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
       font pack later). §10.2/6/7 followed on 2026-08-04 (ComfyUI-style
       desktop viewer, constructor-injected runtime, GitHub-URL install);
       all seven §10 decisions are now made and Slice A is running — see
       the progress ledger below.
2. [ ] **Vendor-boundary plan Slice 0** (footprint + vanilla preflight) —
       **mostly done 2026-08-04**: headless-shell-only browser (−420 MB per
       install) with `MOTION_STUDIO_CHROME` and sidecar recording;
       `npm run fetch-soundfont` (the pack-mechanism pilot); the zero-byte
       per-platform `system` speech backend; capability-tier reporting in
       doctor + `get_capabilities`. Remaining from Phase 0.5: the
       FFmpeg *fetched-pack* chain (resolution chain already exists) and
       treating the pinned browser itself as a pack — both consumers of the
       fetchVerified pack mechanism.
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
- [x] A-4: catalog-driven vendor selection (2026-08-04). Settings stopped
      importing vendor modules (A-4a: structural-only option validation, so
      a newer build's setting survives an older build — with a drift-guard
      test); all three dispatchers rewrote to createXDispatch(catalog) +
      defaultXCatalog() (A-4b/c/d), each landing behavior-identical on the
      first suite run. The catalogs still live beside the dispatchers;
      Phase 2 moves them to vendors/default/.
- [x] A-5: default registry at `engine/src/vendors/default/registry.js`
      (2026-08-04) — thin composition point over the three catalogs, with
      per-capability catalog overrides (the §10.6 seam, tested with a fake
      vendor injected through the real dispatch). Phase 2 moves the
      catalogs into its tree.
- [x] A-6: both entrypoints build the runtime from the registry
      (2026-08-04), dynamically and failure-tolerantly per Phase 4; local
      names preserved so no handler changed. **Phase 1 of Slice A is
      complete.**
- [x] Phase 2 (2026-08-04): P2-a `transcribeMedia` receives the transcription
      dispatch (null → structured TRANSCRIPTION_UNAVAILABLE); P2-b eleven
      modules physically moved into `vendors/default/` and the import-graph
      test polices a real boundary; P2-c the core-only integration test
      (`engine/test/core-only.test.js`) spawns a vendor-less mirror over real
      stdio and passes — it caught a live static-import bug in the MCP server
      on its first run; P2-d settings-schema injection — catalogs declare
      `settingsFields`, the registry exposes `vendorSettingsFields(runtime)`,
      the Studio threads it into `updateSettings`, core keeps a tethered
      literal fallback. **Slice A remainder:** the spessasynth_core
      dependency split, gated on §10.4 / Phase 3 packaging (Slice B).

## Slice B progress (vendor-boundary Phases 3–4; started 2026-08-04)

- [x] B-1 (2026-08-04): the pack mechanism — `core/fetch-verified.js`
      (transport), the versioned manifest `vendors/default/packs.js`
      (soundfont + two whisper model packs, whisper models landing in the
      folder the vendor already searches), `npm run fetch-pack -- <id>` /
      `-- --list` with core-only-tolerant manifest loading;
      `fetch-soundfont` stays as the alias. Pins confirmed by real verified
      downloads. §10.3 and §10.4 decided and recorded.
- [x] B-2 (2026-08-04): the §10.7 GitHub-URL install — root package.json
      wrapper (bins/deps mirrored from engine with a drift test, machine
      state and provider builds excluded), verified by installing the
      packed tarball into a scratch project and driving its MCP server
      over stdio. README documents the install and the consumer-side
      Puppeteer config caveat.
- [x] B-3 (2026-08-04): `get_capabilities` reports a `packs` block — every
      manifest pack with its `installed` state and the fetch command,
      degrading structurally on a core-only install (asserted by the
      core-only test).
- [ ] B-remainder: treating the pinned browser and FFmpeg as packs (the
      Slice 0 Phase 0.5 leftovers — now they have a manifest to live in;
      both need the bootstrap to learn archive extraction first). Phase 4
      itself shipped with Slice A (dynamic tolerant runtime in both
      entrypoints, core-only test, structured unavailables).

## Slice C progress (vendor-boundary Phase 5 / §10.2; started 2026-08-04)

- [x] C-1 (2026-08-04): the unpackaged viewer host — `desktop/` Electron
      shell that spawns the Studio on a real Node (free port, HTTP
      readiness, `studio.log` under user-data, kill-the-tree cleanup,
      sandboxed window). `desktop/smoke.mjs` proves load + cleanup end to
      end (needs a display; not in headless CI). architecture.md §17.
- [ ] C-2: packaging — bundled Node, electron-builder installer, update
      shutdown handling, the packaged-app smoke of plan Phase 6, and the
      §7 acceptance sweep (orphan checks, no-diagnostics-on-stdout).

## Engineering backlog (carried from the retired prioritized todo)

- [x] **Release candidate discipline** — done 2026-08-04: both package
      files bumped to 0.26.0 (drift-guarded by root-package.test), the
      changelog's Unreleased block became the `v0.26` release rollup, and
      [docs/release-checklist.md](../release-checklist.md) is the standing
      list (version ×2, changelog, docs sweep, tool descriptions, skills
      re-copy, entry-file re-emit, migration notes, suite + smokes, tag).
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
