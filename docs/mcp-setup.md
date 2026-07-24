# Motion Studio — MCP Setup and Tool Reference

Motion Studio's agent interface is a local MCP server speaking stdio: `engine/src/mcp/server.js`. It exposes a fixed set of tools for project management, composition authoring, asset ingestion, previewing, and rendering — the same render engine and the same on-disk projects the Studio web UI uses. It has no network listener and no shell or arbitrary-file tools; every file operation is sandboxed to the target project's folder.

## Connecting a client

For Claude Desktop, add to your config file (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS; create it if needed) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "motionStudio": {
      "command": "node",
      "args": ["/absolute/path/to/motion-studio/engine/src/mcp/server.js"]
    }
  }
}
```

For Claude Code: `claude mcp add motionStudio -- node /absolute/path/to/engine/src/mcp/server.js`. Any MCP-capable client works the same way — point it at `node <path>/server.js` over stdio.

Requirements are the same as the Studio's: Node ≥ 18 and FFmpeg ≥ 5 on PATH, and `npm install` completed in the engine folder (`npm run doctor` verifies). If prerequisites are missing, every tool responds with a structured `prereqs_missing` error naming what's absent.

Optional environment variables can be set in the server config's `env` block: `MOTION_STUDIO_HOME` relocates the data directory (registry + default project location; default `~/.motion-studio`, and it must match what the Studio uses if you want the two to share projects), `MOTION_STUDIO_MAX_RENDERS` caps the number of renders a single server session will start (unset = unlimited) as a safety valve for unattended agent loops, and `MOTION_STUDIO_TTS_EXE` points at the Windows text-to-speech executable that powers `synthesize_speech` / `list_voices` (unset = those two tools return `tts_unavailable`; everything else works). See the [text-to-speech guide](tts-setup.md) for building it. `MOTION_STUDIO_LIBS_DIR` overrides where the optional 3D library builds are vendored from (default `engine/vendor/libs`; populate it with `node scripts/fetch-libs.mjs`) — see [3D libraries](#3d-libraries-v07-optional). The optional music toolchain is resolved by `MOTION_STUDIO_MIDI_EXE`, `MOTION_STUDIO_FLUIDSYNTH`, and `MOTION_STUDIO_SOUNDFONT` (each with a vendored default under `engine/vendor/`; any missing → `synthesize_music` returns `music_unavailable`) — see the [music guide](music-setup.md).

## Resources

| URI | Content |
|---|---|
| `motion-studio://reference/frame-api` | The Frame API authoring contract (markdown). Agents should read this before writing composition code. |
| `motion-studio://project/{id}/manifest` | A project's config plus file listing. |

## Tools

All tools return JSON text content; failures set `isError` with a body of `{ code, message, detail? }` using the stable codes listed in [architecture.md](architecture.md) §4. Paths passed to file tools are always **project-relative**; absolute paths and `..` escapes are rejected with `path_outside_project`.

### Projects

| tool | arguments | returns / notes |
|---|---|---|
| `list_projects` | — | `{ projects: [{ id, name, path, createdAt }] }` from the shared registry (same list the Studio shows). |
| `create_project` | `name` (req), `fps` = 30, `width` = 1920, `height` = 1080, `durationInFrames` = 150 | Scaffolds a working template project, registers it, returns `{ id, name, path, config, files }`. Width/height must be even. Errors: `project_already_exists`, `invalid_config`. |
| `get_project` | `projectId` | Config + recursive file listing (sizes, mtimes). Error: `project_not_found`. |
| `update_project_config` | `projectId`, plus any of `name`, `fps`, `width`, `height`, `durationInFrames`, `entry`, `output` (object), `audio` (array) | Validated config update — the only way to change `project.json`. `output.format` ∈ `mp4 webm gif prores png-sequence`; `output.transparent` keeps alpha (webm/prores/png-sequence only); the output filename's extension follows the format automatically. Returns the full updated config. Error: `invalid_config` with the failing field. |
| `remove_project` **(v0.5)** | `projectId`, `deleteFiles?` = false | Unregisters the project. Files are deleted only when `deleteFiles` is true **and** the folder lives under the managed projects root; user-chosen locations are never deleted. Irreversible — confirm with the user first. |

### Composition files

