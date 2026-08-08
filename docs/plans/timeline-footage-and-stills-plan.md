# Stills on the timeline, and trimming footage — without touching the build path

> **Status: REVISED 2026-08-08, reversing this document's own first revision
> the same day.** Both features are still wanted; both are now specified in a
> shape that stays **outside the engine's load-bearing paths**, which is the
> stated constraint. Estimate: scene-from-image ~1 day, trim ~1 day plus a
> measurement first. Independent of each other.
>
> **What changed and why.** The first revision proposed a `trimStartInFrames`
> field on footage segments plus a build-time pre-trim, and a third segment kind
> for stills. Reading the build path killed both. They are recorded in §4 so
> they are not re-proposed.

## 1. The constraint, stated as a test

The core is the **assemble path** (`film.js` `assembleFilm` → `concatSegments`,
`-c copy`), the **frame-count verification** that decides whether a delivery is
honest (`planFootage`'s `framesVerified`, `verifyFrameCount` at promotion), and
the **segment-kind walks** that ask "is this a scene?". A change is safe for
this plan if it adds nothing to those three.

Both features below pass that test by construction: one is a scaffolder that
produces an ordinary scene, the other is the Studio orchestrating two existing
engine operations. Neither adds a field to `film.json`, a branch to the concat,
or a case to a walk.

## 2. Scene-from-image — build this first

**`+ image` scaffolds a scene that displays a still**, exactly as `+ footage`
scaffolds one from a clip. The play order receives an ordinary `{slug}` segment
and nothing downstream can tell the difference.

Why a scene rather than a new segment kind: a scene is **strictly more**. A
still segment could only sit there; a scene can be pushed in on, have text laid
over it, cross-fade its own contents — and the author can open it and direct it,
which is the product's whole shape. The cost is also lower, which is the
unusual part: no new kind means no walk to update.

**Lighter than `sceneFromFootage`, which is the model.** That one must
transcode video to match the film's signature. A still needs **no ffmpeg at
all**: copy the file into the scene's `assets/`, write a composition that draws
it, register the scene. The expensive, failure-prone half of the existing
function is simply absent.

### What it does

1. Resolve the image — a workspace-library path (the common case, `+ image`
   opens the library picker) or a film-relative `assets/` path.
2. **Probe it with `probe_asset`'s picture facts** (v0.27) — `width`, `height`,
   `hasAlpha`, `contentBox`. This is what lets the scaffolder choose honestly
   between cover and contain instead of guessing, and it is already built.
3. Copy into the new scene's `assets/`, using the workspace library's
   hardlink-on-use path where the source is a library file.
4. Write a composition: the image full-frame, `object-fit: cover` when the
   aspect is close and `contain` on a letterbox background when it is not, with
   the chosen mode stated in a comment so the author can flip it.
5. Create the scene at the film's geometry and append it to the play order —
   the same call `+ footage` ends with.

### Rules

- **The composition must be plain.** The point of a scene over a segment is
  that it can be directed afterwards, and an author reading a wall of generated
  cleverness will not direct it. One `<img>`, one rule, one comment.
- **Duration is a caller's choice with a stated default** (the film's
  `sceneDefaults`, else 90 frames). A still has no natural length, and picking
  one silently is the kind of invention this backlog dislikes.
- **`hasAlpha` is reported, not resolved.** A transparent PNG over the film's
  background is a legitimate look and so is a matted one; say which is
  happening rather than choosing.
- Nothing is written outside the new scene folder.

### Acceptance

A library PNG becomes a scene in one call; the scene renders at the film's
geometry with the image filling the frame; a portrait image in a landscape film
letterboxes rather than stretching; the play order gains exactly one `{slug}`
entry; `planFilm`'s problems are empty; and **no code outside the scaffolder
changed** — which is the point, and is checkable by diff.

### Surfaces

`create_scene_from_image` as an MCP tool beside the footage one, and `+ image`
in the film toolbar calling it. Engine first: the tool is the product, the
button is the convenience.

## 3. Trimming footage — measure before building

**The drag re-runs the prepare step.** Pull a footage block's edge and the
Studio re-transcodes that clip with new `trim` values through `transcode_asset`
— which is already frame-exact and already how footage reaches a timeline —
then patches the segment's `durationInFrames`. Both halves are existing, tested
engine operations invoked the ordinary way.

- **One source of truth.** The prepared file *is* the trim. Nothing in
  `film.json` describes it a second time.
- **The concat stays lossless.** No pre-trim, no per-build re-encode, no branch
  in the assemble path.
- **Frame-exactness is inherited**, not re-earned in new code.

### The hazard, and the fix

Re-transcoding **in place** would silently change every other segment sharing
that asset. Write to a derived filename and repoint the segment's `derivedFrom`
— the provenance pointer exists for exactly this, so the segment moves and
nothing else does.

### Measure first, then choose the interaction

A re-encode is seconds, not milliseconds. **Time one on a real clip before
designing the gesture.** If it is fast, a handle that commits on release is
honest. If it is twenty seconds, it is a job and must present as one — progress,
cancellable, the block marked stale meanwhile. Do not build a live scrub over an
operation that cannot be live.

## 4. Retired from this plan, with reasons

Recorded so they are not re-proposed by a later reading of the same feature
request:

- **`trimStartInFrames` on footage segments.** It puts a second answer to
  "which part of this clip plays" into `film.json`, and forces the build to
  pre-trim — a per-build re-encode that trades the lossless concat, an
  architectural property, for edit-time convenience. It also requires editing
  the `framesVerified` rule, which is the code that decides whether a delivery
  is honest. The trim already exists in `transcode_asset`, is frame-exact, and
  is paid once.
- **A third segment kind for stills** (`{image, durationInFrames}`). Every
  "is this a scene?" site in the codebase would have to learn a third answer,
  and that exact omission is **BUG-2** — a segment kind a walk did not know
  about surfaced as a scene called `undefined` and reached the MCP manifest. It
  would buy something weaker than a scene, for more risk.

## 5. Order

1. **Scene-from-image**, engine then button. Safe, self-contained, useful now.
2. **Time a trim re-encode** on a real clip — a measurement, not a build.
3. **Trim-as-re-prepare**, with the interaction chosen from that number.
