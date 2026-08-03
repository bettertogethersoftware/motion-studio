# Motion Studio — Production Lessons

Cross-machine lessons from full productions (two complete music videos — a
cyberpunk rap and a retro-gaming anthem — plus a portrait re-master), written
for the agent doing the next one. These are **workflow** lessons that span the
engine and the external helper tools; engine-authoring traps live in
[knowledge-base.md](knowledge-base.md), and each helper tool's own measured
failures live in the `README.md` beside that tool.

Helper tools referenced here (`videoforge`, `musicforge`, the ComfyUI music
helpers) are optional per machine — check the tools-root `MACHINE.md`
inventory before assuming one exists. The lessons about *measurement* hold
regardless of which tool does the measuring.

## The order of operations for a music-driven film

Both music videos converged on the same order. Follow it and most of the
expensive mistakes below cannot happen.

1. **Generate the song, then MEASURE it.** Tempo and phase from a beat-grid
   measurement (`videoforge\audiogrid.py grid` — its `holds` field must be
   true), section boundaries from an envelope pass, lyric timing from
   `transcribe_asset`. Every later number derives from these.
   **Do not use the BPM you asked for; use the BPM you got** — measured: a
   Stable Audio 3 drum loop requested at 140 BPM came back at 105, while an
   arp requested at 140 came back at 139.992.
2. **Cut the scene list on measured boundaries**, and check the durations sum
   to the film length exactly before authoring anything.
3. **Generate any layer tracks, then measure each one** before placement.
4. **Place cues by transient, set gain by measurement, then verify by lift**
   (the measured level difference the cue makes in the mix).
5. **`preview_audio` before rendering; verify the lift again on the final
   encoded file.**

## The traps, all measured

- **A beat is rarely an integer number of frames.** 150 BPM at 30 fps is
  exactly 12 — which is what makes the trap dangerous, because 140 BPM is
  12.857 and anything stepped by a constant slides a whole beat every ~7
  seconds. Use `MotionStudio.beatGrid()` (frame API v1.5); it derives from
  seconds.
- **A cue's transient is not at its file start.** Place by `peakAtSeconds`
  (`probe_asset { audioPeak: true }`, or `videoforge\cuekit.py measure`), or a
  riser peaks four seconds after the downbeat it was meant to hit. Measured
  transient offsets in one cue set: 0.00, 0.09, 0.87, 3.22, 4.31 s.
- **Gain by mean, then clamp by peak.** A sparse cue's mean is dragged down by
  its own decay; mean-targeting alone asked for **+5 dBFS** on one game-over
  sound. Neither statistic works alone.
- **`balanceWarnings` cannot adjudicate a one-shot.** It flagged an audible
  cue (+4.3 dB lift) and missed an inaudible one (+1.4 dB). Measure the lift
  and fix what *that* condemns — following the warnings blindly makes the mix
  worse.
- **Trim generated-audio padding before measuring a cue.** Stable Audio 3 pads
  to the requested duration, so a 0.3 s blip in a 4 s file has a mean ~14 dB
  below its own peak.
- **Blur or avoid generated words.** Every image model still garbles text. Do
  typography in the composition, or use the one image preset measured to
  render legible text (see the `comfyui` helper README).
- **Check the deliverable's own report, and check the checker.** `probe_asset`
  reported 30.001 fps on files that were exactly 30/1 (fixed 2026-08-03), and
  `transcribe_asset` returned a whole song as one 174 s "sentence" (also
  fixed). When a measurement contradicts something you can verify directly,
  verify it.

## Layering generated tracks: what actually works

Independently generated takes are complete mixes, not stems. What layers
safely, in order of confidence:

1. **Sustained, onset-free material** (pads, drones, atmospheres) — drift is
   inaudible. Put it low and `duck: true`.
2. **One-shots you place yourself** on the host track's measured grid. Exact
   by construction — and placed by the cue's *transient*, not its file start.
3. **A short rhythmic cell, re-anchored.** Drift accumulates, so what matters
   is drift over the span you use: a layer measuring 0.21 s of drift across
   140 s is unusable end-to-end but ~0.0006 s across one 4-bar cell. Cut the
   cell to an exact multiple of the HOST's bar, start it on a beat of the
   layer, and place every repeat on a measured downbeat of the host — never
   tile from wherever the file happens to begin.

What does not work: a second full groove running the length of the track.

For **instrumental** beds where sync matters, prefer a composed score with an
exported accent map (the `musicforge` helper) — the edit is laid against the
score itself and needs no tempo estimation at all. Use a generative music
helper when the track needs **vocals**, then measure the result.

FluidSynth for composed scores is vendored by Motion Studio at
`vendor\fluidsynth\bin\fluidsynth.exe` (repo root — the vendor tree moved out
of `engine\` in v0.25), with SoundFonts beside it; do not download another
copy. Render at `-g 0.42` for headroom and master the result in FFmpeg — the
raw SoundFont output is thin and clips.

## Restart the MCP server after changing the engine

The Motion Studio MCP server loads `engine/src` once at startup. Editing the
engine mid-session does **not** affect the running tools — a fix will look
inert, and you will "work around" a bug that is already fixed on disk. Either
restart the server, or call the engine module directly with `node` for
verification. Skills are copies too: after editing `docs/SKILL.md` or
`docs/SKILL-shell.md`, re-copy them to every client skill directory.
