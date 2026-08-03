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

1. [ ] **Full render-format matrix on Linux CI**: extend the `linux-render`
       job beyond `real-chromium.test.js` to every output format (H.264,
       VP9/alpha, GIF, ProRes, PNG-seq), parallel workers, cancellation.
2. [ ] **Three Slice-0 design decisions** — make once, inside the
       [vendor-boundary plan](ai-only-desktop-vendor-boundary-plan.md), not
       ad-hoc: Linux default speech vendor (zero-byte per-platform `system`
       backend vs. documented-Piper); SoundFont on a clean clone (no fresh
       clone can synthesize music on any OS today); font determinism for
       Linux rendering (pin a pack vs. record the environment in metadata).
3. [ ] **Vendor-boundary plan Slice 0** (footprint + vanilla preflight) —
       its §10 decisions are unmade; the Linux work added extra motivation
       (the pack mechanism replaces several hand-rolled provisioning steps).
4. [ ] **Product backlog P0 items** from
       [production-workflow-backlog.md](production-workflow-backlog.md):
       staging→validate→promote delivery, the review artefact, aspect
       deliverable variants. Then the three queued plans, audio-cue first
       (smallest, knowledge-shaped, caught a real 1.5–2.7 s sync defect no
       existing check can see).

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
