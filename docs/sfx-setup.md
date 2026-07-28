# Motion Studio — Sound Effects (`synthesize_sfx`)

Sound effects are the one generated-audio feature with **nothing to install**
(added in v0.12). Speech needs a Windows TTS exe and music needs a MIDI exe plus
FluidSynth plus a SoundFont; `synthesize_sfx` is pure JavaScript in
`engine/src/core/sfx.js`, so it works on every OS and has no
`sfx_unavailable` error — there is no dependency to be missing.

## Why it exists

`synthesize_speech` makes a voice and `synthesize_music` makes pitched notes.
Neither can make a **noise**: a whoosh on a cut, a chime between scenes, a thud
when something heavy lands, a slow shimmer under a reveal. Two ten-minute films
each hand-rolled about a hundred lines of DSP and a raw RIFF writer to get those,
outside the engine and outside its tests. This is that code, owned properly.

`synthesize_music` is the wrong tool for it: a filtered-noise riser has no MIDI
note number, and requiring a SoundFont to produce a 400 ms whoosh is the wrong
dependency shape.

## The model: one call, one bed

A film wants **one** audio track holding every cue at its absolute time — not one
track per chime, which would grow `amix` inputs for no reason. So one call takes
a whole **cue list** and renders a single mono WAV spanning the piece:

```
synthesize_sfx {
  target,                      // a scene "<film>/<scene>", or a film "<film>"
  spec: {
    cues: [
      { atFrame: 0,     type: "chime",   pitch: 82, gain: 0.4, decay: 2.0 },
      { atFrame: 670,   type: "whoosh",  rise: 0.6, fall: 0.45 },
      { atFrame: 7588,  type: "shimmer", pitches: [70, 74, 77, 82] },
      { atFrame: 12107, type: "thud",    hz: 62, dur: 2.6 }
    ]
  },
  gainDb: -12
}
```

`fps` and the bed length come from the **target** — `durationInFrames` defaults
to the target's (the scene's duration, or the whole film's length for a film
target), so the bed spans the composition without you restating what the
engine already knows.

## Time is in frames

`atFrame` is the primary unit because everything else that places audio in this
engine speaks frames: `config.audio.startInFrames`, `build_film`'s master
timeline, and a scene's `filmOffset`. That makes "a chime on every scene cut" a
plain map:

```js
// sceneLayout comes straight from build_film { scenes, plan: true } (v0.22) —
// it reports each scene's filmOffset without assembling or rendering anything.
cues: sceneLayout.map((s, i) => ({ atFrame: s.filmOffset, type: 'chime', pitch: PENT[i % 6] }))
```

`at` (seconds) is accepted for non-film use. Set **exactly one** of the two — a
cue with both, or neither, is rejected rather than guessed at.

## `gain` is a peak amplitude, not dB

Every cue is scaled so its **peak equals its `gain`** (0..1). That is what makes
`gain` portable: `0.4` is 0.4 of full scale whether the cue is a bell, a noise
sweep, or a sub thud, so you can rebalance a bed without re-learning each
generator's natural loudness. Passing a dB value here (`gain: -8`) is rejected.

Track-level dB still belongs where it always did: `gainDb` on the attached track.

## Levels: it leaves a quiet bed quiet

`normalize` decides what happens to the summed mix:

| value | behaviour |
|---|---|
| `ceiling` (default) | attenuate **only if** the mix exceeds `ceilingDb` (default −1 dBFS) |
| `peak` | always scale so the mix sits exactly at `ceilingDb` |
| `none` | leave it alone, even if it clips |

