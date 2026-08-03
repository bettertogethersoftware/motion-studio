/**
 * Generic PCM WAV and audio-measurement utilities — extracted from
 * core/tts.js in Slice A of the vendor-boundary plan (§5's target layout):
 * these are consumed by the renderer, SFX, music, transcription, and every
 * speech vendor alike, and none of them is speech-specific. The error code
 * stays TTS_FAILED for compatibility: every existing caller and test matches
 * on it, and renaming error codes is not this extraction's job.
 *
 * core/tts.js re-exports everything here for now, so no consumer changes in
 * this step; imports migrate to './audio.js' as later slices touch each file.
 */

import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';

/**
 * Duration (seconds) of a PCM WAV, parsed authoritatively from its RIFF header
 * with no external dependency. Walks the sub-chunks (honoring word-alignment
 * padding), reads `byteRate` from `fmt ` and the declared `data` size, and
 * returns dataSize / byteRate.
 */
export async function wavDurationSeconds(filePath) {
  const buf = await fsp.readFile(filePath);
  const info = parseWavHeader(buf, filePath);
  return info.dataSize / info.byteRate;
}

/** Parse fmt/data facts from a WAV buffer. Exported shape used by callers/tests. */
export function parseWavHeader(buf, filePath = '<buffer>') {
  const bad = (why) => new EngineError(ErrorCodes.TTS_FAILED, `Unreadable WAV (${filePath}): ${why}`);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw bad('missing RIFF/WAVE header');
  }
  let offset = 12;
  let byteRate, sampleRate, channels, bitsPerSample, dataSize, dataOffset;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // Declared size can exceed the actual file for streamed WAVs; clamp.
      dataSize = Math.min(size, Math.max(0, buf.length - body));
      dataOffset = body; // where the samples start — callers that rewrite levels need it
    }
    offset = body + size + (size & 1); // pad to even boundary
  }
  if (!byteRate) throw bad("no 'fmt ' chunk / zero byte-rate");
  if (dataSize === undefined) throw bad("no 'data' chunk");
  return { byteRate, sampleRate, channels, bitsPerSample, dataSize, dataOffset };
}

/** Frames a clip of `seconds` occupies at `fps` (rounded up so audio is never clipped short). */
export function framesForDuration(seconds, fps) {
  return Math.ceil(seconds * fps);
}

/**
 * Split narration into sentences for per-sentence synthesis (v0.19). A simple
 * terminator heuristic (. ! ? … and their CJK forms), deliberately not a full
 * segmenter: timings are sentence-granular and a mis-split only shifts where
 * one caption boundary lands. Abbreviations like "Mr." will split — callers
 * who care can pre-split and pass one sentence per call.
 */
