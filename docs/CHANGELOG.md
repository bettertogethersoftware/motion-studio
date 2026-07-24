# Motion Studio — Changelog

## v0.9 (2026-07-25)

### Long-form films — assemble scenes with `build_film`

**Build videos longer than a single composition** by authoring each scene as its
own project and stitching the rendered scenes together with the new `build_film`
MCP tool (`engine/src/core/film.js`, `engine/src/mcp/server.js`). This is the
answer to "can it do an hour?": not as one monolithic 108k-frame composition, but
as many short, independent, resumable scene renders concatenated losslessly.

- **Lossless assembly.** Scene outputs are concatenated with `ffmpeg -c copy`
  (no re-encode) — reusing the very `encoder.concatSegments` the parallel renderer
  already uses to merge frame-range segments, now applied across projects. Assembly
  is near-instant regardless of film length.
- **Consistency invariant.** Scenes must share resolution/fps/format/pixel-format
  (mp4/webm/prores only — gif/png-sequence can't be stream-copied). A mismatch
  fails with the new `inconsistent_scenes`; an unrendered scene with
  `scene_not_rendered` (the tool assembles, it never renders — rendering stays with
  the existing async `render` tool).
- **Audio, two ways.** With no `audio`, each scene's own audio is preserved (all
  scenes must be consistently audio or silent). Pass an `audio` master timeline
  (`{ src, startInFrames?, gainDb? }`, like `config.audio`) to lay one score +
  narration over the *whole* film via `encoder.muxAudio` — the clean path for
  long-form.
- **Quality.** The concat is lossless, so quality is set by scene render settings
  (`output.crf`/`preset`, or ProRes/PNG intermediates) and one final delivery
  encode of the master. See [film-setup.md](film-setup.md).
- New error codes: `inconsistent_scenes`, `scene_not_rendered`, `film_failed`.
  Additive only — no existing tool or workflow changes; short single-composition
  videos work exactly as before. Tool count 19 → 20.

## v0.8 (2026-07-25)

### Music generation (MIDI → FluidSynth)

**Compose a music bed from a note spec** with the new `synthesize_music` MCP
tool (`engine/src/core/music.js`, `engine/src/mcp/server.js`). The agent authors
a small JSON spec (bpm + tracks of notes); the engine renders it to a Standard
MIDI File, then to audio, and — like `synthesize_speech` — attaches it as a
normal `config.audio` track so the next render mixes it in. This closes the
last "can play but can't generate" gap: v0.6 generated *speech*, v0.8 generates
*music*, and both flow through the audio mux the engine already had.

- **Two-stage, spawn-based pipeline** mirroring the TTS design (no new npm deps,
  no synthesis in Node):
  `note spec → MotionStudioMidi.exe (DryWetMIDI) → song.mid → FluidSynth + a
  General MIDI SoundFont → WAV → config.audio track`.
  The MIDI-authoring half is a self-contained C# console exe
  (`music/MotionStudioMidi`, DryWetMIDI 7.2.0) built the same way as the TTS exe;
  FluidSynth is the provided `fluidsynth.exe`; the SoundFont is any `.sf2`/`.sf3`.
- **Spec** (all authored by the agent): `bpm`, plus `tracks`, each with a General
  MIDI `program` (0..127; 0 piano, 32 acoustic bass, 40 violin, 48 strings, 56
  trumpet, 73 flute…) or `drums:true` (routes to GM percussion, channel 10), and
  `notes` of `{ pitch 0..127 (60 = middle C), start, duration (both in beats),
  velocity? }`.
- **Windows-only, optional.** Three external pieces, each resolvable by env var
  with a git-ignored vendored default under `engine/vendor/`:
  `MOTION_STUDIO_MIDI_EXE`, `MOTION_STUDIO_FLUIDSYNTH`, `MOTION_STUDIO_SOUNDFONT`.
  Any missing piece → the new `music_unavailable` code (named in the error), and
  the rest of the engine is unaffected. New codes: `music_unavailable`,
  `music_failed`, `invalid_music_spec`. See [music-setup.md](music-setup.md).
