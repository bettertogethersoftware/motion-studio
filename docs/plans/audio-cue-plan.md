# Frame-granular audio cues — the two signals a composition cannot get

> **Status: IN PROGRESS — the detector and the two engine-owned surfaces
> shipped 2026-08-08.** `core/audio-cues.js` plus `cues` on
> `synthesize_speech` and `preview_audio`, with the three open questions
> below decided and the detector verified against real narration. Remaining:
> `onsetFrames` on `transcribe_asset`, word frames for generated speech, and
> the frame-API exposure (see the TODO). This is the smallest of the open
> plans and the one with the highest ratio of value to work: both signals are
> already computed *somewhere* in the engine, at the wrong granularity or on
> the wrong path.
>
> Found by building a 15 s narrated spot and then measuring the result — the same
> method that produced plans 4 and 5. Findings marked **[measured]**.

## What already exists — read this before scoping

This plan is an extension, not an invention. Three things are already true:

| Already shipped | Where |
|---|---|
| Per-**word** frames from recorded speech, with `wordsMatching` to find the frame a given name is spoken on | `transcribe_asset` ([transcribe.js](../../engine/src/core/transcribe.js)) |
| Sub-word token merging, by the vendor's leading-space rule | `flattenWords` in the same module |
| A per-**second** RMS envelope in dB, plus `silentTailSeconds` | `measureWavEnvelope` in [tts.js](../../engine/src/core/tts.js), surfaced as `mix.envelopeDb` on `preview_audio` |

So word cueing is well served, and an envelope exists. What is missing is narrow
and specific.

## What is missing

**1. The envelope is per-second, in dB, on the QA path.**
`measureWavEnvelope` answers "did the mix go silent" — its bucket is one second and
its consumer is a warning. An animation needs a *per-frame* linear value it can
multiply a scale, radius, or opacity by. At 30 fps a one-second bucket is 30 frames
of the same number, which is not an envelope, it is a bar chart.

**2. There is no onset signal at all.** Nothing in the engine measures where the
voice *pushes*. Grepping for onsets finds only `captionOnset` in
[render-review.js](../../engine/src/core/render-review.js), which is a caption's
start frame — a different meaning. Emphasis is not the same as a word boundary: the
stressed syllable inside a word is where a cut or a pop belongs, and it is
recoverable from spectral flux with no model and no vendor.

**3. Generated narration knows less about itself than recorded narration does.**
`synthesize_speech` timings are sentence-granular by construction — [tts.js:227](../../engine/src/core/tts.js)
says so outright. The engine *generated* the audio, one clip per sentence, and still
cannot say which frame the word "systolic" lands on without sending its own output
back through `transcribe_asset`. That round trip is a whisper model, a decode, and
an approximation of a fact the synthesizer had exactly.

## Why it matters — a measured defect, not a hypothetical

A 15 s spot was built with hand-typed animation timings that looked fine on
playback. Measuring the finished voiceover afterwards:

| Element | Hand-typed frame | Frame the word is actually spoken |
|---|---|---|
| SYS stat card | 80 | **125** ("systolic") |
| DIA stat card | 90 | **152** ("diastolic") |
| PUL stat card | 101 | **181** ("pulse") |

**[measured]** Every stat card was fully on screen **1.5–2.7 seconds before the
voice named it.** Nothing in the pipeline could have caught this: the render is
correct, the mix is correct, `render-review` sees a picture that changes and audio
that never clips. It is a *sync* defect, and sync is precisely what neither half
can see alone.

This is the same failure shape as a track whose gain encodes a template rather than
a measurement — it passes every automated check and is wrong.

## The signals, and how they are verified

### Per-frame envelope

RMS per frame bucket, linear, alongside the existing dB form. Cheap: it is the same
pass `measureWavEnvelope` already makes, with the bucket set to `sampleRate / fps`
instead of `sampleRate`.

### Onset frames

Spectral flux over a short-time Fourier transform, minus a local median so a loud
passage does not out-vote a quiet one, then peak-picked with a refractory gap so one
syllable yields one onset.

**This is the part that must be verified rather than trusted**, and there is a free
ground truth for it: narration the engine synthesized itself is assembled from
per-line clips, so the true line starts are known exactly.

> **[measured]** The prototype detector recovered all five line starts of a
> five-line voiceover to within **64 ms worst case — 1.9 frames at 30 fps**, most
> within 30 ms.

That test belongs in the suite, built from generated speech, with no vendor needed.

### Word frames for generated speech

`synthesize_speech` synthesizes per sentence already. Per-word frames for vendors
that can report them, and otherwise onset-aligned word boundaries within the
sentence the engine already timed — either beats a whisper round trip on audio the
engine wrote itself.

## Where the signals go

Onto the response of the tool that already produces the audio, not a new tool:

- `synthesize_speech` → `envelope[]` (per frame, linear), `onsetFrames[]`, `words[]`
- `preview_audio` → the same `envelope[]`, alongside today's per-second `envelopeDb`
- `transcribe_asset` → `onsetFrames[]` beside the existing `words[]`

A fourth surface is worth considering and is the real prize: a composition that can
**read** `envelope[]` through the frame API drives a scale or a glow from the voice
directly, rather than an agent baking numbers into source. That is a
[frame-api.md](../frame-api.md) change, and it should be a second step — the signals
are useful the moment they are returned.

