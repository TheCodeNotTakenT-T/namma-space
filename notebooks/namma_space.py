import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")

with app.setup:
    import io
    import json
    import os
    import shutil
    import subprocess
    import sys
    import tarfile
    import time
    from pathlib import Path

    import marimo as mo


@app.function
def git(repo, *args, stdin=None):
    return subprocess.run(["git", "-C", str(repo), *args], input=stdin, capture_output=True, text=True)


@app.function
def get_checkout(repo, source, ref):
    """Make `repo` a Git checkout of `ref` from `source` without overwriting anyone's edits.

    After a shutdown molab restores source files but not `.git`, logs or the environment, so the folder
    may hold files from an older checkout. A file is replaced only when Git history shows it is an
    unmodified committed version; anything else is left in place and listed. An existing checkout is
    only fast-forwarded, which Git refuses if it would touch local changes.
    """
    repo = Path(repo)
    branch = f"refs/heads/{ref}"
    if (repo / ".git").exists() and git(repo, "rev-parse", "--verify", "-q", "HEAD").returncode == 0:
        current = git(repo, "symbolic-ref", "-q", "HEAD").stdout.strip()
        if current != branch:
            return f"{repo} is on {current or 'a detached HEAD'}, not {ref}; left unchanged."
        before = git(repo, "rev-parse", "--short", "HEAD").stdout.strip()
        fetched = git(repo, "fetch", "-q", "--no-tags", source, branch)
        if fetched.returncode:
            return f"{repo} left unchanged; fetching {ref} failed:\n{fetched.stderr}"
        merged = git(repo, "merge", "--ff-only", "-q", "FETCH_HEAD")
        if merged.returncode:
            return f"{repo} left unchanged; it cannot fast-forward without touching local changes:\n{merged.stderr}"
        after = git(repo, "rev-parse", "--short", "HEAD").stdout.strip()
        return f"{repo}: already at {ref} {after}." if after == before else f"{repo}: updated {before} -> {after}."
    repo.mkdir(parents=True, exist_ok=True)
    for args in (["init", "-q"],
                 ["fetch", "-q", "--no-tags", "--update-head-ok", source, f"+{branch}:{branch}"],
                 ["symbolic-ref", "HEAD", branch],
                 ["reset", "-q"]):  # index = branch tip; files on disk untouched
        result = git(repo, *args)
        if result.returncode:
            return f"git {' '.join(args)} failed:\n{result.stdout}{result.stderr}"
    git(repo, "remote", "add", "origin", source)
    deleted = [p for p in git(repo, "ls-files", "-z", "--deleted").stdout.split("\0") if p]
    changed = sorted({p for p in git(repo, "ls-files", "-z", "--modified").stdout.split("\0") if p} - set(deleted))
    hashes = git(repo, "hash-object", "--stdin-paths", stdin="\n".join(changed)).stdout.split() if changed else []
    known = {line.split()[0] for line in git(repo, "rev-list", "--objects", "--all").stdout.splitlines()}
    stale = [p for p, h in zip(changed, hashes) if h in known]
    edited = [p for p, h in zip(changed, hashes) if h not in known]
    restore = deleted + stale
    if restore:
        result = git(repo, "checkout", "--pathspec-from-file=-", "--pathspec-file-nul", stdin="\0".join(restore))
        if result.returncode:
            return f"git checkout failed:\n{result.stderr}"
    untracked = [p for p in git(repo, "ls-files", "-z", "--others", "--exclude-standard").stdout.split("\0") if p]
    lines = [f"Checked out {ref} in {repo}.",
             f"Files written: {len(deleted)} missing, {len(stale)} from an older commit."]
    if edited:
        lines.append(f"{len(edited)} file(s) differ from every committed version and were LEFT AS THEY ARE:")
        lines += [f"  {p}" for p in edited[:20]]
    if untracked:
        lines.append(f"{len(untracked)} untracked file(s) kept (not part of {ref}), e.g. {untracked[0]}")
    return "\n".join(lines)


