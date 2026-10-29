# Namma Space on molab: video to walkable 3D room

One notebook (`notebooks/namma_space.py`) does everything. Part A prepares the GPU environment
(every molab session starts empty); Part B reconstructs a room from a video on Google Drive.

## Part A: environment

1. Upload `notebooks/namma_space.py` to molab and open it on a GPU.
2. **1. Get code** – clones (or fast-forwards) `main` from https://github.com/TheCodeNotTakenT-T/namma-space into `/marimo/namma-space`. Edited files are never overwritten.
3. **2. Run setup + GPU checks** – wait for *finished* and overall PASS. Send back the offered archive if it fails.

What setup does (`bash molab_setup.sh`, logs in `setup-logs/<time>/`):

| Stage | Detail |
|---|---|
| preflight | Linux, `nvidia-smi`, driver CUDA ≥ 13.0, git/gcc/curl/flock, uv; CPU/RAM/disk |
| python | `uv venv --python 3.12` at `.venv`; exact `env/requirements.lock.txt` (Torch 2.11.0+cu130, NumPy 1.26.4, Open3D 0.19.0, pycolmap 4.2.1, PyAV, cuda-toolkit 13.0.2 with nvcc 13.0.88, …) |
| cuda-environment | `CUDA_HOME` = the venv's `nvidia/cu13`; nvcc must equal Torch's CUDA; arch from this GPU; `MAX_JOBS` from CPUs/RAM |
| gsplat-source | gsplat at a pinned commit in `/opt/namma-src/gsplat` + `env/patches/gsplat-relocation-sign.patch` (sm_120 fix, upstream PR #1060) |
| extensions | builds gsplat (reused when toolchain and sources match) |
| moge | MoGe-2 + utils3d at pinned commits, `--no-deps` (keeps NumPy 1.26.4) |
| gpu-checks | `python -m namma check`: environment, torch_cuda, gsplat (render + backward, relocation kernel, depth→normal), pipeline_imports (incl. pycolmap without CUDA), open3d_tsdf |

## Part B: reconstruction

1. Connect Google Drive: Files panel > *Remote storage* > *Google Drive*, run the cell it inserts.
2. Enter the video path inside *My Drive* (e.g. `NammaSpace/classroom.mp4`), click **3. Start / resume**.
3. The detached driver (`python -m namma.driver`, notebook Python) copies the video, creates the job
   (`/opt/namma-jobs/<name>-<hash>`), restores anything already verified on Drive, starts the uploaders,
   runs the smoke test (first 20 s, tiny settings) and then the full job (`python -m namma run`, GPU venv).
4. Watch the status panel (stage, progress, Drive backup, latest photo | render | depth preview, log).
5. **Show download buttons** offers the `DOWNLOAD_THIS` files. They are also on Drive under
   `NammaSpaceBackups/<job>/<seq>-download-<id>/`. Open it in the browser viewer as described in
   [`viewer/README.md`](../viewer/README.md).

Stages and what survives a molab stop (everything is uploaded with a checksum check and VERIFIED.json):

| Stage | Work | Backed up |
|---|---|---|
| frames | sharp, overlapping keyframes (PyAV + OpenCV) | frames + metrics |
| sfm | pycolmap CPU SIFT, sequential + long-range matching, global then incremental mapper, gravity levelling, undistortion | sparse models, undistorted images, database |
| priors | undistorts the original frames at `priors.image_long_side` (1920 px); MoGe-2 metric depth + normals aligned to the SfM points; scene scaled to metres (estimated) | metric model + per-frame scales (maps are recomputed) |
| train | gsplat MCMC (1M Gaussians, 30,000 steps), L1+SSIM, depth/normal priors, per-frame colour correction, checkpoints every 2,500 steps | every checkpoint, final model |
| mesh | TSDF fusion of rendered depth (Open3D 0.19), cleanup, ≤200k triangles, GLB | room.glb |
| export | `DOWNLOAD_THIS/result-<id>/` zip (parts ≤ 90 MiB) in the importer's format | the files themselves |

If molab stops: open the notebook again, redo Part A, reconnect Drive and click Start with the same video.
Finished stages and the newest checkpoint are restored; training continues from that checkpoint.

## Licences (commercial use)

gsplat (Apache-2.0), pycolmap/COLMAP CPU path (BSD-3; GPU SIFT is never used), MoGe-2 code and weights (MIT),
PyAV (BSD-3), OpenCV (Apache-2.0), Open3D (MIT), trimesh (MIT), PyTorch (BSD). The vocabulary tree used for loop
detection is downloaded from COLMAP's release page; its licence is unstated (set `sfm.loop_detection` false to avoid it).
MoGe's weights are MIT-licensed, but they were trained partly on research-only datasets; that is a general legal
uncertainty, not a stated restriction.

## Publishing the compiled gsplat (so nobody has to compile it)

Compiling gsplat for the RTX PRO 6000 takes over an hour. After one setup has compiled it, every later setup
can download it instead, if it is published as a GitHub release asset:

1. After a setup that PASSED (and ran once more, so the archive exists), the files
   `/opt/namma-cache/gsplat-<signature>.tar` and `gsplat-<signature>.tar.sha256` exist on molab. They are also
   on Google Drive in `NammaSpaceBackups/_build-cache/` after you click Start. Download both.
2. On GitHub, in `TheCodeNotTakenT-T/namma-space`, create a release with the tag `gsplat-prebuilt`
   and attach both files unchanged (needs write access to the repository).
3. Every later setup looks for `https://github.com/TheCodeNotTakenT-T/namma-space/releases/download/gsplat-prebuilt/gsplat-<signature>.tar`,
   checks its SHA-256 and installs it in seconds. To use another repository, set `NAMMA_PREBUILT_BASE`.

The signature covers Python, PyTorch, CUDA compiler, gcc, GPU architecture, build flags and the gsplat
source, so a published build is only used where it is exactly valid; anything else compiles from the
pinned source. gsplat is Apache-2.0, so redistributing the build is allowed (its licence file is inside).
