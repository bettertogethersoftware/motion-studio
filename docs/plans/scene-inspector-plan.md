# The scene inspector — the whole scene, without leaving the film

> **Status: SHIPPED code-complete 2026-08-05** (S-1…S-5 all landed; awaiting
> commit). Verified in the browser against `sephiroth-origin-eclipse-mv` and
> `jin-park-sunshine-vertical`; `npm test` green at 925 passing / 0 failing.
> Takes
> [studio-navigation-plan.md](studio-navigation-plan.md)'s **N-5, option (b)** —
> left there as "a real product decision and the user's, not taken here". The
> user has now taken it: option (b), the in-place inspector. This document is
> the design and the slices; the navigation plan is closed by it.
>
> Scope: one shared panel module (~1 d), both documents adopting it, a
> resizable inspector. No new server routes — every panel is already reachable
> over REST from either page.

## Why this, after the navigation plan shipped

The navigation plan fixed the *return* edge. A scene page now names its film
and links back, `open scene ↗` is same-tab, and the document strip keeps the
working set one click away. The round trip works.

**But the trip still exists.** Checking a scene's format, its audio tracks, or
what it last rendered still means leaving the film — and a reviewer who leaves
the timeline loses the thread of the film they were judging. That is the cost
the round trip made cheap rather than removed.

The film page defaults to **watch & advise**: the human is a reviewer, not an
editor ([film.js:7](../../engine/src/studio/public/film.js:7)). For a reviewer,
routine information must never be a navigation. The inspector already holds
half the answer — name, status, video, length, format, film offset, the render
button, the version stack, the advice thread
([film.js:1862](../../engine/src/studio/public/film.js:1862)). The other half —
the scene page's five tabs — is *the same object's deeper fields*, reached the
long way round for no reason but where the code happens to live.

## UI precedent (reference only)

| tool | container → child config |
|---|---|
| Final Cut Pro | select a clip, the right Inspector repopulates — zero navigation |
| Premiere Pro | Effect Controls panel repopulates on selection |
| Resolve | modes exist, but the page bar never leaves the screen |
| After Effects | precomp opens a tab, with the parent chain in a breadcrumb |

Final Cut's is the answer that fits a review surface: **the inspector is where
a selected thing explains itself, and selection is the only navigation.** AE's
tab answer suits an editor juggling compositions — which the Studio already
has, in the document strip. Both, not either.

## The engineering constraint that shapes this

The obvious implementation — port the five panels into `film.js` — is wrong,
and would undo what the navigation plan bought.

The panels are ~700 lines of `app.js` wired to `index.html`'s static markup: a
config form with format capability gating, a staged audio-track editor, an
asset browser with reference badges, rename/delete repair flows and an
audition player, an outputs list. Copied into `film.js`, there are immediately
**two implementations of the same panel**, and they drift. Within a release the
film inspector and the scene page disagree about what editing a scene means —
which is exactly the mode error the navigation plan was fighting, rebuilt one
layer down.

So: **one implementation, two hosts.**

`scene-panels.js` owns the four deep panels as self-built DOM, driven by an
injected context rather than by page globals:

```js
createScenePanels({
  host,                      // element to mount into
  sceneId,                   // "<ws>/<film>/<scene>"
  api, toast, toastError,    // the host's transport and notification
  compact,                   // narrow single-column layout for the inspector
  capabilities,              // { deleteScene } — what this host permits
  onConfigChanged(config),   // host updates its own chrome
  onSceneDeleted(),          // host decides what "gone" means
})
```

Both documents mount it. The scene page adopts it **first**, because it is the
surface that works today: if the module is faithful there, it is faithful in
the inspector, and the diff is reviewable against known behaviour.

## Decisions (settled — do not relitigate in implementation)

| decision | resolution |
|---|---|
| port the panels into `film.js` | **rejected** — two implementations that drift; see above |
| iframe the scene page's panel into the inspector | **rejected** — an iframe for a *panel* never feels native, and the preview iframe is not a precedent for chrome |
| which tabs | `scene · config · audio · assets · outputs` — `scene` replaces the scene page's `render` tab and holds today's facts, render control and move/remove |
| versions + advice | stay under the `scene` tab only. Deep tabs are focused work; the reviewer's home is one click away |
| a scene page rewrite | **no** — it keeps its layout, tab bar and transport; only the four panel bodies change owner |
| delete-scene from the inspector | **yes**, same dialog, same double confirm. `removeScene` already drops the play order in both modes, so the film page just reloads |
| inspector width | 300px fixed → **drag-resizable, persisted**. The panels need room and Final Cut's inspector resizes too |
| new server routes | **none needed** — `GET /api/scenes/:sid`, `PATCH …/config`, `…/assets`, `…/asset`, `…/outputs`, `…/render` all serve either page |

