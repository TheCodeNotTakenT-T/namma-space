"""Google Drive backup and restore for long jobs on molab (whose files vanish when a session ends).

The GPU worker never talks to Drive. When a stage finishes it commits an *outbox entry*: files plus a
MANIFEST.json (written last). A separate uploader runs with the notebook's own Python, which already
holds molab's Drive login (Files > Remote storage > Google Drive), uploads each entry, checks every
file (Drive md5 or a full read-back) and writes VERIFIED.json next to it on Drive. `restore` brings
verified stages and the newest training checkpoint back into a fresh session.

Remote layout: <remote>/<seq>-<stage>-<id>/{files..., MANIFEST.json, VERIFIED.json}
This module uses only the standard library (plus gdrive_fsspec inside upload/restore/fetch).

    python -m namma.backup upload  --job DIR --remote NammaSpaceBackups/<job>
    python -m namma.backup restore --job DIR --remote NammaSpaceBackups/<job>
    python -m namma.backup fetch   --job DIR --video "<path on Drive>"
"""
import argparse
import fcntl
import hashlib
import json
import os
import sys
import tarfile
import time
import uuid
from pathlib import Path

from namma.workspace import read_json, sha256_file, write_json

BLOCK = 64 * 2 ** 20
STAGE_FILES = {  # what each finished stage contributes to a restore (paths relative to the job)
    "frames": ["frames/images", "frames/frame_metrics.csv"],
    "sfm": ["sfm/sparse", "sfm/undistorted/images", "sfm/undistorted/sparse", "sfm/database.db"],
    "priors": ["dataset/sparse", "dataset/priors_scales.json"],  # MoGe maps are recomputed (repair mode)
    "mesh": ["mesh/room.glb"],
    "export": ["export/DOWNLOAD_THIS"],
}


# ---- producer side (worker) -------------------------------------------------------------------
def _next_seq(outbox):
    outbox.mkdir(parents=True, exist_ok=True)
    with open(outbox / "SEQ.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        counter = outbox / "SEQ"
        value = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(value))
        return value


def commit(ws, stage, files=(), tar_paths=(), meta=None):
    """Queue files for Drive. `tar_paths` (relative to the job) are packed into one tar first."""
    seq = _next_seq(ws.outbox)
    entry = ws.outbox / f"{seq:06d}-{stage}-{uuid.uuid4().hex[:6]}"
    entry.mkdir()
    listed = [Path(f) for f in files]
    existing = [p for p in tar_paths if (ws.root / p).exists()]
    if existing:
        archive = entry / f"{stage}.tar"
        with tarfile.open(archive, "w") as tar:
            for rel in existing:
                tar.add(ws.root / rel, arcname=rel)
        listed.append(archive)
    receipt = ws.receipt(stage)
    manifest = {"job": ws.job.get("job_id"), "stage": stage, "seq": seq, "created": time.time(), "meta": meta or {},
                "receipt": receipt,
                "files": [{"name": p.name, "path": str(p.resolve()), "bytes": p.stat().st_size, "sha256": sha256_file(p)}
                          for p in listed]}
    write_json(entry / "MANIFEST.json", manifest)  # written last: marks the entry complete
    return entry


def commit_stage(ws, stage):
    if stage in STAGE_FILES:
        return commit(ws, stage, tar_paths=STAGE_FILES[stage])
    return commit(ws, stage)


# ---- Drive access (notebook Python) -----------------------------------------------------------
def drive_fs(spec):
    if spec.startswith("local:"):  # tests: a plain folder stands in for Drive
        import fsspec
        return fsspec.filesystem("file"), spec[len("local:"):].rstrip("/") + "/"
    import pydata_google_auth.cache
    from gdrive_fsspec import GoogleDriveFileSystem
    token = pydata_google_auth.cache.READ_WRITE._path
    if not os.path.exists(token):
        raise RuntimeError("Google Drive is not connected: in molab open Files > Remote storage > Google Drive and run the cell it adds")
    fs = GoogleDriveFileSystem(token="cache", auth_kwargs={"use_local_webserver": False},
                               use_listings_cache=False, skip_instance_cache=True)
    return fs, ""


