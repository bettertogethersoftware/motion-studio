/**
 * Picture facts for stills (v0.27) — the surviving measurement half of the
 * retired `prepare_image` plan.
 *
 * The arithmetic is pure and tested against hand-built RGBA buffers, which is
 * the whole reason the sample is decoded rather than delegated: a supplier
 * photo on white, a transparent overlay and a flat card are three cases that
 * must not be confused, and each is four lines to construct here.
 *
 * The end-to-end test writes a real PNG with ffmpeg and measures it, so the
 * decode arguments are covered too — skipped where ffmpeg is absent, like the
 * other media tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  alphaFromPixFmt, sampleSizeFor, measureRgbaSample, scaleBox, isStillImage,
  measurePictureFacts, SAMPLE_MAX_EDGE,
} from '../src/core/picture.js';
import { runFfmpeg } from '../src/core/encoder.js';

const ffmpegPath = process.env.MOTION_STUDIO_FFMPEG || 'ffmpeg';
let haveFfmpeg = true;
try {
  await runFfmpeg({ args: ['-hide_banner', '-version'], ffmpegPath, what: 'probe' });
} catch {
  haveFfmpeg = false;
}

/** Build an RGBA buffer from a paint callback — (x, y) → [r, g, b, a]. */
function rgba(width, height, paint) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * width + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
    }
  }
  return buf;
}

/* --------------------------------- pix fmt --------------------------------- */

test('picture: alpha is read off the pixel-format name, and unknown stays unknown', () => {
  for (const fmt of ['rgba', 'bgra', 'argb', 'yuva420p', 'ya8', 'gbrap']) {
    assert.equal(alphaFromPixFmt(fmt), true, fmt);
  }
  for (const fmt of ['yuv420p', 'rgb24', 'gray', 'yuv444p10le']) {
    assert.equal(alphaFromPixFmt(fmt), false, fmt);
  }
  assert.equal(alphaFromPixFmt(null), null, 'no pixel format is not the same as no alpha');
  assert.equal(alphaFromPixFmt(undefined), null);
});

/* --------------------------------- sampling -------------------------------- */

test('picture: the sample grid preserves aspect and never enlarges', () => {
  assert.deepEqual(sampleSizeFor(1920, 1080), { width: 256, height: 144 });
  assert.deepEqual(sampleSizeFor(1080, 1920), { width: 144, height: 256 });
  assert.deepEqual(sampleSizeFor(100, 50), { width: 100, height: 50 }, 'a small image is not blown up');
  const wide = sampleSizeFor(4000, 3);
  assert.equal(wide.width, SAMPLE_MAX_EDGE);
  assert.equal(wide.height, 1, 'a degenerate strip still has a row to measure');
});

/* ------------------------------ the measurement ----------------------------- */

test('picture: a product on a white margin reports the product, not the canvas', () => {
  // The measured case from the retired plan: supplier photos sit on white with
  // a wide, uneven margin, so placing them by their canvas renders the product
  // small and off-centre.
  const buf = rgba(100, 100, (x, y) => (
    x >= 20 && x < 60 && y >= 30 && y < 90 ? [10, 20, 30, 255] : [255, 255, 255, 255]
  ));
  const m = measureRgbaSample(buf, { width: 100, height: 100 });
  assert.deepEqual(m.contentBox, { x: 20, y: 30, width: 40, height: 60 });
  assert.equal(m.isBlank, false);
  assert.equal(m.isTransparent, false);
  assert.ok(m.meanLuminance > 0.7, 'mostly white reads bright');
});

test('picture: a dark product on a dark background is found too', () => {
  // The background is whatever the EDGES are — assuming white (or black) puts
  // the box around the whole frame on half of all real inputs.
  const buf = rgba(80, 80, (x, y) => (
    x >= 10 && x < 30 && y >= 10 && y < 30 ? [200, 200, 200, 255] : [12, 12, 12, 255]
  ));
  const m = measureRgbaSample(buf, { width: 80, height: 80 });
  assert.deepEqual(m.contentBox, { x: 10, y: 10, width: 20, height: 20 });
  assert.ok(m.meanLuminance < 0.2, 'mostly black reads dark');
});

test('picture: a transparent overlay is measured by its alpha, exactly', () => {
  const buf = rgba(64, 64, (x, y) => (
    x >= 8 && x < 24 && y >= 40 && y < 56 ? [255, 0, 0, 255] : [255, 0, 0, 0]
  ));
  const m = measureRgbaSample(buf, { width: 64, height: 64 });
  assert.equal(m.isTransparent, true);
  assert.deepEqual(m.contentBox, { x: 8, y: 40, width: 16, height: 16 },
    'the cutout, not the colour — every pixel here is the same red');
  assert.equal(m.isBlank, false, 'a transparent image is never "blank"');
});

