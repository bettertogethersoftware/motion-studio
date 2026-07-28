/**
 * v0.10 feature tests: batch preview capture, render pre-flight, the audio
 * limiter + level measurement, and the determinism warnings surfaced by
 * ProjectStore.writeFile.
 *
 * Real FFmpeg where audio is involved; Chromium is replaced by the injectable
 * fake browser, whose failAtFrame/onCapture hooks let us prove that pre-flight
 * fails *before* the bulk of a render happens.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  captureFrames, captureSingleFrame, renderComposition,
  preflightFrameList, MAX_PREVIEW_FRAMES, MIN_FRAMES_FOR_PREFLIGHT,
} from '../src/core/renderer.js';
import { measureAudioLevels } from '../src/core/encoder.js';
import { makeConfig, validateConfig } from '../src/core/scene.js';
import { makeSceneIn } from './helpers/workspace.mjs';
import { ErrorCodes } from '../src/core/errors.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';

const execFileP = promisify(execFile);

let tmp;
let haveFfmpeg = true;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-v010-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
});

const cfgFor = (over = {}, outOver = {}) => {
  const cfg = makeConfig({ name: 'V010', fps: 30, width: 160, height: 120, durationInFrames: 120, ...over });
  cfg.output = { ...cfg.output, ...outOver };
  return validateConfig(cfg);
};

/** Fake browser factory that also counts page loads and captured frames. */
function countingFactory(hooks = {}) {
  const stats = { pages: 0, captured: [] };
  const inner = makeFakeBrowserFactory({ ...hooks, onCapture: (n) => stats.captured.push(n) });
  const factory = async (opts) => {
    const browser = await inner(opts);
    const openPage = browser.openPage.bind(browser);
    return { ...browser, openPage: async (o) => { stats.pages++; return openPage(o); } };
  };
  return { factory, stats };
}

/** A 2s test tone. Its absolute level is whatever this ffmpeg's sine emits. */
async function makeTone(dest) {
  await execFileP('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100', dest,
  ]);
  return dest;
}

/**
 * gainDb that lands `file` at `targetDb` peak. lavfi's sine is well below full
 * scale on some builds, so a clipping test has to calibrate rather than assume.
 */
async function gainToReach(file, targetDb) {
  const levels = await measureAudioLevels({ filePath: file });
  assert.ok(levels?.peakDb != null, 'could not measure the test tone');
  return targetDb - levels.peakDb;
}

/** A project whose composition never renders — we only drive the fake browser. */
async function makeProject(name) {
  const dir = path.join(tmp, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'composition.html'), '<html><body></body></html>');
  return dir;
}

/* --------------------------- preflightFrameList ---------------------- */

test('preflightFrameList: includes both endpoints and is sorted/deduped', () => {
  assert.deepEqual(preflightFrameList(0, 299, 5), [0, 75, 150, 224, 299]);
  assert.deepEqual(preflightFrameList(100, 199, 3), [100, 150, 199]);
});

test('preflightFrameList: degenerate ranges do not produce duplicates or out-of-range frames', () => {
  assert.deepEqual(preflightFrameList(0, 0, 5), [0]);
  assert.deepEqual(preflightFrameList(7, 8, 5), [7, 8]);
  const list = preflightFrameList(0, 3, 10);
  assert.deepEqual(list, [0, 1, 2, 3]);
  assert.ok(list.every((f) => f >= 0 && f <= 3));
});

/* ----------------------------- captureFrames ------------------------- */

test('captureFrames: N frames come from ONE page load, in the order requested', async () => {
  const dir = await makeProject('batch');
  const { factory, stats } = countingFactory();
  const shots = await captureFrames({
    scenePath: dir, config: cfgFor(), frames: [10, 0, 119, 60], browserFactory: factory,
  });
  assert.deepEqual(shots.map((s) => s.frame), [10, 0, 119, 60]);
  assert.ok(shots.every((s) => Buffer.isBuffer(s.png) && s.png.length > 0));
  // The whole point of the feature: four frames, one page load.
  assert.equal(stats.pages, 1);
});

test('captureFrames: rejects an empty list, an over-long list, and out-of-range frames', async () => {
  const dir = await makeProject('batch-invalid');
  const config = cfgFor();
  const { factory } = countingFactory();
  const call = (frames) => captureFrames({ scenePath: dir, config, frames, browserFactory: factory });

  await assert.rejects(() => call([]), (e) => e.code === ErrorCodes.INVALID_CONFIG);
  await assert.rejects(
    () => call(Array.from({ length: MAX_PREVIEW_FRAMES + 1 }, (_, i) => i)),
    (e) => e.code === ErrorCodes.INVALID_CONFIG && /at most/.test(e.message),
  );
  await assert.rejects(() => call([0, 120]), (e) => e.code === ErrorCodes.INVALID_CONFIG && /out of range/.test(e.message));
});

