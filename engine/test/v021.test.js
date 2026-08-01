/**
 * v0.21 feature tests:
 *   probe_asset            — media introspection (summarizeMedia + probeMedia)
 *   stale-render detection — the render sidecar, planFilm, validateScenes
 *   page diagnostics       — failed requests named in the error message
 *
 * Real ffprobe/ffmpeg where a measurement is asserted (gated on availability,
 * like the other suites); pure functions are tested directly.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { summarizeMedia, probeMedia } from '../src/core/encoder.js';
import {
  writeRenderMeta, readRenderMeta, renderStaleness, renderDeliveryStaleness, describeStaleness,
  renderMetaPath, sceneOutputPath, validateScenes,
} from '../src/core/film.js';
import { planFilm } from '../src/core/films.js';
import { renderComposition } from '../src/core/renderer.js';
import { makeConfig, validateConfig } from '../src/core/scene.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';
import { formatPageDiagnostics } from '../src/core/browser.js';
import { makeStore, makeScene, TEST_WS } from './helpers/workspace.mjs';
import { ErrorCodes } from '../src/core/errors.js';
import { stagingOutputPath, promoteStagingOutput } from '../src/core/delivery.js';

const execFileP = promisify(execFile);

let tmp;
let haveFfmpeg = true, haveFfprobe = true;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-v021-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  try { await execFileP('ffprobe', ['-version']); } catch { haveFfprobe = false; }
});

const dirFor = async (name) => {
  const d = path.join(tmp, name);
  await fsp.mkdir(d, { recursive: true });
  return d;
};

test('stagingOutputPath gives direct callers a unique path when they have no job id', () => {
  const out = path.join(tmp, 'staging-name', 'out', 'output.mp4');
  const a = stagingOutputPath(out, { jobId: null });
  const b = stagingOutputPath(out, { jobId: null });
  assert.notEqual(a, b);
  assert.match(a, /[\\/]\.staging[\\/]output-[0-9a-f-]+\.mp4$/i);
});

/* ------------------------------------------------------------------ *
 * Promotion retry (v0.23): a transient scanner lock on the destination
 * (EPERM on rename-over-existing, with no real owner) is waited out with
 * a bounded backoff; anything non-transient still fails immediately.
 * ------------------------------------------------------------------ */

