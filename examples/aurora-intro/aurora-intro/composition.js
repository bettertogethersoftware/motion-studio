/*
 * Aurora Intro — Motion Studio reference composition (300 frames @ 30fps = 10s)
 *
 * A denser reference than the basic intro-title example: same frame-purity
 * contract, but exercises every Frame API primitive at least once, including
 * two the basic example never touches — Loop() and particles(). Use this
 * file as the pattern source for new compositions; intro-title/ is still the
 * minimal one to start from.
 *
 * Primitives demonstrated:
 *   - registerComposition harness (automatic frameReady handshake)
 *   - interpolate: multi-segment ranges, named easings, per-element stagger
 *   - Sequence: five independently-timed, overlapping blocks
 *   - spring(): title word pop-in, outro mark pop-in
 *   - interpolateColors(): underline gradient sweep, aurora field hue drift
 *   - MotionStudio.random(): fixed starfield layout, seeded once
 *   - particles(): a real particle system (embers rising through the aurora),
 *     which intro-title.zip never demonstrates — this is the canonical usage
 *   - Loop(): the badge dot's breathing pulse, a bounded repeating sub-animation
 *
 * Timeline (frames):
 *   0 ── 20 ── 55 ─────────────── 230 ── 260 ──────────── 299
 *   badge   rule+kicker   title+chips hold        outro card
 *   fades   wipe in       35: word-1 pop   235–260: crossfade
 *   in      65: word-2 pop, offset by 8 frames for a cascade
 *
 * Design choices worth copying:
 *   - Every Sequence window resets nothing on its own; the top of
 *     registerComposition zeroes all opacities first, so every frame is
 *     fully self-determined (see rule 3 in SKILL.md — no per-frame mutation
 *     carried from a previous frame).
 *   - Two words in the title pop in with a staggered spring rather than
 *     together — a small offset (8 frames) reads as far more "composed"
 *     than simultaneous motion, at almost no extra code.
 *   - The aurora background and the embers both derive their color from the
 *     same interpolateColors() call so the palette never fights itself.
 */

/* global MotionStudio, interpolate, Sequence, spring, interpolateColors, Loop, particles */

const FPS = 30;
const DURATION = 300;

const stage = document.getElementById('stage');
const auroraCanvas = document.getElementById('aurora');
const auroraCtx = auroraCanvas.getContext('2d');
const starsCanvas = document.getElementById('stars');
const starsCtx = starsCanvas.getContext('2d');

const badge = document.getElementById('badge');
const badgeDot = document.getElementById('badge-dot');
const ruleTop = document.getElementById('rule-top');
const kicker = document.getElementById('kicker');
const word1 = document.getElementById('word-1');
const word2 = document.getElementById('word-2');
const underline = document.getElementById('underline');
const subtitle = document.getElementById('subtitle');
const chips = [
  document.getElementById('chip-1'),
  document.getElementById('chip-2'),
  document.getElementById('chip-3'),
];
const outro = document.getElementById('outro');
const outroMark = document.getElementById('outro-mark');

// ---------------------------------------------------------------------
// Fixed layouts: seeded once at module load, identical on every frame and
// worker. Anything that must not flicker between frames (star positions,
// per-star twinkle phase) belongs here, not inside the per-frame callback.
// ---------------------------------------------------------------------
const starRng = MotionStudio.random(20260714);
const STARS = Array.from({ length: 140 }, () => ({
  x: starRng() * 1920,
  y: starRng() * 1080,
  r: 0.6 + starRng() * 1.6,
  phase: starRng() * Math.PI * 2,
  speed: 0.6 + starRng() * 1.4,
}));

function drawStars(frame) {
  starsCtx.clearRect(0, 0, 1920, 1080);
  const fieldAlpha = interpolate(frame, [0, 45, DURATION - 40, DURATION - 1], [0, 0.85, 0.85, 0]);
  for (const s of STARS) {
    const twinkle = 0.4 + 0.6 * Math.sin(s.phase + frame * 0.05 * s.speed);
    starsCtx.beginPath();
    starsCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    starsCtx.fillStyle = `rgba(255, 255, 255, ${(fieldAlpha * twinkle).toFixed(3)})`;
    starsCtx.fill();
  }
}

