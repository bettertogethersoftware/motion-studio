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

Optional environment variables can be set in the server config's `env` block: `MOTION_STUDIO_HOME` relocates the data directory (registry + default project location; default `~/.motion-studio`, and it must match what the Studio uses if you want the two to share projects), `MOTION_STUDIO_MAX_RENDERS` caps the number of renders a single server session will start (unset = unlimited) as a safety valve for unattended agent loops, `MOTION_STUDIO_FFMPEG` names the ffmpeg binary to use for the prerequisite check and for every render/film the server runs, and `MOTION_STUDIO_TTS_EXE` points at the Windows text-to-speech executable behind the `system` speech vendor (unset = the speech tools return `tts_unavailable`; everything else works). Since v0.17 speech has a second vendor: `MOTION_STUDIO_TTS_VENDOR` (`system` | `azure` | `piper`) selects it, the Piper vendor reads `MOTION_STUDIO_PIPER_EXE` / `MOTION_STUDIO_PIPER_VOICES`,, and the Azure vendor reads `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (or their `MOTION_STUDIO_AZURE_SPEECH_*` forms) **from the environment only** — never from `settings.json`. See the [text-to-speech guide](tts-setup.md). `MOTION_STUDIO_LIBS_DIR` overrides where the optional 3D library builds are vendored from (default `engine/vendor/libs`, which is committed — `node scripts/fetch-libs.mjs` only upgrades/repairs it) — see [3D libraries](#3d-libraries-v07-optional). Music has two vendors as of v0.17: `MOTION_STUDIO_MUSIC_VENDOR` (`node` | `fluidsynth`) selects one, `node` being the default — it renders in-process on any OS and needs only `MOTION_STUDIO_SOUNDFONT` (a `.sf2`/`.sf3`, with a vendored default). The `fluidsynth` vendor additionally needs `MOTION_STUDIO_MIDI_EXE` and `MOTION_STUDIO_FLUIDSYNTH`; whatever is missing → `synthesize_music` returns `music_unavailable` naming it. See the [music guide](music-setup.md).

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
| `update_project_config` | `projectId`, plus any of `name`, `fps`, `width`, `height`, `durationInFrames`, `entry`, `output` (object), `audio` (array) | Validated config update — the only way to change `project.json`. `output.format` ∈ `mp4 webm gif prores png-sequence`; `output.transparent` keeps alpha (webm/prores/png-sequence only); the output filename's extension follows the format automatically. `output.audioLimiter` **(v0.10, default `true`)** brick-walls the mixed audio at −1 dBFS. **Audio track edit controls (v0.19):** each track also takes clip-relative `trimEndInFrames` / `fadeInFrames` / `fadeOutFrames` (fade-out ends at the trim if set, else at the composition end) and `duck: true` (sidechain-compress this track under the mix of all non-ducked tracks — bed dips under narration, recovers in gaps; needs both sides present). Returns the full updated config. Error: `invalid_config` with the failing field. |
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

### Audio / narration (v0.6; two vendors since v0.17)

Narration comes from a **speech vendor**: `system` (the Windows speech exe at `MOTION_STUDIO_TTS_EXE`), `azure` (Azure AI Speech, needing `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` in the environment), or `piper` (local neural voices — needs Piper installed via `pip install piper-tts` plus downloaded `.onnx` voices; offline, free, any OS). Omit `vendor` and the machine's configured default is used — `list_vendors` says which that is and why. The user may configure an ordered **preference chain** rather than one vendor, in which case a vendor-less call uses the highest-ranked one that is available and the result carries `vendorChain` + a `vendorNote` naming anything skipped; **a vendor you name explicitly is never redirected** — it runs or it fails. An unconfigured vendor returns `tts_unavailable`, which is a **setup problem for the user**, not something to retry. See [tts-setup.md](tts-setup.md). Synthesized narration is a normal audio track — mixed into the final render by FFmpeg (mp4/webm/prores carry audio; gif/png-sequence do not). `capture_preview_frame` is always silent.

