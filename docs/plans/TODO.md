# TODO — the live index

The single entry point for planned work. **How this folder works:** active
plans keep their own full documents here; this file orders them and holds
items too small for a document. Finished work moves to a summary in
[completed.md](completed.md); dropped ideas move to [retired.md](retired.md)
with the reason. Update this index whenever a linked plan moves.

Active plan documents:

| document | what it is |
|---|---|
| [clone-scene-plan.md](clone-scene-plan.md) | `clone_scene` — one-call scene copy across/within films: config + assets + vendored libs + provenance (**shipped code-complete 2026-08-05, targeted v0.27; awaiting commit + skill re-copy**) |
| [token-efficient-motion-studio-plan.md](token-efficient-motion-studio-plan.md) | compact projections, batch tools, render groups — attacks the measured 49% token bucket of a real production (proposed) |
| [plate-render-forge-plan.md](plate-render-forge-plan.md) | plateforge/motionforge shell orchestration for Krea2 plates → verified film delivery (proposed; review WITH the token-efficient plan) |
| [docker-support-plan.md](docker-support-plan.md) | the containerized third distribution tier — demo-in-a-box, server-hosted Studio, MCP sidecar (proposed, 1–2 d) |
| [production-workflow-backlog.md](production-workflow-backlog.md) | the product backlog: staging→validate→promote, review artefacts, aspect variants, libraries |
| [studio-navigation-plan.md](studio-navigation-plan.md) | Studio UI refinement: the scene ↔ film round trip, AE-style document tabs, sequence zoom/jump (**N-1/N-3/N-6/N-7/N-8 shipped code-complete 2026-08-05**; N-5 handed to [scene-inspector-plan.md](scene-inspector-plan.md), which closes this one) |
| [studio-shell-plan.md](studio-shell-plan.md) | **one Studio, documents inside it** — index.html becomes the shell (permanent Explorer + document tabs + editor stack); films AND scenes open as same-origin iframe documents; page navigation removed entirely (**shipped code-complete 2026-08-06; awaiting commit**) |
| [scene-inspector-plan.md](scene-inspector-plan.md) | the whole scene *inside* the film page — N-5(b), the Final Cut answer: one shared panel module (config/audio/assets/outputs) mounted by both documents, a resizable inspector, `open scene ↗` demoted to an escape hatch (**shipped code-complete 2026-08-05; awaiting commit**) |
| [audio-cue-plan.md](audio-cue-plan.md) | frame-granular envelope + emphasis onsets |
| [auto-reframe-plan.md](auto-reframe-plan.md) | `measure_reframe` — the hard half of aspect variants |
| [image-prep-plan.md](image-prep-plan.md) | `prepare_image` — the still-image hole in the media surface |
| [ai-only-desktop-vendor-boundary-plan.md](ai-only-desktop-vendor-boundary-plan.md) | **delivered 2026-08-04 as v0.26.0** (Slices 0/A/B/C-1 — see [completed.md](completed.md)); kept for the two remainders below |
| [linux-ready-plan.md](linux-ready-plan.md) | **complete 2026-08-04 — Linux is supported**; kept for the record and the remaining caveats |

## Next up (ordered)

1. [x] **Token-efficient production loop — complete 2026-08-04**
       ([plan](token-efficient-motion-studio-plan.md)): `detail` projections
       + cursors, `use_shared_asset_batch`, `write_composition_bundle`,
       `render_group`/`wait_render_group`, plus the P1 set (`finish_film`,
       `review_render_grid`, durable run groups, agent-economy telemetry)
       and the NEON APEX replay acceptance. Slice-by-slice ledger in the
       progress section below; P1-3 absorbed the old "durable jobs" backlog
       item.
2. [ ] **Docker support** ([plan](docker-support-plan.md)) — **blocked on
       Docker being installed on the dev machine** (checked 2026-08-04:
       not present; the slice cannot be honestly verified without it).
       1–2 days once available; the best effort-to-impression ratio for
       the demo tier and server-hosted deployments.
