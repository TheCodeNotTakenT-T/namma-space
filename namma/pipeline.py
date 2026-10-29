"""Video -> frames -> camera poses -> depth/normal priors -> splat training -> collision mesh -> DOWNLOAD_THIS.

Every stage writes a receipt when it finishes; a rerun skips stages whose receipt matches the current
settings and whose outputs exist, and training resumes from its newest checkpoint. Finished stages
and checkpoints are queued for the Drive uploader (namma.backup).
"""
import re
import shutil
import time
import traceback
from pathlib import Path

from namma import backup
from namma.config import Config, smoke_config
from namma.workspace import STAGES, Workspace, sha256_file, write_json

SECTIONS = {"frames": ("frames",), "sfm": ("frames", "sfm"), "priors": ("frames", "sfm", "priors"),
            "train": ("frames", "sfm", "priors", "train"), "mesh": ("frames", "sfm", "priors", "train", "mesh"),
            "export": ("frames", "sfm", "priors", "train", "mesh")}


def create_job(job_dir, job_id, video, sha256, name, smoke=False, overrides=None):
    ws = Workspace(job_dir)
    if not (ws.root / "job.json").exists():
        settings = (smoke_config() if smoke else Config()).to_dict()
        for section, values in (overrides or {}).items():
            settings[section].update(values)
        write_json(ws.root / "job.json", {"job_id": job_id, "video_name": name, "video_path": str(video),
                                          "video_sha256": sha256, "smoke": smoke, "created": time.time(),
                                          "config": Config.from_dict(settings).to_dict()})
    return ws


def prepare(video, jobs_root, overrides=None):
    """Move a fetched video into its job folder (named after its content) and create the job plus a smoke test."""
    video = Path(video)
    sha256 = sha256_file(video)
    stem = re.sub(r"[^A-Za-z0-9]+", "-", video.stem).strip("-")[:40] or "video"
    job_id = f"{stem}-{sha256[:10]}"
    main = Workspace(Path(jobs_root) / job_id)
    target = main.input / ("video" + video.suffix.lower())
    ours = (Path(jobs_root) / "_incoming").resolve() in video.resolve().parents  # a copy fetched from Drive
    if video.resolve() != target.resolve():
        if target.exists() and target.stat().st_size == video.stat().st_size:
            if ours:
                video.unlink()
        elif ours:
            video.replace(target)
        else:  # never move or delete a user's own file
            shutil.copy2(video, target)
    create_job(main.root, job_id, target, sha256, video.name, overrides=overrides)
    smoke = create_job(Path(jobs_root) / f"{job_id}-smoke", f"{job_id}-smoke", target, sha256, video.name, smoke=True)
    return {"job_id": job_id, "job": str(main.root), "smoke_job": str(smoke.root), "video": str(target)}


def _stage(ws, cfg, name, repair=False):
    from namma import export, frames, mesh, priors, sfm, trainer
    if name == "frames":
        return frames.run(ws, cfg, ws.job["video_path"]), [ws.frames / "images", ws.frames / "frame_metrics.csv"]
    if name == "sfm":
        return sfm.run(ws, cfg), [ws.sfm / "sparse", ws.sfm / "undistorted" / "sparse", ws.sfm / "undistorted" / "images"]
    if name == "priors":
        return priors.run(ws, cfg, repair=repair), [ws.dataset / "sparse", ws.dataset / "images", ws.priors]
    if name == "train":
        def on_checkpoint(path, step):
            _safe_commit(ws, "checkpoint", files=[path], meta={"step": step, "settings": cfg.stage_hash("frames", "sfm", "priors", "train")})
        return trainer.run(ws, cfg, on_checkpoint=on_checkpoint)
    if name == "mesh":
        return mesh.run(ws, cfg)
    if name == "export":
        return export.run(ws, cfg)
    raise KeyError(name)


def _safe_commit(ws, stage, **kwargs):
    """A failed backup must not fail a finished stage; the work is still on local disk."""
    try:
        backup.commit(ws, stage, **kwargs)
    except Exception as error:
        ws.log(f"WARNING could not queue {stage} for Drive backup: {type(error).__name__}: {error}")


def run(job_dir, until=None):
    ws = Workspace(job_dir)
    job = ws.job
    if not job:
        raise RuntimeError(f"{job_dir} has no job.json; create the job first")
    cfg = Config.from_dict(job["config"])
    ws.status(state="running", started=time.time(), error=None)
    ws.log(f"Job {job['job_id']} ({'smoke test' if job.get('smoke') else 'full run'})")
    try:
        for name in STAGES:
            settings = cfg.stage_hash(*SECTIONS[name])
            if ws.is_done(name, settings):
                ws.log(f"{name}: already done, skipping")
                continue
            # Priors can be rebuilt from a restored scale file without changing the reconstruction, so
            # later stages stay valid; any other re-run makes them stale.
            repair = name == "priors" and (ws.receipt(name) or {}).get("settings") == settings
            if not repair:
                ws.invalidate_from(name)
            started = time.time()
            ws.status(stage=name, message="starting", progress=None)
            ws.log(f"{name}: starting")
            result = _stage(ws, cfg, name, repair)
            metrics, outputs = result if isinstance(result, tuple) else (result, [])
            ws.finish(name, settings, outputs, metrics, started)
            _safe_commit(ws, name, files=[p for p in outputs if Path(p).is_file()] if name == "train" else (),
                         tar_paths=backup.STAGE_FILES.get(name, ()))
            if name == "export":  # the result as plain files, downloadable straight from Drive
                _safe_commit(ws, "download", files=sorted(p for p in (ws.export / "DOWNLOAD_THIS").rglob("*") if p.is_file()))
            ws.log(f"{name}: done in {time.time() - started:.0f} s")
            if name == until:
                break
        ws.status(state="finished" if until in (None, "export") else "paused", stage=None, message="done", progress=1.0)
        return 0
    except Exception as error:
        ws.log("FAILED: " + "".join(traceback.format_exception(error))[-4000:])
        ws.status(state="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc()[-6000:])
        return 1
