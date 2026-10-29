# Capture SOP

One continuous video per connected space, recorded at walking pace. No extra hardware is required; a
phone works, and a camera on a gimbal works better. Our Round 1 classroom was filmed on a DSLR on a gimbal
at 1/500 s, f/8, 1080p 50 fps, in 4 min 47 s.

## Camera settings

- Main 1x lens, landscape, standard video. Prefer **4K** (sharper training images); 1080p works.
- Fast shutter (1/250 s or faster) so frames are not motion-blurred; enough aperture depth (f/5.6–f/8) to keep
  near furniture and far walls in focus.
- Lock focus and, if possible, exposure and white balance. No zoom or lens switching while recording;
  portrait or cinematic effects off.
- Bright, steady light. Avoid shooting into backlit windows; keep doors, curtains and people still.

## Route

1. Start where a doorway, furniture and some floor are visible together.
2. Walk a slow loop around the room, aiming diagonally across it rather than straight at a nearby blank wall.
   Move your body; do not only rotate in place.
3. Keep part of the previous view in frame at all times. At corners take a small step and turn a little,
   several times, instead of one fast 90° pan.
4. Return to the start (this closes the loop), then cross through the walkable middle and show furniture from
   several sides.
5. Do one lower pass looking slightly down at the floor, furniture legs and door thresholds: the collision
   mesh for walking is built from these surfaces.
6. Tilt up gradually for upper walls and ceiling, then return to a familiar view.

## Before leaving

- Pause the video at a few corners: edges must not be smeared or doubled.
- Measure one clearly visible distance (a door height, a bench length) for the viewer's scale step.
- Copy the original file straight to Google Drive; messaging apps recompress video.

## What the pipeline checks

Frame selection keeps only sharp frames (relative to the surrounding second) and adds a frame whenever the
image has moved about 7% of its width. Camera posing stops with a report if fewer than 50% of frames can be
placed and warns below 90%; cameras placed far outside the room are detected and the slower, more accurate
mapper is used instead. Training reports held-out image quality and stops below 16 dB PSNR.
