"""DOWNLOAD_THIS package in the format the desktop importer (scene-pipeline.py) already accepts.

result-<id>.zip contains namma-result.json, namma-input.json, cameras.json, assets/room.ply
(standard 3DGS PLY), assets/room.glb (collision, same frame, identity transform) and assets/views.json.
Archives over 90 MiB are split into .partNNN pieces with a .parts.json manifest of SHA-256 sums.
"""
import json
import math
import shutil
import subprocess
import time
import uuid
import zipfile
from pathlib import Path

import numpy as np
import torch

from namma import trainer as T
from namma.workspace import read_json, sha256_file, write_json

PART = 90 * 1024 ** 2
REPO = Path(__file__).resolve().parents[1]


def write_ply(splats, path):
    """Inria 3DGS layout: x y z nx ny nz f_dc_0..2 f_rest_0..44 opacity scale_0..2 rot_0..3 (wxyz)."""
    means = splats["means"].float().cpu()
    n = len(means)
    sh0 = splats["sh0"].float().cpu().reshape(n, 3)
    shN = splats["shN"].float().cpu().transpose(1, 2).reshape(n, -1)  # channel-major like the reference
    quats = torch.nn.functional.normalize(splats["quats"].float().cpu(), dim=-1)
    data = torch.cat([means, torch.zeros(n, 3), sh0, shN, splats["opacities"].float().cpu().reshape(n, 1),
                      splats["scales"].float().cpu(), quats], 1).numpy().astype(np.float32)
    finite = np.isfinite(data).all(1)
    data = data[finite]
    names = (["x", "y", "z", "nx", "ny", "nz"] + [f"f_dc_{i}" for i in range(3)] + [f"f_rest_{i}" for i in range(shN.shape[1])]
             + ["opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)])
    header = ("ply\nformat binary_little_endian 1.0\n" + f"element vertex {len(data)}\n"
              + "".join(f"property float {name}\n" for name in names) + "end_header\n")
    with open(path, "wb") as f:
        f.write(header.encode())
        f.write(data.tobytes())
    return {"splats": int(len(data)), "dropped_non_finite": int((~finite).sum()), "sh_rest": int(shN.shape[1])}


def camera_entries(frames):
    cameras, views = [], []
    for i, frame in enumerate(frames):
        c2w = frame.c2w.numpy().astype(float)
        fx, fy = float(frame.K[0, 0]), float(frame.K[1, 1])
        cameras.append({"id": i, "img_name": Path(frame.name).stem, "width": frame.width, "height": frame.height,
                        "position": c2w[:3, 3].tolist(), "rotation": c2w[:3, :3].tolist(), "fx": fx, "fy": fy})
        views.append({"name": Path(frame.name).stem, "fov": math.degrees(2 * math.atan(frame.height / (2 * fy))),
                      "position": c2w[:3, 3].tolist(), "forward": c2w[:3, 2].tolist(), "up": (-c2w[:3, 1]).tolist()})
    return cameras, views


def _code_commit():
    try:
        return subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""


def split_archive(archive, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    digest = sha256_file(archive)
    if archive.stat().st_size <= PART:
        target = out_dir / archive.name
        shutil.copy2(archive, target)
        return [target], {"archive": archive.name, "sha256": digest, "parts": []}
    parts, manifest = [], {"archive": archive.name, "sha256": digest, "parts": []}
    with open(archive, "rb") as src:
        index = 1
        while chunk := src.read(PART):
            part = out_dir / f"{archive.name}.part{index:03d}"
            part.write_bytes(chunk)
            parts.append(part)
            manifest["parts"].append({"name": part.name, "bytes": len(chunk), "sha256": sha256_file(part)})
            index += 1
    manifest_path = out_dir / f"{archive.name}.parts.json"
    write_json(manifest_path, manifest)
    return parts + [manifest_path], manifest


def run(ws, cfg):
    state = torch.load(ws.train / "final.pt", map_location="cpu", weights_only=False)
    frames, _, _ = T.load_dataset(ws, with_priors=False)
    result_id = uuid.uuid4().hex[:12]
    stage = ws.export / f"result-{result_id}"
    shutil.rmtree(ws.export, ignore_errors=True)
    (stage / "assets").mkdir(parents=True)
    ply = write_ply(state["splats"], stage / "assets" / "room.ply")
    shutil.copy2(ws.mesh / "room.glb", stage / "assets" / "room.glb")
    cameras, views = camera_entries(frames)
    write_json(stage / "cameras.json", cameras)
    write_json(stage / "assets" / "views.json", views)

    job = ws.job
    receipts = {s: (ws.receipt(s) or {}).get("metrics", {}) for s in ("frames", "sfm", "priors", "train", "mesh")}
    priors, mesh = receipts["priors"], receipts["mesh"]
    warnings = [w for m in receipts.values() for w in m.get("warnings", [])]
    write_json(stage / "namma-input.json", {"video": job.get("video_name"), "videoSha256": job.get("video_sha256"),
                                            "frames": receipts["frames"]})
    result = {
        "schemaVersion": 1, "type": "namma-planargs-result", "inputId": job.get("job_id"),
        "algorithm": {"name": "namma-gsplat-mcmc", "commit": _code_commit(),
                      "components": "gsplat (Apache-2.0), pycolmap (BSD-3), MoGe-2 (MIT), Open3D (MIT)"},
        "scale": {"calibrated": False, "estimatedMetric": bool(priors.get("metric_scale")),
                  "note": "Units are metres estimated from monocular depth; confirm with a tape measurement in the viewer."},
        "capture": {"originalFrameCount": receipts["frames"].get("decoded_frames"),
                    "inputImages": receipts["sfm"].get("total"), "registeredImages": receipts["sfm"].get("registered"),
                    "trainingSteps": receipts["train"].get("steps"), "diagnostic": False},
        "artifacts": {"splat": {"path": "assets/room.ply", "sha256": sha256_file(stage / "assets" / "room.ply")},
                      "mesh": {"path": "assets/room.glb", "sha256": sha256_file(stage / "assets" / "room.glb"),
                               "triangleCount": mesh.get("triangles"), "coordinateSpace": "raw-ply-v1"},
                      "views": {"path": "assets/views.json", "sha256": sha256_file(stage / "assets" / "views.json")}},
        "walkingSuggestion": {"up": [0.0, -1.0, 0.0], "floor": mesh.get("floor"), "startCamera": 0},
        "quality": {"validated": False, "walkingApproved": False, "evaluation": receipts["train"], "warnings": warnings},
        "meshProcessing": mesh, "training": cfg.to_dict()["train"],
        "runtime": {"created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "torch": torch.__version__},
    }
    write_json(stage / "namma-result.json", result)

    archive = ws.export / f"result-{result_id}.zip"
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
        for path in sorted(stage.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(stage).as_posix())
    download = ws.export / "DOWNLOAD_THIS" / archive.stem
    files, manifest = split_archive(archive, download)
    (download / "READ_ME.txt").write_text(
        "Namma Space reconstruction\n\n"
        "Open it in the viewer (viewer/README.md in the namma-space repository): Namma Pipeline.cmd -> "
        f"'1. Import a trained result' -> select {(archive.name + '.parts.json') if manifest['parts'] else archive.name} "
        "(keep all parts in one folder).\n\n"
        f"Splats: {ply['splats']:,}  Collision triangles: {mesh.get('triangles')}\n"
        f"Held-out PSNR: {receipts['train'].get('psnr')}  SSIM: {receipts['train'].get('ssim')}\n"
        + ("Warnings:\n- " + "\n- ".join(warnings) + "\n" if warnings else ""))
    previews = sorted((ws.train / "previews").glob("*.jpg"))
    if previews:
        shutil.copy2(previews[-1], download / "preview_photo_render_depth.jpg")
    (download / "report.json").write_text(json.dumps({"stages": receipts, "ply": ply, "archive": manifest}, indent=1, default=str))
    return {"result_id": result_id, "archive_bytes": archive.stat().st_size, "parts": len(manifest["parts"]),
            "download_dir": str(download), **ply}, [download]
