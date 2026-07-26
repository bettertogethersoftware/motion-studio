# Motion Studio Frame API Reference (v1.3)

This is the animation contract every Motion Studio composition must follow. It exists so the render engine can call your composition once per frame, in any order, possibly split across parallel worker processes — nothing in your composition may depend on wall-clock time or call order.

> **Changed from the draft reference**: compositions now register through `MotionStudio.registerComposition(fn)` instead of assigning `window.setFrame` by hand. The harness owns the `frameReady` handshake (including async work), which removes the most common authoring bug — setting `frameReady = true` before fonts/images finish. Assigning `window.setFrame` directly is still supported for full manual control, with the same semantics as before. Helpers are provided by `frame-api.js`, which is copied into every project and must load **before** `composition.js`.

## 1. `MotionStudio.registerComposition(fn)` — the standard entry point

Pass a function of `frame`. The harness installs `window.setFrame` around it and guarantees:

- `window.frameReady` is `false` while your function runs;
- if your function is `async` (or returns a promise), `frameReady` flips `true` only after it resolves;
- `document.fonts.ready` is awaited before the first captured frame;
- the current frame is exposed to `Sequence()`;
- exceptions are surfaced to the render engine as a structured `composition_error` naming the frame, instead of hanging until the frame timeout.

```js
MotionStudio.registerComposition((frame) => {
  const el = document.getElementById('logo');
  const scale = interpolate(frame, [0, 30], [0.5, 1], { easing: 'easeOut' });
  el.style.transform = `scale(${scale})`;
});
```

Your function must be a **pure function of `frame`**: given the same `n`, it must produce the same visual output regardless of how many times it has been called before or in what order frames are requested.

**Do not use anywhere in composition code:**

- `Date.now()`, `performance.now()`, or any real-clock read
- `setTimeout` / `setInterval` for driving animation state
- CSS `transition` or `animation` with real-time durations — these animate over wall-clock time, not frame number; compute final values with `interpolate` and set them directly
- `Math.random()` — use `MotionStudio.random(seed)` (§5)
- Any mutable counter that changes based on how many times the frame function has run (call order/count is not guaranteed, especially under parallel rendering)

## 2. `interpolate(frame, inputRange, outputRange, options?)`

Maps a frame number to an eased output value — the core primitive for animating any numeric property (position, opacity, scale, rotation, color channels). Available both as `MotionStudio.interpolate` and the bare global `interpolate`.

```js
const opacity = interpolate(frame, [0, 20], [0, 1]);
const x = interpolate(frame, [0, 15, 45, 60], [0, 200, 200, 0], { easing: 'easeInOut' });
```

- `inputRange` must be strictly increasing; `outputRange` must be the same length. A violation throws with the offending pair and the full array named (v1.2) — worth knowing because a descending range often survives frame 0 and only throws at the first frame that reaches the call. If you are mapping a quantity that goes *negative* (deceleration, a downward offset), negate it and keep the range ascending: `interpolate(-accel, [4, 14], [0, 1])`, not `interpolate(accel, [-4, -14], [0, 1])`.
- Multi-segment ranges (second example) chain distinct phases — move in, hold, move out — in one call.
- Values outside `inputRange` **clamp** to the nearest endpoint by default; pass `{ extrapolate: 'extend' }` to continue the boundary segment's line instead.
- `options.easing` is a name from `MotionStudio.easings` — `linear` (default), `easeIn`, `easeOut`, `easeInOut`, `easeInQuad`, `easeOutQuad`, `easeOutBack` (overshoot pop-in), `easeOutElastic` (springy settle) — or your own `(t: 0..1) => number` function. Easing applies per segment.

## 3. `Sequence(from, durationInFrames, fn)`

Time-offsets a piece of the composition so its internal logic is authored as if it started at frame 0. Inside the current frame function, `fn(localFrame)` runs only while `from <= frame < from + durationInFrames`, with `localFrame = frame - from`. Returns `true` if the sequence was active this frame — use that (or set styles inside `fn`) to control visibility.