@app.function
def setup_running(repo):
    """True while a molab_setup.sh process for this repository is alive."""
    repo = Path(repo).resolve()
    for cmdline in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            args = cmdline.read_bytes().split(b"\0")
            cwd = Path(f"/proc/{cmdline.parent.name}/cwd").resolve()
        except OSError:
            continue
        for arg in args:
            if arg.endswith(b"molab_setup.sh") and (cwd / arg.decode(errors="replace")).resolve() == repo / "molab_setup.sh":
                return True
    return False


@app.function
def machine_summary(repo):
    try:
        mem = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        ram = f"RAM free {int(mem['MemAvailable'].split()[0]) / 2**20:.0f}/{int(mem['MemTotal'].split()[0]) / 2**20:.0f} GiB"
    except (OSError, KeyError, ValueError):
        ram = "RAM unknown"
    disk = shutil.disk_usage(repo if Path(repo).exists() else "/")
    return f"{ram} · disk free {disk.free / 2**30:.0f}/{disk.total / 2**30:.0f} GiB"


@app.function
def tar_bytes(folder):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        archive.add(folder, arcname=Path(folder).name)
    return buffer.getvalue()


@app.function
def process_running(pattern):
    for cmdline in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            if pattern.encode() in cmdline.read_bytes():
                return True
        except OSError:
            continue
    return False


@app.function
def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


@app.function
def drive_connected():
    """molab's Remote storage cell caches the Google login in pydata-google-auth's credentials file."""
    try:
        import pydata_google_auth.cache
        return os.path.exists(pydata_google_auth.cache.READ_WRITE._path)
    except ImportError:
        return False


@app.function
def ensure_gdrive_fork():
    """PyPI gdrive_fsspec lacks the multi-chunk resumable-upload fix that large checkpoints need."""
    import importlib.metadata
    commit = "dd9bb3025b26091d4a29ac4e81cc3d88910203bd"
    try:
        if commit in (importlib.metadata.distribution("gdrive_fsspec").read_text("direct_url.json") or ""):
            return "pinned gdrive_fsspec already installed"
    except importlib.metadata.PackageNotFoundError:
        pass
    spec = f"gdrive_fsspec @ git+https://github.com/marimo-team/gdrive-fsspec@{commit}"
    for cmd in ([sys.executable, "-m", "pip", "install", "--quiet", spec], ["uv", "pip", "install", "--python", sys.executable, spec]):
        try:
            if subprocess.run(cmd, capture_output=True, text=True).returncode == 0:
                return "installed pinned gdrive_fsspec"
        except FileNotFoundError:
            continue
    return "could not install the pinned gdrive_fsspec; large uploads may fail"


@app.function
def setup_passed(repo):
    logs = Path(repo) / "setup-logs"
    latest = (logs / "LATEST").read_text().strip() if (logs / "LATEST").exists() else ""
    return read_json(logs / latest / "report.json").get("overall") == "pass" if latest else False




