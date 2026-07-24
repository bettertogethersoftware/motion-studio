/**
 * Stand-in for fluidsynth.exe, loadable via MOTION_STUDIO_FLUIDSYNTH (core/music.js
 * spawns a `.mjs` target through node). Mimics only what the pipeline uses:
 *
 *   fluidsynth -ni -T wav -F <out.wav> -r <rate> -g <gain> <soundfont> <song.mid>
 *
 * Parses `-F` for the output path and `-r` for the sample rate, then writes a
 * short valid PCM WAV there (the soundfont and MIDI inputs are ignored — this is
 * a wiring stub, not a synthesizer). Exits 0.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const optAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const out = optAfter('-F');
const sampleRate = Number(optAfter('-r')) || 44100;
const channels = 2;
const bitsPerSample = 16;
const seconds = 0.25; // a hair of audio is enough for muxing + header parsing

const byteRate = sampleRate * channels * (bitsPerSample / 8);
const blockAlign = channels * (bitsPerSample / 8);
const dataSize = Math.round(byteRate * seconds);
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
fs.writeFileSync(out, buf);
process.exit(0);
