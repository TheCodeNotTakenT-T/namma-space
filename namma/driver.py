"""Start or resume a reconstruction from the notebook: one detached process per click.

Runs with the notebook's Python (it holds molab's Google Drive login) and drives the GPU venv:
  1. copy the video from Drive (sessions start empty),
  2. create the job (named after the video's content, so every session finds the same backups),
  3. restore whatever is already verified on Drive, then start one uploader per job,
  4. run the ~10 minute smoke test (first 20 s of video, tiny settings) unless it already passed,
  5. run or resume the full job.
Progress goes to <jobs-root>/driver_status.json; each job keeps its own status.json.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

from namma import backup
from namma.workspace import read_json, write_json


def _status(root, **fields):
    current = read_json(root / "driver_status.json", {})
    current.update(fields, updated=time.time())
    write_json(root / "driver_status.json", current)


def notebook_env(repo):
    """The notebook's own environment (Drive login, gdrive_fsspec) with this repository importable."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(p for p in (repo, env.get("PYTHONPATH", "")) if p)
    return env


def venv_env():
    """molab sets PYTHONPATH/PYTHONSAFEPATH for its own Python; they break the GPU venv."""
    return {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONSAFEPATH", "PYTHONHOME")}


def _uploader(job, remote, fs_spec, repo):
    log = open(Path(job) / "logs" / "uploader.log", "ab")
    return subprocess.Popen([sys.executable, "-m", "namma.backup", "upload", "--job", job, "--remote", remote, "--fs", fs_spec],
                            cwd=repo, env=notebook_env(repo), stdin=subprocess.DEVNULL, stdout=log,
                            stderr=subprocess.STDOUT, start_new_session=True)


def _run_stage_process(venv_py, job, repo, log_name):
    with open(Path(job) / "logs" / log_name, "ab") as log:
        return subprocess.run([venv_py, "-m", "namma", "run", "--job", job], cwd=repo, env=venv_env(),
                              stdout=log, stderr=subprocess.STDOUT).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m namma.driver")
    parser.add_argument("--video", required=True, help="Video path on Google Drive (or a local file with --local-video)")
    parser.add_argument("--jobs-root", default="/opt/namma-jobs")
    parser.add_argument("--remote-root", default="NammaSpaceBackups")
    parser.add_argument("--venv-python", required=True)
    parser.add_argument("--skip-smoke", action="store_true")
    parser.add_argument("--local-video", action="store_true")
    parser.add_argument("--fs", default="drive")
    parser.add_argument("--settings", help="JSON overrides for a new job")
    args = parser.parse_args(argv)
    repo = str(Path(__file__).resolve().parents[1])
    root = Path(args.jobs_root)
    root.mkdir(parents=True, exist_ok=True)
    _status(root, state="running", step="starting", error=None, video=args.video, started=time.time())
    try:
        if args.local_video:
            video = args.video
        else:
            _status(root, step="copying the video from Google Drive")
            video = backup.fetch_video(root / "_incoming", args.video, args.fs)["video"]
        _status(root, step="creating the job (hashing the video)")
        cmd = [args.venv_python, "-m", "namma", "prepare", "--video", video, "--jobs-root", str(root)]
        if args.settings:
            cmd += ["--settings", args.settings]
        prepared = subprocess.run(cmd, cwd=repo, env=venv_env(), capture_output=True, text=True)
        if prepared.returncode:
            raise RuntimeError("prepare failed:\n" + prepared.stdout[-2000:] + prepared.stderr[-4000:])
        info = json.loads(prepared.stdout.strip().splitlines()[-1])
        _status(root, job=info["job"], smoke_job=info["smoke_job"], job_id=info["job_id"])
        jobs = [(info["smoke_job"], f"{args.remote_root}/{info['job_id']}-smoke"), (info["job"], f"{args.remote_root}/{info['job_id']}")]
        backup.ensure_folders([args.remote_root] + [remote for _, remote in jobs], args.fs)
        try:  # keep this session's compiled gsplat so the next session's setup skips compiling
            _status(root, step="saving the compiled gsplat build to Drive", cache=backup.cache_sync(
                "/opt/namma-cache", f"{args.remote_root}/_build-cache", "push", args.fs))
        except Exception as error:
            _status(root, cache_error=f"{type(error).__name__}: {error}")
        for job, remote in jobs:
            _status(root, step=f"restoring backups for {Path(job).name}")
            try:
                restored = backup.restore(job, remote, args.fs)
                _status(root, **{f"restored_{Path(job).name}": restored})
            except Exception as error:  # a failed restore only means more recomputation
                _status(root, **{f"restore_error_{Path(job).name}": f"{type(error).__name__}: {error}"})
            _uploader(job, remote, args.fs, repo)
        smoke_state = read_json(Path(info["smoke_job"]) / "status.json", {}).get("state")
        if not args.skip_smoke and smoke_state != "finished":
            _status(root, step="smoke test (first 20 s of video, tiny settings)")
            if _run_stage_process(args.venv_python, info["smoke_job"], repo, "driver-run.log"):
                error = read_json(Path(info["smoke_job"]) / "status.json", {}).get("error")
                raise RuntimeError(f"Smoke test failed, full run not started: {error}")
        _status(root, step="full reconstruction")
        if _run_stage_process(args.venv_python, info["job"], repo, "driver-run.log"):
            error = read_json(Path(info["job"]) / "status.json", {}).get("error")
            raise RuntimeError(f"Reconstruction failed: {error}")
        _status(root, state="finished", step="done; waiting for the last Drive uploads")
        return 0
    except Exception as error:
        _status(root, state="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc()[-4000:])
        return 1


if __name__ == "__main__":
    sys.exit(main())
