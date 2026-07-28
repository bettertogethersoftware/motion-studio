/**
 * v0.14 feature tests: crash-shaped error classification (browser_crashed),
 * in-job capture recovery (relaunch + same-frame retry), JobManager.waitFor
 * (the core of wait_for_render), and named clamped cues in the SFX report.
 *
 * The recovery tests run the real renderer → FFmpeg pipeline with the fake
 * browser: the point of recovery is that frames already piped to the sink
 * survive a mid-capture relaunch, so mocking the encode would test nothing.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isBrowserCrash } from '../src/core/browser.js';
import { renderComposition, CRASH_RELAUNCH_LIMIT } from '../src/core/renderer.js';
import { JobManager, JobState } from '../src/core/jobs.js';
import { renderCues } from '../src/core/sfx.js';
import { makeConfig } from '../src/core/scene.js';
import { EngineError, ErrorCodes } from '../src/core/errors.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';

let tmp;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-v014-'));
});
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/* ----------------------------------------------- crash classification ----- */

test('isBrowserCrash: recognizes every crash shape Puppeteer emits', () => {
  const crashes = [
    new Error('Protocol error (Page.captureScreenshot): Target closed'),
    new Error('Session closed. Most likely the page has been closed.'),
    new Error('Protocol error (Runtime.evaluate): Target crashed'),
    new Error('Connection closed'),
    new Error('Navigating frame was detached'),
    new EngineError(ErrorCodes.BROWSER_CRASHED, 'already classified'),
    // a crash that leaked into another wrapper keeps its message, so the
    // classifier must see through the EngineError coat
    new EngineError(ErrorCodes.COMPOSITION_ERROR, 'setFrame(3) threw: Protocol error (Runtime.evaluate): Target closed'),
  ];
  for (const err of crashes) assert.equal(isBrowserCrash(err), true, err.message);
});

test('isBrowserCrash: does NOT match real composition failures', () => {
  const benign = [
    new EngineError(ErrorCodes.COMPOSITION_ERROR, 'ReferenceError: sprite is not defined'),
    new EngineError(ErrorCodes.FRAME_TIMEOUT, 'Frame 12 never became ready within 15000ms.'),
    new Error('ffmpeg exited with code 1'),
    null,
    undefined,
  ];
  for (const err of benign) assert.equal(isBrowserCrash(err), false, String(err?.message ?? err));
});

/* ------------------------------------------------- capture recovery ------- */

test('renderComposition: relaunches after a mid-capture crash and finishes the render', async () => {
  const scenePath = path.join(tmp, 'proj-recover');
  await fsp.mkdir(scenePath, { recursive: true });
  const config = makeConfig({ name: 'recover', width: 64, height: 36, durationInFrames: 20 });
  const outputPath = path.join(scenePath, 'out', 'output.mp4');

  let launches = 0;
  const captured = [];
  const factory = makeFakeBrowserFactory({
    crashOnceAtFrames: [7],
    onLaunch: () => launches++,
    onCapture: (n) => captured.push(n),
  });

  const result = await renderComposition({ scenePath, config, outputPath, browserFactory: factory });

  assert.equal(launches, 2, 'exactly one relaunch');
  assert.equal(result.frames, 20);
  // the crashed frame was retried, not skipped: every frame captured exactly once
  assert.deepEqual(captured, Array.from({ length: 20 }, (_, i) => i));
  const stat = await fsp.stat(outputPath);
  assert.ok(stat.size > 0, 'output written');
});

test('renderComposition: gives up with browser_crashed once the relaunch budget is spent', async () => {
  const scenePath = path.join(tmp, 'proj-budget');
  await fsp.mkdir(scenePath, { recursive: true });
  const config = makeConfig({ name: 'budget', width: 64, height: 36, durationInFrames: 20 });
  const outputPath = path.join(scenePath, 'out', 'output.mp4');

  // one more distinct crash than the budget allows
  const crashFrames = Array.from({ length: CRASH_RELAUNCH_LIMIT + 1 }, (_, i) => 4 + i);
  const factory = makeFakeBrowserFactory({ crashOnceAtFrames: crashFrames });

  await assert.rejects(
    renderComposition({ scenePath, config, outputPath, browserFactory: factory }),
    (err) => {
      assert.equal(err.code, ErrorCodes.BROWSER_CRASHED);
      return true;
    },
  );
});

test('renderComposition: a composition error is NOT retried', async () => {
  const scenePath = path.join(tmp, 'proj-comperr');
  await fsp.mkdir(scenePath, { recursive: true });
  const config = makeConfig({ name: 'comperr', width: 64, height: 36, durationInFrames: 20 });
  const outputPath = path.join(scenePath, 'out', 'output.mp4');

  let launches = 0;
  const factory = makeFakeBrowserFactory({ failAtFrame: 5, onLaunch: () => launches++ });

  await assert.rejects(
    renderComposition({ scenePath, config, outputPath, browserFactory: factory }),
    (err) => err.code === ErrorCodes.COMPOSITION_ERROR,
  );
  assert.equal(launches, 1, 'no relaunch for a real composition failure');
});

