# TODO — the live index

The single entry point for planned work. **How this folder works:** active
plans keep their own full documents here; this file orders them and holds
items too small for a document. Finished work moves to a summary in
[completed.md](completed.md); dropped ideas move to [retired.md](retired.md)
with the reason; known defects — things that are wrong *now*, as opposed to
work we intend to do — live in [bug-backlog.md](bug-backlog.md). Update this
index whenever a linked plan moves.

Active plan documents:

| document | what it is |
|---|---|
| [token-efficient-motion-studio-plan.md](token-efficient-motion-studio-plan.md) | compact projections, batch tools, render groups — **P0+P1 complete 2026-08-04**; kept for the ledger and the two deferred row fields |
| [plate-render-forge-plan.md](plate-render-forge-plan.md) | plateforge/motionforge shell orchestration for Krea2 plates → verified film delivery (**complete 2026-08-06**; kept for the ledger) |
| [studio-ui-polish-plan.md](studio-ui-polish-plan.md) | the shell's seams under real load — tab strip, background-tab errors, the edit lost on tab close, six smaller honesty repairs, **and the approved accessibility pass** (proposed 2026-08-06, ~4½ d, U-1…U-13) |
| [docker-support-plan.md](docker-support-plan.md) | the containerized third distribution tier — demo-in-a-box, server-hosted Studio, MCP sidecar (proposed, 1–2 d) |
| [production-workflow-backlog.md](production-workflow-backlog.md) | the product backlog: staging→validate→promote, review artefacts, aspect variants, libraries |
| [audio-cue-plan.md](audio-cue-plan.md) | frame-granular envelope + emphasis onsets |
| [auto-reframe-plan.md](auto-reframe-plan.md) | `measure_reframe` — the hard half of aspect variants |
| [ai-only-desktop-vendor-boundary-plan.md](ai-only-desktop-vendor-boundary-plan.md) | **delivered 2026-08-04 as v0.26.0** (Slices 0/A/B/C-1 — see [completed.md](completed.md)); kept for the two remainders below |
| [linux-ready-plan.md](linux-ready-plan.md) | **complete 2026-08-04 — Linux is supported**; kept for the record and the remaining caveats |

## Next up (ordered)

1. [x] **Token-efficient production loop — complete 2026-08-04**
       ([plan](token-efficient-motion-studio-plan.md), ledger in
       [completed.md](completed.md)). P1-3 absorbed the old "durable jobs"
       backlog item.
2. [ ] **Docker support** ([plan](docker-support-plan.md)) — **blocked on
       Docker being installed on the dev machine** (checked 2026-08-04:
       not present; the slice cannot be honestly verified without it).
       1–2 days once available; the best effort-to-impression ratio for
       the demo tier and server-hosted deployments.
