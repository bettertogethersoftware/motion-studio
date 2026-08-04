# Provisioning a Motion Studio machine

This playbook is executed by an AI agent on the target machine (customer
infrastructure or a new dev machine). The human deploying Motion Studio starts
an agent in the directory that will become the **tools root**, with the
`motion-studio` repository already cloned inside it, and says:

> Provision this machine with the `<profile>` profile per
> `motion-studio\deploy\PROVISION.md`.

Everything else is the agent's job. The result is a machine where any future
agent can orient itself from three generated/curated files at the tools root —
`AGENTS.md`, `CLAUDE.md`, `MACHINE.md` — plus the per-helper READMEs.

## Layout being built

```text
<toolsRoot>\                      ← the directory this playbook runs in
  motion-studio\                  ← the app repository (already cloned)
  AGENTS.md                       ← generated: generic agent guide (Codex et al.)
  CLAUDE.md                       ← generated: identical content (Claude et al.)
  MACHINE.md                      ← generated skeleton, filled in by this playbook
  ffmpeg-<version>\               ← core tools (every profile)
  whisper-bin-x64\
  auto-editor-windows-x86_64\
  ImageMagick-<version>\
  <optional helpers per profile>\ ← each with its own README.md
```

## Profiles

| profile | adds | for |
|---|---|---|
| `minimal` | core four: FFmpeg, Whisper.cpp, Auto-Editor, ImageMagick | any machine; MCP-complete Motion Studio |
| `standard` | + the `agent_tool\` folder (plateforge, motionforge, videoforge, musicforge, verticalforge; `youtube` if the customer uses YouTube) | production editing work without GPU generation |
| `gpu` | + ComfyUI and the `comfyui*` helpers the customer's brief needs | machines with a capable NVIDIA GPU |

Customer-specific paid or self-developed tools can be added to any profile:
drop the tool's directory into the tools root **with a complete `README.md`**
and add it to `MACHINE.md`'s inventory. Nothing else needs editing — the agent
guide instructs agents to discover helpers by directory and read their READMEs.

This playbook is Windows-first, matching the current product. Cross-platform
packaging (vendor packs, a lightweight npm-first core) is planned — see
`docs\plans\ai-only-desktop-vendor-boundary-plan.md` (draft); as that
lands, the core-tool steps below shrink into fetched packs.

**Linux status: supported.** The L4 acceptance test passed on 2026-08-04 on
a fresh Ubuntu 24.04.4 LTS (WSL2) install — agent-driven provisioning from
this playbook, then a complete film over MCP stdio: piper narration with
sentence timings, `node`-vendor music, SFX, two Chromium renders, a promoted
H.264+AAC build, and a whisper transcribe-back of the deliverable with every
expected word intact; plus the `standard`-profile forge smokes against
distro FluidSynth. Versions tested: Node 18.19.1 (the engine floor), distro
FFmpeg 6.1.1 and static 7.0.2, ImageMagick 6, pip piper-tts, whisper.cpp
master. Bare-metal/VM confirmation beyond WSL2 is an optional follow-up, and
macOS remains untested. The "Provisioning on Linux" section below records
the verified per-step deltas.

## Deployment variations

### No-shell customers (MCP-only, Env A)

This is the **demo / first-impression tier** (stated product intent,
2026-08-04): real production customers run shell-capable agents that
generate audio/visuals through ComfyUI helpers or AI-written API tools, and
the built-in tts/music vendors serve scratch work and demos. Size the effort
accordingly. When the production agent will have **only MCP** — no shell,
often no filesystem — the deployment changes shape:

- Use the `minimal` profile, and **skip Auto-Editor and ImageMagick**: they
  are agent-side shell tools, and nobody on the machine will run them. FFmpeg
  and Whisper are still required — they serve the *engine*
  (`render`, `transcode_asset`, `transcribe_asset`), not the agent.
- Install **`docs\SKILL.md`** (never `SKILL-shell.md`). In Env A the skill
  plus the MCP tool descriptions are the production agent's entire contract.
- Still generate the entry files and fill `MACHINE.md` — their audience here
  is the human maintainer and any future *provisioning* agent, not the
  production agent, which may never be able to read them.
- Narration, score, SFX, and transcription all work without a GPU or shell
  through the engine's vendors (Piper or a cloud key for speech, the `node`
  SoundFont vendor for music). The customer supplies media by dropping files
  into the workspace `library\`; the agent brings them in with
  `use_shared_asset`.

### Server-hosted Studio: the human views from another machine

Motion Studio can sit on a server (or the customer's main box) with the
human adviser viewing the Studio UI from elsewhere. The Studio binds
`127.0.0.1` by default; set `MOTION_STUDIO_STUDIO_HOST` (v0.26, e.g.
`0.0.0.0`) to opt in to a network bind. **The Studio has no authentication**
— a non-loopback bind belongs on a trusted network or behind an
authenticating reverse proxy, never the open internet; record which applies
in `MACHINE.md`. The planned desktop app (vendor-boundary plan §10.2) is a
ComfyUI-style shell around this same surface.

### Remote GPU: ComfyUI as a network server

The GPU does not have to be in the Motion Studio machine. All `comfyui*`
helpers talk to ComfyUI over HTTP, so a GPU box (a DGX/Spark-class machine, a
workstation in another room) can serve a ComfyUI instance to a Motion Studio
host on the LAN:

- Install ComfyUI, models, and their venv **on the GPU box**; install the
  helper directories on the Motion Studio host as usual.
- Record the remote URL and the GPU box's facts in the host's `MACHINE.md`:
  the `ComfyUI API URL`, whose hardware the sizing notes were measured on,
  and where the shared model directory physically lives.
- Run every helper `check` command from the Motion Studio host so what is
  verified is the path agents will actually use.

Whether such a box can instead host the whole stack directly depends on its
OS and the cross-platform plan's progress — do not promise that without
testing it; the network split needs no porting at all.

### Capability triage for customer APIs

When a customer brings their own generation APIs, decide where each lands by
**capability, not by vendor**:

- **Speech / TTS APIs → engine vendor configuration, not a helper.** The
  engine already supports Azure, ElevenLabs, OpenAI, and Deepgram
  (`docs\tts-setup.md`): set the key as an environment variable and pick the
  vendor in settings. This preserves `synthesize_speech`'s frame-accurate
  `timings`, which agent-side generation loses (forcing a `transcribe_asset`
  round-trip to recover them). If the customer insists on an unsupported
  speech provider, that is engine product work — raise it, don't improvise a
  helper.
- **Music, image, and video generation APIs (Suno, Wan-class video, hosted
  image models, …) → agent-side helper directories**, shaped like the
  existing `comfyui*` helpers: a script plus a complete `README.md`, auth via
  environment variable (never pasted into chat or files), printed cost and an
  explicit confirm flag when calls are paid, and a `MACHINE.md` inventory
  row. Generated audio still gets measured before use
  (`docs\production-lessons.md`) — a requested tempo is not a delivered one,
  whichever service generated it.

This is the generative boundary of `docs\architecture.md` §9.5 applied at
install time: deterministic, timing-coupled capabilities go through the
engine; generative content stays agent-side.

## Steps

Work through these in order. Do not skip verification steps; a provisioning
run is only finished when every check command has actually passed.

### 1. Prerequisites

Verify `git`, `node` (LTS), and `python` (3.10+) are installed and on PATH.
Install what is missing (winget is fine), asking the user before any
system-level installer runs.

### 2. Engine

```powershell
cd <toolsRoot>\motion-studio\engine
npm install
npm run doctor
```

`doctor` must pass. Set the `MotionStudioRoot` **user** environment variable to
the repository root (`<toolsRoot>\motion-studio`).

### 3. Core tools (every profile)

Download and unpack into the tools root, keeping each tool's own versioned
folder name:

- **FFmpeg** — a full build (ffmpeg, ffprobe, ffplay). Note: builds without
  fontconfig crash on `drawtext`; that is acceptable (Motion Studio does text
  in compositions), but record it.
- **Whisper.cpp** — a prebuilt Windows x64 release plus at least one model.
  Default to multilingual `ggml-small.bin`; add `ggml-small.en.bin` optionally.
- **Auto-Editor** — the standalone Windows binary.
- **ImageMagick** — the **portable** Q16-HDRI zip (not the installer). Then
  create `magick-portable.ps1` beside `magick.exe` and a `README.md`
  documenting it — copy both from the distribution source machine if
  available; the wrapper must set the module/config environment variables and
  forward arguments unchanged from PowerShell. Verify with the caret check:
  `-resize '1920x1080^'` on a smaller-aspect image must fill-crop (see the
  README beside the wrapper). **Never** wrap it in `cmd`/`.bat`.

Downloads need the user's go-ahead: state the source URL and size, and let the
user approve once for the batch.

### 4. Profile helpers

`standard` and up: copy the **`agent_tool\` folder as one unit** from the
distribution source (v0.26 layout — it holds `plateforge`, `motionforge`,
`videoforge`, `musicforge`, `verticalforge`, `youtube`, the `agent_tool.md`
convention document, the usage logger and `usage-report.ps1`; exclude any
`usage.jsonl` — usage logs are per-machine). These are self-developed
tools with no pip/npm installs. Read `agent_tool\agent_tool.md` first,
then each tool's `README.md`, and run each tool's own doctor/check command.
Omit `youtube\` if the customer does not use YouTube.

`gpu` only: install ComfyUI per the customer's GPU and brief, then copy the
`comfyui*` helpers required. Each helper has a `check` command — run every
one against the live ComfyUI before calling the helper installed. Model
weights go in a shared models directory; record every installed weight file in
`MACHINE.md`. Size batch/resolution defaults to the actual GPU and record what
was tested.

For `youtube`: the uploader needs the customer's account authorization — the
**user** completes any OAuth/sign-in step themselves; never handle their
credentials.

### 5. Generate the entry files

```powershell
node <toolsRoot>\motion-studio\deploy\provision.mjs
```

This writes `AGENTS.md` and `CLAUDE.md` (identical, from `deploy\ENTRY.md`)
and creates `MACHINE.md` from the template if it does not exist. It never
overwrites an existing `MACHINE.md`. Re-run it after every `git pull` that
changes `deploy\ENTRY.md`, so deployed guides never drift from the repo.

### 6. Fill in MACHINE.md

Replace every `TODO` in `MACHINE.md` with measured facts — probe, don't
assume: GPU via `nvidia-smi` or `Get-CimInstance Win32_VideoController`, exact
paths via `Test-Path`, service status via environment-variable presence
(record configured/not configured, **never** the value). List every installed
helper in the inventory table with its readiness check command.

### 7. Install the agent skill

Copy the appropriate skill (`docs\SKILL.md` for MCP-only agents,
`docs\SKILL-shell.md` for shell-capable agents — install **one**, per
`docs\agent-environments.md`) into the target agent's skill directory, and
configure the agent's MCP client per the generated `AGENTS.md`, taking the
literal paths from `MACHINE.md`.

### 8. Final verification

1. Every helper's `check`/smoke command passes (rerun them now, in one pass).
2. Over MCP: `get_capabilities`, then `list_vendors` — confirm the expected
   vendors report ready.
3. Render a short scene end to end (create film → create scene → write a
   trivial composition → render → `wait_for_render`) and confirm the encoded
   file plays and measures correctly (`ffprobe`).
4. Update `MACHINE.md`'s **Last verified** date.

If any step cannot be completed on this machine, record it under
**Machine-specific deviations** in `MACHINE.md` with the reason, rather than
leaving a silent gap.

## Provisioning on Linux

The steps above are the same; these are the per-step deltas. Everything here
was verified on real Linux (Ubuntu WSL without sudo, and GitHub CI runners)
on 2026-08-04 — but remember the status note: no *complete* install has run
end to end yet.

- **Prerequisites (step 1):** distro packages need sudo — list what is
  missing and let the user run or approve the installs. Every prerequisite
  also has a proven userspace fallback for machines where sudo is
  unavailable: Node from the official tarball into `~/tools`, static FFmpeg
  (below), pip via `get-pip.py --user`.
- **Env var (step 2):** set `MotionStudioRoot` by appending an `export` line
  to `~/.profile` (or the distro's equivalent) instead of
  `[Environment]::SetEnvironmentVariable`.
- **FFmpeg (step 3):** distro FFmpeg 6.x and the johnvansickle static 7.x
  build both pass the engine's version floor and full suite. The static
  build needs no sudo:

  ```bash
  curl -fsSL --retry 5 --retry-all-errors \
    https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    | tar -xJ -C ~/tools
  ```

- **ImageMagick (step 3):** install from the distro. **No
  `magick-portable.ps1` wrapper on Linux** — packaged installs locate their
  own coders, and the cmd caret-eating failure the wrapper exists for is a
  Windows-only phenomenon. Note: **Ubuntu 24.04's `imagemagick` package is
  ImageMagick 6** — the binaries are `convert` and `identify`; there is no
  `magick` unified CLI (that arrives with IM7). Record whichever binaries
  exist in `MACHINE.md`.
- **Auto-Editor (step 3):** `pipx install auto-editor` (pipx keeps its own
  venv; no sudo).
- **Whisper.cpp (step 3):** no prebuilt Linux binaries — build it statically
  (needs cmake + a compiler; ~1 minute):

  ```bash
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp
  cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
  cmake --build whisper.cpp/build -j --target whisper-cli
  ```

  Then fetch a `ggml-*.bin` model from huggingface.co/ggerganov/whisper.cpp.
- **SoundFont:** no fresh clone can synthesize music until one exists. Run
  `npm run fetch-soundfont` from `engine/` (v0.26) — a one-command
  SHA-256-verified download of the MIT-licensed MuseScore_General.sf3 into
  the engine's vendor dir, which is where the `node` music vendor looks by
  default; no env var needed. (`MOTION_STUDIO_SOUNDFONT` still overrides for
  a custom SoundFont, and `musicforge` honors it too.)
- **FluidSynth (standard profile):** `apt install fluidsynth` — `musicforge`
  falls back to the distro binary on PATH when the vendored Windows exe is
  absent (verified end to end on 24.04).
- **Speech vendor:** the default `system` vendor works on Linux since v0.26
  through `espeak-ng` (`sudo apt install espeak-ng`; zero-config scratch
  narration). For production narration install Piper via **pip only** —
  `pipx install piper-tts` — never the archived pre-2024 C++ release
  binaries, which ignore the engine's flags and exit 0 having written no
  audio (see `docs\tts-setup.md`). Note that pipx's bin directory varies
  (`PIPX_BIN_DIR`); resolve the real path with `command -v piper` before
  recording it in `MACHINE.md`. Music needs no extra install: the `node`
  vendor works everywhere a SoundFont exists.
- **Entry files (step 5):** `provision.mjs` detects the platform and emits
  bash-flavored guides automatically (`--os linux|macos|windows` to
  override).
- **Verification (step 8):** additionally run
  `node engine/test/smoke-speech-roundtrip.mjs` with the
  `MOTION_STUDIO_PIPER_*`/`_WHISPER_*` env hooks set — it proves speech and
  transcription against the real vendors in one shot.

## Updating an existing machine

- **App update:** `git pull` in `motion-studio`, `npm install` in `engine\`,
  re-run `provision.mjs` (refreshes both entry files), re-copy changed skills
  to agent skill directories.
- **Adding a tool:** drop the directory (with README) into the tools root, run
  its check, add it to `MACHINE.md`'s inventory. No entry-file edits.
- **Hardware/path changes:** update `MACHINE.md` only.
