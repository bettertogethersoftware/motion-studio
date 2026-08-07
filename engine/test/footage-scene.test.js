/**
 * Turning supplied footage into a scene (v0.28).
 *
 * The claim this operation makes to the human is narrow and testable: the
 * scene it produces is the clip. Same geometry, same frame count, same place
 * in the play order, same narrative band — a VISUAL NO-OP until somebody
 * edits the composition. So that is what is asserted here, on a real encode,
 * rather than that the call returned an object.
 *
 * The two failure modes worth the ffmpeg gate:
 *   - a scene whose length disagrees with the segment moves every cut after it
 *   - an intermediate the render browser cannot decode (H.264) turns the whole
 *     thing into a black rectangle, which is exactly the bug this ships after
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { makeStore, TEST_WS } from './helpers/workspace.mjs';
import { sceneFromFootage, footageCompositionFiles, CLIP_FILENAME } from '../src/core/footage-scene.js';

const execFileP = promisify(execFile);
let tmp, clipSrc, haveFfmpeg = true;

const FPS = 30;
const CLIP_FRAMES = 60;          // two seconds

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-footage-scene-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (!haveFfmpeg) return;
  // H.264 in an .mp4, silent — exactly what a film timeline accepts as footage,
  // and exactly what the render browser cannot decode.
  clipSrc = path.join(tmp, 'clip.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${FPS}:duration=${CLIP_FRAMES / FPS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-frames:v', String(CLIP_FRAMES), clipSrc]);
});
after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

const probe = async (file) => {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,nb_read_packets', '-count_packets',
    '-of', 'json', file]);
  return JSON.parse(stdout).streams[0];
};

/** A film whose play order is one footage segment, in a named sequence. */
async function filmWithFootage(dataDir, { sequence = 'Opening' } = {}) {
  const store = await makeStore(dataDir);
  const film = await store.createFilm(TEST_WS, { name: 'Clip Film' });
  await fsp.mkdir(path.join(film.path, 'assets'), { recursive: true });
  await fsp.copyFile(clipSrc, path.join(film.path, 'assets', 'clip.mp4'));
  const saved = await store.updateFilm(film.id, {
    sceneDefaults: { fps: FPS, width: 320, height: 240, durationInFrames: CLIP_FRAMES },
    scenes: [{ footage: 'assets/clip.mp4', durationInFrames: CLIP_FRAMES, label: 'My Clip', sequence }],
  });
  return { store, film: saved };
}

/* ------------------------------------------------------------------ */
/* The composition, without paying for an encode                       */
/* ------------------------------------------------------------------ */

test('the generated composition seeks rather than plays, and states the scene it is', () => {
  const files = footageCompositionFiles({
    name: 'My Clip', fps: 30, width: 1920, height: 1080, durationInFrames: 231,
  });
  const js = files['composition.js'];
  // play() is the one thing that would break frame determinism outright: under
  // parallel rendering each worker would capture a different moment.
  assert.ok(js.includes('seekVideo('), 'drives the clip with seekVideo');
  assert.ok(!/\.play\s*\(/.test(js), 'never calls play()');
  assert.ok(js.includes('const FPS = 30;'));
  assert.ok(js.includes('const DURATION = 231;'));
  // The in-point is what lets a second scene use a different part of the same
  // file without another transcode, so it has to be a named constant.
  assert.ok(js.includes('IN_POINT'));
  assert.ok(files['composition.html'].includes(`assets/${CLIP_FILENAME}`));
  assert.ok(files['composition.html'].includes('muted'), 'the clip cannot bring audio into a composition');
  assert.ok(files['styles.css'].includes('width: 1920px'));
  assert.ok(files['styles.css'].includes('object-fit: cover'), 'full-bleed by construction');
});

test('a name with markup cannot escape the generated html', () => {
  const files = footageCompositionFiles({
    name: '<script>x</script>', fps: 30, width: 100, height: 100, durationInFrames: 10,
  });
  assert.ok(!files['composition.html'].includes('<script>x</script>'));
  assert.ok(files['composition.html'].includes('&lt;script&gt;'));
});

/* ------------------------------------------------------------------ */
/* The conversion itself                                               */
/* ------------------------------------------------------------------ */

test('footage becomes a scene that IS the clip', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
  const { store, film } = await filmWithFootage(dir);
  const segmentId = film.scenes[0].id;
  assert.ok(segmentId, 'a footage segment is stamped with a stable id');

  const res = await sceneFromFootage({ store, filmId: film.id, segmentId });

  // The scene is the film's geometry and the segment's EXACT length. A frame
  // of drift here moves every cut after it.
  assert.equal(res.config.fps, FPS);
  assert.equal(res.config.width, 320);
  assert.equal(res.config.height, 240);
  assert.equal(res.config.durationInFrames, CLIP_FRAMES);
  assert.equal(res.name, 'My Clip', 'the clip\'s own label names the scene');

  // The intermediate is decodable by the render browser — the whole reason the
  // conversion is not just a copy.
  const clipAbs = path.join(res.path, 'assets', CLIP_FILENAME);
  assert.ok(fs.existsSync(clipAbs));
  const probed = await probe(clipAbs);
  assert.equal(probed.codec_name, 'vp9', 'VP9, because Chromium cannot decode H.264');
  assert.equal(Number(probed.width), 320);
  assert.equal(Number(probed.height), 240);
  assert.equal(Number(probed.nb_read_packets), CLIP_FRAMES, 'every frame survives the conversion');

  // The scene is a real scene: scaffolded, with the runtime beside it.
  for (const f of ['scene.json', 'composition.html', 'composition.js', 'styles.css', 'frame-api.js']) {
    assert.ok(fs.existsSync(path.join(res.path, f)), `${f} exists`);
  }

  // It took the clip's PLACE, and carried its sequence label across — losing
  // that would silently drop the segment out of its narrative band.
  const after = await store.getFilm(film.id);
  assert.equal(after.scenes.length, 1);
  assert.equal(after.scenes[0].slug, res.scene.split('/').pop());
  assert.equal(after.scenes[0].sequence, 'Opening');
  assert.equal(after.scenes[0].footage, undefined);
  assert.equal(res.replaced, true);

  // The original is untouched, so the segment can be put back.
  assert.ok(fs.existsSync(path.join(film.path, 'assets', 'clip.mp4')));
});

