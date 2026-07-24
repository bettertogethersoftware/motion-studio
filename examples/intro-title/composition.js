/*
 * Intro Title — Motion Studio example composition (240 frames @ 30fps = 8s)
 *
 * Demonstrates the full Frame API:
 *   - registerComposition harness (automatic frameReady handshake)
 *   - interpolate with multi-segment ranges and named easings
 *   - overlapping Sequence blocks (title → subtitle crossfade → outro)
 *   - MotionStudio.random for a deterministic particle field
 *   - v1.1: spring() for the title pop, interpolateColors() for the accent bar
 *
 * Timeline (frames):
 *   0 ──── 30 ─────────── 150 ──── 180 ─────────── 239
 *   bar wipes in     title+subtitle hold      outro card
 *          15: title pops in       165–195: crossfade
 */

/* global MotionStudio, interpolate, Sequence, spring, interpolateColors */

const FPS = 30;
const DURATION = 240;

const stage = document.getElementById('stage');
const bar = document.getElementById('bar');
const title = document.getElementById('title');
const subtitle = document.getElementById('subtitle');
const outro = document.getElementById('outro');
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');

// Fixed particle layout: seeded once, identical on every frame and worker.
const layoutRng = MotionStudio.random(20260708);
const PARTICLES = Array.from({ length: 90 }, () => ({
  x: layoutRng() * 1920,
  y: layoutRng() * 1080,
  r: 1 + layoutRng() * 2.5,
  speed: 0.3 + layoutRng() * 0.9,
  phase: layoutRng() * Math.PI * 2,
}));

function drawParticles(frame) {
  ctx.clearRect(0, 0, 1920, 1080);
  const globalAlpha = interpolate(frame, [0, 40, DURATION - 30, DURATION - 1], [0, 0.9, 0.9, 0]);
  for (const p of PARTICLES) {
    // Drift is a pure function of frame — no per-frame mutation.
    const y = (p.y - frame * p.speed + 1080) % 1080;
    const twinkle = 0.55 + 0.45 * Math.sin(p.phase + frame * 0.09 * p.speed);
    ctx.beginPath();
    ctx.arc(p.x, y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${(globalAlpha * twinkle).toFixed(3)})`;
    ctx.fill();
  }
}

MotionStudio.registerComposition((frame) => {
  // Reset visibility every frame so each frame is fully self-determined.
  for (const el of [bar, title, subtitle, outro]) el.style.opacity = 0;

  // Background: slow hue drift across the whole piece.
  const hue = interpolate(frame, [0, DURATION - 1], [225, 258]);
  stage.style.background = `radial-gradient(120% 120% at 30% 20%,
    hsl(${hue}, 60%, 20%), hsl(${hue + 25}, 65%, 8%) 70%)`;

  drawParticles(frame);

  // 1) Accent bar wipes in during the first second, exits with the title.
  //    Its color drifts warm→hot over the piece (v1.1 interpolateColors).
  Sequence(0, 195, (f) => {
    const w = interpolate(f, [0, 30], [0, 560], { easing: 'easeOut' });
    const exit = interpolate(f, [165, 194], [1, 0]);
    bar.style.opacity = exit;
    bar.style.width = `${w}px`;
    bar.style.background = interpolateColors(frame, [0, DURATION - 1], ['#ffb454', '#ff6b5e']);
  });

  // 2) Title: physical spring pop-in at 15 (v1.1), holds, fades out 165–195.
  Sequence(15, 180, (f) => {
    const scale = 0.7 + 0.3 * spring(f, { fps: FPS, stiffness: 150, damping: 11 });
    const inO = interpolate(f, [0, 14], [0, 1]);
    const outO = interpolate(f, [150, 179], [1, 0]);
    title.style.opacity = Math.min(inO, outO);
    title.style.transform = `translate(-50%, -50%) scale(${scale})`;
    title.style.letterSpacing = `${interpolate(f, [0, 22], [0.35, 0.06], { easing: 'easeOut' })}em`;
  });

  // 3) Subtitle: slides up under the title, same exit window.
  Sequence(40, 155, (f) => {
    const o = Math.min(
      interpolate(f, [0, 18], [0, 1], { easing: 'easeOut' }),
      interpolate(f, [125, 154], [1, 0]),
    );
    subtitle.style.opacity = o;
    subtitle.style.transform =
      `translate(-50%, 0) translateY(${interpolate(f, [0, 18], [26, 0], { easing: 'easeOut' })}px)`;
  });

  // 4) Outro card: overlaps the title's fade-out (crossfade), then holds.
  Sequence(180, DURATION - 180, (f) => {
    const o = Math.min(
      interpolate(f, [0, 20], [0, 1], { easing: 'easeInOut' }),
      interpolate(f, [40, 59], [1, 0]),
    );
    outro.style.opacity = o;
    outro.style.transform =
      `translate(-50%, -50%) scale(${interpolate(f, [0, 20], [0.96, 1], { easing: 'easeOut' })})`;
  });
});
