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

## 2. Scene-from-image — build this first ✅ **delivered 2026-08-08**

> **Shipped as `create_scene_from_image` (`engine/src/core/image-scene.js`),
> plus `+ image` in the film toolbar.** Every acceptance item below holds, and
> the diff is the evidence for the last one: the new engine module, its
> registration in the MCP server, one Studio route, the button and its dialog,
> tests and docs. `film.js`'s assemble path, `films.js`'s `planFootage`, and
> every segment-kind walk are untouched.
>
> Two things the build decided that the plan left open, both recorded because
> they are judgement rather than deduction:
>
> - **The cover/contain threshold is a fifth of the picture.** "Close" needed a
>   number, and that is where the real cases fall either side: a 16:10
>   screenshot (10% cropped) and a 3:2 photograph (15.6% — what everyone does
>   with a camera's own aspect) fill the frame, while a 4:3 (25%), a square
>   (44%) and anything portrait letterbox.
> - **An unmeasurable image is `contain`, and says so.** `.svg` is drawable by
>   the browser and undecodable by ffmpeg, and a machine may have no ffmpeg at
>   all. The fit falls back to the one that can neither crop nor stretch, and
>   `fit.measured` is `false` rather than the result implying a measurement that
>   never happened.
>
> One hazard the plan did not name turned up while building and is reported the
> same way transparency is: an **animated GIF**. An `<img>` plays one on the
> wall clock, so parallel render workers would each capture a different moment.
> It is still placed — an arbitrary frame may be exactly what was wanted — with
> the conversion route named.

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

### Measure first, then choose the interaction — **measured 2026-08-08**

> The instruction was: *a re-encode is seconds, not milliseconds; time one on a
> real clip before designing the gesture.* It was timed, and it changed the
> design — not by moving the gesture from "handle" to "job", but by finding that
> **the re-encode is usually not needed at all.**

#### The re-encode, timed

50 interleaved trials on `harmonia-mv`'s real footage segment (321 MB, 151.8 s,
1920x1080@60), conformed to the film's own signature
(`libx264 -preset medium -crf 18`), on a 20-thread i7-12700F shared with
ComfyUI and other agent sessions. An identical 2 s trim was re-run every 6
trials as a drift control and held at 1.51–2.11 s warm, so the run is sound.

| trim output | median | min | max |
|---|---|---|---|
| 1 s | 1,174 ms | 993 | 1,574 |
| 2 s | 1,778 ms | 1,342 | 2,212 |
| 5 s | 3,841 ms | 3,399 | 4,620 |
| 10 s | 7,773 ms | 6,363 | 15,080 |
| 20 s | 14,157 ms | 12,519 | 41,679 |

**`wall_ms = 498 + 11.51 x outputFrames`** (≤5.7% error) — 0.50 s fixed plus
0.69 s per second of *kept* output; ~87 fps for 1080p60 at these settings.

Three facts that decide more than the headline:

- **Cost tracks what is KEPT, not what is cut.** The fit has no term for the
  size of the edit. Nudging the head of that 9,109-frame segment in by one
  second still re-encodes 9,049 frames — **~105 s**. There is no cheap small
  edit.
- **Seek is free** (a 2 s trim costs the same 2 s, 76 s and 144 s into the
  source — `-ss` precedes `-i`), and an **identical request is 89 ms**
  (`skipped: true` from the transcode sidecar).
- **The film's own preset swings cost 2.2x** (10 s trim: `medium` 7,317 ms,
  `veryfast` 3,384 ms). The drag does not choose this; the film's `output`
  config does. It is *readable* before the gesture, so it is an input to an
  estimate rather than a reason not to give one.

By the rule above, that is a job — and it would have been built as one.

#### What the measurement actually found: the re-encode is avoidable

