# Production workflow — reproducible delivery, aspect variants, reusable libraries

Rewritten 2026-07-29, replacing the first draft of this file. That draft proposed
a new `cut-list.json` above `film.json` as the editorial source of truth, aspect
"layout profiles" with named slots, and a promotion state machine. Audited
against the tree, roughly half of it was already shipped and its centrepiece
would have made reproducibility *worse*. What survives — plus what the draft
missed about reuse — is below.

## The lesson, restated for this engine

> One authoritative record per layer, and every derived artefact is regenerated
> or invalidated from that record. A 16:9, 9:16 or square deliverable should be a
> render selection, not a hand-built second edit. A motion pattern or a music bed
> used twice should be a library entry, not a copied folder.

**`film.json` is already that record** and stays that record. It holds every
timing relationship in integer frames at one fps, `validateFilm` runs on every
save, `planFilm` resolves offsets non-throwing with a structured `problems` list,
footage durations are probe-verified before a build is paid for, and the render
sidecar refuses to assemble a scene whose settings have since changed. Nothing
below adds a document above it.

### Why not a cut list

1. **It would be authoritative in name and stale in practice.** The Studio edits
   `film.json` directly (`PATCH /api/films/:fid`, plus the timeline drag in
   `studio/public/film.js`). A cut list above it desynchronises on the first drag
   unless the whole editor is rewritten to edit the cut list instead — a project
   an order of magnitude larger than the problems it solves.
2. **The gaps it identified are fields, not a layer.** Footage provenance
   (P1-1) and per-deliverable reframing (P0-3) are two additions to segments that
   already exist.
3. **Derived-media invalidation already works.** `transcode_asset` writes
   `<out>.transcode.json` keyed on source bytes + mtime + effective request +
   film signature, and returns `skipped: true` when nothing changed
   (`core/transcode.js:266-288, 373-387`). That is the whole P1-1 acceptance list
   from the draft, shipped.

## What is already true (do not rebuild)

| Draft claim | Reality in the tree |
| --- | --- |
| Timing distributed and unvalidated | `planFilm` (`core/films.js:591`) resolves layout, per-scene render state and problems before any encode |
| Derived media drifts, no idempotence | `transcode_asset` sidecar + identity check, above |
| Captions have two competing timelines | `film.captions` is the single record; the `.srt` sidecar and the burned `.ass` both compile from it (`core/films.js:1006-1016`) |
| No machine-readable validation | `measureRenderedPicture` reports motion/static/black runs, per-cut deltas and warnings; every build returns its summary (`core/render-review.js`, `core/films.js:1050`). `inspect_render` and `measure_render` are live MCP tools |
| No shared-asset reuse | Per-workspace `library/`, hardlinked into `assets/` on use (`core/store.js:1064-1190`), with `list_shared_assets` / `use_shared_asset` and a Studio panel |

## The real defect the draft found

`renderScene` streams ffmpeg straight into `out/output.mp4`
(`core/renderer.js:481`); `buildFilmArtifact` writes its finishing encode straight
to the delivery path (`core/films.js:1031`); and the `audioTargetPeakDb`
correction **re-muxes over the delivery file** (`core/film.js:428`). A cancel or a
crash therefore damages the delivery, in one of two shapes:

- **Truncated.** The encode dies mid-write and a short but perfectly valid video
  is left at the delivery name.
- **Destroyed.** Worse, and specific to a scene with audio: `core/renderer.js:528-545`
  *renames* the finished video to `.video-only` and muxes back onto the delivery
  path. A failure during the mux leaves **nothing at the delivery name at all**,
  plus an orphan — the previous delivery is destroyed before its replacement
  exists.

The consequence the draft missed is the serious one: nothing deletes the
*previous* `.render.json`, and `writeRenderMeta` runs only on success and only
for a full-scene render (`isFullSceneRender`, `core/renderer.js:278`). So a
**re-render at identical settings that dies mid-encode** leaves a sidecar that
still matches the live config over a partial file — `planFilm` reports
`rendered: true, renderVerified: true` and `build_film` stitches it. (Change any
setting and `renderStaleness` catches it; it is the *retry* that is unsafe, which
is exactly the case that follows a failure.) This is a correctness bug, not
process hygiene, and it is why P0-1 leads.

