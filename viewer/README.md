# Namma Space viewer

Browser viewer for reconstructed rooms: Gaussian splat rendering (Aholo Viewer) with first-person walking on
the matching collision mesh (Recast/Detour). It also imports pipeline results and packages a room as a static
website.

Requirements: Node.js 18 or newer and Python 3.9 or newer (with tkinter for the desktop launcher).

```bash
cd viewer
npm ci          # installs Three.js, recast-navigation, Vite, splat-transform and the vendored Aholo package
```

## 1. Import a trained result

A finished Molab run leaves `result-<id>.zip.part001…` and `result-<id>.zip.parts.json` in
`DOWNLOAD_THIS/result-<id>/` (also on Google Drive). Keep the parts next to the `.parts.json`.

- **Windows:** double-click `Namma Pipeline.cmd` in the repository root and choose **1. Import a trained result**.
- **Any OS:** `python3 viewer/scripts/namma-pipeline.py` opens the same window, or import from the command line:

```bash
python3 viewer/scripts/scene-pipeline.py --geometry path/to/result-<id>.zip.parts.json --title "My room"
python3 viewer/scripts/namma-pipeline.py --open <scene id printed above>
```

The importer checks every part's size and SHA-256, converts the trained PLY to a compressed web model
(`preview.spz`), checks the collision mesh and writes the room to `data/scene-library/<id>/` (ignored by Git).
Google Drive sometimes renames `…part001` to `…part001.zip` when it downloads a folder; the importer accepts
either name (the SHA-256 check still applies).

## 2. Look around and walk

The viewer runs at `http://127.0.0.1:5174/aholo/?scene=<id>` (`npm run dev` starts it; the launcher does this
for you). Free flight: **WASD** to move, drag to look. To walk with collisions, open **Walking setup**:

1. **Load matching collision estimate**, then **Pick three floor points** on the floor.
2. Enter one real distance in metres and **Pick measurement endpoints** for it.
3. **Build walking surfaces**, tick the review box, **Pick a walking start**, and walk with **WASD** and the mouse.
4. **Download walking setup** saves the floor, scale and entrance for packaging.

For smooth playback on laptops with two GPUs, run the browser on the dedicated GPU (Windows: Settings > System >
Display > Graphics > your browser > High performance) and set **Display quality** to **Balanced**.

A room that has a saved walking setup opens straight into the walk. **Tag places** (top right) shows the
setup panel again.

## 3. Tag places, search and get directions

Once you are walking, the room is a searchable venue:

- **Tag places** (local development, or `?studio=1` on a hosted room) opens the tagging tools. **Add place**,
  then click the spot in the room; **Add zone**, then click the corners of a floor area and **Finish zone**.
  Give each a name, a kind and other names people might search for. **Save** writes `venue.json` next to the
  scene in `data/scene-library/<id>/` (the packager includes it); **Export** / **Import** move it as a file.
- **Search** (press `/`): results appear while typing, tolerate typos (`projecter`), understand other words
  (`toilet` finds a washroom, `where can I sit` finds seating) and are listed nearest first by walking
  distance. `nearest exit` sorts by distance.
- **Click** a label, a tagged spot or a zone in the room to see its name and the route to it. **Directions**
  gives turn-by-turn steps that update as you walk; **Walk me there** walks the route for you; **Jump there**
  sets you down two steps short of the place, facing it. Double-click the floor, or click the map, to be
  walked to that spot.
- The **radar** (bottom left) is drawn from the walkable area itself, turns with you and shows places, the
  route and the destination; click it for the whole floor.
- **Bird's-eye view** (press `M`): the camera lifts out of the room while the ceiling is cut away, so the real
  scan is seen from above as a dollhouse. Drag to turn, scroll to zoom, click the floor or a place to land
  there. **Jump there** uses the same flight: up over the room and down in front of the place.
- **Visits with several stops:** add places with **Add to a visit**, then **Walk the shortest route**. Walking
  distances between every pair of stops come from the navmesh and the order is solved exactly (Held-Karp, up
  to 12 stops). The plan says how much shorter it is than the order you picked; the guided walk pauses at
  each stop, announces it and lights it up.
- **Voice:** the microphone in the search field takes a spoken request ("take me to the projector") and
  starts directions; the speaker on the direction sign reads each instruction aloud. Both use the browser's
  own speech features (no download, no account); the microphone appears only where the browser supports it.
- **Arrival:** the room assembles outwards from where you stand when it opens, and a ring of light runs out
  from you when directions start.

How it works, in `src/` (plain modules with unit tests in `test/`):

| Module | Role |
| --- | --- |
| `venue.js` | The venue document: places, zones, levels; validation of untrusted files |
| `search.js` | In-memory search: prefix, synonym and edit-distance matching, ranking, "nearest" intent |
| `spatial-index.js` | Uniform-grid index: zone containing a point, nearest places |
| `navigation.js` | Recast/Detour navmesh: walkable area, unreachable islands removed, routes, movement |
| `route.js` | Route length and time, turn-by-turn steps, progress, clearance from obstacles |
| `bvh.js` | Ray queries against the collision mesh (clicks, labels hidden behind walls) |
| `projection.js` | Camera projection for labels and the map transform |
| `tour.js` | Shortest order for a visit with several stops (exact up to 12 stops, 2-opt beyond) |
| `room.js` | Wall direction and a wall-aligned box around the scan, used by the bird's-eye view |

Routes are checked in tests against an exhaustive grid search (within 2% of the shortest path) and for
clearance from the edge of the walkable area.

## 4. Package a browser demo

Choose **3. Package a browser demo** in the launcher (or run `npm run build`, then
`node scripts/package-aholo-scene.mjs --scene ../data/scene-library/<id>/scene.json --setup namma-walking-setup.json --output ../output/demo`).
The output folder is a static website: the viewer, `scene/{scene.json,preview.spz,collision.glb}`, the walking
setup and licence files. Host it on any static host (GitHub Pages, Netlify, Vercel); visitors click **Enter room**.

## Tests

```bash
npm test                                   # viewer, walking, packaging (Node test runner)
python3 test/scene-pipeline.test.py        # importer: part checks, unsafe archives, wrong model
```