test('promoteStagingOutput rides out a transient EPERM, then succeeds', async () => {
  let attempts = 0;
  let renamed = null;
  const flaky = async (from, to) => {
    attempts += 1;
    if (attempts <= 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    renamed = [from, to];
  };
  const result = await promoteStagingOutput({
    stagedPath: path.join(tmp, 'p', '.staging', 'output-x.mp4'),
    outputPath: path.join(tmp, 'p', 'output.mp4'),
    renameImpl: flaky,
  });
  assert.equal(attempts, 3);
  assert.equal(result, path.resolve(path.join(tmp, 'p', 'output.mp4')));
  assert.equal(renamed[1], result);
});

test('promoteStagingOutput gives up honestly after the retry budget', async () => {
  let attempts = 0;
  const locked = async () => {
    attempts += 1;
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };
  await assert.rejects(
    () => promoteStagingOutput({
      stagedPath: path.join(tmp, 'q', '.staging', 'output-x.mp4'),
      outputPath: path.join(tmp, 'q', 'output.mp4'),
      renameImpl: locked,
    }),
    (e) => e.code === ErrorCodes.DISK_ERROR,
  );
  assert.equal(attempts, 6, 'first try + five backoff retries');
});

/* The lock the backoff CANNOT wait out (v0.23.1): a reader holding the
 * destination open. Measured in production — the Studio streaming a scene's
 * output to a <video> made every re-render of that scene fail EPERM, so a
 * human watching the film page could fail the director's render. These use a
 * REAL read stream, because the whole bug is a platform rename semantic that
 * a mocked rename cannot reproduce. */

test('promoteStagingOutput replaces a destination a reader is holding open', async () => {
  const dir = path.join(tmp, 'held');
  await fsp.mkdir(path.join(dir, '.staging'), { recursive: true });
  const outputPath = path.join(dir, 'output.mp4');
  const stagedPath = path.join(dir, '.staging', 'output-job.mp4');
  await fsp.writeFile(outputPath, Buffer.alloc(512 * 1024, 1));   // the old delivery
  await fsp.writeFile(stagedPath, Buffer.alloc(512 * 1024, 2));   // the new one

  // Exactly what studio/server.js streamFile does while a human watches.
  const reader = fs.createReadStream(outputPath);
  await new Promise((resolve) => reader.once('readable', resolve));
  try {
    const result = await promoteStagingOutput({ stagedPath, outputPath });
    assert.equal(result, path.resolve(outputPath));
    // The NEW bytes are at the delivery name…
    assert.equal((await fsp.readFile(outputPath))[0], 2);
    // …the staged copy is consumed, and no litter is left behind.
    assert.equal(fs.existsSync(stagedPath), false);
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.superseded-'));
    assert.deepEqual(leftovers, [], 'the moved-aside delivery is cleaned up');
    // The reader keeps streaming the bytes it opened — its handle follows the
    // inode, so a human mid-playback is not corrupted by the swap.
    assert.equal(reader.readable, true);
  } finally {
    reader.destroy();
  }
});

test('promoteStagingOutput keeps the old delivery when the side-step cannot finish', async () => {
  const dir = path.join(tmp, 'held-fail');
  await fsp.mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, 'output.mp4');
  await fsp.writeFile(outputPath, Buffer.from('the previous good delivery'));

  // Every rename onto the delivery name fails; moving it aside is allowed.
  const renameImpl = async (from, to) => {
    if (path.resolve(to) === path.resolve(outputPath) && !String(from).includes('.superseded-')) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return fsp.rename(from, to);
  };
  await assert.rejects(
    () => promoteStagingOutput({
      stagedPath: path.join(dir, 'missing-staged.mp4'), outputPath, renameImpl,
    }),
    (e) => e.code === ErrorCodes.DISK_ERROR,
  );
  // The guarantee that matters: a failed promotion never leaves a gap.
  assert.equal(fs.existsSync(outputPath), true, 'the previous delivery is restored');
  assert.equal(await fsp.readFile(outputPath, 'utf8'), 'the previous good delivery');
});

test('promoteStagingOutput does not retry a non-transient failure', async () => {
  let attempts = 0;
  const missing = async () => {
    attempts += 1;
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  };
  await assert.rejects(
    () => promoteStagingOutput({
      stagedPath: path.join(tmp, 'r', '.staging', 'output-x.mp4'),
      outputPath: path.join(tmp, 'r', 'output.mp4'),
      renameImpl: missing,
    }),
    (e) => e.code === ErrorCodes.DISK_ERROR,
  );
  assert.equal(attempts, 1, 'a missing staged file will not appear by waiting');
});

/* ------------------------------------------------------------------ */
/* summarizeMedia — pure, so no ffprobe needed                         */
/* ------------------------------------------------------------------ */

test('summarizeMedia extracts video + audio properties', () => {
  const s = summarizeMedia({
    format: { format_name: 'mov,mp4', duration: '14.716667', bit_rate: '4201087' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
        avg_frame_rate: '60/1', nb_frames: '883', pix_fmt: 'yuv420p', duration: '14.716667' },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '14.699' },
    ],
  });
  assert.equal(s.durationSeconds, 14.716667);
  assert.equal(s.streams, 2);
  assert.deepEqual(
    { c: s.video.codec, w: s.video.width, h: s.video.height, f: s.video.fps, n: s.video.frames },
    { c: 'h264', w: 1920, h: 1080, f: 60, n: 883 },
  );
  assert.equal(s.audio.channels, 2);
  assert.equal(s.audio.sampleRate, 48000);
  assert.equal(s.hasAudio, true);
});

