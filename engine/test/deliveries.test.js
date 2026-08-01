/**
 * Immutable deliveries (v0.23): archive, manifests, pointers, and the
 * frame→selection resolver human review depends on.
 *
 * archiveDelivery consumes buildFilmArtifact's result shape, so these tests
 * hand it a synthetic result over real files — the archive logic (links,
 * manifests, pointers, revision freezing) is exactly what runs after a real
 * build, without paying for ffmpeg. The full build → archive path runs in
 * the Studio review suite, gated on ffmpeg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeStore, TEST_WS } from './helpers/workspace.mjs';
import {
  archiveDelivery, listDeliveries, getDeliveryManifest, currentDeliveryId,
  deliveryFilePath, resolveDeliveryFrame, deliveryPinnedRevisionIds, newDeliveryId,
} from '../src/core/deliveries.js';
import { archiveRevision } from '../src/core/revisions.js';
import { sceneOutputPath, writeRenderMeta } from '../src/core/film.js';

async function filmFixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-deliveries-'));
  const store = await makeStore(home);
  const film = await store.createFilm(TEST_WS, { name: 'Delivery Film' });
  const s1 = await store.createScene(film.id, { name: 'Intro Shot', durationInFrames: 30 });
  const s2 = await store.createScene(film.id, { name: 'Demo Shot', durationInFrames: 60 });
  return { store, film: await store.getFilm(film.id), s1, s2 };
}

/** Give a scene a fake promoted output + sidecar + archived revision. */
async function renderAndArchive(store, scene, body) {
  const config = await store.readConfig(scene.id);
  const out = sceneOutputPath(scene.path, config);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp-stage';
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, out);
  const renderMeta = await writeRenderMeta({
    scenePath: scene.path, config, frames: config.durationInFrames, outputPath: out,
  });
  const rev = await archiveRevision({ scenePath: scene.path, config, frames: config.durationInFrames, renderMeta });
  return { config, out, rev };
}

/** A synthetic buildFilmArtifact result over a real output file. */
async function fakeBuildResult(film, layout, { totalFrames, fps = 30 }) {
  const outputPath = path.join(film.path, 'out', 'film.mp4');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = outputPath + '.tmp-stage';
  await fsp.writeFile(tmp, 'fake-film-bytes');
  await fsp.rename(tmp, outputPath);
  return {
    outputPath,
    sceneLayout: layout,
    totalFrames,
    fps,
    format: 'mp4',
    durationSeconds: totalFrames / fps,
    deliverable: { id: 'master', width: 1920, height: 1080 },
    audio: { tracks: 1, peakDb: -3.2 },
    review: { warnings: [] },
    reEncoded: false,
  };
}

test('deliveries: archive freezes layout, revisions, tracks, and identity', async () => {
  const { store, film, s1, s2 } = await filmFixture();
  const r1 = await renderAndArchive(store, s1, 'intro-bytes');
  const r2 = await renderAndArchive(store, s2, 'demo-bytes');
  await store.updateFilm(film.id, {
    scenes: [{ slug: 'intro-shot', sequence: 'Intro' }, { slug: 'demo-shot', sequence: 'Demo' }],
    captions: [{ text: 'Hello', fromFrame: 10, toFrame: 40 }],
    audio: [],
  });
  const doc = await store.getFilm(film.id);

  const layout = [
    { kind: 'scene', sceneId: s1.id, slug: 'intro-shot', sequence: 'Intro', name: 'Intro Shot', filmOffset: 0, durationInFrames: 30, startSeconds: 0 },
    { kind: 'scene', sceneId: s2.id, slug: 'demo-shot', sequence: 'Demo', name: 'Demo Shot', filmOffset: 30, durationInFrames: 60, startSeconds: 1 },
  ];
  const result = await fakeBuildResult(doc, layout, { totalFrames: 90 });
  const archived = await archiveDelivery({ store, film: doc, result, agent: 'builder', jobId: 'job-1' });

  assert.ok(archived.id.startsWith('del-'));
  assert.equal(await currentDeliveryId(doc.path), archived.id);

  const manifest = await getDeliveryManifest(doc.path, archived.id);
  assert.equal(manifest.totalFrames, 90);
  assert.equal(manifest.agent, 'builder');
  assert.equal(manifest.segments[0].revisionId, r1.rev.id);
  assert.equal(manifest.segments[1].revisionId, r2.rev.id);
  assert.equal(manifest.captions.length, 1);
  assert.equal(manifest.segments[1].sequence, 'Demo');
  assert.ok(manifest.outputIdentity.bytes > 0);

  // The archived video is the delivered bytes, immutable against replacement.
  const abs = deliveryFilePath(doc.path, archived.id, manifest.outputFile);
  assert.equal(await fsp.readFile(abs, 'utf8'), 'fake-film-bytes');
  const tmp = result.outputPath + '.tmp-next';
  await fsp.writeFile(tmp, 'NEWER build');
  await fsp.rename(tmp, result.outputPath);
  assert.equal(await fsp.readFile(abs, 'utf8'), 'fake-film-bytes');
});

