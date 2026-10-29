"""Pick sharp, well-overlapping frames from a video (PyAV BSD-3, OpenCV Apache-2.0).

Pass 1 decodes every frame at reduced size and measures
  sharpness = sqrt(var(Laplacian) * mean(Sobel^2)), relative to its +-1 s rolling median, and
  motion    = median forward/backward-checked Lucas-Kanade flow, as a fraction of the width.
A keyframe is triggered when the accumulated motion since the last one reaches `shift` or `max_gap`
seconds pass (never before `min_gap`); the sharpest frame within +-`window` s of the trigger wins.
Pass 2 decodes again and writes only the chosen frames at full resolution.
"""
import csv
import math
from concurrent.futures import ThreadPoolExecutor

import av
import cv2
import numpy as np


def _colorspace(frame):
    cs = int(frame.colorspace)  # 1 = BT.709, 2 = unspecified
    if cs in (0, 2) or cs > 10:
        return "ITU709" if frame.height >= 720 else "ITU601"
    return cs


def _color_range(frame):
    r = int(frame.color_range)  # 1 = limited (MPEG), 2 = full (JPEG)
    return r if r in (1, 2) else 1


def _gray(frame, width):
    height = int(round(frame.height * width / frame.width / 2) * 2)
    return frame.reformat(width=width, height=height, format="gray", src_colorspace=_colorspace(frame),
                          src_color_range=_color_range(frame), dst_color_range="JPEG",
                          interpolation="AREA").to_ndarray()


def _rgb(frame):
    return frame.reformat(format="rgb24", src_colorspace=_colorspace(frame), src_color_range=_color_range(frame),
                          dst_color_range="JPEG", interpolation="BICUBIC").to_ndarray()


def _sharpness(gray):
    g = gray.astype(np.float32)
    lap = cv2.Laplacian(g, cv2.CV_32F, ksize=3).var()
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return math.sqrt(max(float(lap), 1e-6) * max(float(np.mean(gx * gx + gy * gy)), 1e-6))


def _motion(prev, cur):
    pts = cv2.goodFeaturesToTrack(prev, maxCorners=500, qualityLevel=0.01, minDistance=7)
    if pts is None or len(pts) < 20:
        return float("nan")
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=4)
    back, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, nxt, None, winSize=(21, 21), maxLevel=4)
    ok = (st[:, 0] == 1) & (st2[:, 0] == 1) & (np.linalg.norm((back - pts)[:, 0], axis=1) < 1.0)
    if ok.sum() < 20:
        return float("nan")
    return float(np.median(np.linalg.norm((nxt - pts)[ok, 0], axis=1))) / prev.shape[1]


def _in_range(t, cfg):
    return t >= cfg.start_s and (cfg.end_s <= 0 or t <= cfg.end_s)


def analyse(video, cfg, progress=None):
    rows, prev = [], None
    with av.open(str(video)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        fps = float(stream.average_rate or stream.guessed_rate or 30)
        total = stream.frames or 0
        for i, frame in enumerate(container.decode(stream)):
            t = float(frame.pts * stream.time_base) if frame.pts is not None else i / fps
            if cfg.end_s > 0 and t > cfg.end_s:
                break
            if not _in_range(t, cfg):
                continue
            gray = _gray(frame, min(cfg.sharp_width, frame.width))
            small = cv2.resize(gray, (cfg.flow_width, int(round(gray.shape[0] * cfg.flow_width / gray.shape[1]))),
                               interpolation=cv2.INTER_AREA)
            rows.append({"idx": i, "t": t, "sharp": _sharpness(gray),
                         "motion": 0.0 if prev is None else _motion(prev, small), "luma": float(small.mean())})
            prev = small
            if progress and i % 300 == 0:
                progress(i, total)
    return rows, fps


def select(rows, fps, cfg, min_gap):
    n = len(rows)
    sharp = np.array([r["sharp"] for r in rows])
    half = max(1, int(fps))
    rolling = np.array([np.median(sharp[max(0, i - half): i + half + 1]) for i in range(n)])
    rel = sharp / np.maximum(rolling, 1e-9)
    motion = np.array([r["motion"] for r in rows])
    motion = np.where(np.isnan(motion), cfg.shift, motion)  # lost tracking forces a keyframe
    cum = np.cumsum(motion)
    t = np.array([r["t"] for r in rows])
    w = max(1, int(round(cfg.window * fps)))
    first = int(np.argmax(rel[: max(1, int(fps * 0.5))]))
    chosen, last = [first], first
    while True:
        k = last + 1
        while k < n and not (t[k] - t[last] >= min_gap and (cum[k] - cum[last] >= cfg.shift or t[k] - t[last] >= cfg.max_gap)):
            k += 1
        if k >= n:
            break
        candidates = [j for j in range(max(last + 1, k - w), min(n, k + w + 1)) if t[j] - t[last] >= min_gap] or [k]
        good = [j for j in candidates if rel[j] >= cfg.min_rel_sharp]
        last = max(good or candidates, key=lambda j: rel[j])
        chosen.append(last)
    for i, r in enumerate(rows):
        r["rel_sharp"] = float(rel[i])
    return chosen, cum


def export(video, wanted, out_dir, quality):
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = set(wanted)
    params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    with ThreadPoolExecutor(max_workers=8) as pool, av.open(str(video)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        futures = []
        for i, frame in enumerate(container.decode(stream)):
            if i in wanted:
                path = out_dir / f"frame_{i:06d}.jpg"
                futures.append(pool.submit(cv2.imwrite, str(path), cv2.cvtColor(_rgb(frame), cv2.COLOR_RGB2BGR), params))
            if i >= max(wanted):
                break
        ok = all(f.result() for f in futures)
    if not ok:
        raise RuntimeError("Writing selected frames failed")


def run(ws, cfg, video):
    fc = cfg.frames
    ws.status(stage="frames", message="Measuring sharpness and motion of every frame")
    rows, fps = analyse(video, fc, lambda i, n: ws.status(progress=i / n if n else None))
    if len(rows) < 10:
        raise RuntimeError(f"Only {len(rows)} frames decoded from {video}")
    min_gap = fc.min_gap
    chosen, cum = select(rows, fps, fc, min_gap)
    while len(chosen) > fc.max_frames:
        min_gap *= 1.25
        chosen, cum = select(rows, fps, fc, min_gap)
    images = ws.frames / "images"
    for old in images.glob("*.jpg"):
        old.unlink()
    ws.status(message=f"Writing {len(chosen)} full-resolution frames", progress=None)
    export(video, [rows[j]["idx"] for j in chosen], images, fc.jpeg_quality)
    selected = set(chosen)
    with open(ws.frames / "frame_metrics.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) + ["selected"])
        writer.writeheader()
        for j, r in enumerate(rows):
            writer.writerow({**r, "selected": int(j in selected)})
    gaps = np.diff(cum[chosen]) if len(chosen) > 1 else np.array([0.0])
    duration = rows[-1]["t"] - rows[0]["t"]
    return {"decoded_frames": len(rows), "video_fps": fps, "selected": len(chosen),
            "selected_per_second": round(len(chosen) / duration, 3) if duration else None, "min_gap_used": min_gap,
            "median_shift": float(np.median(gaps)), "gaps_over_2_5x_shift": int((gaps > 2.5 * fc.shift).sum()),
            "median_rel_sharpness": float(np.median([rows[j]["rel_sharp"] for j in chosen]))}
