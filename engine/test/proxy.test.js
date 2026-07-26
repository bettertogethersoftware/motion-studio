/**
 * Proxy/motion preview tests (v0.21): the cheap low-res + frame-skip render
 * mode for checking motion before committing to a full render.
 *
 * Unit-level: option validation (invalid_config with named values), the
 * even-floored dimension math, the stepped frame list, and the ".proxy"
 * filename derivation. Pipeline-level: the real renderer → FFmpeg path with
 * the fake browser — proxies change the capture geometry and the encode
 * rate, so the encoded file itself (dims, rational fps, stream layout) is
 * the only honest assertion target; ffprobe-gated like the other suites.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  renderComposition, renderParallel,
  normalizeProxy, proxyDimensions, steppedFrameList, proxyOutputPath,
  MIN_FRAMES_FOR_PREFLIGHT,
} from '../src/core/renderer.js';
import { FfmpegFrameSink } from '../src/core/encoder.js';
import { ProgressEmitter } from '../src/core/progress.js';
import { makeConfig } from '../src/core/project.js';
import { ErrorCodes } from '../src/core/errors.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';

const execFileP = promisify(execFile);

let haveFfmpeg = false;
let tmp;
before(async () => {
  try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated below */ }
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-proxy-'));
});
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function makeProject(name, configOverrides = {}) {
  const projectPath = path.join(tmp, name);
  await fsp.mkdir(projectPath, { recursive: true });
  const config = makeConfig({ name, width: 128, height: 72, durationInFrames: 90, ...configOverrides });
  return { projectPath, config };
}

/** ffprobe one video-stream field (e.g. width, r_frame_rate, nb_frames). */
async function probeVideo(file, field) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', `stream=${field}`, '-of', 'default=nk=1:nw=1', file,
  ]);
  return stdout.trim();
}

/**
 * Wrap the fake factory so the test can see what the renderer asked the
 * browser for — the proxy contract is "small viewport + contentScale", and
 * the openPage arguments are the only place that contract is visible.
 */
function spyingFactory(hooks, seen) {
  const inner = makeFakeBrowserFactory(hooks);
  return async () => {
    const browser = await inner();
    const openPage = browser.openPage.bind(browser);
    browser.openPage = async (opts) => { seen.push(opts); return openPage(opts); };
    return browser;
  };
}

/* ------------------------------------------------ option validation ------- */

test('normalizeProxy: fills the documented defaults', () => {
  assert.deepEqual(normalizeProxy({}), { scale: 0.5, frameStep: 2 });
  assert.deepEqual(normalizeProxy({ scale: 0.25 }), { scale: 0.25, frameStep: 2 });
  assert.deepEqual(normalizeProxy({ frameStep: 5 }), { scale: 0.5, frameStep: 5 });
});

test('normalizeProxy: invalid values fail invalid_config and NAME the value', () => {
  for (const scale of [0, 0.05, 1.5, -1, 'big', NaN]) {
    try {
      normalizeProxy({ scale });
      assert.fail(`scale ${scale} should have thrown`);
    } catch (e) {
      assert.equal(e.code, ErrorCodes.INVALID_CONFIG);
      assert.match(e.message, /proxy\.scale/, e.message);
    }
  }
  for (const frameStep of [0, -2, 1.5, 'fast']) {
    try {
      normalizeProxy({ frameStep });
      assert.fail(`frameStep ${frameStep} should have thrown`);
    } catch (e) {
      assert.equal(e.code, ErrorCodes.INVALID_CONFIG);
      assert.match(e.message, /proxy\.frameStep/, e.message);
    }
  }
});

test('renderComposition: rejects a bad proxy before launching anything', async () => {
  const { projectPath, config } = await makeProject('proj-badproxy');
  let launches = 0;
  await assert.rejects(
    renderComposition({
      projectPath, config, outputPath: path.join(projectPath, 'out', 'output.mp4'),
      proxy: { scale: 9 },
      browserFactory: makeFakeBrowserFactory({ onLaunch: () => launches++ }),
    }),
    (err) => err.code === ErrorCodes.INVALID_CONFIG,
  );
  assert.equal(launches, 0, 'validation must precede the browser launch');
});

/* --------------------------------------------------- dimension math ------- */

