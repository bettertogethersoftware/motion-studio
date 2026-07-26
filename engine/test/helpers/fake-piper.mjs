/**
 * Stand-in for the Piper CLI (OHF-Voice/piper1-gpl), loadable through the
 * MOTION_STUDIO_PIPER_EXE env hook — core/tts-piper.js spawns a `.mjs` target
 * through the node binary, the same trick fake-tts.mjs uses.
 *
 * Honors the real flags, verified against piper 1.6.0:
 *
 *   --help                                   -> usage text, exit 0
 *   -m MODEL -i TEXTFILE -f OUT [--no-normalize] [--length-scale N]
 *     [--volume N] [-s N] [--sentence-silence N]
 *                                            -> writes a 1.0s PCM WAV, exit 0
 *
 * It also writes `<out>.args.json` recording the argv it was given, so tests can
 * assert that the engine passed --no-normalize (Piper normalizes to full scale
 * otherwise) and mapped rate onto --length-scale.
 *
 * Failure modes for tests:
 *   - a -m model that does not exist   -> exit 1 with a message on stderr
 *   - env FAKE_PIPER_FAIL set          -> exit 1 with a message on stderr
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (...names) => {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
  }
  return undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('usage: piper [-h] -m MODEL [-i INPUT_FILE] [-f OUTPUT_FILE] [--length-scale N]\n');
  process.exit(0);
}

if (process.env.FAKE_PIPER_FAIL) {
  process.stderr.write(`fake piper failure: ${process.env.FAKE_PIPER_FAIL}\n`);
  process.exit(1);
}

const model = opt('-m', '--model');
if (!model || !fs.existsSync(model)) {
  process.stderr.write(`Error: no such model: ${model}\n`);
  process.exit(1);
}

/** 16 kHz mono 16-bit PCM, 1.0s — the shape a real "low" quality voice emits. */
function pcmWav({ sampleRate = 16000, channels = 1, bitsPerSample = 16, seconds = 1 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataSize = byteRate * seconds;
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
  buf.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // A non-silent body, so a test can tell audio from an empty buffer.
  for (let i = 0; i < dataSize; i += 2) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 40)), 44 + i);
  return buf;
}

const out = opt('-f', '--output-file', '--output_file');
if (!out) {
  process.stderr.write('Error: this stub requires -f\n');
  process.exit(1);
}
fs.writeFileSync(out, pcmWav());
fs.writeFileSync(`${out}.args.json`, JSON.stringify(args));
process.exit(0);
