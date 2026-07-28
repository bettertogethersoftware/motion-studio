# Motion Studio — Music Generation Setup

An agent authors a small note **spec**; the engine renders it to audio against a
General MIDI SoundFont and adds it to a scene's (or a film's master timeline's)
audio tracks. Since **v0.17** that render comes from one of two **music vendors**:

| vendor | what it is | needs | platform |
|---|---|---|---|
| `node` *(default)* | `spessasynth_core` rendering the SoundFont in-process | a `.sf2`/`.sf3` SoundFont | any |
| `fluidsynth` | the v0.8 chain: `MotionStudioMidi.exe` → `fluidsynth.exe` | both exes + a SoundFont | Windows only |

Both take the same spec, read the same SoundFont, and produce the same kind of
PCM WAV, so nothing downstream knows which one played. This mirrors the speech
side exactly — see [tts-setup.md](tts-setup.md); the selection rule, the status
report and the "vendor unavailable" error live in one shared place
(`engine/src/core/vendors.js`).

```
note spec (JSON, from the agent)
  → MIDI  ─┬─ node:       spessasynth_core, in-process
           └─ fluidsynth: MotionStudioMidi.exe → fluidsynth.exe
  → WAV → a config.audio track, mixed by the same FFmpeg pass as narration
```

If the selected vendor isn't usable, `synthesize_music` returns
`music_unavailable` naming what is missing — and, if the *other* vendor is
ready, saying so — and the rest of the engine is unaffected.

## Picking a vendor

**In the Studio:** `npm run studio` → **♫ music** in the sidebar footer. Each card shows live status and where each path came
from; **▶ listen** renders a short phrase on any of the 128 General MIDI
instruments through the selected vendor, so you can hear a SoundFont before
committing a film to it. **☆ favorite** (v0.22) stars the auditioned
instrument: starred programs save as `music.favoritePrograms` and are
reported to agents via `list_vendors`, which are instructed to prefer them
when composing — auditioning directly steers generated music.

**Everywhere else:** the choice is global (`~/.motion-studio/settings.json`,
`music.vendor`) and applies to the Studio and to every agent over MCP:

```
explicit argument (synthesize_music { vendor })
  > MOTION_STUDIO_MUSIC_VENDOR
  > settings.json music.vendors (chain) or music.vendor (single)
  > "node"
```

`node` is the default because it is the only one that works off Windows and the
only one that needs no binaries a fresh clone has to build.

### Preference chains

Tick **both** vendors on the music page and you get an ordered chain
(`music.vendors: ["fluidsynth", "node"]`, ▲▼ to rank): the highest-ranked vendor
that is actually set up renders the spec, so a machine without the FluidSynth
exes falls through to `node` instead of failing. `MOTION_STUDIO_MUSIC_VENDOR`
accepts a comma-separated list for the same thing.