@app.function
def gpu_free_vram_mib():
    """Free GPU VRAM in MiB, or None if nvidia-smi is unavailable (e.g. CPU-only dev box)."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return None


@app.function
def default_sweep_grid():
    """Sensible 4-variant sweep covering the audit's recommendations and the baseline.

    Each entry: {"name": str, "settings": {section: {key: value}}, "fork_after": stage}.
    `fork_after` is the stage whose outputs are cloned (hardlinked) from the canonical job;
    later stages re-run with the variant's settings. Variants that only differ in train/mesh
    use "priors"; variants that change priors.image_long_side use "sfm".
    """
    return [
        {"name": "baseline",    "settings": {},                                                                              "fork_after": "priors"},
        {"name": "more-steps",  "settings": {"train": {"steps": 60000}},                                                    "fork_after": "priors"},
        {"name": "loose-alpha", "settings": {"mesh": {"min_alpha": 0.3, "trunc_voxels": 6.0}},                              "fork_after": "priors"},
        {"name": "recommended", "settings": {"train": {"steps": 60000}, "mesh": {"min_alpha": 0.3, "trunc_voxels": 6.0}},   "fork_after": "priors"},
    ]


@app.function
def _clone_stage_outputs(src, dst, stage):
    """Hardlink every file under <src>/<stage>/ into <dst>/<stage>/."""
    s = src / stage
    if not s.exists():
        return
    d = dst / stage
    if d.exists():
        shutil.rmtree(d)
    shutil.copytree(s, d, copy_function=os.link)


@app.function
def clone_job_for_variant(canonical_job, variant_job, fork_after):
    """Fork the canonical job's upstream stages into a new variant job directory.

    Clones (via hardlinks) the frames / sfm / dataset / priors folders and copies the
    matching stage receipts so that Workspace.is_done returns True for the upstream stages
    and only train+mesh+export re-run with the variant's settings. Hardlinks are cheap on
    the same filesystem and survive if the canonical job is later deleted.
    """
    # Map fork_after -> (directories to clone, stages whose receipts to copy)
    plan = {
        "frames": (["frames"],                   ["frames"]),
        "sfm":    (["frames", "sfm"],            ["frames", "sfm"]),
        "priors": (["frames", "sfm", "dataset", "priors"], ["frames", "sfm", "priors"]),
    }
    clone_dirs, receipt_stages = plan.get(fork_after, plan["priors"])
    src = Path(canonical_job)
    dst = Path(variant_job)
    dst.mkdir(parents=True, exist_ok=True)
    for sub in clone_dirs:
        _clone_stage_outputs(src, dst, sub)
    # Receipts
    (dst / "stages").mkdir(parents=True, exist_ok=True)
    for s in receipt_stages:
        r = src / "stages" / f"{s}.json"
        if r.exists():
            shutil.copy2(r, dst / "stages" / f"{s}.json")
    # The input video (hardlinked) so the variant can re-derive its job identity if asked
    if (src / "input").exists() and not (dst / "input").exists():
        shutil.copytree(src / "input", dst / "input", copy_function=os.link, dirs_exist_ok=True)
    # job.json copied; the caller overrides train/mesh/etc. on top
    if not (dst / "job.json").exists() and (src / "job.json").exists():
        shutil.copy2(src / "job.json", dst / "job.json")


@app.function
def override_job_settings(job_dir, overrides):
    """Rewrite job.json's config section with the variant's settings overrides."""
    p = Path(job_dir) / "job.json"
    data = json.loads(p.read_text())
    for section, values in (overrides or {}).items():
        data.setdefault("config", {}).setdefault(section, {}).update(values)
    p.write_text(json.dumps(data, indent=2))


@app.function
def variant_job_dir(canonical_job, variant_name):
    """Sibling folder named <canonical_id>__<variant_name>."""
    canon = Path(canonical_job)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in variant_name)
    return str(canon.parent / f"{canon.name}__{safe}")


@app.function
def launch_variant(venv_python, repo, variant_job):
    """Start `python -m namma run --job <variant_job>` as a detached subprocess."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONSAFEPATH", "PYTHONHOME")}
    env["PYTHONPATH"] = repo
    log = open(Path(variant_job) / "logs" / "sweep-run.log", "ab")
    return subprocess.Popen([venv_python, "-m", "namma", "run", "--job", variant_job],
                            cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=log,
                            stderr=subprocess.STDOUT, start_new_session=True)


