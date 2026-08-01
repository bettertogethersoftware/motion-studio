# Aurora Intro (reference composition)

A 1080p, 10-second title sequence (300 frames @ 30 fps → `mp4`). Built as a
denser companion reference to the basic `intro-title` example — same runtime,
same frame-purity contract, but exercises **every** Frame API primitive at
least once, including two the basic example never demonstrates:

- **`particles()`** — a real particle system (rising embers inside the aurora
  background), driven purely by `frame`, safe under parallel/out-of-order
  rendering. `intro-title` only shows the manual `MotionStudio.random`
  approach for a static starfield; this shows the built-in emitter primitive
  for something that visibly moves and evolves.
- **`Loop()`** — the status badge's pulsing dot, a bounded repeating
  sub-animation nested inside a `Sequence`.

Also demonstrates, at higher density than the basic example: staggered
multi-word title entrance (two spring pops offset by 8 frames instead of one),
a color-swept underline synced to the same palette as the background
(`interpolateColors` driving two separate elements from one source of truth),
and a three-item chip row with per-index stagger and overshoot easing.

## Why this is worth copying from

- **Every Sequence window is independently timed and overlaps at least one
  neighbor** — badge, rule+kicker, title, underline, subtitle, and chips all
  have their own `from`/`durationInFrames`, chosen so exits and entrances
  cross rather than snap. Read the timeline comment at the top of
  `composition.js` before changing any of the numbers; they were chosen
  together, not independently.
- **Shared palette, one source of truth.** The aurora background and the
  title underline both call `interpolateColors(frame, [...], [...])` with the
  same two colors, so nothing in the frame can visually clash even as both
  drift over 10 seconds.
- **Staggering via frame offset, not extra state.** The two-word title and
  the three chips both fake a "cascade" by subtracting a small constant from
  `f` before feeding it into `interpolate`/`spring` — no counters, no stored
  timers, still a pure function of frame.
- **`particles()` output is consumed, not stored.** Each call returns fresh
  per-particle state for the current frame only; nothing is pushed into an
  array and mutated. That's what makes it safe to render frames out of order
  or across parallel workers.

## Render it

```bash
cd ../../engine
node src/cli/render.js --project ../examples/aurora-intro \
  --output ../examples/aurora-intro/out/aurora-intro.mp4 --workers 3
```

No narration track is attached in this version (`audio: []` in
`scene.json`). To add one, follow the `synthesize_speech` pattern documented
in `intro-title/README.md` — pick a `startInFrames` that lands after the
badge fade-in (frame 20+) and keep the total narration under ~9s so it
resolves before the outro card takes over.
