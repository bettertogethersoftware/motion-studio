import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveInTarget } from '../src/core/sandbox.js';
import { validateConfig, makeConfig, checkJsSyntax, checkDeterminism, checkSequenceCoverage, checkCanvasStateBalance, slugify } from '../src/core/scene.js';
import { WorkspaceStore } from '../src/core/store.js';
import { migrateLegacyLayout } from '../src/core/migrate.js';
import { makeStore, makeScene, TEST_WS } from './helpers/workspace.mjs';
import { parseProgressLine, ProgressStreamParser, ProgressEmitter } from '../src/core/progress.js';
import { parseFfmpegVersion, parseNodeVersion } from '../src/core/prereqs.js';
import { buildAudioFilter, LIMITER_FILTER, computeBalanceWarnings } from '../src/core/encoder.js';
import { encodingCompatibilityWarnings } from '../src/core/formats.js';
import { ErrorCodes } from '../src/core/errors.js';
import { DEFAULT_SETTINGS, withNewSceneDefaults, outputSeedFromSettings } from '../src/core/settings.js';

let tmp;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-test-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const codeOf = (fn) => {
  try { fn(); assert.fail('expected throw'); }
  catch (e) { return e.code; }
};

/* ------------------------------ sandbox ------------------------------ */

test('sandbox: allows normal relative paths', () => {
  const p = resolveInTarget(tmp, 'composition.js', { forWrite: true });
  assert.equal(p, path.join(fs.realpathSync(tmp), 'composition.js'));
});

test('sandbox: rejects traversal, absolute, drive-letter, null-byte paths', () => {
  assert.equal(codeOf(() => resolveInTarget(tmp, '../evil.js')), ErrorCodes.PATH_NOT_ALLOWED);
  assert.equal(codeOf(() => resolveInTarget(tmp, 'a/../../evil.js')), ErrorCodes.PATH_NOT_ALLOWED);
  assert.equal(codeOf(() => resolveInTarget(tmp, '/etc/passwd')), ErrorCodes.PATH_NOT_ALLOWED);
  assert.equal(codeOf(() => resolveInTarget(tmp, 'C:\\Windows\\evil.js')), ErrorCodes.PATH_NOT_ALLOWED);
  assert.equal(codeOf(() => resolveInTarget(tmp, 'a\0.js')), ErrorCodes.PATH_NOT_ALLOWED);
});

test('sandbox: interior ".." that stays inside is fine', () => {
  const p = resolveInTarget(tmp, 'sub/../composition.js');
  assert.equal(path.basename(p), 'composition.js');
});

test('sandbox: write allow-list blocks executables and scene.json', () => {
  assert.equal(codeOf(() => resolveInTarget(tmp, 'evil.exe', { forWrite: true })), ErrorCodes.PATH_NOT_ALLOWED);
  assert.equal(codeOf(() => resolveInTarget(tmp, 'scene.json', { forWrite: true })), ErrorCodes.PATH_NOT_ALLOWED);
  // but reading scene.json is allowed
  resolveInTarget(tmp, 'scene.json');
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
    assert.equal(codeOf(() => resolveInTarget(tmp, 'link/file.js', { forWrite: true })), ErrorCodes.PATH_NOT_ALLOWED);
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

test('store: workspace → film → scene round trip with file read/write', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const film = await store.createFilm(TEST_WS, { name: 'My Film', sceneDefaults: { fps: 24, width: 1280, height: 720 } });
  assert.equal(film.id, `${TEST_WS}/my-film`);
  const scene = await store.createScene(film.id, { name: 'My Intro!', durationInFrames: 48 });
  assert.equal(scene.id, `${film.id}/my-intro`); // slugified name
  assert.ok(fs.existsSync(path.join(scene.path, 'composition.html')));
  assert.ok(fs.existsSync(path.join(scene.path, 'frame-api.js')));

  // template placeholders substituted, film sceneDefaults inherited
  const js = await store.readFile(scene.id, 'composition.js');
  assert.match(js, /const FPS = 24;/);
  assert.match(js, /const DURATION = 48;/);

  const films = await store.listFilms(TEST_WS);
  assert.equal(films.length, 1);
  assert.equal(films[0].name, 'My Film');
  const scenes = await store.listScenes(film.id);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].name, 'My Intro!');

  await store.writeFile(scene.id, 'composition.js', 'MotionStudio.registerComposition(function (f) {});\n');
  assert.match(await store.readFile(scene.id, 'composition.js'), /registerComposition/);
});

test('store: duplicate film / scene slugs rejected', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const film = await store.createFilm(TEST_WS, { name: 'Same' });
  await assert.rejects(() => store.createFilm(TEST_WS, { name: 'Same' }), (e) => e.code === ErrorCodes.FILM_ALREADY_EXISTS);
  await store.createScene(film.id, { name: 'Shot' });
  await assert.rejects(() => store.createScene(film.id, { name: 'Shot' }), (e) => e.code === ErrorCodes.SCENE_ALREADY_EXISTS);
});

