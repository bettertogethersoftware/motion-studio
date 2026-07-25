# Motion Studio — 3D Libraries (Three.js / Babylon.js) and glTF/GLB models

Motion Studio compositions are self-contained HTML/CSS/JS driven by a frame
number. That model extends cleanly to real 3D: WebGL renders in the headless
render path (confirmed — SwiftShader/GPU), so a composition can pull in a
rendering library and draw a scene as a pure function of `frame`.

This document covers the **`add_library`** feature (shipped, v0.7), the
**optional local-asset-fetch flag**, and loading glTF/GLB *models* via the Babylon
loaders addon — which **works** (§3), kept as a full investigation writeup because
the root cause was non-obvious and the gotchas are all still live.

---

## 1. `add_library` (shipped)

Attach a pinned 3D library to a project. The build is vendored **locally** into
the project (never a CDN at render time, so renders stay hermetic) and a
frame-driven starter composition is scaffolded.

```
add_library { projectId, library: "three" | "babylon", scaffold?: true }
```

- **`three`** — Three.js (~600 KB, lightweight). Good default for logos,
  product shots, simple 3D.
- **`babylon`** — Babylon.js (~8 MB, batteries-included: `GlowLayer`,
  `DefaultRenderingPipeline` bloom/vignette/grain, `FresnelParameters`). Good
  when you want a cinematic look without assembling postprocessing yourself.
- `scaffold` (default true) replaces `composition.html/js/css` with the library
  starter; the library id is recorded in the new optional `config.libraries`.

Registry: [`engine/src/core/libraries.js`](../engine/src/core/libraries.js).
Builds are **committed** under `engine/vendor/libs/` (~9 MB, MIT / Apache-2.0), so
`add_library` works on a fresh clone with no setup. `node scripts/fetch-libs.mjs`
is an upgrade/repair tool, not a prerequisite. Starters live in
`engine/templates/lib-*`.

### Determinism contract (returned as `notes`, baked into the starters)

The frame-driven render calls your `setFrame` once per frame, in any order,
across parallel workers. So:

- **Drive every animation from the injected `frame`.** No `requestAnimationFrame`,
  no `THREE.Clock`/`getDelta()`, no Babylon `engine.runRenderLoop()`, no particle
  systems / `scene.beginAnimation()` (all wall-clock based).
- The renderer must use **`preserveDrawingBuffer: true`** and each `setFrame`
  should end with a GL **`finish()`** so the headless screenshot captures the
  frame.
- Babylon `DefaultRenderingPipeline`: set **`grain.animated = false`** (animated
  grain is time-based).

Both the Three.js moon and the Babylon spaceship-intro demos render this way and
were produced end to end (Chromium capture → FFmpeg). A third production — the
City Runner third-person game demo (rigged character, procedural city, chase
cam, game HUD) — added the patterns below.

### The vendored API surface is the contract, not the online docs

The three.js build is **r134** (2021). Classes the current docs treat as
standard may not exist — `CapsuleGeometry` (r142+) throws
`is not a constructor`, surfacing as the generic "never defined
window.setFrame" failure with the real error in its `Page errors:` tail.
Check the vendored revision before reaching for a modern class; compose from
primitives when in doubt (knowledge-base.md §6.3).

### Game HUD / 2D overlay: a second canvas, drawn in the same frame call

For HUD chrome over a 3D scene (minimap, health bars, timecode, prompts,
vignette/grain), skip render-target postprocessing entirely: stack a plain 2D
`<canvas>` absolutely positioned over the WebGL canvas, and in the frame
function draw the 3D scene first (`renderer.render` + `gl.finish()`), then the
HUD. The capture screenshots the *page*, so the browser composites the layers
for free. This keeps HUD text crisp (no WebGL text rasterization), lets the HUD
read composition state directly (e.g. a distance counter derived from the same
`characterZ(frame)` that places the character), and costs nothing at r134 where
postprocessing add-ons aren't bundled.

