# Motion Studio — Architecture (v0.18)

## 1. System overview

Motion Studio is three thin entry points around one shared render engine.

```
 Human path                                 Agent path
 ──────────                                 ──────────
 Browser → Studio web UI                    MCP client (Claude Desktop / Code)
   http://127.0.0.1:7345                            │  MCP over stdio
        │ HTTP/SSE (localhost only)                 ▼
        ▼                                   MCP server (engine/src/mcp/server.js)
 Studio server (engine/src/studio/)           28 tools, path sandbox
   projects / assets / settings                     │
   preview / render API                             │
   hot-reload SSE, output download                  │
        │            in-process calls               │
        └──────────────┬────────────────────────────┘
                       │            ┌── CLI (engine/src/cli/render.js)
                       ▼            ▼      scripts, CI, parallel workers
        Render Engine Core (engine/src/core/)
          renderer.js  — capture loop, parallel split, stills
          browser.js   — Puppeteer lifecycle (injectable)
          encoder.js   — FFmpeg pipe / sequence / concat / transcode / audio
          formats.js   — output-format registry (mp4 webm gif prores png-seq)
          jobs.js      — job queue, status, logs, cancellation
          progress.js  — JSON-line protocol (+ etaMs)
          settings.js  — global user preferences (all entry points; see §11)
          vendors.js   — vendor kit: selection, status, errors (see §9.2)
          tts-vendors.js / music-vendors.js — per-capability dispatch
                       ▼
        headless Chromium ──PNG──▶ FFmpeg ──▶ mp4 / webm / gif / mov / frames
```

The engine core is the *only* implementation of "launch Chromium / capture a
frame / run FFmpeg". The CLI translates process arguments and signals into
engine calls and streams the protocol to stdout; the MCP server translates
tool calls into the same engine calls and folds the same protocol into
pollable job state; the Studio server exposes the same calls over local HTTP
for the UI. Because all paths share the fragile parts (Puppeteer lifecycle,
process trees, encoding), they cannot drift apart.