@app.function
def _one_job_status(job_dir, label, kind):
    job = read_json(job_dir / "job.json")
    if not job:
        return []
    cfg = job.get("config", {})
    train = cfg.get("train", {}); mesh = cfg.get("mesh", {})
    status = read_json(job_dir / "status.json")
    ev = read_json(job_dir / "train" / "eval.json")
    mesh_receipt = read_json(job_dir / "stages" / "mesh.json")
    mesh_metrics = mesh_receipt.get("metrics", {}) if mesh_receipt else {}
    return [{
        "kind": kind, "variant": label, "state": status.get("state", "?"),
        "stage": status.get("stage") or "-", "progress": status.get("progress"),
        "steps": train.get("steps"), "cap_max": train.get("cap_max"),
        "min_alpha": mesh.get("min_alpha"), "trunc_voxels": mesh.get("trunc_voxels"),
        "psnr": ev.get("psnr"), "ssim": ev.get("ssim"),
        "gaussians": ev.get("gaussians"),
        "triangles": mesh_metrics.get("triangles"),
        "components_dropped": mesh_metrics.get("components_dropped"),
    }]


@app.function
def sweep_status_rows(jobs_root, canonical_job):
    """Collect status rows for the canonical job + every variant (siblings named <canon>__*)."""
    rows = []
    canon = Path(canonical_job)
    if canon.exists():
        rows.extend(_one_job_status(canon, canon.name, "canonical"))
    for d in sorted(Path(jobs_root).glob(f"{canon.name}__*")):
        if d.is_dir() and (d / "job.json").exists():
            rows.extend(_one_job_status(d, d.name, "variant"))
    return rows


@app.cell
def _():
    mo.md("""
    # Namma Space: video to walkable 3D room

    **Part A – environment (once per molab session, ~20–30 min the first time)**
    1. **Get code** – check out the active branch. Files you edited are never overwritten.
    2. **Run setup** – installs the pinned Python packages and CUDA compiler, builds gsplat, installs MoGe-2
       and runs real GPU checks. Wait for *finished* with an overall PASS.

    **Part B – reconstruction**
    - Connect Google Drive: Files panel (left) > *Remote storage* > *Google Drive*, then run the cell it adds.
    - Enter the video's path inside *My Drive* and click **Start / resume**. A 10-minute smoke test on the
      first 20 seconds runs first; if it passes, the full reconstruction starts (typically 1–3 hours).
    - Everything finished is backed up to Drive as it completes. **If molab stops**, open this notebook again,
      redo Part A, connect Drive and click Start again with the same video: finished stages and the latest
      training checkpoint are restored instead of recomputed.
    - The result appears under *Download* below and on Drive (folder `NammaSpaceBackups/<job>/…-download-…`).
    """)
    return


@app.cell
def _():
    workspace = mo.ui.text(value="/marimo/namma-space", label="Repository folder", full_width=True)
    source = mo.ui.text(
        value="https://github.com/TheCodeNotTakenT-T/namma-space.git",
        label="Code source: Git URL or an uploaded .bundle file",
        full_width=True,
    )
    ref = mo.ui.text(value="main", label="Branch")
    get_code = mo.ui.run_button(label="1. Get code")
    run_setup = mo.ui.run_button(label="2. Run setup + GPU checks")
    rebuild = mo.ui.checkbox(label="Rebuild native extensions even if cached")
    mo.vstack([workspace, source, ref, get_code, mo.hstack([run_setup, rebuild], justify="start")])
    return get_code, rebuild, ref, run_setup, source, workspace


@app.cell
def _(get_code, ref, source, workspace):
    mo.stop(not get_code.value)
    _repo = Path(workspace.value)
    _message = get_checkout(_repo, source.value, ref.value)
    _state = git(_repo, "log", "-1", "--format=%H %d %s")
    _status = git(_repo, "status", "--short")
    mo.md(f"```\n{_message}\n\nHEAD: {_state.stdout or _state.stderr}\nLocal changes:\n{_status.stdout or 'none'}\n```")
    return


