# Motion Studio — Architecture

## 1. System overview

Motion Studio is three thin entry points around one shared render engine.

```
 Human path                                 Agent path
 ──────────                                 ──────────
 Browser → Studio web UI                    MCP client (Claude Desktop / Code)
   http://127.0.0.1:7345                            │  MCP over stdio
        │ HTTP/SSE (localhost only)                 ▼
        ▼                                   MCP server (engine/src/mcp/server.js)
 Studio server (engine/src/studio/)           bound to ONE workspace
   ALL workspaces / films / scenes                  │  path sandbox
   library / assets / settings                      │
   preview / render / film-build API                │
   hot-reload SSE, output download                  │
        │            in-process calls               │
        └──────────────┬────────────────────────────┘
                       │            ┌── CLI (engine/src/cli/render.js)
                       ▼            ▼      scripts, CI, parallel workers
        Render Engine Core (engine/src/core/)
          store.js     — workspace → film → scene storage (§11)
          migrate.js   — one-shot pre-v0.20 layout migration (§11.2)
          scene.js     — scene config schema, scaffolding, source lints
          renderer.js  — capture loop, parallel split, stills
          browser.js   — Puppeteer lifecycle (injectable)
          encoder.js   — FFmpeg pipe / sequence / concat / transcode / audio
          formats.js   — output-format registry (mp4 webm gif prores png-seq)
          jobs.js      — job queue (render + task lanes), status, logs, cancel (§5)
          progress.js  — JSON-line protocol (+ etaMs)
          settings.js  — global user preferences (all entry points; see §11)
          vendors.js   — vendor kit: selection, status, errors (see §9.2)
          tts-vendors.js / music-vendors.js / transcribe-vendors.js
                       — per-capability dispatch
          transcribe.js — reading supplied speech: extract, derive, cache (§9.3)
          transcode.js — preparing media: named fields only, no shell (§9.4)
          film.js      — scene assembly primitives (lossless concat, §13)
          films.js     — film documents: validation, planning, build (§13)
          revisions.js — immutable scene-revision archive + pointers (§14)
          deliveries.js— immutable film deliveries + frozen manifests (§14)
          advice.js    — durable human advice, leases, evidence (§14)
          events.js    — production event bus + workspace watcher (§14)
          activity.js  — agent heartbeats + production status (§14)
                       ▼
        headless Chromium ──PNG──▶ FFmpeg ──▶ mp4 / webm / gif / mov / frames
```

The asymmetry in that diagram is the point of v0.20: **an agent sees one
workspace, the human sees them all.** Each MCP server is bound to a single
workspace (`MOTION_STUDIO_WORKSPACE`), so two agents working at once cannot
land in each other's films; the Studio browses every workspace, because the
human owns the machine and needs one place to review what was made.

The engine core is the *only* implementation of "launch Chromium / capture a
frame / run FFmpeg". The CLI translates process arguments and signals into
engine calls and streams the protocol to stdout; the MCP server translates
tool calls into the same engine calls and folds the same protocol into
pollable job state; the Studio server exposes the same calls over local HTTP
for the UI. Because all paths share the fragile parts (Puppeteer lifecycle,
process trees, encoding), they cannot drift apart.

The MCP boundary deliberately uses portable JSON Schema shapes. Fixed-size
vectors such as `render.frameRange` are emitted as homogeneous arrays with
`minItems`/`maxItems`, rather than draft-07 tuple-style `items: [...]`. Some
strict MCP importers reject the latter and omit the entire tool even though the
official SDK accepts it. Number-or-null fields (`audioTargetPeakDb`, overlay
`widthPct`) publish as `anyOf [number, null]` and additionally COERCE the
string forms at runtime (`"-2"` → −2, `"null"`/`""` → null, v0.23): a client
that flattens `anyOf` to `{}` has no type to coerce against and delivers the
model's argument as a string, which a plain union would reject after a
successful discovery.

v0.2 shipped a Windows-only C# WinForms app on the human path; v0.5 replaces
it with the Studio web UI — see [CHANGELOG.md](CHANGELOG.md) for the full
rationale (cross-platform, one toolchain, and strictly better preview
fidelity since the browser preview drives the project's real entry HTML).

## 2. The frame model

A composition is a folder with `scene.json` (fps, dimensions, duration,
output and audio settings), an HTML entry point, and JS that registers a
per-frame function through the copied-in `frame-api.js` runtime. The engine
loads the entry in headless Chromium, then for each frame: sets
`window.frameReady = false`, invokes `window.setFrame(n)`, waits for
`frameReady === true` (or `window.__frameError`), screenshots, and streams
the PNG onward. Because every frame is a pure function of `n`, frames can be
captured in any order and split across worker processes; the full contract,
including the `registerComposition` harness that makes async readiness
correct by default, is in [frame-api.md](frame-api.md).

Determinism supports beyond the contract itself: Chromium is launched with
`--force-color-profile=srgb`, `--disable-lcd-text`, and
`--font-render-hinting=none` so pixel output does not vary with the host
display, and the runtime provides `MotionStudio.random(seed)` (and, in v1.1,
closed-form `spring()`) so compositions never need `Math.random()` or
stateful simulation.

### 2.1 Frame geometry (v0.27)

Every page the engine opens — preview, still, proxy draft, final render —
carries the frame's own geometry as CSS custom properties, injected before the
document parses: `--ms-width`/`--ms-height` plus six `--ms-safe-title-*` and
six `--ms-safe-caption-*` values. `core/deliverables.js` `safeAreaVariables()`
is the only place they are computed; `renderer.js` `compositionVariables()`
takes them from the render target (and, when one is rendering, a deliverable's
own insets), and the Studio's scene API hands the identical map to the preview
iframe. `MotionStudio.frameSize()`/`safeArea()` (runtime v1.6) read them back,
falling back to the same documented percentages when a host injects nothing.

Two properties make this load-bearing rather than cosmetic:

- **The safe rectangles are the review artefact's rectangles.** The contact
  sheet's guides and these variables come from the same insets, so a
  composition that stays inside them passes the review it will be judged by.
- **The layout viewport is always the authored size**, including under a proxy
  (§12.1). Without that, `100vw` would mean one thing in a draft and another in
  the deliverable, and the contract would be a lie in exactly the cheap render
  path an agent uses most.

This is the authoring half of aspect variants: Stage A (§13) crops a finished
master, which is all a fixed-pixel composition can survive; a composition that
sizes itself from these values can instead be *re-rendered* at the variant's
geometry — the Stage B path — because its layout is a function of the frame
rather than a memory of one. The engine states the geometry; it does not
enforce its use, and a composition that ignores it renders exactly as before.

## 3. Output formats

`core/formats.js` is the single registry of deliverable formats. Each entry
declares its container extension, FFmpeg encode arguments, whether alpha
survives (`supportsAlpha`), and whether the parallel path may merge segments
with `-c copy` (`copyConcat`). The rest of the engine never spells out codec
flags.

| format | container | codec | alpha | parallel merge |
|---|---|---|---|---|
| `mp4` (default) | .mp4 | libx264, yuv420p, faststart | — | copy-concat |
| `webm` | .webm | libvpx-vp9 (CRF, row-mt) | yuva420p, alt-ref off | copy-concat (opaque) |
| `gif` | .gif | palettegen/paletteuse (split) | — | FFV1 intermediate |
| `prores` | .mov | prores_ks 422 HQ / 4444 | 4444 + yuva444p10le | copy-concat (opaque) |
| `png-sequence` | folder | none (frame PNGs) | RGBA | frames renumbered |

`output.transparent: true` threads through the whole pipeline: Chromium
captures with `omitBackground` (unpainted pixels are alpha 0), and encoding
uses the format's alpha pixel format. Validation rejects `transparent` on
formats that cannot carry it, and requires even dimensions only for
chroma-subsampled formats. Switching `output.format` automatically renames
the configured output file's extension so a `.mp4` never silently contains
VP9.

Final colour-carrying encodes also state one contract: BT.709 primaries and
matrix, sRGB transfer (`iec61966-2-1`), and TV range. `formats.outputColorFilter`
supplies the one `setparams` filter shared by serial renders, parallel renders,
and the film finishing pass; it deliberately does not apply to GIF, a PNG
sequence, or the RGB intermediate used to make a GIF. `outputColorProfile` is
derived from that same choice for signatures and sidecars, so callers are told
what the encoder was instructed to make rather than what one installed ffmpeg
happened to probe afterward.

## 4. IPC: the JSON-line progress protocol

Everything the engine reports crosses one contract,
`engine/src/core/progress.js` — one JSON object per stdout line:

| type | fields | meaning |
|---|---|---|
| `start` | `jobId, totalFrames, fps, width, height` | render accepted, dimensions locked |
| `progress` | `frame, totalFrames, framesDone, elapsedMs, renderFps, etaMs` | one per captured frame (aggregated across workers; `etaMs` null until ≥3 frames of signal) |
| `phase` | `phase` | `capturing` → (`concat`) → `encoding` → (`audio`) |
| `log` | `level, message` | diagnostics worth showing |
| `done` | `outputPath, frames, elapsedMs, promoted?, framesVerified?` | terminal success; file deliveries only report `promoted: true` after staging has been renamed into place |
| `error` | `code, message, detail?` | terminal failure — exactly one is emitted, at whichever layer caught it first |

The MCP `JobManager` and the Studio server tap the same emitter in-process to
maintain the snapshot returned by `get_render_status` / `GET /api/jobs/:id`;
any external orchestrator can parse the CLI's stdout stream directly.
Non-JSON stdout lines (e.g. a dependency printing) are wrapped as `log`
messages so no consumer can be crashed by stray output. CLI exit codes: `0`
ok, `2` bad arguments/config, `3` prerequisites missing, `4` cancelled, `1`
render error.

## 5. Jobs and the render queue

`core/jobs.js` owns job lifecycle for both the MCP and Studio paths:
`queued → running → done | error | cancelled`. One render runs at a time by
default; further submissions queue FIFO and start automatically, replacing
v0.2's fail-fast `render_already_in_progress` (which forced agents into
poll-then-submit races). The queue is bounded (10) — a full queue fails with
`queue_full` — so an unattended agent loop still cannot fan out unbounded
work, and `MOTION_STUDIO_MAX_RENDERS` optionally caps total renders per MCP
session. Cancelling a queued job dequeues it without ever starting it. Job
status includes `percent`, `renderFps`, `etaMs`, and `queuePosition` while
queued.

**Two lanes (v0.22).** The render lane is deliberately one-at-a-time because a
render saturates the machine. `transcribe_asset` (§9.3) is the first job that is
not a render, and it must not sit behind one: transcription is what you do
*while* deciding what to render, so a ten-second read of a clip stuck behind a
twelve-minute render is the opposite of the point. `startTask` therefore submits
into a **second lane** with its own concurrency limit (2) and its own bounded
queue (20), sharing everything a caller already knows how to use — the id space,
`get_render_status`, `wait_for_render`, `get_logs`, `cancel_render`. The visible
differences are exactly three: `kind` names the job type (`"render"` vs
`"transcribe"`), a task has no frames (so `percent` stays 0 and `phase` is what
to watch), and a finished task carries its `result` in the status — because a
task's result *is* the answer, where a render's is the file at `outputPath`.
The lanes never borrow each other's slots; a queue that quietly let
transcriptions take the render slot would reintroduce the head-of-line blocking
the split exists to remove. `MOTION_STUDIO_MAX_RENDERS` likewise does not apply
to tasks: it bounds an unattended agent's *renders*, and reading a file it was
handed is not one.

## 6. Error model