test('summarizeMedia reports colour tags, and "unknown" as null rather than as a value', () => {
  // v0.22. An untagged matrix is exactly the case a player resolves by GUESSING,
  // so passing ffprobe's literal "unknown" through as if it were a colour would
  // hide the one fact worth knowing. Both files below are real measurements: a
  // Motion Studio scene render, and ordinary camera footage.
  const scene = summarizeMedia({
    format: { format_name: 'mov,mp4' },
    streams: [{
      codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1',
      pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'iec61966-2-1',
      color_space: 'unknown', color_range: 'tv',
    }],
  });
  assert.deepEqual(scene.video.color, {
    primaries: 'bt709', transfer: 'iec61966-2-1', matrix: null, range: 'tv',
  });

  const footage = summarizeMedia({
    format: { format_name: 'mov,mp4' },
    streams: [{
      codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1',
      pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'bt709',
      color_space: 'bt709', color_range: 'tv',
    }],
  });
  // The pair that motivated the field: identical pixel format (so they
  // stream-copy together fine) and a different transfer function.
  assert.equal(footage.video.pixFmt, scene.video.pixFmt);
  assert.notEqual(footage.video.color.transfer, scene.video.color.transfer);
});

test('summarizeMedia: a file with no colour tags at all reports nulls, not absence', () => {
  const s = summarizeMedia({
    format: {}, streams: [{ codec_type: 'video', codec_name: 'vp9', width: 8, height: 8, avg_frame_rate: '30/1' }],
  });
  assert.deepEqual(s.video.color, { primaries: null, transfer: null, matrix: null, range: null });
});

test('summarizeMedia warns that H.264 cannot be decoded by the render browser', () => {
  const withH264 = summarizeMedia({
    format: {}, streams: [{ codec_type: 'video', codec_name: 'h264', width: 8, height: 8, avg_frame_rate: '30/1' }],
  });
  assert.ok(withH264.notes?.some((n) => /cannot be decoded by the render browser/.test(n)));

  const withVp9 = summarizeMedia({
    format: {}, streams: [{ codec_type: 'video', codec_name: 'vp9', width: 8, height: 8, avg_frame_rate: '30/1' }],
  });
  assert.equal(withVp9.notes, undefined);
});

test('summarizeMedia parses rational frame rates and flags fractional ones', () => {
  const s = summarizeMedia({
    format: {}, streams: [{ codec_type: 'video', codec_name: 'vp9', width: 8, height: 8, avg_frame_rate: '30000/1001' }],
  });
  assert.equal(s.video.fps, 29.97);
  assert.ok(s.notes?.some((n) => /fractional/.test(n)));
});

test('summarizeMedia ignores cover art so an mp3 is not reported as video', () => {
  const s = summarizeMedia({
    format: { format_name: 'mp3' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } },
      { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
    ],
  });
  assert.equal(s.video, null);
  assert.equal(s.hasAudio, true);
});

test('summarizeMedia survives junk without throwing', () => {
  const s = summarizeMedia({});
  assert.equal(s.video, null);
  assert.equal(s.audio, null);
  assert.equal(s.streams, 0);
});

test('probeMedia returns null when ffprobe is missing rather than throwing', async () => {
  const res = await probeMedia({ filePath: 'nope.mp4', ffprobePath: 'definitely-not-ffprobe-xyz' });
  assert.equal(res, null);
});

test('probeMedia reads a real file', { skip: !haveFfmpeg || !haveFfprobe }, async () => {
  const dir = await dirFor('probe');
  const wav = path.join(dir, 'tone.wav');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2', wav]);
  const s = await probeMedia({ filePath: wav });
  assert.ok(s, 'expected a probe result');
  assert.equal(s.hasAudio, true);
  assert.equal(s.audio.channels, 2);
  assert.ok(Math.abs(s.durationSeconds - 1) < 0.1, `duration ${s.durationSeconds}`);
  assert.equal(s.video, null);
});

/* ------------------------------------------------------------------ */
/* Render sidecar / stale-render detection                             */
/* ------------------------------------------------------------------ */

const cfgOf = (over = {}) => ({
  name: 'S', width: 320, height: 240, fps: 30, durationInFrames: 60,
  output: { dir: 'out', filename: 'output.mp4', format: 'mp4' }, ...over,
});

