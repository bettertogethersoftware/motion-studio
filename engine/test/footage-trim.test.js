/**
 * Trimming a footage segment (v0.28).
 *
 * The claim is narrow and measurable: the segment ends up playing a file that
 * really has the frames it declares, the film still plans, the original is
 * still there, and the cheap path is taken whenever it is honest. So that is
 * what is asserted — on real encodes, because the whole feature is a statement
 * about what ffmpeg does with keyframes.
 *
 * The fixture matters. Two clips are built from the same source: one with
 * `-g 10` (what the engine's own footage preparation produces, keyframes every
 * 10 frames) and one with `-g 250` (what a screen recording looks like). The
 * difference between them IS the feature.
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
import {
  trimFootage, keyframeGrid, keyframeAtOrBefore, trimSignature, acceptShortTail,
  COARSE_GRID_FRAMES, TAIL_SLACK_FRAMES,
} from '../src/core/footage-trim.js';
import { planFilm } from '../src/core/films.js';

const execFileP = promisify(execFile);
let tmp, fineSrc, coarseSrc, haveFfmpeg = true;

const FPS = 30;
const FRAMES = 300;          // ten seconds
const W = 320, H = 240;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-footage-trim-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (!haveFfmpeg) return;
  const make = async (file, gop) => {
    await execFileP('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${FRAMES / FPS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-frames:v', String(FRAMES), file]);
    return file;
  };
  // gop 10 = what the engine's footage preparation writes; gop 250 = a recording.
  fineSrc = await make(path.join(tmp, 'fine.mp4'), 10);
  coarseSrc = await make(path.join(tmp, 'coarse.mp4'), 250);
});
after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

const countFrames = async (file) => {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return Number(String(stdout).trim().split(',')[0]);
};

/** A film whose play order is one footage segment, from the named fixture. */
async function filmWith(dataDir, src, { withScene = false } = {}) {
  const store = await makeStore(dataDir);
  const film = await store.createFilm(TEST_WS, {
    name: 'Trim Film', sceneDefaults: { fps: FPS, width: W, height: H, durationInFrames: FRAMES },
  });
  await fsp.mkdir(path.join(film.path, 'assets'), { recursive: true });
  await fsp.copyFile(src, path.join(film.path, 'assets', 'clip.mp4'));
  if (withScene) {
    await store.createScene(film.id, { name: 'Head', fps: FPS, width: W, height: H, durationInFrames: 30 });
  }
  const saved = await store.updateFilm(film.id, {
    scenes: [
      ...(withScene ? [{ slug: 'head' }] : []),
      { footage: 'assets/clip.mp4', durationInFrames: FRAMES, label: 'Clip', sequence: 'Body' },
    ],
  });
  const seg = saved.scenes.find((s) => s.footage !== undefined);
  return { store, film: saved, segmentId: seg.id };
}

/* ------------------------------------------------------------------ */
/* The grid, which is what decides everything else                     */
/* ------------------------------------------------------------------ */

test('the keyframe grid tells a prepared clip from a supplied one',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const fine = await keyframeGrid({ filePath: fineSrc, fps: FPS });
    assert.ok(fine.count > 20, `expected many keyframes, got ${fine.count}`);
    assert.ok(fine.intervalFrames <= COARSE_GRID_FRAMES, `interval ${fine.intervalFrames}`);
    assert.equal(fine.coarse, false, 'a 10-frame GOP is a usable edit grid');
    assert.equal(fine.frames[0], 0, 'frame 0 is always a keyframe');

    const coarse = await keyframeGrid({ filePath: coarseSrc, fps: FPS });
    assert.ok(coarse.intervalFrames === null || coarse.intervalFrames > COARSE_GRID_FRAMES,
      `a 250-frame GOP must read as coarse, got ${coarse.intervalFrames}`);
    assert.equal(coarse.coarse, true);
  });

test('an unreadable file yields no grid rather than an error', async () => {
  const grid = await keyframeGrid({ filePath: path.join(tmp, 'nope.mp4'), fps: 30 });
  assert.deepEqual(grid.frames, []);
  assert.equal(grid.coarse, true, 'unknown means no cheap path, never a crash');
});

test('keyframeAtOrBefore lands on or before, never after', () => {
  const g = [0, 10, 20, 30];
  assert.equal(keyframeAtOrBefore(g, 0), 0);
  assert.equal(keyframeAtOrBefore(g, 9), 0);
  assert.equal(keyframeAtOrBefore(g, 10), 10);
  assert.equal(keyframeAtOrBefore(g, 25), 20);
  assert.equal(keyframeAtOrBefore(g, 999), 30);
  assert.equal(keyframeAtOrBefore([], 5), null);
});

