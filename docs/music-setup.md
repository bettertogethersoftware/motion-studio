# Motion Studio — Music Generation Setup

Music generation is an **optional, Windows-only** feature (added in v0.8).
Motion Studio does not synthesize audio itself: an agent authors a small note
**spec**, and the engine renders it in two spawned stages — exactly the pattern
the [text-to-speech feature](tts-setup.md) uses for narration:

```
note spec (JSON, from the agent)
  → MotionStudioMidi.exe  (DryWetMIDI)          → song.mid
  → FluidSynth + a General MIDI SoundFont       → WAV
  → a config.audio track, mixed by the same FFmpeg pass as narration
```

Everything else in Motion Studio stays cross-platform. If the toolchain isn't
configured, the one music tool (`synthesize_music`) returns `music_unavailable`
and the rest of the engine is unaffected.

## What you need

Three external pieces, each resolvable by an environment variable, each with a
git-ignored **vendored default** under `engine/vendor/`:

| piece | env var | vendored default | what it is |
|---|---|---|---|
| MIDI author | `MOTION_STUDIO_MIDI_EXE` | `engine/vendor/music/MotionStudioMidi.exe` | the C# exe in `music/MotionStudioMidi` (DryWetMIDI) |
| synthesizer | `MOTION_STUDIO_FLUIDSYNTH` | `engine/vendor/fluidsynth/bin/fluidsynth.exe` | the [FluidSynth](https://www.fluidsynth.org/) binary |
| instruments | `MOTION_STUDIO_SOUNDFONT` | `engine/vendor/soundfonts/MuseScore_General.sf3` | any General MIDI `.sf2`/`.sf3` SoundFont |

`checkMusic()` verifies all three exist before the tool runs; whichever is
missing is named in the `music_unavailable` error. Set the overrides in the MCP
server's `env` block (see [mcp-setup.md](mcp-setup.md)) or wherever the engine is
launched.

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

## The MIDI CLI contract

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

- **`music_unavailable`** — one of the three pieces is missing; the error names
  which and its resolved path. A setup problem for the user to fix, not something
  an agent should retry. (Also raised if the MIDI exe can't be spawned at all.)
- **`invalid_music_spec`** — the spec had no tracks/notes or wasn't valid JSON;
  the `detail` carries the exe's message. Fix the spec and retry.
- **`music_failed`** — the MIDI exe or FluidSynth ran but failed (e.g. a bad
  SoundFont, or FluidSynth wrote no audio); `detail.stderrTail` has the tail.
- **Silent / near-silent WAV** — almost always the SoundFont: a DLS file renamed
  to `.sf2`, or an empty/percussion-only bank. Try MuseScore_General.
- **No sound in a preview** — expected. Audio is muxed only at the final
  `render`; `capture_preview_frame` is always silent. Confirm the output format
  carries audio (mp4/webm/prores do; gif/png-sequence do not).