3. [ ] **PlateForge/MotionForge** ([plan](plate-render-forge-plan.md)) —
       **after** item 1's P0: the motionforge half should consume
       `use_shared_asset_batch`/`render_group` instead of reimplementing
       aggregation client-side (the plan itself says "if a future batch MCP
       operation exists, use it"). The plateforge/Krea2 half has no such
       dependency and could start alongside item 1 if GPU production
       resumes first.
       **Progress 2026-08-04: plateforge P0 items 1–2 implemented** at the
       tools root (`<toolsRoot>\agent_tool\plateforge\`, outside this
       repository, with its own `README.md` and an entry in `MACHINE.md`). Ships `doctor`,
       `plan`, `generate`, `review`, `select`, `stage`, and `verify-assets`
       — the shared manifest, path containment, Krea2 sidecar reuse/stale/
       `--force`, the JSONL event log and run-directory layout, the single
       contact sheet, explicit selection, and safe library staging. 115
       unittests pass against a fake Krea2 helper; real GPU generation is
       still unexercised.
       **Progress 2026-08-05: motionforge implemented** (delivery-order
       items 3–4) at the tools root (`<toolsRoot>\agent_tool\motionforge\`,
       with its own `README.md` and an entry in `MACHINE.md`). Ships `doctor`, `link`,
       `render`, `build`, `verify`, and the resumable `run` with
       `--plan-only` / `--resume` / `--no-build` / `--visual-review`
       (`--force-plate` is refused and redirected to plateforge). Per the
       architect override, it **consumes the v0.26 engine operations instead
       of reimplementing them**: `link` is one `use_shared_asset_batch`,
       `render` is `render_group` + `wait_render_group` with its `since`
       cursor in a bounded loop (groupId persisted, restart re-attaches and
       the engine recomputes truth from output files), `build`+`verify` ride
       one `finish_film` job plus `get_production_status`/`measure_render`
       and external ffprobe — `get_film` full and the per-scene `render`
       loop are never called. Dependency-free Node with its own ~150-line
       stdio MCP client; 37 `node --test` tests (~8 s) run against a REAL
       engine server on a throwaway `MOTION_STUDIO_HOME` with the fake
       browser module. **Remaining: the plan's acceptance run on real GPU
       production** (ten real plates, an interrupted resume, the finished
       delivery) — everything else in the plan is implemented.
4. [ ] **Product backlog P0 items** from
       [production-workflow-backlog.md](production-workflow-backlog.md):
       staging→validate→promote delivery, the review artefact, aspect
       deliverable variants. Then the queued plans, audio-cue first
       (smallest, knowledge-shaped, caught a real 1.5–2.7 s sync defect no
       existing check can see).
5. [x] **Studio UI refinement — shipped code-complete 2026-08-05**
       ([plan](studio-navigation-plan.md)): the round trip (the scene page
       derives its own film and links back through the `&scene=` deep link
       that had existed unused since v0.23), same-tab `open scene ↗`,
       keyboard parity, the localStorage document strip, and sequence
       movement (double-click to zoom, PgUp/PgDn cut-to-cut). Awaiting
       commit.
6. [x] **The scene inspector — shipped code-complete 2026-08-05**
       ([plan](scene-inspector-plan.md)). `scene-panels.js` is the single
       implementation of config/audio/assets/outputs, mounted by the scene
       page and by the film inspector's tab strip; the inspector is
       resizable and its panel DOM survives the 1 Hz poll with focus and
       caret intact; `open scene ↗` is demoted to an escape hatch. Verified
       in-browser against SEPHIROTH and jin-park-sunshine-vertical; suites
       green. Awaiting commit. Original framing:
       N-5(b),
       the piece the navigation plan left to the user and the user has now
       taken. Fixing the *return* edge made the trip cheap; it did not
       remove it, and a reviewer who leaves the timeline loses the thread of
       the film they are judging. The scene's own panels move **into** the
       film inspector behind a tab strip. The load-bearing constraint is that
       they must not be a second copy: one shared `scene-panels.js` mounted
       by both documents, adopted by the scene page first so the refactor is
       provable against the surface that already works. ~1 d.
7. [x] **The Studio shell — shipped code-complete 2026-08-06**
       ([plan](studio-shell-plan.md)). The two-page Studio is gone: the
       Explorer tree is permanent and films and scenes open as document tabs
       in one window, each a same-origin iframe so a tab keeps its playhead,
       undo stack and scroll while another is in front. Also landed the VS
       Code chrome (activity bar, status bar, command palette, Dark Modern
       surfaces with the amber accent kept) and `scene.html`/`scene.js`,
       extracted from index.html/app.js. `tabs.js` retired. Awaiting commit.
8. [ ] **Vendor-boundary remainders**, whenever convenient: treating the
       pinned browser and FFmpeg as packs (the bootstrap must learn archive
       extraction first); C-2 desktop packaging (bundled Node, installer) —
       **deprioritized by §10.7** ("no installer channel — the Electron
       host follows, never leads"); the unpackaged `desktop/` host covers
       the checkout case today.

## Token-efficient loop progress (started 2026-08-04)

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
- [ ] **Contribution/support contracts** for the repository.
- [ ] **Known suite flake** — `studio-film-page` "build archives a
      delivery" fails rarely under the full parallel run, passes standalone
      and on re-run. Worth one root-cause hour before it erodes trust in
      red suites.

## Parked, with reasons

- [ ] **`prepare_image`** ([plan](image-prep-plan.md)) — **deferred
      2026-08-04 by the user**: its Python/Pillow dependency makes it
      shell-tool territory (an agent-side helper beside the forges), not
      an engine vendor — consistent with the generative-boundary rule that
      spawned external interpreters stay outside the MCP surface. The plan
      document remains valid as the design record for whoever builds the
      shell version; the Env-A hard wall stands and is the revisit trigger
      (an MCP-only customer who must prep supplier stills).
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
