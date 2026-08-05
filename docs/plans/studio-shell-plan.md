# One Studio, documents inside it

> **Status: SHIPPED code-complete 2026-08-06** (S-1…S-4 landed; awaiting
> commit). Verified in the browser against `sephiroth-origin-eclipse-mv`;
> `npm test` green at 925 passing / 0 failing. From a user mockup. Supersedes the parts of
> [studio-navigation-plan.md](studio-navigation-plan.md) that existed only to
> make navigating *between two pages* bearable — the breadcrumb and the
> same-tab `open scene ↗`. Those were the right fix for two documents. This
> plan removes the two documents.

## Why

Motion Studio has shipped as **two pages** since v0.20: `/index.html` (the
workspace tree and the scene workbench) and `/film.html?id=…` (the film
editor). Every improvement since has been an attempt to make moving between
them cheaper — a deep link, a breadcrumb, a same-tab link, a document strip,
and finally a command palette.

They all treat the symptom. The disease is that **opening a film is a page
navigation**, so the workspace tree — the thing that tells you what exists —
disappears the moment you look at anything, and comes back only by leaving what
you were looking at. VS Code does not work that way and neither does any
editor: the Explorer is permanent and documents open *inside* the shell.

So: one page. The tree is the shell. A film opens as a document tab. A scene
opens as a document tab. **Switching pages stops existing.**

## The shape

```
┌────┬──────────────┬──────────────────────────────────────────────┐
│ A  │  EXPLORER    │ [▶ SEPHIROTH ✕][◧ 06 Nibelheim ✕]            │  ← document tabs
│ C  │              ├──────────────────────────────────────────────┤
│ T  │  ▸ codex     │                                              │
│ I  │  ▾ default   │   the active document, whole:                │
│ V  │    Harmonia  │   the film editor (its own rail, viewport,   │
│ I  │    SEPHIROTH │   inspector and timeline), or the scene      │
│ T  │    …         │   workbench (preview, transport, panel)      │
│ Y  │    library   │                                              │
├────┴──────────────┴──────────────────────────────────────────────┤
│ …/sephiroth-origin-eclipse-mv   ● newer work awaits a film build │  ← status bar
└──────────────────────────────────────────────────────────────────┘
```

## The decision that shapes everything: how a document is instantiated

`film.js` (3.9k lines) and the scene half of `app.js` each assume they own the
document: top-level `$`, `state`, `filmId`, `window` keydown handlers, and
`document.querySelector('#id')` throughout. Both use `#btn-play`,
`#frame-total`, `#timecode`, `#inspector`, `#save-state`.

| option | verdict |
|---|---|
| **Refactor both into mountable modules in one runtime** | rejected. ~6k lines of global-scoped vanilla JS, and the id collisions are not incidental — two open films would fight over `#inspector`. Days of work, and the failure mode is silent. |
| **One document view at a time, torn down and rebuilt on tab switch** | rejected. It solves ids by never having two, which is exactly what the tab model promises to allow — and every switch would refetch, losing playhead, undo stack and scroll. |
| **A same-origin iframe per open document** | **taken.** |

The iframe is not the cheap option, it is the correct one:

- **Per-document state survives**, which is what a tab strip means. Switch away
  from a film and back, and the playhead, the undo stack, the timeline zoom and
  the inspector tab are where you left them. VS Code editors behave this way.
- **Id collisions vanish** rather than being managed. Two films open at once is
  a normal thing to want, and it just works.
- **The documents stay standalone pages.** `/film.html?id=…` still opens on its
  own — useful for a second monitor, and the reason the deep links keep working.
- Motion Studio already renders the composition in an iframe. This is not a new
  idea in this codebase.

Same origin means no `postMessage` ceremony: the shell can call into a
document's window directly, and a document can call `parent.StudioShell`.

## The contract

The shell exposes:

```js
window.StudioShell = {
  isShell: true,
  openDocument({ kind, id, name, activate = true }),  // kind: 'film' | 'scene'
  closeDocument({ kind, id }),
  documentReady(doc),    // a document has loaded and named itself
  syncDocument(doc),     // its title or status items changed
  treeChanged(),         // it created/renamed/deleted something the Explorer shows
  openPalette(mode),     // Ctrl+P landed inside a document; the shell owns it
}
```

Each document exposes, once it knows what it is:

```js
window.StudioDoc = {
  kind, id,
  title(),        // for the tab
  status(),       // [{ text, cls?, title?, align?, onClick? }] for the status bar
  suspend(),      // going behind a full-stage page: stop playing
}
```

Registered through `StudioUtil.registerDocument()`, which also marks
`<html class="embedded">` so the stylesheets can drop the shell's chrome.

A document detects embedding with `window.parent !== window &&
window.parent.StudioShell`. Embedded, it hides its own activity bar, status bar
and document strip — the shell owns those — and routes what would have been a
`location.href` navigation through `openDocument` instead.

## Slices

### S-1 — `scene.html` + `scene.js`

The scene workbench leaves `index.html`/`app.js` and becomes a document of its
own: the viewport, transport, preview iframe, the render tab, the hot-reload
stream, job polling, and the mounted `ScenePanels`. What stays behind in the
shell is everything that is not a document — the tree, the vendor and settings
pages, the shared library, the dialogs that create things.

Shared one-liners (`$`, `api`, `enc`, `toast`) move to `studio-util.js` rather
than being copied. `el()` does **not** move: `app.js` and `film.js` have had
different signatures for it since v0.20 and unifying them is not this plan's
job.

### S-2 — the editor stack

`index.html`'s stage gains `#editor-stack`. `tabs.js` is **retired**: a strip of
links between two pages has no job in a one-page app, so the shell owns the
open-document model instead — the list, one iframe per document, exactly one
shown, ✕ to close. The set lives in `localStorage` (`ms.docs`), so a reload
reopens what was open and re-activates what was in front.

### S-3 — documents adapt

`film.js` and `scene.js` declare `window.StudioDoc`, hide their own chrome when
embedded, and call `openDocument` where they used to navigate. The film
inspector's `open scene ↗` becomes "open this scene as a tab" — no longer an
escape hatch to another page, because there is no other page.

### S-4 — the shell drives the tree and the status bar

Tree clicks open documents instead of navigating. The status bar renders the
active document's items. The palette's `run()` calls `openDocument`.

## What this removes

- `tabs.js`, and with it the idea of a tab that is a link to another page.
- `location.href` navigation between the two surfaces, in both directions.
- The scene breadcrumb and the film's `←`, **when embedded** — the Explorer is
  permanently visible, so both are answering a question nobody has any more.
  Standalone they stay, because there the question is real.

The deep links **stay** (`/film.html?id=…&scene=…`, and the new
`/scene.html?scene=…`): they are how a document opens standalone, on a second
monitor, and how an agent hands you a link to one exact thing.

## Verification

Browser-driven against `sephiroth-origin-eclipse-mv`:

1. Click a film in the tree → it opens as a tab, tree still visible, no navigation.
2. Click a scene → a second tab; switching between them preserves each one's
   playhead and scroll.
3. A film tab's inspector `open scene ↗` opens the scene as a *third* tab.
4. ✕ closes a document; the last one closing shows the empty state.
5. Reload restores the open set and the active document.
6. Status bar follows the active tab.
7. `/film.html?id=…` still opens standalone with its own chrome.
8. `npm test` green.

## Non-goals

No client router (the shell never changes URL for a tab switch). No split view
or editor groups. No refactor of `film.js`'s internals. No change to the MCP
surface, the engine, or storage.