Two smaller tricks from the same production:

- **Blob shadow over shadow maps.** A radial-gradient canvas texture on a
  ground-hugging plane, moved with the character and scaled/faded with jump
  height. For a long tracking shot it beats a shadow-mapped light whose frustum
  would have to span the whole run (or be repositioned every frame).
- **Drive gait phase from distance, not frames** — and sanity-check the
  cadence arithmetic (cycles/sec) before rendering; a wrong rate is invisible
  in still previews (knowledge-base.md §5.6).

---

## 2. Loading external assets over `file://` (opt-in flag)

Compositions load from a `file://` URL. Chrome allows `<img>`, `<audio>`, CSS
url(), and canvas 2D image draws from sibling files, **but blocks `fetch`/`XHR`**
to `file://` (CORS — "Cross origin requests are only supported for protocol
schemes: … data, http, https …"). glTF/GLB loaders and JSON `fetch()` therefore
fail with `net::ERR_FAILED`.

Opt-in flag (added v0.7, [`engine/src/core/browser.js`](../engine/src/core/browser.js)):

```
MOTION_STUDIO_ALLOW_LOCAL_FETCH=1   # adds Chromium --allow-file-access-from-files
```

Off by default (no behavior change). With it set, a composition can `fetch` its
own project assets. **Security note:** with the flag on, composition JS can
`fetch('file:///…')` any local file and draw it to the canvas (exfiltrate via the
output image). Acceptable for a local single-user tool running your own
compositions; do not enable it for untrusted composition code. A longer-term
alternative is to serve the project over `http://127.0.0.1` during render instead
of `file://` (see §4).

Verified: with the flag, a 13.5 MB GLB **fetches and imports** successfully.

---

## 3. glTF/GLB models via the Babylon loaders addon — RESOLVED

Goal: load a real model (`super_starfury.glb`, 13.5 MB) via
`babylonjs.loaders.min.js` + `BABYLON.SceneLoader.ImportMeshAsync` and render it
frame-driven. **This works** — verified end to end as a cinematic video. The
root cause of the earlier "blank frame" wall and the fix are below; the working
recipe is §3.4.

### 3.1 What works
- With `MOTION_STUDIO_ALLOW_LOCAL_FETCH=1`, the GLB fetches and imports:
  `SceneLoader.ImportMeshAsync('', 'assets/', 'super_starfury.glb', scene)`
  resolves with **18 geometry meshes**, valid world bounds
  (`scene.getWorldExtends()` → min ≈ (−711, −478, −910), max ≈ (712, 555, 566);
  centre ≈ (0, 38, −172); bounding-sphere radius ≈ 1148). Meshes report
  `isVisible=true`, `isEnabled()=true`, `scaling.z=1`, and only the composition's
  own camera/light exist (the GLB brought neither).

### 3.2 Gotchas found along the way (all real, worth keeping)
1. **file:// CORS** — fixed with the flag (§2).
2. **PBR needs *enough* light — but not necessarily IBL.** glTF uses
   metallic-roughness PBR, and with only a weak hemispheric light the metal reads
   as near-black, which is where the original "PBR is black without IBL" note came
   from. **Superseded by evidence:** the 15-second *Space Jump* render lit the
   same `super_starfury.glb` (all 11 materials `pbrMetallicRoughness`, metallic
   ≈0.68) to a clean, legible grey using **no `environmentTexture` at all** — just
   a hemispheric fill (0.45) plus two directional lights (key 2.6, rim 1.3). So:
   IBL buys you *reflections* and is worth adding for a hero beauty shot, but it
   is **not** required to get a lit result. If your metal is black, try a
   directional light at intensity ≳2 before building a procedural equirect.
3. **Model is large & offset** — never assume it sits at the origin or is ~1
   unit. Two ways to deal with it, and the second has a trap:
   - **Move the camera to the model** — frame from the bounding sphere:
     `distance = sphereRadius / sin(fov/2)`, `camera.maxZ` beyond that. Best when
     the model is the whole shot and stays put.
   - **Scale the model to the camera** — normalize it into known units
     (`scale = targetSize / max(size.x, size.y, size.z)`), which is easier when
     the model has to be *animated* against a fixed camera and hand-authored
     lights. `node.getHierarchyBoundingVectors(true)` gives you `{min,max}` over
     the whole subtree in one call — much less error-prone than a hand-rolled
     world-AABB loop over `loaded.meshes`, especially on a 45-node export.

   **The trap, if you normalize: keep the normalization scale on a node your
   frame function never touches.** Put it on the same node you animate and the
   first `setFrame` that assigns `scaling` silently wipes it, and the model jumps
   to native size — a Sketchfab export measured in centimetres then fills the
   frame ~250×. Use three nested nodes: an outer one you animate freely
   (position/rotation/scaling for a stretch effect), a middle one holding the
   fixed normalization scale, and an inner one holding the centring offset.
   The symptom is distinctive: a *correct-looking* model that is wildly too big
   and off-centre, rather than a missing or black one.
4. **Heavy model + per-frame `await`** — awaiting the 13.5 MB `ImportMeshAsync`
   *inside* `setFrame` trips Puppeteer `Protocol error … Promise was collected`.
   Fix: **load once, then `registerComposition`** so every `setFrame` is
   synchronous.
5. **CDN/build pitfalls** — an old `cdn.jsdelivr.net/npm/babylonjs@<v>/babylon.js`
   build (6.8 MB) rendered **nothing** (blank) here; the working core is
   `cdn.babylonjs.com` (8.2 MB). Core and loaders must be the **same version**.
   Both are now pinned and hash-locked — see §3.5, which also narrows this jsdelivr
   warning to the specific old build it described.
6. **Byte-size is a misleading proxy** — a blank/uniform frame and a
   mostly-flat-color frame are both ~8 KB PNGs. Always inspect actual pixels, not
   the file size.

### 3.3 The wall — root cause & fix (RESOLVED)
Reduced to a minimal box in a known-good project, `gl.readPixels` at screen
centre read the **clearColor, not the box** — even though the box was an active,
in-frustum mesh (`scene.meshes=1`, `getActiveMeshes()=1`, correct active camera).
The tell was **`mesh.isReady()=false` and `material.isReady()=false`**:

> **Babylon (and Three) compile material shaders lazily. The *first*
> `scene.render()` / `renderer.render()` SKIPS any mesh whose effect hasn't
> compiled yet.** The frame-driven path renders once and screenshots, so a
> single-frame capture (`render_still`, `capture_preview_frame`, or frame 0)
> shows only the clear. Video renders "worked" only because the page persists
> across frames — frame 0 warmed the shader and frames 1+ drew.

Both earlier symptoms ("loaders script → black", "meshes don't draw") were this
one cause surfacing at different times. Nothing about the loaders UMD, MSAA, or
`preserveDrawingBuffer` was actually broken.

**Fix (now baked into both starters):** compile shaders before the first frame.
- Babylon: `await Promise.all(scene.meshes.filter(m=>m.material).map(m => m.material.forceCompilationAsync(m)))` before `registerComposition`.
- Three: `renderer.compile(scene, camera)` before `registerComposition`.

Debugging tip that cracked it: read the true framebuffer with `gl.readPixels`
inside the composition (surface the value via a thrown error) — far more reliable
than inferring from PNG byte size, which conflates blank and uniform-color frames.
`mesh.isReady()` / `material.isReady()` tell you whether shaders are compiled.

### 3.4 Loading a glTF/GLB model (working recipe)
1. `add_library { library: "babylon", addons: ["loaders"] }` — vendors
   `babylonjs.loaders.min.js` and injects its `<script>` after the core.
2. Put the model under `assets/` (`write_asset_file`) and render with
   **`MOTION_STUDIO_ALLOW_LOCAL_FETCH=1`** (glTF fetches over file://, §2).
3. In the composition:
   - `const r = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'model.glb', scene)`.
   - `scene.animationGroups.forEach(g => g.stop())` — glTF animations are
     wall-clock; drive motion from `frame`.
   - Light the PBR materials: set `scene.environmentTexture` (a procedural
     equirect built on a `<canvas>` → data URL is hermetic).
   - **Frame from the bounds** (models aren't ~1 unit and rarely sit at the
     origin): world-AABB the geometry meshes, `distance = sphereRadius /
     sin(fov/2)`, set `camera.maxZ` beyond that.
   - **Warm up**: `forceCompilationAsync` on the imported meshes before
     `registerComposition`.
   - **Load once, then register** — never `await` the multi-MB import inside
     `setFrame` (it trips Puppeteer's `Promise was collected`).

Verified: `super_starfury.glb` (13.5 MB, 18 meshes, metallic PBR) renders as a
cinematic frame-driven video.

### 3.5 Build/CDN notes — pinned and hash-locked (v0.13)

Both libraries are now **version-pinned and content-locked**. The registry points
at versioned URLs and `engine/vendor.lock.json` (committed, unlike the artifacts
it describes) records the sha256 of every vendored build:

- Core: `https://cdn.babylonjs.com/v9.18.0/babylon.js`
- Loaders: `https://cdn.babylonjs.com/v9.18.0/loaders/babylonjs.loaders.min.js`
- Versioned paths need the **`v` prefix** — `/9.18.0/…` 404s, `/v9.18.0/…` works.
  The root `/babylonjs.loaders.min.js` also works but is unversioned.
- Core and loaders must be the **same version**.

**A version pin alone is not enough, and this is measurable.**
`cdn.babylonjs.com/babylon.js` and `cdn.babylonjs.com/v9.18.0/babylon.js` both
self-report `Version="9.18.0"` and are **different code** — 8,180,880 vs
8,180,848 bytes, diverging around byte 2,317,477 where the floating build carries
an extra `var t;`. A version string is a claim; a hash is a fact. (Both render the
ship identically, so the difference is immaterial *here* — but only checking told
us that.)

Verify what you have, and never let a silent swap through:

```bash
node scripts/fetch-libs.mjs --verify   # check disk against the lock, exit 1 on drift
node scripts/fetch-libs.mjs            # fetch; refuses to overwrite on hash mismatch
node scripts/fetch-libs.mjs --update   # accept a new build and rewrite the lock
```

`add_library` additionally stamps `config.libraryBuilds` into the project
(`{ version, sha256, bytes }` per copied file). That is not redundant with git
tracking the builds: git says what the repo holds *now*, `libraryBuilds` says what
the project copied *then* — and they diverge the moment the libraries are upgraded.

Note the version is recorded as `null` when a build does not state one: three's
`REVISION` is minified to `const e="134"` and the Babylon loaders bundle has no
banner at all. **The hash is the identity; the version is a courtesy label** — the
detector refuses to guess, because a wrong version is worse than no version.

The old warning that the jsdelivr `babylonjs@<v>/babylon.js` build "rendered
nothing" appears to be **version-specific**, not a property of jsdelivr: it
described a 6.8 MB artifact, whereas at 9.18.0 jsdelivr and the versioned
`cdn.babylonjs.com` path serve the same 8,180,848 bytes. Prefer
`cdn.babylonjs.com` anyway — it is the channel with known-good history here.

### 3.6 Status
Shipped and tested: `add_library` (three + babylon) with the babylon **`loaders`
addon**, the local-fetch flag, and the shader warm-up baked into both starters
(so single-frame captures render). Tests cover addon vendoring + `<script>`
injection and the unknown-addon errors.
