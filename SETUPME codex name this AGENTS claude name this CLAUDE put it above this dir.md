# Motion Studio Agent Guide

Use this guide when handing this repository to another AI agent with MCP,
filesystem, and shell access. The agent may use Motion Studio MCP tools and
directly run the bundled FFmpeg and Whisper.cpp binaries.

## Required Motion Studio orientation

Before performing any Motion Studio task, read
`<MOTION_STUDIO_ROOT>\docs\SKILL.md` completely and follow its workflow,
authoring contract, verification requirements, and error-handling guidance.

Read `<MOTION_STUDIO_ROOT>\docs\mcp-setup.md` before configuring,
troubleshooting, or directly using the Motion Studio MCP server. It is the
complete connection and MCP tool reference.

Before writing composition HTML, CSS, or JavaScript, also read
`<MOTION_STUDIO_ROOT>\docs\frame-api.md`.

If Motion Studio concepts or capabilities are unfamiliar, consult the relevant
documents under `<MOTION_STUDIO_ROOT>\docs\` before acting. Start with
`user-guide.md`, `film-setup.md`, and `architecture.md`, then use the
capability-specific guides such as `tts-setup.md`, `music-setup.md`,
`transcribe-setup.md`, `sfx-setup.md`, or `3d-libraries.md`.

Read the `README.md` beside every local helper before using it; those files
contain the helper-specific commands, prerequisites, and current limitations.

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

# The bundled media and generation tools are stored beside the app repository.
$MotionStudioToolsRoot = Split-Path -Parent $MotionStudioRoot
if (-not (Test-Path (Join-Path $MotionStudioToolsRoot 'ffmpeg-8.1.2-full_build\bin\ffmpeg.exe'))) {
  throw "Motion Studio bundled tools were not found beside the repository: $MotionStudioToolsRoot"
}
```

The examples below use `$MotionStudioRoot` for the app, documents, workspaces,
and temporary assets, and `$MotionStudioToolsRoot` for the sibling tool bundle.
MCP client configuration formats require literal absolute paths, so replace
every `<MOTION_STUDIO_ROOT>` and `<MOTION_STUDIO_TOOLS_ROOT>` placeholder in the
TOML example with the corresponding resolved value before saving it.

## Repository and data model

Skill location
<MOTION_STUDIO_ROOT>\docs\SKILL.md
<MOTION_STUDIO_ROOT>\docs\SKILL-shell.md

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
MOTION_STUDIO_FFMPEG = "<MOTION_STUDIO_TOOLS_ROOT>\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe"
MOTION_STUDIO_WHISPER_BIN = "<MOTION_STUDIO_TOOLS_ROOT>\\whisper-bin-x64\\Release\\whisper-cli.exe"
MOTION_STUDIO_WHISPER_MODEL = "<MOTION_STUDIO_TOOLS_ROOT>\\whisper-bin-x64\\Release\\models\\ggml-small.bin"
MOTION_STUDIO_SOUNDFONT = "<MOTION_STUDIO_ROOT>\\data\\workspaces\\default\\library\\MuseScore_General.sf3"
```

If the MCP client cannot find `node`, replace `command = "node"` with the
result of `(Get-Command node).Source`. The SoundFont setting is optional; keep
it only when the referenced `.sf3` file exists.

The configured `ggml-small.bin` model is multilingual. Keep
`ggml-small.en.bin` only as an optional English-specific alternative.

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
Copy-Item (Join-Path $MotionStudioRoot 'docs\SKILL-shell.md') (Join-Path $skill 'SKILL.md') -Force
Copy-Item (Join-Path $MotionStudioRoot 'docs\frame-api.md') (Join-Path $skill 'references\frame-api.md') -Force
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
<MOTION_STUDIO_TOOLS_ROOT>\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe
<MOTION_STUDIO_TOOLS_ROOT>\ffmpeg-8.1.2-full_build\bin\ffprobe.exe
<MOTION_STUDIO_TOOLS_ROOT>\ffmpeg-8.1.2-full_build\bin\ffplay.exe
```

PowerShell example:

```powershell
$ffmpeg = Join-Path $MotionStudioToolsRoot 'ffmpeg-8.1.2-full_build\bin\ffmpeg.exe'
$ffprobe = Join-Path $MotionStudioToolsRoot 'ffmpeg-8.1.2-full_build\bin\ffprobe.exe'

& $ffprobe -v error -show_format -show_streams input.mp4
& $ffmpeg -i input.mp4 -c:v libvpx-vp9 -c:a libopus prepared.webm
```