test('picture: a flat card is blank, and colour keeps that honest', () => {
  assert.equal(measureRgbaSample(rgba(32, 32, () => [128, 128, 128, 255]),
    { width: 32, height: 32 }).isBlank, true);

  // Red and green at MATCHING luminance. A greyscale sample would call this a
  // blank card; it is a two-colour image, which is why the sample is RGBA.
  const twoTone = rgba(32, 32, (x) => (x < 16 ? [255, 0, 0, 255] : [0, 110, 0, 255]));
  const m = measureRgbaSample(twoTone, { width: 32, height: 32 });
  assert.equal(m.isBlank, false, 'two colours at one luminance is not blank');
});

test('picture: a picture that is only background has no box, rather than a wrong one', () => {
  const m = measureRgbaSample(rgba(16, 16, () => [7, 7, 7, 255]), { width: 16, height: 16 });
  assert.equal(m.contentBox, null);
  assert.equal(m.isBlank, true);
});

test('picture: a truncated buffer is an error, never a confident measurement', () => {
  assert.throws(
    () => measureRgbaSample(Buffer.alloc(10), { width: 16, height: 16 }),
    /expected 1024 bytes/,
  );
});

/* --------------------------------- scaling --------------------------------- */

test('picture: a sample-space box scales back to real pixels, inside the frame', () => {
  const box = scaleBox({ x: 32, y: 18, width: 64, height: 36 },
    { from: { width: 256, height: 144 }, to: { width: 1920, height: 1080 } });
  assert.deepEqual(box, { x: 240, y: 135, width: 480, height: 270 });

  // Rounding must never push the box past the edge — a caller crops with it.
  const edge = scaleBox({ x: 255, y: 143, width: 1, height: 1 },
    { from: { width: 256, height: 144 }, to: { width: 1920, height: 1080 } });
  assert.ok(edge.x + edge.width <= 1920 && edge.y + edge.height <= 1080);
  assert.equal(scaleBox(null, { from: { width: 1, height: 1 }, to: { width: 1, height: 1 } }), null);
});

/* ------------------------------- still or not ------------------------------- */

test('picture: only a real still is measured as one', () => {
  const still = { video: { frames: 1 }, hasAudio: false };
  assert.equal(isStillImage('a.png', still), true);
  assert.equal(isStillImage('a.JPG', { video: { frames: null }, hasAudio: false }), true);
  // An animated gif is a still by extension and a movie by content: one
  // arbitrary frame must not be reported as "the picture".
  assert.equal(isStillImage('a.gif', { video: { frames: 48 }, hasAudio: false }), false);
  assert.equal(isStillImage('a.mp4', still), false, 'extension first');
  assert.equal(isStillImage('a.png', null), false, 'an unprobed file is not assumed');
  assert.equal(isStillImage('a.png', { video: { frames: 1 }, hasAudio: true }), false);
});

/* -------------------------------- end to end -------------------------------- */

test('picture: measures a real PNG through the real decode', { skip: !haveFfmpeg }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-picture-'));
  try {
    // A 400x200 white canvas with a 100x50 black block at (50, 100).
    const file = path.join(dir, 'card.png');
    await runFfmpeg({
      ffmpegPath,
      what: 'test fixture',
      args: ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=white:s=400x200:d=1',
        '-vf', 'drawbox=x=50:y=100:w=100:h=50:color=black:t=fill',
        '-frames:v', '1', '-y', file],
    });

    const facts = await measurePictureFacts({
      filePath: file, width: 400, height: 200, pixFmt: 'rgb24', ffmpegPath,
    });
    assert.equal(facts.width, 400);
    assert.equal(facts.height, 200);
    assert.equal(facts.hasAlpha, false);
    assert.equal(facts.isBlank, false);
    assert.ok(facts.meanLuminance > 0.8, `mostly white (got ${facts.meanLuminance})`);
    assert.deepEqual(facts.sampledAt, { width: 256, height: 128 });

    // The block, recovered through scale-down and scale-up. Tolerance is the
    // sample grid: 400/256 is ~1.6 real pixels per sample column.
    const b = facts.contentBox;
    assert.ok(Math.abs(b.x - 50) <= 4, `x ${b.x}`);
    assert.ok(Math.abs(b.y - 100) <= 4, `y ${b.y}`);
    assert.ok(Math.abs(b.width - 100) <= 6, `width ${b.width}`);
    assert.ok(Math.abs(b.height - 50) <= 6, `height ${b.height}`);

    // Unmeasurable input is null, never a throw: a picture measurement must not
    // fail a probe that otherwise worked.
    assert.equal(await measurePictureFacts({ filePath: file, width: 0, height: 0, ffmpegPath }), null);
    assert.equal(
      await measurePictureFacts({
        filePath: path.join(dir, 'ghost.png'), width: 10, height: 10, ffmpegPath,
      }),
      null,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