test('renderStaleness returns null when nothing changed, and when there is no sidecar', () => {
  const cfg = cfgOf();
  assert.equal(renderStaleness({ frames: 60, width: 320, height: 240, fps: 30, format: 'mp4' }, cfg), null);
  assert.equal(renderStaleness(null, cfg), null, 'no sidecar must not be treated as stale');
});

test('renderStaleness reports exactly which fields diverged', () => {
  const cfg = cfgOf({ durationInFrames: 200 });
  const st = renderStaleness({ frames: 217, width: 320, height: 240, fps: 30, format: 'mp4' }, cfg);
  assert.deepEqual(st.changed, ['frames']);
  assert.equal(st.recorded.frames, 217);
  assert.equal(st.current.frames, 200);
  assert.equal(describeStaleness(st), 'frames 217 → 200');

  const many = renderStaleness({ frames: 60, width: 640, height: 240, fps: 24, format: 'mp4' }, cfgOf());
  assert.deepEqual(many.changed, ['width', 'fps']);
});

test('renderStaleness only compares fields the sidecar actually recorded', () => {
  // A partial/older sidecar has less to say — it must not report every
  // absent field as a change.
  assert.equal(renderStaleness({ frames: 60 }, cfgOf()), null);
});

test('writeRenderMeta round-trips through readRenderMeta', async () => {
  const scenePath = await dirFor('meta');
  const cfg = cfgOf();
  await fsp.mkdir(path.join(scenePath, 'out'), { recursive: true });
  await fsp.writeFile(sceneOutputPath(scenePath, cfg), 'rendered-output');
  const written = await writeRenderMeta({ scenePath, config: cfg, frames: 60 });
  assert.equal(written.frames, 60);
  assert.ok(fs.existsSync(renderMetaPath(scenePath, cfg)));

  const read = readRenderMeta(scenePath, cfg);
  assert.equal(read.frames, 60);
  assert.equal(read.width, 320);
  assert.ok(read.renderedAt, 'records when it was rendered');
  assert.deepEqual(read.outputIdentity.bytes, Buffer.byteLength('rendered-output'));
  assert.equal(renderStaleness(read, cfg), null);
});

test('a sidecar is stale when the delivery file changes at identical settings', async () => {
  const scenePath = await dirFor('meta-output-identity');
  const cfg = cfgOf();
  const out = sceneOutputPath(scenePath, cfg);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, 'the first delivery');
  await writeRenderMeta({ scenePath, config: cfg, frames: 60 });

  await fsp.writeFile(out, 'a different replacement delivery with a different size');
  const meta = readRenderMeta(scenePath, cfg);
  const stale = renderDeliveryStaleness(meta, cfg, out);
  assert.deepEqual(stale.changed, ['outputIdentity']);
  assert.equal(describeStaleness(stale), 'output file identity changed');
  assert.throws(
    () => validateScenes([{ sceneId: 'a/b', path: scenePath, config: cfg }]),
    (err) => err.code === ErrorCodes.STALE_RENDER,
  );
});

test('writeRenderMeta never throws when the sidecar cannot be written', async () => {
  // out/ does not exist: a render that already succeeded must not fail here.
  const scenePath = await dirFor('meta-unwritable');
  const res = await writeRenderMeta({ scenePath, config: cfgOf(), frames: 1 });
  assert.equal(res.frames, 1);
});

test('readRenderMeta returns null for a corrupt sidecar', async () => {
  const scenePath = await dirFor('meta-corrupt');
  const cfg = cfgOf();
  await fsp.mkdir(path.join(scenePath, 'out'), { recursive: true });
  await fsp.writeFile(renderMetaPath(scenePath, cfg), 'not json{');
  assert.equal(readRenderMeta(scenePath, cfg), null);
});

