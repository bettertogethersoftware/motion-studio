/**
 * Unit tests for the TTS core module (no external exe, no ffmpeg): WAV header
 * parsing, duration→frames, and the spawn/contract mapping against the Node
 * stub injected via the ttsExe argument (helpers/fake-tts.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  wavDurationSeconds, parseWavHeader, framesForDuration, synthesizeSpeech, checkTts,
  measureWavLevels, measureWavEnvelope, splitSentences, concatWavBuffers,
} from '../src/core/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_TTS = path.resolve(__dirname, 'helpers/fake-tts.mjs');

/** Build a PCM WAV buffer, optionally with an extra (possibly odd-sized) chunk before `data`. */
function pcmWav({ sampleRate = 22050, channels = 1, bitsPerSample = 16, dataSize = 44100, extraChunk = null } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const parts = [];

  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);
  parts.push(fmt);

  if (extraChunk) {
    const { id, size } = extraChunk;
    const padded = size + (size & 1);
    const c = Buffer.alloc(8 + padded);
    c.write(id, 0, 'ascii');
    c.writeUInt32LE(size, 4);
    parts.push(c);
  }

  const data = Buffer.alloc(8 + dataSize);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(dataSize, 4);
  parts.push(data);

  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, body]);
}

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-tts-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

test('parseWavHeader reads fmt facts and data size', () => {
  const info = parseWavHeader(pcmWav({ sampleRate: 22050, channels: 1, bitsPerSample: 16, dataSize: 44100 }));
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.channels, 1);
  assert.equal(info.byteRate, 44100);
  assert.equal(info.dataSize, 44100);
});

test('parseWavHeader walks odd-sized chunks with word-alignment padding', () => {
  // A 5-byte LIST chunk (odd → 1 pad byte) sits between fmt and data.
  const info = parseWavHeader(pcmWav({ dataSize: 22050, extraChunk: { id: 'LIST', size: 5 } }));
  assert.equal(info.dataSize, 22050);
  assert.equal(info.byteRate, 44100);
});

test('wavDurationSeconds = dataSize / byteRate', async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, 'a.wav');
    await fsp.writeFile(f, pcmWav({ dataSize: 44100 })); // 44100 / 44100 = 1.0s
    assert.equal(await wavDurationSeconds(f), 1);
    const g = path.join(dir, 'b.wav');
    await fsp.writeFile(g, pcmWav({ dataSize: 22050 })); // 0.5s
    assert.equal(await wavDurationSeconds(g), 0.5);
  });
});

test('parseWavHeader throws EngineError on non-WAV bytes', () => {
  assert.throws(() => parseWavHeader(Buffer.from('not a wav at all!!')), (e) => {
    assert.equal(e.code, 'tts_failed');
    return /Unreadable WAV/.test(e.message);
  });
});

test('framesForDuration rounds up so audio is never clipped short', () => {
  assert.equal(framesForDuration(1.0, 30), 30);
  assert.equal(framesForDuration(1.02, 30), 31);
  assert.equal(framesForDuration(0.5, 24), 12);
});

test('checkTts lists voices from the stub', async () => {
  const probe = await checkTts({ ttsExe: FAKE_TTS });
  assert.equal(probe.available, true);
  assert.ok(probe.voices.includes('Microsoft David Desktop'), JSON.stringify(probe.voices));
});

test('checkTts reports unavailable for a missing exe', async () => {
  const probe = await checkTts({ ttsExe: path.join(os.tmpdir(), 'no-such-ms-tts-exe.exe') });
  assert.equal(probe.available, false);
  assert.ok(probe.error);
});

test('synthesizeSpeech writes a WAV and returns contract metadata', async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, 'vo.wav');
    const res = await synthesizeSpeech({ text: 'Hello "world"\nsecond line', outPath: out, ttsExe: FAKE_TTS });
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(out));
    assert.equal(res.sampleRate, 22050);
    assert.equal(await wavDurationSeconds(out), 1);
  });
});

test('synthesizeSpeech maps an unknown voice to unsupported_voice', async () => {
  await withTmp(async (dir) => {
    await assert.rejects(
      synthesizeSpeech({ text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'No Such Voice', ttsExe: FAKE_TTS }),
      (e) => e.code === 'unsupported_voice',
    );
  });
});

/* --------------------- levels / sentences / concat (v0.19) --------------------- */

