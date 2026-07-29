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

import {
  validateScenes, assembleFilm, sceneSignature, sceneOutputPath, sceneHasAudio, filmLayout,
  isFootage, segmentFrames, segmentPath, segmentName, probeSignature, engineFormatForProbe,
} from '../src/core/film.js';
import { filmSignature } from '../src/core/films.js';
import { buildVideoArgs } from '../src/core/encoder.js';

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

/* --------------------- the film signature (v0.22) --------------------- */

/* The encode contract, stated as data. The rule these tests exist to protect is
 * "derive, never duplicate": a second copy of the encode table would diverge and
 * the *reported* one would be the wrong one, which is worse than reporting
 * nothing. So the load-bearing assertion is the byte-identity one. */

test('filmSignature reports args byte-identical to what the renderer passes', () => {
  const c = cfg();
  const sig = filmSignature([c]);
  assert.deepEqual(sig.ffmpegArgs, buildVideoArgs(c.output));
  // …and to what buildFilmArtifact's finishing pass passes, which spells the
  // same call differently (films.js: `{ ...firstOutput, format: info.format,
  // transparent: firstOutput.transparent }`). Both restate keys the spread
  // already carries, so the arrays must be equal — assert it rather than trust
  // the comment, since a divergence would make the reported contract a lie.
  assert.deepEqual(
    sig.ffmpegArgs,
    buildVideoArgs({ ...c.output, format: c.output.format ?? 'mp4', transparent: c.output.transparent }),
  );
  // …and the fields are read back out of those args, not restated beside them.
  assert.equal(sig.video.codec, 'libx264');
  assert.equal(sig.video.preset, 'medium');
  assert.equal(sig.pixFmt, 'yuv420p');
  assert.equal(sig.audio.codec, 'aac');
  assert.equal(sig.audio.bitrate, '192k');
});

test('filmSignature reuses sceneSignature for the comparison key', () => {
  const c = cfg();
  assert.equal(filmSignature([c]).id, sceneSignature(c));
});

test('filmSignature reports the first scene — the film\'s encode voice', () => {
  const sig = filmSignature([cfg({ output: { ...cfg().output, crf: 20 } }), cfg()]);
  assert.equal(sig.video.crf, 20);
  assert.equal(sig.width, 320);
  assert.equal(sig.fps, 30);
});

test('filmSignature warns when scenes disagree on crf/preset instead of reading as uniform', () => {
  const a = cfg({ output: { ...cfg().output, crf: 18 } });
  const b = cfg({ output: { ...cfg().output, crf: 30 } });
  assert.deepEqual(filmSignature([a, a]).warnings, []);
  const varied = filmSignature([a, b]).warnings;
  assert.equal(varied.length, 1);
  assert.match(varied[0], /disagree on crf\/preset/);
  // Legal, not an error: they affect quality, not stream compatibility.
  assert.ok(!filmSignature([a, b]).mustMatch.includes('crf'));
  assert.ok(!filmSignature([a, b]).neednotMatch.includes('crf'));
  // But not "need not match" either — the third list is where they belong.
  assert.ok(filmSignature([a, b]).matchForLooks.includes('crf'));
});

test('filmSignature: colour is stated from the render profile, never guessed at', () => {
  const sig = filmSignature([cfg()]);
  assert.equal(sig.color.stated, true);
  assert.deepEqual(
    { p: sig.color.primaries, t: sig.color.transfer, m: sig.color.matrix, r: sig.color.range },
    { p: 'bt709', t: 'iec61966-2-1', m: 'bt709', r: 'tv' },
  );
  // ffmpegArgs remain a flat codec contract; the renderer folds the profile's
  // filter into the chain it owns, so callers never get a second -vf to lose.
  for (const flag of ['-color_primaries', '-color_trc', '-colorspace', '-color_range']) {
    assert.ok(!sig.ffmpegArgs.includes(flag), `${flag} must not be in ffmpegArgs`);
  }
});

test('filmSignature: the three lists are disjoint and colour is only in the third', () => {
  const sig = filmSignature([cfg()]);
  // A parameter in two lists would make the contract self-contradictory —
  // which is the failure the third list was added to avoid, not to introduce.
  const all = [...sig.mustMatch, ...sig.neednotMatch, ...sig.matchForLooks];
  assert.equal(new Set(all).size, all.length);
  assert.ok(sig.matchForLooks.includes('colorTransfer'));
  assert.ok(!sig.mustMatch.some((k) => /^color/.test(k)));
  assert.ok(!sig.neednotMatch.some((k) => /^color/.test(k)));
});

