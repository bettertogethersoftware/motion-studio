# The shell under load — ten tabs, a failing render, and the edit that got away

> **Status: PROPOSED 2026-08-06.** Found by driving the running Studio on
> `:7345` against `default/signal-path` (24 scenes) and
> `default/harmonia-everdark-short`, and by reading the tree. Every claim
> below carries either a `file:line` or a measurement taken in the browser;
> the five reproduced in a running Studio say so in their own slices (U-1,
> U-3, U-8 twice, U-11). Thirteen slices, `U-1`…`U-13`, ~4½ days,
> splittable — the hard chain is only `U-2 → U-3` and `U-1, U-4 → U-5`.
> Follows [studio-shell-plan.md](studio-shell-plan.md), which shipped the surfaces
> this document repairs; supersedes nothing.
>
> **Progress 2026-08-06 — U-1…U-7, U-9, U-11 and U-12 shipped**, U-8 partly,
> plus U-8's engine half via [bug-backlog.md](bug-backlog.md)
> BUG-2. Each was accepted in headless Chromium rather than by reading: U-4
> with a control run that loses the edit once `closing()` is removed, U-6
> against throwaway films checked on disk both ways. Verifying U-4 surfaced
> BUG-3 (the film page is editable before it has loaded), pre-existing and
> filed rather than fixed here.
>
> **U-14 (the Explorer's standing) was added and shipped 2026-08-06** from use
> rather than from the audit — open-vs-active marks, one glyph per row carrying
> both kind and standing (and, on a film, doubling as the twisty), a live tree,
> and one shared production stream. **U-15 (the timeline's lanes and trims)
> followed the same day**, also from use: stored lanes with add/remove/drag,
> the engine's missing head trim, and an audible audio picker.
>
> **Remaining: U-10 (the two trees) and U-13 (timeline blocks) — about 1 day.**
> U-6 closed 2026-08-06: the name dialog moved into `studio-util.js` and builds
> itself per document, film.js's four `prompt()` calls, the withdraw-all
> `confirm()` and scene-panels.js's asset rename all went through it, and
> Studio now contains no native `prompt()` or `confirm()` at all. Accepted in
> headless Chromium against a throwaway store: each dialog raised, cancelled,
> and confirmed, with the result read back off disk — a scene created, a
> cancelled one not created, a sequence in `film.json`, advice withdrawn only
> on confirm, an asset renamed — and both pages armed to throw if any code path
> reached a native dialog.
>
> **Revision 2026-08-06:** the accessibility work was first written here as
> a deferred reminder and is now **approved and scheduled** (U-10…U-13,
> plus the two items cheap enough to fold into U-3 and U-5). Investigating
> it turned up a defect that is not a semantics question at all: the
> command palette drops focus on `<body>` when it closes, so every document
> shortcut is dead until you click. That is U-11.

## Why

The shell that shipped in `22d053f`/`2ddef07` is the right architecture and
it is correct for the case it was built against: **one or two documents,
in the foreground, on a healthy film.** Every acceptance run in
[studio-shell-plan.md](studio-shell-plan.md) is that case.

A real session is not that case. It is ten tabs, a render failing in a tab
you are not looking at, a 24-scene film in the Explorer, and a film that
contains footage. Under that load the shell's surfaces stop doing the job
they promise:

- A tab strip whose names render **nine pixels wide** is not a working set.
  It is ten identical rectangles.
- An error painted inside a `visibility:hidden` iframe is not a report.
  Nothing is shown, nothing expires, and the failure is simply lost.
- A 700 ms save debounce that `frame.remove()` walks straight through is
  not a save.

The disease under all three is the same: **the shell and its documents were
verified separately, and the seams between them were never loaded.** A
document raises its own toasts, guards its own unload, owns its own
keyboard — each correct standalone, each defeated the moment the document
becomes a tab. The slices below are that seam, plus the smaller honesty
repairs found on the way.

## Decisions (settled — do not relitigate in implementation)

| decision | resolution |
|---|---|
| A DOM reconciler for the Explorer tree | **rejected.** The symptom is scroll loss, and the cause is that emptying the `<ul>` collapses `#rail-tree`'s content height so the browser clamps `scrollTop` to 0. Save and restore three lines. Keyed reconciliation of a tree that renders in under a millisecond buys nothing and costs a class of bugs. |
| `Ctrl+W` / `Ctrl+Tab` / `Ctrl+PageUp/Down` for tabs | **rejected — they are browser-reserved.** `keydown` fires, `preventDefault()` is ignored, and the browser acts anyway; `Ctrl+W` would close the *browser* tab as well as the document. Use `Alt+W`, `Alt+PageUp/Down`, `Alt+1…9`, and VS Code's own `Ctrl+K W` chord, which is not reserved. |
| A keyboard handler on `app.js` alone | **rejected.** Focus is normally *inside* an iframe, so a shell-only handler reaches nothing. The two duplicated `Ctrl+P` forwarders ([film.js:4113](../../engine/src/studio/public/film.js:4113), [scene.js:450](../../engine/src/studio/public/scene.js:450)) already prove the shape — U-5 collapses them into one shared binder rather than adding a third copy. |
| A second toast implementation in the shell | **rejected.** `studio-util.js` already owns `toast()`; U-2 deletes film.js's drifted copy *before* U-3 changes the routing, so the change is written once. |
| Bumping the packages to `0.27.0` so the version chip reads v0.27 | **no — read the real version.** `0.26.0` is what shipped 2026-08-04; v0.27 is targeted, not released, and the release checklist owns the bump. The chip's job is to stop lying, not to predict. |
| Hiding every unresolvable Explorer row | **no — only the nameless ones.** A scene folder that vanished is information and stays visible as `missing`. A footage segment rendered as a nameless scene is not information; it is a bug leaking through. |
| The ARIA pass | **approved 2026-08-06**, as U-10…U-13 plus two foldings. It was deferred on the theory that the UI is still moving, but the surfaces it touches — the two trees, the palette, the activity bar — are exactly the ones the shell just finished settling, and one of them turned out to hide a plain keyboard bug. |
| WCAG conformance as the target | **rejected.** The goal is narrower and testable without an auditor: **every surface reachable by keyboard, and every control announcing what it is and what state it is in.** No contrast re-theming, no conformance statement, no ARIA added where a native element already carries the semantics. |
| `role="tree"` on `#fe-tree` with no `treeitem` beneath it | **finish it, not remove it.** [film.html:70](../../engine/src/studio/public/film.html:70) already claims to be a tree while its rows are plain `div.tree-row` ([film.js:3383](../../engine/src/studio/public/film.js:3383)). A tree with zero items announces as an empty tree — **worse than no role at all**, because the markup makes a promise the DOM breaks. |
| `tabindex="0"` on every tree row | **rejected — roving tabindex.** A 24-scene film would otherwise cost 24 Tab stops to cross. One stop per tree, arrows move within it; that is what the `role="tree"` already claimed. |
| Converting the palette to `<dialog>` | **rejected.** Its scrim, its pointer-dismiss and its two-mode swap all work today ([palette.js:166](../../engine/src/studio/public/palette.js:166)); `showModal()` would change dismissal and stacking for no gain. U-11 adds the two things it is actually missing — focus restore and listbox semantics. |

## Slices

`N-` and `S-` are taken by
[studio-navigation-plan.md](studio-navigation-plan.md) and
[scene-inspector-plan.md](scene-inspector-plan.md), and their tombstones
must keep their numbers. This document uses `U-`.

Dependency chain: **U-2 → U-3** and **U-1, U-4 → U-5**. U-6 through U-13
are independent of everything and of each other.

U-1…U-9 are the shell's seams under load. **U-10…U-13 are the approved
accessibility pass**; two of its items were cheap enough to fold into
slices that already open the same file, and are marked in place rather
than duplicated.

### U-1 — the tab strip stops collapsing  *(~2 h)* — **SHIPPED 2026-08-06**

**Measured**, ten documents open at a 1100 px viewport: every tab name
rendered between **9 px and 29 px wide**. `"Intro A — grid"` painted at
9 px — one character and an ellipsis. `strip.scrollWidth ===
strip.clientWidth`, so the `overflow-x: auto` at
[tabs.css:17](../../engine/src/studio/public/tabs.css:17) has never once
been reachable.

The cause is one declaration. `.doc-tab`
([tabs.css:22](../../engine/src/studio/public/tabs.css:22)) sets
`min-width: 0` and inherits `flex-shrink: 1`, so tabs shrink without
bound instead of the strip scrolling.

- `.doc-tab`: `flex: 0 0 auto`, `min-width: 120px`, keep `max-width:
  240px`, **drop `min-width: 0`**. The strip's existing `overflow-x` goes
  live for the first time; keep the hidden scrollbar — Chrome maps a
  vertical wheel to horizontal on an x-only scroller.
- Move `min-width: 0` onto `.doc-tab-name`
  ([tabs.css:44](../../engine/src/studio/public/tabs.css:44)) so the
  *name* ellipsises inside a floored tab.
- `renderDocTabs()`
  ([app.js:1929](../../engine/src/studio/public/app.js:1929)) does
  `strip.innerHTML = ''` and re-appends, which resets `scrollLeft` to 0 on
  every repaint — including the one a film rename triggers through
  `syncDocument`. Capture and restore `scrollLeft` around the rebuild,
  then `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on the
  active tab. That is the same call with the same options that
  [palette.js:289](../../engine/src/studio/public/palette.js:289) already
  uses — today it is the only `scrollIntoView` in the codebase.

### U-2 — `film.js` drops its duplicate helpers  *(~1 h)* — **SHIPPED 2026-08-06**

[film.js:39-85](../../engine/src/studio/public/film.js:39) defines its own
`$`, `api`, `toast` and `toastError` even though
[film.html:267](../../engine/src/studio/public/film.html:267) loads
`studio-util.js` first. They have already drifted: film.js's `toast` omits
the `close.title = 'dismiss'` that
[studio-util.js:69](../../engine/src/studio/public/studio-util.js:69) sets,
so the film page's dismiss button has no tooltip and nobody noticed.

Delete the four and destructure from `StudioUtil` the way
[app.js:17](../../engine/src/studio/public/app.js:17) does. Leave `uuid`,
`clamp`, and film.js's own `el()` alone —
[studio-util.js:7](../../engine/src/studio/public/studio-util.js:7)
documents why `el` is deliberately *not* shared, and that reasoning stands.

**This is a prerequisite for U-3**, not a tidy-up. With two copies live,
the toast routing would be written twice and drift again immediately.

### U-3 — a failing background document is heard  *(~3 h)* — **SHIPPED 2026-08-06**

**Verified live.** A non-active document is `visibility: hidden`
([shell.css:198](../../engine/src/studio/public/shell.css:198)), `toast()`
appends to *that document's own* body
([studio-util.js:73](../../engine/src/studio/public/studio-util.js:73)),
and an error toast gets `ttl = null`
([studio-util.js:74](../../engine/src/studio/public/studio-util.js:74)) so
it never expires. Raising an error in a background scene document put it
in that document's DOM, invisible, permanent, with the shell showing
nothing at all.

So: **start a render, switch tabs, and if it fails you are never told.**
The failures accumulate behind the hidden frame and appear all at once
whenever you happen to come back.

- Add `docToast({ kind, code, message, doc })` to the shell's exported
  object beside the existing entries at
  [app.js:1988](../../engine/src/studio/public/app.js:1988). It renders
  into the *shell's* `#toasts` with a clickable source chip that calls
  `showDocument(docKey(...))` — so a background failure both shows itself
  and takes you to the thing that failed.
- `toast()` checks `shell()` first and forwards, inside a `try`/`catch`
  that falls through to the local path. Standalone `/film.html` on a
  second monitor must keep working; that is the same guard `shell()`
  already carries at
  [studio-util.js:90](../../engine/src/studio/public/studio-util.js:90).
- **Cap the stack at the newest five** in `toastContainer()`. Routing them
  makes them visible; it does not stop a retrying render from stacking
  unbounded `ttl: null` errors over the whole UI. Visible-and-unbounded is
  a worse failure than hidden.
- Drop a document's toasts in `closeDocument` — they are about a thing
  that is no longer open.
- **Folded in from the accessibility pass:** give `#toasts` `role="status"
  aria-live="polite"` in `toastContainer()`
  ([studio-util.js:38](../../engine/src/studio/public/studio-util.js:38)),
  following the `aria-live="polite"` precedent already at
  [film.js:3008](../../engine/src/studio/public/film.js:3008). Two lines,
  in the function this slice is already rewriting — and the whole point of
  the slice is that failures get announced, which is the same sentence a
  screen reader needs. Use `polite`, not `assertive`: a render failure is
  not worth interrupting a word mid-syllable.

### U-4 — closing a tab cannot eat an edit  *(~2 h)* — **SHIPPED 2026-08-06**

The film page saves on a 700 ms debounce
([film.js:194](../../engine/src/studio/public/film.js:194)) and guards the
window with `beforeunload`
([film.js:311](../../engine/src/studio/public/film.js:311)). `beforeunload`
does not gate `frame.remove()`
([app.js:1893](../../engine/src/studio/public/app.js:1893)) — browsers do
not run it for a removed subframe. **Close a film tab inside the debounce
window and the edit is silently gone**, and the one protection written
against exactly that is defeated by the shell it now lives in.

- Add `closing()` to the `StudioDoc` contract, the same shape as the
  `suspend()` and `shown()` that already sit at
  [film.js:4097](../../engine/src/studio/public/film.js:4097).
- film.js implements it as `scheduleSave({ now: true })` followed by the
  `waitForSaved()` that already exists at
  [film.js:271](../../engine/src/studio/public/film.js:271) and does
  precisely this for structural edits. Nothing new is invented.
- `closeDocument` becomes async and awaits `closing()` with a short
  timeout before `frame.remove()`; a rejection surfaces through U-3's
  toast rather than being swallowed.
- `doc.closeAll` ([app.js:2056](../../engine/src/studio/public/app.js:2056))
  iterates and closes — it must await too, or it races this fix.
- `scene.js` needs no implementation. Its config form saves on submit, not
  on a debounce.

### U-5 — the working set gets a keyboard  *(~½ d)* — **SHIPPED 2026-08-06**

`app.js` has **zero** `keydown` handlers. There is no way to close, cycle
or reach a tab without the mouse, and
[tabs.css:52](../../engine/src/studio/public/tabs.css:52) carries a
`.doc-tab:focus-visible` rule that can never fire because tabs are `<div>`
elements with no `tabindex`. The palette registers `doc.close` and
`doc.closeAll` at
[app.js:2051](../../engine/src/studio/public/app.js:2051) and no keystroke
reaches either.

- **One shared binder in `studio-util.js`** that dispatches locally in the
  shell and forwards through `hostShell()` from a document, subsuming the
  two duplicated `Ctrl+P` forwarders
  ([film.js:4113](../../engine/src/studio/public/film.js:4113),
  [scene.js:450](../../engine/src/studio/public/scene.js:450)).
- Keys: `Alt+W` close, `Ctrl+K W` / `Ctrl+K Ctrl+W` close (VS Code's
  chord), `Alt+PageUp`/`Alt+PageDown` previous/next, `Alt+1…9` nth,
  `Alt+0` last, and middle-click on a tab. Route them at the existing
  palette commands rather than new entry points.
- **Guard [film.js:1541](../../engine/src/studio/public/film.js:1541) with
  `if (e.altKey) return;`.** It binds bare `PageDown`/`PageUp` and calls
  `preventDefault()`, so without the guard `Alt+PageDown` inside a film
  moves the playhead *and* switches tabs.
- Fix the activation target while here. `closeDocument` falls back to
  `[...docs.keys()].pop()`
  ([app.js:1896](../../engine/src/studio/public/app.js:1896)) — the last
  tab in the strip, wherever it is. Capture the index before
  `docs.delete` and activate the tab that slid into the slot, else the one
  before it. Every editor convention is the neighbour, not the end.
- **Folded in from the accessibility pass:** in the same `renderDocTabs`
  rewrite, `role="tablist"` on `#doc-tabs`
  ([index.html:63](../../engine/src/studio/public/index.html:63)),
  `role="tab"` + `aria-selected` on each tab, and a roving `tabindex` (`0`
  on the active tab, `-1` on the rest). The close `✕` keeps its own
  `aria-label`, because "close" is not the tab's name. This is what
  finally makes the `.doc-tab:focus-visible` rule at
  [tabs.css:52](../../engine/src/studio/public/tabs.css:52) — dead since
  the strip was written — actually fire, and it is the same three lines
  whether or not anyone is running a screen reader.

Depends on **U-1** (switching to a tab you cannot see is not a fix) and on
**U-4** (the close keys must honour the save hook).

### U-6 — destructive actions get a real dialog  *(~1 d, splittable)* — **SHIPPED 2026-08-06**

`deleteFilm` ([app.js:235](../../engine/src/studio/public/app.js:235))
chains **two** native `confirm()`s, and the second encodes "delete the
whole film folder, its scenes, assets and renders" against "keep every
file" as OK-versus-Cancel. That is the least legible control in the
product attached to its most destructive action, and the correct component
already exists twenty files away: the scene delete dialog at
[scene-panels.js:317](../../engine/src/studio/public/scene-panels.js:317)
is a `<dialog>` with an *also delete files on disk* checkbox and a
paragraph explaining what each choice leaves behind.

The pattern is settled — static `<dialog>` markup in the page, wired in
the script, `[data-close]` for cancel
([film.js:2521](../../engine/src/studio/public/film.js:2521)), styled by
the existing `styles.css` and `scene-panels.css` classes. **No new
machinery.**

- `#delete-film-dialog` in `index.html` beside `#new-film-dialog`,
  modelled line-for-line on the scene one. **Do this first — it is a third
  of the slice's value and can ship alone.**
- `#delete-library-file-dialog` for
  [app.js:1788](../../engine/src/studio/public/app.js:1788).
- One reusable `#text-prompt-dialog` (settable heading, label, default)
  replacing the five `prompt()` calls:
  [app.js:252](../../engine/src/studio/public/app.js:252) (new workspace),
  [film.js:1097](../../engine/src/studio/public/film.js:1097) and
  [film.js:1110](../../engine/src/studio/public/film.js:1110) (sequence
  name/rename), [film.js:2645](../../engine/src/studio/public/film.js:2645)
  (new scene), [film.js:2668](../../engine/src/studio/public/film.js:2668)
  (duplicate).
- `#withdraw-advice-dialog` for
  [film.js:3751](../../engine/src/studio/public/film.js:3751).
- Asset rename
  ([scene-panels.js:637](../../engine/src/studio/public/scene-panels.js:637))
  as a second use of the asset-delete dialog's structure — its "update
  audio references" checkbox and reference list already exist at
  [scene-panels.js:695](../../engine/src/studio/public/scene-panels.js:695).
  Add the path field, share the rest. The `confirm()` beside it at
  [scene-panels.js:643](../../engine/src/studio/public/scene-panels.js:643)
  is the same illegible encoding: OK repoints the audio tracks, Cancel
  leaves them aimed at a file that no longer exists.

### U-7 — the version chip tells the truth  *(~1 h)* — **SHIPPED 2026-08-06**

[index.html:458](../../engine/src/studio/public/index.html:458) hard-codes
the literal string `v0.25` in the global-settings header. Both
`package.json`s say `0.26.0`, and the code around it references v0.27
throughout. Nothing in the Studio API exposes a version today, so the chip
has no way to be right and drifts every release.

Mirror what the MCP server already does at
[mcp/server.js:484](../../engine/src/mcp/server.js:484): read
`engine/package.json` and add `engine: pkg.version` to the **existing**
`GET /api/prereqs` response
([server.js:698](../../engine/src/studio/server.js:698)). `fs` is already
imported and `__dirname` already exists at
[server.js:199](../../engine/src/studio/server.js:199), so the read is one
expression — no new imports, **no new route**.
`checkPrereqs()` ([app.js:59](../../engine/src/studio/public/app.js:59))
already runs at boot and already writes into the same `.engine-strip`
span; replace the literal with a `<span id="engine-version">` and fill it
there.

The chip will read `v0.26.0` until the v0.27 release bumps the packages.
That is correct: it reports what is installed, which is the only thing it
can honestly report.

### U-8 — the Explorer keeps its place and stops showing ghosts  *(~2 h)* — **PARTLY SHIPPED**

Two unrelated defects in one file, cheap together.

**Scroll loss — measured.** Scrolled `#rail-tree` to 198, called
`StudioShell.treeChanged()`, and it came back **0**. `renderTree()`
([app.js:130](../../engine/src/studio/public/app.js:130)) does
`ul.innerHTML = ''`; that collapses `#rail-tree`'s content height, the
browser clamps `scrollTop`, and refilling leaves it clamped. With a
24-scene film expanded you are thrown to the top every time a document
reports a change. Save and restore `$('#rail-tree').scrollTop` around the
rebuild. Three lines — see the settled decision above on why not a
reconciler.

**Ghost rows — seen live.** Expanding `harmonia-everdark-short` shows a
nameless row tagged `missing`, with `title` reading
`default/harmonia-everdark-short/undefined`. The cause is
[store.js:715](../../engine/src/core/store.js:715): `for (const s of
film.scenes ?? []) out.push(await describe(s.slug, false))` maps *every*
play-order entry, and footage segments have no `slug`, so `describe()`
falls into its catch and returns `{ name: undefined, missing: true }`. In
`appendFilmRows`
([app.js:206](../../engine/src/studio/public/app.js:206)), skip rows with
no name — the *nameless* half of the guard
[palette.js:136](../../engine/src/studio/public/palette.js:136) already
carries (`!s?.id || !(s.name || s.slug)`), **not** its `s.missing` half.
The palette is a jump target, so a scene it cannot open is noise; the
Explorer is the inventory, so a scene folder that vanished must still
show as `missing`. Same defect, two correct answers.

**Update 2026-08-06 — the engine half landed.** BUG-2 is fixed:
`listScenes` skips footage at the source, so `sceneFolders` no longer
carries the ghost and the Explorer has nothing to guard against today.
That does **not** retire this half of the slice. Skipping a row it cannot
name is the Explorer's own business whatever the engine hands it, and the
guard costs one line; it simply never fires now. Note in the commit that
it is belt-and-braces, so the next reader does not delete it as dead code.

What the fix *did* retire from this slice: the row's scene count. It read
`${f.scenes}sc` from a total that included footage, so a film of pure
footage claimed a scene count that opened onto nothing. `listFilms` now
reports `scenes` and `footage` separately and the row renders `2sc · 1
clip`. Already done.

### U-9 — favicon  *(~10 min)* — **SHIPPED 2026-08-06**

[index.html:11](../../engine/src/studio/public/index.html:11) and
[film.html:11](../../engine/src/studio/public/film.html:11) still paint the
favicon on `#0e0f12` — a pre-VS-Code-theme colour that is not in the token
block at [styles.css:14](../../engine/src/studio/public/styles.css:14).
[scene.html:10](../../engine/src/studio/public/scene.html:10) was updated
to `#1f1f1f` and the other two were missed. Match `--ink`.

## The accessibility pass (U-10…U-13) — approved 2026-08-06

The whole UI carries **four** ARIA attributes today
([index.html:21](../../engine/src/studio/public/index.html:21),
[film.html:70](../../engine/src/studio/public/film.html:70),
[film.html:105](../../engine/src/studio/public/film.html:105),
[film.js:3008](../../engine/src/studio/public/film.js:3008)), and two of
those four are incomplete claims rather than descriptions.

The target is not conformance — see the settled decisions. It is two
sentences: **every surface is reachable by keyboard, and every control
says what it is and what state it is in.** Both are testable by hand, in
this repository, without an auditor.

The reason to do it now rather than "when the UI settles" is that
investigating it found a plain bug. The palette leaves focus on `<body>`
when it closes, which is not an ARIA question and costs every user their
keyboard.

### U-10 — the two trees get a keyboard and real semantics  *(~1 d)*

The Explorer is the app's primary navigation and it is **pointer-only**.
`renderTree` builds `<li>` rows with click handlers
([app.js:130](../../engine/src/studio/public/app.js:130),
[app.js:181](../../engine/src/studio/public/app.js:181)) inside a plain
`<ul id="workspace-tree">`
([index.html:46](../../engine/src/studio/public/index.html:46)): no role,
no `tabindex`, no arrow keys, no `Enter`. `Ctrl+P` mitigates it for
opening a document you can already name, and does nothing for browsing.

The film tree is worse in a specific way. `#fe-tree` carries `role="tree"
aria-label="film structure"` while every row beneath it is a plain
`div.tree-row` ([film.js:3383](../../engine/src/studio/public/film.js:3383),
[3397](../../engine/src/studio/public/film.js:3397),
[3436](../../engine/src/studio/public/film.js:3436)) — so it announces as
**a tree containing nothing**. The role was added in good faith and never
finished.

One job, done twice, sharing one helper:

- `role="tree"` on `#workspace-tree` (the film tree already has it),
  `role="treeitem"` on every row, `aria-expanded` on the rows that
  collapse (workspaces, films, sequences), `aria-level`, and
  `aria-selected` where a row can be selected.
- **Roving `tabindex`** — one Tab stop per tree, `ArrowUp`/`ArrowDown` to
  move, `ArrowRight`/`ArrowLeft` to expand/collapse or step in and out,
  `Enter` to open, `Home`/`End` to the ends. Not `tabindex="0"` per row:
  a 24-scene film would cost 24 Tab stops to cross.
- Put the roving-tabindex helper in
  [studio-util.js](../../engine/src/studio/public/studio-util.js) beside
  U-5's key binder. Two trees in two documents is exactly the condition
  that produced the duplicated `toast()` U-2 is deleting; write it once.
- The trees rebuild wholesale, so the helper must restore the focused row
  after a repaint — the same problem the inspector already solves with
  `captureFocus`/`restoreFocus`
  ([film.js:1650](../../engine/src/studio/public/film.js:1650)). Reuse
  that shape rather than inventing a second one. Combines with U-8's
  scroll restore, which is the same repaint.

### U-11 — the palette gives focus back  *(~2 h)* — **SHIPPED 2026-08-06**

**Measured.** With focus on the film document, opening the palette and
dismissing it with `Esc` leaves `document.activeElement` on **`BODY`** —
not on the frame it was taken from. `close()`
([palette.js:158](../../engine/src/studio/public/palette.js:158)) removes
the input its focus was living in and restores nothing. Every document
shortcut — `Space`, the arrows, `PageUp`/`PageDown`, `Ctrl+S` — is dead
until you click back into the document, and nothing tells you why.

This is the item that justified pulling the pass forward. It is a
keyboard bug wearing an accessibility costume.

- Record `document.activeElement` in `open()`
  ([palette.js:166](../../engine/src/studio/public/palette.js:166)) and
  `focus()` it in `close()`. Guard it — the element may be gone if the
  chosen command closed the document it lived in, in which case fall back
  to the active frame.
- Restore *before* running the chosen command, not after: `choose()`
  ([palette.js:292](../../engine/src/studio/public/palette.js:292)) may
  open a document that wants the focus itself.
- Semantics while here: `role="listbox"` on `.palette-list` with
  `role="option"` + `aria-selected` on each `.palette-row`, and
  `role="combobox"` / `aria-expanded` / `aria-controls` /
  `aria-activedescendant` on the input
  ([palette.js:177](../../engine/src/studio/public/palette.js:177)). The
  cursor row already exists and already scrolls itself into view
  ([palette.js:289](../../engine/src/studio/public/palette.js:289)) —
  `aria-activedescendant` is naming what the code already tracks.
- Rows bind `pointerdown` only
  ([palette.js:286](../../engine/src/studio/public/palette.js:286)). Keep
  it — `Enter` is already handled on the input, and the arrow keys are
  the keyboard path.

### U-12 — the icon-only controls say what they are  *(~1 h)* — **SHIPPED 2026-08-06**

The activity bar is seven buttons whose entire label is an emoji
([index.html:22-28](../../engine/src/studio/public/index.html:22)). They
carry `title`, which does produce an accessible name — so the naming is
thin rather than absent. What is genuinely missing is **state**: the
`.active` item is marked by a 2px amber left border
([shell.css:39](../../engine/src/studio/public/shell.css:39)) and by
nothing else. Which page is open is conveyed by colour alone, to
everyone.

- `aria-label` on each activity-bar button, so the name does not depend
  on tooltip behaviour, and `aria-pressed` on the toggles (`☰` explorer,
  and the three vendor pages plus settings, which behave as a radio set —
  `aria-current="page"` fits those better than `aria-pressed`). Wire it
  in the existing `syncExplorerIcon`
  ([app.js:2014](../../engine/src/studio/public/app.js:2014)) and
  `showVendorsPage`
  ([app.js:774](../../engine/src/studio/public/app.js:774)) rather than a
  new painter.
- Same treatment for the other icon-only controls that already have
  handlers: the tree's `✕` film delete and `+ film`
  ([app.js:143](../../engine/src/studio/public/app.js:143),
  [app.js:191](../../engine/src/studio/public/app.js:191)), the twisty
  chevrons, and the transport buttons on both documents.
- The status bar's problem counter renders as the bare glyph `⊗ N`
  ([app.js:86](../../engine/src/studio/public/app.js:86)); give it a text
  label so it does not announce as a symbol.

### U-13 — timeline blocks are reachable  *(~½ d)*

Every block on the film timeline is a pointer-only `<div>`. They all come
from one builder, `baseBlock()`
([film.js:1142](../../engine/src/studio/public/film.js:1142)), which is
also why this slice is cheaper than it looks — there is a single place to
add the semantics and the `tabindex`. Selection is mouse-only, and once
something *is*
selected the keyboard already works — `Delete` removes it
([film.js:1553](../../engine/src/studio/public/film.js:1553)),
`PageUp`/`PageDown` move cut to cut, the inspector edits it. **The
missing piece is only selection**, which makes this much smaller than it
first looks.

- Roving `tabindex` per lane, `ArrowLeft`/`ArrowRight` to the previous
  and next block *in that lane*, `ArrowUp`/`ArrowDown` between lanes,
  `Enter` to select. Reuse U-10's helper — a lane is a one-level tree.
  All of it goes in `baseBlock()`, once, for scenes, audio, captions,
  overlays and footage alike.
- The bare arrows already move the playhead
  ([film.js:1545](../../engine/src/studio/public/film.js:1545)), so the
  lane keys only apply when focus is **inside** the timeline; the
  document-level handler already returns early for `input, select,
  textarea` and needs the same early return for a focused block.
- `aria-label` per block from the label text the builder already computes
  (`s.name`, or `⚠ missing (…)` for a broken one), plus its frame range.
- **Drag, trim and reorder stay pointer-only.** A keyboard grammar for
  dragging is a real design problem and this slice does not pretend to
  solve it; the inspector is the keyboard path to the same values.
  **This is the most cuttable slice in the document** — if the pass has
  to shrink, cut this one and keep U-10 through U-12.

### U-14 — the Explorer has standing  *(~½ d)* — **SHIPPED 2026-08-06**

Added 2026-08-06 from use, not from the audit: with eighteen films and
three tabs open, the rail could not say which document was in front,
which were open behind it, which films were finished, or which one the
agent was working on. Three separate holes with one answer — the row.

- **One mark per row, in one column: shape is the kind, colour is the
  standing, and on a film it is the disclosure control as well.** `▶`
  film, `◧` scene, `⧉` library, `+` create — the tab strip's `▶`/`◧`
  rather than a second vocabulary for the same two things. It took three
  passes and both corrections were right: the glyph first (beside a
  state dot), then the dot went when the user said the glyph was meant
  to *replace* it — two marks saying one thing is one too many — then
  the chevron went when they pointed out it was still a second column,
  since a `▶` turned 90° is the disclosure triangle every tree already
  uses. Names ended up starting 24px further left than they began. A
  workspace keeps its chevron and takes no glyph: it is a section
  header, and only `▶` rotates into something meaningful. A kind-only glyph is `aria-hidden` (the
  name beside it is the label); one carrying state is `role="img"` with
  that state as its label, since a colour cannot be read aloud. The
  film page's tree took the same grammar — `◧` scene, `▦` footage,
  coloured by readiness — replacing a bare dot that carried the colour
  but named nothing.
- **Open vs active.** `syncTreeSelection()` toggles `open` and `active`
  on `[data-doc]` rows and runs on every open, close and switch. Before
  this, a scene row went `active` merely by being *open*, film rows said
  nothing, and nothing repainted the tree when the working set changed,
  so even that was usually stale. Classes only, never a rebuild — this
  runs on every tab switch and a rebuild costs the rail its scroll.
  `revealActiveDoc()` scrolls the active row into view, expanding its
  film when the active document is a scene.
- **Standing per film**, server-side in `filmStanding()`: built /
  edited-since-built / draft / broken from the delivery pointer and its
  manifest, plus the workspace's heartbeats for "an agent is on this
  one now". Cheap reads by design — `productionStatus` is the right
  answer per film and far too expensive once per row per refresh. The
  edited-since-built rule is copied from it so the two cannot disagree.
- **Render state per scene** from the plan the Explorer already had:
  `GET /api/films/:id` returns `detail` beside `sceneFolders`, and
  `loadFilmScenes` was throwing it away.
- **A live tree.** The shell subscribes to `/api/events`, so a film an
  agent creates elsewhere appears by itself, badged `new` until opened,
  with one clickable toast. It also *fans that stream out* to its
  documents (`StudioUtil.subscribeProduction`): ten open films had meant
  ten SSE sockets against HTTP/1.1's ~6 per origin, which starves the
  later feeds and the shell's own fetches with them.

Accepted in headless Chromium — against the real workspace for the marks
and the dots (18 films: 11 built, 7 edited, 1 draft), against a
throwaway store for the live half (a film created mid-session arrives,
badges, toasts, clears on open; a heartbeat lights its film; three open
documents, one stream). Verifying it surfaced **BUG-4** (`computeFit`
throws on a closing document), pre-existing and filed rather than fixed.

### U-15 — the timeline's lanes and trims  *(~1 d)* — **SHIPPED 2026-08-06**

Added from use, like U-14, and reported in one sentence each: adding
and removing a layer is hard, adding audio forces you to pick a file
first, a lane disappears when you drag clips around, the picker gives
you no way to hear what you are choosing, and a clip can only be
shortened from the end.

Four of the five were the same root cause in two places.

- **Lanes were a picture, not a fact.** `packLanes` re-derived the rows
  on every repaint, so a lane existed only while something overlapped in
  it — dragging clips apart deleted the row, and an empty lane was
  unsayable. Items now carry `lane`, the film carries
  `lanes: {audio, captions, overlays}` (a new stored field: presentation,
  but an empty lane you just made has to survive a reload), and the old
  packing is kept as the migration for films written before this, so
  opening one looks like nothing happened. Per-lane `+`, `⊕` to add an
  empty lane, `✕` to take an empty one back, and vertical drag between
  lanes with the target lit.
- **The head trim did not exist in the engine.** `trimEndInFrames` was
  the only trim, so the left grip had nothing to write. Both trims now
  index the SOURCE (`[start, end)`), which leaves the old field's meaning
  untouched, and the mixer chain gained `asetpts=PTS-STARTPTS` after
  `atrim` — without it a head-trimmed clip keeps its source timestamps
  and arrives `trimStart` late on top of its `adelay`. That one is easy
  to get wrong and impossible to see in the UI, so it is proven against
  real ffmpeg rather than asserted: a file of one second of silence then
  one second of tone reads `-inf` dB in the first quarter-second
  untrimmed and −24 dB with a 30-frame head trim.
- **The picker could not be heard.** One shared `<audio>`, a `▶` per row
  that toggles, stopped by the next play and by the dialog closing.

Accepted in headless Chromium against a throwaway film with real WAVs —
13 checks: an empty lane added with no file, stored, still there after a
reload; audition playing and stopping; a clip landing in the lane whose
`+` was clicked; a drag that does **not** collapse the lane; a drag that
moves a clip between lanes; the left grip writing `trimStartInFrames`
while `startInFrames` follows; an empty lane removed. Plus four engine
tests for the graph and four for the schema.

**Follow-up the same day, from the same use:** a lane can be **muted**
(`film.mutedLanes.audio`, plus `mute` on a single track), and the mix
honours it everywhere through one `audibleTracks(film)` rule rather
than three — muting the editor only would be a lie the build discovers.
And the head buttons were put into three fixed columns (mute · add ·
lane) after they were reported as ragged: they had been appended in
turn with `margin-left:auto` on the first, so a row with one button put
it where the next row put its second. Fixing that surfaced a real hole
— the **last** lane only ever offered `⊕`, so an empty lane added at
the bottom could never be removed; it now offers `✕`, since an empty
last lane IS the lane you would have added.

**Not done, deliberately:** footage keeps its single grip. A footage
segment joins the film without re-encoding, so trimming it is
`transcode_asset`'s job, not the timeline's.

## Verification

Hard-reload the browser before judging — an open tab keeps the old JS.
Drive `default/signal-path` (24 scenes) and
`default/harmonia-everdark-short` (the film that produces the ghost row).

1. **U-1** — open ten documents at a 1100 px viewport. Every tab name is
   legible; the strip scrolls horizontally; a vertical wheel over it
   scrolls it. Switch to the last tab, then the first: the active tab is
   scrolled into view both times. Rename a film with the strip scrolled
   right — the scroll position holds across the repaint.
2. **U-2** — the film page's toast dismiss button has the tooltip it was
   missing. No `ReferenceError` in the console on film load.
3. **U-3** — open a film and a scene, activate the film, force an error in
   the background scene. The toast appears **in the shell**, labelled with
   the scene, and clicking the label activates that tab. Raise eight
   errors: five remain. Close the scene tab: its toasts go. Open
   `/scene.html?scene=…` directly with no shell — the toast still renders
   locally.
4. **U-4** — type in a film field and hit the tab's ✕ within 700 ms.
   Reload: the edit is there. Repeat through `doc.closeAll`.
5. **U-5** — with focus inside the film iframe: `Alt+W` closes one
   document and **does not close the browser tab**; `Alt+PageDown` moves
   to the next document and **does not move the playhead**; `Alt+3`
   activates the third. Close a middle tab — its right-hand neighbour
   activates, not the last one. Middle-click closes. `Ctrl+P` still works
   from both documents and from the shell.
6. **U-6** — the film delete dialog: cancel leaves the film; unchecked
   deletes only `film.json` (confirm the folder survives on disk);
   checked removes the folder. `Esc` cancels. Open documents for that film
   still close ([app.js:244](../../engine/src/studio/public/app.js:244)).
7. **U-7** — the chip in global settings matches `engine/package.json`.
8. **U-8** — expand a 24-scene film, scroll the rail to the bottom,
   create a scene from a document (which fires `treeChanged`): position
   holds. Expand `harmonia-everdark-short`: no nameless `missing` row, and
   a genuinely missing scene folder still shows one.
9. **U-9** — favicon reads correctly against the shell background in a
   browser tab.
10. **U-10** — Tab into the Explorer: **one** stop, not twenty-four.
    Arrows move, `→`/`←` expand and collapse, `Enter` opens the document.
    Expand a 24-scene film, focus a scene row, create a scene from a
    document so the tree repaints: focus stays on the row it was on. Same
    keys in the film tree, which now reports its rows instead of
    announcing as empty.
11. **U-11** — with focus in the film document, `Ctrl+P` then `Esc`, then
    press `Space` **without clicking**: playback toggles. Repeat choosing
    a row instead of dismissing — focus lands in the document that
    opened, not on `<body>`. Arrow through the list and confirm
    `aria-activedescendant` tracks the amber row.
12. **U-12** — every activity-bar button has a name; the open page
    reports as current, not only as an amber border. Toggle the Explorer
    and confirm the pressed state changes with it.
13. **U-13** — Tab into the timeline, arrow along a lane and across
    lanes, `Enter` selects, the inspector follows, `Delete` removes. The
    bare arrows still move the playhead when focus is **not** on a block.

Then, once, across the whole app: Tab from the top of the shell to the
bottom and confirm every stop is visible, in order, and escapable — no
trap, and no control that takes focus without showing it.

`npm test` green at its current count, 0 failing.

## Docs (same change, per project rule)

- [CHANGELOG.md](../CHANGELOG.md) — one Unreleased entry per landed slice.
- [user-guide.md](../user-guide.md) — the "Getting around the Studio"
  section gains the new document shortcuts (U-5) and the tree/timeline
  keys (U-10, U-13), and loses nothing. The keyboard is now a documented
  surface, not folklore: one table of every binding the Studio answers.
- [architecture.md](../architecture.md) — `StudioDoc` grows `closing()`
  and `StudioShell` grows `docToast()`; both are named in the shell
  contract there. Add the roving-tabindex helper beside the key binder as
  part of `StudioUtil`'s documented surface.
- [TODO.md](TODO.md) — this document in the active table; move to
  [completed.md](completed.md) when the last slice lands.
- [bug-backlog.md](bug-backlog.md) — **do not close BUG-2 when U-8 lands.**
  U-8 stops the Explorer *showing* the phantom row; the engine still
  *reports* it, and the MCP workspace manifest still carries it into what
  an agent reads. The symptom a human sees is the one that disappears,
  which is exactly how this defect stayed unnoticed the first time.

## Non-goals

No SPA rewrite and no client router; no refactor of `film.js` or the
shell into mountable modules; no DOM reconciler for either tree; no split
view or editor groups; no new dependencies; no new server route (U-7
extends a response that already exists); no change to the amber accent;
no premature version bump to make a chip read nicer; and no attempt to
fix `store.js`'s footage-in-`listScenes` defect here — that is
[bug-backlog.md](bug-backlog.md) **BUG-2**, an engine change with its own
blast radius.

Inside the approved accessibility pass, also **not** in scope: WCAG
conformance as a target or a conformance statement; contrast or palette
re-theming; a keyboard grammar for dragging, trimming or reordering
timeline blocks (U-13 covers selection only, and the inspector is the
keyboard path to those values); an automated a11y linter or axe run in
CI — the acceptance is the hand-driven pass in Verification, and adding a
tool would be a new dependency this plan has already ruled out; and ARIA
on anything that a native element already describes, which is most of the
form surface.
