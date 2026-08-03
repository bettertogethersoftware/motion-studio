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

However if you have an access to Motion Studio, You may directly copy data to <MOTION_STUDIO_ROOT>\data\workspaces\{workspace}\library (default {workapcespace} is default)

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
in a scene.

**Always call `magick-portable.ps1`, never `magick.exe` directly.** This copy of
ImageMagick was unpacked rather than installed, and it is a "Modules" build, so
`magick.exe` on its own cannot locate its coder DLLs or its `*.xml` config —
every format fails with `NoDecodeDelegateForThisImageFormat`. The wrapper sits
next to `magick.exe`, sets the four required environment variables, forwards all
arguments unchanged, and returns ImageMagick's own exit code.

```powershell
$magick = Join-Path $MotionStudioToolsRoot 'ImageMagick-7.1.2-Q16-HDRI\magick-portable.ps1'

# Inspect dimensions and metadata.
& $magick identify input.jpg

# Make a centred 1920×1080 cover image without distorting it.
& $magick input.jpg -resize '1920x1080^' -gravity center -extent 1920x1080 prepared.jpg
```

Call the wrapper from PowerShell. **Do not re-wrap it in `cmd /c`, a `.bat`, or a
`.cmd`, and do not "simplify" it into one** — this was tried first and it fails
silently:

- `cmd` re-parses the forwarded argument list (`%*`) and strips the caret in
  geometry arguments such as `'1920x1080^'`.
- That turns a fill-crop into a fit, so the image is letterboxed with padding
  instead of filling the frame — **and the exit code is still 0**.
- Measured through a `.cmd` wrapper, both `-resize '1920x1080^'` and
  `-resize '1920x1080'` returned `1440x1080`. Through the PowerShell wrapper
  they correctly differ: `1920x1440` and `1440x1080`.

PowerShell passes arguments to a native binary as an array with no second round
of parsing, which is the only reason the wrapper is a `.ps1`. Because the
failure is silent, ordinary smoke tests do not catch it. If you ever change how
arguments reach `magick.exe`, verify with this specific check rather than by
confirming the command merely succeeds:

```powershell
# Must print 1920x1440. If it prints 1440x1080, the caret is being eaten.
& $magick input.jpg -resize '1920x1080^' -format '%wx%h' info:
```

Write derived files to `data\temp` while preparing them, then add the final
image to the active scene or film's `assets/` folder (or workspace library)
before rendering.

### ComfyUI image generation

Note: generate.py will generate a completely different image each time you call it. 
In order to generate the same object consistently, you have to generate different angles in a large grid image,
and then cut them out. So if you want to create an animation of a car in a city, you will have to generate the
background and place the different objects you cut out to animate it. This is just one of technique only,
you do not have to follow it.

For a **person** who must look the same in many shots, use "Keeping one
character the same across shots" below instead — it is simpler than the grid
and keeps every image at full resolution.

You will need to blur any words in any languages, because all of our image generation models have an issue with words 
(e.g. if you try to generate English, it will not generate words correctly)

Use `comfyui\generate.py` to generate still image assets — plates, backgrounds,
textures, lifestyle context — through a local ComfyUI. It prints one JSON object
per call and needs no Python packages beyond the standard library:

```powershell
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'

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
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'

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

### Keeping one character the same across shots

`generate.py` invents a new person every call. To get the *same* character in
ten different shots, follow these six steps. Cheap, no extra tools, good
enough for fast-cut video. (Verified on a 16-shot music video.)

**1. Write the character once, and paste that exact text into every prompt.**
Never reword it between shots. Only the scene half of the prompt changes.

```text
<NAME>, a <age>-year-old <nationality> <man|woman>: <face shape>,
<eye colour + shape>, <eyebrows>, <ONE rare mark>, <hair colour + exact cut>,
<ONE rare accessory — say which side>, <build>, <exact outfit>
```

**2. Include two or three RARE details.** These do the real work. Vague words
like "handsome" lock nothing. Good anchors:

- a small mole under his **left** eye
- platinum-silver undercut with dark roots
- one silver hoop earring in his **left** ear

**3. Change `--seed` on every shot; never change the description.** The seed
varies pose and framing; the description holds the person. Reusing a seed just
gives you the same picture again.

**4. Use the same `--preset` for every shot.** Switching preset changes the face.

**5. Put the outfit in the description too**, or the clothes change between shots.

```powershell
$who = "Jin Park, a 24-year-old South Korean male idol: sharp jawline, dark brown monolid eyes, a small mole under his left eye, platinum-silver undercut with dark roots, one silver hoop earring in his left ear, black leather jacket over a white tee"
$neg = "text, watermark, extra fingers, deformed hands, two people, duplicate face, blurry"

