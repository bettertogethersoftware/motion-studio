# Motion Studio — Changelog

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
