/**
 * v0.24: the three fixes that came out of producing a music video end to end.
 *
 *   - assertDeliveryWritable   fail a held output BEFORE the render, not after
 *   - measureAudioPeakPosition WHERE a cue peaks, so one-shots land on the beat
 *   - audioPatch / audioGainOffsetDb  edit a saved timeline without restating it
 *
 * The limiter's codec headroom is asserted next to the filter itself in
 * core.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assertDeliveryWritable } from '../src/core/delivery.js';
import { pickFrameRate, summarizeMedia } from '../src/core/encoder.js';
import { segmentSentences } from '../src/core/transcribe.js';
import { measureAudioPeakPosition, measureAudioLevels } from '../src/core/encoder.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';

const execFileP = promisify(execFile);
let haveFfmpeg = false;
try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated */ }

async function withTmp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-v024-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

/* ------------------------- held-output preflight ------------------------- */

test('delivery: a destination that does not exist yet is writable', async () => {
  await withTmp(async (dir) => {
    // The first render of a scene has nothing to replace — it must not trip.
    await assertDeliveryWritable({ outputPath: path.join(dir, 'output.mp4') });
  });
});

test('delivery: an existing, unheld destination is writable', async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, 'output.mp4');
    await fsp.writeFile(out, 'x');
    await assertDeliveryWritable({ outputPath: out });
  });
});

test('delivery: a held destination fails fast with an actionable disk_error', async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, 'output.mp4');
    await fsp.writeFile(out, 'x');
    // Windows answers a sharing violation with EBUSY/EPERM on the write open.
    const openImpl = async () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
    await assert.rejects(
      assertDeliveryWritable({ outputPath: out, openImpl }),
      (err) => {
        assert.equal(err.code, 'disk_error');
        assert.equal(err.detail.phase, 'preflight');
        // The message has to name BOTH ways out, or the caller just retries
        // the same render and loses the same minutes again.
        assert.match(err.message, /Close whatever is playing it/);
        assert.match(err.message, /different output filename/);
        return true;
      },
    );
  });
});

test('delivery: a non-lock error is left for the renderer, not reported as a held file', async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, 'output.mp4');
    await fsp.writeFile(out, 'x');
    const openImpl = async () => { const e = new Error('EISDIR'); e.code = 'EISDIR'; throw e; };
    // Resolves: this probe only claims to detect sharing violations.
    await assertDeliveryWritable({ outputPath: out, openImpl });
  });
});

/* --------------------------- cue peak position --------------------------- */

test('encoder: measureAudioPeakPosition finds a late transient, not the clip start', { skip: !haveFfmpeg && 'needs ffmpeg' }, async () => {
  await withTmp(async (dir) => {
    const wav = path.join(dir, 'cue.wav');
    // 2s quiet, then a loud burst: exactly the shape of a riser or a sub-drop,
    // where placing the file by its START puts the hit 2 seconds late.
    await execFileP('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2,volume=0.03',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]',
      '-map', '[a]', wav,
    ]);

    const res = await measureAudioPeakPosition({ filePath: wav });
    assert.ok(res, 'expected a measurement');
    // The whole point: the number is the BURST, not the file start.
    assert.ok(
      res.peakAtSeconds >= 1.9 && res.peakAtSeconds <= 2.3,
      `peak should sit at the burst (~2.0s), got ${res.peakAtSeconds}s`,
    );
    // Cross-check the level against the independent measurement path. They
    // decode the same file through different filters, so agreement here is
    // what says the windowed astats reading is calibrated and not merely
    // self-consistent.
    const levels = await measureAudioLevels({ filePath: wav });
    assert.ok(
      Math.abs(res.peakDb - levels.peakDb) < 0.5,
      `windowed peak ${res.peakDb} dB should match volumedetect's ${levels.peakDb} dB`,
    );
  });
});

test('encoder: measureAudioPeakPosition returns null for a file with no audio', async () => {
  await withTmp(async (dir) => {
    const notMedia = path.join(dir, 'notes.txt');
    await fsp.writeFile(notMedia, 'not media');
    // Contract matches measureAudioLevels: unknown, never a thrown failure.
    assert.equal(await measureAudioPeakPosition({ filePath: notMedia }), null);
  });
});

