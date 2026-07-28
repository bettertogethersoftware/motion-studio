# `transcribe_asset` — read the speech in supplied media (whisper.cpp)

> **Status: SHIPPED (unreleased, v0.22).** This file is kept as the design
> record — the reasoning below is why the feature exists. For how to *use* it,
> read [transcribe-setup.md](../transcribe-setup.md); for what actually shipped,
> see the [CHANGELOG](../CHANGELOG.md#transcribe_asset--reading-the-speech-in-supplied-media-whispercpp).
>
> **Six things were decided or corrected during implementation**, each because
> the plan left it open or turned out to be under-specified:
>
> 1. **The open "which queue?" question was answered: a second lane.**
>    `core/jobs.js` grew a task lane with its own concurrency limit (2) and
>    queue, sharing the id space and every polling tool. The call blocks up to
>    `waitMs` (default 45 s) and returns the transcript inline when it fits,
>    which at ~7× realtime covers anything under about five minutes of audio —
>    so the plan's design sketch (a direct return shape) is what a caller
>    normally sees, and a `jobId` is the fallback rather than the norm.
> 2. **The sidecar lives under the data dir, not beside the file.** The plan said
>    "key a sidecar on (file identity, model, language)" without saying where. A
>    transcript dropped into the workspace library is debris in a folder the human
>    curates, and one in `assets/` invites someone to put it on a timeline. It
>    caches *seconds*, so one entry serves a 24 fps film and a 30 fps one.
> 3. **Models beside the binary are found automatically.** Not in the plan, and it
>    is the difference between a three-variable setup and a one-variable one:
>    every prebuilt whisper.cpp release ships `Release/whisper-cli.exe` with
>    `Release/models/`, so pointing `MOTION_STUDIO_WHISPER_BIN` at the exe is a
>    complete configuration. `MOTION_STUDIO_WHISPER_MODELS` was added for the
>    folder, and `MODEL` accepts a bare name *or* a path.
> 4. **A third error code.** The plan asked for "a distinct error for
>    non-16 kHz-mono input that the tool could not convert";
>    `transcription_input_unsupported` is broader and more useful: the vendor is
>    fine and the setup is fine, but the *file* has no readable speech. The fix is
>    a different file, which is neither of the other two codes' story.
> 5. **`wordsMatching` and `maxWords`.** A 30-minute recording is thousands of
>    words, and the plan's `words: true` would have made the response the size of
>    the problem. `wordsMatching: "acme"` serves the actual use case — find the
>    frame a given name is spoken on — and the cap reports when it bites.
> 6. **Word `p` is the MINIMUM of its tokens, and words keep their punctuation.**
>    Both follow from "never invent words": a word is only as trustworthy as its
>    least certain sub-token, and stripping punctuation would be a second, lossy
>    opinion about where a word ends. Zero-width tokens (whisper emits
>    `from === to` freely) are widened to the next word's start, because a word an
>    instant wide is a cue frame decided by rounding.
>
> Also added beyond the plan: `pauseSeconds` (what counts as a cut point),
> `trailingSilenceFrames` alongside `leadingSilenceFrames`, and an explicit
> documented model-preference order so "which model runs when nobody says" is
> visible rather than incidental. `-dtw` was evaluated and left off, as the plan
> recommended.
>
> **The vendor is whisper.cpp, not faster-whisper** — see
> [Vendor](#vendor-whispercpp). The whole flow in this plan was driven by hand
> end-to-end (see [What the prototype
> proved](#what-the-prototype-proved)), so the return shape below was measured
> against real vendor output rather than sketched.

## What it does in each environment

| | Without this tool | With it |
|---|---|---|
| **Env A** (MCP only) | Cannot read supplied speech **at all**. A film built around a recording starts with a blocking question to the user. | Parity with Env B on the one thing Env A could never do. |
| **Env B** (+ shell) | Can run `whisper-cli` — and then re-derives sentence boundaries, word frames and confidence by hand, per session, from millisecond offsets. | The subtle derivation is done once, correctly. See [decision 2](#the-five-design-decisions-that-matter). |

This is the rare plan that is high-value in **both** environments, which is why
it ships early despite not being the blocker. Env A gains a capability; Env B
gains correctness on a derivation that is genuinely easy to get wrong — the
prototype nearly spliced audio on decode-window boundaries, which would have cut
mid-clause.

## Why

Motion Studio can **write** speech and knows exactly where every word lands. It
cannot **read** speech, and knows nothing about audio a user supplies. That
asymmetry decides how good a film with real footage can be.

`synthesize_speech` returns `timings` — each sentence's start and duration in
seconds *and frames* — and that single field is why generated narration is easy
to build against: captions, cue frames and visual beats all land on the word
because the engine reported where the word is.

For a user's own recording there is no equivalent. Two sessions show both halves
of the cost.

**Without a transcript** (the promo session), the absence cost structure:

- **A blocking round trip.** The agent could see a person talking and could not
  tell what they were saying, so it stopped and asked. The answer — "it's not
  about the product, voice over it" — determined the entire structure of the
  film. That question is answerable in seconds by a transcript.
- **Every in-point was blind.** The four PIP segments used 2.0 s, 5.0 s, 0.6 s
  and 4.6 s. Those numbers encode one fact only: the clip is 12.4 s long and the
  scene must not run past its end. Not "cut in on the gesture", not "start after
  the throat-clear" — just arithmetic against the duration.
- **Dead air stayed in**, and **the user's voice went unused**: the film shipped
  as synthetic narration over muted footage, with no lip-sync.

**With a transcript** (the prototype), the same primitives produced a different
kind of film — a 65 s piece cut from a 94 s talk, where the speaker's own voice
is the spine and five rendered scenes are cut against it:

| What the transcript made possible | Why it was impossible before |
|---|---|
| Choosing the *argument*: four spans kept, a rhetorical detour dropped | Requires knowing what each span says |
| Splicing on sentence boundaries so joins are inaudible | Requires knowing where sentences end |
| Cueing each of four on-screen labels to the word being spoken | Requires per-word timing, not per-clip |
| Completing a truncated closing line with the speaker's own earlier words | Requires the full text |
| Verifying the finished cut by re-transcribing it | Requires the tool to be cheap enough to run twice |

Captioning supplied footage is impossible without this for the same reason: the
caption track can only ever be as accurate as the agent's guess at the words.

## Vendor: whisper.cpp

The earlier draft of this plan named faster-whisper. **whisper.cpp is the better
fit**, and the prototype ran on it:

- **A single self-contained binary plus one model file.** `whisper-cli.exe` and
  a `ggml-*.bin`. faster-whisper needs Python, pip, and a CTranslate2 wheel —
  three moving parts on a user's machine to read a WAV.
- **It is the shape every other vendor here already has.** Piper is exactly
  this: a binary and a voice file, found via `MOTION_STUDIO_*`, degrading to
  `*_unavailable` when absent. A second vendor with the same shape costs nothing
  new to document, install, or reason about.
- **Fast enough to be used casually.** Measured: `ggml-small.en` on 94.1 s of
  16 kHz mono, 8 CPU threads → **14.4 s wall, ≈6.5× realtime**, no GPU. Cheap
  enough to transcribe on ingest *and* re-transcribe the render to verify it.

### Invocation, as verified

```
whisper-cli.exe -m models/ggml-small.en.bin -f in.wav -l en -ojf -of out -t 8 -np
```

- **`-ojf` (`--output-json-full`), not `-oj`.** Plain `-oj` omits the `tokens`
  array, and the tokens are the whole point — they are where per-word timing
  lives.
- **Input must be 16 kHz mono PCM.** Not a preference; whisper.cpp requires it.
  This is the hard dependency on `transcode_asset`'s `audio` mode, which
  therefore needs explicit `sampleRate`/`channels`, not just "a WAV".
- `-np` suppresses progress chatter; `-t` sets threads; `-of` sets the output
  prefix (the tool appends `.json`).

### The vendor's actual output shape

```jsonc
{
  "systeminfo": "…", "model": { "type": "small", "multilingual": false, … },
  "params": { "model": "…", "language": "en", "translate": false },
  "result": { "language": "en" },
  "transcription": [
    { "timestamps": { "from": "00:00:08,560", "to": "00:00:16,040" },
      "offsets":    { "from": 8560, "to": 16040 },          // MILLISECONDS
      "text": " the salvation and the redemption of the entire world. Jordan death. Jesus Christ",
      "tokens": [
        { "text": " salvation", "offsets": { "from": 8860, "to": 9760 },
          "timestamps": {…}, "id": 21005, "p": 0.994888, "t_dtw": -1 },
        …
      ] }
  ]
}
```

Three facts in that sample that the design has to absorb:

**1. `transcription[]` entries are decode windows, not sentences.** Look at the
`text`: it starts mid-sentence and crosses *three* sentence boundaries. Segments
are ~7.5 s chunks bounded by the model's decode window, and nothing about them
respects grammar. So the vendor's segments **cannot** be handed back as the
analogue of `timings` — the tool must re-segment on sentence-final punctuation
using token offsets. The prototype did this by hand, and it is the single most
load-bearing derivation in the whole tool.

**2. There is no `no_speech_prob`.** The earlier draft promised to pass it
through; the vendor does not emit it. What exists is per-token `p` (probability).
Confidence must therefore be **derived** — min and mean token `p` per sentence.

**3. `t_dtw` is `-1`** in this output, i.e. DTW alignment was not requested.
Whether enabling it measurably improves token boundaries is untested; treat it
as an option to evaluate, not a default.

## Design sketch

Addressed exactly like `probe_asset` — the two tools answer the two questions
you have about a file you did not make ("what is it?" / "what does it say?"), so
they should be reached the same way.

```js
transcribe_asset({
  path:   'host.mp4',        // library-relative when `target` is omitted
  target: undefined,         // or "<film>" / "<film>/<scene>" + an assets/ path
  fps:    30,                // timings come back in FRAMES at this rate
  language: 'en',            // optional; auto-detected otherwise
  model:  'small.en',        // tiny | base | small | medium | large-v3 (+ .en)
  words:  true,              // include the word-level array (default true)
})
→ {
  text: 'This is the Lamb of God that is going to be slain…',
  language: 'en', durationSeconds: 94.12,
  vendor: 'whisper.cpp', model: 'small.en',

  // RE-SEGMENTED to sentences, mirroring synthesize_speech's `timings`
  // field-for-field so both narration sources share one code path:
  sentences: [
    { text: 'This is the Lamb of God that is going to be slain and buried…',
      startSeconds: 1.95,  startInFrames: 59,
      durationSeconds: 9.4, durationInFrames: 282,
      minTokenP: 0.71, meanTokenP: 0.96 },
    …
  ],

  // the reason -ojf exists: cue a graphic to a spoken word
  words: [
    { text: 'salvation', startSeconds: 8.86, startInFrames: 266,
      endSeconds: 9.76, endInFrames: 293, p: 0.994888 },
    …
  ],

  speechRanges: [ { startInFrames: 58, endInFrames: 2820 } ],
  leadingSilenceFrames: 58,

  // verbatim vendor segments, for debugging only — never the primary surface
  rawSegments: [ … ],
}
```

### The five design decisions that matter

**1. Timings are in frames, and they are the product.** The `sfx-plan`
post-mortem recorded this the hard way: everything that places anything in this
engine speaks frames, and a tool that returns seconds forces a hand division at
exactly the spot where an off-by-one hides. `sentences[]` must mirror
`timings[]`'s `{text, startSeconds, startInFrames, durationSeconds,
durationInFrames}` exactly, so an agent treats "narration I generated" and
"narration the user recorded" identically. Seconds are reported alongside, never
alone. Vendor offsets are milliseconds and must be converted once, in the engine.

**2. Sentence re-segmentation is the tool, not a convenience.** Per §1 of the
vendor output above, the raw segments are unusable as edit points — they start
mid-clause. Splicing on them produces exactly the audible mid-word cut this tool
exists to prevent. The engine owns this derivation so every caller gets it right.

**3. `words[]` is what makes graphics land on speech.** In the prototype, four
on-screen labels were cued to four spoken names — frames 1451 / 1478 / 1497 /
1520, derived straight from token offsets. Sentence timing could not have done
it; the four names are inside one sentence. This is the capability that turns a
transcript from documentation into direction, and the earlier draft omitted it.

**4. `speechRanges` and `leadingSilenceFrames` are derived, and worth more than
the text.** Collapsing the sentence list into "where is there actually speech" is
a few lines, and it is what turns a transcript into an edit: trim the head, cut
on a pause instead of mid-word, find the gap for a cutaway. The raw text answers
"what does it say"; these answer "where can I cut", which is the question the
film actually has.

**5. It is a vendor capability, gated and degrading — like Piper.** whisper.cpp
is local, offline and free, the same shape as the preferred speech vendor and the
right default for this product. It is *not* a declared prerequisite, so:

- `list_vendors` grows a third capability, `transcription`, beside `speech` and
  `music`, reporting availability and exactly what to install.
- An unconfigured machine gets `transcription_unavailable` naming the fix, never
  a crash and never a retry loop.
- Configuration is environment-only (`MOTION_STUDIO_WHISPER_BIN`,
  `MOTION_STUDIO_WHISPER_MODEL`, `MOTION_STUDIO_WHISPER_THREADS`), consistent
  with every other vendor. **No API keys**: this is a local model, and nothing
  about it should teach an agent to ask a user for a secret.

## Rules it must obey

- **Never invent words.** Report derived `minTokenP` / `meanTokenP` per sentence
  and `p` per word, and let the caller decide; a confidently-wrong transcript
  quoted on screen is worse than no transcript. (Measured: `small.en` rendered
  "Jordan, i.e. death" as `Jordan death.` on one pass — a caption generated
  blind from that would have been wrong on screen.)
- **Cache aggressively.** Model load plus inference is seconds-to-minutes and the
  same file gets asked about repeatedly during authoring. Key a sidecar on
  (file identity, model, language) and return instantly on a hit — same pattern
  as the v0.21 render sidecar.
- **Accept a video directly**, extracting 16 kHz mono internally with the
  engine's own ffmpeg (`runFfmpeg`) — **not** by depending on
  [`transcode_asset`](../task_completed/transcode-asset-plan.md). Requiring the caller to demux
  first is exactly the friction this tool exists to remove, and routing through
  another plan's tool would delay this one for no gain. The extracted WAV is a
  temp file, not an asset: nobody asked for it, and leaving 16 kHz mono debris in
  `assets/` invites someone to put it on a timeline.
- **Convert units once.** Vendor offsets are integer milliseconds; every
  seconds/frames field in the response is derived in the engine, never by the
  caller.
- **Bounded**: max duration and max file size, with a clear error rather than a
  twenty-minute silent job.
- **A job, not a synchronous call** — same reasoning and the same open queue
  question as [`transcode_asset`](../task_completed/transcode-asset-plan.md#open-questions--decide-before-implementing).
  At ≈6.5× realtime a 10-minute recording is ~90 s, well past an MCP client's
  patience. It must not sit behind the render queue: transcription is what you do
  *while* deciding what to render.

## TODO — all done

- [x] `engine/src/core/transcribe.js` — the derivations (**sentence
      re-segmentation from token offsets**, `words[]` flattening, `speechRanges`,
      ms→seconds/frames) plus extract/bound/cache orchestration. The vendor probe
      and invocation ended up one file lower, in
      `engine/src/core/transcribe-whisper.js`, so the provider stays a thin
      wrapper over one CLI contract and the derivations stay vendor-agnostic.
- [x] `engine/src/core/transcribe-vendors.js` mirroring `tts-vendors.js`:
      availability report, "what to install" text, chain-ready even though
      there is one vendor today.
- [x] `transcription` capability in `list_vendors`, and its own Studio page
      (✎ transcribe in the footer, beside 🗣 tts and ♫ music).
- [x] `ErrorCodes.TRANSCRIPTION_UNAVAILABLE` / `TRANSCRIPTION_FAILED`, plus
      `TRANSCRIPTION_INPUT_UNSUPPORTED` — broader than the "non-16 kHz-mono"
      error the plan asked for, and more useful: the file has no readable speech.
- [x] MCP tool `transcribe_asset`, in a second job lane so it never waits behind
      a render.
- [x] Sidecar cache, under `<dataDir>/cache/transcripts/`, keyed with a
      derivation version and storing seconds so any fps can be served.
- [x] Tests with a **fake vendor** (the `fake-piper.mjs` pattern) so the suite
      never needs a 466 MB model download. Cases: **a decode-window segment that
      spans three sentences re-segmenting correctly** (the real sample above is
      the fixture), token→frame conversion at several fps, `words[]` boundaries,
      `speechRanges` derivation across gaps, confidence derivation from token
      `p`, cache hit/miss, unavailable-vendor degradation, bounds — 59 tests in
      `engine/test/transcribe.test.js`, plus six MCP-level ones and five Studio
      ones. **The optional real-model test was deliberately not added**: it would
      be a 466 MB download gated on an env var that nobody sets, and the numbers
      it would assert are already measured by hand and recorded in
      [transcribe-setup.md](../transcribe-setup.md#models-size-speed-and-which-one-you-get).
- [x] Docs: `docs/transcribe-setup.md` (install, models, the measured
      size/speed table) following `tts-setup.md`; rows in `docs/mcp-setup.md`;
      `architecture.md` §9.2 vendors; and `docs/SKILL.md` — specifically that
      supplied footage should be transcribed *before* scene durations are
      chosen, the same way narration is synthesized before durations are chosen
      today.

## What it does not solve

Worth writing down so the tool is not oversold when it lands.

- **It gives text and timing, not judgement.** It will not say whether a take is
  good, whether the framing works, or whether the delivery lands. Choosing which
  four spans of a 94 s talk make an argument was the agent's work, and the
  transcript only made it possible, not automatic.
- **It does not answer intent.** Knowing the words are about AI coding still does
  not say whether the user wants that audio kept, replaced, or muted. That
  question stays with the user; this only removes the *other* question.
- **Accuracy is not free.** Accented speech, proper nouns and technical terms
  come back wrong often enough that a transcript quoted verbatim on screen needs
  a human read. Timing is far more reliable than spelling — which is fortunate,
  because timing is the part the engine actually consumes.

## Deliberately out of scope

- **Diarization** (who spoke). Real value for interviews; a separate feature.
- **Translation / subtitles in another language.** whisper can, this should not
  — a promo shipping a machine translation under the user's name is a bigger
  claim than a transcript.
- **Cloud ASR vendors.** The point is local and offline. The vendor-chain shape
  is there if a cloud option is ever wanted, but nothing should require a key to
  read the user's own file.
- **Choosing the cuts.** The tool reports where the words are. Deciding which
  ones survive is the agent's job, and then the user's.

## What the prototype proved

The whole flow in this plan was run by hand — ffmpeg + whisper.cpp + Motion
Studio — to build a 65 s film from a 94 s talk: the speaker's voice as a
four-span spine, five rendered scenes cut against it, every audio splice hidden
under a graphic, and each of four labels cued to a spoken word. It worked, which
is the argument for building it, but the *cost* is the argument for the shape:

| | calls |
|---|---|
| Shell (`ffmpeg` / `ffprobe` / `whisper-cli` / `node`) | 31 |
| MCP tools, via the client | 17 (4 distinct) |
| MCP tools, via a hand-written stdio JSON-RPC script | 3 distinct |

Two things that accounting makes plain:

- **`probe_asset` shipped in v0.21 and went unused** — every media question was
  answered with `ffprobe` in a shell, because the answers had to feed shell
  commands anyway. A read-only tool in a surface that cannot act is a tool that
  gets bypassed. That observation became the rule the whole set is now organised
  around; see [README.md](../todo_task/README.md#the-rule-this-implies).
- **`build_film` was never called.** The final assembly was a nine-part ffmpeg
  concat, because the film model cannot express "footage, then a scene, then
  footage". That is now [plan 2](../task_completed/footage-segment-plan.md) — promoted from
  "deliberately out of scope" to the blocker, because without it Env A cannot
  build this film no matter how good the asset tooling gets.

**A caution this plan should carry about itself:** a transcript is the *input* to
judgement, not a substitute for it. Choosing which four spans of a 94 s talk make
an argument, deciding to hide every audio splice under a graphic, and completing a
truncated closing line with the speaker's own earlier words were all editorial
calls. The transcript made them possible; it did not make them.
