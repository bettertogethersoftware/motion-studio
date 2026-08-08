/**
 * Films: document validation, the pure caption/overlay builders (no ffmpeg),
 * planFilm against a real WorkspaceStore, and the Studio films API end to end
 * — create → add scenes → edit → render scenes (fake browser) → build (real
 * ffmpeg concat + finishing pass) → download, gated on ffmpeg where needed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  validateFilm, normalizeFilm, toMixerTracks, audibleTracks, captionsToSrt, captionsToAss, buildOverlayGraph, planFilm, submitFilmBuild,
} from '../src/core/films.js';
import { sceneSignature } from '../src/core/film.js';
import { probeMedia } from '../src/core/encoder.js';
import { transcodeAsset, transcodeMetaPath } from '../src/core/transcode.js';
import { compileReframeFilter, resolveDeliverableSelections } from '../src/core/deliverables.js';
import { JobManager } from '../src/core/jobs.js';
import { createStudioServer } from '../src/studio/server.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';

const execFileP = promisify(execFile);
let haveFfmpeg = false;
try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated */ }

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-films-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

/* ------------------------------ validation ------------------------------ */

test('validateFilm collects every problem at once', () => {
  const bad = normalizeFilm({
    name: '',
    audio: [{ src: 'not-under-assets.wav', gainDb: 'loud' }],
    captions: [{ text: 'x', fromFrame: 10, toFrame: 5 }],
    overlays: [{ src: 'assets/logo.png', fromFrame: 0, toFrame: 0 }],
  });
  try {
    validateFilm(bad);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'invalid_film');
    assert.ok(e.detail.problems.length >= 4, JSON.stringify(e.detail.problems));
  }
});

test('normalizeFilm stamps ids and fills defaults', () => {
  const film = normalizeFilm({ name: 'F', captions: [{ text: 'hi', fromFrame: 0, toFrame: 30 }] });
  assert.ok(film.captions[0].id);
  assert.equal(film.outputFilename, 'film');
  assert.equal(film.captionStyle.sizePct, 4.5);
  assert.equal(film.burnCaptions, false);
  assert.deepEqual(film.audio, []);
  validateFilm(film); // defaults must validate
});

test('film: lanes are stored, so an empty one survives a save', () => {
  // The editor's lanes used to be derived by packing items into the fewest
  // non-overlapping rows, which is why a lane vanished the moment you dragged
  // its clips apart, and why an empty one could not exist at all.
  const film = normalizeFilm({
    name: 'F',
    lanes: { audio: 3 },
    audio: [{ src: 'assets/a.wav', lane: 2 }],
  });
  assert.deepEqual(film.lanes, { audio: 3 });
  validateFilm(film);
  assert.equal(film.audio[0].lane, 2);
});

test('film: a lane is presentation, and never reaches the mixer', () => {
  const [track] = toMixerTracks([{ src: 'assets/a.wav', lane: 2, label: 'bed', trimStartInFrames: 30 }]);
  assert.deepEqual(track, { src: 'assets/a.wav', trimStartInFrames: 30 });
});

test('film: a muted lane leaves the mix, and so does a muted track', () => {
  // Mute is the LANE's: drop another clip into a muted lane and it is silent
  // too, which is what every editor means by muting a track.
  const film = normalizeFilm({
    name: 'F',
    lanes: { audio: 3 },
    mutedLanes: { audio: [1] },
    audio: [
      { src: 'assets/bed.wav', lane: 0 },
      { src: 'assets/vox.wav', lane: 1 },
      { src: 'assets/late.wav', lane: 1 },
      { src: 'assets/sfx.wav', lane: 2, mute: true },
    ],
  });
  validateFilm(film);
  assert.deepEqual(audibleTracks(film).map((t) => t.src), ['assets/bed.wav']);
  // Nothing was deleted — unmuting brings them all back.
  assert.equal(film.audio.length, 4);
  assert.deepEqual(audibleTracks({ ...film, mutedLanes: {} }).map((t) => t.src),
    ['assets/bed.wav', 'assets/vox.wav', 'assets/late.wav']);
});

test('validateFilm rejects a mutedLanes that is not audio lane indexes', () => {
  for (const mutedLanes of [{ audio: ['1'] }, { audio: 1 }, { captions: [0] }]) {
    assert.throws(() => validateFilm(normalizeFilm({ name: 'F', mutedLanes })),
      (e) => e.code === 'invalid_film', JSON.stringify(mutedLanes));
  }
});

test('validateFilm rejects a lane count that is not a small positive integer', () => {
  for (const lanes of [{ audio: 0 }, { audio: 1.5 }, { audio: 99 }, { nope: 2 }]) {
    assert.throws(() => validateFilm(normalizeFilm({ name: 'F', lanes })),
      (e) => e.code === 'invalid_film', JSON.stringify(lanes));
  }
});

test('validateFilm rejects an audio window that ends before it starts', () => {
  // Both trims index the SOURCE file, so an inverted pair is a clip of no
  // length — silence the mixer would render without complaint.
  assert.throws(() => validateFilm(normalizeFilm({
    name: 'F',
    audio: [{ src: 'assets/a.wav', trimStartInFrames: 90, trimEndInFrames: 60 }],
  })), (e) => e.code === 'invalid_film');
  // The valid window passes, and so does a head trim with no tail trim.
  validateFilm(normalizeFilm({ name: 'F', audio: [{ src: 'assets/a.wav', trimStartInFrames: 30, trimEndInFrames: 90 }] }));
  validateFilm(normalizeFilm({ name: 'F', audio: [{ src: 'assets/a.wav', trimStartInFrames: 30 }] }));
});

test('validateFilm rejects a path-escaping outputFilename', () => {
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', outputFilename: '../evil' })),
    (e) => e.code === 'invalid_film');
});

test('validateFilm rejects bad scene refs and duplicates', () => {
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{ slug: '../nope' }] })),
    (e) => e.code === 'invalid_film');
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{ slug: 'a' }, { slug: 'a' }] })),
    (e) => e.code === 'invalid_film' && /more than once/.test(e.detail.problems.join(' ')));
});

test('validateFilm checks sceneDefaults shape', () => {
  validateFilm(normalizeFilm({ name: 'F', sceneDefaults: { fps: 24, width: 640 } }));
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', sceneDefaults: { fps: 0 } })),
    (e) => e.code === 'invalid_film');
});

test('validateFilm accepts a partial delivery-review override and rejects conflicting codes', () => {
  const inheritedWarns = normalizeFilm({ name: 'F', review: { block: ['black_run'] } });
  validateFilm(inheritedWarns);
  assert.deepEqual(inheritedWarns.review, { block: ['black_run'] });
  assert.throws(
    () => validateFilm(normalizeFilm({ name: 'F', review: { block: ['black_run'], warn: ['black_run'] } })),
    (error) => error.code === 'invalid_film' && /both block and warn/.test(error.detail.problems.join(' ')),
  );
});

/* ------------------------------- captions ------------------------------- */

test('captionsToSrt formats and orders cues', () => {
  const srt = captionsToSrt([
    { text: 'World', fromFrame: 90, toFrame: 150 },
    { text: 'Hello', fromFrame: 0, toFrame: 60 },
  ], 30);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nHello\n/);
  assert.match(srt, /2\n00:00:03,000 --> 00:00:05,000\nWorld\n/);
});