- **Durations.** Returns `musicalDurationSeconds` (the note content) *and*
  `durationSeconds`/`durationInFrames` — the latter re-derived from the WAV
  header (via `tts.js`'s `wavDurationSeconds`), which is longer because FluidSynth
  adds a reverb/release tail; the WAV is what FFmpeg actually muxes. Use
  `durationInFrames` to size the video, and `startInFrames`/`gainDb` to place and
  balance the bed under narration (e.g. `gainDb: -8`).
- `mode:"attach"` (default) writes `assets/music-<n>.wav` and appends the track;
  `mode:"asset-only"` writes + reports only. Tool count 18 → 19.

## v0.7 (2026-07-25)

### Optional 3D libraries (Three.js / Babylon.js)

**Attach a 3D rendering library to a project** with the new `add_library` MCP
tool (`store.addLibrary`, `engine/src/core/libraries.js`). It copies a pinned
library build **locally** into the project — never a CDN at render time, so
renders stay hermetic and reproducible — and scaffolds a frame-driven starter
composition (`engine/templates/lib-three`, `engine/templates/lib-babylon`).

- `library: "three"` — Three.js (~600 KB, lightweight) or `"babylon"` —
  Babylon.js (~8 MB, built-in glow/bloom/postprocessing). `scaffold` (default
  true) swaps in the starter; the attached library is recorded in the new
  optional `config.libraries` array.
- The big builds are **git-ignored** under `engine/vendor/libs/` and fetched with
  `node scripts/fetch-libs.mjs` (URLs live in the registry). A missing build
  returns the new `library_unavailable` error code; `MOTION_STUDIO_LIBS_DIR`
  overrides the vendor location (used by tests).
- **Determinism contract** (returned to the agent as `notes`, and baked into the
  starters): drive all animation from the injected `frame` — no
  `requestAnimationFrame`, no `THREE.Clock` / Babylon `runRenderLoop` / particle
  systems (all wall-clock based); starters set `preserveDrawingBuffer` and call a
  GL `finish()` each frame so the headless screenshot captures it. Confirmed
  WebGL renders in the headless path (SwiftShader/GPU); both starters render end
  to end through Chromium + FFmpeg.
- Neither library is in the base scaffold — 2D projects carry nothing extra.
- **glTF/GLB models**: the babylon `loaders` addon (`add_library { library:
  "babylon", addons: ["loaders"] }`) vendors `babylonjs.loaders.min.js` and
  injects it, for `SceneLoader.ImportMeshAsync`. Loading a model over `file://`
  needs the opt-in **`MOTION_STUDIO_ALLOW_LOCAL_FETCH`** env (adds Chromium
  `--allow-file-access-from-files`; off by default — `fetch`/XHR to `file://` is
  otherwise CORS-blocked). Verified end to end on a 13.5 MB model. See
  [3d-libraries.md](3d-libraries.md).
- **Shader warm-up in the starters**: Babylon/Three compile materials lazily and
  skip not-ready meshes on the *first* render, so a single-frame capture
  (render_still / capture_preview_frame / frame 0) came back blank. The starters
  now compile up front (`material.forceCompilationAsync` / `renderer.compile`)
  before registering the composition.

## v0.6 (2026-07-24)

### Text-to-speech narration

**Generate a voiceover from text** via two new MCP tools, `synthesize_speech`
and `list_voices` (`engine/src/core/tts.js`, `engine/src/mcp/server.js`).
Narration is synthesized by an external, self-contained Windows console
executable that the engine spawns the same way it spawns FFmpeg; its path is
supplied through the new `MOTION_STUDIO_TTS_EXE` environment variable. See
[tts-setup.md](tts-setup.md) for the CLI contract and build steps.

*Rationale / scope.* Motion Studio already muxed pre-supplied audio tracks
(`config.audio`, `core/encoder.js`); the only missing piece was *generating*
speech. The renderer and the audio mux are untouched — `synthesize_speech`
writes a WAV into `assets/` and, in the default `attach` mode, appends a normal
`{ src, startInFrames?, gainDb? }` track, so a synthesized voiceover flows
through the exact path a hand-supplied one already did. The tool also returns
the clip length as `durationInFrames`, letting an agent size a `Sequence()` to
the narration; `mode: "asset-only"` synthesizes and reports the duration
without modifying `config.audio`.

- Duration is derived authoritatively from the WAV RIFF header on the Node side
  (exactly what FFmpeg later muxes), not from the exe's self-report.
- New stable error codes (`core/errors.js`): `tts_unavailable` (engine not
  configured — the feature is Windows-only and optional), `unsupported_voice`,
  and `tts_failed`. The TTS tools do **not** gate on the render prerequisites,
  so a machine with no speech engine still renders everything else normally.
- The reference exe (`tts/MotionStudioTts/`) ships two backends: **WinRT**
  (`Windows.Media.SpeechSynthesis`, default — the OneCore "mobile" voices,
  more voices including male) with automatic fallback to **SAPI5** COM
  automation (`--engine sapi`). Either way it emits the same CLI-contract WAV +
  JSON that `list_voices`/`synthesize_speech` consume.
- This deliberately reintroduces an optional, Windows-only native dependency —
  narrowly, only for speech synthesis — without disturbing the cross-platform
  engine established in v0.5.

## v0.5 (2026-07-08)

v0.5 evolves the v0.2 implementation into a commercial-ready, cross-platform
product. The upload accompanying this release contained the complete v0.2
implementation as the reference spec (there was no separate v0.5 spec
document), with license to change anything for a better solution. Every
deliberate departure from v0.2 is recorded here with its rationale.

### Headline changes

**1. The Windows-only C# WinForms app is replaced by a cross-platform Studio
web UI** (`engine/src/studio/`, `npm run studio`).

*Rationale.* The engine has always been Node.js; the WinForms shell restricted
the human path to Windows, required a second toolchain (.NET 8 + WebView2),
and could not be built or tested on the Linux/macOS machines most motion work
happens on. The Studio server is a zero-dependency `node:http` process bound
to `127.0.0.1` that serves a vanilla-JS single-page UI. Nothing was lost in
the translation that mattered:

- Preview fidelity is *better*: the preview iframe loads the project's actual
  entry HTML from `/preview/:id/` and is driven through the identical
  `window.setFrame(n)` contract the headless renderer uses. WebView2 preview
  approximated the render; this *is* the render path minus Chromium headless.
- Scrubbing, play/pause at project fps, hot reload (SSE + `fs.watch`),
  render orchestration with progress/ETA/cancel, logs, and output download
  all carry over.
- The Job-Object process-tree-kill duty the WinForms orchestrator performed
  is owned by the engine's `JobManager` (which the Studio server, the MCP
  server, and the CLI all share), so cancellation still leaves no orphaned
  Chromium or FFmpeg on any OS.
