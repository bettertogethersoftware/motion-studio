# Retired plans — no longer valid, and why

Plans that were dropped, superseded, or absorbed — each with the reason, so
they are not re-proposed by a later session that finds the idea attractive.
Full texts: git history — the 2026-07 documents at commit `1f3f9fe` and
earlier, later ones at the commit named in their entry.

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
plans it pointed at (audio-cue and auto-reframe) are indexed in
[TODO.md](TODO.md); the third, image-prep, was retired in its own right —
see below.

## current-todo-2026-08-04.md

Lived for a few hours as a standalone master list before this folder
existed; folded into [TODO.md](TODO.md) the same day. Never committed.

## `prepare_image` — image-prep-plan.md (2026-08-08)

A `prepare_image` MCP tool (autoCrop, keyBackground, fit/cover, pad,
contactSheet, encode) plus picture facts on `probe_asset`, to close the
still-image hole for an MCP-only agent. Prototyped by hand on a 15 s product
spot; the Env-A findings in it are real and were measured. Full text at
`299e848:docs/plans/image-prep-plan.md`.

**Retired because it has no vehicle the boundary allows.** The user deferred
it 2026-08-04, and that deferral was a rejection of the design rather than a
delay: the plan's recommended implementation spawns Python + Pillow behind
`MOTION_STUDIO_PILLOW_PYTHON`, and the generative-boundary rule keeps spawned
external interpreters *outside* the MCP surface — that is agent-side shell
territory. The plan had already rejected both alternatives itself, ImageMagick
because it means building command lines ([architecture.md §9.4](../architecture.md)'s
"a shell wearing a hat") and `sharp` because it is a heavy native npm
dependency. Nothing is left to build it with. Meanwhile the environment it
serves best is already served: every Motion Studio machine carries ImageMagick
at the tools root with a documented wrapper, and the plan's own environment
table calls Env B "mostly redundant". It was also listed as an *active* plan
and parked at the same time, which this resolves.

**What survives.** The measurement half is knowledge-shaped and needs no
Python: still-image facts on `probe_asset` — `width`, `height`, `hasAlpha`,
`contentBox`, `meanLuminance`, `isBlank`. Kept as an engineering-backlog line
in [TODO.md](TODO.md). It answers "where is the content in this frame" and
"how dark is the region under my caption" before a render, which is the part
Env B wanted too.

**Revisit trigger:** the Env-A hard wall — an MCP-only customer who must prep
supplier stills with no shell. Build it then as a tool under
`agent_tool/`, in that folder's contract, and re-derive from the tree rather
than from the retired document.

## U-13 — timeline blocks are reachable (2026-08-08)

The last slice of the accessibility pass approved 2026-08-06: roving
`tabindex` per timeline lane, arrow-key movement between blocks and lanes,
`Enter` to select, `aria-label` per block — all inside `baseBlock()`. The
slice stays in [studio-ui-polish-plan.md](studio-ui-polish-plan.md) as the
design record, marked retired.

**Retired because the slice nominated itself and the argument holds.** Its
own last paragraph named it "the most cuttable slice in the document — if
the pass has to shrink, cut this one and keep U-10 through U-12." The missing
piece is *selection* only: once a block is selected the keyboard already
works — `Delete` removes it, `PageUp`/`PageDown` move cut to cut, the
inspector edits every value it exposes — and drag, trim and reorder were
pointer-only by the slice's own scope regardless. So the pass's target
("every surface reachable by keyboard, every control says what it is and
what state it is in") is met for the timeline through the inspector, which
is a keyboard path to the same values. **Remaining from the pass: U-10.**

**Revisit trigger:** someone actually navigating the timeline without a
pointer, or U-10 landing its roving-tabindex helper in `studio-util.js` — a
lane is a one-level tree, so the grammar becomes nearly free once that helper
exists.

## Remotion Studio parity features (2026-08-08)

A feature-by-feature read of the Remotion Studio's documentation against this
tree, prompted by "list the features they have and we don't." Most of the list
is genuinely absent — and should stay absent, because it is built for a
human-in-the-loop product and this one bets the human is *not* in the loop. The
whole class is retired here so it is not re-proposed as a gap.

Retired outright:

- **Zod-schema props + the graphical props editor.** A props form exists so a
  human can vary a video without touching code, and so a non-AI caller can
  render N variants. Here the thing that would fill the form is the AI, which
  already has a wider channel — `write_composition_bundle`, `clone_scene`,
  `update_scene_config` edit anything, not a fixed field set. It also fails the
  moat test in [competitive-position.md](../competitive-position.md): a composed
  stack can do it.
- **Saving edited props back to source, and `visualControl()`** (a widget in the
  UI that rewrites the source line behind it). **This contradicts a settled
  decision rather than merely losing on priority:** the Studio never edits
  production directly — the human's channel is advice, and advice is durable
  evidence (their words, what they were watching, a frame grab, the AI's
  answer). A control that silently rewrites the composition destroys that trail.
- **An embeddable `<Player>`.** That is an embed/SaaS business; the deliverable
  here is a measured file.
- **An in-Studio "Ask AI" chatbot.** The AI is already outside, driving through
  MCP. A second in-app channel bypasses the advice record, and the need behind
  it — "is anyone listening?" — is served by `report_agent_activity`, the
  Explorer's amber pulse and `get_production_status`.
- **Canvas-level direct manipulation** (click-select/move/resize/crop a scene's
  contents, marquee select, layer ordering). A scene's interior is code the AI
  owns. Timeline-level editing is a different matter and is legitimate — it is
  scoped in [studio-ui-polish-plan.md](studio-ui-polish-plan.md), where U-15
  already shipped lane storage, head-trimming and audition.
- **`@remotion/studio`'s scripting API** (`play`/`seek`/`goToComposition`/
  `getStaticFiles`/`writeStaticFile`/…). Those sixteen functions exist because
  Remotion has no agent protocol; MCP is a superset, and the file half is
  already `list_assets` / `write_asset_file` / `sync_shared_files`.
