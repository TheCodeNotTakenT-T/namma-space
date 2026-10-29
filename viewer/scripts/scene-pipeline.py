"""Reusable local result import, backup verification and scene-library registration."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            h.update(block)
    return h.hexdigest()


def scene_up(cameras):
    """The room's up direction: the mean of every training camera's up (-Y of its camera-to-world rotation).
    One camera's up is tilted wherever that frame was; the mean over a walkthrough is level."""
    total = [0.0, 0.0, 0.0]
    for camera in cameras:
        rotation = camera.get("rotation")
        if not (isinstance(rotation, list) and len(rotation) == 3 and all(isinstance(r, list) and len(r) == 3 for r in rotation)):
            continue
        for i in range(3):
            total[i] -= float(rotation[i][1])
    length = sum(v * v for v in total) ** 0.5
    return [v / length for v in total] if length > 1e-9 else None


def safe_name(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Invalid archive filename")
    parts = name.split("/")
    if name.startswith("/") or any(p in ("", ".", "..") or p.endswith((".", " ")) for p in parts):
        raise ValueError("Unsafe archive filename: " + name)
    if any(re.match(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", p, re.I) for p in parts):
        raise ValueError("Reserved filename")
    return name


def join_parts(manifest, output):
    manifest = Path(manifest)
    record = json.loads(manifest.read_text(encoding="utf-8"))
    name = safe_name(record["archive"])
    if "/" in name:
        raise ValueError("Archive must use a plain filename")
    parts = record["parts"]
    if not isinstance(parts, list) or not 1 <= len(parts) <= 500:
        raise ValueError("Invalid part count")
    seen = set()
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    target = output / name
    with target.open("xb") as destination:
        for part in parts:
            part_name = safe_name(part["name"])
            if "/" in part_name or part_name in seen:
                raise ValueError("Invalid or duplicate part name")
            seen.add(part_name)
            source = manifest.parent / part_name
            if not source.exists() and (manifest.parent / (part_name + ".zip")).exists():
                source = manifest.parent / (part_name + ".zip")  # Google Drive folder downloads rename ZIP-looking parts
            if source.stat().st_size != part["bytes"] or sha(source) != part["sha256"]:
                raise ValueError("Missing, truncated or changed part: " + part_name)
            with source.open("rb") as stream:
                shutil.copyfileobj(stream, destination, 8 * 1024**2)
            print("Verified", part_name, flush=True)
    if sha(target) != record["sha256"]:
        raise ValueError("Joined archive checksum mismatch")
    shutil.copy2(manifest, output / manifest.name)
    return target


def extract_archive(source, target):
    target = Path(target)
    with zipfile.ZipFile(source) as z:
        entries = z.infolist()
        if len(entries) > 10000 or sum(i.file_size for i in entries) > 16 * 1024**3:
            raise ValueError("Archive exceeds import limits")
        seen = set()
        for entry in entries:
            name = safe_name(entry.filename.rstrip("/"))
            key = name.casefold()
            if key in seen:
                raise ValueError("Duplicate archive filename")
            seen.add(key)
            if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Archive links are not allowed")
        if z.testzip() is not None:
            raise ValueError("Damaged archive")
        z.extractall(target)


def import_scene(geometry, model=None, backup=None, title="Imported room"):
    identity = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    job = ROOT / "data/scene-imports" / identity
    scene = ROOT / "data/scene-library" / identity
    job.mkdir(parents=True)
    state = {"status": "verifying", "title": title, "id": identity}
    def save():
        (job / "status.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    save()
    try:
        geometry = Path(geometry).resolve(strict=True)
        if geometry.name.endswith(".parts.json"):
            archive = join_parts(geometry, job / "downloads")
        else:
            archive = job / "geometry-source.zip"
            shutil.copy2(geometry, archive)
        extracted = job / "source"
        extract_archive(archive, extracted)
        standard = extracted / "namma-result.json"
        if standard.is_file():
            report = json.loads(standard.read_text())
            def artifact(kind):
                item = report["artifacts"][kind]
                p = extracted / safe_name(item["path"])
                if sha(p) != item["sha256"]:
                    raise ValueError("Changed " + kind + " artifact")
                return p
            model = artifact("splat")
            mesh = artifact("mesh")
            if report["artifacts"]["mesh"].get("coordinateSpace") != "raw-ply-v1":
                raise ValueError("Unsupported mesh coordinate convention")
            source_hash = sha(model)
        else:
            report = json.loads((extracted / "recovery-report.json").read_text())
            if model is None:
                raise ValueError("Select the matching trained Gaussian PLY for this recovery archive.")
            model = Path(model).resolve(strict=True)
            source_hash = sha(model)
            if source_hash != report["sourceModelSha256"]:
                raise ValueError("This geometry belongs to a different trained PLY. Nothing was registered.")
            candidates = list(extracted.glob("*-collision-candidate.ply"))
            if len(candidates) != 1:
                raise ValueError("Expected one collision candidate in recovery ZIP")
            mesh = candidates[0]
        if backup:
            joined = join_parts(backup, job / "depth-backup")
            with zipfile.ZipFile(joined) as z:
                if z.testzip() is not None:
                    raise ValueError("Depth backup ZIP is damaged")
                metadata = json.loads(z.read("recovery-report.json"))
                if metadata["sourceModelSha256"] != source_hash:
                    raise ValueError("Depth backup belongs to another model")
            state["depthBackup"] = str(joined)
        saved_model = job / "trained-model.ply"
        shutil.copy2(model, saved_model)
        if sha(saved_model) != source_hash:
            raise ValueError("Model copy checksum mismatch")
        state["status"] = "converting"
        save()
        scene.mkdir(parents=True)
        command = [shutil.which("node") or "node", str(ROOT / "viewer/scripts/scene-assets.mjs"),
                   str(saved_model), str(mesh), str(scene)]
        with (job / "conversion.log").open("w", encoding="utf-8") as log:
            subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        assets = json.loads((scene / "asset-report.json").read_text())
        record = {
            "version": 1, "type": "namma-viewer-scene", "id": identity, "title": title,
            "sourceModelSha256": source_hash, "coordinateSpace": "raw-ply-v1",
            "splat": {"file": "preview.spz", "sha256": sha(scene / "preview.spz"),
                      "bytes": (scene / "preview.spz").stat().st_size},
            "collision": {"file": "collision.glb", "sha256": sha(scene / "collision.glb"),
                          "triangles": assets["triangleCount"], "kind": "reconstructed-surface"},
            "scaleCalibrated": False, "walkingValidated": False,
            "provenance": {"sourceArchiveSha256": sha(archive), "report": report},
        }
        cameras_file = extracted / "cameras.json"
        if cameras_file.is_file():
            cameras = json.loads(cameras_file.read_text())
            if cameras:
                # Saved PlanarGS camera-to-world pose, used only for framing.
                camera = cameras[0]
                record["initialView"] = {key: camera[key] for key in
                                         ("position", "rotation", "height", "fy")}
                up = scene_up(cameras)
                if up:
                    record["initialView"]["up"] = up
        # Written last: unfinished conversions never appear in the scene library.
        (scene / "scene.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        state.update(status="ready", scene=str(scene),
                     url="http://127.0.0.1:5174/aholo/?scene=" + identity)
        save()
        print("READY:", state["url"], "\nPreserved inputs and backup:", job, flush=True)
        return state
    except Exception as error:
        state.update(status="failed", error=str(error))
        save()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geometry", type=Path, required=True)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--title", default="Imported room")
    args = parser.parse_args()
    import_scene(args.geometry, args.model, args.backup, args.title)


if __name__ == "__main__":
    main()