- The JSON-line stdout protocol the WinForms app consumed is unchanged, so
  any external orchestrator that spoke it still works.

**2. Output formats** (`core/formats.js`): `mp4` (H.264, default), `webm`
(VP9), `gif` (two-pass palette), `prores` (.mov, 422 HQ / 4444), and
`png-sequence` (a folder of frames, no encode). `output.format` in
`project.json`; the output filename's extension is kept in lockstep with the
format automatically.

**3. Alpha-channel renders**: `output.transparent: true` captures with
Chromium's `omitBackground` and encodes alpha-capable formats (`webm` →
yuva420p with alt-ref disabled, `prores` → 4444, `png-sequence` → RGBA).
Validation rejects `transparent` on formats that cannot carry alpha.

**4. Parallel merge strategy is now format-aware.** mp4/webm/prores opaque
segments are copy-concatenated exactly as in v0.2 (fast path, no re-encode).
GIF — whose per-segment palettes cannot be concatenated — and *any*
transparent render go through a lossless FFV1/RGBA intermediate per worker,
one copy-concat, and a single final encode pass, so the parallel result is
bit-equivalent to the serial one.

**5. Render queue replaces fail-fast concurrency** (`core/jobs.js`).
Submitting a render while one is running used to fail with
`render_already_in_progress`, forcing agents into poll-then-submit races.
Jobs now queue FIFO (`queued → running → done|error|cancelled`, still one
render at a time by default). The queue is bounded (10) so an unattended
agent loop cannot fan out unbounded work — a full queue fails with the new
`queue_full` code. Cancelling a queued job dequeues it without starting.