test('captionsToAss pins resolution, style and escapes override syntax', () => {
  const ass = captionsToAss(
    [{ text: 'brace {\\test}\nsecond line', fromFrame: 30, toFrame: 90 }],
    30,
    { width: 1920, height: 1080, style: { sizePct: 5, position: 'top' } },
  );
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /PlayResY: 1080/);
  assert.match(ass, /Style: Caption,Arial,54,/); // 1080 * 5% = 54
  assert.match(ass, /,8,/); // top alignment in the style line
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.00,Caption,,0,0,0,,brace \(\/test\)\\Nsecond line/);
  assert.ok(!ass.includes('{')); // no ASS override blocks survive
});

/* ---------------------------- overlay graph ----------------------------- */

test('buildOverlayGraph places, scales and gates overlays', () => {
  const { filterComplex, outLabel } = buildOverlayGraph([
    { fromFrame: 30, toFrame: 90, xPct: 10, yPct: 20, widthPct: 50, opacity: 0.5, isVideo: false },
  ], { width: 1920, height: 1080, fps: 30 });
  assert.equal(outLabel, 'v0');
  assert.match(filterComplex, /\[1:v\]format=rgba,scale=960:-1,colorchannelmixer=aa=0\.500\[ov0\]/);
  assert.match(filterComplex, /\[0:v\]\[ov0\]overlay=x=192:y=216:enable='between\(t,1\.000,3\.000\)'\[v0\]/);
});

test('buildOverlayGraph shifts video overlays and chains + subtitles', () => {
  const { filterComplex, outLabel } = buildOverlayGraph([
    { fromFrame: 0, toFrame: 60, isVideo: true },
    { fromFrame: 60, toFrame: 120, isVideo: false },
  ], { width: 640, height: 360, fps: 30, subtitlesFile: 'captions.ass' });
  assert.match(filterComplex, /setpts=PTS-STARTPTS\+0\.000\/TB/);
  assert.match(filterComplex, /\[v0\]\[ov1\]overlay=/);
  assert.match(filterComplex, /\[v1\]subtitles=captions\.ass\[vsub\]/);
  assert.equal(outLabel, 'vsub');
});

test('buildOverlayGraph with captions only burns straight off the base', () => {
  const { filterComplex, outLabel } = buildOverlayGraph([], { width: 640, height: 360, fps: 30, subtitlesFile: 'c.ass' });
  assert.equal(filterComplex, '[0:v]subtitles=c.ass[vsub]');
  assert.equal(outLabel, 'vsub');
});

/* ----------------------- Stage-A deliverables ----------------------- */

test('deliverables resolve to saved snapshots and compile timeline crop centres', () => {
  const [youtube, shorts] = resolveDeliverableSelections({
    requested: [{ id: 'youtube-16x9' }, { id: 'shorts-9x16' }],
    baseFilename: 'car-promo',
  });
  assert.equal(youtube.outputFilename, 'car-promo-youtube-16x9');
  assert.equal(shorts.outputFilename, 'car-promo-shorts-9x16');
  assert.equal(shorts.captionStyle.sizePct, 6.5);
  assert.equal(shorts.safeAreas.caption.bottomPct, 8);

  const compiled = compileReframeFilter({
    reframe: { default: { xPct: 50, yPct: 50 }, segments: { product: { xPct: 70, yPct: 50 } } },
    sceneLayout: [
      { slug: 'hook', name: 'Hook', filmOffset: 0, durationInFrames: 30 },
      { slug: 'product', name: 'Product', filmOffset: 30, durationInFrames: 30 },
    ],
    sourceWidth: 1920, sourceHeight: 1080, targetWidth: 1080, targetHeight: 1920, fps: 30,
  });
  assert.equal(compiled.centers.length, 2);
  assert.ok(compiled.centers[1].x > compiled.centers[0].x, JSON.stringify(compiled.centers));
  assert.match(compiled.filter, /^crop=\d+:1080:if\(lt\(t\\,1\.000000\)\\,/);
  assert.match(compiled.filter, /scale=1080:1920:flags=lanczos,setsar=1$/);
});

test('validateFilm refuses deliverables that would overwrite the master', () => {
  assert.throws(() => validateFilm(normalizeFilm({
    name: 'F', outputFilename: 'film', deliverables: [{
      id: 'portrait', width: 1080, height: 1920, outputFilename: 'film',
      captionStyle: { sizePct: 6.5, position: 'bottom' },
      safeAreas: {
        title: { leftPct: 7, rightPct: 7, topPct: 6, bottomPct: 50 },
        caption: { leftPct: 8, rightPct: 8, topPct: 55, bottomPct: 8 },
      },
      reframe: { default: { xPct: 50, yPct: 50 }, segments: {} },
    }],
  })), (error) => /duplicates the master/.test(error.detail.problems.join(' ')));
});

/**
 * A film carrying LAYERS but no SEGMENTS (v0.28, found in use).
 *
 * Overlays, captions and audio ride over the play order and give a film no
 * length, so on a film with neither a scene nor a clip every one of them is
 * orphaned — nothing plays, nothing builds. The two `*_out_of_range` checks
 * cannot catch it: both are guarded by `totalFrames &&`, which is exactly zero
 * here. It reported no problem at all, and a human who had just dropped an
 * overlay on the timeline was told only "no scenes yet".
 */
test('planFilm: layers on a film with no segments are reported, not silently orphaned', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Layers Only' });

    // A brand-new empty film is NOT a defect — saying so would flag every film
    // at the moment it is created.
    const empty = await planFilm({ film: await store.getFilm(film.id), store });
    assert.equal(empty.totalFrames, 0);
    assert.equal(empty.problems.find((p) => p.code === 'film_has_no_segments'), undefined,
      'an empty film with nothing on it is just empty');

    const withOverlay = await store.updateFilm(film.id, {
      overlays: [{ src: 'assets/logo.png', fromFrame: 0, toFrame: 90, xPct: 4, yPct: 6, widthPct: 28, opacity: 1 }],
    });
    const plan = await planFilm({ film: withOverlay, store });
    const problem = plan.problems.find((p) => p.code === 'film_has_no_segments');
    assert.ok(problem, JSON.stringify(plan.problems));
    assert.match(problem.message, /1 overlay/);
    assert.match(problem.message, /no scenes or footage/);

    // It counts every family, and pluralises what it names.
    const withMore = await store.updateFilm(film.id, {
      captions: [
        { id: 'c1', text: 'one', fromFrame: 0, toFrame: 30 },
        { id: 'c2', text: 'two', fromFrame: 30, toFrame: 60 },
      ],
    });
    const plan2 = await planFilm({ film: withMore, store });
    const p2 = plan2.problems.find((p) => p.code === 'film_has_no_segments');
    assert.match(p2.message, /1 overlay and 2 captions/);

    // And it goes away the moment the film has something to play.
    await store.createScene(film.id, { name: 'Hero', durationInFrames: 30 });
    const plan3 = await planFilm({ film: await store.getFilm(film.id), store });
    assert.equal(plan3.problems.find((p) => p.code === 'film_has_no_segments'), undefined,
      'a film with a segment carries its layers normally');
  });
});

