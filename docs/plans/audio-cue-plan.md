# Frame-granular audio cues — the two signals a composition cannot get

> **Status: IN PROGRESS — the detector and all three surfaces shipped
> 2026-08-08.** `core/audio-cues.js`, `cues` on `synthesize_speech` and
> `preview_audio`, and `onsetFrames` on `transcribe_asset`, with the three
> open questions below decided and the detector verified against real
> narration. Remaining: word frames for generated speech, and the frame-API
> exposure (see the TODO). This is the smallest of the open
> plans and the one with the highest ratio of value to work: both signals are
> already computed *somewhere* in the engine, at the wrong granularity or on
> the wrong path.
>
> Found by building a 15 s narrated spot and then measuring the result — the same
> method that produced plans 4 and 5. Findings marked **[measured]**.

## What it does in each environment

Added 2026-08-08, after the question "if the agent is on Env B, do we need
this?" — the test every plan in this folder should carry and this one did not.
Definitions in [agent-environments.md](../agent-environments.md); the customer
framing in [deploy/PROVISION.md](../../deploy/PROVISION.md) §"No-shell
customers", which makes Env A the demo tier and real production agents
shell-capable.

| | Value |
|---|---|
| **Env A** (MCP only) | **Essential**, and the usual Env A story — nothing on the tool surface measured emphasis, and a composition cannot ask a question about audio. |
| **Env B** (+ shell) | **Wants the onsets, and cannot get them.** This is the part that decides the plan, so it is stated with what was actually checked. |

**Onsets: Env B cannot produce these from the standard toolset.** ffmpeg has no
onset or spectral-flux filter; its neighbours answer different questions
(`silencedetect` finds silence boundaries, `astats` gives windowed statistics).
Spectral flux needs an FFT over the samples, and the machine inventory in
`MACHINE.md` has no aubio, essentia or librosa, with system Python recorded as
standard-library only — so a pure-Python STFT over even a 20 s clip is
unusably slow. Env B would have to install a new dependency to answer a
question the engine can answer on a pass it is already making.

**The envelope: Env B could grind it out**, by decoding raw PCM with
`-f s16le` and looping, or `astats` with a reset window — the same shape
[render-review.js](../../engine/src/core/render-review.js) already uses for
video. Two things still keep it engine-side: it comes back in seconds or
samples and must become **frames at the film's fps**, which the engine knows
and a shell script does not (the invariant `transcode_asset` already states),
and it was ~30 lines on the pass the onsets required anyway.

**Why the demo-tier framing does not apply.** PROVISION.md calls Env A the
demo tier for *generation* — production customers generate audio and visuals
agent-side. Its very next section pushes the opposite way for timing: a
customer's speech API becomes an engine **vendor**, never a helper, because
that "preserves `synthesize_speech`'s frame-accurate `timings`, which
agent-side generation loses (forcing a `transcribe_asset` round-trip to
recover them)." A production Env B agent generating narration through a
ComfyUI TTS helper is exactly the caller with **no engine timings**, and cue
measurement is how it recovers them cheaply. Deterministic, timing-coupled
measurement is engine work by [architecture.md](../architecture.md) §9.5
regardless of whether the caller has a shell.

**The one item this test kills** is word frames for generated speech — see the
TODO below. Its stated value is beating a whisper round trip on audio the
engine wrote itself, but *both* environments have whisper (Env A through
`transcribe_asset`, Env B through the binary), so it is a cost-and-precision
improvement rather than a capability either one lacks — and by the quote
above, engine-generated narration is the scratch-work-and-demos path anyway.
Build it only where a vendor hands the boundaries over for free.

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
- [x] `onsetFrames[]` on `transcribe_asset` (2026-08-08) — measured from the 16 kHz extraction the model already read, cached in seconds and framed per call, with `null` reserved for "cached before cue measurement existed"
- [ ] Word frames for generated speech — **narrowed 2026-08-08 by the Env A/B
      test above**: only where a vendor already reports word boundaries (Azure's
      word-boundary events, ElevenLabs' character timings), where it is free,
      exact, and cannot invent anything. The onset-alignment fallback the
      original sketch proposed is **dropped**: eight words against five onsets
      has no correct mapping, so it would ship plausible-but-wrong timings —
      the exact failure class this plan exists to catch, and a breach of its
      own rule 3, "never invent a word". A caller that needs word frames from
      a vendor that cannot report them should round-trip through
      `transcribe_asset`, which is honest about what it measured.
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
   Shipped 2026-08-08, and it forced a fifth decision: **the answer is
   three-valued.** `[]` is measured-and-silent, `null` is not-measured (a
   transcript cached before this existed), and the response names `refresh:
   true` for the second. Bumping `DERIVATION_VERSION` instead would have been
   tidier and much worse — the cache stores only the derived transcript, not the
   raw tokens, so invalidating it re-runs the *model* over every previously
   transcribed file to recover a cue list.
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