/* ------------------------------------------------------------------ */
/* The cheap path                                                      */
/* ------------------------------------------------------------------ */

test('a tail trim is always a copy — frame 0 is a keyframe',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, coarseSrc);   // even a COARSE clip
    const r = await trimFootage({ store, filmId: film.id, segmentId, durationInFrames: 120 });

    assert.equal(r.method, 'copy', 'a tail trim never needs a re-encode, whatever the GOP');
    assert.equal(r.startFrame, 0);
    assert.equal(r.durationInFrames, 120);
    assert.equal(r.framesVerified, true);
    assert.equal(await countFrames(path.join(film.path, r.file)), 120, 'the file really has them');
  });

test('a head trim that lands on a keyframe is a copy, and keeps the segment\'s other fields',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    const r = await trimFootage({ store, filmId: film.id, segmentId, startInFrames: 60, durationInFrames: 90 });

    assert.equal(r.method, 'copy');
    assert.equal(r.startFrame, 60);
    assert.equal(r.snappedByFrames, 0);
    assert.equal(await countFrames(path.join(film.path, r.file)), 90);

    const after = await store.getFilm(film.id);
    const seg = after.scenes.find((s) => s.footage !== undefined);
    assert.equal(seg.footage, r.file);
    assert.equal(seg.durationInFrames, 90);
    assert.equal(seg.id, segmentId, 'the segment keeps its identity, so advice bound to it survives');
    assert.equal(seg.label, 'Clip');
    assert.equal(seg.sequence, 'Body', 'and its narrative band');
  });

test('the original file is left in assets/, so the trim is reversible',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    const r = await trimFootage({ store, filmId: film.id, segmentId, durationInFrames: 100 });
    assert.ok(fs.existsSync(path.join(film.path, 'assets', 'clip.mp4')), 'the source survives');
    assert.equal(r.keptOnDisk, 'assets/clip.mp4');
    assert.notEqual(r.file, 'assets/clip.mp4', 'and was never overwritten');
  });

test('repeated trims compose on the current file and do not stack filename suffixes',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    const a = await trimFootage({ store, filmId: film.id, segmentId, durationInFrames: 200 });
    const b = await trimFootage({ store, filmId: film.id, segmentId, startInFrames: 20, durationInFrames: 100 });
    assert.equal(a.file, 'assets/clip.trim1.mp4');
    assert.equal(b.file, 'assets/clip.trim2.mp4', 'not clip.trim1.trim1.mp4');
    assert.equal(b.from, 'assets/clip.trim1.mp4', 'the second trim cuts the first one\'s output');
    assert.equal(await countFrames(path.join(film.path, b.file)), 100);
  });

/* ------------------------------------------------------------------ */
/* The in-point is never moved silently                                */
/* ------------------------------------------------------------------ */

test('off a keyframe the default is an exact re-encode, not a silent snap',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc, { withScene: true });
    const r = await trimFootage({ store, filmId: film.id, segmentId, startInFrames: 63, durationInFrames: 60 });

    assert.equal(r.method, 'reencode');
    assert.equal(r.startFrame, 63, 'exactly where it was asked for');
    assert.equal(r.snappedByFrames, 0);
    assert.equal(r.framesVerified, true);
    assert.equal(await countFrames(path.join(film.path, r.file)), 60);
  });

test('snapToKeyframe takes the cheap path, holds the OUT-point, and says where it landed',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    // 63..123 requested; 60 is the keyframe at or before 63, and the out-point
    // stays at 123 — so the window LENGTHENS to 63 frames rather than sliding.
    const r = await trimFootage({
      store, filmId: film.id, segmentId, startInFrames: 63, durationInFrames: 60, snapToKeyframe: true,
    });
    assert.equal(r.method, 'copy');
    assert.equal(r.startFrame, 60);
    assert.equal(r.snappedByFrames, 3);
    assert.equal(r.durationInFrames, 63, 'the out-point is held fixed, so the window grew by the snap');
    assert.equal(await countFrames(path.join(film.path, r.file)), 63);
    assert.ok(r.warnings.some((w) => /in-point moved from frame 63 to 60/.test(w)), r.warnings.join('|'));
  });

test('a coarse clip warns that snapping is not an edit, and names the one-time fix',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, coarseSrc, { withScene: true });
    const r = await trimFootage({
      store, filmId: film.id, segmentId, startInFrames: 90, durationInFrames: 60, dryRun: true,
    });
    assert.equal(r.method, 'reencode');
    assert.equal(r.keyframes.coarse, true);
    assert.ok(r.warnings.some((w) => /gop: 10/.test(w)), r.warnings.join('|'));
  });