All cross-boundary failures are `EngineError`s with a stable
machine-readable `code` (`engine/src/core/errors.js`): `prereqs_missing`,
`scene_not_found`, `scene_already_exists`, `invalid_config`,
`path_not_allowed`, `file_not_found`, `syntax_error`, `job_not_found`,
`browser_launch_failed`, `composition_error`, `frame_timeout`,
`ffmpeg_failed`, `cancelled`, `disk_error`, `internal_error`, and — new in
v0.5 — `unsupported_format`, `asset_too_large`, `queue_full`. New in v0.11:
`short_render` (the encoded file has fewer frames than were rendered). New in
v0.14: `browser_crashed` — a crash-shaped Chromium failure ("Target closed" et
al.), classified so it stops masquerading as `composition_error`/
`frame_timeout`/`internal_error`; the capture loop relaunches and retries on it.
New with saved films: `film_not_found` and `invalid_film` (the latter carries
the FULL `problems` list in `detail`, because an editor fixing a film wants
every complaint at once)
in place, and it only surfaces after the per-render relaunch budget (3) is
spent. New in v0.19: `no_audio_tracks` — `preview_audio` on a target whose
audio timeline is empty. New in v0.20 (the storage model): `workspace_not_found`,
`film_already_exists`, `invalid_id` (an id that is not a well-formed slug path
— a different mistake from "that scene does not exist", and worth a different
code), and `migration_failed`. `project_not_found` / `project_already_exists`
were renamed `scene_not_found` / `scene_already_exists` with the concept;
nothing had shipped, so there are no legacy aliases.
The generated-audio and library features carry their own codes: v0.6–v0.7
`tts_unavailable`, `tts_failed`, `unsupported_voice`, `library_unavailable`;
v0.8 `music_unavailable`, `music_failed`, `invalid_music_spec`; v0.9
`inconsistent_scenes`, `scene_not_rendered`, `film_failed`; v0.21 adds
`stale_render` (the output exists but was rendered at settings the scene no
longer has — distinct from `short_render`, where the file is incomplete); v0.12
`invalid_sfx_spec`; v0.22 `transcription_unavailable`, `transcription_failed`,
and `transcription_input_unsupported`. The `*_unavailable` pair means "not
configured on this machine — a setup problem, do not retry"; the `*_failed` pair
means the configured tool itself failed. (There is deliberately no
`sfx_unavailable`: sfx is pure JS with nothing to configure.)
`transcription_input_unsupported` is a **third** category the generators did not
need: the vendor is fine and the setup is fine, but the *file* has no readable
speech in it (not media, no audio stream, a codec this ffmpeg cannot decode). The
fix is a different file, so it is neither the user's setup to repair nor worth a
retry — and conflating it with either would send the caller to the wrong place.
`promotion_blocked` means a complete staged delivery was held by its explicit
review policy; it retains paths to the staged video, JSON report, and contact
sheet, and is distinct from `short_render`, which signals an incomplete encode.
`render_already_in_progress` was retired from the render path in v0.5 and held
reserved; **v0.11 raises it again for a different condition** — not
in-process concurrency, which still queues, but a *second OS process* holding
the project's render lock (§7.1). MCP tools return them as `isError` results with the JSON
body; the CLI emits them as protocol `error` lines; the Studio server maps
them to HTTP statuses (403 sandbox, 404 not-found, 400 invalid, 413
asset-too-large, 429 queue-full, 409 lock-held / name-taken, 502 vendor
failed, 503 prereqs or vendor unconfigured). `write_composition_file`
compile-checks `.js` content (`vm.Script`) and rejects with `syntax_error`
*before touching disk*; writes are atomic (temp file + rename) so a rejected
write never corrupts the previous version.

## 7. Process lifetime and cancellation

No orphaned Chromium/FFmpeg processes, from any path. Cancellation is an
`AbortSignal`: the capture loop checks it between frames, aborting kills the
FFmpeg sink and closes the browser, and `renderParallel` SIGKILLs its worker
processes on abort. As a second layer, every spawned pid (Chromium, FFmpeg,
workers) is reported upward via `onChildPid`; `cancel_render` hard-kills any
of them still alive two seconds after the abort. This engine-level guarantee
is what the v0.2 WinForms Job Object provided on Windows, now owned by the
shared `JobManager` on every OS. Inside the engine, the FFmpeg sink handles
stdin backpressure (`drain`) so a fast capture loop cannot balloon memory,
and a killed sink swallows its own exit rejection so teardown never surfaces
spurious errors.

### 7.1 The render lock (v0.11)

Job queueing (§5) serialises renders *within* one process, which says nothing
about a second process. Two renders on one project is silent corruption rather
than a loud failure: both write the same frame files and both run FFmpeg on the
same output path, so the survivor is whichever finished last and any torn frame
in between is invisible. It has happened for real — an orphaned background
render raced a foreground one through the same scene, and the only symptom was
an unexpected process count.

`core/lock.js` takes a `.render.lock` file (a dotfile, so `listFiles` already
skips it) in the project folder holding the owning pid. **Liveness, not age,
decides staleness:** a render may legitimately run for hours, so a timeout would
eventually evict a healthy job, whereas a crashed owner's pid stops existing at
once. Creation uses `open(…, 'wx')`, so two processes racing cannot both believe
they won. Same-pid acquisition is re-entrant, and release is a no-op unless we
still own the file, so a stale-lock takeover cannot be undone by the loser. An
unreleased lock therefore self-heals: the next acquirer clears any lock whose
owner is gone.

`renderComposition` and `renderParallel` take it; **parallel workers must not**
(`lock: false`, set from the CLI's `--segment`), because they render the same
project by design and their parent already holds one lock covering all of them.
`renderParallel` also delegates to `renderComposition` for a single worker, and
lets the delegate do the locking rather than deadlocking against itself.

### 7.2 Frame-count verification (v0.11)

A worker killed mid-encode leaves a short but perfectly valid video, and nothing
downstream noticed: `build_film` concatenated it and the finished film simply had
a scene that stopped early. After encoding (and after any audio mux), the
renderer probes the file's real frame count and fails with `short_render` if it
disagrees with what was rendered. `encoder.probeFrameCount` reads the
container's `nb_frames` first — muxers write it from the frames actually written,
so a truncated file reports the truncated number for the cost of one metadata
read — and only falls back to a full `-count_frames` decode when that is absent.
ffprobe is **not** a declared prerequisite (§prereqs checks only ffmpeg), so an
unmeasurable file is reported as `framesVerified: false`, never as a failure.
This is what makes "the output exists and has the right length" a trustworthy
resume condition for a long multi-scene batch.

### 7.2.1 Staged file delivery (unreleased)

Every top-level file delivery (scene render, proxy, partial export, or built
film) encodes under its destination's `.staging/` sibling first. The capture
encoder, audio mux, film finishing pass, and delivery review all operate on
that staging path; only a completed file which passes the explicit review
policy is renamed onto the caller-visible name.
Promotion is one native rename — there is deliberately no delete-then-rename
fallback, because retaining the old delivery is safer than creating a gap.
A rename refused with `EPERM`/`EACCES`/`EBUSY` is retried on a bounded
backoff (~1.5s total, v0.23) before failing: on Windows an antivirus or
indexer can briefly lock the destination during rename-over-existing with no
real owner (measured — an unlink of the same path succeeded immediately),
and failing a finished multi-minute render over a sub-second scanner lock
helps nobody. Non-transient codes still fail on the first attempt.
When the backoff is exhausted and a destination exists, the old delivery is
renamed *aside* and the new one put in its place, which Windows permits for
many held files; if that second rename fails the aside copy goes straight
back, so the failure mode stays "old delivery intact".

Because all of that happens at the *end*, `assertDeliveryWritable()` runs at
the **start** of every staged delivery (v0.24) — before the render lock, before
Chromium, before a build's assemble. It write-opens an existing destination
(`r+`, never truncating; a missing one is fine) and fails immediately with
`disk_error` and `phase: "preflight"` if a reader holds it. A held file is not
always recoverable: measured, two consecutive 600-frame renders each ran to
100% over ~3.5 minutes and *then* died at the rename, roughly seven minutes
spent to learn what one file handle reports instantly. The check is advisory
about its own limits — a holder can still appear in the window before
promotion, so it reduces wasted work rather than guaranteeing success — and its
message names both ways out: close the holder (the Studio scene page is the
usual one), or give the target a different `output.filename`.

The terminal result exposes `promoted: true` after that rename and always states
`framesVerified`. A missing/unusable `ffprobe` produces `framesVerified: false`,
not a claimed count match, and does not fail a render because ffprobe is not a
declared prerequisite. A failed/cancelled job retains the staging file and
returns its `stagingPath`; the Studio output listing hides `.staging`.

This applies to single-file formats. PNG sequences are directory deliveries and
need a separate directory-promotion protocol rather than a misleading
delete-and-replace implementation.

### 7.2.2 Delivery review and promotion gate (v0.23)

Before a staged file is promoted, the renderer writes a staged
`<output>.review.json` and `<output>.contact.png`. The report preserves the
probe/frame result, audio and picture measurements, warning severities, and the
exact sampled frames; the contact sheet contains the first and last frames plus
cut boundaries and caption onsets. The default policy blocks only a frame-count
mismatch. Picture/probe/audio findings warn by default, so a measurable review
does not turn an otherwise valid delivery into a false failure. Global
`render.review` settings establish the policy, while a film's `review` field
replaces it for that build. A blocked promotion keeps the old delivery intact
and retains all staged evidence for inspection; the Studio build panel reads
that saved report and overlays its frame diagnostics on the contact sheet.

### 7.3 The render sidecar (v0.21; `environment` since v0.26)

Since v0.26 the sidecar also records which browser produced the pixels — an
`environment` block with the binary's resolution (`bundled` headless shell vs
`MOTION_STUDIO_CHROME`), the headless mode, and the build string when the
writing process launched the browser itself. Deliberately outside the
staleness allowlist: a browser upgrade must not mark every existing render
stale; the field exists so a cross-machine or post-upgrade visual difference
is diagnosable, not to invalidate work.

§7.2 verifies a file against **what was just rendered**. It cannot verify it
against **what the scene says now** — and a config edit after a render is the
common case, because narration length drives scene duration and the duration is
the thing most likely to change late. Existence of the output was the only
"rendered?" signal, so shortening a scene left the plan reporting
`rendered: true` with a `totalFrames` the concatenation cannot produce, and
`build_film` stitched the stale file: every master-audio offset past that scene
then drifted against the picture, silently.

So a render that is the **whole scene, at its current settings, to its real
destination** writes `<output>.render.json` holding
`{ frames, width, height, fps, format, colorPrimaries, colorTransfer,
colorMatrix, colorRange, outputIdentity: { bytes, mtimeMs }, renderedAt }`
(`film.writeRenderMeta`).
`film.renderStaleness` compares it with the live config;
`films.planFilm` surfaces a `stale_render` problem plus a per-scene
`renderVerified`, and `film.validateScenes` refuses the build with the
`stale_render` error code. The guard in `renderer.isFullSceneRender` is what
keeps a proxy, a per-worker segment or a partial `frameRange` from claiming to
be the scene's canonical output.

Two deliberate non-failures, matching §7.2's philosophy: writing the sidecar is
best-effort (a render that already succeeded must not fail on metadata), and a
**missing** sidecar is `renderVerified: null` — unknown, not stale — so output
from an older build still assembles. A sidecar from before stated colour likewise
has no colour fields and is unverified rather than falsely called current; a
present field that differs (for example `colorMatrix: bt601 → bt709`) is stale.
The output identity is likewise a cheap `bytes` + `mtimeMs` mismatch detector,
not a hash or provenance proof: a mismatch is stale, while a legacy sidecar
without an identity stays unverified.

## 8. Parallel rendering

`renderParallel` splits the frame range into contiguous chunks (remainder
spread across the first chunks), spawns one CLI worker per chunk with
`--frame-range a b --segment`, and aggregates their per-worker `progress`
streams into a single monotonically increasing count. The merge is
format-aware:

- **Copy-concat formats, opaque** (mp4, webm, prores): workers encode the
  target codec directly; segments are concatenated with FFmpeg's concat
  demuxer and `-c copy` — no re-encode, identical codec parameters by
  construction.
- **GIF, or any transparent render**: per-segment GIF palettes cannot be
  concatenated, and alpha must survive the merge — so workers encode a
  lossless FFV1/RGBA intermediate (`--intermediate`), the intermediates are
  copy-concatenated, and a single final encode pass produces the target
  file. FFV1 is lossless, so the parallel result is bit-equivalent to a
  serial render.
- **png-sequence**: workers write frames into per-worker folders; the merge
  renames them into the output folder with globally consistent zero-padded
  numbering.

The audio pass runs once, on the merged file. Workers default to
`min(CPU cores, 4)`; beyond ~4 concurrent Chromium instances, memory
pressure typically erases the speedup on desktop hardware.

## 9. Audio

`scene.json` may declare `audio: [{ src, startInFrames?, gainDb?,
trimStartInFrames?, trimEndInFrames?, fadeInFrames?, fadeOutFrames?, duck? }]`.
After the silent video exists, a single FFmpeg pass builds a `-filter_complex`
graph — per-track `atrim`/`afade` (fade-out bounded by the kept window, else by
the composition end), then `adelay` (frame offset → ms) and `volume`, then
`amix` with `normalize=0` so adding a quiet voiceover doesn't duck the music
bed — and muxes with the video stream copied.

The timeline's height is a splitter (v0.27), `--tl-h` persisted per browser,
clamped so the timeline keeps 120px and the STAGE keeps 200px — measured
against the frame minus the header and problems banner, since those live inside
it too. `.fe-stage` needed `min-height: 0` for any of it to work: a grid item's
automatic minimum is its content, so the stage overflowed rather than shrinking
and the player never re-fitted.

The film page renders that mix once and caches it, so **the cache key has to
cover everything that changes the sound** — `audio` *and* `mutedLanes`. It
covered `audio` alone when lane mute arrived, which left a muted lane still
audible from a cache that looked fresh. Invalidating also has to **pause** the
old element before dropping it: revoking an object URL does not stop a media
element that already loaded it, so releasing the reference alone left the stale
mix playing to its end. Mid-playback the page re-renders straight away
(debounced, and re-checked afterwards in case the film moved on again) and
rejoins at the playhead.

**A muted lane is silent everywhere.** `audibleTracks(film)` in `core/films.js`
is the single rule — a track is dropped when its own `mute` is true or its lane
is in `film.mutedLanes.audio` — and the build, `preview_audio` and the balance
warnings all read it, because three answers to "what is audible" would drift.
`hasMasterAudio` stays keyed on the *declared* timeline: muting every track
means the film is silent, not that per-scene audio comes back. Lane mute lives
on the film rather than on the tracks so that a clip dragged into a muted lane
is silent too — which is what muting a track means in any editor.

