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

Requirements are the same as the Studio's: Node ≥ 18 and FFmpeg ≥ 5 on PATH, and `npm install` completed in the engine folder (`npm run doctor` verifies). If prerequisites are missing, every tool responds with a structured `prereqs_missing` error naming what's absent — including `ffmpeg.effectivePath` and `ffmpeg.source`, so you can see *which* binary was probed and where that path came from.

The server shares the Studio's global settings (`~/.motion-studio/settings.json`, the ⚙ dialog): a `create_project` call that omits fps/dimensions/duration gets the user's new-project defaults and encode defaults, and a `render` that omits `workers` gets their default worker count (the response reports the value used). An explicit argument always wins, and settings apply only when a project is created — nothing on disk is rewritten because a global changed.

FFmpeg is resolved as `MOTION_STUDIO_FFMPEG` → the Studio's `settings.json` `ffmpeg.path` → `ffmpeg` on PATH, and the binary that passes the check is the one that runs your renders. Worth knowing because MCP clients launch the server themselves and often hand it a narrower PATH than your shell: if the Studio UI renders happily and every agent call returns `prereqs_missing`, that mismatch is the reason — set `MOTION_STUDIO_FFMPEG` in the server config's `env` block.

Optional environment variables can be set in the server config's `env` block: `MOTION_STUDIO_HOME` relocates the data directory (registry + default project location; default `~/.motion-studio`, and it must match what the Studio uses if you want the two to share projects), `MOTION_STUDIO_MAX_RENDERS` caps the number of renders a single server session will start (unset = unlimited) as a safety valve for unattended agent loops, `MOTION_STUDIO_FFMPEG` names the ffmpeg binary to use for the prerequisite check and for every render/film the server runs, and `MOTION_STUDIO_TTS_EXE` points at the Windows text-to-speech executable that powers `synthesize_speech` / `list_voices` (unset = those two tools return `tts_unavailable`; everything else works). See the [text-to-speech guide](tts-setup.md) for building it. `MOTION_STUDIO_LIBS_DIR` overrides where the optional 3D library builds are vendored from (default `engine/vendor/libs`, which is committed — `node scripts/fetch-libs.mjs` only upgrades/repairs it) — see [3D libraries](#3d-libraries-v07-optional). The optional music toolchain is resolved by `MOTION_STUDIO_MIDI_EXE`, `MOTION_STUDIO_FLUIDSYNTH`, and `MOTION_STUDIO_SOUNDFONT` (each with a vendored default under `engine/vendor/`; any missing → `synthesize_music` returns `music_unavailable`) — see the [music guide](music-setup.md).

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
| `update_project_config` | `projectId`, plus any of `name`, `fps`, `width`, `height`, `durationInFrames`, `entry`, `output` (object), `audio` (array) | Validated config update — the only way to change `project.json`. `output.format` ∈ `mp4 webm gif prores png-sequence`; `output.transparent` keeps alpha (webm/prores/png-sequence only); the output filename's extension follows the format automatically. `output.audioLimiter` **(v0.10, default `true`)** brick-walls the mixed audio at −1 dBFS. Returns the full updated config. Error: `invalid_config` with the failing field. |
| `remove_project` **(v0.5)** | `projectId`, `deleteFiles?` = false | Unregisters the project. Files are deleted only when `deleteFiles` is true **and** the folder lives under the managed projects root; user-chosen locations are never deleted. Irreversible — confirm with the user first. |

### Composition files