The bundled FFmpeg build can crash when using the `drawtext` filter because it
has no fontconfig support. Use HTML/CSS canvas text in Motion Studio instead.

### Auto-Editor

Use Auto-Editor to prepare supplied video footage by removing or speeding up
silent sections before it is added to a Motion Studio film. Resolve the
executable from the tools root:

```powershell
$autoEditor = Join-Path $MotionStudioToolsRoot 'auto-editor-windows-x86_64\auto-editor-windows-x86_64.exe'

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
in a scene. Resolve the executable from the tools root:

```powershell
$magick = Join-Path $MotionStudioToolsRoot 'ImageMagick-7.1.2-Q16-HDRI\magick.exe'

# Inspect dimensions and metadata.
& $magick identify input.jpg

# Make a centred 1920×1080 cover image without distorting it.
& $magick input.jpg -resize '1920x1080^' -gravity center -extent 1920x1080 prepared.jpg
```

Write derived files to `data\temp` while preparing them, then add the final
image to the active scene or film's `assets/` folder (or workspace library)
before rendering.

### ComfyUI image generation

Note: generate.py will generate a completely different image each time you call it. In order to generate the same object consistently, you have to generate different angles in a large grid image, and then cut them out. So if you want to create an animation of a car in a city, you will have to generate the background and place the different objects you cut out to animate it. This is just one of technique only, you do not have to follow it.

Use `comfyui\generate.py` to generate still image assets — plates, backgrounds,
textures, lifestyle context — through a local ComfyUI. It prints one JSON object
per call and needs no Python packages beyond the standard library:

```powershell
$gen = Join-Path $MotionStudioToolsRoot 'comfyui\generate.py'

# Reachable? Starts a headless ComfyUI if nothing is listening.
python $gen check

# One image, 16:9, written where you ask.
python $gen image --prompt "a calm modern clinic waiting room, soft daylight" `
    --aspect 16:9 --out (Join-Path $MotionStudioTemp 'clinic.png')

# Four candidates to choose between.
python $gen image --prompt "..." --batch 4 `
    --out-dir (Join-Path $MotionStudioTemp 'plates')

# Anything that must contain readable words needs the Qwen preset.
python $gen image --preset qwen-image-fast `
    --prompt 'a white product box labelled "YUVNICE" and "BP-814", studio lighting' `
    --out (Join-Path $MotionStudioTemp 'box.png')
```

Four verified presets: `z-image-turbo` (default, 13–20 s), `z-image`,
`qwen-image-fast` (~85 s, **the one that renders legible text**) and `qwen-image`.
The base helper uses ComfyUI 0.22.3, where the installed `ideogram4_*` weights
remain unsupported; `python $gen models` correctly reports that limitation.
For local Ideogram generation use the dedicated `generate_ideogram4.py` helper
below, which selects the newer ComfyUI 0.29 runtime.

**Authoring-time only — never per frame.** Independently generated frames flicker,
which breaks the pure-function-of-`n` frame contract. Generated images are inputs a
composition animates.

Two rules the tool cannot enforce for you. A generated product is **not** the
client's product — generate the context and composite the real supplier photo in.
And generated people need human review: extra fingers pass every automated check
and are unusable in client work.

To change an image you already have, use the companion `comfyui\img2img.py`:

```powershell
$edit = Join-Path $MotionStudioToolsRoot 'comfyui\img2img.py'

# Remove a supplier's burned-in graphic instead of cropping around it.
python $edit inpaint `
    --in (Join-Path $MotionStudioTemp 'p5.jpg') `
    --out (Join-Path $MotionStudioTemp 'p5_clean.png') `
    --mask-rect-pct 0.50,0.13,0.49,0.29 `
    --prompt "plain bright interior wall, soft window light, no text"
