# `prepare_image` — the still-image hole in the media surface

> **Status: PROPOSED. Nothing here has shipped.** This is a design record written
> before implementation, in the shape of the completed real-footage plans
> (summarized in [completed.md](completed.md)). It is **capability-shaped**,
> which by the rule in
> [agent-environments.md](../agent-environments.md#the-rule-that-falls-out-of-it)
> means it ships *behind* the knowledge-shaped work in
> [production-workflow-backlog.md](production-workflow-backlog.md),
> not ahead of it.
>
> Prototyped by hand — a 15 s product spot built entirely **outside** the MCP
> surface, from five supplier photos plus a product spec sheet, using Python +
> Pillow for pictures and FFmpeg for the mux. Findings from that run are marked
> **[measured]** below.

## What it does in each environment

| | Value |
|---|---|
| **Env A** (MCP only) | **Essential, and currently a hard wall.** An agent handed a supplier photo cannot crop it, cannot key its background, and cannot ask a single question about its content. `transcode_asset` has `video`, `audio` and `frames` modes — there is no `image` mode — and `probe_asset` reports container/codec facts, not picture facts. The only available move is to pass the file to a composition unmodified and hope. |
| **Env B** (+ shell) | **Mostly redundant.** Pillow, ImageMagick or `ffmpeg -vf cropdetect` are all better than any wrapper, and Env B already reaches for them. Env B wants one thing from this plan: the *measurement* half, because "what is the mean luminance under my caption" is a question you otherwise answer by rendering and squinting. |

Scope accordingly. This is the same trap `transcode_asset` documents: every field
beyond what Env A needs to build a real film is a field to defer, and the honest
end state of the wrapper treadmill is an `args` passthrough that
[architecture.md §9.4](../architecture.md) forbids on purpose.

## Why

The evidence is one session, run end to end today.

A user pointed at a folder of five supplier photos and a spec sheet and asked for
a 15 s spot with narration and music. It was built — but every picture operation
that mattered happened outside the tool surface:

| Operation | Why it was needed | MCP equivalent today |
|---|---|---|
| Bounding-box crop to the product | **[measured]** All five shots sit on white with a wide, *uneven* margin. Placed as-is, the device renders small and off-centre, and the layout has to be hand-tuned per photo. | none |
| Multiply-composite onto the background | **[measured]** A white-background JPEG dropped on a light gradient reads as a visible white card. Multiply makes the seam vanish *and* preserves the shot's own drop shadow — no cutout needed. | none — CSS `mix-blend-mode: multiply` exists, but [the footage memo's finding stands](../frame-api.md): multiply dies under any ancestor opacity or transform |
| Content-aware crop of `p5.jpg` | **[measured]** That file carries the supplier's own burned-in "EASY TO USE" headline and icon row in its upper right, which collided with our copy. Framing the lower-left third removed it. | none — and nothing on the surface can *detect* the burned-in text either |
| Feather / alpha keying | The white flood-fill cutout already hand-rolled for these exact shots in earlier work. | none |

None of these is exotic. All four are the first four things anyone does with a
supplier photo, and an MCP-only agent can do none of them.

**The second half is measurement, and it is the part Env B wants too.** A
composition can style an image; it can never ask a question about one. "Is this
photo portrait or landscape", "where is the actual content in this frame", "how
dark is the region where the caption goes" are all decidable before a render and
currently decidable only by rendering and looking.

## What this plan does *not* do

**It does not add a second renderer.** Chromium stays the renderer. The prototype
drew all 450 frames in Pillow, which was fast and crash-free, and the ceiling was
obvious and low:

- **No text layout engine.** Pillow draws glyph runs. It does not wrap, kern-adjust,
  or fall back across fonts — every line break in the prototype is a hardcoded pixel
  value tuned by eye. Given the engine narrates zh-TW, the missing font-fallback
  chain is disqualifying on its own.
- **No blend modes worth the name, no real blur, no vector, no 3D, no video layers,
  no iframes** — all of which work today through the browser.
- **No animation model.** No timeline, no `spring()`, no `MotionStudio.random(seed)`.
  The prototype hand-differentiated its own worse easing function.

**It does not duplicate render review.**
[render-review.js](../../engine/src/core/render-review.js) already samples decoded
frames at 64×36 greyscale through ffmpeg to derive `static_run` / `black_run` /
`suspect_cut`. That is measurement of a *delivered file* and it needs no new
dependency. This plan is strictly about **input assets, before a render**.

## Design sketch

One tool, `prepare_image`, addressed exactly like its siblings — `from` +
`fromTarget`, resolved through `locateMedia`, writing only into `assets/`. Plus
picture facts on the existing `probe_asset`.

### Ops, not arguments

The rule from §9.4 carries over unchanged and is the whole reason this is worth
building rather than shelling out:

> **No arbitrary arguments. Not `args`, not `filter`, not an escape hatch.**

The request is a validated list of named ops applied in order:

| op | fields | notes |
|---|---|---|
| `autoCrop` | `threshold`, `pad` | bbox of non-background content. Threshold is per-image and dark shots need a harder variant — so it is a field, not a constant |
| `keyBackground` | `threshold`, `feather`, `seed: "edges"` | edge flood fill, **not** a colour key — a colour key eats the product's own white highlights |
| `fit` / `cover` | `width`, `height` | resample named in the request, recorded in the sidecar |
| `pad` | `width`, `height`, `background` | letterbox to an exact canvas |
| `contactSheet` | `columns`, `cell` | for a folder of stills |
| `encode` | `format`, `quality`, `dataUrl: true` | `dataUrl` matters: inlining as a data URL is the documented way around `file://` canvas taint blacking out WebGL textures |

`buildImageOps` is pure and unit-testable with no Pillow installed, the same shape
as `buildVideoFilter` and `buildOverlayGraph`. It is the entire surface that can
ever run, which is what makes the no-shell claim checkable rather than aspirational.

### Picture facts on `probe_asset`

For a still input, report what only a pixel read can tell you: `width`, `height`,
`hasAlpha`, `contentBox` (the `autoCrop` bbox, reported without performing it),
`meanLuminance`, `dominantColors`, and `isBlank`. Report by measuring, never by
echoing — the same property the transcode surface already states.

### Vehicle: Pillow behind a Python hook

Three candidates. The precedent for the winner already exists in
[tts-piper.js](../../engine/src/core/tts-piper.js), which resolves `python -m piper`
through `MOTION_STUDIO_PIPER_PYTHON`.

| candidate | verdict |
|---|---|
| **Pillow via `MOTION_STUDIO_PILLOW_PYTHON`** | **Recommended.** One helper script takes a validated JSON op list on stdin. There is no command line to build, therefore no string to smuggle anything into |
| ImageMagick via `MOTION_STUDIO_MAGICK_EXE` | **Rejected**, despite a copy currently sitting unpacked at the repo root. Using it means *building command lines*, which §9.4 calls a shell wearing a hat — the exact thing this surface exists to avoid |
| `sharp` (npm) | **Rejected.** A heavy native npm dependency, against the standing preference for spawned external tools behind env hooks |

Absent Python-with-Pillow, every op degrades to `image_prep_unavailable`, matching
how the Windows-only and vendor-gated features already behave.

## Rules it must obey

1. **Never destructive.** The destination may never equal the source, and a
   `*.image.json` sidecar records source identity plus every parameter, so an
   unchanged repeat call is free.
2. **Record the tool version in the sidecar.** Pillow's resampling differs subtly
   across releases; `vendor.lock.json` already sets the precedent that the bytes are
   git's job and the *origin* is the lock's job.
3. **Writes stay inside `assets/`** via `_assetRelPath`, reads may resolve `out/`
   through `resolveMediaFile` — the existing asymmetry, unchanged.
4. **Measure the output, don't echo the request.** A caller who asked for 640×360
   and got 640×358 learns it here.
5. **No image op may run during a render.** This is authoring-time asset prep; a
   per-frame hook would put a Python spawn inside the frame loop.

## TODO

- [ ] `core/image.js` — `validateImageRequest`, pure `buildImageOps`, `prepareImage`
- [ ] The Python helper + `MOTION_STUDIO_PILLOW_PYTHON` resolution, mirroring `resolvePiper`
- [ ] `image_prep_unavailable` in `errors.js`, with a message naming the env var
- [ ] Picture facts on `probe_asset` for still inputs
- [ ] MCP tool `prepare_image` in `mcp/server.js`
- [ ] Tests: op-list unit tests with no Pillow present; an integration test behind a stub helper, as `fake-whisper.mjs` does
- [ ] Docs: `mcp-setup.md` tool row, `architecture.md` §9.4 (it is the same surface), `CHANGELOG.md`, and both SKILL files
- [ ] A real film that uses it — the acceptance test below

## Acceptance test

> **Env A can rebuild the 15 s product spot.**

Five supplier photos, one spec sheet, no shell: crop each shot to its product,
detect that one of them carries burned-in supplier copy, place them on a
generated background without a visible white card, and narrate the result. Today
Env A fails at step one.

## Open questions — decide before implementing

1. **Does `keyBackground` belong at all, or does `multiply` composite make it
   unnecessary?** **[measured]** The prototype needed *no* cutout — multiply alone
   removed the seam and kept the shot's shadow. If compositions can reliably
   multiply, keying is a much smaller feature than it looks. But the standing
   finding is that multiply dies under any ancestor opacity or transform, which is
   a common thing for an animated card to have. Resolve by testing that specific
   collision before writing the flood fill.
2. **Sync or job?** Image ops are ~100 ms, not ~10 s. They may not need
   `jobs.startTask`'s second lane at all — but `contactSheet` over a large folder
   does. Suggest: sync with a hard input-count cap, revisit if the cap bites.
3. **Does `contactSheet` belong here or in `render-review`?** It already builds one
   for delivered files. Two contact sheets in one codebase is one too many.

## Deliberately out of scope

- Any per-frame or in-render image processing.
- Text rendering of any kind. That is the browser's job and Pillow is bad at it.
- Generative/AI image editing.
- A general filter surface (blur, sharpen, curves). A composition can do those in
  CSS at render time on an element it already controls.