/** 16-bit mono WAV holding literal samples (−1..1). */
function pcmWav16(samples, sampleRate = 22050) {
  const wav = pcmWav({ sampleRate, channels: 1, bitsPerSample: 16, dataSize: samples.length * 2 });
  const { dataOffset } = parseWavHeader(wav);
  samples.forEach((s, i) => wav.writeInt16LE(Math.round(s * 32767), dataOffset + i * 2));
  return wav;
}

test('measureWavLevels reports peak and RMS in dBFS', async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, 'half.wav');
    // constant 0.5 amplitude → peak = RMS = 20·log10(0.5·32767/32768) ≈ −6.02
    await fsp.writeFile(f, pcmWav16(new Array(2205).fill(0.5)));
    const { peakDb, meanDb } = await measureWavLevels(f);
    assert.ok(Math.abs(peakDb - -6.02) < 0.05, `peakDb=${peakDb}`);
    assert.ok(Math.abs(meanDb - -6.02) < 0.05, `meanDb=${meanDb}`);
  });
});

test('measureWavLevels reports nulls for silence instead of -Infinity', async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, 'silence.wav');
    await fsp.writeFile(f, pcmWav({ dataSize: 4410 }));
    assert.deepEqual(await measureWavLevels(f), { peakDb: null, meanDb: null });
  });
});

test('measureWavEnvelope reports per-second RMS and flags a dead tail', async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, 'tail.wav');
    // 2 s of 0.5-amplitude tone, then 2 s of digital silence at 22050 Hz.
    const samples = [...new Array(44100).fill(0.5), ...new Array(44100).fill(0)];
    await fsp.writeFile(f, pcmWav16(samples));
    const { envelopeDb, silentTailSeconds } = await measureWavEnvelope(f);
    assert.equal(envelopeDb.length, 4);
    assert.ok(Math.abs(envelopeDb[0] - -6.0) < 0.1, `envelopeDb[0]=${envelopeDb[0]}`);
    assert.ok(Math.abs(envelopeDb[1] - -6.0) < 0.1);
    assert.equal(envelopeDb[2], null);   // digital silence, not -Infinity
    assert.equal(envelopeDb[3], null);
    assert.equal(silentTailSeconds, 2);
  });
});

test('measureWavEnvelope reports zero silent tail when audio runs to the end', async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, 'full.wav');
    await fsp.writeFile(f, pcmWav16(new Array(44100).fill(0.25)));
    const { envelopeDb, silentTailSeconds } = await measureWavEnvelope(f);
    assert.equal(envelopeDb.length, 2);
    assert.equal(silentTailSeconds, 0);
  });
});

test('splitSentences splits on terminators and never returns empty', () => {
  assert.deepEqual(splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  assert.deepEqual(splitSentences('No terminator here'), ['No terminator here']);
  assert.deepEqual(splitSentences('這是茶壺。它很燙!'), ['這是茶壺。它很燙!']); // no space after CJK stop: one unit
  assert.deepEqual(splitSentences('這是茶壺。 它很燙!'), ['這是茶壺。', '它很燙!']);
});

test('concatWavBuffers places segments exactly, with the gap between them', () => {
  const a = pcmWav16(new Array(22050).fill(0.25)); // 1.0s
  const b = pcmWav16(new Array(11025).fill(0.25)); // 0.5s
  const { buffer, segments, sampleRate } = concatWavBuffers([a, b], { gapSeconds: 0.5 });
  assert.equal(sampleRate, 22050);
  assert.deepEqual(segments, [
    { startSeconds: 0, durationSeconds: 1 },
    { startSeconds: 1.5, durationSeconds: 0.5 },
  ]);
  // The result is itself a valid WAV totalling 2.0s of audio.
  const info = parseWavHeader(buffer);
  assert.equal(info.dataSize / info.byteRate, 2);
});

test('concatWavBuffers refuses mismatched formats', () => {
  const a = pcmWav16(new Array(100).fill(0.1), 22050);
  const b = pcmWav16(new Array(100).fill(0.1), 16000);
  assert.throws(() => concatWavBuffers([a, b]), (e) => /format mismatch/.test(e.message));
});

test('synthesizeSpeech maps a generic engine failure to tts_failed', async () => {
  await withTmp(async (dir) => {
    process.env.FAKE_TTS_FAIL = '1';
    try {
      await assert.rejects(
        synthesizeSpeech({ text: 'hi', outPath: path.join(dir, 'vo.wav'), ttsExe: FAKE_TTS }),
        (e) => e.code === 'tts_failed',
      );
    } finally {
      delete process.env.FAKE_TTS_FAIL;
    }
  });
});