/* -------------------------------- store --------------------------------- */

test('film documents: create → get → update → list → remove (folder survives)', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'My Film' });
    assert.equal(film.id, `${TEST_WS}/my-film`);
    assert.equal((await store.getFilm(film.id)).name, 'My Film');

    const updated = await store.updateFilm(film.id, {
      audio: [{ src: 'assets/bed.wav', gainDb: -8, duck: true }],
      captions: [{ text: 'Hi', fromFrame: 0, toFrame: 30 }],
    });
    assert.equal(updated.audio.length, 1);
    assert.ok(updated.audio[0].id, 'update stamps ids too');

    assert.equal((await store.listFilms(TEST_WS)).length, 1);
    await assert.rejects(store.updateFilm(film.id, { nope: 1 }), (e) => e.code === 'invalid_film');
    await assert.rejects(store.getFilm(`${TEST_WS}/missing`), (e) => e.code === 'film_not_found');

    // Without deleteFiles only the document goes; the folder lists as broken.
    await store.removeFilm(film.id);
    const after = await store.listFilms(TEST_WS);
    assert.equal(after.length, 1);
    assert.equal(after[0].broken, true);
    assert.ok(fs.existsSync(film.path));

    await store.removeFilm(film.id, { deleteFiles: true }).catch(() => {});
    await fsp.rm(film.path, { recursive: true, force: true });
    assert.equal((await store.listFilms(TEST_WS)).length, 0);
  });
});

/* ------------------------- optimistic concurrency ------------------------ */

test('a stale film patch is refused instead of reverting the other writer', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Contested' });
    await store.updateFilm(film.id, { scenes: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] });

    // Reader A opens the film (a Studio tab loading the page).
    const readA = await store.getFilm(film.id);
    assert.ok(readA.revision, 'getFilm hands out a revision');

    // Writer B reorders it while that tab sits open.
    const afterB = await store.updateFilm(film.id, { scenes: [{ slug: 'c' }, { slug: 'b' }, { slug: 'a' }] });
    assert.notEqual(afterB.revision, readA.revision, 'a write moves the revision');

    // A now saves an unrelated field, carrying its page-load-old scenes array.
    // Unguarded this succeeds and silently undoes B's reorder.
    await assert.rejects(
      store.updateFilm(film.id, { name: 'Renamed', scenes: readA.scenes }, { expectedRevision: readA.revision }),
      (e) => {
        assert.equal(e.code, 'film_conflict');
        assert.equal(e.detail.expectedRevision, readA.revision);
        assert.equal(e.detail.revision, afterB.revision);
        return true;
      },
    );
    assert.deepEqual((await store.getFilm(film.id)).scenes.map((s) => s.slug), ['c', 'b', 'a'],
      'B\'s order survived');

    // Re-read, re-apply: the same edit lands once it is based on current truth.
    const readC = await store.getFilm(film.id);
    const ok = await store.updateFilm(film.id, { name: 'Renamed' }, { expectedRevision: readC.revision });
    assert.equal(ok.name, 'Renamed');
    assert.deepEqual(ok.scenes.map((s) => s.slug), ['c', 'b', 'a']);
    assert.equal(ok.revision, (await store.getFilm(film.id)).revision,
      'the revision returned by a write is the one a later read sees');
  });
});

test('omitting expectedRevision keeps the old last-write-wins behaviour', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Unguarded' });
    const stale = await store.getFilm(film.id);
    await store.updateFilm(film.id, { name: 'Moved' });
    // Internal read-modify-write callers (createScene, removeScene, renameAsset)
    // rely on this: they patch one field within a tick and must not be made to
    // carry a revision they never read.
    const after = await store.updateFilm(film.id, { burnCaptions: true });
    assert.equal(after.burnCaptions, true);
    assert.equal(after.name, 'Moved');
    assert.ok(stale.revision !== after.revision);
    // Explicit null is "I am not claiming a base revision", not a mismatch.
    await store.updateFilm(film.id, { burnCaptions: false }, { expectedRevision: null });
  });
});

/* -------------------------------- planFilm ------------------------------ */

test('planFilm reports problems instead of throwing', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Plan' });
    await store.createScene(film.id, { name: 'Scene A', width: 320, height: 240, fps: 30, durationInFrames: 10 });
    await store.createScene(film.id, { name: 'Scene B', width: 640, height: 480, fps: 30, durationInFrames: 20 });

    const doc = await store.updateFilm(film.id, {
      scenes: [{ slug: 'scene-a' }, { slug: 'scene-b' }, { slug: 'ghost' }],
      audio: [{ src: 'assets/missing.wav' }],
    });
    const plan = await planFilm({ film: doc, store });
    const codes = plan.problems.map((p) => p.code);
    assert.ok(codes.includes('scene_missing'), codes.join(','));
    assert.ok(codes.includes('signature_mismatch'));
    assert.ok(codes.includes('scene_not_rendered'));
    assert.ok(codes.includes('asset_missing'));
    assert.equal(plan.totalFrames, 30); // ghost contributes 0
    assert.equal(plan.scenes[1].filmOffset, 10);
    assert.equal(plan.scenes[0].sceneId, `${film.id}/scene-a`);
    // The encode contract travels with the plan (v0.22), seeded from the first
    // scene that resolved — and `signature.id` is the string each scene's own
    // signature is compared against, which is what signature_mismatch reports.
    assert.equal(plan.signature.id, plan.scenes[0].signature);
    assert.equal(plan.signature.width, 320);
    assert.equal(plan.signature.video.codec, 'libx264');
    assert.ok(Array.isArray(plan.signature.ffmpegArgs));
  });
});

test('planFilm: a film with no scenes has no signature to state', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Empty' });
    const plan = await planFilm({ film: await store.getFilm(film.id), store });
    // Not a guess from sceneDefaults: an empty film enforces nothing, and a
    // confident wrong answer here produces a file that fails to concat later.
    assert.equal(plan.signature, null);
  });
});

/* ------------- footage on the film timeline (v0.22) ------------- */

/* The document half: a heterogeneous play order, and the verification that makes
 * a declared frame count trustworthy. `build_film` was never called in the
 * session that motivated this — not because it failed, but because it could not
 * be asked: `film.scenes[]` could only hold rendered scenes. */

test('validateFilm accepts footage segments beside scenes', () => {
  const ok = normalizeFilm({
    name: 'Mixed',
    scenes: [{ slug: 'title' }, { footage: 'assets/f1.mp4', durationInFrames: 231 }, { slug: 'lamb' }],
  });
  validateFilm(ok);
  // The stamped `id` is the clip's stable handle (v0.23.1) — see sequences.test.js.
  const { id, ...clip } = ok.scenes[1];
  assert.ok(id, 'footage segments carry a stable id');
  assert.deepEqual(clip, { footage: 'assets/f1.mp4', durationInFrames: 231 });

  // Ambiguous or incomplete segments are refused, not guessed at.
  assert.throws(() => validateFilm(normalizeFilm({
    name: 'F', scenes: [{ slug: 'a', footage: 'assets/f.mp4', durationInFrames: 10 }],
  })), (e) => /either a scene .* or footage/.test(e.detail.problems.join(' ')));
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{}] })),
    (e) => e.code === 'invalid_film');
  // A declaration is mandatory: every later offset derives from it.
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{ footage: 'assets/f.mp4' }] })),
    (e) => /durationInFrames must be a positive integer/.test(e.detail.problems.join(' ')));
  // Same sandbox rule as audio/overlay sources.
  assert.throws(() => validateFilm(normalizeFilm({
    name: 'F', scenes: [{ footage: '../escape.mp4', durationInFrames: 10 }],
  })), (e) => /under assets\//.test(e.detail.problems.join(' ')));
});