The default is `ceiling` on purpose. Always normalizing to −1 dBFS makes the
returned peak meaningless and then has to be undone with a large negative
`gainDb` at mix time — both hand-rolled beds ended up around −20 purely to cancel
their own normalization. Leaving a quiet bed quiet keeps `peakDb` a real number
and composes with [`build_film`'s `audioTargetPeakDb`](film-setup.md#levels-measure-never-inherit)
instead of fighting it.

The result always reports `rawPeakDb` (before any correction), `peakDb` (what is
in the file), and `appliedGainDb` (what was done, `0` if nothing).

## The generators

| `type` | Params (defaults) | Sound |
|---|---|---|
| `chime` | `pitch` 82, `gain` .5, `decay` 2.0 | Struck bell. Inharmonic partials (1, 2, 2.76, 4.16, 5.43) with faster decay up top and a 4 ms attack — that ratio set is what reads as "bell" rather than "organ note". |
| `whoosh` | `rise` .6, `fall` .45, `seed` | Seeded noise through a sweeping one-pole low-pass plus a one-pole high-pass, with a quartic rise landing exactly on `atFrame`. Transition sweeps. |
| `shimmer` | `pitches` [70,74,77,82,86,89,94], `rise` 3, `hold` 2.4, `fall` 4 | Micro-detuned sine stack with slow per-voice tremolo and filtered air beneath. Awe, not alarm — it never gets loud fast. |
| `thud` | `hz` 62, `dur` 2.6 | Exponentially descending sine plus octave, 90 ms attack so it settles rather than clicks. Weight: a gate shutting, an impact. |
| `tone` | `pitch`/`hz`, `dur` .25, `wave` sine, `attack` .01, `release` .08 | Plain oscillator + AR envelope. UI blips, counters, escape hatch. |

Pitched cues take `pitch` (a MIDI note, the same vocabulary as
`synthesize_music`) **or** `hz`, never both.

Descending-pitch cues (`thud`, `whoosh`'s body) accumulate phase rather than
evaluating `sin(2π·f(t)·t)`. The latter sweeps about twice as fast as its own
frequency curve claims — a bug worth naming, because it was shipped by hand twice
before it was written down.

## Determinism, and its limit

All noise comes from a seeded PRNG (mulberry32), seeded per cue from its index
unless you pass `seed`. So two identical cues at different times do **not** sound
like copies, and re-rendering the same spec on the same Node build is
byte-identical — asserted in `test/sfx.test.js`.

It is **not** guaranteed across Node/V8 versions. ECMAScript does not pin the
results of `Math.sin`/`Math.exp`, and this module uses both. Pinning it would
mean shipping fixed-point transcendental tables, which is not worth it for a
sound-effects bed. This is a decision, not an oversight — and it does not touch
frame-render determinism, which is a property of the composition; audio is
generated once, here, and then read back as a file.

## File size

Mono 16-bit at 44.1 kHz is ~5.3 MB per minute, so a ten-minute bed is **~53 MB**.
That is why `synthesize_sfx` writes server-side like `synthesize_music` does,
rather than going through `write_asset_file` (25 MB cap).

For a long bed, `sampleRate: 22050` halves it. Nyquist drops to 11 kHz, which is
inaudible on thuds and whooshes and only slightly dulls the top bell partials.
44100 is the default; 48000 is available for delivery-matched projects.

## Limits

- **512 cues** per bed — enough for a cue on every cut of a long film.
- **30 s per cue.** Anything longer is a music bed or an ambience loop, not a cue.
- A cue **overhanging** the end is clamped and reported in `clamped` (a count),
  and — since v0.14 — named in **`clampedCues`**: one
  `{ cue, type, atSeconds, lostSeconds }` entry per victim, where `cue` is the
  index into `spec.cues` and `lostSeconds` is how much of the tail ran past the
  end of the bed. A final chime losing 2 s of its decay is a taste decision;
  a whoosh losing its whole fall is a timing bug — the detail is what lets you
  tell the two apart without listening. A cue starting **past** the end is an
  error: overhang is a taste decision, placement outside the piece is a bug.

Bad specs fail with `invalid_sfx_spec`, with the offending cue index in `detail`.

## Performance

Cues render into a small reused scratch buffer, never the whole bed, so cost
scales with cue content rather than bed length. The 18-cue, 9.8-minute bed from
the Bible film (25.9 M samples) renders in **under a second**.
