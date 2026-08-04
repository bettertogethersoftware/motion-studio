/**
 * clone_scene (v0.27): copying a scene across — or within — films.
 *
 * Store-level tests, no Chromium and no ffmpeg: a "render" here is a file at
 * the scene's canonical output path, which is all the revision machinery and
 * the tree walk care about. What is actually under test is the copy contract —
 * everything an author wrote comes across, nothing a render derived does, and
 * the copy OWNS ITS BYTES (the aliasing test below is the one that would catch
 * a well-meaning hardlink optimisation).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeStore, TEST_WS } from './helpers/workspace.mjs';
import { archiveRevision } from '../src/core/revisions.js';
import { sceneOutputPath, writeRenderMeta } from '../src/core/film.js';

async function tmpStore() {
  return makeStore(await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-clone-')));
}

/** A film with a signature, plus one scene in it. */
async function fixture({ sceneDefaults = { fps: 30, width: 1920, height: 1080 }, scene = {} } = {}) {
  const store = await tmpStore();
  const film = await store.createFilm(TEST_WS, { name: 'Source Film', sceneDefaults });
  const src = await store.createScene(film.id, { name: 'Hero Shot', durationInFrames: 90, ...scene });
  return { store, film: await store.getFilm(film.id), src };
}

/** Simulate a completed render at the scene's canonical output path. */
async function fakeRender(store, scene, body = 'take-1') {
  const config = await store.readConfig(scene.id);
  const out = sceneOutputPath(scene.path, config);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp-stage';
  await fsp.writeFile(tmp, `fake-video:${body}`);
  await fsp.rename(tmp, out);
  const renderMeta = await writeRenderMeta({
    scenePath: scene.path, config, frames: config.durationInFrames, outputPath: out,
  });
  return { config, out, renderMeta };
}

test('clone_scene: within-film clone copies the composition and joins the play order', async () => {
  const { store, film, src } = await fixture();
  await store.writeFile(src.id, 'composition.js', '/* hero */\nMotionStudio.registerComposition(() => {});\n');

  const clone = await store.cloneScene(src.id, film.id);

  assert.equal(clone.id, `${film.id}/hero-shot-copy`);
  assert.equal(clone.name, 'Hero Shot (copy)');
  assert.deepEqual(clone.warnings, []);
  assert.ok(clone.copied.files >= 4, `expected the composition files, got ${clone.copied.files}`);
  assert.ok(clone.copied.bytes > 0);

  // The authored files are really there, byte for byte.
  assert.equal(
    await fsp.readFile(path.join(clone.path, 'composition.js'), 'utf8'),
    await fsp.readFile(path.join(src.path, 'composition.js'), 'utf8'),
  );
  assert.ok(fs.existsSync(path.join(clone.path, 'frame-api.js')));
  assert.ok(fs.existsSync(path.join(clone.path, 'composition.html')));

  // Appended to the play order, after the source.
  const after = await store.getFilm(film.id);
  assert.deepEqual(after.scenes.map((s) => s.slug), ['hero-shot', 'hero-shot-copy']);
  // ...and the film document really changed, which is what the Studio's
  // film-updated events ride on.
  assert.notEqual(after.revision, film.revision);
  // Listed, not `unlisted` — the failure mode a hand-copied folder produces.
  const listed = await store.listScenes(film.id);
  assert.equal(listed.length, 2);
  assert.ok(!listed.some((s) => s.unlisted));
});

test('clone_scene: cross-film clone lands in the destination film only', async () => {
  const { store, film, src } = await fixture();
  const other = await store.createFilm(TEST_WS, { name: 'Other Film', sceneDefaults: { fps: 30, width: 1920, height: 1080 } });

  const clone = await store.cloneScene(src.id, other.id, { name: 'Borrowed Shot' });

  assert.equal(clone.id, `${other.id}/borrowed-shot`);
  assert.equal(clone.config.name, 'Borrowed Shot');
  assert.deepEqual((await store.getFilm(other.id)).scenes.map((s) => s.slug), ['borrowed-shot']);
  // The source film is untouched.
  assert.deepEqual((await store.getFilm(film.id)).scenes.map((s) => s.slug), ['hero-shot']);
  assert.ok(fs.existsSync(path.join(clone.path, 'composition.html')));
});

