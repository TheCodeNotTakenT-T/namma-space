"""Quality experiment: retrain a finished room under several settings and compare them.

Every variant reuses the finished job's frames, camera solve and depth priors from Google Drive, so the
only difference between the results is the setting being tested. Each variant is an ordinary pipeline
job (priors repair -> train -> collision mesh -> export), so every result is also a viewer-ready room.

Runs detached from the molab notebook, with the notebook's Python (it holds the Google Drive login):

    python -m namma.experiment run --source-job JOB [--variants baseline ppisp] [--root /opt/namma-quality]
    python -m namma.experiment selftest [--root /opt/namma-quality]   # ~10 min GPU check before the long run

Folders: <root>/jobs/<job>-<variant>/ (pipeline jobs), <root>/report/ (side-by-side renders and scores),
<root>/status.json + logs/ (what the notebook shows). On Drive: NammaQuality/<job>-<variant>/ (checkpoints
and results, for resuming after a molab shutdown) and NammaQuality/<job>-report/.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE_ROOT = "NammaSpaceBackups"
REMOTE_ROOT = "NammaQuality"
UPLOAD_WAIT = 3 * 3600

# What each variant changes, on top of the finished job's own settings.
VARIANTS = {
    "baseline": {},                         # the trainer as it produced the Round 1 room
    "ppisp": {"train": {"ppisp": True}},    # NVIDIA PPISP colour model instead of the per-frame affine fix
}


class Run:
    def __init__(self, root, fs="drive", extra_settings=None):
        self.root, self.fs, self.extra = Path(root), fs, extra_settings or {}
        self.jobs, self.logs, self.done_dir = self.root / "jobs", self.root / "logs", self.root / "done"
        self.venv_py = REPO / ".venv" / "bin" / "python"

    # ---- bookkeeping ----------------------------------------------------------------------------
    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=1, default=str))
        tmp.replace(path)

    def read(self, path):
        try:
            return json.loads(Path(path).read_text())
        except (OSError, ValueError):
            return {}

    def status(self, **fields):
        self.write(self.root / "status.json", {**self.read(self.root / "status.json"), **fields, "updated": time.time()})

    def log(self, message):
        self.logs.mkdir(parents=True, exist_ok=True)
        with open(self.logs / "experiment.log", "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {message}\n")

    def done(self, stage):
        return (self.done_dir / f"{stage}.json").exists()

    def mark(self, stage, **info):
        self.write(self.done_dir / f"{stage}.json", {"time": time.time(), **info})

    def run(self, cmd, log_name, env, cwd=REPO):
        self.log(f"{log_name}: {' '.join(map(str, cmd))}")
        with open(self.logs / f"{log_name}.log", "ab") as out:
            code = subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                  stdout=out, stderr=subprocess.STDOUT).returncode
        if code:
            raise RuntimeError(f"{log_name} failed with exit code {code}; see {self.logs / (log_name + '.log')}")

    @staticmethod
    def notebook_env():
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(p for p in (str(REPO), env.get("PYTHONPATH", "")) if p)
        return env

    @staticmethod
    def venv_env():
        """molab sets PYTHONPATH/PYTHONSAFEPATH for its own Python; they break the GPU venv."""
        return {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONSAFEPATH", "PYTHONHOME")}

    # ---- stages --------------------------------------------------------------------------------
    def setup(self, need_ppisp):
        if not (self.done("setup") and self.venv_py.exists()):
            self.status(stage="setup", message="Installing the GPU environment (compiled builds come from the Drive cache)")
            for remote in (f"{SOURCE_ROOT}/_build-cache", f"{REMOTE_ROOT}/_build-cache"):
                try:
                    self.run([sys.executable, "-m", "namma.backup", "cache-pull", "--remote", remote, "--fs", self.fs], "setup", self.notebook_env())
                except RuntimeError as error:  # no cache only means a longer compile
                    self.log(f"setup: build cache {remote} not pulled: {error}")
            self.run(["bash", REPO / "molab_setup.sh"], "setup", self.venv_env())
            try:
                self.run([sys.executable, "-m", "namma.backup", "cache-push", "--remote", f"{REMOTE_ROOT}/_build-cache", "--fs", self.fs],
                         "setup", self.notebook_env())
            except RuntimeError as error:
                self.log(f"setup: build cache not saved: {error}")
            self.mark("setup")
        if need_ppisp:
            check = subprocess.run([str(self.venv_py), "-c", "import ppisp; print(ppisp.__version__)"], capture_output=True, text=True, env=self.venv_env())
            if check.returncode:
                raise RuntimeError("PPISP did not build in setup (see the newest setup-logs/*/build-ppisp.log); the ppisp variant cannot run")
            self.log(f"setup: ppisp {check.stdout.strip()} available")

    def prepare(self, job, variant):
        """A pipeline job holding the finished job's frames, solve and priors, with the variant's settings."""
        sys.path.insert(0, str(REPO))
        from namma import backup
        from namma.config import Config
        from namma.pipeline import SECTIONS
        from namma.workspace import Workspace
        name = f"{job}-{variant}"
        ws = Workspace(self.jobs / name)
        remote = f"{REMOTE_ROOT}/{name}"
        if not self.done(f"base-{variant}"):
            self.status(stage=f"{variant}: restore", message=f"Copying the camera solve and priors from {SOURCE_ROOT}/{job}")
            self.log(f"restore {variant}: {backup.restore(ws.root, f'{SOURCE_ROOT}/{job}', self.fs)}")
            missing = [s for s in ("frames", "sfm", "priors") if not ws.receipt(s)]
            if missing:
                raise RuntimeError(f"{SOURCE_ROOT}/{job} has no verified {', '.join(missing)} backup to reuse")
            # A job's settings file is not part of its Drive backup, so variants start from today's defaults
            # (the settings that produced the Round 1 room) plus their own change.
            settings = Config().to_dict()
            for source in (VARIANTS[variant], self.extra):
                for section, values in source.items():
                    settings[section].update(values)
            cfg = Config.from_dict(settings)
            for stage in ("train", "mesh", "export"):  # the finished job's room is not this variant's result
                (ws.stages / f"{stage}.json").unlink(missing_ok=True)
                shutil.rmtree(getattr(ws, stage), ignore_errors=True)
                getattr(ws, stage).mkdir()
            self.write(ws.root / "job.json", {"job_id": name, "video_name": "", "video_path": "", "video_sha256": "", "smoke": False,
                                              "created": time.time(), "experiment_of": f"{SOURCE_ROOT}/{job}", "variant": variant,
                                              "config": cfg.to_dict()})
            # Same frames, solve and priors under this job's settings hashes: the pipeline skips frames/sfm
            # and rebuilds only the depth maps from the restored metric scale (repair mode, a few minutes).
            for stage in ("frames", "sfm", "priors"):
                self.write(ws.stages / f"{stage}.json", {**ws.receipt(stage), "settings": cfg.stage_hash(*SECTIONS[stage])})
            self.mark(f"base-{variant}", job=job)
        if self.read(self.done_dir / f"base-{variant}.json").get("job") != job:
            raise RuntimeError(f"{self.root} already holds an experiment on another job; start a new molab session")
        backup.ensure_folders([REMOTE_ROOT, remote], self.fs)
        self.status(stage=f"{variant}: restore", message=f"Looking for this variant's own checkpoints in {remote}")
        self.log(f"restore {variant} checkpoints: {backup.restore(ws.root, remote, self.fs)}")
        return ws, remote

    def train(self, ws, remote, variant):
        if self.read(ws.root / "status.json").get("state") == "finished":
            self.log(f"{variant}: already finished")
            return
        (ws.root / "logs").mkdir(parents=True, exist_ok=True)
        with open(ws.root / "logs" / "uploader.log", "ab") as out:
            uploader = subprocess.Popen([sys.executable, "-m", "namma.backup", "upload", "--job", str(ws.root), "--remote", remote, "--fs", self.fs],
                                        cwd=REPO, env=self.notebook_env(), stdin=subprocess.DEVNULL, stdout=out,
                                        stderr=subprocess.STDOUT, start_new_session=True)
        self.status(stage=f"{variant}: pipeline", message="Rebuilding depth maps, then training", job_dir=str(ws.root))
        ok = False
        try:
            self.run([self.venv_py, "-m", "namma", "run", "--job", ws.root], f"pipeline-{variant}", self.venv_env())
            ok = True
        finally:
            self.status(stage=f"{variant}: upload", message="Waiting for the last Drive uploads")
            try:  # after a failure the uploader may never see a final state: do not wait for hours
                uploader.wait(timeout=UPLOAD_WAIT if ok else 900)
            except subprocess.TimeoutExpired:
                self.log(f"{variant}: uploader still running after the wait; see backup_status.json")
        state = self.read(ws.root / "status.json")
        if state.get("state") != "finished":
            raise RuntimeError(f"{variant} pipeline ended as {state.get('state')}: {state.get('error')}")

    def report(self, job, workspaces):
        sys.path.insert(0, str(REPO))
        from namma import backup
        out = self.root / "report"
        self.status(stage="compare", message="Rendering held-out views from every result")
        self.run([self.venv_py, "-m", "namma", "compare", "--jobs", *[ws.root for ws in workspaces.values()],
                  "--names", *workspaces.keys(), "--out", out], "compare", self.venv_env())
        fs, base = backup.drive_fs(self.fs)
        remote = f"{base}{REMOTE_ROOT}/{job}-report"
        backup.ensure_folders([REMOTE_ROOT, f"{REMOTE_ROOT}/{job}-report"], self.fs)
        for path in sorted(out.iterdir()):
            if path.is_file():
                backup.put_verified(fs, path, f"{remote}/{path.name}")
        self.log(f"report uploaded to {REMOTE_ROOT}/{job}-report")
        return self.read(out / "report.json")

    def main(self, job, variants):
        unknown = [v for v in variants if v not in VARIANTS]
        if unknown:
            raise SystemExit(f"Unknown variant(s) {unknown}; choose from {sorted(VARIANTS)}")
        self.root.mkdir(parents=True, exist_ok=True)
        commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.status(state="running", stage="starting", message="", error=None, job=job, variants=variants, started=time.time(), code=commit)
        self.log(f"experiment on {job}: {variants} (code {commit[:7]})")
        try:
            self.setup(need_ppisp=any(VARIANTS[v].get("train", {}).get("ppisp") for v in variants))
            workspaces = {}
            for variant in variants:
                ws, remote = self.prepare(job, variant)
                self.train(ws, remote, variant)
                workspaces[variant] = ws
                self.status(**{f"finished_{variant}": self.read(ws.stages / "train.json").get("metrics", {})})
            report = self.report(job, workspaces)
            self.status(state="finished", stage="done", message=f"Finished: compare the results below, or in Drive {REMOTE_ROOT}/{job}-report",
                        report=report.get("jobs"))
            return 0
        except BaseException as error:
            self.status(state="failed", error=f"{type(error).__name__}: {error}"[-4000:])
            self.log("FAILED: " + traceback.format_exc()[-4000:])
            return 1

    def selftest(self):
        """About 10 minutes on the GPU before the long run: tests/run_local_experiment.py on the bundled clip
        (tiny room, both variants, PPISP killed and resumed, report) with a local folder standing in for Drive.
        Shares the setup with the real run; writes <root>/selftest.json, never touches status.json."""
        state = self.root / "selftest.json"
        self.root.mkdir(parents=True, exist_ok=True)
        self.status = lambda **fields: None   # the experiment's status.json stays untouched
        self.write(state, {"state": "running", "started": time.time(), "message": "Installing the GPU environment"})
        try:
            self.setup(need_ppisp=True)
            self.write(state, {**self.read(state), "message": "Training two tiny rooms, killing and resuming one"})
            self.run([self.venv_py, REPO / "tests" / "run_local_experiment.py", REPO / "tests" / "sample" / "classroom_30s.mp4",
                      self.root / "selftest"], "selftest", self.venv_env())
            self.write(state, {**self.read(state), "state": "passed", "message": "All checks passed", "finished": time.time()})
            return 0
        except BaseException as error:
            self.write(state, {**self.read(state), "state": "failed", "error": f"{type(error).__name__}: {error}"[-4000:]})
            self.log("SELFTEST FAILED: " + traceback.format_exc()[-4000:])
            return 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m namma.experiment")
    parser.add_argument("command", choices=["run", "selftest"])
    parser.add_argument("--source-job", help="finished job folder name in NammaSpaceBackups/ on Drive (run)")
    parser.add_argument("--variants", nargs="+", default=list(VARIANTS))
    parser.add_argument("--root", default="/opt/namma-quality")
    parser.add_argument("--fs", default="drive", help="tests: local:/folder stands in for Google Drive")
    parser.add_argument("--settings", help='tests: JSON merged into every variant, e.g. {"train": {"steps": 300}}')
    args = parser.parse_args(argv)
    extra = json.loads(args.settings) if args.settings else None
    if args.command == "selftest":
        return Run(args.root, args.fs, extra).selftest()
    if not args.source_job:
        parser.error("run needs --source-job")
    return Run(args.root, args.fs, extra).main(args.source_job, args.variants)


if __name__ == "__main__":
    sys.exit(main())
