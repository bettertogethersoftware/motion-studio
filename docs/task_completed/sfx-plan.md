# `synthesize_sfx` — a built-in sound-effects generator

> **Status: SHIPPED in v0.12.** This file is kept as the design record — the
> reasoning below is why the feature exists. For how to *use* it, read
> [sfx-setup.md](../sfx-setup.md); for what actually shipped, see the
> [CHANGELOG](../CHANGELOG.md#v012-2026-07-25).
>
> **Four things changed between this plan and the implementation**, each because
> the plan turned out to be wrong or under-specified:
>
> 1. **Time is in frames, not seconds.** `atFrame` is primary (`at` in seconds
>    still accepted). Everything else that places audio in this engine speaks
>    frames, so a cue list maps straight over scene `filmOffset`s instead of
>    needing a hand division — which is exactly where an off-by-one hides.
> 2. **It does not normalize by default.** The plan said "normalize to a headroom
>    target (−1 dBFS)". That was wrong: it makes the reported peak meaningless and
>    then has to be undone with a large negative `gainDb` at mix time. Shipped
>    default is `normalize: 'ceiling'` — attenuate *only* if over the ceiling —
>    with `'peak'` and `'none'` available.
> 3. **`gain` is defined as the cue's peak amplitude.** Each cue is scaled so its
>    peak equals its `gain`, so the number means the same thing across
>    generators. The plan left `gain` as an unspecified per-generator multiplier.
> 4. **The determinism claim is narrowed.** Byte-identical for a given Node build
>    (asserted in tests), *not* across V8 versions, because ECMAScript does not
>    pin `Math.sin`/`Math.exp`. The plan promised more than JS can give.
>
> Also added beyond the plan: explicit budgets (512 cues, 30 s per cue), and the
> distinction that a cue *overhanging* the end clamps while one starting *past*
> the end is an error.

## Why

Motion Studio can generate **speech** (`synthesize_speech`, v0.6) and **music**
(`synthesize_music`, v0.8) but has no way to make a *noise* — a whoosh on a cut,
a chime between scenes, a thud when a door shuts, a shimmer under a reveal.

That gap is not theoretical. Both films needed exactly those cues, and both
solved it the same way: a standalone script that filled a `Float32Array` sample
by sample, hand-wrote a 44-byte RIFF header, and dropped the WAV into the
project's `assets/`. Roughly 100 lines of DSP per film, reinvented each time,
living entirely outside the engine and outside its tests.

`synthesize_music` cannot cover this. It is a MIDI pipeline: it needs the MIDI
exe, FluidSynth **and** a SoundFont installed (`checkMusic` probes all three),
and its vocabulary is pitched notes on General MIDI programs. A filtered-noise
riser has no note number, and requiring a SoundFont to produce a 400 ms whoosh
is the wrong dependency shape.

## Design sketch

A **pure-JS, dependency-free, deterministic** synthesizer in `core/sfx.js` —
no external binary, so unlike music it can never be "unavailable". One call
renders a whole *cue list* into a single WAV, because that is how films use it:
a bed of cues at absolute times, mixed to one track, laid over the film with
`build_film`'s master `audio` timeline.

```js
synthesizeSfx({
  outPath,
  durationSeconds: 586.3,        // usually the film length
  sampleRate: 44100,
  cues: [
    { at: 0.5,   type: 'chime',  pitch: 82, gain: 0.4, decay: 2.0 },
    { at: 22.3,  type: 'whoosh', rise: 0.6, fall: 0.45, gain: 0.5 },
    { at: 252.9, type: 'shimmer', rise: 3, hold: 2.4, fall: 4, pitches: [70, 74, 77, 82] },
    { at: 403.6, type: 'thud',   startHz: 62, dur: 2.6, gain: 0.55 },
  ],
})
// → { outPath, durationSeconds, cues, peak, sampleRate, bytes }
```

### Generators to ship

| `type` | Shape | Real use it came from |
|---|---|---|
| `chime` | Inharmonic partials (1, 2, 2.76, 4.16, 5.43) with faster decay on the upper ones, ~4 ms attack | scene-transition bells, in key with the score |
| `whoosh` | Seeded noise through a sweeping one-pole low-pass + high-pass, quartic rise into the hit | tutorial-film cuts |
| `shimmer` | Detuned sine stack with slow per-voice tremolo plus a whisper of filtered air | the glory reveal |
| `thud` | Exponentially descending sine + octave, soft attack so it settles rather than clicks | a heavy gate shutting |
| `tone` | Plain sine/triangle/square + ADSR | UI blips, counters, escape hatch |

### Rules it must obey

- **Deterministic.** All noise from a seeded PRNG (mulberry32), seed derived
  from the cue index unless given. Re-running must be byte-identical — the same
  contract the frame API imposes on visuals.
- **No clipping by construction.** Sum in `Float32`, measure the true peak, and
  normalize to a headroom target (−1 dBFS) rather than trusting the gains. Report
  the pre-normalization peak so a caller can see it was hot.
- **Mono, 44.1 kHz, 16-bit PCM** to match what `muxAudio` already expects.
- **Cheap.** A 10-minute bed is ~26 M samples; it must stay well under a second,
  so per-cue rendering writes only into its own window, never the whole buffer.

## TODO — all done in v0.12

- [x] `engine/src/core/sfx.js` — generators above, seeded PRNG, cue mixdown,
      normalize policy, WAV writer.
- [x] Validate the cue list: unknown `type`, negative `at`, cue extending past
      the end (clamp + report), empty list — plus cue-count/length budgets and
      the `atFrame`-xor-`at` and `pitch`-xor-`hz` rules.
- [x] `ErrorCodes.INVALID_SFX_SPEC` in `core/errors.js` (no `*_unavailable`
      twin — there is no external dependency to be missing).
- [x] MCP tool `synthesize_sfx`, mirroring `synthesize_music`'s shape.
- [x] Tests — `test/sfx.test.js` (26) plus 5 MCP-level tests, no ffmpeg needed.
- [x] `docs/sfx-setup.md` + a row in `docs/mcp-setup.md`'s tool table, and
      `architecture.md` §9.1.
- [x] Note in `docs/film-setup.md` §Levels that the SFX bed is calibrated the
      same way as everything else — measured, not guessed.

## Deliberately out of scope

- **Convolution reverb / impulse responses.** Wants an IR asset library; the
  slow tremolo and detune in `shimmer` already give enough space for cartoon and
  storybook work.
- **Sample playback.** If you have a recording, it is already a file — put it in
  `assets/` and reference it from `config.audio`.
- **Ducking narration under cues.** That is a mix decision, and mixing belongs to
  `build_film`'s master timeline (see `audioTargetPeakDb`), not to the generator.