## Rules it must obey

1. **Frames, not seconds.** Every returned cue is a frame index at the target fps —
   the invariant `transcode_asset` already states.
2. **Verify the detector against generated speech** in the test suite. A cue
   detector that is 3 frames off produces work that looks right and is wrong.
3. **Never invent a word.** The existing per-word confidence discipline in
   `transcribe.js` carries over unchanged.
4. **Additive.** `envelopeDb` keeps its per-second meaning; the new field is new.
5. **Pure and testable.** Flux, median subtraction and peak-picking take an array
   and return an array — no ffmpeg, no vendor.

## TODO

- [x] `core/audio-cues.js` — STFT, spectral flux, local-median subtraction, peak-picking, per-frame RMS; all pure (2026-08-08)
- [x] Per-frame linear `envelope[]` on `synthesize_speech`, `preview_audio` (2026-08-08; `transcribe_asset` deliberately excluded — see the decisions below)
- [x] `onsetFrames[]` on the same two (2026-08-08)
- [ ] `onsetFrames[]` on `transcribe_asset` — fits its cache cleanly (onsets are fps-independent in seconds; `withFrames` frames them at read time, exactly as `words[]` already works)
- [ ] Word frames for generated speech, without a transcription round trip
- [x] Test: recover known line starts from engine-generated multi-line narration, assert < 2 frames (2026-08-08, `engine/test/audio-cues.test.js`, 13 tests)
- [x] Docs: `mcp-setup.md`, `architecture.md` §9.6, `CHANGELOG.md`, both SKILL files (2026-08-08 — the SKILL copies in each client's skill directory need re-copying, per the deploy guide)
- [ ] Later, separately: expose `envelope[]` to compositions through the frame API

## Open questions — DECIDED 2026-08-08

1. **Response size.** *Neither quantise-and-always-send nor downsample:* the
   per-frame envelope is **opt-in** (`cues: "full"`), and the default summary
   carries the count, `onsetFrames`, and `envelopePeak`. 9,000 floats in a
   default read is exactly what the token-efficient program (v0.26) spent a
   whole slice removing, and this plan predates it. Values are rounded to 4
   decimals; the inline cue list is capped at 400 frames and **says so** when
   the cap bites, rather than trimming quietly.
2. **Does `onsetFrames` need strength?** Yes, and it is computed — but it lives
   in `onsets: [{frame, seconds, strength}]` under `cues: "full"`, while the
   summary returns a bare `onsetFrames: [int]`. A caller that wants to
   threshold asks for it; the cheap shape stays cheap. Strength turned out to
   carry real information: the one line the detector places late is also the
   one with a weak peak, so a caller *can* tell a soft onset from a crisp one.
3. **Whose fps?** Already answered by the tree — no new argument. All three
   tools are target-addressed and resolve `t.fps` today
   (`transcribe_asset` even takes an explicit `fps` override with the target's
   as its default). The plan's worry about "film-agnostic speech tools" does
   not survive contact with the code.

### Decided while building

4. **`transcribe_asset` gets onsets, not the envelope.** Onsets are
   fps-independent in seconds, so they cache the way `words[]` already does and
   `withFrames` frames them at read time. A per-frame envelope is
   fps-*dependent*, so caching it means caching per-fps or recomputing over a
   possibly hour-long file on every call. For a supplied recording the honest
   place to get an envelope is `preview_audio`, once the asset is on a timeline.
5. **No sidecar file.** An `<asset>.cues.json` was considered (the
   `transcode.json` precedent) and rejected for now: its one real advantage is
   letting a *composition* fetch cues at render time, and that is the frame-API
   step this plan already defers. Adding files, staleness rules and cleanup for
   a consumer that does not exist yet is cost without a payer.

## What the measurement corrected

Two findings from verifying rather than trusting the detector, both of which
would otherwise have shipped silently:

- **Windows must be centred on their hop.** Windows that *start* at their hop
  report every cue early by most of a window, and make a line beginning at
  frame 0 undetectable — the first window has no predecessor to be an increase
  over. **[measured]** Bias against a known attack: −10 ms for an instant
  attack, and about half the attack ramp as the attack softens (0/5/20/40 ms
  ramps → −10/0/+10/+20 ms). That is the perceptual answer, so it is pinned by
  a test rather than corrected.
- **The prototype's "64 ms worst case" needs its ground truth restated.**
  Against real Windows-TTS narration the cues first measured 170–300 ms late on
  *every* line. They were not late: the vendor pads each clip with ~112–145 ms
  of silence, so `concatWavBuffers`' segment starts are **clip** boundaries,
  not **voice** onsets. Against where the voice actually starts: **[measured]**
  four of five lines within 1–2 frames at 30 fps (34–68 ms). The fifth,
  "Your pulse…", is 165 ms — a soft `/j/` glide whose strongest attack really
  is five frames in, and whose cue strength (0.31) is correspondingly low. A
  detector that finds *attacks* will always place a gradual onset later than a
  boundary-finder would; that is a limit to state, not to tune away.

## Deliberately out of scope

- Beat/tempo detection for music. Different problem, and `synthesize_music` already
  knows its own note table exactly — a film scored that way needs no analysis.
- Speaker diarisation.
- Phoneme-level timing or lip sync.
- Any cloud audio-analysis vendor.
