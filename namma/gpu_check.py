"""Real GPU checks for the Namma Space environment (gsplat, MoGe-2, pycolmap, Open3D).

Every check runs in its own subprocess (a CUDA fault in one cannot hide or
poison the others), executes a small real CUDA operation, and records the
imported binary paths, timings and numeric evidence. Import-only is never
treated as a pass for a native module.

Run from the repository root with the training venv:
    .venv/bin/python -m namma check --out setup-logs/<run>
"""
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Every check is required: setup passes only when all of them pass.
CHECKS = ("environment", "torch_cuda", "gsplat", "pipeline_imports", "open3d_tsdf")


class CheckFailed(AssertionError):
    """A failed check that still carries the evidence it collected."""

    def __init__(self, message, details):
        super().__init__(message)
        self.details = details


def _module_file(name):
    module = sys.modules.get(name)
    return getattr(module, "__file__", None) if module else None


def _command(args):
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=60)
        return (out.stdout + out.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"unavailable: {error}"


def _assert_outside_source(path, label):
    """Native binaries must come from this venv's build, not stale files in the source tree."""
    if path is None:
        raise AssertionError(f"{label}: no binary path")
    resolved = Path(path).resolve()
    source = os.environ.get("NAMMA_GSPLAT_SRC")
    if source and Path(source).resolve() in resolved.parents:
        raise AssertionError(f"{label} imported from the source tree ({resolved}), not the built venv package")
    return str(resolved)


def check_environment():
    import importlib.metadata as md
    import torch

    details = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "cudnn": torch.backends.cudnn.version(),
        "torch_arch_list": torch.cuda.get_arch_list(),
        "cuda_available": torch.cuda.is_available(),
        "env": {k: os.environ.get(k) for k in ("CUDA_HOME", "TORCH_CUDA_ARCH_LIST", "NVCC_FLAGS",
                                               "NVCC_PREPEND_FLAGS", "MAX_JOBS")},
        "nvidia_smi": _command(["nvidia-smi", "--query-gpu=name,driver_version,memory.total,compute_cap",
                                "--format=csv,noheader"]),
        "gcc": (_command(["gcc", "--version"]) or "no output").splitlines()[0],
        "repo_commit": _command(["git", "-C", str(REPO), "rev-parse", "HEAD"]),
        "repo_dirty": bool(_command(["git", "-C", str(REPO), "status", "--porcelain", "--untracked-files=no"])),
        "gsplat_source": os.environ.get("NAMMA_GSPLAT_SRC"),
        "packages": {},
    }
    for name in ("torch", "torchvision", "numpy", "scipy", "open3d", "opencv-python", "huggingface-hub",
                 "pycolmap", "cuda-toolkit", "nvidia-cuda-nvcc", "gsplat", "moge", "utils3d_moge", "av",
                 "trimesh", "jaxtyping"):
        try:
            details["packages"][name] = md.version(name)
        except md.PackageNotFoundError:
            details["packages"][name] = None

    cuda_home = os.environ.get("CUDA_HOME")
    nvcc = shutil.which("nvcc") or (cuda_home and str(Path(cuda_home) / "bin" / "nvcc"))
    details["nvcc_path"] = nvcc
    details["nvcc"] = _command([nvcc, "--version"]) if nvcc else "missing"
    match = re.search(r"release (\d+\.\d+)", details["nvcc"])
    details["nvcc_release"] = match.group(1) if match else None

    problems = []
    if torch.cuda.is_available():
        capability = torch.cuda.get_device_capability()
        details["device"] = torch.cuda.get_device_name()
        details["compute_capability"] = f"{capability[0]}.{capability[1]}"
        free, total = torch.cuda.mem_get_info()
        details["vram_gib"] = {"free": round(free / 2**30, 2), "total": round(total / 2**30, 2)}
        if f"sm_{capability[0]}{capability[1]}" not in details["torch_arch_list"]:
            problems.append(f"Torch build lacks kernels for sm_{capability[0]}{capability[1]}")
    else:
        problems.append("PyTorch cannot use CUDA (driver too old for this Torch CUDA build, or no GPU)")
    if details["nvcc_release"] != torch.version.cuda:
        problems.append(f"nvcc {details['nvcc_release']} does not match Torch CUDA {torch.version.cuda}")
    if problems:
        raise CheckFailed("; ".join(problems), details)
    return details