test('proxyDimensions: floors to even numbers (encoders reject odd dims)', () => {
  assert.deepEqual(proxyDimensions(1920, 1080, 0.5), { width: 960, height: 540 });
  // 854×480 @ 0.5 → 427×240; 427 is odd and must floor to 426, not round to 428
  assert.deepEqual(proxyDimensions(854, 480, 0.5), { width: 426, height: 240 });
  // both axes round independently
  assert.deepEqual(proxyDimensions(106, 62, 0.5), { width: 52, height: 30 });
  // full scale stays the (already even) composition size
  assert.deepEqual(proxyDimensions(1920, 1080, 1), { width: 1920, height: 1080 });
});

test('proxyDimensions: clamps to 2 so tiny compositions cannot hit zero', () => {
  assert.deepEqual(proxyDimensions(4, 4, 0.1), { width: 2, height: 2 });
});

/* ------------------------------------------------ stepped frame list ------ */

test('steppedFrameList: every Nth frame, final frame NOT forced in', () => {
  const evenSpan = steppedFrameList(0, 89, 2);
  assert.equal(evenSpan.length, 45);
  assert.equal(evenSpan[0], 0);
  assert.equal(evenSpan.at(-1), 88); // 89 is skipped: exact arithmetic, no tail special-case

  const coarse = steppedFrameList(0, 89, 7);
  assert.equal(coarse.length, 13);
  assert.equal(coarse.at(-1), 84);

  // step 1 is the identity — the full-render path shares this list
  assert.equal(steppedFrameList(0, 89, 1).length, 90);
  // a range offset keeps the step anchored at the range start
  assert.deepEqual(steppedFrameList(10, 20, 4), [10, 14, 18]);
});

/* -------------------------------------------------- filename derivation --- */

test('proxyOutputPath: inserts .proxy before the extension, idempotently', () => {
  assert.equal(proxyOutputPath(path.join('out', 'output.mp4')), path.join('out', 'output.proxy.mp4'));
  assert.equal(proxyOutputPath(path.join('out', 'output.proxy.mp4')), path.join('out', 'output.proxy.mp4'));
  // png-sequence outputs are directories with no extension
  assert.equal(proxyOutputPath(path.join('out', 'frames')), path.join('out', 'frames.proxy'));
});

/* -------------------------------------- rational rate reaches the sink ---- */

test('FfmpegFrameSink: a rational fps string reaches -framerate verbatim', () => {
  // A nonexistent binary: the spawn fails asynchronously, but the argument
  // list — the thing under test — is assembled synchronously first.
  const sink = new FfmpegFrameSink({
    outputPath: path.join(os.tmpdir(), 'never-written.mp4'),
    fps: '30/4',
    ffmpegPath: path.join(os.tmpdir(), 'ms-no-such-ffmpeg'),
  });
  try {
    const i = sink.args.indexOf('-framerate');
    assert.ok(i >= 0, 'sink must pass -framerate');
    assert.equal(sink.args[i + 1], '30/4');
  } finally {
    sink.kill(); // also swallows the failed-spawn exit rejection
  }
});

/* ----------------------------------------- full pipeline (real ffmpeg) ---- */

test('proxy render: scaled viewport, stepped frames, rational rate, no preflight, .proxy name', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { projectPath, config } = await makeProject('proj-proxy');
  assert.ok(config.durationInFrames >= MIN_FRAMES_FOR_PREFLIGHT, 'long enough that preflight would normally run');
  const outputPath = path.join(projectPath, 'out', 'output.mp4');

  const pages = [];
  const captured = [];
  const phases = [];
  const progress = new ProgressEmitter(null, (m) => { if (m.type === 'phase') phases.push(m.phase); });

  const result = await renderComposition({
    projectPath, config, outputPath, progress,
    proxy: { frameStep: 4 }, // scale defaults to 0.5
    browserFactory: spyingFactory({ onCapture: (n) => captured.push(n) }, pages),
  });

  // .proxy filename: the deliverable path is untouched, the draft is beside it
  assert.equal(result.outputPath, path.join(projectPath, 'out', 'output.proxy.mp4'));
  await assert.rejects(fsp.stat(outputPath), 'the deliverable name must not be written');

  // frame list: 0, 4, 8, …, 88 — count and endpoints
  assert.equal(result.frames, 23);
  assert.equal(captured.length, 23);
  assert.equal(captured[0], 0);
  assert.equal(captured.at(-1), 88);
  assert.deepEqual(result.proxy, { scale: 0.5, frameStep: 4 });

  // proxy IS the preflight — no probe pass despite the 90-frame duration
  assert.ok(!phases.includes('preflight'), `phases were ${phases.join(', ')}`);

  // the page was opened at the scaled size with the exact per-axis factors
  assert.equal(pages.length, 1);
  assert.equal(pages[0].width, 64);
  assert.equal(pages[0].height, 36);
  assert.deepEqual(pages[0].contentScale, { x: 64 / 128, y: 36 / 72 });

  // the encoded file agrees: proxy dims, and 30/4 = 7.5 fps survived the mp4 path
  assert.equal(await probeVideo(result.outputPath, 'width'), '64');
  assert.equal(await probeVideo(result.outputPath, 'height'), '36');
  assert.equal(await probeVideo(result.outputPath, 'r_frame_rate'), '15/2');
  assert.equal(result.framesVerified, true, 'a proxy is a whole file and is verified like one');
});

