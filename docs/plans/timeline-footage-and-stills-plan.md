# Trimming footage, and putting a still on the timeline

> **Status: PROPOSED 2026-08-08.** Both features approved from use ("we can
> resize audio both ways but we cannot resize footage", "we should allow import
> images as well like `+ image`"). Written before implementation because the
> first one carries a decision — frame-exactness versus the lossless concat —
> that must be made deliberately rather than discovered halfway through a build
> path. Estimate: 1–2 days each, independent of one another.

## 1. What is true today

| | audio track | footage segment |
|---|---|---|
| in-point into the source | `trimStartInFrames` (U-15) | **none** |
| out-point | `trimEndInFrames` (U-15) | **none** |
| length on the timeline | derived from the trims | `durationInFrames`, declared and probe-verified |
| trimmable in the Studio | yes, both edges | no |

`checkFootage` ([films.js:157](../../engine/src/core/films.js:157)) accepts
`footage`, `durationInFrames`, `label`, `sequence`, `id` and `derivedFrom` —
there is no in-point anywhere in the schema. A footage segment therefore always
plays its file from frame 0 for the number of frames its slot declares, and a
slot longer than the clip holds the last frame (which the player now says out
loud, v0.27).

Stills have no place in the play order at all. `+ overlay` already accepts an
image and is the right tool for a logo or a lower third, but an overlay is
*over* something — there is no way to say "this picture is the frame, for four
seconds".

## 2. The decision that governs the footage half

A film assembles by **lossless concat**: `-f concat -c copy`
([encoder.js:214](../../engine/src/core/encoder.js:214)). Nothing is
re-encoded unless the finishing pass has overlays or burnt captions.

The concat demuxer supports `inpoint`/`outpoint`, so a trim looks free. **It is
not, and this is the trap:** with `-c copy` those directives seek to the nearest
**keyframe**. A 240-frame trim would deliver whatever the GOP boundary allows —
and this engine derives every later offset from `durationInFrames`, verifies the
delivered frame count at promotion (`verifyFrameCount`), and refuses to assemble
a scene whose settings changed. A keyframe-snapped trim breaks that invariant
silently, in the one place the engine promises exactness.

Three honest ways out:

| | how | cost |
|---|---|---|
| **A. Pre-trim to a frame-exact intermediate** | a trimmed segment is cut into `out/.staging/` with `-ss`/`-frames:v` at the film's encode voice, and the concat consumes that | one re-encode per trimmed segment per build; the concat stays lossless for everything else. **Recommended** |
| **B. `inpoint`/`outpoint` with `-c copy`** | one line in the concat list | free, and wrong: keyframe-snapped, so the frame count is not what the timeline says. Only acceptable if the trim is *advisory*, which it is not |
| **C. Re-run `transcode_asset`** | the drag edits the transcode's `trim`, which is already frame-exact, and the segment points at the new file | no build-path change at all, and provenance stays truthful (`derivedFrom` already records the transcode) — but a re-encode of the whole clip on every drag, and it mutates an asset other segments may share |

**Take A.** It confines the cost to the segments that are actually trimmed,
keeps the lossless path for the common case, and reuses the staging discipline
P0-1 already built. State the re-encode in the build result the way the
deliverable re-encode is stated, so it is visible rather than inferred from a
timing difference.

## 3. Schema: one length field, not two

Audio derives its length from `trimStart`/`trimEnd` because an audio track has
no slot. **Footage has a slot**, and `durationInFrames` is load-bearing:
`planFilm` resolves every later offset from it and probes the file against it.

So footage gains **`trimStartInFrames` only**:

- `trimStartInFrames` — the in-point, a source-frame offset at the film's fps.
- `durationInFrames` — unchanged in meaning: how many frames this segment
  occupies. The segment plays source frames `[trimStart, trimStart + duration)`.

Dragging the **left** edge raises `trimStartInFrames` and lowers
`durationInFrames` by the same amount; dragging the **right** edge changes
`durationInFrames` alone. Both edges move, and there is still exactly one length
in the document.

Adding `trimEndInFrames` to match audio's spelling would create a second way to
express the same length and a rule about which wins — the kind of ambiguity this
backlog has retired before. Record the asymmetry in `film-setup.md` so it reads
as a decision rather than an oversight.

**Validation** (`checkFootage`): non-negative integer; `trimStart + duration`
must not exceed the probed frame count, which `planFootage` already reads —
that check is the whole reason the trim can be trusted, and it belongs beside
the existing `footage_duration_mismatch`.

## 4. The stills half

A third segment kind in the play order, beside `{slug}` and `{footage}`:

```json
{ "image": "assets/plate.png", "durationInFrames": 120, "label": "…" }
```

- `planFilm` treats it like footage for layout: it occupies frames and carries
  a `sequence` label and an `id`.
- The build turns it into a segment with `-loop 1 -t <duration>` at the film's
  encode voice — a re-encode by construction, since a PNG is not a video
  stream. Same staging path as A above, so the two features share it.
- `probe_asset`'s picture facts (v0.27) already answer whether the image
  matches the film's geometry; a mismatch is a plan-time warning, not a refusal
  — letterboxing a 4:3 still into a 16:9 film is a legitimate choice.
- **Not** a scene. A scene is a folder with a composition; this is a file with
  a duration. An author who wants the still to *move* (a push-in, text over it)
  wants `sceneFromFootage`'s equivalent for images, which is a separate item
  and should stay separate.

`isFootageSegment` in `core/films.js` is the shape to copy — and the reason
BUG-2 existed (a segment kind the walk did not know about was described as a
scene called `undefined`), so every place that asks "is this a scene?" has to
learn the third answer at the same time. That is the main risk in this half and
it is a search, not a design problem.

## 5. Order and acceptance

1. **Footage trim, engine** — schema, validation against the probe, the
   pre-trim intermediate, the build result reporting it. Acceptance: a film
   with one trimmed segment builds to a frame count that equals the timeline's,
   proven by `ffprobe`, and an untrimmed film still takes the lossless path
   (assert no re-encode).
2. **Footage trim, Studio** — drag handles on footage blocks, reusing the audio
   block's grip grammar so both lanes trim the same way.
3. **Stills** — the segment kind, then `+ image` beside `+ footage`.

## 6. Deliberately out of scope

- Transitions between segments — that is P1-3, still held.
- A Ken Burns move on a still: that is a composition, and the answer is a scene.
- Trimming a *scene* segment. A scene's length is its own config, and two
  places to set it is the ambiguity §3 exists to avoid.