| tool | arguments | returns / notes |
|---|---|---|
| `list_vendors` **(v0.17)** | `capability?` (`speech` \| `music`), `probe?` = true | `{ speech: {…}, music: {…} }`, each `{ active, activeSource, chain, preferred, fellBack, allVendors, vendors: [{ id, label, active, priority, available, requires, offline, error?, voiceCount? }] }` — which vendor each generator uses by default, whether each is usable right now, and what to configure if not. **`chain`** is the user's ordered preference (usually one entry); **`preferred`** is its head, **`active`** is the vendor that will ACTUALLY run (first in the chain that is available), and **`fellBack: true`** when those differ. Each vendor's **`priority`** is its 1-based rank in the chain, or null if outside it. `probe: false` reports configuration only (no exe spawn, no network) and then `active` is just the head. Never reports a credential, only its source. |
| `list_voices` | `vendor?`, `locale?`, `search?`, `limit?` = 50, `offset?` = 0 | `{ vendor, total, returned, truncated, voices }`. The `system` vendor returns plain names; `azure` returns `{ name, locale, gender, styles? }` — filter with `locale` (e.g. `"en-US"`) or `search`, since the Azure catalogue is several hundred voices. Error: `tts_unavailable`. |
| `synthesize_speech` | `projectId`, `text` (req), `vendor?` (`system`|`azure`|`piper`), `voice?`, `rate?` (−10..10), `volume?` (0..100), `style?` (azure), `mode?` = `attach`, `assetPath?` (under `assets/`, default `assets/narration-<n>.wav`), `startInFrames?`, `gainDb?`, `sentenceTimings?` = false **(v0.19)**, `sentenceGapSeconds?` = 0.3, `deterministic?` **(v0.20, piper)** | Speaks `text` to a WAV in `assets/` and returns `{ assetPath, vendor, vendorSource, durationSeconds, durationInFrames, fps, voice, sampleRate, peakDb, meanDb, warnings?, … }` — use `durationInFrames` to size the `Sequence()` the narration plays under, and **`peakDb`/`meanDb` (v0.19)** to balance a music bed against the narration without rendering first. **`sentenceTimings: true` (v0.19)** synthesizes per sentence, joins the clips with `sentenceGapSeconds` of silence (replacing — not stacking on — the vendor's own inter-sentence pad since v0.20), and adds `timings: [{ text, startSeconds, startInFrames, durationSeconds, durationInFrames }]` — exact caption/cue placement (word-level timing is not available from any vendor's CLI). **`deterministic: true` (v0.20)** pins Piper's stochastic phoneme durations (`--noise-scale 0 --noise-w 0`) so identical input yields identical timing across runs; other vendors report it in `warnings`. An explicit `vendor` differing from the machine default adds a `vendorNote`. `mode:"attach"` also appends the clip to `config.audio` so the next render mixes it in; `mode:"asset-only"` only writes + reports (wire it yourself with `update_project_config`). An option the chosen vendor doesn't support (e.g. `style` on `system`) is reported in `warnings`, not silently dropped. Errors: `tts_unavailable`, `unsupported_voice`, `tts_failed`, `path_outside_project`. |

### 3D libraries (v0.7, optional)

Attach a heavier rendering library to a project. The build is copied **locally**
into the project (never a CDN at render time, so renders stay hermetic). Builds
are **committed** under `engine/vendor/libs/`, so this works on a fresh clone with
no setup step; `node scripts/fetch-libs.mjs` is for upgrading or repairing them.
A missing build returns `library_unavailable`.

| tool | arguments | returns / notes |
|---|---|---|
| `add_library` | `projectId`, `library` ∈ `three` \| `babylon`, `scaffold?` = true, `addons?` (three: `geometries` \| `loaders` \| `postprocessing` **(v0.19)**; babylon: `loaders`) | Vendors the library (+ any addons) into the project and (when `scaffold`) replaces `composition.html/js/css` with a frame-driven starter; records `config.libraries`. Returns `{ library, version, global, addons, copied, scaffolded, notes }`. **`three`** = Three.js (~600 KB); **`babylon`** = Babylon.js (~8 MB, built-in glow/bloom/postprocessing). Three addons (v0.19): `geometries` = `THREE.TeapotGeometry`; `loaders` = `THREE.GLTFLoader`; `postprocessing` = EffectComposer/RenderPass/UnrealBloomPass/ShaderPass + shader deps, injected in load order (multi-file addons supported). Babylon addon `loaders` adds glTF/GLB import via `SceneLoader`.  **Provenance (v0.13):** records `config.libraryBuilds` = `{ version, sha256, bytes }` per copied file, and returns each `copied` entry with its `sha256`. The builds are committed and version-pinned, with `engine/vendor.lock.json` recording which upstream build each came from, so a render can be traced to exact bytes — see [3d-libraries.md](3d-libraries.md) §3.5. |

