# Bug backlog — known defects, not yet fixed

Defects found and understood but deliberately not fixed at the time, with
enough evidence to act on them cold. Distinct from the planning documents
beside it: [TODO.md](TODO.md) orders *work we intend to do*, this file records
*things that are wrong now*. A bug leaves here in one of three ways — fixed
(note the commit and delete the entry), promoted to a plan document when it
turns out to be a design change, or moved to [retired.md](retired.md) with the
reason it will never be fixed.

**Every entry states:** what is wrong, the evidence (a `file:line` or a
measurement, never a suspicion), who is bitten and how badly, the workaround if
one exists, and the candidate fixes with their costs. If an entry cannot carry
evidence it is not a bug report yet — reproduce it first.

---

## BUG-1 — a scene's vendored `frame-api.js` is frozen at creation

**Found** 2026-08-06, while shipping frame API v1.6 (the `--ms-*` frame-geometry
authoring contract). **Severity:** low today, rising with every runtime release.
**Area:** `engine/src/core/scene.js`, `engine/src/core/store.js`.

### What is wrong

Each scene folder holds its **own copy** of the Frame API runtime.
`createScene` copies it once —

```js
// engine/src/core/scene.js:215
await fsp.copyFile(RUNTIME_FRAME_API, path.join(scenePath, 'frame-api.js'));
```

— and nothing ever refreshes it. A scene therefore keeps the runtime version it
was born with, for its whole life, while `engine/src/runtime/frame-api.js`
moves on. `cloneScene` makes it worse rather than better: its single tree walk
copies `frame-api.js` across with everything else
(`engine/src/core/store.js:634`), so cloning a 2026-08-01 scene in 2026-12
produces a brand-new scene running the old runtime.

### Evidence

Measured live in the Studio on 2026-08-06, previewing
`default/same-machine-mv/s01-cell` (a scene created 2026-08-02) against an
engine carrying runtime v1.6:

| read | value |
|---|---|
| `MotionStudio.version` inside the preview iframe | `1.5` |
| `MotionStudio.frameSize` / `safeArea` | `undefined` |
| `--ms-safe-title-left` on the same document | `134px` |

The last row is the important one: the **CSS variables are unaffected**, because
the engine injects them into every page it opens
(`core/browser.js` `openPage`, `core/renderer.js` `compositionVariables()`).
Only the JavaScript helpers are missing.

### Who is bitten

An agent or human authoring in an **existing** scene, who reads
[frame-api.md](../frame-api.md), calls `MotionStudio.safeArea('title')`, and
gets a `TypeError` at frame 0 — from documentation that is correct for the
product and wrong for that folder. The failure is legible (`composition_error`
naming the frame) but the cause is not: nothing in the message says "this scene
carries an older runtime."

The blast radius grows with each runtime version. v1.6 is the first release
where a documented helper is missing from every previously created scene;
v1.4 (`seekVideo`) and v1.5 (`beatGrid`) had the same hole and it simply was not
noticed, because both arrived alongside the films that first used them.

### Workaround

`sync_shared_files { sourceScene: "<a scene created since the bump>",
targetScenes: [...], files: ["frame-api.js"] }` copies a current runtime in.
It works, and it is a workaround, not an answer: it needs a known-good donor
scene, it is per-scene bookkeeping an author should never be doing, and nothing
tells them it is necessary.

### Candidate fixes

1. **Refresh on open (preferred).** Compare the scene's copy with
   `RUNTIME_FRAME_API` — by content hash, or by the `version` in its banner —
   wherever a scene is opened for render or preview, and rewrite it when it is
   older. The runtime is engine-owned and byte-identical across scenes, so
   overwriting it is not an edit to the author's work in the way a composition
   file would be. Watch the two constraints: it must not fire per frame (once
   per render, not once per page), and it must stay silent when the copy is
   already current.
2. **Refresh on clone.** `cloneScene` re-copies `RUNTIME_FRAME_API` after the
   tree walk instead of inheriting the source's. One line, strictly correct —
   the clone is a *new* scene — and it stops the defect propagating even if
   (1) is never built.
3. **Report it, fix it never.** `get_scene`/`doctor` surface
   `runtime: { version, current }` so at least the mismatch is visible. Cheapest,
   and it leaves the author holding the problem.

(2) is worth doing on its own regardless of (1). The trap in (1) is that
`frame-api.js` sits in the scene folder alongside files the author owns; the
refresh must be provably confined to that one engine-owned filename.

### Not this bug

Vendored **3D library** builds (`three.min.js`, `babylon.js` — `core/libraries.js`)
are pinned on purpose and hashed into `libraryBuilds` so a scene records the
exact build it holds. Those must **not** be auto-refreshed; a silent library
upgrade would change rendered pixels. The runtime is different in kind: it is
part of the engine's own contract with the composition, not a third-party
dependency the scene chose.

---

## Fixed

- **BUG-2 — every film with footage reported a phantom scene called
  `undefined`.** `listScenes` walked the whole play order and described footage
  segments, which have no slug, as scenes. Cosmetic in the Explorer, but it
  reached the MCP workspace manifest, so an agent was told a scene existed that
  could not be opened, rendered or deleted. Fixed 2026-08-06 by skipping
  footage at the source, with `isFootageSegment` in `core/films.js` — keyed on
  the stored shape, because `isFootage` in `core/film.js` reads a `kind` tag
  only `planFilm` stamps and is silently false against a film read off disk.
  The same miscount one layer up (`listFilms` calling play-order entries
  "scenes") went with it.
