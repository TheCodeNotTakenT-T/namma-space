import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")

with app.setup:
    import json
    import os
    import re
    import subprocess
    import sys
    import time
    from pathlib import Path

    import marimo as mo

    ROOT = Path("/opt/namma-quality")            # outside /marimo: a molab restart cannot half-restore it
    REPO_DIR = ROOT / "namma-space"
    REPO_URL = "https://github.com/TheCodeNotTakenT-T/namma-space.git"
    BRANCH = "round2"
    SOURCE_ROOT = "NammaSpaceBackups"
    REMOTE_ROOT = "NammaQuality"
    VARIANTS = {"baseline": "Today's trainer (per-frame colour fix), as for the Round 1 room",
                "ppisp": "PPISP: exposure, vignetting, colour and camera response per frame"}


@app.function
def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


@app.function
def tail(path, lines=25):
    try:
        text = Path(path).read_bytes()[-100000:].decode(errors="replace").replace("\r", "\n")
    except OSError:
        return ""
    return "\n".join([line for line in text.splitlines() if line.strip()][-lines:])


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
def drive_connected():
    """molab's Remote storage cell caches the Google login in pydata-google-auth's credentials file."""
    try:
        import pydata_google_auth.cache
        return os.path.exists(pydata_google_auth.cache.READ_WRITE._path)
    except ImportError:
        return False


@app.function
def ensure_gdrive_fork():
    """PyPI gdrive_fsspec lacks the multi-chunk resumable-upload fix that multi-GB checkpoints need."""
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
def list_jobs():
    """Finished Namma Space jobs on Drive that have a camera solve (…-sfm-…) to reuse."""
    from gdrive_fsspec import GoogleDriveFileSystem
    fs = GoogleDriveFileSystem(token="cache", auth_kwargs={"use_local_webserver": False},
                               use_listings_cache=False, skip_instance_cache=True)
    jobs = []
    for folder in sorted(fs.ls(SOURCE_ROOT, detail=False)):
        name = folder.rstrip("/").rsplit("/", 1)[-1]
        if name.startswith("_") or name.endswith("-smoke"):
            continue
        entries = [p.rstrip("/").rsplit("/", 1)[-1] for p in fs.ls(folder, detail=False)]
        if any(re.fullmatch(r"\d+-sfm-[0-9a-f]+", e) for e in entries):
            jobs.append(name)
    return jobs


@app.function
def get_code():
    """Clone (or fast-forward) the published repository's round2 branch; the venv and builds are kept."""
    if not (REPO_DIR / ".git").exists():
        REPO_DIR.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "-q", "--branch", BRANCH, REPO_URL, str(REPO_DIR)], check=True)
    else:
        subprocess.run(["git", "-C", str(REPO_DIR), "fetch", "-q", "origin", BRANCH], check=True)
        subprocess.run(["git", "-C", str(REPO_DIR), "checkout", "-q", "-B", BRANCH, f"origin/{BRANCH}"], check=True)
    return subprocess.run(["git", "-C", str(REPO_DIR), "log", "-1", "--format=%h %s"], capture_output=True, text=True).stdout.strip()


@app.cell
def _():
    mo.md("""
    # Does PPISP make the room better?

    Trains the room again under each setting below, on the **same frames, camera solve and depth priors**
    as a finished Namma Space job, so the setting is the only difference. Then it renders held-out
    photos (never used for training) from every result side by side, with scores.

    It uses its own folder (`/opt/namma-quality`) and its own Drive folder (`NammaQuality/`), and only
    *reads* the finished job. Each result is also a complete room you can import into the viewer.

    **Before you start:** select a GPU runtime, then connect Google Drive: Files panel (left) >
    *Remote storage* > *Google Drive*, and run the cell it adds.

    0. **Quick GPU test** (about 15 minutes, once per session): installs the GPU environment, then trains two
       tiny rooms from a clip bundled with the code, stops one on purpose and resumes it, and builds a
       comparison. Wait for **PASSED** before step 2; if it says FAILED, send the log it shows.
    1. **Find my jobs** lists your finished rooms on Drive. Keep the DSLR classroom job selected.
    2. **Start / resume** runs everything unattended: code, GPU environment (compiled builds come from the
       Drive cache), then for each setting: restore, depth maps, 30,000 training steps, collision mesh,
       export. Expect **about 1.5 to 2.5 hours** in total (longer the first time PPISP is compiled).
    3. The status below refreshes itself. You can close the tab; the run continues while molab lives.
       **If molab stops**, open this notebook again, connect Drive and click **Start / resume**: finished
       settings are skipped and training resumes from its newest checkpoint on Drive.
    """)
    return


@app.cell
def _():
    quick = mo.ui.run_button(label="0. Quick GPU test (about 15 min)")
    quick
    return (quick,)


