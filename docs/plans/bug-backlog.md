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

**Open: BUG-3.** BUG-1 and BUG-4 were fixed 2026-08-08, BUG-2 on 2026-08-06;
all are kept below with the fix noted, because the evidence is the useful part.

---

## BUG-1 — a scene's vendored `frame-api.js` is frozen at creation — **FIXED 2026-08-08**

> Fixed by taking **both** candidate fixes below, which turned out to be one
> function rather than two: `ensureSceneRuntime(scenePath)` in
> `core/scene.js` compares the scene's copy with the engine's and rewrites it
> when they differ (or when it is missing entirely). It is called once per
> render and once per preview batch — before the page opens, never inside the
> frame loop — and once by `cloneScene` after its tree walk, so a clone is born
> current instead of inheriting its source's copy.
>
> The three properties the report demanded are each pinned by a test: it writes
> `frame-api.js` and nothing else (the author's `composition.js` and a pinned
> `three.min.js` beside it are asserted untouched), it is silent when the copy
> is already current, and it returns `{refreshed:false}` rather than writing.
> Fix (3), reporting the mismatch, was not needed once the mismatch stopped
> existing. Tests: `clone-scene.test.js` (3), `frame-geometry.test.js` (2).
>
> Everything below is the original report, kept because it is the evidence.

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

## BUG-3 — the film page is editable before it has loaded

**Found** 2026-08-06, by a Puppeteer probe racing the film document's boot while
verifying the tab-close flush (U-4). **Severity:** low — a narrow window, and
the page recovers. **Area:** `engine/src/studio/public/film.js`.

### What is wrong

`StudioUtil.registerDocument(filmDoc)` runs at film.js top level. The async boot
that actually loads the film — `await refresh()` — runs *after* it, in the IIFE
at the foot of the file. Between those two moments the document is fully wired:
`#film-name` is in the DOM, its `change` listener is attached, and `StudioDoc`
answers to the shell. What is missing is `state.film`, which is still `null`.

Anything that calls `mutate()` in that window throws in `snapshot()`:

```js
// engine/src/studio/public/film.js — snapshot()
EDITABLE.map((k) => [k, state.film[k]])   // state.film is null
```

### Evidence

Driving the real page in headless Chromium: open a film as a document, wait only
until `StudioDoc` exists, set `#film-name` and dispatch `change`. Console:

```
[pageerror] Cannot read properties of null (reading 'name')  film.js:184:89
```

`#save-state` stays `saved`, the keystroke is discarded, and nothing tells the
human. Reproduced identically on `f58f295` and on the working tree, so it is not
a regression from the v0.27 shell — it has been there since the field was
wired.

### Who is bitten

A human who types into the film name in the moment after the tab paints and
before the film resolves. On a warm local film that window is tens of
milliseconds and effectively unreachable; on a cold start, a large film, or a
slow disk it is long enough to lose a keystroke — and the failure mode is a
silent no-op plus a console error, not a message.

### Workaround

Retype it. The page is fine afterwards; only edits made during the window are
lost.

### Candidate fixes

1. **Disable the controls until the film resolves (preferred).** The boot
   already replaces the whole body on a load *failure*; the same gate can mark
   the document busy until `refresh()` lands. Honest, and it also covers the
   other inputs, not just the name.
2. **Guard `mutate()`.** `if (!state.film) return;` — one line, stops the throw,
   but keeps silently discarding the edit, which is the part that actually hurts.
3. **Register the document after the boot.** Smallest-looking and wrong: the
   shell wants `StudioDoc` early so a tab can show its title and status while
   the film is still loading.

Take (1). (2) is worth having underneath it regardless — a null-guard on the
single function every edit funnels through is cheap insurance.

---

## BUG-4 — `computeFit` throws on a film document that is closing — **FIXED 2026-08-08**

> Fix (1), the guard, taken with U-10 since it is a console error in the same
> document: `const sc = $('#tl-scroll'); if (!sc) return;`. A document with no
> timeline has no fit to compute. Fix (2) — disconnecting the observer on
> teardown — is still not worth it on its own: the shell removes the frame
> without waiting on anything but the save flush, so the guard is needed
> underneath either way.

**Found** 2026-08-06, in the control run for the Explorer-standing change (the
same error appears on unmodified `master`, so it predates it). **Severity:**
low — cosmetic, one console error per closing document. **Area:**
`engine/src/studio/public/film.js`.

### What is wrong

`computeFit` reads `$('#tl-scroll').clientWidth` with no null guard
(`film.js:2392`), and its `ResizeObserver` (`film.js:2462`) can fire while the
film document's iframe is being torn down — the element is gone, the callback
is not:

```
TypeError: Cannot read properties of null (reading 'clientWidth')
    at computeFit (http://localhost:7345/film.js:2392)
    at <anonymous> (http://localhost:7345/film.js:2462)
```

### Evidence

Headless Chromium against the running Studio: open two films from the Explorer,
then open a scene. One error per teardown, reproduced on both the working tree
and a `git checkout --` control of `film.js` at HEAD (line 2377 there — the same
function before later edits moved it).

### Who is bitten

Nobody functionally: the observer's next firing works, and the fit is
recomputed when the document is shown. It costs a red line in the console that
a real error then has to be found among.

### Candidate fixes

1. **Guard the read** — `const sc = $('#tl-scroll'); if (!sc) return;`. One
   line, and correct: a document with no timeline has no fit to compute.
2. **Disconnect the observer on teardown**, in the `closing()` hook the shell
   already calls. Tidier in principle, but the shell removes the frame without
   waiting on anything but the save flush, so (1) is still needed underneath.

Take (1).

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