| tool | arguments | returns / notes |
|---|---|---|
| `read_composition_file` | `projectId`, `path` | `{ path, content, size }`. Errors: `file_not_found`, `path_outside_project`. |
| `write_composition_file` | `projectId`, `path`, `content` | Atomic write (temp + rename). `.js`/`.mjs` content is syntax-checked first and rejected with `syntax_error` (line/column in `detail`) **before touching disk** — the previous file version survives a rejected write. Allowed extensions: `.html .css .js .mjs .json .svg .txt .md`; `project.json` is deny-listed (use `update_project_config`). **Determinism lint (v0.10):** JS/CSS is scanned for frame-driven contract violations and any hits come back as `warnings: [{ rule, line, snippet, message }]`. These are **advisory — the file is written regardless** (a loader outside the frame function may legitimately use a timer), but treat them as real unless you know the usage is safe. Comments and string literals are excluded from the scan. Rules: `date-now`, `performance-now`, `new-date`, `set-timeout`, `set-interval`, `request-animation-frame`, `math-random`, `three-clock`, `babylon-render-loop`, `babylon-begin-animation`, `css-transition`, `css-animation`. |
| `sync_shared_files` **(v0.11)** | `sourceProjectId`, `targetProjectIds` (array), `files` (array of project-relative paths) | Copies the named files from the source project into every target, overwriting. The maintenance half of the multi-scene film pattern: each scene project owns its own copy of the shared `composition.js`, so without this a one-line engine fix is one write per scene. Each target gets the same syntax check + determinism lint as `write_composition_file` (warnings come back per target), and **all** source files are read before anything is written, so a bad path fails before it half-updates the film. The source is skipped if it appears in `targetProjectIds`; `project.json` remains deny-listed. Does **not** invalidate rendered output — re-render the affected scenes. Returns `{ sourceProjectId, files, projectsUpdated, results }`. Errors: `file_not_found`, `project_not_found`, `invalid_config` (empty list), `syntax_error`. |
| `write_asset_file` **(v0.5)** | `projectId`, `path` (under `assets/`), `contentBase64` | Writes a binary asset (image/audio/font) from base64. Confined to `assets/`; extension allow-list (`png jpg jpeg gif webp svg mp3 wav ogg m4a flac woff woff2 ttf otf json txt`); 25 MB decoded cap → `asset_too_large`. Reference from the composition as `assets/<name>`. |
| `list_assets` **(v0.15)** | `projectId` | `{ files: [{ path, bytes, mtime, kind, audioRefs }] }` for everything under `assets/`. `kind` is `image`/`audio`/`font`/`data`; **`audioRefs`** is how many `config.audio` tracks reference the file. `get_project` also lists files, but undifferentiated and without reference counts — use this to tell a load-bearing asset from an orphaned take before cleaning up. |
| `delete_asset` **(v0.15)** | `projectId`, `path` (under `assets/`), `updateAudio?` = false | Deletes one file. Returns `{ path, deleted, audioRefs, audioTracksRemoved, config? }`. **`audioRefs` is always reported**, so you are never unaware that you just orphaned an audio track — a dangling `src` does not fail at delete time, it fails much later as an ffmpeg mux error. Pass `updateAudio: true` to drop those tracks in the same call (the updated `config` comes back). Irreversible. Folders are not deleted. Errors: `file_not_found`, `path_outside_project`, `invalid_config` (path is a folder). |
| `rename_asset` **(v0.15)** | `projectId`, `from`, `to` (both under `assets/`), `updateAudio?` = false | Moves/renames within `assets/`. Returns `{ from, to, audioRefs, audioTracksUpdated, config? }`. An existing destination is **refused, not overwritten** (`invalid_config`). With `updateAudio: true` the referencing tracks are repointed at the new path, preserving each track's `startInFrames` and `gainDb`. Errors: `file_not_found`, `path_outside_project`, `invalid_config`. |

### Audio / narration (v0.6, Windows-only)

Requires `MOTION_STUDIO_TTS_EXE` to point at the Windows speech executable (see [tts-setup.md](tts-setup.md)); without it both tools return `tts_unavailable`. Synthesized narration is a normal audio track — mixed into the final render by FFmpeg (mp4/webm/prores carry audio; gif/png-sequence do not). `capture_preview_frame` is always silent.

| tool | arguments | returns / notes |
|---|---|---|
| `list_voices` | — | `{ voices: [name, …] }` installed on the machine, for use as `synthesize_speech`'s `voice`. Error: `tts_unavailable`. |
| `synthesize_speech` | `projectId`, `text` (req), `voice?`, `rate?` (−10..10), `volume?` (0..100), `mode?` = `attach`, `assetPath?` (under `assets/`, default `assets/narration-<n>.wav`), `startInFrames?`, `gainDb?` | Speaks `text` to a WAV in `assets/` and returns `{ assetPath, durationSeconds, durationInFrames, fps, voice, sampleRate, … }` — use `durationInFrames` to size the `Sequence()` the narration plays under. `mode:"attach"` also appends the clip to `config.audio` so the next render mixes it in; `mode:"asset-only"` only writes + reports (wire it yourself with `update_project_config`). Errors: `tts_unavailable`, `unsupported_voice`, `tts_failed`, `path_outside_project`. |

### 3D libraries (v0.7, optional)

Attach a heavier rendering library to a project. The build is copied **locally**
into the project (never a CDN at render time, so renders stay hermetic). Builds
are **committed** under `engine/vendor/libs/`, so this works on a fresh clone with
no setup step; `node scripts/fetch-libs.mjs` is for upgrading or repairing them.
A missing build returns `library_unavailable`.

