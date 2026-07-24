/*
 * Lower Third — Motion Studio example (120 frames @ 30fps = 4s)
 *
 * A broadcast-style lower third rendered with a REAL alpha channel:
 * project.json sets output.format = "webm" and output.transparent = true,
 * so the deliverable drops onto any timeline as an overlay.
 *
 * Showcases the v1.1 Frame API:
 *   - spring()            physical slide-in for the plate (no keyframe guessing)
 *   - Loop()              the "live" dot pulses every 24 frames, forever
 *   - interpolateColors() the pulse blends red → amber and back
 *
 * Timeline (frames):
 *   0 ───── 20 ────────────────── 96 ───── 119
 *   plate springs in   hold + pulse    slide out
 */

/* global MotionStudio, interpolate, Sequence, Loop, spring, interpolateColors */

const FPS = 30;
const DURATION = 120;

const plate = document.getElementById('plate');
const name = document.getElementById('name');
const role = document.getElementById('role');
const rule = document.getElementById('rule');
const dot = document.getElementById('live-dot');

MotionStudio.registerComposition((frame) => {
  // Every frame fully self-determined: reset, then paint.
  for (const el of [plate, rule]) el.style.opacity = 0;

  // 1) Plate springs in from the left; slight overshoot sells the weight.
  //    Runs for the FULL duration (the spring settles at 1) so the text and
  //    pulse are pure functions of frame even mid-exit — a parallel worker
  //    starting at frame 100 paints the identical pixels a serial render does.
  Sequence(0, DURATION, (f) => {
    const s = spring(f, { fps: FPS, stiffness: 120, damping: 12 });
    plate.style.opacity = Math.min(1, s * 2);
    plate.style.transform = `translateX(${(1 - s) * -420}px)`;

    // Text lines reveal with a short stagger once the plate has arrived.
    name.style.transform = `translateY(${interpolate(f, [6, 20], [110, 0], { easing: 'easeOut' })}%)`;
    role.style.transform = `translateY(${interpolate(f, [12, 26], [110, 0], { easing: 'easeOut' })}%)`;

    // The "live" dot pulses on a 24-frame cycle for as long as we hold.
    Loop(24, (lf) => {
      const pulse = Math.sin((lf / 24) * Math.PI); // 0 → 1 → 0 each cycle
      dot.style.transform = `scale(${1 + pulse * 0.45})`;
      dot.style.background = interpolateColors(lf, [0, 12, 23], ['#ff5c4d', '#ffb454', '#ff5c4d']);
    });
  });

  // 2) Accent rule draws out under the plate, slightly behind the spring.
  Sequence(4, 92, (f) => {
    rule.style.opacity = 1;
    rule.style.width = `${interpolate(f, [0, 22], [0, 560], { easing: 'easeOut' })}px`;
  });

  // 3) Exit: overrides plate/rule AFTER block 1 (code order = paint order),
  //    sliding everything out over the last 24 frames.
  Sequence(96, DURATION - 96, (f) => {
    const out = interpolate(f, [0, 23], [0, 1], { easing: 'easeIn' });
    plate.style.opacity = 1 - out;
    plate.style.transform = `translateX(${out * -160}px)`;
    rule.style.opacity = 1 - out;
    rule.style.width = `${interpolate(f, [0, 23], [560, 0], { easing: 'easeIn' })}px`;
  });
});
