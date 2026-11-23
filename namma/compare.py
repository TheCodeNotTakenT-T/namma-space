"""Side-by-side comparison of trained rooms that share one camera solve (the same frames and poses).

    python -m namma compare --jobs JOB_A JOB_B [...] --names baseline ppisp --out DIR

For held-out frames (never used in training) it renders every job's final model and writes:
    DIR/compare_<frame>.jpg   photo | job A | job B ... with each job's name and PSNR on the image
    DIR/report.json, report.md  the scores each job's training measured, plus the same scores re-measured
                                here on the rendered views, so every number comes from one code path
The renders are the plain models, as the web viewer shows them.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch

from namma.config import Config
from namma.trainer import color_matched, load_dataset, psnr_value, render, split, ssim_value
from namma.workspace import Workspace, read_json, write_json

SCORES = ("psnr", "ssim", "cc_psnr", "cc_ssim", "isp_psnr")


def _label(image, text):
    """Name and score in a dark band at the top of one tile (BGR uint8)."""
    band = max(28, image.shape[0] // 22)
    image[:band] = (image[:band] * 0.35).astype(np.uint8)
    cv2.putText(image, text, (10, int(band * 0.72)), cv2.FONT_HERSHEY_SIMPLEX, band / 40, (255, 255, 255), 2, cv2.LINE_AA)
    return image


def compare(job_dirs, names, out_dir, views=8, device="cuda"):
    jobs = [Workspace(d) for d in job_dirs]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cfg = Config.from_dict(jobs[0].job["config"])
    frames, _, _ = load_dataset(jobs[0], with_priors=False)
    _, test_ids = split(frames, cfg.train.test_every)
    picks = [test_ids[i] for i in np.linspace(0, len(test_ids) - 1, min(views, len(test_ids))).round().astype(int)] if test_ids else []
    models = []
    for ws in jobs:
        final = torch.load(ws.train / "final.pt", map_location=device, weights_only=False)
        models.append(({k: v.to(device) for k, v in final["splats"].items()}, final["sh_degree"]))

    measured = {name: {"psnr": [], "ssim": [], "cc_psnr": []} for name in names}
    sheets = []
    with torch.no_grad():
        for i in picks:
            frame = frames[i]
            gt = frame.image.to(device).float()[None] / 255.0
            tiles = [_label(frame.image.numpy()[..., ::-1].copy(), "photo (held out)")]
            for name, (splats, sh_degree) in zip(names, models):
                rgb = render(splats, frame, sh_degree, device, mode="RGB")[0][..., :3].clamp(0, 1)
                psnr = psnr_value(rgb, gt)
                measured[name]["psnr"].append(psnr)
                measured[name]["ssim"].append(ssim_value(rgb, gt))
                measured[name]["cc_psnr"].append(psnr_value(color_matched(rgb, gt), gt))
                tile = (rgb[0].cpu().numpy()[..., ::-1] * 255).astype(np.uint8).copy()
                tiles.append(_label(tile, f"{name}  {psnr:.2f} dB"))
            sheet = np.concatenate(tiles, axis=1)
            scale = min(1.0, 3600 / sheet.shape[1])
            sheet = cv2.resize(sheet, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            path = out / f"compare_{Path(frame.name).stem}.jpg"
            cv2.imwrite(str(path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])
            sheets.append(path.name)

    report = {"frames_compared": [frames[i].name for i in picks], "sheets": sheets, "jobs": {}}
    for name, ws in zip(names, jobs):
        trained = read_json(ws.train / "eval.json", {}) or (read_json(ws.stages / "train.json", {}) or {}).get("metrics", {})
        report["jobs"][name] = {
            "job": str(ws.root), "settings": ws.job["config"]["train"],
            "training_scores": {k: trained.get(k) for k in (*SCORES, "gaussians", "minutes", "exported_step", "colour_model")},
            "these_views": {k: round(float(np.mean(v)), 3) for k, v in measured[name].items() if v},
        }
    write_json(out / "report.json", report)
    lines = ["# Quality comparison", "", f"Same camera solve and depth priors; {len(picks)} held-out frames rendered from each final model.", "",
             "| run | PSNR (viewer) | SSIM | colour-matched PSNR | PPISP-corrected PSNR | Gaussians | minutes |", "|---|---|---|---|---|---|---|"]
    for name, data in report["jobs"].items():
        t = data["training_scores"]
        cell = lambda v, f: (f.format(v) if isinstance(v, (int, float)) else "-")
        lines.append(f"| {name} | {cell(t.get('psnr'), '{:.2f}')} | {cell(t.get('ssim'), '{:.4f}')} | {cell(t.get('cc_psnr'), '{:.2f}')} | "
                     f"{cell(t.get('isp_psnr'), '{:.2f}')} | {cell(t.get('gaussians'), '{:,}')} | {cell(t.get('minutes'), '{}')} |")
    lines += ["", "PSNR (viewer): the plain render against the photo, which is what the web viewer shows.",
              "Colour-matched: after the best colour map onto the photo, so exposure differences do not count; what remains is detail and geometry.",
              "", *[f"![{s}]({s})" for s in sheets]]
    (out / "report.md").write_text("\n".join(lines) + "\n")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m namma compare")
    parser.add_argument("--jobs", nargs="+", required=True)
    parser.add_argument("--names", nargs="+")
    parser.add_argument("--out", required=True)
    parser.add_argument("--views", type=int, default=8)
    args = parser.parse_args(argv)
    names = args.names or [Path(j).name for j in args.jobs]
    if len(names) != len(args.jobs):
        parser.error("give one name per job")
    print(json.dumps(compare(args.jobs, names, args.out, args.views)["jobs"], indent=1))
    return 0
