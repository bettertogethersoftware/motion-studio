# Retired plans — no longer valid, and why

Plans that were dropped, superseded, or absorbed — each with the reason, so
they are not re-proposed by a later session that finds the idea attractive.
Full texts: git history at commit `1f3f9fe` and earlier.

## The cut-list layer (first draft of the production-workflow backlog, 2026-07)

Proposed a `cut-list.json` above `film.json` as the editorial source of
truth, plus "layout profiles" and a promotion state machine. **Retired
because it would have made reproducibility worse:** the Studio edits
`film.json` directly, so a document above it desynchronises on the first
timeline drag unless the whole editor is rewritten; and audited against the
tree, roughly half the draft was already shipped (idempotent transcode
sidecars, planFilm validation, single caption record, measured render
review). What survived became
[production-workflow-backlog.md](production-workflow-backlog.md). Lesson:
**audit the tree before proposing a layer.**

## The V2 shot architecture (motion-studio-shot-advice-plan, rev 3, 2026-08-01)

A full Film → Narrative Scene → Shot redesign with atomic shots and an
evidence model. **Retired in favor of its own rework:** the MVP
(sequences + human advice inside the *existing* Film editor) shipped as
v0.23/v0.23.1 and covered the actual need at a fraction of the churn — see
[completed.md](completed.md). The V2 architecture remains a possible future,
but any revival must re-derive from the current tree, not from that document.

## prioritized-codebase-todo-2026-07-29

A P0/P1/P2 backlog reviewed against the 2026-07-29 tree. Fully absorbed:

- **P1-2..P1-5** (vertical deliverables, captions, templates, release
  gates) — superseded the same day by
  [production-workflow-backlog.md](production-workflow-backlog.md) (as its
  P0-3, P1-2, P2-1, P0-2 respectively). Schedule from there.
- **P0-1 (CI gate)** — shipped 2026-08-04 (`.github/workflows/ci.yml`:
  Linux + Windows suites, real-Chromium render, speech round-trip). The
  unshipped remainder (lint/format check, coverage artifacts, required-check
  branch protection) moved to [TODO.md](TODO.md).
- **P0-2 (release candidate)** and **P1-1 (durable jobs)** — still valid;
  moved to [TODO.md](TODO.md).
- **P2-1/P2-2** (coverage + fixtures, contribution contracts) — still valid;
  moved to [TODO.md](TODO.md)'s backlog.

## todo_task/README.md (the real-footage program index)

The narrative that ordered plans 0–5 — environments, the
knowledge-vs-capability rule, the acceptance test. Retired because the
program **completed** (see [completed.md](completed.md)) and its durable
content already lives in canonical places: the rule and Env A/B definitions
in [agent-environments.md](../agent-environments.md), the ordering rationale
in [competitive-position.md](../competitive-position.md). The still-queued
plans it pointed at (audio-cue, auto-reframe, image-prep) are indexed in
[TODO.md](TODO.md).

## current-todo-2026-08-04.md

Lived for a few hours as a standalone master list before this folder
existed; folded into [TODO.md](TODO.md) the same day. Never committed.
