/**
 * Filmstrips (v0.28) — frames along a timeline block.
 *
 * The pure parts are tested without an encode, because the interesting
 * decisions are all arithmetic: how many tiles a block deserves, and the frame
 * stride that makes those tiles span the WHOLE clip rather than its first
 * second. The encode itself is covered once, on a real file, to prove the
 * filter string ffmpeg actually accepts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { filmstrip, stripFilter, clampTiles, MIN_TILES, MAX_TILES } from '../src/core/filmstrip.js';

const execFileP = promisify(execFile);
let tmp, clip, haveFfmpeg = true;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-strip-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (!haveFfmpeg) return;
  clip = path.join(tmp, 'clip.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-frames:v', '120', clip]);
});
after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

test('clampTiles keeps a strip inside what a timeline can use', () => {
  assert.equal(clampTiles(12), 12);
  assert.equal(clampTiles(0), MIN_TILES, 'a strip of nothing is not a strip');
  assert.equal(clampTiles(9999), MAX_TILES);
  assert.equal(clampTiles('8'), 8, 'query strings arrive as text');
  assert.equal(clampTiles(undefined), 12, 'the stated default');
  assert.equal(clampTiles('nonsense'), 12);
});

test('the stride spans the whole clip, not just its head', () => {
  // 120 frames into 4 tiles is every 30th frame: 0, 30, 60, 90 — the last tile
  // is near the END. A stride that rounded up would tile past the file and the
  // strip would finish on black.
  //
  // Asserted with String.raw + includes rather than a regex: the filter carries
  // ffmpeg's own escaped comma (`n\,`), and expressing that in a regex literal
  // means backslashes escaped twice over — which is how a test ends up
  // asserting something other than the string it is about.
  const four = stripFilter({ frames: 120, tiles: 4 });
  assert.ok(four.includes(String.raw`not(mod(n\,30))`), four);
  assert.ok(four.includes('tile=4x1'), four);
  // Fewer frames than tiles must still step by at least one.
  assert.ok(stripFilter({ frames: 3, tiles: 8 }).includes(String.raw`not(mod(n\,1))`));
  // The height is the tile height, and the width follows the source aspect.
  assert.ok(stripFilter({ frames: 60, tiles: 6, height: 40 }).includes('scale=-1:40'));
});

test('a real clip yields a real JPEG, and more tiles yield a wider one',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const small = await filmstrip({ filePath: clip, frames: 120, tiles: 4 });
    assert.ok(small && small.length > 0);
    assert.equal(small[0], 0xff, 'JPEG magic');
    assert.equal(small[1], 0xd8);

    const big = await filmstrip({ filePath: clip, frames: 120, tiles: 16 });
    assert.ok(big.length > small.length, `16 tiles (${big.length}B) should exceed 4 (${small.length}B)`);
  });

test('a clip shorter than the strip is sampled by what it has, not padded with black',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const short = path.join(tmp, 'short.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=0.1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-frames:v', '3', short]);
    const strip = await filmstrip({ filePath: short, frames: 3, tiles: 32 });
    assert.ok(strip && strip.length > 0, 'a three-frame clip still gets a strip');
  });

test('an unreadable file answers null rather than throwing', async () => {
  assert.equal(await filmstrip({ filePath: path.join(tmp, 'nope.mp4'), frames: 100 }), null);
  assert.equal(await filmstrip({ filePath: clip ?? 'x', frames: 0 }), null, 'nothing to sample');
});