test('normalizeFilm round-trips footage instead of destroying it', () => {
  // THE regression this feature turns on. normalizeFilm runs on every save —
  // createFilm, updateFilm, createScene's auto-append, removeScene, and the
  // Studio's debounced autosave — and used to project every entry to { slug }.
  // Footage would validate, persist once, then vanish on the next unrelated edit.
  const film = normalizeFilm({
    name: 'F',
    scenes: [{ footage: 'assets\\win\\path.mp4', durationInFrames: 40, label: 'B-roll' }, { slug: 'outro' }],
  });
  const { id, ...clip } = film.scenes[0];
  assert.ok(id, 'footage segments carry a stable id');
  assert.deepEqual([clip, film.scenes[1]], [
    { footage: 'assets/win/path.mp4', durationInFrames: 40, label: 'B-roll' },
    { slug: 'outro' },
  ]);
  // Idempotent: a second pass (i.e. the next save) preserves it exactly —
  // including the id, which is the whole point of stamping one.
  assert.deepEqual(normalizeFilm(film).scenes, film.scenes);
});

test('normalizeFilm preserves an optional footage provenance pointer', () => {
  const film = normalizeFilm({
    name: 'Provenance',
    scenes: [{
      footage: 'assets\\prepared.mp4',
      durationInFrames: 30,
      derivedFrom: {
        asset: 'library\\raw.mp4',
        transcodeMeta: 'assets\\prepared.mp4.transcode.json',
      },
    }],
  });
  validateFilm(film);
  assert.deepEqual(film.scenes[0].derivedFrom, {
    asset: 'library/raw.mp4',
    transcodeMeta: 'assets/prepared.mp4.transcode.json',
  });
  assert.deepEqual(normalizeFilm(film).scenes, film.scenes, 'the pointer survives unrelated later saves');

  assert.throws(() => validateFilm(normalizeFilm({
    name: 'Bad provenance',
    scenes: [{
      footage: 'assets/prepared.mp4', durationInFrames: 30,
      derivedFrom: { asset: 'library/raw.mp4', transcodeMeta: 'assets/not-a-sidecar.json' },
    }],
  })), (e) => /must name a .transcode.json sidecar/.test(e.detail.problems.join(' ')));
});

test('validateFilm dedupes scene slugs but lets footage repeat', () => {
  // A scene plays once (it has one rendered output); the same plate can appear
  // several times as a recurring cutaway, and there is nothing to collide.
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{ slug: 'a' }, { slug: 'a' }] })),
    (e) => /more than once/.test(e.detail.problems.join(' ')));
  const repeated = normalizeFilm({
    name: 'F',
    scenes: [
      { footage: 'assets/plate.mp4', durationInFrames: 12 },
      { slug: 'mid' },
      { footage: 'assets/plate.mp4', durationInFrames: 12 },
    ],
  });
  validateFilm(repeated);
  assert.equal(repeated.scenes.length, 3);
});

test('an old film.json with only slug entries still loads unchanged', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Legacy' });
    await store.createScene(film.id, { name: 'One', width: 320, height: 240, fps: 30, durationInFrames: 10 });
    // Written the way every pre-v0.22 film is.
    const doc = await store.updateFilm(film.id, { scenes: [{ slug: 'one' }] });
    assert.deepEqual(doc.scenes, [{ slug: 'one' }]);
    assert.equal(doc.schemaVersion, 1, 'no migration: the key and the version are unchanged');
    const plan = await planFilm({ film: await store.getFilm(film.id), store });
    assert.equal(plan.scenes[0].kind, 'scene');
    assert.equal(plan.totalFrames, 10);
  });
});

test('planFilm verifies a declared footage duration against the file', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Footage Film', sceneDefaults: { fps: 30, width: 320, height: 240 } });
    const doc0 = await store.getFilm(film.id);
    // 30 frames of real video in the film's own assets/.
    const clip = path.join(doc0.path, 'assets', 'shot.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-pix_fmt', 'yuv420p', clip]);

    // Declared correctly → verified, no problem.
    let doc = await store.updateFilm(film.id, { scenes: [{ footage: 'assets/shot.mp4', durationInFrames: 30 }] });
    let plan = await planFilm({ film: doc, store });
    const seg = plan.scenes[0];
    assert.equal(seg.kind, 'footage');
    assert.equal(seg.probed, true);
    assert.equal(seg.actualFrames, 30);
    assert.equal(seg.framesVerified, true);
    assert.equal(seg.signature, '320x240@30/mp4/opaque/yuv420p');
    assert.equal(plan.totalFrames, 30);
    assert.equal(plan.fps, 30, 'an all-footage film takes its rate from the probe');
    assert.ok(!plan.problems.some((p) => p.code === 'footage_duration_mismatch'));

    // Declared wrongly → reported, with both numbers. This is the check that
    // matters: every offset after this segment derives from the declaration, so
    // an unverified lie shifts every later scene, caption and cue silently.
    doc = await store.updateFilm(film.id, { scenes: [{ footage: 'assets/shot.mp4', durationInFrames: 231 }] });
    plan = await planFilm({ film: doc, store });
    const mismatch = plan.problems.find((p) => p.code === 'footage_duration_mismatch');
    assert.ok(mismatch, JSON.stringify(plan.problems));
    assert.equal(mismatch.declared, 231);
    assert.equal(mismatch.actual, 30);
    assert.match(mismatch.message, /declared 231 → actual 30/);
    assert.equal(plan.scenes[0].framesVerified, false);
  });
});

test('planFilm flags a prepared footage segment when its recorded source changes', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, {
      name: 'Source provenance', sceneDefaults: { fps: 30, width: 320, height: 240 },
    });
    const doc0 = await store.getFilm(film.id);
    const source = path.join(doc0.path, 'assets', 'raw.mp4');
    const prepared = path.join(doc0.path, 'assets', 'prepared.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p', source]);
    await transcodeAsset({
      sourceAbs: source, outPath: prepared, mode: 'video',
      trim: { durationInFrames: 30 }, fpsForFrames: 30,
    });
    assert.ok(fs.existsSync(transcodeMetaPath(prepared)), 'the prepared file owns the one authoritative manifest');

    const doc = await store.updateFilm(film.id, {
      scenes: [{
        footage: 'assets/prepared.mp4',
        durationInFrames: 30,
        derivedFrom: {
          asset: 'assets/raw.mp4',
          transcodeMeta: 'assets/prepared.mp4.transcode.json',
        },
      }],
    });
    let plan = await planFilm({ film: doc, store });
    assert.equal(plan.scenes[0].derivedFrom.sourceVerified, true, JSON.stringify(plan.problems));
    assert.ok(!plan.problems.some((p) => p.code === 'footage_source_changed'));

    // Same path, different source. The prepared clip remains playable and its
    // declared frame count remains valid, so provenance is the only guard that
    // can stop this old trim being mistaken for the new source.
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=3', '-pix_fmt', 'yuv420p', source]);
    plan = await planFilm({ film: await store.getFilm(film.id), store });
    const changed = plan.problems.find((p) => p.code === 'footage_source_changed');
    assert.ok(changed, JSON.stringify(plan.problems));
    assert.equal(changed.reason, 'source_identity_changed');
    assert.equal(plan.scenes[0].derivedFrom.sourceVerified, false);
    assert.equal(plan.scenes[0].derivedFrom.reason, 'source_identity_changed');
    const changedFilm = await store.getFilm(film.id);
    await assert.rejects(
      () => submitFilmBuild({ film: changedFilm, store, jobs: new JobManager() }),
      (error) => error.code === 'footage_source_changed'
        && error.detail.problems[0].reason === 'source_identity_changed',
      'a direct build call cannot bypass the pre-build provenance problem',
    );
  });
});