**Both trims index the source file**, and both name a point rather than a
length: the clip plays `[trimStartInFrames, trimEndInFrames)`. That keeps
`trimEndInFrames` alone meaning exactly what it meant in v0.19 — the clip's
first N frames — while `trimStartInFrames` (v0.27) adds the head trim the
timeline could not offer, which is what "drop the room tone off the front of
this take" needs. A head-trimmed chain **must** follow `atrim` with
`asetpts=PTS-STARTPTS`: atrim keeps the source timestamps, so without it every
head trim would silently arrive `trimStart` late on top of its `adelay`. Proven
against ffmpeg with a file of one second of silence then one second of tone —
the mix's first quarter-second reads `-inf` dB untrimmed and −24 dB with a
30-frame head trim. Every
track chain ends in `aformat` pinning **44.1 kHz stereo**: without it, ffmpeg
negotiates a common format across the mix inputs, and one 16 kHz mono
narration WAV (Piper's native output) silently downsampled the entire mix —
music bed included — to 16 kHz.
**Auto-duck (v0.19):** when some tracks carry `duck: true` and others don't,
the graph splits into a foreground submix and a bed submix and runs
`sidechaincompress` (threshold ≈ −34 dBFS, ratio 8, attack 50 ms, release
400 ms) with the foreground as the key, so the bed dips under narration and
recovers in the gaps; with only one side present the graph is unchanged.
Both the bed and the sidechain are silence-padded (`apad=whole_dur`) to the
composition length before the compressor: `sidechaincompress` is asymmetric
about EOF — a sidechain that ends first terminates the filter (which used to
hard-silence the bed from the last narration clip to the end of the film),
and a bed that ends first stalls the graph forever. Padding both to the same
bound makes them reach EOF together, so neither failure mode is reachable.
`preview_audio` (v0.19) reuses this exact graph against an `anullsrc` stand-in
for the video input to produce a standalone WAV mixdown without a render. The audio codec
comes from the format registry (AAC for mp4, Opus for webm, PCM for ProRes);
GIF and png-sequence cannot carry audio, so configured tracks are skipped
with a `log` warning rather than failing the render. The mixed audio is
`apad`-ded and `atrim`-med to exactly the video duration: a 5-second music
bed under a 0.8-second clip yields a 0.8-second file, which `-shortest`
would not guarantee in the general case. That outer `apad` carries
`whole_dur` too — with the duck branches already ending at exactly the
composition length, an *unbounded* pad feeding `atrim` busy-spins forever on
some builds, so the graph keeps zero infinite generators and terminates by
construction.

**Clipping protection (v0.10).** `normalize=0` is deliberate — it keeps the
music bed at the level the author set — but it also means gains sum straight
through, so three tracks near 0 dB produce a distorted master with nothing to
catch it. The graph therefore ends `[amix] → alimiter(limit=0.841, level=0) →
[aout]`: a brick wall at −1.5 dBFS that is a no-op below the threshold, with
alimiter's auto-levelling pinned off so it can never *boost* a quiet mix. Set
`output.audioLimiter: false` to pass the sum through untouched.

The ceiling is −1.5 dBFS rather than −1 because **the limiter bounds sample
peaks and the deliverable is AAC** (v0.24). A lossy encoder reconstructs
intersample peaks above the samples it was given, so a −1 dBFS ceiling did not
survive the mux: a measured 21-track music-video mix previewed at −1.0 dBFS as
a WAV and then encoded to 0.0 dBFS, raising `audio_clipping` on a mix the
limiter had already done its job on. Since `preview_audio` measures the WAV and
`build_film` measures the encoded result, that gap made the two disagree on the
one audio metric an agent cannot check by ear — and taught callers to ignore
it. Half a decibel of loudness buys the headroom back. After muxing,
the result is decoded once with `volumedetect` and reported as
`audio: { tracks, limiter, peakDb, meanDb, clipping, balanceWarnings }` on the
render result and in `get_render_status` — an agent cannot listen to the
output, so a measured number is the only way it learns the mix clipped.
Measurement failure is logged and ignored; it never fails an otherwise good
render.

**Balance warnings (v0.22).** Clipping's inverse — a track buried under a
louder concurrent track — fails no check at all: the mix only gets quieter.
`computeBalanceWarnings()` (encoder.js, pure) flags any track whose effective
mean (`clipMeanDb + gainDb`) sits ≥8 dB below a louder track overlapping at
least half of its play window; `duck: true` tracks are declared background and
exempt as the quiet side. Both `preview_audio` and the render report
(`reportAudioLevels`, which measures each source clip — WAVs by direct PCM
read, the rest via `volumedetect`) surface the same list, so the problem is
visible whether or not the caller previewed. Same non-fatal contract as the
clipping check.

### 9.1 Generated audio: three sources, one mixer (v0.12)

Everything above is the *mixer*; three generators feed it, and they differ mainly
in what they depend on:

| source | dependency | failure mode |
|---|---|---|
| `synthesize_speech` (v0.6) | a **speech vendor**: the Windows TTS exe, or Azure AI Speech (v0.17) | `tts_unavailable` |
| `synthesize_music` (v0.8) | a **music vendor**: an in-process SoundFont synth, or the MIDI exe + FluidSynth chain (v0.17) | `music_unavailable` |
| `synthesize_sfx` (v0.12) | **none** — pure JS in `core/sfx.js` | *(cannot be unavailable)* |

`core/sfx.js` exists because the other two cannot make an unpitched noise, and
because a filtered-noise riser has no MIDI note number. It is split into a pure
`renderCues(spec) → Float32Array` and a thin `synthesizeSfx({spec, outPath})`
that adds the WAV write, so nearly all of its tests inspect samples directly with
no ffmpeg and no subprocess.

Two design points worth stating because they differ from the rest of the audio
path. First, **time is in frames** (`atFrame`): every other audio placement in
the engine speaks frames, so a cue list maps directly over scene `filmOffset`s.
Second, its default `normalize: 'ceiling'` only attenuates a mix that exceeds the
ceiling, rather than always normalizing to it — the same principle as §7.2 and
`audioTargetPeakDb`, that a reported number should be the measured truth rather
than an artifact of an automatic correction.

Determinism is bounded and documented: noise comes from a seeded PRNG so a spec
re-renders byte-identically on a given Node build, but `Math.sin`/`Math.exp` are
not pinned by ECMAScript, so cross-version identity is not claimed. This does not
weaken frame-render determinism, which is a property of the composition — audio
is generated once and thereafter read as a file.

### 9.2 Vendors (v0.17)

Three capabilities have more than one possible implementation — or, in the
newest case, room for one:

```
speech         →  system (core/tts.js, Windows exe)   |  azure (core/tts-azure.js)  |  piper (core/tts-piper.js)  |  …
music          →  node   (core/music-node.js)         |  fluidsynth (core/music.js)
transcription  →  whisper-cpp (core/transcribe-whisper.js)                                              — v0.22
```

`core/vendors.js` owns what those axes share — the selection rule, the env
hooks, the status-report shape, and the sentence a caller sees when a vendor
cannot be used. `core/tts-vendors.js`, `core/music-vendors.js` and
`core/transcribe-vendors.js` supply the providers on top; the shared module
imports none of them, so capability modules
depend on the kit and never the reverse. Within a capability, providers return
identical payload and probe shapes, so nothing downstream branches on vendor:
`synthesize_speech`, `synthesize_music`, `transcribe_asset`, the Studio pages and
the audio mixer each see one source.

Transcription joins the kit with exactly **one** vendor, on purpose. A capability
with one provider costs nothing extra to run through the shared machinery, and
the alternative — a second, near-identical resolution path with its own
precedence and its own "not configured" sentence — is the thing the kit exists to
prevent. It is also why `list_vendors` and the Studio's three vendor pages are one
projection rather than three.

Selection uses the standard precedence — explicit argument →
`MOTION_STUDIO_TTS_VENDOR` / `MOTION_STUDIO_MUSIC_VENDOR` /
`MOTION_STUDIO_TRANSCRIPTION_VENDOR` → `settings.json` →
built-in default. The defaults are chosen for what they cost you: speech
defaults to `system` so a machine that has been narrating locally does not start
billing a cloud subscription because a newer version knows how to; music
defaults to `node` because it is the only one that works off Windows and needs
no binaries a fresh clone must build. The "active" source is read from the
*stored* settings, not the merged ones, so the UI can distinguish "the user
chose this" from "this is what ships".

**Preference chains, and the fallback rule they narrow.** Through v0.19 the rule
was absolute: no fallback between vendors ever, because a machine that quietly
swapped synthesizers would produce a film whose soundtrack changes character
between scenes. Settings may now name an ordered chain (`tts.vendors` /
`music.vendors`; the env vars accept a comma-separated list) and resolution walks
it to the first vendor that is available — but the original concern is answered by
scoping, not dropped:

- an explicitly named vendor resolves to a chain of exactly itself, so a caller's
  choice is never redirected — it runs or it raises `*_unavailable`;
- only *unavailability* is skipped (an unconfigured vendor), never *failure*: one
  that probes fine and then fails during synthesis is a hard error;
- a one-entry chain — still the default — probes nothing, so single-vendor
  machines keep both the old behaviour and the old cost;
- every fallback is reported: `skipped` from `walkVendorChain`, `vendorNote` and
  `vendorChain` on the MCP result, a warning line on the Studio page,
  `preferred` vs `active` + `fellBack` from `list_vendors`;
- an exhausted chain reports its *head*, so the error names the user's first
  choice rather than whichever candidate happened to be last.

The residual cost is stated where users will meet it: with a chain of two or more,
resolution happens per call, so a vendor that becomes unavailable between two
calls in one film changes everything after it. An unavailable vendor also still
names any sibling that is ready.

Two rules carry over from §6's error model. Setup problems and failures stay
distinct: a missing or rejected credential is `tts_unavailable` / a missing
SoundFont is `music_unavailable` (the caller must stop and tell the user), while
a rate limit, a bad style or a failed render is `tts_failed` / `music_failed`.
And an unknown voice is `unsupported_voice` with suggestions rather than a
silent substitution — validated against the catalogue *before* any audio is
requested, because a film whose narrator changed between takes is a worse
outcome than a failed call. Options a vendor lacks are reported in `warnings`,
not dropped.

Credentials are environment-only (`AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` and
their `MOTION_STUDIO_`-prefixed forms). `settings.json` may hold the region,
default voice, format and style but never a key — a patch carrying one is
rejected — and every surface that reports a key reports it masked with the
variable it came from. The Studio page renders in a browser; an unmasked key
there would be a key in every screenshot.

**Level parity is part of the contract, not an afterthought.** Two
synthesizers disagree about what a master gain means — measured on one identical
spec, FluidSynth at `-g 0.7` peaks at −9.1 dBFS where spessasynth at 0.7 peaks
at −16.1 dBFS. So the Node vendor's default gain is calibrated (1.575, from a
linear gain curve) to land at the same loudness, and `music.targetPeakDb`
(default −3) is measured against every render by both vendors, attenuating only
— the same rule §9.1 gives `synthesize_sfx`. Swapping vendors must not
re-balance a film's music against its narration, and the measured peak is
always reported rather than assumed.

### 9.3 Reading speech, not writing it (v0.22)

Everything above §9.2 is about *producing* audio. `transcribe_asset` is the first
capability that *consumes* it: it turns a recording a user supplied into text plus
per-sentence and per-word timing. The asymmetry it closes is specific —
`synthesize_speech` returns `timings`, and that one field is why generated
narration is easy to build against; a user's own recording had no equivalent, so
every cut-in point was arithmetic against the clip's duration.

The layering is three files deep, and the split is the whole design:

```
core/transcribe.js           extract → bound → cache → DERIVE
core/transcribe-vendors.js   which vendor, and the chain rule (§9.2)
core/transcribe-whisper.js   one CLI contract, normalized to milliseconds
```

The provider returns nothing but normalized tokens in milliseconds. Four
derivations sit above it, and they are the product rather than conveniences:

1. **Sentence re-segmentation.** whisper.cpp's `transcription[]` entries are
   *decode windows* — ~7.5 s chunks bounded by the model's context — and nothing
   about them respects grammar; one routinely starts mid-clause and crosses three
   sentence boundaries. Splicing audio on those boundaries is the audible
   mid-word cut the tool exists to prevent, so sentences are rebuilt from token
   offsets. The engine owns this so every caller gets it right once instead of
   re-deriving it per session — which is exactly the rule in
   [agent-environments.md](agent-environments.md): a shell can run `whisper-cli`,
   but then it re-derives sentence boundaries by hand from millisecond offsets.
2. **Words.** Sentence timing cannot cue a graphic to a name spoken *inside* a
   sentence; per-word offsets can. This is what makes a transcript direction
   rather than documentation.
3. **Frames.** `sentences[]` mirrors `timings[]` field-for-field, so recorded and
   generated narration are one code path. Vendor offsets are integer
   milliseconds and are converted **once**, in the engine.