```

Modes are `inpaint`, `img2img` and `outpaint`. Inpaint and outpaint leave every
unmasked source pixel byte-identical — ComfyUI returns VAE-aligned sizes, so the
tool composites back at the original resolution rather than letting one edited
corner resample the whole photo.

Full options, idempotency, exit codes, presets and measured timings:
[comfyui/README.md](comfyui/README.md).

### ComfyUI Qwen Image 2512 generation

Use `comfyui\generate_qwen.py` for a dedicated, clean Qwen Image pipeline. It
loads `qwen_image_2512_fp8_e4m3fn.safetensors` with the
`qwen_2.5_vl_7b_fp8_scaled.safetensors` encoder, `qwen_image` CLIP type, and
`qwen_image_vae.safetensors`. It is fully local and does not need API credits:

```powershell
$qwen = Join-Path $MotionStudioToolsRoot 'comfyui\generate_qwen.py'

python $qwen check
python $qwen models

# Four-step Lightning mode (default).
python $qwen image --mode fast `
    --prompt "original science-fantasy anime party beneath a violet moon" `
    --aspect 9:16 --out (Join-Path $MotionStudioTemp 'qwen-fast.png')

# Twenty-step model without the Lightning LoRA.
python $qwen image --mode quality `
    --prompt "original science-fantasy anime party beneath a violet moon" `
    --aspect 9:16 --out (Join-Path $MotionStudioTemp 'qwen-quality.png')
```

The helper supports seeded batches, custom dimensions divisible by 16,
idempotency sidecars, sampler overrides, and `--force`.

### ComfyUI Ideogram 4.0 generation

Use `comfyui\generate_ideogram4.py` for the local Ideogram 4 workflow. It uses
the separate conditional and unconditional diffusion weights, asymmetric
dual-model guidance, `Ideogram4Scheduler`, Qwen3-VL 8B conditioning, and the
Flux 2 VAE from ComfyUI's installed reference workflow:

```powershell
$ideogram = Join-Path $MotionStudioToolsRoot 'comfyui\generate_ideogram4.py'
$caption = Join-Path $MotionStudioTemp 'ideogram4-prompt.json'

python $ideogram check
python $ideogram models

$json = @'
{"high_level_description":"A premium science-fiction poster with one exact headline: STAR VOYAGE.","style_description":{"aesthetics":"cinematic, clean, dramatic","lighting":"violet planetary glow and silver rim light","medium":"graphic_design","art_style":"retro-futurist travel poster with precise bold typography","color_palette":["#09051F","#6E35C9","#C8B7FF","#F4F1FF"]},"compositional_deconstruction":{"background":"Deep indigo space with a luminous violet planet. No logos, signatures, watermarks, or other writing.","elements":[{"type":"obj","bbox":[250,70,850,900],"desc":"A sleek silver starship flying upward toward the planet."},{"type":"text","bbox":[65,80,245,920],"text":"STAR VOYAGE","desc":"The only text: a large uppercase geometric sans-serif headline centered across the top."}]}}
'@
[System.IO.File]::WriteAllText($caption, $json)

python $ideogram image --mode turbo --prompt-file $caption `
    --aspect 9:16 --out (Join-Path $MotionStudioTemp 'ideogram4-poster.png')
```

Modes are `turbo` (12 steps), `default` (20), and `quality` (48). Use structured
Ideogram JSON with `--prompt-file` for production work. Plain text is accepted,
but it has a high false-positive safety-filter rate because Ideogram 4 was
trained on structured captions. The required composition object contains
`background` and `elements`; text elements carry the exact words in `text` and
may use normalized `[y_min,x_min,y_max,x_max]` bounding boxes.

The two diffusion weights, `qwen3vl_8b_fp8_scaled.safetensors` text encoder, and
`flux2-vae.safetensors` are installed and visible to ComfyUI 0.29. The helper
still validates every component before rendering rather than substituting
incompatible Qwen or Z-Image components. A local 512×512 Turbo smoke test
completed in 149.79 seconds and rendered `STAR VOYAGE` exactly.

### ComfyUI Krea 2 local generation and Wan partner generation

`generate_krea2.py` uses the locally installed open Krea 2 weights. On this
machine they live under `C:\Users\jerry\ComfyUI-Shared\models`, and the helper
uses the newer ComfyUI 0.29 checkout under `C:\Users\jerry\ComfyUI-Installs`.
It does not need account sign-in, API credits, or `--confirm-cost`.

`generate_wan.py` is different: no local Wan diffusion model is installed, so it
uses ComfyUI's paid Wan partner node. Its free `check` and `models` commands
confirm that the node is available. A video command prints its estimated USD
cost and exits without submitting until `--confirm-cost` is explicitly added:

```powershell
$krea = Join-Path $MotionStudioToolsRoot 'comfyui\generate_krea2.py'
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\generate_wan.py'

python $krea check
python $krea models
python $krea image `
    --prompt "original cinematic fantasy party facing a colossal crystal guardian" `
    --model turbo --aspect 9:16 `
    --out (Join-Path $MotionStudioTemp 'krea2-party.png')

python $wan check
python $wan models
python $wan video `
    --prompt "original anime fantasy heroes charge a crystal guardian, vertical cinematic shot" `
    --model wan2.6-t2v --resolution 720p --aspect 9:16 --duration 5 `
    --out (Join-Path $MotionStudioTemp 'wan-battle.mp4')
```

For Wan, review the printed estimate and rerun the same command with
`--confirm-cost` to authorize submission. ComfyUI must be signed in with partner
API credits. Do not add `--confirm-cost` on another user's behalf without their
approval. The local Krea helper writes PNG files; the Wan helper writes H.264 MP4
files and reports their measured duration, dimensions, codec, frame rate, and
audio presence. Both write idempotency sidecars beside successful outputs.

### ComfyUI music generation

Use `comfyui_music\generate_music.py` for higher-quality generated soundtrack
assets through the local, native ACE-Step 1.5 ComfyUI workflow. Like the image
helper, it prints one JSON result, starts ComfyUI when needed, and writes an
idempotency sidecar beside every output:

```powershell
$musicGen = Join-Path $MotionStudioToolsRoot 'comfyui_music\generate_music.py'

python $musicGen check

python $musicGen music `
    --prompt "original cinematic fantasy orchestral score, grief becoming resolve, instrumental" `
    --duration 60 --bpm 112 --key "D minor" `
    --out (Join-Path $MotionStudioTemp 'score.wav')
```

ACE-Step durations are 10–600 seconds. Generated audio is an authoring-time
asset: audition it, then copy the chosen file into the active film's `assets/`
folder and run Motion Studio's audio preview before rendering.

For a song, pass the words separately with `--lyrics` and select the language:

```powershell
$lyrics = @'
[Verse]
黑夜燃烧，星光在呼唤

[Chorus]
我们再出发，穿过风和火
'@

python $musicGen music `
    --prompt "original Mandarin symphonic metal rock, distorted guitars, cinematic choir, clear Mandarin diction" `
    --lyrics $lyrics --language zh --duration 60 --bpm 148 --key "D minor" `
    --out (Join-Path $MotionStudioTemp 'mandarin-metal.wav')
```

Instrumental and vocal examples, batch generation, sidecars, output
measurements, environment overrides, and troubleshooting:
[comfyui_music/README.md](comfyui_music/README.md).

### Whisper.cpp

```text
<MOTION_STUDIO_TOOLS_ROOT>\whisper-bin-x64\Release\whisper-cli.exe
<MOTION_STUDIO_TOOLS_ROOT>\whisper-bin-x64\Release\models\ggml-small.en.bin
<MOTION_STUDIO_TOOLS_ROOT>\whisper-bin-x64\Release\models\ggml-small.bin
```

Convert an input to Whisper-friendly mono WAV, then transcribe it:

```powershell
$ffmpeg = Join-Path $MotionStudioToolsRoot 'ffmpeg-8.1.2-full_build\bin\ffmpeg.exe'
$whisper = Join-Path $MotionStudioToolsRoot 'whisper-bin-x64\Release\whisper-cli.exe'
$model = Join-Path $MotionStudioToolsRoot 'whisper-bin-x64\Release\models\ggml-small.en.bin'

& $ffmpeg -i input.mp4 -ar 16000 -ac 1 speech.wav
& $whisper -m $model -f speech.wav -l en -otxt -oj
```

This writes text and JSON transcript files beside `speech.wav`. The installed
`ggml-small.bin` is multilingual: use it for Mandarin, Japanese, or mixed-language
speech and set the appropriate language instead of using the `.en` model.

### youtube upload
The uploader is configured for the user's account. Resolve it from the tools
root instead of using a machine-specific absolute path:

```powershell
$youtubeTools = Join-Path $MotionStudioToolsRoot 'youtube'
$youtubeUploader = Join-Path $youtubeTools 'upload_to_youtube.py'
```


## SFX restriction

Do not use `synthesize_sfx` cue types `chime`, `shimmer`, `whoosh`, or `thud`.
