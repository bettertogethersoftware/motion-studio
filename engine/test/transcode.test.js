/**
 * `transcode_asset` (v0.22): preparing media inside the tool surface.
 *
 * The graph builders are pure and tested directly, because they are the ENTIRE
 * validated surface — the tool takes no arbitrary ffmpeg arguments and never will,
 * so what those two functions emit is exactly what can ever run. Everything that
 * needs a real encode is gated on ffmpeg, like the other suites.
 *
 * The assertions that matter most are the ones a wrapper gets wrong silently:
 * that a frame-exact trim really produces that many frames, that a crossfaded
 * join really consumes the time it claims, and that the response describes the
 * file that exists rather than the request that was made.
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
  buildVideoFilter, buildSpanGraph, validateTranscode, formatForExtension,
  transcodeAsset, transcodeMetaPath, readTranscodeMeta, transcodeIdentity,
  MAX_CROSSFADE_MS, MAX_SPANS, TRANSCODE_VERSION,
} from '../src/core/transcode.js';
import { ErrorCodes } from '../src/core/errors.js';

const execFileP = promisify(execFile);
let tmp, src, haveFfmpeg = true;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-transcode-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (!haveFfmpeg) return;
  // 4s of 640x480 video with a tone: enough to trim, crop, scale and cut spans.
  src = path.join(tmp, 'src.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', src]);
});
after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

const probe = async (file, extra = []) => {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,codec_name', ...extra, '-of', 'json', file]);
  return JSON.parse(stdout).streams[0];
};
const packets = async (file) => Number((await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file])).stdout.trim());

/* ------------------------------------------------------------------ */
/* The filter builders — the whole attack surface                      */
/* ------------------------------------------------------------------ */

test('buildVideoFilter orders crop before scale before fps', () => {
  // Not the caller's choice: cropping after scaling would make the rectangle mean
  // something other than what they measured on the source.
  assert.equal(
    buildVideoFilter({ crop: { x: 384, y: 110, width: 1152, height: 648 }, scale: { width: 640 }, fps: 30 }),
    'crop=1152:648:384:110,scale=640:-2,fps=30',
  );
  assert.equal(buildVideoFilter({}), null, 'no geometry means no -vf at all');
  assert.equal(buildVideoFilter({ scale: { height: 360 } }), 'scale=-2:360', 'one dimension keeps the aspect ratio');
});

test('buildVideoFilter floors odd dimensions for subsampled video, keeps them for frames', () => {
  // An odd width is an encoder error, not a rounding detail — but a PNG sequence
  // has no chroma subsampling, and silently resizing one is worse than honouring it.
  assert.equal(buildVideoFilter({ scale: { width: 641, height: 361 } }), 'scale=640:360');
  assert.equal(buildVideoFilter({ scale: { width: 641, height: 361 }, evenDims: false }), 'scale=641:361');
  assert.equal(buildVideoFilter({ crop: { width: 101, height: 51, x: 3, y: 5 } }), 'crop=100:50:3:5');
});

test('buildSpanGraph joins N spans with triangular crossfades', () => {
  const { filterComplex, outLabel } = buildSpanGraph([
    { startSeconds: 1.95, durationSeconds: 11.37 },
    { startSeconds: 14.91, durationSeconds: 19.63 },
    { startSeconds: 58.45, durationSeconds: 20.73 },
  ], { crossfadeMs: 12, sampleRate: 48000, channels: 2 });
  assert.equal(outLabel, 'out');
  const parts = filterComplex.split(';');
  assert.equal(parts.length, 5, '3 trims + 2 crossfades');
  assert.match(parts[0], /^\[0:a\]atrim=start=1\.95:duration=11\.37,asetpts=N\/SR\/TB,aformat=sample_rates=48000:channel_layouts=stereo\[a0\]$/);
  // Chained, not parallel: each fade takes the previous result.
  assert.equal(parts[3], '[a0][a1]acrossfade=d=0.0120:c1=tri:c2=tri[x1]');
  assert.equal(parts[4], '[x1][a2]acrossfade=d=0.0120:c1=tri:c2=tri[out]');
});