v0.2 shipped a Windows-only C# WinForms app on the human path; v0.5 replaces
it with the Studio web UI — see [CHANGELOG.md](CHANGELOG.md) for the full
rationale (cross-platform, one toolchain, and strictly better preview
fidelity since the browser preview drives the project's real entry HTML).

## 2. The frame model

A composition is a folder with `project.json` (fps, dimensions, duration,
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

## 4. IPC: the JSON-line progress protocol

Everything the engine reports crosses one contract,
`engine/src/core/progress.js` — one JSON object per stdout line:

| type | fields | meaning |
|---|---|---|
| `start` | `jobId, totalFrames, fps, width, height` | render accepted, dimensions locked |
| `progress` | `frame, totalFrames, framesDone, elapsedMs, renderFps, etaMs` | one per captured frame (aggregated across workers; `etaMs` null until ≥3 frames of signal) |
| `phase` | `phase` | `capturing` → (`concat`) → `encoding` → (`audio`) |
| `log` | `level, message` | diagnostics worth showing |
| `done` | `outputPath, frames, elapsedMs` | terminal success |
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

## 6. Error model

All cross-boundary failures are `EngineError`s with a stable
machine-readable `code` (`engine/src/core/errors.js`): `prereqs_missing`,
`project_not_found`, `project_already_exists`, `invalid_config`,
`path_outside_project`, `file_not_found`, `syntax_error`, `job_not_found`,
`browser_launch_failed`, `composition_error`, `frame_timeout`,
`ffmpeg_failed`, `cancelled`, `disk_error`, `internal_error`, and — new in
v0.5 — `unsupported_format`, `asset_too_large`, `queue_full`. New in v0.11:
`short_render` (the encoded file has fewer frames than were rendered). New in
v0.14: `browser_crashed` — a crash-shaped Chromium failure ("Target closed" et
al.), classified so it stops masquerading as `composition_error`/
`frame_timeout`/`internal_error`; the capture loop relaunches and retries on it
in place, and it only surfaces after the per-render relaunch budget (3) is
spent. New in v0.19: `no_audio_tracks` — `preview_audio` on a project whose
`config.audio` is empty.
The generated-audio and library features carry their own codes: v0.6–v0.7
`tts_unavailable`, `tts_failed`, `unsupported_voice`, `library_unavailable`;
v0.8 `music_unavailable`, `music_failed`, `invalid_music_spec`; v0.9
`inconsistent_scenes`, `scene_not_rendered`, `film_failed`; v0.12
`invalid_sfx_spec`. The `*_unavailable` pair means "not configured on this
machine — a setup problem, do not retry"; the `*_failed` pair means the
configured tool itself failed. (There is deliberately no `sfx_unavailable`:
sfx is pure JS with nothing to configure.)
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

`project.json` may declare `audio: [{ src, startInFrames?, gainDb?,
trimEndInFrames?, fadeInFrames?, fadeOutFrames?, duck? }]` (the last four new
in v0.19). After the silent video exists, a single FFmpeg pass builds a
`-filter_complex` graph — per-track clip-relative `atrim`/`afade` (fade-out
bounded by the trim, else by the composition end), then `adelay` (frame offset
→ ms) and `volume`, then `amix` with `normalize=0` so adding a quiet voiceover
doesn't duck the music bed — and muxes with the video stream copied. Every
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
catch it. The graph therefore ends `[amix] → alimiter(limit=0.891, level=0) →
[aout]`: a brick wall at −1 dBFS that is a no-op below the threshold, with
alimiter's auto-levelling pinned off so it can never *boost* a quiet mix. Set
`output.audioLimiter: false` to pass the sum through untouched. After muxing,
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

Two of the three generators have more than one possible implementation:

```
speech  →  system (core/tts.js, Windows exe)   |  azure (core/tts-azure.js)  |  piper (core/tts-piper.js)
music   →  node   (core/music-node.js)         |  fluidsynth (core/music.js)
```

`core/vendors.js` owns what those axes share — the selection rule, the env
hooks, the status-report shape, and the sentence a caller sees when a vendor
cannot be used. `core/tts-vendors.js` and `core/music-vendors.js` supply the
providers on top; the shared module imports neither, so capability modules
depend on the kit and never the reverse. Within a capability, providers return
identical payload and probe shapes, so nothing downstream branches on vendor:
`synthesize_speech`, `synthesize_music`, the Studio page and the audio mixer
each see one source.

Selection uses the standard precedence — explicit argument →
`MOTION_STUDIO_TTS_VENDOR` / `MOTION_STUDIO_MUSIC_VENDOR` → `settings.json` →
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

## 10. Security and sandboxing

The agent-facing write surface is exactly composition source files and
`assets/` content inside the target project. `resolveInProject` (used by
every file-touching tool and every Studio file route) rejects absolute and
drive-letter paths, `..` escapes, null bytes, and symlink escapes (the
deepest existing ancestor is `realpath`-ed and re-checked). Text writes are
restricted to an extension allow-list (`.html .css .js .mjs .json .svg .txt
.md`); binary asset writes are additionally confined to the `assets/` folder,
allow-listed to image/audio/font types, and capped at 25 MB. The MCP tool
(`write_asset_file`, base64) and the Studio's raw-body upload both funnel
through one `ProjectStore.writeAssetBuffer`, so that confinement has a single
enforcement point rather than two implementations to keep in step; the
Studio's asset delete/rename routes resolve through the same sandbox.
`project.json` is deny-listed from raw writes so config invariants can only
change through the validated `update_project_config` tool (the Studio's
config PATCH calls the same `updateConfig`). `remove_project` deletes files
only inside the managed projects root.
There is no shell tool and no arbitrary-path tool. The MCP server is
stdio-only; the Studio server binds to `127.0.0.1` and has no authentication
because it is never reachable off-machine — do not reverse-proxy it.

One caveat worth stating plainly: composition JS executes with Chromium's
normal capabilities inside the render browser (it can, for example, `fetch`
remote resources). The sandbox governs what an agent can do to the *user's
disk and processes* through the tool surface, not what the page can do
inside Chromium. Treat composition code from untrusted sources like any
other code you run.

## 11. Shared project registry and global settings

All paths read and write `~/.motion-studio/projects.json` (override with
`MOTION_STUDIO_HOME`), and project folders are identical regardless of which
side created them. Scaffolding is implemented once, in the engine's
`ProjectStore`; the Studio UI and MCP `create_project` both call it. Config
files written by v0.2 (schema v1) are migrated to schema v2 on read,
non-destructively. Registry writes are atomic (temp file + rename).
Human/agent concurrent edits remain last-write-wins on disk, surfaced to the
human through the Studio's hot-reload watcher.

`~/.motion-studio/settings.json` (v0.15, `core/settings.js`) sits alongside it
and holds *user preferences*, with the same atomic write and a validated
schema: `newProjectDefaults`, `render.defaultWorkers`, an `ffmpeg` block
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
gaps** — an explicit argument always wins, which is why MCP's `create_project`
takes `.optional()` fields rather than zod `.default()`s (a default is
indistinguishable from a caller who meant it). And they apply **only at
creation**: an existing `project.json` is never rewritten because a global
changed, so a project renders identically tomorrow. Both front ends route
through `withNewProjectDefaults` / `outputSeedFromSettings` in
`core/settings.js` rather than merging locally, so they cannot drift.

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

- **Screenshot size** (`scale`, default 0.5): the Puppeteer viewport is set to
  `width×scale by height×scale`, **floored to even numbers** because
  mp4/webm/prores reject odd dimensions and a proxy must work with whatever
  format the project is configured for. The fixed-pixel composition is mapped
  onto the small viewport by an inline `transform: scale(sx, sy);
  transform-origin: 0 0` on `documentElement` — the one element compositions
  never style themselves — with per-axis factors derived from the even-floored
  dims so the content fills the viewport exactly. This is safe because of the
  frame contract (§2): compositions are pure functions of frame authored at
  fixed pixel sizes and never read window dimensions. The screenshot is *of the
  small viewport* — capturing large and downscaling would keep the very cost
  the proxy exists to cut.
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

## 13. Testability

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

492 tests across 26 suites; see `engine/test/`. A clean run has **zero
failures**. Tests skip rather than fail when the platform cannot host them:
besides the gated Chromium suite, `cli: SIGTERM mid-render cancels with exit
code 4` is POSIX-only, because Windows has no signal mechanism and
`child.kill('SIGTERM')` falls back to `TerminateProcess()` — the process dies
before any handler runs, so `close` reports `null` instead of the CLI's exit
code 4. Cancellation on Windows is unaffected: it goes through
`JobManager.cancel`'s in-process abort, covered on every platform. A
permanently-red case teaches readers to skim past failures, which is how a
real regression hides.