test('store: unknown ids → scene_not_found / film_not_found / workspace_not_found / invalid_id', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  await assert.rejects(() => store.readConfig(`${TEST_WS}/f/nope`), (e) => e.code === ErrorCodes.SCENE_NOT_FOUND);
  await assert.rejects(() => store.getFilm(`${TEST_WS}/nope`), (e) => e.code === ErrorCodes.FILM_NOT_FOUND);
  await assert.rejects(() => store.getWorkspace('nope'), (e) => e.code === ErrorCodes.WORKSPACE_NOT_FOUND);
  await assert.rejects(() => store.readConfig('not-a-scene-id'), (e) => e.code === ErrorCodes.INVALID_ID);
  await assert.rejects(() => store.getFilm('../../escape'), (e) => e.code === ErrorCodes.INVALID_ID);
});

test('store: write with JS syntax error fails fast, file untouched', async () => {
  const { store, scene } = await makeScene(await makeStore(path.join(tmp, 'data')), { name: 'SyntaxGuard' });
  const before = await store.readFile(scene.id, 'composition.js');
  await assert.rejects(
    () => store.writeFile(scene.id, 'composition.js', 'function ( { broken'),
    (e) => e.code === ErrorCodes.SYNTAX_ERROR && /Syntax error/.test(e.message),
  );
  assert.equal(await store.readFile(scene.id, 'composition.js'), before, 'original file preserved');
});

test('store: sandbox enforced through writeFile', async () => {
  const { store, scene } = await makeScene(await makeStore(path.join(tmp, 'data')), { name: 'Sandboxed' });
  await assert.rejects(
    () => store.writeFile(scene.id, '../outside.js', '1'),
    (e) => e.code === ErrorCodes.PATH_NOT_ALLOWED,
  );
});

test('store: updateConfig validates and restricts fields', async () => {
  const { store, scene } = await makeScene(await makeStore(path.join(tmp, 'data')), { name: 'Cfg' });
  const next = await store.updateConfig(scene.id, { fps: 60, durationInFrames: 300 });
  assert.equal(next.fps, 60);
  await assert.rejects(() => store.updateConfig(scene.id, { entry: 'hack.html' }), (e) => e.code === ErrorCodes.INVALID_CONFIG);
  await assert.rejects(() => store.updateConfig(scene.id, { width: 1921 }), (e) => e.code === ErrorCodes.INVALID_CONFIG);
});

test('store: scene order lives in film.json; removeScene keeps the folder as unlisted', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const film = await store.createFilm(TEST_WS, { name: 'Order' });
  const a = await store.createScene(film.id, { name: 'A' });
  const b = await store.createScene(film.id, { name: 'B' });
  assert.deepEqual((await store.getFilm(film.id)).scenes.map((s) => s.slug), ['a', 'b']);
  await store.updateFilm(film.id, { scenes: [{ slug: 'b' }, { slug: 'a' }] });
  assert.deepEqual((await store.listScenes(film.id)).map((s) => s.slug), ['b', 'a']);

  await store.removeScene(a.id); // keep files
  const scenes = await store.listScenes(film.id);
  assert.deepEqual(scenes.map((s) => `${s.slug}:${!!s.unlisted}`), ['b:false', 'a:true']);
  assert.ok(fs.existsSync(a.path), 'scene folder preserved');

  await store.removeScene(b.id, { deleteFiles: true });
  assert.ok(!fs.existsSync(b.path), 'scene folder deleted');
});

test('store: listScenes skips footage segments instead of describing them as scenes', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const film = await store.createFilm(TEST_WS, { name: 'Mixed' });
  await store.createScene(film.id, { name: 'A' });
  await store.createScene(film.id, { name: 'B' });
  await store.writeAssetFile(film.id, 'assets/clip.mp4', Buffer.from('fake').toString('base64'));
  // The play order holds scenes AND footage; footage has no slug.
  await store.updateFilm(film.id, {
    scenes: [
      { slug: 'a' },
      { footage: 'assets/clip.mp4', durationInFrames: 120, label: 'Clip' },
      { slug: 'b' },
    ],
  });

  const persisted = (await store.getFilm(film.id)).scenes;
  assert.equal(persisted.length, 3, 'the footage segment survives normalization');
  assert.equal(persisted[1].kind, undefined,
    'film.json carries no `kind` tag — only planFilm stamps one, which is why isFootage is the wrong guard here');

  const listed = await store.listScenes(film.id);
  assert.deepEqual(listed.map((s) => s.slug), ['a', 'b'], 'footage does not become a scene row');
  assert.ok(!listed.some((s) => s.id.endsWith('/undefined')), 'no `<film>/undefined` ghost');
  assert.ok(!listed.some((s) => s.name == null), 'every row has a name');
  assert.ok(!listed.some((s) => s.missing), 'and none is falsely flagged missing');
});

test('store: listScenes still reports a scene whose folder vanished', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const film = await store.createFilm(TEST_WS, { name: 'Gone' });
  const a = await store.createScene(film.id, { name: 'A' });
  fs.rmSync(a.path, { recursive: true, force: true });

  // The footage guard must not swallow this: a play-order entry whose folder was
  // deleted out from under the film is information, and stays reported.
  const listed = await store.listScenes(film.id);
  assert.deepEqual(listed.map((s) => `${s.slug}:${!!s.missing}`), ['a:true']);
});

