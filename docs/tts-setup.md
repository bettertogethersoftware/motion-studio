# Motion Studio — Text-to-Speech (Narration) Setup

Narration is optional, and since **v0.17** it comes from one of two **speech
vendors**:

| vendor | what it is | needs | platform |
|---|---|---|---|
| `system` *(default)* | the local `MotionStudioTts.exe` driving the OS voices | `MOTION_STUDIO_TTS_EXE` | Windows only |
| `azure` | Azure AI Speech neural voices over REST, in plain Node | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | any |

Both write the same thing — a PCM WAV in the project's `assets/` — and both are
driven by the same tools (`synthesize_speech`, `list_voices`) and the same
Studio page. Nothing downstream knows which one spoke. If the selected vendor
isn't configured, those tools return `tts_unavailable` and the rest of the
engine is unaffected.

## Picking a vendor

**In the Studio:** `npm run studio` → **🗣 vendors** in the sidebar footer. The
page shows both vendors' live status, what each one is missing, the voice
catalogue, and a ▶ test button that speaks a line so you can hear a voice
before committing a render to it. Pick one, press **save**.

**Everywhere else:** the choice is global — it lives in
`~/.motion-studio/settings.json` as `tts.vendor` and applies to the Studio *and*
to every agent connected over MCP. Precedence, as everywhere else in Motion
Studio:

```
explicit argument (synthesize_speech { vendor })
  > MOTION_STUDIO_TTS_VENDOR
  > settings.json tts.vendor
  > "system"
```

The default stays `system` deliberately: adding a cloud vendor must not start
billing an existing project's narration to an Azure subscription.

Agents can discover all of this with the **`list_vendors`** tool, which reports
which vendor is active, why, whether each is available, and what a user must fix
if not — for speech *and* for [music](music-setup.md), which has the same
two-vendor arrangement and shares the selection machinery
(`engine/src/core/vendors.js`).

---

## Vendor: `azure` (Azure AI Speech) — v0.17

Cross-platform, no exe to build, several hundred neural voices across ~140
locales, with expressive styles. It is a plain `fetch` client
(`engine/src/core/tts-azure.js`) against the two documented REST endpoints — no
SDK, no npm dependency:

```
GET  {endpoint}/cognitiveservices/voices/list
POST {endpoint}/cognitiveservices/v1        body: SSML → RIFF PCM WAV
```

### Credentials (environment only)

Create a **Speech** resource in the Azure portal, then set its key and region on
the machine. On Windows:

```
setx AZURE_SPEECH_KEY "<your key>"
setx AZURE_SPEECH_REGION "eastus"
```

`setx` writes to the *user* environment, so open a new terminal — and restart
the Studio or the MCP client — before the value is visible. Recognized names, in
precedence order:

| purpose | variables |
|---|---|
| key | `MOTION_STUDIO_AZURE_SPEECH_KEY`, `AZURE_SPEECH_KEY`, `SPEECH_KEY` |
| region | `MOTION_STUDIO_AZURE_SPEECH_REGION`, `AZURE_SPEECH_REGION`, `SPEECH_REGION` |
| endpoint override | `MOTION_STUDIO_AZURE_SPEECH_ENDPOINT`, `AZURE_SPEECH_ENDPOINT` |
| default voice | `MOTION_STUDIO_AZURE_SPEECH_VOICE` |

**The key is never stored in `settings.json`** and never leaves the machine
except in the request to Azure. `settings.json` holds only the non-secret half
(`tts.azure.region`, `.voice`, `.outputFormat`, `.style`), and writing a `key`
into it is rejected with `invalid_config` rather than quietly honoured. The
Studio and the MCP tools report the key as `••••1234` with the variable it came
from, so you can confirm *which* credential is in play without exposing it.

The endpoint override exists for sovereign clouds, private endpoints, and tests;
with only a region set, the endpoint is `https://<region>.tts.speech.microsoft.com`.

### Voices and styles

Voice names are Azure **ShortNames** — `en-US-AvaNeural`, `en-GB-RyanNeural`,
`zh-TW-HsiaoChenNeural`. Because the catalogue is large, `list_voices` takes
`locale` / `search` / `limit` / `offset` and reports the true `total`; the
Studio page has the same filters. An unknown voice is a hard `unsupported_voice`
with suggestions — never a silent substitution, because a film whose narrator
quietly changed between takes is worse than a failed call. Omit `voice` entirely
and the vendor uses the configured default, or the first neural `en-US` voice.

Some voices support expressive **styles** (`newscast`, `cheerful`, …), passed as
`style` on `synthesize_speech` and listed per voice by `list_voices`. Asking a
voice for a style it doesn't have fails with the supported list rather than a
bare HTTP 400.

`rate` keeps the `system` vendor's −10..10 scale so a project can switch vendors
without re-tuning every call: each step is 10% of default speed (`rate: 3` →
SSML `rate="+30%"`). `volume` (0..100) passes through to SSML directly.

### Output format

`tts.azure.outputFormat` defaults to `riff-24khz-16bit-mono-pcm`. Only `riff-*`
(WAV) formats are offered, because the narration contract is "a PCM WAV whose
header is the authoritative duration" and every consumer — duration→frames, the
audio mixer, the Studio's audition player — depends on it. A non-RIFF format is
refused before the request is made.