@app.cell
def _(quick):
    mo.stop(not quick.value)
    if not drive_connected():
        _out = mo.md("Connect Google Drive first (Files > Remote storage > Google Drive, run the inserted cell): "
                     "the compiled builds are cached there.")
    elif process_running("namma.experiment"):
        _out = mo.md("A test or experiment is already running; its progress is shown below.")
    else:
        _fork = ensure_gdrive_fork()
        try:
            _code = get_code()
            (ROOT / "logs").mkdir(parents=True, exist_ok=True)
            with open(ROOT / "logs" / "launch.log", "ab") as _log:
                subprocess.Popen([sys.executable, "-m", "namma.experiment", "selftest", "--root", str(ROOT)], cwd=REPO_DIR,
                                 env={**os.environ, "PYTHONPATH": str(REPO_DIR)}, stdin=subprocess.DEVNULL, stdout=_log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
            _out = mo.md(f"Quick test started with code `{_code}` ({_fork}). Progress appears below.")
        except subprocess.CalledProcessError as _error:
            _out = mo.md(f"Could not download the code: `{_error}`")
    _out
    return


@app.cell
def _():
    quick_refresh = mo.ui.refresh(default_interval="30s", options=["10s", "30s", "1m"])
    quick_refresh
    return (quick_refresh,)


@app.cell
def _(quick_refresh):
    quick_refresh
    _st = read_json(ROOT / "selftest.json")
    if not _st:
        _view = mo.md("Quick test: not run in this session yet.")
    else:
        _state = _st.get("state")
        if _state == "running" and not process_running("namma.experiment"):
            _state = "STOPPED (click 0 again)"
        _mins = int(((_st.get("finished") or time.time()) - _st.get("started", time.time())) // 60)
        _lines = [f"Quick test: **{str(_state).upper()}** · {_st.get('message', '')} · {_mins} min"]
        if _st.get("error"):
            _lines.append(f"```\n{_st['error']}\n```")
        _view = mo.vstack([mo.md("\n\n".join(_lines)), mo.accordion({
            "Quick test log": mo.md(f"```\n{tail(ROOT / 'logs' / 'selftest.log', 40)}\n```"),
            "Setup log": mo.md(f"```\n{tail(ROOT / 'logs' / 'setup.log')}\n```"),
            "Launch log": mo.md(f"```\n{tail(ROOT / 'logs' / 'launch.log')}\n```"),
        })])
    _view
    return


@app.cell
def _():
    find_jobs = mo.ui.run_button(label="1. Find my jobs on Drive")
    find_jobs
    return (find_jobs,)


@app.cell
def _(find_jobs):
    jobs = []
    if not find_jobs.value:
        _note = "Connect Google Drive, then click **1. Find my jobs on Drive**."
    elif not drive_connected():
        _note = "Google Drive is **not connected**: Files panel > Remote storage > Google Drive, run the cell it adds, then click 1 again."
    else:
        try:
            jobs = list_jobs()
            _note = f"Found {len(jobs)} job(s) with a camera solve." if jobs else f"No finished job with a camera solve in `{SOURCE_ROOT}/`."
        except Exception as _error:
            _note = f"Could not list Drive: `{type(_error).__name__}: {_error}`"
    mo.md(_note)
    return (jobs,)


@app.cell
def _(jobs):
    _default = next((j for j in jobs if "f9935280" in j), jobs[0] if jobs else None)
    job = mo.ui.dropdown(options=jobs, value=_default, label="Job whose camera solve to reuse", full_width=True)
    variants = mo.ui.multiselect(options={v: k for k, v in VARIANTS.items()}, value=list(VARIANTS.values()),
                                 label="Settings to train and compare (in this order)", full_width=True)
    start = mo.ui.run_button(label="2. Start / resume the experiment")
    mo.vstack([job, variants, start])
    return job, start, variants


@app.cell
def _(job, start, variants):
    mo.stop(not start.value)
    _problems = []
    if not drive_connected():
        _problems.append("Connect Google Drive (Files > Remote storage > Google Drive, run the inserted cell). "
                         "Without it nothing survives a molab stop.")
    if not job.value:
        _problems.append("Click **1. Find my jobs on Drive** and pick the job.")
    if not variants.value:
        _problems.append("Pick at least one setting.")
    if process_running("namma.experiment"):
        _problems.append("An experiment is already running; its progress is shown below.")
    if _problems:
        _out = mo.md("\n".join(f"- {p}" for p in _problems))
    else:
        _fork = ensure_gdrive_fork()
        try:
            _code = get_code()
        except subprocess.CalledProcessError as _error:
            _code = None
            _out = mo.md(f"Could not download the code: `{_error}`")
        if _code:
            (ROOT / "logs").mkdir(parents=True, exist_ok=True)
            _chosen = [v for v in VARIANTS if v in variants.value]
            _env = {**os.environ, "PYTHONPATH": str(REPO_DIR)}
            with open(ROOT / "logs" / "launch.log", "ab") as _log:
                subprocess.Popen([sys.executable, "-m", "namma.experiment", "run", "--source-job", job.value, "--variants", *_chosen,
                                  "--root", str(ROOT)], cwd=REPO_DIR, env=_env, stdin=subprocess.DEVNULL, stdout=_log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
            _out = mo.md(f"Started `{', '.join(_chosen)}` on `{job.value}` with code `{_code}` ({_fork}). "
                         "Progress appears below; it keeps running if this tab closes.")
    _out
    return


@app.cell
def _():
    refresh = mo.ui.refresh(default_interval="30s", options=["10s", "30s", "1m"])
    refresh
    return (refresh,)


@app.cell
def _(refresh):
    refresh
    _st = read_json(ROOT / "status.json")
    _parts = [mo.md("**Google Drive:** " + ("connected" if drive_connected() else
                    "NOT connected: Files panel > Remote storage > Google Drive, then run the cell it inserts."))]
    if not _st:
        _parts.append(mo.md("No experiment in this session yet."))
    else:
        _state = _st.get("state")
        if _state == "running" and not process_running("namma.experiment"):
            _state = "STOPPED (the run is gone; click Start / resume to continue)"
        _elapsed = int(time.time() - _st.get("started", time.time()))
        _lines = [f"**{_state}** · `{_st.get('stage', '-')}` · {_st.get('message', '')}"
                  + f" · running {_elapsed // 3600} h {_elapsed % 3600 // 60:02d} min · code `{(_st.get('code') or '')[:7]}`"]
        _job_dir = Path(_st.get("job_dir", "/nonexistent"))
        _pipe = read_json(_job_dir / "status.json")
        if _pipe and "pipeline" in str(_st.get("stage")):
            _progress = _pipe.get("progress")
            _lines.append(f"Pipeline `{_job_dir.name}`: **{_pipe.get('state')}** · stage `{_pipe.get('stage') or '-'}` · {_pipe.get('message', '')}"
                          + (f" · **{_progress:.0%}**" if isinstance(_progress, (int, float)) else ""))
        _backup = read_json(_job_dir / "backup_status.json")
        if _backup:
            _lines.append(f"Drive backup: {_backup.get('state')}"
                          + (f", {_backup.get('uploaded_bytes', 0) / 2**30:.2f} GiB uploaded" if _backup.get("uploaded_bytes") else "")
                          + (f", error: {_backup['error']}" if _backup.get("error") else ""))
        for _name in VARIANTS:
            _m = _st.get(f"finished_{_name}")
            if _m:
                _lines.append(f"Finished **{_name}**: PSNR {_m.get('psnr') or 0:.2f} dB, colour-matched {_m.get('cc_psnr') or 0:.2f} dB, "
                              f"SSIM {_m.get('ssim') or 0:.3f}, {_m.get('gaussians') or 0:,} Gaussians, {_m.get('minutes')} min")
        if _st.get("error"):
            _lines.append(f"**Error:**\n```\n{_st['error']}\n```")
        _parts.append(mo.md("\n\n".join(_lines)))
        _report = ROOT / "report" / "report.md"
        if _st.get("state") == "finished" and _report.exists():
            _text = "\n".join(l for l in _report.read_text().splitlines() if not l.startswith("!["))
            _parts.append(mo.md(_text))
            for _sheet in sorted((ROOT / "report").glob("compare_*.jpg")):
                _parts.append(mo.image(src=_sheet.read_bytes(), width="100%"))
        _parts.append(mo.accordion({
            "Pipeline log": mo.md(f"```\n{tail(_job_dir / 'logs' / 'pipeline.log')}\n```"),
            "Experiment log": mo.md(f"```\n{tail(ROOT / 'logs' / 'experiment.log')}\n```"),
            "Setup log": mo.md(f"```\n{tail(ROOT / 'logs' / 'setup.log')}\n```"),
            "Launch log": mo.md(f"```\n{tail(ROOT / 'logs' / 'launch.log')}\n```"),
        }))
    mo.vstack(_parts)
    return


@app.cell
def _():
    show_downloads = mo.ui.run_button(label="Show download buttons for the finished results")
    show_downloads
    return (show_downloads,)


@app.cell
def _(show_downloads):
    mo.stop(not show_downloads.value)
    _st = read_json(ROOT / "status.json")
    _items = []
    if _st.get("state") == "finished":
        _report = sorted(p for p in (ROOT / "report").glob("*") if p.is_file())
        _items.append(mo.md(f"**Comparison** (also on Drive in `{REMOTE_ROOT}/{_st.get('job')}-report/`)"))
        _items += [mo.download(data=p.read_bytes(), filename=p.name, label=p.name) for p in _report]
        for _job in sorted((ROOT / "jobs").iterdir()):
            _files = sorted(p for p in (_job / "export" / "DOWNLOAD_THIS").rglob("*") if p.is_file())
            if _files:
                _items.append(mo.md(f"**Room `{_job.name}`** for the viewer (Namma Pipeline.cmd > Import a trained result; "
                                    f"also on Drive in `{REMOTE_ROOT}/{_job.name}/`)"))
                _items += [mo.download(data=p.read_bytes(), filename=p.name, label=f"{p.name} ({p.stat().st_size / 2**20:.0f} MiB)")
                           for p in _files]
    _out = mo.vstack(_items) if _items else mo.md("No finished experiment yet.")
    _out
    return


if __name__ == "__main__":
    app.run()
