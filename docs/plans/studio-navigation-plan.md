# Studio navigation — the scene ↔ film round trip, tabs, and sequence movement

> **Status: PROPOSED 2026-08-05, revised twice same day.** First revision: a
> code review found the round-trip half of the job already half-built — the
> film page has honored `?scene=` / `?sequence=` / `?advice=` deep links since
> v0.23 ([film.js:3750-3761](../../engine/src/studio/public/film.js:3750)), but
> nothing in the Studio ever *sends* one. Second revision, **per the user**:
> this is a *UI refinement* plan, nothing else — earlier drafts imported
> product-strategy framing (competitive positioning, roadmap ranking) that was
> never asked for; it is removed. Market tools appear below only as **UI
> precedent**: how the category solves tabbing and sequence navigation.
>
> Scope: N-1/N-3/N-6 (~2–3 h), N-7 tabs (~½ d), N-8 sequence movement (~1–2 h).
> N-5 remains a real product decision and is **the user's, not taken here**.
>
> **Closed 2026-08-05.** N-1/N-3/N-6/N-7/N-8 shipped code-complete. N-5 was
> then taken by the user as **option (b)**, and moved to its own document:
> [scene-inspector-plan.md](scene-inspector-plan.md), also shipped. The one
> revision that plan made to the recommendation below: fixing the *return*
> edge made the trip cheap but did not remove it, and for a reviewer the trip
> itself is the cost — so (b) was not "optional rather than urgent" after all.

## Why

Motion Studio ships **two documents**, not one app: `/index.html` (the scene
surface) and `/film.html?id=<filmId>` (the film surface). Moving between them
is a hard document navigation, and the edges only point one way:

| edge | how | lands where |
|---|---|---|
| tree film row → film page | `location.href` ([app.js:267](../../engine/src/studio/public/app.js:267)) | `/film.html?id=…` — no scene selected, playhead 0 |
| film page → studio | `←` ([film.html:25](../../engine/src/studio/public/film.html:25)) | `/` — deliberate "leave this film"; fine |
| film inspector → scene page | `open scene ↗`, `target="_blank"` ([film.js:1864](../../engine/src/studio/public/film.js:1864)) | `/?scene=<sceneId>`, honored on boot ([app.js:2805](../../engine/src/studio/public/app.js:2805)) |
| **scene page → the film it belongs to** | **nothing** | — |
| film page ← `&scene=<slug>` deep link | honored on boot ([film.js:3752](../../engine/src/studio/public/film.js:3752)): selects the scene, parks the playhead at its `filmOffset` | **no producer anywhere sends it** |

So the routine act of *checking a scene's config while reviewing a film* is a
one-way door: `open scene ↗`, and the way back is re-finding the film in the
workspace tree. And once there is more than one thing in play — the film plus
two or three scenes being compared — there is no working-set surface at all;
every switch repeats the hunt.

No origin parameter is needed for the return edge: a scene id is
`"<ws>/<film>/<scene>"` and `filmIdOf` already derives the film
([app.js:47](../../engine/src/studio/public/app.js:47)). **The scene page can
always name its film unprompted**, so the edge works for a reload, a bookmark,
and a tree arrival alike.

## UI precedent (what current tools do; reference only)

The category's answer to "container view whose children have deep config"
converged on three mechanisms, usually **combined**:

| mechanism | who | what it gives |
|---|---|---|
| **In-place inspector** — select a child, the right panel repopulates | Final Cut, Premiere (Effect Controls), Resolve | zero-click config for the common case |
| **Tabs** — every opened composition/sequence is a tab in a persistent strip | After Effects comp tabs, Premiere timeline sequence tabs | the *working set*: switch between N things in one click, see what's open |
| **Breadcrumb / visible parent chain** | After Effects (mini-flowchart / comp navigator), Rive | the *hierarchy*: where am I, one click up |
| **Edit-point jumping** — up/down arrows move the playhead cut-to-cut | Premiere, Resolve, Avid | timeline movement at the granularity you edit at, not the frame |

Tabs and breadcrumbs answer different questions (what am I juggling vs. where
am I); AE ships both. The shared principle: **navigation is selection, not
location** — a mode or surface is never a place you can be stranded in.

## Corrections from the code review (recorded so they aren't re-litigated)