The returned `notes` are **determinism rules you must follow** in the composition:
drive all animation from the injected `frame` — no `requestAnimationFrame`, no
`THREE.Clock` / Babylon `runRenderLoop` / particle systems (all wall-clock based).
The starters set `preserveDrawingBuffer` + a per-frame GL `finish()`, and compile
shaders up front (else a single-frame capture is blank). **Loading a glTF/GLB
model** additionally needs `MOTION_STUDIO_ALLOW_LOCAL_FETCH=1` (file:// fetch) and
a working recipe — see [3d-libraries.md](3d-libraries.md).

### Music (v0.8; two vendors since v0.17)

Compose a music bed from a note spec **you author**. The spec becomes MIDI and is
rendered against a General MIDI SoundFont, and — like `synthesize_speech` — the
result is a normal `config.audio` track mixed into the final render. Two vendors:
`node` (default — renders in-process, works on any OS, needs only a SoundFont)
and `fluidsynth` (the Windows exe chain: `MOTION_STUDIO_MIDI_EXE` +
`MOTION_STUDIO_FLUIDSYNTH` + `MOTION_STUDIO_SOUNDFONT`). Omit `vendor` to use the
configured default — `list_vendors` says which that is. A vendor that is not
usable → `music_unavailable`, naming what to fix (and any sibling that is ready).
See [music-setup.md](music-setup.md).

| tool | arguments | returns / notes |
|---|---|---|
| `synthesize_sfx` **(v0.12)** | `projectId`, `spec` (req: `cues[]`, optional `durationInFrames`/`sampleRate`/`normalize`/`ceilingDb`), `mode?` = `attach`, `assetPath?` (default `assets/sfx-<n>.wav`), `startInFrames?`, `gainDb?` | Renders a list of sound-effect **cues** into one mono WAV and (in `attach` mode) appends the track. **Pure JS — nothing to install, works on every OS, and has no `*_unavailable` error**, unlike speech and music. One call makes the whole bed: a single track holding every cue at its absolute time, which is what `build_film`'s master timeline wants. **Time is in frames**: `atFrame` matches `startInFrames`/`filmOffset`, so a chime on every scene cut is a map over scene offsets; `at` (seconds) is accepted instead — exactly one of the two. `gain` is the cue's **peak amplitude 0..1, not dB**, and means the same thing for every type. Types: `chime`, `whoosh`, `shimmer`, `thud`, `tone`; pitched cues take `pitch` (MIDI) **or** `hz`. Levels: `normalize:"ceiling"` (default) attenuates only a mix hotter than `ceilingDb`, so the returned `peakDb` is the real level — also reports `rawPeakDb` and `appliedGainDb`. `fps` and the default bed length come from the project. Limits: 512 cues, 30 s per cue, `sampleRate` ∈ 22050/44100/48000 (a 10-minute 44.1k bed is ~53 MB — prefer 22050 for long beds). A cue overhanging the end is clamped and counted in `clamped`; one starting past the end is an error. Errors: `invalid_sfx_spec` (offending cue index in `detail`), `path_outside_project`. See [sfx-setup.md](sfx-setup.md). |
| `synthesize_music` | `projectId`, `spec` (req), `vendor?` (`node` | `fluidsynth`), `mode?` = `attach`, `assetPath?` (under `assets/`, default `assets/music-<n>.wav`), `startInFrames?`, `gainDb?`, `duck?` **(v0.19)** | Renders `spec` to a WAV in `assets/` and returns `{ assetPath, bpm, tracks, notes, musicalDurationSeconds, durationSeconds, durationInFrames, fps, bytes, … }`. `durationInFrames`/`durationSeconds` come from the WAV (includes FluidSynth's reverb tail — longer than `musicalDurationSeconds`); use it to size the video, and `startInFrames`/`gainDb` (e.g. `-8`) to place and balance the bed under narration. `mode:"attach"` also appends the track (`duck: true` **(v0.19)** marks it for sidechain auto-ducking under the non-ducked tracks); `mode:"asset-only"` writes + reports only. Also reports the `vendor` used and the **measured `peakDb`** of what was written (plus `attenuatedDb` when `music.targetPeakDb` pulled it down) — you cannot hear the bed, so that number is how you know whether it will fight the narration; an explicit `vendor` differing from the machine default adds a `vendorNote`. Errors: `music_unavailable`, `invalid_music_spec` (`detail.problems` lists every bad field), `music_failed`, `path_outside_project`. |

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
| `preview_audio` **(v0.19)** | `projectId`, `outputFilename?` = `audio-preview.wav` | Mixes `config.audio` to a standalone WAV in `out/` using the **exact** filter graph the final render will use (delay, gain, trim/fades, ducking, limiter) — no video pass, so it takes seconds. Returns `{ outputPath, durationSeconds, limiter, tracks: [{ …track, clipPeakDb, clipMeanDb }], mix: { peakDb, meanDb, clipping, envelopeDb, silentTailSeconds } }` — audition the mix and catch a bad balance (and which track caused it) **before** rendering. `envelopeDb` is the mix's per-second RMS (`null` = digital silence) and `silentTailSeconds` the length of the dead run at the end, so a mix that goes silent early is visible even when the whole-file peak/mean look healthy. Errors: `no_audio_tracks` (empty `config.audio`), `path_outside_project`, `ffmpeg_failed`. |

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
