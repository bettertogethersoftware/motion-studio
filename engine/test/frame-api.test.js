import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The runtime is a classic browser script: evaluate it in a fresh vm context
// with a `window` global, exactly as Chromium would.
const runtimeSrc = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime/frame-api.js'),
  'utf8',
);
const win = {};
win.window = win; // self-referential, browser-style
vm.createContext(win);
vm.runInContext(runtimeSrc, win, { filename: 'frame-api.js' });
const { interpolate, Sequence, random, easings, registerComposition, spring, interpolateColors, Loop, particles } = win.MotionStudio;

test('interpolate: linear two-point mapping', () => {
  assert.equal(interpolate(0, [0, 10], [0, 100]), 0);
  assert.equal(interpolate(5, [0, 10], [0, 100]), 50);
  assert.equal(interpolate(10, [0, 10], [0, 100]), 100);
});

test('interpolate: clamps outside range by default', () => {
  assert.equal(interpolate(-5, [0, 10], [0, 100]), 0);
  assert.equal(interpolate(50, [0, 10], [0, 100]), 100);
});

test('interpolate: extrapolate extend continues the line', () => {
  assert.equal(interpolate(20, [0, 10], [0, 100], { extrapolate: 'extend' }), 200);
  assert.equal(interpolate(-10, [0, 10], [0, 100], { extrapolate: 'extend' }), -100);
});

test('interpolate: multi-segment (move in, hold, move out)', () => {
  const inR = [0, 15, 45, 60];
  const outR = [0, 200, 200, 0];
  assert.equal(interpolate(0, inR, outR), 0);
  assert.equal(interpolate(15, inR, outR), 200);
  assert.equal(interpolate(30, inR, outR), 200); // hold
  assert.equal(interpolate(60, inR, outR), 0);
  assert.ok(Math.abs(interpolate(7.5, inR, outR) - 100) < 1e-9);
});

test('interpolate: named easings hit endpoints and stay monotone-ish', () => {
  for (const name of Object.keys(easings)) {
    const start = interpolate(0, [0, 100], [0, 1], { easing: name });
    const end = interpolate(100, [0, 100], [0, 1], { easing: name });
    assert.ok(Math.abs(start) < 1e-9, `${name} start`);
    assert.ok(Math.abs(end - 1) < 1e-9, `${name} end`);
  }
});

test('interpolate: rejects malformed ranges', () => {
  // predicate on .name: RangeError from the vm realm has a different prototype
  const isRange = (e) => e.name === 'RangeError';
  assert.throws(() => interpolate(1, [0], [0]), isRange);
  assert.throws(() => interpolate(1, [0, 10], [0, 10, 20]), isRange);
  assert.throws(() => interpolate(1, [10, 0], [0, 1]), isRange, 'non-increasing input');
  assert.throws(() => interpolate(1, [0, 10], [0, 1], { easing: 'nope' }), isRange);
});

test('interpolate: determinism — same inputs, same output, any call order', () => {
  const calls = [77, 3, 50, 3, 77];
  const results = calls.map((f) => interpolate(f, [0, 100], [0, 360], { easing: 'easeInOut' }));
  assert.equal(results[1], results[3]);
  assert.equal(results[0], results[4]);
});

test('Sequence: runs only inside its window with local frames', () => {
  const seen = [];
  const runAt = (frame) => {
    // simulate the harness setting the current frame
    registerComposition(() => {
      Sequence(10, 5, (lf) => seen.push([frame, lf]));
    });
    return win.setFrame(frame);
  };
  return (async () => {
    await runAt(9);
    await runAt(10);
    await runAt(14);
    await runAt(15);
    assert.deepEqual(seen, [[10, 0], [14, 4]]);
  })();
});

test('Sequence: overlapping sequences are both active (crossfade case)', async () => {
  const active = [];
  registerComposition(() => {
    Sequence(0, 10, () => active.push('a'));
    Sequence(5, 10, () => active.push('b'));
  });
  await win.setFrame(7);
  assert.deepEqual(active, ['a', 'b']);
});

test('random: seeded PRNG is deterministic per seed', () => {
  const a1 = random(42), a2 = random(42), b = random(43);
  const seqA1 = [a1(), a1(), a1()];
  const seqA2 = [a2(), a2(), a2()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA1, seqA2);
  assert.notDeepEqual(seqA1, seqB);
  for (const v of seqA1) assert.ok(v >= 0 && v < 1);
});

test('registerComposition: frameReady handshake, sync function', async () => {
  let applied = null;
  registerComposition((f) => { applied = f; });
  const p = win.setFrame(12);
  assert.equal(win.frameReady, false, 'not ready while running');
  await p;
  assert.equal(win.frameReady, true);
  assert.equal(applied, 12);
});

