"""Per-frame metric depth and normals from MoGe-2 (Microsoft, MIT code and weights), aligned to COLMAP.

For every training frame the MoGe depth is compared with the depth of the frame's triangulated SfM points;
a robust per-frame log-scale fit gives s_i (COLMAP units per metre). Their median makes the whole scene
metric: the reconstruction is scaled by 1/median, so later stages work in metres (estimated, not
tape-measured). Each frame's depth prior is corrected by s_i / median so priors agree with the model.
If MoGe is unavailable the stage still writes the dataset, without priors or metric scale.
"""
import math
import shutil

import cv2
import numpy as np
import pycolmap

from namma.sfm import cam_from_world
from namma.workspace import read_json, write_json


def _observed_depths(rec, image, point_ids):
    pose = cam_from_world(image)
    R, t = np.asarray(pose.rotation.matrix()), np.asarray(pose.translation)
    uv, z, w = [], [], []
    for p2d in image.points2D:
        pid = p2d.point3D_id
        if pid not in point_ids:
            continue
        point = rec.points3D[pid]
        if point.track.length() < 3 or point.error > 1.5:
            continue
        depth = (R @ point.xyz + t)[2]
        if depth > 0:
            uv.append(p2d.xy)
            z.append(depth)
            w.append(point.track.length() / (1.0 + point.error))
    return np.array(uv).reshape(-1, 2), np.array(z), np.array(w)