test('buildSpanGraph uses concat for a hard join, and passes one span straight through', () => {
  const hard = buildSpanGraph([{ startSeconds: 0, durationSeconds: 1 }, { startSeconds: 5, durationSeconds: 1 }], { crossfadeMs: 0 });
  assert.match(hard.filterComplex, /\[a0\]\[a1\]concat=n=2:v=0:a=1\[out\]$/);
  const one = buildSpanGraph([{ startSeconds: 2, durationSeconds: 3 }], { crossfadeMs: 12 });
  assert.equal(one.outLabel, 'a0', 'nothing to fade into');
  assert.ok(!one.filterComplex.includes('acrossfade'));
});

test('buildSpanGraph normalizes every span to one sample format', () => {
  // acrossfade requires matching inputs; without this a source whose streams
  // differ fails deep inside ffmpeg, naming nothing the caller wrote.
  const mono = buildSpanGraph([{ startSeconds: 0, durationSeconds: 1 }], { sampleRate: 16000, channels: 1 });
  assert.match(mono.filterComplex, /aformat=sample_rates=16000:channel_layouts=mono/);
});

test('formatForExtension maps the destination extension, and is not an identity map', () => {
  assert.equal(formatForExtension('a/b/clip.mp4'), 'mp4');
  assert.equal(formatForExtension('clip.WEBM'), 'webm');
  assert.equal(formatForExtension('clip.mov'), 'prores', 'prores writes .mov');
  assert.equal(formatForExtension('clip.gif'), null);
  assert.equal(formatForExtension('clip'), null);
});

/* ------------------------------------------------------------------ */
/* Validation — nothing shell-shaped, every complaint at once          */
/* ------------------------------------------------------------------ */

test('validateTranscode collects every problem rather than failing on the first', () => {
  try {
    validateTranscode({
      mode: 'sideways', to: '', crop: { width: 0, height: -1 },
      scale: {}, fps: 900, video: { quality: 99, gop: 0 },
    });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, ErrorCodes.INVALID_CONFIG);
    const all = e.detail.problems.join(' | ');
    for (const want of ['mode must be', 'to must be', 'crop.width/height', 'scale needs', 'fps must be', 'video.quality', 'video.gop']) {
      assert.ok(all.includes(want), `missing "${want}" in: ${all}`);
    }
  }
});