| tool | arguments | returns / notes |
|---|---|---|
| `read_composition_file` | `projectId`, `path` | `{ path, content, size }`. Errors: `file_not_found`, `path_outside_project`. |
| `write_composition_file` | `projectId`, `path`, `content` | Atomic write (temp + rename). `.js`/`.mjs` content is syntax-checked first and rejected with `syntax_error` (line/column in `detail`) **before touching disk** — the previous file version survives a rejected write. Allowed extensions: `.html .css .js .mjs .json .svg .txt .md`; `project.json` is deny-listed (use `update_project_config`). |
| `write_asset_file` **(v0.5)** | `projectId`, `path` (under `assets/`), `contentBase64` | Writes a binary asset (image/audio/font) from base64. Confined to `assets/`; extension allow-list (`png jpg jpeg gif webp svg mp3 wav ogg m4a flac woff woff2 ttf otf json txt`); 25 MB decoded cap → `asset_too_large`. Reference from the composition as `assets/<name>`. |

### Audio / narration (v0.6, Windows-only)

Requires `MOTION_STUDIO_TTS_EXE` to point at the Windows speech executable (see [tts-setup.md](tts-setup.md)); without it both tools return `tts_unavailable`. Synthesized narration is a normal audio track — mixed into the final render by FFmpeg (mp4/webm/prores carry audio; gif/png-sequence do not). `capture_preview_frame` is always silent.

| tool | arguments | returns / notes |
|---|---|---|
| `list_voices` | — | `{ voices: [name, …] }` installed on the machine, for use as `synthesize_speech`'s `voice`. Error: `tts_unavailable`. |
| `synthesize_speech` | `projectId`, `text` (req), `voice?`, `rate?` (−10..10), `volume?` (0..100), `mode?` = `attach`, `assetPath?` (under `assets/`, default `assets/narration-<n>.wav`), `startInFrames?`, `gainDb?` | Speaks `text` to a WAV in `assets/` and returns `{ assetPath, durationSeconds, durationInFrames, fps, voice, sampleRate, … }` — use `durationInFrames` to size the `Sequence()` the narration plays under. `mode:"attach"` also appends the clip to `config.audio` so the next render mixes it in; `mode:"asset-only"` only writes + reports (wire it yourself with `update_project_config`). Errors: `tts_unavailable`, `unsupported_voice`, `tts_failed`, `path_outside_project`. |

### 3D libraries (v0.7, optional)

Attach a heavier rendering library to a project. The build is copied **locally**
into the project (never a CDN at render time, so renders stay hermetic). Builds
are git-ignored and fetched once with `node scripts/fetch-libs.mjs`; missing
builds return `library_unavailable`.

| tool | arguments | returns / notes |
|---|---|---|
| `add_library` | `projectId`, `library` ∈ `three` \| `babylon`, `scaffold?` = true, `addons?` (babylon: `["loaders"]`) | Vendors the library (+ any addons) into the project and (when `scaffold`) replaces `composition.html/js/css` with a frame-driven starter; records `config.libraries`. Returns `{ library, version, global, addons, copied, scaffolded, notes }`. **`three`** = Three.js (~600 KB); **`babylon`** = Babylon.js (~8 MB, built-in glow/bloom/postprocessing). Addon `loaders` adds glTF/GLB import via `SceneLoader`. |

