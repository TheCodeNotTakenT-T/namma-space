"""Local end-to-end test of the pipeline plumbing with a stand-in renderer (tests/fake_gsplat.py).

    python tests/run_local_pipeline.py VIDEO WORK_DIR

Checks: every stage runs on a short clip; training is killed after its first checkpoint and resumes
from it; the export matches the importer contract; Drive backup to a local folder, restore into a
fresh job, and the rerun skips finished stages. Not a quality test and not a gsplat/GPU validation.
"""
import json
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
SETTINGS = {"sfm": {"train_long_side": 48, "min_registered": 0.4, "loop_detection": False, "max_image_size": 1280},
            "priors": {"enabled": False, "image_long_side": 48, "prior_long_side": 48},
            "train": {"steps": 240, "cap_max": 4000, "checkpoint_every": 80, "preview_every": 80, "normal_start": 40,
                      "sh_degree_interval": 40, "test_every": 8, "min_psnr": 0.0},
            "mesh": {"render_long_side": 48, "max_views": 16, "voxel": 0.05, "target_triangles": 20000}}


def child(job, until):
    """Run the pipeline with the stand-in renderer (separate process so it can be killed)."""
    import namma.trainer as T
    sys.path.insert(0, str(REPO / "tests"))
    import fake_gsplat
    T.BACKEND = fake_gsplat.BACKEND
    from namma import pipeline
    return pipeline.run(job, until or None)


def run_child(job, until="", kill_when=None):
    proc = subprocess.Popen([sys.executable, __file__, "--child", job, until], cwd=REPO)
    if kill_when:
        while proc.poll() is None and not kill_when():
            time.sleep(0.5)
        if proc.poll() is None:
            proc.kill()
            proc.wait()
            return "killed"
    return proc.wait()


def fake_priors(job):
    """MoGe cannot run here; write plausible priors so the depth/normal losses execute."""
    import numpy as np
    from namma.workspace import Workspace
    ws = Workspace(job)
    for img in sorted((ws.dataset / "images").glob("*.jpg")):
        import cv2
        h, w = cv2.imread(str(img)).shape[:2]
        normal = np.zeros((h, w, 3), np.float16)
        normal[..., 2] = -1
        np.savez(ws.priors / f"{img.name}.npz", depth=np.full((h, w), 2.0, np.float16), mask=np.ones((h, w), bool), normal=normal)


def check(condition, message):
    print(("PASS " if condition else "FAIL ") + message, flush=True)
    if not condition:
        sys.exit(1)


def main(video, work):
    work = Path(work)
    shutil.rmtree(work, ignore_errors=True)
    (work / "incoming").mkdir(parents=True)
    shutil.copy(video, work / "incoming" / "clip.mp4")
    from namma import backup, pipeline
    from namma.workspace import Workspace, read_json
    info = pipeline.prepare(work / "incoming" / "clip.mp4", work / "jobs", SETTINGS)
    job = info["job"]
    ws = Workspace(job)
    check(run_child(job, "priors") == 0, "frames, sfm, priors stages")
    fake_priors(job)
    ckpt = ws.train / "ckpt" / "step_000080.pt"
    check(run_child(job, "train", kill_when=ckpt.exists) == "killed", "training interrupted after its first checkpoint")
    check(run_child(job) == 0, "rerun resumes and finishes all stages")
    log = (ws.logs / "pipeline.log").read_text()
    check("Resumed training at step 80" in log, "training resumed from step 80")
    check("frames: already done" in log and "sfm: already done" in log, "finished stages skipped on rerun")

    download = next((ws.export / "DOWNLOAD_THIS").iterdir())
    archives = list(download.glob("*.zip")) or [download / json.loads(next(download.glob("*.parts.json")).read_text())["archive"]]
    with zipfile.ZipFile(archives[0]) as zf:
        names = set(zf.namelist())
        result = json.loads(zf.read("namma-result.json"))
        ply = zf.read("assets/room.ply")
        glb = zf.read("assets/room.glb")
    check({"namma-result.json", "cameras.json", "assets/room.ply", "assets/room.glb", "assets/views.json"} <= names, "archive layout")
    header = ply[: ply.index(b"end_header\n")].decode()
    count = int(header.split("element vertex ")[1].split()[0])
    check(header.count("property float") == 62 and len(ply) - len(header) - 11 == count * 62 * 4, f"PLY layout ({count} splats, 62 floats)")
    import hashlib
    check(result["artifacts"]["splat"]["sha256"] == hashlib.sha256(ply).hexdigest(), "splat sha256 in namma-result.json")
    check(result["artifacts"]["mesh"]["coordinateSpace"] == "raw-ply-v1", "mesh coordinate space")
    import trimesh
    mesh = trimesh.load(trimesh.util.wrap_as_stream(glb), file_type="glb", force="mesh")
    check(len(mesh.faces) == result["artifacts"]["mesh"]["triangleCount"] > 0, f"GLB loads ({len(mesh.faces)} triangles)")

    drive = work / "drive"
    check(backup.upload_loop(job, f"NammaSpaceBackups/{info['job_id']}", f"local:{drive}", once=True) == 0, "upload to local 'Drive'")
    verified = list(drive.rglob("VERIFIED.json"))
    check(len(verified) >= 7, f"{len(verified)} verified backup entries")

    fresh = work / "fresh"
    (fresh / "incoming").mkdir(parents=True)
    shutil.copy(video, fresh / "incoming" / "clip.mp4")
    info2 = pipeline.prepare(fresh / "incoming" / "clip.mp4", fresh / "jobs", SETTINGS)
    restored = backup.restore(info2["job"], f"NammaSpaceBackups/{info['job_id']}", f"local:{drive}")
    print(restored)
    check({"frames", "sfm", "priors", "train", "mesh", "export"} <= set(restored["restored"]), "restore brought every stage back")
    check(run_child(info2["job"]) == 0, "restored job reruns")
    log2 = (Workspace(info2["job"]).logs / "pipeline.log").read_text()
    check("train: already done" in log2 and "priors: repair mode" not in log2 or "train: already done" in log2,
          "training not repeated after restore")
    print("ALL LOCAL PIPELINE CHECKS PASSED")


if __name__ == "__main__":
    if sys.argv[1] == "--child":
        sys.exit(child(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""))
    main(sys.argv[1], sys.argv[2])