test('captureSingleFrame: still works and keeps its out-of-range message', async () => {
  const dir = await makeProject('single');
  const { factory } = countingFactory();
  const png = await captureSingleFrame({ scenePath: dir, config: cfgFor(), frame: 5, browserFactory: factory });
  assert.ok(Buffer.isBuffer(png) && png.length > 0);
  await assert.rejects(
    () => captureSingleFrame({ scenePath: dir, config: cfgFor(), frame: 999, browserFactory: factory }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG && /out of range \(composition has frames 0\.\.119\)/.test(e.message),
  );
});

/* ------------------------------- pre-flight -------------------------- */

test('preflight: a failure at a late frame is caught before the render body runs', async () => {
  const dir = await makeProject('preflight-late');
  // Break the second-to-last probe rather than hard-coding a frame number.
  const late = preflightFrameList(0, 119, 5)[3];
  const { factory, stats } = countingFactory({ failAtFrame: late });
  await assert.rejects(
    () => renderComposition({
      scenePath: dir,
      config: cfgFor(),
      outputPath: path.join(dir, 'out.mp4'),
      browserFactory: factory,
    }),
    (e) => e.code === ErrorCodes.COMPOSITION_ERROR
      && new RegExp(`Pre-flight failed at frame ${late}`).test(e.message)
      && e.detail?.phase === 'preflight',
  );
  // Without pre-flight this would have captured ~90 frames before failing.
  assert.ok(stats.captured.length <= 5, `captured ${stats.captured.length} frames before failing`);
});

test('preflight: probes endpoints, so a frame-0-only smoke test cannot pass a broken end', async () => {
  const dir = await makeProject('preflight-end');
  const { factory } = countingFactory({ failAtFrame: 119 });
  await assert.rejects(
    () => renderComposition({
      scenePath: dir, config: cfgFor(), outputPath: path.join(dir, 'out.mp4'), browserFactory: factory,
    }),
    (e) => /Pre-flight failed at frame 119/.test(e.message),
  );
});

test('preflight: can be disabled, and is skipped for short renders', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await makeProject('preflight-off');

  // Disabled: the probe frames are never captured, so the render reaches 90.
  const off = countingFactory();
  await renderComposition({
    scenePath: dir, config: cfgFor(), outputPath: path.join(dir, 'off.mp4'),
    browserFactory: off.factory, preflight: false,
  });
  assert.equal(off.stats.captured.length, 120, 'exactly the render frames, no probes');

  // Short render: below the threshold pre-flight is pure overhead and skipped.
  const short = countingFactory();
  const frames = MIN_FRAMES_FOR_PREFLIGHT - 1;
  await renderComposition({
    scenePath: dir, config: cfgFor({ durationInFrames: frames }), outputPath: path.join(dir, 'short.mp4'),
    browserFactory: short.factory,
  });
  assert.equal(short.stats.captured.length, frames);
});

test('preflight: a healthy composition renders the probe frames plus every real frame', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await makeProject('preflight-ok');
  const { factory, stats } = countingFactory();
  const res = await renderComposition({
    scenePath: dir, config: cfgFor(), outputPath: path.join(dir, 'ok.mp4'), browserFactory: factory,
  });
  assert.equal(res.frames, 120);
  // 120 real frames + 5 probes, all from the one page the render already opened.
  assert.equal(stats.captured.length, 125);
  assert.equal(stats.pages, 1);
});

/* --------------------------- audio measurement ----------------------- */

test('measureAudioLevels: reports peak/mean dBFS, tracking a known gain change', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  // Asserted relatively: lavfi's sine amplitude is not full scale and differs
  // between ffmpeg builds, so a -6 dB step is the stable thing to check.
  const loud = path.join(tmp, 'tone-loud.wav');
  const quiet = path.join(tmp, 'tone-quiet.wav');
  await makeTone(loud);
  await execFileP('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', loud, '-af', 'volume=-6dB', quiet]);

  const a = await measureAudioLevels({ filePath: loud });
  const b = await measureAudioLevels({ filePath: quiet });
  assert.ok(a && b, 'expected levels for both files');
  assert.ok(Math.abs((a.peakDb - b.peakDb) - 6) < 0.3, `peak delta was ${a.peakDb - b.peakDb}`);
  assert.ok(a.meanDb < a.peakDb, 'mean must sit below peak');
});

