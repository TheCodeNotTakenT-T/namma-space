# Namma Space

**One ordinary video of an indoor space becomes a photorealistic 3D room you can walk through in a web browser.**
Team rpk (Akarsh Shrivastav, Mayan S Hiremath, NIT Goa) · Techfest 2026-27, IIT Bombay.

- **Live walkthrough:** https://thecodenottakent-t.github.io/namma-space/ (open **Walking setup > Enter saved
  walking setup**, then WASD to move and drag to look; best on a desktop browser using its dedicated GPU)
- **Capture SOP:** [docs/CAPTURE_SOP.md](docs/CAPTURE_SOP.md)
- **Sample data:** [tests/sample/](tests/sample/) (30 s of our classroom capture)

```
video ──> keyframes ──> camera poses ──> depth/normal priors ──> Gaussian splat ──> collision mesh ──> package
          (PyAV,         (COLMAP via       (MoGe-2, aligned to     (gsplat, MCMC,     (TSDF of rendered     (splat PLY + GLB
           sharpness +    pycolmap, CPU)    SfM, metric scale)      30,000 steps)      depth, Open3D)        + hashes)
           optical flow)
                                     all on a free Molab GPU, every stage backed up to Google Drive
                                                              │
                                                              v
                       viewer/: import ──> browser viewer (Aholo) with first-person walking ──> static website
```

## Repository layout

| Path | What it is |
| --- | --- |
| `notebooks/namma_space.py` | The marimo notebook you open on Molab: Get code, Run setup, Start |
| `molab_setup.sh` | Pinned GPU environment: Python 3.12, PyTorch 2.11 + CUDA 13.0, gsplat, MoGe-2, self-checks |
| `namma/` | The pipeline: `frames`, `sfm`, `priors`, `trainer`, `mesh`, `export`, plus `backup` (Drive), `driver`, `pipeline`, `gpu_check` |
| `env/` | Locked Python requirements and the one gsplat patch |
| `viewer/` | Browser viewer, importer and static-demo packager ([viewer/README.md](viewer/README.md)) |
| `tests/` | Local end-to-end pipeline test (stand-in renderer) and the sample clip |
| `docs/` | Molab details ([MOLAB_SETUP.md](docs/MOLAB_SETUP.md)) and the capture SOP |

## Reproduce the room

You need a Google account with Drive and a free [Molab](https://molab.marimo.io) account (NVIDIA GPU runtime).

1. **Capture** a room following [docs/CAPTURE_SOP.md](docs/CAPTURE_SOP.md), or use
   [`tests/sample/classroom_30s.mp4`](tests/sample/). Upload the video to Google Drive.
2. **Open the notebook:** create a Molab notebook from `notebooks/namma_space.py` and select a GPU.
3. **1. Get code** clones this repository into `/marimo/namma-space`.
4. **2. Run setup** installs the pinned environment and runs real GPU checks; wait for **overall PASS**. The first
   setup compiles gsplat's CUDA kernels (about an hour on Molab's RTX PRO 6000) and saves the build to your
   Drive, so later sessions restore it in seconds. Logs: `setup-logs/<time>/`.
5. **Connect Google Drive:** Files panel > *Remote storage* > *Google Drive*, then run the cell it inserts.
6. **Reconstruct:** enter the video path inside My Drive (e.g. `NammaSpace/classroom_30s.mp4`) and click
   **3. Start**. A 20-second smoke test runs first, then the full job. Progress, a photo | render | depth preview
   and the log appear in the notebook. Everything finished is copied to `NammaSpaceBackups/` on Drive and
   verified; if Molab stops, run steps 3–6 again and the job resumes from Drive.
7. **Download** `NammaSpaceBackups/<job>/<n>-download-<id>/` from Drive and open it in the viewer
   ([viewer/README.md](viewer/README.md)): import, look around, set the floor and scale, walk, and package a website.

Measured on Molab for our 4 min 47 s classroom video (613 keyframes): frame selection 12 min, camera poses
32 min, depth priors 3.5 min, training 14 min, mesh and export 1 min. Result: all 613 frames posed at 1.0 px
mean reprojection error; 20.7 dB PSNR and 0.888 SSIM on 26 held-out frames; 1,000,000 Gaussians; 199,999-triangle
collision mesh; 24 MB web model.

## Check the code without a GPU

```bash
python -m venv .venv && .venv/bin/pip install -r env/requirements.lock.txt   # Linux, Python 3.12
python tests/run_local_pipeline.py tests/sample/classroom_30s.mp4 /tmp/namma-test
cd viewer && npm ci && npm test && python3 test/scene-pipeline.test.py
```

The pipeline test runs every stage on the clip with a small stand-in renderer instead of gsplat, kills training
after its first checkpoint, resumes it, checks the export format, backs up to a local folder standing in for
Drive, restores into a fresh job and checks that finished stages are not repeated. It tests the plumbing, not
image quality.

## Settings that matter

Defaults (`namma/config.py`) are the ones that produced the Round 1 room. Two more are implemented but have not
run on a GPU yet: `train.strategy = "default"` (original 3DGS densification, grows past 1M Gaussians) and
`priors.image_long_side = 3840` (4K training images from 4K video).

## Licences

Our code: MIT ([LICENSE](LICENSE)). Every pipeline and viewer component allows commercial use; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
