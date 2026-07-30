# Planned work — real footage in Motion Studio films

> **Plans 0–5 and the associated defect follow-ons have shipped (unreleased).**
> Every design record now lives in [`task_completed/`](../task_completed/), each
> carrying its own completion note. This file preserves
> the reasoning that ordered them, the two environments they were scoped against,
> and the acceptance test — now met: an MCP-only agent can conform a supplied clip
> to a film, place it on the timeline beside rendered scenes, build the result, and
> inspect/measure the delivered picture.
>
> **The follow-ons below are complete.** They were all found the same way — by
> building a real film and reading the result back:
>
> - **[render-review-plan.md](../task_completed/render-review-plan.md)** — `inspect_render` now
>   returns encoded-file frames, and `measure_render` reports delivered-picture
>   facts; R§4's optional cloud vendor is explicitly out of scope.
> - [film-colour-plan.md](../task_completed/film-colour-plan.md) — final renders state BT.709/sRGB
>   colour, and `matchFilm` converts footage to that contract.
> - [mcp-defects-plan.md](../task_completed/mcp-defects-plan.md) — all five MCP defects are fixed.
> - [lint-branch-awareness-plan.md](../task_completed/lint-branch-awareness-plan.md) — shared-engine
>   branches no longer trigger a false `sequence-gap` warning.

**What comes after these plans** —
[source-of-truth-production-workflow-todo-2026-07-29.md](source-of-truth-production-workflow-todo-2026-07-29.md)
is the current backlog: an atomic staging → validate → promote delivery path, a
persisted review artefact, aspect deliverable variants, and reusable template /
media libraries. It was found the same way plans 4 and 5 were — by building real
films and reading the result back — and it supersedes the overlapping half of
[prioritized-codebase-todo-2026-07-29.md](prioritized-codebase-todo-2026-07-29.md).