| tool | arguments | returns / notes |
|---|---|---|
| `add_library` | `projectId`, `library` ∈ `three` \| `babylon`, `scaffold?` = true, `addons?` (babylon: `["loaders"]`) | Vendors the library (+ any addons) into the project and (when `scaffold`) replaces `composition.html/js/css` with a frame-driven starter; records `config.libraries`. Returns `{ library, version, global, addons, copied, scaffolded, notes }`. **`three`** = Three.js (~600 KB); **`babylon`** = Babylon.js (~8 MB, built-in glow/bloom/postprocessing). Addon `loaders` adds glTF/GLB import via `SceneLoader`.  **Provenance (v0.13):** records `config.libraryBuilds` = `{ version, sha256, bytes }` per copied file, and returns each `copied` entry with its `sha256`. The builds are committed and version-pinned, with `engine/vendor.lock.json` recording which upstream build each came from, so a render can be traced to exact bytes — see [3d-libraries.md](3d-libraries.md) §3.5. |

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
| `synthesize_sfx` **(v0.12)** | `projectId`, `spec` (req: `cues[]`, optional `durationInFrames`/`sampleRate`/`normalize`/`ceilingDb`), `mode?` = `attach`, `assetPath?` (default `assets/sfx-<n>.wav`), `startInFrames?`, `gainDb?` | Renders a list of sound-effect **cues** into one mono WAV and (in `attach` mode) appends the track. **Pure JS — nothing to install, works on every OS, and has no `*_unavailable` error**, unlike speech and music. One call makes the whole bed: a single track holding every cue at its absolute time, which is what `build_film`'s master timeline wants. **Time is in frames**: `atFrame` matches `startInFrames`/`filmOffset`, so a chime on every scene cut is a map over scene offsets; `at` (seconds) is accepted instead — exactly one of the two. `gain` is the cue's **peak amplitude 0..1, not dB**, and means the same thing for every type. Types: `chime`, `whoosh`, `shimmer`, `thud`, `tone`; pitched cues take `pitch` (MIDI) **or** `hz`. Levels: `normalize:"ceiling"` (default) attenuates only a mix hotter than `ceilingDb`, so the returned `peakDb` is the real level — also reports `rawPeakDb` and `appliedGainDb`. `fps` and the default bed length come from the project. Limits: 512 cues, 30 s per cue, `sampleRate` ∈ 22050/44100/48000 (a 10-minute 44.1k bed is ~53 MB — prefer 22050 for long beds). A cue overhanging the end is clamped and counted in `clamped`; one starting past the end is an error. Errors: `invalid_sfx_spec` (offending cue index in `detail`), `path_outside_project`. See [sfx-setup.md](sfx-setup.md). |
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
| `build_film` | `scenes` (req: ordered `[{ projectId }]`), `outputProjectId?` (pass a dedicated film project — defaulting to the first scene dumps the film into that scene's folder), `outputFilename?`, `audio?` (master timeline `[{ src, startInFrames?, gainDb? }]`), `audioTargetPeakDb?` **(v0.11)** | Concatenates the scenes' rendered outputs **losslessly** (`-c copy`) into one film and returns `{ outputPath, scenes, totalFrames, durationSeconds, fps, format, hasAudio }`. Scenes must share resolution/fps/format/pixel-format (mp4/webm/prores only). With no `audio`, per-scene audio is preserved (scenes must be consistently audio or silent); with `audio`, one master timeline is laid over the whole film (replacing scene audio). **With a master timeline the result also carries `audio: { tracks, limiter, peakDb, meanDb, clipping, targetPeakDb?, appliedOffsetDb? }` (v0.11)** — the measured level of the assembled film, the same report `render` has produced since v0.10. `audioTargetPeakDb` (−60..0, e.g. `-2`) measures the mix, applies one offset to **every** track so the relative balance is preserved, re-muxes once and re-measures — use it instead of guessing a master gain. Errors: `scene_not_rendered`, `inconsistent_scenes`, `path_outside_project`, `file_not_found`, `invalid_config`. |

For the quality pipeline (render scenes as ProRes/low-CRF → assemble → one final
encode) and scaling to long-form, see [film-setup.md](film-setup.md).

### Preview

| tool | arguments | returns / notes |
|---|---|---|
| `capture_preview_frame` | `projectId`, `frame` = 0 | Renders exactly one frame through the real render path (Puppeteer Chromium — identical pixels to the final render) and returns it as an MCP **image** content block (PNG). Errors: `invalid_config` (frame out of range), `composition_error`, `frame_timeout`, `browser_launch_failed`. |
| `capture_preview_frames` **(v0.10)** | `projectId`, `frames?` (array), `count?` = 5 | Same render path, but **N frames from one page load** — returns an image block per frame, in the order requested, followed by a text block listing them. Pass explicit `frames`, or `count` for evenly-spaced frames spanning the composition (first and last always included). Max 24 per call → `invalid_config`. **Prefer this whenever you want more than one frame:** a single capture pays a full Chromium launch, page load, and re-run of the composition's one-time setup, so five separate captures pay that five times. |
| `render_still` **(v0.5)** | `projectId`, `frame`, `outputFilename?` = `still-<frame>.png` | Same single-frame render, but written to a `.png` inside the project's `out/` dir — for poster frames and thumbnails. Returns `{ outputPath, bytes, frame }`. |

### Rendering

| tool | arguments | returns / notes |
|---|---|---|
| `render` | `projectId`, `frameRange?` = `[start, end]` inclusive, `workers?` = 1, `outputFilename?`, `preflight?` = true **(v0.10)** | Starts an async job for the configured output format; returns `{ jobId, state, queuePosition?, outputPath, totalFrames }` immediately. One render runs at a time; further submissions **queue FIFO (v0.5)** and start automatically. A full queue (10) fails with `queue_full`. `workers` > 1 splits capture across parallel Chromium processes. **Pre-flight (v0.10):** evenly-spaced frames (both endpoints included) are probed before the render commits, so a composition that only breaks at frame 90 fails in seconds instead of after 90 frames and N spawned workers. Failures keep their real code (`composition_error` / `frame_timeout`) with `detail.phase = "preflight"`. Skipped under 30 frames; pass `preflight: false` to disable. **Frame-count verification (v0.11):** when the encode finishes, the file's actual frame count is checked against what was rendered; a mismatch fails with `short_render` rather than returning a truncated file, and the result carries `framesVerified` (false only when ffprobe is unavailable). **Render lock (v0.11):** the project is locked for the duration, so a *second process* rendering the same project fails fast with `render_already_in_progress` instead of silently interleaving frame writes. In-process submissions still queue as before. |
| `get_render_status` | `jobId` | `{ state: queued\|running\|done\|error\|cancelled, framesDone, totalFrames, percent, renderFps, etaMs, queuePosition?, outputPath?, error? }`. Poll until terminal — or use `wait_for_render` instead of a polling loop. When the render carried audio, adds `audio: { tracks, limiter, peakDb, meanDb, clipping }` **(v0.10)** — the measured level of the final mix. Error: `job_not_found`. |
| `wait_for_render` **(v0.14)** | `jobIds` = `[…]` (1–16), `timeoutMs?` = 300000 (1s–10min) | Blocks until **every** listed job is terminal, or the timeout elapses. Returns `{ timedOut, jobs }` — each `jobs[]` entry has the `get_render_status` shape, including the structured `error` for failed jobs and the measured `audio` block for finished ones. Check states individually: one failed scene does not stop the others. Waiting on queued jobs is fine (FIFO). A timeout is **not** an error — the jobs keep running; wait again to keep watching. Error: `job_not_found` if any id is unknown. |
| `cancel_render` | `jobId` | Aborts a running job and kills every child process (Chromium workers, FFmpeg); dequeues a queued job without starting it. Idempotent on finished jobs. |
| `list_render_jobs` | — | All jobs this session, newest first, with status snapshots. |
| `get_logs` | `jobId`, `tail?` = 200 | The job's log lines (engine phases, warnings, FFmpeg stderr on failure) — read this before diagnosing a failed render. |

## Typical agent session

```
list_projects                                   → empty
create_project { name: "Product Intro", durationInFrames: 300 }
(read resource motion-studio://reference/frame-api)
write_composition_file { path: "composition.js", content: … }   → syntax_error → fix → ok
                                                → then: warnings? fix determinism hits
capture_preview_frames { count: 5 }             → inspect 5 images from ONE page load
render { frameRange: [0, 59] }                  → confirm pacing on 2s
wait_for_render { jobIds: [job1] }              → done
render { workers: 4, preflight: false }         → already previewed; skip the probe
wait_for_render { jobIds: [job2] }              → blocks → done, outputPath,
                                                   audio: { peakDb, clipping }
render_still { frame: 150 }                     → poster frame for the thumbnail
```

To deliver a transparent overlay instead of an mp4:
`update_project_config { output: { format: "webm", transparent: true } }`,
give the composition a transparent background, and render — the output drops
onto any timeline as an alpha overlay.

The updated agent skill in [SKILL.md](SKILL.md) encodes this workflow, the authoring contract, and error handling for direct use as a Claude skill (pair it with `frame-api.md` as `references/frame-api.md`).
