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

## 3. Package a browser demo

Choose **3. Package a browser demo** in the launcher (or run `npm run build`, then
`node scripts/package-aholo-scene.mjs --scene ../data/scene-library/<id>/scene.json --setup namma-walking-setup.json --output ../output/demo`).
The output folder is a static website: the viewer, `scene/{scene.json,preview.spz,collision.glb}`, the walking
setup and licence files. Host it on any static host (GitHub Pages, Netlify, Vercel); visitors click **Enter room**.

## Tests

```bash
npm test                                   # viewer, walking, packaging (Node test runner)
python3 test/scene-pipeline.test.py        # importer: part checks, unsafe archives, wrong model
```
