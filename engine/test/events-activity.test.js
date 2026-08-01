/**
 * Production events + agent activity (v0.23).
 *
 * The event bus and change classifier are pure and tested directly. The
 * filesystem watcher test is the honest cross-process story: it writes real
 * advice through the core API and expects the watcher (the Studio's view) to
 * notice — the same path an MCP server's writes take. Skipped only where
 * recursive fs.watch is unsupported.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProductionEvents, classifyChange, startWorkspaceWatcher, sseFrame } from '../src/core/events.js';
import { reportActivity, listActivity, productionStatus } from '../src/core/activity.js';
import { createAdvice } from '../src/core/advice.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';

test('events: emit, subscribe, replay, and gap detection', () => {
  const bus = new ProductionEvents({ bufferSize: 3 });
  const seen = [];
  const unsub = bus.subscribe((e) => seen.push(e));

  const first = bus.emit('film', { filmId: 't/f' });
  bus.emit('advice', { filmId: 't/f', adviceId: 'adv-1' });
  assert.equal(seen.length, 2);
  assert.equal(first.id, 1);
  assert.ok(seen[1].id > seen[0].id, 'ids are monotonic');

  // Replay from a known id.
  assert.deepEqual(bus.since(first.id).map((e) => e.type), ['advice']);
  assert.deepEqual(bus.since(seen[1].id), []);

  // Overflow the buffer → a too-old id reports a gap (null), not silence.
  bus.emit('a'); bus.emit('b'); bus.emit('c');
  assert.equal(bus.since(first.id), null);
  assert.equal(bus.since('nonsense'), null);

  unsub();
  bus.emit('after-unsub');
  assert.equal(seen.length, 5);

  const frame = sseFrame(seen[1]);
  assert.match(frame, /^id: \d+\nevent: advice\ndata: \{/);
});

test('events: classifyChange maps paths to entities and ignores noise', () => {
  const c = (p) => classifyChange(p);
  assert.deepEqual(c('t/films/my-film/advice/adv-1/request.json'), { type: 'advice', filmId: 't/my-film', adviceId: 'adv-1' });
  assert.deepEqual(c('t\\films\\my-film\\film.json'), { type: 'film', filmId: 't/my-film' });
  assert.deepEqual(c('t/films/my-film/deliveries/del-9/manifest.json'), { type: 'delivery', filmId: 't/my-film', deliveryId: 'del-9' });
  assert.deepEqual(c('t/films/my-film/deliveries/current.json'), { type: 'delivery', filmId: 't/my-film' });
  assert.deepEqual(
    c('t/films/my-film/scenes/shot-1/revisions/rev-1/revision.json'),
    { type: 'revision', filmId: 't/my-film', sceneId: 't/my-film/shot-1', revisionId: 'rev-1' },
  );
  assert.deepEqual(c('t/films/my-film/scenes/shot-1/out/output.mp4'), { type: 'scene-output', filmId: 't/my-film', sceneId: 't/my-film/shot-1' });
  assert.deepEqual(c('t/films/my-film/out/film.mp4'), { type: 'film-output', filmId: 't/my-film' });
  assert.deepEqual(c('t/activity/claude.json'), { type: 'activity', workspace: 't' });

  // Noise: temp files, staging, composition keystrokes, foreign shapes.
  assert.equal(c('t/films/f/out/.staging/film-x.mp4'), null);
  assert.equal(c('t/films/f/advice/adv-1.tmp-123/request.json'), null);
  assert.equal(c('t/films/f/scenes/s/composition.js'), null);
  assert.equal(c('t/library/big.mp4'), null);
  assert.equal(c(''), null);
});

test('events: the workspace watcher notices another writer (cross-process channel)', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-events-'));
  const store = await makeStore(home);
  const film = await store.createFilm(TEST_WS, { name: 'Watched' });

  const bus = new ProductionEvents();
  const watcher = startWorkspaceWatcher({ root: store.workspacesRoot, events: bus, debounceMs: 50 });
  if (!watcher.active) {
    t.skip('recursive fs.watch unsupported on this platform');
    return;
  }
  try {
    const got = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      bus.subscribe((e) => {
        if (e.type === 'advice' && e.filmId === film.id) { clearTimeout(timeout); resolve(e); }
      });
    });
    await createAdvice({ filmPath: film.path, filmId: film.id, message: 'seen by the watcher?' });
    const event = await got;
    assert.ok(event, 'watcher reported the advice write');
    assert.equal(event.filmId, film.id);
  } finally {
    watcher.close();
  }
});

test('activity: heartbeats round-trip with staleness', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-activity-'));
  const store = await makeStore(home);
  const wsPath = store.workspacePath(TEST_WS);

  await reportActivity({ workspacePath: wsPath, agent: 'claude', activity: 'Creating scene demo-shot', filmId: 't/f' });
  const listed = await listActivity(wsPath);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].stale, false);
  assert.equal(listed[0].activity, 'Creating scene demo-shot');

  // Time travel: the same heartbeat read three minutes later is stale.
  const later = await listActivity(wsPath, { now: Date.now() + 200_000 });
  assert.equal(later[0].stale, true);

  await assert.rejects(
    () => reportActivity({ workspacePath: wsPath, agent: 'bad/slash', activity: 'x' }),
    (e) => e.code === 'invalid_config',
  );
  await assert.rejects(
    () => reportActivity({ workspacePath: wsPath, agent: 'ok', activity: '' }),
    (e) => e.code === 'invalid_config',
  );
});

test('activity: productionStatus reports readiness, advice, and delivery facts', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-status-'));
  const store = await makeStore(home);
  const created = await store.createFilm(TEST_WS, { name: 'Status Film' });
  await store.createScene(created.id, { name: 'One', durationInFrames: 10 });
  await createAdvice({ filmPath: created.path, filmId: created.id, message: 'note' });
  await reportActivity({
    workspacePath: store.workspacePath(TEST_WS), agent: 'claude',
    activity: 'Planning film', filmId: created.id,
  });

  const film = await store.getFilm(created.id);
  const status = await productionStatus({ store, film });
  assert.equal(status.filmId, film.id);
  assert.equal(status.readiness.total, 1);
  assert.equal(status.readiness.rendered, 0);
  assert.equal(status.advice.unresolved, 1);
  assert.equal(status.currentDelivery, null);
  assert.equal(status.deliveries, 0);
  assert.equal(status.newerWorkThanDelivery, false);
  assert.equal(status.activity.length, 1);
  assert.equal(status.activity[0].agent, 'claude');
});
