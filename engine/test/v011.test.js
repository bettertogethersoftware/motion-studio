/**
 * v0.11 feature tests: the cross-process render lock, encoded-frame-count
 * verification, film-assembly level measurement / target peak, and
 * ProjectStore.syncSharedFiles.
 *
 * Real FFmpeg wherever a level or a frame count is asserted — the whole point of
 * these features is that they measure what actually landed on disk, so mocking
 * the measurement would test nothing.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { acquireRenderLock, releaseRenderLock, lockPath, isProcessAlive, LOCK_FILENAME } from '../src/core/lock.js';
import { probeFrameCount, measureAudioLevels } from '../src/core/encoder.js';
import { verifyFrameCount, renderComposition } from '../src/core/renderer.js';
import { makeConfig, validateConfig } from '../src/core/scene.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';
import { assembleFilm, sceneOutputPath } from '../src/core/film.js';
import { makeStore, makeScene } from './helpers/workspace.mjs';
import { ErrorCodes } from '../src/core/errors.js';

const execFileP = promisify(execFile);

let tmp;
let haveFfmpeg = true;
let haveFfprobe = true;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-v011-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  try { await execFileP('ffprobe', ['-version']); } catch { haveFfprobe = false; }
});

const dirFor = async (name) => {
  const d = path.join(tmp, name);
  await fsp.mkdir(d, { recursive: true });
  return d;
};

/** A silent clip of exactly `frames` frames at 30fps. */
async function makeClip(dest, frames, colour = 'red') {
  await execFileP('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=160x120:r=30`,
    '-frames:v', String(frames), '-pix_fmt', 'yuv420p', dest,
  ]);
  return dest;
}

/* ------------------------------------------------------------------ lock -- */

test('lock: a second process cannot take a lock a live process holds', async () => {
  const dir = await dirFor('lock-busy');
  const held = await acquireRenderLock(dir, { pid: process.pid });
  try {
    // A different pid that is definitely alive: this test process's own parent
    // stand-in is awkward, so use our pid under a *different* claimed owner by
    // acquiring as ourselves and asking as someone else.
    await assert.rejects(
      () => acquireRenderLock(dir, { pid: process.pid + 100000 }),
      (e) => e.code === ErrorCodes.RENDER_ALREADY_IN_PROGRESS && /already writing this scene/.test(e.message),
    );
  } finally {
    await held.release();
  }
});

test('lock: re-entrant for the same pid, so nesting inside one render is safe', async () => {
  const dir = await dirFor('lock-reentrant');
  const a = await acquireRenderLock(dir, { pid: process.pid });
  const b = await acquireRenderLock(dir, { pid: process.pid });   // must not throw
  await b.release();
  // The inner release is a no-op: the outer holder still owns the lock.
  assert.ok(await fsp.stat(lockPath(dir)).catch(() => null), 'inner release must not drop the outer lock');
  await a.release();
  assert.equal(await fsp.stat(lockPath(dir)).catch(() => null), null);
});

test('lock: a lock owned by a dead pid is stale and gets taken over', async () => {
  const dir = await dirFor('lock-stale');
  // 0x7FFFFFFE is not a live pid on any platform we run on.
  const deadPid = 2147483646;
  assert.equal(isProcessAlive(deadPid), false);
  await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: deadPid, host: 'gone' }), 'utf8');

  const held = await acquireRenderLock(dir, { pid: process.pid });
  const now = JSON.parse(await fsp.readFile(lockPath(dir), 'utf8'));
  assert.equal(now.pid, process.pid, 'the live process should now own it');
  await held.release();
});

test('lock: a truncated lock file is treated as unowned rather than wedging the project', async () => {
  const dir = await dirFor('lock-corrupt');
  await fsp.writeFile(lockPath(dir), '{"pid":', 'utf8');           // killed mid-write
  const held = await acquireRenderLock(dir, { pid: process.pid });
  await held.release();
  assert.equal(await fsp.stat(lockPath(dir)).catch(() => null), null);
});

