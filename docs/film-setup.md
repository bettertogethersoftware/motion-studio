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

Returns `{ outputProjectId, sceneOrder, outputPath, scenes, totalFrames, durationSeconds, fps, format, hasAudio }`.
Errors: `scene_not_rendered`, `inconsistent_scenes`, `path_outside_project`,
`file_not_found`, plus `prereqs_missing`/`ffmpeg_failed` from the encoder.

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

## Current limits (v0.9)

- **No built-in transitions.** Cuts only. For crossfades, bake the transition into
  adjacent scene tails/heads, or run a separate `xfade` pass on the master (that
  step re-encodes at the boundary).
- **Whole-scene only.** `build_film` uses each scene's full rendered output; it does
  not sub-range a scene (render the scene to the length you want instead).
- Mixed audio/silent scenes require a master `audio` timeline (see above).