- **Ecosystem packages and Lambda/Cloud Run rendering.** Already-settled
  unwinnable fronts — see `competitive-position.md`'s "Where you cannot win".

Already covered, and mistakenly first read as gaps:

- **Hosting the Studio for a remote viewer** — `MOTION_STUDIO_STUDIO_HOST`
  (v0.26) plus the server-hosted tier in
  [docker-support-plan.md](docker-support-plan.md).
- **`calculateMetadata()`** (a composition computing its own duration from an
  asset) — `footage-scene.js` already derives a scene from a supplied clip's
  real duration, and `probe_asset` supplies the numbers.

**What survives, in Motion Studio's shape** — both moved to
[TODO.md](TODO.md)'s engineering backlog, both measurement-shaped rather than
GUI-shaped:

1. **Asset-duration staleness** — the honest remainder of `calculateMetadata`.
   Not live re-evaluation; a check that a scene's configured duration no longer
   matches the asset it plays, in the `stale_render` / `plan.problems` family.
2. **Declared scene inputs as a *validation* surface** — "this scene needs
   `{headline, logo}`" so `verify_film` can catch a scene wired to a missing
   asset before a render is paid for. The knowledge-shaped half of the props
   idea, without the editor.

**Revisit trigger for the props editor specifically:** a customer wanting
**batch templating** — many videos from one composition and a data file. That is
a different job from the production loop, and it is the only reading under which
a declared input schema earns a GUI. Scoped 2026-08-08 in
[batch-templating-plan.md](batch-templating-plan.md), which ranks the candidate
use cases and keeps the editor retired: even under batch templating the data
channel and the validation surface carry the value, and the form does not.

## C-2 desktop packaging (2026-08-08)

The packaged half of the vendor-boundary plan's Slice C — a bundled Node
executable, a signed Windows installer and an update channel
([the plan](ai-only-desktop-vendor-boundary-plan.md) §8: "Signed Windows
installer and update channel: 3–5 days"; Phase 5's packaging tasks).

**Retired because a settled decision in the same document forbids it.**
§10.7 chose distribution = npm-first via GitHub URL install, tied to
repository access to match the install-on-customer-infrastructure model:
"no public npm publish, no signing, **no installer channel**." §10.2 adds
that the Electron host follows, never leads. It was carried in
[TODO.md](TODO.md) as a remainder for four days while its own plan had
already ruled it out — a contradiction, not a backlog item. What ships in
its place already exists: **Slice C-1**, the unpackaged `desktop/` Electron
viewer host (v0.26.0), plus git clone + `deploy/PROVISION.md` for dev
machines and the GitHub-URL install for embedding.

**Revisit trigger:** distribution stops being tied to repository access — a
customer who can neither clone nor `npm install` from git and needs a signed
installer. That reopens §10.7 first; packaging follows that decision rather
than preceding it. The *other* Slice remainder — treating the pinned browser
and FFmpeg as packs — is unaffected and stays open in [TODO.md](TODO.md).
