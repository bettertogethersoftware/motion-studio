# Competitive position — how to win, and what to stop trying to win

> **What this is.** A strategy note, written after building two complete films
> through the MCP surface and then researching the alternatives to score them
> honestly ([the review](../data/workspaces/default/films/ms-review), 5:00).
> It is one operator's assessment, not market research — but it is an operator
> who used the product for real work and then read every competitor's own
> documentation.
>
> It sits in `docs/` rather than `todo_task/` because it is not a unit of work.
> It is the reasoning that should **order** the units of work, in the same way
> [agent-environments.md](agent-environments.md) orders them by environment.

## The one-sentence strategy

> **Stop competing on "programmatic video." Compete on being the video engine an
> agent can be trusted to operate alone — and make "trusted" mean something
> measurable that a stack of assembled tools structurally cannot offer.**

Everything below follows from that sentence.

## Where the product actually stands

Scored for one job — an agent producing a finished, structured film with no
human in the loop:

| | score | why |
|---|---|---|
| Remotion + community plugins | **8.4** | ecosystem, cloud scale, and the agent can *watch its own output* |
| **Motion Studio** | **8.0** | best-instrumented, only one that runs offline; cannot review its own work |
| Revideo | 6.2 | drivable and free, agent flies blind |
| Motion Canvas | 4.6 | closed to an agent |
| Generative models | 3.0 | different job entirely |

Second place, by a margin that is **one capability wide**. That is the good news
and it is the whole plan: the gap is not diffuse, it is a single named thing.

## Where you cannot win — stop trying

Being honest about this is worth more than any roadmap item, because each of
these is a place where effort disappears.

| Front | Why it is unwinnable | What happens if you try |
|---|---|---|
| **Ecosystem breadth** | Remotion inherits every React component ever written. There is no amount of work that closes that. | You spend a year building charts and transitions that npm already has, and are still behind. |
| **Cloud scale** | Lambda fan-out is Remotion's home turf and a solved product there. | You build distributed rendering *and* it contradicts the offline identity below. |
| **Generated media quality** | You will not beat a frontier speech lab with a local ONNX voice, or a sample library with a SoundFont. | You sink effort into the one axis where the competitor buys their way past you. |
| **Community size** | Follows ecosystem and time. Cannot be bought. | — |

Note what these have in common: they are all **breadth**. The product's advantages
are all **depth and coherence**. Do not fight a breadth war from a depth position.

## The moat, named

Every competitor's agent story is **assembled**: a CLI, plus a docs skill, plus
five third-party MCP servers, plus four API keys. That assembly is capable — it
scored higher than this product — but it has a structural blind spot:

> **No single piece of an assembled stack owns the whole film, so no piece can
> check the whole film.**

Motion Studio is one process that owns the document, the renderer, the mixer, the
encoder and the tool surface at once. That is why it can already do things the
assembly cannot:

- `plan.signature` — states the encode contract, so supplied footage can be
  checked *before* a build is paid for. A stack of separate tools has no shared
  place for that contract to live.
- `balanceWarnings` — compares each audio track against the ones it overlaps.
  Requires knowing the whole timeline, not one clip.
- `plan.problems` — names every unrendered or stale scene before assembly.
- `stale_render` — knows a scene's output predates its config change.

**This is the test every roadmap item should pass:**

> *Could a composed stack of independent tools do this?*
> If yes, it is table stakes. If no, it is the moat.

Ecosystem items fail this test. Measurement and cross-cutting invariants pass it.

## The action list

Four tiers, in order. Tier 0 and 1 are the ones that change the ranking.

### Tier 0 — Restore the claim you are already making

*Cost: small. Blocks everything else, because the pitch is currently falsifiable.*

1. **Fix the transcription integrity bug first** — before the other four, before
   anything on this page. `transcribe_asset` runs a `.en` model against a
   non-English `language` and returns a confident, well-formed, completely wrong
   transcript **with fabricated timings**. The entire strategy above rests on
   "this tool tells you the truth about your film." One tool that confidently
   lies costs more credibility than five that error out.
   See [mcp-defects-plan.md §2](task_completed/mcp-defects-plan.md).
2. **Fix the other four defects**, especially `audioTargetPeakDb` — a documented
   mastering feature that cannot be called at all. You cannot market
   "best-instrumented" with a broken instrument.
3. **Add the published-contract test** in that same plan. It is six lines and it
   is the thing that stops this class recurring.

### Tier 1 — Close the one gap that loses the comparison

*Cost: small → medium. This is the difference between #2 and #1 on the scorecard.*