@app.cell
def _(rebuild, run_setup, workspace):
    mo.stop(not run_setup.value)
    _repo = Path(workspace.value)
    if not (_repo / ".git").exists() or not (_repo / "molab_setup.sh").exists():
        _out = mo.md(f"`{_repo}` is not a complete checkout yet. Click **1. Get code** first.")
    elif setup_running(_repo):
        _out = mo.md("Setup is already running; progress is shown below.")
    else:
        _logs = _repo / "setup-logs"
        _logs.mkdir(exist_ok=True)
        _note = ""
        if drive_connected():  # a compiled gsplat saved by an earlier session skips the long compile
            _env = {**os.environ, "PYTHONPATH": os.pathsep.join(p for p in (str(_repo), os.environ.get("PYTHONPATH", "")) if p)}
            _pull = subprocess.run([sys.executable, "-m", "namma.backup", "cache-pull"], cwd=_repo, env=_env,
                                   capture_output=True, text=True)
            _note = f" Build cache from Drive: {(_pull.stdout or _pull.stderr).strip()[-300:]}"
        _args = ["bash", str(_repo / "molab_setup.sh")] + (["--rebuild"] if rebuild.value else [])
        # A separate session keeps the setup running if the notebook kernel restarts.
        with open(_logs / "notebook-launch.log", "ab") as _launch_log:
            subprocess.Popen(_args, cwd=_repo, stdout=_launch_log, stderr=subprocess.STDOUT, start_new_session=True)
        _out = mo.md("Setup started. Progress appears below." + _note)
    _out
    return


@app.cell
def _():
    refresh = mo.ui.refresh(default_interval="10s", options=["5s", "10s", "30s"])
    refresh
    return (refresh,)


@app.cell
def _(refresh, workspace):
    refresh
    _repo = Path(workspace.value)
    _logs = _repo / "setup-logs"
    _latest = (_logs / "LATEST").read_text().strip() if (_logs / "LATEST").exists() else None
    _runs = sorted(p for p in _logs.glob("20*") if p.is_dir()) if _logs.exists() else []
    _run = _runs[-1] if _runs else None
    _parts = [mo.md(f"_{machine_summary(_repo)} (checked {time.strftime('%H:%M:%S')})_")]
    if _run is None:
        _parts.append(mo.md("No setup run in this session yet."))
    else:
        _log = _run / "setup.log"
        _tail = _log.read_text(errors="replace").splitlines()[-25:] if _log.exists() else []
        if _latest == _run.name:
            _state = "finished"
        elif setup_running(_repo):
            _state = "running"
        else:
            _state = "STOPPED before finishing (process killed or out of memory); download its logs below"
        _parts.append(mo.md(f"**Run {_run.name}** – {_state}\n\n```\n" + "\n".join(_tail) + "\n```"))
        _report = _run / "report.md"
        if _report.exists():
            _parts.append(mo.md(_report.read_text()))
        _archive = _logs / f"namma-setup-{_run.name}.tar.gz"
        if _state == "finished" and _archive.exists():
            _parts.append(mo.download(data=_archive.read_bytes(), filename=_archive.name,
                                      label=f"Download {_archive.name} (send this back)"))
        elif _state != "running":
            _parts.append(mo.download(data=tar_bytes(_run), filename=f"namma-setup-{_run.name}-partial.tar.gz",
                                      label="Download the logs of this stopped run (send this back)"))
    mo.vstack(_parts)
    return


@app.cell
def _():
    video = mo.ui.text(value="", placeholder="e.g. NammaSpace/classroom.mp4 (inside My Drive), or /full/local/path.mp4",
                       label="Video", full_width=True)
    jobs_root = mo.ui.text(value="/opt/namma-jobs", label="Working folder (temporary; backups go to Drive)", full_width=True)
    remote_root = mo.ui.text(value="NammaSpaceBackups", label="Backup folder on Google Drive")
    skip_smoke = mo.ui.checkbox(label="Skip the smoke test")
    start = mo.ui.run_button(label="3. Start / resume reconstruction")
    mo.vstack([mo.md("## Reconstruct a room"), video, jobs_root, remote_root, mo.hstack([start, skip_smoke], justify="start")])
    return jobs_root, remote_root, skip_smoke, start, video


