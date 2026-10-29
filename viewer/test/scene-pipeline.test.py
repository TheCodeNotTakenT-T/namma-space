import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "viewer/scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pipeline = load("scene-pipeline")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "output").mkdir(exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="scene-test-", dir=ROOT / "output")).resolve()

    def tearDown(self):
        self.assertTrue(self.root.is_relative_to((ROOT / "output").resolve()))
        shutil.rmtree(self.root)

    def test_parts_join_and_corruption_rejection(self):
        pieces = [b"first", b"second"]
        records = []
        for index, data in enumerate(pieces):
            name = f"backup.part{index}"
            (self.root / name).write_bytes(data)
            records.append({"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        manifest = self.root / "backup.parts.json"
        manifest.write_text(json.dumps({"archive": "backup.zip",
            "sha256": hashlib.sha256(b"".join(pieces)).hexdigest(), "parts": records}))
        joined = pipeline.join_parts(manifest, self.root / "good")
        self.assertEqual(joined.read_bytes(), b"firstsecond")
        (self.root / records[1]["name"]).write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "changed part"):
            pipeline.join_parts(manifest, self.root / "bad")

    def test_archive_traversal_rejected_before_extraction(self):
        archive = self.root / "bad.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("../outside.txt", "no")
        with self.assertRaises(ValueError):
            pipeline.extract_archive(archive, self.root / "extracted")
        self.assertFalse((self.root / "outside.txt").exists())

    def test_wrong_model_is_never_registered(self):
        previous = pipeline.ROOT
        pipeline.ROOT = self.root
        try:
            archive = self.root / "geometry.zip"
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("recovery-report.json", json.dumps({"sourceModelSha256": "0" * 64}))
                z.writestr("room-collision-candidate.ply", "not used")
            model = self.root / "model.ply"
            model.write_bytes(b"wrong model")
            with self.assertRaisesRegex(ValueError, "different trained PLY"):
                pipeline.import_scene(archive, model)
            self.assertFalse((self.root / "data/scene-library").exists())
        finally:
            pipeline.ROOT = previous


if __name__ == "__main__":
    unittest.main()
