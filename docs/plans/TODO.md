# TODO — the live index

The single entry point for planned work. **How this folder works:** active
plans keep their own full documents here; this file orders them and holds
items too small for a document. Finished work moves to a summary in
[completed.md](completed.md); dropped ideas move to [retired.md](retired.md)
with the reason. Update this index whenever a linked plan moves.

Active plan documents:

| document | what it is |
|---|---|
| [linux-ready-plan.md](linux-ready-plan.md) | **complete 2026-08-04 — Linux is supported** (L4 passed on fresh Ubuntu 24.04); kept for the record and the remaining caveats |
| [ai-only-desktop-vendor-boundary-plan.md](ai-only-desktop-vendor-boundary-plan.md) | AI-only desktop runtime + vendor packs (proposed, 12–19 d) |
| [production-workflow-backlog.md](production-workflow-backlog.md) | the product backlog: staging→validate→promote, review artefacts, aspect variants, libraries |
| [audio-cue-plan.md](audio-cue-plan.md) | frame-granular envelope + emphasis onsets — **first of the three queued** |
| [auto-reframe-plan.md](auto-reframe-plan.md) | `measure_reframe` — the hard half of aspect variants |
| [image-prep-plan.md](image-prep-plan.md) | `prepare_image` — the still-image hole in the media surface |

## Next up (ordered)

1. [x] **Three Slice-0 design decisions** — DECIDED 2026-08-04, recorded in
       the [vendor-boundary plan](ai-only-desktop-vendor-boundary-plan.md)
       §10: zero-byte per-platform `system` speech backend as the default
       (Piper stays the documented upgrade); SoundFont fetch-on-command
       with SHA-256 as the pack-mechanism pilot (never in git, never
       fetched silently); fonts recorded in the render sidecar with the
       `@font-face`-assets policy for cross-machine consistency (optional
       font pack later). §10's remaining decisions (2–7: shell shape,
       pack contents, workspace split, Studio's future, injection seam,
       distribution shape) still gate Slice A.
2. [ ] **Vendor-boundary plan Slice 0** (footprint + vanilla preflight) —
       **mostly done 2026-08-04**: headless-shell-only browser (−420 MB per
       install) with `MOTION_STUDIO_CHROME` and sidecar recording;
       `npm run fetch-soundfont` (the pack-mechanism pilot); the zero-byte
       per-platform `system` speech backend; capability-tier reporting in
       doctor + `get_capabilities`. Remaining from Phase 0.5: the
       FFmpeg *fetched-pack* chain (resolution chain already exists) and
       treating the pinned browser itself as a pack. The injection-seam and
       distribution-shape decisions (§10.6–7) gate Slice A, not this.
3. [ ] **Product backlog P0 items** from
       [production-workflow-backlog.md](production-workflow-backlog.md):
       staging→validate→promote delivery, the review artefact, aspect
       deliverable variants. Then the three queued plans, audio-cue first
       (smallest, knowledge-shaped, caught a real 1.5–2.7 s sync defect no
       existing check can see).

## Slice A progress (vendor-boundary Phase 1; started 2026-08-04)

- [x] A-1/A-2: `core/audio.js` extracted from tts.js; all ten in-tree
      importers repointed; compat re-exports keep external imports working.
- [x] A-3: the import-graph boundary test stands guard before the migration.
- [ ] A-4 (next): catalog-driven vendor selection — the three `*-vendors.js`
      dispatchers consume an injected capability catalog instead of
      hardcoded provider imports; settings validation accepts schemas from
      the registry and tolerates vendors whose pack is absent. This is the
      settings-validation redesign the plan says dominates the estimate.
- [ ] A-5: default registry at `engine/src/vendors/default/registry.js`
      wrapping the existing modules; constructor-injected per §10.6, lazy
      and failure-tolerant.
- [ ] A-6: thread the runtime through the MCP and Studio entrypoints
      (~15 vendor symbols each); Phase 2 file moves follow.

## Engineering backlog (carried from the retired prioritized todo)

- [ ] **Release candidate discipline** — package.json still says `0.21.0`
      while docs describe v0.26; one release checklist synchronizing
      version, changelog, tool descriptions, skills, and migration notes.
- [ ] **CI gate remainder** — lint/format check, coverage artifacts,
      required-check branch protection (the workflow itself shipped
      2026-08-04).
- [ ] **Durable jobs** — render/transcription jobs survive a server restart.
- [ ] **Coverage reporting + a small cross-platform media fixture set.**
- [ ] **Contribution/support contracts** for the repository.

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

- 2026-08-04 — **Render-format matrix on CI**: `smoke-render-formats.mjs`
  proves mp4 / webm-alpha / gif / prores-4444 / png-sequence plus parallel
  workers and cancellation through the real browser, ffprobe-verified;
  runs in the `linux-render` job after the gated Chromium suite.
- 2026-08-04 — **Linux L4 acceptance PASSED** on a fresh Ubuntu 24.04 WSL2
  distro: agent-driven provisioning, full film over MCP (speech + music +
  SFX + Chromium renders + promoted build), whisper transcribe-back, forge
  smokes via distro FluidSynth. PROVISION.md now says **supported**; the
  acceptance script lives on as `engine/test/smoke-mcp-film.mjs`.
- 2026-08-04 — CI green end to end on both platforms (run #6): suite ×2,
  real-Chromium render with skips-are-failures, piper→whisper round-trip.
  Linux L0–L3 done; per-OS entry emit shipped; docs/plans consolidation.
- 2026-08-03 — v0.26 deployment restructure (`deploy/` machinery, generative
  boundary policy, production-lessons.md).
- 2026-08-01/02 — v0.23/v0.23.1 production loop (sequences + human advice).