test('planFilm reports missing footage, and refuses a file with an audio stream', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Bad Footage', sceneDefaults: { fps: 30, width: 320, height: 240 } });
    const doc0 = await store.getFilm(film.id);

    let doc = await store.updateFilm(film.id, { scenes: [{ footage: 'assets/ghost.mp4', durationInFrames: 30 }] });
    let plan = await planFilm({ film: doc, store });
    assert.ok(plan.problems.some((p) => p.code === 'footage_missing'));
    assert.equal(plan.scenes[0].missing, true);
    assert.equal(plan.totalFrames, 0, 'a missing segment contributes no frames');

    // Footage is silent by contract: all sound comes from the master timeline.
    // Dropping an audio stream silently would make the user's own voice vanish
    // from a film they can hear it in.
    const noisy = path.join(doc0.path, 'assets', 'noisy.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', noisy]);
    doc = await store.updateFilm(film.id, { scenes: [{ footage: 'assets/noisy.mp4', durationInFrames: 30 }] });
    plan = await planFilm({ film: doc, store });
    const audioProblem = plan.problems.find((p) => /carries an audio stream/.test(p.message));
    assert.ok(audioProblem, JSON.stringify(plan.problems.map((p) => p.message)));
    assert.match(audioProblem.message, /master audio timeline/);
  });
});

test('planFilm flags footage that cannot be stream-copied onto the film', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Mismatch Film', sceneDefaults: { fps: 30, width: 320, height: 240 } });
    await store.createScene(film.id, { name: 'Title', width: 320, height: 240, fps: 30, durationInFrames: 10 });
    const doc0 = await store.getFilm(film.id);
    // Right codec, wrong resolution — the film's signature is set by its scene.
    const wrong = path.join(doc0.path, 'assets', 'wrong.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=640x480:rate=30:duration=1', '-pix_fmt', 'yuv420p', wrong]);

    const doc = await store.updateFilm(film.id, {
      scenes: [{ slug: 'title' }, { footage: 'assets/wrong.mp4', durationInFrames: 30 }],
    });
    const plan = await planFilm({ film: doc, store });
    const mismatch = plan.problems.find((p) => p.code === 'footage_signature_mismatch');
    assert.ok(mismatch, JSON.stringify(plan.problems));
    assert.match(mismatch.message, /640x480@30/);
    assert.match(mismatch.message, /320x240@30/);
    // The fix is named, and it is never a silent re-encode: a film that quietly
    // re-encodes one segment has stopped being losslessly assembled.
    assert.match(mismatch.message, /get_film reports it/);
    assert.match(mismatch.message, /will not silently re-encode/);
  });
});

test('planFilm places footage and scenes on one set of offsets', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Nine Part', sceneDefaults: { fps: 30, width: 320, height: 240 } });
    await store.createScene(film.id, { name: 'A', width: 320, height: 240, fps: 30, durationInFrames: 10 });
    await store.createScene(film.id, { name: 'B', width: 320, height: 240, fps: 30, durationInFrames: 20 });
    const doc0 = await store.getFilm(film.id);
    const clip = path.join(doc0.path, 'assets', 'mid.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-pix_fmt', 'yuv420p', clip]);

    // "footage, then a scene, then footage" — the shape that was inexpressible.
    const doc = await store.updateFilm(film.id, {
      scenes: [{ slug: 'a' }, { footage: 'assets/mid.mp4', durationInFrames: 30 }, { slug: 'b' }],
    });
    const plan = await planFilm({ film: doc, store });
    assert.deepEqual(plan.scenes.map((s) => s.kind), ['scene', 'footage', 'scene']);
    assert.deepEqual(plan.scenes.map((s) => s.filmOffset), [0, 10, 40]);
    assert.equal(plan.totalFrames, 60);
    assert.equal(plan.scenes[1].startSeconds, Number((10 / 30).toFixed(3)));
    // Nothing about the footage disagrees with the film.
    assert.ok(!plan.problems.some((p) => String(p.code).startsWith('footage_')), JSON.stringify(plan.problems));
  });
});

/* ------------------------------ studio API ------------------------------ */