- **"The film page accepts `&scene=`" was drafted as new work (old N-2). It
  shipped in v0.23** — [film.js:3750](../../engine/src/studio/public/film.js:3750)
  even says "A deep link from anywhere else in the Studio lands on the exact
  thing." The defect is precisely that nothing else in the Studio ever
  deep-links. N-1's breadcrumb href works today with zero film.js changes.
- **"Delete is one slip from navigate" (old N-4) overstated the risk.** The `✕`
  is hover-revealed ([styles.css:126-131](../../engine/src/studio/public/styles.css:126))
  and `deleteFilm` double-confirms ([app.js:305-309](../../engine/src/studio/public/app.js:305)).
  Slice retired.
- The scene page is **not** undo-less by neglect: its config is a form with an
  explicit `apply`. Out of scope.

## Decisions (settled — do not relitigate in implementation)

| decision | resolution |
|---|---|
| pass origin as `?from=<filmId>` | **rejected** — `filmIdOf(state.sceneId)` already knows; a param would rot on reload |
| single-page app / client router | **rejected** — two documents is fine; tabs and crumbs are links, not a router |
| `open scene ↗` in a new tab | **change to same-tab** once N-1 lands; a plain `<a href>` keeps ctrl/cmd-click |
| film page `←` → `/` | **keep** — reads correctly as "leave this film" once the round trip exists |
| tabs replace the breadcrumb? | **no — both.** Tabs are the working set, the crumb is the hierarchy; AE ships both and they cost nothing together |
| slice numbering | N-2 and N-4 keep their numbers as tombstones; do not renumber |

## Slices

### N-1 — the return edge

`.viewport-head` ([index.html:594](../../engine/src/studio/public/index.html:594))
gains a breadcrumb before `#scene-title`:

```
← SEPHIROTH — ASHES OF THE…  /  06 Nibelheim — Snow and Flame
```

- The film half is a plain `<a href="/film.html?id=<filmId>&scene=<slug>">` —
  the deep link the film page already honors: lands with the scene selected,
  inspector populated, playhead at its `filmOffset`.
- Film id from `filmIdOf(state.sceneId)`; display name from the loaded tree
  (`state.tree.flatMap(w => w.films)`); fall back to the film **slug** when
  the tree has not loaded — never an empty crumb.
- Set in `selectScene` beside the `#scene-title` assignment
  ([app.js:346](../../engine/src/studio/public/app.js:346)); hidden with the
  workbench. CSS ellipsis; full name in `title`.

### N-2 — ~~film page accepts `&scene=`~~ *(already shipped, v0.23 — see corrections)*

### N-3 — `open scene ↗` becomes same-tab

Drop `target="_blank"` at [film.js:1864](../../engine/src/studio/public/film.js:1864).
Depends on N-1; alone it would remove the only existing escape (the old film
tab) without adding the new one.

### N-5 — scene config in the film inspector *(proposed; decision is the user's)*

`renderSceneInspector` ([film.js:1837](../../engine/src/studio/public/film.js:1837))
already shows name / status / video / length / format / offset, holds the
render button, and lists versions. The scene page's five tabs are the same
object's deeper fields.

- **(a) Minimal** — the inspector gains an editable config block (name,
  duration, format). Everything deeper stays on the scene page, now reachable
  *and returnable*.
- **(b) Full** — the five tabs move into the inspector (the Final Cut answer).
  Costs a real inspector redesign (~300px panel). `open scene ↗` then becomes
  the rare escape hatch its arrow promises.

**Recommendation: (a) now; (b) only if the film page becomes the primary human
surface.** N-1/N-3/N-7 make (b) optional rather than urgent.

### N-6 — transport keyboard parity *(small)*

Both pages bind space and ←/→ ([app.js:498](../../engine/src/studio/public/app.js:498),
[film.js:1512](../../engine/src/studio/public/film.js:1512)); the film page
also has Home/End and shift+arrow ×10. Add those two to the scene page.

### N-7 — document tabs: the working set *(the AE comp-tab pattern)*

A slim tab strip shared by **both** documents — the market's answer to
"tabbing between UIs", adapted to a two-document app without introducing a
router:

```
[ ▶ SEPHIROTH — ASHES… ] [ 06 Nibelheim ✕ ] [ 04 Truth ✕ ] [ 11 Final Rev… ✕ ]
```

