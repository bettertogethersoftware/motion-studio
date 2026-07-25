# Motion Studio — Long-form Films (`build_film`)

Motion Studio renders **one composition per project**. A composition is a single
`frame → state` function, which is the right size for a shot or a scene — not for
an hour of video. To build anything longer than a single composition, you author
each **scene as its own project** and stitch the rendered scenes together with the
`build_film` tool (added in v0.9).

```
scene-1 (project)  ─ render ─┐
scene-2 (project)  ─ render ─┤→  build_film  →  one continuous film
scene-3 (project)  ─ render ─┘   (+ optional master audio)
```

This is the same idea the parallel renderer already uses internally (it splits one
render into frame-range segments and concatenates them losslessly); `build_film`
applies it at the **scene** level, across projects.

## The scene model

- **One project per scene.** Author and render each scene with the normal tools
  (`create_project` → `write_composition_file` → `capture_preview_frame` →
  `render`). Nothing new to learn per scene.
- **`build_film` assembles; it never renders.** Every scene must already be
  rendered, or the call fails with `scene_not_rendered` naming the culprits.
- Because compositions are pure functions of frame, you can **preview scenes at
  720p and final-render at 1080p/4K with zero code change** — resolution and fps
  live in each project's config, not in the composition.

## The consistency invariant

Scenes are concatenated **losslessly** (`ffmpeg -c copy`, no re-encode, no quality
loss, near-instant even for a long film). For a stream copy to succeed, every scene
must share the codec-determining parameters:

- **resolution** (`width`×`height`), **fps**, **format**, and **pixel format**.
- **format ∈ mp4 | webm | prores.** `gif` (global palette) and `png-sequence`
  cannot be concatenated — a mismatch or a bad format fails with
  `inconsistent_scenes`.

Set these once and reuse them for every scene project. (`crf`/`preset` may differ
between scenes — they affect encoding, not stream compatibility.)

## Audio: two modes

- **Per-scene audio (default).** With no `audio` argument, each scene's own audio
  is preserved through the concat. All scenes must be **consistently audio or all
  silent** (mixing the two breaks a stream copy → `inconsistent_scenes`).