def _remote_md5(fs, path):
    try:
        return fs.info(path, fields="md5Checksum,size").get("md5Checksum")
    except TypeError:  # older gdrive_fsspec without `fields`
        return fs.info(path).get("md5Checksum")
    except Exception:
        return None


def put_verified(fs, local, remote, expected_sha=None):
    md5, sha = hashlib.md5(), hashlib.sha256()
    size = 0
    with open(local, "rb") as src, fs.open(remote, "wb", block_size=BLOCK) as dst:
        while chunk := src.read(BLOCK):
            md5.update(chunk)
            sha.update(chunk)
            dst.write(chunk)
            size += len(chunk)
    if expected_sha and sha.hexdigest() != expected_sha:
        raise IOError(f"{local} changed while uploading")
    remote_md5 = _remote_md5(fs, remote)
    if remote_md5 is None or size < 32 * 2 ** 20:  # no server checksum, or small enough to read back fully
        check = hashlib.sha256()
        with fs.open(remote, "rb", block_size=BLOCK) as f:
            while chunk := f.read(BLOCK):
                check.update(chunk)
        if check.hexdigest() != sha.hexdigest():
            raise IOError(f"read-back mismatch for {remote}")
    elif remote_md5 != md5.hexdigest():
        raise IOError(f"Drive md5 mismatch for {remote}")
    return sha.hexdigest()


def get_verified(fs, remote, local, sha256):
    local = Path(local)
    local.parent.mkdir(parents=True, exist_ok=True)
    tmp = local.with_name(local.name + ".part")
    digest = hashlib.sha256()
    with fs.open(remote, "rb", block_size=BLOCK) as src, open(tmp, "wb") as dst:
        while chunk := src.read(BLOCK):
            digest.update(chunk)
            dst.write(chunk)
    if digest.hexdigest() != sha256:
        tmp.unlink()
        raise IOError(f"downloaded {remote} does not match its manifest")
    tmp.replace(local)