// ---------------------------------------------------------------------
// Aurora field: a few soft, drifting gradient bands plus an ember particle
// system rising through them. This is the canonical use of particles():
// each call returns one state object per particle for the *current* frame,
// derived purely from frame + seed, so it is safe under out-of-order or
// parallel rendering — nothing here is simulated frame-to-frame.
// ---------------------------------------------------------------------
function drawAurora(frame) {
  auroraCtx.clearRect(0, 0, 1920, 1080);

  const paletteA = interpolateColors(frame, [0, DURATION - 1], ['#1c2a6b', '#3a1c6b']);
  const paletteB = interpolateColors(frame, [0, DURATION - 1], ['#7c9cff', '#ff6b9e']);

  auroraCtx.fillStyle = '#05060a';
  auroraCtx.fillRect(0, 0, 1920, 1080);

  // Two slow bands, offset in phase so they cross rather than move in unison.
  for (let band = 0; band < 2; band++) {
    const yBase = 1080 * (band === 0 ? 0.32 : 0.7);
    const sway = Math.sin(frame * 0.015 + band * 2.1) * 90;
    const grad = auroraCtx.createRadialGradient(
      960 + sway, yBase, 60,
      960 + sway, yBase, 900,
    );
    grad.addColorStop(0, band === 0 ? paletteA : paletteB);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    auroraCtx.globalAlpha = 0.55;
    auroraCtx.fillStyle = grad;
    auroraCtx.fillRect(0, 0, 1920, 1080);
  }
  auroraCtx.globalAlpha = 1;

  // Embers: rise, drift sideways, and fade across a bounded lifetime. Count
  // stays modest (36) since these render under the title text.
  const emberAlpha = interpolate(frame, [0, 50, DURATION - 60, DURATION - 1], [0, 0.9, 0.9, 0]);
  particles(frame, { count: 36, lifeFrames: 150, seed: 9, speed: 1 }).forEach((p) => {
    const x = 200 + p.u[0] * 1520 + Math.sin(p.phase * Math.PI * 2 + p.u[1] * 6) * 40;
    const y = 1080 - p.phase * 1080;
    const size = 1.5 + p.u[2] * 3.5;
    const twinkle = 0.5 + 0.5 * Math.sin(frame * 0.2 + p.u[3] * 10);
    auroraCtx.beginPath();
    auroraCtx.arc(x, y, size, 0, Math.PI * 2);
    auroraCtx.fillStyle = `rgba(255, 214, 170, ${(emberAlpha * twinkle * (1 - p.phase * 0.6)).toFixed(3)})`;
    auroraCtx.fill();
  });
}