test('validateScenes refuses to build a scene whose settings changed since it rendered', async () => {
  const scenePath = await dirFor('validate-stale');
  const cfg = cfgOf();
  await fsp.mkdir(path.join(scenePath, 'out'), { recursive: true });
  await fsp.writeFile(sceneOutputPath(scenePath, cfg), 'pretend-video');
  await writeRenderMeta({ scenePath, config: cfg, frames: 60 });

  // Same settings: fine.
  assert.doesNotThrow(() => validateScenes([{ sceneId: 'a/b', path: scenePath, config: cfg }]));

  // Duration changed after the render — the exact bug this feature exists for.
  const changed = cfgOf({ durationInFrames: 45 });
  assert.throws(
    () => validateScenes([{ sceneId: 'a/b', path: scenePath, config: changed }]),
    (err) => {
      assert.equal(err.code, ErrorCodes.STALE_RENDER);
      assert.match(err.message, /frames 60 → 45/);
      assert.equal(err.detail.stale[0].sceneId, 'a/b');
      return true;
    },
  );
});

test('validateScenes skips the staleness check when not requiring rendered output', async () => {
  const scenePath = await dirFor('validate-plan');
  const cfg = cfgOf();
  await fsp.mkdir(path.join(scenePath, 'out'), { recursive: true });
  await fsp.writeFile(sceneOutputPath(scenePath, cfg), 'x');
  await writeRenderMeta({ scenePath, config: cfg, frames: 60 });
  assert.doesNotThrow(() => validateScenes(
    [{ sceneId: 'a/b', path: scenePath, config: cfgOf({ durationInFrames: 45 }) }],
    { requireRendered: false },
  ));
});

test('planFilm reports a stale render as a problem, with the scene marked unverified', async () => {
  const store = await makeStore(await dirFor('plan-stale'));
  const { film, scene } = await makeScene(store, { name: 'One', film: 'Stale Film' });
  const config = await store.readConfig(scene.id);

  const outFile = sceneOutputPath(scene.path, config);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, 'pretend-video');
  await writeRenderMeta({ scenePath: scene.path, config, frames: config.durationInFrames });

  // Clean first: rendered and verified.
  let plan = await planFilm({ film: await store.getFilm(film.id), store });
  assert.equal(plan.problems.length, 0, JSON.stringify(plan.problems));
  assert.equal(plan.scenes[0].renderVerified, true);

  // Now change the duration, exactly as update_scene_config would.
  await store.updateConfig(scene.id, { durationInFrames: config.durationInFrames - 17 });
  plan = await planFilm({ film: await store.getFilm(film.id), store });
  const stale = plan.problems.find((p) => p.code === 'stale_render');
  assert.ok(stale, `expected a stale_render problem, got ${JSON.stringify(plan.problems)}`);
  assert.deepEqual(stale.changed, ['frames']);
  assert.equal(plan.scenes[0].rendered, true, 'the file still exists');
  assert.equal(plan.scenes[0].renderVerified, false, 'but it no longer matches the config');
  assert.deepEqual(plan.scenes[0].staleRender.current, { frames: config.durationInFrames - 17 });
});

test('planFilm treats a sidecar-less render as unverified, not stale', async () => {
  const store = await makeStore(await dirFor('plan-nosidecar'));
  const { film, scene } = await makeScene(store, { name: 'One', film: 'Legacy Film' });
  const config = await store.readConfig(scene.id);
  const outFile = sceneOutputPath(scene.path, config);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, 'rendered-by-an-older-build');

  const plan = await planFilm({ film: await store.getFilm(film.id), store });
  assert.equal(plan.problems.length, 0, 'an old render must not become a hard problem');
  assert.equal(plan.scenes[0].rendered, true);
  assert.equal(plan.scenes[0].renderVerified, null, 'unknown, not false');
});

