/**
 * Unit tests for the film-assembly core: scene validation (consistency, render
 * state, audio mixing rules) with no ffmpeg, plus a real concat + master-audio
 * mux of tiny generated clips gated on ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validateScenes, assembleFilm, sceneSignature, sceneOutputPath, sceneHasAudio, filmLayout } from '../src/core/film.js';

const execFileP = promisify(execFile);
let haveFfmpeg = false;
try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated */ }

const cfg = (o = {}) => ({
  width: 320, height: 240, fps: 30, durationInFrames: 15, audio: [],
  output: { format: 'mp4', dir: 'out', filename: 'output.mp4', pixFmt: 'yuv420p', transparent: false },
  ...o,
});

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-film-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

async function scene(root, id, config, { rendered = true, clip } = {}) {
  const dir = path.join(root, id);
  await fsp.mkdir(path.join(dir, config.output.dir), { recursive: true });
  const out = sceneOutputPath(dir, config);
  if (clip) await fsp.copyFile(clip, out);
  else if (rendered) await fsp.writeFile(out, 'placeholder'); // existence is all validateScenes checks
  return { sceneId: id, path: dir, config };
}

test('sceneSignature separates codec-determining params', () => {
  assert.notEqual(sceneSignature(cfg()), sceneSignature(cfg({ width: 640 })));
  assert.notEqual(sceneSignature(cfg()), sceneSignature(cfg({ fps: 60 })));
  assert.notEqual(sceneSignature(cfg()), sceneSignature(cfg({ output: { ...cfg().output, format: 'webm' } })));
  assert.equal(sceneSignature(cfg()), sceneSignature(cfg({ durationInFrames: 999 }))); // duration doesn't matter
});

test('sceneHasAudio reflects config.audio + format capability', () => {
  assert.equal(sceneHasAudio(cfg()), false);
  assert.equal(sceneHasAudio(cfg({ audio: [{ src: 'assets/a.wav' }] })), true);
  assert.equal(sceneHasAudio(cfg({ audio: [{ src: 'a.wav' }], output: { ...cfg().output, format: 'gif' } })), false); // gif carries no audio
});

test('validateScenes rejects an empty film', () => {
  assert.throws(() => validateScenes([]), (e) => e.code === 'inconsistent_scenes');
});

/* ------------------------ film layout (v0.22) ------------------------ */

test('filmLayout returns each scene\'s cumulative filmOffset', () => {
  // The real case: nine scenes whose offsets used to be accumulated by hand.
  const scenes = [
    { sceneId: 'a', config: cfg({ durationInFrames: 501, name: 'Islands' }) },
    { sceneId: 'b', config: cfg({ durationInFrames: 573 }) },
    { sceneId: 'c', config: cfg({ durationInFrames: 510 }) },
  ];
  const layout = filmLayout(scenes);
  assert.deepEqual(layout.map((s) => s.filmOffset), [0, 501, 1074]);
  assert.deepEqual(layout.map((s) => s.durationInFrames), [501, 573, 510]);
  assert.equal(layout[0].name, 'Islands');
  // startSeconds is the same number in the unit an editor thinks in.
  assert.equal(layout[1].startSeconds, Number((501 / 30).toFixed(3)));
  // The last offset plus its duration is the film length.
  const total = layout[2].filmOffset + layout[2].durationInFrames;
  assert.equal(total, 1584);
});

test('validateScenes can skip the rendered check for planning', async () => {
  await withTmp(async (root) => {
    const scenes = [
      await scene(root, 'a', cfg(), { rendered: false }),
      await scene(root, 'b', cfg(), { rendered: false }),
    ];
    // Default: unrendered scenes are refused…
    assert.throws(() => validateScenes(scenes), (e) => e.code === 'scene_not_rendered');
    // …but planning only needs the configs, which exist before any render.
    const info = validateScenes(scenes, { requireRendered: false });
    assert.equal(info.fps, 30);
    assert.deepEqual(filmLayout(scenes).map((s) => s.filmOffset), [0, 15]);
  });
});

