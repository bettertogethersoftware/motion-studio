# Motion Studio — User Guide

## Installation and first run

Motion Studio needs two things installed and on PATH: **Node.js 18 or
newer** and **FFmpeg 5 or newer**. Neither is bundled. Then, from the
repository root:

```bash
cd engine
npm install          # downloads Puppeteer's Chromium build (~150–300 MB, once)
npm run doctor       # prints the prerequisite check as JSON (exit 0 = ready)
npm run studio       # → http://127.0.0.1:7345
```

Open `http://127.0.0.1:7345` in any browser. Engine status sits at the top
of the sidebar, under the brand;
if a prerequisite is missing a banner names it, and every render also
re-verifies prerequisites and reports a structured `prereqs_missing` error
rather than failing mysteriously. Set `PORT` to change the port. The Studio
binds to `127.0.0.1` only — it is a local tool, not a web service.

If Puppeteer's Chromium download is blocked on your network, install any
Chrome/Chromium yourself and point the engine at it:
`PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm run studio`.

## Getting around the Studio (v0.27)

**The Studio is one page.** The tree on the left is always there; films and
scenes open as **document tabs** inside it, the way files open in an editor.
Clicking a film does not take you anywhere — it opens the film editor in the
tab area, with the tree still beside it.

| where | what it is |
|---|---|
| **activity bar** (far left, 48px) | ☰ toggles the side bar; ⌕ opens the command palette; the bottom group opens the **speech**, **music** and **transcription** vendor pages and **global settings**. The lit icon has an amber bar on its left edge. |
| **Explorer** (the tree) | every workspace → film → scene on the machine. Click a film or a scene to open it as a tab. It never goes away. |
| **document tabs** (across the top) | what you have open. The active one is cut out of the strip in the editor's shade with an amber line along its top. **✕** closes a document and touches nothing on disk. |
| **status bar** (across the bottom) | whatever the active document reports. A film: its problems, what the AI is doing, the master-mix state, save state. A scene: its `workspace / film / scene` path, live render progress, whether hot reload is watching. |
| **command palette** | see below. |

**Tabs keep their state.** Leave a film paused at 01:02, go read a scene's
config, come back — the playhead is still at 01:02, with the undo history,
timeline zoom and inspector tab exactly as you left them. What is open is
remembered between sessions too, so a reload puts you back where you were.

A film or a scene can also be opened **on its own**, which is how you put a
scene on a second monitor: `/film.html?id=<workspace>/<film>` and
`/scene.html?scene=<workspace>/<film>/<scene>`. Standalone they carry their own
activity bar and status bar; inside the Studio the shell provides those.

### The command palette

| shortcut | what it does |
|---|---|
| **Ctrl/Cmd + P** | go to any film or scene **on the machine**, by name |
| **Ctrl/Cmd + Shift + P** | run a command |

Either one swaps to the other without closing, and `Esc` dismisses. Matching is
fuzzy: `cldopn` finds *01 Cold Open — The Manor*, and the characters that
matched are marked so you can see why a result is there. `↑ ↓` move, `Enter`
opens.

This is the fastest way around a machine with a lot of work on it — the tree
is a convenience, not the only route. The commands on offer are the shell's
(new workspace, the vendor pages, settings, close a document) plus whatever the
active document adds: a film contributes build, advise, the
add-narration/audio/caption/footage/overlay actions, undo/redo, fit-the-timeline
and the six inspector tabs.

Dismissing the palette puts the keyboard back where it took it from, so the
transport keys keep working; *choosing* something puts you in the document that
opened.

### The keyboard

Shortcuts for the documents you have open. They work wherever the focus is —
in the tree, in the status bar, or inside a film or scene.

| shortcut | what it does |
|---|---|
| **Alt + W**, or **Ctrl/Cmd + K** then **W** | close the active document |
| **Alt + PageDown / PageUp** | next / previous document (wraps) |
| **Alt + 1…9** | go to the *n*th document |
| **Alt + 0** | go to the last one |
| middle-click a tab | close it |

The tab strip is reachable by `Tab` as one stop; `← →` move along it, `Enter`
activates, `Delete` closes.

**Why `Alt` and not `Ctrl+W`.** `Ctrl+W`, `Ctrl+Tab` and `Ctrl+PageUp/PageDown`
belong to the browser and cannot be intercepted — `Ctrl+W` would close the
browser tab along with the document. `Ctrl+K` is free, and the chord is the one
VS Code uses.

Inside a film or scene, `Alt` is reserved for the shortcuts above, so the
transport keys below never fire at the same time as a document switch.

## Workspaces, films and scenes

Motion Studio's storage mirrors what you're actually making. A **workspace**
is one tree of work — each connected AI agent is bound to its own via
`MOTION_STUDIO_WORKSPACE` (default `"default"`, created on first use), and
the Studio shows *every* workspace, since the human browses them all. A
**film** is the video you're building: an ordered list of scenes plus a
master audio timeline, captions and overlays, with its own `assets/` (master
audio, overlay files) and `out/` (the built film). A **scene** is one
composition inside a film — same folder contents as ever (`scene.json`,
`composition.html`, `composition.js`, `styles.css`, a copy of `frame-api.js`,
`assets/`, `out/`), same preview/render behaviour; only its location changed.
There's no standalone scene outside a film — even a single short clip is a
film with one scene.

