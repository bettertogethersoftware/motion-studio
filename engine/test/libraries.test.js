/**
 * add_library / WorkspaceStore.addLibrary — vendoring an optional 3D library and
 * scaffolding its starter. Uses a fake vendor dir (MOTION_STUDIO_LIBS_DIR) so it
 * needs neither the real multi-MB builds nor ffmpeg/Chromium.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeStore, makeScene } from './helpers/workspace.mjs';

async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-lib-'));
  return { dir, store: await makeStore(path.join(dir, 'home')) };
}
async function fakeThree(dir) {
  const libs = path.join(dir, 'libs', 'three');
  await fsp.mkdir(path.join(libs, 'examples'), { recursive: true });
  await fsp.writeFile(path.join(libs, 'three.min.js'), '/* fake */ window.THREE = {};');
  // The v0.19 addons (geometries / loaders / postprocessing), so addon tests
  // need neither the real builds nor the network.
  for (const f of [
    'TeapotGeometry.js', 'GLTFLoader.js', 'CopyShader.js', 'LuminosityHighPassShader.js',
    'Pass.js', 'ShaderPass.js', 'MaskPass.js', 'EffectComposer.js', 'RenderPass.js', 'UnrealBloomPass.js',
  ]) {
    await fsp.writeFile(path.join(libs, 'examples', f), `/* fake ${f} */`);
  }
  process.env.MOTION_STUDIO_LIBS_DIR = path.join(dir, 'libs');
}
async function fakeBabylon(dir) {
  const libs = path.join(dir, 'libs', 'babylon');
  await fsp.mkdir(libs, { recursive: true });
  await fsp.writeFile(path.join(libs, 'babylon.js'), '/* fake */ window.BABYLON = {};');
  await fsp.writeFile(path.join(libs, 'babylonjs.loaders.min.js'), '/* fake loaders */');
  process.env.MOTION_STUDIO_LIBS_DIR = path.join(dir, 'libs');
}