test('a real render stamps the sidecar; proxy and partial renders do not', { skip: !haveFfmpeg }, async () => {
  const dir = await dirFor('render-sidecar');
  await fsp.writeFile(path.join(dir, 'composition.html'), '<html><body></body></html>');
  const config = validateConfig(makeConfig({
    name: 'Sidecar', fps: 30, width: 160, height: 120, durationInFrames: 24,
  }));
  const out = path.join(dir, 'out', 'output.mp4');
  const browserFactory = makeFakeBrowserFactory();
  const meta = () => renderMetaPath(dir, config);

  // A partial range renders only part of the file — claiming it as the
  // scene's canonical output would be a lie.
  const partial = await renderComposition({
    scenePath: dir, config, outputPath: out, frameRange: [0, 9], browserFactory, preflight: false,
  });
  assert.equal(partial.promoted, true, 'a direct partial export is also promoted from staging');
  assert.equal(fs.existsSync(meta()), false, 'a partial render must not stamp the sidecar');

  // A proxy writes to output.proxy.mp4 and is not the deliverable.
  const proxy = await renderComposition({
    scenePath: dir, config, outputPath: out, proxy: { scale: 0.5, frameStep: 2 }, browserFactory, preflight: false,
  });
  assert.equal(proxy.promoted, true, 'a proxy is a caller-visible file and is promoted safely too');
  assert.equal(fs.existsSync(meta()), false, 'a proxy must not stamp the sidecar');

  // The full scene does.
  const full = await renderComposition({ scenePath: dir, config, outputPath: out, browserFactory, preflight: false });
  assert.equal(full.promoted, true);
  assert.ok(fs.existsSync(meta()), 'a full render stamps the sidecar');
  const recorded = readRenderMeta(dir, config);
  assert.equal(recorded.frames, 24);
  assert.equal(recorded.width, 160);
  assert.equal(recorded.fps, 30);
  const picture = await probeMedia({ filePath: out });
  assert.deepEqual(picture.video.color, {
    primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', range: 'tv',
  });
  assert.equal(renderStaleness(recorded, config), null);

  // And that sidecar is what makes a later config change detectable.
  const shortened = validateConfig(makeConfig({
    name: 'Sidecar', fps: 30, width: 160, height: 120, durationInFrames: 12,
  }));
  assert.equal(describeStaleness(renderStaleness(readRenderMeta(dir, shortened), shortened)), 'frames 24 → 12');

  // v0.22: pixFmt and transparent are part of the concat signature, so they are
  // recorded too. Before this they were not, which left a hole — change either
  // after rendering and the contract was broken with nothing reporting it.
  assert.equal(recorded.pixFmt, 'yuv420p');
  assert.equal(recorded.transparent, false);
  assert.deepEqual(
    [recorded.colorPrimaries, recorded.colorTransfer, recorded.colorMatrix, recorded.colorRange],
    ['bt709', 'iec61966-2-1', 'bt709', 'tv'],
  );
  // makeConfig() owns the output block, so the pixel format is changed on the
  // config it produced rather than passed in — the same edit a user makes.
  const repixed = { ...config, output: { ...config.output, pixFmt: 'yuv444p' } };
  assert.equal(describeStaleness(renderStaleness(readRenderMeta(dir, repixed), repixed)), 'pixFmt yuv420p → yuv444p');
  const recolored = { ...recorded, colorMatrix: 'bt601' };
  assert.equal(describeStaleness(renderStaleness(recolored, config)), 'colorMatrix bt601 → bt709');
});