### Errors

| code | when |
|---|---|
| `tts_unavailable` | no key/region, a rejected key (401/403), a wrong region (404), or the service could not be reached |
| `unsupported_voice` | the requested voice is not in the catalogue |
| `tts_failed` | rate limit (429), a 5xx, an unsupported style, a non-WAV format, an empty/garbled body |

The split is deliberate: `tts_unavailable` means *stop and tell the user to fix
their configuration*, `tts_failed` means the call itself went wrong.

### Cost

Azure bills per character synthesized. Motion Studio does not meter or cap this
— re-synthesizing a five-minute film's narration a dozen times is a dozen
billable runs. The voice-test button on the vendors page is capped at 400
characters, which is an audition, not a render.

---

## Vendor: `system` (Windows speech exe) — v0.6

Offline, free, no account, and the reason narration existed before v0.17. Motion
Studio does not synthesize speech itself here either: narration is produced by a
small, self-contained Windows console executable that the engine spawns the same
way it spawns FFmpeg.

Once the exe exists, point the engine at it:

```
MOTION_STUDIO_TTS_EXE = C:\path\to\MotionStudioTts.exe
```

Set it in the MCP server's `env` block (see [mcp-setup.md](mcp-setup.md)), or in
the environment of whatever launches the engine.

---

## The CLI contract (system vendor)

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

`synthesize_speech` (in `engine/src/mcp/server.js`) does, in order: resolve the
vendor and probe it (→ `tts_unavailable` before anything is written); resolve a
destination under the project's `assets/` (default `assets/narration-<n>.wav`,
sandbox-checked); hand the text to the vendor
(`core/tts-vendors.js` → the exe or Azure); parse the WAV header for the
authoritative duration; then, in `attach` mode, append a
`{ src, startInFrames?, gainDb? }` track to `config.audio` so the next render
mixes it in. `list_voices` returns the chosen vendor's catalogue.

`core/tts-vendors.js` is the only vendor-aware module: it owns the vendor list,
the precedence rule, and the probe/synthesize/list calls, so the Studio, the MCP
server, and the CLI cannot disagree about which vendor is active. Both providers
return the same payload shape (`{ ok, voice, durationSeconds, sampleRate,
channels, bytes, outPath }`) and the same probe shape
(`{ available, voices, error }`).

Options one vendor doesn't have are reported, not dropped: passing `style` to
the `system` vendor succeeds and returns
`warnings: ["\"style\" is an Azure-only option and was ignored…"]`.

The exe path resolves as: explicit argument → `MOTION_STUDIO_TTS_EXE` → a
bundled default at `engine/vendor/tts/MotionStudioTts.exe`. A `.js`/`.mjs`
target is run through Node (used by the test stub
`engine/test/helpers/fake-tts.mjs`); the Azure vendor is stubbed the same way by
a local HTTP server (`engine/test/helpers/fake-azure-speech.mjs`) pointed at
through the endpoint override, so both vendors are covered by tests with no exe,
no subscription, and no network.

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
so you can point the exe at any backend (e.g. the neural "(Natural)" voices)
without touching Motion Studio — keep the args, the stdout JSON line, and
PCM-WAV output identical. For a *cloud* backend, prefer adding a vendor
alongside `core/tts-azure.js` instead: a vendor gets the Studio page, the
`vendor` argument, and per-vendor error reporting, none of which an exe wearing
someone else's name can have.

---

## Troubleshooting

Open the Studio's **🗣 vendors** page first: it names the active vendor, its
live status, and what is missing — which answers most of the below without a
terminal. `list_vendors` is the same information for an agent.

- **`tts_unavailable` (system)** — the exe couldn't be run:
  `MOTION_STUDIO_TTS_EXE` is unset, points at a missing file, or the exe crashed
  on `--list-voices`. This is a setup problem for the user to fix, not something
  an agent should retry.
- **`tts_unavailable` (azure)** — no key or region in the environment, a key
  Azure rejected (401/403), a region that doesn't resolve (404), or the service
  was unreachable. The message says which.
- **The key is set but the Studio says it isn't** — `setx` only affects
  *new* processes. Restart the Studio (and the MCP client, which passes its own
  environment to the server).
- **The key is set but Azure rejects it** — a Speech key is region-bound; the
  key and `AZURE_SPEECH_REGION` must belong to the same resource.
- **`unsupported_voice`** — call `list_voices` and pass one of the returned
  names verbatim (or omit `voice` for the vendor default). For Azure, filter by
  `locale` first; the error's `detail.suggestions` lists nearby names.
- **`tts_failed`** — the vendor ran but synthesis failed; `detail` carries the
  exe's `error`/stderr, or Azure's HTTP status and body.
- **The Studio vendors page ignores my region** — a region set in the
  environment outranks the field, so the field is shown disabled with the
  variable that won. Clear the variable to edit it in the Studio.
- **No sound in a preview** — expected. Audio is muxed only at the final
  `render`; `capture_preview_frame` is always silent. Also confirm the output
  format carries audio (mp4/webm/prores do; gif/png-sequence do not).
