# `transcribe_asset` — read the speech in supplied media (faster-whisper)

> **Status: PLANNED.** Ships *after*
> [transcode-asset-plan.md](transcode-asset-plan.md): this tool needs that
> tool's `audio` mode to get a WAV out of a video, and — more importantly — a
> transcript only pays off if you can act on it. Knowing *where* the good
> sentence is, with no way to cut to it, is a worse experience than not knowing.

## Why

Motion Studio can **write** speech and knows exactly where every word lands. It
cannot **read** speech, and knows nothing about audio a user supplies. That
asymmetry decides how good a film with real footage can be.

`synthesize_speech` returns `sentenceTimings` — each sentence's start and
duration in frames — and that single field is why generated narration is easy to
build against: captions, cue frames and visual beats all land on the word
because the engine reported where the word is.

For a user's own recording there is no equivalent, and the consequences showed
up immediately in the session that motivated this plan:

- **A blocking round trip.** The agent could see a person talking and could not
  tell what they were saying, so it stopped and asked. The answer — "it's not
  about the product, voice over it" — determined the entire structure of the
  film. That question is answerable in seconds by a transcript.
- **Every in-point was blind.** The four PIP segments used 2.0 s, 5.0 s, 0.6 s
  and 4.6 s. Those numbers encode one fact only: the clip is 12.4 s long and the
  scene must not run past its end. Not "cut in on the gesture", not "start after
  the throat-clear" — just arithmetic against the duration.
- **Dead air stayed in.** No way to find the pause at the head of the take.
- **The user's voice went unused.** The film shipped as synthetic narration over
  muted footage, with no lip-sync. If the recording *had* been about the
  product, there was still no way to build around it.

Captioning supplied footage is impossible for the same reason: the caption
track can only ever be as accurate as the agent's guess at the words.

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
  model:  'base',            // tiny | base | small | medium | large-v3
})
→ {
  text: 'So I have been using Claude to…',
  language: 'en', durationSeconds: 14.72,
  vendor: 'faster-whisper', model: 'base',
  segments: [
    { text: 'So I have been using Claude to…',
      startSeconds: 0.42,  startInFrames: 13,
      durationSeconds: 3.1, durationInFrames: 93,
      noSpeechProb: 0.02 },
    …
  ],
  speechRanges: [ { startInFrames: 13, endInFrames: 372 } ],
  leadingSilenceFrames: 13,
}
```

### The three design decisions that matter

**1. Timings are in frames, and they are the product.** The `sfx-plan` post-mortem
recorded this lesson the hard way: everything that places anything in this engine
speaks frames, and a tool that returns seconds forces a hand division at exactly
the spot where an off-by-one hides. `segments[].startInFrames` must mirror
`sentenceTimings` field-for-field, so an agent can treat "narration I generated"
and "narration the user recorded" with the same code path. Seconds are reported
alongside, never alone.

**2. `speechRanges` and `leadingSilenceFrames` are derived, and worth more than
the text.** Collapsing the segment list into "where is there actually speech" is
a few lines, and it is what turns a transcript into an edit: trim the head, cut
on a pause instead of mid-word, find the gap to place a cutaway. The raw text
answers "what does it say"; these answer "where can I cut", which is the
question the film actually has.

**3. It is a vendor capability, gated and degrading — like Piper.** faster-whisper
is local, offline and free, which is the same shape as the preferred speech
vendor and the right default for this product. It is *not* a declared
prerequisite, so:

- `list_vendors` grows a third capability, `transcription`, beside `speech` and
  `music`, reporting availability and exactly what to install.
- An unconfigured machine gets `transcription_unavailable` naming the fix, never
  a crash and never a retry loop.
- Configuration is environment-only (`MOTION_STUDIO_WHISPER_*`), consistent with
  every other vendor. **No API keys**: this is a local model, and nothing about
  it should teach an agent to ask a user for a secret.

## Rules it must obey

- **Never invent words.** Pass through the model's `no_speech_prob` per segment
  and let the caller decide; a confidently-wrong transcript quoted on screen is
  worse than no transcript.
- **Cache aggressively.** Model load plus inference is seconds-to-minutes and
  the same file gets asked about repeatedly during authoring. Key a sidecar on
  (file identity, model, language) and return instantly on a hit — same pattern
  as the v0.21 render sidecar.
- **Accept a video directly**, extracting audio internally via
  `transcode_asset`'s `audio` mode. Requiring the caller to demux first is
  exactly the friction this pair of tools exists to remove.
- **Bounded**: max duration and max file size, with a clear error rather than a
  twenty-minute silent job.
- **A job, not a synchronous call** — same reasoning and the same open queue
  question as `transcode_asset`.

## TODO

- [ ] `engine/src/core/transcribe.js` — vendor probe, invocation, result
      normalisation into the `sentenceTimings` shape, `speechRanges` derivation.
- [ ] `engine/src/core/transcribe-vendors.js` mirroring `tts-vendors.js`:
      availability report, "what to install" text, chain-ready even though
      there is one vendor today.
- [ ] `transcription` capability in `list_vendors`, and in the Studio vendors page.
- [ ] `ErrorCodes.TRANSCRIPTION_UNAVAILABLE` / `TRANSCRIPTION_FAILED`.
- [ ] MCP tool `transcribe_asset`.
- [ ] Sidecar cache.
- [ ] Tests with a **fake vendor** (the `fake-piper.mjs` pattern) so the suite
      never needs a model download: segment → frame conversion at several fps,
      `speechRanges` derivation across gaps, cache hit/miss, unavailable-vendor
      degradation, bounds. One optional real-model test, skipped by default.
- [ ] Docs: a `docs/transcribe-setup.md` (install, models, size/speed table)
      following `tts-setup.md`; rows in `docs/mcp-setup.md`; `architecture.md`
      §9.2 vendors; and `docs/SKILL.md` — specifically that supplied footage
      should be transcribed *before* scene durations are chosen, the same way
      narration is synthesized before durations are chosen today.

## What it does not solve

Worth writing down so the tool is not oversold when it lands.

- **It gives text and timing, not judgement.** It will not say whether a take is
  good, whether the framing works, or whether the delivery lands.
- **It does not answer intent.** Knowing the words are about AI coding still does
  not say whether the user wants that audio kept, replaced, or muted. That
  question stays with the user; this only removes the *other* question.
- **Accuracy is not free.** Accented speech, product names and technical terms
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