test('validateTranscode refuses ambiguous trims', () => {
  const bad = (trim) => assert.throws(() => validateTranscode({ mode: 'video', to: 'assets/o.mp4', trim }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG);
  bad({ startSeconds: 1, startInFrames: 30 });
  bad({ durationInFrames: 30, durationSeconds: 1 });
  bad({ durationInFrames: 0 });
  bad({ startSeconds: -1 });
  // …and accepts one of each.
  assert.doesNotThrow(() => validateTranscode({ mode: 'video', to: 'assets/o.mp4', trim: { startInFrames: 60, durationInFrames: 90 } }));
});

test('validateTranscode holds audio mode to its own fields', () => {
  const at = (o) => () => validateTranscode({ mode: 'audio', to: 'assets/a.wav', ...o });
  assert.throws(at({}), /spans/, 'audio mode without spans is meaningless');
  assert.throws(at({ spans: [{ startSeconds: 0 }], crossfadeMs: MAX_CROSSFADE_MS + 1 }), /crossfadeMs/);
  assert.throws(at({ spans: [{ startSeconds: 0 }], sampleRate: 12345 }), /sampleRate/);
  assert.throws(at({ spans: [{ startSeconds: 0 }], channels: 6 }), /channels/);
  assert.throws(at({ spans: [{ startSeconds: 0, durationInFrames: 2, durationSeconds: 1 }] }), /not both/);
  assert.doesNotThrow(at({ spans: [{ startSeconds: 1.5, durationInFrames: 90 }], crossfadeMs: 12, sampleRate: 48000, channels: 2 }));
  // spans is an audio-mode field; passing it to video mode is a mistake worth naming.
  assert.throws(() => validateTranscode({ mode: 'video', to: 'assets/o.mp4', spans: [{ startSeconds: 0 }] }), /audio-mode field/);
  assert.throws(at({ spans: Array.from({ length: MAX_SPANS + 1 }, () => ({ startSeconds: 0, durationSeconds: 1 })) }), /spans exceeds/);
});

/* ------------------------------------------------------------------ */
/* video mode                                                          */
/* ------------------------------------------------------------------ */

test('video mode: a frame-exact trim really produces that many frames', { skip: !haveFfmpeg }, async () => {
  // -frames:v guarantees the count where -t seconds does not, and one frame of
  // drift breaks a concat seam and shifts every later cue. This is the assertion
  // that makes an output safe as a footage segment.
  const out = path.join(tmp, 'exact.mp4');
  const r = await transcodeAsset({
    sourceAbs: src, outPath: out, mode: 'video',
    trim: { startSeconds: 1, durationInFrames: 45 },
  });
  assert.equal(await packets(out), 45);
  assert.equal(r.frames, 45, 'and the response reports the measured count');
  assert.equal(r.skipped, false);
});

test('video mode: crop then scale, measured on the result', { skip: !haveFfmpeg }, async () => {
  const out = path.join(tmp, 'pip.webm');
  const r = await transcodeAsset({
    sourceAbs: src, outPath: out, mode: 'video',
    trim: { durationInFrames: 10 },
    crop: { x: 64, y: 48, width: 320, height: 240 },
    scale: { width: 160 },
    video: { quality: 40, gop: 10 },
  });
  // The response describes the file that exists, not the request: 320x240 cropped
  // then scaled to width 160 keeps 4:3, so 160x120.
  assert.equal(r.video.width, 160);
  assert.equal(r.video.height, 120);
  assert.equal(r.video.codec, 'vp9', 'the .webm extension picked the codec');
  assert.equal(r.hasAudio, false, 'audio is dropped unless asked for');
  assert.equal(r.probed, true);
});

test('video mode: H.264 in, VP9 out — acting on probe_asset\'s own warning', { skip: !haveFfmpeg }, async () => {
  // The render browser is Chromium without proprietary codecs, so a composition
  // cannot play the H.264 source. probe_asset warns; this is the fix, and the
  // measured output must no longer carry that note.
  const before = await probe(src);
  assert.equal(before.codec_name, 'h264');
  const out = path.join(tmp, 'browser.webm');
  const r = await transcodeAsset({ sourceAbs: src, outPath: out, mode: 'video', trim: { durationInFrames: 6 }, video: { quality: 45 } });
  assert.equal(r.video.codec, 'vp9');
  assert.ok(!(r.notes ?? []).some((n) => /cannot be decoded by the render browser/.test(n)),
    `the output must be browser-decodable, got notes: ${JSON.stringify(r.notes)}`);
});

test('video mode: audio: true keeps the source track', { skip: !haveFfmpeg }, async () => {
  const out = path.join(tmp, 'withsound.mp4');
  const r = await transcodeAsset({ sourceAbs: src, outPath: out, mode: 'video', trim: { durationInFrames: 30 }, audio: true });
  assert.equal(r.hasAudio, true);
});

test('video mode: an unknown destination extension is refused, naming the options', { skip: !haveFfmpeg }, async () => {
  await assert.rejects(
    () => transcodeAsset({ sourceAbs: src, outPath: path.join(tmp, 'out.gif'), mode: 'video' }),
    (e) => {
      assert.equal(e.code, ErrorCodes.UNSUPPORTED_FORMAT);
      // gif's own encode args ARE a -filter_complex, which cannot be combined
      // with a crop/scale chain — so the refusal explains rather than just fails.
      assert.match(e.message, /\.mp4, \.webm or \.mov/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* audio mode — the expensive half, and the one with the click         */
/* ------------------------------------------------------------------ */

test('audio mode: N spans joined, and the crossfade consumes the time it claims', { skip: !haveFfmpeg }, async () => {
  const out = path.join(tmp, 'spine.wav');
  const r = await transcodeAsset({
    sourceAbs: src, outPath: out, mode: 'audio',
    spans: [
      { startSeconds: 0.2, durationInFrames: 30 },
      { startSeconds: 1.5, durationInFrames: 30 },
      { startSeconds: 3.0, durationInFrames: 30 },
    ],
    crossfadeMs: 12, sampleRate: 48000, channels: 2, fpsForFrames: 30,
  });
  // acrossfade OVERLAPS its inputs, so 3×1s with two 12ms fades is 2.976s, not 3s.
  // That is what makes it a crossfade rather than a gap, and the number a caller
  // needs when placing the result on a timeline.
  assert.ok(Math.abs(r.durationSeconds - 2.976) < 0.01, `expected ~2.976s, got ${r.durationSeconds}`);
  assert.equal(r.audio.codec, 'pcm_s16le', 'PCM, so every consumer reads the duration from a header');
  assert.equal(r.audio.sampleRate, 48000);
  assert.equal(r.audio.channels, 2);
  assert.equal(r.video, null, 'audio mode writes no video stream');
});

test('audio mode: a hard join consumes no time', { skip: !haveFfmpeg }, async () => {
  const out = path.join(tmp, 'hard.wav');
  const r = await transcodeAsset({
    sourceAbs: src, outPath: out, mode: 'audio',
    spans: [{ startSeconds: 0.2, durationSeconds: 1 }, { startSeconds: 2, durationSeconds: 1 }],
    crossfadeMs: 0,
  });
  assert.ok(Math.abs(r.durationSeconds - 2) < 0.01, `expected ~2s, got ${r.durationSeconds}`);
});

test('audio mode: 16 kHz mono, the shape a transcription needs', { skip: !haveFfmpeg }, async () => {
  const out = path.join(tmp, 'forwhisper.wav');
  const r = await transcodeAsset({
    sourceAbs: src, outPath: out, mode: 'audio',
    spans: [{ startSeconds: 0, durationSeconds: 2 }], sampleRate: 16000, channels: 1,
  });
  assert.equal(r.audio.sampleRate, 16000);
  assert.equal(r.audio.channels, 1);
});

test('audio mode: a source with no audio stream is refused before any work', { skip: !haveFfmpeg }, async () => {
  const silent = path.join(tmp, 'silent.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=160x120:rate=30:duration=1', '-pix_fmt', 'yuv420p', silent]);
  await assert.rejects(
    () => transcodeAsset({
      sourceAbs: silent, outPath: path.join(tmp, 'nope.wav'), mode: 'audio',
      spans: [{ startSeconds: 0, durationSeconds: 1 }],
    }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG && /no audio stream|has none/.test(e.message),
  );
});

/* ------------------------------------------------------------------ */
/* frames mode                                                         */
/* ------------------------------------------------------------------ */

test('frames mode: a PNG sequence, and `every` decimates the trimmed span', { skip: !haveFfmpeg }, async () => {
  const dir = path.join(tmp, 'seq');
  await transcodeAsset({
    sourceAbs: src, outPath: dir, mode: 'frames',
    trim: { startSeconds: 0.5, durationInFrames: 6 }, scale: { width: 160 },
  });
  assert.deepEqual((await fsp.readdir(dir)).sort().slice(0, 2), ['frame-000001.png', 'frame-000002.png']);
  assert.equal((await fsp.readdir(dir)).length, 6);

  // `trim.durationInFrames` means frames OF SOURCE in every mode, so `every: 3`
  // over 12 of them is 4 images — not 12 taken from 36.
  const dir2 = path.join(tmp, 'seq2');
  await transcodeAsset({
    sourceAbs: src, outPath: dir2, mode: 'frames',
    trim: { durationInFrames: 12 }, scale: { width: 160 }, frames: { every: 3 },
  });
  assert.equal((await fsp.readdir(dir2)).length, 4);
  // …and the geometry survived being in the same chain as the select filter.
  const png = await probe(path.join(dir2, 'frame-000001.png'));
  assert.equal(png.width, 160);
});

/* ------------------------------------------------------------------ */
/* the rules it must obey                                              */
/* ------------------------------------------------------------------ */

test('it never overwrites its source', { skip: !haveFfmpeg }, async () => {
  await assert.rejects(
    () => transcodeAsset({ sourceAbs: src, outPath: src, mode: 'video' }),
    (e) => e.code === ErrorCodes.INVALID_CONFIG && /never overwrites/.test(e.message),
  );
});

test('a missing source is file_not_found, and an oversized one is refused by measurement', { skip: !haveFfmpeg }, async () => {
  await assert.rejects(
    () => transcodeAsset({ sourceAbs: path.join(tmp, 'ghost.mp4'), outPath: path.join(tmp, 'o.mp4') }),
    (e) => e.code === ErrorCodes.FILE_NOT_FOUND,
  );
  await assert.rejects(
    () => transcodeAsset({ sourceAbs: src, outPath: path.join(tmp, 'o2.mp4'), maxSourceSeconds: 1 }),
    (e) => {
      assert.equal(e.code, ErrorCodes.ASSET_TOO_LARGE);
      assert.match(e.message, /over the 1s limit/);
      return true;
    },
  );
});

test('repeating an unchanged call is free, and a changed parameter re-runs it', { skip: !haveFfmpeg }, async () => {
  const out = path.join(tmp, 'idem.mp4');
  const req = { sourceAbs: src, outPath: out, mode: 'video', trim: { durationInFrames: 12 }, scale: { width: 160 } };
  const first = await transcodeAsset(req);
  assert.equal(first.skipped, false);
  assert.ok(first.elapsedMs >= 0);

  const second = await transcodeAsset(req);
  assert.equal(second.skipped, true, 'the sidecar recognised the same source and parameters');
  assert.equal(second.elapsedMs, 0);
  // Still measured, so a skip reports the same shape as a run.
  assert.equal(second.video.width, 160);

  const changed = await transcodeAsset({ ...req, scale: { width: 128 } });
  assert.equal(changed.skipped, false, 'a different parameter is a different output');
  assert.equal(changed.video.width, 128);

  const forced = await transcodeAsset({ ...req, scale: { width: 128 }, refresh: true });
  assert.equal(forced.skipped, false, 'refresh re-runs regardless');

  // The sidecar is a real, readable record beside the output.
  const meta = readTranscodeMeta(out);
  assert.equal(meta.identity.version, TRANSCODE_VERSION);
  assert.ok(meta.transcodedAt);
  assert.ok(fs.existsSync(transcodeMetaPath(out)));
});

test('the sidecar identity changes with the source file, not just the parameters', async () => {
  const base = { sourceAbs: 'C:/x/a.mp4', bytes: 10, mtimeMs: 5, request: { mode: 'video' } };
  const id = transcodeIdentity(base);
  assert.deepEqual(transcodeIdentity({ ...base }), id);
  assert.notDeepEqual(transcodeIdentity({ ...base, mtimeMs: 6 }), id, 'an edited source is a different transcode');
  assert.notDeepEqual(transcodeIdentity({ ...base, bytes: 11 }), id);
  assert.notDeepEqual(transcodeIdentity({ ...base, request: { mode: 'audio' } }), id);
});

/* ------------------------------------------------------------------ */
/* matchFilm — the option that prevents the common disaster            */
/* ------------------------------------------------------------------ */

test('matchFilm conforms the output using the film\'s OWN encoder arguments', { skip: !haveFfmpeg }, async () => {
  const { filmSignature } = await import('../src/core/films.js');
  const { sceneSignature, probeSignature } = await import('../src/core/film.js');
  const { probeMedia } = await import('../src/core/encoder.js');

  // A film whose scenes are 320x240@30 mp4 — the signature a footage segment
  // has to agree with to be stream-copied onto its timeline.
  const cfg = {
    width: 320, height: 240, fps: 30, durationInFrames: 15, audio: [],
    output: { format: 'mp4', dir: 'out', filename: 'output.mp4', crf: 18, preset: 'medium', pixFmt: 'yuv420p', transparent: false },
  };
  const signature = filmSignature([cfg]);

  const out = path.join(tmp, 'conformed.mp4');
  const r = await transcodeAsset({
    sourceAbs: src, outPath: out, mode: 'video',
    trim: { durationInFrames: 24 },
    scale: { width: signature.width, height: signature.height },
    fps: signature.fps,
    signature,
  });

  // The proof: the conformed file rebuilds the film's own fingerprint, so
  // validateScenes and planFilm's footage check both accept it.
  const measured = await probeMedia({ filePath: out });
  assert.equal(probeSignature(measured), signature.id);
  assert.equal(probeSignature(measured), sceneSignature(cfg));
  assert.equal(r.frames, 24, 'and still frame-exact, which is what the timeline declares');
  // The encode args came from the film, not from a second derivation here.
  assert.deepEqual(r.applied.args, signature.ffmpegArgs);
});