test('filmSignature returns null when nothing resolved — never a guess', () => {
  // An empty film enforces no contract; a plausible answer from sceneDefaults
  // alone would produce a file that fails to concat much later.
  assert.equal(filmSignature([]), null);
  assert.equal(filmSignature(undefined), null);
  assert.equal(filmSignature([null, undefined]), null);
});

test('filmSignature: a webm film reports VP9, and alpha reaches the pixel format', () => {
  const opaque = filmSignature([cfg({ output: { ...cfg().output, format: 'webm', filename: 'output.webm' } })]);
  assert.equal(opaque.video.codec, 'libvpx-vp9');
  assert.equal(opaque.audio.codec, 'libopus');
  assert.equal(opaque.pixFmt, 'yuv420p');
  assert.equal(opaque.container, 'webm');

  const alpha = filmSignature([cfg({
    output: { ...cfg().output, format: 'webm', filename: 'output.webm', transparent: true },
  })]);
  assert.equal(alpha.transparent, true);
  assert.equal(alpha.pixFmt, 'yuva420p');
  assert.ok(alpha.ffmpegArgs.includes('-auto-alt-ref'));
});

test('filmSignature: prores reports container "mov" and the profile\'s real pixel format', () => {
  const sig = filmSignature([cfg({ output: { ...cfg().output, format: 'prores', filename: 'output.mov' } })]);
  assert.equal(sig.format, 'prores');
  assert.equal(sig.container, 'mov', 'the container is not a synonym for the format');
  assert.equal(sig.video.codec, 'prores_ks');
  // The profile decides the pixel format regardless of output.pixFmt, so the
  // honest answer to "what will my file have to be" is the encoder's, not the
  // config's — `id` keeps sceneSignature's comparison string either way.
  assert.equal(sig.pixFmt, 'yuv422p10le');
  assert.equal(sig.video.crf, null, 'prores has no crf');
});

test('filmSignature never throws on a format with no encode step', () => {
  const sig = filmSignature([cfg({ output: { ...cfg().output, format: 'png-sequence', filename: 'frames' } })]);
  assert.equal(sig.ffmpegArgs, null);
  assert.equal(sig.video.codec, null);
  assert.equal(sig.container, null);
  assert.equal(sig.warnings.length, 1, 'the no-encode-step line subsumes the copyConcat one');
  assert.match(sig.warnings[0], /no encode step/);
});

test('filmSignature: a gif film has filter args but no codec, and says it cannot be joined', () => {
  const sig = filmSignature([cfg({ output: { ...cfg().output, format: 'gif', filename: 'output.gif' } })]);
  assert.equal(sig.copyConcat, false);
  assert.equal(sig.video.codec, null, 'gif\'s videoArgs is a -filter_complex with no -c:v');
  assert.equal(sig.audio, null, 'gif carries no audio');
  assert.ok(sig.ffmpegArgs.includes('-filter_complex'));
  assert.match(sig.warnings.join(' '), /cannot be stream-copied/);
});

test('filmSignature carries the crf-0 compatibility advisory', () => {
  // This is the moment someone is deciding what to encode, so the lossless-H.264
  // black-video trap belongs here rather than only on a finished render.
  const sig = filmSignature([cfg({ output: { ...cfg().output, crf: 0 } })]);
  assert.equal(sig.video.crf, 0);
  assert.match(sig.warnings.join(' '), /BLACK VIDEO/);
});

test('filmSignature survives a hand-edited unknown format', () => {
  const sig = filmSignature([cfg({ output: { ...cfg().output, format: 'ogv' } })]);
  assert.equal(sig.format, 'ogv');
  assert.equal(sig.copyConcat, null);
  assert.equal(sig.ffmpegArgs, null);
});

/* ------------------- footage segments (v0.22) ------------------- */

/* `film.scenes[]` used to hold exactly one kind of thing — a rendered scene — so
 * a film could not express "footage, then a scene, then footage", which is what
 * almost every film built around someone's own recording actually is. These test
 * the accessors and the assembly; films.test.js covers plan-time verification. */

