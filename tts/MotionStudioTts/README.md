# MotionStudioTts

The external Windows text-to-speech helper that Motion Studio's engine spawns
for the `synthesize_speech` MCP tool. It turns narration text into a PCM WAV
using the OS speech voices. This is an **optional, Windows-only** component; the
rest of Motion Studio is cross-platform and runs fine without it.

It's a self-contained console app with **no NuGet dependencies** and two
synthesis backends, both from the Windows runtime:

- **WinRT (default)** — `Windows.Media.SpeechSynthesis`, the OneCore "mobile"
  voices (more voices, including male like George/James; higher quality than the
  classic SAPI5 "Desktop" set). Projections come free with the
  `net10.0-windows10.0.x` target framework.
- **SAPI5 (`--engine sapi`, or automatic fallback)** — `SAPI.SpVoice` /
  `SAPI.SpFileStream` via late-bound `dynamic`, the same way PowerShell's
  `New-Object -ComObject SAPI.SpVoice` does. (The managed `System.Speech` wrapper
  throws `NullReferenceException` instantiating voices under .NET Core on some
  machines, so we bypass it.)

## Build

```
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o ../../vendor/tts
```

That drops `MotionStudioTts.exe` at `vendor/tts/`, which is the path the
engine checks by default (`resolveTtsExe` in `engine/src/core/tts.js`). The exe
is ~70 MB and git-ignored — build it locally. Alternatively point
`MOTION_STUDIO_TTS_EXE` at it wherever it lives.

## CLI contract

```
MotionStudioTts.exe --list-voices [--engine winrt|sapi]
MotionStudioTts.exe --text-file <utf8 path> --out <.wav path> [--voice "<name>"] [--rate -10..10] [--volume 0..100] [--engine winrt|sapi]
```

- `--list-voices` → prints a JSON array of installed voice names, exit 0.
- synth → writes a PCM WAV to `--out` (WinRT ~16 kHz mono, SAPI 22.05 kHz mono)
  and prints one JSON line: `{ "ok":true, "voice", "engine", "durationSeconds", "sampleRate", "channels", "bytes", "outPath" }`.
- `--engine` selects the backend (default `winrt`, falls back to `sapi` if WinRT
  is unavailable).
- failure → non-zero exit + `{ "ok":false, "error":"...", "code":"..." }` where
  `code` is `unsupported_voice` (unknown `--voice`) or `tts_failed` (anything else).

Narration text is read from a UTF-8 **file** (not argv), so quotes / newlines /
unicode are safe. A concrete installed voice is always selected — the requested
one, or the first installed if `--voice` is omitted — never the SAPI system
default.

See [`docs/tts-setup.md`](../../docs/tts-setup.md) for how the engine uses this.
