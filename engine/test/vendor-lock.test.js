/**
 * v0.13 vendor lockfile: content hashes for the git-ignored library builds, and
 * the build provenance stamped into a project by addLibrary.
 *
 * No network — the "downloads" are local fixture files, which is the point: the
 * lock is about bytes on disk, not about where they came from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sha256, detectVersion, readLock, writeLock, describe as describeBuild,
  verifyOne, verifyVendoredLibraries, vendorLockPath,
} from '../src/core/vendor-lock.js';
import { ProjectStore } from '../src/core/project.js';
import { LIBRARIES } from '../src/core/libraries.js';

async function tmpDir(tag) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `ms-vlock-${tag}-`));
}

/** Point the lock + vendor dir at a sandbox for the duration of one test. */
async function sandbox(tag, fn) {
  const dir = await tmpDir(tag);
  const prevLock = process.env.MOTION_STUDIO_VENDOR_LOCK;
  const prevLibs = process.env.MOTION_STUDIO_LIBS_DIR;
  process.env.MOTION_STUDIO_VENDOR_LOCK = path.join(dir, 'vendor.lock.json');
  process.env.MOTION_STUDIO_LIBS_DIR = path.join(dir, 'libs');
  try {
    return await fn(dir);
  } finally {
    if (prevLock === undefined) delete process.env.MOTION_STUDIO_VENDOR_LOCK;
    else process.env.MOTION_STUDIO_VENDOR_LOCK = prevLock;
    if (prevLibs === undefined) delete process.env.MOTION_STUDIO_LIBS_DIR;
    else process.env.MOTION_STUDIO_LIBS_DIR = prevLibs;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------------------------------- version sniff -- */

test('detectVersion: reads the version a build reports about itself', () => {
  assert.equal(detectVersion(Buffer.from('…thin.Version="9.18.0",x=1…')), '9.18.0');
  assert.equal(detectVersion(Buffer.from('/*! babylonjs@9.18.0 */')), '9.18.0');
  assert.equal(detectVersion(Buffer.from('const REVISION = "134";')), '134');
});

test('detectVersion: returns null rather than guessing', () => {
  // Real case: three.min.js minifies REVISION to `const e="134"`, and 134 also
  // appears in unrelated colour constants. A wrong version is worse than none —
  // the sha256 is the identity, the version is only a courtesy label.
  assert.equal(detectVersion(Buffer.from('const e="134",n=100,indianred:13458524')), null);
  assert.equal(detectVersion(Buffer.from('no version here at all')), null);
});

/* ------------------------------------------------------------- lockfile -- */

test('lock: round-trips, and writes sorted keys for a stable diff', async () => {
  await sandbox('rt', async () => {
    await writeLock({
      'z/last.js': { version: '1.0.0', sha256: 'bb', bytes: 2 },
      'a/first.js': { version: null, sha256: 'aa', bytes: 1 },
    });
    const raw = await fsp.readFile(vendorLockPath(), 'utf8');
    assert.ok(raw.indexOf('a/first.js') < raw.indexOf('z/last.js'), 'keys should be sorted');
    assert.match(raw, /"lockfileVersion": 1/);
    const back = await readLock();
    assert.equal(back['a/first.js'].sha256, 'aa');
    assert.equal(back['z/last.js'].version, '1.0.0');
  });
});

test('lock: a missing lockfile reads as empty, not as an error', async () => {
  await sandbox('absent', async () => {
    assert.deepEqual(await readLock(), {});
  });
});

/* --------------------------------------------------------------- verify -- */

test('verifyOne: ok / mismatch / missing / unlocked', async () => {
  await sandbox('verify', async (dir) => {
    const f = path.join(dir, 'lib.js');
    await fsp.writeFile(f, 'BUILD-A');
    const good = describeBuild(Buffer.from('BUILD-A'), 'http://x/lib.js');
    const lock = { 'lib.js': good };

    assert.equal(verifyOne('lib.js', f, lock).status, 'ok');
    assert.equal(verifyOne('lib.js', path.join(dir, 'nope.js'), lock).status, 'missing');
    assert.equal(verifyOne('lib.js', f, {}).status, 'unlocked');

    // The case this whole feature exists for: same name, different bytes.
    await fsp.writeFile(f, 'BUILD-B');
    const drift = verifyOne('lib.js', f, lock);
    assert.equal(drift.status, 'mismatch');
    assert.equal(drift.expected.sha256, good.sha256);
    assert.notEqual(drift.actual.sha256, good.sha256);
  });
});

test('verifyVendoredLibraries: reports every registry file and flags problems', async () => {
  await sandbox('sweep', async (dir) => {
    const libs = path.join(dir, 'libs');
    const lock = {};
    // Vendor every file the registry expects, with correct hashes...
    for (const spec of Object.values(LIBRARIES)) {
      for (const f of [...spec.files, ...Object.values(spec.addons || {})]) {
        const abs = path.join(libs, f.vendor);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const body = Buffer.from(`stub:${f.vendor}`);
        await fsp.writeFile(abs, body);
        lock[f.vendor] = describeBuild(body, f.url);
      }
    }
    await writeLock(lock);

    const clean = await verifyVendoredLibraries(LIBRARIES, libs);
    assert.equal(clean.ok, true, JSON.stringify(clean.problems));
    assert.equal(clean.locked, true);
    assert.ok(clean.results.length >= 3, 'three + babylon + loaders');

    // ...then corrupt one and confirm it is the one reported.
    const victim = Object.keys(lock)[0];
    await fsp.writeFile(path.join(libs, victim), 'TAMPERED');
    const dirty = await verifyVendoredLibraries(LIBRARIES, libs);
    assert.equal(dirty.ok, false);
    assert.equal(dirty.problems.length, 1);
    assert.equal(dirty.problems[0].file, victim);
    assert.equal(dirty.problems[0].status, 'mismatch');
  });
});

test('verify: an unlocked-but-present file is not reported as a failure', async () => {
  // Adding a library to the registry before locking it is a normal state; it
  // should show as `unlocked`, not block a build.
  await sandbox('unlocked', async (dir) => {
    const libs = path.join(dir, 'libs');
    for (const spec of Object.values(LIBRARIES)) {
      for (const f of [...spec.files, ...Object.values(spec.addons || {})]) {
        const abs = path.join(libs, f.vendor);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, 'stub');
      }
    }
    await writeLock({});
    const r = await verifyVendoredLibraries(LIBRARIES, libs);
    assert.equal(r.problems.length, 0, 'unlocked is not a problem');
    assert.ok(r.results.every((x) => x.status === 'unlocked'));
  });
});

/* ------------------------------------------------- project provenance ---- */

test('addLibrary: stamps the exact build hashes into config.libraryBuilds', async () => {
  await sandbox('stamp', async (dir) => {
    const libs = path.join(dir, 'libs');
    // Minimal fake vendor tree for babylon + its loaders addon.
    const core = Buffer.from('/*! babylonjs@9.18.0 */ var BABYLON={};');
    const addon = Buffer.from('loaders-stub');
    await fsp.mkdir(path.join(libs, 'babylon'), { recursive: true });
    await fsp.writeFile(path.join(libs, 'babylon', 'babylon.js'), core);
    await fsp.writeFile(path.join(libs, 'babylon', 'babylonjs.loaders.min.js'), addon);

    const store = new ProjectStore(path.join(dir, 'home'));
    const proj = await store.createProject({ name: 'Prov', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    const res = await store.addLibrary(proj.id, { library: 'babylon', addons: ['loaders'] });

    const cfg = await store.readConfig(proj.id);
    assert.deepEqual(cfg.libraries, ['babylon']);
    // The provenance: what this project actually holds.
    assert.equal(cfg.libraryBuilds['babylon.js'].sha256, sha256(core));
    assert.equal(cfg.libraryBuilds['babylon.js'].bytes, core.length);
    assert.equal(cfg.libraryBuilds['babylon.js'].version, '9.18.0');
    assert.equal(cfg.libraryBuilds['babylonjs.loaders.min.js'].sha256, sha256(addon));
    // A build with no readable version is recorded as null, not omitted.
    assert.equal(cfg.libraryBuilds['babylonjs.loaders.min.js'].version, null);
    // And the copy report carries the hash too.
    assert.equal(res.copied.find((c) => c.path === 'babylon.js').sha256, sha256(core));

    // The stamp must survive a later, unrelated config update.
    await store.updateConfig(proj.id, { durationInFrames: 60 });
    const after = await store.readConfig(proj.id);
    assert.equal(after.libraryBuilds['babylon.js'].sha256, sha256(core));
  });
});

test('config: libraryBuilds is validated, and rejects a malformed entry', async () => {
  await sandbox('cfgval', async (dir) => {
    const store = new ProjectStore(path.join(dir, 'home'));
    const proj = await store.createProject({ name: 'CfgVal', fps: 30, width: 320, height: 240, durationInFrames: 30 });
    await assert.rejects(
      () => store.updateConfig(proj.id, { libraryBuilds: { 'x.js': { version: '1' } } }),  // no sha256/bytes
      (e) => e.code === 'invalid_config' && /libraryBuilds\.x\.js/.test(e.message),
    );
    await assert.rejects(
      () => store.updateConfig(proj.id, { libraryBuilds: ['nope'] }),
      (e) => e.code === 'invalid_config',
    );
  });
});

/* ----------------------------------------------------- the real lockfile -- */

test('the committed vendor.lock.json is present and internally consistent', async () => {
  // Reads the real repo lock (not a sandbox), so a hand-edit that breaks its
  // shape fails here rather than at someone else's clone.
  const real = path.resolve(import.meta.dirname, '../vendor.lock.json');
  if (!fs.existsSync(real)) return;                     // fresh clone before --update
  const body = JSON.parse(await fsp.readFile(real, 'utf8'));
  assert.equal(body.lockfileVersion, 1);
  const files = Object.entries(body.files);
  assert.ok(files.length >= 3, 'three + babylon core + babylon loaders');
  for (const [key, v] of files) {
    assert.match(v.sha256, /^[0-9a-f]{64}$/, `${key}: sha256 must be a full hex digest`);
    assert.ok(Number.isInteger(v.bytes) && v.bytes > 0, `${key}: bytes`);
    assert.match(v.url, /^https:\/\//, `${key}: url`);
    // Pinned, not floating: a URL without a version can serve anything tomorrow.
    assert.ok(/@\d|\/v\d/.test(v.url), `${key}: url should be version-pinned, got ${v.url}`);
  }
});