MotionStudio.registerComposition((frame) => {
  // Reset every visibility-bearing element so each frame is fully
  // self-determined — no state carried from the previous frame.
  for (const el of [badge, ruleTop, kicker, word1, word2, underline, subtitle, ...chips, outro]) {
    el.style.opacity = 0;
  }

  drawAurora(frame);
  drawStars(frame);

  // 1) Status badge, top-left: fades in early, holds, exits with the title.
  Sequence(0, 245, (f) => {
    const o = Math.min(
      interpolate(f, [0, 18], [0, 1], { easing: 'easeOut' }),
      interpolate(f, [215, 244], [1, 0]),
    );
    badge.style.opacity = o;
    // Loop(): the dot breathes on a fixed 40-frame cycle, independent of
    // the badge's own fade. This is the canonical Loop() usage — a bounded
    // repeating sub-animation nested inside a Sequence.
    Loop(40, (lf) => {
      const pulse = 0.6 + 0.4 * Math.sin((lf / 40) * Math.PI * 2);
      badgeDot.style.transform = `scale(${(0.85 + pulse * 0.3).toFixed(3)})`;
      badgeDot.style.boxShadow = `0 0 ${(8 + pulse * 14).toFixed(1)}px rgba(107, 255, 176, ${(0.5 + pulse * 0.5).toFixed(2)})`;
    });
  });

  // 2) Top rule + kicker: wipe in together, exit just before the title fades.
  Sequence(15, 225, (f) => {
    const w = interpolate(f, [0, 26], [0, 480], { easing: 'easeOut' });
    const exit = interpolate(f, [190, 224], [1, 0]);
    ruleTop.style.opacity = exit;
    ruleTop.style.width = `${w}px`;

    const kO = Math.min(
      interpolate(f, [10, 32], [0, 1], { easing: 'easeOut' }),
      exit,
    );
    kicker.style.opacity = kO;
    kicker.style.letterSpacing = `${interpolate(f, [10, 40], [0.9, 0.5], { easing: 'easeOut' })}em`;
  });

  // 3) Title: two words pop in on a staggered spring (word-2 starts 8 frames
  //    after word-1), hold, then fade out together. Staggering is what makes
  //    a two-word title read as composed rather than stamped.
  Sequence(35, 195, (f) => {
    const outO = interpolate(f, [150, 179], [1, 0]);

    const s1 = spring(f, { fps: FPS, stiffness: 160, damping: 12 });
    const in1 = interpolate(f, [0, 16], [0, 1]);
    word1.style.opacity = Math.min(in1, outO);
    word1.style.transform = `scale(${(0.6 + 0.4 * s1).toFixed(3)}) translateY(${interpolate(f, [0, 16], [24, 0], { easing: 'easeOut' })}px)`;

    const f2 = f - 8;
    const s2 = spring(f2, { fps: FPS, stiffness: 160, damping: 12 });
    const in2 = interpolate(f2, [0, 16], [0, 1]);
    word2.style.opacity = Math.min(in2, outO);
    word2.style.transform = `scale(${(0.6 + 0.4 * s2).toFixed(3)}) translateY(${interpolate(f2, [0, 16], [24, 0], { easing: 'easeOut' })}px)`;
  });

  // 4) Underline: wipes in under the settled title, color sweeps end to end,
  //    then contracts back to a point as it exits (mirrors the wipe-in).
  Sequence(60, 165, (f) => {
    const growIn = interpolate(f, [0, 24], [0, 620], { easing: 'easeOut' });
    const shrinkOut = interpolate(f, [130, 164], [620, 0], { easing: 'easeIn' });
    const w = f < 130 ? growIn : shrinkOut;
    underline.style.opacity = interpolate(f, [0, 10, 150, 164], [0, 1, 1, 0]);
    underline.style.width = `${w}px`;
    underline.style.background = interpolateColors(frame, [60, 224], ['#7c9cff', '#ff6b9e']);
    underline.style.boxShadow = `0 0 24px ${interpolateColors(frame, [60, 224], ['rgba(124,156,255,0.7)', 'rgba(255,107,158,0.7)'])}`;
  });

  // 5) Subtitle: slides up under the underline, same general exit window.
  Sequence(78, 150, (f) => {
    const o = Math.min(
      interpolate(f, [0, 18], [0, 1], { easing: 'easeOut' }),
      interpolate(f, [112, 149], [1, 0]),
    );
    subtitle.style.opacity = o;
    subtitle.style.transform = `translate(-50%, 0) translateY(${interpolate(f, [0, 18], [22, 0], { easing: 'easeOut' })}px)`;
  });

  // 6) Feature chips: three pills enter with a per-index stagger (24 frames
  //    apart) and a slight overshoot easing, then exit together.
  Sequence(95, 140, (f) => {
    const outO = interpolate(f, [95, 139], [1, 0]);
    chips.forEach((chip, i) => {
      const cf = f - i * 10;
      const o = Math.min(interpolate(cf, [0, 16], [0, 1]), outO);
      chip.style.opacity = o;
      chip.style.transform = `translateY(${interpolate(cf, [0, 16], [16, 0], { easing: 'easeOutBack' })}px) scale(${interpolate(cf, [0, 16], [0.9, 1], { easing: 'easeOutBack' })})`;
    });
  });

  // 7) Outro: overlaps the title block's fade-out (crossfade window
  //    235–260 lines up with block 3's own 150–179 local fade plus its
  //    Sequence offset), then holds to the end. Mark pops with a spring;
  //    text fades a beat behind it.
  Sequence(235, DURATION - 235, (f) => {
    const cardO = Math.min(
      interpolate(f, [0, 22], [0, 1], { easing: 'easeInOut' }),
      1,
    );
    outro.style.opacity = cardO;
    const markS = spring(f, { fps: FPS, stiffness: 170, damping: 13 });
    outroMark.style.transform = `scale(${(0.5 + 0.5 * markS).toFixed(3)}) rotate(${interpolate(f, [0, 24], [-12, 0], { easing: 'easeOut' })}deg)`;
    document.getElementById('outro-text').style.opacity = interpolate(f, [14, 32], [0, 1], { easing: 'easeOut' });
  });
});