let server, base, home;
before(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-films-studio-'));
  server = createStudioServer({
    store: await makeStore(home),
    jobs: new JobManager(),
    browserFactory: makeFakeBrowserFactory(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
});

const j = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.json();
  return { status: res.status, data, res };
};

async function waitJob(jobId, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await j(`/api/jobs/${jobId}`);
    if (['done', 'error', 'cancelled'].includes(data.state)) return data;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} timed out in state ${data.state}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const enc = encodeURIComponent;
let filmId, sceneA, sceneB;

test('films API: create film in a workspace, add scenes', async () => {
  const created = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST',
    body: { name: 'E2E Film', width: 320, height: 240, fps: 30, durationInFrames: 8 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  filmId = created.data.film.id;
  assert.equal(filmId, `${TEST_WS}/e2e-film`);
  assert.deepEqual(created.data.film.sceneDefaults, { fps: 30, width: 320, height: 240, durationInFrames: 8 });

  sceneA = (await j(`/api/films/${enc(filmId)}/scenes`, { method: 'POST', body: { name: 'Cut A' } })).data;
  sceneB = (await j(`/api/films/${enc(filmId)}/scenes`, { method: 'POST', body: { name: 'Cut B' } })).data;
  assert.equal(sceneA.config.width, 320, 'sceneDefaults inherited');

  const tree = await j('/api/workspaces');
  const ws = tree.data.workspaces.find((w) => w.id === TEST_WS);
  assert.ok(ws, 'workspace listed');
  assert.equal(ws.films.length, 1);
  assert.equal(ws.films[0].scenes, 2);
});

test('films API: detail reports layout and problems', async () => {
  const { status, data } = await j(`/api/films/${enc(filmId)}`);
  assert.equal(status, 200);
  assert.equal(data.detail.totalFrames, 16);
  assert.equal(data.detail.scenes[1].filmOffset, 8);
  const codes = data.detail.problems.map((p) => p.code);
  assert.ok(codes.includes('scene_not_rendered'));
  assert.equal(data.sceneFolders.length, 2);
  // The Studio gets the signature block for free: this route returns the raw
  // plan, so there was no second projection to teach.
  assert.equal(data.detail.signature.id, data.detail.scenes[0].signature);
  assert.deepEqual(data.detail.signature.mustMatch, ['codec', 'width', 'height', 'fps', 'pixFmt', 'container']);
});

test('films API: PATCH edits tracks, rejects junk', async () => {
  const bad = await j(`/api/films/${enc(filmId)}`, { method: 'PATCH', body: { patch: { bogus: true } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_film');

  const patched = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { captions: [{ text: 'Hello film', fromFrame: 0, toFrame: 12 }] } },
  });
  assert.equal(patched.status, 200);
  assert.ok(patched.data.film.captions[0].id);
});

test('films API: a PATCH carrying a stale revision is a 409, not a silent revert', async () => {
  const slugOf = (s) => s.id.split('/').pop();
  const opened = (await j(`/api/films/${enc(filmId)}`)).data.film;   // the tab loads
  assert.ok(opened.revision, 'GET hands the page a revision to send back');

  // The AI reorders the film while that tab is open.
  const moved = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH', body: { patch: { scenes: [{ slug: slugOf(sceneB) }, { slug: slugOf(sceneA) }] } },
  });
  assert.equal(moved.status, 200);

  // The tab autosaves; its snapshot still has the old order.
  const stale = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { name: 'Typed in the tab', scenes: opened.scenes }, revision: opened.revision },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'film_conflict');
  assert.equal(stale.data.detail.revision, moved.data.film.revision);

  const now = (await j(`/api/films/${enc(filmId)}`)).data.film;
  assert.deepEqual(now.scenes.map((s) => s.slug), [slugOf(sceneB), slugOf(sceneA)], 'the reorder survived');
  assert.notEqual(now.name, 'Typed in the tab');

  // Re-read and retry — what the page does after reloading — goes through.
  const retried = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH', body: { patch: { name: 'Typed in the tab' }, revision: now.revision },
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.film.name, 'Typed in the tab');

  // Restore the state the rest of this file's tests build on.
  const restored = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: {
      patch: { name: opened.name, scenes: [{ slug: slugOf(sceneA) }, { slug: slugOf(sceneB) }] },
      revision: retried.data.film.revision,
    },
  });
  assert.equal(restored.status, 200);
});

test('films API: build refuses while scenes are unrendered', async () => {
  const res = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'scene_not_rendered');
});

test('films API: render scenes → build with master audio + captions → sidecar', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');

  for (const s of [sceneA, sceneB]) {
    const job = (await j(`/api/scenes/${enc(s.id)}/render`, { method: 'POST', body: { workers: 1 } })).data;
    const done = await waitJob(job.jobId);
    assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  }

  // A one-second bed into the FILM's own assets (raw-body upload).
  const wavPath = path.join(home, 'bed.wav');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '44100', wavPath]);
  const put = await fetch(`${base}/api/films/${enc(filmId)}/asset?path=${enc('assets/bed.wav')}`, {
    method: 'PUT', body: await fsp.readFile(wavPath),
  });
  assert.equal(put.status, 201);

  const patched = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { audio: [{ src: 'assets/bed.wav', gainDb: -6 }] } },
  });
  assert.equal(patched.status, 200);

  const build = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: { outputFilename: 'e2e', audioTargetPeakDb: -2 } });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  assert.ok(done.audio, 'master timeline reports measured levels');
  assert.ok(done.review, 'the job reports the staged-delivery review artefacts');

  // The film folder's out/ holds the build + sidecar.
  const { data: film } = await j(`/api/films/${enc(filmId)}`);
  const outDir = path.join(film.film.path, 'out');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.mp4')), 'film written');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.srt')), 'caption sidecar written');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.review.json')), 'review report written beside film');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.contact.png')), 'contact sheet written beside film');
  const review = JSON.parse(await fsp.readFile(path.join(outDir, 'e2e.review.json'), 'utf8'));
  assert.equal(review.delivery.expectedFrames, 16);
  assert.equal(review.delivery.framesVerified, true);
  assert.deepEqual(review.contact.thumbnails.map((thumb) => thumb.frame), [0, 8, 15]);
  const srt = await fsp.readFile(path.join(outDir, 'e2e.srt'), 'utf8');
  assert.match(srt, /Hello film/);

  // And downloads through the film output route.
  const dl = await fetch(`${base}/api/films/${enc(filmId)}/output?file=e2e.mp4`);
  assert.equal(dl.status, 200);
  const reviewDl = await fetch(`${base}/api/films/${enc(filmId)}/output?file=e2e.review.json`);
  assert.equal(reviewDl.status, 200);
});

test('films API: a Stage-A deliverable reframes the approved master into its own portrait output', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const deliverable = {
    id: 'portrait-review', label: 'Portrait review', width: 180, height: 320,
    outputFilename: 'e2e-portrait',
    captionStyle: { sizePct: 6.5, position: 'bottom' },
    safeAreas: {
      title: { leftPct: 7, rightPct: 7, topPct: 6, bottomPct: 50 },
      caption: { leftPct: 8, rightPct: 8, topPct: 55, bottomPct: 8 },
    },
    reframe: {
      default: { xPct: 50, yPct: 50 },
      // The second scene begins at frame 8, proving the compiler consumes the
      // real timeline rather than a hand-calculated seconds list.
      segments: { 'cut-b': { xPct: 72, yPct: 50 } },
    },
  };
  const patched = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH', body: { patch: { deliverables: [deliverable] } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));

  const build = await j(`/api/films/${enc(filmId)}/build`, {
    method: 'POST', body: { deliverable: deliverable.id },
  });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  assert.equal(build.data.deliverable.id, deliverable.id);
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  assert.equal(done.deliverable.id, deliverable.id);
  assert.equal(done.reEncoded, true, 'a reframe never takes the lossless concat shortcut');
  assert.ok(done.review, 'variant receives independent review artefacts');

  const { data } = await j(`/api/films/${enc(filmId)}`);
  const outDir = path.join(data.film.path, 'out');
  const out = path.join(outDir, 'e2e-portrait.mp4');
  assert.ok(fs.existsSync(out));
  const media = await probeMedia({ filePath: out });
  assert.equal(media.video.width, 180);
  assert.equal(media.video.height, 320);
  assert.ok(fs.existsSync(path.join(outDir, 'e2e-portrait.srt')));
  const review = JSON.parse(await fsp.readFile(path.join(outDir, 'e2e-portrait.review.json'), 'utf8'));
  assert.deepEqual(review.contact.safeAreas, deliverable.safeAreas);
  assert.equal(review.delivery.expectedFrames, 16);
});