def check_torch_cuda():
    import torch
    torch.manual_seed(0)
    layer = torch.nn.Linear(64, 64).cuda()
    x = torch.randn(128, 64, device="cuda")
    loss = layer(x).square().mean()
    loss.backward()
    torch.cuda.synchronize()
    expected = (x @ layer.weight.T + layer.bias).square().mean()
    assert torch.isfinite(layer.weight.grad).all() and layer.weight.grad.abs().sum() > 0
    assert torch.allclose(loss, expected, rtol=1e-4), "matmul result mismatch"
    return {"loss": loss.item(), "grad_norm": layer.weight.grad.norm().item()}


def check_gsplat():
    """Render + backward with gsplat, the patched MCMC relocation kernel, and depth_to_normal."""
    import importlib.util
    import math
    import gsplat
    import torch
    from gsplat.relocation import compute_relocation
    from gsplat.rendering import rasterization
    from gsplat.utils import depth_to_normal

    spec = importlib.util.find_spec("gsplat.csrc")
    binary = _assert_outside_source(spec.origin, "gsplat") if spec and spec.origin else gsplat.__file__
    torch.manual_seed(0)
    device = "cuda"
    n, width, height = 4000, 160, 120
    means = torch.empty(n, 3, device=device).uniform_(-1, 1)
    means[:, 2] = means[:, 2].abs() * 1.5 + 2.5
    params = {
        "means": means.requires_grad_(),
        "scales": torch.full((n, 3), math.log(0.03), device=device).requires_grad_(),
        "quats": torch.nn.functional.normalize(torch.randn(n, 4, device=device), dim=-1).requires_grad_(),
        "opacities": torch.full((n,), 1.0, device=device).requires_grad_(),
        "colors": (torch.randn(n, 16, 3, device=device) * 0.2).requires_grad_(),
    }
    K = torch.tensor([[150.0, 0, width / 2], [0, 150.0, height / 2], [0, 0, 1]], device=device)
    renders, alphas, info = rasterization(params["means"], params["quats"], torch.exp(params["scales"]),
                                          torch.sigmoid(params["opacities"]), params["colors"],
                                          torch.eye(4, device=device)[None], K[None], width, height, sh_degree=3,
                                          render_mode="RGB+ED", packed=False)
    assert renders.shape == (1, height, width, 4) and torch.isfinite(renders).all(), "non-finite render"
    coverage = float((alphas > 0.5).float().mean())
    assert coverage > 0.1, f"only {coverage:.0%} of pixels covered"
    (renders[..., :3].mean() + 0.1 * renders[..., 3].mean()).backward()
    grads = {}
    for name, p in params.items():
        assert p.grad is not None and torch.isfinite(p.grad).all(), f"bad gradient for {name}"
        grads[name] = float(p.grad.norm())
        assert grads[name] > 0, f"zero gradient for {name}"
    normals = depth_to_normal(renders[..., 3:4].detach(), torch.eye(4, device=device)[None], K[None])
    assert torch.isfinite(normals).all(), "non-finite normals"

    n_max = 51  # every MCMC split ratio, including the sm_120 fast-math sign case (upstream PR #1060)
    binoms = torch.zeros(n_max, n_max, device=device)
    for i in range(n_max):
        for k in range(i + 1):
            binoms[i, k] = math.comb(i, k)
    opac = torch.linspace(0.05, 0.95, n_max, device=device)
    scales = torch.linspace(0.1, 1.6, n_max * 3, device=device).reshape(n_max, 3)
    ratios = torch.arange(1, n_max + 1, device=device, dtype=torch.int32)
    import inspect
    accepted = inspect.signature(compute_relocation).parameters
    inputs = {"opacities": opac, "scales": scales, "ratios": ratios, "binoms": binoms}
    new_opac, new_scales = compute_relocation(**{k: v for k, v in inputs.items() if k in accepted})
    assert torch.isfinite(new_opac).all() and torch.isfinite(new_scales).all(), "relocation produced NaN"
    assert (new_scales > 0).all() and ((new_opac > 0) & (new_opac <= 1)).all(), "relocation out of range"
    return {"binary": binary, "version": gsplat.__version__, "coverage": coverage, "grad_norms": grads,
            "relocation_min_scale_ratio": float((new_scales / scales).min())}


def check_pipeline_imports():
    """Everything the video pipeline imports, with licence-relevant facts."""
    import av
    import moge.model.v2  # noqa: F401  (MoGe-2; weights download on first use)
    import pycolmap
    import trimesh  # noqa: F401
    for module in ("frames", "sfm", "priors", "trainer", "mesh", "export", "backup", "pipeline"):
        __import__(f"namma.{module}")
    has_cuda = bool(getattr(pycolmap, "has_cuda", False))
    assert not has_cuda, "pycolmap was built with CUDA: its GPU SIFT (SiftGPU) is not licensed for commercial use"
    return {"pycolmap": pycolmap.__version__, "pycolmap_cuda": has_cuda, "av": av.__version__,
            "moge": _module_file("moge")}


