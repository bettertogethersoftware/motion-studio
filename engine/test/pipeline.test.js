/**
 * Pipeline integration tests. These run the REAL renderer and REAL ffmpeg —
 * only Chromium is replaced by the fake browser factory (test/helpers), which
 * produces genuine PNG frames. Verifies:
 *   - stdin-streamed encode produces a valid MP4 with the right frame count
 *   - PNG-sequence mode (framesDir) produces the same
 *   - audio muxing adds an AAC stream of the right duration
 *   - cancellation stops mid-render, cleans up, reports CANCELLED
 *   - JobManager lifecycle: status polling, concurrency cap, logs, cancel
 *
 * Skipped automatically if ffmpeg is not on PATH.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { renderComposition } from '../src/core/renderer.js';
import { JobManager, JobState } from '../src/core/jobs.js';
import { makeConfig } from '../src/core/scene.js';
import { ErrorCodes } from '../src/core/errors.js';
import { ProgressEmitter } from '../src/core/progress.js';
import { makeFakeBrowserFactory, encodePng } from './helpers/fake-browser.js';

const execFileP = promisify(execFile);

let haveFfmpeg = false;
let tmp;
before(async () => {
  try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { haveFfmpeg = false; }
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-pipeline-'));
});

const CFG = () => makeConfig({ name: 'Pipeline', fps: 30, width: 320, height: 240, durationInFrames: 24 });

async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,nb_frames,width,height:format=duration',
    '-of', 'json', file,
  ]);
  return JSON.parse(stdout);
}

test('pipeline: stdin-streamed render produces a valid MP4', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'stream.mp4');
  const messages = [];
  const result = await renderComposition({
    scenePath: tmp,
    config: CFG(),
    outputPath: out,
    browserFactory: makeFakeBrowserFactory(),
    progress: new ProgressEmitter(null, (m) => messages.push(m)),
  });

  assert.equal(result.frames, 24);
  assert.ok(fs.existsSync(out));

  const info = await probe(out);
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 320);
  assert.equal(Number(v.nb_frames), 24);

  // protocol shape: start → capturing → per-frame progress → encoding →
  // staged review → promotion → done. A completed file is not a delivery until
  // its evidence is checked and its rename onto the visible output path succeeds.
  assert.equal(messages[0].type, 'start');
  assert.equal(messages.filter((m) => m.type === 'progress').length, 24);
  assert.deepEqual(messages.filter((m) => m.type === 'phase').map((m) => m.phase), ['capturing', 'encoding', 'creating-review', 'promoting']);
  assert.equal(result.promoted, true);
  assert.ok(result.review?.reviewPath);
  assert.equal(messages.at(-1).type, 'done');
});

test('pipeline: a review-policy block retains the prior delivery and staged evidence', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const config = makeConfig({ name: 'Static review', fps: 30, width: 160, height: 90, durationInFrames: 90 });
  const out = path.join(tmp, 'review-block.mp4');
  const staticBrowser = async () => ({
    async openPage({ width, height }) {
      const png = encodePng(width, height, () => [18, 24, 35]);
      return { async captureFrame() { return png; }, async close() {} };
    },
    async close() {},
  });

  await renderComposition({
    scenePath: tmp,
    config,
    outputPath: out,
    browserFactory: staticBrowser,
    preflight: false,
    reviewPolicy: { block: [], warn: ['static_run'] },
    jobId: 'review-baseline',
  });
  const prior = await fsp.readFile(out);
  let error;
  await assert.rejects(
    renderComposition({
      scenePath: tmp,
      config,
      outputPath: out,
      browserFactory: staticBrowser,
      preflight: false,
      reviewPolicy: { block: ['static_run'], warn: [] },
      jobId: 'review-blocked',
    }),
    (caught) => { error = caught; return caught.code === ErrorCodes.PROMOTION_BLOCKED; },
  );
  assert.deepEqual(await fsp.readFile(out), prior, 'a blocked staging file cannot replace the last delivery');
  assert.ok(fs.existsSync(error.detail.reviewPath), 'the staged report explains the block');
  const report = JSON.parse(await fsp.readFile(error.detail.reviewPath, 'utf8'));
  assert.ok(report.warnings.some((warning) => warning.code === 'static_run' && warning.level === 'block'));
  assert.ok(fs.existsSync(error.detail.contactPath), 'the staged contact sheet is available for diagnosis');
});

test('pipeline: framesDir mode writes PNG sequence then encodes', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'seq.mp4');
  const framesDir = path.join(tmp, 'frames');
  await renderComposition({
    scenePath: tmp,
    config: CFG(),
    outputPath: out,
    framesDir,
    frameRange: [6, 17], // partial range: files must be range-relative 000000..
    browserFactory: makeFakeBrowserFactory(),
  });
  const pngs = (await fsp.readdir(framesDir)).sort();
  assert.equal(pngs.length, 12);
  assert.equal(pngs[0], 'frame-000000.png');
  const info = await probe(out);
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video').nb_frames), 12);
});

test('pipeline: audio pass muxes AAC trimmed to video length', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // synthesize a 5s sine as the "music bed" (longer than the 0.8s video)
  const wav = path.join(tmp, 'assets', 'tone.wav');
  await fsp.mkdir(path.dirname(wav), { recursive: true });
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', wav]);

  const config = { ...CFG(), audio: [{ src: 'assets/tone.wav', startInFrames: 6, gainDb: -3 }] };
  const out = path.join(tmp, 'audio.mp4');
  await renderComposition({
    scenePath: tmp,
    config,
    outputPath: out,
    browserFactory: makeFakeBrowserFactory(),
  });

  const info = await probe(out);
  const kinds = info.streams.map((s) => s.codec_type).sort();
  assert.deepEqual(kinds, ['audio', 'video']);
  assert.equal(info.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
  // 24 frames / 30fps = 0.8s; audio must not stretch it to the 5s bed
  assert.ok(Math.abs(Number(info.format.duration) - 0.8) < 0.15, `duration ${info.format.duration}`);
});

test('pipeline: composition error propagates with frame context', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await assert.rejects(
    () =>
      renderComposition({
        scenePath: tmp,
        config: CFG(),
        outputPath: path.join(tmp, 'fail.mp4'),
        browserFactory: makeFakeBrowserFactory({ failAtFrame: 10 }),
      }),
    (e) => e.code === ErrorCodes.COMPOSITION_ERROR && /frame 10/.test(e.message),
  );
});

test('pipeline: cancellation mid-render stops cleanly', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const controller = new AbortController();
  const captured = [];
  const p = renderComposition({
    scenePath: tmp,
    config: makeConfig({ name: 'Cancel', fps: 30, width: 320, height: 240, durationInFrames: 200 }),
    outputPath: path.join(tmp, 'cancel.mp4'),
    signal: controller.signal,
    browserFactory: makeFakeBrowserFactory({
      captureDelayMs: 15,
      onCapture: (n) => { captured.push(n); if (n === 5) controller.abort(); },
    }),
  });
  await assert.rejects(p, (e) => e.code === ErrorCodes.CANCELLED);
  assert.ok(captured.length < 20, `stopped early (captured ${captured.length})`);
});

/* ----------------------------- JobManager ---------------------------- */

