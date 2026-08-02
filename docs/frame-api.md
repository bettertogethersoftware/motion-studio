# Motion Studio Frame API Reference

The animation contract every Motion Studio composition must follow. The render engine calls your composition **once per frame, in any order, possibly across parallel worker processes** — so nothing in it may depend on wall-clock time or on how many times it has run.

Helpers come from `frame-api.js`, which is already in every scene folder and must load **before** `composition.js`.

> **"Scene" means two things — don't confuse them.** In this document a *scene* is a visual section of one composition (a title card, a chapter). Motion Studio also calls a whole composition folder a **scene** (`"<film>/<scene>"` — the unit that renders). Reach for the second one first: a long video should be **many short scenes in one film**, stitched by `build_film`, not many sections inside one giant composition. §3's recipe is for when you genuinely do hold several sections in a single composition.

## 1. `MotionStudio.registerComposition(fn)` — the entry point

Pass a function of `frame`. The harness installs `window.setFrame` around it and guarantees:

- `window.frameReady` is `false` while your function runs;
- if your function is `async` (or returns a promise), `frameReady` flips `true` only after it resolves;
- `document.fonts.ready` is awaited before the first captured frame;
- the current frame is exposed to `Sequence()`;
- exceptions surface as a structured `composition_error` naming the frame, instead of hanging until the frame timeout.

```js
MotionStudio.registerComposition((frame) => {
  const el = document.getElementById('logo');
  const scale = interpolate(frame, [0, 30], [0.5, 1], { easing: 'easeOut' });
  el.style.transform = `scale(${scale})`;
});
```

Your function must be a **pure function of `frame`**: given the same `n`, it must produce the same visual output regardless of how many times it has been called before, or in what order frames are requested.

**Never use in composition code:**

- `Date.now()`, `performance.now()`, or any real-clock read
- `setTimeout` / `setInterval` to drive animation state
- CSS `transition` or `animation` with real-time durations — they animate over wall-clock time, not frame number; compute the final value with `interpolate` and set it directly
- `Math.random()` — use `MotionStudio.random(seed)` (§5)
- Any mutable counter that changes based on how many times the frame function has run
- `video.play()` / `audio.play()` — media playback advances on the wall clock; seek per frame instead (§11)

## 2. `interpolate(frame, inputRange, outputRange, options?)`

Maps a frame number to an eased output value — the core primitive for animating any numeric property (position, opacity, scale, rotation, color channels). Available as `MotionStudio.interpolate` and as the bare global `interpolate`.

```js
const opacity = interpolate(frame, [0, 20], [0, 1]);
const x = interpolate(frame, [0, 15, 45, 60], [0, 200, 200, 0], { easing: 'easeInOut' });
```

- `inputRange` must be **strictly increasing**; `outputRange` must be the same length. A violation throws, naming the offending pair — note a descending range often survives frame 0 and only throws at the first frame that reaches the call. If you are mapping a quantity that goes *negative* (deceleration, a downward offset), negate it and keep the range ascending: `interpolate(-accel, [4, 14], [0, 1])`, not `interpolate(accel, [-4, -14], [0, 1])`.
- Multi-segment ranges (second example) chain distinct phases — move in, hold, move out — in one call.
- Values outside `inputRange` **clamp** to the nearest endpoint by default; pass `{ extrapolate: 'extend' }` to continue the boundary segment's line instead.
- `options.easing` is a name from `MotionStudio.easings` — `linear` (default), `easeIn`, `easeOut`, `easeInOut`, `easeInQuad`, `easeOutQuad`, `easeOutBack` (overshoot pop-in), `easeOutElastic` (springy settle) — or your own `(t: 0..1) => number`. Easing applies per segment.

## 3. `Sequence(from, durationInFrames, fn)`

Time-offsets part of the composition so its internal logic is authored as if it started at frame 0. `fn(localFrame)` runs only while `from <= frame < from + durationInFrames`, with `localFrame = frame - from`. Returns `true` if the sequence was active this frame.

```js
MotionStudio.registerComposition((frame) => {
  title.style.opacity = 0;          // hide by default; sequences own visibility
  lowerThird.style.opacity = 0;

  Sequence(0, 60, (f) => renderTitle(f));        // overall frames 0–59
  Sequence(45, 90, (f) => renderLowerThird(f));  // overlaps 45–59 → crossfade
});
```

Sequences need not be contiguous or non-overlapping. Elements a sequence controls keep their last styles when it ends, so **reset/hide elements at the top of every frame** (as above) — each frame must be fully determined by that frame alone.

### Section visibility — the only safe recipe

When one composition holds several sections:

1. every section container is **hidden by default in CSS** (`.section { opacity: 0; }` on markup that carries the class in the HTML — not added later);
2. each `Sequence` turns **its own section on** (`el.style.opacity = 1`) and never touches the others;
3. nothing in the frame function calls `classList.add` / `classList.remove` — a class added at frame N persists to every later frame *and never exists for a worker that starts mid-render*, so a reset loop selecting a runtime-added class, and any show/hide scheme built on class accumulation, are broken by construction. `classList.toggle(name, condition)` with a boolean is fine: it sets an absolute state each frame.

**Rule 1 applies to *every* element, not just the ones you thought of as sections.** An `<img>`, panel or badge sitting in the markup with no `opacity: 0` and no code touching it is visible for the entire video — behind every section in turn, at whatever opacity the stylesheet gave it. The test is ownership: **for each element that ever appears, name the single `Sequence` that turns it on.** If there isn't one, the element is either dead markup or a permanent overlay you didn't intend; both are bugs, and neither is an error.

The failure this prevents: every section visible at once, stacked, for the whole video — while every automated check passes, because nothing about it is an error. Note that direction 1→2 (a container that is never turned *on*) and direction 2→1 (a container that is never turned *off*) are equally silent: the first ships a video missing its subject, the second ships one where the subject never leaves. Both look intentional in any single preview frame, which is why you compare captures from *different* sections — an element identical in all of them is owned by none of them.

`write_composition_file` flags `classList.add/remove` and checks literal `Sequence(start, duration)` calls against the composition duration (gaps and uncovered tails come back as `sequence-gap` warnings). Calls spread across mutually exclusive helper scopes are intentionally not merged into one coverage claim; same-scope sibling calls are still checked. Neither check can see the ownership rule above: the lint compares the `Sequence` calls you *wrote* against the duration, so a composition that writes none, or one whose markup carries an unowned element, passes clean.

## 4. `window.frameReady` (manual mode)

If you assign `window.setFrame` yourself instead of using `registerComposition`, you own the readiness handshake: set `window.frameReady = true` only once the DOM for the current frame is fully settled — fonts loaded, images decoded, layout stable. The capture loop polls this flag, screenshots when it sees `true`, and resets it before the next frame.

```js
window.setFrame = async function (frame) {
  window.frameReady = false;
  await applyFrameState(frame);   // may await image.decode(), document.fonts.ready, …
  window.frameReady = true;
};
```

**Common mistake:** setting `frameReady = true` synchronously when the function does async work — the engine screenshots before fonts/images finish. `registerComposition` makes this mistake impossible; prefer it.

If your frame function throws, set `window.__frameError = String(err)` (registerComposition does this for you) so the engine fails fast with the real error instead of waiting out the frame timeout.

## 5. `MotionStudio.random(seed)` — deterministic randomness

Returns a seeded PRNG. Seed it from `frame` (or a constant per element) so "random" motion stays a pure function of frame:

```js
const rng = MotionStudio.random(frame);          // per-frame jitter
const flicker = 0.9 + rng() * 0.1;

const rngStars = MotionStudio.random(1234);      // fixed layout, same every frame
for (let i = 0; i < 100; i++) placeStar(rngStars(), rngStars());
```

## 6. `spring(frame, options?)` — physical motion

A physically-based spring from **0 to 1**, evaluated in **closed form** — a pure function of `frame` with no simulation state, so it stays correct under parallel and out-of-order rendering.

```js
// A title that pops in at frame 15 with a natural overshoot:
Sequence(15, 180, (f) => {
  const s = spring(f, { fps: 30, stiffness: 150, damping: 11 });
  title.style.transform = `scale(${0.7 + 0.3 * s})`;
});
```

