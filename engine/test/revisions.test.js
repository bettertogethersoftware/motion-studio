/**
 * Scene revisions (v0.23): immutable history for the atomic render unit.
 *
 * Pure store-level tests — no Chromium, no ffmpeg. A "render" here is a file
 * written at the scene's canonical output path plus the sidecar body a real
 * render would have produced; archiveRevision and useRevision only care about
 * those, which is the point: history-keeping is independent of how the bytes
 * were made. The renderer integration (a real fake-browser render archiving a
 * revision automatically) is covered in pipeline.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeSceneIn } from './helpers/workspace.mjs';
import {
  archiveRevision, listRevisions, getRevision, currentRevisionId, useRevision,
  pruneRevisions, newRevisionId, revisionFilePath,
} from '../src/core/revisions.js';
import { sceneOutputPath, readRenderMeta, writeRenderMeta } from '../src/core/film.js';

async function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ms-revisions-'));
}

/**
 * Simulate a completed canonical render: output file + sidecar.
 *
 * The replacement is staged-and-renamed, exactly like the engine's own
 * promotion protocol — that rename-only contract (never write the delivery
 * in place) is what makes hardlinked revision archives immutable.
 */
async function fakeRender(scene, config, body = 'take-1') {
  const out = sceneOutputPath(scene.path, config);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp-stage';
  await fsp.writeFile(tmp, `fake-video:${body}`);
  await fsp.rename(tmp, out);
  const renderMeta = await writeRenderMeta({
    scenePath: scene.path, config, frames: config.durationInFrames, outputPath: out,
  });
  return { out, renderMeta };
}

test('revisions: archive → list → current, with source snapshot', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);
  const { renderMeta } = await fakeRender(scene, config);

  const rev = await archiveRevision({
    scenePath: scene.path, config, frames: 10, renderMeta,
    agent: 'test-agent', note: 'first take',
  });
  assert.ok(rev.id.startsWith('rev-'));
  assert.equal(await currentRevisionId(scene.path), rev.id);

  const listed = await listRevisions(scene.path);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, rev.id);
  assert.equal(listed[0].current, true);
  assert.equal(listed[0].agent, 'test-agent');
  assert.equal(listed[0].note, 'first take');
  assert.equal(listed[0].frames, 10);
  // Listings elide the per-file manifest but keep the totals.
  assert.equal(listed[0].source.manifest, undefined);
  assert.ok(listed[0].source.files > 0);

  // The archived output holds the exact promoted bytes.
  const doc = await getRevision(scene.path, rev.id);
  const archived = await fsp.readFile(path.join(doc.path, doc.outputFile), 'utf8');
  assert.equal(archived, 'fake-video:take-1');
  // The source snapshot carries the composition files, not the out dir.
  const snap = doc.source.manifest.map((f) => f.path);
  assert.ok(snap.includes('composition.html'));
  assert.ok(snap.includes('scene.json'));
  assert.ok(!snap.some((p) => p.startsWith('out/')));
  assert.ok(!snap.some((p) => p.startsWith('revisions/')));
});

test('revisions: a rework archives a second revision without touching the first', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);

  const r1 = await fakeRender(scene, config, 'take-1');
  const rev1 = await archiveRevision({ scenePath: scene.path, config, frames: 10, renderMeta: r1.renderMeta });
  const r2 = await fakeRender(scene, config, 'take-2');
  const rev2 = await archiveRevision({ scenePath: scene.path, config, frames: 10, renderMeta: r2.renderMeta });

  assert.equal(await currentRevisionId(scene.path), rev2.id);
  const listed = await listRevisions(scene.path);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, rev2.id, 'newest first');
  assert.equal(listed[1].current, false);

  // Immutability: the first revision still holds take-1 bytes.
  const doc1 = await getRevision(scene.path, rev1.id);
  assert.equal(await fsp.readFile(path.join(doc1.path, doc1.outputFile), 'utf8'), 'fake-video:take-1');
});