/* ------------------------ addressed timeline edits ------------------------ */

async function filmWithTimeline(home) {
  const store = await makeStore(home);
  const film = await store.createFilm(TEST_WS, { name: 'Mix' });
  const saved = await store.updateFilm(film.id, {
    audio: [
      { id: 'song', src: 'assets/song.wav', gainDb: 0 },
      { id: 'bed', src: 'assets/bed.wav', gainDb: -8, duck: true },
      { id: 'hit', src: 'assets/hit.wav', gainDb: -4.5, startInFrames: 600 },
    ],
  });
  return { store, film, saved };
}

test('store: audioGainOffsetDb shifts every track and preserves the balance', async () => {
  await withTmp(async (home) => {
    const { store, film } = await filmWithTimeline(home);
    const out = await store.updateFilm(film.id, { audioGainOffsetDb: -2 });
    const by = Object.fromEntries(out.audio.map((t) => [t.id, t]));
    assert.equal(by.song.gainDb, -2);
    assert.equal(by.bed.gainDb, -10);
    assert.equal(by.hit.gainDb, -6.5);
    // The point of the operation: every gap between tracks is unchanged.
    assert.equal(by.song.gainDb - by.bed.gainDb, 8);
    // Untouched fields survive.
    assert.equal(by.bed.duck, true);
    assert.equal(by.hit.startInFrames, 600);
  });
});

test('store: audioPatch edits named tracks and leaves the rest alone', async () => {
  await withTmp(async (home) => {
    const { store, film } = await filmWithTimeline(home);
    const out = await store.updateFilm(film.id, {
      audioPatch: [{ id: 'hit', gainDb: -1 }, { id: 'bed', fadeInFrames: 30 }],
    });
    const by = Object.fromEntries(out.audio.map((t) => [t.id, t]));
    assert.equal(by.hit.gainDb, -1);
    assert.equal(by.hit.startInFrames, 600, 'omitted fields keep their values');
    assert.equal(by.bed.fadeInFrames, 30);
    assert.equal(by.bed.gainDb, -8);
    assert.equal(by.song.gainDb, 0, 'unnamed tracks are untouched');
    assert.equal(out.audio.length, 3);
  });
});

test('store: audioPatch then audioGainOffsetDb compose, offset last', async () => {
  await withTmp(async (home) => {
    const { store, film } = await filmWithTimeline(home);
    const out = await store.updateFilm(film.id, {
      audioPatch: [{ id: 'song', gainDb: 3 }],
      audioGainOffsetDb: -2,
    });
    const by = Object.fromEntries(out.audio.map((t) => [t.id, t]));
    assert.equal(by.song.gainDb, 1, 'patched to 3, then the master offset applies');
  });
});

test('store: an unknown audioPatch id is an error, not a silent no-op', async () => {
  await withTmp(async (home) => {
    const { store, film } = await filmWithTimeline(home);
    await assert.rejects(
      store.updateFilm(film.id, { audioPatch: [{ id: 'nope', gainDb: -3 }] }),
      (e) => {
        assert.equal(e.code, 'invalid_film');
        // Naming the real ids is what turns this into a one-retry fix.
        assert.match(e.message, /song, bed, hit/);
        return true;
      },
    );
  });
});

test('store: audio and the addressed operations are mutually exclusive', async () => {
  await withTmp(async (home) => {
    const { store, film } = await filmWithTimeline(home);
    await assert.rejects(
      store.updateFilm(film.id, {
        audio: [{ src: 'assets/only.wav' }],
        audioGainOffsetDb: -2,
      }),
      (e) => e.code === 'invalid_film' && /not both/.test(e.message),
    );
  });
});

test('store: patching a film with no timeline says so instead of inventing one', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Silent' });
    await assert.rejects(
      store.updateFilm(film.id, { audioGainOffsetDb: -2 }),
      (e) => e.code === 'invalid_film' && /no master audio timeline/.test(e.message),
    );
  });
});