4. **`speechRanges` / leading + trailing silence.** The text answers "what does it
   say"; these answer "where can I cut", which is the question a film has.

Two properties follow from the vendor being local and cheap. **Confidence is
derived and always reported** — whisper.cpp emits no `no_speech_prob`, so
`minTokenP`/`meanTokenP` per sentence and `p` per word are computed from token
probabilities; a confidently-wrong transcript quoted on screen is worse than no
transcript. An English-only `.en` model also refuses an explicit non-English
language (`transcription_language_unsupported`) before it runs: whisper.cpp would
otherwise return a plausible English artefact with unusable timing. And
**transcripts are cached** per (file identity, model, language) in
`<dataDir>/cache/transcripts/`, keyed with a derivation version so a build with
better segmentation never serves the old split. The cache stores *seconds*, so one
entry serves a 24 fps film and a 30 fps one; it lives under the data dir rather
than beside the file because a sidecar in the workspace library would be debris in
a folder the human curates, and one in `assets/` invites someone to put it on a
timeline. That cache is what makes the verification loop — render, then
re-transcribe the render — cheap enough to actually run.

The 16 kHz mono PCM whisper.cpp requires is produced internally with the engine's
own ffmpeg, which is already a declared prerequisite; the extracted WAV is a temp
file, never an asset. Bounds (60 minutes, 2 GB) exist so a wrong file fails with a
measurement instead of becoming a twenty-minute silent job.

### 9.4 Preparing media, without a shell (v0.22)

`probe_asset` reads a media file and `transcribe_asset` hears one. Neither can
**change** one, and until `transcode_asset` an agent on the MCP surface stopped at
exactly that line: it could report that a clip's codec cannot be decoded by the
render browser and then had no way to act on its own advice.

Both read through `store.resolveMediaFile`, which accepts a path under the target's
`assets/` **or** its `out/`. The asymmetry is deliberate and is the whole point:
verifying a finished cut means probing or re-transcribing `out/film.mp4`, so
confining the *read* to `assets/` blocked a documented workflow while protecting
nothing — the file is one the engine itself just wrote. Writes, deletes and renames
keep going through `_assetRelPath` and stay confined to `assets/`, so a deliverable
is readable but not replaceable from the tool surface.

`core/transcode.js` closes it with three modes — `video` (conform, trim, crop,
scale, fps), `audio` (cut N spans out of one source and join them into a PCM WAV),
`frames` (a PNG sequence) — and one architectural rule:

> **No arbitrary ffmpeg arguments. Not `args`, not `filter`, not an escape hatch.**

The premise of this whole surface is "no shell"; a passthrough is a shell wearing a
hat, and it takes the path sandbox with it. Every operation is a named, validated
field, and the two functions that turn those fields into a filter graph
(`buildVideoFilter`, `buildSpanGraph`) are pure and unit-tested without ffmpeg —
the same shape as `buildOverlayGraph`. They are the entire surface that can ever
run, which is what makes that claim checkable rather than aspirational. The MCP
schema strips unknown keys, so there is nothing to smuggle.

Four properties are worth stating because each replaces a way a wrapper usually
goes wrong:

- **Report by measuring, never by echoing.** The response is `summarizeMedia` on
  the output, so a caller who asked for 640×360 and got 640×358 (even dimensions,
  chroma subsampling) learns it here rather than from a render three steps later.
- **Frames, not seconds.** `trim.durationInFrames` maps to `-frames:v`, which
  guarantees the count; `-t seconds` does not, and one frame of drift breaks a
  concat seam and shifts every later cue. It always means frames *of source*, in
  every mode — so `frames.every: 3` over 12 of them is 4 images, not 12 taken
  from 36.
- **`matchFilm` consumes the signature (§13), never a second copy of the encode
  table.** It splices the film's own `ffmpegArgs` into the command, so a conformed
  file agrees with the film by construction rather than by an agent's arithmetic.
  When that signature states colour, its existing filter chain also performs a
  real `colorspace=all=bt709:trc=srgb` conversion; an input with incomplete
  metadata is treated as BT.709 and the returned `assumptions.color` records that
  decision. That is the loop the four v0.22 plans close: the film *states* its
  contract, the tool *conforms* a file to it, and the timeline *holds* the result.
- **Idempotent, and never destructive.** A `*.transcode.json` sidecar beside the
  output records the source identity and every parameter, so repeating an unchanged
  call is free; the destination may never equal the source.

Span-joining lives here rather than on the film's audio timeline for a measured
reason: the mixer's fades are frame-quantized, and 12 ms at 30 fps is 0.36 frames.
Four overlapping tracks with 1-frame (33 ms) fades is a different, worse edit. A
hard butt-join between two spans of speech clicks audibly; `acrossfade` overlaps
its inputs, so the joined length is `sum(spans) − (N−1) × crossfade` — the fade
consumes time, which is what makes it a crossfade rather than a gap.

### 9.5 The generative boundary (v0.26)

The audio (and image) capabilities split into two families, and the split is
policy, not accident:

- **The engine owns deterministic, timing-coupled work.** `synthesize_speech`,
  `synthesize_music` (note-spec), and `synthesize_sfx` return frame-accurate
  timing and mix through the one FFmpeg pass; `transcribe_asset` and
  `probe_asset` measure what a supplied file actually contains. Same spec in,
  same kind of result out, `*_unavailable` when a vendor is missing — an
  MCP-only (Env A) agent can build a narrated, scored film from these alone.
- **Generative models are agent-side tools.** ComfyUI image/music/video
  helpers are non-deterministic, machine-specific (GPU sizing, model
  inventories, paid partner nodes), and their outputs need an agent's
  measure-audition-regenerate loop before they are usable — a requested tempo
  is not a delivered one, and generated hands need eyes. Their outputs enter
  films as ordinary assets via `write_asset_file` / `use_shared_asset`.

Generative helpers will **not** be added as engine vendors or wrapped in MCP
tools. The vendor contract that makes the speech/music vendors interchangeable
— same spec, same kind of WAV, nothing downstream knows which ran — is exactly
what a prompt-driven model cannot satisfy, and wrapping one in a tool call
would hide the iteration loop that makes its output usable. A future
capability that *is* deterministic and timing-coupled belongs inside; one that
generates content from a prompt belongs outside, documented beside its tool
(see [production-lessons.md](production-lessons.md) and §16).

The same rule triages customer-supplied APIs at install time (the
[deploy/PROVISION.md](../deploy/PROVISION.md) "capability triage" section):
a speech API becomes an engine TTS **vendor** — that keeps
`synthesize_speech`'s frame-accurate `timings`, which agent-side generation
loses — while music/image/video generation APIs become agent-side helper
directories. The boundary runs between capabilities, not between local and
cloud.

## 10. Security and sandboxing

The agent-facing write surface is exactly composition source files and
`assets/` content inside the target scene or film. `resolveInTarget` (used by
every file-touching tool and every Studio file route) rejects absolute and
drive-letter paths, `..` escapes, null bytes, and symlink escapes (the
deepest existing ancestor is `realpath`-ed and re-checked). Text writes are
restricted to an extension allow-list (`.html .css .js .mjs .json .svg .txt
.md`); binary asset writes are additionally confined to the `assets/` folder,
allow-listed to image/audio/font/video types, and capped at 25 MB. The MCP tool
(`write_asset_file`, base64) and the Studio's raw-body upload both funnel
through one `WorkspaceStore.writeAssetBuffer`, so that confinement has a single
enforcement point rather than two implementations to keep in step; the
Studio's asset delete/rename routes resolve through the same sandbox.
`scene.json` is deny-listed from raw writes so config invariants can only
change through the validated `update_scene_config` tool (the Studio's
config PATCH calls the same `updateConfig`); v0.20 adds `film.json` and
`workspace.json` to that denylist for the same reason — they are documents
with validated schemas that `WorkspaceStore` owns.

Two boundaries are new in v0.20. Ids are **slug paths**, and every id is
parsed and validated before it is joined to a path (`a-z 0-9 - _` only, with
a reserved-name list), so a caller cannot reach outside `workspaces/` through
an id any more than through a file path. And an MCP server is confined to its
own workspace: it qualifies every incoming id with its bound workspace slug
before touching the store, so an agent cannot name another agent's film even
by guessing its slug. Destructive verbs stay explicit — `remove_scene` and
`remove_film` keep the folder unless `deleteFiles: true`.

There is no shell tool and no arbitrary-path tool. The MCP server is
stdio-only; the Studio server binds to `127.0.0.1` and has no authentication
because it is never reachable off-machine — do not reverse-proxy it.

One caveat worth stating plainly: composition JS executes with Chromium's
normal capabilities inside the render browser (it can, for example, `fetch`
remote resources). The sandbox governs what an agent can do to the *user's
disk and processes* through the tool surface, not what the page can do
inside Chromium. Treat composition code from untrusted sources like any
other code you run.

## 11. Storage: workspace → film → scene (v0.20)

**The filesystem is the registry.** Everything lives under one data dir
(default `<app>/data` since v0.22 — configurable, see §11.1):

```
<dataDir>/
  settings.json
  agent-economy.json      MCP session cost PROXIES, replaced each run (§11.4)
  workspaces/
    <workspace>/            one per AI (and any the human creates)
      workspace.json        { name, createdAt } — display metadata only
      library/              human-managed shared assets (large files)
      films/
        <film>/
          film.json         the film document (core/films.js owns its schema)
          assets/           master audio / overlay files for this film
          out/              the built film (+ .srt sidecar)
          render-groups/    <groupId>.json — one render run's membership,
                            terminal member states and delivery (§11.4)
          scenes/
            <scene>/        a composition folder (scene.json, composition.*)
```

Identity is the **slug path**: a workspace is `"<ws>"`, a film
`"<ws>/<film>"`, a scene `"<ws>/<film>/<scene>"`. Slugs share one alphabet
(`a-z 0-9 - _`), so every id is exactly its folder path relative to
`workspaces/` — and slug validation doubles as path safety, since a valid
slug cannot contain a separator, a dot, or a drive letter. Presence of
`film.json` makes a film; presence of `scene.json` makes a scene. Copying a
film folder into another workspace *is* moving the film.

`core/store.js` (`WorkspaceStore`) owns discovery and persistence;
`core/scene.js` keeps the scene config schema, the scaffolder and the
source lints, and deliberately knows nothing about the hierarchy — it takes
absolute scene paths. The config file is `scene.json`, named for the thing it
configures; the one place the pre-v0.20 `project.json` name is still read is
`core/migrate.js`, which renames it as it moves each folder.

**Why this replaced the flat `projects/` + `projects.json` + `films.json`
model.** Four things had gone wrong, and all four were the same mistake — the
storage model did not match what people were actually making:

- A "project" was really a *scene* of a film. Every long-form doc said so; the
  storage did not, so the relationship lived in prose and in whoever's head
  made the last `build_film` call.
- A film needed a **by-convention** "`<name> — Master`" project to hold its
  master audio and receive the build — a film wearing a project's clothes,
  indistinguishable from a real scene in the UI, and easy to render by
  mistake. The film folder now has its own `assets/` and `out/`, so the
  convention is gone rather than documented.
- Every agent dumped scenes into one shared folder. A fresh film started by
  one AI appeared amid another's scenes; nothing scoped anything.
- Both registries were a shared read-modify-write file — a lost-update hazard
  whenever two writers were live.

Concurrency is better but not free: writes are atomic (temp + rename) and the
common case now touches disjoint files (each film document is its own file),
so two agents in different workspaces cannot lose each other's writes.
Cross-process render collisions are prevented by the render lock (§7.1), not
by this store.

Two writers editing the *same* `film.json` were last-write-wins, inherited
from the registry model. For films specifically that is not survivable,
because a film patch **replaces whole arrays**: a writer holding a stale
`scenes` snapshot does not lose its own field, it reverts every segment change
made in between, with no error. The production loop makes this the normal
case rather than the exotic one — the AI edits the document continuously while
the human sits on an open film page.

So `getFilm` returns a **`revision`** (a hash of the stored document; derived
on read, never written to disk, so hand-editing `film.json` produces a new one
for free) and `updateFilm` takes an optional `expectedRevision`, answering a
mismatch with `film_conflict` rather than a write. Optional is the deliberate
choice: read-modify-write callers inside the store (`createScene`,
`removeScene`, `renameAsset`) complete within a tick and gain nothing from it.
The writers that hold a snapshot across *think-time* — the Studio film page's
autosave and the `update_film` tool — pass it. Conflicts are not merged;
whole-array replace admits no honest merge, so the page discards its unsaved
edit (one 700 ms debounce at most), reloads, and says so.

**Scene defaults are where the concat invariant now lives.** A film records
`sceneDefaults` (fps/width/height/durationInFrames) at creation, and
`createScene` fills any dimension the caller left unset from it. The rule
that every scene must share resolution/fps/format to concatenate losslessly
(§13) used to be discipline enforced only at build time; it is now the
default path, and diverging takes a deliberate override.