test('revisions: useRevision repoints the live output and re-stamps the sidecar', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);

  const r1 = await fakeRender(scene, config, 'take-1');
  const rev1 = await archiveRevision({ scenePath: scene.path, config, frames: 10, renderMeta: r1.renderMeta });
  const r2 = await fakeRender(scene, config, 'take-2');
  await archiveRevision({ scenePath: scene.path, config, frames: 10, renderMeta: r2.renderMeta });

  const result = await useRevision({ scenePath: scene.path, config, revisionId: rev1.id, agent: 'director' });
  assert.equal(result.restored, true);
  assert.equal(result.revisionId, rev1.id);

  // Live output now holds take-1, and the pointer follows.
  assert.equal(await fsp.readFile(sceneOutputPath(scene.path, config), 'utf8'), 'fake-video:take-1');
  assert.equal(await currentRevisionId(scene.path), rev1.id);

  // Sidecar: verified against the CURRENT file identity and honest about origin.
  const meta = readRenderMeta(scene.path, config);
  assert.equal(meta.restoredFrom, rev1.id);
  assert.equal(meta.restoredBy, 'director');
  assert.equal(meta.frames, 10);
  const st = fs.statSync(sceneOutputPath(scene.path, config));
  assert.equal(meta.outputIdentity.bytes, st.size);

  // Newer history was NOT deleted.
  assert.equal((await listRevisions(scene.path)).length, 2);
});

test('revisions: useRevision refuses a revision the scene has outgrown', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);
  const r1 = await fakeRender(scene, config);
  const rev1 = await archiveRevision({ scenePath: scene.path, config, frames: 10, renderMeta: r1.renderMeta });

  const changed = await store.updateConfig(scene.id, { durationInFrames: 20 });
  await assert.rejects(
    () => useRevision({ scenePath: scene.path, config: changed, revisionId: rev1.id }),
    (err) => {
      assert.equal(err.code, 'revision_mismatch');
      assert.ok(err.detail.changed.includes('frames'));
      return true;
    },
  );
  // Nothing moved: current pointer unchanged.
  assert.equal(await currentRevisionId(scene.path), rev1.id);
});

test('revisions: unknown ids and path-shaped ids are refused', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);
  await assert.rejects(() => getRevision(scene.path, 'rev-nope'), (e) => e.code === 'revision_not_found');
  await assert.rejects(() => getRevision(scene.path, '../escape'), (e) => e.code === 'revision_not_found');
  await assert.rejects(
    () => useRevision({ scenePath: scene.path, config, revisionId: 'rev-nope' }),
    (e) => e.code === 'revision_not_found',
  );
  assert.throws(() => revisionFilePath(scene.path, '..\\up', 'output.mp4'), (e) => e.code === 'revision_not_found');
});

test('revisions: archive without an output fails honestly', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);
  await assert.rejects(
    () => archiveRevision({ scenePath: scene.path, config, frames: 10 }),
    (e) => e.code === 'file_not_found',
  );
});

test('revisions: prune keeps current + pinned + retention count', async () => {
  const { store, scene } = await makeSceneIn(await tmpdir(), { durationInFrames: 10 });
  const config = await store.readConfig(scene.id);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await fakeRender(scene, config, `take-${i}`);
    const rev = await archiveRevision({ scenePath: scene.path, config, frames: 10, renderMeta: r.renderMeta });
    ids.push(rev.id);
  }
  // ids[4] is current. Pin ids[0]; keep 1 beyond pins.
  const { kept, deleted } = await pruneRevisions({
    scenePath: scene.path, keep: 1, pinned: new Set([ids[0]]),
  });
  assert.ok(kept.includes(ids[4]), 'current survives');
  assert.ok(kept.includes(ids[0]), 'pinned survives');
  assert.ok(kept.includes(ids[3]), 'newest unpinned survives the keep count');
  assert.deepEqual(deleted.sort(), [ids[1], ids[2]].sort());
  assert.equal((await listRevisions(scene.path)).length, 3);
});

test('revisions: ids are time-prefixed and unique', () => {
  const a = newRevisionId(1000);
  const b = newRevisionId(1000);
  assert.notEqual(a, b);
  assert.ok(newRevisionId(2000) > a, 'later ids sort after earlier ones');
});