test('store: the addressed operations respect expectedRevision', async () => {
  await withTmp(async (home) => {
    const { store, film, saved } = await filmWithTimeline(home);
    await store.updateFilm(film.id, { name: 'Renamed by the human' });
    // Resolving against the CURRENT doc must not smuggle a stale write past
    // the conflict check.
    await assert.rejects(
      store.updateFilm(film.id, { audioGainOffsetDb: -2 }, { expectedRevision: saved.revision }),
      (e) => e.code === 'film_conflict',
    );
  });
});

/* ------------------------- reported frame rate --------------------------- */

test('encoder: a constant-rate stream reports its base rate, not frames/duration', () => {
  // Measured on this engine's own output: r_frame_rate 30/1, avg 921600/30719
  // (= 30.00098). Reporting the average made probe_asset call a conformant film
  // fractional and warn that seeking would miss frames.
  assert.equal(pickFrameRate({ r_frame_rate: '30/1', avg_frame_rate: '921600/30719' }), 30);
  const media = summarizeMedia({
    format: { duration: '179.994141' },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
      r_frame_rate: '30/1', avg_frame_rate: '921600/30719', nb_frames: '5400' }],
  });
  assert.equal(media.video.fps, 30);
  assert.ok(!media.notes.some((n) => /fractional/.test(n)), 'must not warn about its own CFR output');
});

test('encoder: genuine fractional and variable rates are still reported honestly', () => {
  // 29.97 is a real rate, not a rounding artefact: keep it, and keep the note.
  assert.equal(pickFrameRate({ r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' }), 29.97);
  const ntsc = summarizeMedia({
    format: {}, streams: [{ codec_type: 'video', codec_name: 'h264', r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' }],
  });
  assert.ok(ntsc.notes.some((n) => /fractional/.test(n)));
  // VFR: containers often declare a nonsense base rate, so the average wins.
  assert.equal(pickFrameRate({ r_frame_rate: '1000/1', avg_frame_rate: '24/1' }), 24);
  assert.equal(pickFrameRate({ r_frame_rate: '30/1', avg_frame_rate: '0/0' }), 30);
});

/* --------------------- sentences in sung material ------------------------ */

const w = (text, startMs, endMs) => ({ text, raw: ` ${text}`, startMs, endMs, p: 0.9 });

test('transcribe: prose still splits on punctuation, and says so', () => {
  const s = segmentSentences([
    w('Hello', 0, 400), w('there.', 400, 900),
    w('How', 1000, 1300), w('are', 1300, 1500), w('you?', 1500, 1900),
  ]);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'Hello there.');
  assert.equal(s[0].boundary, 'punctuation');
  assert.equal(s[1].text, 'How are you?');
});

test('transcribe: sung lyrics split on the rest, not into one 3-minute sentence', () => {
  // No punctuation anywhere — the shape that produced a single 174 s "sentence".
  const words = [];
  for (let line = 0; line < 4; line++) {
    const base = line * 5000;
    ['one', 'more', 'life'].forEach((t, i) => words.push(w(t, base + i * 400, base + i * 400 + 350)));
  }
  const s = segmentSentences(words);
  assert.equal(s.length, 4, 'each sung line is its own sentence');
  assert.ok(s.every((x) => x.text === 'one more life'));
  assert.equal(s[0].boundary, 'pause');
  // Every boundary must sit in real silence, which is what makes it cuttable.
  for (let i = 0; i < s.length - 1; i++) {
    assert.ok(s[i + 1].startMs - s[i].endMs >= 700, 'boundary lands in a pause');
  }
});

test('transcribe: unpunctuated material with no pauses still gets capped', () => {
  const words = [];
  for (let i = 0; i < 200; i++) words.push(w('la', i * 300, i * 300 + 290));
  const s = segmentSentences(words);
  assert.ok(s.length > 1, 'a 60s run of continuous syllables must not be one sentence');
  assert.ok(s.some((x) => x.boundary === 'cap'));
  for (const x of s) assert.ok(x.endMs - x.startMs <= 20500, 'no sentence exceeds the cap');
});
