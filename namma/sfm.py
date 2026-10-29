"""Camera poses with pycolmap (BSD-3), CPU SIFT only.

COLMAP's GPU SIFT is SiftGPU, licensed for non-profit research only, so it is never used here; the
PyPI pycolmap wheel has no CUDA, which guarantees that. Matching is sequential (video order) plus a
quadratic long-range pass and, if the vocabulary tree can be fetched, loop detection. The global
mapper runs first; the incremental mapper is tried when too few frames register.
"""
import shutil
import urllib.request

import numpy as np
import pycolmap


def cam_from_world(image):
    pose = image.cam_from_world
    return pose() if callable(pose) else pose


def camera_center(image):
    pose = cam_from_world(image)
    R = np.asarray(pose.rotation.matrix())
    return -R.T @ np.asarray(pose.translation)


def _rotation_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def level_and_center(rec):
    """Rotate so the average camera 'up' becomes world -Y (OpenCV/COLMAP convention), centre on the cameras."""
    ups, centers = [], []
    for image in rec.images.values():
        if not image.has_pose:
            continue
        R = np.asarray(cam_from_world(image).rotation.matrix())
        ups.append(R.T @ np.array([0.0, -1.0, 0.0]))
        centers.append(camera_center(image))
    up = np.mean(ups, axis=0)
    R = _rotation_between(up, np.array([0.0, -1.0, 0.0]))
    t = -R @ np.median(centers, axis=0)  # median: one far-off camera must not move the origin
    rec.transform(pycolmap.Sim3d(1.0, pycolmap.Rotation3d(R), t))
    return {"up_tilt_deg": float(np.degrees(np.arccos(np.clip(-up[1] / np.linalg.norm(up), -1, 1)))),
            "up_consistency": float(np.linalg.norm(up))}


def _vocab_tree(ws, url, log):
    path = ws.root.parent / "_assets" / url.rsplit("/", 1)[-1]
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            log(f"Downloading vocabulary tree {url}")
            tmp = path.with_suffix(".part")
            urllib.request.urlretrieve(url, tmp)
            tmp.rename(path)
        except Exception as error:  # loop detection is an improvement, not a requirement
            log(f"Vocabulary tree unavailable ({error}); continuing without loop detection")
            return None
    return path


def outlier_cameras(rec, factor):
    """Registered images whose centre lies far outside the rest (global mapping can place a few absurdly)."""
    ids = [i for i, img in rec.images.items() if img.has_pose]
    if len(ids) < 5:
        return []
    centers = np.array([camera_center(rec.images[i]) for i in ids])
    dist = np.linalg.norm(centers - np.median(centers, axis=0), axis=1)
    limit = factor * max(float(np.median(dist)), 1e-9)
    return [i for i, d in zip(ids, dist) if d > limit]


def _summary(rec, total, factor=6.0):
    outliers = len(outlier_cameras(rec, factor))
    return {"registered": rec.num_reg_images() - outliers, "outlier_cameras": outliers, "total": total,
            "fraction": (rec.num_reg_images() - outliers) / max(total, 1),
            "points": rec.num_points3D(), "mean_reprojection_error": rec.compute_mean_reprojection_error(),
            "mean_track_length": rec.compute_mean_track_length()}


def _best(recs):
    return max(recs.values(), key=lambda r: (r.num_reg_images(), -r.compute_mean_reprojection_error())) if recs else None