- **Master audio timeline.** Pass `audio: [{ src, startInFrames?, gainDb? }, …]`
  (the same shape as `config.audio`, relative to the output project's `assets/`) to
  lay **one** music-bed-plus-narration timeline over the *entire* film. This
  **replaces** per-scene audio and is the clean choice for long-form — a score that
  spans scene cuts, VO placed by absolute frame across the whole film.

### Tiling a music loop across the film

The score does not need to be as long as the film. Compose one short piece
(32–64 beats is plenty), then list the **same `src` several times** at stepped
`startInFrames`:

```
audio: [
  { src: "assets/theme.wav", startInFrames: 0,    gainDb: -13 },
  { src: "assets/theme.wav", startInFrames: 1440, gainDb: -13 },
  { src: "assets/theme.wav", startInFrames: 2880, gainDb: -13 },
  …
]
```

Step by the piece's **`musicalDurationSeconds` × fps**, not by its WAV length:
`synthesize_music` reports both, and the WAV is longer because it carries the
reverb tail. Stepped on the musical grid, each repeat starts in time while the
previous tail decays underneath it — a free crossfade at every seam. (A 48 s
theme at 30 fps tiles every 1440 frames; seven placements cover a five-minute
film.)

### Placing multi-clip narration (and a second voice)

A scene that chains clips — narrator, a quotation in a second voice, narrator
again — derives every offset from the **measured** clip lengths, never from the
text. For a scene starting at `filmOffset`:

```
a = filmOffset + LEAD                  # narr-a starts after the scene lead-in
q = a + narrA.durationInFrames + GAP   # the quote voice
b = q + quote.durationInFrames + GAP   # narr-a's voice resumes

audio: [ { src: "assets/narr-a.wav", startInFrames: a },
         { src: "assets/quote.wav",  startInFrames: q },
         { src: "assets/narr-b.wav", startInFrames: b }, … ]
```

`GAP` of 15–20 frames reads as a natural breath. Scene-local visuals (subtitle
cues, beat-synced effects) use the same numbers minus `filmOffset`, so
re-synthesizing any clip means re-measuring once and updating both places — and
the "size the scene to the voice" assertion below generalizes to the chain:
the *last* clip must still end inside the scene.

## Levels: measure, never inherit

When you pass a master `audio` timeline, the result carries an `audio` block with
the **measured** peak/mean dBFS of the finished film and a `clipping` flag. Read
it. A bad mix is the one defect you cannot see in a preview frame, and the render
path has reported these numbers since v0.10 — as of v0.11 `build_film` does too.

**Do not copy a master gain from a previous film.** Levels are a property of the
*voices and beds you actually used*, not of your taste. A worked example: an
en-US narration film mixed correctly at a +4 dB master lift; the zh-TW OneCore
voices in the next film conditioned about 5 dB hotter through the same
`speechnorm` chain, and that same +4 would have put speech at **+1.4 dBFS** —
forcing the limiter to act on every consonant. That is the failure mode to fear,
because unlike clipping it is not reported and does not sound broken; it just
sounds slightly muddy, which is fatal for a children's narration.

The reliable procedure:

1. Condition each narration clip (`speechnorm=e=9:r=0.0004:l=1,volume=-3dB` is a
   good starting chain) and **measure the loudest one**.
2. Set your *relative* balance from that — bed mean ~30 dB under the voice,
   transition cues peaking ~20 dB under it.
3. Let `build_film` place the absolute level: pass **`audioTargetPeakDb: -2`**.
   It measures the assembled mix, applies one offset to *every* track (so your
   balance is preserved exactly), re-muxes, and re-measures. The returned
   `audio.appliedOffsetDb` tells you what it moved.

Re-assembly is cheap — the concat is a stream copy, so a level correction on a
ten-minute film costs seconds. Measure and fix; never ship a guess.

`output.audioLimiter` (default true) still brick-walls the result at −1 dBFS, but
treat it as a seatbelt, not a mixing tool: if the limiter is doing work, the mix
is already wrong.

**The SFX bed is calibrated the same way.** `synthesize_sfx` (v0.12) renders a
whole cue list — chimes on cuts, a shimmer under a reveal, a thud on an impact —
into one track, and by default it *leaves a quiet bed quiet* rather than
normalizing it, so the `peakDb` it reports is a real level you can balance
against. Attach it with a `gainDb` derived from that number, not from a previous
film. See [sfx-setup.md](sfx-setup.md).

## Highest quality

The concat itself is lossless, so quality is set by how you **render the scenes**
and **encode the final master**:

1. Render scenes at a **high-quality setting** — either a low `output.crf` (14–16)
   or, best, `output.format: "prores"` (422 HQ, 10-bit) / `png-sequence` as lossless
   intermediates. Set these via `update_project_config`'s `output` object.
2. `build_film` to stitch (lossless).
3. Do **one** final delivery encode of the assembled master (e.g. H.264 CRF 18–20,
   `preset slow`, or H.265) — a single generation of lossy encoding instead of one
   per scene.

Pick resolution/fps deliberately: 1920×1080@30 is the sweet spot; 4K is ~4× the
render cost; 60fps doubles frames. Even dimensions are required for mp4/webm/prores.

## Tool contract

`build_film`:

| arg | meaning |
|---|---|
| `scenes` (req) | ordered `[{ projectId }]` — the scenes, in play order, each already rendered |
| `outputProjectId` | project that receives `out/<film>` and holds master-audio assets (default: the first scene) |
| `outputFilename` | bare filename; extension is forced to the scenes' format (default `film.<ext>`) |
| `audio` | optional master timeline `[{ src (under assets/), startInFrames?, gainDb? }]` laid over the whole film |
| `audioTargetPeakDb` **(v0.11)** | −60..0. Measure the mixed film and re-mux **once** so it peaks here (e.g. `-2`). Shifts every track by the same offset, preserving your balance. |

Returns `{ outputProjectId, sceneOrder, outputPath, scenes, totalFrames, durationSeconds, fps, format, hasAudio }`,
plus — whenever a master timeline was supplied — **`audio: { tracks, limiter, peakDb, meanDb, clipping, targetPeakDb?, appliedOffsetDb? }`** (v0.11).
Errors: `scene_not_rendered`, `inconsistent_scenes`, `path_outside_project`,
`file_not_found`, `invalid_config` (bad `audioTargetPeakDb`), plus
`prereqs_missing`/`ffmpeg_failed` from the encoder.

## Worked example

```
# three scenes, identical video params
create_project { name: "Scene 1 — Title",  width: 1920, height: 1080, fps: 30, durationInFrames: 150 }
create_project { name: "Scene 2 — Body",   width: 1920, height: 1080, fps: 30, durationInFrames: 600 }
create_project { name: "Scene 3 — Outro",  width: 1920, height: 1080, fps: 30, durationInFrames: 150 }

# author + render each (render nothing here that build_film will redo)
write_composition_file … ; render { projectId: <scene1> } ; poll get_render_status → done
… repeat for scene 2 and 3 …

# a master score in scene 1's assets (or a dedicated film project)
synthesize_music { projectId: <scene1>, mode: "asset-only" }   → assets/music-1.wav

# stitch, with the score over the whole 30s
build_film {
  scenes: [{ projectId: <scene1> }, { projectId: <scene2> }, { projectId: <scene3> }],
  audio:  [{ src: "assets/music-1.wav", gainDb: -8 }],
  outputFilename: "my-film"
}
→ out/my-film.mp4  (900 frames, 30s, one continuous film)
```

## The pattern that scales: one engine, scenes as data

For a film of more than a couple of scenes, don't write a bespoke composition per
scene. Write **one** `composition.js` that reads a per-scene config object, and give
each scene project its own tiny config file:

```html
<script src="frame-api.js"></script>
<script src="scene.js"></script>        <!-- window.SCENE = { … } — differs per scene -->
<script src="composition.js"></script>  <!-- the shared engine — identical everywhere -->
```

The engine turns `window.SCENE` (background, sprites with positions/entrances, a
library of named effects, camera keyframes, dialogue timing, titles) into per-frame
draws. Every scene project ships the **same** `composition.js`; only `scene.js`
changes. This keeps `build_film`'s "one project per scene" model cheap to author — a
new scene is a data file, not new code — and it's how a 7-scene, five-minute cutscene
was built.

**Iterate one scene at a time.** Because scenes are independent projects, fix a single
scene's config, re-render *only that project*, and call `build_film` again — the other
scenes' rendered outputs are reused untouched and the whole film re-stitches in
seconds. That render-one / reassemble loop is what makes a long film tractable.

**Fixing the shared engine: use `sync_shared_files`.** Each project owns its own
*copy* of `composition.js`, so editing the one you authored first reaches nothing
already scaffolded. On a 16-scene film a one-line art fix otherwise means sixteen
`write_composition_file` calls. Instead:

```
sync_shared_files {
  sourceProjectId: <scene 1>,
  targetProjectIds: [<every other scene>],
  files: ["composition.js", "styles.css"]
}
```

Every target gets the same syntax check and determinism lint as a normal write,
and all source files are read before anything is written, so a bad path fails
before it half-updates the film. Note what it does **not** do: it will not touch
`scene.js` unless you list it (that is the per-scene data, and listing it would
overwrite every scene with scene 1's), and already-rendered output is not
invalidated — **re-render the affected scenes yourself**.

## Narration-first timing

For anything voice-led, synthesize the narration **before** you size the scene,
and let the audio decide `durationInFrames`:

```
synthesize_speech(...)            → durationInFrames for the clip
durationInFrames = LEAD + <narration frames> + TAIL     // e.g. LEAD 24, TAIL 38
update_project_config { durationInFrames }
```

Then the visuals cannot drift out of sync with the voice, because the picture is
cut to the voice rather than the other way round. Sizing the scene first and
hoping the VO fits is what produces either dead air at the end of a scene or a
line still talking over the next cut. Two ten-minute films built this way landed
every one of their scenes with exactly the intended tail frames and zero
overruns; the check is worth automating — assert
`narrationStart + narrationFrames <= sceneStart + durationInFrames` for every
scene before you render anything.

## Using external image assets

Backgrounds, sprites, and other images live under the project's `assets/` and are
referenced as `assets/<name>`. Put them there **directly on disk** for anything large
or numerous (`write_asset_file` is base64, capped at 25 MB). A few determinism rules
learned the hard way:

- **Load images before you register.** Preload every image (`new Image()` +
  `Promise.all`) and only then call `registerComposition`, so `setFrame` isn't defined
  until the assets are ready — the renderer waits for that handshake, guaranteeing each
  captured frame has its images. Drawing local images onto a `<canvas>` is fine: the
  render screenshots the *page*, not the canvas buffer, so cross-origin tainting never
  matters.
- **GIFs animate on the wall clock — don't use them live.** An animated `<img>` GIF
  advances by real time, which breaks frame determinism. Convert to a **still**
  (`ffmpeg -i bg.gif -frames:v 1 bg.png`) and drive any motion yourself from `frame`.
- **Pixel art:** set `image-rendering: pixelated` on the canvas/element and
  `ctx.imageSmoothingEnabled = false`, then scale up — crisp big pixels instead of blur.
- **Transparency:** PNGs with alpha composite directly. For a sprite on a solid colour
  (e.g. a ripped sheet), key it out first — and add `format=rgba`, or ffmpeg may drop
  palette/keyed alpha when cropping:
  `ffmpeg -i sheet.png -vf "crop=W:H:X:Y,colorkey=0xRRGGBB:0.2:0.05,format=rgba" sprite.png`

## Scaling to an hour (and why this is the way)

- **Render time scales linearly**, but each scene is a **short, independent,
  resumable** job — render them in parallel across the machine, or overnight, and
  re-render just the scene you changed. A single 108,000-frame monolith would be one
  fragile long job and one unmaintainable timeline function.
- **Assembly is cheap** — a stream copy of N files is near-instant regardless of
  total length.
- **Authoring is the real cost.** For long-form, favor **templated / data-driven
  scenes** (generate many similar scene projects from a manifest) and **asset
  compositing** (images/video as the base, code for motion/text/transitions) over
  hand-building every frame.
- **Drive a long batch by frame count, and retry.** Chromium dies intermittently
  mid-screenshot (`Protocol error (Page.captureScreenshot): Target closed`) on
  long runs — observed at both 4 and 6 workers, on different scenes each time,
  with plenty of RAM free. It is flaky, not a bad scene and not memory pressure,
  so lowering the fan-out only changes the odds. **Since v0.14 the capture loop
  self-heals**: a crash-shaped failure relaunches Chromium (up to 3 per render,
  with backoff) and retries the *same frame* in place, so the frames already
  encoded are kept and a flake costs about a second instead of a scene. A job
  that spends the whole budget fails with `browser_crashed` — at that point the
  machine is crashing, not flaking. Scene-level retry remains the backstop, and
  the resume condition is unchanged: skip a scene whose output already has
  exactly `durationInFrames` frames. Since v0.11 the renderer verifies that
  count itself and fails with `short_render` rather than returning a truncated
  file, so "the output exists and is the right length" is a trustworthy resume
  condition.
- **Wait, don't poll.** For a queued batch, `wait_for_render` (v0.14) with the
  whole list of jobIds replaces a `get_render_status` polling loop; it returns
  when every scene is terminal (or on timeout, with the current snapshots).
  Check each returned state — one failed scene does not stop the others.
- **Skip redundant pre-flights.** If you have just verified every scene with
  `capture_preview_frames`, pass `preflight: false` to `render` — the probe
  would re-check what you just looked at, at one Chromium launch per scene.

## Current limits (v0.9)

- **No built-in transitions.** Cuts only. For crossfades, bake the transition into
  adjacent scene tails/heads, or run a separate `xfade` pass on the master (that
  step re-encodes at the boundary).
- **Whole-scene only.** `build_film` uses each scene's full rendered output; it does
  not sub-range a scene (render the scene to the length you want instead).
- Mixed audio/silent scenes require a master `audio` timeline (see above).