test('keepFootage builds the scene beside the clip, leaving the play order alone',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await filmWithFootage(dir);
    const res = await sceneFromFootage({
      store, filmId: film.id, segmentId: film.scenes[0].id, keepFootage: true,
    });
    assert.equal(res.replaced, false);
    const after = await store.getFilm(film.id);
    assert.equal(after.scenes.length, 1);
    assert.equal(after.scenes[0].footage, 'assets/clip.mp4', 'the clip is still the segment');
    assert.ok(fs.existsSync(path.join(res.path, 'assets', CLIP_FILENAME)), 'the scene was still built');
  });

test('converting the same clip twice dedupes the slug rather than failing',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await filmWithFootage(dir);
    const first = await sceneFromFootage({
      store, filmId: film.id, segmentId: film.scenes[0].id, keepFootage: true,
    });
    const second = await sceneFromFootage({
      store, filmId: film.id, segmentId: film.scenes[0].id, keepFootage: true,
    });
    assert.notEqual(first.scene, second.scene);
    assert.match(second.scene, /-2$/);
  });

test('an explicit slug that is taken is an error, not a surprise',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await filmWithFootage(dir);
    await sceneFromFootage({
      store, filmId: film.id, segmentId: film.scenes[0].id, slug: 'taken', keepFootage: true,
    });
    await assert.rejects(
      () => sceneFromFootage({
        store, filmId: film.id, segmentId: film.scenes[0].id, slug: 'taken', keepFootage: true,
      }),
      (e) => e.code === 'scene_already_exists',
    );
  });

/**
 * The case that actually happened: a 60fps clip on a 30fps film. A footage
 * segment states a frame COUNT, `planFilm` verifies it against the file, and
 * the timeline then reads it at the FILM's rate — the same number meaning two
 * different lengths. Building a scene to the declared count leaves half of it
 * with nothing to show. The clip was already unbuildable AS footage for the
 * same reason, so this refuses instead of paying for a transcode first.
 */
async function filmWithMismatchedFootage(dataDir) {
  const store = await makeStore(dataDir);
  const film = await store.createFilm(TEST_WS, { name: 'Rate Clash' });
  // A SCENE first, so the film's timeline rate is established at 30 the way a
  // real film's is. On a footage-only film the clip would set the rate itself
  // and there would be no clash to test — which is the distinction that made
  // `sceneDefaults` the wrong thing to read.
  await store.createScene(film.id, { name: 'Head', fps: 30, width: 320, height: 240, durationInFrames: 30 });
  await fsp.mkdir(path.join(film.path, 'assets'), { recursive: true });
  // 60 frames AT 60fps — one second of video, declared as 60 frames on a
  // 30fps timeline, where 60 frames means two seconds.
  const fast = path.join(film.path, 'assets', 'fast.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-frames:v', '60', fast]);
  const saved = await store.updateFilm(film.id, {
    sceneDefaults: { fps: 30, width: 320, height: 240, durationInFrames: 60 },
    scenes: [{ slug: 'head' }, { footage: 'assets/fast.mp4', durationInFrames: 60 }],
  });
  return { store, film: saved, segmentId: saved.scenes[1].id };
}