/* ------------------------------------------------------------------ */
/* dryRun, and the film afterwards                                     */
/* ------------------------------------------------------------------ */

test('dryRun reports the plan and changes nothing at all',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    const before = await fsp.readdir(path.join(film.path, 'assets'));

    const r = await trimFootage({
      store, filmId: film.id, segmentId, startInFrames: 63, durationInFrames: 60, dryRun: true,
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.method, 'reencode');
    assert.ok(r.estimatedMs > 0, 'a re-encode is quoted so the caller can decide');
    assert.equal(r.keyframes.coarse, false);

    assert.deepEqual(await fsp.readdir(path.join(film.path, 'assets')), before, 'no file was written');
    const after = await store.getFilm(film.id);
    assert.equal(after.scenes.find((s) => s.footage !== undefined).durationInFrames, FRAMES, 'play order untouched');
  });

test('after a trim the film plans clean, and the frame count verifies against the file',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc, { withScene: true });
    await trimFootage({ store, filmId: film.id, segmentId, startInFrames: 30, durationInFrames: 120 });

    const after = await store.getFilm(film.id);
    const plan = await planFilm({ film: after, store });
    const seg = plan.scenes.find((s) => s.kind === 'footage');
    assert.equal(seg.durationInFrames, 120);
    assert.equal(seg.actualFrames, 120);
    assert.equal(seg.framesVerified, true, 'the rule that decides whether a delivery is honest');
    assert.deepEqual(
      plan.problems.filter((p) => p.code !== 'scene_not_rendered').map((p) => p.code), [],
      JSON.stringify(plan.problems),
    );
    assert.equal(plan.totalFrames, 30 + 120, 'the timeline got shorter by exactly what was cut');
  });

/* ------------------------------------------------------------------ */
/* Refusals, and the film-with-no-signature case §3 did not cover      */
/* ------------------------------------------------------------------ */

test('a window that is not inside the file is refused, and nothing is written',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    const before = await fsp.readdir(path.join(film.path, 'assets'));

    await assert.rejects(
      () => trimFootage({ store, filmId: film.id, segmentId, startInFrames: 10, durationInFrames: 100000 }),
      (e) => e.code === 'invalid_config' && /not all there/.test(e.message),
    );
    await assert.rejects(
      () => trimFootage({ store, filmId: film.id, segmentId, startInFrames: 0, durationInFrames: FRAMES }),
      (e) => e.code === 'invalid_config' && /whole clip/.test(e.message),
    );
    await assert.rejects(
      () => trimFootage({ store, filmId: film.id, segmentId: 'seg-nope', durationInFrames: 10 }),
      (e) => e.code === 'invalid_film',
    );
    assert.deepEqual(await fsp.readdir(path.join(film.path, 'assets')), before);
  });

test('a missing clip is refused before anything is created',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);
    await fsp.rm(path.join(film.path, 'assets', 'clip.mp4'));
    await assert.rejects(
      () => trimFootage({ store, filmId: film.id, segmentId, durationInFrames: 10 }),
      (e) => e.code === 'file_not_found',
    );
  });

/**
 * The gap §3's text did not cover: two of the three footage-bearing films on
 * the dev machine are footage-ONLY, so they have no encode signature and
 * `matchFilm` has nothing to conform to. A re-encode there uses the SEGMENT'S
 * own probed properties — matching the file you are cutting is exactly what
 * keeps it joinable to itself.
 */
test('a footage-only film has no signature, and a re-encode conforms to the clip itself',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, fineSrc);   // no scene at all
    const plan = await planFilm({ film, store });
    assert.equal(plan.signature?.ffmpegArgs, undefined, 'precondition: this film has no encoder args');

    const r = await trimFootage({ store, filmId: film.id, segmentId, startInFrames: 63, durationInFrames: 60 });
    assert.equal(r.method, 'reencode');
    assert.equal(r.conformedTo.from, 'segment');
    assert.equal(r.framesVerified, true);
    assert.equal(await countFrames(path.join(film.path, r.file)), 60);
  });

/**
 * The case that shipped broken (found in use, 2026-08-08).
 *
 * Repeated copy-trims of a COARSE clip converge: each copy starts at a keyframe
 * and keeps fewer frames than the source's next one, so the output has exactly
 * one keyframe — frame 0 — and every later one does too. A real film reached
 * 623 frames/3 keyframes → 163/1 → 77/1 → 32/1.
 *
 * The engine was always right here (no keyframe to snap to means re-encode),
 * but the Studio caged its handle to the grid, so on such a clip the handle
 * could only ever land on frame 0 and the drag silently did nothing. The cage
 * is gone; this pins the engine half so the fallback can never quietly rot.
 *
 * The measured lesson underneath it: a re-encode costs by frames KEPT, so on a
 * clip that has been trimmed down it is cheap. The rule "re-encoding is a job"
 * came from a 152 s segment and does not transfer to a half-second one.
 */