const waitFor = async (fn, timeoutMs = 30_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
};

test('jobs: full lifecycle running → done with progress snapshots', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const jm = new JobManager();
  const out = path.join(tmp, 'job.mp4');
  const { jobId } = jm.startRender({
    targetId: 'p1',
    scenePath: tmp,
    config: CFG(),
    outputPath: out,
    renderFn: (opts) => renderComposition({ ...opts, browserFactory: makeFakeBrowserFactory() }),
  });

  assert.equal(jm.getStatus(jobId).state, JobState.RUNNING);
  await waitFor(() => jm.getStatus(jobId).state !== JobState.RUNNING);

  const st = jm.getStatus(jobId);
  assert.equal(st.state, JobState.DONE);
  assert.equal(st.framesDone, 24);
  assert.equal(st.percent, 100);
  assert.ok(fs.existsSync(out));
  assert.ok(jm.getLogs(jobId).some((l) => /phase: encoding/.test(l.message)));
});

test('jobs: second submit queues, runs after first, bounded queue fills', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const jm = new JobManager({ maxConcurrent: 1, maxQueued: 1 });
  const slowRender = (opts) =>
    renderComposition({ ...opts, browserFactory: makeFakeBrowserFactory({ captureDelayMs: 30 }) });
  const fastRender = (opts) => renderComposition({ ...opts, browserFactory: makeFakeBrowserFactory() });

  const first = jm.startRender({
    targetId: 'p1', scenePath: tmp,
    config: makeConfig({ name: 'Slow', fps: 30, width: 320, height: 240, durationInFrames: 60 }),
    outputPath: path.join(tmp, 'busy.mp4'),
    renderFn: slowRender,
  });
  assert.equal(first.state, JobState.RUNNING);

  // Second submit queues (v0.5) instead of failing.
  const second = jm.startRender({
    targetId: 'p1', scenePath: tmp, config: CFG(),
    outputPath: path.join(tmp, 'queued.mp4'), renderFn: fastRender,
  });
  assert.equal(second.state, JobState.QUEUED);
  assert.equal(second.queuePosition, 1);
  assert.equal(jm.getStatus(second.jobId).state, JobState.QUEUED);

  // The queue is bounded: a third submit fails with queue_full.
  assert.throws(
    () => jm.startRender({ targetId: 'p1', scenePath: tmp, config: CFG(), outputPath: path.join(tmp, 'x.mp4'), renderFn: fastRender }),
    (e) => e.code === ErrorCodes.QUEUE_FULL && e.detail.queuedJobIds.includes(second.jobId),
  );

  // Cancel the running job → the queued one is scheduled and completes.
  jm.cancel(first.jobId);
  await waitFor(() => jm.getStatus(first.jobId).state !== JobState.RUNNING);
  assert.equal(jm.getStatus(first.jobId).state, JobState.CANCELLED);
  await waitFor(() => jm.getStatus(second.jobId).state === JobState.DONE);
  assert.ok(fs.existsSync(path.join(tmp, 'queued.mp4')));
});

