# Motion Studio — Text-to-Speech (Narration) Setup

Text-to-speech is an **optional, Windows-only** feature (added in v0.6). Motion
Studio does not synthesize speech itself: narration is produced by a small,
self-contained Windows console executable that the engine spawns the same way
it spawns FFmpeg. Everything else in Motion Studio stays cross-platform; if the
executable isn't configured, the two speech tools (`synthesize_speech`,
`list_voices`) return `tts_unavailable` and the rest of the engine is
unaffected.

Once the exe exists, point the engine at it:

```
MOTION_STUDIO_TTS_EXE = C:\path\to\MotionStudioTts.exe
```

Set it in the MCP server's `env` block (see [mcp-setup.md](mcp-setup.md)), or in
the environment of whatever launches the engine.

---

## The CLI contract

The engine (`engine/src/core/tts.js`) and the executable communicate over a
fixed command-line + stdout-JSON contract. Any implementation that honors this
contract works — the reference implementation is a C# console app, but the
engine only cares about the interface below.

**Synthesize** narration text (passed via a UTF-8 *file*, never argv, so quotes
/ newlines / unicode in the text are safe):

```
MotionStudioTts.exe --text-file <utf8 path> --out <abs .wav path> \
                    --voice "<name>" [--rate N] [--volume N] [--engine winrt|sapi]
```

On success: exit code `0`, write a PCM WAV to `--out`, and print **one JSON
line** to stdout:

```json
{ "ok": true, "voice": "Microsoft George", "engine": "winrt", "durationSeconds": 1.50,
  "sampleRate": 16000, "channels": 1, "bytes": 48046, "outPath": "..." }
```

**List voices**:

```
MotionStudioTts.exe --list-voices [--engine winrt|sapi]
```

Prints a JSON array of installed voice names and exits `0`:

```json
["Microsoft George", "Microsoft Hazel", "Microsoft Susan", "Microsoft James"]
```

**On any failure**: exit non-zero and print `{ "ok": false, "error": "...",
"code": "..." }`. Recognized `code` values:

| `code` | engine maps it to | meaning |
|---|---|---|
| `unsupported_voice` | `unsupported_voice` | the requested `--voice` isn't installed |
| anything else / omitted | `tts_failed` | any other synthesis failure |

Notes:

- **Output is PCM WAV.** FFmpeg re-encodes it during the render mux (mp4→AAC,
  webm→Opus, prores→PCM), so a plain PCM WAV is exactly right.
- **The engine re-derives duration from the WAV header** (`data` size ÷
  `byteRate`), because that's what FFmpeg actually muxes. Your
  `durationSeconds` may be approximate; it's kept only as
  `reportedDurationSeconds`.
- Read `--text-file` as UTF-8 and set the process's stdout encoding to UTF-8.

---

## How the engine uses it

`synthesize_speech` (in `engine/src/mcp/server.js`) does, in order: probe the
exe with `--list-voices` (→ `tts_unavailable` if it can't run); resolve a
destination under the project's `assets/` (default `assets/narration-<n>.wav`,
sandbox-checked); write the narration text to a temp UTF-8 file; spawn the exe;
parse the WAV header for the authoritative duration; then, in `attach` mode,
append a `{ src, startInFrames?, gainDb? }` track to `config.audio` so the next
render mixes it in. `list_voices` just returns the probe's voice list.

The exe path resolves as: explicit argument → `MOTION_STUDIO_TTS_EXE` → a
bundled default at `engine/vendor/tts/MotionStudioTts.exe`. A `.js`/`.mjs`
target is run through Node (used by the test stub
`engine/test/helpers/fake-tts.mjs`).

---

## Building the reference executable (C#)

A reference implementation ships in **[`tts/MotionStudioTts/`](../tts/MotionStudioTts/)** —
a standalone .NET console app published as a single self-contained `win-x64`
exe. It has no dependency on this repo beyond matching the contract above, and
no NuGet dependencies at all.

**How it works.** It has two backends, both from the Windows runtime, no NuGet
(target framework `net10.0-windows10.0.19041.0`):

- **WinRT (default):** `Windows.Media.SpeechSynthesis.SpeechSynthesizer` —
  the OneCore "mobile" voices. On a typical Windows 11 box this exposes more
  voices than SAPI5 (e.g. George/James male, Susan, Catherine…) at higher
  quality. `SynthesizeTextToStreamAsync` returns a WAV stream (commonly 16 kHz
  mono) written straight to `--out`. The projections come free with the
  windows10 TFM. **Note:** these are the OneCore voices, *not* the newest neural
  "(Natural)" voices — if any of those are installed (Settings → Time &
  language → Speech → Manage voices) they show up in `--list-voices` too.
- **SAPI5 (`--engine sapi`, or automatic fallback):** SAPI's COM automation
  objects (`SAPI.SpVoice` + `SAPI.SpFileStream`) via late-bound `dynamic` — the
  same mechanism as PowerShell's `New-Object -ComObject SAPI.SpVoice`, writing
  mono 22.05 kHz PCM. Used when WinRT is unavailable. (The managed
  `System.Speech` wrapper was tried first but throws `NullReferenceException` in
  `GetComEngine` instantiating a voice under the .NET Core runtime on some
  machines, so it was dropped.) A concrete voice is always selected — never the
  SAPI *default*, which is what triggers that NRE.

An unknown `--voice` is a hard `unsupported_voice` error on either backend (no
silent fallback to a different voice).

To build/rebuild it:

1. **Publish** the self-contained single-file exe to the engine's default path:
   ```
   dotnet publish tts/MotionStudioTts -c Release -r win-x64 --self-contained true \
     -p:PublishSingleFile=true -o engine/vendor/tts
   ```
   → `engine/vendor/tts/MotionStudioTts.exe` (the built exe is git-ignored; it's ~70 MB).
2. **Wire it up:** the engine looks at `engine/vendor/tts/MotionStudioTts.exe` by
   default, so once published it's picked up automatically; otherwise set
   `MOTION_STUDIO_TTS_EXE` to wherever the exe lives.
3. **Smoke-test:**
   ```
   engine/vendor/tts/MotionStudioTts.exe --list-voices
   ```
   then a `--text-file <utf8> --out <path.wav>` run, and confirm the WAV plays.

**Swapping the voice engine.** Motion Studio only cares about the CLI contract,
so you can point the exe at any backend (e.g. a cloud TTS, or the neural
"(Natural)" voices) without touching Motion Studio — keep the args, the stdout
JSON line, and PCM-WAV output identical.

---

## Troubleshooting

- **`tts_unavailable`** — the exe couldn't be run: `MOTION_STUDIO_TTS_EXE` is
  unset, points at a missing file, or the exe crashed on `--list-voices`. This
  is a setup problem for the user to fix, not something an agent should retry.
- **`unsupported_voice`** — call `list_voices` and pass one of the returned
  names verbatim (or omit `voice` to use the first installed voice).
- **`tts_failed`** — the engine ran but synthesis failed; the `detail` carries
  the exe's `error`/stderr.
- **No sound in a preview** — expected. Audio is muxed only at the final
  `render`; `capture_preview_frame` is always silent. Also confirm the output
  format carries audio (mp4/webm/prores do; gif/png-sequence do not).
