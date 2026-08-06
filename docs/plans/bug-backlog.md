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

## BUG-2 — every film with footage reports a phantom scene called `undefined`

**Found** 2026-08-06 while building the command palette; **re-found and
measured** 2026-08-06 in the Explorer tree. Recorded in
[CHANGELOG.md](../CHANGELOG.md) and [architecture.md](../architecture.md) as
"filed separately" — this is that filing. **Severity:** medium — cosmetic in
the Studio, but it puts a non-existent scene into the structured JSON an agent
reads. **Area:** `engine/src/core/store.js`.

### What is wrong

`listScenes()` maps **every** play-order entry through its scene describer:

```js
// engine/src/core/store.js:715
for (const s of film.scenes ?? []) out.push(await describe(s.slug, false));
```

A film's play order holds scenes *and* footage segments, and a footage segment
has no `slug` — it is a supplied file, not a scene folder. So
`describe(undefined, false)` builds `id: "<film>/undefined"`, fails to read a
config at that path,
and falls into its catch (`store.js:712`), which returns
`{ ...base, name: slug, missing: true }` — with `slug` undefined. **One phantom
row per footage clip**, named nothing, flagged as a missing scene.

`isFootage` already exists for exactly this distinction
(`engine/src/core/film.js:268`, keyed on the tagged `kind` rather than on the
absence of a field).

### Evidence

Measured live in the Studio on 2026-08-06. Expanding
`default/harmonia-everdark-short` in the Explorer renders a row with an empty
name, the meta tag `missing`, and a `title` of
`default/harmonia-everdark-short/undefined`.

Three consumers, three different behaviours — which is why it survived:

| consumer | what it does | result |
|---|---|---|
| `palette.js:136` | skips rows that are `missing` **or** nameless | correct, and deliberate |
| film page | its unlisted-scene filter also happens to hold `undefined` | hidden **by accident** |
| Explorer tree (`app.js:206`) | renders whatever `sceneFolders` contains | **shows the ghost** |
| MCP `workspace-manifest` resource (`mcp/server.js:4552`) | pushes every row into the manifest | emits `{ scene: "undefined", slug: undefined, missing: true }` |

The last row is the one that matters. The Studio symptom is a dead row a human
ignores; the manifest is what an agent reads to learn what exists, and it is
being told a scene is there.

### Who is bitten

An agent listing a film that contains footage — every music video in this
workspace that cuts supplied clips against rendered scenes. It sees a scene it
cannot open, cannot render, and cannot delete, with no name to reason about. A
diligent agent may try to repair the "missing" scene it was just told about.
The human sees a nameless row in the Explorer and learns to distrust the tree.

### Workaround

None needed by a human — ignore the row. There is none for an agent short of
filtering `slug == null` at every call site, which is the bug restated.

### Candidate fixes

1. **Skip non-scene entries at the source (preferred).** Guard the loop with
   the existing `isFootage`, so `listScenes` returns scenes.
   One line, and it fixes all four consumers at once. The check to run first:
   `listScenes` also reconciles against folders on disk, so confirm a footage
   segment cannot own a `scenes/<slug>/` folder that the on-disk pass would then
   report as `unlisted`.
2. **Describe footage honestly instead of skipping it.** Return a tagged
   `{ kind: 'footage', … }` row so a caller can see the whole play order from
   one call. Larger, and it changes the shape of `sceneFolders` for the Studio
   film page as well as the manifest — a design change, not a fix. If this is
   ever wanted it should leave this file and become a plan.
3. **Guard each consumer.** What the palette already does. It is what the
   codebase is doing today by accident, and it is why the defect reached four
   surfaces with three different behaviours.

Take (1). The Explorer also grows its own guard as
[studio-ui-polish-plan.md](studio-ui-polish-plan.md) **U-8**, which is correct
independently — it is the Explorer's job to skip nameless rows whatever the
engine hands it — and stays correct after (1) lands, at which point it simply
never fires.

### Not this bug

Genuinely **missing** scenes — a play-order entry whose folder was deleted out
from under the film — must keep being reported. That row is information, and
`describe()`'s catch is the right behaviour for it. The defect is only that an
entry which was never a scene takes the same path.
