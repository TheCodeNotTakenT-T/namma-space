#!/usr/bin/env bash
# Reproducible Linux/NVIDIA (Molab) setup for Namma Space. Safe to rerun.
#
#   bash molab_setup.sh             # install, build gsplat + MoGe, run GPU checks
#   bash molab_setup.sh --check     # only rerun the GPU checks/report
#   bash molab_setup.sh --rebuild   # rebuild gsplat even if a cached build exists
#
# Everything is logged to setup-logs/<UTC time>/ and packed into
# setup-logs/namma-setup-<UTC time>.tar.gz. Return that file when asking for help.
set -Eeuo pipefail
# Molab injects these for its own Python 3.13; they break the isolated venv.
unset PYTHONPATH PYTHONSAFEPATH PYTHONHOME

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ---- Pinned inputs ---------------------------------------------------------------------------
PYTHON_VERSION=3.12
MIN_DRIVER_CUDA=13.0                          # Torch 2.11.0+cu130 runtime
GSPLAT_URL=https://github.com/nerfstudio-project/gsplat.git
GSPLAT_COMMIT=512d366b67073d77ca099ede742683c165dfc23b   # main, 19 Sep 2026 (1.6.0 dev; CUDA 13 support)
GSPLAT_DIR=/opt/namma-src/gsplat              # outside /marimo: a molab restart cannot half-restore it
CACHE_DIR=/opt/namma-cache                    # compiled gsplat by build signature; the notebook syncs it with Drive
# Published compiled builds: <base>/gsplat-<signature>.tar + .tar.sha256 (GitHub release assets).
PREBUILT_BASE="${NAMMA_PREBUILT_BASE:-https://github.com/TheCodeNotTakenT-T/namma-space/releases/download/gsplat-prebuilt}"
MOGE_COMMIT=74fbce054ebed49800de42d0ad0e83495065719a     # microsoft/MoGe (MIT), MoGe-2 model used
UTILS3D_COMMIT=62f09d58509485564e24d5d9f6aac9ee9ebc0c37  # pinned by MoGe's pyproject
VENV="${NAMMA_VENV:-$REPO_ROOT/.venv}"
VENV_PY="$VENV/bin/python"

MODE=full
REBUILD=0
for arg in "$@"; do
    case "$arg" in
        --check) MODE=check ;;
        --rebuild) REBUILD=1 ;;
        *) echo "Unknown option: $arg"; exit 2 ;;
    esac
done

mkdir -p "$REPO_ROOT/setup-logs"
exec 9>"$REPO_ROOT/setup-logs/.lock"
flock -n 9 || { echo "Another molab_setup.sh is running in this repository."; exit 1; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$REPO_ROOT/setup-logs/$STAMP"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/setup.log") 2>&1
TIMINGS="$LOG_DIR/timings.tsv"
printf 'step\tseconds\n' > "$TIMINGS"

finish() {
    local code=$?
    echo "$STAMP" > "$REPO_ROOT/setup-logs/LATEST"
    if [[ $code == 0 ]]; then
        echo "SETUP PASSED. Report: $LOG_DIR/report.md"
    else
        echo "SETUP FAILED (exit $code). Full log: $LOG_DIR/setup.log"
    fi
    echo "Download and return: $REPO_ROOT/setup-logs/namma-setup-$STAMP.tar.gz"
    tar -czf "$REPO_ROOT/setup-logs/namma-setup-$STAMP.tar.gz" -C "$REPO_ROOT/setup-logs" "$STAMP" 2>/dev/null || true
}
trap finish EXIT

step() {  # step <name> <function>: run, time and record one setup stage
    local name=$1 started=$SECONDS
    echo; echo "==== $name ($(date -u +%H:%M:%S) UTC)"
    "$2"
    printf '%s\t%s\n' "$name" "$((SECONDS - started))" >> "$TIMINGS"
}

# ---- Stages ---------------------------------------------------------------------------------
preflight() {
    [[ "$(uname -s)" == Linux ]] || { echo "Run this on the Linux GPU machine."; exit 1; }
    command -v nvidia-smi >/dev/null || { echo "nvidia-smi missing: select a GPU runtime."; exit 1; }
    for tool in git gcc curl tar flock; do
        command -v "$tool" >/dev/null || { echo "Missing required tool: $tool"; exit 1; }
    done
    nvidia-smi | tee "$LOG_DIR/nvidia-smi.txt"
    local driver_cuda
    driver_cuda="$(grep -o 'CUDA Version: [0-9.]*' "$LOG_DIR/nvidia-smi.txt" | awk '{print $3}')"
    if [[ "$(printf '%s\n%s\n' "$MIN_DRIVER_CUDA" "$driver_cuda" | sort -V | sed -n 1p)" != "$MIN_DRIVER_CUDA" ]]; then
        echo "Driver supports CUDA $driver_cuda; Torch cu130 needs $MIN_DRIVER_CUDA or newer."; exit 1
    fi
    if ! command -v uv >/dev/null; then
        python3 -m pip install --quiet uv
    fi
    { uv --version; gcc --version | sed -n 1p; ldd --version | sed -n 1p; git -C "$REPO_ROOT" rev-parse HEAD
      git -C "$REPO_ROOT" status --short; echo "cpus=$(nproc)"; free -g; df -h "$REPO_ROOT" "$HOME"; } \
        | tee "$LOG_DIR/host.txt"
}

