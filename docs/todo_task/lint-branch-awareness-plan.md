# Lint defect — `sequence-gap` is branch-blind

> Found the same way as the other entries here: by building two real films
> (`cymatic`, 45 s / 5 scenes and `the-last-difference`, 64 s / 5 scenes) with the
> **recommended** shared-engine film pattern and reading the tool output back.

| # | Defect | Priority | Cost | Consequence |
|---|---|---|---|---|
| 1 | [`sequence-gap` does not know about branches](#1-sequence-gap-does-not-know-about-branches) | **P2** | small | Every scene of a shared-engine film gets a false warning, on the pattern `film-setup.md` tells agents to use |

Nothing here needs a design decision. Defect 1 is a bug against the lint's own
stated intent, not a policy change.

---

## 1. `sequence-gap` does not know about branches

### Symptom

`sync_shared_files` pushes one `composition.js` to four scenes. Three of them
come back with a warning that is false in all three cases:

```
sync_shared_files {
  sourceScene: "cymatic/overture",
  targetScenes: ["cymatic/plate", "cymatic/resonance", "cymatic/field", "cymatic/coda"],
  files: ["composition.js"]
}

→ cymatic/plate      warnings: [{ rule: "sequence-gap", line: 663,
      snippet: "Sequence(96, 144, function (f) {",
      message: "Sequence coverage ends at frame 240 but the composition runs to 320
                — the last 80 frames have no Sequence scheduled." }]
→ cymatic/resonance  (identical)
→ cymatic/field      (identical)
→ cymatic/coda       (no warning — 160 frames, under the gapFrames slack)
```

The two literal `Sequence` calls it found —

```js
function renderOverture(frame, beat, act) {
  Sequence(0, 240, …);        // the overture's waveform
  Sequence(96, 144, …);       // the overture's title
}
```

— are inside `renderOverture`, which is reached only via

```js
if (S.mode === 'overture') renderOverture(frame, beat, act);
else if (S.mode === 'plate') drawPlate(frame, beat, act);
…
```

`cymatic/plate` has `SCENE.mode === 'plate'`. `renderOverture` **never runs
there**, so there is no gap and no dead air. The plate draws unconditionally on
every one of its 320 frames. The warning is reported against a scene where the
code it is describing is unreachable.

### Root cause

`checkSequenceCoverage` — [`engine/src/core/scene.js:450`](../../engine/src/core/scene.js) —
regex-scans the **whole file** for literal `Sequence(int, int` pairs
(`scene.js:454`) and merges them into one coverage interval, with no notion of
which ones can execute together:

```js
const re = /\bSequence\s*\(\s*(\d+)\s*,\s*(\d+)/g;
…
if (calls.length < 2) return [];
```

The tail warning (`scene.js:482`) then compares that single merged interval
against the *scene's* `durationInFrames`, which for a shared engine is a
different number in every scene.

### Why this is a bug and not a rough edge

The function's own doc comment already states the governing principle
(`scene.js:444`):

> Only literal number pairs are considered, and only when there are at least two
> of them — **dynamically computed sequences (variables, arithmetic) make
> coverage unknowable statically** […]

Conditional dispatch is exactly that case. The author already decided not to
warn when coverage is statically unknowable; the implementation simply doesn't
detect this particular way of being unknowable. So the fix restores the stated
intent rather than changing policy.

It also fires specifically on the pattern the docs prescribe —
[`film-setup.md:522`](../film-setup.md) ("**Fixing the shared engine: use
`sync_shared_files`**"), and `SKILL.md`'s "Don't hand-write a composition per
scene. Write **one** shared `composition.js` that reads a per-scene
`window.SCENE` config." An agent that follows the documented advice is
guaranteed to collect these.

**The cost is not the noise.** `SKILL.md` tells agents "treat both warning types
as real bugs unless you are certain the code is deliberate" and lists
`sequence-gap` among the checks that catch what a single-frame preview cannot. A
warning that is *reliably* wrong on the recommended pattern trains agents to
skim past the rule — and the next one may be the 298-frame hole this check was
written for.

### Fix — two options

**A. Branch awareness (principled, recommended).** Treat coverage as unknowable
when the literal `Sequence` calls do not all share one enclosing function body.
Cheapest sufficient approximation: bracket-match each call back to its enclosing
`function`/arrow body; if ≥2 distinct bodies contain literal calls, `return []`.

- Still catches the original failure (siblings inside one `setFrame`).
- Trade-off: a composition that legitimately splits sibling Sequences across two
  unconditionally-called helpers loses the check. Acceptable — that is precisely
  the "unknowable" bucket the comment already carves out, and a false negative
  here is far cheaper than a false positive on the documented pattern.

**B. Scope the check in the sync path (cheap mitigation).** `sync_shared_files`
writes one source to N scenes of differing durations, so a duration-relative
check cannot be meaningful for all of them by construction. Run coverage only
for the source scene, or skip it on sync.

- One-line-ish, kills the exact reported noise.
- Does **not** fix a direct `write_composition_file` of a shared engine into a
  scene whose duration differs from the branch's, which is the same bug.

Prefer **A**; **B** alone leaves the defect reachable.

### Test

Add to `engine/test/core.test.js` beside the existing `sequence-gap` cases:

1. **No warning across branches.** Source with `Sequence(0,240)` and
   `Sequence(96,144)` inside `renderA()`, plus a `renderB()` with none, dispatched
   by `if (S.mode === …)`; checked against `durationInFrames: 320` → `[]`.
2. **Regression guard.** Two sibling literal Sequences in one `setFrame` body
   leaving a 298-frame hole against a long duration → still warns. This is the
   real-world failure named in the doc comment and must not be lost to fix 1.

### Docs to update in the same change

Per `CLAUDE.md` ("Always update the docs as part of the change"):

- [`frame-api.md`](../frame-api.md) and [`mcp-setup.md`](../mcp-setup.md) —
  wherever `sequence-gap` is specified, state that coverage is not checked when
  the calls span branches.
- [`SKILL.md`](../SKILL.md) / [`SKILL-shell.md`](../SKILL-shell.md) — the
  "treat every warning as a real bug" instruction is correct and should stay;
  it just needs to stop being contradicted by the shared-engine pattern.
- [`CHANGELOG.md`](../CHANGELOG.md).

---

## Corroborations — already filed, reproduced independently

Neither is new. Recording that a second, unrelated pair of films hit them, since
both plans were written off a single Env B film.

- **`audioTargetPeakDb` unreachable** — [`mcp-defects-plan.md` defect 1](mcp-defects-plan.md#1-nullable-erases-the-parameter-type).
  Reproduced exactly as documented, on **both** entry points, from an MCP client
  unrelated to the one that originally found it:

  ```
  build_film  { film: "cymatic", audioTargetPeakDb: -2 }
  update_film { film: "cymatic", audioTargetPeakDb: -2 }
    → Expected number, received string   path: ["audioTargetPeakDb"]
  ```

  Confirms the `.nullable()` diagnosis is client-independent. Worked around by
  measuring with `preview_audio` and applying one uniform `gainDb` offset to every
  track (−9.16 → −2.16 dBFS with +7 dB on both), which preserves the balance —
  i.e. by hand-rolling exactly what the parameter is for. `gainDb` is typed
  `z.number()` and works, so the workaround is reliable; the P1 stands.

- **The agent cannot see its own deliverable** — [`render-review-plan.md`](render-review-plan.md).
  Both films were verified only by shelling out to `ffprobe` for frame count and
  stream duration. `build_film` reported `audio: { peakDb, clipping }` and nothing
  about the picture. **In Env A neither film could have been verified at all** —
  every image-returning tool points at the composition, not the built file. Direct
  support for plan 5's framing.

---

## Not Motion Studio bugs — recorded so nobody chases them

Two failures in the same sessions looked like engine faults and were not. Both
were in composition code, and both are already fixed in the two films.

- **Grains flung off the plate.** A composition helper wrote its solved position
  into the same scratch array `psiAt` uses for its gradient out-param, so the
  caller read a gradient as a position. Rendered clean and empty — a plate that
  looked like a design choice. Author error; the frame API behaved correctly.
- **A marker that never revealed.** A log-time playhead stopped exactly at the
  exponent of its final label, and labels revealed on `playhead − label`, so the
  last one was permanently at zero opacity. Author error.

Both are worth remembering as evidence for [`render-review-plan.md`](render-review-plan.md)
rather than as defects: neither raised a warning, neither failed a render, and
both were caught only by looking at `capture_preview_frames` output with the
brief in mind. Nothing in the toolchain could have caught either — but nothing in
the toolchain could have caught them *in the built film* either, which is the gap.