const footageSeg = (file, frames, extra = {}) =>
  ({ kind: 'footage', footage: `assets/${file}`, segmentPath: `/abs/${file}`, durationInFrames: frames, ...extra });

test('segment accessors read one vocabulary over two kinds', () => {
  const s = { kind: 'scene', sceneId: 'a', path: '/p', config: cfg({ name: 'Intro' }) };
  const f = footageSeg('clip.mp4', 231, { name: 'Interview' });
  assert.equal(isFootage(f), true);
  assert.equal(isFootage(s), false);
  assert.equal(segmentFrames(s), 15);
  assert.equal(segmentFrames(f), 231);
  assert.equal(segmentName(s), 'Intro');
  assert.equal(segmentName(f), 'Interview');
  assert.equal(segmentPath(f), '/abs/clip.mp4');
  assert.equal(segmentPath(s), sceneOutputPath('/p', cfg()));
  // An untagged entry is a scene — that is what every film written before v0.22 is.
  assert.equal(isFootage({ sceneId: 'x', config: cfg() }), false);
});

test('filmLayout places footage and scenes on one timeline, identically', () => {
  const segs = [
    { kind: 'scene', sceneId: 'title', config: cfg({ durationInFrames: 90, name: 'Title' }) },
    footageSeg('f1.mp4', 231),
    { kind: 'scene', sceneId: 'lamb', config: cfg({ durationInFrames: 60, name: 'Lamb' }) },
    footageSeg('f2.mp4', 320),
  ];
  const layout = filmLayout(segs);
  assert.deepEqual(layout.map((s) => s.filmOffset), [0, 90, 321, 381]);
  assert.deepEqual(layout.map((s) => s.kind), ['scene', 'footage', 'scene', 'footage']);
  // The fields an agent places a caption or a cue with are the same either way.
  for (const entry of layout) {
    for (const k of ['kind', 'name', 'filmOffset', 'durationInFrames', 'startSeconds']) {
      assert.ok(k in entry, `${entry.kind} entry must carry ${k}`);
    }
  }
  assert.equal(layout[1].footage, 'assets/f1.mp4');
  assert.equal(layout[1].startSeconds, 3); // 90 / 30
  assert.equal(layout[3].filmOffset + layout[3].durationInFrames, 701);
});

test('filmLayout takes an fps for an all-footage film, which has no scene config', () => {
  const segs = [footageSeg('a.mp4', 30), footageSeg('b.mp4', 60)];
  assert.deepEqual(filmLayout(segs, 30).map((s) => s.startSeconds), [0, 1]);
  // Without one it reports offsets but no seconds, rather than dividing by null.
  assert.deepEqual(filmLayout(segs).map((s) => s.startSeconds), [0, 0]);
  assert.deepEqual(filmLayout(segs).map((s) => s.filmOffset), [0, 30]);
});

test('validateScenes skips render and staleness checks for footage', async () => {
  await withTmp(async (root) => {
    const a = await scene(root, 'a', cfg());
    // Footage is a file the user supplied: there is nothing to render and no
    // sidecar to go stale, so an unrendered-looking entry must not be refused.
    const f = { ...footageSeg('clip.mp4', 40), segmentPath: path.join(root, 'clip.mp4') };
    const info = validateScenes([a, f]);
    assert.equal(info.format, 'mp4');
    assert.equal(info.fps, 30);
    assert.equal(info.signature, sceneSignature(cfg()));
  });
});

test('validateScenes: footage counts as a silent segment', async () => {
  await withTmp(async (root) => {
    const withAudio = await scene(root, 'a', cfg({ audio: [{ src: 'assets/vo.wav' }] }));
    const f = footageSeg('clip.mp4', 40);
    // Footage is silent by contract, so mixing it with an audio-carrying scene
    // and no master timeline is a real -c copy failure — the plan had this
    // backwards, claiming silent footage kept the check quiet.
    assert.throws(() => validateScenes([withAudio, f], { hasMasterAudio: false }),
      (e) => e.code === 'inconsistent_scenes' && /mix audio and silence/.test(e.message));
    // A master timeline is the normal shape for such a film, not a workaround.
    assert.equal(validateScenes([withAudio, f], { hasMasterAudio: true }).fps, 30);
  });
});