test('addLibrary babylon with the loaders addon vendors it and injects the script', async () => {
  const { dir, store } = await tmp();
  await fakeBabylon(dir);
  try {
    const { scene: proj } = await makeScene(store, { name: 'Babylon Addon', fps: 30, width: 640, height: 360, durationInFrames: 60 });
    const res = await store.addLibrary(proj.id, { library: 'babylon', addons: ['loaders'] });
    assert.deepEqual(res.addons, ['loaders']);
    assert.ok(res.copied.some((c) => c.path === 'babylonjs.loaders.min.js'));
    // The addon's own note must reach the caller. It documents that loading a
    // model needs MOTION_STUDIO_ALLOW_LOCAL_FETCH=1 — the single most common way
    // a glTF render fails — and it used to be dropped from the return value.
    assert.ok(res.notes.some((n) => /MOTION_STUDIO_ALLOW_LOCAL_FETCH/.test(n)),
      `addon note missing from notes: ${JSON.stringify(res.notes)}`);
    assert.ok(res.notes.some((n) => /^\[loaders\]/.test(n)), 'addon notes should be attributed');
    assert.ok(fs.existsSync(path.join(proj.path, 'babylonjs.loaders.min.js')));
    const html = await fsp.readFile(path.join(proj.path, 'composition.html'), 'utf8');
    assert.match(html, /src="babylonjs\.loaders\.min\.js"/); // injected
    assert.doesNotMatch(html, /__ADDONS__/);                 // placeholder consumed
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary rejects an unknown / unsupported addon', async () => {
  const { dir, store } = await tmp();
  await fakeBabylon(dir);
  await fakeThree(dir); // also populate three so its build exists
  try {
    const { scene: b } = await makeScene(store, { name: 'Bad Addon', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(b.id, { library: 'babylon', addons: ['nope'] }), (e) => e.code === 'invalid_config');
    const { scene: t } = await makeScene(store, { name: 'Three Bad Addon', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(t.id, { library: 'three', addons: ['nope'] }), (e) => e.code === 'invalid_config');
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary three with a multi-file addon vendors every file in order (v0.19)', async () => {
  const { dir, store } = await tmp();
  await fakeThree(dir);
  try {
    const { scene: proj } = await makeScene(store, { name: 'Three PP', fps: 30, width: 640, height: 360, durationInFrames: 60 });
    const res = await store.addLibrary(proj.id, { library: 'three', addons: ['postprocessing', 'geometries'] });
    assert.deepEqual(res.addons, ['postprocessing', 'geometries']);
    // every file of the multi-file addon lands in the project…
    for (const f of ['three.EffectComposer.js', 'three.UnrealBloomPass.js', 'three.CopyShader.js', 'three.TeapotGeometry.js']) {
      assert.ok(fs.existsSync(path.join(proj.path, f)), `missing ${f}`);
      assert.ok(res.copied.some((c) => c.path === f), `not reported copied: ${f}`);
    }
    // …and the script tags preserve declared load order (shaders before passes).
    const html = await fsp.readFile(path.join(proj.path, 'composition.html'), 'utf8');
    const idx = (s) => html.indexOf(`src="${s}"`);
    assert.ok(idx('three.CopyShader.js') >= 0 && idx('three.CopyShader.js') < idx('three.EffectComposer.js'),
      'CopyShader must load before EffectComposer');
    assert.ok(idx('three.EffectComposer.js') < idx('three.UnrealBloomPass.js'),
      'EffectComposer must load before UnrealBloomPass');
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary vendors the build, scaffolds the starter, records config', async () => {
  const { dir, store } = await tmp();
  await fakeThree(dir);
  try {
    const { scene: proj } = await makeScene(store, { name: 'Lib Test', fps: 30, width: 640, height: 360, durationInFrames: 60 });
    const res = await store.addLibrary(proj.id, { library: 'three' });

    assert.equal(res.library, 'three');
    assert.equal(res.global, 'THREE');
    assert.ok(res.copied.some((c) => c.path === 'three.min.js'));
    assert.ok(res.scaffolded.includes('composition.js'));
    assert.ok(res.notes.length > 0);

    assert.ok(fs.existsSync(path.join(proj.path, 'three.min.js')));
    const html = await fsp.readFile(path.join(proj.path, 'composition.html'), 'utf8');
    assert.match(html, /src="three\.min\.js"/);
    assert.match(html, /src="frame-api\.js"/);
    const js = await fsp.readFile(path.join(proj.path, 'composition.js'), 'utf8');
    assert.match(js, /THREE\.WebGLRenderer/);
    assert.match(js, /preserveDrawingBuffer/);
    assert.match(js, /const W = 640/); // placeholder substituted

    const cfg = await store.readConfig(proj.id);
    assert.deepEqual(cfg.libraries, ['three']);
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary is idempotent in config.libraries', async () => {
  const { dir, store } = await tmp();
  await fakeThree(dir);
  try {
    const { scene: proj } = await makeScene(store, { name: 'Twice', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await store.addLibrary(proj.id, { library: 'three' });
    await store.addLibrary(proj.id, { library: 'three' });
    const cfg = await store.readConfig(proj.id);
    assert.deepEqual(cfg.libraries, ['three']);
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary scaffold:false vendors the build but keeps the composition', async () => {
  const { dir, store } = await tmp();
  await fakeThree(dir);
  try {
    const { scene: proj } = await makeScene(store, { name: 'Keep', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    const before = await fsp.readFile(path.join(proj.path, 'composition.js'), 'utf8');
    const res = await store.addLibrary(proj.id, { library: 'three', scaffold: false });
    assert.equal(res.scaffolded.length, 0);
    const after = await fsp.readFile(path.join(proj.path, 'composition.js'), 'utf8');
    assert.equal(before, after);
    assert.ok(fs.existsSync(path.join(proj.path, 'three.min.js')));
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary without the vendored build → library_unavailable', async () => {
  const { dir, store } = await tmp();
  process.env.MOTION_STUDIO_LIBS_DIR = path.join(dir, 'empty');
  try {
    const { scene: proj } = await makeScene(store, { name: 'Missing', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(proj.id, { library: 'three' }), (e) => e.code === 'library_unavailable');
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary rejects an unknown library', async () => {
  const { dir, store } = await tmp();
  try {
    const { scene: proj } = await makeScene(store, { name: 'Unknown', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(proj.id, { library: 'nope' }), (e) => e.code === 'invalid_config');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