def upload_loop(job_dir, remote, fs_spec="drive", once=False):
    from namma.workspace import Workspace
    ws = Workspace(job_dir)
    status_path = ws.root / "backup_status.json"
    lock = open(ws.root / "uploader.lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("uploader already running for this job")
        return 0
    try:
        fs, prefix = drive_fs(fs_spec)
    except Exception as error:
        write_json(status_path, {"state": "auth_error", "error": str(error), "time": time.time()})
        raise
    base = prefix + remote.strip("/")
    uploaded_bytes, errors, started = 0, 0, time.time()
    while True:
        pipeline_state = read_json(ws.root / "status.json", {})  # read BEFORE scanning the outbox
        pending = sorted(e for e in ws.outbox.iterdir() if e.is_dir() and (e / "MANIFEST.json").exists()
                         and not (e / "UPLOADED.json").exists()) if ws.outbox.exists() else []
        for entry in pending:
            manifest = read_json(entry / "MANIFEST.json")
            folder = f"{base}/{entry.name}"
            write_json(status_path, {"state": "uploading", "entry": entry.name, "uploaded_bytes": uploaded_bytes,
                                     "errors": errors, "time": time.time()})
            try:
                fs.makedirs(base, exist_ok=True)
                fs.makedirs(folder, exist_ok=True)
                for item in manifest["files"]:
                    if not Path(item["path"]).exists():
                        item["missing"] = True  # e.g. an old checkpoint pruned after a newer one was written
                        continue
                    put_verified(fs, item["path"], f"{folder}/{item['name']}", item["sha256"])
                    uploaded_bytes += item["bytes"]
                with fs.open(f"{folder}/MANIFEST.json", "w") as f:
                    f.write(json.dumps(manifest, indent=1))
                verified = {"verified": time.time(), "files": [i["name"] for i in manifest["files"] if not i.get("missing")]}
                with fs.open(f"{folder}/VERIFIED.json", "w") as f:
                    f.write(json.dumps(verified))
                write_json(entry / "UPLOADED.json", {"remote": folder, **verified})
                if manifest["stage"] == "checkpoint" and verified["files"]:
                    _drop_older_checkpoints(fs, base, entry.name)
                for item in manifest["files"]:  # outbox tars are copies: free the disk
                    if Path(item["path"]).parent == entry and item["name"].endswith(".tar"):
                        Path(item["path"]).unlink(missing_ok=True)
            except Exception as error:
                errors += 1
                write_json(status_path, {"state": "retrying", "entry": entry.name, "error": f"{type(error).__name__}: {error}",
                                         "uploaded_bytes": uploaded_bytes, "errors": errors, "time": time.time()})
                time.sleep(min(300, 10 * errors))
                break
        else:
            state = pipeline_state.get("state")
            write_json(status_path, {"state": "idle", "uploaded_bytes": uploaded_bytes, "errors": errors,
                                     "pipeline": state, "time": time.time()})
            # Stop only when the outbox was empty AFTER the pipeline reported its end in this session.
            if once or (not pending and state in ("finished", "failed") and pipeline_state.get("updated", 0) >= started):
                return 0
            time.sleep(10)


def _drop_older_checkpoints(fs, base, newest):
    """Checkpoints are ~2 GB each; Drive keeps only the newest verified one."""
    for path in fs.ls(base, detail=False):
        name = path.rstrip("/").rsplit("/", 1)[-1]
        if "-checkpoint-" in name and name < newest:
            try:
                fs.rm(path, recursive=True)
            except Exception:
                pass


def ensure_folders(remotes, fs_spec="drive"):
    """Create the backup folders once, from one process (concurrent creation makes duplicate Drive folders)."""
    fs, prefix = drive_fs(fs_spec)
    for remote in remotes:
        fs.makedirs(prefix + remote.strip("/"), exist_ok=True)


def restore(job_dir, remote, fs_spec="drive"):
    """Bring verified stages (and the newest training checkpoint) back from Drive."""
    from namma.workspace import Workspace
    ws = Workspace(job_dir)
    fs, prefix = drive_fs(fs_spec)
    base = prefix + remote.strip("/")
    if not fs.exists(base):
        return {"restored": [], "note": "nothing on Drive yet"}
    entries = sorted(p.rstrip("/").rsplit("/", 1)[-1] for p in fs.ls(base, detail=False))
    seqs = [int(e.split("-", 1)[0]) for e in entries if e.split("-", 1)[0].isdigit()]
    if seqs:  # first, so new entries never reuse numbers already on Drive even if a download fails
        current = int((ws.outbox / "SEQ").read_text()) if (ws.outbox / "SEQ").exists() else 0
        (ws.outbox / "SEQ").write_text(str(max(current, max(seqs))))
    verified = [e for e in entries if fs.exists(f"{base}/{e}/VERIFIED.json")]
    restored, newest_ckpt = [], None
    for name in verified:
        manifest = json.loads(fs.cat_file(f"{base}/{name}/MANIFEST.json"))
        stage = manifest["stage"]
        if stage == "checkpoint":
            usable = manifest["files"] and not manifest["files"][0].get("missing")
            if usable and (newest_ckpt is None or manifest["meta"]["step"] > newest_ckpt[0]["meta"]["step"]):
                newest_ckpt = (manifest, name)
            continue
        receipt = manifest.get("receipt")
        if not receipt or ws.receipt(stage) == receipt:
            continue
        for item in manifest["files"]:
            if item.get("missing"):
                continue
            local = ws.root / "restore" / item["name"]
            get_verified(fs, f"{base}/{name}/{item['name']}", local, item["sha256"])
            if item["name"].endswith(".tar"):
                with tarfile.open(local) as tar:
                    tar.extractall(ws.root, filter="data")
                local.unlink()
            elif stage == "train":
                local.replace(ws.train / item["name"])
        write_json(ws.stages / f"{stage}.json", receipt)
        restored.append(stage)
    if newest_ckpt and not (ws.stages / "train.json").exists():
        manifest, name = newest_ckpt
        item = manifest["files"][0]
        get_verified(fs, f"{base}/{name}/{item['name']}", ws.train / "ckpt" / item["name"], item["sha256"])
        restored.append(f"checkpoint step {manifest['meta']['step']}")
    return {"restored": restored}


def fetch_video(job_dir, remote_video, fs_spec="drive"):
    """Copy the source video from Drive into the job (sessions start empty)."""
    from namma.workspace import Workspace
    ws = Workspace(job_dir)
    fs, prefix = drive_fs(fs_spec)
    remote = prefix + remote_video.strip("/")
    info = fs.info(remote)
    target = ws.input / ("video" + Path(remote).suffix.lower())
    if target.exists() and target.stat().st_size == int(info["size"]):
        return {"video": str(target), "bytes": target.stat().st_size, "cached": True}
    tmp = target.with_name(target.name + ".part")
    done = 0
    with fs.open(remote, "rb", block_size=BLOCK) as src, open(tmp, "wb") as dst:
        while chunk := src.read(BLOCK):
            dst.write(chunk)
            done += len(chunk)
            write_json(ws.root / "fetch_status.json", {"bytes": done, "total": int(info["size"]), "time": time.time()})
    tmp.replace(target)
    return {"video": str(target), "bytes": done, "md5": info.get("md5Checksum"), "cached": False}


def cache_sync(local_dir, remote, direction, fs_spec="drive"):
    """Copy compiled-build archives (<name>-<signature>.tar) between /opt/namma-cache and Drive."""
    fs, prefix = drive_fs(fs_spec)
    base = prefix + remote.strip("/")
    local_dir = Path(local_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    fs.makedirs(base, exist_ok=True)
    remote_names = {p.rstrip("/").rsplit("/", 1)[-1] for p in fs.ls(base, detail=False)}
    moved = []
    if direction == "push":
        for tar in sorted(local_dir.glob("*.tar")):
            if tar.name not in remote_names:
                sha = put_verified(fs, tar, f"{base}/{tar.name}")
                with fs.open(f"{base}/{tar.name}.sha256", "w") as f:
                    f.write(sha)
                moved.append(tar.name)
    else:
        for name in sorted(n for n in remote_names if n.endswith(".tar")):
            if not (local_dir / name).exists() and f"{name}.sha256" in remote_names:
                sha = fs.cat_file(f"{base}/{name}.sha256").decode().strip()
                get_verified(fs, f"{base}/{name}", local_dir / name, sha)
                moved.append(name)
    return {direction: moved}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m namma.backup")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("cache-push", "cache-pull"):
        p = sub.add_parser(name)
        p.add_argument("--dir", default="/opt/namma-cache")
        p.add_argument("--remote", default="NammaSpaceBackups/_build-cache")
        p.add_argument("--fs", default="drive")
    for name in ("upload", "restore", "fetch"):
        p = sub.add_parser(name)
        p.add_argument("--job", required=True)
        p.add_argument("--fs", default="drive", help="'drive' or local:/folder for tests")
        if name == "fetch":
            p.add_argument("--video", required=True)
        else:
            p.add_argument("--remote", required=True)
        if name == "upload":
            p.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if args.command in ("cache-push", "cache-pull"):
        print(json.dumps(cache_sync(args.dir, args.remote, args.command.split("-")[1], args.fs)))
        return 0
    if args.command == "upload":
        return upload_loop(args.job, args.remote, args.fs, args.once)
    result = restore(args.job, args.remote, args.fs) if args.command == "restore" else fetch_video(args.job, args.video, args.fs)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
