# Sample data

`classroom_30s.mp4`: the first 30 seconds of our Round 1 capture (NIT Goa classroom, DSLR on a gimbal,
1/500 s, f/8, 1920×1080), re-encoded to H.264 without audio (18 MB).

To reconstruct it, upload the file to your Google Drive (for example `NammaSpace/classroom_30s.mp4`), open the
Molab notebook as described in the main README, enter that path in **Video** and click **Start**. The smoke test
reconstructs the first 20 seconds with small settings; the full job then reconstructs the whole clip. A 30-second
clip covers only one corner of the room; the full 4 min 47 s video produced the published classroom.

For a local check of the pipeline's plumbing without a GPU (stand-in renderer, not gsplat):

```bash
python tests/run_local_pipeline.py tests/sample/classroom_30s.mp4 /tmp/namma-test
```
