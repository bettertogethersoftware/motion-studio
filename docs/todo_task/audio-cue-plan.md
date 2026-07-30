# Frame-granular audio cues — the two signals a composition cannot get

> **Status: PROPOSED. Nothing here has shipped.** Design record. This is the
> smallest of the open plans and the one with the highest ratio of value to work:
> both signals are already computed *somewhere* in the engine, at the wrong
> granularity or on the wrong path.
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

- [ ] `core/audio-cues.js` — STFT, spectral flux, local-median subtraction, peak-picking, per-frame RMS; all pure
- [ ] Per-frame linear `envelope[]` on `synthesize_speech`, `preview_audio`, `transcribe_asset`
- [ ] `onsetFrames[]` on the same three
- [ ] Word frames for generated speech, without a transcription round trip
- [ ] Test: recover known line starts from engine-generated multi-line narration, assert < 2 frames
- [ ] Docs: `mcp-setup.md`, `architecture.md` §9 (audio), `CHANGELOG.md`, both SKILL files
- [ ] Later, separately: expose `envelope[]` to compositions through the frame API

## Open questions — decide before implementing

1. **Response size.** A 5-minute film at 30 fps is 9000 envelope floats. Quantise to
   3 decimals, or downsample and let the composition interpolate?
2. **Does `onsetFrames` need strength?** A bare frame list cannot distinguish a
   stressed syllable from a soft one. `{frame, strength}` costs little and lets a
   caller threshold.
3. **Whose fps?** Speech tools are film-agnostic today. The cue arrays need one, so
   either the film's fps must be resolvable at call time or fps becomes a required
   argument.

## Deliberately out of scope

- Beat/tempo detection for music. Different problem, and `synthesize_music` already
  knows its own note table exactly — a film scored that way needs no analysis.
- Speaker diarisation.
- Phoneme-level timing or lip sync.
- Any cloud audio-analysis vendor.
