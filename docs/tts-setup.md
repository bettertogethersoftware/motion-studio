# Motion Studio — Text-to-Speech (Narration) Setup

Narration is optional, and since **v0.17** it comes from one of several **speech
vendors**:

| vendor | what it is | needs | platform |
|---|---|---|---|
| `system` *(default)* | the local `MotionStudioTts.exe` driving the OS voices | `MOTION_STUDIO_TTS_EXE` | Windows only |
| `azure` | Azure AI Speech neural voices over REST, in plain Node | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | any |
| `piper` *(v0.18)* | [Piper](https://github.com/OHF-Voice/piper1-gpl) neural voices, running locally | Piper installed + downloaded `.onnx` voices | any |

The short version of choosing: `system` is free and offline but Windows-only
and stuck with whatever voices Windows has; `azure` has the best voices and
~140 locales but needs an account and bills per character; `piper` is neural
*and* offline *and* free, at the cost of installing it and downloading voices
yourself.

They all write the same thing — a PCM WAV in the project's `assets/` — and all
are driven by the same tools (`synthesize_speech`, `list_voices`) and the same
Studio page. Nothing downstream knows which one spoke. If the selected vendor
isn't configured, those tools return `tts_unavailable` and the rest of the
engine is unaffected.

## Picking a vendor

**In the Studio:** `npm run studio` → **🗣 tts** in the sidebar footer. Each card shows that vendor's live status, what it is
missing, its voice catalogue, and a ▶ test button that speaks a line so you can
hear a voice before committing a render to it. Tick one, press **save**.

**Everywhere else:** the choice is global — it lives in
`~/.motion-studio/settings.json` as `tts.vendor` and applies to the Studio *and*
to every agent connected over MCP. Precedence, as everywhere else in Motion
Studio:

```
explicit argument (synthesize_speech { vendor })
  > MOTION_STUDIO_TTS_VENDOR
  > settings.json tts.vendors (chain) or tts.vendor (single)
  > "system"
```

The default stays `system` deliberately: adding a cloud vendor must not start
billing an existing project's narration to an Azure subscription.

Agents can discover all of this with the **`list_vendors`** tool, which reports
which vendor is active, why, whether each is available, and what a user must fix
if not — for speech *and* for [music](music-setup.md), which has the same
arrangement and shares the selection machinery (`engine/src/core/vendors.js`).

### Preference chains — ticking more than one

Tick **several** vendors and you get an ordered *preference chain*: narration
runs on the highest-ranked vendor that is actually set up. Rank with the ▲▼
buttons on each card; the badge shows `#1`, `#2`, … and a line above the cards
says which vendor will really be used and what was skipped.

Stored as an ordered array — the scalar `tts.vendor` is kept as the chain's head,
so anything reading it still sees one coherent choice:

```json
"tts": { "vendor": "azure", "vendors": ["azure", "piper"] }
```

The env var takes a comma-separated list for the same thing:
`MOTION_STUDIO_TTS_VENDOR=piper,system`.

Useful for exactly one situation: *"use the good cloud voices when the key is
there, otherwise keep working offline."* Azure key missing or revoked → narration
silently continues on Piper instead of failing the render.

What a chain deliberately does **not** do:

- **It never redirects a vendor you named.** `synthesize_speech { vendor: "azure" }`
  runs on Azure or fails with `tts_unavailable`. Same for a single-valued env var.
  An agent that asked for a specific voice never gets a different one.
- **It only falls back past a vendor that is *not configured*** — no key, no exe,
  no voices. A vendor that probes fine and then fails mid-synthesis is still a
  hard error; the clip is not quietly finished by someone else.
- **A chain of one costs nothing.** That is the default, and resolution does not
  probe anything, exactly as before chains existed.
- **It never falls back silently.** `synthesize_speech` returns a `vendorNote`
  saying what was skipped and why, plus `vendorChain`; the Studio shows a warning
  line; `list_vendors` reports `preferred` vs `active` and `fellBack: true`.

**The caveat worth knowing:** the choice is made per call. In a multi-scene film,
a vendor that becomes unavailable *between* two `synthesize_speech` calls changes
the voice of every line after it — which is the exact failure the single-vendor
rule was written to prevent. If a film's narration must be one voice no matter
what, tick one vendor and let it fail loudly instead.

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

## Vendor: `piper` (local neural) — v0.18

[Piper](https://github.com/OHF-Voice/piper1-gpl) is a fast neural TTS that runs
entirely on the machine: no account, no per-character billing, no network, and
it works on any OS. It is the middle ground between the other two — Azure-ish
voice quality with `system`-ish independence.

Two things to know before you start. Piper is **GPLv3**, so Motion Studio
spawns it as a separate program and never bundles, links, or ships it — the
same arm's-length arrangement it has with FFmpeg and FluidSynth. And Piper is
distributed as a **Python wheel, not a standalone binary**, so it needs a Python
on the machine.

### Install

```
pip install piper-tts
```

That installs a `piper` executable next to your Python (on Windows,
`…\Scripts\piper.exe`) as well as the `python -m piper` module form.

On Windows, pip usually prints a warning that `piper.exe` landed in a `Scripts`
folder **which is not on PATH**. That is the normal outcome, not a broken
install — and you can ignore it: when nothing is configured and `piper` cannot
be found, the engine falls back to `python -m piper`, then `py -m piper`, so a
bare `pip install piper-tts` works with zero configuration. The Studio's tts
page shows which command actually answered.

To pin it explicitly instead:

| purpose | variables |
|---|---|
| executable | `MOTION_STUDIO_PIPER_EXE` (falls back to `piper`, then `python -m piper` / `py -m piper` on PATH) |
| Python (module form) | `MOTION_STUDIO_PIPER_PYTHON` — used as `<python> -m piper` when no exe is set |
| voices folder | `MOTION_STUDIO_PIPER_VOICES` (default `engine/vendor/piper/voices`) |

An explicitly configured command never falls back — a user who named a binary
meant it.

All three can also be set on the Studio's vendors page instead
(`tts.piper.exe` / `.python` / `.voicesDir` in `settings.json`); the environment
wins, as everywhere else.

### Voices are files you download

Each voice is **two files** — the model and its config — from
[huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices):

```
en_US-lessac-medium.onnx
en_US-lessac-medium.onnx.json
```

The easiest way to fetch one is Piper's own downloader, aimed straight at the
voices folder:

```
python -m piper.download_voices en_US-lessac-medium --download-dir engine/vendor/piper/voices
```

Or download both files by hand and put them in the voices folder. Every `.onnx` there with its `.onnx.json`
alongside becomes a voice in `list_voices` and in the Studio's picker; a model
whose config is missing is skipped rather than offered, because Piper cannot
load it. Names follow `{locale}-{speaker}-{quality}`, which is where the
engine gets the locale and quality it shows you. Sizes run from ~20 MB (`low`)
to ~110 MB (`high`).

**Each voice carries its own licence** — check its `MODEL_CARD` on Hugging
Face. Some are more restrictive than Piper itself.

Motion Studio itself never downloads voices: the engine does not fetch from the
internet, and this feature was not the place to start. The downloader above is
Piper's own tool, run by you.

### Behaviour

- **`rate` maps to Piper's `--length-scale`** on the same scale the Azure vendor
  uses — each step is 10% of default speed — so a project can switch vendors
  without re-timing every line. It is clamped to a 0.4–3× range.
- `volume` (0..100) becomes Piper's `--volume` multiplier.
- **`--no-normalize` is always passed.** Piper otherwise normalizes every clip
  to full scale, which would silently overwrite the level balance between
  narration and music. Levels come out as synthesized and the measurement is
  the truth.
- Azure-only options (`style`, `pitch`, `role`) are reported in `warnings`
  rather than silently dropped.
- Narration text is passed with `--input-file` — a UTF-8 file, never argv —
  so quotes, newlines and unicode in a script are safe. Same rule as the exe
  vendor.
- **Output is not bit-identical between runs.** Piper's inference is stochastic
  (`noise_scale`/`noise_w`), so re-synthesizing the same line gives a slightly
  different take. That is fine for narration — audio is generated once and
  thereafter read as a file — but it is not the determinism the frame renderer
  guarantees.

Expect roughly 1–2 seconds per line on CPU, most of it model loading; the
`--cuda` path is not wired up.

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
(`core/tts-vendors.js` → the exe, Azure, or Piper); parse the WAV header for the
authoritative duration; measure the clip's `peakDb`/`meanDb` (v0.19 — a direct
PCM read, so a music bed's `gainDb` can be set relative to the narration
without rendering first); then, in `attach` mode, append a
`{ src, startInFrames?, gainDb? }` track to `config.audio` so the next render
mixes it in. `list_voices` returns the chosen vendor's catalogue.

### Sentence timings (v0.19)

`synthesize_speech { sentenceTimings: true }` synthesizes **per sentence**
(simple terminator split — `.` `!` `?` `…` and CJK forms), concatenates the
clips locally with `sentenceGapSeconds` of silence between them (default 0.3),
and returns `timings`:

```json
"timings": [
  { "text": "This is a teapot.", "startSeconds": 0,    "startInFrames": 0,
    "durationSeconds": 0.99,     "durationInFrames": 30 },
  { "text": "It is quite hot.",  "startSeconds": 1.29, "startInFrames": 39, … }
]
```

Offsets are exact because the engine placed the clips itself, so captions and
cues can be timed to the frame instead of eyeballed. Trade-offs to know:
inter-sentence pacing becomes `sentenceGapSeconds` rather than the vendor's
own prosody, and abbreviations like "Mr." split (pre-split yourself if that
matters). **Word-level timing is not available**: Piper's CLI cannot emit
alignment data, and Azure word-boundary events require the websocket Speech
SDK — a heavy dependency this repo deliberately keeps out (see
"External tool integration style" in the repo conventions).

### Vendor override notes (v0.19)

Calling `synthesize_speech`/`synthesize_music` with an explicit `vendor` that
differs from the machine's configured default adds a `vendorNote` to the
response: the override applies to that call only, and vendor-less calls (and
the Studio UI) keep using the default.

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

Open the Studio's **🗣 tts** page first: it names the active vendor, its
live status, and what is missing — which answers most of the below without a
terminal. `list_vendors` is the same information for an agent.

- **`tts_unavailable` (system)** — the exe couldn't be run:
  `MOTION_STUDIO_TTS_EXE` is unset, points at a missing file, or the exe crashed
  on `--list-voices`. This is a setup problem for the user to fix, not something
  an agent should retry.
- **`tts_unavailable` (piper)** — Piper is not installed (`pip install piper-tts`), or it runs but the voices folder has no usable voice (each voice is an `.onnx` **plus** its `.onnx.json`). The message says which. pip's "piper.exe is installed in a Scripts folder which is not on PATH" warning on Windows is fine — the engine falls back to `python -m piper` automatically; set `MOTION_STUDIO_PIPER_EXE` only when the Python on PATH is not the one pip installed into.
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
