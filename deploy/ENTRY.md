# Motion Studio Agent Guide

> **Generated file — do not edit.** `motion-studio\deploy\provision.mjs` writes
> this guide to the tools root as both `AGENTS.md` and `CLAUDE.md`. It is
> identical on every Motion Studio machine. Everything specific to *this*
> machine lives in `MACHINE.md` beside it; everything specific to a helper tool
> lives in that tool's own `README.md`. If this file disagrees with either of
> those, the more specific file wins.

Use this guide when driving this Motion Studio installation as an AI agent with
MCP, filesystem, and shell access. The agent may use Motion Studio MCP tools
and directly run the locally installed media tools.

## Where facts live

| layer | file | changes when |
|---|---|---|
| stable contract | this file | Motion Studio itself changes (regenerate, never hand-edit) |
| this machine | `MACHINE.md` (beside this file) | hardware, paths, models, or paid services change |
| each helper tool | `<tool>\README.md` | that tool changes |
| production knowledge | `<MOTION_STUDIO_ROOT>\docs\` | lessons are learned anywhere |

## Required Motion Studio orientation

Before performing any Motion Studio task, read
`<MOTION_STUDIO_ROOT>\docs\SKILL.md` completely and follow its workflow,
authoring contract, verification requirements, and error-handling guidance.

Read `<MOTION_STUDIO_ROOT>\docs\mcp-setup.md` before configuring,
troubleshooting, or directly using the Motion Studio MCP server. It is the
complete connection and MCP tool reference.

Before writing composition HTML, CSS, or JavaScript, also read
`<MOTION_STUDIO_ROOT>\docs\frame-api.md`.

Before producing a music video, beat-synced film, or anything that layers
generated audio, read `<MOTION_STUDIO_ROOT>\docs\production-lessons.md` — it
records the measured traps from previous productions so they are paid for once.

If Motion Studio concepts or capabilities are unfamiliar, consult the relevant
documents under `<MOTION_STUDIO_ROOT>\docs\` before acting. Start with
`user-guide.md`, `film-setup.md`, and `architecture.md`, then use the
capability-specific guides such as `tts-setup.md`, `music-setup.md`,
`transcribe-setup.md`, `sfx-setup.md`, or `3d-libraries.md`.

## Read the root path from the environment

Before following any PowerShell example in this guide, retrieve the repository
root from the `MotionStudioRoot` environment variable. Do not hard-code or
guess the repository path. Use the process value first, then the user- and
system-level Windows environment values, and validate the result:

```powershell
$MotionStudioRoot = $env:MotionStudioRoot
if ([string]::IsNullOrWhiteSpace($MotionStudioRoot)) {
  $MotionStudioRoot = [Environment]::GetEnvironmentVariable('MotionStudioRoot', 'User')
}
if ([string]::IsNullOrWhiteSpace($MotionStudioRoot)) {
  $MotionStudioRoot = [Environment]::GetEnvironmentVariable('MotionStudioRoot', 'Machine')
}
if ([string]::IsNullOrWhiteSpace($MotionStudioRoot)) {
  throw 'MotionStudioRoot is not configured. Ask the user to set it before continuing.'
}
if (-not (Test-Path (Join-Path $MotionStudioRoot 'engine\src\mcp\server.js'))) {
  throw "MotionStudioRoot does not point to a Motion Studio repository: $MotionStudioRoot"
}