test('deliveries: newest master build becomes current; variants never do', async () => {
  const { store, film, s1 } = await filmFixture();
  await renderAndArchive(store, s1, 'v1');
  const doc = await store.getFilm(film.id);
  const layout = [{ kind: 'scene', sceneId: s1.id, slug: 'intro-shot', name: 'Intro Shot', filmOffset: 0, durationInFrames: 30, startSeconds: 0 }];

  const first = await archiveDelivery({ store, film: doc, result: await fakeBuildResult(doc, layout, { totalFrames: 30 }) });
  const second = await archiveDelivery({ store, film: doc, result: await fakeBuildResult(doc, layout, { totalFrames: 30 }) });
  assert.equal(await currentDeliveryId(doc.path), second.id);

  const variantResult = await fakeBuildResult(doc, layout, { totalFrames: 30 });
  variantResult.deliverable = { id: 'tiktok', width: 1080, height: 1920 };
  const variant = await archiveDelivery({ store, film: doc, result: variantResult });
  assert.equal(await currentDeliveryId(doc.path), second.id, 'a variant build does not steal the review pointer');

  const listed = await listDeliveries(doc.path);
  assert.equal(listed.length, 3);
  assert.equal(listed[0].id, variant.id, 'newest first');
  assert.equal(listed.find((d) => d.id === second.id).current, true);
  assert.equal(listed.find((d) => d.id === first.id).current, false);
});

test('deliveries: resolveDeliveryFrame answers what the human is looking at', () => {
  const manifest = {
    totalFrames: 90,
    fps: 30,
    segments: [
      { kind: 'scene', sceneId: 't/f/a', slug: 'a', sequence: 'Intro', filmOffset: 0, durationInFrames: 30, revisionId: 'rev-a' },
      { kind: 'scene', sceneId: 't/f/b', slug: 'b', sequence: 'Demo', filmOffset: 30, durationInFrames: 60, revisionId: 'rev-b' },
    ],
    captions: [{ id: 'c1', text: 'Hi', fromFrame: 25, toFrame: 45 }],
    overlays: [{ id: 'o1', src: 'assets/logo.png', fromFrame: 0, toFrame: 90 }],
    audio: [
      { id: 't1', src: 'assets/narration.wav', startInFrames: 0, trimEndInFrames: 40 },
      { id: 't2', src: 'assets/music.wav', startInFrames: 0 },
    ],
  };
  const hit = resolveDeliveryFrame(manifest, 42);
  assert.equal(hit.segment.slug, 'b');
  assert.equal(hit.segmentFrame, 12);
  assert.equal(hit.sequence, 'Demo');
  assert.equal(hit.timeSeconds, 1.4);
  assert.deepEqual(hit.captions.map((c) => c.id), ['c1']);
  assert.deepEqual(hit.overlays.map((o) => o.id), ['o1']);
  // t1's trim window (0..40) has ended by frame 42; the untrimmed music bed remains.
  assert.deepEqual(hit.audio.map((t) => t.id), ['t2']);

  // Boundary behaviour: the first frame of a segment belongs to it.
  assert.equal(resolveDeliveryFrame(manifest, 30).segment.slug, 'b');
  assert.equal(resolveDeliveryFrame(manifest, 29).segment.slug, 'a');
  // Beyond the end clamps to the last frame rather than erroring.
  assert.equal(resolveDeliveryFrame(manifest, 500).filmFrame, 89);
  assert.throws(() => resolveDeliveryFrame(manifest, -1), (e) => e.code === 'invalid_config');
  assert.throws(() => resolveDeliveryFrame(manifest, 1.5), (e) => e.code === 'invalid_config');
});

test('deliveries: artefact serving is allow-listed; ids cannot escape', async () => {
  const { store, film, s1 } = await filmFixture();
  await renderAndArchive(store, s1, 'v1');
  const doc = await store.getFilm(film.id);
  const layout = [{ kind: 'scene', sceneId: s1.id, slug: 'intro-shot', name: 'Intro Shot', filmOffset: 0, durationInFrames: 30, startSeconds: 0 }];
  const archived = await archiveDelivery({ store, film: doc, result: await fakeBuildResult(doc, layout, { totalFrames: 30 }) });

  assert.ok(deliveryFilePath(doc.path, archived.id, 'manifest.json'));
  assert.throws(() => deliveryFilePath(doc.path, archived.id, '..\\..\\film.json'), (e) => e.code === 'path_not_allowed');
  assert.throws(() => deliveryFilePath(doc.path, '..', 'manifest.json'), (e) => e.code === 'delivery_not_found');
  await assert.rejects(() => getDeliveryManifest(doc.path, 'del-nope'), (e) => e.code === 'delivery_not_found');
});

test('deliveries: pinned revision ids cover every archived manifest', async () => {
  const { store, film, s1, s2 } = await filmFixture();
  const r1 = await renderAndArchive(store, s1, 'v1');
  const r2 = await renderAndArchive(store, s2, 'v1');
  const doc = await store.getFilm(film.id);
  const layout = [
    { kind: 'scene', sceneId: s1.id, slug: 'intro-shot', name: 'Intro Shot', filmOffset: 0, durationInFrames: 30, startSeconds: 0 },
    { kind: 'scene', sceneId: s2.id, slug: 'demo-shot', name: 'Demo Shot', filmOffset: 30, durationInFrames: 60, startSeconds: 1 },
  ];
  await archiveDelivery({ store, film: doc, result: await fakeBuildResult(doc, layout, { totalFrames: 90 }) });
  const pinned = await deliveryPinnedRevisionIds(doc.path);
  assert.ok(pinned.has(r1.rev.id));
  assert.ok(pinned.has(r2.rev.id));
});

test('deliveries: ids sort chronologically', () => {
  assert.ok(newDeliveryId(2000) > newDeliveryId(1000));
});