def check_open3d_tsdf():
    """Synthetic plane fusion; Open3D 0.20 produced zero vertices for this case on Molab."""
    import numpy as np
    import open3d as o3d
    depth = np.ascontiguousarray(np.full((128, 128), 2.0, dtype=np.float32))
    color = np.ascontiguousarray(np.full((128, 128, 3), 128, dtype=np.uint8))
    rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
        o3d.geometry.Image(color), o3d.geometry.Image(depth), depth_scale=1.0, depth_trunc=10.0,
        convert_rgb_to_intensity=False)
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=0.04, sdf_trunc=0.16, color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)
    intrinsic = o3d.camera.PinholeCameraIntrinsic(128, 128, 100, 100, 63.5, 63.5)
    for _ in range(3):
        volume.integrate(rgbd, intrinsic, np.eye(4))
    mesh = volume.extract_triangle_mesh()
    vertices, triangles = len(mesh.vertices), len(mesh.triangles)
    assert vertices > 0 and triangles > 0, "synthetic TSDF produced an empty mesh"
    return {"open3d": o3d.__version__, "vertices": vertices, "triangles": triangles}


def run_one(name):
    os.chdir(REPO)
    sys.path.insert(0, str(REPO))
    started = time.perf_counter()
    record = {"name": name, "required": True}
    try:
        record["details"] = globals()["check_" + name]()
        record["status"] = "pass"
    except BaseException as error:  # report every failure, including import errors
        record["status"] = "fail"
        record["details"] = getattr(error, "details", None)
        record["error"] = f"{type(error).__name__}: {error}"
        record["traceback"] = traceback.format_exc()[-4000:]
    record["seconds"] = round(time.perf_counter() - started, 3)
    print("NAMMA_CHECK_RESULT " + json.dumps(record, default=str), flush=True)


def run_all(out_dir, only=None):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    names = [n for n in CHECKS if not only or n in only]
    results = []
    for name in names:
        started = time.perf_counter()
        process = subprocess.run([sys.executable, "-m", "namma.gpu_check", name], cwd=REPO,
                                 capture_output=True, text=True, timeout=900)
        (out / f"check-{name}.log").write_text(process.stdout + process.stderr, encoding="utf-8")
        lines = [l for l in process.stdout.splitlines() if l.startswith("NAMMA_CHECK_RESULT ")]
        if lines:
            record = json.loads(lines[-1][len("NAMMA_CHECK_RESULT "):])
        else:  # crashed before reporting (segfault, abort)
            record = {"name": name, "required": True, "status": "fail",
                      "error": f"process exited {process.returncode} without a result; see check-{name}.log",
                      "seconds": round(time.perf_counter() - started, 3)}
        results.append(record)
        mark = "PASS" if record["status"] == "pass" else ("FAIL" if record["required"] else "optional-fail")
        print(f"{mark:>13}  {name:<14} {record['seconds']:>8.2f}s  {record.get('error', '')}", flush=True)

    failed = [r["name"] for r in results if r["status"] != "pass" and r["required"]]
    report = {"overall": "fail" if failed else "pass", "failed_required": failed,
              "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": results}
    (out / "report.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    (out / "report.md").write_text(_markdown(report), encoding="utf-8")
    print(f"Overall: {report['overall'].upper()}  report: {out / 'report.md'}", flush=True)
    return 1 if failed else 0


def _markdown(report):
    lines = [f"# Namma Space environment check: {report['overall'].upper()}", "",
             f"Generated {report['generated_utc']}. Each check runs in its own process; a native-module pass "
             "means a real CUDA operation (and backward where relevant) ran and matched a reference.", "",
             "| Check | Required | Result | Seconds | Binary / error |", "|---|---|---|---|---|"]
    for r in report["checks"]:
        detail = r.get("error") or (r.get("details") or {}).get("binary", "")
        lines.append(f"| {r['name']} | {'yes' if r['required'] else 'no'} | {r['status']} | {r['seconds']} | {detail} |")
    env = next((r.get("details") for r in report["checks"] if r["name"] == "environment"), None)
    if env:
        lines += ["", "## Environment", "", "```json", json.dumps(env, indent=2, default=str), "```"]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    run_one(sys.argv[1])
