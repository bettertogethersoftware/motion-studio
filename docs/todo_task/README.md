# Planned work — real footage in Motion Studio films

> **Plans 0–3 have shipped (unreleased, v0.22).** The design records live in
> [`task_completed/`](../task_completed/). This file is kept for the reasoning that
> ordered them, the two environments they were scoped against, and the acceptance
> test — which is now met: an MCP-only agent can conform a supplied clip to a film,
> place it on the timeline beside rendered scenes, and build the result losslessly.
>
> **Two follow-ons are open**, both found the same way — by building a real film
> and reading the result back:
>
> - [film-colour-plan.md](film-colour-plan.md) — the film's colour tags are
>   inherited rather than stated, so conformed footage matches the scenes on
>   everything except colour. It is measured and reported (`signature.color`,
>   `signature.matchForLooks`, `probe_asset`'s `video.color`) but not enforced,
>   because a real fix starts at the *render* encode and changes rendered pixels
>   — a decision, not a fix.
> - [mcp-defects-plan.md](mcp-defects-plan.md) — five unrelated defects on the MCP
>   surface, all hit while building one 3:00 Env B film. Two are P1:
>   `audioTargetPeakDb` cannot be called at all (`.nullable()` publishes an empty
>   schema), and `transcribe_asset` runs a `.en` model against a non-English
>   `language` and returns a confident wrong transcript. Unlike the plans below,
>   these are bugs rather than capability — none needs a design decision.

Five plans, in ship order. They exist because of one observation: a film built
from a person's own recording is the thing users most want, and the thing this
product currently handles worst.

| # | Plan | Cost | Unblocks |
|---|---|---|---|
| 0 | ~~film signature~~ — **SHIPPED**, see [task_completed/film-signature-plan.md](../task_completed/film-signature-plan.md) | hours | correctness, both environments ✔ |
| 1 | ~~`transcribe_asset`~~ — **SHIPPED**, see [task_completed/transcribe-asset-plan.md](../task_completed/transcribe-asset-plan.md) | small | reading supplied speech ✔ |
| 2 | ~~footage segments~~ — **SHIPPED**, see [task_completed/footage-segment-plan.md](../task_completed/footage-segment-plan.md) | medium | **the whole use case** ✔ |
| 3 | ~~`transcode_asset`~~ — **SHIPPED**, see [task_completed/transcode-asset-plan.md](../task_completed/transcode-asset-plan.md) | medium | Env A parity ✔ |
| 4 | **[film colour](film-colour-plan.md)** — state it at the render encode | medium | conformed footage matching on colour too |
| — | **[MCP surface defects](mcp-defects-plan.md)** — five bugs, two P1 | small each | not a plan; unblocks nothing, just wrong today |

Plan 4 was not foreseen when plans 0–3 were ordered; it surfaced from the
acceptance test below actually being run. It is the only one that **changes
rendered pixels**, which is why it is filed rather than done — the plans above it
all added capability or knowledge without altering existing output.

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
