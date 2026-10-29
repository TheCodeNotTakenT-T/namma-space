# Third-party components

Namma Space is our own orchestration, capture SOP, quality checks, backup/resume and viewer integration
around the open-source components below. We do not claim their algorithms. Every component used by the
pipeline allows commercial use.

## Reconstruction pipeline (`namma/`, run on Molab)

| Component | Role | Licence |
| --- | --- | --- |
| [gsplat](https://github.com/nerfstudio-project/gsplat) (commit `512d366`, patched in `env/patches/`) | Differentiable Gaussian splat rendering, MCMC training | Apache-2.0 |
| [COLMAP / pycolmap](https://github.com/colmap/colmap) 4.2.1, CPU build | SIFT features, matching, camera poses, undistortion | BSD-3-Clause (GPU SiftGPU is never used) |
| [MoGe-2](https://github.com/microsoft/MoGe) code and [moge-2-vitl-normal](https://huggingface.co/Ruicheng/moge-2-vitl-normal) weights | Monocular depth and normal priors | MIT |
| [utils3d](https://github.com/EasternJournalist/utils3d) (MoGe dependency) | Geometry utilities | MIT |
| [Open3D](https://github.com/isl-org/Open3D) 0.19 | TSDF fusion of rendered depth into the collision mesh | MIT |
| [PyTorch](https://github.com/pytorch/pytorch) 2.11 | Training runtime | BSD-3-Clause |
| [OpenCV](https://github.com/opencv/opencv), [PyAV](https://github.com/PyAV-Org/PyAV), [trimesh](https://github.com/mikedh/trimesh), NumPy, SciPy | Images, video decoding, GLB export, maths | Apache-2.0 / BSD-3-Clause / MIT / BSD-3-Clause / BSD-3-Clause |
| [marimo](https://github.com/marimo-team/marimo), [gdrive-fsspec](https://github.com/marimo-team/gdrive-fsspec) | Cloud notebook, Google Drive backup | Apache-2.0 / BSD-3-Clause |

The COLMAP vocabulary tree used for loop detection is downloaded from COLMAP's release page; its licence is
not stated (set `sfm.loop_detection` to false to avoid it). MoGe's MIT weights were trained partly on
research datasets; that is a general uncertainty, not a stated restriction.

## Viewer (`viewer/`)

See [`viewer/THIRD_PARTY_NOTICES.md`](viewer/THIRD_PARTY_NOTICES.md): Aholo Viewer, Three.js, recast-navigation,
PlayCanvas splat-transform and Vite, all MIT.

## Methods

3D Gaussian Splatting (Kerbl et al., SIGGRAPH 2023); 3D Gaussian Splatting as MCMC (Kheradmand et al.,
NeurIPS 2024); MoGe-2 (Wang et al., 2025); Structure-from-Motion Revisited (Schönberger and Frahm, CVPR 2016);
KinectFusion-style TSDF fusion (Newcombe et al., 2011).

An earlier prototype of this project used PlanarGS (Mayan-101/NammaPlanarGS); that code is not part of this
repository.