The `-c copy` floor was dismissed in one line ("a copy can only cut on
keyframes"), without asking how far apart *these* keyframes are. They are ten
frames apart, because the footage path prepares clips with `gop: 10` — and
[films.js](../../engine/src/core/films.js) lists `gopSize` under
`neednotMatch`, so a differing GOP never breaks the lossless concat. A copied
span therefore keeps the film's signature by construction.

Measured on the same segment, verified frame-count-exact and
signature-preserving (`1920x1080@60/mp4/yuv420p/h264`) every time:

| trim | stream copy | re-encode |
|---|---|---|
| tail, keep 600 f | 1,368 ms | 19,726 ms |
| tail, keep 9,049 f (150.8 s) | 1,776 ms | ~105 s (fit) |
| head from f60, keep 600 f | **183 ms** | 15,690 ms |
| head from f60, keep 9,049 f | **515 ms** | ~105 s (fit) |

**The real gesture — pull the head of the only signature-carrying footage
segment in by one second — is 515 ms by copy against ~105 s by re-encode.**
Two hundred times cheaper, frame-exact, and still concat-legal.

The asymmetry is worth stating because it is not obvious: a **tail** trim starts
at frame 0, which is always a keyframe, so it is *always* available; a **head**
trim must start on a keyframe, so it is available on a grid.

#### The catch, and it is the whole design

The grid is a property of **how the footage arrived**, and it varies by an order
of magnitude:

| segment | keyframes per 600 | grid @60fps | provenance |
|---|---|---|---|
| `body3-red.mp4` | 74 | **0.13 s** | engine-prepared (`gop: 10`) |
| `bright-gameplay.mp4` | 11 | 0.9 s | as-supplied |
| `full-vertical-video.mp4` | 9 | 1.1 s | as-supplied |
| the 656 MB screen recording | 3 | 3.3 s | as-supplied |

Engine-prepared footage can be trimmed on an eighth-of-a-second grid, which is
finer than anyone drags. As-supplied footage cannot: a 0.9–3.3 s grid is not an
edit. And the Studio's `+ footage` places a file **as-is**, with no transcode,
so most footage arrives on the coarse side.

Also measured, and **not covered by §3 as written**: of 18 films, 15 carry no
footage at all, and of the three that do, **two are footage-only** — no scenes,
therefore no encode signature, therefore nothing for `matchFilm` to conform a
re-prepare to. §3's mechanism has no target on those films.

#### The interaction the numbers choose

1. **Probe the segment's keyframe interval** (one bounded `ffprobe`) and let it
   pick the path. This is a measurement, not a guess, and it is the same
   report-what-exists rule the rest of the engine follows.
2. **Fine grid → the handle commits on release, by stream copy.** 0.2–1.8 s is
   §3's own "fast" branch. The handle must **snap visibly to the keyframe
   grid**, because `ffmpeg` snaps to the preceding keyframe *silently* — an
   in-point requested at f63 returned f60's 600 frames, byte-identical to the
   f60 request. Snapping the UI is what keeps that from being a lie.
3. **Coarse grid → offer to prepare the clip once**, not to pay per drag. One
   re-encode buys a fine grid and every later trim is ~500 ms. That is the same
   shape `make_scene_from_footage` already recommends for a long recording:
   convert once, then carve cheaply.
4. **Frame-exact in-points between keyframes stay a job**, presented as one —
   progress, cancellable, the block stale meanwhile — because that genuinely is
   the ~105 s operation.

#### Recorded because the first reading was wrong

Two claims were put to adversarial review and did not survive, and they are
noted so they are not re-derived:

- *"The UI must never promise a duration."* False. The 2.2x preset spread is a
  value `filmSignature()` already returns, and the 3.3x spread was `max/min` of
  n=10 — an extreme-value statistic inflated by other processes on a shared box.
  The drift control put the real dispersion at 1.4x. An estimate of the form
  `a(preset) + b(preset) x frames` is buildable from values in hand.
- *"An edge-drag is the wrong gesture."* The premise (cost tracks kept length)
  is true and understated, but the conclusion does not follow: **every** commit
  path pays the same cost, so it is a verdict on the operation, not on the
  control surface. And the drag need not encode at all — the Studio already
  scrubs footage by seeking `<video>` against the prepared file, so proposing is
  free and only committing costs.

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

1. ~~**Scene-from-image**, engine then button.~~ **Done 2026-08-08** — engine
   first, then the button, as written.
2. ~~**Time a trim re-encode** on a real clip — a measurement, not a build.~~
   **Done 2026-08-08**, and it moved the design: see §3. The re-encode is
   `0.50 s + 0.69 s per second kept` (~105 s for the one real segment), but a
   **stream copy does the same trim in 0.2–1.8 s**, frame-exact and
   concat-legal, whenever the footage was engine-prepared.
3. **Trim-as-copy-where-possible**, re-prepare where not — the interaction in
   §3's last section, chosen from those numbers rather than from §3's original
   assumption that a re-encode was unavoidable.
