# This machine — Motion Studio installation facts

> **Machine-specific file.** Written during provisioning and updated whenever
> hardware, paths, models, or paid services change on this machine. The generic
> agent guide (`AGENTS.md` / `CLAUDE.md` beside this file) defers to this file
> for every machine-specific fact. Keep entries literal — exact absolute paths,
> exact model filenames — because agents paste them into MCP configs and
> commands. Never record secret *values* here (API keys, tokens); record only
> whether a service is configured.

## Identity

| fact | value |
|---|---|
| Machine / customer | TODO |
| Provisioned on | TODO (date) |
| Provisioned profile | TODO (`minimal` / `standard` / `gpu`) |
| Operating system | TODO (e.g. `Windows 11 Pro 10.0.26200` or `Ubuntu 24.04, kernel 6.8`) |
| Last verified | TODO (date all check commands below last passed) |

## Hardware

| fact | value |
|---|---|
| GPU | TODO (model + VRAM, e.g. `NVIDIA RTX 3080, 10 GiB`) |
| CPU | TODO |
| RAM | TODO |
| Free disk at tools root | TODO |

GPU sizing notes (batch sizes, resolution limits that were actually tested on
this GPU): TODO.

## Core media tools

The four binaries every install has. These are the values the agent guide's
`$ffmpeg` / `$ffprobe` / `$autoEditor` / `$magick` / `$whisper` /
`$whisperModel` variables must resolve to, and the values to paste into MCP
`MOTION_STUDIO_*` environment settings.

| variable | path |
|---|---|
| `FFMPEG_EXE` | TODO (Windows: `<toolsRoot>\ffmpeg-<version>\bin\ffmpeg.exe`; Linux: static build or distro path) |
| `FFPROBE_EXE` | TODO |
| `FFPLAY_EXE` | TODO |
| `AUTO_EDITOR_EXE` | TODO (Linux: the pipx-installed path) |
| `MAGICK` | TODO (Windows: the `magick-portable.ps1` wrapper — never bare `magick.exe`; Linux: the distro `magick`) |
| `WHISPER_CLI` | TODO (Linux: the statically built `whisper-cli`) |
| `WHISPER_MODEL` | TODO (default model for MCP config) |
| `PIPER` | TODO (the pip-installed piper — resolve with `command -v piper`, or `none`) |
| `SOUNDFONT` | TODO (`.sf2`/`.sf3` path, or `none`) |

Installed Whisper models:

| model | path | languages |
|---|---|---|
| TODO | TODO | TODO |

## Python and ComfyUI

| fact | value |
|---|---|
| System Python | TODO (interpreter on PATH → version) |
| ComfyUI installs | TODO (checkout path + version + which helpers use it; note if ComfyUI runs on a remote GPU box instead) |
| ComfyUI API URL(s) | TODO (`http://127.0.0.1:8188`, or the remote GPU box's URL) |
| ComfyUI Python venv(s) | TODO (exact `python.exe` paths) |
| Shared model directory | TODO (and which machine it physically lives on) |

Installed model weights that helpers depend on (exact filenames under the
shared model directory):

| model file | used by |
|---|---|
| TODO | TODO |

## Paid and external services

Record configured/not configured only — never the secret itself.

| service | status |
|---|---|
| Pexels (`PEXELS_API_KEY` user env var) | TODO configured / not configured |
| ComfyUI partner API sign-in (paid Wan video, …) | TODO |
| YouTube uploader account | TODO |
| Other API keys (TTS vendors, …) | TODO |

## Installed helpers

The actual helper inventory on this machine. A helper not listed here is not
installed; a helper listed here has a `README.md` that is its usage guide.

| helper | one-line purpose | check command |
|---|---|---|
| TODO | TODO | TODO (the helper's own readiness check, e.g. `python <helper>\...py check`) |

## Motion Studio

| fact | value |
|---|---|
| `MotionStudioRoot` (user env var) | TODO |
| Engine `npm install` + `npm run doctor` last passed | TODO (date) |
| Agent skill(s) installed | TODO (which skill, which agent, where) |

## Machine-specific deviations

Anything on this machine that deviates from the standard setup, with why:
TODO / none.