test('a failed identical-settings re-render preserves the promoted delivery and its metadata', { skip: !haveFfmpeg }, async () => {
  const store = await makeStore(await dirFor('staged-retry'));
  const { film, scene } = await makeScene(store, {
    name: 'Staged retry', film: 'Staged Retry Film', fps: 30, width: 160, height: 120, durationInFrames: 12,
  });
  const config = await store.readConfig(scene.id);
  const out = sceneOutputPath(scene.path, config);

  const first = await renderComposition({
    scenePath: scene.path, config, outputPath: out,
    browserFactory: makeFakeBrowserFactory(), preflight: false, jobId: 'first',
  });
  assert.equal(first.promoted, true);
  const before = await fsp.readFile(out);
  const beforeMeta = readRenderMeta(scene.path, config);

  let failedStagingPath;
  await assert.rejects(
    renderComposition({
      scenePath: scene.path, config, outputPath: out,
      browserFactory: makeFakeBrowserFactory({ failAtFrame: 5 }), preflight: false, jobId: 'retry',
    }),
    (err) => {
      assert.equal(err.code, ErrorCodes.COMPOSITION_ERROR);
      assert.match(err.detail.stagingPath, /[\\/]\.staging[\\/]/);
      failedStagingPath = err.detail.stagingPath;
      return true;
    },
  );

  assert.deepEqual(await fsp.readFile(out), before, 'the prior delivery must not be replaced by a partial retry');
  assert.deepEqual(readRenderMeta(scene.path, config).outputIdentity, beforeMeta.outputIdentity, 'the old sidecar remains truthful');
  assert.doesNotThrow(() => validateScenes([{ sceneId: scene.id, path: scene.path, config }]));
  const afterFailure = await planFilm({ film: await store.getFilm(film.id), store });
  assert.equal(afterFailure.problems.length, 0, JSON.stringify(afterFailure.problems));
  assert.equal(afterFailure.scenes[0].renderVerified, true, 'the healthy previous delivery stays verified after a failed retry');
  assert.ok(fs.existsSync(path.dirname(failedStagingPath)), 'the failure identifies a retained staging area for diagnosis');
  assert.notEqual(path.resolve(failedStagingPath), path.resolve(out), 'a failed attempt can never claim the delivery path');

  // This is the complementary Windows-sensitive check: the next successful
  // retry must replace the existing destination by rename, never by deleting it
  // first. The sidecar follows that new delivery and is immediately trustworthy.
  const second = await renderComposition({
    scenePath: scene.path, config, outputPath: out,
    browserFactory: makeFakeBrowserFactory(), preflight: false, jobId: 'retry-success',
  });
  assert.equal(second.promoted, true);
  assert.equal(renderDeliveryStaleness(readRenderMeta(scene.path, config), config, out), null);
});

test('an older sidecar without pixFmt stays unverified rather than turning up stale', () => {
  // The backward-compatibility story for the two fields added in v0.22:
  // renderStaleness only compares what a sidecar actually recorded, so renders
  // from before this release are not retroactively condemned.
  const base = validateConfig(makeConfig({
    name: 'Old', fps: 30, width: 160, height: 120, durationInFrames: 24,
  }));
  const config = { ...base, output: { ...base.output, pixFmt: 'yuv444p' } };
  const preV022 = { frames: 24, width: 160, height: 120, fps: 30, format: 'mp4' };
  assert.equal(renderStaleness(preV022, config), null);
  // …while a v0.22 sidecar recording the old value does catch it.
  assert.deepEqual(renderStaleness({ ...preV022, pixFmt: 'yuv420p' }, config).changed, ['pixFmt']);
});

/* ------------------------------------------------------------------ */
/* Page diagnostics                                                    */
/* ------------------------------------------------------------------ */

test('formatPageDiagnostics is empty when there is nothing to report', () => {
  assert.equal(formatPageDiagnostics({}), '');
  assert.equal(formatPageDiagnostics(), '');
});

test('formatPageDiagnostics names the asset that failed to load', () => {
  const out = formatPageDiagnostics({
    failedRequests: [{ url: 'assets/host-pip.webm', error: 'net::ERR_FILE_NOT_FOUND' }],
  });
  assert.match(out, /1 asset failed to load/);
  assert.match(out, /assets\/host-pip\.webm \(net::ERR_FILE_NOT_FOUND\)/);
});

test('formatPageDiagnostics includes page errors and pluralises', () => {
  const out = formatPageDiagnostics({
    pageErrors: ['console.error: boom'],
    failedRequests: [
      { url: 'a.webm', error: 'net::ERR_FILE_NOT_FOUND' },
      { url: 'b.png', error: 'net::ERR_FILE_NOT_FOUND' },
    ],
  });
  assert.match(out, /2 assets failed to load/);
  assert.match(out, /Page errors:/);
  assert.match(out, /console\.error: boom/);
});

test('formatPageDiagnostics caps a runaway list', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ url: `f${i}.png`, error: 'x' }));
  const out = formatPageDiagnostics({ failedRequests: many });
  assert.match(out, /25 assets failed to load/);
  assert.match(out, /…and 15 more/);
  assert.ok(!out.includes('f20.png'), 'must not print every entry');
});