export function splitSentences(text) {
  const parts = text
    .split(/(?<=[.!?…。！？])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

/**
 * Concatenate same-format 16-bit PCM WAV buffers with an optional silence gap
 * between them, reporting where each segment landed (v0.19). This is how
 * synthesize_speech produces sentence timings from vendors whose CLIs cannot
 * emit alignment data: one clip per sentence, concatenated here, offsets known
 * exactly because we placed them.
 *
 * @returns {{buffer: Buffer, sampleRate, channels,
 *            segments: Array<{startSeconds: number, durationSeconds: number}>}}
 */
export function concatWavBuffers(buffers, { gapSeconds = 0 } = {}) {
  if (!buffers.length) throw new EngineError(ErrorCodes.TTS_FAILED, 'concatWavBuffers: no clips');
  const infos = buffers.map((b, i) => {
    const info = parseWavHeader(b, `<clip ${i}>`);
    if (info.bitsPerSample !== 16) {
      throw new EngineError(ErrorCodes.TTS_FAILED, `concatWavBuffers: clip ${i} is not 16-bit PCM`);
    }
    return info;
  });
  const { sampleRate, channels, byteRate } = infos[0];
  infos.forEach((info, i) => {
    if (info.sampleRate !== sampleRate || info.channels !== channels) {
      throw new EngineError(
        ErrorCodes.TTS_FAILED,
        `concatWavBuffers: clip ${i} format mismatch (${info.sampleRate}Hz/${info.channels}ch vs ${sampleRate}Hz/${channels}ch)`,
      );
    }
  });

  const blockAlign = channels * 2;
  let gapBytes = Math.round(gapSeconds * sampleRate) * blockAlign;
  const gap = Buffer.alloc(Math.max(0, gapBytes));
  gapBytes = gap.length;

  const segments = [];
  const chunks = [];
  let offsetBytes = 0;
  infos.forEach((info, i) => {
    if (i > 0 && gapBytes) {
      chunks.push(gap);
      offsetBytes += gapBytes;
    }
    segments.push({
      startSeconds: Number((offsetBytes / byteRate).toFixed(4)),
      durationSeconds: Number((info.dataSize / byteRate).toFixed(4)),
    });
    chunks.push(buffers[i].subarray(info.dataOffset, info.dataOffset + info.dataSize));
    offsetBytes += info.dataSize;
  });

  const data = Buffer.concat(chunks);
  return {
    buffer: Buffer.concat([makeWavHeader(data.length, { sampleRate, channels }), data]),
    sampleRate, channels, segments,
  };
}

/** The canonical 44-byte RIFF header for 16-bit PCM. One writer, shared. */
function makeWavHeader(dataLength, { sampleRate, channels }) {
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * Wrap headerless 16-bit PCM in a RIFF WAV container. The cloud vendors that
 * return raw PCM (ElevenLabs `pcm_*` formats, Gemini's inline audio) go
 * through here so every narration asset on disk honours the same contract:
 * "a PCM WAV whose header is the authoritative duration".
 */
export function pcmToWavBuffer(pcm, { sampleRate, channels = 1 }) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    throw new EngineError(ErrorCodes.TTS_FAILED, 'pcmToWavBuffer: empty PCM body');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new EngineError(ErrorCodes.TTS_FAILED, `pcmToWavBuffer: bad sampleRate ${sampleRate}`);
  }
  // 16-bit frames: an odd byte count means the stream is not what we were told.
  const blockAlign = channels * 2;
  if (pcm.length % blockAlign !== 0) {
    throw new EngineError(
      ErrorCodes.TTS_FAILED,
      `pcmToWavBuffer: PCM length ${pcm.length} is not a multiple of the ${blockAlign}-byte frame (16-bit × ${channels}ch)`,
    );
  }
  return Buffer.concat([makeWavHeader(pcm.length, { sampleRate, channels }), pcm]);
}

/**
 * Measure a 16-bit PCM WAV's peak and RMS level in dBFS (v0.19). Gives
 * synthesize_speech the same level report music/sfx already return, so a caller
 * can balance narration against a bed without rendering first. Reads the samples
 * directly — no ffmpeg round-trip. Non-16-bit files report nulls ("unknown"),
 * mirroring conformWavLevel's refusal to guess.
 *
 * @returns {Promise<{peakDb: number|null, meanDb: number|null}>}
 */
export async function measureWavLevels(filePath) {
  const buf = await fsp.readFile(filePath);
  const info = parseWavHeader(buf, filePath);
  if (info.bitsPerSample !== 16 || info.dataOffset === undefined || info.dataSize === 0) {
    return { peakDb: null, meanDb: null };
  }
  const start = info.dataOffset;
  const end = start + info.dataSize - (info.dataSize % 2);

  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let i = start; i + 1 < end; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSquares += v * v;
    count++;
  }
  if (count === 0 || peak === 0) return { peakDb: null, meanDb: null };
  const toDb = (amp) => Number((20 * Math.log10(amp)).toFixed(2));
  return { peakDb: toDb(peak), meanDb: toDb(Math.sqrt(sumSquares / count)) };
}

/**
 * Per-second RMS envelope of a 16-bit PCM WAV (v0.19.x). Whole-file peak/mean
 * can look perfectly healthy while the last seconds are digital silence — the
 * exact failure mode of the duck/EOF mixer bug — so preview_audio reports this
 * envelope alongside the summary. Buckets that are pure digital silence report
 * null; anything else reports its RMS in dBFS.
 *
 * silentTailSeconds counts the trailing run of buckets that are digital
 * silence or below -70 dBFS, so a mix that dies early is visible at a glance
 * (an intended fade-out ends quiet but not dead — it contributes at most its
 * final bucket).
 *
 * @returns {Promise<{envelopeDb: (number|null)[], silentTailSeconds: number}|null>}
 *   null when the WAV is not 16-bit PCM (mirrors measureWavLevels).
 */
export async function measureWavEnvelope(filePath, { bucketSeconds = 1 } = {}) {
  const buf = await fsp.readFile(filePath);
  const info = parseWavHeader(buf, filePath);
  if (info.bitsPerSample !== 16 || info.dataOffset === undefined || info.dataSize === 0) {
    return null;
  }
  const channels = info.channels || 1;
  const samplesPerBucket = Math.max(1, Math.round(info.sampleRate * bucketSeconds)) * channels;
  const start = info.dataOffset;
  const end = start + info.dataSize - (info.dataSize % 2);

  const envelopeDb = [];
  let sumSquares = 0;
  let count = 0;
  const flush = () => {
    if (count === 0) return;
    envelopeDb.push(sumSquares === 0
      ? null
      : Number((20 * Math.log10(Math.sqrt(sumSquares / count))).toFixed(1)));
    sumSquares = 0;
    count = 0;
  };
  for (let i = start; i + 1 < end; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    sumSquares += v * v;
    if (++count >= samplesPerBucket) flush();
  }
  flush();

  let silentBuckets = 0;
  for (let i = envelopeDb.length - 1; i >= 0; i--) {
    if (envelopeDb[i] !== null && envelopeDb[i] > -70) break;
    silentBuckets++;
  }
  return {
    envelopeDb,
    silentTailSeconds: Number((silentBuckets * bucketSeconds).toFixed(1)),
  };
}