test('store: film-level assets and audio tracks (the old "master project" role)', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const film = await store.createFilm(TEST_WS, { name: 'Master' });
  await store.writeAssetFile(film.id, 'assets/music.wav', Buffer.from('RIFF').toString('base64'));
  const assets = await store.listAssets(film.id);
  assert.deepEqual(assets.map((a) => a.path), ['assets/music.wav']);

  await store.updateFilm(film.id, { audio: [{ src: 'assets/music.wav', gainDb: -8 }] });
  const withRefs = await store.listAssets(film.id);
  assert.equal(withRefs[0].audioRefs, 1);

  const del = await store.deleteAsset(film.id, 'assets/music.wav', { updateAudio: true });
  assert.equal(del.audioTracksRemoved, 1);
  assert.deepEqual((await store.getFilm(film.id)).audio, []);
});

test('store: library upload → list → useLibraryAsset links into a scene', async () => {
  const store = await makeStore(path.join(tmp, 'data'));
  const { scene } = await makeScene(store);
  await store.writeLibraryBuffer(TEST_WS, 'plates/bg.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  const lib = await store.listLibrary(TEST_WS);
  assert.deepEqual(lib.map((f) => f.path), ['plates/bg.png']);

  const used = await store.useLibraryAsset(scene.id, 'plates/bg.png');
  assert.equal(used.path, 'assets/library/plates/bg.png');
  assert.ok(fs.existsSync(path.join(scene.path, 'assets', 'library', 'plates', 'bg.png')));

  await assert.rejects(() => store.useLibraryAsset(scene.id, 'nope.png'), (e) => e.code === ErrorCodes.FILE_NOT_FOUND);
  await assert.rejects(() => store.useLibraryAsset(scene.id, '../../escape.png'), (e) => e.code === ErrorCodes.PATH_NOT_ALLOWED);
});

test('slugify: collapses runs and strips edge dashes', () => {
  assert.equal(slugify('My Film — Master'), 'my-film-master');
  assert.equal(slugify('  A  B  '), 'a-b');
  assert.equal(slugify('!!!'), 'untitled');
});

/* ---------------------------- migration ------------------------------ */

test('migrate: legacy projects.json/films.json becomes workspaces/default', async () => {
  const dataDir = path.join(tmp, 'legacy');
  // Deliberately the OLD filename: this fixture is the pre-v0.20 world, and
  // renaming project.json → scene.json is part of what migration must do.
  const mkProj = async (slug, name) => {
    const p = path.join(dataDir, 'projects', slug);
    await fsp.mkdir(path.join(p, 'assets'), { recursive: true });
    await fsp.mkdir(path.join(p, 'out'), { recursive: true });
    await fsp.writeFile(path.join(p, 'project.json'), JSON.stringify({
      schemaVersion: 2, name, fps: 30, width: 640, height: 360, durationInFrames: 30,
      entry: 'composition.html', output: { dir: 'out', filename: 'output.mp4', format: 'mp4' },
    }));
    return p;
  };
  const p1 = await mkProj('s1', 'Film X - Scene 1');
  const pm = await mkProj('xm', 'Film X - Master');
  await fsp.writeFile(path.join(pm, 'assets', 'music.wav'), 'RIFF');
  const loose = await mkProj('loose', 'Loose');
  await fsp.writeFile(path.join(dataDir, 'projects.json'), JSON.stringify({ projects: [
    { id: 'u1', name: 'Film X - Scene 1', path: p1, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'um', name: 'Film X - Master', path: pm, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'ul', name: 'Loose', path: loose, createdAt: '2026-01-01T00:00:00Z' },
  ] }));
  await fsp.writeFile(path.join(dataDir, 'films.json'), JSON.stringify({ films: [{
    id: 'f1', name: 'Film X', scenes: [{ projectId: 'u1' }], outputProjectId: 'um',
    outputFilename: 'film-x', audio: [{ src: 'assets/music.wav' }], overlays: [], captions: [],
  }] }));

  const report = await migrateLegacyLayout(dataDir);
  assert.equal(report.migrated, true);
  assert.equal(report.filmIdMap.f1, 'default/film-x');

  const store = new WorkspaceStore(dataDir);
  const films = await store.listFilms('default');
  assert.deepEqual(films.map((f) => f.slug).sort(), ['film-x', 'loose']);
  const filmX = await store.getFilm('default/film-x');
  assert.deepEqual(filmX.scenes.map((s) => s.slug), ['film-x-scene-1']);
  assert.deepEqual(filmX.audio.map((t) => t.src), ['assets/music.wav']);
  // The master project's assets folded into the film folder.
  assert.ok(fs.existsSync(path.join(filmX.path, 'assets', 'music.wav')));
  // The config file was renamed with the concept — a moved folder is only a
  // scene once it carries scene.json, and readConfig proves the store agrees.
  const sceneDir = path.join(filmX.path, 'scenes', 'film-x-scene-1');
  assert.ok(fs.existsSync(path.join(sceneDir, 'scene.json')), 'project.json → scene.json');
  assert.ok(!fs.existsSync(path.join(sceneDir, 'project.json')), 'old name gone');
  assert.equal((await store.readConfig('default/film-x/film-x-scene-1')).width, 640);
  // Registries retired; second run is a no-op.
  assert.ok(!fs.existsSync(path.join(dataDir, 'projects.json')));
  assert.deepEqual(await migrateLegacyLayout(dataDir), { migrated: false });
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

/* ------------------------ determinism lint --------------------------- */

test('checkDeterminism: flags wall-clock, timers and unseeded randomness', () => {
  const src = [
    'const t = Date.now();',
    'setInterval(tick, 16);',
    'const r = Math.random();',
    'requestAnimationFrame(draw);',
  ].join('\n');
  const rules = checkDeterminism(src, 'composition.js').map((w) => w.rule);
  assert.deepEqual(rules.sort(), ['date-now', 'math-random', 'request-animation-frame', 'set-interval'].sort());
});

test('checkDeterminism: reports the offending line and snippet', () => {
  const src = 'const a = 1;\nconst b = 2;\nconst t = Date.now();\n';
  const [w] = checkDeterminism(src, 'composition.js');
  assert.equal(w.line, 3);
  assert.equal(w.snippet, 'const t = Date.now();');
  assert.match(w.message, /wall clock/i);
});

test('checkDeterminism: ignores mentions in comments and strings', () => {
  // The lib-three scaffold's own header comment names three banned APIs; if
  // those matched, every scaffolded project would warn on its first write.
  const src = [
    '/* Do NOT use THREE.Clock/getDelta() or requestAnimationFrame. */',
    '// Math.random() is banned; use MotionStudio.random(seed).',
    'const label = "Date.now() is not allowed";',
    'const ok = MotionStudio.random(frame);',
  ].join('\n');
  assert.deepEqual(checkDeterminism(src, 'composition.js'), []);
});

test('checkDeterminism: clean frame-driven composition produces no warnings', () => {
  const src = [
    'MotionStudio.registerComposition((frame) => {',
    '  const o = interpolate(frame, [0, 30], [0, 1]);',
    '  const rng = MotionStudio.random(frame);',
    '  el.style.opacity = String(o * (0.9 + rng() * 0.1));',
    '});',
  ].join('\n');
  assert.deepEqual(checkDeterminism(src, 'composition.js'), []);
});

test('checkDeterminism: classList.add/remove flagged, toggle-with-state exempt (v0.22)', () => {
  // add/remove accumulate DOM state across frames; toggle(name, bool) sets an
  // absolute per-frame state and is the correct pattern.
  const src = [
    'MotionStudio.registerComposition((frame) => {',
    "  intro.classList.add('section');",
    "  old.classList.remove('visible');",
    "  cursor.classList.toggle('cursor', frame % 2 === 0);",
    '});',
  ].join('\n');
  const w = checkDeterminism(src, 'composition.js');
  assert.deepEqual(w.map((x) => x.rule), ['classlist-mutation', 'classlist-mutation']);
  assert.deepEqual(w.map((x) => x.line), [2, 3]);
});

test('checkCanvasStateBalance: unrestored ctx.save() is flagged, balanced helpers are not (v0.22)', () => {
  // The real bug: a drawing helper that translates and never restores, so the
  // title/letterbox/vignette drawn afterwards were silently relocated.
  const src = [
    'function pottery(cx, baseY, s) {',
    '  ctx.save(); ctx.translate(cx, baseY);',
    '  ctx.fill();',
    '}',
    'function samurai(cx, baseY) {',
    '  ctx.save();',
    '  ctx.save(); ctx.rotate(-0.5); ctx.restore();',   // nested pair
    '  ctx.restore();',
    '}',
  ].join('\n');
  const w = checkCanvasStateBalance(src);
  assert.equal(w.length, 1);
  assert.equal(w[0].rule, 'canvas-save-restore');
  assert.equal(w[0].line, 1);
  assert.match(w[0].message, /pottery\(\)/);
});

test('checkCanvasStateBalance: covers arrows and function expressions, not just declarations', () => {
  // Drawing helpers get written in every function form — `.forEach((p) => {
  // ctx.save(); … })` is as common as a named helper — so the rule must not be
  // limited to `function name()`.
  const named = checkCanvasStateBalance('const b = (ctx) => { ctx.save(); ctx.fill(); };');
  assert.equal(named.length, 1);
  assert.match(named[0].message, /^b\(\)/);                       // names the binding
  assert.equal(checkCanvasStateBalance('const c = function () { ctx.save(); };').length, 1);
  assert.equal(checkCanvasStateBalance('xs.forEach((p) => { ctx.save(); });').length, 1);
  assert.equal(checkCanvasStateBalance('xs.forEach(p => { ctx.save(); });').length, 1);
  // A balanced arrow nested in a balanced function is clean.
  assert.deepEqual(
    checkCanvasStateBalance('function e(){ xs.forEach((p) => { ctx.save(); ctx.restore(); }); }'), []);
});

test('checkCanvasStateBalance: reports the innermost offender once, not every enclosing scope', () => {
  // The outer function is balanced on its own; the nested arrow is not. Naive
  // counting would flag both, sending the author to the wrong line.
  const src = 'function f(){ ctx.save(); ctx.restore(); xs.forEach((q) => { ctx.save(); }); }';
  const w = checkCanvasStateBalance(src);
  assert.equal(w.length, 1);
  assert.match(w[0].message, /save\(\) 1× but restore\(\) 0×/);
});

test('checkCanvasStateBalance: ignores save/restore inside comments and strings', () => {
  const src = [
    'function draw() {',
    '  // ctx.save() mentioned in a comment',
    '  const s = "ctx.save()";',
    '  ctx.fill();',
    '}',
  ].join('\n');
  assert.deepEqual(checkCanvasStateBalance(src), []);
});

test('checkSequenceCoverage: names gaps and uncovered tails against the duration (v0.22)', () => {
  // The real failure: nine sequences with a 298-frame hole (2258–2556) and
  // everything else contiguous.
  const src = [
    'Sequence(0, 137, (f) => {});',
    'Sequence(137, 410, (f) => {});',
    'Sequence(547, 1711, (f) => {});',   // ends 2258
    'Sequence(2556, 2284, (f) => {});',  // starts after a 298-frame hole; ends 4840
  ].join('\n');
  const w = checkSequenceCoverage(src, 4840);
  assert.equal(w.length, 1);
  assert.equal(w[0].rule, 'sequence-gap');
  assert.match(w[0].message, /2258–2556/);
  assert.equal(w[0].line, 4);

  // Uncovered tail: coverage stops well before the end.
  const tail = checkSequenceCoverage('Sequence(0, 100, f => {});\nSequence(100, 100, f => {});', 900);
  assert.equal(tail.length, 1);
  assert.match(tail[0].message, /last 700 frames/);
});

test('checkSequenceCoverage: silent for dynamic args, single sequences, and full tiling', () => {
  // Computed starts make coverage unknowable — do not guess.
  assert.deepEqual(checkSequenceCoverage('Sequence(start, DUR, f => {});\nSequence(start + DUR, DUR, f => {});', 600), []);
  // One sequence is usually a partial overlay by design.
  assert.deepEqual(checkSequenceCoverage('Sequence(30, 60, f => {});', 600), []);
  // Contiguous tiling with overlap: no warnings.
  assert.deepEqual(checkSequenceCoverage('Sequence(0, 300, f => {});\nSequence(280, 320, f => {});', 600), []);
});

test('checkSequenceCoverage: does not merge mutually exclusive shared-engine branches', () => {
  const src = [
    'function renderA(frame) {',
    '  Sequence(0, 240, f => {});',
    '  Sequence(96, 144, f => {});',
    '}',
    'function renderB(frame) { drawPlate(frame); }',
    "if (SCENE.mode === 'a') renderA(frame); else renderB(frame);",
  ].join('\n');
  assert.deepEqual(checkSequenceCoverage(src, 320), []);

  // Calls in the same executable body still catch the original large hole.
  const sibling = 'function frame() {\nSequence(0, 100, f => {});\nSequence(398, 100, f => {});\n}';
  assert.equal(checkSequenceCoverage(sibling, 500).length, 1);
});

test('checkDeterminism: CSS real-time transitions flagged, zero/none ignored', () => {
  assert.equal(checkDeterminism('.a { transition: opacity 300ms ease; }', 'styles.css').length, 1);
  assert.equal(checkDeterminism('.a { animation: spin 2s linear infinite; }', 'styles.css').length, 1);
  assert.deepEqual(checkDeterminism('.a { transition: none; }', 'styles.css'), []);
  assert.deepEqual(checkDeterminism('.a { transition: opacity 0s; }', 'styles.css'), []);
});

test('checkDeterminism: CSS url(http://…) is not treated as a comment', () => {
  // blankCss must not honour `//`, or everything after a protocol-relative or
  // absolute URL would be blanked and later declarations silently skipped.
  const src = '.a { background: url(http://x/y.png); }\n.b { transition: left 1s; }';
  const w = checkDeterminism(src, 'styles.css');
  assert.equal(w.length, 1);
  assert.equal(w[0].line, 2);
});

test('checkDeterminism: ignores file types it does not understand', () => {
  assert.deepEqual(checkDeterminism('Date.now()', 'notes.md'), []);
  assert.deepEqual(checkDeterminism('<p>Date.now()</p>', 'composition.html'), []);
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
  const f = buildAudioFilter([{ src: 'a.mp3', startInFrames: 30, gainDb: -6 }], 30, { limiter: false });
  assert.match(f, /\[1:a\]adelay=1000\|1000,volume=-6dB,aformat=sample_rates=44100:channel_layouts=stereo\[a0\]/);
  assert.match(f, /\[a0\]anull\[aout\]/);
});

test('encoder: every track chain pins the mix format (44.1 kHz stereo)', () => {
  // Without a per-track aformat, ffmpeg negotiates a common format across the
  // mix inputs and a 16 kHz mono narration WAV (Piper) drags the whole mix —
  // music bed included — down to 16 kHz.
  const f = buildAudioFilter([{ src: 'a.mp3' }, { src: 'b.wav' }], 30, { limiter: false });
  const hits = f.match(/aformat=sample_rates=44100:channel_layouts=stereo/g) ?? [];
  assert.equal(hits.length, 2);
});

test('encoder: buildAudioFilter mixes multiple tracks without normalizing', () => {
  const f = buildAudioFilter([{ src: 'a.mp3' }, { src: 'b.wav', startInFrames: 60 }], 30, { limiter: false });
  assert.match(f, /amix=inputs=2:normalize=0\[aout\]/);
  assert.match(f, /\[2:a\]adelay=2000\|2000/);
});

test('encoder: buildAudioFilter appends the limiter by default (amix does not normalize)', () => {
  const f = buildAudioFilter([{ src: 'a.mp3' }, { src: 'b.wav' }], 30);
  // The mix lands on [amix] and the limiter produces the [aout] the muxer wants.
  assert.match(f, /amix=inputs=2:normalize=0\[amix\]/);
  assert.match(f, new RegExp(`\\[amix\\]${LIMITER_FILTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[aout\\]`));
  assert.ok(f.endsWith('[aout]'));
});

test('encoder: limiter disables alimiter auto-levelling', () => {
  // level defaults to true in ffmpeg and would BOOST quiet mixes; we only want
  // peaks caught, so the filter must pin level=0.
  assert.match(LIMITER_FILTER, /level=0/);
  assert.match(LIMITER_FILTER, /limit=0\.841/);
});

test('encoder: limiter ceiling leaves headroom for lossy intersample peaks', () => {
  // -1 dBFS did not survive the AAC mux: a measured 21-track mix previewed at
  // -1.0 dBFS in the WAV and encoded to 0.0 dBFS, so every limited film could
  // report audio_clipping. The ceiling must stay far enough below full scale
  // to absorb ~1 dB of encoder overshoot.
  const limit = Number(/limit=([\d.]+)/.exec(LIMITER_FILTER)[1]);
  const ceilingDb = 20 * Math.log10(limit);
  assert.ok(ceilingDb <= -1.4, `limiter ceiling ${ceilingDb.toFixed(2)} dBFS leaves no codec headroom`);
  assert.ok(ceilingDb >= -3, `limiter ceiling ${ceilingDb.toFixed(2)} dBFS throws away too much loudness`);
});

test('encoder: single track still gets the limiter, ending in [aout]', () => {
  const f = buildAudioFilter([{ src: 'a.mp3' }], 30);
  assert.match(f, /\[a0\]anull\[amix\]/);
  assert.ok(f.endsWith('[aout]'));
});

/* ---------------------- encoding warnings (v0.22) ---------------------- */

test('formats: mp4 crf 0 warns — lossless lands in Hi444PP, unplayable on most decoders', () => {
  const w = encodingCompatibilityWarnings({ format: 'mp4', crf: 0 });
  assert.equal(w.length, 1);
  assert.match(w[0], /High 4:4:4 Predictive/);
  assert.match(w[0], /crf 18/);
});

test('formats: normal mp4 crf values do not warn', () => {
  assert.deepEqual(encodingCompatibilityWarnings({ format: 'mp4', crf: 18 }), []);
  assert.deepEqual(encodingCompatibilityWarnings({ format: 'mp4' }), []); // default crf
});

test('formats: crf 0 on non-mp4 formats does not warn', () => {
  // VP9's crf 0 is just "best lossy" — lossless is a separate flag it never sets.
  assert.deepEqual(encodingCompatibilityWarnings({ format: 'webm', crf: 0 }), []);
  assert.deepEqual(encodingCompatibilityWarnings({ format: 'prores', crf: 0 }), []);
  assert.deepEqual(encodingCompatibilityWarnings({ format: 'png-sequence', crf: 0 }), []);
});

test('formats: missing format defaults to mp4 for the crf 0 check', () => {
  assert.equal(encodingCompatibilityWarnings({ crf: 0 }).length, 1);
});

/* ---------------------- balance warnings (v0.22) ---------------------- */

const BAL_OPTS = { fps: 30, videoDurationSec: 60 };

test('encoder: computeBalanceWarnings flags tracks buried under a louder concurrent track', () => {
  // The real case that motivated this: template gains (-2/-6/-10) applied to
  // files whose own levels already differ, burying two of three layers.
  const w = computeBalanceWarnings([
    { src: 'music-1.wav', gainDb: -2, clipMeanDb: -25.6 },
    { src: 'music-2.wav', gainDb: -6, clipMeanDb: -30.9 },
    { src: 'music-3.wav', gainDb: -10, clipMeanDb: -36.5 },
  ], BAL_OPTS);
  assert.equal(w.length, 2);
  assert.match(w[0], /music-2\.wav/);
  assert.match(w[0], /music-1\.wav/);
  assert.match(w[1], /music-3\.wav/);
});

test('encoder: computeBalanceWarnings passes a level-matched mix', () => {
  // Same files, gains compensating each file's measured level: all ≈ -27.6.
  const w = computeBalanceWarnings([
    { src: 'music-1.wav', gainDb: -2, clipMeanDb: -25.6 },
    { src: 'music-2.wav', gainDb: 3, clipMeanDb: -30.9 },
    { src: 'music-3.wav', gainDb: 9, clipMeanDb: -36.5 },
  ], BAL_OPTS);
  assert.deepEqual(w, []);
});

test('encoder: duck:true declares background — the quiet side never warns', () => {
  const w = computeBalanceWarnings([
    { src: 'narration.wav', gainDb: 0, clipMeanDb: -20 },
    { src: 'bed.wav', gainDb: -14, clipMeanDb: -20, duck: true },
  ], BAL_OPTS);
  assert.deepEqual(w, []);
});

test('encoder: a quiet non-duck track still warns even when the loud track ducks', () => {
  // Narration buried under a hot bed is a real problem regardless of ducking.
  const w = computeBalanceWarnings([
    { src: 'narration.wav', gainDb: 0, clipMeanDb: -34 },
    { src: 'bed.wav', gainDb: 0, clipMeanDb: -20, duck: true },
  ], BAL_OPTS);
  assert.equal(w.length, 1);
  assert.match(w[0], /narration\.wav/);
});

test('encoder: sequential clips do not warn — overlap must cover half the window', () => {
  // Big level gap but the clips never play together (bounded by duration/trim).
  const w = computeBalanceWarnings([
    { src: 'loud.wav', gainDb: 0, clipMeanDb: -18, startInFrames: 0, clipDurationSec: 20 },
    { src: 'quiet.wav', gainDb: 0, clipMeanDb: -40, startInFrames: 900, trimEndInFrames: 600 },
  ], BAL_OPTS);
  assert.deepEqual(w, []);
});

test('encoder: unmeasurable clips are skipped, not warned about', () => {
  const w = computeBalanceWarnings([
    { src: 'a.mp3', gainDb: 0, clipMeanDb: null },
    { src: 'b.wav', gainDb: 0, clipMeanDb: -20 },
  ], BAL_OPTS);
  assert.deepEqual(w, []);
});

/* ---------------------- audio trim / fades / duck (v0.19) ---------------------- */

test('encoder: trimEndInFrames caps the clip before placement', () => {
  const f = buildAudioFilter([{ src: 'a.wav', trimEndInFrames: 90, startInFrames: 30 }], 30, { limiter: false });
  // source-relative: trim first, THEN adelay
  assert.match(f, /\[1:a\]atrim=0\.000:3\.000,asetpts=PTS-STARTPTS,adelay=1000\|1000,volume=0dB,aformat=/);
});

test('encoder: trimStartInFrames drops the head and resets the clip to zero', () => {
  // The head trim is the one the timeline could not offer. atrim alone would
  // keep the source timestamps, so the clip would arrive `trimStart` late on
  // top of its adelay — asetpts is what makes the placement mean what it says.
  const f = buildAudioFilter([{ src: 'a.wav', trimStartInFrames: 60, startInFrames: 30 }], 30, { limiter: false });
  assert.match(f, /\[1:a\]atrim=2\.000,asetpts=PTS-STARTPTS,adelay=1000\|1000/);
});

test('encoder: both trims name points in the source, and the fade-out follows the kept window', () => {
  const f = buildAudioFilter(
    [{ src: 'a.wav', trimStartInFrames: 60, trimEndInFrames: 150, fadeOutFrames: 15 }], 30, { limiter: false });
  assert.match(f, /atrim=2\.000:5\.000/);
  // Kept window is 3s long, so a half-second fade-out starts at 2.5s — NOT at
  // 4.5s, which is where the source-relative end would have put it.
  assert.match(f, /afade=t=out:st=2\.500:d=0\.500/);
});

test('encoder: an untrimmed track keeps its chain free of atrim entirely', () => {
  const f = buildAudioFilter([{ src: 'a.wav', startInFrames: 30 }], 30, { limiter: false });
  assert.ok(!f.includes('atrim'), f);
  assert.ok(!f.includes('asetpts'), f);
});

test('encoder: fadeInFrames fades up from the clip start', () => {
  const f = buildAudioFilter([{ src: 'a.wav', fadeInFrames: 15 }], 30, { limiter: false });
  assert.match(f, /afade=t=in:st=0:d=0\.500/);
});

test('encoder: fadeOutFrames ends at trimEndInFrames when set', () => {
  const f = buildAudioFilter([{ src: 'a.wav', trimEndInFrames: 90, fadeOutFrames: 30 }], 30, { limiter: false });
  // 90f = 3s trim, 30f = 1s fade → fade starts at 2s
  assert.match(f, /afade=t=out:st=2\.000:d=1\.000/);
});

test('encoder: fadeOutFrames falls back to the composition end minus the track start', () => {
  const f = buildAudioFilter([{ src: 'a.wav', startInFrames: 30, fadeOutFrames: 30 }], 30,
    { limiter: false, videoDurationSec: 5 });
  // clip plays from 1s → composition ends at clip-time 4s; 1s fade starts at 3s
  assert.match(f, /afade=t=out:st=3\.000:d=1\.000/);
});

test('encoder: fadeOutFrames with no bound available is skipped, not garbage', () => {
  const f = buildAudioFilter([{ src: 'a.wav', fadeOutFrames: 30 }], 30, { limiter: false });
  assert.doesNotMatch(f, /afade=t=out/);
});

test('encoder: duck:true splits the graph into fg/bed and sidechains the bed', () => {
  const f = buildAudioFilter(
    [{ src: 'voice.wav' }, { src: 'music.wav', duck: true }], 30, { limiter: false });
  assert.match(f, /\[a0\]anull\[fgraw\]/);
  assert.match(f, /\[a1\]anull\[bed0\]/);
  assert.match(f, /\[fgraw\]asplit=2\[fgmix\]\[sc0\]/);
  assert.match(f, /\[bed\]\[sc\]sidechaincompress=/);
  assert.match(f, /\[fgmix\]\[bedduck\]amix=inputs=2:normalize=0\[aout\]/);
});

test('encoder: ducking pads bed AND sidechain to the composition length', () => {
  // sidechaincompress is asymmetric about EOF: sidechain-first EOF silences
  // the bed for the rest of the mix; bed-first EOF stalls the graph forever.
  // Padding both branches to the same bound makes them EOF together.
  const f = buildAudioFilter(
    [{ src: 'voice.wav' }, { src: 'music.wav', duck: true }], 30,
    { limiter: false, videoDurationSec: 15 });
  assert.match(f, /\[bed0\]apad=whole_dur=15\.000\[bed\]/);
  assert.match(f, /\[sc0\]apad=whole_dur=15\.000\[sc\]/);
});

test('encoder: ducking without a composition length skips the pads', () => {
  const f = buildAudioFilter(
    [{ src: 'voice.wav' }, { src: 'music.wav', duck: true }], 30, { limiter: false });
  assert.doesNotMatch(f, /apad/);
  assert.match(f, /\[bed0\]anull\[bed\]/);
  assert.match(f, /\[sc0\]anull\[sc\]/);
});

test('encoder: ducking needs both sides — all-ducked or none-ducked mixes normally', () => {
  const all = buildAudioFilter([{ src: 'a.wav', duck: true }, { src: 'b.wav', duck: true }], 30, { limiter: false });
  assert.doesNotMatch(all, /sidechaincompress/);
  assert.match(all, /amix=inputs=2:normalize=0\[aout\]/);
  const none = buildAudioFilter([{ src: 'a.wav' }, { src: 'b.wav' }], 30, { limiter: false });
  assert.doesNotMatch(none, /sidechaincompress/);
});

test('encoder: ducking still ends in the limiter by default', () => {
  const f = buildAudioFilter([{ src: 'voice.wav' }, { src: 'music.wav', duck: true }], 30);
  assert.match(f, /\[fgmix\]\[bedduck\]amix=inputs=2:normalize=0\[amix\]/);
  assert.ok(f.endsWith('[aout]'));
});

/* ------------------------- global settings defaults ------------------------- */
// These two helpers are the whole reason "Global Settings" is global: the Studio
// and the MCP server both route project creation through them, so neither can
// grow its own idea of what a default is.

const settingsWith = (patch) => ({
  ...DEFAULT_SETTINGS,
  newSceneDefaults: { ...DEFAULT_SETTINGS.newSceneDefaults, ...(patch.newSceneDefaults ?? {}) },
  ffmpeg: { ...DEFAULT_SETTINGS.ffmpeg, ...(patch.ffmpeg ?? {}) },
});

test('settings: new-project defaults fill only the fields a caller left unset', () => {
  const s = settingsWith({ newSceneDefaults: { fps: 24, width: 1280, height: 720, durationInFrames: 48 } });
  const merged = withNewSceneDefaults(s, { name: 'x', width: 3840 });
  assert.equal(merged.width, 3840); // explicit wins
  assert.equal(merged.fps, 24);     // global fills the gap
  assert.equal(merged.height, 720);
  assert.equal(merged.durationInFrames, 48);
  assert.equal(merged.name, 'x');
});

test('settings: an explicit undefined does not clobber a global default', () => {
  // MCP hands unset optional fields through as undefined; a naive spread would
  // overwrite the default with undefined and silently fall back to 30fps.
  const s = settingsWith({ newSceneDefaults: { fps: 24 } });
  const merged = withNewSceneDefaults(s, { name: 'x', fps: undefined, height: undefined });
  assert.equal(merged.fps, 24);
  assert.equal(merged.height, DEFAULT_SETTINGS.newSceneDefaults.height);
});

test('settings: an explicit value equal to the factory default still wins', () => {
  // Guards the "did the caller mean it?" distinction that .default() destroyed.
  const s = settingsWith({ newSceneDefaults: { fps: 24 } });
  assert.equal(withNewSceneDefaults(s, { name: 'x', fps: 30 }).fps, 30);
});

test('settings: output seed is null unless an encode default is set', () => {
  assert.equal(outputSeedFromSettings(settingsWith({}), { format: 'mp4' }), null);
});

test('settings: output seed patches crf/preset over the scaffolded output', () => {
  const s = settingsWith({ ffmpeg: { defaultCrf: 18, defaultPreset: 'slow' } });
  const seed = outputSeedFromSettings(s, { format: 'webm', filename: 'out.webm', crf: 32 });
  assert.deepEqual(seed, { format: 'webm', filename: 'out.webm', crf: 18, preset: 'slow' });
});

test('settings: a partially set encode default leaves the other field alone', () => {
  const s = settingsWith({ ffmpeg: { defaultCrf: 18 } });
  const seed = outputSeedFromSettings(s, { format: 'mp4' });
  assert.deepEqual(seed, { format: 'mp4', crf: 18 });
  assert.ok(!('preset' in seed));
});