3. [x] **PlateForge/MotionForge — complete 2026-08-06**
       ([plan](plate-render-forge-plan.md), ledger in
       [completed.md](completed.md)): both tools ship at the tools root
       (`<toolsRoot>\agent_tool\`), with the real-GPU acceptance run closed.
4. [ ] **Product backlog P0 remainder** from
       [production-workflow-backlog.md](production-workflow-backlog.md) —
       **the workable next item.** P0-1 (staging→validate→promote) and P0-2
       (the review artefact) shipped 2026-07-29, and P0-3 Stage A shipped
       with them; what is left is **P0-3 Stage B — variant renders**, the
       correct 9:16/1:1 for text-heavy films that Stage A's reframe metadata
       cannot fix by cropping alone. Then the queued plans, audio-cue first
       (smallest, knowledge-shaped, caught a real 1.5–2.7 s sync defect no
       existing check can see).
       **Progress 2026-08-06 — Stage B's authoring contract shipped**
       (its prerequisite, not the render path): the engine states
       `--ms-width`/`--ms-height` and the `--ms-safe-*` rectangles on every
       page it opens, frame API v1.6 adds `frameSize()`/`safeArea()`, and the
       proxy path was fixed to keep the authored layout viewport (it shrank
       the viewport, so relative units were dishonest in drafts). Stage A was
       exercised for the first time on real work — `same-machine-mv` →
       `shorts-9x16`, 175 s re-encoded in 59 s, delivery archived, guides
       clean. **The audit that motivated it:** across all eleven rendered
       films there is not one `vw`/`vh`/`clamp()`/relative font size, so
       nothing benefits retroactively — Stage B pays off for films authored
       to the contract, and among existing ones only `signal-path` (engine-
       drawn, edge-anchored HUD) is a true Stage B case; the plate-driven
       MVs crop acceptably, which the shorts build now demonstrates.
5. [x] **The Studio UI program — shipped and committed 2026-08-05/06**:
       navigation refinement, the scene inspector, and the Studio shell that
       closed all three (`bdb1efa`…`2ddef07`). Summarized in
       [completed.md](completed.md); the three plan documents remain as the
       design record. **Follow-up open:**
       [studio-ui-polish-plan.md](studio-ui-polish-plan.md) — the shell was
       verified with one or two documents in the foreground, and its seams
       fail under real load (a ten-tab strip whose names render 9 px wide, a
       render failure raised behind a hidden iframe, a film edit dropped by
       `frame.remove()`). **The accessibility pass was approved 2026-08-06**
       and is scheduled in the same document as U-10…U-13 — the two trees,
       the palette, the icon-only controls, timeline block selection —
       after investigating it found the palette dropping focus on `<body>`
       when it closes, which kills every document shortcut until you
       click. ~4½ days total, splittable; U-1/U-3/U-4/U-11 carry the value,
       U-13 is the first thing to cut.
       **Progress 2026-08-06 — U-1…U-7, U-9, U-11, U-12 shipped**, U-8 partly,
       plus U-8's engine half as BUG-2: the tab strip, the
       drifted helpers, background-document toasts, the tab-close flush, the
       working-set keyboard (Alt+W / Alt+PageUp-Down / Alt+1…9 / Ctrl+K W —
       not Ctrl+W, which the browser owns), the film-delete dialog, the
       palette's focus restore, the activity bar's state, and the version
       chip, and — closing U-6 — the shared name/confirm dialogs that took the
       last native `prompt()`/`confirm()` out of the film document and the
       panels module. Each accepted in headless Chromium, U-4 and U-6 with
       control runs against disk. **U-14 was added and shipped the same day
       from use**: the Explorer now marks the active document against merely
       open ones, gives every row a single glyph that says what it is and
       how far along it is (built / edited-since-built / draft, rendered /
       stale / not yet — and on a film it is the twisty too), refreshes
       itself from `/api/events` (badging what an agent just created), and
       fans that one stream out to every document instead of one socket each.
       **U-15 followed**: the film timeline's lanes are stored rather than
       re-derived on every repaint (so one stops vanishing mid-drag, an empty
       one can exist, and a clip can be dragged between them), audio clips trim
       from the head as well as the tail — a new engine field,
       `trimStartInFrames`, proven against ffmpeg — and the audio picker plays
       each file before you place it. **Remaining: U-10 (both trees), ~1 day.
       U-13 (timeline blocks) was retired 2026-08-08** — the slice nominated
       itself as the cut, selection was its only missing piece, and the
       inspector is already a keyboard path to every value a selected block
       exposes ([retired.md](retired.md)).
6. [ ] **Vendor-boundary remainder**, whenever convenient: treating the
       pinned browser and FFmpeg as packs (the bootstrap must learn archive
       extraction first). **C-2 desktop packaging was retired 2026-08-08** —
       §10.7 had already ruled out the installer channel ("the Electron host
       follows, never leads"), and the unpackaged `desktop/` host covers the
       checkout case today ([retired.md](retired.md)).

## Token-efficient loop progress (2026-08-04, closed)

Summarized in [completed.md](completed.md); kept here as the slice ledger.

- [x] TE-1 (2026-08-04): P0-1 detail projections + P0-2 cursors —
      `core/projections.js` (segment rows with folded `state`, stateless
      cursor/diff), `get_production_status` compact-by-default with
      `since` heartbeats/deltas/`cursorReset`, `list_films` readiness
      rows by default, `get_film` gains `scenes`/`summary` (default stays
      `full` — the editing read). Deferred from the row spec:
      `outputIdentity {bytes, mtimeMs}` — planFilm does not surface it yet;
      add when render groups (P0-6) need it.
- [x] TE-2 (2026-08-04): P0-4/P0-5 batch operations —
      `use_shared_asset_batch` (per-item rows + counts, idempotent) and
      `write_composition_bundle` (validate once, write targets
      independently, content hashes). Deferred: `expectedRevisions` on the
      bundle — the single-file tool has no revision guard either; add both
      together if composition drift ever bites.
- [x] TE-3 (2026-08-04): P0-6/P0-7 render groups — `render_group`
      (plan-once, refuse-broken, skip-current, per-scene queue_full rows,
      re-run = resume, record persisted with the film),
      `wait_render_group` (aggregate counts, failure detail only on
      failure, since-cursor heartbeats/deltas, `done` from output files —
      restart-proven by a second-server test), `cancel_render_group`.
- [x] TE-3b (2026-08-04): the P0-3 canary sweep — a distinctive
      composition body written to a scene must not appear in any
      production-loop read at its default or compact details. **The
      token-efficient plan's P0 is complete.**
- [x] TE-4a (2026-08-04): P1-1 `finish_film` — the composite finish as one
      task job (advice/plan blockers up front + dryRun, render group →
      build → delivery → picture measurement, cancel cascades to sub-jobs,
      evidence in the job result). Proven end to end in the loop suite.
- [x] TE-4b (2026-08-04): P1-2 `review_render_grid` — one contact sheet
      plus one compact row per cell for a whole film, read from the built
      film or the individual scene renders (cut + hold per segment, or one
      hold with `scope: "scenes"`). Sheets persist under
      `<film>/review-grids/` so the async path returns a path and counts,
      never base64, and the image is collected later by `gridId`. The
      delivery review's tiler was factored into a shared
      `buildContactSheet`. `inspect_render` is untouched — this is
      transport, not a replacement for inspection.
- [x] TE-4c (2026-08-04): P1-3 durable run groups + P1-4 agent-economy
      telemetry (absorbs the old "durable jobs" item). Group records now
      complete themselves — per-member `terminalState`/`finishedAt` stamped
      by `wait_render_group` (and by `finish_film`, which never calls it),
      group `completedAt`, and `deliveryId`/`deliveredAt` the moment a build
      succeeds; every update is best effort and atomic-ish, and the restart
      rule stands (records inform, files decide). `agent-economy.json` at
      the storage root counts proxies — per-tool calls/bytes, compact vs
      full, and the per-scene calls each batch replaced — never tokens,
      never arguments or file contents (canary-tested), wired by one
      `registerTool` decoration.
- [x] TE-4d (P1 remainder): the NEON APEX replay acceptance — replay the
      ten-scene, 180-second film through the token-efficient path and
      record the measured saving against the plan's acceptance criteria.

## Engineering backlog

- [ ] **CI gate remainder** — lint/format check, coverage artifacts,
      required-check branch protection (the workflow itself shipped
      2026-08-04). Add the docker-build job here when the Docker plan runs.
- [ ] **Coverage reporting + a small cross-platform media fixture set.**
- [ ] **Still-image facts on `probe_asset`** — `width`, `height`, `hasAlpha`,
      `contentBox`, `meanLuminance`, `isBlank` for a still input. The one
      knowledge-shaped half of the retired `prepare_image` plan
      ([retired.md](retired.md)): no Python, no new vehicle, and it answers
      "where is the content in this frame" and "how dark is the region under
      my caption" before a render instead of after one.
- [ ] **Contribution/support contracts** for the repository.
- [ ] **Known suite flake** — `studio-film-page` "build archives a
      delivery" fails rarely under the full parallel run, passes standalone
      and on re-run. Worth one root-cause hour before it erodes trust in
      red suites.
- [ ] **Known defects** live in [bug-backlog.md](bug-backlog.md) — three open,
      none blocking (BUG-2 was fixed 2026-08-06). **BUG-1**: a scene's vendored
      `frame-api.js` is frozen at creation, so every scene made before a runtime
      bump lacks the helpers [frame-api.md](../frame-api.md) documents (v1.6's
      `frameSize`/`safeArea` today; v1.4 and v1.5 had the same hole unnoticed) —
      fix (2), re-copying the runtime on *clone*, is worth taking on its own,
      and it is the one that misleads a reader rather than merely failing one.
      **BUG-3**: the film page accepts edits before it has loaded, and drops
      them. **BUG-4**: `computeFit` throws on a document being torn down — one
      console line, one-line fix.

## Parked, with reasons

- [ ] **Helper win32 audit remainder**: FFmpeg/FluidSynth *discovery* is
      platform-aware in all tools-root helpers, but their full command
      construction is unaudited for Windows-only conventions. Do before
      promising the forge helpers on Linux.
- [ ] **faster-whisper as a second transcription vendor** — evaluated
      2026-08-04, **not** adopted as a replacement: Python library vs. the
      one-binary-one-model vendor philosophy, runtime HF model downloads, a
      second JSON parser beside whisper.cpp's `-ojf` shape, CPU-only on
      Apple Silicon. Adoption trigger: a customer needing GPU-speed
      transcription of hours-long footage.
- [ ] **macOS, then ARM64** (Windows-on-ARM Spark boxes, Linux ARM) — x64
      Linux passed L4 on 2026-08-04, so these are unblocked; schedule when a
      macOS/ARM customer appears. Most Linux work transfers.
- [ ] **GitHub Actions Node-20 deprecation** — bump `actions/checkout` and
      `actions/setup-node` majors in `ci.yml`. Cosmetic until it breaks.
- [ ] **CI badge in README.md.**

## Recently completed (context — details in [completed.md](completed.md))

- 2026-08-06 — **The frame-geometry authoring contract** (`--ms-*` variables,
  frame API v1.6, the proxy layout-viewport fix) plus the first real Stage A
  variant build. Stage B's prerequisite; see item 4.
- 2026-08-06 — **PlateForge/MotionForge complete**: both agent tools at the
  tools root, motionforge riding the v0.26 batch/group operations, and the
  real-GPU acceptance run (ten plates, an interrupted resume, a finished
  delivery) closed.
- 2026-08-06 — **The Studio shell** (`22d053f`, `2ddef07`): one page, the
  Explorer permanent, films and scenes as same-origin iframe documents, VS
  Code chrome, and the film inspector's own **film · assets · outputs** tabs
  on the shared panel module.
- 2026-08-05 — **The scene inspector** and the **navigation round trip**:
  `scene-panels.js` as the single config/audio/assets/outputs implementation
  mounted by both documents, plus sequence movement and the document strip.
- 2026-08-05 — **`clone_scene`** (`bdb1efa`, targeted v0.27): one-call scene
  copy across or within films — config, assets, vendored libs, provenance.
- 2026-08-04 — **The token-efficient production loop, P0 + P1**: projections
  and cursors, `use_shared_asset_batch`/`write_composition_bundle`, render
  groups, `finish_film`, `review_render_grid`, durable group records, and
  `agent-economy.json`; NEON APEX replay acceptance measured.
- 2026-08-04 — **v0.26.0 released and tagged**: the whole vendor-boundary
  program (Slices 0/A/B/C-1 — boundary, packs, GitHub-URL install, desktop
  viewer host), release discipline + [release-checklist.md](../release-checklist.md).
  Full slice-by-slice ledger in [completed.md](completed.md).
- 2026-08-04 — **Render-format matrix on CI**: `smoke-render-formats.mjs`
  proves mp4 / webm-alpha / gif / prores-4444 / png-sequence plus parallel
  workers and cancellation through the real browser, ffprobe-verified.
- 2026-08-04 — **Linux L4 acceptance PASSED** on a fresh Ubuntu 24.04 WSL2
  distro; PROVISION.md says **supported**; the acceptance script lives on
  as `engine/test/smoke-mcp-film.mjs`.
- 2026-08-04 — CI green end to end on both platforms; Linux L0–L3; per-OS
  entry emit; docs/plans consolidation.
- 2026-08-03 — v0.26 deployment restructure (`deploy/` machinery, generative
  boundary policy, production-lessons.md).
- 2026-08-01/02 — v0.23/v0.23.1 production loop (sequences + human advice).