python $gen image --preset z-image-turbo --seed 101 --aspect 16:9 --negative $neg `
    --prompt "$who standing in a rain-slick Seoul alley at night, neon signs behind him" `
    --out (Join-Path $MotionStudioTemp 'shot-alley.png')

python $gen image --preset z-image-turbo --seed 102 --aspect 16:9 --negative $neg `
    --prompt "$who on a rooftop at night, city skyline behind him" `
    --out (Join-Path $MotionStudioTemp 'shot-roof.png')
```

**6. Open and look at every image.** This gives a strong resemblance, NOT a
locked identity. These failures are common — expect two or three regeneration
passes:

| What you see | Fix |
|---|---|
| Eye colour changed | State the colour in the description; add the wrong colour to `--negative` |
| Wrong clothes | State the outfit in the description |
| A second person appeared | Say "exactly one person"; add `two people` to `--negative` |
| Coloured light painted on the face like makeup | Describe the light *source*, not the effect: "hard cyan light from far camera-left", not "cyan rim light" |
| Extra or bent fingers | Regenerate, or pick a framing with no visible hands |

When a shot fails, tighten the description and regenerate only that shot.
Keep the tightened wording for all later shots.

**If you need a truly locked identity** — a recurring character, or tight
close-ups where drift shows — this method is not enough. Escalate to
`comfyui\img2img.py img2img --strength 0.4` starting from one approved image:
it keeps the face and changes the surroundings.

### ComfyUI Qwen Image 2512 generation

Use `comfyui\generate_qwen.py` for a dedicated, clean Qwen Image pipeline. It
loads `qwen_image_2512_fp8_e4m3fn.safetensors` with the
`qwen_2.5_vl_7b_fp8_scaled.safetensors` encoder, `qwen_image` CLIP type, and
`qwen_image_vae.safetensors`. It is fully local and does not need API credits:

```powershell
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'

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
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'
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

`generate_video_wan.py` is different: no local Wan diffusion model is installed, so it
uses ComfyUI's paid Wan partner node. Its free `check` and `models` commands
confirm that the node is available. A video command prints its estimated USD
cost and exits without submitting until `--confirm-cost` is explicitly added:

```powershell
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'

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
$wan = Join-Path $MotionStudioToolsRoot 'comfyui\\generate_video_wan.py'

python $musicGen check

python $musicGen music `
    --prompt "original cinematic fantasy orchestral score, grief becoming resolve, instrumental" `
    --duration 60 --bpm 112 --key "D minor" `
    --out (Join-Path $MotionStudioTemp 'score.wav')
```

ACE-Step durations are 10–600 seconds. Generated audio is an authoring-time
asset: audition it, then copy the chosen file into the active film's `assets/`
folder and run Motion Studio's audio preview before rendering.

### Stable Audio 3 Medium (AI-only agent procedure)

Use this section only as machine-operational guidance. Stable Audio 3 is a
separate native ComfyUI workflow; do not substitute the ACE-Step helper or the
Stable Audio 3 Base blueprint unless the task explicitly asks for prompt
rewriting with its additional Qwen encoder.

The exact helper is:

```powershell
$stableAudio3 = Join-Path $MotionStudioToolsRoot 'comfyui_music\generate_music_stable_audio3.py'
```

The canonical shared model files must be present at:

```text
C:\Users\jerry\ComfyUI-Shared\models\checkpoints\stable_audio_3_medium.safetensors
C:\Users\jerry\ComfyUI-Shared\models\text_encoders\t5gemma_b_b_ul2.safetensors
```

Preflight and verify the installation before submitting a generation:

```powershell
python $stableAudio3 check
python $stableAudio3 models
python $stableAudio3 verify
```

The `verify` command must report `ok: true`; it checks the official SHA-256
values and the text-encoder byte count. The helper verifies both files again
before `music` submits a graph. The graph uses `CheckpointLoaderSimple`, the
`stable_audio` `CLIPLoader` type, two `CLIPTextEncode` nodes, `EmptyLatentAudio`,
the Stable Audio 3 sampler defaults (`8` steps, CFG `1`, `lcm`/`simple`),
`VAEDecodeAudio`, and `SaveAudio`.

Use direct prompts with the Medium checkpoint. Keep the first run short on the
10 GiB RTX 3080, then increase duration only after a successful result:

```powershell
python $stableAudio3 music `
    --prompt "instrumental cinematic ambient score, warm strings, restrained percussion, gradual lift" `
    --duration 30 --seed 1234 `
    --out (Join-Path $MotionStudioTemp 'stable-audio3-test.flac')
```

