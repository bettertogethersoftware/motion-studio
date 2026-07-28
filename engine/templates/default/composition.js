/*
 * __SCENE_NAME__ — Motion Studio composition
 *
 * Everything below is a pure function of `frame`. Never read the clock,
 * never use setTimeout/setInterval or CSS transitions/animations with
 * real-time durations. See the Frame API reference (docs/frame-api.md or the
 * motion-studio://reference/frame-api MCP resource).
 */

/* global MotionStudio, interpolate, Sequence */

const FPS = __FPS__;
const DURATION = __DURATION__; // total frames

const title = document.getElementById('title');
const subtitle = document.getElementById('subtitle');

function drawFrame(frame) {
  // Hide everything first so Sequence blocks fully own visibility.
  title.style.opacity = 0;
  subtitle.style.opacity = 0;

  // Title: pops in over the first second, holds, fades near the end.
  Sequence(0, DURATION, (f) => {
    const inScale = interpolate(f, [0, FPS], [0.6, 1], { easing: 'easeOutBack' });
    const inOpacity = interpolate(f, [0, Math.round(FPS * 0.6)], [0, 1]);
    const outOpacity = interpolate(f, [DURATION - FPS, DURATION - 1], [1, 0]);
    title.style.opacity = Math.min(inOpacity, outOpacity);
    title.style.transform = `translate(-50%, -50%) scale(${inScale})`;
  });

  // Subtitle: enters half a second later, slides up as it fades in.
  Sequence(Math.round(FPS * 0.5), DURATION - Math.round(FPS * 0.5), (f) => {
    const opacity = interpolate(f, [0, FPS], [0, 1], { easing: 'easeOut' });
    const y = interpolate(f, [0, FPS], [24, 0], { easing: 'easeOut' });
    const outOpacity = interpolate(f, [DURATION - 2 * FPS, DURATION - FPS], [1, 0]);
    subtitle.style.opacity = Math.min(opacity, outOpacity);
    subtitle.style.transform = `translate(-50%, 0) translateY(${y}px)`;
  });

  // Background hue drifts across the whole composition — also frame-driven.
  const hue = interpolate(frame, [0, DURATION - 1], [222, 262]);
  document.getElementById('stage').style.background =
    `linear-gradient(135deg, hsl(${hue}, 45%, 12%), hsl(${hue + 40}, 55%, 22%))`;
}

// registerComposition wires up window.setFrame and handles the
// frameReady handshake (including async work) for you.
MotionStudio.registerComposition(drawFrame);