test('a clip whose only keyframe is frame 0 still head-trims — exactly, by re-encode',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film, segmentId } = await filmWith(dir, coarseSrc);

    // Converge it the way repeated trims do: a copy from frame 0 keeping fewer
    // frames than the 250-frame GOP leaves a file with one keyframe.
    const first = await trimFootage({ store, filmId: film.id, segmentId, durationInFrames: 40 });
    assert.equal(first.method, 'copy');
    const grid = await keyframeGrid({ filePath: path.join(film.path, first.file), fps: FPS });
    assert.deepEqual(grid.frames, [0], 'precondition: the converged clip has exactly one keyframe');

    // There is no keyframe to snap to, so even asking to snap must not silently
    // land on 0 and call it done — it re-encodes and gives the exact frame.
    const r = await trimFootage({
      store, filmId: film.id, segmentId, startInFrames: 12, durationInFrames: 20, snapToKeyframe: true,
    });
    assert.equal(r.method, 'reencode');
    assert.equal(r.startFrame, 12, 'the frame that was asked for, not frame 0');
    assert.equal(r.snappedByFrames, 0);
    assert.equal(r.framesVerified, true);
    assert.equal(await countFrames(path.join(film.path, r.file)), 20);
  });

/**
 * A container that over-counts its own tail (found in use, 2026-08-08).
 *
 * A real screen recording in the workspace declares 623 frames in `nb_frames`
 * AND reports 623 packets, while a full decode yields 622 — its last packets
 * are out of order (pts 10.3167, 10.3833, 10.3500). Both cheap counts lie the
 * same way, so a trim keeping everything to the end asks for one frame that
 * does not exist, and the first version refused the whole operation over it.
 *
 * The frames that DID arrive were exactly right, so a small shortfall at the
 * end of the source is now taken and reported. The rule is deliberately narrow
 * — anywhere but the tail, or by more than a couple of frames, a short file is
 * still a failure, because nothing else explains it.
 */
test('a short tail is accepted only at the end of the source, and only by a frame or two', () => {
  // The reported case: 391 asked for at the very end, 390 produced.
  const real = acceptShortTail({ requested: 391, produced: 390, reachedEnd: true });
  assert.equal(real.accept, true);
  assert.equal(real.frames, 390, 'the segment declares what the file actually holds');
  assert.equal(real.shortfall, 1);

  // Same shortfall, but the window did NOT run to the end — nothing explains
  // that, so it stays a failure.
  assert.equal(acceptShortTail({ requested: 391, produced: 390, reachedEnd: false }).accept, false);

  // Too big to be a container quirk.
  assert.equal(acceptShortTail({ requested: 400, produced: 200, reachedEnd: true }).accept, false);
  assert.equal(acceptShortTail({ requested: 10, produced: 10 - TAIL_SLACK_FRAMES, reachedEnd: true }).accept, true);
  assert.equal(acceptShortTail({ requested: 10, produced: 10 - TAIL_SLACK_FRAMES - 1, reachedEnd: true }).accept, false);

  // An empty output is never "nearly right".
  assert.equal(acceptShortTail({ requested: 1, produced: 0, reachedEnd: true }).accept, false);
  // A LONGER output is not a tail shortfall either.
  assert.equal(acceptShortTail({ requested: 10, produced: 12, reachedEnd: true }).accept, false);
});

test('trimSignature prefers the film, falls back to the clip, and refuses to guess', () => {
  const filmSig = { id: 'f', width: 1920, height: 1080, ffmpegArgs: ['-c:v', 'libx264'] };
  assert.equal(trimSignature({ planSignature: filmSig, media: null, file: 'x' }).source, 'film');

  const fromClip = trimSignature({
    planSignature: null,
    media: { video: { width: 640, height: 480, fps: 30, pixFmt: 'yuv422p' } },
    file: 'x',
  });
  assert.equal(fromClip.source, 'segment');
  assert.equal(fromClip.signature.width, 640);
  assert.ok(fromClip.signature.ffmpegArgs.includes('yuv422p'), 'the clip\'s own pixel format is carried');

  assert.throws(
    () => trimSignature({ planSignature: null, media: null, file: 'x.mp4' }),
    (e) => e.code === 'invalid_film' && /no signature/.test(e.message),
  );
});
