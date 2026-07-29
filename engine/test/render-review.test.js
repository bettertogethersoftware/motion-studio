import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  reviewFrameList, extractRenderedFrame, measureRenderedPicture,
} from '../src/core/render-review.js';

const execFileP = promisify(execFile);
let tmp, fixture, haveFfmpeg = true;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-render-review-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; return; }
  fixture = path.join(tmp, 'black-white.mp4');
  await execFileP('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=160x90:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=white:s=160x90:r=10:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture,
  ]);
});
after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

test('reviewFrameList prefers cuts and holds the engine already knows', () => {
  const layout = [{ filmOffset: 0, durationInFrames: 10 }, { filmOffset: 10, durationInFrames: 10 }];
  assert.deepEqual(reviewFrameList({ totalFrames: 20, sceneLayout: layout, around: 'cuts' }), [0, 2, 9, 10, 12]);
  assert.deepEqual(reviewFrameList({ totalFrames: 20, sceneLayout: layout, around: 'holds' }), [5, 15]);
});

test('reviewFrameList keeps a long film review useful within the image cap', () => {
  const layout = Array.from({ length: 12 }, (_, index) => ({
    filmOffset: index * 10, durationInFrames: 10,
  }));
  const frames = reviewFrameList({ totalFrames: 120, sceneLayout: layout, around: 'cuts', maxFrames: 24 });
  assert.ok(frames.length <= 24);
  assert.ok(frames.includes(0));
  assert.ok(frames.some((frame) => frame >= 110), 'review samples the end as well as the start');
});

test('render review extracts a delivered frame and measures static, black, and cut facts', { skip: !haveFfmpeg }, async () => {
  const layout = [
    { sceneId: 'review/black', name: 'Black', filmOffset: 0, durationInFrames: 20 },
    { sceneId: 'review/white', name: 'White', filmOffset: 20, durationInFrames: 20 },
  ];
  const png = await extractRenderedFrame({ filePath: fixture, frame: 20, fps: 10, maxWidth: 80 });
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');

  const report = await measureRenderedPicture({ filePath: fixture, fps: 10, totalFrames: 40, sceneLayout: layout });
  assert.equal(report.frames, 40);
  assert.ok(report.staticRuns.length > 0, JSON.stringify(report));
  assert.ok(report.blackRuns.length > 0, JSON.stringify(report));
  assert.equal(report.cutCheck[0].expectedFrame, 20);
  assert.equal(report.cutCheck[0].verdict, 'changed');
});