test('proxy render: odd scaled dims are floored to even and the mp4 encode succeeds', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // 106×62 @ 0.5 → 53×31, both odd: without the even floor libx264 rejects it
  const { projectPath, config } = await makeProject('proj-odd', { width: 106, height: 62 });
  const result = await renderComposition({
    projectPath, config, outputPath: path.join(projectPath, 'out', 'output.mp4'),
    proxy: {},
    browserFactory: makeFakeBrowserFactory(),
  });
  assert.equal(await probeVideo(result.outputPath, 'width'), '52');
  assert.equal(await probeVideo(result.outputPath, 'height'), '30');
});

test('proxy render: audio tracks configured, but the proxy carries NO audio stream', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // The mux is skipped outright, so the referenced asset is deliberately
  // never created: if a regression re-enables the mux, the render fails loudly
  // here instead of the assertion below silently passing on a muxed file.
  const { projectPath, config } = await makeProject('proj-audio', {
    audio: [{ src: 'assets/bed.wav', startInFrames: 0 }],
  });
  const phases = [];
  const progress = new ProgressEmitter(null, (m) => { if (m.type === 'phase') phases.push(m.phase); });

  const result = await renderComposition({
    projectPath, config, outputPath: path.join(projectPath, 'out', 'output.mp4'),
    proxy: {}, progress,
    browserFactory: makeFakeBrowserFactory(),
  });

  assert.ok(!phases.includes('audio'), `audio phase ran: ${phases.join(', ')}`);
  assert.equal(result.audio, undefined);
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=codec_type', '-of', 'default=nk=1:nw=1', result.outputPath,
  ]);
  assert.equal(stdout.trim(), '', 'no audio stream in a proxy');
});

test('renderParallel: a proxy delegates to ONE serial render, whatever workers says', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { projectPath, config } = await makeProject('proj-serial');
  let launches = 0;
  const result = await renderParallel({
    projectPath, config, outputPath: path.join(projectPath, 'out', 'output.mp4'),
    workers: 4,
    proxy: {},
    browserFactory: makeFakeBrowserFactory({ onLaunch: () => launches++ }),
  });
  // One launch total: no per-worker Chromium fan-out, no preflight probe browser
  assert.equal(launches, 1);
  assert.equal(result.frames, 45);
  assert.ok(result.outputPath.endsWith('output.proxy.mp4'));
});

test('proxy render: png-sequence writes the stepped frames contiguously into a .proxy dir', async () => {
  // No encode step, so this pipeline test needs no ffmpeg at all.
  const { projectPath, config } = await makeProject('proj-seq');
  config.output = { ...config.output, format: 'png-sequence', filename: 'frames' };
  const result = await renderComposition({
    projectPath, config, outputPath: path.join(projectPath, 'out', 'frames'),
    proxy: { scale: 0.5, frameStep: 3 },
    browserFactory: makeFakeBrowserFactory(),
  });
  assert.equal(result.outputPath, path.join(projectPath, 'out', 'frames.proxy'));
  const files = (await fsp.readdir(result.outputPath)).sort();
  // frames 0,3,…,87 → 30 files, numbered 000000…000029 with no step-shaped gaps
  assert.equal(files.length, 30);
  assert.equal(files[0], 'frame-000000.png');
  assert.equal(files.at(-1), 'frame-000029.png');
});