test('jobs: cancelling a queued job dequeues it without running', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const jm = new JobManager({ maxConcurrent: 1 });
  const slowRender = (opts) =>
    renderComposition({ ...opts, browserFactory: makeFakeBrowserFactory({ captureDelayMs: 30 }) });
  const running = jm.startRender({
    targetId: 'p1', scenePath: tmp,
    config: makeConfig({ name: 'Slow', fps: 30, width: 320, height: 240, durationInFrames: 60 }),
    outputPath: path.join(tmp, 'busy2.mp4'), renderFn: slowRender,
  });
  const queued = jm.startRender({
    targetId: 'p1', scenePath: tmp, config: CFG(),
    outputPath: path.join(tmp, 'never.mp4'), renderFn: slowRender,
  });
  const res = jm.cancel(queued.jobId);
  assert.equal(res.state, JobState.CANCELLED);
  assert.equal(jm.getStatus(queued.jobId).state, JobState.CANCELLED);
  jm.cancel(running.jobId);
  await waitFor(() => jm.getStatus(running.jobId).state !== JobState.RUNNING);
  assert.ok(!fs.existsSync(path.join(tmp, 'never.mp4')));
});

test('jobs: unknown jobId → job_not_found', () => {
  const jm = new JobManager();
  assert.throws(() => jm.getStatus('missing'), (e) => e.code === ErrorCodes.JOB_NOT_FOUND);
});

/* --------------------------- PNG helper sanity ------------------------ */

test('helper: generated PNGs are decodable by ffmpeg', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const png = encodePng(64, 48, (x, y) => [x * 4, y * 5, 128]);
  const p = path.join(tmp, 'sanity.png');
  await fsp.writeFile(p, png);
  const info = await probe(p);
  assert.equal(info.streams[0].codec_name, 'png');
  assert.equal(info.streams[0].width, 64);
});