/* --------------------------------------------------------- waitFor -------- */

function deferredRenderFn() {
  let resolve, reject;
  const gate = new Promise((res, rej) => { resolve = res; reject = rej; });
  const renderFn = () => gate;
  return { renderFn, resolve, reject };
}

test('waitFor: resolves with timedOut:false when all jobs finish', async () => {
  const jobs = new JobManager();
  const a = deferredRenderFn();
  const b = deferredRenderFn();
  const cfg = makeConfig({ name: 'w', durationInFrames: 10 });
  const { jobId: idA } = jobs.startRender({ targetId: 'a', scenePath: tmp, config: cfg, outputPath: path.join(tmp, 'a.mp4'), renderFn: a.renderFn });
  const { jobId: idB } = jobs.startRender({ targetId: 'b', scenePath: tmp, config: cfg, outputPath: path.join(tmp, 'b.mp4'), renderFn: b.renderFn });

  setTimeout(() => a.resolve({ outputPath: 'a.mp4', frames: 10, elapsedMs: 1 }), 30);
  setTimeout(() => b.resolve({ outputPath: 'b.mp4', frames: 10, elapsedMs: 1 }), 60);

  const res = await jobs.waitFor([idA, idB], { timeoutMs: 5_000, pollMs: 10 });
  assert.equal(res.timedOut, false);
  assert.equal(res.jobs.length, 2);
  for (const s of res.jobs) assert.equal(s.state, JobState.DONE);
});

test('waitFor: reports failed jobs with their structured error, still timedOut:false', async () => {
  const jobs = new JobManager();
  const a = deferredRenderFn();
  const cfg = makeConfig({ name: 'w', durationInFrames: 10 });
  const { jobId } = jobs.startRender({ targetId: 'a', scenePath: tmp, config: cfg, outputPath: path.join(tmp, 'c.mp4'), renderFn: a.renderFn });

  setTimeout(() => a.reject(new EngineError(ErrorCodes.BROWSER_CRASHED, 'boom')), 20);

  const res = await jobs.waitFor([jobId], { timeoutMs: 5_000, pollMs: 10 });
  assert.equal(res.timedOut, false);
  assert.equal(res.jobs[0].state, JobState.ERROR);
  assert.equal(res.jobs[0].error.code, ErrorCodes.BROWSER_CRASHED);
});

test('waitFor: times out with current snapshots while a job is still running', async () => {
  const jobs = new JobManager();
  const a = deferredRenderFn();
  const cfg = makeConfig({ name: 'w', durationInFrames: 10 });
  const { jobId } = jobs.startRender({ targetId: 'a', scenePath: tmp, config: cfg, outputPath: path.join(tmp, 'd.mp4'), renderFn: a.renderFn });

  const res = await jobs.waitFor([jobId], { timeoutMs: 100, pollMs: 10 });
  assert.equal(res.timedOut, true);
  assert.equal(res.jobs[0].state, JobState.RUNNING);

  a.resolve({ outputPath: 'd.mp4', frames: 10, elapsedMs: 1 }); // let the job settle
  await jobs.waitFor([jobId], { timeoutMs: 1_000, pollMs: 10 });
});

test('waitFor: unknown job id fails up front with job_not_found', async () => {
  const jobs = new JobManager();
  await assert.rejects(jobs.waitFor(['nope'], { timeoutMs: 100 }), (err) => err.code === ErrorCodes.JOB_NOT_FOUND);
});

/* ------------------------------------------------------ sfx clamping ------ */

test('renderCues: names each clamped cue with its index and lost tail', () => {
  const spec = {
    fps: 30,
    durationInFrames: 30, // a 1-second bed
    sampleRate: 22050,
    cues: [
      { type: 'tone', atFrame: 0, dur: 0.2 },                 // fits
      { type: 'chime', atFrame: 15, decay: 2.0 },             // tail runs past the end
    ],
  };
  const result = renderCues(spec);
  assert.equal(result.clamped, 1);
  assert.equal(result.clampedCues.length, 1);
  const c = result.clampedCues[0];
  assert.equal(c.cue, 1);
  assert.equal(c.type, 'chime');
  assert.equal(c.atSeconds, 0.5);
  assert.ok(c.lostSeconds > 0, `lostSeconds should be positive, got ${c.lostSeconds}`);
});

test('renderCues: no clamped cues → empty detail array', () => {
  const result = renderCues({
    fps: 30,
    durationInFrames: 90,
    sampleRate: 22050,
    cues: [{ type: 'tone', atFrame: 0, dur: 0.2 }],
  });
  assert.equal(result.clamped, 0);
  assert.deepEqual(result.clampedCues, []);
});