test('clone_scene: the whole config survives — duration, fps, audio, output', async () => {
  const { store, film, src } = await fixture();
  await fsp.mkdir(path.join(src.path, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(src.path, 'assets', 'bed.wav'), 'RIFF-fake');
  const source = await store.updateConfig(src.id, {
    durationInFrames: 275,
    fps: 24,
    audio: [{ src: 'assets/bed.wav', startInFrames: 12, gainDb: -6, fadeOutFrames: 30 }],
    output: { dir: 'out', filename: 'output.webm', format: 'webm', transparent: true, crf: 30 },
  });

  const clone = await store.cloneScene(src.id, film.id);
  const { name, clonedFrom, ...copiedConfig } = clone.config;
  const { name: sourceName, ...sourceRest } = source;
  assert.deepEqual(copiedConfig, sourceRest, 'every config field but the name is carried verbatim');
  assert.equal(name, 'Hero Shot (copy)');
  // And it is what is on disk, not just what was returned.
  assert.deepEqual(await store.readConfig(clone.id), clone.config);
});

test('clone_scene: assets are copied byte-equal and are NOT aliased to the source', async () => {
  const { store, film, src } = await fixture();
  const assetDir = path.join(src.path, 'assets');
  await fsp.mkdir(assetDir, { recursive: true });
  // Deliberately larger than the revision snapshotter's 256 KB hardlink
  // threshold: a small file was always copied, so only a big one proves that
  // clones never share an inode with the scene they came from.
  const big = Buffer.alloc(300 * 1024, 0x41);
  await fsp.writeFile(path.join(assetDir, 'plate.png'), big);
  await fsp.mkdir(path.join(assetDir, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(assetDir, 'notes', 'credit.txt'), 'photo: someone');

  const clone = await store.cloneScene(src.id, film.id);
  assert.equal(clone.copied.assets, 2);
  const clonedPlate = path.join(clone.path, 'assets', 'plate.png');
  assert.deepEqual(await fsp.readFile(clonedPlate), big);
  assert.equal(fs.statSync(clonedPlate).nlink, 1, 'a clone must own its asset bytes');

  // Mutate the SOURCE asset in place, the way a human editing a file on disk
  // (or an image tool writing over it) would.
  await fsp.writeFile(path.join(assetDir, 'plate.png'), Buffer.alloc(300 * 1024, 0x42));
  assert.deepEqual(await fsp.readFile(clonedPlate), big, 'the clone must not follow the source');
});

test('clone_scene: rendered output and revision history are left behind', async () => {
  const { store, film, src } = await fixture();
  const { config, renderMeta } = await fakeRender(store, src);
  await archiveRevision({ scenePath: src.path, config, frames: config.durationInFrames, renderMeta });

  const clone = await store.cloneScene(src.id, film.id);

  assert.ok(!fs.existsSync(path.join(clone.path, 'out', 'output.mp4')), 'the clone starts unrendered');
  assert.ok(!fs.existsSync(path.join(clone.path, 'revisions')), 'history belongs to the scene that made it');
  // The out dir itself exists and is empty, exactly as create_scene leaves it.
  assert.deepEqual(await fsp.readdir(path.join(clone.path, 'out')), []);
});

test('clone_scene: clonedFrom pins the source revision, or null when there is none', async () => {
  const { store, film, src } = await fixture();

  const bare = await store.cloneScene(src.id, film.id, { slug: 'never-rendered' });
  assert.equal(bare.config.clonedFrom.scene, src.id);
  assert.equal(bare.config.clonedFrom.revisionId, null);
  assert.ok(Date.parse(bare.config.clonedFrom.at) > 0);

  const { config, renderMeta } = await fakeRender(store, src);
  const rev = await archiveRevision({ scenePath: src.path, config, frames: config.durationInFrames, renderMeta });
  const pinned = await store.cloneScene(src.id, film.id, { slug: 'after-a-take' });
  assert.equal(pinned.config.clonedFrom.revisionId, rev.id);

  // Provenance is engine-stamped, never agent-editable.
  await assert.rejects(
    () => store.updateConfig(pinned.id, { clonedFrom: { scene: 'somewhere/else', revisionId: null } }),
    (e) => e.code === 'invalid_config' && /clonedFrom/.test(e.message),
  );
});

test('clone_scene: a derived slug auto-dedupes, an explicit one conflicts', async () => {
  const { store, film, src } = await fixture();

  assert.equal((await store.cloneScene(src.id, film.id)).id, `${film.id}/hero-shot-copy`);
  assert.equal((await store.cloneScene(src.id, film.id)).id, `${film.id}/hero-shot-copy-2`);
  assert.equal((await store.cloneScene(src.id, film.id)).id, `${film.id}/hero-shot-copy-3`);

  await assert.rejects(
    () => store.cloneScene(src.id, film.id, { slug: 'hero-shot-copy' }),
    (e) => e.code === 'scene_already_exists',
  );
  // The film lists each dedupe exactly once.
  assert.deepEqual(
    (await store.getFilm(film.id)).scenes.map((s) => s.slug),
    ['hero-shot', 'hero-shot-copy', 'hero-shot-copy-2', 'hero-shot-copy-3'],
  );
});

test('clone_scene: a signature mismatch warns instead of failing', async () => {
  const { store, src } = await fixture({ scene: { fps: 30, width: 1920, height: 1080 } });
  const vertical = await store.createFilm(TEST_WS, {
    name: 'Vertical Cut', sceneDefaults: { fps: 30, width: 1080, height: 1920 },
  });

  const clone = await store.cloneScene(src.id, vertical.id);

  assert.equal(clone.config.width, 1920, 'the clone is verbatim; reframing is the caller\'s move');
  assert.equal(clone.warnings.length, 1);
  assert.match(clone.warnings[0], /width 1920 vs the film's 1080/);
  assert.match(clone.warnings[0], /height 1080 vs the film's 1920/);
  assert.match(clone.warnings[0], /update_scene_config/);
  // ...and the clone exists regardless.
  assert.ok(fs.existsSync(path.join(clone.path, 'scene.json')));
});

test('clone_scene: a vendored 3D build comes across with its libraryBuilds intact', async () => {
  const { store, film, src } = await fixture();
  const libs = path.join(store.dataDir, 'libs', 'three');
  await fsp.mkdir(libs, { recursive: true });
  await fsp.writeFile(path.join(libs, 'three.min.js'), '/* fake three */ window.THREE = {};');
  process.env.MOTION_STUDIO_LIBS_DIR = path.dirname(libs);
  try {
    await store.addLibrary(src.id, { library: 'three' });
    const clone = await store.cloneScene(src.id, film.id);

    assert.deepEqual(clone.config.libraries, ['three']);
    const build = clone.config.libraryBuilds['three.min.js'];
    assert.ok(build, 'libraryBuilds survived the copy');
    const bytes = await fsp.readFile(path.join(clone.path, 'three.min.js'));
    assert.equal(bytes.length, build.bytes, 'the recorded build is the file that is actually there');
    // The scaffolded HTML still points at the local build, so the clone is
    // renderable without re-attaching the library.
    assert.match(await fsp.readFile(path.join(clone.path, 'composition.html'), 'utf8'), /src="three\.min\.js"/);
  } finally {
    delete process.env.MOTION_STUDIO_LIBS_DIR;
  }
});

test('clone_scene: a failure part-way through leaves no half-scene behind', async () => {
  const { store, film, src } = await fixture();
  const clonePath = store.scenePath(`${film.id}/hero-shot-copy`);

  const realWrite = store._writeJsonAtomic;
  store._writeJsonAtomic = async () => { throw new Error('disk full'); };
  await assert.rejects(() => store.cloneScene(src.id, film.id), /disk full/);
  store._writeJsonAtomic = realWrite;

  assert.equal(fs.existsSync(clonePath), false, 'the partial folder is removed');
  assert.deepEqual((await store.getFilm(film.id)).scenes.map((s) => s.slug), ['hero-shot']);
  assert.equal((await store.listScenes(film.id)).length, 1, 'nothing surfaces as unlisted');

  // And the same call succeeds once the disk behaves.
  assert.equal((await store.cloneScene(src.id, film.id)).id, `${film.id}/hero-shot-copy`);
});

test('clone_scene: unknown source and unknown destination fail honestly', async () => {
  const { store, film, src } = await fixture();
  await assert.rejects(
    () => store.cloneScene(`${film.id}/no-such-scene`, film.id),
    (e) => e.code === 'scene_not_found',
  );
  await assert.rejects(
    () => store.cloneScene(src.id, `${TEST_WS}/no-such-film`),
    (e) => e.code === 'film_not_found',
  );
  await assert.rejects(
    () => store.cloneScene(src.id, film.id, { slug: 'Not A Slug' }),
    (e) => e.code === 'invalid_id',
  );
  // Nothing was created by any of the three.
  assert.equal((await store.listScenes(film.id)).length, 1);
});
