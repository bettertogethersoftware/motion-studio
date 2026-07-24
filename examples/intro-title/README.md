# Intro Title (example)

A 1080p, 8-second title sequence (240 frames @ 30 fps → `mp4`). Demonstrates
the full Frame API: the `registerComposition` harness, multi-segment
`interpolate` with named easings, overlapping `Sequence` blocks (title →
subtitle crossfade → outro), a deterministic particle field via
`MotionStudio.random`, and the v1.1 primitives — `spring()` for the title
pop and `interpolateColors()` for the accent bar's warm→hot drift.

`out/intro-title.mp4` and `out/still-90.png` are **real rendered outputs**
(headless Chromium + FFmpeg, 3 parallel workers). Re-render with:

```bash
cd ../../engine
node src/cli/render.js --project ../examples/intro-title \
  --output ../examples/intro-title/out/intro-title.mp4 --workers 3
```
