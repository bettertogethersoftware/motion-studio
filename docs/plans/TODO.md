# TODO — the live index

The single entry point for planned work. **How this folder works:** active
plans keep their own full documents here; this file orders them and holds
items too small for a document. Finished work moves to a summary in
[completed.md](completed.md); dropped ideas move to [retired.md](retired.md)
with the reason. Update this index whenever a linked plan moves.

Active plan documents:

| document | what it is |
|---|---|
| [token-efficient-motion-studio-plan.md](token-efficient-motion-studio-plan.md) | compact projections, batch tools, render groups — attacks the measured 49% token bucket of a real production (proposed) |
| [plate-render-forge-plan.md](plate-render-forge-plan.md) | plateforge/motionforge shell orchestration for Krea2 plates → verified film delivery (proposed; review WITH the token-efficient plan) |
| [docker-support-plan.md](docker-support-plan.md) | the containerized third distribution tier — demo-in-a-box, server-hosted Studio, MCP sidecar (proposed, 1–2 d) |
| [production-workflow-backlog.md](production-workflow-backlog.md) | the product backlog: staging→validate→promote, review artefacts, aspect variants, libraries |
| [audio-cue-plan.md](audio-cue-plan.md) | frame-granular envelope + emphasis onsets |
| [auto-reframe-plan.md](auto-reframe-plan.md) | `measure_reframe` — the hard half of aspect variants |
| [image-prep-plan.md](image-prep-plan.md) | `prepare_image` — the still-image hole in the media surface |
| [ai-only-desktop-vendor-boundary-plan.md](ai-only-desktop-vendor-boundary-plan.md) | **delivered 2026-08-04 as v0.26.0** (Slices 0/A/B/C-1 — see [completed.md](completed.md)); kept for the two remainders below |
| [linux-ready-plan.md](linux-ready-plan.md) | **complete 2026-08-04 — Linux is supported**; kept for the record and the remaining caveats |

## Next up (ordered)

1. [ ] **Token-efficient production loop, P0** ([plan](token-efficient-motion-studio-plan.md)):
       `detail` projections + cursors, `use_shared_asset_batch`,
       `write_composition_bundle`, `render_group`/`wait_render_group`.
       Highest measured value on the board — a real 180 s production spent
       ~49% of 57.5 M agent tokens on per-scene orchestration this
       eliminates, and it is engine-side, testable, and consumed by
       everything below. Its P1-3 (durable run groups) absorbs the old
       "durable jobs" backlog item.
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
4. [ ] **Product backlog P0 items** from
       [production-workflow-backlog.md](production-workflow-backlog.md):
       staging→validate→promote delivery, the review artefact, aspect
       deliverable variants. Then the queued plans, audio-cue first
       (smallest, knowledge-shaped, caught a real 1.5–2.7 s sync defect no
       existing check can see).
5. [ ] **Vendor-boundary remainders**, whenever convenient: treating the
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
- [ ] TE-4c (P1 remainder): durable run groups beyond the persisted group
      records (absorbs the old "durable jobs" item), agent-economy
      telemetry, and the NEON APEX replay acceptance.

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
