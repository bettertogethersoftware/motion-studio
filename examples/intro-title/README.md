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

## Narration (v0.6, Windows text-to-speech)

This example also demonstrates the `synthesize_speech` tool. `assets/narration.wav`
was generated from text by the Windows TTS engine and attached to `project.json`
as an `audio` track — a subsequent render mixes it into the video automatically.

An agent does this with one MCP call:

```
synthesize_speech {
  projectId: "<this project>",
  text: "Motion Studio. Deterministic video, rendered entirely from code.",
  mode: "attach",          // writes assets/narration.wav AND adds the audio track
  startInFrames: 24
}
→ { durationSeconds: 5.9, durationInFrames: 178, ... }   // size a Sequence() to this
```

To reproduce the asset + config locally (needs the TTS exe — see
[docs/tts-setup.md](../../docs/tts-setup.md)):

```bash
node add-narration.mjs
```

The narration is `startInFrames: 24` (~0.8 s in) and runs ~5.9 s, comfortably
inside the 8 s title. Requires an mp4/webm/prores output (gif and png-sequence
carry no audio).
