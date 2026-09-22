const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const OBSWebSocket = require('obs-websocket-js').default
const Anthropic = require('@anthropic-ai/sdk')

const PORT = process.env.PORT || 8788
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

// obs-websocket-js errors (e.g. connection refused) often carry an empty
// .message and only a numeric close/status code — fall back to something
// readable instead of showing a blank error in the UI.
function errText(e) {
  return (e && e.message) || `${(e && e.name) || 'Error'}${e && e.code !== undefined ? ` (code ${e.code})` : ''}`
}

const DATA_DIR = process.pkg ? path.dirname(process.execPath) : __dirname
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

if (process.pkg && !fs.existsSync(PRESETS_FILE) && fs.existsSync(path.join(__dirname, 'presets.json'))) {
  fs.copyFileSync(path.join(__dirname, 'presets.json'), PRESETS_FILE)
}

let presets = {}
try { presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) } catch { presets = {} }
function savePresetsFile() { fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2)) }

let config = {}
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { config = {} }
function saveConfigFile() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)) }

const obs = new OBSWebSocket()
let currentScene = config.lastScene || null

// ---- OBS state -> plain JSON for the page ----
async function getSceneState(sceneName) {
  const { baseWidth, baseHeight } = await obs.call('GetVideoSettings')
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName })
  const items = sceneItems.map((it) => ({
    sceneItemId: it.sceneItemId,
    sourceName: it.sourceName,
    enabled: it.sceneItemEnabled,
    transform: it.sceneItemTransform,
  }))
  return { sceneName, canvasWidth: baseWidth, canvasHeight: baseHeight, items }
}

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data)
}

async function pushSceneState() {
  if (!currentScene) return
  try {
    broadcast({ type: 'sceneState', ...(await getSceneState(currentScene)) })
  } catch (e) {
    broadcast({ type: 'error', message: errText(e) })
  }
}

async function pushSceneList() {
  try {
    const { scenes } = await obs.call('GetSceneList')
    broadcast({ type: 'scenes', scenes: scenes.map((s) => s.sceneName).reverse() })
  } catch (e) {
    broadcast({ type: 'error', message: errText(e) })
  }
}

obs.on('ConnectionOpened', () => broadcast({ type: 'connected' }))
obs.on('ConnectionClosed', () => broadcast({ type: 'disconnected' }))
obs.on('Identified', async () => {
  broadcast({ type: 'connected' })
  await pushSceneList()
  if (currentScene) await pushSceneState()
})
for (const evt of ['SceneItemTransformChanged', 'SceneItemEnableStateChanged', 'SceneItemListReindexed', 'SceneItemCreated', 'SceneItemRemoved']) {
  obs.on(evt, (data) => { if (data.sceneName === currentScene) pushSceneState() })
}
obs.on('SceneListChanged', () => pushSceneList())

// ---- presets ----
async function loadPresetByName(name) {
  const preset = presets[name]
  if (!preset) throw new Error(`Unknown preset "${name}"`)
  if (!currentScene) throw new Error('No scene selected')
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentScene })
  for (const box of preset.boxes) {
    const item = sceneItems.find((it) => it.sourceName === box.sourceName)
    if (!item) continue // producer's scene doesn't have this source (renamed/removed) — skip, don't fail the whole preset
    await obs.call('SetSceneItemEnabled', { sceneName: currentScene, sceneItemId: item.sceneItemId, sceneItemEnabled: box.enabled })
    await obs.call('SetSceneItemTransform', { sceneName: currentScene, sceneItemId: item.sceneItemId, sceneItemTransform: box.transform })
  }
}

// ---- screenshot -> layout analysis (Claude vision) ----
async function analyzeScreenshot(imageBase64, mediaType) {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('No Anthropic API key configured — add one in Settings first')
  const anthropic = new Anthropic({ apiKey })
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    tools: [{
      name: 'report_boxes',
      description: 'Report every distinct video box visible in the broadcast layout screenshot.',
      input_schema: {
        type: 'object',
        properties: {
          boxes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short description, e.g. "main shot" or "PIP bottom right"' },
                xPct: { type: 'number', description: 'Left edge, 0-1 fraction of frame width' },
                yPct: { type: 'number', description: 'Top edge, 0-1 fraction of frame height' },
                widthPct: { type: 'number', description: '0-1 fraction of frame width' },
                heightPct: { type: 'number', description: '0-1 fraction of frame height' },
                zIndex: { type: 'integer', description: 'Stacking order, 0 = furthest back (e.g. the main/full-screen box)' },
              },
              required: ['label', 'xPct', 'yPct', 'widthPct', 'heightPct', 'zIndex'],
            },
          },
        },
        required: ['boxes'],
      },
    }],
    tool_choice: { type: 'tool', name: 'report_boxes' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        {
          type: 'text',
          text: 'This is a broadcast video layout (picture-in-picture / multi-box composition). ' +
            'Identify every distinct VIDEO CONTENT box as a rectangle — most prominent/background box first (zIndex 0), inset/PIP boxes on top with higher zIndex. ' +
            'Ignore decorative chrome: colored borders, bezels, divider lines, drop shadows, logos, and lower-third/scoreboard graphics that sit on top of or between the video boxes are NOT boxes themselves and should not be reported or included in a box\'s rectangle. ' +
            'Each rectangle\'s edges should land on the actual video content boundary (where the camera/game footage starts), not on the outer edge of any border or divider around it — err toward the inside of a border rather than including it.',
        },
      ],
    }],
  })
  const toolUse = message.content.find((b) => b.type === 'tool_use')
  if (!toolUse) throw new Error('Claude did not return a structured result')
  return toolUse.input.boxes
}