**`cloneScene` (v0.27) is the fourth scene-lifecycle operation**, beside
`createScene`, `removeScene` and `renameAsset`, and it exists because the
agent-side recipe it replaces (`createScene` → `updateConfig` →
`syncSharedFiles` → re-attach assets and library builds) drops exactly the
steps that get forgotten — and one of them, the binary assets, is not
expressible over MCP at all, since no tool returns asset *bytes*. It copies the
source tree with `copySceneTree`, the walk it shares with revision snapshots
(`core/revisions.js`, §7.2-adjacent), which is why the two agree on what counts
as authored (composition files, `frame-api.js`, `assets/`, vendored library
builds) versus derived (`out/`, `revisions/`, staging, `node_modules`,
dotfiles). The one thing they do not share is the storage decision: a snapshot
hardlinks large binaries because a revision is immutable, while a clone passes
`linkThreshold: Infinity` and copies everything, because a clone is a *live*
scene and an aliased inode would let an in-place asset edit in one scene
silently rewrite the other. `scene.json` is excluded from the walk and written
separately — the source config wholesale, with `name` replaced and a
`clonedFrom` provenance stamp (pinned to the source's current revision id, or
`null`) that `validateConfig` accepts permissively and `updateConfig`'s ALLOWED
set deliberately refuses, so provenance is engine-written only. The play-order
append goes through `updateFilm` rather than around it, so the Studio's
film-update events fire for free, and a failure before that point removes a
folder this call created — never leaving the half-scene that later surfaces as
`unlisted`. Signature divergence from the destination film's `sceneDefaults`
comes back as `warnings`, not an error: clone-then-reframe is legitimate work.