test('lock: releasing does not remove a lock someone else has since taken', async () => {
  const dir = await dirFor('lock-release-foreign');
  await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: process.pid + 100000 }), 'utf8');
  await releaseRenderLock(lockPath(dir), process.pid);             // we are not the owner
  assert.ok(await fsp.stat(lockPath(dir)).catch(() => null), 'a non-owner release must be a no-op');
  await fsp.rm(lockPath(dir), { force: true });
});

test('lock: the lock file is a dotfile, so it stays out of listFiles', async () => {
  assert.ok(LOCK_FILENAME.startsWith('.'), 'listFiles skips dotfiles; the lock must be one');
});

/* ---------------------------------------------------- probeFrameCount ---- */

test('probeFrameCount: reports the real frame count, and detects a short file', async (t) => {
  if (!haveFfmpeg || !haveFfprobe) return t.skip('ffmpeg/ffprobe not available');
  const dir = await dirFor('probe');
  const full = await makeClip(path.join(dir, 'full.mp4'), 30);
  const short = await makeClip(path.join(dir, 'short.mp4'), 10);

  assert.equal(await probeFrameCount({ filePath: full }), 30);
  // The check that matters: a truncated encode is distinguishable from a whole
  // one purely from the file, which is what makes resume-by-count trustworthy.
  assert.equal(await probeFrameCount({ filePath: short }), 10);
});

test('probeFrameCount: returns null (not a throw) when it cannot measure', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await dirFor('probe-null');
  assert.equal(await probeFrameCount({ filePath: path.join(dir, 'nope.mp4') }), null);
  // ffprobe absent must degrade to "unverified", never fail a good render.
  const clip = await makeClip(path.join(dir, 'c.mp4'), 5);
  assert.equal(await probeFrameCount({ filePath: clip, ffprobePath: 'definitely-not-ffprobe' }), null);
});

/* --------------------------------------------------- verifyFrameCount --- */

test('verifyFrameCount: passes a whole file and rejects a short one', async (t) => {
  if (!haveFfmpeg || !haveFfprobe) return t.skip('ffmpeg/ffprobe not available');
  const dir = await dirFor('verify');
  const clip = await makeClip(path.join(dir, 'c.mp4'), 30);

  assert.deepEqual(await verifyFrameCount({ outputPath: clip, expected: 30 }), { frames: 30, verified: true });

  // The failure this exists for: a killed worker leaves a valid but short file,
  // and concatenating it would ship a film with a scene that just stops.
  await assert.rejects(
    () => verifyFrameCount({ outputPath: clip, expected: 45 }),
    (e) => e.code === ErrorCodes.SHORT_RENDER
      && e.detail.actual === 30 && e.detail.expected === 45
      && /do not assemble/.test(e.message),
  );
});

test('verifyFrameCount: unmeasurable is "unverified", not a failure', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await dirFor('verify-unknown');
  const res = await verifyFrameCount({ outputPath: path.join(dir, 'missing.mp4'), expected: 12 });
  assert.deepEqual(res, { frames: 12, verified: false });
});

test('render: a completed render reports framesVerified against the real file', async (t) => {
  if (!haveFfmpeg || !haveFfprobe) return t.skip('ffmpeg/ffprobe not available');
  const dir = await dirFor('render-verified');
  await fsp.writeFile(path.join(dir, 'composition.html'), '<html><body></body></html>');
  const config = validateConfig(makeConfig({ name: 'V011', fps: 30, width: 160, height: 120, durationInFrames: 24 }));
  const out = path.join(dir, 'out', 'output.mp4');

  const res = await renderComposition({
    scenePath: dir, config, outputPath: out,
    browserFactory: makeFakeBrowserFactory(),
    preflight: false,
  });

  assert.equal(res.framesVerified, true);
  assert.equal(res.frames, 24);
  assert.equal(await probeFrameCount({ filePath: out }), 24);
  // And the lock it took is gone again.
  assert.equal(await fsp.stat(lockPath(dir)).catch(() => null), null);
});

