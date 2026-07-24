/**
 * Stand-in for the external Windows MotionStudioMidi.exe (the DryWetMIDI half of
 * the music pipeline), loadable across process boundaries via
 * MOTION_STUDIO_MIDI_EXE (core/music.js spawns a `.mjs` target through node).
 * Honors the exe CLI contract:
 *
 *   --spec-file F --out M  -> writes a minimal valid Standard MIDI File to M,
 *                             prints the success JSON line, exit 0
 *
 * Failure modes for tests (via env FAKE_MIDI_FAIL):
 *   FAKE_MIDI_FAIL=spec  -> { ok:false, code:"invalid_music_spec" }, exit 2
 *   FAKE_MIDI_FAIL=<any> -> { ok:false, code:"music_failed" },       exit 1
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

if (process.env.FAKE_MIDI_FAIL === 'spec') {
  emit({ ok: false, code: 'invalid_music_spec', error: 'fake: spec rejected' });
  process.exit(2);
}
if (process.env.FAKE_MIDI_FAIL) {
  emit({ ok: false, code: 'music_failed', error: `fake failure: ${process.env.FAKE_MIDI_FAIL}` });
  process.exit(1);
}

const specFile = opt('--spec-file');
const out = opt('--out');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));

// Minimal Standard MIDI File: an MThd (format 0, 1 track, 480 TPQ) followed by
// an MTrk holding just an end-of-track meta event. Structurally valid; the real
// notes are irrelevant because FluidSynth is stubbed too.
const mthd = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
const mtrk = Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0x00, 0xff, 0x2f, 0x00]);
fs.writeFileSync(out, Buffer.concat([mthd, mtrk]));

const tracks = Array.isArray(spec.tracks) ? spec.tracks.length : 0;
const notes = (spec.tracks || []).reduce((s, t) => s + (Array.isArray(t.notes) ? t.notes.length : 0), 0);
emit({ ok: true, tracks, notes, bpm: spec.bpm || 120, durationSeconds: 2.0, outPath: out });
process.exit(0);
