# Lower Third (example) — transparent WebM overlay

A broadcast-style lower third rendered with a **real alpha channel**:
`project.json` sets `output.format: "webm"` and `output.transparent: true`,
so the deliverable drops onto any timeline as an overlay. Nothing in the
composition paints a background — unpainted pixels are alpha 0.

Demonstrates the Frame API (bundled at v1.3): `spring()` for the physical slide-in,
`Loop()` for the endlessly pulsing "live" dot, and `interpolateColors()` for
its red→amber blend — all pure functions of frame, so a parallel worker
starting mid-composition paints identical pixels to a serial render.

Rendered output is not committed (`out/` is git-ignored). The render below
goes through the lossless FFV1 parallel path; on the resulting
`out/lower-third.webm`, ffprobe reports `alpha_mode=1` and frame 60 decodes
to 85% fully-transparent pixels. To eyeball the alpha, composite a frame over
solid green. Note: play the .webm in a browser or mpv — some players ignore
VP9 alpha and show black instead of transparency.

```bash
cd ../../engine
node src/cli/render.js --project ../examples/lower-third \
  --output ../examples/lower-third/out/lower-third.webm --workers 3
```