The sidebar is **one tree** instead of the old projects/films tabs: each
workspace row expands to its films (hovering reveals a **+ film** button;
an empty workspace shows a clickable **+ first film** row instead), each
film row — name, what it holds, a ✕ to delete — expands to its scenes plus a
**+ scene** row, and a **⧉ library** row sits below a workspace's films (see
[Shared library](#shared-library) below). **+ workspace** at the very bottom
starts a new tree.

**+ film** opens the **new film** dialog: a name plus width/height/fps/
duration and optional **platform versions** (YouTube 16:9, Shorts/TikTok 9:16,
Square 1:1). The first selected platform supplies the master canvas; every
selected version is saved before any scene exists, so it shares one edit rather
than becoming a second film later. Leave them unticked for a master-only film.
Those dimensions become the film's *scene defaults* — every scene created
inside it inherits them, which is what keeps a film's scenes losslessly
concatenable — and the visual [film editor](#the-film-editor) opens next.
**+ scene** opens the **new scene** dialog: just a name and an
optional duration (0 = the film's default); width/height/fps always come
from the film, so diverging them is left to the scene's own config tab
rather than offered up front. Scenes and films created or edited by an agent
over MCP (`create_scene`, `create_film`, `update_film`, …) appear in the
same tree, because it's the same thing on disk — presence of `film.json` or
`scene.json` is what makes a folder a film or a scene, so there's no
separate registry to fall out of sync. Data lives under
`<dataDir>/workspaces/<workspace>/films/<film>/scenes/<scene>/`, where
`<dataDir>` is the `data` folder beside the app by default — change it in
the ⚙ global-settings page, or override it for one process with `MOTION_STUDIO_HOME`. If you
used Motion Studio before v0.22 your existing `~/.motion-studio` keeps being
used, and the settings page shows it.

**What each row tells you (v0.27.2).** The rail is where twenty films look
alike, so every row carries **one mark**, in one column: its shape is what the
row is, its colour is how far along that row is, and on a film it is also the
control that shows and hides the scenes. Films and scenes wear the same glyphs
their document tabs do.

| the glyph | what the row is |
|---|---|
| `▶` | a film — click the glyph itself to show or hide its scenes; it turns down while they are showing |
| `◧` | a scene |
| `⧉` | the shared library |
| `+` | a create row |

| its colour | where that row stands |
|---|---|
| green | **built** — a delivery exists and nothing has changed since (a scene: rendered) |
| yellow | **edited since built** — what plays is behind production (a scene: rendered at settings that have since changed) |
| faint grey | **in production** — no finished build yet, or nothing in it (a scene: not rendered) |
| red | broken, or a folder that has gone missing |
| pulsing amber | an agent is working on this film *now* — hover for who and what |

Hovering any glyph says it in words. Two more marks sit beside it: an amber
bar and amber name for the document you are looking at right now, a grey
highlight for the tabs open behind it, and a `new` badge on a film that
appeared while you were working (opening it clears the badge).

The film page's own tree speaks the same way: `◧` for a scene, `▦` for
supplied footage, green when it is ready and red when it is not.

The tree is live — a film an agent creates in another process appears on its
own, says so once in a toast you can click to open it, and its dot follows the
work as it renders, builds and gets edited. Switching tabs moves the amber
mark, and opening a scene from anywhere (the palette, a film page) scrolls its
row into view and expands its film to get there.

Clicking a film's row opens its [film page](#watching-and-advising-the-film-page-v023)
— player, tree, timeline and [editor](#the-film-editor) on one surface;
clicking a scene opens the workbench below. The film row's ✕ deletes it,
through a dialog with one checkbox: leave *also delete the film folder on disk*
unchecked and only `film.json` goes — the scenes, assets and rendered output
stay, and the folder is listed as `broken` until cleaned up; tick it and the
whole folder goes, every scene included. Neither can be undone from here.

The count beside a film name is what it actually holds. Scenes and supplied
footage are counted apart — `12sc`, or `2sc · 1 clip`, or just `1 clip` —
because only scenes expand into rows beneath, and a film of pure footage that
claimed a scene count opened onto nothing.

### A scene, without leaving the film (v0.27)

Select a scene on the film page and its inspector opens on a row of tabs:

| tab | what is on it |
|---|---|
| **advice** | *the first tab, and where a selection lands* — the take's **versions** and the **advice** on it, with **✎ advise** at the top |
| **scene** | the take itself — name, status, resolution, length, format, film offset — plus **re-render**, **move earlier / later**, **remove** |
| **config** | the scene's own `scene.json`: name, fps, width, height, frames, and every output setting (format, dir, filename, crf, preset, pix fmt, alpha, audio limiter), with the read-only facts, the raw JSON and the folder path underneath |
| **audio** | audio tracks *inside* this scene — src, start frame, gain, audition — separate from the film's master audio timeline |
| **assets** | the scene's `assets/` folder: upload or drop files, copy a scene-relative path, rename — the dialog asks for the new path, and when audio tracks point at the file it offers, ticked, to repoint them — delete |
| **outputs** | what this scene has rendered, with sizes and download links |

These are the same four panels the scene workbench shows, not a summary of
them: reviewing a film no longer means leaving the timeline to read a format
or check what an asset is called. Settings apply with **apply**; a change that
moves the cut (a new frame count) reflows the film immediately.

**Advice is the first tab on every selection, and it is where a selection
lands.** Not only a scene: the film, a sequence, a timeline lane, a supplied
clip, an audio track, a caption and an overlay all open on `advice`, with the
thing's own properties on the tab beside it. It used to be a *section at the
foot* of the property sheet — below a scene's whole summary, and stood down
entirely on the four deep tabs — so the human's half of this page was the one
thing you had to scroll to find. The tab also carries the **unresolved count**
for that selection, so you can see there is something waiting before you open
it.

The choice sticks per kind. Click `scene` once and later scenes open on `scene`
too, which is what an editing pass wants; the advice tab is still one click
away, and its count is still on the strip. Advising itself is never more than
one click away whichever tab you are on: **✎ advise** and the advice board also
sit on the timeline toolbar.

Selecting the **film** itself — its row at the top of the tree — gives the same
treatment: **advice · film · assets · outputs**, where `assets` is the film's
own folder (master audio, overlays, footage) and `outputs` is what it has
built. There is deliberately no film-level `config` or `audio` tab: a film's
settings are the film tab, and its audio is the timeline.

**open scene ↗** is still there, at the foot of the scene tab — it opens that
scene as its own document tab, for when you want the composition preview, frame
scrubbing or the render job card. It is not a navigation and never leaves the
film: both stay open, one click apart.

**The inspector resizes.** Drag its left edge; the width is remembered between
sessions (280–620px, and never more than a bit over half the window).

### Moving between a film and its scenes

Nothing carries you between them any more, because they are not separate places.
A film and its scenes are documents in the same window: open the film from the
tree, open a scene from the tree or from **open scene ↗** in the film's scene
inspector, and both sit in the tab strip. Click between them.

The film document also accepts deep links, which is what an agent can hand you
in a message:
`/film.html?id=<workspace>/<film>` opens the film,
`&scene=<scene-slug>` selects that scene and parks the playhead at its offset,
`&sequence=<label>` selects a sequence, and `&advice=<id>` opens one piece of
advice. An unknown slug or id is ignored rather than erroring, so a stale link
still opens the film.

The **config** tab (in the scene workbench) is a complete view of
`scene.json`: the composition fields (name/fps/size/duration), the whole
`output` block (format, dir, filename, crf, preset, pix fmt, transparent,
audio limiter), read-only **scene facts** (entry file, schema version,
attached 3D libraries and the exact build each scene vendored), and a
**raw scene.json** disclosure at the bottom. Settings a given format
doesn't use are greyed out rather than hidden — mp4 has no alpha, GIF
ignores crf, and so on — with a note explaining why. Clearing an optional
field (preset, pix fmt, crf) removes it so the format's own default applies
again.

The tab also shows the scene's absolute folder location with a copy button,
and **delete scene…** removes it: unchecked, the scene only leaves its
film's play order (the folder stays on disk, listed as *unlisted* in the
[film editor](#the-film-editor)'s scenes rail); tick *also delete files on
disk* to remove the folder too.

Edit `composition.js` in your editor of choice against the Frame API
([frame-api.md](frame-api.md) — read it before writing your first
composition; the one-paragraph version: everything must be a pure function
of the frame number, no clocks, no CSS transitions, register your function
with `MotionStudio.registerComposition`).

## Assets (v0.15)

The **assets** tab lists everything under the scene's `assets/` folder —
image thumbnails, in-place audio audition, size — and manages it: upload via
the **+ upload** button or by dropping files onto the panel (25 MB per file;
images, audio, fonts, JSON/TXT), rename/move within `assets/`, delete, and
download. **copy** puts the *scene-relative* path (`assets/…`) on your
clipboard — exactly the string a composition or an `audio` track references.
A **♫ n** badge marks files the scene's audio timeline uses; deleting one
asks whether to remove those tracks too (and renaming offers to repoint
them), so a stale reference can't quietly turn into an ffmpeg error mid-render.
The folder's absolute path is shown in the tab header (copy button next to
it) if you'd rather drop large files in with your file manager; anything you
put there shows up on the next refresh. A film has its own `assets/` the
same way — master audio and overlay files, managed from the
[film editor](#the-film-editor) instead of this tab.

## Shared library

Each workspace also has a **⧉ library**: shared assets the human manages
once, that workspace's agent can then pull into any scene or film. It's a
row in the tree below a workspace's films rather than a tab on a scene,
since it belongs to the whole workspace, not to whichever scene happens to
be open.

The library page **uploads** (optionally into a subfolder you type, handy
once it grows past a handful of files), **downloads**, and **deletes** —
deleting asks you to type the filename back, because a library file can be the
plate a dozen scenes were built from. Scenes that already pulled a file in keep
their own copy; this removes the shared original.
Unlike scene and film assets there's no 25 MB cap — the library exists
specifically for the files too big for that channel (a licensed soundtrack,
a folder of location photos, a multi-gigabyte video plate). An agent lists
the library with `list_shared_assets` and pulls a file into a scene's or
film's own `assets/` with `use_shared_asset` — hardlinked where the
filesystem allows, so a large asset costs no extra disk and the scene or
film still renders from a normal, self-contained `assets/` folder. Deleting
a library file doesn't touch copies a scene or film already pulled in.

## Global settings (v0.15)

The **⚙** button in the sidebar footer opens the global configuration (since
v0.25 the footer shows compact labels — `tts · music · trans · ⚙` — so all
four buttons fit the rail; full names live in the tooltips) — since v0.22 an
inline stage page like the
tts/music vendor pages (it replaces the workbench while open; close restores
it), no longer a popup dialog. Since v0.25 the **save** button sits in the
page header like the vendor pages, each section is drawn as its own
accent-barred card, and the header carries the engine status strip
(version · engine · ffmpeg) that used to occupy the sidebar:

- **new-scene defaults** — the fps/dimensions/duration the **new film** and
  **new scene** dialogs are pre-filled with, and what any new film or scene
  gets when its creator didn't specify — including one an agent makes over
  MCP (`create_film`/`create_scene`). Newly created films/scenes only;
  existing ones keep their own.
- **new-film platform defaults** — optional platform versions preselected in
  Studio's **new film** dialog. Leave all clear for master-only by default.
  An AI request that explicitly names YouTube, TikTok/Shorts, or Square always
  wins and is saved as that film's own snapshot; changing this setting never
  alters a film already created.
- **default workers** — the render tab's initial workers selection, and the
  worker count for any render that doesn't name one.
- **delivery review** — comma-separated finding codes to **block** or record
  as a **warning** after an encoded file is staged. The default blocks only a
  frame-count mismatch; dark/static/cut findings stay warnings because they can
  be intentional. A block preserves the prior delivery and leaves staged
  evidence for diagnosis. A film can save a more specific policy through its
  document (for example an agent can use `update_film { review: … }`).
- **ffmpeg** — a binary path override (leave empty to use `ffmpeg` on PATH;
  the dialog live-probes the effective binary and shows its version or a
  ✗ if it can't be run — the engine status strip in the page header updates
  too) and default
  crf/preset values that seed *newly created* scenes' output config.
  The path override applies to every render — the Studio's, the CLI's, and an
  agent's. `MOTION_STUDIO_FFMPEG` overrides it for a single process, and the
  CLI's `--ffmpeg <path>` overrides both (`render.js --doctor` prints which
  binary it settled on and where that came from).
- **storage** (v0.22): where the **data dir**, the **workspaces root** and the
  **settings file** live — editable, not just reported. Leave a box empty for
  its default (shown greyed inside it); a relative path is taken from the
  Motion Studio folder, so `data` keeps the install portable. Under each box is
  the resolved path and where it came from. Folders are created on save and
  **nothing is moved** — point these at a tree that already exists, or copy
  your files across yourself first. The Studio switches over immediately (it
  reloads); connected agents keep using the old location until their MCP server
  is restarted. A field that `MOTION_STUDIO_HOME` / `_WORKSPACES` / `_SETTINGS`
  / `_VENDOR_DIR` already sets is shown locked, because editing it here would
  change nothing. Moving is refused while a render or build is running
  (`storage_busy`) — let it finish first.
  The fourth box, **vendor dir** (v0.25), is where the bundled speech/music
  exes, FluidSynth, SoundFonts, Piper voices, Whisper models and the 3D libs
  are looked up — default: the app's own `vendor` folder. A per-item override
  (an exe path on a vendor card, or an env var such as
  `MOTION_STUDIO_SOUNDFONT`) still beats it; changing it needs no reload —
  the next probe simply resolves against the new root.
- a read-only **environment** report: the bootstrap file that records the
  locations above, plus the current values of the `MOTION_STUDIO_*` env hooks
  (including which **workspace** each connected agent is bound to),
  `PUPPETEER_EXECUTABLE_PATH`, and the speech-vendor variables (API keys shown
  masked, never in full).

Narration and music vendors each live on their own page — **🗣 tts** and
**♫ music** in the sidebar footer, next to ✎ trans and the ⚙ settings button; see
[Generated narration](#generated-narration-text-to-speech) below.

Settings persist in `<dataDir>/settings.json` and are genuinely global:
the Studio, the CLI, and agents working over MCP all honour them. They fill in
what a new scene or render didn't specify — an explicit choice always wins,
so an agent told to make a 4K vertical video still gets one — and they apply
only at creation where they seed a scene. The worker and delivery-review
settings are runtime defaults, so they apply to the next render but do not
rewrite any scene. One thing that file never holds is a credential: API keys
are read from the environment only.

The **☰** at the top of the activity bar hides and shows the Explorer — it
collapses away entirely and the document takes the space. Each workspace's and
film's expanded/collapsed state persists the same way, all remembered per
browser.

The workbench is a fixed half preview, half panel, so switching tabs never
resizes the preview; long tabs scroll inside their half. The **▾** button at
the right of the tab bar collapses the panel when you want the full height
for scrubbing, and clicking any tab brings it back.

## Preview and scrubbing

Selecting a scene loads its *actual entry HTML* into the preview iframe —
the same file headless Chromium renders — and the transport drives it
through the same `window.setFrame(n)` contract. Scrubbing exercises your
real animation logic. Space plays/pauses at the scene's fps; arrow keys step
single frames, shift+arrow steps ten, and Home/End jump to the first and last
frame — the same transport keys the film page has (v0.26). Transparent scenes
preview over a checkerboard.

Saving any scene file hot-reloads the preview automatically (debounced, so
editor save bursts don't thrash), holding your current frame. If an AI agent
edits the scene over MCP while you have it open, you'll see the change
land live — the amber dot in the preview header flashes on each reload.

The preview runs in *your* browser while the final render runs in
Puppeteer's Chromium; these are close relatives but not guaranteed to be the
identical binary, so subtle font-hinting/color differences are possible. The
render path is the source of truth — use the **still ⤓** button (or the CLI's
`--capture-frame`) for a pixel-exact check of any frame without a full
render.

## Rendering

The **render** tab starts a job for the full composition (or a `start-end`
frame range for a cheap pacing check). The workers selector parallelizes
capture across Chromium processes (1, 2, 3, 4, 6, 8, or 10); segments are
merged losslessly at the end. Expect near-linear speedup to about 4 workers,
then diminishing returns beyond that as Chromium instances compete for memory
— watch RAM usage at 6+ workers, since paging (not CPU) is usually the real
ceiling.

**Proxy/motion preview (v0.21):** when you want to check *motion* — pacing,
easing, a camera move — before paying for the real thing, render a proxy: a
half-resolution, every-2nd-frame draft that takes roughly 1/8 the time and
keeps wall-clock duration (it encodes at `fps/frameStep`, so playback speed is
true). Proxies skip audio and the pre-flight probe, always render serially,
and write to `output.proxy.mp4` so they never overwrite your deliverable.
Available via the `render` MCP tool's `proxy` option and the CLI's
`--proxy [scale] --frame-step N` flags; they work with whatever output format
the scene is configured for (scaled dimensions are floored to even numbers
where the encoder demands it).

While a job runs you get a progress bar, effective render fps, an **ETA**,
and live logs. Starting another render while one is running **queues** it
(you'll see `queued #1`); it starts automatically when the slot frees.
**cancel** stops a running job and kills its entire process tree — Node,
every Chromium worker, FFmpeg — or silently drops a queued job. When a job
finishes, a download link appears and the output shows in the **outputs**
tab.

Common failures and what they mean: `composition_error` names the frame
where your JS threw (the message includes the page error);
`frame_timeout` means `frameReady` never flipped true within 15 s — almost
always async work (fonts/images) not awaited, use `registerComposition` with
an async function; `browser_launch_failed` usually means `npm install`
never completed its Chromium download (or set `PUPPETEER_EXECUTABLE_PATH`);
`ffmpeg_failed` includes the tail of FFmpeg's stderr.

Errors surface as **toasts** in the bottom-right corner (v0.20), not
blocking dialogs: the error code appears as a badge, the message — which
already contains the fix and any available alternative vendors — stays until
you dismiss it, and the page remains usable underneath. An unconfigured
music vendor now reports "not configured" (503) on the vendors page the
same way speech vendors always did, instead of a generic server error.

**A tab you are not looking at can still tell you something went wrong**
(v0.27). Start a render, switch to another document, and if it fails the toast
appears in the Studio anyway, with a chip naming the document it came from —
click the chip to go there. Before this, the toast was painted inside the
hidden tab and simply never seen. Only the five most recent are kept, so a
render that keeps retrying cannot bury the thing it is reporting on.

## Output formats (v0.5)

The **config** tab (or `scene.json`'s `output` block) selects the
deliverable:

| format | you get | typical use |
|---|---|---|
| `mp4` | H.264 .mp4, `crf` 18 default | the default; plays everywhere |
| `webm` | VP9 .webm, `crf` ~32 | smaller files, alpha support |
| `gif` | animated GIF (two-pass palette) | short loops; keep it brief — GIF palettes are memory-hungry to build and files get large fast |
| `prores` | ProRes 422 HQ .mov (4444 when transparent) | editorial hand-off / NLE ingest |
| `png-sequence` | a folder of `frame-%06d.png` | compositing pipelines; maximum fidelity |

Switching format automatically fixes the output filename's extension.
`crf` = quality (lower is better/bigger; 0–63). Dimensions must be even for
mp4/webm/prores (chroma subsampling); gif and png-sequence take any size.

**Do not set mp4 `crf` to 0 for "maximum quality."** CRF 0 makes x264 encode
*lossless* H.264, which the spec forces into the High 4:4:4 Predictive
profile — a profile most players (Windows Movies & TV, phones, TVs,
browsers) cannot decode. The symptom is black video with working audio, and
it looks exactly like a broken render even though every frame is in the
file. The render still succeeds but logs a `[warn]` and reports
`encodingWarnings` in the job status. Use `crf` 18 (the default) for
visually-lossless mp4 that plays everywhere; if you truly need lossless,
use `prores` or `png-sequence` instead.

**Transparency**: tick *transparent (alpha)* (webm, prores, or png-sequence
only), give your composition a transparent background (no `background` on
`html/body`), and everything unpainted renders as alpha 0. The result drops
onto any timeline as an overlay — see `examples/lower-third`, which ships a
real transparent `lower-third.webm` and a proof composite over green.

## Audio

Use the **audio** tab, or add tracks to `scene.json` directly:

```json
"audio": [
  { "src": "assets/music.mp3", "gainDb": -6, "fadeOutFrames": 30, "duck": true },
  { "src": "assets/voiceover.wav", "startInFrames": 45 }
]
```

The tab edits exactly this list: **+ add track** appends a row, `src`
autocompletes from the scene's audio assets, the start frame shows its
equivalent in seconds as you type, and ▶ auditions the file. Edits are staged
until you press **save tracks**, so a half-typed path never reaches disk.

Each track can start at a frame offset and carry a gain in dB; multiple
tracks are mixed without normalization (so adding a quiet track doesn't duck
the others) and the result is trimmed/padded to exactly the video's length.
Drop the files in `assets/` and re-render. mp4 muxes AAC, webm muxes Opus,
prores muxes PCM; gif and png-sequence cannot carry audio (tracks are
skipped with a warning in the logs).

Since v0.19 a track also takes (all optional, all in frames):

- **`trimStartInFrames`** / **`trimEndInFrames`** — the window of the SOURCE
  file the clip plays, `[start, end)`. `trimEndInFrames` alone means what it
  always did — keep the clip's first N frames — and `trimStartInFrames`
  (v0.27) drops the head, which is the trim the timeline could not offer
  before.
- **`fadeInFrames`** — fade up from silence at the clip start.
- **`fadeOutFrames`** — fade to silence ending at `trimEndInFrames` if set,
  otherwise at the composition end. A music bed longer than the video now
  resolves instead of cutting off at the last frame.
- **`duck: true`** — sidechain auto-ducking: this track is compressed by the
  mix of all *non*-ducked tracks, so a bed dips while narration speaks and
  recovers in the gaps. Engages only when ducked and non-ducked tracks both
  exist.

### Hearing the mix before a render (`preview_audio`, v0.19)

The `preview_audio` MCP tool mixes a **scene's or a film's** audio timeline
to `out/audio-preview.wav` using the exact filter graph the render (or film
build) will use — delays, gains, trims, fades, ducking, limiter — with no
video pass. It reports
the mixed `peakDb`/`meanDb`, a `clipping` flag, and each source clip's own
level, so a bad balance names the track that caused it. Seconds instead of a
full render.

The `mix` block also carries `envelopeDb` — the mix's RMS level per second,
with `null` marking digital silence — and `silentTailSeconds`, the length of
the dead run at the end. Whole-file peak/mean can look perfectly healthy while
the last seconds are silent; the envelope makes a mix that dies early visible
in the tool result instead of only in the rendered film.

The result's `balanceWarnings` list flags the opposite of clipping: a track
whose effective level (its own measured mean plus its `gainDb`) sits 8 dB or
more below a louder track playing at the same time. Such a track is almost
certainly inaudible in the mix, yet the render succeeds and nothing clips —
the mix only got quieter — so without this check the only symptom is "I can't
hear one of my tracks". Gains should compensate each file's measured level,
not apply a fixed template. Mark an intentional background layer `duck: true`
and it is exempt. The final render runs the same check: warnings appear as
`[warn]` lines in the job log and in the completion status's `audio` block.

### Generated narration (text-to-speech)

You can synthesize a voiceover instead of supplying an audio file. An agent
calls the `synthesize_speech` MCP tool (see [tts-setup.md](tts-setup.md))
targeting a scene or a film: it speaks your text to
`assets/narration-<n>.wav` in that target's own `assets/`, reports the
clip's length in frames, and — in the default `attach` mode — adds it to the
`audio` list above (a scene's own list, or a film's master timeline) for
you. The synthesized WAV mixes through the exact audio path described above.

Since v0.17 the voice comes from one of several **speech vendors**, chosen on the
**🗣 tts** page in the sidebar footer.

- **system** — the local Windows speech executable
  (`MOTION_STUDIO_TTS_EXE`). Offline and free, but Windows-only and limited to
  the voices installed on the machine.
- **azure** — Azure AI Speech: several hundred neural voices across ~140
  locales, with expressive styles, on any OS. Needs an Azure Speech resource;
  set `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in your Windows environment
  (`setx AZURE_SPEECH_KEY "<key>"`, then restart the Studio). Keys are read from
  the environment only and are never written into `settings.json`.
- **piper** *(v0.18)* — [Piper](https://github.com/OHF-Voice/piper1-gpl) neural
  voices running on this machine: no account, no billing, no network, any OS.
  Install it yourself (`pip install piper-tts`, GPLv3) and download the voices
  you want — two files each, an `.onnx` and its `.onnx.json`, from
  huggingface.co/rhasspy/piper-voices — into the folder named by
  `MOTION_STUDIO_PIPER_VOICES`. Everything in that folder shows up in the
  picker.

Since v0.22 the page shows **one vendor at a time behind tabs** (six cards made
it a long scroll); the tab strip opens on whichever vendor would actually run.
Each card shows the vendor's live status, what it is missing if it is
unavailable, its voice catalogue (filterable by locale), and a **▶ test** button
that speaks a line so you can hear a voice before committing a render to it.
The music page uses the same tabs.
Whichever vendor you save is used by the Studio *and* by every agent connected
over MCP; a tool call can still name a vendor explicitly for one clip. If the
selected vendor isn't configured, the speech tools return `tts_unavailable` and
the rest of Motion Studio is unaffected.

**Starring voices for agents (v0.22).** The **☆** next to each vendor's voice
picker stars the selected voice; starred voices show as chips at the top of
the page (click to remove) and save as `tts.favoriteVoices`, keyed by vendor.
Connected agents see them in `list_vendors` and are instructed to prefer a
starred voice when a request doesn't name one — the speech twin of the music
page's starred instruments. An explicit voice in your request still wins.

#### Ticking more than one vendor (preference chain)

The vendor boxes are checkboxes, not radio buttons: tick **several** and the
highest-ranked one that is actually set up gets used. Rank them with the ▲▼
buttons — the badge on each card shows `#1`, `#2`, … and the line above the cards
always says which vendor will really be used, plus anything it skipped.

The point is resilience, not variety: with `azure → piper`, narration uses the
good cloud voices while the key is valid and keeps working offline the moment it
isn't. Three things it will *not* do — a vendor you name explicitly in a tool call
is never swapped for another; only vendors that are **unconfigured** are skipped
(one that fails partway through a clip is still an error); and it never happens
silently, so expect a warning line here and a `vendorNote` on the tool result.

One caveat: the choice is made per clip. Across a long film, a vendor that stops
being available halfway through changes the voice from that point on. If a film's
narration has to be one voice no matter what, tick exactly one vendor — that is
still the default — and let it fail loudly instead.

### Generated music (note specs)

Music works the same way: an agent authors a short note spec and
`synthesize_music` renders it against a General MIDI SoundFont into `assets/`,
adding it to the audio timeline. The **♫ music** page in the sidebar footer
picks who renders it:

- **node** *(default)* — renders the SoundFont in-process. Works on any OS,
  needs nothing installed beyond the SoundFont that already ships, and is about
  four times faster than the external chain.
- **fluidsynth** — the original v0.8 pair of executables
  (`MotionStudioMidi.exe` + `fluidsynth.exe`). Windows-only, and you build or
  download them yourself.

Both read the same SoundFont and sound the same; **▶ listen** renders a short
phrase on any of the 128 General MIDI instruments through whichever vendor would
actually be used, so you can audition a SoundFont before committing a film to it.
Ticking both makes a preference chain, exactly as on the tts page above. The
**target peak** control (default −3 dBFS) applies to both vendors and only ever
attenuates, which is what keeps a bed at the same loudness against your
narration when you switch. See [music-setup.md](music-setup.md).

**Starring instruments for agents (v0.22).** Next to the audition picker, the
**☆ favorite** button stars the selected instrument; starred programs show as
chips (click one to remove it) and save with the music settings as
`music.favoritePrograms`. Connected agents see the list in `list_vendors` and
are instructed to prefer starred programs when composing — so auditioning
sounds you like directly steers what generated music uses, instead of every
piece defaulting to piano and strings. An explicit instrument in your request
still wins.

### Reading a recording you supplied (transcription, v0.22)

The two pages above make audio. The **✎ trans** (transcription) page in the sidebar footer
configures the one thing that *reads* it: `transcribe_asset` turns a recording you
supplied — audio or video — into text with per-sentence and per-word timing, which
is what lets an agent cut your talk on sentence boundaries and land a caption on
the word being spoken.

It runs **whisper.cpp** entirely on this machine: one binary plus one model file,
no account, no API key, no network. Point the page's **executable** box (or
`MOTION_STUDIO_WHISPER_BIN`) at `whisper-cli` — **or at the folder holding it**,
including the root you unzipped; the engine looks inside for the binary and
tells you where it found it. Keep a `ggml-*.bin` model in a `models` folder
beside it (the layout every prebuilt release already has, and the page finds it
automatically), and restart. Until then the page says exactly what is missing
and every transcription call fails with `transcription_unavailable` rather than
half-working.

The page's test is the inverse of the tts page's: instead of typing a line and
hearing it, you **choose a recording and read what came back**. It shows the
re-segmented sentences with the `start` and `frames` numbers an agent would place a
caption at, the confidence of the least certain word in each (low values in red —
those are the captions that would be wrong on screen), and how many times realtime
*this* machine reads speech. That last number is the one worth knowing before you
build a film around a long recording. See
[transcribe-setup.md](transcribe-setup.md).

Transcriptions run in their own job lane, so one never waits behind a render — and
results are cached, so an agent asking the same question twice costs nothing.

### Footage a connected agent can prepare and place (v0.22)

Two things an agent could not do before this release, both about video *you*
supplied rather than animation it wrote:

- **Put your footage on the film timeline.** A film's play order can now hold
  footage segments beside rendered scenes, so a film can be "your clip, then a
  graphic, then your clip". The film editor shows them as distinct blocks (▣, a
  warmer fill, no render dot — they were never rendered), and **+ footage** puts one
  on the timeline, reading its frame count from the file rather than asking anyone
  to type it. Footage joins without re-encoding, so it has to match the film's
  resolution/fps/format and must be silent — its sound belongs on the master audio
  timeline.
- **Conform a clip so it can.** `transcode_asset` trims to an exact frame count,
  crops, scales, and re-encodes to the film's own settings; it also extracts and
  joins spans of audio into a single WAV. It has no ffmpeg-argument passthrough by
  design — every operation is a named field — and it never overwrites your source.

Together these mean a film built around your own recording no longer needs anyone
to run ffmpeg by hand. See [film-setup.md](film-setup.md#footage-on-the-timeline-v022).

## Watching and advising: the film page (v0.23)

Clicking a film opens **its one page**. It exists for the workflow Motion
Studio is built around: an AI directs production unattended, and you return
whenever you like, watch what it made, and tell it what you think. Nothing
here asks for approval, and nothing waits for you.

Everything is on one surface — player, tree, timeline, and the full editor.
There is no separate review screen and no mode to pick: one film, one
timeline, one set of rules.

### Watch & advise

- **The tree is the film.** The left rail reads `Film → Sequence →
  Scene/Footage`. Click a sequence and the playhead jumps to its start and
  its band lights up; click a scene or clip and the matching timeline block
  selects. Scene folders the film does not play sit below as **unused
  scenes**. The timeline gains a **sequences** band above the scenes row and
  an **advice** row of markers below the tracks.
- **Click to aim, then say it.** Select anything — a sequence, a scene, a
  supplied clip, an audio item, a caption, an overlay — and press **✎ advise**
  (or `A`). A small popup opens on exactly that thing, showing what it is and
  where you are in the film, with one comment box. Press advise with nothing
  selected and the next click on the tree, timeline or picture becomes the
  target; `Esc` cancels.
- **The film and a whole lane are things too.** Click the **top row of the
  tree** — the film's own name — to aim at the entire film: *"it drags in the
  middle"*, *"the whole thing is one energy level"*. Click a timeline row's
  **head** (`sequences`, `scenes`, `audio`, `captions`, `overlay`) to aim at
  that lane: *"every caption lands a beat late"*, *"this bed is fighting the
  narration all the way through"*. Both light up when selected, both carry
  their own unresolved count, and both are one sentence instead of the same
  sentence repeated per block. The **advice** row at the bottom is the record
  of this conversation rather than a part of the film, so it is not a target.
- **The advise button never moves.** It sits on the **timeline toolbar**, past
  `snap`, and it names what it is aimed at — `✎ advise · test3` — so pressing
  it is never a guess. The same button heads the inspector's **advice** tab —
  the first tab on every selection, and the one a selection lands on — beside
  the conversation about that exact thing; both do exactly the same thing, so
  use whichever is closer.
- **The whole conversation, in one popup.** The `≡` button beside advise (or
  `Shift+A`) opens the **advice board**: every piece of advice on this film,
  grouped by what it is about and ordered down the cut, with *open*,
  *answered* and *all* filters and a running `N open · M answered`. It fills
  the screen the way the other dialogs do, which is what makes the AI's
  before/after frames worth looking at — in the inspector they are thumbnails.
  Click an entry to open it in place and read what the AI did about it; click
  **go to it ↗** (or a target heading) to close the board and take the film to
  that exact moment. `Esc` or `×` closes it. Each entry carries its own
  **withdraw**, and the foot has **withdraw all N open**.
- **Nothing to fill in.** The target, the frame, and what you were watching
  are captured from your selection, and a frame grab of that exact moment is
  stored with your words. Close the browser whenever — advice is on disk and
  the AI finds it at its next checkpoint. Statuses are the human ones:
  *advice sent → AI received it → AI is working on it → updated* (or *AI
  reviewed it* with a short reason, or *AI needs more information* with a
  question you answer inline). Opening one shows the AI's explanation and
  the before/after frames.
- **You can take it back.** Every still-open item has a **withdraw** button,
  and the section foot has **withdraw all N open across the film**. Use it for
  a typo, a duplicate, or a note you thought better of — otherwise it is
  re-served to every later AI run. Withdrawing *closes* rather than deletes:
  your wording, the event log and the evidence stay on record, the timeline
  marker turns resolved instead of vanishing, and the card reads *you withdrew
  this* rather than crediting the AI with a decision it never made.
- **Every version is kept.** Select a scene and its **advice** tab lists the
  **versions** — each completed render, archived with its date, author and
  the AI's one-line note. Click a take to watch it *in place* in the film;
  previewing changes nothing. If an older one was better, **ask AI to use
  this** (also offered right in the advice popup as *previous result*). That
  sends high-priority advice naming the exact take; the AI normally switches
  to it (no re-rendering — it is archived), may derive something better from
  it, or explains why not. The page never changes production itself.
- **Preview or the real thing.** The player normally stitches the scenes as
  they stand right now. Switch it to **built film** to watch the last film
  the AI actually assembled, with its real mix, overlays and burned
  captions; that player pins one archived build and never switches beneath
  you. A newer build offers itself in a banner, and a build whose length no
  longer matches the cut says so rather than pretending.
- **Honest progress.** The header shows what the AI reports it is doing
  ("Creating scene demo-shot"), live; when its heartbeat goes stale you see
  *waiting for the next AI run* — completed work and your advice are
  unaffected.
- **No film built yet?** Everything above still works against the scene
  preview: the tree, the timeline, and advice on any scene, clip or track
  item.

### The production controls

They are always available: the add row (`+ narration`, `+ audio`, `+ caption`,
`+ footage`, `+ overlay`), snap, drag-to-reorder and edge-trim, the full
property inspector, undo/redo, per-scene render and **build film**. Scenes are
added from where the scene folders actually are — the rail's **+ new scene**,
or by dragging one from the rail onto the timeline. Sequences are drawn
straight onto their lane, resized by dragging a band's edges, reassigned per
segment from the inspector, and named, ungrouped and annotated there too;
*Film: New Sequence from Selection* in the command palette is the keyboard
route to the same create. The advice tab stays a click away in this mode too,
so the conversation is never a mode away.

In watch mode none of that can fire: dragging a block only selects it, and
Delete does nothing.

## Long-form films (multiple scenes)

A single composition is the right size for a shot, not for minutes of video.
For anything longer, start a **film** and give it several **scenes** — each
one inherits the film's width/height/fps, so they're concat-compatible by
construction — render each, and let the film's assembly stitch them
together. Assembly concatenates the rendered scenes **losslessly** (`-c
copy`, no re-encode) into one continuous video, so each scene stays a short,
independent, resumable render — fix one scene, re-render only it, re-stitch
in seconds.

### The film editor

The editor *is* the film page — the same surface you watch and advise on (see
[Watching and advising](#watching-and-advising-the-film-page-v023)).

Creating a film (**+ film** in a workspace, or `create_film` over MCP) opens
it right away — there's no separate save step and no more dedicated "…—
Master" project: the film folder itself holds the assets and output. The info
bar shows the film's **workspace** and name. The left rail is the `Film →
Sequence → Scene/Footage` tree — the play order, read top to bottom — with
any scene folder the film does *not* play listed below it as an **unused
scene** (made by an agent, or copied in by hand) ready to drag in. The right
panel is the context inspector — a selected scene explains itself there in
full, across the tabs described above — and the **build panel** docks there
too, so assembling never covers the timeline. Drag the inspector's left edge
to widen it. The timeline holds a sequence band row,
scene/footage blocks, audio, caption and overlay tracks, and an advice row:

- **sequences** — the narrative band above the cut. Consecutive segments
  sharing a label are one sequence; there is nothing else to it, which is why
  regrouping never moves a file or invalidates a render. Because a sequence
  *is* a run of segments, every way of changing one is a way of moving a
  boundary (v0.28):
  - **Make one by drawing it.** An unnamed stretch of the lane reads *drag to
    make a sequence*. Drag across it: a marquee snaps to cuts and the tooltip
    names what it is taking — `3 segments, "one" → "three" · takes 1 from
    "Act II"` — so you can pull past the end of the unnamed run to take scenes
    off the sequence next door. Let go and the band is there, named
    `sequence 1`, with the caret already in the inspector's **name** field and
    the placeholder selected: type the real name and press Enter. Nothing is
    asked up front, because the band itself is the answer — and Ctrl+Z undoes
    the whole thing in one step.
  - **Drag either edge of a band** across a cut to change what is in it.
    Outward takes segments off the neighbouring band; inward hands them back,
    or — at the ends of the film — out of the sequences entirely. The edge only
    lands on a cut, and never crosses the band's far edge, because a band with
    no segments is an *ungroup*, which is its own action.
  - **The segment inspector's `sequence` picker** does the same edit from the
    keyboard: the band before, the band after, no sequence, or a new one. It
    applies to the selected segment **and the rest of its band**, and the note
    under it says how many that is. Those are the only choices on offer,
    because any other label would put one sequence name on two stretches of
    film with somebody else's in between. To move a segment somewhere else
    entirely, use **move earlier / move later**.
  - **Make one from the keyboard.** *Film: New Sequence from Selection* in the
    command palette (`Ctrl+P`) does the same create at the selected segment or
    the one under the playhead. On unnamed film it takes exactly that segment;
    aimed inside an existing sequence it takes the rest of that sequence,
    splitting it at the cut. (It used to label everything from the selection to
    the end of the film, and to start from segment one whenever the selection
    was empty — which is how pressing it swallowed a whole film into a single
    sequence.) It had a **+ seq** button in the rail and a **+** on the
    sequences lane head; both are gone, because drawing on the lane is the
    gesture and two extra buttons for it were three routes to one thing.

  The inspector holds the **name** (a field — a name another band already uses
  is refused rather than merged), an **intent** note the AI reads, and
  **ungroup**, which returns those segments to unnamed film ready to be drawn
  over again. `Delete` on a selected band ungroups it too; it never deletes
  scenes. A scene dropped inside a sequence joins it rather than splitting the
  band in three. **Double-click a sequence** — its band on the timeline or its
  row in the tree — to zoom the timeline to exactly that stretch of film
  (v0.26); double-click the empty timeline background to fit the whole film
  again.
- **scenes and footage** — **drag a scene from the unused list onto the
  timeline** to place it (an insert marker shows where it lands); drag blocks
  to reorder. **+ new scene** at the
  foot of the rail scaffolds a fresh scene folder directly into the film, and
  the **⧉** on a scene row duplicates an existing one instead — the whole
  scene, composition files, assets, vendored 3D libraries and settings alike.
  It is the safe version of the hand-copied folder that otherwise turns up as
  an unused scene. It asks for a name (offering the source's plus “(copy)”),
  stays inside this film, and appends the copy to the play order. What it does
  *not* copy is the render: the duplicate starts unrendered, and anything about
  it that would break the build — a duration or size that no longer matches the
  film — comes back as a warning you have to dismiss rather than something
  silently accepted.
  Incompatible/unrendered scenes and footage with a mismatched signature or
  frame count are flagged before a build. Prepared footage can retain the
  source record returned by `transcode_asset`; its inspector status is
  **source verified** until the original file changes. A changed or missing
  source stops the build and needs a fresh preparation pass. Scene and footage
  blocks are butt-joined — a film has no gaps — so order is the only thing to
  drag.
- **audio** — a master timeline laid over the whole film (it replaces
  per-scene audio, same rule as `build_film`). The **+** on a lane head places
  an asset at the playhead **in that lane**; the picker lists the film's audio
  assets with a **▶ to listen to each one before you place it** (a second
  click stops, and closing the dialog stops it too), so choosing between eight
  `bed-*.flac` takes is not guesswork. “+ narration” synthesizes speech
  through your configured vendor right into the film, and can drop a **synced
  caption per sentence** and duck the music bed under the voice in the same
  click. Tracks show decoded waveforms of **the part you kept**; drag to move,
  drag **either edge** to trim, and set gain / fades / **duck** in the
  inspector.
**Lanes are yours (v0.27).** Audio, captions and overlays each hold as many
lanes as you make. Every lane head carries the same three controls, in the same
three columns down the whole timeline: **♪** mutes (audio only), **+** adds
an item *into that lane* at the playhead, and the third is the lane itself —
**⊕** on the last lane adds an **empty** one below (no file needed, and it
stays through a drag, a reload and an agent's edit), **✕** on an empty lane
takes it back. Drag a block **up or down** to move it between lanes; the target
lights up as you cross it, and the lane you drop it in is remembered.

**A lane head is also the lane itself.** Click its name — anywhere but those
three buttons — to select the whole row, on the `sequences` and `scenes` rows
as well as the three that stack. The inspector then says what is standing in
it, and **✎ advise** aims at the row rather than at one block: *"every caption
lands a beat late"* is one sentence, not one per caption. A row with
unresolved advice on it carries the count beside its name.

**Muting is real.** A muted lane's clips leave the mix — the preview you play,
`preview_audio`, and the built film alike — rather than just going quiet in the
editor. The head lights amber and its label is struck through; the clips in it
dim. Mute belongs to the **lane**, so a clip you drag in afterwards is silent
too, which is what muting a track means in any editor. A single clip can also be
silenced on its own with **mute this track** in the inspector. Nothing is
deleted either way: unmute and it all comes back.

**Muting says which lane a clip is in, out loud.** A film the AI wrote does not
record a lane per clip — the MCP tools never asked for one — so the timeline
draws it by packing the clips into the fewest rows that fit. That picture is
only this page's; the mix reads the clips' own lanes, and with none written
down every clip is lane 1 to it. Muting therefore **writes the rows you can see
down first**, the way dragging a clip between lanes always has, so the lane
silenced is the row you pressed. Open a film that was muted before this and it
repairs itself: the lane you muted stays muted, the tracks that should never
have gone with it come back, and a note says how many did.

**The timeline has its own edge.** Drag the line above the toolbar to trade
height between the player and the tracks — four audio lanes plus captions and
overlays do not fit in the default 300px, and a film you are only watching does
not need them. Double-click the edge to put it back, and the height is
remembered per browser. The player re-fits as you drag.

**Muting while the film is playing** stops that audio immediately and the mix
re-renders around it, rejoining a moment later at the same playhead — you do
not have to stop and press play again. It is a re-render rather than a fader
because the preview is **one ffmpeg mix of the whole film**, which is what
makes it the build's own graph (gains, fades, ducking, limiter); a mute applied
only to playback would be a mute the finished film did not have. (Muting *every* track makes
the film silent — the mix refuses with a sentence saying so rather than
rendering silence you did not ask for.) Before this, lanes were drawn by packing whatever overlapped
into the fewest rows, so a lane appeared and vanished under the mouse as you
dragged clips apart, and an empty lane could not exist at all.

**Trimming works from both ends (v0.27).** The **left grip** moves the clip's
**in-point through the file** while the audio under your cursor stays where it
is — that is how you drop two seconds of room tone off the front of a take
without re-cutting the file. The right grip still sets the out-point. The
inspector shows both as **trim in / trim out**, in source frames, and the
waveform redraws to the window you kept. Captions and overlays already had
both edges; footage does not, by design — a footage clip joins the film
without re-encoding, so trimming one is `transcode_asset`'s job.

- **captions** — text blocks with frame-accurate in/out. A `.srt` sidecar is
  always written next to the built film; tick **burn captions** to also
  render them into the picture (size/position under the film inspector).
- **overlay** — images (logo, watermark) or videos (a transparent `.webm`
  stinger keeps its alpha) composited over the film: position/width in % of
  frame, opacity, frame-accurate window.
- **advice** — a marker per piece of human advice, wherever on the film it
  was left. Clicking one selects what it was about and opens it. Blocks and
  tree rows carry a small count badge while advice on them is unresolved.

The **preview plays your real rendered scenes** back to back with overlays
and captions drawn in place. With a master timeline, pressing play builds the
mix through **the exact ffmpeg graph the final film uses** (gains, fades,
ducking, limiter) — what you hear is what ships. Snap, zoom, undo/redo and
autosave behave the way you'd expect from an NLE; Space plays, arrows step
(shift for ten), Home/End go to the ends, and Del removes the selected block.
`A` advises on the selection and `Shift+A` opens the advice board.
**PgDn/PgUp move the playhead cut to cut** — the next and previous scene
boundary — and **shift+PgDn/PgUp** move it sequence to sequence (v0.26), which
is the granularity a film is actually reviewed at. They are spelled out in the
transport buttons' own tooltips; the toolbar line that used to list them cost
a whole row of a timeline already short of height (v0.28).

**You and the AI share this document, so the page watches for its edits.**
When the AI changes the film while you have the page open, a page with nothing
unsaved quietly catches up on its next refresh. If you *are* mid-edit, the save
indicator reads **changed elsewhere** and your work is left alone. Should you
save anyway, the save is refused rather than applied: an edit here is a
statement about the *whole* scene order, so letting it through would wipe out
whatever the AI just did. The page then reloads and tells you that last change
was not saved — make it again on top of the new version. Losing one edit is
the point; the alternative is silently losing the AI's.

**↻ reloads the film** (in the header, beside undo/redo). A browser reload from
here takes the whole shell with it — every open document goes back to the
Studio home — so the page has its own. It saves anything outstanding first, so
the reload cannot eat it, then re-reads the film, its plan, its assets and the
production loop, and throws the rendered audio mix away so the next play is
made from what is on disk now. It clears the undo history, because those
snapshots describe the document as it was before the reload and replaying one
over the AI's work is exactly the clobber above. Reach for it when a page has
been open for hours, or when something looks stale and you would rather re-sync
everything at once than work out which part.

The empty right-side inspector also contains **platform versions**. It shows the
versions the AI or new-film dialog chose, lets you add/remove a saved preset,
choose its output name and caption style, and set a default or per-scene crop
focus. These controls change only that delivery version; timing, cuts, master
audio and captions remain the one shared film edit. Its contact sheet later
draws the version's caption-safe guide so the final portrait crop can be judged
from the actual encoded picture.

**build film →** opens the build panel in the right-side column (the
timeline stays visible and editable) and assembles: lossless concat,
master-audio mux with optional **master-to-peak** (measure the mix, shift
every track by one offset, re-mux once — your balance survives), then — only
if the film uses overlays or burned captions — a single finishing encode.
The panel shows live progress (the header button carries the percent even if
you switch back to editing) and, when it lands, the measured
`peak/mean dBFS` of the mix, a download link, and an **Output review** contact
sheet. Its badges point to the encoded film's black/static/cut findings and
caption/cut frames; the list below it records the exact policy severity. The
same `<base>.review.json` and `<base>.contact.png` live beside the movie in
`out/`, so the review survives a reload and is available to agents too. Choose
**master** or a saved platform version in the panel; a platform version is a
target-size reframe of the approved master, with its own output/SRT/review files.
**build master + all versions** runs every saved delivery in sequence with separate
staged output names — it does not rebuild the edit by hand.

Films are shared with the agent whose workspace they live in: `update_film`
and `build_film` over MCP edit and build this same `film.json`, so a film you
re-cut here is the one the agent rebuilds, and vice versa. See
[film-setup.md](film-setup.md) for the underlying model, the quality
pipeline, and how it scales to arbitrary length.

## The CLI

Everything the Studio does is scriptable. `<folder>` is any scene folder —
for example one under
`<dataDir>/workspaces/<workspace>/films/<film>/scenes/<scene>/`, or a
standalone composition folder like the ones under `examples/`:

```bash
node src/cli/render.js --scene <folder> --output out/clip.mp4 --workers 4
node src/cli/render.js --scene <folder> --frame-range 0 59 --output out/pace-check.mp4
node src/cli/render.js --scene <folder> --proxy 0.5 --frame-step 2 --output out/clip.mp4   # → out/clip.proxy.mp4
node src/cli/render.js --scene <folder> --capture-frame 42 --capture-out check.png
node src/cli/render.js --doctor
```

Progress streams to stdout as JSON lines (see
[architecture.md §4](architecture.md)); exit codes: 0 ok, 2 bad args,
3 prereqs missing, 4 cancelled, 1 render error.

## Connecting an AI agent

See [mcp-setup.md](mcp-setup.md). An agent works inside its own
**workspace** (`MOTION_STUDIO_WORKSPACE`) — the Studio shows every
workspace, but a given agent only ever sees its own — and can create films
and scenes, author compositions, supply assets, pull files from the
workspace's shared library, and render on your behalf. Every agent is
sandboxed to its workspace's scene and film folders: no arbitrary file
access, no shell.
