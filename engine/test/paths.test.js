/**
 * Storage locations — core/paths.js (v0.22).
 *
 * Every case here redirects the bootstrap file with MOTION_STUDIO_PATHS_FILE
 * into a temp dir. Without that these tests would write the developer's real
 * paths.json, i.e. repoint their whole film library as a side effect of running
 * the suite — which is exactly why that env hook exists.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolvePaths, updateLocations, invalidatePaths, ensureStableDataDir,
  defaultDataDir, workspacesRootFor, settingsFileFor, vendorDir,
  locationsFile, APP_DATA_DIR, APP_VENDOR_DIR, PATH_ENV, PATHS_FILE_ENV,
} from '../src/core/paths.js';
import { resolveMidiExe, resolveSoundFont } from '../src/vendors/default/music/fluidsynth.js';
import { libsVendorDir } from '../src/core/libraries.js';
import { WorkspaceStore } from '../src/core/store.js';
import { readSettings, updateSettings } from '../src/core/settings.js';
import { ErrorCodes } from '../src/core/errors.js';

let tmp;
const SAVED = {};

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-paths-'));
  for (const k of [PATHS_FILE_ENV, ...Object.values(PATH_ENV)]) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  process.env[PATHS_FILE_ENV] = path.join(tmp, 'paths.json');
  invalidatePaths();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidatePaths();
  await fsp.rm(tmp, { recursive: true, force: true });
});

const codeOf = async (fn) => {
  try { await fn(); assert.fail('expected throw'); }
  catch (e) { return e.code; }
};

/* ------------------------------ resolution ------------------------------ */

test('paths: with nothing configured the app data dir is the default', () => {
  const p = resolvePaths();
  assert.equal(p.defaults.dataDir, APP_DATA_DIR);
  // On a machine carrying a pre-v0.22 ~/.motion-studio the resolved value is
  // that one instead — the legacy exception — and it says so.
  assert.ok(['default', 'legacy'].includes(p.sources.dataDir));
  if (p.sources.dataDir === 'default') assert.equal(p.dataDir, APP_DATA_DIR);
});

test('paths: the other two default from whatever the data dir resolved to', async () => {
  const root = path.join(tmp, 'store');
  await updateLocations({ dataDir: root });
  const p = resolvePaths();
  assert.equal(p.dataDir, root);
  assert.equal(p.workspacesRoot, path.join(root, 'workspaces'));
  assert.equal(p.settingsFile, path.join(root, 'settings.json'));
  assert.deepEqual(
    { ws: p.sources.workspacesRoot, sf: p.sources.settingsFile },
    { ws: 'default', sf: 'default' },
  );
});

test('paths: env beats the file, per key, and reports itself as the source', async () => {
  await updateLocations({ dataDir: path.join(tmp, 'from-file') });
  process.env[PATH_ENV.dataDir] = path.join(tmp, 'from-env');
  invalidatePaths();

  const p = resolvePaths();
  assert.equal(p.dataDir, path.join(tmp, 'from-env'));
  assert.equal(p.sources.dataDir, 'env');
  // ...while the file's value is still reported, so the UI can show what it
  // would fall back to once the variable is unset.
  assert.equal(p.stored.dataDir, path.join(tmp, 'from-file'));
  // The untouched keys follow the env-resolved root, not the file's.
  assert.equal(p.workspacesRoot, path.join(tmp, 'from-env', 'workspaces'));
});

test('paths: each location has its own env override', () => {
  process.env[PATH_ENV.dataDir] = path.join(tmp, 'd');
  process.env[PATH_ENV.workspacesRoot] = path.join(tmp, 'ws');
  process.env[PATH_ENV.settingsFile] = path.join(tmp, 'cfg', 'settings.json');
  process.env[PATH_ENV.vendorDir] = path.join(tmp, 'packs');
  invalidatePaths();

  const p = resolvePaths();
  assert.equal(p.workspacesRoot, path.join(tmp, 'ws'));
  assert.equal(p.settingsFile, path.join(tmp, 'cfg', 'settings.json'));
  assert.equal(p.vendorDir, path.join(tmp, 'packs'));
  assert.deepEqual(Object.values(p.sources), ['env', 'env', 'env', 'env']);
});

/* ------------------------------ vendor dir ------------------------------- */

test('paths: the vendor dir defaults to the app vendor tree, not the data dir', async () => {
  // Relocating the DATA dir must not drag the vendor assets with it — they
  // ship with the app.
  await updateLocations({ dataDir: path.join(tmp, 'store') });
  const p = resolvePaths();
  assert.equal(p.vendorDir, APP_VENDOR_DIR);
  assert.equal(p.sources.vendorDir, 'default');
});

test('paths: a configured vendor dir reaches every bundled-asset resolver', async () => {
  const packs = path.join(tmp, 'packs');
  await updateLocations({ vendorDir: packs });
  assert.equal(vendorDir(), packs);
  assert.ok(fs.existsSync(packs), 'an explicitly configured vendor dir is created on save');
  // The resolvers join their relative defaults onto it…
  assert.equal(resolveMidiExe(), path.join(packs, 'music', 'MotionStudioMidi.exe'));
  assert.equal(resolveSoundFont(), path.join(packs, 'soundfonts', 'MuseScore_General.sf3'));
  assert.equal(libsVendorDir(), path.join(packs, 'libs'));
  // …and the per-item env hook still wins over the configured root.
  process.env.MOTION_STUDIO_SOUNDFONT = path.join(tmp, 'own.sf3');
  try {
    assert.equal(resolveSoundFont(), path.join(tmp, 'own.sf3'));
  } finally {
    delete process.env.MOTION_STUDIO_SOUNDFONT;
  }
});