```js
MotionStudio.registerComposition((frame) => {
  title.style.opacity = 0;          // hide by default; sequences own visibility
  lowerThird.style.opacity = 0;

  Sequence(0, 60, (f) => renderTitle(f));        // overall frames 0–59
  Sequence(45, 90, (f) => renderLowerThird(f));  // overlaps 45–59 → crossfade
});
```

Sequences need not be contiguous or non-overlapping. Because elements a sequence controls keep their last styles when the sequence ends, reset/hide elements at the top of every frame (as above) so each frame is fully determined by that frame alone.

**Scene visibility, the safe recipe (v1.4).** When one composition holds several scenes, the *only* robust pattern is:

1. every scene container is **hidden by default in CSS** (`.scene { opacity: 0; }` on markup that carries the class in the HTML — not added later);
2. each `Sequence` turns **its own scene on** (`el.style.opacity = 1`) and never touches the others;
3. nothing inside the frame function calls `classList.add`/`classList.remove` — a class added at frame N persists to every later frame *and never exists for a render worker that starts mid-film*, so both a reset loop that selects a runtime-added class and any show/hide scheme built on class accumulation are broken by construction. `classList.toggle(name, condition)` with a boolean is fine: it sets an absolute state each frame.

The failure mode this prevents: every scene of a multi-minute video visible at once, stacked, for the entire duration — while all automated checks pass, because nothing about it is an error. The `write_composition_file` lint flags `classList.add/remove` and statically checks literal `Sequence(start, duration)` calls against the composition duration (gaps and uncovered tails come back as `sequence-gap` warnings).

## 4. `window.frameReady` (manual mode)

If you assign `window.setFrame` yourself instead of using `registerComposition`, you own the readiness handshake: set `window.frameReady = true` only once the DOM for the current frame is fully settled — fonts loaded, images decoded, layout stable. The capture loop polls this flag, screenshots when it sees `true`, and resets it before the next frame.

```js
window.setFrame = async function (frame) {
  window.frameReady = false;
  await applyFrameState(frame);   // may await image.decode(), document.fonts.ready, …
  window.frameReady = true;
};
```

**Common mistake**: setting `frameReady = true` synchronously when the function does async work — the engine will screenshot before fonts/images finish. `registerComposition` makes this mistake impossible; prefer it.

If your frame function throws, set `window.__frameError = String(err)` (registerComposition does this automatically) so the engine fails fast with the real error instead of waiting out the frame timeout.

## 5. `MotionStudio.random(seed)` — deterministic randomness

Returns a seeded PRNG. Seed it from `frame` (or a constant per element) so "random" motion is still a pure function of frame:

```js
const rng = MotionStudio.random(frame);          // per-frame jitter
const flicker = 0.9 + rng() * 0.1;

const rngStars = MotionStudio.random(1234);      // fixed layout, same every frame
for (let i = 0; i < 100; i++) placeStar(rngStars(), rngStars());
```

## 6. `spring(frame, options?)` — physical motion (v1.1)

A physically-based spring from **0 to 1**, evaluated in **closed form** — it
is a pure function of `frame` with no simulation state, so it stays correct
under parallel and out-of-order rendering (a worker starting mid-composition
computes the identical value a serial render does).

```js
// A title that pops in at frame 15 with a natural overshoot:
Sequence(15, 180, (f) => {
  const s = spring(f, { fps: 30, stiffness: 150, damping: 11 });
  title.style.transform = `scale(${0.7 + 0.3 * s})`;
});
```

Options (all optional): `fps` (default 30 — pass your project fps),
`stiffness` (default 100), `damping` (default 10), `mass` (default 1).
Negative/zero frames return 0. Lower damping = more bounce; damping
`2·√(stiffness·mass)` is critically damped (no overshoot). Map the 0→1
output onto whatever you're animating, exactly as with `interpolate`.

