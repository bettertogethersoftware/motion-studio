/**
 * v0.5 feature tests: output formats (webm / gif / prores / png-sequence),
 * alpha end-to-end, still export, config migration, asset writes, project
 * removal, and ETA in progress. Real FFmpeg is used and outputs are
 * probe-verified; Chromium is replaced by the injectable fake browser.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { renderComposition, renderParallel, renderStill } from '../src/core/renderer.js';
import { buildVideoArgs } from '../src/core/encoder.js';
import { getFormat, normalizeOutputFilename, FORMATS } from '../src/core/formats.js';
import { makeConfig, migrateConfig, validateConfig, ProjectStore, MAX_ASSET_BYTES } from '../src/core/project.js';
import { ErrorCodes } from '../src/core/errors.js';
import { ProgressEmitter } from '../src/core/progress.js';
import { makeFakeBrowserFactory, encodePng } from './helpers/fake-browser.js';

const execFileP = promisify(execFile);
const FAKE_MODULE = path.resolve('test/helpers/fake-browser-module.js');

let tmp;
let haveFfmpeg = true;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-v05-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
});

async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  return JSON.parse(stdout);
}

const cfgFor = (over = {}, outOver = {}) => {
  const cfg = makeConfig({ name: 'V05', fps: 30, width: 320, height: 240, durationInFrames: 24, ...over });
  cfg.output = { ...cfg.output, ...outOver };
  return validateConfig(cfg);
};

/* ------------------------------ formats ------------------------------ */

test('formats: registry rejects unknown format with unsupported_format', () => {
  assert.throws(() => getFormat('avi'), (e) => e.code === ErrorCodes.UNSUPPORTED_FORMAT);
  assert.throws(() => buildVideoArgs({ format: 'nope' }), (e) => e.code === ErrorCodes.UNSUPPORTED_FORMAT);
});

test('formats: normalizeOutputFilename keeps extension in lockstep with format', () => {
  assert.equal(normalizeOutputFilename({ format: 'webm', filename: 'output.mp4' }), 'output.webm');
  assert.equal(normalizeOutputFilename({ format: 'gif', filename: 'clip' }), 'clip.gif');
  assert.equal(normalizeOutputFilename({ format: 'prores', filename: 'master.mp4' }), 'master.mov');
  assert.equal(normalizeOutputFilename({ format: 'png-sequence', filename: 'output.mp4' }), 'output');
});

test('formats: transparent flag only builds alpha args for alpha-capable formats', () => {
  const webm = buildVideoArgs({ format: 'webm', transparent: true });
  assert.ok(webm.includes('yuva420p') && webm.includes('-auto-alt-ref'));
  const prores = buildVideoArgs({ format: 'prores', transparent: true });
  assert.ok(prores.includes('yuva444p10le'));
  const mp4 = buildVideoArgs({ format: 'mp4' });
  assert.ok(mp4.includes('libx264'));
});

test('config: validateConfig rejects transparent mp4 and odd dims for even-dim formats', () => {
  assert.throws(
    () => cfgFor({}, { transparent: true }), // mp4 default
    (e) => e.code === ErrorCodes.INVALID_CONFIG && /alpha/.test(e.message),
  );
  assert.throws(
    () => makeConfig({ name: 'odd', width: 321, height: 240 }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG,
  );
  // gif does not require even dims
  const gifCfg = makeConfig({ name: 'g', width: 320, height: 240 });
  gifCfg.output.format = 'gif';
  gifCfg.width = 321; gifCfg.height = 239;
  assert.equal(validateConfig(gifCfg).width, 321);
});

test('config: v1 → v2 migration adds format and transparent, preserves the rest', () => {
  const v1 = {
    schemaVersion: 1, name: 'Old', fps: 30, width: 640, height: 360, durationInFrames: 90,
    entry: 'composition.html',
    output: { dir: 'out', filename: 'output.mp4', crf: 20, preset: 'fast', pixFmt: 'yuv420p' },
  };
  const v2 = migrateConfig(v1);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.output.format, 'mp4');
  assert.equal(v2.output.transparent, false);
  assert.equal(v2.output.crf, 20);
  validateConfig(v2); // must pass
});