test('validateScenes: an all-footage film has no encode voice, and that is not an error', async () => {
  await withTmp(async () => {
    const info = validateScenes([footageSeg('a.mp4', 30), footageSeg('b.mp4', 60)]);
    // Only a scene carries a config the engine authored; a film of supplied files
    // has none, so the honest answer is null rather than a fabricated default.
    assert.equal(info.signature, null);
    assert.equal(info.fps, null);
    assert.equal(info.format, 'mp4', 'the concat container still has to be decided');
  });
});

test('probeSignature rebuilds the film fingerprint from a probed file', () => {
  // The comparison that makes footage_signature_mismatch possible.
  const mp4 = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: { codec: 'h264', width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p' },
  };
  assert.equal(probeSignature(mp4), '1920x1080@30/mp4/opaque/yuv420p');
  // …which is exactly what sceneSignature produces for the matching config.
  assert.equal(probeSignature(mp4), sceneSignature({
    width: 1920, height: 1080, fps: 30,
    output: { format: 'mp4', pixFmt: 'yuv420p', transparent: false },
  }));

  const alpha = { container: 'matroska,webm', video: { codec: 'vp9', width: 640, height: 360, fps: 24, pixFmt: 'yuva420p' } };
  assert.equal(probeSignature(alpha), '640x360@24/webm/alpha/yuva420p');

  // Unprobeable, or a codec/container pair the timeline cannot carry, is null —
  // and null must never be read as "matches".
  assert.equal(probeSignature(null), null);
  assert.equal(probeSignature({ container: 'avi', video: { codec: 'mpeg4', width: 320, height: 240, fps: 30 } }), null);
  assert.equal(probeSignature({ container: 'mov,mp4', video: { codec: 'h264', width: 0, height: 0, fps: null } }), null);
});

test('engineFormatForProbe maps codec+container to the engine\'s format name', () => {
  // ffprobe says "h264" in "mov,mp4,…"; the engine says format "mp4" whose
  // encoder is "libx264". Comparing either field directly is a false mismatch.
  assert.equal(engineFormatForProbe('h264', 'mov,mp4,m4a,3gp,3g2,mj2'), 'mp4');
  assert.equal(engineFormatForProbe('vp9', 'matroska,webm'), 'webm');
  assert.equal(engineFormatForProbe('vp8', 'matroska,webm'), 'webm');
  assert.equal(engineFormatForProbe('prores', 'mov,mp4,m4a'), 'prores');
  assert.equal(engineFormatForProbe('mpeg4', 'avi'), null);
  assert.equal(engineFormatForProbe(undefined, undefined), null);
});

test('assembleFilm interleaves footage with rendered scenes, losslessly', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withTmp(async (root) => {
    // Three signature-matched mp4s: two "rendered scenes" and one piece of
    // supplied footage. The whole point of the design is that this function
    // cannot tell them apart.
    const mk = async (name, colour, seconds) => {
      const p = path.join(root, name);
      await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
        '-i', `color=c=${colour}:s=320x240:r=30:d=${seconds}`, '-pix_fmt', 'yuv420p', p]);
      return p;
    };
    const sceneClip = await mk('scene.mp4', 'red', 0.5);      // 15 frames
    const footageClip = await mk('shot.mp4', 'green', 1);      // 30 frames
    const a = await scene(root, 'a', cfg(), { clip: sceneClip });
    const b = await scene(root, 'b', cfg(), { clip: sceneClip });
    const f = { ...footageSeg('shot.mp4', 30), segmentPath: footageClip };

    const out = path.join(root, 'film.mp4');
    const res = await assembleFilm({ scenes: [a, f, b], format: 'mp4', outputPath: out });
    assert.equal(res.scenes, 3);
    assert.equal(res.totalFrames, 60, '15 + 30 + 15');
    assert.deepEqual(res.sceneLayout.map((s) => s.filmOffset), [0, 15, 45]);
    assert.deepEqual(res.sceneLayout.map((s) => s.kind), ['scene', 'footage', 'scene']);

    // Measured, not assumed: the assembled file really holds every frame.
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]);
    assert.equal(Number(stdout.trim()), 60, 'a frame lost at a seam is the failure mode this prevents');
    // And it decodes clean — no silent re-encode, no broken seam.
    const { stderr } = await execFileP('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
    assert.equal(stderr.trim(), '');
  });
});