> **Three plans sit behind that backlog**, all found the same way — by building
> real films (a product spot from supplier photos, a narrated 15 s cut, a 9:16
> variant of a two-shot) and measuring the result:
>
> - **[audio-cue-plan.md](audio-cue-plan.md)** — frame-granular envelope and
>   emphasis onsets. **Take this one first.** It is the smallest, both signals
>   already exist at the wrong granularity or on the wrong path, and it caught a
>   real sync defect: hand-typed stat cards appeared 1.5–2.7 s *before* the voice
>   named them, which no existing check can see.
> - **[auto-reframe-plan.md](auto-reframe-plan.md)** — `measure_reframe`, the hard
>   half of aspect deliverable variants. `transcode_asset`'s `crop` is a constant,
>   so Env A can only centre-crop; a per-frame argmax strobes on 349 of 955 frame
>   pairs, so the crop *path* is the feature. Reuses `render-review`'s existing
>   rawvideo sampling — no new dependency.
> - **[image-prep-plan.md](image-prep-plan.md)** — `prepare_image`, the still-image
>   hole: `transcode_asset` has `video`, `audio` and `frames` modes and no `image`
>   mode, so an Env A agent cannot crop, key or even *measure* a supplied photo.
>
> All three are queued below the backlog above, and the last two are
> capability-shaped — see [the rule](#the-rule-this-implies) — so Env B already has
> better tools for them. The audio-cue plan is the exception: it is knowledge, and
> Env B needs it as much as Env A.

> For **why these are ordered the way they are** against the alternatives — and
> which fronts are deliberately being conceded — see
> [competitive-position.md](../competitive-position.md). It scores this product
> against Remotion, Motion Canvas, Revideo and the generative models, and argues
> that plan 5 plus the defect list is what changes the ranking.

Five plans, in ship order. They exist because of one observation: a film built
from a person's own recording is the thing users most want, and the thing this
product currently handles worst.

| # | Plan | Cost | Unblocks |
|---|---|---|---|
| 0 | ~~film signature~~ — **SHIPPED**, see [task_completed/film-signature-plan.md](../task_completed/film-signature-plan.md) | hours | correctness, both environments ✔ |
| 1 | ~~`transcribe_asset`~~ — **SHIPPED**, see [task_completed/transcribe-asset-plan.md](../task_completed/transcribe-asset-plan.md) | small | reading supplied speech ✔ |
| 2 | ~~footage segments~~ — **SHIPPED**, see [task_completed/footage-segment-plan.md](../task_completed/footage-segment-plan.md) | medium | **the whole use case** ✔ |
| 3 | ~~`transcode_asset`~~ — **SHIPPED**, see [task_completed/transcode-asset-plan.md](../task_completed/transcode-asset-plan.md) | medium | Env A parity ✔ |
| 4 | ~~[film colour](../task_completed/film-colour-plan.md)~~ — **SHIPPED** | medium | conformed footage matching on colour too ✔ |
| 5 | ~~[render review](../task_completed/render-review-plan.md)~~ — **SHIPPED** (R§1–R§3) | small → medium | **the agent verifying its own work** ✔ |
| — | ~~[MCP surface defects](../task_completed/mcp-defects-plan.md)~~ — **FIXED** | small each | not a plan; correctness repairs ✔ |
| — | ~~[`sequence-gap` branch blindness](../task_completed/lint-branch-awareness-plan.md)~~ — **FIXED** | small | documented shared-engine pattern ✔ |

Plan 4 was not foreseen when plans 0–3 were ordered; it surfaced from the
acceptance test below actually being run. It is the only one that **changes
rendered pixels**. It now ships with colour in the render sidecar, so an existing
file remains unverified and a re-render under a changed profile is marked stale
rather than silently assembled with current output.

Plan 5 was found the same way plan 4 was, one film later: the acceptance test
below says an agent must be able to *build* the film, and it turns out that is
only half of what a producer does. Plans 0–3 gave the agent the operations. Plan
5 is the first one about giving it back the **result**. `inspect_render` and
`measure_render` complete its local review loop without touching delivered pixels;
the optional cloud review vendor was deliberately not made a requirement.

The defect list is unnumbered on purpose: it is not part of this sequence and
nothing waits on it. It sits here because it was found by the same method — the
acceptance test, run for real, at feature length.

Plan 1 landed first, out of order: it had no dependencies, is the rare plan that
is high-value in **both** environments, and the queue question it shared with plan
3 was answerable on its own (a second job lane — see
[architecture.md §5](../architecture.md#5-jobs-and-the-render-queue)). Its `audio`
extraction turned out not to need plan 3 at all, because ffmpeg is already a
declared prerequisite of the engine.

**Plan 0 shipped next**, as intended: `get_film`'s `plan.signature` now states the
encode contract, including the `ffmpegArgs` the engine's own encoder uses. Both
remaining plans consume it — plan 2 compares probed footage against it, plan 3's
`matchFilm` resolves from it instead of re-deriving the encode table.

## The two environments

Everything in these plans is scoped by which of two environments an agent is in.
Get this wrong and you build either a redundant tool or an unusable one.
**Canonical definition: [agent-environments.md](../agent-environments.md)** —
read it first if the terms are unfamiliar.

| | Capability | Bottleneck | Therefore needs |
|---|---|---|---|
| **Env A** | Motion Studio MCP only. No shell. | **Capability** — whole classes of film are impossible | *breadth*: more operations |
| **Env B** | MCP **+** `ffmpeg` + `whisper.cpp` | **Correctness** — everything is possible, subtle things go silently wrong | *knowledge*: engine invariants stated as data |

### The rule this implies

> **Tools that only report lose to the shell. Tools that report what only the
> engine knows do not.**

`trim`/`crop`/`scale` is **capability** — Env A needs it, Env B will always prefer
ffmpeg, and that is fine. `matchFilm` and the film signature are **knowledge** —
both environments need them, and Env B needs them *more*, because Env B is the one
hand-writing encoder flags against an invariant it cannot see.

Plan 0 exists because it is pure knowledge and costs almost nothing. Plan 3 is
mostly capability, which is why it ships last.

## Acceptance test

> **Env A can reproduce the prototype film.**

The prototype — 65 s cut from a 94 s talk, four spans of the speaker's voice as a
continuous spine, five rendered scenes interleaved with four footage segments,
every audio splice hidden under a graphic, four on-screen labels cued to spoken
words — was built in Env B with 31 shell calls against 17 MCP calls. It is a real
film, so it is a fair test, and it exercises every plan here.

Audited against the current engine plus plans 1 and 3 alone, **Env A still could
not build it**:

| Step | Covered by |
|---|---|
| 16 kHz mono extraction | plan 3 (`audio` mode) — though `transcribe_asset` already does its own, internally |
| Transcript, sentence + word frames | **plan 1 — shipped** |
| Four speech spans trimmed and joined | plan 3 (`audio` mode + `join`) |
| Level / limit / pad to length | film mixer (exists) |
| Music bed | `synthesize_music` (exists) |
| Four footage segments, frame-exact, matched encode | plan 3 + plan 0 |
| Continuous audio spine across the whole film | `film.audio[]` (exists) |
| **Nine-part interleave of footage and scenes** | **plan 2 — shipped** |

That last row is why plan 2 is not a follow-on. `build_film` was never called in
a session that produced a film, because `film.scenes[]` can only hold rendered
scenes — there is no way to say "footage, then a scene, then footage." For Env B
that was an inconvenience routed around with `ffmpeg concat`. For Env A it is a
wall, and no amount of asset tooling gets over it.

## One documented path

Two environments tempt you into two documented workflows — and then
[SKILL.md](../SKILL.md) teaches both, and an agent has to detect which one it is
in before it can start. That is a real tax on the two documents a
knowledge-free agent reads first.

Write **one** path per skill, and choose the skill at install time so no agent
ever has to detect its own environment:
[SKILL.md](../SKILL.md) for Env A, [SKILL-shell.md](../SKILL-shell.md) for Env B.
They overlap only on the authoring contract, which both defer to
[frame-api.md](../frame-api.md); everything else is disjoint.

What must stay true as these plans land: **the MCP path is the one both skills
describe**, and Env B substitutes a shell only where it is strictly better. That
only stays coherent if the MCP tools carry knowledge the shell cannot have —
which is the whole reason plan 0 leads.