test('paths: a relative stored value is resolved against the bootstrap file', async () => {
  await fsp.writeFile(locationsFile(), JSON.stringify({ dataDir: 'data' }));
  invalidatePaths();
  assert.equal(resolvePaths().dataDir, path.join(tmp, 'data'));
});

test('paths: an app-relative location is STORED relative, so the folder can move', async () => {
  await updateLocations({ dataDir: path.join(tmp, 'data') });
  assert.equal(JSON.parse(await fsp.readFile(locationsFile(), 'utf8')).dataDir, 'data');
});

test('paths: a corrupt bootstrap file falls back to the defaults instead of throwing', async () => {
  await fsp.writeFile(locationsFile(), '{ not json');
  invalidatePaths();
  const p = resolvePaths();
  assert.deepEqual(p.stored, {});
  assert.equal(p.dataDir, defaultDataDir());
});

/* -------------------------------- writing -------------------------------- */

test('paths: saving creates the directories it names', async () => {
  const root = path.join(tmp, 'nested', 'deeper', 'store');
  await updateLocations({ dataDir: root, settingsFile: path.join(tmp, 'cfg', 'ms.json') });
  assert.ok(fs.existsSync(root));
  assert.ok(fs.existsSync(path.join(root, 'workspaces')));
  assert.ok(fs.existsSync(path.join(tmp, 'cfg')));
});

test('paths: null clears a location back to its default', async () => {
  await updateLocations({ dataDir: path.join(tmp, 'a'), workspacesRoot: path.join(tmp, 'ws') });
  assert.equal(resolvePaths().workspacesRoot, path.join(tmp, 'ws'));

  await updateLocations({ workspacesRoot: null });
  const p = resolvePaths();
  assert.equal(p.workspacesRoot, path.join(tmp, 'a', 'workspaces'));
  assert.equal(p.sources.workspacesRoot, 'default');
  // The unmentioned key survives — a patch is a patch, not a replacement.
  assert.equal(p.dataDir, path.join(tmp, 'a'));
});

test('paths: unknown keys are refused rather than silently ignored', async () => {
  assert.equal(await codeOf(() => updateLocations({ cacheDir: tmp })), ErrorCodes.INVALID_CONFIG);
});

test('paths: a settings file that is not .json is refused', async () => {
  assert.equal(
    await codeOf(() => updateLocations({ settingsFile: path.join(tmp, 'settings') })),
    ErrorCodes.INVALID_CONFIG,
  );
});

test('paths: a data dir that already exists as a file is refused', async () => {
  const file = path.join(tmp, 'not-a-dir');
  await fsp.writeFile(file, 'x');
  assert.equal(await codeOf(() => updateLocations({ dataDir: file })), ErrorCodes.INVALID_CONFIG);
});

test('paths: ensureStableDataDir records a legacy dir and nothing else', async () => {
  // Env-decided: there is nothing to remember, and the client owns the answer.
  process.env[PATH_ENV.dataDir] = path.join(tmp, 'env-root');
  invalidatePaths();
  assert.equal(await ensureStableDataDir(), null);
  assert.ok(!fs.existsSync(locationsFile()));
});

/* --------------------- what the rest of the engine sees ------------------- */

test('paths: a configured workspaces root reaches the store', async () => {
  const root = path.join(tmp, 'store');
  const elsewhere = path.join(tmp, 'films-on-another-disk');
  await updateLocations({ dataDir: root, workspacesRoot: elsewhere });

  const store = new WorkspaceStore();
  assert.equal(store.dataDir, root);
  assert.equal(store.workspacesRoot, elsewhere);
  await store.ensureWorkspace('t');
  assert.ok(fs.existsSync(path.join(elsewhere, 't', 'films')));
  assert.ok(!fs.existsSync(path.join(root, 'workspaces', 't')));
});

test('paths: an override applies to the configured data dir only', async () => {
  const root = path.join(tmp, 'store');
  await updateLocations({ dataDir: root, workspacesRoot: path.join(tmp, 'elsewhere') });

  // A caller naming some other directory gets the conventional layout inside
  // it — otherwise a test (or a CLI run over a copy) would silently borrow the
  // machine's real workspaces.
  const other = path.join(tmp, 'other');
  assert.equal(workspacesRootFor(other), path.join(other, 'workspaces'));
  assert.equal(settingsFileFor(other), path.join(other, 'settings.json'));
  assert.equal(new WorkspaceStore(other).workspacesRoot, path.join(other, 'workspaces'));
});

test('paths: settings are read and written at the configured settings file', async () => {
  const root = path.join(tmp, 'store');
  const cfg = path.join(tmp, 'config', 'motion-studio.json');
  await updateLocations({ dataDir: root, settingsFile: cfg });

  await updateSettings({ render: { defaultWorkers: 7 } }, defaultDataDir());
  assert.ok(fs.existsSync(cfg));
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')));
  assert.equal((await readSettings(defaultDataDir())).render.defaultWorkers, 7);
  assert.equal(JSON.parse(await fsp.readFile(cfg, 'utf8')).render.defaultWorkers, 7);
});