---

# P0 — the delivery path

## P0-1 — Encode to staging, validate, promote atomically

**Status — implemented 2026-07-29 for single-file deliveries.** Scene renders
(including proxy, partial, and custom-file exports), parallel renders, film
builds, and mastering re-muxes now stage under `.staging/`, validate before one
rename promotion, and report `promoted` plus explicit `framesVerified` state.
Canonical scene sidecars record the promoted file's bytes + mtime identity, so a
replaced file at identical settings is stale rather than trusted. Regression,
MCP, Studio, and full-engine tests cover the previous-delivery retry case,
status fields, and hidden staging output. PNG sequences remain directory
deliveries and need their own directory-promotion protocol; they are not
misrepresented as atomically promoted files.

**Build.** Every encode writes to `out/.staging/<base>-<jobId><ext>`. On success:
verify frame count, then `rename` onto the delivery path, then write the sidecar.
On failure or cancel: leave the staging file for diagnosis, never touch the
previous delivery, never leave a sidecar vouching for it.

Applies to three paths. Two already reach for an intermediate file (`films.js`'s
`ms-filmbuild-` tmpdir, `renderer.js`'s `.video-only`) — but the second reaches
for it *by moving the delivery aside*, which is the destructive shape above. The
change is to make staging the rule, and to make it always a separate file rather
than a displaced delivery:

- `renderScene` / the parallel renderer → scene `out/`
- `buildFilmArtifact` assemble + finishing pass → film `out/`
- the mastering re-mux, which must never be the file a caller can read

**The sidecar is written at promotion, and nothing is deleted up front.** An
earlier draft of this plan said to remove the existing sidecar before encoding.
That was a fix for the *old* shape, where the encode overwrote the delivery in
place; with staging it is actively wrong. The previous delivery survives a failed
attempt intact, so its sidecar is still an accurate description of it, and
deleting it would make a perfectly good output look unverified. A failed attempt
belongs in job history, not in the delivery's metadata.

**Promotion order is video first, then sidecar** — and that ordering is the
safety property, so state it where it will not be "tidied" later:

- Video promoted, crash before the sidecar → the old sidecar disagrees with the new file, so the scene reports **stale** (re-render, wasteful but safe), or **unverified** if there was no sidecar. Both are states the engine already handles.
- The reverse order is the unsafe one: a promoted sidecar over a delivery whose rename did not happen describes the *new* render while the *old* file is on disk, and it matches the live config — reported rendered-and-verified, wrongly. Never promote the sidecar first.

**Record the output's identity in the sidecar** — `bytes` and `mtimeMs` of the
promoted file, the same cheap identity `transcodeIdentity` already uses rather
than a hash. That closes the crash window's remaining ambiguity: a sidecar whose
recorded identity does not match the file beside it is *provably* stale rather
than merely unverified.

**The audio mux moves too.** It is the destructive path above: mux from the
staging video into a second staging file, promote that, and never rename the
delivery out from under itself.

**One Studio consequence, fixed in the same change.** `GET /api/{films|scenes}/:tid/outputs`
readdirs the out dir with no filter and reports directories (`studio/server.js:1055`),
so `out/.staging/` would show up in the output panel. Filter dot-entries from that
listing.

**Acceptance:**

- Killing a render or a build mid-encode leaves the previous delivery byte-identical **and still reported as rendered and verified** — it is still a valid file, and the failed attempt is visible in job history, not in the delivery's metadata.
- The specific regression test: render a scene, kill a re-render **at identical settings**, and assert (a) the output is byte-identical to the first render, (b) the plan still reports `renderVerified: true`, and (c) no `.staging` file is left claiming to be the delivery. This is the case today's code gets wrong in the other direction — it reports verified over a *truncated* file.
- A sidecar whose recorded `bytes`/`mtimeMs` do not match the file beside it reports stale, not verified.
- A promoted file's probed frame count equals the plan's `totalFrames`; a mismatch fails promotion with the existing `verifyFrameCount` error rather than overwriting.
- `render` / `build_film` responses gain `promoted: true` and the staging path on failure.
- Interrupted-run recovery removes only `out/.staging/*`, and the Studio's output list never shows it.

**Cost:** ~1 day. **Touches:** `core/renderer.js`, `core/films.js`, `core/film.js`, `studio/server.js`.
**Error codes:** reuses `FRAME_COUNT_MISMATCH` / `CANCELLED`; adds `promotion_blocked` for a validation refusal.
**Tests:** `engine/test/film.test.js` (sidecar/promotion ordering), `films.test.js` (build promotion), `mcp.test.js` (response shape).
**Docs:** `film-setup.md`, `architecture.md` §render, `CHANGELOG.md`.

## P0-2 — A review artefact beside every delivery

**Status — implemented 2026-07-29.** Every staged single-file scene delivery
(including proxy, partial, custom-name, serial and parallel renders) and film
build now produces a staged `review.json` and contact sheet before promotion.
The policy gate keeps the prior delivery untouched on a block, and the completed
job exposes the final review/contact paths and classified warnings. The Studio
film build panel reads the persisted record through the existing output route,
showing per-thumbnail context and warning overlays. Global `render.review`
settings seed the policy; a saved film can override either severity list.
Regression coverage exercises artefact shape, default promotion of a dark/static
film, policy blocks, settings validation, and output-route retrieval.

**Build.** Persist what the engine already measures. On promotion write
`out/<base>.review.json` — frame count and probe result, audio metrics, the
`measureRenderedPicture` output, and warnings classified `block` / `warn` /
`info` — plus `out/<base>.contact.png`, a contact sheet assembled from
`extractRenderedFrame` at first/last frame, every cut, and each caption onset.
Both primitives exist; this is composition and persistence, not new capability.

Run the measurement **against the staging file, before promotion**, so a `block`
warning can hold the delivery back. Today it runs after the file is already at the
delivery name.

**Studio.** No new routes: the out-dir listing and
`GET /api/{films|scenes}/:tid/output?file=` already serve both files. Add an
**Output review** panel to the film page showing the contact sheet with warnings
overlaid on the thumbnails they came from.

**Settings extension.** `render.review: { block: [...], warn: [...] }` naming which
warning classes hold a promotion — following the existing rule that global
settings *seed* behaviour and per-film values win.

**Picture warnings default to `warn`, not `block`, and that is deliberate.**
`measureRenderedPicture` documents itself as a report rather than a gate, because
title cards and fades are legitimately dark or static. Only a frame-count
mismatch blocks by default; promoting black-run or static-run warnings to `block`
is an opt-in a particular film can make.

**Acceptance:**

- One artefact lets a producer check timing, cuts, captions and black/static frames without scrubbing.
- Each thumbnail names the segment it belongs to (`contextAtFrame` already returns this).
- With default settings, a film that is legitimately dark or static still promotes, and the warning is recorded in `review.json`.
- A warning the settings classify as `block` leaves the previous delivery in place and reports which rule held it.

**Cost:** ~1–2 days, after P0-1. **Touches:** `core/render-review.js`, `core/films.js`, `core/settings.js`, `studio/public/film.js`.
**Error codes:** `promotion_blocked` (shared with P0-1), carrying the failing rule and the staging path.
**Tests:** `engine/test/render-review.test.js` (artefact shape, classification), `films.test.js` (default policy promotes a dark film).
**Docs:** `film-setup.md`, `user-guide.md`, `mcp-setup.md`.

## P0-3 — Deliverable variants (16:9 / 9:16 / 1:1) without a second edit

**Stage A status: shipped 2026-07-29. Stage B remains planned.**

The implementation lives in `engine/src/core/deliverables.js`: a film saves
full version snapshots (geometry, per-segment crop focus, caption style,
safe-area insets and an independent filename), rather than remembering a global
preset id and reinterpreting it later. `create_film` resolves named platform
intent before scenes are created; the Studio API and MCP both accept the same
input, and an unspecified brief remains master-only by default. The first
selected version supplies the master canvas only when the caller did not name
dimensions explicitly.

`build_film { deliverable }` now compiles the resolved timeline into a
piecewise crop expression, re-encodes the completed master once at the variant
geometry, applies variant caption styling, and writes independent output/SRT/
review/contact artifacts. The contact sheet draws title and caption safe guides.
The completed job exposes `deliverable` and `reEncoded`, so the extra encode is
visible instead of implicit. Studio adds a New Film platform picker, film-level
version/crop/caption controls, a selected-version build choice, and an all-version
action. Evidence: `engine/test/films.test.js` exercises the real portrait
encode and guide-bearing review output; `mcp.test.js` and `studio.test.js`
exercise creation/default/error contracts.

The real gap the draft's "layout profiles" pointed at: **nothing lets one film
emit two aspects.** Today it means copying the film and hand-editing every
scene's dimensions. But named slots with pixel rectangles and anchors would be a
layout engine competing with CSS, in a product whose compositions *are* HTML at
the viewport size. Two honest stages instead:

**Stage A — reframe pass (cheap, ships first).** A film-level list:

```json
"deliverables": [
  { "id": "shorts-9x16", "width": 1080, "height": 1920,
    "reframe": { "default": { "xPct": 50 }, "segments": { "hook": { "xPct": 62 } } },
    "captionStyle": { "sizePct": 6.5 }, "outputFilename": "film-vertical" }
]
```

`build_film { deliverable }` runs the existing finishing pass with a reframe stage
prepended and the variant's caption style, writing to its own output name. No
re-render. Text-heavy rendered scenes will crop badly — that is exactly what the
P0-2 contact sheet is for, and it is an honest limitation to state rather than hide.

**The reframe is a compiler, not a filter string.** A single `crop` cannot take a
different centre per segment, so the per-segment overrides above need the resolved
timeline. The graph is built like `buildOverlayGraph` already is — from
`planFilm`'s layout, not by hand:

- **Output geometry is constant** for the whole deliverable (`w`/`h` fixed by the variant), so only the crop *centre* varies.
- `crop`'s `x`/`y` accept per-frame expressions over `t`, so the compiler emits a **piecewise step expression** over the segment boundaries it already knows — one `if(lt(t,…),…)` chain, generated, never authored.
- Per-segment intermediates before the concat are the fallback, needed only if a variant ever wants a per-segment *zoom* (varying `w`/`h`), which a step expression cannot express. Not in Stage A.

That compiler, its unit tests against a known layout, and the graph's interaction
with the existing overlay/subtitle stage are why this is **3–4 days, not 2**.

**Its price, stated plainly.** `finishing = overlays.length > 0 || burn`
(`core/films.js:975`): a film with neither is delivered today by a lossless
concat that never re-encodes. A reframe deliverable forces a **full re-encode of
the whole film**, at the first scene's crf/preset. That is the cost of getting a
vertical cut without re-rendering, and it should be reported in the build result
rather than discovered from a timing difference.

Each deliverable also owns its own derived files: a variant's captions differ in
style and in safe-area wrapping, so it needs its own `.srt`, its own
`review.json` and its own contact sheet, keyed by the deliverable id.

**Stage B — variant renders (correct, later).** Scenes re-render at the variant's
dimensions into `out/<deliverable>/`, with the sidecar and `planFilm` keyed on the
variant, so a vertical build assembles the vertical set. This only pays off once
compositions are authored to survive a reflow, so it ships with an authoring
contract in `frame-api.md`: relative units, and a `--ms-safe-*` CSS variable set
per deliverable for title/caption-safe insets.

**Settings extension.** `deliverablePresets` in global settings — named
width/height/caption defaults offered by `create_film` and the Studio's variant
picker, seeding a film's `deliverables` on creation and never mutating an existing
film. Same rule as `newSceneDefaults` and `ffmpeg.defaultCrf`.

**Acceptance:**

- One film produces landscape and 9:16 deliverables from one `build_film` call each, with no edit to the timeline between them.
- Every deliverable states caption-safe and title-safe insets, and the review contact sheet draws them.
- A caption that clearly exceeds the variant's safe region is a plan-time `warn` (an estimate — see P1-2), and the contact sheet is what settles the marginal ones.
- The build result names the deliverable, its derived files, and whether the film was re-encoded for it.
- Stage B: a scene rendered for one variant is never assembled into another (the sidecar refuses it).

**Cost:** Stage A 3–4 days (the reframe compiler is most of it); Stage B medium, schedule separately.
**Error codes:** `unknown_deliverable`; plan-time problems `caption_may_overflow_safe_area`, `reframe_exceeds_source`.
**Tests:** `engine/test/films.test.js` (variant resolution, derived-file naming), `film.test.js` (Stage B sidecar keying), `mcp.test.js` (`build_film { deliverable }`).
**Docs:** `film-setup.md`, `frame-api.md` (authoring contract), `user-guide.md`.

---

# P1 — close the remaining boundaries

## P1-1 — Footage segments record where they came from

**Status: shipped 2026-07-29.**

The one field the draft's cut list was really asking for. A footage segment is
`{ footage, durationInFrames }` with no record of which source and which trim
produced it, so a changed source is invisible.

**Build.** Optional `derivedFrom: { asset, transcodeMeta }` on the segment.
`planFilm` reads the existing `.transcode.json`, recomputes `transcodeIdentity`
against the source on disk, and emits `footage_source_changed` when they diverge.
Nothing new is stored that the transcode sidecar does not already hold — this is
the pointer between the timeline and the manifest.

**Acceptance:** editing or replacing the source file makes the plan say so before
a build; a film with no `derivedFrom` behaves exactly as today.
**Cost:** small. **Error codes:** plan-time problem `footage_source_changed`.
**Tests:** `engine/test/films.test.js` (plan problem), `transcode.test.js` (identity round-trip).
**Docs:** `film-setup.md`.

## P1-2 — Transcript → captions, and a caption lint

`transcribe_asset` already returns sentence and word timings; turning them into
`film.captions` is manual, and nothing checks a caption's length or bounds.

**Build.** `build_captions { film, transcription, maxChars, maxLines, from, mode }` —
phrase grouping from sentence timings, written into `film.captions` with a stable
`phraseId`. Word timings are kept on the phrase as optional children so a future
word-highlight renderer has them without introducing a competing timeline.

**Regeneration must never eat a producer's edits.** A transcript changes, or the
grouping parameters do, and the obvious implementation overwrites hand-corrected
wording and hand-nudged timing. So each generated caption carries
`generatedFrom: { asset, hash, phraseId }`, and the tool takes an explicit mode:

- `replaceGenerated` (default) — replaces only captions whose `generatedFrom.hash` matches the previous run *and* whose text and frames are unchanged since. Anything a human touched is left alone and **reported in the response**, never silently kept or silently clobbered.
- `append` — adds, touches nothing.
- A caption with no `generatedFrom` is hand-authored by definition and is never a candidate for replacement.

**The safe-area lint is an estimate, and says so.** `planFilm` gains
`caption_too_long` (exact — a character count against the profile's limit) and
`caption_may_overflow_safe_area` (**conservative**). Real bounds need the font,
libass's line breaking, margins and the target geometry; the burn-in style is
Arial at a percentage of frame height (`captionsToAss`), so a plan-time check can
only be a pessimistic advance-width estimate that flags the clear cases. The
**authoritative** check is the P0-2 contact sheet, which shows the caption
actually rendered at the deliverable's geometry — the lint exists to catch the
obvious overflow before a render, not to certify the ones it passes.

**Studio.** The caption panel gains *Generate from transcript*, shows the lint
inline, and marks which captions are generated versus hand-edited.

**Not building:** a phrase-record layer owning speaker, emphasis and style tokens.
`film.captions` is already the single source; adding a second vocabulary above it
recreates the problem the draft set out to solve.

**Acceptance:** regenerating after a transcript change leaves every hand-edited
caption untouched and names them in the response; the estimated lint never blocks
a build on its own.
**Cost:** medium. **Error codes:** `transcription_not_found`; plan-time `caption_too_long`, `caption_may_overflow_safe_area` (shared with P0-3).
**Tests:** `engine/test/transcribe.test.js` (phrase grouping from the existing fixture), `films.test.js` (regeneration preserves edits; lint), `mcp.test.js` (tool schema, modes).
**Docs:** `transcribe-setup.md`, `film-setup.md`, `mcp-setup.md`.

## P1-3 — Transitions on the timeline

The one genuine capability gap in the timeline model: segments are butt-joined by
lossless concat, so a dissolve is impossible without hand-written ffmpeg — a wall
for an MCP-only agent.

**Build.** `transitionOut: { kind, frames }` on a segment. The compiler subtracts
the overlap exactly once, `planFilm` reports the resolved frame interval, and the
finishing pass re-encodes **only the overlapping region**, concatenating the
untouched remainder around it — so the lossless guarantee is broken deliberately,
locally, and visibly, rather than silently.

**Transitions are picture-only, and that has to be stated before anyone builds
it.** Master audio is an independent timeline laid over the finished picture, and
it already owns its own `fadeInFrames` / `fadeOutFrames` / `duck` per track. A
dissolve therefore does **not** crossfade audio; it shortens the picture timeline,
and every audio `startInFrames` after it shifts by the overlap — which is the same
recompute the acceptance criteria below demand for captions and cues. An author
who wants the sound to dissolve too says so on the track, where that control
already lives.

The corollary is a constraint worth enforcing at plan time: a transition needs
segments whose audio is on the master timeline. Scene-carried audio would have to
be crossfaded at the seam, and nothing in the concat path can do that. This is the
existing rule — a film mixing footage with audio-carrying scenes already needs a
master timeline — extended one step, not a new one.

**Acceptance:** the plan shows each transition's exact frame interval; changing
its length recalculates downstream offsets, captions and audio placements;
an unsupported kind fails at plan time; promotion fails if the delivered frame
count disagrees with the compiled timeline (P0-1 already enforces this).

**Cost:** medium; deserves its own plan document before implementation.
**Error codes:** `unsupported_transition` (plan time), `transition_overlaps_segment`, `transition_needs_master_audio`.
**Tests:** `engine/test/film.test.js` (offset arithmetic), `films.test.js` (plan + build), `mcp.test.js`.
**Docs:** `film-setup.md`, `architecture.md`, its own plan doc.

---

# P2 — reusability

Both items extend mechanisms that already exist, and both follow the same two
precedents: the workspace `library/` (human-managed files, hardlinked on use) and
`tts.favoriteVoices` / `music.favoritePrograms` (user curation surfaced back to
agents through an MCP tool).

## P2-1 — A template library, replacing "motion templates"

The draft wanted parameterised presenter/product templates with slot bindings.
Most of that machinery exists already, and is stronger than it looks:
`addLibrary` (`core/store.js:702-720`) scaffolds a **named** template over an
**existing** scene, substituting `__SCENE_NAME__`, `__FPS__`, `__DURATION__`,
`__WIDTH__`, `__HEIGHT__` and an addon-script placeholder, with a `scaffold`
opt-out. "Apply template X to scene Y" is therefore nearly free. What is missing
is only that the set is closed: `create_scene` always uses `default`, and the
three template dirs ship inside the engine.

**Build.**

- User templates at `<dataDir>/templates/<id>/` — `composition.html/js/css` plus
  `template.json { name, description, requires: { libraries, addons }, aspects, params }`.
- `create_scene { template }`, and a `list_templates` MCP tool reporting what each
  template needs and supports — knowledge an agent cannot otherwise have.
- Studio: a **Templates** panel, and *Save scene as template* on a scene, which is
  how a template actually gets written (author the scene, prove it renders, keep it).
- `params` are substituted exactly like the existing scaffold placeholders. No
  slot-binding runtime, no anchor resolver.

**The hazard to fix while extending it.** That scaffold **overwrites composition
files in place**. Today that is survivable because it happens as part of adding a
library to a fresh scene; the moment templates are user-applied, applying one to
a scene with authored work in it silently destroys that work. Applying a template
to a non-empty scene must require an explicit `overwrite: true`, and say what it
would replace.

**Why this beats the draft's version:** a template is files plus a manifest, and
the engine already knows how to materialise that. The reusable presenter/product
pattern the draft wanted becomes a template someone saved from a film that worked.

**Acceptance:** a pattern used in one film scaffolds into another with one call;
a template declares its required libraries before render; a template authored for
16:9 is reported as such rather than silently scaffolded into a 9:16 film;
applying a template over authored work is refused without an explicit override.
**Cost:** small–medium. **Error codes:** `unknown_template`, `template_would_overwrite`, `template_requires_library`.
**Tests:** `engine/test/core.test.js` (scaffold + overwrite guard), `mcp.test.js` (`list_templates`, `create_scene { template }`).
**Docs:** `user-guide.md`, `SKILL.md`, `frame-api.md`, `mcp-setup.md`.

## P2-2 — A shared media library that carries measurements

Two gaps in the existing library, both of which cost real time on every film:

1. **It is per-workspace.** A music bed reused in another workspace is a manual
   copy. Add a shared root at `<dataDir>/library/`, visible to every workspace,
   with the workspace library shadowing it by name. Path configurable alongside
   `dataDir` / `workspacesRoot` in `paths.json`, resolved env → file → default,
   exactly like its siblings.
2. **It carries no metadata.** Every film re-measures the same bed by hand to pick
   a `gainDb`, and a music bed's note spec is thrown away once rendered.

**Build.** A `library.json` per root: for each entry, measured `peakDb` /
loudness and duration (from the existing `measureAudioLevels`), plus optional
tags, bpm/key, licence, and — when the file was generated — the
`synthesize_music` spec or `synthesize_speech` request that produced it.

- `list_shared_assets` returns the metadata; `use_shared_asset` returns the
  measured peak with the copy, so an agent sets `gainDb` from a measurement
  instead of a remembered template.
- `save_shared_asset { from, as, tags }` promotes a film asset into the library,
  measuring it on the way in.
- Studio: the library panel gains the metadata columns, an audition button, and
  drag-into-film.

**Acceptance:** pulling a bed into a new film reports its measured level in the
same call; a generated bed can be re-rendered from its stored spec; a library file
with no metadata still lists and still works; a workspace entry shadows a shared
entry of the same name, and the listing says which root each came from.
**Cost:** medium. **Error codes:** reuses `FILE_NOT_FOUND` / `PATH_NOT_ALLOWED`; adds `library_measure_unavailable` (non-fatal, mirrors the existing advisory rule).
**Tests:** `engine/test/core.test.js` (shadowing, metadata round-trip), `mcp.test.js` (`list_shared_assets` / `save_shared_asset`).
**Docs:** `user-guide.md`, `music-setup.md`, `mcp-setup.md`, `architecture.md` §storage.

---

# Deliberately not building

| Dropped | Why |
| --- | --- |
| `cut-list.json` as an authoritative layer | `film.json` already is; the Studio edits it directly, so a layer above it rots on the first drag |
| Layout profiles with named slots and anchors | A layout engine competing with CSS, in a product whose compositions are HTML at viewport size. Deliverables + safe-area variables cover the need |
| Promotion approval state, manifests with hashes | Ceremony for a single-operator tool. Revisit when a second person reviews before release |
| `export_cut_list` migration | Moot without a cut list |
| A phrase-record layer for captions | `film.captions` is already single-source; a second vocabulary recreates the problem |

# Order and cost

| # | Item | Cost | Unblocks |
| --- | --- | --- | --- |
| 1 | P0-1 staging → promote | ~1 day | every later change is safe to review |
| 2 | P0-2 review artefact | 1–2 days | promotion can be gated on evidence |
| 3 | P0-3 Stage A reframe variants | ~2 days | vertical deliverables today |
| 4 | P1-1 footage provenance | small | a changed source is visible |
| 5 | P2-1 template library | small–med | reuse of proven motion patterns |
| 6 | P2-2 shared library + measurements | medium | reuse of beds; kills a manual measuring step |
| 7 | P1-2 transcript → captions + lint | medium | social captions |
| 8 | P1-3 transitions | medium | own plan first |
| 9 | P0-3 Stage B variant renders | medium | correct vertical for text-heavy films |

**This is a dependency order, not a fixed sequence.** Only three edges are real:
P0-2 needs P0-1's staging file to measure before promotion, P0-3 Stage B needs
Stage A's `deliverables` field, and P1-2's safe-area lint needs P0-3's insets.
The two reuse items depend on nothing above them — if reusable templates and a
measured media library are the near-term goal, move P2-1 and P2-2 to the front
and nothing else shifts.

## Relationship to the other backlog

[prioritized-codebase-todo-2026-07-29.md](prioritized-codebase-todo-2026-07-29.md)
was written the same day and proposes four of these under different names — its
P1-2 (vertical profile), P1-3 (word-timing captions), P1-4 (finishing templates)
and P1-5 (policy-based release gates). They are absorbed here as P0-3, P1-2, P2-1
and P0-2 respectively, and should be scheduled from this document only. Its P0-1
(CI gate), P0-2 (release candidate) and P1-1 (durable jobs) are unrelated to this
plan and still stand.