**6. Progress now carries `etaMs`** (null until at least 3 frames of signal),
in the stdout protocol, job status, the Studio UI, and MCP polling.

**7. Still export**: `renderStill()` in the core, `render_still` MCP tool,
`--capture-frame` CLI flag (unchanged), and a "still ⤓" button in the Studio.

**8. Binary asset ingestion**: `write_asset_file` MCP tool accepts base64
content, confined to the project's `assets/` folder, with an extension
allowlist (images/audio/fonts/json/txt) and a 25 MB decoded-size cap
(`asset_too_large`). This closes the v0.2 gap where agents could author
compositions but not supply a logo or a music bed.

**9. Project removal**: `remove_project` MCP tool / `DELETE /api/projects/:id`.
Unregisters; deletes files only when explicitly requested *and* the folder
lives under the managed projects root — projects registered at user-chosen
paths are never deleted from disk.

**10. Frame API v1.1** (`src/runtime/frame-api.js`), all pure functions of
frame and therefore safe under parallel/out-of-order rendering:
- `spring(frame, {fps, stiffness, damping, mass})` — closed-form damped
  spring from 0→1 (no simulation state).
- `interpolateColors(frame, inputRange, colors)` — piecewise color
  interpolation over hex/rgb()/rgba() stops, returns an `rgba()` string.
- `Loop(durationInFrames, fn)` — repeats a sub-animation with
  `(localFrame, cycleIndex)`.

**11. Config schema v2.** `output.format` + `output.transparent` added.
v1 configs are migrated on read, non-destructively; `crf` range widened to
0–63 (VP9). Even-dimension enforcement now applies only to formats whose
pixel formats require it (gif and png-sequence accept odd sizes).

**12. New error codes** (additive): `unsupported_format`, `asset_too_large`,
`queue_full`. All v0.2 codes are unchanged; `render_already_in_progress` is
retired from the render path (superseded by queueing) but the code remains
reserved.

**13. CLI**: `--intermediate` (internal, used by parallel workers for the
FFV1 path) and `--doctor` (prints the prerequisite check as JSON, exit 0/3).

### Testing

- 102 automated tests across 8 suites (v0.2 shipped 62): core, pipeline,
  CLI, MCP (real SDK client over stdio), frame-api (vm-hosted runtime),
  v0.5 features, Studio HTTP server, and a gated real-Chromium suite.
- All FFmpeg encodes in tests are real and probe-verified (codec, pixel
  format, frame counts), including transparent WebM alpha and the parallel
  GIF/png-sequence merge paths across true process boundaries.
- The real-Chromium suite (capture determinism, serial mp4, genuine alpha in
  `omitBackground` captures) runs wherever a browser is resolvable and skips
  honestly elsewhere.
- The shipped example outputs (`examples/*/out/`) were rendered with real
  headless Chromium + FFmpeg through the parallel path, including the
  transparent `lower-third.webm` (probe: `alpha_mode=1`; decoded frame 60:
  85% fully-transparent pixels with partial-alpha shadow edges).

### Compatibility

- v0.2 `project.json` files load unchanged (schema migration on read).
- The CLI flags, JSON-line progress protocol, error-code set, and all twelve
  v0.2 MCP tools are preserved; v0.5 adds three tools and queue semantics.
- `render` responses now include `state` (`running` | `queued`) and, when
  queued, `queuePosition` — additive fields.

## v0.2

Initial reference implementation: deterministic frame-driven render pipeline
(Puppeteer capture → FFmpeg stdin pipe), project system with path sandbox,
JSON-line progress protocol, parallel rendering with copy-concat, audio
mixing, MCP server with twelve tools, C# WinForms desktop app (Windows), and
a 62-test suite. See `docs/spec-changes.md` for the v0.2-era decision log.