install_python() {
    if [[ -x "$VENV_PY" ]] && ! "$VENV_PY" -c "import sys; assert sys.version.startswith('$PYTHON_VERSION.')" 2>/dev/null; then
        local saved="$VENV-preserved-$STAMP"
        echo "Existing $VENV is not Python $PYTHON_VERSION; moving it to $saved (nothing deleted)."
        mv "$VENV" "$saved"
    elif [[ -e "$VENV" ]] && ! "$VENV_PY" -c "import torch, numpy" 2>/dev/null; then
        # A molab shutdown keeps some files of the venv but not its interpreter or binaries.
        echo "$VENV is incomplete (interrupted install or molab shutdown); recreating it from the lock file."
        rm -rf "$VENV"
    fi
    [[ -x "$VENV_PY" ]] || uv venv --python "$PYTHON_VERSION" --seed "$VENV"
    uv pip install --python "$VENV_PY" --index-strategy unsafe-best-match -r env/requirements.lock.txt
    uv pip freeze --python "$VENV_PY" > "$LOG_DIR/pip-freeze.txt"
}

cuda_environment() {
    # nvcc comes from the pinned cuda-toolkit wheels inside the venv, matching Torch's CUDA.
    CUDA_HOME="$("$VENV_PY" -c 'import nvidia, pathlib; print(pathlib.Path(list(nvidia.__path__)[0]) / "cu13")')"
    # The venv's bin holds ninja: without it on PATH, torch builds extensions one file at a time.
    export CUDA_HOME PATH="$VENV/bin:$CUDA_HOME/bin:$PATH"
    command -v ninja >/dev/null || { echo "ninja missing from $VENV/bin (parallel builds impossible)"; exit 1; }
    [[ -x "$CUDA_HOME/bin/nvcc" ]] || { echo "nvcc missing at $CUDA_HOME/bin"; exit 1; }
    # The linker needs the unversioned name; the wheel only ships libcudart.so.13.
    [[ -e "$CUDA_HOME/lib/libcudart.so" ]] || ln -s libcudart.so.13 "$CUDA_HOME/lib/libcudart.so"
    export LD_LIBRARY_PATH="$CUDA_HOME/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    # Kept from the original multi-extension build: part of the cached gsplat build's signature.
    export NVCC_FLAGS="--device-entity-has-hidden-visibility=false -static-global-template-stub=false"
    # Older rasterizer headers rely on transitive fixed-width integer declarations.
    export NVCC_PREPEND_FLAGS="--pre-include=stdint.h,cstdint,cstddef"
    # CUDA 13 moved CCCL (cub/thrust/libcu++) out of include/; gsplat's host .cpp files need it too.
    local limits cccl
    limits="$(find -L "$CUDA_HOME" -path '*/cuda/std/limits' -print -quit)"
    [[ -n "$limits" ]] || { echo "CCCL headers (cuda/std/limits) not found under $CUDA_HOME"; exit 1; }
    cccl="$(dirname "$(dirname "$(dirname "$limits")")")"
    echo "CCCL include dir: $cccl"
    if [[ "$cccl" != "$CUDA_HOME/include" ]]; then
        NVCC_PREPEND_FLAGS+=" -I$cccl"
        export CPLUS_INCLUDE_PATH="$cccl${CPLUS_INCLUDE_PATH:+:$CPLUS_INCLUDE_PATH}"
        export CUDA_INC_PATH="$cccl"   # torch adds this to both g++ and nvcc include paths
    fi
    export FORCE_CUDA=1
    # Parallel nvcc jobs: one per CPU, at most one per 4 GiB of available RAM.
    local ram_jobs
    ram_jobs="$(awk '/MemAvailable/ {print int($2 / 4194304)}' /proc/meminfo)"
    export MAX_JOBS="${MAX_JOBS:-$(( ram_jobs < $(nproc) ? (ram_jobs > 0 ? ram_jobs : 1) : $(nproc) ))}"
    if [[ -z "${TORCH_CUDA_ARCH_LIST:-}" ]]; then
        TORCH_CUDA_ARCH_LIST="$("$VENV_PY" -c 'import torch; print("%d.%d" % torch.cuda.get_device_capability())')"
    fi
    export TORCH_CUDA_ARCH_LIST
    local nvcc_release torch_cuda
    nvcc_release="$(nvcc --version | grep -o 'release [0-9.]*' | awk '{print $2}')"
    torch_cuda="$("$VENV_PY" -c 'import torch; print(torch.version.cuda)')"
    echo "CUDA_HOME=$CUDA_HOME nvcc=$nvcc_release torch_cuda=$torch_cuda arch=$TORCH_CUDA_ARCH_LIST MAX_JOBS=$MAX_JOBS"
    [[ "$nvcc_release" == "$torch_cuda" ]] || { echo "nvcc $nvcc_release does not match Torch CUDA $torch_cuda"; exit 1; }
    nvcc --list-gpu-arch > "$LOG_DIR/nvcc-gpu-arch.txt"
    grep -qx "compute_${TORCH_CUDA_ARCH_LIST//./}" "$LOG_DIR/nvcc-gpu-arch.txt" \
        || { echo "nvcc cannot target compute capability $TORCH_CUDA_ARCH_LIST"; exit 1; }
}