Stable Audio 3 Medium is intended for up to 380 seconds; enforce that limit in
calls. The helper accepts `.flac` directly or converts to `.wav` with the
configured FFmpeg. It writes a `.gen.json` sidecar; copy the selected output
into the active film `assets\` folder before using it in a Motion Studio film,
then run the normal audio preview and final media verification. Generated
Stable Audio 3 output is instrumental in this helper; use ACE-Step when the
task requires its lyrics/vocal controls.

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


## Reusable agent tooling: videoforge and musicforge

Two local toolkits built while producing a music video from a 6:44 gameplay
capture. They exist to save a later agent the expensive discoveries, not just
the typing. Standard-library Python 3 plus the bundled FFmpeg — nothing to
install.

```powershell
$videoforge = Join-Path $MotionStudioToolsRoot 'videoforge'
$musicforge = Join-Path $MotionStudioToolsRoot 'musicforge'
```

Read [videoforge/README.md](videoforge/README.md) and
[musicforge/README.md](musicforge/README.md) before using either.

### videoforge — build a cut around a long recording

| tool | answers |
|---|---|
| `shotfinder.py` | where in this long recording is anything worth cutting? |
| `audiogrid.py` | what is this track's real beat grid, and does it hold? |
| `cuekit.py` | place one-shot cues on that grid, and prove they are audible |
| `cutkit.py` | compile the whole cut as one beat-locked ffmpeg graph |

```powershell
# 1. Rank moments by motion energy, then LOOK at them. A shortlist is not a
#    decision: the top-ranked moment can be a loading screen or a menu.
python $videoforge\shotfinder.py scan  raw.mp4 --top 40 --min-gap 4
python $videoforge\shotfinder.py sheet raw.mp4 --times 4.3,51,64.5 --out picks.png

# 2. Measure the music BEFORE designing the cut.
python $videoforge\audiogrid.py grid     take-a.wav take-b.wav
python $videoforge\audiogrid.py envelope take-a.wav      # -> section boundaries
python $videoforge\audiogrid.py drift    spine.wav layer.wav

# 3. Place one-shot cues (impacts, risers, SFX) on that grid, then prove they
#    survived the mix. Do NOT place a cue by its file start — see below.
python $videoforge\cuekit.py measure "cues\*.wav"
python $videoforge\cuekit.py plan song.wav plan.json > planned.json
python $videoforge\cuekit.py verify song.wav mixed.wav planned.json

