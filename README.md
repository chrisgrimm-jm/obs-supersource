# OBS SuperSource

Drag-and-drop control panel for building multi-box broadcast layouts (PIPs,
splits, grids) directly out of an OBS scene — move, resize, and crop any
source in the scene, save/load named layout presets, and generate a starting
layout automatically by dropping in a screenshot of a broadcast look you want
to copy.

This is the OBS counterpart to [windows-supersource](https://github.com/chrisgrimm-jm/windows-supersource)
(the ATEM version), rebuilt around OBS's own compositor instead of an ATEM
SuperSource.

## How it works

A "box" here is just a **source inside an OBS scene**. Pick one scene to be
your layout canvas (e.g. a scene named `SuperSource` with your cameras,
graphics, and game feed already added to it), and every source in that scene
becomes a draggable/resizable/croppable box in the panel — no fixed box count
like the ATEM had.

Two pieces:

- **`docs/`** — the static control page.
- **`server.js`** — a small Node bridge that holds the real connection to OBS
  (via [obs-websocket](https://github.com/obsproject/obs-websocket), built
  into OBS 28+) and to the Anthropic API for the screenshot-import feature,
  and relays everything to the page over a WebSocket.

The bridge needs to run on a machine that can reach OBS's WebSocket server
(usually the same machine running OBS). The page itself can be hosted
anywhere, same as the ATEM version's GitHub Pages setup.

## Setup

Requires [Node.js](https://nodejs.org).

```bash
git clone https://github.com/chrisgrimm-jm/obs-supersource.git
cd obs-supersource
npm install
npm start
```

This starts the bridge at `http://localhost:8788`, which also serves the page.

In OBS: **Tools → WebSocket Server Settings** → enable it, note the port
(default `4455`) and password (or turn auth off for a local-only setup).
Enter `ws://<obs-host>:4455` and the password in the page, hit **Connect**,
then pick the scene you want to control from the dropdown.

Want it as a double-click Windows .exe instead? `npm run build:win` (cross-
compiles fine from macOS/Linux too) — same approach as the ATEM version.

## Using it

- **Move** a box: drag it. **Resize**: drag the corner handle. **Crop**:
  hover an edge for a thin handle, drag inward.
- Each box shows the real OBS source name — there's no separate "pick a
  camera" step, because the box *is* that source. To put a different camera
  in a spot, swap what's in that scene item within OBS itself.
- **Presets**: name the current layout and hit **Save**. **Load** recalls it,
  **✕** deletes it. Presets store each source's position/size/crop/enabled
  state, matched back up by source name — if a producer's scene doesn't have
  a source a preset expects, that one box is skipped rather than failing the
  whole load.

### Import from Screenshot

Drop in a picture of a broadcast layout you want to copy (a screenshot, a
photo of someone else's stream, whatever). Claude looks at it and identifies
each distinct video box. The suggested boxes then appear **on top of your
actual screenshot**, so you can drag them into pixel-perfect alignment if the
AI's guess is slightly off, assign each one to a real source from your scene
via its dropdown, and hit **Apply Layout**. Nothing is touched in OBS until
you apply. Boxes left unassigned ("— skip —") are ignored.

This needs an Anthropic API key — paste one into **Settings** in the page
(saved on the bridge, in `config.json`, never committed to git) or set an
`ANTHROPIC_API_KEY` environment variable before starting the bridge.

## Bitfocus Companion integration

Same as the ATEM version: every saved preset gets an HTTP URL shown under its
name in the Presets panel —

```
http://<bridge-host>:8788/presets/<preset-name>/load
```

Hit it (GET or POST, no body) to load that preset. Add a Companion **Trigger**
with condition **On Companion Init** and an **HTTP Request** action pointing
at the URL, so a producer's layout applies itself the moment their config
loads.

## Notes

- Position/size use OBS's "bounds" transform mode (top-left anchored,
  scale-to-fit), which the app takes over on any box you touch — an item you
  had positioned some other way in OBS will normalize to this scheme the
  first time you move or resize it here.
- Crop dragging is a reasonable approximation (source-native pixels scaled
  against the box's current on-screen size) — fine-tune with the exact
  number fields if you need precision.
- The OBS WebSocket password (if set) and the Anthropic API key are both
  stored in plaintext in `config.json` next to the bridge — fine for a
  trusted local network, don't commit that file or expose the bridge port
  publicly.