test('a clip that cannot fill its place is refused BEFORE the transcode',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWithMismatchedFootage(dir);
    await assert.rejects(
      () => sceneFromFootage({ store, filmId: film.id, segmentId }),
      (e) => {
        assert.equal(e.code, 'invalid_film');
        // The error has to carry the value that WOULD work, or "conform it"
        // is advice the caller cannot act on without doing the arithmetic.
        assert.equal(e.detail.durationInFramesThatFits, 30);
        assert.equal(e.detail.clipFps, 60);
        assert.equal(e.detail.filmFps, 30);
        assert.match(e.message, /freeze/);
        return true;
      },
    );
    // Nothing was built and nothing was spent: only the scene that was already
    // there is on disk, and the clip is still the segment.
    assert.deepEqual((await fsp.readdir(path.join(film.path, 'scenes'))).sort(), ['head']);
    const after = await store.getFilm(film.id);
    assert.equal(after.scenes[1].footage, 'assets/fast.mp4');
  });

test('a clip that sets the film\'s own rate is NOT a clash',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    // The same 60fps clip, but first in the play order, so the timeline runs
    // at 60 and its 60 frames really are one second of this film. Reading the
    // film's `sceneDefaults` (30) instead would invent a clash that is not
    // there and refuse a perfectly good conversion.
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const store = await makeStore(dir);
    const film = await store.createFilm(TEST_WS, { name: 'Fast First' });
    await fsp.mkdir(path.join(film.path, 'assets'), { recursive: true });
    await execFileP('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-frames:v', '60', path.join(film.path, 'assets', 'fast.mp4')]);
    const saved = await store.updateFilm(film.id, {
      sceneDefaults: { fps: 30, width: 320, height: 240, durationInFrames: 60 },
      scenes: [{ footage: 'assets/fast.mp4', durationInFrames: 60 }],
    });
    const res = await sceneFromFootage({ store, filmId: saved.id, segmentId: saved.scenes[0].id });
    assert.equal(res.config.fps, 60, 'the scene matches the timeline, not sceneDefaults');
    assert.equal(res.config.durationInFrames, 60);
    assert.deepEqual(res.warnings, []);
  });

test('...and the length the error names is one the call accepts',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWithMismatchedFootage(dir);
    const res = await sceneFromFootage({
      store, filmId: film.id, segmentId, durationInFrames: 30,
    });
    assert.equal(res.config.durationInFrames, 30);
    assert.equal(res.config.fps, 30);
    assert.deepEqual(res.warnings, [], 'the scene now fits its clip exactly');
    // One second of film where two were declared: the cut got shorter, which
    // is the trade the caller opted into by naming the length.
    const after = await store.getFilm(film.id);
    assert.equal(after.scenes[1].slug, res.scene.split('/').pop());
  });

test('an unknown segment id is refused before anything is created', async () => {
  const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
  const store = await makeStore(dir);
  const film = await store.createFilm(TEST_WS, { name: 'Empty' });
  await assert.rejects(
    () => sceneFromFootage({ store, filmId: film.id, segmentId: 'seg-nope' }),
    (e) => e.code === 'invalid_film',
  );
});

test('a clip missing from assets/ is refused, and leaves no half-scene behind',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await filmWithFootage(dir);
    await fsp.rm(path.join(film.path, 'assets', 'clip.mp4'));
    await assert.rejects(
      () => sceneFromFootage({ store, filmId: film.id, segmentId: film.scenes[0].id }),
      (e) => e.code === 'file_not_found',
    );
    // The play order is untouched: a failed conversion must not break the film.
    const after = await store.getFilm(film.id);
    assert.equal(after.scenes[0].footage, 'assets/clip.mp4');
    const scenesDir = path.join(film.path, 'scenes');
    const left = fs.existsSync(scenesDir) ? await fsp.readdir(scenesDir) : [];
    assert.deepEqual(left, [], 'no scene folder is left behind');
  });