test('render: refuses to start while another live process holds the lock', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const dir = await dirFor('render-locked');
  await fsp.writeFile(path.join(dir, 'composition.html'), '<html><body></body></html>');
  const config = validateConfig(makeConfig({ name: 'V011L', fps: 30, width: 160, height: 120, durationInFrames: 10 }));

  // A real, live, *foreign* pid — same-pid is re-entrant by design, so faking
  // the owner as ourselves would prove nothing.
  const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  try {
    assert.ok(isProcessAlive(squatter.pid));
    await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: squatter.pid, host: 'other' }), 'utf8');

    await assert.rejects(
      () => renderComposition({
        scenePath: dir, config, outputPath: path.join(dir, 'out', 'o.mp4'),
        browserFactory: makeFakeBrowserFactory(), preflight: false,
      }),
      (e) => e.code === ErrorCodes.RENDER_ALREADY_IN_PROGRESS && e.detail.pid === squatter.pid,
    );

    // The refusal must leave the incumbent's lock intact.
    const still = JSON.parse(await fsp.readFile(lockPath(dir), 'utf8'));
    assert.equal(still.pid, squatter.pid);
  } finally {
    squatter.kill('SIGKILL');
    await fsp.rm(lockPath(dir), { force: true });
  }
});

/* ------------------------------------------------- assembleFilm levels --- */

async function twoScenes(root) {
  const mk = async (id, colour) => {
    const d = path.join(root, id);
    const cfg = {
      width: 160, height: 120, fps: 30, durationInFrames: 15, audio: [],
      output: { format: 'mp4', dir: 'out', filename: 'output.mp4', pixFmt: 'yuv420p', transparent: false },
    };
    await fsp.mkdir(path.join(d, 'out'), { recursive: true });
    await makeClip(sceneOutputPath(d, cfg), 15, colour);
    return { sceneId: id, path: d, config: cfg };
  };
  return [await mk('s1', 'red'), await mk('s2', 'blue')];
}

test('assembleFilm: reports measured peak/mean and a clipping flag', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const root = await dirFor('film-levels');
  const scenes = await twoScenes(root);
  const bed = path.join(root, 'bed.wav');
  await execFileP('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', bed]);

  const out = path.join(root, 'film.mp4');
  const res = await assembleFilm({
    scenes, format: 'mp4', outputPath: out,
    audioTracks: [{ src: bed, gainDb: -6 }], assetRoot: root,
  });

  assert.ok(res.audio, 'a master timeline must come back with an audio report');
  assert.equal(res.audio.tracks, 1);
  assert.equal(res.audio.limiter, true);
  assert.equal(typeof res.audio.peakDb, 'number');
  assert.equal(typeof res.audio.meanDb, 'number');
  assert.equal(res.audio.clipping, false);
});

test('assembleFilm: audioTargetPeakDb lands the film on the requested peak', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const root = await dirFor('film-target');
  const scenes = await twoScenes(root);
  const bed = path.join(root, 'bed.wav');
  await execFileP('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', bed]);

  const out = path.join(root, 'film.mp4');
  const TARGET = -6;
  const res = await assembleFilm({
    scenes, format: 'mp4', outputPath: out,
    // Deliberately far off target, so a correction has to happen.
    audioTracks: [{ src: bed, gainDb: -30 }], assetRoot: root,
    audioTargetPeakDb: TARGET,
  });

  assert.equal(res.audio.targetPeakDb, TARGET);
  assert.ok(res.audio.appliedOffsetDb > 0, 'a too-quiet mix should be corrected upward');
  assert.ok(Math.abs(res.audio.peakDb - TARGET) <= 0.6,
    `expected a peak near ${TARGET} dBFS, got ${res.audio.peakDb}`);

  // And the reported level is the file's real level, not a prediction.
  const onDisk = await measureAudioLevels({ filePath: out });
  assert.equal(onDisk.peakDb, res.audio.peakDb);
});

test('assembleFilm: a target shifts every track equally, preserving the balance', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const root = await dirFor('film-balance');
  const scenes = await twoScenes(root);
  const loud = path.join(root, 'loud.wav');
  const quiet = path.join(root, 'quiet.wav');
  await execFileP('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', loud]);
  await execFileP('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-ac', '2', '-ar', '44100', quiet]);

  const tracks = [{ src: loud, gainDb: -10 }, { src: quiet, gainDb: -25 }];
  const res = await assembleFilm({
    scenes, format: 'mp4', outputPath: path.join(root, 'film.mp4'),
    audioTracks: tracks, assetRoot: root, audioTargetPeakDb: -3,
  });
  // The caller's 15 dB spread must survive: the offset is applied to both, and
  // the input array itself must not be mutated.
  assert.equal(tracks[0].gainDb, -10);
  assert.equal(tracks[1].gainDb, -25);
  assert.ok(Math.abs(res.audio.peakDb - -3) <= 0.6);
});

