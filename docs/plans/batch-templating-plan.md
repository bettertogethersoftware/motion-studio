# Batch templating — one composition, many deliverables

> **Status: PROPOSED (2026-08-08), and deliberately gated.** Slice 0 is an
> example and can ship on its own merit. Slices 1–3 are the engine work and
> should not start without a named use case from the ranked list in §2 —
> the whole idea arrived as the *revisit trigger* of a retired plan
> ([retired.md](retired.md), "Remotion Studio parity features"), not as a
> customer request. Estimate: 0.5 d for Slice 0, ~4 d for Slices 1–3,
> ~1 d for the optional Slice 4.

## 1. Decision

Batch templating is **one composition rendered N times against N data rows**.
The retired Remotion-parity read concluded that a graphical props editor has no
place here — the party that would fill the form is the AI, and the AI edits
compositions directly. This plan is what survives that conclusion: the *data
channel* and the *validation surface*, with no editor.

The shape follows §2.1's frame-geometry precedent exactly, because it is the
same problem: **the engine states something about this render, before the
document parses, identically in preview / still / proxy / full / parallel
worker.** Geometry got CSS custom properties; a data row gets one frozen
object. A composition that ignores it renders exactly as before.

What this is **not**: `clone_scene`. Cloning is for rows that differ in *code*.
This is for rows that differ only in *values*, where N copies of the source is
the wrong answer — it multiplies the thing that can drift and leaves nothing
able to say which row produced which file.

## 2. The ranked use cases

Ranked for *this* product, against four questions: does it need cloud fan-out
volume (if yes, we lose — see [competitive-position.md](../competitive-position.md));
does it exercise whole-film ownership and measurement (the moat); does it sit in
the offline/data-residency segment (Tier 3); can an agent run it unattended.

| # | Use case | Volume/run | Verdict |
|---|---|---|---|
| **1** | **Localized variants of one film** — same edit, narration and captions per language | 5–30 | **The flagship. Build against this.** |
| 2 | Recurring per-client / per-region report videos from private data | 10–50 | Strong second; the simplest honest acceptance case |
| 3 | Product/catalog spots from a feed, with aspect variants | 100s | Good commercial pull, grazes cloud scale |
| 4 | Event / attendee / certificate videos | 100s, bursty | Works, but exercises nothing we are good at |
| 5 | Personalized sales outbound (name + company + logo) | 1,000s | **Explicitly not the target** |
| 6 | Per-track music visualizers, UGC creator templates | varies | Not templating — plate/GPU territory, already `plateforge` |

**Why #1 wins.** Every other row on that list is a *text swap*: the layout is
fixed, only the strings change, and any tool with a template engine does it. A
language variant changes the one thing a template engine cannot absorb — **the
timing**. German narration runs longer than English; the scene it sits under has
to grow, the scenes after it move, the captions re-derive, the music bed
re-fits, and the mix has to be re-measured because a longer bed overlaps
differently. That is precisely the class of failure `competitive-position.md`
names as unreachable for an assembled stack: *no single piece owns the whole
film, so no piece can check the whole film.* `synthesize_speech` returns
frame-accurate per-sentence timings, `preview_audio` measures the mix,
`plan.problems` catches the scenes that no longer fit. A batch of five locales
is a batch where **four of them are wrong in a way only this engine can see** —
and it is 5–30 renders, not 10,000, so local rendering is the right size rather
than a handicap.

**Why #5 loses**, despite being the use case Remotion is famous for: it is a
volume-and-distribution problem (Lambda fan-out plus a hosting/tracking story),
both of which are settled no's. Competing there means competing on their turf
with our weakest hand.

## 3. Non-goals

- **No props GUI, no `visualControl`, no save-back-to-source.** Retired, with
  reasons, in [retired.md](retired.md). The human's channel stays advice.
- **No CSV/XLSX parsing in the engine.** The agent (or an `agent_tool/`) hands
  over JSON rows. Parsing other people's spreadsheet dialects is not an engine
  responsibility and would be the first of a hundred formats.
- **No cloud fan-out.** A batch is a render group on this machine.
- **No per-row code.** That is `clone_scene`, and it already exists.
- **No runtime fetching by the composition.** Data arrives injected before
  parse, or it does not arrive; a composition that fetches its own data breaks
  frame purity and parallel rendering.

## 4. Slices

### Slice 0 — the example, with no engine change (0.5 d)

**`examples/batch-card/`** — the pattern working today, using only what ships.

```text
examples/batch-card/
  README.md              the pattern, its ceiling, and what Slice 1 fixes
  composition.html/js/css  reads MotionStudio.data() with a documented fallback
  scene.json
  frame-api.js
  rows.json              three rows (the data an agent would hand over)
  render-batch.mjs       stage a row → render → collect, one row at a time
```

`render-batch.mjs` copies the scene folder into `out/rows/<id>/`, writes that
row's `data.json` beside it, renders through `src/cli/render.js`, and collects
the outputs with a small manifest. It must run on a clean checkout with no MCP
server and no engine change.

**The README states the ceiling honestly**, because that is what makes this an
argument rather than a workaround: N copies of the source exist while the batch
runs; nothing in the render record says which row made which file; a re-render
cannot prove it used the same row; and the copy step is pure overhead. Slices
1–3 remove exactly those four.