def run(ws, cfg):
    sc = cfg.sfm
    images = ws.frames / "images"
    names = sorted(p.name for p in images.glob("*.jpg"))
    if len(names) < 10:
        raise RuntimeError(f"Only {len(names)} frames to reconstruct")
    for old in ("database.db", "global", "incremental", "sparse", "undistorted"):
        target = ws.sfm / old
        shutil.rmtree(target, ignore_errors=True) if target.is_dir() else target.unlink(missing_ok=True)
    db = ws.sfm / "database.db"

    ws.status(stage="sfm", message=f"Extracting SIFT features from {len(names)} frames (CPU)", progress=None)
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = sc.camera_model
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.use_gpu = False
    extraction.max_image_size = sc.max_image_size
    extraction.sift.max_num_features = sc.max_features
    pycolmap.extract_features(db, images, image_names=names, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=reader, extraction_options=extraction, device=pycolmap.Device.cpu)

    matching = pycolmap.FeatureMatchingOptions()
    matching.use_gpu = False
    matching.guided_matching = True
    pairing = pycolmap.SequentialPairingOptions()
    pairing.overlap = sc.overlap
    pairing.quadratic_overlap = False
    vocab = _vocab_tree(ws, sc.vocab_tree_url, ws.log) if sc.loop_detection and len(names) > 60 else None
    if vocab:
        pairing.loop_detection = True
        pairing.vocab_tree_path = str(vocab)
        pairing.loop_detection_period = 5
        pairing.loop_detection_num_images = 30
        pairing.loop_detection_min_index_distance = 30
    ws.status(message=f"Matching neighbouring frames (overlap {sc.overlap}, loop detection {'on' if vocab else 'off'})")
    pycolmap.match_sequential(db, matching_options=matching, pairing_options=pairing, device=pycolmap.Device.cpu)
    if sc.quadratic_overlap > 0:
        far = pycolmap.SequentialPairingOptions()
        far.overlap = sc.quadratic_overlap
        far.quadratic_overlap = True
        ws.status(message="Matching long-range frame pairs")
        pycolmap.match_sequential(db, matching_options=matching, pairing_options=far, device=pycolmap.Device.cpu)

    candidates = {}
    if sc.mapper in ("auto", "global"):
        ws.status(message="Global mapping (rotation averaging + global positioning)")
        out = ws.sfm / "global"
        out.mkdir()
        try:
            best = _best(pycolmap.global_mapping(db, images, out))
            if best is not None:
                candidates["global"] = best
                ws.log(f"global mapper: {_summary(best, len(names), sc.outlier_factor)}")
        except Exception as error:
            ws.log(f"global mapper failed: {error}")
    glob = _summary(candidates["global"], len(names), sc.outlier_factor) if candidates else None
    if sc.mapper == "incremental" or (sc.mapper == "auto" and (
            glob is None or glob["fraction"] < sc.warn_registered or glob["outlier_cameras"] > 0
            or glob["mean_reprojection_error"] > sc.max_global_error)):
        ws.status(message="Incremental mapping")
        out = ws.sfm / "incremental"
        out.mkdir()
        best = _best(pycolmap.incremental_mapping(db, images, out))
        if best is not None:
            candidates["incremental"] = best
            ws.log(f"incremental mapper: {_summary(best, len(names), sc.outlier_factor)}")
    if not candidates:
        raise RuntimeError("COLMAP could not reconstruct any cameras")
    # Among models that pose at least 95% as many (non-outlier) frames as the best one, take the most accurate.
    scored = {k: _summary(v, len(names), sc.outlier_factor) for k, v in candidates.items()}
    most = max(s["registered"] for s in scored.values())
    mapper = min((k for k, s in scored.items() if s["registered"] >= 0.95 * most),
                 key=lambda k: scored[k]["mean_reprojection_error"])
    rec, summary = candidates[mapper], scored[mapper]
    ws.log(f"chose the {mapper} reconstruction: {summary}")
    if summary["fraction"] < sc.min_registered:
        raise RuntimeError(f"Only {summary['registered']}/{len(names)} frames got a camera pose "
                           f"({summary['fraction']:.0%} < {sc.min_registered:.0%}). The video may move too fast, "
                           f"be blurry, or lack texture. Details: {summary}")
    warnings = []
    if summary["fraction"] < sc.warn_registered:
        warnings.append(f"Only {summary['registered']}/{len(names)} frames ({summary['fraction']:.0%}) got a camera pose; "
                        "parts of the room seen only in the other frames will be missing.")
        ws.log("WARNING " + warnings[-1])
    level = level_and_center(rec)
    sparse = ws.sfm / "sparse"
    sparse.mkdir()
    rec.write(sparse)

    ws.status(message="Undistorting frames to training resolution")
    undistort = pycolmap.UndistortCameraOptions()
    undistort.max_image_size = sc.train_long_side
    pycolmap.undistort_images(ws.sfm / "undistorted", sparse, images, output_type="COLMAP",
                              undistort_options=undistort, jpeg_quality=95)
    return {"mapper": mapper, **summary, **level, "candidates": {k: _summary(v, len(names)) for k, v in candidates.items()},
            "loop_detection": bool(vocab), "warnings": warnings}  # outlier cameras are dropped by trainer.load_dataset