# Helper tools and machine facts live beside the app repository.
$MotionStudioToolsRoot = Split-Path -Parent $MotionStudioRoot
if (-not (Test-Path (Join-Path $MotionStudioToolsRoot 'MACHINE.md'))) {
  throw "MACHINE.md was not found beside the repository. Run motion-studio\deploy\provision.mjs first: $MotionStudioToolsRoot"
}
```

The examples below use `$MotionStudioRoot` for the app, documents, workspaces,
and temporary assets, and `$MotionStudioToolsRoot` for the sibling tools.

## This machine: MACHINE.md

`MACHINE.md` at the tools root is the authority for everything
machine-specific: hardware (GPU model and VRAM — sizing decisions for ComfyUI
work come from here), the exact folder names and paths of the core media
binaries, Python interpreters and ComfyUI installations, which model weights
are installed, which paid services are signed in, and an inventory of the
helper tools present on this machine.

Any path in this guide or in a helper README that is written as an example —
a versioned folder name, a `C:\Users\...` path, a model file — must be
confirmed against `MACHINE.md` before use. If `MACHINE.md` and an example
disagree, `MACHINE.md` is right.

## Repository and data model

Skill location:

```text
<MOTION_STUDIO_ROOT>\docs\SKILL.md
<MOTION_STUDIO_ROOT>\docs\SKILL-shell.md
```

Motion Studio stores work as `workspace → film → scene`:

```text
data\workspaces\<workspace>\
  library\                         shared user-provided assets
  films\<film>\
    film.json
    assets\
    out\
    scenes\<scene>\                one renderable composition
```

Use the workspace library for large user-provided assets. Scene `out\` folders
hold render results; film `out\` folders hold assembled multi-scene films.

## Preferred: install the Motion Studio MCP server

The local MCP server is:

`engine\src\mcp\server.js`

It exposes workspace, film, scene, asset, music, preview, and render tools.
It is the preferred interface for new Motion Studio work because it enforces
the film/scene model and returns structured paths and render status.

Before configuring it, run this once from `engine\` if dependencies are not
already present:

```powershell
npm install
npm run doctor
```

### Codex on Windows

Add this to `%USERPROFILE%\.codex\config.toml`, replacing
`<UNIQUE_AGENT_WORKSPACE>` with a unique name for this agent and every path
placeholder with the literal absolute value recorded in `MACHINE.md` (MCP
client configuration formats require literal paths). Restart Codex or start a
new task after editing the config.

```toml
[mcp_servers.motion_studio]
command = "node"
args = ["<MOTION_STUDIO_ROOT>\\engine\\src\\mcp\\server.js"]
startup_timeout_sec = 120

[mcp_servers.motion_studio.env]
MOTION_STUDIO_WORKSPACE = "<UNIQUE_AGENT_WORKSPACE>"
MOTION_STUDIO_FFMPEG = "<FFMPEG_EXE from MACHINE.md>"
MOTION_STUDIO_WHISPER_BIN = "<WHISPER_CLI from MACHINE.md>"
MOTION_STUDIO_WHISPER_MODEL = "<WHISPER_MODEL from MACHINE.md>"
MOTION_STUDIO_SOUNDFONT = "<SOUNDFONT from MACHINE.md>"
```

If the MCP client cannot find `node`, replace `command = "node"` with the
result of `(Get-Command node).Source`. The SoundFont setting is optional; keep
it only when the referenced `.sf2`/`.sf3` file exists.

For another MCP client, launch this exact stdio command and set the same
environment variables in that client's MCP configuration:

```text
node <repository-root>\engine\src\mcp\server.js
```

See `docs\mcp-setup.md` for the complete MCP tool reference.

## Core media tools

Every Motion Studio machine has these four installed at the tools root. Their
folder names vary by version — resolve the exact paths from `MACHINE.md`
(shown here as `$ffmpeg`, `$ffprobe`, `$autoEditor`, `$magick`, `$whisper`,
`$whisperModel`).

### FFmpeg

```powershell
& $ffprobe -v error -show_format -show_streams input.mp4
& $ffmpeg -i input.mp4 -c:v libvpx-vp9 -c:a libopus prepared.webm
```

The bundled FFmpeg build can crash when using the `drawtext` filter because it
has no fontconfig support. Use HTML/CSS canvas text in Motion Studio instead.

### Auto-Editor

Use Auto-Editor to prepare supplied video footage by removing or speeding up
silent sections before it is added to a Motion Studio film:

```powershell
# Review the proposed cuts first.
& $autoEditor input.mp4 --preview

