import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveInProject } from '../src/core/sandbox.js';
import { ProjectStore, validateConfig, makeConfig, checkJsSyntax } from '../src/core/project.js';
import { parseProgressLine, ProgressStreamParser, ProgressEmitter } from '../src/core/progress.js';
import { parseFfmpegVersion, parseNodeVersion } from '../src/core/prereqs.js';
import { buildAudioFilter } from '../src/core/encoder.js';
import { ErrorCodes } from '../src/core/errors.js';

let tmp;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-test-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const codeOf = (fn) => {
  try { fn(); assert.fail('expected throw'); }
  catch (e) { return e.code; }
};

/* ------------------------------ sandbox ------------------------------ */

test('sandbox: allows normal relative paths', () => {
  const p = resolveInProject(tmp, 'composition.js', { forWrite: true });
  assert.equal(p, path.join(fs.realpathSync(tmp), 'composition.js'));
});

test('sandbox: rejects traversal, absolute, drive-letter, null-byte paths', () => {
  assert.equal(codeOf(() => resolveInProject(tmp, '../evil.js')), ErrorCodes.PATH_OUTSIDE_PROJECT);
  assert.equal(codeOf(() => resolveInProject(tmp, 'a/../../evil.js')), ErrorCodes.PATH_OUTSIDE_PROJECT);
  assert.equal(codeOf(() => resolveInProject(tmp, '/etc/passwd')), ErrorCodes.PATH_OUTSIDE_PROJECT);
  assert.equal(codeOf(() => resolveInProject(tmp, 'C:\\Windows\\evil.js')), ErrorCodes.PATH_OUTSIDE_PROJECT);
  assert.equal(codeOf(() => resolveInProject(tmp, 'a\0.js')), ErrorCodes.PATH_OUTSIDE_PROJECT);
});

test('sandbox: interior ".." that stays inside is fine', () => {
  const p = resolveInProject(tmp, 'sub/../composition.js');
  assert.equal(path.basename(p), 'composition.js');
});

test('sandbox: write allow-list blocks executables and project.json', () => {
  assert.equal(codeOf(() => resolveInProject(tmp, 'evil.exe', { forWrite: true })), ErrorCodes.PATH_OUTSIDE_PROJECT);
  assert.equal(codeOf(() => resolveInProject(tmp, 'project.json', { forWrite: true })), ErrorCodes.PATH_OUTSIDE_PROJECT);
  // but reading project.json is allowed
  resolveInProject(tmp, 'project.json');
});