4. **Ship [render-review-plan.md](task_completed/render-review-plan.md), parts R§1–R§3.**
   Every image-returning tool points at the *composition*; nothing points at the
   deliverable. It does **not** need a video-understanding model — the agent
   already is one. It needs frames of the rendered file plus the picture analogue
   of `preview_audio`.

   Stated precisely, because the loose version of this claim is wrong: an Env A
   agent cannot see the output at all, and an Env B agent can extract frames with
   a shell but can only afford to look at **~0.3%** of a 5:00 film, and sees
   stills rather than motion either way. So the priority inside the plan is
   **R§2 (measurement) over R§1 (frames)** — `freezedetect` reads all 9,000 frames
   and returns four lines, which is a trade sampling cannot make. See
   [the objection](task_completed/render-review-plan.md#but-a-shell-agent-can-already-just-look-at-the-mp4).

5. **Do not ship R§4 (a cloud review vendor) as the default.** Shipping it first
   would be matching the competitor on their ground and trading away the offline
   identity in Tier 2. Ship it last, off by default, opt-in.

### Tier 2 — Widen the moat, on the axis nobody can copy by assembly

*Cost: medium. This is where the product stops being "a smaller Remotion" and
becomes a different category.*

6. **`verify_film` — one call, every check, one problems list.** Picture, audio,
   captions, assets, signature, staleness, duration. Today an agent has to
   remember six separate calls and know which to make; the SKILL spends a whole
   section on "the five checks nothing else will do for you," which is a
   documentation workaround for a missing tool. Make the checklist executable.
   **A composed stack cannot build this** — nothing in it sees all six domains.

7. **Give the film a stated delivery contract, and check against it.** The film
   document already holds scenes, audio, captions and overlays. Add what the film
   is *for*: target loudness, exact duration, required caption coverage, aspect
   variants. Then `verify_film` measures the film against its own spec.

   The concrete first piece: **EBU R128 loudness normalisation** (`loudnorm`,
   already in the bundled ffmpeg). Every delivery target has a LUFS spec —
   broadcast −23, most platforms −14 — and *nobody in this category does it*.
   It costs one filter and one measurement, it fits the measurement identity
   exactly, and it is immediately citable in a feature comparison. It also
   sidesteps the broken `audioTargetPeakDb`: peak is the wrong target anyway.

8. **Make determinism enforceable, not advisory.** The linter is good and its own
   docs admit an empty `warnings` array proves nothing. Add the checks it cannot
   currently make — a composition with no `Sequence` at all, an element no
   `Sequence` ever turns on, canvas state set and never reset. These are exactly
   the bugs that cost real work in both films, and they are static-analysable.

### Tier 3 — Own the segment the competitor cannot serve

*Cost: mostly documentation and testing. Highest return per hour on this page.*

9. **Make "runs with the wire cut" a first-class, tested, documented mode.**
   Today it is true by accident of architecture. Make it a promise: a CI job that
   runs the full acceptance film with networking disabled, and a doc page for
   regulated environments.

   This is a real, uncontested segment — medical devices, defence, legal,
   government, anyone under a data-residency rule. The competing agent stack
   needs four API keys and ships your client's footage to four third parties.
   That is disqualifying for those buyers, and no amount of Remotion's ecosystem
   fixes it.

10. **Say the licence out loud.** The engine is Unlicense — public domain — against
    a competitor that is free to three people and then $25 per seat per month.
    That is a headline, and it is currently buried in `package.json`.

### Tier 4 — Fix the weakest link cheaply; do not try to win it

*Cost: small, if you resist the urge to build a media lab.*

11. **Deal with `synthesize_sfx` honestly.** It produced cues a paying client
    called "extremely unpleasant… never use those again," and nothing in the
    system flagged it, because nothing measures taste. A generator whose default
    output is unusable is worse than no generator: the agent cannot tell, and
    ships it. Either bundle a small set of real recorded cues, or gate the
    synthetic ones behind an explicit "these are placeholders" warning in the
    tool description. **Do not** invest in better synthesis.

12. **Compete on the vendor chain, not the vendors.** The preference-chain design
    is already good. Better defaults, clearer setup docs, and starred favourites
    surfaced earlier get most of the available win. The frontier voices belong to
    other people; make it trivial to plug them in and stop there.

## Scorecard, with targets

From the review's own published numbers — the point of publishing them was to
make progress checkable:

| | today | after Tier 0+1 | after Tier 2+3 |
|---|---|---|---|
| Overall, agent-run film | 8.0 | **8.6** | **9.0** |
| Instrumentation | 9 | 9 | **10** |
| Generated media quality | 5 | 5 | 6 |
| Ecosystem & scale | 3 | 3 | 3 |

Ecosystem stays at 3 on purpose. That is the strategy working, not failing.

Tier 0+1 alone moves the product past 8.4 and takes first place on the one
scorecard that matters for the category it is trying to define. Everything after
that is widening a lead rather than closing a gap.

## How to know the strategy is working

Not by feature count. By these:

1. **The acceptance film finds its own defects.** Re-run the two films that
   produced these documents; the tooling should surface the reflection slab, the
   overlapping rows and the mis-levelled bed *without a human pointing at them*.
2. **A new agent, given only SKILL.md, ships a correct film first time.** Every
   bug in both films that cost a re-render was a footgun the documentation warned
   about and the tooling did not check. The gap between "documented" and
   "checked" is the product.
3. **Someone chooses it over Remotion for a reason you can quote.** If the reason
   is "it has more features," the strategy failed. If it is "it is the only one
   we can run inside our network" or "it is the only one that told us the mix was
   wrong," it worked.

## What to say no to

Written down so it can be pointed at later:

- A generative video model. Different job; the review says so on camera.
- A component/template library to match React's. Unwinnable, and it fails the
  moat test.
- Distributed cloud rendering. Fights Tier 3 and cedes ground on Remotion's turf.
- A default cloud review vendor. Trades the offline identity for parity.
- Better local TTS or a better synth. Buy it through the vendor chain instead.