There is still **no silent fallback**, in the sense that mattered: a vendor you
name explicitly is never redirected, only *unconfigured* vendors are skipped
(a vendor that fails mid-render is a hard error), and every fallback is reported —
`vendorNote` + `vendorChain` on the result, a warning line in the Studio,
`preferred` vs `active` from `list_vendors`. What it costs: with a chain of two,
the choice is made per call, so a vendor that disappears between two
`synthesize_music` calls in one film changes the timbre from that point on. Tick
one vendor if a film's soundtrack must be one synthesizer no matter what — that
is still the default. Full reasoning in [tts-setup.md](tts-setup.md#preference-chains--ticking-more-than-one)
and `engine/src/core/vendors.js`.

Agents discover all of this with **`list_vendors`**, which reports both
capabilities (speech and music), which vendor each will use, and what to fix.

---

## Vendor: `node` (v0.17)

Nothing to install beyond a SoundFont. The spec becomes a MIDI file in memory
(`MIDIBuilder`) and is rendered by `spessasynth_core` — Apache-2.0, no
transitive dependencies, ~2.5 MB — which is already a dependency of the engine,
so `npm install` is the entire setup.

| piece | env var | default |
|---|---|---|
| instruments | `MOTION_STUDIO_SOUNDFONT` | `engine/vendor/soundfonts/MuseScore_General.sf3` |

Settings (`music.node`) can also carry a `soundfont` path, `sampleRate`
(default 44100) and `gain`; the environment variable wins over settings, as
everywhere else.

**Measured on a 60-second, 4-track bed** against `MuseScore_General.sf3`
(39 MB, 309 presets): the SoundFont loads in ~56 ms and the render takes ~1.4 s
— about 45× realtime, versus ~5.3 s for the spawned chain on the same spec. The
same spec renders byte-identically across runs.

### The gain calibration (why `1.575`)

The two synthesizers scale their master gain differently. Rendering one
identical spec through both, FluidSynth at its `-g 0.7` peaks at **−9.1 dBFS**
while spessasynth at `0.7` peaks at **−16.1 dBFS** — 7 dB quieter. Gain here is
exactly linear (0.7 → −16.14, 1.0 → −13.04, 1.575 → −9.10), so the default is
**1.575**: the value that makes a bed land at the same loudness whichever vendor
rendered it. Switching vendors must not silently re-balance a film's music
against its narration.

That default is a setting (`music.node.gain`) — change it if you prefer a
different working level, but change `music.targetPeakDb` first (below), which is
the safer knob.

---

## Level control (both vendors)

`music.targetPeakDb` (default **−3 dBFS**) is measured against every render and
**only ever attenuates** — a quiet arrangement stays quiet, because the agent
asking for quiet meant it. It is the same rule
[`synthesize_sfx`](sfx-setup.md) uses, and it is what keeps a vendor swap from
changing loudness. Set it to `off` on the vendors page (or `null` in settings)
to leave levels exactly as rendered.

`synthesize_music` reports the measured `peakDb` of what was actually written,
plus `attenuatedDb` when the target pulled it down. You cannot hear the output;
that number is how you know whether the bed will fight the narration. Since
v0.19 `synthesize_speech` reports its clip's `peakDb`/`meanDb` too, so the
bed/narration balance is arithmetic, not guesswork — and the `preview_audio`
tool mixes the whole timeline to a WAV (fades, ducking, limiter included) so
the result can be checked in seconds without a render.

Two v0.19 track controls matter for beds specifically: `fadeOutFrames` ends a
bed musically at the composition end instead of hard-cutting mid-reverb-tail,
and `duck: true` (settable at attach time) sidechain-compresses the bed under
the non-ducked tracks, dipping it while narration speaks. See
[user-guide.md §Audio](user-guide.md) and `update_scene_config` in
[mcp-setup.md](mcp-setup.md).

An explicit `vendor` argument that differs from the machine's configured
default adds a `vendorNote` to the response (v0.19) — the override is for that
call only; the default is changed on the vendors page.

---

## What the `fluidsynth` vendor needs

Three external pieces, each resolvable by an environment variable, each with a
git-ignored **vendored default** under `engine/vendor/`:

| piece | env var | vendored default | what it is |
|---|---|---|---|
| MIDI author | `MOTION_STUDIO_MIDI_EXE` | `engine/vendor/music/MotionStudioMidi.exe` | the C# exe in `music/MotionStudioMidi` (DryWetMIDI) |
| synthesizer | `MOTION_STUDIO_FLUIDSYNTH` | `engine/vendor/fluidsynth/bin/fluidsynth.exe` | the [FluidSynth](https://www.fluidsynth.org/) binary |
| instruments | `MOTION_STUDIO_SOUNDFONT` | `engine/vendor/soundfonts/MuseScore_General.sf3` | any General MIDI `.sf2`/`.sf3` SoundFont |

All three must exist before the tool runs; whichever is missing is named in the
`music_unavailable` error. Set the overrides in the MCP server's `env` block
(see [mcp-setup.md](mcp-setup.md)) or wherever the engine is launched.

---

## The spec (what the agent authors)

`synthesize_music` takes a `spec` — the piece to compose — plus placement
options. Times are in **beats** (quarter notes), so they're tempo-independent:

```json
{
  "bpm": 110,
  "tracks": [
    { "program": 0,  "notes": [
      { "pitch": 72, "start": 0, "duration": 0.5, "velocity": 100 },
      { "pitch": 76, "start": 0.5, "duration": 0.5 },
      { "pitch": 79, "start": 1, "duration": 1 } ] },
    { "program": 32, "notes": [
      { "pitch": 48, "start": 0, "duration": 1 },
      { "pitch": 55, "start": 1, "duration": 1 } ] }
  ]
}
```

- `program` — General MIDI instrument `0..127` (0 piano, 24 nylon guitar, 32
  acoustic bass, 40 violin, 48 strings, 56 trumpet, 73 flute…). Ignored when
  `drums: true`, which routes the whole track to GM percussion (channel 10).
- `pitch` — MIDI note `0..127`; `60` = middle C. `start`/`duration` in beats;
  `velocity` `1..127` (default 96).
- Tracks map to distinct MIDI channels automatically (skipping the drum channel).

---

## Composing without writing notes (v0.20)

Hand-writing the note form works, but a 30-second bed is ~100 raw MIDI notes —
and hand-voiced triads tend to get the craft details (voice leading, register,
headroom) wrong. Since v0.20 `spec` alternatively takes a **progression form**
that the engine compiles into the exact same note spec before either vendor
sees it (`engine/src/core/music-theory.js` — the renderers are untouched):

```json
{ "bpm": 96, "progression": ["D", "A", "Bm", "G"], "style": "pad-ballad", "bars": 8, "key": "D" }
```

Chords are **letters** (`C`, `F#m`, `Bb7`, `Am7`, `Dmaj7`, `Esus4`, `Gdim`,
slash bass `C/E`) or **roman numerals** resolved against `key` (`I`, `ii`,
`V7`, `bVII` — lowercase = minor; minor keys like `Am` use natural-minor
degrees). A chord the parser does not know fails as `invalid_music_spec`
**naming the chord** and listing the valid forms.

The progression fills `bars` bars, one chord per bar, cycling (default:
one bar per chord, once through; `beatsPerBar` defaults to 4), then **one
extra held bar closes the piece** on the key's tonic — or the opening chord
when no key is given — so a bed never stops mid-phrase. Chords are voice-led
(each takes the inversion that moves least from the previous one), registers
are fixed per role (bass 36..50, pads ~52..81, arps 60..84), and velocities
sit around 45..65 so the bed arrives with mix headroom built in.

Styles, each a set of named **layers** (= one track each, in this order):

| style | layers (GM program) | character |
|---|---|---|
| `pad` | pad (89) | sustained close-voiced chords — minimal ambient bed |
| `pad-ballad` | pad (89), bass (32), piano (0) | warm pad + root–fifth bass + soft piano arpeggios |
| `arp` | arp (0), bass (32) | eighth-note arpeggios over held bass roots |
| `drive` | pad (90), bass (33), drums | rhythmic eighths pad + walking bass + light kick/snare/hats |
| `lullaby` | music-box (10), strings (48), bass (32) | slow broken chords over soft strings |

### Worked example 1 — the progression form, and what it compiles to

```json
{ "bpm": 96, "progression": ["D", "A", "Bm", "G"], "style": "pad-ballad", "bars": 8, "key": "D" }
```

compiles to a normal 3-track note spec: a **pad** (program 89) holding
voice-led triads one whole bar each — D:`62,66,69` → A:`61,64,69` (only two
voices move, one semitone and one whole tone) — a **bass** (program 32)
playing root for two beats then fifth for two, down in `38..50`, and a
**piano** (program 0) arpeggiating chord tones in quarter notes above. Eight
bars of D–A–Bm–G, then bar 9 holds a D chord across every layer. ~80 notes,
36 beats = 22.5 s at 96 bpm — from one line. The tool response reports
`compiled: { style, bars, chords, notes }` next to the usual fields; `chords`
counts the held close, which is why it reads 9 for `bars: 8`.

### Worked example 2 — roman numerals, layer selection, seeded variation

```json
{ "bpm": 72, "key": "F", "progression": ["I", "vi", "IV", "V7"], "style": "lullaby",
  "bars": 8, "layers": ["music-box", "strings"], "seed": 7 }
```

Roman numerals resolve against `key: "F"` → F, Dm, Bb, C7. `layers` renders
only the named subset of the style's layers (here: no bass — the track order
stays the style's own). `seed` drives the only "randomness" there is —
velocity humanization and arp/broken-chord contour — through a local
deterministic PRNG (the same mulberry32 the Frame API's `random()` uses):
**identical input always compiles to identical notes**, and with the `node`
vendor that means byte-identical WAVs; change `seed` to get a different take
of the same arrangement.

Exactly **one** of `tracks` | `progression` must be present. Everything
downstream is unchanged: the compiled spec passes the same validator, renders
through whichever vendor is active, and mixes like any other bed.

---

## The MIDI CLI contract (fluidsynth vendor)

The engine (`engine/src/core/music.js`) and the MIDI exe communicate over a
fixed command line + one-JSON-line stdout. Any implementation honoring it works;
the reference is the C# app below. The spec is passed as a **UTF-8 file**, never
argv, so structure/encoding is safe:

```
MotionStudioMidi.exe --spec-file <utf8 json> --out <song.mid>
```

On success: exit `0`, write the MIDI, print **one JSON line**:

```json
{ "ok": true, "tracks": 2, "notes": 5, "bpm": 110, "durationSeconds": 2.0, "outPath": "..." }
```

On failure: non-zero exit and `{ "ok": false, "error": "...", "code": "..." }`.
Recognized `code` values and how the engine maps them:

| exe `code` | engine maps it to | meaning |
|---|---|---|
| `invalid_music_spec` | `invalid_music_spec` | spec missing/empty/no notes, or not valid JSON |
| anything else / omitted | `music_failed` | any other authoring failure |

The MIDI file uses 480 ticks per quarter note; the tempo is written as a single
`SetTempoEvent` (`60,000,000 / bpm` µs per quarter) on the first track.

## The FluidSynth stage

The engine then spawns FluidSynth to render the MIDI to a WAV:

```
fluidsynth -ni -T wav -F <out.wav> -r 44100 -g 0.7 <soundfont> <song.mid>
```

The WAV is **longer than the spec's `durationSeconds`** by FluidSynth's
reverb/release tail. The engine re-derives the authoritative length from the WAV
header (`tts.js`'s `wavDurationSeconds`) — that's what FFmpeg actually muxes — and
returns it as `durationSeconds`/`durationInFrames`, keeping the spec's musical
length as `musicalDurationSeconds`.

---

## Building the reference MIDI exe (C#)

A reference implementation ships in **[`music/MotionStudioMidi/`](../music/MotionStudioMidi/)** —
a standalone .NET 8 console app, its one NuGet dependency
([DryWetMIDI](https://github.com/melanchall/drywetmidi) 7.2.0) bundled into a
single self-contained `win-x64` exe:

```
dotnet publish music/MotionStudioMidi -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -o engine/vendor/music
```

→ `engine/vendor/music/MotionStudioMidi.exe` (git-ignored; ~68 MB). The engine
looks there by default, so once published it's picked up automatically;
otherwise set `MOTION_STUDIO_MIDI_EXE`. Smoke-test with a spec file:

```
echo {"bpm":120,"tracks":[{"program":0,"notes":[{"pitch":60,"start":0,"duration":1}]}]} > spec.json
engine/vendor/music/MotionStudioMidi.exe --spec-file spec.json --out song.mid
```

## Setting up FluidSynth + a SoundFont

1. **FluidSynth** — unzip the Windows build (e.g. `fluidsynth-v2.5.6-win10-x64`)
   into `engine/vendor/fluidsynth/` so the exe is at
   `engine/vendor/fluidsynth/bin/fluidsynth.exe`. Keep the **whole `bin/`
   folder** — the exe needs its sibling `.dll`s (glib, etc.). Verify with
   `engine/vendor/fluidsynth/bin/fluidsynth.exe --version`.
2. **SoundFont** — drop a General MIDI SoundFont at
   `engine/vendor/soundfonts/MuseScore_General.sf3`
   ([MuseScore_General](https://musescore.org/en/handbook/3/soundfonts-and-sfz-files#soundfonts)
   is a good free default, ~38 MB). **Use a real `.sf2`/`.sf3`** — Windows'
   bundled `gm.dls` is a DLS file, which FluidSynth rejects ("Not a SoundFont
   file") and renders silent.

You can point the exe at any synthesizer/soundfont — Motion Studio only cares
about the CLI contract and that a WAV lands at `--out`.

---

## Troubleshooting

Open the Studio's **♫ music** page first: it names the active music vendor,
its live status, and what is missing. `list_vendors` is the same information for
an agent.

- **`music_unavailable` (node)** — no readable SoundFont at the resolved path,
  or `spessasynth_core` is not installed (`npm install` in `engine/`). The
  message names which.
- **`music_unavailable` (fluidsynth)** — one of the three pieces is missing; the
  error names which and its resolved path. A setup problem for the user to fix,
  not something an agent should retry. (Also raised if the MIDI exe can't be
  spawned at all.) If the `node` vendor is usable, the message says so.
- **`invalid_music_spec`** — the spec had no tracks/notes, or a field was out of
  range. Since v0.17 both vendors run the same validator, so the message is the
  same either way and `detail.problems` lists every bad field, not just the
  first. Fix the spec and retry.
- **`music_failed`** — the vendor ran but failed (e.g. a corrupt SoundFont, or
  FluidSynth wrote no audio); `detail.stderrTail` has the tail for the exe path.
- **Silent / near-silent WAV** — almost always the SoundFont: a DLS file renamed
  to `.sf2`, or an empty/percussion-only bank. Try MuseScore_General, and use
  the vendors page's **▶ listen** button to hear the bank before rendering.
- **The bed sits at a different level after switching vendors** — it shouldn't;
  that is what the calibrated gain and `music.targetPeakDb` are for. Check the
  reported `peakDb` from each vendor, and see the calibration note above if you
  have changed `music.node.gain`.
- **No sound in a preview** — expected. Audio is muxed only at the final
  `render`; `capture_preview_frame` is always silent. Confirm the output format
  carries audio (mp4/webm/prores do; gif/png-sequence do not).