test('sandbox: symlink escape via existing symlinked dir is rejected', async (t) => {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-outside-'));
  try {
    try {
      fs.symlinkSync(outside, path.join(tmp, 'link'), 'dir');
    } catch {
      t.skip('symlinks not permitted in this environment');
      return;
    }
    assert.equal(codeOf(() => resolveInProject(tmp, 'link/file.js', { forWrite: true })), ErrorCodes.PATH_OUTSIDE_PROJECT);
  } finally {
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

/* ------------------------------ config ------------------------------- */

test('config: valid default config passes', () => {
  const cfg = makeConfig({ name: 'Demo' });
  assert.equal(cfg.fps, 30);
  assert.equal(cfg.entry, 'composition.html');
});

test('config: odd dimensions rejected (yuv420p)', () => {
  assert.equal(codeOf(() => makeConfig({ name: 'x', width: 1921, height: 1080 })), ErrorCodes.INVALID_CONFIG);
});

test('config: garbage rejected with problem list', () => {
  try {
    validateConfig({ name: '', fps: 0, width: -1, height: 2, durationInFrames: 1.5, entry: 'nope.txt' });
    assert.fail();
  } catch (e) {
    assert.equal(e.code, ErrorCodes.INVALID_CONFIG);
    assert.ok(e.detail.problems.length >= 4);
  }
});

test('config: audio track validation', () => {
  makeConfig({ name: 'x', audio: [{ src: 'assets/a.mp3', startInFrames: 30, gainDb: -6 }] });
  assert.equal(
    codeOf(() => makeConfig({ name: 'x', audio: [{ startInFrames: -1 }] })),
    ErrorCodes.INVALID_CONFIG,
  );
});

/* ------------------------------ store -------------------------------- */

test('store: create → list → get → read/write file round trip', async () => {
  const store = new ProjectStore(path.join(tmp, 'data'));
  const proj = await store.createProject({ name: 'My Intro!', fps: 24, width: 1280, height: 720, durationInFrames: 48 });
  assert.ok(proj.id);
  assert.ok(fs.existsSync(path.join(proj.path, 'composition.html')));
  assert.ok(fs.existsSync(path.join(proj.path, 'frame-api.js')));

  // template placeholders substituted
  const js = await store.readFile(proj.id, 'composition.js');
  assert.match(js, /const FPS = 24;/);
  assert.match(js, /const DURATION = 48;/);

  const list = await store.listProjects();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'My Intro!');

  await store.writeFile(proj.id, 'composition.js', 'MotionStudio.registerComposition(function (f) {});\n');
  assert.match(await store.readFile(proj.id, 'composition.js'), /registerComposition/);
});

test('store: duplicate project path rejected', async () => {
  const store = new ProjectStore(path.join(tmp, 'data'));
  await store.createProject({ name: 'Same' });
  await assert.rejects(() => store.createProject({ name: 'Same' }), (e) => e.code === ErrorCodes.PROJECT_ALREADY_EXISTS);
});

test('store: unknown project id → project_not_found', async () => {
  const store = new ProjectStore(path.join(tmp, 'data'));
  await assert.rejects(() => store.readConfig('nope'), (e) => e.code === ErrorCodes.PROJECT_NOT_FOUND);
});

test('store: write with JS syntax error fails fast, file untouched', async () => {
  const store = new ProjectStore(path.join(tmp, 'data'));
  const proj = await store.createProject({ name: 'SyntaxGuard' });
  const before = await store.readFile(proj.id, 'composition.js');
  await assert.rejects(
    () => store.writeFile(proj.id, 'composition.js', 'function ( { broken'),
    (e) => e.code === ErrorCodes.SYNTAX_ERROR && /Syntax error/.test(e.message),
  );
  assert.equal(await store.readFile(proj.id, 'composition.js'), before, 'original file preserved');
});

test('store: sandbox enforced through writeFile', async () => {
  const store = new ProjectStore(path.join(tmp, 'data'));
  const proj = await store.createProject({ name: 'Sandboxed' });
  await assert.rejects(
    () => store.writeFile(proj.id, '../outside.js', '1'),
    (e) => e.code === ErrorCodes.PATH_OUTSIDE_PROJECT,
  );
});

test('store: updateConfig validates and restricts fields', async () => {
  const store = new ProjectStore(path.join(tmp, 'data'));
  const proj = await store.createProject({ name: 'Cfg' });
  const next = await store.updateConfig(proj.id, { fps: 60, durationInFrames: 300 });
  assert.equal(next.fps, 60);
  await assert.rejects(() => store.updateConfig(proj.id, { entry: 'hack.html' }), (e) => e.code === ErrorCodes.INVALID_CONFIG);
  await assert.rejects(() => store.updateConfig(proj.id, { width: 1921 }), (e) => e.code === ErrorCodes.INVALID_CONFIG);
});

/* --------------------------- syntax check ---------------------------- */

test('checkJsSyntax: valid classic and ESM-ish sources pass', () => {
  checkJsSyntax('const a = 1; function f() { return a; }');
  checkJsSyntax('import x from "y";\nexport const a = 1;');
});

test('checkJsSyntax: reports line info for broken source', () => {
  try {
    checkJsSyntax('const a = 1;\nfunction ( {', 'comp.js');
    assert.fail();
  } catch (e) {
    assert.equal(e.code, ErrorCodes.SYNTAX_ERROR);
    assert.match(e.message, /comp\.js/);
  }
});

/* ---------------------------- progress ------------------------------- */

test('progress: parse valid lines, wrap noise as log', () => {
  assert.deepEqual(parseProgressLine('{"type":"progress","frame":3}'), { type: 'progress', frame: 3 });
  assert.equal(parseProgressLine('   '), null); // blank -> null
  assert.equal(parseProgressLine(''), null);
  const noise = parseProgressLine('Debugger attached.');
  assert.equal(noise.type, 'log');
  assert.equal(noise.message, 'Debugger attached.');
});

test('progress: stream parser handles chunk-split lines', () => {
  const seen = [];
  const p = new ProgressStreamParser((m) => seen.push(m));
  p.feed('{"type":"start","total');
  p.feed('Frames":10}\n{"type":"progress","frame":0}\n{"ty');
  p.feed('pe":"done"}\n');
  assert.deepEqual(seen.map((m) => m.type), ['start', 'progress', 'done']);
  assert.equal(seen[0].totalFrames, 10);
});

test('progress: emitter computes renderFps and taps in-process listener', () => {
  const tapped = [];
  const em = new ProgressEmitter(null, (m) => tapped.push(m));
  em.progress({ frame: 9, totalFrames: 100, framesDone: 10, elapsedMs: 2000 });
  assert.equal(tapped[0].renderFps, 5);
});

/* ----------------------------- prereqs ------------------------------- */

test('prereqs: version parsers handle real-world strings', () => {
  assert.deepEqual(parseNodeVersion('v22.22.2'), [22, 22, 2]);
  assert.deepEqual(parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright'), [6, 1]);
  assert.deepEqual(parseFfmpegVersion('ffmpeg version n7.0-19-g0f1a Copyright'), [7, 0]);
  assert.equal(parseFfmpegVersion('not ffmpeg output'), null);
});

/* --------------------------- audio filter ---------------------------- */

test('encoder: buildAudioFilter single track uses anull, honors delay/gain', () => {
  const f = buildAudioFilter([{ src: 'a.mp3', startInFrames: 30, gainDb: -6 }], 30);
  assert.match(f, /\[1:a\]adelay=1000\|1000,volume=-6dB\[a0\]/);
  assert.match(f, /\[a0\]anull\[aout\]/);
});

test('encoder: buildAudioFilter mixes multiple tracks without normalizing', () => {
  const f = buildAudioFilter([{ src: 'a.mp3' }, { src: 'b.wav', startInFrames: 60 }], 30);
  assert.match(f, /amix=inputs=2:normalize=0\[aout\]/);
  assert.match(f, /\[2:a\]adelay=2000\|2000/);
});