test('measureAudioLevels: reports its pid and dies on abort', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  // The renderer's contract is that EVERY spawned pid is reported so the job
  // owner can guarantee no orphaned ffmpeg survives a cancel. This pass decodes
  // the whole file, so on a long film it owns a process for a real window.
  const tone = await makeTone(path.join(tmp, 'abort-tone.wav'));
  const pids = [];
  const controller = new AbortController();
  const levels = await measureAudioLevels({
    filePath: tone, onSpawn: (pid) => pids.push(pid), signal: controller.signal,
  });
  assert.ok(levels, 'expected a measurement');
  assert.equal(pids.length, 1, 'exactly one pid should be reported');
  assert.equal(typeof pids[0], 'number');

  // Aborting before the process finishes yields no measurement rather than hanging.
  const pre = new AbortController();
  pre.abort();
  const aborted = await measureAudioLevels({ filePath: tone, signal: pre.signal });
  assert.equal(aborted, null, 'an already-aborted signal must not return a measurement');
});

test('measureAudioLevels: returns null instead of throwing on a file with no audio', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const txt = path.join(tmp, 'not-media.txt');
  await fsp.writeFile(txt, 'nope');
  assert.equal(await measureAudioLevels({ filePath: txt }), null);
});

test('render: the limiter keeps a hot two-track mix under 0 dBFS and reports it', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await makeProject('audio-levels');
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
  const track = await makeTone(path.join(dir, 'assets', 'tone.wav'));
  // Two coherent copies at -1 dBFS sum to roughly +5 dBFS under normalize=0.
  const gainDb = await gainToReach(track, -1);

  const config = cfgFor({ durationInFrames: 30 });
  config.audio = [{ src: 'assets/tone.wav', gainDb }, { src: 'assets/tone.wav', gainDb }];
  const { factory } = countingFactory();
  const res = await renderComposition({
    scenePath: dir, config, outputPath: path.join(dir, 'audio.mp4'), browserFactory: factory,
  });

  assert.equal(res.audio.tracks, 2);
  assert.equal(res.audio.limiter, true);
  assert.equal(typeof res.audio.peakDb, 'number');
  assert.ok(res.audio.peakDb < 0, `limited mix should stay under 0 dBFS, got ${res.audio.peakDb}`);
  assert.equal(res.audio.clipping, false);
});

test('render: with the limiter disabled the same mix is reported as clipping', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await makeProject('audio-clip');
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
  const track = await makeTone(path.join(dir, 'assets', 'tone.wav'));
  const gainDb = await gainToReach(track, -1);

  const config = cfgFor({ durationInFrames: 30 }, { audioLimiter: false });
  config.audio = [{ src: 'assets/tone.wav', gainDb }, { src: 'assets/tone.wav', gainDb }];
  const { factory } = countingFactory();
  const res = await renderComposition({
    scenePath: dir, config, outputPath: path.join(dir, 'clip.mp4'), browserFactory: factory,
  });
  assert.equal(res.audio.limiter, false);
  assert.equal(res.audio.clipping, true, `peakDb was ${res.audio.peakDb}`);
});

/* ---------------------- determinism warnings on write ---------------- */

test('writeFile: returns determinism warnings but still writes the file', async () => {
  const { store, scene } = await makeSceneIn(path.join(tmp, 'store'), { name: 'Lint Demo', durationInFrames: 30 });
  const src = 'MotionStudio.registerComposition((frame) => {\n  const j = Math.random();\n});\n';
  const res = await store.writeFile(scene.id, 'composition.js', src);

  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].rule, 'math-random');
  assert.equal(res.warnings[0].line, 2);
  assert.equal(await store.readFile(scene.id, 'composition.js'), src, 'a warning must not block the write');
});

test('writeFile: a clean composition reports no warnings key at all', async () => {
  const { store, scene } = await makeSceneIn(path.join(tmp, 'store2'), { name: 'Clean Demo', durationInFrames: 30 });
  const res = await store.writeFile(
    scene.id, 'composition.js',
    'MotionStudio.registerComposition((frame) => {\n  el.style.opacity = interpolate(frame, [0, 10], [0, 1]);\n});\n',
  );
  assert.equal(res.warnings, undefined);
});

test('writeFile: a broken file is still rejected before the lint runs', async () => {
  const { store, scene } = await makeSceneIn(path.join(tmp, 'store3'), { name: 'Broken Demo', durationInFrames: 30 });
  await assert.rejects(
    () => store.writeFile(scene.id, 'composition.js', 'function ( { Math.random()'),
    (e) => e.code === ErrorCodes.SYNTAX_ERROR,
  );
});

/* ------------------------------- config ------------------------------ */

test('config: audioLimiter defaults on and rejects non-booleans', () => {
  assert.equal(makeConfig({ name: 'x' }).output.audioLimiter, true);
  assert.throws(
    () => cfgFor({}, { audioLimiter: 'yes' }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG && /audioLimiter/.test(e.message),
  );
});
