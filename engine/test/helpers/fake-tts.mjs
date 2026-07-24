/**
 * Stand-in for the external Windows MotionStudioTts.exe, loadable across process
 * boundaries via the MOTION_STUDIO_TTS_EXE env hook (core/tts.js spawns a
 * `.mjs` target through the node binary). Honors the exe CLI contract exactly:
 *
 *   --list-voices                          -> JSON array of voice names, exit 0
 *   --text-file F --out W [--voice V] ...  -> writes a 1.0s PCM WAV to W, prints
 *                                             the success JSON line, exit 0
 *
 * Failure modes for tests:
 *   - an unknown --voice                -> { ok:false, code:"unsupported_voice" }, exit 1
 *   - env FAKE_TTS_FAIL set (truthy)    -> { ok:false, code:"tts_failed" },        exit 1
 */
import fs from 'node:fs';

const KNOWN_VOICES = ['Microsoft David Desktop', 'Microsoft Zira Desktop'];
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

if (args.includes('--list-voices')) {
  emit(KNOWN_VOICES);
  process.exit(0);
}

if (process.env.FAKE_TTS_FAIL) {
  emit({ ok: false, code: 'tts_failed', error: `fake failure: ${process.env.FAKE_TTS_FAIL}` });
  process.exit(1);
}

const voice = opt('--voice');
if (voice && !KNOWN_VOICES.includes(voice)) {
  emit({ ok: false, code: 'unsupported_voice', error: `no voice named "${voice}"` });
  process.exit(1);
}

/** Minimal PCM WAV: 22050 Hz, mono, 16-bit → byteRate 44100; 44100 data bytes = 1.0s. */
function pcmWav({ sampleRate = 22050, channels = 1, bitsPerSample = 16, dataSize = 44100 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const out = opt('--out');
const sampleRate = 22050;
const channels = 1;
const wav = pcmWav({ sampleRate, channels });
fs.writeFileSync(out, wav);
emit({
  ok: true,
  voice: voice ?? KNOWN_VOICES[0],
  durationSeconds: 1.0,
  sampleRate,
  channels,
  bytes: wav.length,
  outPath: out,
});
process.exit(0);
