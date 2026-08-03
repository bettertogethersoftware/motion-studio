/**
 * Speech→transcription round-trip smoke against REAL vendors
 * (linux-ready-plan.md L1). Piper speaks a known sentence, extractSpeechWav
 * conforms it to whisper's 16 kHz mono, real whisper.cpp transcribes it, and
 * the words must come back.
 *
 * Deliberately NOT part of `npm test` (the suite fakes both vendors — see
 * helpers/fake-whisper.mjs for why). CI's linux-speech job runs this file
 * directly where the real binaries exist; it also works on any dev machine
 * with the MOTION_STUDIO_PIPER_* and MOTION_STUDIO_WHISPER_* env hooks set.
 * Exit code 0 means the transcript contained every expected word.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { synthesizePiperSpeech } from '../src/core/tts-piper.js';
import { extractSpeechWav } from '../src/core/transcribe.js';
import { transcribeWithWhisper } from '../src/core/transcribe-whisper.js';

const TEXT = 'The quick brown fox jumps over the lazy dog.';
const MUST_SURVIVE = ['quick', 'brown', 'fox', 'lazy', 'dog'];

const dir = await mkdtemp(path.join(os.tmpdir(), 'ms-roundtrip-'));
const spoken = path.join(dir, 'spoken.wav');
const conformed = path.join(dir, 'speech-16k.wav');

const speech = await synthesizePiperSpeech({ text: TEXT, outPath: spoken });
console.log('piper:', JSON.stringify({
  voice: speech.voice, seconds: speech.durationSeconds, sampleRate: speech.sampleRate,
}));

await extractSpeechWav({
  inputPath: spoken,
  outPath: conformed,
  ffmpegPath: process.env.MOTION_STUDIO_FFMPEG || 'ffmpeg',
});

const doc = await transcribeWithWhisper({ wavPath: conformed, language: 'en' });
const haystack = JSON.stringify(doc).toLowerCase();
const missing = MUST_SURVIVE.filter((word) => !haystack.includes(word));
if (missing.length) {
  console.error('round-trip FAILED — transcript missing:', missing.join(', '));
  console.error('transcript document (first 2000 chars):', haystack.slice(0, 2000));
  process.exit(1);
}
console.log('round-trip OK — every expected word survived synthesis and transcription');
