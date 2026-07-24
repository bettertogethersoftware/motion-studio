/**
 * add_library / ProjectStore.addLibrary — vendoring an optional 3D library and
 * scaffolding its starter. Uses a fake vendor dir (MOTION_STUDIO_LIBS_DIR) so it
 * needs neither the real multi-MB builds nor ffmpeg/Chromium.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/core/project.js';

async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-lib-'));
  return { dir, store: new ProjectStore(path.join(dir, 'home')) };
}
async function fakeThree(dir) {
  const libs = path.join(dir, 'libs', 'three');
  await fsp.mkdir(libs, { recursive: true });
  await fsp.writeFile(path.join(libs, 'three.min.js'), '/* fake */ window.THREE = {};');
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
    const proj = await store.createProject({ name: 'Babylon Addon', fps: 30, width: 640, height: 360, durationInFrames: 60 });
    const res = await store.addLibrary(proj.id, { library: 'babylon', addons: ['loaders'] });
    assert.deepEqual(res.addons, ['loaders']);
    assert.ok(res.copied.some((c) => c.path === 'babylonjs.loaders.min.js'));
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
    const b = await store.createProject({ name: 'Bad Addon', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(b.id, { library: 'babylon', addons: ['nope'] }), (e) => e.code === 'invalid_config');
    const t = await store.createProject({ name: 'Three No Addon', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(t.id, { library: 'three', addons: ['loaders'] }), (e) => e.code === 'invalid_config');
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary vendors the build, scaffolds the starter, records config', async () => {
  const { dir, store } = await tmp();
  await fakeThree(dir);
  try {
    const proj = await store.createProject({ name: 'Lib Test', fps: 30, width: 640, height: 360, durationInFrames: 60 });
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
    const proj = await store.createProject({ name: 'Twice', fps: 30, width: 320, height: 240, durationInFrames: 30 });
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
    const proj = await store.createProject({ name: 'Keep', fps: 30, width: 320, height: 240, durationInFrames: 30 });
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
    const proj = await store.createProject({ name: 'Missing', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(proj.id, { library: 'three' }), (e) => e.code === 'library_unavailable');
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('addLibrary rejects an unknown library', async () => {
  const { dir, store } = await tmp();
  try {
    const proj = await store.createProject({ name: 'Unknown', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(store.addLibrary(proj.id, { library: 'nope' }), (e) => e.code === 'invalid_config');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
