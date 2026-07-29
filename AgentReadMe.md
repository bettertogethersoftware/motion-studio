# Motion Studio Agent Guide

Use this guide when handing this repository to another AI agent with MCP,
filesystem, and shell access. The agent may use Motion Studio MCP tools and
directly run the bundled FFmpeg and Whisper.cpp binaries.

## Read the root path from the environment

Before following any PowerShell example in this guide, agents must retrieve the
repository root from the `MotionStudioRoot` environment variable. Do not
hard-code or guess the repository path. Use the process value first, then the
user- and system-level Windows environment values, and validate the result:

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
```

The examples below use `$MotionStudioRoot`. MCP client configuration formats
require literal absolute paths, so replace every `<MOTION_STUDIO_ROOT>`
placeholder in the TOML example with this resolved value before saving it.

## Repository and data model

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
`<UNIQUE_AGENT_WORKSPACE>` with a unique name for this agent. Restart Codex or
start a new task after editing the config.

```toml
[mcp_servers.motion_studio]
command = "node"
args = ["<MOTION_STUDIO_ROOT>\\engine\\src\\mcp\\server.js"]
startup_timeout_sec = 120

[mcp_servers.motion_studio.env]
MOTION_STUDIO_WORKSPACE = "<UNIQUE_AGENT_WORKSPACE>"
MOTION_STUDIO_FFMPEG = "<MOTION_STUDIO_ROOT>\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe"
MOTION_STUDIO_WHISPER_BIN = "<MOTION_STUDIO_ROOT>\\whisper-bin-x64\\Release\\whisper-cli.exe"
MOTION_STUDIO_WHISPER_MODEL = "<MOTION_STUDIO_ROOT>\\whisper-bin-x64\\Release\\models\\ggml-small.en.bin"
MOTION_STUDIO_SOUNDFONT = "<MOTION_STUDIO_ROOT>\\data\\workspaces\\default\\library\\MuseScore_General.sf3"
```

If the MCP client cannot find `node`, replace `command = "node"` with the
result of `(Get-Command node).Source`. The SoundFont setting is optional; keep
it only when the referenced `.sf3` file exists.

`ggml-small.en.bin` is English-only. Install and select a multilingual Whisper
model before transcribing Japanese or other non-English speech.

For another MCP client, launch this exact stdio command and set the same
environment variables in that client's MCP configuration:

```text
node <repository-root>\engine\src\mcp\server.js
```

See `docs\mcp-setup.md` for the complete MCP tool reference.

## Stock images from Pexels

`PEXELS_API_KEY` is configured as a user environment variable on this machine.
If it is unavailable, tell the user that Pexels is not configured and ask them
to configure the environment variable; never ask them to paste the key into
chat or put it in a project file.
When a user asks for a Motion Studio video, treat Pexels as the default source
for **stock photography and real-world background imagery** when the brief
would benefit from it and the user has not supplied suitable visuals. Do not
use it as a substitute for a user's actual product, logo, person, or other
specific supplied asset; abstract or fully graphic treatments may not need
stock imagery at all.

Use the Pexels API to search for images that match the scene's subject, mood,
orientation, and aspect ratio. Download the chosen files locally rather than
putting Pexels/CDN URLs in a composition. Remote images can work in a preview
but make parallel renders unreliable.

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

For every Pexels image used in a film:

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

## Install the Motion Studio shell skill

Install the shell skill plus the Frame API reference in the target agent's skill
directory. On Codex for Windows, the skill directory is normally
`%USERPROFILE%\.codex\skills`.

Run the following commands from this repository root.

```powershell
$skill = Join-Path $env:USERPROFILE '.codex\skills\motion-studio-video-shell'
New-Item -ItemType Directory -Force -Path (Join-Path $skill 'references')
Copy-Item '.\docs\SKILL-shell.md' (Join-Path $skill 'SKILL.md') -Force
Copy-Item '.\docs\frame-api.md' (Join-Path $skill 'references\frame-api.md') -Force
```

Other AI products use different skill locations. Keep the same structure:
`SKILL.md` at the skill root and `references\frame-api.md` beside it.

## Direct full-access tools

When an agent has filesystem and shell access, it may use these local binaries
directly. Prefer MCP for Motion Studio documents; use direct tools for media
inspection, footage preparation, and verification when the agent environment
allows it.

### FFmpeg

```text
ffmpeg-8.1.2-full_build\bin\ffmpeg.exe
ffmpeg-8.1.2-full_build\bin\ffprobe.exe
ffmpeg-8.1.2-full_build\bin\ffplay.exe
```

PowerShell example:

```powershell
$ffmpeg = Join-Path $MotionStudioRoot 'ffmpeg-8.1.2-full_build\bin\ffmpeg.exe'
$ffprobe = Join-Path $MotionStudioRoot 'ffmpeg-8.1.2-full_build\bin\ffprobe.exe'

& $ffprobe -v error -show_format -show_streams input.mp4
& $ffmpeg -i input.mp4 -c:v libvpx-vp9 -c:a libopus prepared.webm
```

The bundled FFmpeg build can crash when using the `drawtext` filter because it
has no fontconfig support. Use HTML/CSS canvas text in Motion Studio instead.

### Auto-Editor

Use Auto-Editor to prepare supplied video footage by removing or speeding up
silent sections before it is added to a Motion Studio film. Resolve the
executable from the same root variable:

```powershell
$autoEditor = Join-Path $MotionStudioRoot 'auto-editor-windows-x86_64\auto-editor-windows-x86_64.exe'

# Review the proposed cuts first.
& $autoEditor input.mp4 --preview

# Create an edited copy; keep short pauses around spoken content.
& $autoEditor input.mp4 --margin 0.2s --output prepared.mp4
```

Inspect the output before using it. Silence can be intentional, so do not
blindly apply automatic cuts to interviews, narration, or timed footage.

### ImageMagick

Use ImageMagick to inspect and prepare still-image assets for Motion Studio,
such as resizing, cropping, or converting a Pexels image before it is placed
in a scene. Resolve the executable from the same root variable:

```powershell
$magick = Join-Path $MotionStudioRoot 'ImageMagick-7.1.2-Q16-HDRI\magick.exe'

# Inspect dimensions and metadata.
& $magick identify input.jpg

# Make a centred 1920×1080 cover image without distorting it.
& $magick input.jpg -resize '1920x1080^' -gravity center -extent 1920x1080 prepared.jpg
```

Write derived files to `data\temp` while preparing them, then add the final
image to the active scene or film's `assets/` folder (or workspace library)
before rendering.

### Whisper.cpp

```text
whisper-bin-x64\Release\whisper-cli.exe
whisper-bin-x64\Release\models\ggml-small.en.bin
```

Convert an input to Whisper-friendly mono WAV, then transcribe it:

```powershell
$ffmpeg = Join-Path $MotionStudioRoot 'ffmpeg-8.1.2-full_build\bin\ffmpeg.exe'
$whisper = Join-Path $MotionStudioRoot 'whisper-bin-x64\Release\whisper-cli.exe'
$model = Join-Path $MotionStudioRoot 'whisper-bin-x64\Release\models\ggml-small.en.bin'

& $ffmpeg -i input.mp4 -ar 16000 -ac 1 speech.wav
& $whisper -m $model -f speech.wav -l en -otxt -oj
```

This writes text and JSON transcript files beside `speech.wav`. For Japanese or
mixed-language speech, use a multilingual `ggml-small.bin` or larger model and
set the appropriate language instead of using the `.en` model.

## SFX restriction

Do not use `synthesize_sfx` cue types `chime`, `shimmer`, `whoosh`, or `thud`.