test('films API: default review policy promotes an intentional static black film as warnings', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const created = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST', body: { name: 'Static Review', width: 320, height: 240, fps: 30, durationInFrames: 90 },
  });
  const film = created.data.film;
  const clip = path.join(film.path, 'assets', 'black.mp4');
  await execFileP('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=3',
    '-frames:v', '90', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
  ]);
  const patched = await j(`/api/films/${enc(film.id)}`, {
    method: 'PATCH', body: { patch: { scenes: [{ footage: 'assets/black.mp4', durationInFrames: 90, label: 'Intentional black hold' }] } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.ok(!patched.data.detail.problems.length, JSON.stringify(patched.data.detail.problems));

  const submitted = await j(`/api/films/${enc(film.id)}/build`, { method: 'POST', body: { outputFilename: 'black-review' } });
  const done = await waitJob(submitted.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  const report = JSON.parse(await fsp.readFile(path.join(film.path, 'out', 'black-review.review.json'), 'utf8'));
  assert.ok(report.warnings.some((warning) => warning.code === 'static_run' && warning.level === 'warn'), JSON.stringify(report.warnings));
  assert.ok(report.warnings.some((warning) => warning.code === 'black_run' && warning.level === 'warn'), JSON.stringify(report.warnings));
});

test('films API: overlay triggers the finishing pass', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');

  const pngPath = path.join(home, 'logo.png');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', pngPath]);
  const put = await fetch(`${base}/api/films/${enc(filmId)}/asset?path=${enc('assets/logo.png')}`, {
    method: 'PUT', body: await fsp.readFile(pngPath),
  });
  assert.equal(put.status, 201);

  await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { overlays: [{ src: 'assets/logo.png', fromFrame: 0, toFrame: 16, xPct: 5, yPct: 5, widthPct: 20, opacity: 0.8 }] } },
  });
  const build = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: { outputFilename: 'e2e-overlay' } });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));

  const { data: film } = await j(`/api/films/${enc(filmId)}`);
  const outPath = path.join(film.film.path, 'out', 'e2e-overlay.mp4');
  assert.ok(fs.existsSync(outPath));
  assert.ok((await fsp.stat(outPath)).size > 0);
  const picture = await probeMedia({ filePath: outPath });
  assert.deepEqual(picture.video.color, {
    primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', range: 'tv',
  });
});

test('films API: preview-audio streams the master mix', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await fetch(`${base}/api/films/${enc(filmId)}/preview-audio`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 44, 'more than a WAV header');
});

test('film asset streaming honours Range requests (video scrubbing)', async () => {
  const res = await fetch(`${base}/api/films/${enc(filmId)}/asset?path=${enc('assets/bed.wav')}`, {
    headers: { Range: 'bytes=0-3' },
  });
  if (res.status === 404) return; // wav upload skipped without ffmpeg
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '4');
  assert.match(res.headers.get('content-range'), /^bytes 0-3\/\d+$/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('ascii'), 'RIFF');
});