*Acceptance:* three rows render to three distinct, correct files from one
source folder; the README's ceiling paragraph names all four limitations.

### Slice 1 — the data channel (1.5 d)

One frozen object, injected before the document parses, in **every** path.

- `renderComposition`/`renderParallel`/still/proxy/preview accept `data`
  (a plain JSON object), alongside the existing `cssVariables`.
- Injection rides the seam that already exists —
  [browser.js:164](../../engine/src/core/browser.js:164)'s
  `openPage({ cssVariables })` / `evaluateOnNewDocument` — setting
  `window.__MOTION_STUDIO_DATA__`.
- Frame API **v1.7**: `MotionStudio.data()` returns the object, or `{}` when
  nothing was injected, documented in [frame-api.md](../frame-api.md).
- CLI: `--data <file.json>`.
- Studio preview passes the scene's committed `data.json` when one exists, so
  the human sees what the agent rendered.

**The load-bearing part is the parallel path.** Workers are separate processes
([renderer.js](../../engine/src/core/renderer.js) `renderParallel`), so the row
has to reach each worker's argv/env and be re-injected there. A row that reaches
the serial path and not the workers is worse than no feature: the draft is right
and the delivery is wrong.

**Known interaction — BUG-1.** A scene's `frame-api.js` is vendored at creation,
so `MotionStudio.data()` is absent in every scene made before v1.7
([TODO.md](TODO.md)). Slice 1 must either land with BUG-1's fix (2) or state the
version requirement in the tool error, not fail with `undefined is not a
function`.

*Acceptance:* one scene folder, three rows, three correct outputs, no copies on
disk; the same row rendered serially and with `--workers 3` is frame-identical;
a proxy draft and the final agree on layout.

### Slice 2 — declared inputs, as validation only (1 d)

`scene.json` gains `inputs` — names, types, `required`, defaults. `validateConfig`
checks the declaration's shape; the render path checks the *row* against it and
**fails before the browser opens**, with the missing field named. Missing assets
referenced by a row are caught here too.

No form is generated from this. Its consumer is `verify_film` (Tier 2 item 6 in
`competitive-position.md`) and `plan.problems`: a film whose scenes declare their
inputs is a film that can be checked for a broken row before a batch is paid for.

*Acceptance:* a row missing a required input fails in under a second with the
field named; a film with one under-supplied scene reports it in `plan.problems`
rather than rendering N bad deliverables.

### Slice 3 — the row is part of the render's identity (1 d)

The moat slice. A stable hash of the row is written into the render record and
the delivery manifest, and joins the staleness rule: a scene rendered from row
`v1` whose row is now `v2` is **stale**, exactly as a config change makes it
stale today.

This is the claim no assembled stack can make: *this file was made from this
data, and the data has not changed since.* For use case #2 (recurring reports on
private data) it is the difference between a batch and an auditable batch.

*Acceptance:* changing one field of one row marks exactly that scene stale;
`list_deliveries` shows the row hash per delivery; an unchanged re-run of the
batch is a no-op.

### Slice 4 — `render_batch` (1 d, optional, customer-gated)

One MCP call: composition + rows → a render group, per-row result rows, resume
on re-run. It is a convenience over Slices 1–3, and until a real batch is being
run repeatedly, the agent loop plus `render_group` covers it. **Do not build
this first**; it is the part that looks like the feature and contains none of
the value.

## 5. Acceptance for the flagship (use case #1)

One film, three locales, run end to end by an agent with no human approval:

1. Rows carry the locale, its script, and its voice.
2. Narration is synthesized per locale through `synthesize_speech`; the measured
   timings — not an assumption — set each scene's duration.
3. Captions re-derive per locale; the timeline re-flows; the mix is re-measured
   and `balanceWarnings` is clean.
4. All three build, and each delivery records its row hash (Slice 3).
5. **The negative case is the real test:** a locale whose narration overruns its
   scene must be reported by `plan.problems` *before* the build, not discovered
   in the file.

Use case #2 is the smaller acceptance case worth running first — it exercises
Slices 1–3 with no TTS in the loop.

## 6. Risks

- **Scene-level vs film-level data.** A film is N scenes; a locale row belongs to
  the *film* and must fan out. Decide before Slice 1: film-level row, scenes read
  from it. Getting this wrong means retrofitting every caller.
- **Frame purity.** Injection before parse is not a convenience, it is the
  contract. Any path that lets a composition fetch its row at runtime must be
  refused in review.
- **Scope creep toward the editor.** `inputs` (Slice 2) is one short step from a
  generated form, and the form is retired. If a slice starts describing widgets,
  it has left this plan.
- **Volume honesty.** Nothing here makes rendering faster. A 500-row batch is 500
  local renders; say so rather than letting a data channel imply scale.

## 7. Ordering

Slice 0 stands alone and is worth shipping regardless — it documents a pattern
agents will otherwise reinvent badly, in the folder where patterns live. Slices
1–3 wait for a named use case. Slice 4 waits for that use case to repeat.

Related: [retired.md](retired.md) (why the editor half is retired),
[competitive-position.md](../competitive-position.md) (the moat test each slice
is scored against), [frame-api.md](../frame-api.md) (v1.7 surface),
[TODO.md](TODO.md) (BUG-1, `verify_film`).