# 4. Write a JSON edit spec, then compile it in one encode.
python $videoforge\cutkit.py effects
python $videoforge\cutkit.py build myfilm.editspec.json --dry
python $videoforge\cutkit.py build myfilm.editspec.json
```

`cutkit build` prints the **measured** frame count to declare in
`update_film { footage, durationInFrames }`. The encoded body is routinely one
to four frames shorter than the sum of the shot lengths; declaring the intended
number earns `footage_duration_mismatch`.

**`audiogrid drift` had two bugs, fixed 2026-08-03 — distrust older
conclusions.** Its onset envelope rate was tied to the file's sample rate, and
it indexed file B with A's rate, so every comparison between files of
*different* sample rates was scaled ~8% wrong. That is the normal pairing here:
**ACE-Step writes 48 kHz, Stable Audio 3 writes 44.1 kHz.** On the same pair,
`corr` went from 0.054-0.071 (noise — "these don't correlate") to **0.407-0.565**
after the fix. It also crashed outright when B was shorter than A. Read the new
`comparable` field before `driftSec`: below ~0.2 correlation the lag is an
arbitrary peak and the drift number means nothing.

**`audiogrid grid`'s `holds` field is the one to read.** It scores the beat grid
over the front and back halves separately. Two generated takes both reported
150.0 BPM; the one with the *higher* overall fit drifted (`fitBack` 0.175 vs
`fitFront` 0.234) and would have slid out of sync by the climax. Local tempo
estimation cannot see this.

`cutkit`'s effect vocabulary is `plain zi zo pan pushpan dutch mirror trail
stutter whip invert duo freeze slow split2 split3 grid4 vsplit pip`. Its README
records five failures worth avoiding — animated `crop` w/h (impossible, use
`zoompan`), `zoompan`'s non-square SAR breaking `concat`, duotone crushing dark
footage to black, mirroring reflecting HUD text into gibberish, and sampling
past the end of a capture into the menu screens (`srcLastSafe`).

### musicforge — compose a score with an exported accent map

```powershell
python $musicforge\compose.py     # -> out/harmonia.{mid,wav}, out/accents.json
```

`accents.json` carries section boundaries, every downbeat, crash and stab in
seconds, so the edit is laid against the score itself and needs no tempo
estimation at all. Use it for **instrumental** beds where sync matters; use
`comfyui_music\generate_music.py` (ACE-Step) when the track needs **vocals**,
then measure the result with `audiogrid grid`.

**Motion Studio already vendors FluidSynth** at
`engine\vendor\fluidsynth\bin\fluidsynth.exe`, with SoundFonts beside it. Do not
download another copy. Render at `-g 0.42` for headroom and master the result in
ffmpeg — the raw SoundFont output is thin and clips.

### Layering generated tracks: what actually works

Independently generated takes are complete mixes, not stems, and **a requested
tempo is not a delivered one** — measured: an SA3 drum loop asked for 140 BPM
came back at **105**, while an arp asked for 140 came back at 139.992. Always
measure with `audiogrid grid`; never trust the prompt or the sidecar.

What layers safely, in order of confidence:

1. **Sustained, onset-free material** (pads, drones, atmospheres) — drift is
   inaudible. Put it low and `duck: true`.
2. **One-shots you place yourself** on the host's measured grid. Exact by
   construction. Use `cuekit` — and place by the cue's *transient*, not its file
   start (measured offsets in one set: 0.00, 0.09, 0.87, 3.22, 4.31 s).
3. **A short rhythmic cell, re-anchored.** Drift accumulates, so what matters is
   drift over the span you use: a layer measuring 0.21 s across 140 s is
   unusable end-to-end but ~0.0006 s across one 4-bar cell. Cut the cell to an
   exact multiple of the HOST's bar, start it on a beat of the layer, and place
   every repeat on a measured downbeat of the host — never tile from wherever
   the file happens to begin.

What does not: a second full groove running the length of the track.

## Lessons learned: producing a music video end to end

Two full music videos (a cyberpunk rap, a retro-gaming anthem) converged on the
same order of operations. Follow it and most of the expensive mistakes below
cannot happen.

1. **Generate the song, then MEASURE it.** `audiogrid grid` for tempo/phase
   (`holds` must be true), `audiogrid envelope` for section boundaries,
   `transcribe_asset` for lyric timing. Every later number derives from these.
   Do not use the BPM you asked for; use the BPM you got.
2. **Cut the scene list on measured boundaries**, and check the durations sum to
   the film length exactly before authoring anything.
3. **Generate SA3 layers, then measure each one** (`cuekit measure`).
4. **Place cues by transient, gain by measurement, then verify by lift.**
5. **`preview_audio` before rendering; verify the lift again on the encoded file.**

### The traps, all measured

- **A beat is rarely an integer number of frames.** 150 BPM at 30 fps is exactly
  12 — which is what makes the trap dangerous, because 140 BPM is 12.857 and
  anything stepped by a constant slides a whole beat every ~7 seconds. Use
  `MotionStudio.beatGrid()` (frame API v1.5); it derives from seconds.
- **A cue's transient is not at its file start.** Place by `peakAtSeconds`
  (`probe_asset { audioPeak: true }` or `cuekit`), or a riser peaks four seconds
  after the downbeat it was meant to hit.
- **Gain by mean, then clamp by peak.** A sparse cue's mean is dragged down by
  its own decay; mean-targeting alone asked for **+5 dBFS** on one game-over
  sound. Neither statistic works alone.
- **`balanceWarnings` cannot adjudicate a one-shot.** It flagged an audible cue
  (+4.3 dB lift) and missed an inaudible one (+1.4 dB). Measure the lift and fix
  what *that* condemns — following the warnings blindly makes the mix worse.
- **Trim SA3's padding before measuring a cue.** It pads to the requested
  duration, so a 0.3 s blip in a 4 s file has a mean ~14 dB below its own peak.
- **Blur or avoid generated words.** Every image model still garbles text; the
  arcade plate's cabinet marquees are nonsense at full size (acceptable only
  because they become 3-4 px blobs at the pixelation used). Do typography in the
  composition, or use `qwen-image-fast`, which is the one preset that renders
  legible text.
- **Check the deliverable's own report, and check the checker.** `probe_asset`
  reported 30.001 fps on files that were exactly 30/1 (fixed 2026-08-03), and
  `transcribe_asset` returned a whole song as one 174 s "sentence" (also fixed).
  When a measurement contradicts something you can verify directly, verify it.

### Restart the MCP server after changing the engine

The Motion Studio MCP server loads `engine/src` once at startup. Editing the
engine mid-session does **not** affect the running tools — a fix will look
inert, and you will "work around" a bug that is already fixed on disk. Either
restart the server, or call the engine module directly with `node` for
verification. Skills are copies too: after editing `docs/SKILL.md`, re-copy it
to every client skill directory (see "Install the Motion Studio shell skill").

## Reusable agent tooling: verticalforge

AI-agent-only operational toolkit for converting an already-finished landscape
master into a full-length portrait deliverable without recutting it, inventing
copy, or upscaling the sharp gameplay panel. It records the exact-frame,
source-transition, low-quality-footage, and MCP-registration lessons from the
Harmonia vertical master.

```powershell
$verticalforge = Join-Path $MotionStudioToolsRoot 'verticalforge'
```

Read [verticalforge/README.md](verticalforge/README.md) completely before use.
The scripts are standard-library Python plus the bundled FFmpeg, and the MCP
registrar imports the SDK already installed under Motion Studio's `engine`.

| tool | agent use |
|---|---|
| `verticalize.py` | validate exact inclusive frame coverage; compile native-width gameplay over a blurred portrait fill; extract exact-duration PCM; probe both outputs |
| `review.py` | make unlabeled exact-time source/output sheets around every transition and layout boundary |
| `register.mjs` | read-only MCP plan, safe shared-asset registration, revision-guarded film update, audio preview, build, encoded-frame inspection, measurement, and delivery/advice status |

```powershell
$spec = Join-Path $verticalforge 'examples\harmonia-full-vertical.json'
python $verticalforge\verticalize.py dry-run $spec
python $verticalforge\verticalize.py build $spec
python $verticalforge\verticalize.py verify $spec
node $verticalforge\register.mjs --spec $spec --plan
node $verticalforge\register.mjs --spec $spec
```

The spec uses exact frame numbers and must cover `0..sourceFrames-1` once with
no gap or overlap. Use `fit` for full-frame title/end cards and `native-crop`
for gameplay. A crop whose width equals the portrait canvas avoids enlarging
the sharp gameplay layer; the blurred background is deliberately enlarged and
must never be presented as recovered detail.

Compile segment panels as portrait-sized transparent layers, concatenate them
in timeline order, then overlay that one stream on the background. Independently
timestamp-shifting future overlay branches can make FFmpeg buffer them until it
runs out of memory; the verticalforge compiler deliberately avoids that graph.

The mutating registrar refuses an unexpected existing timeline unless the
agent explicitly passes `--replace-timeline` after inspecting `get_film`.
Never suppress unresolved human advice, plan problems, unexpected picture
measurement findings, or audio warnings. Never add invented words: preserve
source titles and game terminology unless the user separately authorizes copy.

## SFX restriction

Do not use `synthesize_sfx` cue types `chime`, `shimmer`, `whoosh`, or `thud`.
