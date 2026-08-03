/**
 * Storage locations through the Studio (v0.22): the report the settings page
 * renders, and the relocation it performs.
 *
 * Its own file rather than a case inside studio.test.js because relocating is a
 * whole-server event — the point of the feature is that the running process
 * starts serving a different tree — and the shared server in that suite would
 * be moved out from under every test after it.
 *
 * The bootstrap file is redirected into a temp dir (MOTION_STUDIO_PATHS_FILE)
 * so running the suite cannot repoint the developer's real library.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStudioServer } from '../src/studio/server.js';
import { JobManager } from '../src/core/jobs.js';
import { updateLocations, invalidatePaths, PATH_ENV, PATHS_FILE_ENV } from '../src/core/paths.js';

let server, base, jobs, home, elsewhere, tmp;
const SAVED = {};

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-storage-'));
  for (const k of [PATHS_FILE_ENV, ...Object.values(PATH_ENV)]) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  process.env[PATHS_FILE_ENV] = path.join(tmp, 'paths.json');
  invalidatePaths();

  home = path.join(tmp, 'store-a');
  elsewhere = path.join(tmp, 'store-b');
  await updateLocations({ dataDir: home });

  jobs = new JobManager();
  // No `store`: the server builds its own from the configured location, which
  // is the arrangement being tested.
  server = createStudioServer({ jobs });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidatePaths();
  await fsp.rm(tmp, { recursive: true, force: true });
});

const j = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : null };
};

test('studio: the settings report describes each storage location', async () => {
  const { status, data } = await j('/api/settings');
  assert.equal(status, 200);
  const { storage } = data.environment;
  assert.deepEqual(Object.keys(storage.locations), ['dataDir', 'workspacesRoot', 'settingsFile', 'vendorDir']);
  assert.equal(storage.locations.dataDir.value, home);
  assert.equal(storage.locations.dataDir.source, 'configured');
  assert.equal(storage.locations.dataDir.editable, true);
  assert.equal(storage.locations.dataDir.env.name, 'MOTION_STUDIO_HOME');
  assert.equal(storage.locations.workspacesRoot.value, path.join(home, 'workspaces'));
  assert.equal(storage.locations.workspacesRoot.source, 'default');
  assert.equal(storage.locationsFile, path.join(tmp, 'paths.json'));

  // The flat trio is what THIS process is serving from, and still reported.
  assert.equal(data.environment.dataDir, home);
  assert.equal(data.environment.settingsPath, path.join(home, 'settings.json'));
});

test('studio: PATCH moves the storage root and the server follows without a restart', async () => {
  // A workspace only the OLD tree has, so "did it actually move" is observable.
  const made = await j('/api/workspaces', { method: 'POST', body: { name: 'only-in-a' } });
  assert.equal(made.status, 201, JSON.stringify(made.data));

  const moved = await j('/api/settings', { method: 'PATCH', body: { paths: { dataDir: elsewhere } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.relocated.moved, true);
  assert.equal(moved.data.relocated.from.dataDir, home);
  assert.equal(moved.data.relocated.to.dataDir, elsewhere);
  // Connected agents resolved their paths when their client spawned them.
  assert.equal(moved.data.relocated.restartAgents, true);
  assert.equal(moved.data.environment.dataDir, elsewhere);

  // The new tree is empty and the old one is untouched — nothing is moved.
  const after = await j('/api/workspaces');
  assert.deepEqual(after.data.workspaces.map((w) => w.id), []);
  assert.ok(fs.existsSync(path.join(home, 'workspaces', 'only-in-a')));

  // ...and going back finds the workspace again.
  const back = await j('/api/settings', { method: 'PATCH', body: { paths: { dataDir: home } } });
  assert.equal(back.status, 200);
  const restored = await j('/api/workspaces');
  assert.ok(restored.data.workspaces.some((w) => w.id === 'only-in-a'));
});

test('studio: a settings patch sent with a move lands in the NEW settings file', async () => {
  const cfg = path.join(tmp, 'config', 'ms.json');
  const res = await j('/api/settings', {
    method: 'PATCH',
    body: { paths: { settingsFile: cfg }, patch: { render: { defaultWorkers: 5 } } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.settings.render.defaultWorkers, 5);
  assert.equal(JSON.parse(await fsp.readFile(cfg, 'utf8')).render.defaultWorkers, 5);
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')));

  await j('/api/settings', { method: 'PATCH', body: { paths: { settingsFile: null } } });
});

test('studio: an invalid location is refused and changes nothing', async () => {
  const bad = await j('/api/settings', { method: 'PATCH', body: { paths: { settingsFile: path.join(tmp, 'nope') } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_config');
  const unknown = await j('/api/settings', { method: 'PATCH', body: { paths: { cacheDir: tmp } } });
  assert.equal(unknown.status, 400);
  assert.equal((await j('/api/settings')).data.environment.dataDir, home);
});

test('studio: a location the environment sets is reported locked, not editable', async () => {
  process.env[PATH_ENV.workspacesRoot] = elsewhere;
  invalidatePaths();
  try {
    const { data } = await j('/api/settings');
    const ws = data.environment.storage.locations.workspacesRoot;
    assert.equal(ws.source, 'env');
    assert.equal(ws.editable, false);
    assert.equal(ws.value, elsewhere);
    assert.equal(ws.env.value, elsewhere);
    // The data dir beside it is untouched: the lock is per key.
    assert.equal(data.environment.storage.locations.dataDir.editable, true);
  } finally {
    delete process.env[PATH_ENV.workspacesRoot];
    invalidatePaths();
  }
});

test('studio: storage cannot move out from under work in flight', async () => {
  let release;
  const started = jobs.startTask({
    kind: 'test-hold',
    targetId: 'x',
    run: () => new Promise((resolve) => { release = resolve; }),
  });

  const busy = await j('/api/settings', { method: 'PATCH', body: { paths: { dataDir: elsewhere } } });
  assert.equal(busy.status, 409);
  assert.equal(busy.data.code, 'storage_busy');
  assert.equal((await j('/api/settings')).data.environment.dataDir, home);

  release();
  await jobs.waitFor([started.jobId], { timeoutMs: 5000 });

  const ok = await j('/api/settings', { method: 'PATCH', body: { paths: { dataDir: home } } });
  assert.equal(ok.status, 200);
});