@app.cell
def _(jobs_root, remote_root, skip_smoke, start, video, workspace):
    mo.stop(not start.value)
    _repo = Path(workspace.value)
    _venv = _repo / ".venv" / "bin" / "python"
    _problems = []
    if not _venv.exists() or not setup_passed(_repo):
        _problems.append("Run **2. Run setup** first and wait for an overall PASS (the GPU environment is rebuilt each session).")
    if not video.value.strip():
        _problems.append("Enter the video path.")
    if not drive_connected():
        _problems.append("Connect Google Drive (Files > Remote storage > Google Drive, run the inserted cell). "
                         "Without it nothing survives a molab stop.")
    if process_running("namma.driver"):
        _problems.append("A reconstruction is already running; progress is shown below.")
    if _problems:
        _out = mo.md("\n".join(f"- {p}" for p in _problems))
    else:
        _fork = ensure_gdrive_fork()
        Path(jobs_root.value).mkdir(parents=True, exist_ok=True)
        _args = [sys.executable, "-m", "namma.driver", "--video", video.value.strip(), "--jobs-root", jobs_root.value,
                 "--remote-root", remote_root.value, "--venv-python", str(_venv)]
        _args += (["--skip-smoke"] if skip_smoke.value else []) + (["--local-video"] if video.value.strip().startswith("/") else [])
        _env = {**os.environ, "PYTHONPATH": os.pathsep.join(p for p in (str(_repo), os.environ.get("PYTHONPATH", "")) if p)}
        with open(Path(jobs_root.value) / "driver.log", "ab") as _log:
            subprocess.Popen(_args, cwd=_repo, env=_env, stdin=subprocess.DEVNULL, stdout=_log, stderr=subprocess.STDOUT,
                             start_new_session=True)
        _out = mo.md(f"Started ({_fork}). Progress appears below; it keeps running if this tab disconnects.")
    _out
    return


@app.cell
def _(jobs_root, refresh):
    refresh
    _root = Path(jobs_root.value)
    _driver = read_json(_root / "driver_status.json")
    _parts = [mo.md("**Google Drive:** " + ("connected" if drive_connected() else
                    "NOT connected – Files panel > Remote storage > Google Drive, then run the cell it inserts."))]
    if not _driver:
        _parts.append(mo.md("No reconstruction started in this session."))
    else:
        _state = _driver.get("state")
        if _state == "running" and not process_running("namma.driver"):
            _state = "STOPPED (the driver process is gone; click Start again to resume)"
        _parts.append(mo.md(f"**Reconstruction:** {_state} – {_driver.get('step', '')}"
                            + (f"\n\n**Error:** `{_driver['error']}`" if _driver.get("error") else "")))
        for _key, _title in (("smoke_job", "Smoke test"), ("job", "Full run")):
            if not _driver.get(_key):
                continue
            _job = Path(_driver[_key])
            _st, _bk = read_json(_job / "status.json"), read_json(_job / "backup_status.json")
            _line = (f"**{_title}:** {_st.get('state', 'waiting')} · stage `{_st.get('stage') or '-'}` · {_st.get('message', '')}"
                     + (f" · {_st['progress']:.0%}" if isinstance(_st.get("progress"), (int, float)) else "")
                     + f"\n\nDrive backup: {_bk.get('state', 'not started')}, {_bk.get('uploaded_bytes', 0) / 2**30:.2f} GiB uploaded"
                     + (f" (last error: {_bk['error']})" if _bk.get("error") else "")
                     + (f"\n\n**Error:** `{_st['error']}`" if _st.get("error") else ""))
            _parts.append(mo.md(_line))
            _previews = sorted((_job / "train" / "previews").glob("*.jpg"))
            if _previews:
                _parts.append(mo.image(src=_previews[-1].read_bytes(), caption=f"{_title}: photo | render | depth, {_previews[-1].stem}"))
            _log = _job / "logs" / "pipeline.log"
            if _log.exists():
                _tail = "\n".join(_log.read_text(errors="replace").splitlines()[-30:])
                _parts.append(mo.accordion({f"{_title} log": mo.md(f"```\n{_tail}\n```")}))
    mo.vstack(_parts)
    return


