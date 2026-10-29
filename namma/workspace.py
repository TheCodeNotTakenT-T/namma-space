"""One job's folder: stage outputs, completion receipts, status and logs.

    <job>/job.json           source video identity + settings
    <job>/stages/<s>.json    receipt written when stage <s> finished (settings hash, outputs, metrics)
    <job>/status.json        what the notebook shows (stage, progress, message)
    <job>/logs/              pipeline.log and per-stage logs
    <job>/outbox/            files waiting for the Drive uploader (see namma.backup)
"""
import hashlib
import json
import os
import time
from pathlib import Path

STAGES = ("frames", "sfm", "priors", "train", "mesh", "export")


def write_json(path, data):
    """Atomic JSON write: a reader never sees a half-written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, default=str))
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def sha256_file(path, block=8 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(block):
            digest.update(chunk)
    return digest.hexdigest()


class Workspace:
    def __init__(self, root):
        self.root = Path(root).resolve()
        for sub in ("stages", "logs", "input", "frames", "sfm", "dataset", "priors", "train", "mesh", "export", "outbox"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)

    def __getattr__(self, name):
        if name in ("stages", "logs", "input", "frames", "sfm", "dataset", "priors", "train", "mesh", "export", "outbox"):
            return self.root / name
        raise AttributeError(name)

    @property
    def job(self):
        return read_json(self.root / "job.json", {})

    def receipt(self, stage):
        return read_json(self.stages / f"{stage}.json")

    def is_done(self, stage, settings_hash):
        receipt = self.receipt(stage)
        if not receipt or receipt.get("settings") != settings_hash:
            return False
        return all((self.root / rel).exists() for rel in receipt.get("outputs", []))

    def finish(self, stage, settings_hash, outputs, metrics, started):
        receipt = {"stage": stage, "settings": settings_hash, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "seconds": round(time.time() - started, 1),
                   "outputs": [str(Path(p).resolve().relative_to(self.root)) for p in outputs], "metrics": metrics}
        write_json(self.stages / f"{stage}.json", receipt)
        return receipt

    def invalidate_from(self, stage):
        """A re-run stage makes every later stage stale."""
        for later in STAGES[STAGES.index(stage):]:
            (self.stages / f"{later}.json").unlink(missing_ok=True)

    def status(self, **fields):
        current = read_json(self.root / "status.json", {})
        current.update(fields, updated=time.time())
        write_json(self.root / "status.json", current)

    def log(self, message):
        line = f"{time.strftime('%H:%M:%S')} {message}"
        print(line, flush=True)
        with open(self.logs / "pipeline.log", "a") as f:
            f.write(line + "\n")
