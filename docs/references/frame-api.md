# Motion Studio Frame API Reference (v1.2)

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

## 9. Per-frame async work (images, fonts)

Anything the frame's pixels depend on must resolve before the screenshot. With `registerComposition`, just make your function `async` and await it:

```js
MotionStudio.registerComposition(async (frame) => {
  img.src = `assets/slide-${Math.floor(frame / 30)}.png`;
  await img.decode();                       // decoded before capture
  img.style.opacity = interpolate(frame % 30, [0, 10], [0, 1]);
});
```

## 10. Practical checklist before rendering

- [ ] No `Date.now()`, `setTimeout`, `setInterval`, `Math.random()`, or real-time CSS transitions/animations anywhere
- [ ] Composition registered via `MotionStudio.registerComposition` (or a correct manual `setFrame`)
- [ ] Frame function produces identical output for the same `frame` value regardless of call history; elements hidden/reset at the top of each frame
- [ ] All per-frame async work (font/image loading) is awaited inside the frame function
- [ ] Multi-element timing uses `Sequence` rather than frame-offset arithmetic scattered through the code
- [ ] Springy/looping motion uses `spring()` / `Loop()` (pure functions of frame) — never incremental per-frame physics or accumulated state
- [ ] `frame-api.js` is included via `<script>` **before** `composition.js`
- [ ] Spot-checked with `capture_preview_frames` at the start, a midpoint, the end, and every `Sequence` boundary before running a full render (one call, not one per frame)
- [ ] `write_composition_file` returned no determinism `warnings` — or each one is understood and deliberate
