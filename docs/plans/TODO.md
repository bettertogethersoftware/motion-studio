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
2. [ ] **Docker support** ([plan](docker-support-plan.md)) — 1–2 days,
       independent of item 1; the best effort-to-impression ratio for the
       demo tier and server-hosted deployments. Pull it forward past item 1
       whenever a customer demo lands on the calendar.
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
