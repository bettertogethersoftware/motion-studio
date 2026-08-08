# `measure_reframe` — aspect variants that follow the subject

> **Status: PROPOSED. Nothing here has shipped.** Design record, in the shape of
> the completed plans (summarized in [completed.md](completed.md); full records
> in git history). It is the hard half of the
> **aspect deliverable variants** item in
> [production-workflow-backlog.md](production-workflow-backlog.md).
>
> Prototyped end to end against `data/temp/source-interview.mp4` — a real
> 1920×1080/60 two-shot, 956 frames — and reframed to 9:16. Findings from that run
> are marked **[measured]**.

## What it does in each environment

| | Value |
|---|---|
| **Env A** (MCP only) | **Essential.** `transcode_asset` can crop, but its `crop` is a *constant*. There is no way to express "the window moves," so the only vertical variant Env A can produce is a fixed centre crop — which on a two-shot frames the gap between two people. |
| **Env B** (+ shell) | **Wants the measurement, not the pixels.** ffmpeg will always crop better than a wrapper, but ffmpeg has no opinion about *where*. `cropdetect` finds bars, not subjects. The crop path is the part Env B cannot get from its own tools. |

This one splits cleanly along the [rule](README.md#the-rule-this-implies), so it
should ship as two things rather than one:

- **`measure_reframe` returns a path** — knowledge. Both environments want it, Env B
  arguably more, because Env B is the one hand-writing an ffmpeg command against a
  question it cannot answer.
- **`transcode_asset` gains a time-varying crop** — capability. Only Env A is blocked
  without it.

**Both halves are in scope (re-evaluated 2026-08-08).** Under
[TODO.md](TODO.md)'s standing rule — Env B is the main focus, Env A is the demo
tier, and a cheap Env A win still gets done — the capability half passes on
price rather than on audience. The expensive, judgement-carrying work is the
measurement (sampling, letterbox detection, column scoring, the DP), and both
halves consume it. Once a validated path exists, applying it is generating a
`sendcmd` script and splicing one filter — small, and the engine has to own the
generation anyway, because §9.4 forbids the caller supplying ffmpeg arguments.
If the crop half ever stops being small, it is the half to drop: Env B applies
the path itself, and the path is the part it cannot compute.

## Why

Centre-cropping 16:9 to 9:16 discards 68% of the width, and on real footage the
subject is not in the middle. **[measured]** On the prototype clip a fixed centre
crop frames the table between the two speakers for the entire 16 seconds.

The naive fix is worse than the problem. Choosing the best window independently
per frame is *correct on every frame* and unwatchable across them:

> **[measured]** Per-frame argmax jumps more than 100 px on **349 of 955 frame
> pairs** — it strobes between the two speakers several times a second.

That number is the whole reason this is a plan and not a filter option.

## Design sketch

Four stages. Only the third and fourth carry any judgement.

### 1. Sample — reuse what render-review already does

[render-review.js](../../engine/src/core/render-review.js) already decodes a file
to 64×36 greyscale through `ffmpeg -f rawvideo` and does the arithmetic on plain
Buffers in Node. Reframe needs the same pipeline at a slightly higher width and
at full frame rate rather than `fps=1`. **No new dependency, and no Python:** the
whole analysis is sums and comparisons over a `Uint8Array`.

**[measured]** 192×108 was ample — about 1/100th of the pixels. The prototype
never decoded a full-resolution frame.

### 2. Letterbox — find the active picture before framing anything

**[measured]** The prototype source is letterboxed: the real picture occupies rows
**190–890** of 1080. Framing without this test puts grey bars in the deliverable
and computes the crop height from padding.

A row is a bar when it is flat across its width **and** still over time. Both
tests are needed, and this is worth stating because either alone is wrong: a clean
wall is flat but moving; a locked-off background is still but textured. Only the
conjunction is a bar.

### 3. Score — where the picture is busy

Per column, per frame: temporal motion (frame difference) plus spatial detail
(gradient magnitude), weighted toward the upper rows, where faces are in a seated
shot and where a table is not. Motion is weighted ~3× detail — a speaking face
beats a static poster.

This stage deliberately does **not** detect faces. A face detector is a model
download, a licence, and a per-frame cost, and it answers a narrower question than
"what is happening." Revisit only if a real job fails on it.

### 4. Path — a min-cost path, not an argmax

The framing is chosen by dynamic programming over candidate window centres:
each frame pays `−interest`, each pixel of camera movement pays a fixed price.
Because the movement penalty is L1, each frame is an O(states) distance transform
rather than O(states²), so the solve is linear in frames.

**[measured]** With movement priced at 0.006/px: **1167 px of total travel across
16 s, peak 2.6 px/frame, 545 crop commands** — against 349 strobe jumps for the
argmax. The path holds on one speaker and commits to the other only when the other
is persistently better.

Two implementation notes that cost the prototype real time:

- **Normalise per frame with min–max, not divide-by-peak.** What the DP trades
  against movement is the *spread* between candidate framings. Dividing by the peak
  leaves that spread arbitrarily small, no move is ever worth paying for, and the
  path freezes at one x for the entire clip. That was the first result.
- **Price movement by sweeping, not by taste.** **[measured]** 0.0005 → 57 moves;
  0.01 → 22 moves. The default belongs in the response so a caller can see it.

### The output is a path, and the engine turns it into pixels

`measure_reframe` returns `{ cropWidth, cropHeight, cropY, path: [x per frame] }`
plus the letterbox it found and the parameters it used. `transcode_asset` then
accepts that path as a time-varying crop and generates the ffmpeg `sendcmd` script
itself — for the same reason `matchFilm` splices the film's own `ffmpegArgs`
rather than making the caller reproduce them.

## Rules it must obey

1. **Report by measuring.** Return the letterbox actually detected and the travel
   actually produced, not the request echoed back.
2. **No arbitrary ffmpeg arguments**, per [architecture.md §9.4](../architecture.md).
   The `sendcmd` script is generated from a validated path, never supplied.
3. **Scoring and the DP are pure functions**, unit-testable with no ffmpeg present —
   the same shape as `buildVideoFilter` and `buildSpanGraph`.
4. **A path is data.** It must be returnable, inspectable, and overridable; an agent
   that disagrees with the framing needs to be able to hand back its own.
5. **Deterministic.** Same input plus same parameters yields the same path, so a
   re-render is not a re-edit.

## TODO

- [ ] `core/reframe.js` — sampling, letterbox detection, column scoring, DP, all pure
- [ ] `measure_reframe` MCP tool returning the path plus what it measured
- [ ] `transcode_asset`: time-varying crop from a supplied path, `sendcmd` generated engine-side
- [ ] Tests: scoring and DP against synthetic column data, no ffmpeg; letterbox against a generated bar pattern
- [ ] Docs: `mcp-setup.md`, `architecture.md` §9.4, `CHANGELOG.md`, both SKILL files
- [ ] Acceptance: produce the 9:16 variant of a real film without a shell

## Known limitation, stated up front

**[measured]** The prototype's lower-third name graphics are sliced mid-word —
"taru Takagi", "Mika Kana". They are authored for 16:9 and **no crop path saves
them.** A vertical deliverable that keeps burned-in graphics is wrong regardless of
how good the framing is; the answer is to suppress the source graphic and re-render
titles as a composition overlay, which is a film-timeline job, not this tool's.

Worth saying plainly because it bounds the feature: auto-reframe produces a good
*camera*, not a good *deliverable*, whenever the source has burned-in text.

Also: a letterboxed source has less height than the target, so every vertical
variant upscales (2.7× on the prototype). That is a property of the source, and the
response should report the scale factor rather than hide it.

## Open questions — decide before implementing

1. **Does the path belong on the film, or only on the tool call?** An aspect variant
   that is re-derived on every build is not reproducible; one stored in the film doc
   is another thing the visual editor can silently rewrite.
2. **Is `cropY` allowed to move too?** The prototype fixes it to the letterbox. Vertical
   movement matters for a standing subject and doubles the state space.
3. **Should scoring accept an audio hint?** On a two-shot the strongest cue for "who
   matters" is who is speaking, and `transcribe_asset` already knows word frames. That
   is a much cheaper speaker cue than any vision model — but it couples two subsystems,
   so it should be a second version, not the first.
4. **One `every`-frame path, or keyframes?** 545 commands for 16 s is fine; a 10-minute
   source is ~20k. Consider emitting keyframes with linear interpolation.

## Deliberately out of scope

- Face or person detection models.
- Rotation, stabilisation, or perspective correction.
- Re-timing. This moves a window; it never changes frame count.
- Choosing the aspect ratio. The caller states the target.