The returned `notes` are **determinism rules you must follow** in the composition:
drive all animation from the injected `frame` — no `requestAnimationFrame`, no
`THREE.Clock` / Babylon `runRenderLoop` / particle systems (all wall-clock based).
The starters set `preserveDrawingBuffer` + a per-frame GL `finish()`, and compile
shaders up front (else a single-frame capture is blank). **Loading a glTF/GLB
model** additionally needs `MOTION_STUDIO_ALLOW_LOCAL_FETCH=1` (file:// fetch) and
a working recipe — see [3d-libraries.md](3d-libraries.md).

### Music (v0.8, Windows-only)

Compose a music bed from a note spec **you author**. The engine renders it to
MIDI (DryWetMIDI) then to audio (FluidSynth + a General MIDI SoundFont), and — like
`synthesize_speech` — the result is a normal `config.audio` track mixed into the
final render. Requires the music toolchain (`MOTION_STUDIO_MIDI_EXE` +
`MOTION_STUDIO_FLUIDSYNTH` + `MOTION_STUDIO_SOUNDFONT`, each with a vendored
default); any missing piece → `music_unavailable`. See [music-setup.md](music-setup.md).

| tool | arguments | returns / notes |
|---|---|---|
| `synthesize_music` | `projectId`, `spec` (req), `mode?` = `attach`, `assetPath?` (under `assets/`, default `assets/music-<n>.wav`), `startInFrames?`, `gainDb?` | Renders `spec` to a WAV in `assets/` and returns `{ assetPath, bpm, tracks, notes, musicalDurationSeconds, durationSeconds, durationInFrames, fps, bytes, … }`. `durationInFrames`/`durationSeconds` come from the WAV (includes FluidSynth's reverb tail — longer than `musicalDurationSeconds`); use it to size the video, and `startInFrames`/`gainDb` (e.g. `-8`) to place and balance the bed under narration. `mode:"attach"` also appends the track; `mode:"asset-only"` writes + reports only. Errors: `music_unavailable`, `invalid_music_spec`, `music_failed`, `path_outside_project`. |

The `spec` is `{ bpm, tracks: [ { program, drums?, notes: [ { pitch, start, duration, velocity? } ] } ] }`.
`program` = General MIDI instrument `0..127` (0 piano, 32 acoustic bass, 40 violin,
48 strings, 56 trumpet, 73 flute…); `drums:true` routes the track to GM percussion.
`pitch` `0..127` (60 = middle C); `start`/`duration` in **beats** (quarter notes);
`velocity` `1..127`.

### Film assembly (v0.9)

Build videos **longer than a single composition** by authoring each scene as its
own project and stitching the rendered scenes together. `build_film` assembles —
it never renders (render each scene first with `render`).

| tool | arguments | returns / notes |
|---|---|---|
| `build_film` | `scenes` (req: ordered `[{ projectId }]`), `outputProjectId?` (default first scene), `outputFilename?`, `audio?` (master timeline `[{ src, startInFrames?, gainDb? }]`) | Concatenates the scenes' rendered outputs **losslessly** (`-c copy`) into one film and returns `{ outputPath, scenes, totalFrames, durationSeconds, fps, format, hasAudio }`. Scenes must share resolution/fps/format/pixel-format (mp4/webm/prores only). With no `audio`, per-scene audio is preserved (scenes must be consistently audio or silent); with `audio`, one master timeline is laid over the whole film (replacing scene audio). Errors: `scene_not_rendered`, `inconsistent_scenes`, `path_outside_project`, `file_not_found`. |

For the quality pipeline (render scenes as ProRes/low-CRF → assemble → one final
encode) and scaling to long-form, see [film-setup.md](film-setup.md).

### Preview

| tool | arguments | returns / notes |
|---|---|---|
| `capture_preview_frame` | `projectId`, `frame` = 0 | Renders exactly one frame through the real render path (Puppeteer Chromium — identical pixels to the final render) and returns it as an MCP **image** content block (PNG). Errors: `invalid_config` (frame out of range), `composition_error`, `frame_timeout`, `browser_launch_failed`. |
| `render_still` **(v0.5)** | `projectId`, `frame`, `outputFilename?` = `still-<frame>.png` | Same single-frame render, but written to a `.png` inside the project's `out/` dir — for poster frames and thumbnails. Returns `{ outputPath, bytes, frame }`. |

### Rendering

| tool | arguments | returns / notes |
|---|---|---|
| `render` | `projectId`, `frameRange?` = `[start, end]` inclusive, `workers?` = 1, `outputFilename?` | Starts an async job for the configured output format; returns `{ jobId, state, queuePosition?, outputPath, totalFrames }` immediately. One render runs at a time; further submissions **queue FIFO (v0.5)** and start automatically. A full queue (10) fails with `queue_full`. `workers` > 1 splits capture across parallel Chromium processes. |
| `get_render_status` | `jobId` | `{ state: queued\|running\|done\|error\|cancelled, framesDone, totalFrames, percent, renderFps, etaMs, queuePosition?, outputPath?, error? }`. Poll until terminal. Error: `job_not_found`. |
| `cancel_render` | `jobId` | Aborts a running job and kills every child process (Chromium workers, FFmpeg); dequeues a queued job without starting it. Idempotent on finished jobs. |
| `list_render_jobs` | — | All jobs this session, newest first, with status snapshots. |
| `get_logs` | `jobId`, `tail?` = 200 | The job's log lines (engine phases, warnings, FFmpeg stderr on failure) — read this before diagnosing a failed render. |

## Typical agent session

```
list_projects                                   → empty
create_project { name: "Product Intro", durationInFrames: 300 }
(read resource motion-studio://reference/frame-api)
write_composition_file { path: "composition.js", content: … }   → syntax_error → fix → ok
capture_preview_frame { frame: 0 }              → inspect image
capture_preview_frame { frame: 150 }            → inspect image
render { frameRange: [0, 59] }                  → confirm pacing on 2s
get_render_status …                             → done
render { workers: 4 }                           → full render
get_render_status … (poll)                      → etaMs while running → done, outputPath
render_still { frame: 150 }                     → poster frame for the thumbnail
```

To deliver a transparent overlay instead of an mp4:
`update_project_config { output: { format: "webm", transparent: true } }`,
give the composition a transparent background, and render — the output drops
onto any timeline as an alpha overlay.

The updated agent skill in [SKILL.md](SKILL.md) encodes this workflow, the authoring contract, and error handling for direct use as a Claude skill (pair it with `frame-api.md` as `references/frame-api.md`).
