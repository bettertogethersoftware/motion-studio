import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  reviewFrameList, deliveryReviewFrameList, extractRenderedFrame, measureRenderedPicture,
  createDeliveryReview, assertReviewAllowsPromotion, resolveReviewPolicy,
  reviewGridCells, buildReviewGrid, contactSheetGrid,
} from '../src/core/render-review.js';
import { ErrorCodes } from '../src/core/errors.js';

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

test('reviewGridCells takes a cut and a hold per segment, or one hold in scenes scope', () => {
  const segments = [
    { key: 'one', filmOffset: 0, durationInFrames: 10 },
    { key: 'two', filmOffset: 10, durationInFrames: 10 },
  ];
  const both = reviewGridCells({ segments });
  assert.deepEqual(
    both.cells.map((cell) => [cell.segment.key, cell.kind, cell.filmFrame, cell.localFrame]),
    [['one', 'cut', 0, 0], ['one', 'hold', 4, 4], ['two', 'cut', 10, 0], ['two', 'hold', 14, 4]],
  );
  assert.equal(both.truncated, false);
  assert.equal(both.requestedCells, 4);

  const holds = reviewGridCells({ segments, scope: 'scenes' });
  assert.deepEqual(holds.cells.map((cell) => cell.filmFrame), [4, 14]);
});

test('reviewGridCells keeps the ends and NAMES what it dropped over the cap', () => {
  const segments = Array.from({ length: 9 }, (_, index) => ({
    key: `s${index}`, filmOffset: index * 10, durationInFrames: 10,
  }));
  const planned = reviewGridCells({ segments, maxCells: 6 });
  assert.equal(planned.cells.length, 6, 'three segments × cut+hold');
  assert.equal(planned.truncated, true);
  assert.equal(planned.requestedCells, 18);
  assert.deepEqual(planned.cells.map((cell) => cell.segment.key), ['s0', 's0', 's4', 's4', 's8', 's8']);
  assert.deepEqual(planned.omitted, ['s1', 's2', 's3', 's5', 's6', 's7']);
});

test('buildReviewGrid tiles encoded frames into one sheet bounded by maxWidth', { skip: !haveFfmpeg }, async () => {
  const outputPath = path.join(tmp, 'grid.png');
  const cells = [0, 10, 20, 30].map((frame) => ({ filePath: fixture, frame, fps: 10 }));
  const sheet = await buildReviewGrid({ cells, outputPath, maxWidth: 320 });
  assert.deepEqual({ columns: sheet.columns, rows: sheet.rows }, contactSheetGrid(4));
  assert.ok(sheet.thumbnailWidth <= 320 / sheet.columns);
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', outputPath,
  ]);
  const [width] = stdout.trim().split('x').map(Number);
  assert.ok(width <= 320, `sheet width ${width} must stay inside maxWidth`);
});

test('deliveryReviewFrameList anchors a persisted review to first, last, cuts, and caption onsets', () => {
  const selection = deliveryReviewFrameList({
    totalFrames: 40,
    sceneLayout: [
      { filmOffset: 0, durationInFrames: 20 },
      { filmOffset: 20, durationInFrames: 20 },
    ],
    captions: [{ fromFrame: 3 }, { fromFrame: 27 }],
  });
  assert.deepEqual(selection, {
    frames: [0, 3, 20, 27, 39], requestedFrames: 5, truncated: false,
  });
});

test('a film review policy overrides only the severity list it supplies', () => {
  assert.deepEqual(
    resolveReviewPolicy({
      globalPolicy: { block: ['frame_count_mismatch'], warn: ['black_run', 'static_run'] },
      filmPolicy: { block: ['black_run'] },
    }),
    { block: ['black_run'], warn: ['static_run'] },
  );
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

test('delivery review persists staged evidence and only a policy block stops promotion', { skip: !haveFfmpeg }, async () => {
  const layout = [
    { sceneId: 'review/black', name: 'Black', filmOffset: 0, durationInFrames: 20 },
    { sceneId: 'review/white', name: 'White', filmOffset: 20, durationInFrames: 20 },
  ];
  const picture = await measureRenderedPicture({ filePath: fixture, fps: 10, totalFrames: 40, sceneLayout: layout });
  const delivery = path.join(tmp, 'delivered.mp4');
  const review = await createDeliveryReview({
    stagedOutputPath: fixture,
    deliveryPath: delivery,
    fps: 10,
    totalFrames: 40,
    sceneLayout: layout,
    captions: [{ text: 'Cut to white', fromFrame: 20, toFrame: 30 }],
    picture,
    frameCheck: { expected: 40, actual: 40, verified: true },
    policy: { block: [], warn: ['static_run', 'black_run', 'suspect_cut'] },
  });

  assert.ok(await fsp.stat(review.stagedPaths.contactPath));
  assert.ok(await fsp.stat(review.stagedPaths.reviewPath));
  assert.equal((await fsp.readFile(review.stagedPaths.contactPath)).subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(
    review.report.contact.thumbnails.map((thumb) => thumb.frame),
    [0, 20, 39],
  );
  assert.deepEqual(JSON.parse(await fsp.readFile(review.stagedPaths.reviewPath, 'utf8')), review.report);
  assert.doesNotThrow(() => assertReviewAllowsPromotion(review));

  assert.throws(
    () => assertReviewAllowsPromotion({
      ...review,
      report: {
        ...review.report,
        warnings: [...review.report.warnings, {
          code: 'frame_count_mismatch', level: 'block', message: 'Encoded output has 39 frames; 40 were required.',
        }],
      },
    }),
    (error) => error.code === ErrorCodes.PROMOTION_BLOCKED && error.detail.reviewPath === review.stagedPaths.reviewPath,
  );
});
