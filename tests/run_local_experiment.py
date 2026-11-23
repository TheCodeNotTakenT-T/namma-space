"""Local GPU test of the quality experiment (namma.experiment) with the real gsplat and PPISP.

    python tests/run_local_experiment.py VIDEO WORK_DIR [--small]

Needs a CUDA GPU and a venv at <repo>/.venv with gsplat and ppisp installed (setup is not run here).
Builds a tiny source room from the clip, backs it up to a local folder standing in for Google Drive,
then runs the experiment on it: baseline and PPISP variants restored from that "Drive", PPISP training
killed after its first checkpoint and resumed, side-by-side report written and uploaded.
Small images and few steps: it tests the plumbing and the PPISP integration, not image quality.
--small: 48 px images and at most 4000 Gaussians, for the stand-in renderer (tests/fake_gsplat.py installed
as the venv's gsplat) on a laptop GPU that cannot compile gsplat; then gsplat itself is not tested.
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
SOURCE = {"frames": {"end_s": 12.0},
          "sfm": {"train_long_side": 240, "min_registered": 0.4, "loop_detection": False, "max_image_size": 1280},
          "priors": {"enabled": False, "image_long_side": 240, "prior_long_side": 240},
          "train": {"steps": 300, "cap_max": 20000, "checkpoint_every": 100, "preview_every": 100, "normal_start": 100,
                    "sh_degree_interval": 60, "test_every": 6, "min_psnr": 0.0},
          "mesh": {"render_long_side": 160, "max_views": 24, "voxel": 0.05, "target_triangles": 20000}}
# The source job's own settings are not on Drive (only its results), so the experiment starts from the
# defaults; here the source's tiny settings go along so the restored data and the settings agree.
EXPERIMENT = {**SOURCE, "train": {**SOURCE["train"], "steps": 600, "checkpoint_every": 200, "preview_every": 200}}
if "--small" in sys.argv:
    SOURCE = {**SOURCE, "sfm": {**SOURCE["sfm"], "train_long_side": 48}, "train": {**SOURCE["train"], "cap_max": 4000},
              "priors": {**SOURCE["priors"], "image_long_side": 48, "prior_long_side": 48},
              "mesh": {**SOURCE["mesh"], "render_long_side": 48, "max_views": 16}}
    EXPERIMENT = {**SOURCE, "train": {**SOURCE["train"], "steps": 600, "checkpoint_every": 200, "preview_every": 200}}


def check(condition, message):
    print(("PASS " if condition else "FAIL ") + message, flush=True)
    if not condition:
        sys.exit(1)


def experiment(job_id, root, drive, kill_when=None):
    cmd = [sys.executable, "-m", "namma.experiment", "run", "--source-job", job_id, "--variants", "baseline", "ppisp",
           "--root", str(root), "--fs", f"local:{drive}", "--settings", json.dumps(EXPERIMENT)]
    env = {**os.environ, "PYTHONPATH": str(REPO)}
    proc = subprocess.Popen(cmd, cwd=REPO, env=env, start_new_session=True)
    if kill_when:
        while proc.poll() is None and not kill_when():
            time.sleep(1)
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)   # like a molab shutdown: the run and its pipeline die
            proc.wait()
            subprocess.run(["pkill", "-f", "namma.backup upload"], check=False)
            return "killed"
    return proc.wait()


def main(video, work):
    import shutil
    from namma import backup, pipeline
    from namma.workspace import Workspace, read_json
    work = Path(work)
    shutil.rmtree(work, ignore_errors=True)
    (work / "incoming").mkdir(parents=True)
    shutil.copy(video, work / "incoming" / "clip.mp4")
    drive = work / "drive"

    info = pipeline.prepare(work / "incoming" / "clip.mp4", work / "jobs", SOURCE)
    check(pipeline.run(info["job"]) == 0, "source room: every stage with the real gsplat")
    check(backup.upload_loop(info["job"], f"NammaSpaceBackups/{info['job_id']}", f"local:{drive}", once=True) == 0,
          "source room backed up to the local 'Drive'")

    root = work / "experiment"
    (root / "done").mkdir(parents=True)
    (root / "done" / "setup.json").write_text("{}")   # the environment is this venv; molab_setup.sh is not run here
    ppisp_job = root / "jobs" / f"{info['job_id']}-ppisp"
    first = ppisp_job / "train" / "ckpt" / "step_000200.pt"
    check(experiment(info["job_id"], root, drive, kill_when=first.exists) == "killed", "PPISP training killed after its first checkpoint")
    check(experiment(info["job_id"], root, drive) == 0, "experiment rerun finishes")

    status = read_json(root / "status.json", {})
    check(status.get("state") == "finished", f"experiment finished ({status.get('error')})")
    log = (ppisp_job / "logs" / "pipeline.log").read_text()
    check("Resumed training at step 200" in log, "PPISP training resumed from step 200 (PPISP state restored)")
    check("Gaussians frozen; PPISP controller distillation" in log, "Gaussians frozen for the controller's last sixth")
    baseline_log = (root / "jobs" / f"{info['job_id']}-baseline" / "logs" / "pipeline.log").read_text()
    check("frames: already done" in baseline_log and "sfm: already done" in baseline_log, "frames and camera solve reused, not recomputed")
    for name in ("baseline", "ppisp"):
        metrics = Workspace(root / "jobs" / f"{info['job_id']}-{name}").receipt("train")["metrics"]
        check(all(k in metrics for k in ("psnr", "ssim", "cc_psnr", "cc_ssim")), f"{name}: viewer and colour-matched scores")
        check(metrics["cc_psnr"] >= metrics["psnr"] - 1e-6, f"{name}: colour matching never lowers PSNR ({metrics['psnr']:.2f} -> {metrics['cc_psnr']:.2f})")
        check(metrics.get("colour_model") == ("ppisp" if name == "ppisp" else "affine"), f"{name}: colour model recorded")
        check(any((root / "jobs" / f"{info['job_id']}-{name}" / "export" / "DOWNLOAD_THIS").rglob("*.json")), f"{name}: viewer-ready export")
    check("isp_psnr" in Workspace(ppisp_job).receipt("train")["metrics"], "ppisp: PPISP-corrected score for new views")
    report = read_json(root / "report" / "report.json", {})
    check(set(report.get("jobs", {})) == {"baseline", "ppisp"} and report.get("sheets"), f"report with {len(report.get('sheets', []))} side-by-side sheets")
    uploaded = {p.name for p in (drive / "NammaQuality" / f"{info['job_id']}-report").glob("*")}
    check({"report.json", "report.md"} <= uploaded and any(n.startswith("compare_") for n in uploaded), "report uploaded to the 'Drive'")
    print(json.dumps({n: d["training_scores"] for n, d in report["jobs"].items()}, indent=1))
    print("ALL LOCAL EXPERIMENT CHECKS PASSED")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--small"]
    main(args[0], args[1])