signature() {  # identity of one extension build: toolchain + exact sources
    local top
    top="$(git -C "$1" rev-parse --show-toplevel)"
    {
        "$VENV_PY" -c 'import sys, torch; print(sys.version, torch.__version__, torch.version.cuda)'
        nvcc --version | tail -2
        gcc --version | sed -n 1p
        # Paths inside the venv are written as <venv>: a published build must match wherever the repo is cloned.
        echo "$TORCH_CUDA_ARCH_LIST|$NVCC_FLAGS|${NVCC_PREPEND_FLAGS//$VENV/<venv>}|${FAST_MATH:-1}|${CPLUS_INCLUDE_PATH//$VENV/<venv>}"
        if [[ "$top" == "$REPO_ROOT" ]]; then
            git ls-files -s "$1"
            git diff HEAD -- "$1"
        else  # its own checkout (gsplat): pinned commit + our patch
            git -C "$top" rev-parse HEAD
            git -C "$top" diff
        fi
    } | sha256sum | cut -d' ' -f1
}

fetch_gsplat() {
    local dir=$GSPLAT_DIR patch="$REPO_ROOT/env/patches/gsplat-relocation-sign.patch"
    if [[ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" != "$GSPLAT_COMMIT" ]]; then
        rm -rf "$dir"   # scratch copy of pinned upstream source, never edited by hand
        mkdir -p "$dir"
        git -C "$dir" init -q
        git -C "$dir" fetch -q --depth 1 "$GSPLAT_URL" "$GSPLAT_COMMIT"
        git -C "$dir" checkout -q --detach FETCH_HEAD
        git -C "$dir" submodule update -q --init --recursive --depth 1
    fi
    if git -C "$dir" apply --reverse --check "$patch" 2>/dev/null; then
        echo "gsplat relocation patch already applied."
    else
        git -C "$dir" apply "$patch"
    fi
    git -C "$dir" log -1 --format='gsplat %H %cd'
    git -C "$dir" diff --stat
}

install_moge() {  # pure Python; --no-deps keeps NumPy 1.26.4 (MoGe 3.0's pyproject asks for numpy>=2)
    local stamp="$VENV/.namma-builds/moge" want="$MOGE_COMMIT $UTILS3D_COMMIT"
    if [[ -f "$stamp" && "$(cat "$stamp")" == "$want" ]] && "$VENV_PY" -c "import moge.model.v2, utils3d_moge" 2>/dev/null; then
        echo "MoGe already installed at the pinned commits."
        return
    fi
    if ! "$VENV_PY" -m pip install --no-deps --no-cache-dir --force-reinstall             "moge @ git+https://github.com/microsoft/MoGe.git@$MOGE_COMMIT"             "utils3d_moge @ git+https://github.com/EasternJournalist/utils3d-moge.git@$UTILS3D_COMMIT"             > "$LOG_DIR/install-moge.log" 2>&1; then
        tail -n 30 "$LOG_DIR/install-moge.log"; echo "MoGe install failed."; exit 1
    fi
    mkdir -p "$VENV/.namma-builds"
    echo "$want" > "$stamp"
}

save_cache() {  # save_cache <distribution> <signature>: pack the installed files so later sessions skip compiling
    local archive="$CACHE_DIR/$1-$2.tar"
    [[ ! -f "$archive" ]] || return 0
    mkdir -p "$CACHE_DIR"
    "$VENV_PY" - "$1" "$archive" <<'PY'
import importlib.metadata as md, pathlib, sys, tarfile
dist, archive = md.distribution(sys.argv[1]), pathlib.Path(sys.argv[2])
base = pathlib.Path(dist.locate_file(""))
with tarfile.open(archive.with_suffix(".part"), "w") as tar:
    for rel in dist.files:
        if (base / rel).exists():
            tar.add(base / rel, arcname=str(rel))
archive.with_suffix(".part").rename(archive)
PY
    sha256sum "$archive" | cut -d' ' -f1 > "$archive.sha256"
    echo "$1: compiled build saved to $archive (uploaded to Drive when you click Start)"
}

fetch_prebuilt() {  # fetch_prebuilt <file>: download a published build if one matches this exact signature
    local tmp="$CACHE_DIR/$1.download" want
    mkdir -p "$CACHE_DIR"
    if ! want="$(curl -fsSL --max-time 30 "$PREBUILT_BASE/$1.sha256")"; then
        echo "No published build for this signature at $PREBUILT_BASE ($1); compiling instead."
        return 1
    fi
    echo "Downloading the published build $1"
    curl -fsSL --retry 3 "$PREBUILT_BASE/$1" -o "$tmp" || { rm -f "$tmp"; return 1; }
    if [[ "$(sha256sum "$tmp" | cut -d' ' -f1)" != "${want%% *}" ]]; then
        echo "Published build failed its checksum; ignoring it."
        rm -f "$tmp"
        return 1
    fi
    mv "$tmp" "$CACHE_DIR/$1"
    echo "${want%% *}" > "$CACHE_DIR/$1.sha256"
}

build_one() {  # build_one <name> <path> <required:1|0>
    local name=$1 path=$2 required=$3 started=$SECONDS
    local stamps="$VENV/.namma-builds" sig
    mkdir -p "$stamps"
    sig="$(signature "$path")"
    if [[ $REBUILD == 0 && -f "$stamps/$name" && "$(cat "$stamps/$name")" == "$sig" ]]; then
        echo "$name: cached build matches toolchain and sources."
        printf 'build:%s\tcached\n' "$name" >> "$TIMINGS"
        [[ $name != gsplat ]] || save_cache gsplat "$sig"
        return
    fi
    if [[ $REBUILD == 0 && $name == gsplat && ! -f "$CACHE_DIR/$name-$sig.tar" ]]; then
        fetch_prebuilt "$name-$sig.tar" || true
    fi
    if [[ $REBUILD == 0 && -f "$CACHE_DIR/$name-$sig.tar" ]]; then
        tar -xf "$CACHE_DIR/$name-$sig.tar" -C "$("$VENV_PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
        echo "$sig" > "$stamps/$name"
        echo "$name: restored the compiled build from $CACHE_DIR (no compilation)."
        printf 'build:%s\trestored\n' "$name" >> "$TIMINGS"
        return
    fi
    rm -f "$stamps/$name"
    rm -rf "$path/build"   # generated objects from another toolchain
    echo "$name: building (log: $LOG_DIR/build-$name.log)"
    if "$VENV_PY" -m pip install --no-build-isolation --no-deps --no-cache-dir --force-reinstall -v "$path" \
            > "$LOG_DIR/build-$name.log" 2>&1; then
        echo "$sig" > "$stamps/$name"
        printf 'build:%s\t%s\n' "$name" "$((SECONDS - started))" >> "$TIMINGS"
        [[ $name != gsplat ]] || save_cache gsplat "$sig"
    else
        printf 'build:%s\tfailed\n' "$name" >> "$TIMINGS"
        tail -n 40 "$LOG_DIR/build-$name.log"
        if [[ $required == 1 ]]; then
            echo "Required extension $name failed to build."; exit 1
        fi
        echo "Optional extension $name failed."
    fi
}

build_extensions() {
    build_one gsplat "$GSPLAT_DIR" 1
    uv pip freeze --python "$VENV_PY" > "$LOG_DIR/pip-freeze-after-build.txt"
}

gpu_checks() {
    NAMMA_GSPLAT_SRC="$GSPLAT_DIR" "$VENV_PY" -m namma check --out "$LOG_DIR"
}

# ---- Run ------------------------------------------------------------------------------------
step preflight preflight
if [[ $MODE == full ]]; then
    step python install_python
fi
step cuda-environment cuda_environment
if [[ $MODE == full ]]; then
    step gsplat-source fetch_gsplat
    step extensions build_extensions
    step moge install_moge
fi
step gpu-checks gpu_checks