`<dataDir>/settings.json` sits beside `workspaces/` and holds *user
preferences*, with the same atomic write and a validated schema:
`newSceneDefaults` (which seed a new film's `sceneDefaults`),
`render.defaultWorkers`, an `ffmpeg` block (binary `path` override plus
`defaultCrf`/`defaultPreset`), and `tts` / `music` blocks (the active vendor
per capability, plus their non-secret options). Credentials are the one thing
it will not hold — see §9.2.

### 11.1 Where the data dir is (v0.22)

Four locations decide where everything lives, and `core/paths.js` owns all
of them:

| location | default | env override |
|---|---|---|
| `dataDir` | `<app>/data` | `MOTION_STUDIO_HOME` |
| `workspacesRoot` | `<dataDir>/workspaces` | `MOTION_STUDIO_WORKSPACES` |
| `settingsFile` | `<dataDir>/settings.json` | `MOTION_STUDIO_SETTINGS` |
| `vendorDir` | `<app>/vendor` | `MOTION_STUDIO_VENDOR_DIR` (v0.25) |

`vendorDir` is the odd one out: it is not user *data* but the root the engine
resolves bundled runtime assets from — the TTS/MIDI exes, FluidSynth,
SoundFonts, Piper voices, Whisper models and the committed 3D libs. It lives in
`core/paths.js` all the same because it shares every property that put the
other three there: machine-level, needed synchronously by module-level
resolvers, and per-process overridable. Its default is anchored to the app, not
the data dir — relocating your film library must not drag the vendor binaries
with it. The per-item hooks (`MOTION_STUDIO_TTS_EXE`, `_SOUNDFONT`,
`_WHISPER_MODELS`, `_LIBS_DIR`, …) and per-vendor paths in `settings.json` all
still win over it; the vendor dir only moves the *default* root they fall back
to. Changing it never triggers the storage-relocation machinery below — the
next probe or synthesis simply resolves against the new root.

Through v0.22 all three were derived from `MOTION_STUDIO_HOME` (or
`~/.motion-studio`) and changing one meant restarting every front end with a
different environment — which is why the Studio's settings page listed them
**read-only**. They are fields now, and that needed somewhere to record them
that is *not* `settings.json`, since `settings.json` is one of the things being
located. Hence a bootstrap file of their own:

```
<app>/paths.json   { dataDir, workspacesRoot, settingsFile, vendorDir }   any may be null
```

Resolution per key, highest first: **env → `paths.json` → the default**. Env
sits on top for the same reason it does for the ffmpeg binary (§11.3): an MCP
server is spawned by its client with whatever environment that client chose,
and a value named there is a deliberate statement about *that* process which a
shared file must not overrule. `resolvePaths()` reports which layer won for
each key, and the settings page disables a field the environment has already
decided rather than offering an edit that would do nothing.

The default moved from `~/.motion-studio` to `<app>/data` so a checkout carries
its own library: one folder to copy, back up, or move to another drive.
`paths.json` stores app-relative values *relatively*, so moving the folder
moves the install intact.

**The legacy exception.** An upgrade must not make an existing library vanish.
When nothing is configured, `<app>/data` does not exist yet, and
`~/.motion-studio` does, the old directory wins and is reported as source
`legacy`; both servers then call `ensureStableDataDir()` at startup to write it
into `paths.json`, so the answer stops depending on which folders happen to
exist and becomes a recorded decision the user can see and change. A fresh
install never takes that branch.

An override applies to the **configured** data dir only — name any other
directory and you get the conventional layout inside it. That rule is what
keeps a caller who passes an explicit `dataDir` (a test over a temp dir, a CLI
run against a copy) from silently borrowing the machine's real workspaces.

Relocating through `PATCH /api/settings` re-points the *running* Studio: it
rebuilds its `WorkspaceStore` in place, because "changed the data dir, saw no
change" is indistinguishable from a broken setting. It is refused with
`storage_busy` while any job is in flight — a render holds absolute paths into
the old tree and writes frames there for minutes, so swapping underneath it
would produce a corrupted result rather than an error. **Nothing is moved on
disk**, and connected MCP servers resolved their paths when their client
spawned them, so they keep using the old location until restarted; the response
says so (`relocated.restartAgents`).

### 11.2 Migration from the pre-v0.20 layout

`core/migrate.js` runs once, from `WorkspaceStore.ready()`, and only when
`projects.json` exists — the last step moves that file into
`<dataDir>/legacy-v019/`, so a completed migration can never re-run. The
mapping:

- Everything lands in the `default` workspace. The old layout had no notion
  of who made what, so inventing an attribution would be a guess.
- Each saved film becomes a film folder: its scene projects move into
  `scenes/<slug>` (each folder's `project.json` renamed to `scene.json`), and
  its output project's `assets/` and `out/` fold into the film's own — that
  project stops existing, which is the whole point.
- Projects in no film become **single-scene films** of the same name, so
  nothing silently disappears from the Studio.
- The old registries, and any leftover output-project files, move to
  `legacy-v019/` together with a `migration-report.json` mapping every old
  UUID to its new id. **Nothing is deleted.**

A crash mid-way leaves `projects.json` in place and the migration resumes on
the next start; folder moves that already happened are detected by their
destination existing, and the report says so.

### 11.3 The workspace library

The 25 MB base64 cap on `write_asset_file` exists to keep large media out of
the MCP channel, which left "the user gave me a 500 MB plate" with no good
answer. Each workspace now has a `library/` the human fills through the
Studio (or on disk); agents see it read-only via `list_shared_assets` and
pull a file into any scene or film with `use_shared_asset`. The pull
**hardlinks** when the filesystem allows and copies otherwise, so a huge
asset costs no extra disk and the scene still renders hermetically from its
own `assets/`. Pulling the same file again refreshes the link, so an updated
library file propagates on request rather than silently.

The settings file (v0.15, `core/settings.js`) sits alongside it — at
`<dataDir>/settings.json` unless §11.1 says otherwise — and holds *user
preferences*, with the same atomic write and a validated
schema: `newSceneDefaults`, `render.defaultWorkers`, an `ffmpeg` block
(binary `path` override plus `defaultCrf`/`defaultPreset`), and `tts` / `music`
blocks (v0.17: the active vendor per capability, plus their non-secret options —
Azure region/voice/format, SoundFont path, sample rate, gain, target peak).
Credentials are the one thing it will not hold — see §9.2.

The scope line moved in v0.16, and the reasoning is worth recording because it
reversed. Through v0.15 the MCP server read none of this: an agent asking for
24 fps should say so explicitly, and a machine-level preference silently
changing an agent's output looked like a reproducibility hazard. In practice
the UI calls the panel **Global Settings**, and a user who sets a value there
means it — the surface that happens to be driving is not a meaningful axis to
vary behaviour along. Worse, `ffmpeg.path` had no MCP equivalent at all, so a
correctly-configured machine still failed every agent call with
`prereqs_missing`. All front ends now honour the file.

Two invariants keep the reproducibility concern answered. Globals **only fill
gaps** — an explicit argument always wins, which is why MCP's `create_film`
takes `.optional()` fields rather than zod `.default()`s (a default is
indistinguishable from a caller who meant it). And they apply **only at
creation**: an existing `scene.json` is never rewritten because a global
changed, so a scene renders identically tomorrow. Both front ends route
through `withNewSceneDefaults` / `outputSeedFromSettings` in
`core/settings.js` rather than merging locally, so they cannot drift.

v0.20 adds one hop to that chain without changing the rule: the globals seed a
**film's `sceneDefaults`** at `create_film`, and a scene created inside the
film inherits from those. So "the user's default is 1280×720" reaches a scene
through the film that owns it, and a film deliberately made at another size
keeps its scenes consistent with *itself* rather than with the machine.

`ffmpeg.path` is resolved by one function, `resolveFfmpegPath()`, which all
three entry points call: explicit override (CLI `--ffmpeg`) →
`MOTION_STUDIO_FFMPEG` → `ffmpeg.path` → `ffmpeg` on PATH. The env var
outranks settings because an MCP server inherits whatever PATH its client had;
the override outranks everything because a caller naming a binary means it.
The resolved path feeds `checkPrerequisites` *and* the render job, so a green
check can never describe a different binary than the one that encodes.
`renderParallel` forwards it to its workers unconditionally — including the
literal `"ffmpeg"`, since a worker that re-resolved for itself could pick up an
env var the parent deliberately overrode and split a fan-out across two
binaries. A corrupted settings file degrades to defaults rather than bricking
the UI — or, on the MCP side, rather than taking the server down.

### 11.4 Run records and the agent-economy report (v0.26, TE P1-3/P1-4)

Two files exist purely to answer "what happened", and neither is ever allowed
to answer "what is true".

A **render group record** (`<film>/render-groups/<groupId>.json`) is written
at submission with the group's membership, film revision, scene policy and
engine version, and is then *completed* as the run proceeds:
`wait_render_group` stamps each member that reached a terminal job state with
`terminalState` + `finishedAt` and the group with `completedAt`;
`finish_film`, which waits on its own jobs rather than through that tool, does
the same and then stamps `deliveryId` + `deliveredAt` when its build succeeds.
A `not_found` job is never stamped as an outcome — an id lost with a previous
process is missing memory, not a result. **Records inform, files decide**: a
group's `done` is recomputed from the current plan's output files and
sidecars, so a hand-deleted or stale record can only cost history, never
correctness. Updates are best effort and atomic-ish (temp + rename) and a
failed update is one stderr line, never a failed read.

The **agent-economy report** (`<dataDir>/agent-economy.json`,
`src/mcp/agent-economy.js`) is the transport's own cost proxy. Motion Studio
cannot see the LLM provider's token ledger, so it counts what it can: calls
and returned text bytes per tool, compact versus full projections, and the
per-scene calls each batch operation replaced. One decoration of the MCP
server's `registerTool` counts every tool, so no handler carries telemetry
code and a new tool is measured the day it is written; counting happens after
the handler resolved and adds no async hop to the response path. Writes are
debounced, fire-and-forget, unref'd (telemetry never holds the process open)
and flushed once more on exit. It holds names and numbers only — never
arguments, prompts, file contents or credentials — and a new server run
replaces the file, `startedAt` naming the run.

## 12. Preview fidelity

The Studio preview iframe loads the project's *actual entry HTML* from the
sandboxed `/preview/:id/` route and is driven through the same
`window.setFrame(n)` contract the headless renderer uses — the preview and
the render differ only in Chromium being headless. The agent preview,
`capture_preview_frame`, goes further and reuses the render path itself
(real Puppeteer capture), so what the agent sees is byte-what-renders. The
render is always the source of truth.

### 12.1 Proxy/motion preview (v0.21)

Between "a handful of preview stills" and "the full render" sits the question
stills cannot answer: *does the motion read?* A proxy render
(`proxy: { scale?, frameStep? }` on the render tool, `--proxy [scale]
--frame-step N` on the CLI) answers it in roughly 1/8 the time by cutting the
two costs that dominate a render:

- **Screenshot size** (`scale`, default 0.5): the capture rectangle is
  `width×scale by height×scale`, **floored to even numbers** because
  mp4/webm/prores reject odd dimensions and a proxy must work with whatever
  format the project is configured for. The composition is mapped onto that
  rectangle by an inline `transform: scale(sx, sy); transform-origin: 0 0` on
  `documentElement` — the one element compositions never style themselves —
  with per-axis factors derived from the even-floored dims so the content fills
  it exactly, and `page.screenshot({ clip })` captures precisely that rectangle.
  The **viewport stays the authored size** (v0.27): it is what `vw`, `vh`,
  percentages and `--ms-safe-*` resolve against, so shrinking it — as the
  original v0.21 implementation did — would have made a relative-unit
  composition lay out against the draft width and then be scaled again, i.e. a
  draft that disagrees with its own deliverable. Rastering only the clip is
  still the whole saving; capturing large and downscaling would keep the very
  cost the proxy exists to cut.
- **Frame count** (`frameStep`, default 2): frames `start, start+N, start+2N, …`
  are captured (exact arithmetic — the final frame is not forced in) and
  encoded at the rational rate `fps/frameStep` (FFmpeg takes `"30/2"`
  verbatim), so wall-clock duration — the thing being judged — is preserved.

Proxies are **serial by design** (`renderParallel` delegates and ignores
`workers`: a proxy is already cheap, and a Chromium fan-out would cost more in
launches than it saves in capture), **skip pre-flight** (the proxy *is* the
pre-flight), and **skip the audio mux** (it is a motion check; on a typical
project the audio pass would dominate the time saved). The output name gets
`.proxy` inserted before the extension (`output.proxy.mp4`) by the renderer
itself, so a proxy can never overwrite the deliverable, and job status carries
`proxy: { scale, frameStep }` so the Studio and agents can tell a draft from
the real thing.

## 13. Films and the film editor

A film is a folder (§11) and `film.json` is its document. `core/films.js`
owns what that document *means*:

- **The document** is the ordered scene list (`scenes: [{slug}]` — play
  order, resolved against the film's own `scenes/` folder), the master audio
  timeline, the caption and overlay tracks, `sceneDefaults`, and the
  mastering options. Audio and overlay `src`s are film-relative under
  `assets/`, exactly the shape `config.audio` uses in a scene. Before v0.20 a
  film referenced scene projects by UUID and needed a separate "output
  project" to hold those assets; both are gone, and with them the class of
  bug where a film pointed at a project someone had since deleted or
  re-purposed.
- **Deliverable variants (Stage A)** are saved snapshots on that same document,
  not copied films: each has target geometry, output name, caption style,
  title/caption safe insets, and a default/per-segment reframe focus. Global
  `deliverablePresets` only seed a new film; `resolveDeliverableSelections()`
  resolves them before any scene is created, so changing a preset cannot
  silently change a production already in progress. A request that names
  YouTube and TikTok therefore produces one landscape master and one named
  portrait target from the outset, while an unspecified request remains
  master-only by default. What a variant can *survive* is decided upstream, in
  the composition: a layout built against the `--ms-*` frame geometry (§2.1)
  reflows, a layout built at 1920 fixed pixels can only be cropped.
- **`validateFilm`** runs on every save and throws `invalid_film` with the
  complete `problems` list. **`planFilm`** resolves a film against reality
  *without throwing* — rendered state, signature mismatches, missing
  scenes/assets, out-of-range cues — because an editor must open a broken
  document to let you repair it. The Studio's validation chip and the MCP
  tools' `problems` field are both this one function.
- **Builds are jobs.** `submitFilmBuild` pre-resolves (so a bad film fails
  the submit call with a structured error) and then runs `buildFilmArtifact`
  as a `JobManager` job — same status/logs/cancel surface as renders, and
  `build_film` is async over MCP for the same reason `wait_for_render`
  caps its wait: a finishing encode can outlive a request timeout. `plan: true`
  short-circuits to `planFilm`, which is how an agent gets every scene's
  `filmOffset` *before* rendering anything — the numbers narration and cues
  are placed against.
- **The encode voice comes from scene 1.** The finishing pass takes its
  crf/preset (and the limiter default) from the first scene's `output`
  config. Scenes already share the codec-determining parameters by
  construction, so scene 1 speaks for the film — and the film document needs
  no duplicate encode block that could drift from the scenes it describes.
- **The play order is heterogeneous (v0.22).** A segment is a **scene** (which the
  engine rendered; its `config` is the truth) or **footage** (a file the user
  supplied; the file is the truth). `film.scenes[]` holds both — key unchanged,
  `schemaVersion` unchanged, so pre-v0.22 films load untouched. Four accessors in
  `core/film.js` (`isFootage`, `segmentFrames`, `segmentPath`, `segmentName`) are
  the only code that knows the difference, which is why `assembleFilm` needed no new
  machinery: it always concatenated a list of signature-matched files and laid the
  master audio over the result, and could not take footage only because the path
  could only come from a scene ref. Footage is **never re-encoded** (a mismatch is a
  reported problem, not a silent transcode) and **always silent** (all sound comes
  from the master timeline), and its declared `durationInFrames` is **verified by
  probe at plan time** — the render-sidecar contract applied to a file the engine
  did not write: declare, then verify, never trust.
- **Prepared footage retains its source proof.** A footage segment can carry
  `derivedFrom: { asset, transcodeMeta }`, pointers to the `.transcode.json`
  sidecar produced by `transcode_asset`. The film intentionally does not copy
  the source identity or crop/trim request into `film.json`: the sidecar is the
  one authoritative record. `planFilm` reads it, rechecks the original source,
  and exposes `derivedFrom.sourceVerified`. A source replacement, edit, missing
  source, or missing sidecar becomes `footage_source_changed`; direct builds run
  the same guard, so a caller cannot bypass it by skipping an advisory plan.
- **That voice is now stated, not just used (v0.22).** `filmSignature()` in
  `core/films.js` publishes the encode contract as `planFilm`'s `signature`:
  `sceneSignature()` supplies `id`, scene 1's `output` the values, and
  `buildVideoArgs()` the `ffmpegArgs` — the *same call* the finishing pass makes,
  so the reported args and the emitted args cannot diverge. `video`/`audio` are
  read back out of those arrays by flag lookup rather than restated, because the
  format registry holds codec identity only inside the argument lists; a
  declarative copy would be the second table that goes stale, and the reported one
  is the one that would be wrong. It never throws — a `png-sequence` film reports
  `ffmpegArgs: null` and a warning rather than propagating `UNSUPPORTED_FORMAT` to
  a caller who merely asked what the contract is.

  One projection carries it everywhere: `planSummary` covers `get_film`,
  `list_films`, `update_film` and `build_film { plan: true }`, and the Studio's
  `GET /api/films/:fid` already returned the raw plan, so both surfaces are served
  by one implementation. The rule this satisfies is the one in
  [agent-environments.md](agent-environments.md): tools that only report what a
  shell could report get bypassed, and this is knowledge no `ffprobe` can recover
  from a workspace — the engine held it and never said it.

  `mustMatch`/`neednotMatch`/`matchForLooks` are stated rather than derived,
  because that knowledge existed nowhere in the code. `neednotMatch` is the
  load-bearing half of the first pair: a segment encoded at a deliberately
  different profile *and* GOP concatenates and decodes back bit-identically
  (measured), which is why pinning them is wasted effort — each segment is its own
  encode and opens on a keyframe, all that `concat -c copy` requires.

  **`matchForLooks` is the third list (v0.22)**, and it exists because two could
  not classify everything: `crf`/`preset` were in neither, described only in prose,
  and the colour tags turned out to be the same shape of fact — no effect on the
  join, but the joined file keeps only segment 1's, so a mismatch is a look
  difference rather than an error. `signature.color` is derived from the render's
  output profile and now states BT.709/sRGB/BT.709/TV for final colour-carrying
  outputs. The renderer places `setparams` in the filter chain it owns (bare
  `-color_primaries` and `-color_trc` do not reliably override decoder frame
  properties). `matchFilm` then converts footage through `colorspace`, rather
  than relabelling it, and reports a BT.709 assumption when its source left
  colour metadata incomplete. Legacy render sidecars without these fields remain
  unverified; a present colour mismatch is stale. See
  [film-setup.md](film-setup.md#the-consistency-invariant).
- **The finishing pass.** Assembly is still `assembleFilm`'s lossless concat
  (+ master-audio mux). Only when a film has overlays or burns captions does
  ONE extra encode run: `buildOverlayGraph` (pure, unit-tested) composes the
  `-filter_complex` — percent-of-frame geometry, opacity via
  `colorchannelmixer`, `enable='between(t,…)'` windows, `setpts` shifts for
  video overlays, `.webm` decoded with libvpx so alpha survives — and
  captions burn via a generated `.ass` (resolution-relative styling; ffmpeg
  runs with `cwd` at the temp dir because the subtitles filter cannot take a
  Windows absolute path without unmaintainable escaping). Captions always
  also write a `.srt` sidecar next to the output. Encode settings come from
  the first scene's `output` config via the same `buildVideoArgs` the
  renderer uses; `encoder.runFfmpeg` parses `-progress` so the job reports
  real frame progress. A Stage-A deliverable deliberately also enters this
  pass even with no overlays/caption burn: `compileReframeFilter()` turns the
  resolved `planFilm` scene layout into a piecewise crop expression, then
  scales it to the saved target before overlays/subtitles are placed in target
  coordinates. It is one full re-encode of the approved master — reported as
  `reEncoded: true` — not a second scene render. The variant owns separate
  output/SRT/review/contact names, and the contact-sheet writer draws its safe
  guides on the staged encoded image before promotion.
- **The editor lies as little as possible.** `/film.html` plays the scenes'
  actual rendered files (byte-range serving makes them seekable), draws
  overlays/captions with the same geometry the finishing pass burns, and
  auditions master audio through `POST /api/films/:id/preview-audio`, which
  runs `mixAudioOnly` — the render's own filter graph (fades, trims,
  sidechain ducking, limiter). It deliberately does NOT approximate the mix
  in WebAudio: an approximation that gets ducking wrong is worse than a
  one-second wait for the truth.
- **Delivered-picture review is advisory, not a hidden gate.**
  `inspect_render` extracts downscaled PNGs from the encoded file itself, using
  the film layout to sample cuts or holds; a long film is represented across the
  timeline without exceeding the 24-image response cap. `measure_render` runs in
  the task lane and scans a low-resolution greyscale stream for per-second motion,
  static/black runs, solid frames, and expected-cut deltas. Full scene renders
  expose `staticFrames`; film builds expose the compact `picture` summary on the
  completed job. A title card may correctly be black or static, so these are facts
  for an agent to inspect, never reasons for the engine to reject a deliverable.
  `review_render_grid` (v0.26) is the same evidence at a tenth of the transport:
  one tiled contact sheet for a whole film — cut and hold per segment, read from
  the built film or the individual scene renders — plus one compact metadata row
  per cell. It shares the delivery review's tiler (`buildContactSheet`), writes
  its sheet as a file under `<film>/review-grids/` so the async path carries a
  path instead of base64, and points at `inspect_render` for the exact frames.
  It reduces transport, never inspection.

### 13.1 The Studio front end: one shell, documents inside it (v0.27)

The Studio UI is vanilla JS with no build step, served as files by
`studio/server.js` from a small explicit allowlist.

**It is one page.** `index.html`/`app.js` is the *shell*: the Explorer tree of
every workspace → film → scene, the document tabs, the editor stack, the
activity bar, the status bar, and the full-stage pages that are not documents
(vendors, global settings, the shared library). It navigates nowhere.

A **document** is a film or a scene, and each one is a same-origin iframe
mounted into `#editor-stack`:

| document | page | script |
|---|---|---|
| film | `/film.html?id=<ws>/<film>` | `film.js` |
| scene | `/scene.html?scene=<ws>/<film>/<scene>` | `scene.js` |

Iframes were chosen over refactoring both into one runtime, and the reasons are
load-bearing rather than convenient:

- **Per-document state survives a tab switch**, which is the only thing a tab
  strip is for. A film returns with its playhead, undo stack, timeline zoom and
  inspector tab intact. Tearing down and rebuilding on every switch would
  refetch and lose all of it.
- **Element ids stop colliding.** `film.js` and `scene.js` both use
  `#inspector`, `#btn-play`, `#frame-total`, `#timecode`. In one runtime a
  second open film would drive the first one's controls, silently.
- **Documents stay standalone pages**, so a scene still opens on a second
  monitor and the deep links still mean what they meant.

The shell↔document contract is direct calls, not `postMessage` — same origin:

```js
window.StudioShell = { openDocument, closeDocument, documentReady,
                       syncDocument, treeChanged, openPalette,
                       docToast, shellCommand }
window.StudioDoc   = { kind, id, title(), status(), suspend(), shown(), closing() }
```

`shown()` exists because a `ResizeObserver` cannot cover the case it is for: a
document inside an iframe the **parent** has hidden is not rendered at all, so
nothing in it observes anything. The shell therefore says when a document is on
screen, and the document does what it could not do without a box — the film
fits its timeline, the scene scales its preview. `suspend()` is the inverse.

`closing()` exists for the same class of reason, on the way out. A document is
removed from the DOM rather than unloaded, and **`beforeunload` does not run for
a subframe being removed** — so the film page's guard against losing a debounced
save was silently defeated the moment it became a tab. The document flushes;
`closeDocument` awaits it before `frame.remove()`, with a 4 s ceiling so a
wedged document cannot make its tab unclosable. `closeDocument(doc, { flush:
false })` skips it for the one case where flushing is wrong — deleting a film,
where the save would target something that no longer exists.

`docToast()` is the inverse direction. A non-active document is
`visibility: hidden`: it still has a layout, so a toast raised inside one
rendered perfectly and was seen by nobody, and since error toasts have no TTL it
stayed there forever. `StudioUtil.toast()` therefore checks for a shell first
and hands the toast up, where it is shown over whatever *is* on screen with a
chip naming the document it came from — clicking the chip activates that tab.
The stack is capped at five, because routing a retrying render's failures into
view is only an improvement if they cannot bury the view. Standalone (no shell
in reach) the local path is unchanged, which is what keeps `/film.html` working
on a second monitor.

`shellCommand(id, arg)` is the working set's keyboard, routed through one place:
`closeDoc`, `prevDoc`, `nextDoc`, `nthDoc`. The keys themselves are bound by
`StudioUtil.bindShellKeys()`, which the shell **and** both documents call —
focus normally sits inside an iframe, so a handler on the shell alone reaches
nothing. That was already true of `Ctrl+P`, which is why film.js and scene.js
had each grown their own copy of a forwarder; the binder is that forwarder once,
for every shortcut. The bindings are `Alt`-based (`Alt+W`, `Alt+PageUp/PageDown`,
`Alt+1…9`, `Alt+0`) plus VS Code's `Ctrl+K W` chord, because `Ctrl+W`,
`Ctrl+Tab` and `Ctrl+PageUp/PageDown` are browser-reserved: `keydown` fires,
`preventDefault()` is ignored, and `Ctrl+W` would take the browser tab with the
document. Both documents' own keyboards return early on `altKey` so a document
switch cannot also move a playhead.

A document declares `StudioDoc` via `StudioUtil.registerDocument()`, which also
marks `<html class="embedded">` so the stylesheets drop the chrome the shell
provides. The shell **asks** the active document for its status items and never
reads its DOM; a document going behind a full-stage page is told to `suspend()`
so opening settings cannot leave a film playing. `StudioUtil.openDocument()`
opens a sibling tab when embedded and falls back to a real navigation when not,
which is why the same code works both ways.

Files shared by shell and documents alike, loaded as classic scripts before the
page's own, each an IIFE exporting exactly one global:

| file | global | what it owns |
|---|---|---|
| `studio-util.js` | `StudioUtil` | `$`/`api`/`enc`, toasts (routed to the shell when embedded), the embed helpers (`registerDocument`, `syncDocument`, `openDocument`), `bindShellKeys()` — the one keyboard binder every surface calls — `subscribeProduction()` — the one production feed every surface shares — and the two asking helpers (`askForText`, `askToConfirm`) that replaced `prompt()`/`confirm()` |
| `scene-panels.js` / `scene-panels.css` | `ScenePanels` | a scene's **config, audio, assets and outputs** panels |
| `palette.js` | `StudioPalette` | quick open (`Ctrl+P`) and the command palette (`Ctrl+Shift+P`) |
| `shell.css` / `tabs.css` | — | the activity bar, status bar, editor stack, tabs, palette chrome, and the shared list/scrollbar grammar |

**The chrome is VS Code's (v0.27).** Not as decoration: the app already had
that shape and was spelling it differently, so adopting the grammar cost markup
rather than architecture. `.vs-shell` wraps a page as a column of `.vs-body`
(activity bar + root) over `.status-bar`; `.frame` and `.fe-frame` kept their
internals and gave up only their `height: 100vh`. The activity bar's vendor and
settings buttons ARE the old rail-footer buttons, moved with their ids and
handlers intact. Three status-bar nodes on the film document (`#save-state`,
`#production-line`, `#mix-state`) moved out of its header the same way, which is
why their setters preserve an `sb-item` class they did not need before — and why
each of them calls `StudioUtil.syncDocument()`, since embedded they are read
through `StudioDoc.status()` rather than seen.

Colours are VS Code Dark Modern: an editor surface (`#1f1f1f`) *lighter* than
its side bar (`#181818`), `#2b2b2b` hairlines, `#2a2d2e` list hover. The accent
is deliberately not VS Code's `#007acc` — amber stays the record light, because
a video tool that looks exactly like an IDE has lost the thing that says which
app you are in.

**The tab strip has a floor.** `.doc-tab` is `flex: 0 0 auto` with
`min-width: 120px`; the strip scrolls. It originally carried `min-width: 0` and
the default `flex-shrink: 1`, which meant ten open documents shared the strip's
width rather than overflowing it — measured at 1100 px, every name rendered nine
to thirty pixels wide, and the `overflow-x: auto` on the strip was unreachable.
`renderDocTabs()` rebuilds the strip wholesale, so it saves and restores
`scrollLeft` (emptying it collapses the scrollable width and the browser clamps
the position to 0) and scrolls the active tab into view. The strip is a
`role="tablist"` with a roving `tabindex`: one Tab stop, arrows along it,
`Enter` to activate, `Delete` and middle-click to close.

**Destructive actions are dialogs, not `confirm()`.** Deleting a film was two
chained `confirm()`s whose second encoded "delete every file on disk" against
"keep them" as OK-versus-Cancel. The shell now uses the same `<dialog>` shape
`scene-panels.js` already had — a summary, an *also delete files on disk*
checkbox that starts off, and a note stating what each choice leaves behind —
plus one reusable name dialog in place of `prompt()`.

That name dialog and a plain confirm dialog live in `studio-util.js`
(`askForText`, `askToConfirm`) and build their own markup on first use in
whichever document asks — so the film document's four name prompts (new and
renamed sequences, new and duplicated scenes), the panels module's asset rename,
and the shell's new-workspace prompt are one implementation rather than a copy
of the markup per page. `askForText` takes an optional checkbox, which is how
the asset rename asks its second question: renaming a file out from under an
audio track used to be a chained `confirm()` where OK repointed the tracks and
Cancel left them aimed at a file that no longer existed. **No native `prompt()`
or `confirm()` remains anywhere in Studio.**

**The Explorer says where you are and how far along everything is (v0.27.2).**
It used to say neither. A scene row went `active` merely by being *open*, film
rows said nothing at all, and no row was repainted when the working set changed
— so with ten tabs the left-hand side of the app could not answer "which of
these am I looking at?". `syncTreeSelection()` now toggles `open` (a background
tab, VS Code's unfocused-selection grey) and `active` (the front document,
amber plus `aria-current="page"`) on `[data-doc]` rows, by class and never by
rebuild, because it runs on every tab switch and rebuilding would cost the rail
its scroll position. `revealActiveDoc()` scrolls the active row into view and
expands its film first when it is a scene.

Every row carries **one mark** in a fixed 12px column: shape is the kind
(`ROW_GLYPH` — `▶` film, `◧` scene, `⧉` library, `+` create), colour is where
that row stands, and on a film row it is the disclosure control too — a
`<button>` with `aria-expanded`, rotated 90° while the film is open. That last
part removed a column: a separate chevron spent 18px of a 264px rail on every
row saying what a turned `▶` says for free. A workspace keeps its chevron and
takes no glyph, being a section header — a rotated `▶` is a disclosure
triangle, a rotated anything-else is just askew. The glyphs are the tab strip's own `▶`/`◧`
rather than a second vocabulary for the same two things; the indents shrank by
the width the column took, so names kept their length. A kind-only glyph is
`aria-hidden` (the name beside it is the label); one carrying state is
`role="img"` with that state as its `aria-label`, because a colour cannot be
read aloud. It is deliberately *not* re-coloured on the active row — which row
you are on is already said three ways, and the state is what would be lost.

The standing itself — built / edited-since-built / draft / broken, or a pulsing
amber when an agent's heartbeat names that film — is computed server-side in
`filmStanding()` (`studio/server.js`) from the delivery pointer, its manifest
and `listActivity`, all cheap reads, and deliberately *not* from
`productionStatus`, which plans the film and walks every scene's revisions:
right per film, far too expensive once per row per refresh. The "edited since
built" rule is `productionStatus`'s own, so the rail and the film page cannot
disagree. Scene rows colour the same way from the plan the Explorer already
fetched with the scene list — `GET /api/films/:id` returns `detail` beside
`sceneFolders`, and it was being thrown away. The film page's own tree follows
the same grammar (`.tree-kind`: `◧` scene, `▦` footage, coloured by readiness),
replacing the bare `.tree-dot` that carried the colour but named nothing.

**One production stream for the whole app.** The shell holds a single
`EventSource('/api/events')` and fans it out through
`StudioShell.subscribeEvents`; `StudioUtil.subscribeProduction()` uses it when
embedded and opens its own connection only when a document is standalone. Ten
open films used to mean ten streams against HTTP/1.1's ~6 sockets per origin,
which starves the later documents' feeds *and* the shell's own fetches. The
same stream keeps the rail live: an agent creating a film in another process
now makes it appear, badged `new`, with one clickable toast — previously the
tree was a snapshot taken at load and only a document's own `treeChanged()`
refreshed it.

`palette.js` indexes films from one `/api/workspaces` call and scenes per film
from `/api/films/:id?detail=scenes` — the compact projection, no composition
bodies — fetched lazily at a concurrency of six and cached for the page's life,
so a cold palette is useful immediately rather than blocking on one request per
film. It skips `sceneFolders` rows that are `missing` or nameless — belt and
braces since v0.27, when `store.listScenes()` stopped describing footage
segments as scenes. It used to walk the whole play order, and footage has no
slug, so every clip produced one nameless `<film>/undefined` row; the palette
guarded against it, the film page hid it by accident, and the Explorer showed
it. The guard stays because skipping a row it cannot open is the palette's own
business, whatever the engine hands it.

A film's counts are split for the same reason: `listFilms` reports `scenes` and
`footage` separately, because only scenes expand into rows, and a film of pure
footage that claimed a scene count opened onto nothing.

`ScenePanels.create()` builds its own DOM — it adopts no markup from either
page — and takes everything host-specific by injection: the transport (`api`),
the notifications, a `compact` flag for the inspector's column, and two
callbacks that say what a config change and a deletion *mean* to that host
(the workbench reloads its preview and tree; the film page reflows the whole
film, because a retimed scene moves every offset after it). It owns its own
`<dialog>`s and one audition player per instance.

The rule this encodes: **the scene page and the film inspector must not have
two implementations of the same panel.** They would drift, and within a release
the two surfaces would disagree about what editing a scene means — the same
mode error the document strip exists to end, one layer down. The scene page
adopted the module first precisely so the extraction was provable against the
surface that already worked.

Two consequences worth knowing when editing `film.js`:

- The inspector is rebuilt from `innerHTML = ''` on selection, mutation, save,
  SSE and a 1 Hz scene-job poll. The panel root is therefore **long-lived** —
  detached and re-appended, never rebuilt — and `renderInspector` captures and
  restores focus and caret across the render. Without both, a background render
  would retype the user's config field once a second.
- Everything a panel needs is already REST: `GET /api/scenes/:sid`,
  `PATCH …/config`, `…/assets`, `…/asset`, `…/outputs`. The film page needed
  no new server route to show a scene in full.

## 14. The production loop (v0.23): AI directs, the human advises

Motion Studio's working model is unattended AI production with asynchronous
human advice. The AI (over MCP) plans, produces, revises and assembles; the
human (on the film page, §14.1) watches, navigates, and leaves plain-language
advice. **There is no approval gate anywhere** — production
never waits, and every human interaction is durable evidence rather than a
blocking control. Four mechanisms carry the loop, all of them plain files
under the film so they survive any process restart and are shared between
the Studio and every MCP server without coordination:

- **Scene revisions** (`core/revisions.js`). The scene is the atomic visual
  work unit, and every promoted canonical render is archived immutably at
  `scenes/<scene>/revisions/<id>/`: the delivered video, the render's
  contact sheet/review report, a source snapshot, and provenance (agent,
  note, advice ids, parent). Hardlinks make the archive nearly free, and
  they are immutable *because* of §7.2.1: the engine only ever replaces a
  delivery by staged rename, which swaps the inode rather than writing
  through it. `revisions/current.json` is the pointer; `use_scene_revision`
  repoints by staging a copy of the archived output over the live one,
  re-stamps the render sidecar (so §7.3's staleness rule agrees with what is
  now on disk), and refuses (`revision_mismatch`) when the scene's settings
  have moved on. It never regenerates and never deletes newer history.
  Retention (`pruneRevisions`) is explicit and never touches the current
  revision or anything pinned by a delivery manifest or advice evidence.
- **Immutable deliveries** (`core/deliveries.js`). `out/<name>.mp4` remains
  the live delivery; every successful build is *also* archived at
  `deliveries/<id>/` with a frozen `manifest.json` mapping each film frame
  to the segment, scene revision, sequence, caption, overlay and audio item
  that produced it. The film page's **built film** player pins one delivery
  and resolves clicks through its manifest (`resolveDeliveryFrame`, pure),
  which is what makes advice **snapshot-consistent**: the human's words bind
  to what they actually watched, even when production has moved on. The
  newest master build takes the `current.json` pointer; platform variants
  archive but never steal it.
- **Human advice** (`core/advice.js`). Per-film folders holding an immutable
  `request.json` (wording + structural target + the observed
  delivery/revision/frame), an append-only `events.ndjson` (appended before
  every state write, so a crash loses a cached view, never history), a
  replaceable `state.json` projection, a terminal immutable
  `resolution.json`, and best-effort before/after frame evidence captured
  *after* the request is durable (a capture failure records a warning; it
  can never lose the human's words). Work leases are TTL wall-clock ones —
  an agent is a remote process no pid check can see — renewable by the
  holder, and expiry *is* the crash recovery. `needs-clarification` is
  deliberately non-terminal: the question lands in the state, the human
  answers with a linked follow-up request, and the original wording is
  never rewritten. Idempotency (`requestId` on create/resolve) survives
  restarts because it is stored in the documents themselves.
- **Events and status** (`core/events.js`, `core/activity.js`). Truth is
  multi-process (Studio server + N MCP servers), so the Studio's SSE stream
  (`/api/events`) is fed by its own writes *and* a recursive `fs.watch` on
  the workspaces root that classifies changed paths into entity events —
  which is how an MCP server's render appears in the browser live. Events
  carry monotonic ids with a ring-buffer replay (`Last-Event-ID`) and an
  honest `reset` on a gap; they are notifications, never truth — clients
  refetch canonical state. Agent heartbeats are the same durable-vs-live
  split as jobs (§11.3): `report_agent_activity` overwrites
  `<workspace>/activity/<agent>.json`, staleness is wall-clock (~3 min),
  and a dead agent degrades the header to "waiting for next AI run" with
  nothing lost.

The **sequence** is the narrative layer over the play order: a `sequence`
label per segment plus optional `film.sequences[label].intent` metadata.
Consecutive same-label segments form bands (`sequenceBands`, pure) used by
the plan, the film timeline, and advice targets. Sequences render nothing
and own no files — the deliberate contrast with the scene, which is exactly
the atomic render unit.

Every Studio gesture that regroups is therefore a **boundary move**, because
that is the only edit a run of segments can take without becoming two runs
sharing a name (v0.28). One client helper, `assignSequence(from, to, label)`,
writes a label across a contiguous range in both copies of the document —
`film.scenes`, which saves, and `state.detail.scenes`, which the timeline is
drawn from until the server answers — and drops intent metadata for any label
that range was the last carrier of, so a regrouping cannot itself create the
`unreferencedSequences` damage described below. Everything above it only picks
a range:

| gesture | range |
|---|---|
| `drawSequence` — drag on an unnamed stretch of the lane | the cuts the marquee spans |
| `bandGrip` — drag a band's left/right edge | the boundary's new cut |
| segment inspector's `sequence` picker | this segment to the end of its band |
| `+ seq` (`newSequenceRange`) | one segment on unnamed film; anchor to band end inside a sequence |

Contiguity is a property of those operations rather than something validated
afterwards. The draw gesture can only *start* on an unnamed run — which always
sits between bands — so growing it consumes a neighbour from the end nearest
the pointer and never from its middle; the picker offers no label that is not
an immediate neighbour; and `+ seq`'s two cases are exactly the two that
cannot split a name in half. `nameNewSequence` is the shared create: it
commits with a generated `sequence N` name, selects the band, and sets
`state.namingSequence` so the inspector focuses and selects its name field.
That flag is consumed in a microtask rather than during the render, because
creating renders the inspector twice — once from `select`, once from
`renderAll` — and the first pass's field is detached before the caret could
land in it.

Because a `scenes` patch replaces the play order *and each entry replaces its
segment*, an omitted `sequence` clears that segment's label — which is how the
Studio's ungroup works and therefore stays. The cost is that a play order
rebuilt from bare `{slug}` objects wipes the story layer and leaves
`film.sequences` describing bands that no longer exist. Two v0.27 additions
make that visible rather than silent: `planFilm` reports
`unreferencedSequences` (metadata keys no segment carries, omitted when empty),
and the `update_film` **MCP handler** — not the store — compares the play order
before and after a `scenes` patch and returns a `warnings` array naming the
labels it cleared. The asymmetry is deliberate: the Studio ungroups through its
own PATCH endpoint, where the clearing is the stated intent. (The upstream redesign plan called these "shots"
inside renamed "scenes"; the shipped model keeps the engine's scene
vocabulary and names the grouping *sequence*, killing the same ambiguity
without churning every id, tool, and document. A later revision of that plan
proposed `sequences[]` with opaque ids and a schema-version bump; the label
model already satisfies its rules — bands are contiguous by construction —
and needs no migration, so it stayed.)

**Segment identity.** A scene segment is addressed by its slug, which
`validateFilm` already keeps unique per film. A footage segment gets a
stamped `id` in `normalizeSegment`, because neither of the alternatives is an
identity: the path repeats when the same plate is cut in twice, and the array
index changes on every reorder — which would silently re-aim existing advice
at a different clip. The id survives normalization (every save runs it),
reaches the plan and the delivery manifest, and is what a `footage` advice
target names.

Agent identity is `MOTION_STUDIO_AGENT` (default: the workspace slug),
stamped on revisions, deliveries, advice events and heartbeats. The
checkpoint protocol — check advice at task start / after planning / before
expensive generation / after each scene revision / before build / before
completion; acknowledge, lease, resolve with an outcome; never wait — lives
in the tool descriptions themselves, `get_capabilities`, and
[docs/SKILL.md](SKILL.md), so any MCP-capable agent learns it from the
surface it is already reading.

### 14.1 One film page

The human half of the loop is **one page per film** (`film.html`), in two
modes over the same document, timeline and player — not two screens.

The first implementation shipped a second surface, `review.html`, beside the
existing editor. Both drew a timeline of the same film, one read-only against
a pinned delivery and one editable against the live document, and a reader
had to know which they were on before they could trust what they saw. The
duplication *was* the defect, so the review page was removed and its
behaviour folded in:

| Region | What it holds |
|---|---|
| Left rail | `Film → Sequence → Scene/Footage` tree, unused scenes, `+ new scene` / `+ seq` |
| Timeline | sequences band row, scenes row, track lanes, advice marker row |
| Player | scene-stitched preview, or a pinned **built film** delivery |
| Inspector | property panel, versions, and the advice for the selection |
| Header | film name, production line, save state, undo/redo, build |

A first cut of this shipped a *second* split — watch & advise versus advanced
editing, toggled in the header — and it was removed for the same reason the
review page was (v0.23.2). It only hid buttons, so it bought no safety a
reader could rely on, while still making them establish which mode they were
in before trusting the screen. The page is always the full editor.

Advising is therefore driven from the **inspector**, not a header button: that
panel already resolves the selection, so the advice control sits beside the
thing it is about instead of guessing. With nothing selected it arms one
targeting click (`A`, `Esc` to cancel), which is the only piece of modal
behaviour left and is announced by a banner while it is live.

`GET /api/films/:fid/overview` is the one call the page opens on: document,
plan, deliveries, advice, per-scene revision counts, and production status.
It is refetched on SSE events, and deliberately never overwrites the film
document — an agent's activity must not clobber a sentence the human is
mid-way through typing.

## 15. Testability

The renderer takes an injectable `browserFactory`; tests substitute a fake
browser that emits real, self-encoded PNGs (RGB and RGBA), so the entire
pipeline downstream of the screenshot — backpressure, every encode format,
concat, the FFV1 intermediate path, audio, cancellation, protocol, queue,
HTTP API — runs against real FFmpeg with probe-verified outputs. The same
substitution works across process boundaries via the
`MOTION_STUDIO_BROWSER_MODULE` environment hook, enabling true multi-process
parallel-render tests, full MCP client↔server integration tests (official
SDK client over stdio), and Studio HTTP tests on an ephemeral port. A gated
`real-chromium.test.js` suite covers the one seam fakes cannot — Puppeteer
launch, screenshot determinism, and genuine `omitBackground` alpha — and
skips honestly where no browser is resolvable.

826 tests across 40 files; see `engine/test/`. A clean run has **zero
failures**. Tests skip rather than fail when the platform cannot host them:
besides the gated Chromium suite, `cli: SIGTERM mid-render cancels with exit
code 4` is POSIX-only, because Windows has no signal mechanism and
`child.kill('SIGTERM')` falls back to `TerminateProcess()` — the process dies
before any handler runs, so `close` reports `null` instead of the CLI's exit
code 4. Cancellation on Windows is unaffected: it goes through
`JobManager.cancel`'s in-process abort, covered on every platform. A
permanently-red case teaches readers to skim past failures, which is how a
real regression hides.

## 16. Deployment: the tools root and the entry files (v0.26)

A deployed Motion Studio machine is a **tools root** directory containing this
repository plus the sibling media/generation tools, fronted by three files the
agent reads first. `deploy/` holds the machinery:

```text
<toolsRoot>\
  motion-studio\          the repo (this file lives inside it)
  AGENTS.md, CLAUDE.md    generated from deploy\ENTRY.md — identical, generic
  MACHINE.md              machine-owned manifest, created from deploy\MACHINE-template.md
  ffmpeg-*, whisper-*, …  core tools (every machine)
  comfyui*, …             optional helpers, each with its own README.md
  agent_tool\             portable agent CLI tools; agent_tool.md is their contract
    <tool>\               plateforge, motionforge, videoforge, musicforge, …
    agent_created\        the sandbox an AI may add a new tool to without asking
    _log-usage.ps1        one JSON line per invocation → usage.jsonl
    usage-report.ps1      per-tool frequency, for the human
```

The split between `comfyui*` and `agent_tool\` is **portability**: a helper
bound to a local installation, a virtual environment, and gigabytes of model
weights is machine infrastructure and stays at the root, while a program that
resolves its environment at run time travels, and lives one level down under a
single convention. That convention (`agent_tool\agent_tool.md`) is what lets an
agent both *use* an unfamiliar tool and *write* a new one without asking: same
launcher shape, same JSON-only stdout, same exit codes, same usage logging.
Promotion out of `agent_created\` — and every removal — stays with the human,
who decides from the usage report rather than from an agent's assertion.

The design rule is that **every fact lives in exactly one layer**, picked by
what changes it:

| layer | file | changes when |
|---|---|---|
| stable contract | `AGENTS.md`/`CLAUDE.md` (generated, never hand-edited) | the product changes |
| this machine | `MACHINE.md` | hardware, paths, models, paid services change |
| agent-tool contract | `agent_tool\agent_tool.md` | the agent-tool convention changes |
| each helper or tool | that folder's `README.md` | the helper or tool changes |
| production knowledge | `docs/` (this repo) | a lesson is learned anywhere |

The generated guide teaches agents to *discover* helpers (check the directory,
read its README, resolve machine values from `MACHINE.md`) rather than
enumerate them — so installing, removing, or adding a customer-specific tool
never edits the guide, and machines with different tool sets run identical
guides. The template is also single-sourced across OSes: `ENTRY.md` carries
`<!-- os:windows -->`/`<!-- os:posix -->` blocks and `provision.mjs` filters
them at emit time, so each machine's guide shows exactly one shell's examples
without maintaining two templates. Cross-machine lessons go in repo docs
([production-lessons.md](production-lessons.md),
[knowledge-base.md](knowledge-base.md)) so they reach every deployment via
`git pull`; `deploy/provision.mjs` re-emits the entry files after a pull, and
overwrites them unconditionally *because* they are generated — drift between
deployed guides and the repo was the failure mode that motivated this layout
(a hand-copied guide going stale, an entry file left empty by a missed rename,
a bad search/replace corrupting deployed examples).

Provisioning a new machine is agent-driven: [deploy/PROVISION.md](../deploy/PROVISION.md)
is a playbook (profiles `minimal`/`standard`/`gpu`) that an agent on the
target machine executes end to end — install, verify every tool's own check
command, emit the entry files, fill `MACHINE.md` with *measured* facts, and
finish with an end-to-end render. §9.5's generative boundary is what keeps
this layout stable: the engine stays portable (`npm install` + core binaries),
while GPU-heavy generative tooling varies per machine without touching the
engine.

## 17. The desktop viewer host (v0.26, Slice C)

`desktop/` is the ComfyUI-style desktop shell decided in the vendor-boundary
plan §10.2: an Electron window that **launches and views** the local Studio —
it owns process lifecycle and nothing else. The layering rule it must never
break: the shell reimplements no Studio behavior and adds no privileged
bridge (`contextIsolation`, no `nodeIntegration`); it is a viewer.

Mechanics, in order: resolve a **real Node runtime** (`MOTION_STUDIO_NODE`,
else PATH) — never Electron's own executable, because the Studio spawns
render workers from its `process.execPath` and those must be Node; probe a
free port; spawn `engine/src/studio/server.js` with `PORT`; poll HTTP until
ready; load the URL in a `BrowserWindow`. Child stdout/stderr stream to
`studio.log` under Electron's user-data dir. On close the child dies as a
**tree** (`taskkill /T` on Windows, a process-group signal elsewhere), so no
Chromium, FFmpeg, or render-worker descendant outlives the window — verified
by `desktop/smoke.mjs`, which requires the served page to genuinely load and
the port to stop answering afterward.

The shell changes nothing for agents: MCP connections are configured exactly
as in [mcp-setup.md](mcp-setup.md), with or without the window open. The
same Studio can still be served headless and viewed remotely
(`MOTION_STUDIO_STUDIO_HOST`, §14). `desktop/` is private to the repository
— excluded from the npm install artifact, Electron a devDependency of that
folder alone. Packaging (bundled Node, installer) is the plan's remaining
Slice C work.