/* --------------------------- real encodes ---------------------------- */

test('render: webm (VP9) output is probe-verified', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'clip.webm');
  const config = cfgFor({}, { format: 'webm', filename: 'clip.webm', crf: 40 });
  await renderComposition({
    projectPath: tmp, config, outputPath: out, browserFactory: makeFakeBrowserFactory(),
  });
  const info = await probe(out);
  assert.equal(info.streams[0].codec_name, 'vp9');
  assert.equal(info.streams[0].width, 320);
});

test('render: transparent webm carries an alpha pixel format end-to-end', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'alpha.webm');
  const config = cfgFor({ durationInFrames: 12 }, { format: 'webm', transparent: true, crf: 40 });
  await renderComposition({
    projectPath: tmp, config, outputPath: out, browserFactory: makeFakeBrowserFactory(),
  });
  const info = await probe(out);
  assert.equal(info.streams[0].codec_name, 'vp9');
  // libvpx tags alpha via yuva420p pix_fmt (ffprobe may report it on the
  // stream, or via the alpha_mode side data / container tag).
  const s = JSON.stringify(info);
  assert.ok(/yuva420p|alpha_mode/.test(s), `expected alpha markers in probe output: ${s.slice(0, 300)}`);
});

test('render: animated GIF output is probe-verified', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'clip.gif');
  const config = cfgFor({ durationInFrames: 12 }, { format: 'gif', filename: 'clip.gif' });
  await renderComposition({
    projectPath: tmp, config, outputPath: out, browserFactory: makeFakeBrowserFactory(),
  });
  const info = await probe(out);
  assert.equal(info.streams[0].codec_name, 'gif');
});

test('render: ProRes .mov output is probe-verified', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'master.mov');
  const config = cfgFor({ durationInFrames: 8 }, { format: 'prores', filename: 'master.mov' });
  await renderComposition({
    projectPath: tmp, config, outputPath: out, browserFactory: makeFakeBrowserFactory(),
  });
  const info = await probe(out);
  assert.equal(info.streams[0].codec_name, 'prores');
});

test('render: png-sequence writes a folder of frames, no encode', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'frames-serial');
  const config = cfgFor({ durationInFrames: 10 }, { format: 'png-sequence', filename: 'frames-serial' });
  const res = await renderComposition({
    projectPath: tmp, config, outputPath: out, browserFactory: makeFakeBrowserFactory(),
  });
  assert.equal(res.frames, 10);
  const files = (await fsp.readdir(out)).sort();
  assert.equal(files.length, 10);
  assert.equal(files[0], 'frame-000000.png');
  assert.equal(files[9], 'frame-000009.png');
});

test('parallel: gif goes through the lossless intermediate and matches frame count', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'par.gif');
  const config = cfgFor({ durationInFrames: 24 }, { format: 'gif', filename: 'par.gif' });
  await fsp.writeFile(path.join(tmp, 'project.json'), JSON.stringify(config)); // workers re-read it
  process.env.MOTION_STUDIO_BROWSER_MODULE = FAKE_MODULE;
  try {
    await renderParallel({
      projectPath: tmp, config, outputPath: out, workers: 3,
    });
  } finally {
    delete process.env.MOTION_STUDIO_BROWSER_MODULE;
  }
  const info = await probe(out);
  assert.equal(info.streams[0].codec_name, 'gif');
  assert.equal(Number(info.streams[0].nb_frames), 24);
});

test('parallel: png-sequence merges worker folders with global numbering', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const out = path.join(tmp, 'frames-par');
  const config = cfgFor({ durationInFrames: 20 }, { format: 'png-sequence', filename: 'frames-par' });
  await fsp.writeFile(path.join(tmp, 'project.json'), JSON.stringify(config)); // workers re-read it
  process.env.MOTION_STUDIO_BROWSER_MODULE = FAKE_MODULE;
  try {
    await renderParallel({ projectPath: tmp, config, outputPath: out, workers: 3 });
  } finally {
    delete process.env.MOTION_STUDIO_BROWSER_MODULE;
  }
  const files = (await fsp.readdir(out)).sort();
  assert.equal(files.length, 20);
  assert.equal(files[0], 'frame-000000.png');
  assert.equal(files[19], 'frame-000019.png');
});