- **What is a tab:** a film or a scene the user has opened. The Studio home
  (`/`) is *not* a tab — it is reached by the brand mark / `←`, the same way
  AE's project panel is not a comp tab.
- **Mechanics:** one shared `tabs.js` + CSS included by both pages, no build
  step. The working set lives in `localStorage` (`ms.tabs`: array of
  `{kind: 'film'|'scene', id, name}`). On load, each document upserts its own
  entry (freshening `name`) and marks itself active. A tab is a plain link —
  film tabs to `/film.html?id=…`, scene tabs to `/?scene=…` — so ctrl/cmd-click
  and middle-click behave like the browser. `✕` removes an entry; cap the
  strip (~8, evict oldest inactive).
- **Placement:** above `.viewport-head` on the scene page and above the film
  info bar on the film page — one consistent strip position, styled like the
  existing panel tab row ([index.html:615](../../engine/src/studio/public/index.html:615))
  so it reads as the same UI grammar.
- **Why localStorage and not tabs-per-browser-tab:** the strip must survive
  the document swap — that is its entire job. Per-window scoping
  (sessionStorage) would empty it on every navigation.

Builds on nothing but the two deep links that already exist. Independent of
N-1 (crumb = hierarchy, tabs = working set; keep both).

### N-8 — sequence and scene movement on the timeline *(the edit-point pattern)*

The film page's sequences are selectable bands and collapsible tree groups,
but not *navigable*: no zoom-to-sequence, no jump keys — the playhead moves
only by frame (←/→), drag, or click. Two additions, both standard grammar in
Premiere/Resolve/Avid:

1. **Double-click a sequence band (or its tree row) → zoom to fit it**: set
   `pxf` so the band fills the timeline viewport and scroll to its offset.
   Uses the existing `setPxf`/fit machinery ([film.js:2157](../../engine/src/studio/public/film.js:2157)).
   Double-click empty timeline background restores `fit` (whole film).
2. **PageDown / PageUp → playhead to next / previous scene boundary**;
   **shift+PageDown / PageUp → next / previous sequence start.** Boundaries
   from `state.detail.scenes[].filmOffset` — already loaded. Added to the
   existing keydown handler ([film.js:1512](../../engine/src/studio/public/film.js:1512));
   PgUp/PgDn avoids colliding with ←/→ frame-stepping.

This is the granularity a human actually reviews at: cut-to-cut and
movement-to-movement, not frame-by-frame.

## Verification

The studio suites are HTTP-level with no DOM harness; browser-driven
acceptance against `sephiroth-origin-eclipse-mv` (12 scenes, 7 sequences):

1. **Round trip:** film page → select scene 06 → `open scene ↗` (same tab) →
   breadcrumb names the film → click → film page with scene 06 selected,
   playhead at its offset. Screenshot pair.
2. **Crumb on every arrival:** `/?scene=…` cold, reload, tree click; unlisted
   scene, missing folder, unknown `&scene=` slug (ignored silently —
   [film.js:3754](../../engine/src/studio/public/film.js:3754)), tree-not-yet-loaded
   slug fallback.
3. **Tabs:** open film + three scenes → strip shows all four on both surfaces;
   switch via tabs; `✕` removes; survives reload; cap/eviction; ctrl-click
   opens a browser tab without hijack.
4. **Sequence movement:** double-click NIBELHEIM band → those two scenes fill
   the viewport; double-click background → whole film; PgDn steps the playhead
   scene-to-scene, shift+PgDn sequence-to-sequence.
5. **Keyboard parity:** Home/End and shift+arrow on the scene page.

Hard-reload the browser tab before judging — an open tab keeps the old JS.

## Docs (same change, per project rule)

- `docs/user-guide.md` — the breadcrumb, the tab strip, sequence movement, and
  the film page's `scene`/`sequence`/`advice` deep links (currently
  undocumented anywhere).
- `docs/CHANGELOG.md` — entry under Unreleased.
- `docs/architecture.md` — no change unless N-5(b) is taken.

## Non-goals

No SPA rewrite, no client router, no competitive positioning (removed on
revision — this is a UI plan), no J/K/L shuttle, no scene-page undo stack, no
change to the film page's `←`, no tree-row rework (retired), no new
dependency.