test('validateScenes rejects a non-concatenable format', async () => {
  await withTmp(async (root) => {
    const s = await scene(root, 'a', cfg({ output: { ...cfg().output, format: 'gif', filename: 'output.gif' } }));
    assert.throws(() => validateScenes([s]), (e) => e.code === 'inconsistent_scenes' && /losslessly/.test(e.message));
  });
});

test('validateScenes rejects mismatched scene dimensions', async () => {
  await withTmp(async (root) => {
    const a = await scene(root, 'a', cfg());
    const b = await scene(root, 'b', cfg({ width: 640, height: 480 }));
    assert.throws(() => validateScenes([a, b]), (e) => {
      assert.equal(e.code, 'inconsistent_scenes');
      assert.equal(e.detail.mismatched[0].sceneId, 'b');
      return true;
    });
  });
});

test('validateScenes reports unrendered scenes by id', async () => {
  await withTmp(async (root) => {
    const a = await scene(root, 'a', cfg());
    const b = await scene(root, 'b', cfg(), { rendered: false });
    assert.throws(() => validateScenes([a, b]), (e) => {
      assert.equal(e.code, 'scene_not_rendered');
      assert.deepEqual(e.detail.unrendered, ['b']);
      return true;
    });
  });
});

test('validateScenes rejects mixing audio + silent scenes without master audio', async () => {
  await withTmp(async (root) => {
    const a = await scene(root, 'a', cfg({ audio: [{ src: 'assets/vo.wav' }] }));
    const b = await scene(root, 'b', cfg()); // silent
    assert.throws(() => validateScenes([a, b], { hasMasterAudio: false }), (e) => e.code === 'inconsistent_scenes');
    // a master timeline makes the mix legal (scene audio is replaced)
    assert.deepEqual(validateScenes([a, b], { hasMasterAudio: true }), { format: 'mp4', fps: 30, signature: sceneSignature(cfg()) });
  });
});

test('validateScenes passes for consistent, rendered scenes', async () => {
  await withTmp(async (root) => {
    const a = await scene(root, 'a', cfg());
    const b = await scene(root, 'b', cfg());
    assert.deepEqual(validateScenes([a, b]), { format: 'mp4', fps: 30, signature: sceneSignature(cfg()) });
  });
});

test('assembleFilm concatenates scene clips losslessly', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (root) => {
    const red = path.join(root, 'red.mp4'), blue = path.join(root, 'blue.mp4');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=0.5', '-pix_fmt', 'yuv420p', red]);
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=0.5', '-pix_fmt', 'yuv420p', blue]);
    const a = await scene(root, 'a', cfg(), { clip: red });
    const b = await scene(root, 'b', cfg(), { clip: blue });
    const out = path.join(root, 'film.mp4');
    const res = await assembleFilm({ scenes: [a, b], format: 'mp4', outputPath: out });
    assert.equal(res.scenes, 2);
    assert.equal(res.totalFrames, 30);
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]);
    assert.ok(Math.abs(parseFloat(stdout) - 1.0) < 0.15, `duration ~1s, got ${stdout.trim()}`);
  });
});

test('assembleFilm lays a master audio track over the film', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (root) => {
    const red = path.join(root, 'red.mp4');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=0.5', '-pix_fmt', 'yuv420p', red]);
    const a = await scene(root, 'a', cfg(), { clip: red });
    const b = await scene(root, 'b', cfg(), { clip: red });
    const bed = path.join(root, 'bed.wav');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', bed]);
    const out = path.join(root, 'film.mp4');
    const res = await assembleFilm({ scenes: [a, b], format: 'mp4', outputPath: out, audioTracks: [{ src: bed, gainDb: -6 }], assetRoot: root });
    assert.equal(res.hasAudio, true);
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', out]);
    assert.match(stdout.trim(), /audio/);
  });
});