/* ------------------------------- stills ------------------------------ */

test('renderStill: writes one PNG for the requested frame, validates range', async () => {
  const out = path.join(tmp, 'stills', 'f5.png');
  const config = cfgFor({ durationInFrames: 10 });
  const res = await renderStill({
    projectPath: tmp, config, frame: 5, outputPath: out, browserFactory: makeFakeBrowserFactory(),
  });
  assert.equal(res.frame, 5);
  assert.ok(fs.existsSync(out));
  await assert.rejects(
    renderStill({ projectPath: tmp, config, frame: 99, outputPath: out, browserFactory: makeFakeBrowserFactory() }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG,
  );
});

/* ------------------------------- assets ------------------------------ */

test('assets: writeAssetFile confines to assets/, checks extension and size cap', async () => {
  const store = new ProjectStore(await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-assets-')));
  const proj = await store.createProject({ name: 'Asset Test' });
  const png = encodePng(8, 8, () => [200, 40, 40]);

  const res = await store.writeAssetFile(proj.id, 'assets/logo.png', png.toString('base64'));
  assert.equal(res.bytes, png.length);
  const onDisk = await fsp.readFile(path.join(proj.path, 'assets', 'logo.png'));
  assert.ok(onDisk.equals(png), 'asset round-trips byte-exact');

  // outside assets/ → rejected
  await assert.rejects(
    store.writeAssetFile(proj.id, 'logo.png', png.toString('base64')),
    (e) => e.code === ErrorCodes.PATH_OUTSIDE_PROJECT,
  );
  // path escape → rejected
  await assert.rejects(
    store.writeAssetFile(proj.id, 'assets/../../evil.png', png.toString('base64')),
    (e) => e.code === ErrorCodes.PATH_OUTSIDE_PROJECT,
  );
  // disallowed extension → rejected
  await assert.rejects(
    store.writeAssetFile(proj.id, 'assets/tool.exe', png.toString('base64')),
    (e) => e.code === ErrorCodes.PATH_OUTSIDE_PROJECT,
  );
  // over the size cap → asset_too_large
  await assert.rejects(
    store.writeAssetFile(proj.id, 'assets/big.png', png.toString('base64'), { maxBytes: 4 }),
    (e) => e.code === ErrorCodes.ASSET_TOO_LARGE,
  );
  assert.ok(MAX_ASSET_BYTES > 1024 * 1024);
});

/* --------------------------- remove project -------------------------- */

test('removeProject: unregisters; deletes files only inside the managed root', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-rm-'));
  const store = new ProjectStore(dataDir);

  // Managed project: deleteFiles honored.
  const managed = await store.createProject({ name: 'Managed' });
  const res1 = await store.removeProject(managed.id, { deleteFiles: true });
  assert.equal(res1.filesDeleted, true);
  assert.ok(!fs.existsSync(managed.path));

  // External-dir project: unregistered but files stay.
  const extDir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-ext-')), 'proj');
  const external = await store.createProject({ name: 'External', dir: extDir });
  const res2 = await store.removeProject(external.id, { deleteFiles: true });
  assert.equal(res2.filesDeleted, false);
  assert.ok(fs.existsSync(path.join(extDir, 'project.json')));

  assert.equal((await store.listProjects()).length, 0);
  await assert.rejects(store.removeProject('nope'), (e) => e.code === ErrorCodes.PROJECT_NOT_FOUND);
});

/* -------------------------------- ETA -------------------------------- */

test('progress: emits etaMs once enough frames are done', async () => {
  const msgs = [];
  const progress = new ProgressEmitter(null, (m) => msgs.push(m));
  const config = cfgFor({ durationInFrames: 8 });
  await renderComposition({
    projectPath: tmp, config, outputPath: path.join(tmp, 'eta.mp4'),
    browserFactory: makeFakeBrowserFactory({ captureDelayMs: 5 }),
    progress,
  });
  const withEta = msgs.filter((m) => m.type === 'progress' && typeof m.etaMs === 'number');
  assert.ok(withEta.length > 0, 'at least one progress message carries etaMs');
  const last = withEta[withEta.length - 1];
  assert.ok(last.etaMs >= 0);
});