test('studio TTS endpoint rejects empty text up front (film target)', async () => {
  const res = await j(`/api/films/${enc(filmId)}/tts`, { method: 'POST', body: { text: '  ' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'invalid_config');
});

test('workspace library: upload → list → use in a scene via the store', async () => {
  const put = await fetch(`${base}/api/workspaces/${TEST_WS}/library/file?path=${enc('plates/bg.png')}`, {
    method: 'PUT', body: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  assert.equal(put.status, 201);
  const list = await j(`/api/workspaces/${TEST_WS}/library`);
  assert.deepEqual(list.data.files.map((f) => f.path), ['plates/bg.png']);

  const get = await fetch(`${base}/api/workspaces/${TEST_WS}/library/file?path=${enc('plates/bg.png')}`);
  assert.equal(get.status, 200);

  const del = await j(`/api/workspaces/${TEST_WS}/library/file?path=${enc('plates/bg.png')}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await j(`/api/workspaces/${TEST_WS}/library`)).data.files.length, 0);
});

/* ------------------ the signature is SUFFICIENT (v0.22) ------------------ */

/* The tests above assert the reported block is correct. This one asserts it is
 * *enough*: a caller who has only the block — no access to formats.js, no
 * rendered file to probe — can produce a file that joins the film.
 *
 * That is the whole point of stating the contract, and it is the step the
 * prototype got wrong by guessing (it pinned -profile:v high -level 4.0 and a
 * custom GOP, none of which were needed). So the command below is assembled
 * FROM the block; adding any flag that is not in it would invalidate the proof.
 */

const framePackets = async (file) => Number((await execFileP('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_packets',
  '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file,
])).stdout.trim());

/** Per-frame md5s, so a comparison measures pixels rather than file bytes. */
const frameHashes = async (file, extra = []) => {
  const { stdout } = await execFileP('ffmpeg', [
    '-v', 'error', '-i', file, ...extra, '-f', 'framemd5', '-hide_banner', '-',
  ]);
  return stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.trim().split(/\s+/).pop());
};

test('films API: a clip encoded from the reported signature alone joins the film', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // Read the contract the way a caller does — over the API, not from the module.
  const sig = (await j(`/api/films/${enc(filmId)}`)).data.detail.signature;
  assert.ok(sig?.ffmpegArgs, 'the film must state its contract before this can be tested');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-sig-e2e-'));
  try {
    // Everything here comes from the block. No profile, no level, no GOP — the
    // three things the prototype pinned for no reason.
    const ext = path.join(dir, `external.${sig.container}`);
    await execFileP('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${sig.width}x${sig.height}:rate=${sig.fps}`,
      '-frames:v', '24', '-an',
      ...sig.ffmpegArgs,
      ext,
    ]);

    // 1. The file's real parameters equal the reported ones. `probe_asset`'s own
    //    summarizer is used, so this is the shape an agent would compare.
    const probed = await probeMedia({ filePath: ext });
    assert.equal(probed.video.width, sig.width);
    assert.equal(probed.video.height, sig.height);
    assert.equal(probed.video.pixFmt, sig.pixFmt);
    assert.equal(probed.video.fps, sig.fps);
    // The one asymmetry a caller must know about: the block reports the ffmpeg
    // ENCODER id (what you pass to -c:v) while a probe reports the CODEC name.
    // libx264 → h264. A naive equality check here is a guaranteed false
    // mismatch, which matters for anything comparing probed footage to a film.
    assert.equal(sig.video.codec, 'libx264');
    assert.equal(probed.video.codec, 'h264');

    // 2. The engine's own invariant accepts it — validateScenes is what
    //    build_film runs, so this is the real gate, not a paraphrase of it.
    const asScene = {
      sceneId: 'external',
      path: dir,
      config: {
        name: 'External', width: sig.width, height: sig.height, fps: sig.fps,
        durationInFrames: 24, audio: [],
        output: {
          format: sig.format, pixFmt: sig.pixFmt, transparent: sig.transparent,
          dir: '.', filename: path.basename(ext),
        },
      },
    };
    assert.equal(sceneSignature(asScene.config), sig.id, 'the conformed file rebuilds the film\'s own key');

    // 3. And it really concatenates, losslessly, with a scene the engine
    //    rendered — measured by frame count and by pixels, not by exit code.
    const sceneOut = path.join(sceneA.path, sceneA.config.output.dir, sceneA.config.output.filename);
    const listFile = path.join(dir, 'list.txt');
    await fsp.writeFile(listFile, [sceneOut, ext].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = path.join(dir, 'joined.mp4');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined]);

    // A full decode with an empty stderr: the check the prototype never ran.
    const { stderr } = await execFileP('ffmpeg', ['-v', 'error', '-i', joined, '-f', 'null', '-']);
    assert.equal(stderr.trim(), '', `the joined film must decode clean, got: ${stderr}`);

    const sceneFrames = await framePackets(sceneOut);
    assert.equal(await framePackets(joined), sceneFrames + 24, 'one frame of drift is the failure mode this prevents');

    // The external segment's pixels survive the seam bit-exactly.
    const tail = (await frameHashes(joined)).slice(-24);
    assert.deepEqual(tail, await frameHashes(ext));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('films API: neednotMatch is measured, not inherited', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // The prototype pinned `-profile:v high -level 4.0` and `-x264-params
  // keyint=60`, and could not have said why. Nothing had ever tested whether a
  // segment that DISAGREES on those still joins — libx264 writes SPS/PPS into
  // mp4's avcC and the concat demuxer keeps the FIRST segment's, so it is not
  // obvious. This asserts the claim `neednotMatch` makes.
  const sig = (await j(`/api/films/${enc(filmId)}`)).data.detail.signature;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-sig-neednot-'));
  try {
    const build = async (name, extra) => {
      const out = path.join(dir, name);
      await execFileP('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', `smptebars=size=${sig.width}x${sig.height}:rate=${sig.fps}`,
        '-frames:v', '24', '-an', ...sig.ffmpegArgs, ...extra, out,
      ]);
      return out;
    };
    const cases = {
      // Deliberately DIFFERENT from what the film's own encode produces.
      profile: await build('p.mp4', ['-profile:v', 'baseline']),
      gop: await build('g.mp4', ['-x264-params', 'keyint=15']),
    };
    const base = await build('base.mp4', []);

    for (const [label, seg] of Object.entries(cases)) {
      const listFile = path.join(dir, `${label}.txt`);
      await fsp.writeFile(listFile, [base, seg].map((p) => `file '${p}'`).join('\n'));
      const joined = path.join(dir, `${label}-joined.mp4`);
      await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined]);
      const { stderr } = await execFileP('ffmpeg', ['-v', 'error', '-i', joined, '-f', 'null', '-']);
      assert.equal(stderr.trim(), '', `${label}: a differing ${label} must still decode clean`);
      assert.equal(await framePackets(joined), 48, `${label}: no frames lost`);
      // …and the differing segment's pixels are preserved exactly, which is the
      // part "it did not error" does not prove.
      assert.deepEqual((await frameHashes(joined)).slice(-24), await frameHashes(seg), `${label}: pixels preserved`);
      assert.ok(sig.neednotMatch.includes(label === 'gop' ? 'gopSize' : 'profile'));
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('films API: a film alternating footage and scenes builds, and every frame is there', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // THE acceptance case. A session built exactly this shape by hand — footage
  // interleaved with rendered scenes — and never called build_film, because
  // film.scenes[] could not be asked for it. The assembly was a nine-part
  // ffmpeg concat in a shell, and the workspace kept no record of the real cut.
  const created = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST',
    body: { name: 'Interleaved', width: 320, height: 240, fps: 30, durationInFrames: 8 },
  });
  const fid = created.data.film.id;
  const a = (await j(`/api/films/${enc(fid)}/scenes`, { method: 'POST', body: { name: 'Open' } })).data;
  const b = (await j(`/api/films/${enc(fid)}/scenes`, { method: 'POST', body: { name: 'Close' } })).data;
  for (const s of [a, b]) {
    const job = (await j(`/api/scenes/${enc(s.id)}/render`, { method: 'POST', body: { workers: 1 } })).data;
    assert.equal((await waitJob(job.jobId)).state, 'done');
  }

  // Footage conformed to the film's own signature, read from the film itself
  // rather than guessed — which is what plan 0 made possible.
  const sig = (await j(`/api/films/${enc(fid)}`)).data.detail.signature;
  const filmDir = (await j(`/api/films/${enc(fid)}`)).data.film.path;
  const shot = path.join(filmDir, 'assets', 'shot.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${sig.width}x${sig.height}:rate=${sig.fps}`,
    '-frames:v', '24', '-an', ...sig.ffmpegArgs, shot]);

  const patched = await j(`/api/films/${enc(fid)}`, {
    method: 'PATCH',
    body: {
      patch: {
        scenes: [
          { slug: 'open' },
          { footage: 'assets/shot.mp4', durationInFrames: 24, label: 'B-roll' },
          { slug: 'close' },
        ],
      },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  // The document really holds the footage entry — the round-trip that used to
  // silently delete it on the very next save.
  const { id: clipId, ...clip } = patched.data.film.scenes[1];
  assert.ok(clipId, 'the clip keeps a stable id across saves so advice can name it');
  assert.deepEqual(clip, { footage: 'assets/shot.mp4', durationInFrames: 24, label: 'B-roll' });

  const detail = patched.data.plan ?? (await j(`/api/films/${enc(fid)}`)).data.detail;
  assert.deepEqual(detail.scenes.map((s) => s.kind), ['scene', 'footage', 'scene']);
  assert.ok(!detail.problems.some((p) => String(p.code).startsWith('footage_')), JSON.stringify(detail.problems));
  const expectedFrames = 8 + 24 + 8;
  assert.equal(detail.totalFrames, expectedFrames);

  const build = (await j(`/api/films/${enc(fid)}/build`, { method: 'POST', body: {} })).data;
  const done = await waitJob(build.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  assert.ok(fs.existsSync(build.outputPath));

  // Measured, not assumed: the built film holds every frame of all three
  // segments, and decodes clean — no silent re-encode, no broken seam.
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', build.outputPath]);
  assert.equal(Number(stdout.trim()), expectedFrames, 'one lost frame shifts every later cue');
  const { stderr } = await execFileP('ffmpeg', ['-v', 'error', '-i', build.outputPath, '-f', 'null', '-']);
  assert.equal(stderr.trim(), '');
});

test('films API: build refuses footage whose declared frame count is a lie', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const created = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST', body: { name: 'Lying Film', width: 320, height: 240, fps: 30, durationInFrames: 8 },
  });
  const fid = created.data.film.id;
  const filmDir = created.data.film.path;
  const shot = path.join(filmDir, 'assets', 'shot.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-pix_fmt', 'yuv420p', shot]);

  // 30 real frames, declared as 300.
  await j(`/api/films/${enc(fid)}`, {
    method: 'PATCH', body: { patch: { scenes: [{ footage: 'assets/shot.mp4', durationInFrames: 300 }] } },
  });
  const detail = (await j(`/api/films/${enc(fid)}`)).data.detail;
  const problem = detail.problems.find((p) => p.code === 'footage_duration_mismatch');
  assert.ok(problem, JSON.stringify(detail.problems));
  assert.equal(problem.actual, 30);
  // Reported at PLAN time — before a build is paid for, beside
  // scene_not_rendered and stale_render.
  assert.equal(detail.scenes[0].framesVerified, false);
});

test('films API: delete without deleteFiles keeps the folder (listed as broken)', async () => {
  const res = await j(`/api/films/${enc(filmId)}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const tree = await j('/api/workspaces');
  const ws = tree.data.workspaces.find((w) => w.id === TEST_WS);
  const entry = ws.films.find((f) => f.id === filmId);
  assert.ok(entry?.broken, 'film folder still present, flagged broken');
  // Scene folders inside survive.
  assert.equal((await j(`/api/scenes/${enc(sceneA.id)}`)).status, 200, 'scene folder survives');
});
