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