@app.cell
def _():
    show_downloads = mo.ui.run_button(label="Show download buttons for the finished result")
    show_downloads
    return (show_downloads,)


@app.cell
def _(jobs_root, show_downloads):
    mo.stop(not show_downloads.value)
    _driver = read_json(Path(jobs_root.value) / "driver_status.json")
    _folder = Path(_driver.get("job", "/nonexistent")) / "export" / "DOWNLOAD_THIS"
    _files = sorted(p for p in _folder.rglob("*") if p.is_file()) if _folder.exists() else []
    if _files:
        _out = mo.vstack([mo.md("Download every file into one folder, then import it in the viewer (*Namma Pipeline.cmd > 1. Import a trained result*, see `viewer/README.md`). "
                                f"(Also on Google Drive: `{_driver.get('job_id')}`, folder `…-download-…`.)")]
                         + [mo.download(data=p.read_bytes(), filename=p.name, label=f"{p.name} ({p.stat().st_size / 2**20:.0f} MiB)")
                            for p in _files])
    else:
        _out = mo.md("No finished result yet.")
    _out
    return


@app.cell
def _():
    mo.md("""
    ## Hyperparameter sweep

    After the canonical job (above) finishes its **priors** stage, fork it into N variants
    that share the upstream stages (`frames` / `sfm` / `priors` — hardlinked, no extra disk)
    and only re-run **train + mesh + export** with different settings. Each variant is a
    separate `python -m namma run --job <variant>` process; the RTX PRO 6000 (96 GiB VRAM)
    fits 3–4 train jobs in parallel. Re-click **Start / continue sweep** to launch the next
    batch when slots free up.

    The default grid covers the audit's recommendations and the baseline. Edit the JSON to
    add your own variants (e.g. `cap_max=1.5M`, `strategy="default"`, `image_long_side=3840`).
    For variants that change `priors.*` settings, set `"fork_after": "sfm"` so the `priors`
    stage re-runs with the new value.
    """)
    return


@app.cell
def _():
    import json as _json
    sweep_grid_text = mo.ui.text_area(
        value=_json.dumps(default_sweep_grid(), indent=2),
        label="Sweep grid (JSON list of {name, settings, fork_after})",
        full_width=True,
    )
    max_parallel = mo.ui.slider(1, 6, value=3, label="Max parallel variant jobs")
    min_vram_mib = mo.ui.slider(8000, 20000, value=12000, step=1000,
                                label="Min free VRAM (MiB) before launching another variant")
    start_sweep = mo.ui.run_button(label="Start / continue sweep")
    mo.vstack([sweep_grid_text, max_parallel, min_vram_mib, start_sweep])
    return max_parallel, min_vram_mib, start_sweep, sweep_grid_text