def robust_log_scale(z_sfm, d_prior, weights, inlier=0.07):
    """Weighted mode of log(z_sfm / d_prior), refined on inliers (scale only: metric priors)."""
    r = np.log(z_sfm) - np.log(d_prior)
    best, best_score = None, -1.0
    for c in r[:: max(1, len(r) // 200)]:
        score = weights[np.abs(r - c) < inlier].sum()
        if score > best_score:
            best, best_score = c, score
    inliers = np.abs(r - best) < 2 * inlier
    estimate = float(np.average(r[inliers], weights=weights[inliers]))
    return estimate, int(inliers.sum()), float(inliers.mean())


def _load_moge(name, log):
    try:
        import torch
        from moge.model.v2 import MoGeModel
        return MoGeModel.from_pretrained(name).to("cuda").eval(), torch
    except Exception as error:
        log(f"WARNING MoGe unavailable ({type(error).__name__}: {error}); training without depth/normal priors")
        return None, None


def run(ws, cfg, repair=False):
    """Normal mode builds dataset/ from the frames undistorted at priors.image_long_side. Repair mode (after a Drive restore brought back
    dataset/sparse and dataset/priors_scales.json) only recomputes the MoGe maps with the stored scales."""
    pc = cfg.priors
    src = _undistort(ws, pc.image_long_side)
    scales_path = ws.dataset / "priors_scales.json"
    stored = read_json(scales_path) if repair and (ws.dataset / "sparse").exists() else None
    rec = pycolmap.Reconstruction(src / "sparse")
    names = sorted(img.name for img in rec.images.values() if img.has_pose)
    out_images = ws.dataset / "images"
    if stored is None:
        shutil.rmtree(ws.dataset, ignore_errors=True)
    shutil.rmtree(out_images, ignore_errors=True)
    out_images.mkdir(parents=True)
    for name in names:
        shutil.copy2(src / "images" / name, out_images / name)
    shutil.rmtree(ws.priors, ignore_errors=True)
    ws.priors.mkdir()
    if stored is not None:
        ws.log("priors: repair mode, reusing the stored metric scale and per-frame corrections")
        if stored.get("log_k") is None:  # first session had no priors: nothing to recompute
            return {**stored.get("metrics", {}), "priors": False, "metric_scale": False, "repaired": True}

    model, torch = _load_moge(cfg.priors.model, ws.log) if cfg.priors.enabled else (None, None)
    if model is None:
        if stored is None:
            rec.write(_sparse_dir(ws))
            write_json(scales_path, {"log_k": None, "scales": {}})
        return {"priors": False, "metric_scale": False, "frames": len(names),
                "warnings": ["No depth/normal priors: geometry is learned from photos only and the scale is arbitrary."]}

    point_ids = set(rec.points3D.keys())
    by_name = {img.name: img for img in rec.images.values()}
    scales, rows = {}, []
    for k, name in enumerate(names):
        ws.status(stage="priors", message=f"MoGe-2 depth/normals {k + 1}/{len(names)}", progress=k / len(names))
        image = by_name[name]
        camera = rec.cameras[image.camera_id]
        rgb = cv2.cvtColor(cv2.imread(str(out_images / name)), cv2.COLOR_BGR2RGB)
        s = min(1.0, pc.prior_long_side / max(rgb.shape[:2]))  # maps are stored smaller; training upsamples them
        if s < 1.0:
            rgb = cv2.resize(rgb, (round(rgb.shape[1] * s), round(rgb.shape[0] * s)), interpolation=cv2.INTER_AREA)
        H, W = rgb.shape[:2]
        fx, fy, cx, cy = camera.params[:4] if camera.model_name == "PINHOLE" else (camera.params[0],) * 2 + tuple(camera.params[1:3])
        fx, fy, cx, cy = fx * W / camera.width, fy * H / camera.height, cx * W / camera.width, cy * H / camera.height
        with torch.no_grad():
            out = model.infer(torch.from_numpy(rgb).cuda().permute(2, 0, 1).float() / 255,
                              fov_x=math.degrees(2 * math.atan(W / (2 * fx))), resolution_level=cfg.priors.resolution_level)
        depth = out["depth"].float().cpu().numpy()
        mask = out["mask"].cpu().numpy().astype(bool) & np.isfinite(depth) & (depth > 0)
        normal = out["normal"].float().cpu().numpy() if "normal" in out else None
        if normal is not None:
            # Orient normals towards the camera (OpenCV camera frame: x right, y down, z forward).
            u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
            rays = np.stack([(u - cx) / fx, (v - cy) / fy, np.ones_like(u)], -1)
            normal = np.where((np.sum(normal * rays, -1) > 0)[..., None], -normal, normal)
            normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6)
            mask &= np.isfinite(normal).all(-1)

        uv, z, w = _observed_depths(rec, image, point_ids)
        uv = uv * [W / camera.width, H / camera.height]
        ui =np.clip(uv[:, 0].astype(int), 0, W - 1) if len(uv) else np.zeros(0, int)
        vi = np.clip(uv[:, 1].astype(int), 0, H - 1) if len(uv) else np.zeros(0, int)
        ok = mask[vi, ui] if len(uv) else np.zeros(0, bool)
        row = {"name": name, "points": int(ok.sum())}
        if ok.sum() >= cfg.priors.min_points:
            log_s, n_in, frac = robust_log_scale(z[ok], depth[vi[ok], ui[ok]], w[ok])
            if n_in >= cfg.priors.min_points and frac >= 0.5:
                scales[name] = log_s
            row.update(log_scale=log_s, inliers=n_in, inlier_fraction=frac)
        rows.append(row)
        np.savez(ws.priors / f"{name}.npz", depth=np.where(mask, depth, 0).astype(np.float16), mask=mask,
                 **({"normal": np.where(mask[..., None], normal, 0).astype(np.float16)} if normal is not None else {}))

    if stored is not None and stored.get("log_k") is not None:
        scales, log_k = stored["scales"], stored["log_k"]
        _apply_corrections(ws, names, scales, log_k)
        return {**stored.get("metrics", {}), "repaired": True}
    if len(scales) < max(5, 0.2 * len(names)):
        ws.log(f"WARNING only {len(scales)} frames had a reliable depth scale; priors disabled")
        shutil.rmtree(ws.priors, ignore_errors=True)
        ws.priors.mkdir()
        rec.write(_sparse_dir(ws))
        write_json(scales_path, {"log_k": None, "scales": {}})
        return {"priors": False, "metric_scale": False, "frames": len(names), "per_frame": rows,
                "warnings": ["Depth priors could not be aligned to the camera reconstruction; trained without them."]}

    log_values = np.array(list(scales.values()))
    log_k = float(np.median(log_values))
    mad = float(np.median(np.abs(log_values - log_k)))
    _apply_corrections(ws, names, scales, log_k)
    rec.transform(pycolmap.Sim3d(math.exp(-log_k), pycolmap.Rotation3d(), np.zeros(3)))
    rec.write(_sparse_dir(ws))
    metrics = {"priors": True, "metric_scale": True, "metres_per_original_unit": math.exp(-log_k),
               "scale_spread_mad_log": mad, "frames": len(names), "frames_with_reliable_scale": len(scales),
               "per_frame": rows}
    write_json(scales_path, {"log_k": log_k, "scales": scales, "metrics": metrics})
    return metrics


def _apply_corrections(ws, names, scales, log_k):
    """Per-frame correction so each saved prior matches the (metric) reconstruction."""
    for name in names:
        path = ws.priors / f"{name}.npz"
        data = dict(np.load(path))
        correction = math.exp(scales.get(name, log_k) - log_k)
        data["depth"] = (data["depth"].astype(np.float32) * correction).astype(np.float16)
        data["scale_reliable"] = np.array(name in scales)
        np.savez(path, **data)


def _undistort(ws, long_side):
    """Training images straight from the original frames (sfm/undistorted is only 1920 px)."""
    out = ws.root / "undistorted"
    shutil.rmtree(out, ignore_errors=True)
    ws.status(stage="priors", message=f"Undistorting frames at {long_side} px")
    options = pycolmap.UndistortCameraOptions()
    options.max_image_size = long_side
    pycolmap.undistort_images(out, ws.sfm / "sparse", ws.frames / "images", output_type="COLMAP",
                              undistort_options=options, jpeg_quality=95)
    return out


def _sparse_dir(ws):
    path = ws.dataset / "sparse"
    path.mkdir(parents=True, exist_ok=True)
    return path
