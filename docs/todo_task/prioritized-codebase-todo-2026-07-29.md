# Motion Studio — prioritized codebase TODO

> **P1-2, P1-3, P1-4 and P1-5 are superseded.** They are absorbed by
> [source-of-truth-production-workflow-todo-2026-07-29.md](source-of-truth-production-workflow-todo-2026-07-29.md)
> as P0-3 (deliverable variants), P1-2 (transcript captions), P2-1 (template
> library) and P0-2 (review artefact + promotion gates) — schedule them from
> there, not from here. P0-1 (CI gate), P0-2 (release candidate) and P1-1
> (durable jobs) below are unrelated to that plan and still stand.

Reviewed 2026-07-29 against the current working tree. This is a forward-looking backlog, not a list of test failures: the engine suite completed with **751 passing tests, 3 environment-dependent skips, and 0 failures**. Existing plans in this folder already cover the shipped render-review, colour, lint-awareness, and MCP-defect work, so they are deliberately not duplicated here.

## Priority definitions

| Priority | Meaning |
| --- | --- |
| **P0** | Required before the next release or before relying on the engine in a production workflow. |
| **P1** | High-value product or reliability work for the next development cycle. |
| **P2** | Important hardening and developer-experience work; schedule after P0/P1. |

## P0 — release confidence

### P0-1 — Add a checked-in continuous-integration quality gate

**Why:** `engine/package.json` has a test command, but the repository currently has no checked-in CI workflow, lint/format command, coverage command, or declared Node-version file. A locally passing suite is a good baseline, but it does not stop a platform-specific or Node-version regression from reaching users.

**Scope:** add a GitHub Actions workflow; pin/support the intended Node versions; add linting and formatting checks; run `npm ci`, `npm test`, and the engine doctor in the release matrix. Publish test/coverage reports as build artifacts.

**Done when:** every pull request has a visible required check, failures identify the command to reproduce locally, and Linux/Windows results are reported separately where FFmpeg/Chromium behaviour differs.

### P0-2 — Turn the current v0.22/v0.23 work into a release candidate

**Why:** the package is still versioned `0.21.0`, while the checked-in source and documentation describe later v0.22/v0.23 capabilities (footage/transcode, separate transcription jobs, and output review). That is a release-coordination risk: users, documentation, and package metadata can disagree about what they have installed.

**Scope:** make a release checklist that synchronizes package version, changelog, MCP tool descriptions, skill documentation, migration notes, and test evidence. Keep the change set reviewable by separating implementation, tests, and docs into coherent commits.

**Done when:** a clean checkout reports the same version everywhere, a new user can follow one documented workflow end-to-end, and release notes identify any FFmpeg/Whisper/vendor prerequisites.

## P1 — production workflow improvements

### P1-1 — Make render and transcription jobs durable across a server restart

**Why:** `JobManager` keeps records in an in-memory `Map`, retains only the most recent 20 completed jobs, and stores logs only in process memory. A long render or transcription therefore loses its status and diagnostic trail after an MCP or Studio restart.

**Scope:** persist job metadata, terminal status, logs, and output paths under the workspace; on startup, reconcile unfinished jobs as interrupted rather than silently losing them. Add retention settings and a safe cleanup command.

**Done when:** a user can restart the server, list prior work, see whether a job finished or was interrupted, and open the associated output/log without guessing the path.

### P1-2 — Add a first-class vertical/social deliverable profile

**Why:** film output is configurable by raw width and height, while film captions currently have only `sizePct` and a `top`/`bottom` position. Creating polished TikTok/Shorts versions therefore requires manual layout choices and repeated caption tuning.

**Scope:** introduce named profiles such as `youtube-landscape`, `shorts-vertical`, and `square-social`; include portrait safe zones, caption placement/size defaults, title-safe regions, and preview guides. Let a film derive a deliverable variant without mutating its source timeline.

**Done when:** one film can produce landscape and 9:16 outputs with predictable safe areas, legible captions, and an inspection frame showing that captions do not cover the featured person or product.

### P1-3 — Connect transcript word timings to animated, readable captions

**Why:** transcription already returns sentence and word timings, but a film caption is currently one text block over a frame range and its ASS style is limited to size and top/bottom placement. It cannot create word-following social captions, emphasis, or caption-safe line breaks from the transcript itself.

**Scope:** add an opt-in transcript-to-caption builder with phrase grouping, word-level highlighting, maximum line length, language/font selection, and a caption-review preview. Preserve simple SRT/ASS export for standard workflows.

**Done when:** a transcription can generate a caption track that follows speech word-by-word, has configurable large social styling, and passes a no-overlap/out-of-bounds review check.

### P1-4 — Add reusable animated finishing templates for product promos

**Why:** the finishing graph supports timed overlays, position, scale, and opacity, but not reusable motion presets such as a presenter easing into a corner while a product card zooms/rotates into the center. Those are common, repeated production needs and are currently assembled manually outside the film document.

**Scope:** define a small, versioned template system for lower-thirds, picture-in-picture, product cards, logo endboards, and captions. Templates should expose safe parameters (asset, anchor, duration, easing, scale, and text) rather than arbitrary FFmpeg filters.

**Done when:** a producer can apply a presenter-plus-product template to a film, preview it, and render it consistently across landscape and vertical profiles.

### P1-5 — Make render review actionable with policy-based release gates

**Why:** the renderer now returns useful picture/audio advisories, but the result is still primarily information for the caller to interpret. A production workflow needs a reusable decision such as “warn on black frames at cuts” or “block delivery when captions are out of bounds or music masks dialogue.”

**Scope:** add named review policies with thresholds for black/static frames, cut seams, audio peaks/loudness, caption bounds, and required inspection frames. Store reports beside each output and make `build_film` return a clear pass/warn/fail summary.

**Done when:** a failed production check is reproducible from the saved report, points to frame/timecode, and cannot be mistaken for a successful approved deliverable.

## P2 — hardening and maintainability

### P2-1 — Add test coverage reporting and a small cross-platform media fixture set

**Why:** the suite is broad and passing, but the skipped cases show that media and process behaviour still depends on the host. There is no measured coverage trend or compact, committed fixture suite that proves the supported FFmpeg/Chromium matrix.

**Scope:** collect line/branch coverage, set realistic floors for core validation and MCP boundaries, and add tiny deterministic fixtures for landscape/portrait video, speech, transparency, invalid media, and cancellation/restart recovery.

**Done when:** coverage regressions are visible in CI and platform-specific skips are explicitly classified as expected, quarantined, or fixed.

### P2-2 — Establish repository contribution and support contracts

**Why:** the codebase has extensive in-code and changelog rationale, but no top-level contribution, support, or security policy was found during this review. That makes it harder for outside contributors to know the expected Node/FFmpeg setup, test tiers, and vulnerability-reporting channel.

**Scope:** add concise `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates, and a compatibility table for Node, FFmpeg, Chromium, and optional transcription/music vendors.

**Done when:** a new contributor can set up the engine, run the relevant test tier, and report a security concern without relying on tribal knowledge.

## Suggested delivery order

1. **P0-1** CI gate and **P0-2** release candidate work together.
2. **P1-1** durable jobs, then **P1-5** review gates, to make unattended renders recoverable and auditable.
3. **P1-2** vertical profiles and **P1-3** transcript-driven captions, followed by **P1-4** motion templates for the recurring promo workflow.
4. Schedule the P2 hardening items once the release pipeline is enforcing the baseline.