## Slices

### S-1 — `scene-panels.js` + `scene-panels.css`

The shared module. Builds its own DOM, owns its own `<dialog>` for asset
deletion, and keeps one audition player per instance. Public surface:
`setScene(id)`, `show(tab)`, `refresh()`, `adoptConfig(config)`, `destroy()`.

`compact: true` drops the config grid to one column and tightens the asset and
output rows — the same panels, sized for a 300–520px column.

### S-2 — the scene page adopts it

`app.js` deletes its config/audio/assets/outputs implementations and mounts
the module; `index.html` sheds the corresponding markup and the asset-delete
dialog. The page's own chrome — meta line, preview reload, tree refresh —
moves into `onConfigChanged` / `onSceneDeleted`.

The `render` tab, the transport, the preview iframe and the workspace tree are
untouched: they are the scene page's job, not a scene panel.

### S-3 — the film inspector's scene tabs

`renderSceneInspector` gains a tab strip in the existing `.tabs` grammar. The
`scene` tab is today's inspector unchanged, plus versions and advice. The four
deep tabs mount the shared module.

**The re-render hazard, and the fix.** `renderInspector` rebuilds from
`innerHTML = ''` and fires on selection, mutation, save, SSE and the
once-a-second scene-job poll. A config form rebuilt under the user loses
half-typed text and focus. Two changes:

1. The panel root is **long-lived** — held in a module variable, detached and
   re-appended rather than rebuilt. Nodes keep their values and listeners.
2. `renderInspector` **preserves focus and selection** across a render: capture
   the active element and its `selectionStart/End` when it lives inside the
   inspector, restore after. This is a real bug today — the film-name and
   caption inputs have it too — and the fix is general.

### S-4 — a resizable inspector, and `open scene ↗` demoted

`.fe-main`'s third column becomes a CSS variable driven by a drag handle on the
inspector's left border, clamped 280–560px, persisted in `localStorage`.

`open scene ↗` stops being the route to routine information and becomes what
its arrow says: a small escape hatch to the full-screen editor, in the note row
rather than the primary action row.

### S-5 — docs, per the project rule

`docs/user-guide.md` (the inspector's tabs and what each one does),
`docs/architecture.md` (the shared panel module and why it exists),
`README.md`, `docs/CHANGELOG.md`.

## Verification

The studio suites are HTTP-level with no DOM harness, so the acceptance is
browser-driven against `sephiroth-origin-eclipse-mv` (12 scenes, 7 sequences):

1. **The scene page still works** (S-2 is a refactor — this is the regression
   gate): config apply round-trips and renames the tree entry; format switch
   gates crf/preset/pixFmt/transparent/audioLimiter and swaps the note; audio
   add/edit/save with the ♫ badges updating; asset upload, drop, copy, rename
   with audio repair, delete with the reference warning; outputs list and
   download.
2. **The same panels in the inspector**: select scene 06 on the film page,
   walk all five tabs, edit config, confirm the timeline block renames.
3. **No teardown under polling**: type into the config name field while a
   scene render is running and confirm focus and text survive the 1 Hz poll.
4. **Selection changes swap the scene**: pick a different scene with a deep tab
   open — the panel follows the selection rather than stranding the old one.
5. **Footage segments** keep the footage inspector with no tabs — there is no
   scene folder to show.
6. **Resize** persists across a reload; the timeline and stage reflow.
7. `npm test` in `engine/` stays green.

Hard-reload the browser before judging — an open tab keeps the old JS.

## Non-goals

No SPA rewrite or client router. No change to the document strip, the
breadcrumb, or the film page's `←` — the navigation plan settled those. The
scene page keeps its preview, transport and render tab. No new server routes,
no new dependency, no change to the composition editing model (files on disk,
edited by the agent).