# Create an edited copy; keep short pauses around spoken content.
& $autoEditor input.mp4 --margin 0.2s --output prepared.mp4
```

Inspect the output before using it. Silence can be intentional, so do not
blindly apply automatic cuts to interviews, narration, or timed footage.

### ImageMagick

Use ImageMagick to inspect and prepare still-image assets — resizing,
cropping, or converting an image before it is placed in a scene.

**Always call `magick-portable.ps1`, never `magick.exe` directly, and never
re-wrap the wrapper in `cmd`, a `.bat`, or a `.cmd`.** The copy is a portable
"Modules" build that needs the wrapper's environment variables, and `cmd`
silently eats the caret in geometry arguments like `'1920x1080^'` while still
exiting 0 — the full failure analysis and the mandatory verification check are
in the `README.md` beside the wrapper. Read it before any ImageMagick work.

```powershell
& $magick identify input.jpg
& $magick input.jpg -resize '1920x1080^' -gravity center -extent 1920x1080 prepared.jpg

# Verification: must print 1920x1440. If it prints 1440x1080, the caret is being eaten.
& $magick input.jpg -resize '1920x1080^' -format '%wx%h' info:
```

Write derived files to `data\temp` while preparing them, then add the final
image to the active scene or film's `assets/` folder (or workspace library)
before rendering.

### Whisper.cpp

Convert an input to Whisper-friendly mono WAV, then transcribe it:

```powershell
& $ffmpeg -i input.mp4 -ar 16000 -ac 1 speech.wav
& $whisper -m $whisperModel -f speech.wav -l en -otxt -oj
```

This writes text and JSON transcript files beside `speech.wav`. `MACHINE.md`
lists the installed models; a multilingual `ggml-*.bin` handles Mandarin,
Japanese, or mixed-language speech with the appropriate `-l` language set,
while `.en` models are English-only.

## Helper tools: discover, then read, then use

Beyond the core four, the tools root contains zero or more optional helper
directories. **What is installed varies per machine — never assume a helper
exists.** Before using any helper:

1. Check `MACHINE.md`'s installed-helper inventory, or confirm the directory
   exists.
2. Read that helper's `README.md` completely. It is the authoritative and
   *only* usage guide — commands, prerequisites, presets, measured timings,
   known failures, and current limitations all live there, so installing or
   updating a helper never requires editing this file.
3. Resolve machine-specific values it needs (Python interpreter, model paths,
   GPU batch sizing) from `MACHINE.md`.

Helper families that may be present (non-exhaustive — the inventory in
`MACHINE.md` is the actual list):

| helper | what it is for |
|---|---|
| `comfyui\` | local ComfyUI image generation and editing (plus a paid Wan video partner helper) |
| `comfyui_music\` | generated soundtrack audio (ACE-Step, Stable Audio 3) |
| `comfyui_upscaling\` | Real-HAT GAN video upscaling |
| `comfyui_video\` | local video generation workflows |
| `videoforge\` | building a beat-locked cut around long recordings |
| `musicforge\` | composing an instrumental score with an exported accent map |
| `verticalforge\` | converting a finished landscape master to a portrait deliverable |
| `youtube\` | uploading finished deliverables to the configured YouTube account |

A customer- or machine-specific helper not in this table follows the same
rule: its directory has a `README.md`, and that README is the guide.

## The generative boundary

Motion Studio's engine owns **deterministic, timing-coupled** audio and
ingestion: `synthesize_speech`, `synthesize_music` (note-spec), and
`synthesize_sfx` return frame-accurate timing; `transcribe_asset` and
`probe_asset` measure what a supplied file actually contains. Generative
models — ComfyUI image, music, and video helpers — are **agent-side tools**:
generate outside the engine, measure and audition the result, and bring the
chosen take into a film as an asset (`write_asset_file`, `use_shared_asset`).
Do not integrate generative helpers as engine vendors, wrap them in MCP tools,
or call them per-frame; their outputs are authoring-time inputs that require
an agent's measure-and-regenerate loop before they are usable.

The inverse also holds: **narration goes through the engine, not through an
external TTS call.** Cloud speech belongs inside as a configured TTS vendor
(Azure, ElevenLabs, OpenAI, Deepgram — see `docs\tts-setup.md`); generating
speech agent-side discards `synthesize_speech`'s frame-accurate `timings` and
forces a `transcribe_asset` round-trip to recover what the engine reports for
free.

## Stock images from Pexels

`MACHINE.md` records whether `PEXELS_API_KEY` is configured as a user
environment variable on this machine. If it is unavailable, tell the user that
Pexels is not configured and ask them to configure the environment variable;
never ask them to paste the key into chat or put it in a project file.

When a user asks for a Motion Studio video, treat Pexels as the default source
for **stock photography and real-world background imagery** when the brief
would benefit from it and the user has not supplied suitable visuals. Do not
use it as a substitute for a user's actual product, logo, person, or other
specific supplied asset; abstract or fully graphic treatments may not need
stock imagery at all.

Use the Pexels API to search for images that match the scene's subject, mood,
orientation, and aspect ratio. Download the chosen files locally rather than
putting Pexels/CDN URLs in a composition — remote images can work in a preview
but make parallel renders unreliable. For every Pexels image used in a film:

1. Save it under the active workspace library, for example
   `<workspace>\library\pexels\`, using a descriptive filename that includes
   the Pexels photo ID.
2. Keep the Pexels page URL and photographer alongside the asset (for example,
   in a small `sources.md` file) so the source can be revisited and credited
   when desired.
3. Bring it into the scene or film with `use_shared_asset` (or place a small
   file directly under that target's `assets/`), then reference only the local
   `assets/...` path from the composition.
4. Preload each image before calling `MotionStudio.registerComposition`, and
   inspect preview frames to confirm that it is correctly cropped, visible,
   and relevant to the user's request.

Never commit `PEXELS_API_KEY`, copy it into project files, or show it in logs.
Follow the current Pexels licence and API terms for every download.

### Temporary asset staging

Agents with filesystem access may use the path below as a local staging area
for **any** asset, including Pexels downloads, user media, generated images,
and intermediate conversions:

```powershell
$MotionStudioTemp = Join-Path $MotionStudioRoot 'data\temp'
```

Before a render, copy or link every asset the composition needs into the active
scene or film's `assets/` folder (or its workspace library); never reference
files in `data\temp` directly from a composition.

However if you have access to Motion Studio, you may directly copy data to
`<MOTION_STUDIO_ROOT>\data\workspaces\{workspace}\library` (the default
`{workspace}` is `default`).

## Install the Motion Studio shell skill

Install the shell skill plus the Frame API reference in the target agent's
skill directory. On Codex for Windows, the skill directory is normally
`%USERPROFILE%\.codex\skills`.

```powershell
$skill = Join-Path $env:USERPROFILE '.codex\skills\motion-studio-video-shell'
New-Item -ItemType Directory -Force -Path (Join-Path $skill 'references')
Copy-Item (Join-Path $MotionStudioRoot 'docs\SKILL-shell.md') (Join-Path $skill 'SKILL.md') -Force
Copy-Item (Join-Path $MotionStudioRoot 'docs\frame-api.md') (Join-Path $skill 'references\frame-api.md') -Force
```

Other AI products use different skill locations. Keep the same structure:
`SKILL.md` at the skill root and `references\frame-api.md` beside it.

Skills are copies: after `docs/SKILL.md` or `docs/SKILL-shell.md` changes in
the repository, re-copy them to every client skill directory.

## Restart the MCP server after changing the engine

The Motion Studio MCP server loads `engine/src` once at startup. Editing the
engine mid-session does **not** affect the running tools — a fix will look
inert, and you will "work around" a bug that is already fixed on disk. Either
restart the server, or call the engine module directly with `node` for
verification.

## SFX restriction

Do not use `synthesize_sfx` cue types `chime`, `shimmer`, `whoosh`, or `thud`.