## 7. `interpolateColors(frame, inputRange, colors)` (v1.1)

Piecewise color interpolation with the same range semantics as
`interpolate`. Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`
stops; returns an `rgba(r, g, b, a)` string (alpha interpolates too).

```js
bg.style.background = interpolateColors(frame, [0, 60, 120],
                                        ['#0b1026', '#274690', '#f9564f']);
```

## 8. `Loop(durationInFrames, fn)` (v1.1)

Repeats a sub-animation forever: calls `fn(localFrame, cycleIndex)` where
`localFrame = frame % duration`. Composes with `Sequence`:

```js
Sequence(0, 300, () => {
  Loop(24, (lf) => {                     // a 24-frame pulse, repeating
    const pulse = Math.sin((lf / 24) * Math.PI);
    dot.style.transform = `scale(${1 + pulse * 0.45})`;
  });
});
```

## 9. `particles(frame, options?)` (v1.3)

Deterministic looping particle emitter — the frame-contract replacement for
the wall-clock particle systems the 3D libraries ship (all banned: see
docs/3d-libraries.md). Returns one state per particle, a pure function of
`frame`:

- `phase` — 0..1 through the particle's life, uniformly staggered by index
- `cycle` — which rebirth this is
- `u` — four random values in 0..1, **stable per (particle, cycle)**: use them
  for spawn jitter, size, drift, hue — anything that must not flicker between
  frames; they re-roll each time the particle is reborn

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

Options: `count` (default 20), `lifeFrames` (default 60), `seed` (default 1 —
vary for independent emitters), `speed` (default 1). Create the DOM nodes /
meshes once at setup; `particles()` only computes states.

## 10. Per-frame async work (images, fonts)

Anything the frame's pixels depend on must resolve before the screenshot. With `registerComposition`, just make your function `async` and await it:

```js
MotionStudio.registerComposition(async (frame) => {
  img.src = `assets/slide-${Math.floor(frame / 30)}.png`;
  await img.decode();                       // decoded before capture
  img.style.opacity = interpolate(frame % 30, [0, 10], [0, 1]);
});
```

## 11. Practical checklist before rendering

- [ ] No `Date.now()`, `setTimeout`, `setInterval`, `Math.random()`, or real-time CSS transitions/animations anywhere
- [ ] Composition registered via `MotionStudio.registerComposition` (or a correct manual `setFrame`)
- [ ] Frame function produces identical output for the same `frame` value regardless of call history; elements hidden/reset at the top of each frame
- [ ] All per-frame async work (font/image loading) is awaited inside the frame function
- [ ] Multi-element timing uses `Sequence` rather than frame-offset arithmetic scattered through the code
- [ ] Scene containers are hidden by **default in CSS** and only turned on by their own `Sequence`; no `classList.add`/`remove` anywhere in the frame function (§3's scene-visibility recipe)
- [ ] **Canvas work:** every `ctx.save()` has a matching `ctx.restore()` (an unrestored transform relocates everything drawn later in the frame), and `fillStyle`/`strokeStyle` are set *inside* loops whose bodies call helpers that also set them
- [ ] Literal `Sequence(start, duration)` calls tile the full composition duration — no unscheduled gaps (`sequence-gap` warnings are clean)
- [ ] Springy/looping motion uses `spring()` / `Loop()` (pure functions of frame) — never incremental per-frame physics or accumulated state
- [ ] Particle-style effects (steam, dust, sparks, rain) use `particles()` — never a library particle system or per-frame velocity accumulation
- [ ] `frame-api.js` is included via `<script>` **before** `composition.js`
- [ ] Spot-checked with `capture_preview_frames` at the start, a midpoint, the end, and every `Sequence` boundary before running a full render (one call, not one per frame)
- [ ] `write_composition_file` returned no determinism `warnings` — or each one is understood and deliberate