test('registerComposition: async work resolves before frameReady', async () => {
  const order = [];
  registerComposition(async () => {
    order.push('start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('asyncDone');
  });
  const p = win.setFrame(0);
  assert.equal(win.frameReady, false);
  await p;
  order.push(`ready:${win.frameReady}`);
  assert.deepEqual(order, ['start', 'asyncDone', 'ready:true']);
});

test('registerComposition: composition errors surface via __frameError', async () => {
  registerComposition(() => { throw new Error('boom in composition'); });
  win.__frameError = undefined;
  await assert.rejects(() => win.setFrame(3));
  assert.match(String(win.__frameError), /boom in composition/);
  assert.equal(win.frameReady, false, 'never flips ready on error');
});

/* ------------------------- v1.1 primitives (v0.5) ------------------------- */

test('spring: pure function of frame, starts at 0 and settles at 1', () => {
  assert.equal(spring(0), 0);
  assert.equal(spring(-10), 0);
  const settled = spring(600, { fps: 30 });
  assert.ok(Math.abs(settled - 1) < 1e-3, `settled=${settled}`);
  // Deterministic: same inputs, same output (twice).
  assert.equal(spring(17, { fps: 30, damping: 8 }), spring(17, { fps: 30, damping: 8 }));
});

test('spring: underdamped overshoots, critically damped does not', () => {
  let overshoot = 0;
  for (let f = 1; f <= 120; f++) overshoot = Math.max(overshoot, spring(f, { fps: 30, damping: 6 }));
  assert.ok(overshoot > 1.01, `expected overshoot, max=${overshoot}`);
  for (let f = 1; f <= 300; f++) {
    const v = spring(f, { fps: 30, damping: 20, stiffness: 100 }); // zeta = 1
    assert.ok(v <= 1 + 1e-9, `critically damped exceeded 1 at frame ${f}: ${v}`);
  }
});

test('interpolateColors: hex and rgb() endpoints, multi-stop, alpha', () => {
  assert.equal(interpolateColors(0, [0, 60], ['#000000', '#ffffff']), 'rgba(0, 0, 0, 1)');
  assert.equal(interpolateColors(30, [0, 60], ['#000000', '#ffffff']), 'rgba(128, 128, 128, 1)');
  assert.equal(interpolateColors(60, [0, 60], ['#000', 'rgb(255, 255, 255)']), 'rgba(255, 255, 255, 1)');
  // 8-digit hex alpha interpolates
  const mid = interpolateColors(30, [0, 60], ['#ff000000', '#ff0000ff']);
  assert.match(mid, /^rgba\(255, 0, 0, 0\.5\d*\)$/);
  assert.throws(() => interpolateColors(0, [0, 60], ['#000']), /must match inputRange length/);
  assert.throws(() => interpolateColors(0, [0, 60], ['#000', 'chartreuse']), /unsupported color/);
});

test('Loop: repeats against the active frame context with cycle index', async () => {
  let seen = null;
  registerComposition(() => { Loop(20, (f, cycle) => { seen = [f, cycle]; }); });
  await win.setFrame(0);
  assert.deepEqual(seen, [0, 0]);
  await win.setFrame(19);
  assert.deepEqual(seen, [19, 0]);
  await win.setFrame(45);
  assert.deepEqual(seen, [5, 2]);
  assert.throws(() => Loop(0, () => {}), /durationInFrames must be > 0/);
});

// particles() returns arrays built inside the vm realm; deepStrictEqual would
// fail on the foreign Array prototype, so compare JSON-normalized copies.
const J = (x) => JSON.parse(JSON.stringify(x));

test('particles: pure function of frame — identical output for identical frames (v1.3)', () => {
  const a = particles(42, { count: 8, lifeFrames: 60, seed: 7 });
  const b = particles(42, { count: 8, lifeFrames: 60, seed: 7 });
  assert.deepEqual(J(a), J(b));
  assert.equal(a.length, 8);
  for (const p of a) {
    assert.ok(p.phase >= 0 && p.phase < 1, `phase ${p.phase}`);
    assert.equal(p.u.length, 4);
    for (const u of p.u) assert.ok(u >= 0 && u < 1);
  }
});

test('particles: staggered phases, per-cycle random re-roll, seed independence', () => {
  const frame0 = particles(0, { count: 4, lifeFrames: 40, seed: 1 });
  // uniform stagger: phases 0, .25, .5, .75 at frame 0
  assert.deepEqual(Array.from(frame0, (p) => p.phase), [0, 0.25, 0.5, 0.75]);
  // same particle, same cycle → same randoms across frames
  const f1 = particles(1, { count: 4, lifeFrames: 40, seed: 1 });
  assert.deepEqual(J(frame0[0].u), J(f1[0].u));
  // next cycle → new randoms
  const f40 = particles(40, { count: 4, lifeFrames: 40, seed: 1 });
  assert.equal(f40[0].cycle, 1);
  assert.notDeepEqual(J(frame0[0].u), J(f40[0].u));
  // a different seed is a different emitter
  assert.notDeepEqual(J(frame0[0].u), J(particles(0, { count: 4, lifeFrames: 40, seed: 2 })[0].u));
});

test('particles: validates count and lifeFrames', () => {
  assert.throws(() => particles(0, { count: 0 }), /count must be > 0/);
  assert.throws(() => particles(0, { lifeFrames: 0 }), /lifeFrames must be > 0/);
});