test('assembleFilm: rejects an out-of-range target', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const root = await dirFor('film-bad-target');
  const scenes = await twoScenes(root);
  await assert.rejects(
    () => assembleFilm({
      scenes, format: 'mp4', outputPath: path.join(root, 'f.mp4'),
      audioTracks: [{ src: path.join(root, 'nope.wav') }], assetRoot: root,
      audioTargetPeakDb: 6,
    }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG,
  );
});

test('assembleFilm: no master audio means no audio report', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not available');
  const root = await dirFor('film-silent');
  const scenes = await twoScenes(root);
  const res = await assembleFilm({ scenes, format: 'mp4', outputPath: path.join(root, 'film.mp4') });
  assert.equal(res.audio, undefined);
});

/* ------------------------------------------------- syncSharedFiles ------- */

async function storeWithScenes(name, ids) {
  const root = await dirFor(name);
  const store = await makeStore(root);
  const made = {};
  for (const id of ids) {
    const { scene } = await makeScene(store, { name: id, fps: 30, width: 160, height: 120, durationInFrames: 10 });
    made[id] = scene.id;
  }
  return { store, made };
}

test('syncSharedFiles: pushes to every target and skips the source', async () => {
  const { store, made } = await storeWithScenes('sync-basic', ['a', 'b', 'c']);
  const shared = 'var SHARED = 1;\n';
  await store.writeFile(made.a, 'composition.js', shared);
  await store.writeFile(made.b, 'composition.js', 'var OLD = 0;\n');

  const res = await store.syncSharedFiles({
    sourceSceneId: made.a,
    targetSceneIds: [made.a, made.b, made.c],     // source listed on purpose
    files: ['composition.js'],
  });

  assert.equal(res.scenesUpdated, 2, 'the source must not be written to itself');
  assert.equal(await store.readFile(made.b, 'composition.js'), shared);
  assert.equal(await store.readFile(made.c, 'composition.js'), shared);
});

test('syncSharedFiles: a missing source file fails before anything is written', async () => {
  const { store, made } = await storeWithScenes('sync-missing', ['a', 'b']);
  await store.writeFile(made.a, 'composition.js', 'var OK = 1;\n');
  await store.writeFile(made.b, 'composition.js', 'var UNTOUCHED = 1;\n');

  await assert.rejects(
    () => store.syncSharedFiles({
      sourceSceneId: made.a,
      targetSceneIds: [made.b],
      files: ['composition.js', 'nope.js'],          // second one does not exist
    }),
    (e) => e.code === ErrorCodes.FILE_NOT_FOUND,
  );
  // The valid file must NOT have been pushed — a half-applied sync across a
  // 16-scene film is worse than a failed one.
  assert.equal(await store.readFile(made.b, 'composition.js'), 'var UNTOUCHED = 1;\n');
});

test('syncSharedFiles: syntax errors and determinism warnings still apply per target', async () => {
  const { store, made } = await storeWithScenes('sync-lint', ['a', 'b']);
  await store.writeFile(made.a, 'composition.js', 'var t = Date.now();\n');   // lints, but writes
  const res = await store.syncSharedFiles({
    sourceSceneId: made.a, targetSceneIds: [made.b], files: ['composition.js'],
  });
  const warned = res.results[0].written[0].warnings;
  assert.ok(warned?.some((w) => w.rule === 'date-now'), 'determinism warnings must survive the sync');
});

test('syncSharedFiles: rejects an empty file list or an empty target list', async () => {
  const { store, made } = await storeWithScenes('sync-empty', ['a', 'b']);
  await assert.rejects(
    () => store.syncSharedFiles({ sourceSceneId: made.a, targetSceneIds: [made.b], files: [] }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG,
  );
  await assert.rejects(
    () => store.syncSharedFiles({ sourceSceneId: made.a, targetSceneIds: [], files: ['composition.js'] }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG,
  );
});