Options (all optional): `fps` (default 30 — pass your scene's fps), `stiffness` (default 100), `damping` (default 10), `mass` (default 1). Negative/zero frames return 0. Lower damping = more bounce; damping `2·√(stiffness·mass)` is critically damped (no overshoot). Map the 0→1 output onto whatever you're animating, exactly as with `interpolate`.

## 7. `interpolateColors(frame, inputRange, colors)`

Piecewise color interpolation with the same range semantics as `interpolate`. Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` stops; returns an `rgba(r, g, b, a)` string (alpha interpolates too).

```js
bg.style.background = interpolateColors(frame, [0, 60, 120],
                                        ['#0b1026', '#274690', '#f9564f']);
```

## 8. `Loop(durationInFrames, fn)`

Repeats a sub-animation forever: calls `fn(localFrame, cycleIndex)` where `localFrame = frame % duration`. Composes with `Sequence`:

```js
Sequence(0, 300, () => {
  Loop(24, (lf) => {                     // a 24-frame pulse, repeating
    const pulse = Math.sin((lf / 24) * Math.PI);
    dot.style.transform = `scale(${1 + pulse * 0.45})`;
  });
});
```

## 9. `particles(frame, options?)`

Deterministic looping particle emitter — use this instead of any library particle system (those are wall-clock driven and break the frame contract). Returns one state per particle, a pure function of `frame`:

- `phase` — 0..1 through the particle's life, uniformly staggered by index
- `cycle` — which rebirth this is
- `u` — four random values in 0..1, **stable per (particle, cycle)**: use them for spawn jitter, size, drift, hue — anything that must not flicker between frames; they re-roll each time the particle is reborn

```js
// steam rising from a teapot spout (puffs = 14 pre-made meshes/divs):
particles(frame, { count: 14, lifeFrames: 90, seed: 7 }).forEach((p) => {
  const m = puffs[p.index];
  m.position.set(x0 + (p.u[0] - 0.5) * 0.6 * p.phase,   // stable drift
                 y0 + p.phase * 2.3,                     // rise
                 (p.u[1] - 0.5) * 0.4 * p.phase);
  m.material.opacity = 0.3 * Math.sin(p.phase * Math.PI); // fade in+out
  const s = 0.6 + p.phase * (1 + p.u[2]);
  m.scale.set(s, s, s);
});
```

Options: `count` (default 20), `lifeFrames` (default 60), `seed` (default 1 — vary for independent emitters), `speed` (default 1). Create the DOM nodes / meshes once at setup; `particles()` only computes states.

## 10. Per-frame async work (images, fonts)

Anything the frame's pixels depend on must resolve before the screenshot. With `registerComposition`, make your function `async` and await it:

```js
MotionStudio.registerComposition(async (frame) => {
  img.src = `assets/slide-${Math.floor(frame / 30)}.png`;
  await img.decode();                       // decoded before capture
  img.style.opacity = interpolate(frame % 30, [0, 10], [0, 1]);
});
```

## 11. `seekVideo(video, seconds, {fps})` — footage in a composition

Real video **can** be layered into a composition (a talking-head PIP, a background plate). It is the one asset type that cannot simply be drawn, because it has a playhead: calling `video.play()` makes the picture a function of wall-clock time, which breaks the contract in §1 outright — under parallel rendering each worker would capture a different moment.

So a composition **seeks** instead: one frame of footage per frame of output.

```js
const host = document.getElementById('host');   // <video src="assets/host.webm" muted preload="auto">

MotionStudio.registerComposition(async (frame) => {
  await seekVideo(host, 2.0 + frame / 30, { fps: 30 });   // 2.0 = in-point in the clip
  host.style.opacity = interpolate(frame, [0, 12], [0, 1]);
});
```

`seekVideo` resolves once the element is displaying that time, and returns `false` if the element is unusable. It exists because the obvious hand-rolled version has three defects, and the first is severe:

1. **Never await `seeked` on an element that failed to load.** A `<video>` whose `src` is missing or undecodable never fires `seeked`, so `currentTime = t; await seeked` **deadlocks the frame** — the render stalls until the frame timeout, and every subsequent frame does the same. `seekVideo` checks `duration > 0 && readyState >= 1` first and bails, turning a hang into a missing picture. (The engine also names failed asset loads in the error message; see §12.)
2. **Clamp to the last real frame.** Pass `fps` and the target is clamped to `duration - 1/fps`. Seeking past the end may never complete, and a scene longer than its footage otherwise freezes or stalls at the tail — check the clip is long enough for the range you are using: `from + sceneDuration/fps <= clipDuration`.
3. **Skip a seek that is already satisfied**, or a re-render of the same frame pays a pointless round trip.

`videoReady(video)` awaits `loadeddata` for setup, and resolves on `error` too, so a missing file cannot deadlock there either.

**Two things to settle before you author the scene**, both invisible in a still frame:

- **Codec.** The render browser is Chromium *without* proprietary codecs: an **H.264/HEVC** file fails at render time even though the page's own `canPlayType()` answers `"probably"`. Use **VP8/VP9/AV1 in `.webm`**. Check with the `probe_asset` tool before writing any code — it reports the codec and warns about exactly this. **You can fix it yourself:** `transcode_asset { target, from, to: "assets/clip.webm", mode: "video" }` produces a file the browser can decode, and the response measures the result so you know it worked.
- **Length and frame rate.** `probe_asset` also gives you `durationSeconds` and `fps`, which is what the scene's `durationInFrames` and your in-points have to be built around. A short GOP makes per-frame seeking much faster, so pass `video: { gop: 10 }` when you transcode — and while you are there, `crop`/`scale` down to the size the scene actually shows, because footage costs render time per frame.

Footage costs real render time — each frame is a seek plus a decode. If you only need a plain rectangular overlay with no masking or 3D, a film-level **overlay track** composites it with ffmpeg at build time instead, and never touches the browser.

## 12. `beatGrid({bpm, phase, fps, startSeconds?})` — lock visuals to music

Everything that should hit *with* the track — a pulse, a shake, a cut, a placed
audio cell — comes from here. Build it once from a **measured** grid and read it
per frame:

```js
const beat = MotionStudio.beatGrid({ bpm: 140.004, phase: 0.404, fps: 30,
                                     startSeconds: 49.567 });  // this scene's film offset

MotionStudio.registerComposition((frame) => {
  const punch = 1 + 0.05 * beat.pulse(frame);      // every beat
  const flash = beat.barPulse(frame);              // downbeats only
  logo.style.transform = `scale(${punch})`;
});
```

Returns `pulse(frame, sharpness?)`, `barPulse(frame, sharpness?)`,
`position(frame)` (fractional beat index), `timeAt(frame)`, `frameOfBeat(n)`,
`frameOfBar(n)`, `nearestDownbeat(seconds)`, plus `beatSeconds`, `barSeconds`
and `beatFrames`.

**Two mistakes this exists to remove**, both of which shipped in hand-written
compositions before it:

- **A beat is not an integer number of frames.** At 150 BPM/30fps it happens to
  be exactly 12, which is what makes the trap so easy: at 140 BPM it is
  **12.857**, so `frame % 12` slides a full beat every ~7 seconds and the video
  visibly drifts off the music by the second chorus. Everything here derives
  from seconds and stays fractional.
- **The tempo you asked for is not the tempo you got.** Measured: a loop
  requested at 140 BPM came back at **105**. `bpm`/`phase` must come from
  measuring the finished audio, not from the prompt or the sidecar that
  generated it — `videoforge/audiogrid.py grid` reports both, plus a `holds`
  flag for whether the tempo survives the whole file.

`startSeconds` is the scene's own offset on the film timeline (`filmOffset / fps`
from `get_film`'s plan), so every scene reads the same absolute grid and cuts
land in the same place whether you address them from the film or from inside a
scene.

## 13. Checklist before rendering

- [ ] No `Date.now()`, `setTimeout`, `setInterval`, `Math.random()`, or real-time CSS transitions/animations anywhere
- [ ] Composition registered via `MotionStudio.registerComposition` (or a correct manual `setFrame`)
- [ ] Frame function produces identical output for the same `frame` regardless of call history; elements hidden/reset at the top of each frame
- [ ] All per-frame async work (font/image loading, **video seeks**) is awaited inside the frame function
- [ ] Multi-element timing uses `Sequence` rather than frame-offset arithmetic scattered through the code
- [ ] Section containers are hidden by **default in CSS** and only turned on by their own `Sequence`; no `classList.add`/`remove` in the frame function (§3)
- [ ] **Every element that ever appears has exactly one owning `Sequence`** — nothing is visible by default, and nothing stays visible after its section ends (§3). Compare captures from different sections: anything present in all of them is unowned
- [ ] Scripts, fonts and images are loaded from `assets/`, never from a URL — a CDN `<script src>` previews fine and is a coin-flip across parallel render workers
- [ ] **Canvas:** every `ctx.save()` has a matching `ctx.restore()` (an unrestored transform relocates everything drawn later in the frame), and `fillStyle`/`strokeStyle` are set *inside* loops whose bodies call helpers that also set them
- [ ] Literal `Sequence(start, duration)` calls tile the full composition duration — no unscheduled gaps
- [ ] Springy/looping motion uses `spring()` / `Loop()` — never incremental per-frame physics or accumulated state
- [ ] Particle effects use `particles()` — never a library particle system or per-frame velocity accumulation
- [ ] **Footage** is driven by `seekVideo()`, never `play()`; the file is VP8/VP9/AV1 in `.webm` (H.264 cannot be decoded by the render browser) and long enough for the range the scene uses — confirm both with `probe_asset` (§11)
- [ ] A frame that never becomes ready: read the whole error message — it lists assets that failed to load, and a missing file a `<video>`/`<img>` was waiting on is the usual cause
- [ ] `frame-api.js` is included via `<script>` **before** `composition.js`
- [ ] Spot-checked with `capture_preview_frames` at the start, a midpoint, the end, and every `Sequence` boundary — one call, not one per frame
- [ ] `write_composition_file` returned no `warnings` — or each one is understood and deliberate