@app.cell
def _(jobs_root, max_parallel, min_vram_mib, start_sweep, sweep_grid_text, workspace):
    mo.stop(not start_sweep.value)
    _repo = Path(workspace.value)
    _venv = _repo / ".venv" / "bin" / "python"
    _driver = read_json(Path(jobs_root.value) / "driver_status.json")
    _canon = _driver.get("job")
    _problems = []
    if not _canon or not Path(_canon).exists():
        _problems.append("Click **3. Start / resume reconstruction** first so a canonical job exists.")
    elif not (Path(_canon) / "stages" / "priors.json").exists():
        _problems.append("Wait for the canonical job to finish the `priors` stage before forking variants.")
    if not _venv.exists():
        _problems.append("Run setup (section 2) first.")
    try:
        _grid = json.loads(sweep_grid_text.value) if sweep_grid_text.value else []
        if not isinstance(_grid, list) or not _grid:
            _problems.append("Sweep grid must be a non-empty JSON list.")
        for i, v in enumerate(_grid):
            if not isinstance(v, dict) or "name" not in v or "settings" not in v:
                _problems.append(f"Sweep grid entry {i} must have `name` and `settings`.")
    except ValueError as e:
        _problems.append(f"Sweep grid is not valid JSON: {e}")
    if _problems:
        _out = mo.md("\n".join(f"- {p}" for p in _problems))
    else:
        _launched, _running, _skipped = [], 0, []
        for _v in _grid:
            _vname = _v["name"]
            _vjob = variant_job_dir(_canon, _vname)
            _status = read_json(Path(_vjob) / "status.json") if Path(_vjob).exists() else {}
            if _status.get("state") == "running":
                _running += 1
                _skipped.append(f"{_vname} (running)")
                continue
            if _status.get("state") == "finished":
                _skipped.append(f"{_vname} (done)")
                continue
            if not Path(_vjob).exists():
                clone_job_for_variant(_canon, _vjob, _v.get("fork_after", "priors"))
                override_job_settings(_vjob, _v.get("settings", {}))
            if _running >= max_parallel.value:
                _skipped.append(f"{_vname} (queued: max_parallel reached)")
                continue
            free = gpu_free_vram_mib()
            if free is not None and free < min_vram_mib.value:
                _skipped.append(f"{_vname} (queued: only {free:,} MiB VRAM free)")
                continue
            launch_variant(str(_venv), str(_repo), _vjob)
            _launched.append(_vname)
            _running += 1
        _msg = [f"**Launched {len(_launched)}** variant(s): {', '.join(_launched) or 'none'}."]
        if _skipped:
            _msg.append(f"Skipped: {'; '.join(_skipped)}.")
        if _running < len(_grid):
            _msg.append("Click **Start / continue sweep** again to launch the next batch.")
        _out = mo.md("  \n".join(_msg))
    _out
    return


@app.cell
def _(jobs_root, refresh):
    refresh
    _driver = read_json(Path(jobs_root.value) / "driver_status.json")
    _canon = _driver.get("job")
    if not _canon:
        _out = mo.md("No canonical job yet — start the reconstruction in section 3 first.")
    else:
        _rows = sweep_status_rows(jobs_root.value, _canon)
        if not _rows:
            _out = mo.md("Canonical job exists but has no status yet.")
        else:
            _best_psnr, _best_name = -1.0, None
            for r in _rows:
                if r.get("psnr") and r["psnr"] > _best_psnr:
                    _best_psnr, _best_name = r["psnr"], r["variant"]
            _lines = [
                "| variant | kind | state | stage | steps | min_a | trunc | PSNR | SSIM | Gaussians | triangles | dropped |",
                "|---------|------|-------|-------|-------|-------|-------|------|------|-----------|-----------|---------|",
            ]
            for r in _rows:
                _star = " **\u2605**" if r["variant"] == _best_name and r.get("psnr") else ""
                _psnr = f"{r['psnr']:.2f}" if r.get("psnr") is not None else "-"
                _ssim = f"{r['ssim']:.4f}" if r.get("ssim") is not None else "-"
                _g = f"{r['gaussians']:,}" if r.get("gaussians") else "-"
                _t = f"{r['triangles']:,}" if r.get("triangles") else "-"
                _ma = r["min_alpha"] if r.get("min_alpha") is not None else "-"
                _tv = r["trunc_voxels"] if r.get("trunc_voxels") is not None else "-"
                _cd = r.get("components_dropped") if r.get("components_dropped") is not None else "-"
                _lines.append(
                    f"| {r['variant']}{_star} | {r['kind']} | {r['state']} | {r['stage']} | "
                    f"{r.get('steps') or '-'} | {_ma} | {_tv} | {_psnr} | {_ssim} | {_g} | {_t} | {_cd} |"
                )
            _free = gpu_free_vram_mib()
            _vram_line = f"\n\nFree VRAM: **{_free:,} MiB**" if _free is not None else ""
            _out = mo.md("\n".join(_lines) + _vram_line + "\n\n\u2605 = best held-out PSNR so far. Click the refresh button above to update.")
    _out
    return



if __name__ == "__main__":
    app.run()