// ---- HTTP ----
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer((req, res) => {
  // The page can be hosted on a different origin than the bridge (e.g. GitHub
  // Pages pointed at a local bridge address), so its fetch() calls need CORS.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  const presetLoadMatch = req.url.match(/^\/presets\/([^/]+)\/load\/?$/)
  if (presetLoadMatch) {
    loadPresetByName(decodeURIComponent(presetLoadMatch[1]))
      .then(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true })))
      .catch((e) => res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: errText(e) })))
    return
  }
  if (req.url === '/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(Object.keys(presets)))
    return
  }
  if (req.url === '/analyze-screenshot' && req.method === 'POST') {
    readJsonBody(req)
      .then(({ imageBase64, mediaType }) => analyzeScreenshot(imageBase64, mediaType))
      .then((boxes) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, boxes })))
      .catch((e) => res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: errText(e) })))
    return
  }

  const file = req.url === '/' ? '/index.html' : req.url
  const filePath = path.join(__dirname, 'docs', file)
  fs.readFile(filePath, (err, data) => {
    if (err) return res.writeHead(404).end('Not found')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' })
    res.end(data)
  })
})

const wss = new WebSocketServer({ server })
const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))

  ws.send(JSON.stringify({ type: obs.identified ? 'connected' : 'disconnected' }))
  ws.send(JSON.stringify({ type: 'presets', presets }))
  ws.send(JSON.stringify({ type: 'hasApiKey', hasApiKey: !!(config.apiKey || process.env.ANTHROPIC_API_KEY) }))
  if (currentScene) getSceneState(currentScene).then((s) => ws.send(JSON.stringify({ type: 'sceneState', ...s }))).catch(() => {})

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    try {
      if (msg.type === 'connect') {
        config.lastUrl = msg.url
        config.lastPassword = msg.password
        saveConfigFile()
        await obs.connect(msg.url, msg.password || undefined)
      } else if (msg.type === 'selectScene') {
        currentScene = msg.sceneName
        config.lastScene = msg.sceneName
        saveConfigFile()
        await pushSceneState()
      } else if (msg.type === 'setItem') {
        if (msg.enabled !== undefined) {
          await obs.call('SetSceneItemEnabled', { sceneName: currentScene, sceneItemId: msg.sceneItemId, sceneItemEnabled: msg.enabled })
        }
        if (msg.transform) {
          await obs.call('SetSceneItemTransform', { sceneName: currentScene, sceneItemId: msg.sceneItemId, sceneItemTransform: msg.transform })
        }
      } else if (msg.type === 'savePreset') {
        const state = await getSceneState(currentScene)
        presets[msg.name] = { boxes: state.items.map((it) => ({ sourceName: it.sourceName, enabled: it.enabled, transform: it.transform })) }
        savePresetsFile()
        broadcast({ type: 'presets', presets })
      } else if (msg.type === 'loadPreset') {
        await loadPresetByName(msg.name)
      } else if (msg.type === 'deletePreset') {
        delete presets[msg.name]
        savePresetsFile()
        broadcast({ type: 'presets', presets })
      } else if (msg.type === 'setApiKey') {
        config.apiKey = msg.key
        saveConfigFile()
        broadcast({ type: 'hasApiKey', hasApiKey: !!config.apiKey })
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: errText(e) }))
    }
  })
})

server.listen(PORT, () => console.log(`OBS SuperSource: http://localhost:${PORT}`))

if (config.lastUrl) {
  obs.connect(config.lastUrl, config.lastPassword || undefined).catch((e) => console.error(`Auto-connect to ${config.lastUrl} failed:`, errText(e)))
}
