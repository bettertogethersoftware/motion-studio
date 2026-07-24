/**
 * Unit tests for the music core module (no real toolchain, no ffmpeg): the
 * env-var resolvers, the checkMusic availability probe, and the two-stage
 * spawn/contract mapping (MIDI exe → FluidSynth) against Node stubs injected via
 * the midiExe/fluidsynth arguments (helpers/fake-music.mjs, fake-fluidsynth.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  synthesizeMusic, checkMusic, resolveMidiExe, resolveFluidSynth, resolveSoundFont,
} from '../src/core/music.js';
import { wavDurationSeconds } from '../src/core/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MIDI = path.resolve(__dirname, 'helpers/fake-music.mjs');
const FAKE_FLUIDSYNTH = path.resolve(__dirname, 'helpers/fake-fluidsynth.mjs');
const FAKE_SOUNDFONT = path.resolve(__dirname, 'fixtures/fake.sf2');

const SPEC = {
  bpm: 100,
  tracks: [
    { program: 0, notes: [{ pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 }] },
    { program: 32, notes: [{ pitch: 48, start: 0, duration: 2 }] },
  ],
};

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-music-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

const stubs = { midiExe: FAKE_MIDI, fluidsynth: FAKE_FLUIDSYNTH, soundfont: FAKE_SOUNDFONT };

test('resolvers prefer an explicit path over env and default', () => {
  assert.equal(resolveMidiExe('/x/midi.exe'), '/x/midi.exe');
  assert.equal(resolveFluidSynth('/x/fs.exe'), '/x/fs.exe');
  assert.equal(resolveSoundFont('/x/font.sf2'), '/x/font.sf2');
  // With no explicit arg and no env override, defaults land under engine/vendor/.
  assert.match(resolveMidiExe(), /vendor[\\/]music[\\/]MotionStudioMidi\.exe$/);
  assert.match(resolveFluidSynth(), /vendor[\\/]fluidsynth[\\/]bin[\\/]fluidsynth\.exe$/);
  assert.match(resolveSoundFont(), /vendor[\\/]soundfonts[\\/]/);
});

test('checkMusic reports available when all three pieces exist', async () => {
  const probe = await checkMusic(stubs);
  assert.equal(probe.available, true, JSON.stringify(probe));
});

test('checkMusic reports unavailable and names every missing piece', async () => {
  const probe = await checkMusic({
    midiExe: path.join(os.tmpdir(), 'no-such-midi.exe'),
    fluidsynth: path.join(os.tmpdir(), 'no-such-fs.exe'),
    soundfont: path.join(os.tmpdir(), 'no-such.sf2'),
  });
  assert.equal(probe.available, false);
  assert.match(probe.error, /missing:/);
  assert.match(probe.error, /MIDI exe/);
  assert.match(probe.error, /fluidsynth/);
  assert.match(probe.error, /soundfont/);
});

test('checkMusic still flags a partial toolchain (soundfont only)', async () => {
  const probe = await checkMusic({
    midiExe: FAKE_MIDI,
    fluidsynth: path.join(os.tmpdir(), 'no-such-fs.exe'),
    soundfont: FAKE_SOUNDFONT,
  });
  assert.equal(probe.available, false);
  assert.match(probe.error, /fluidsynth/);
});

test('synthesizeMusic runs both stages and writes a playable WAV', async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, 'song.wav');
    const res = await synthesizeMusic({ spec: SPEC, outPath: out, ...stubs });
    assert.equal(res.tracks, 2);
    assert.equal(res.notes, 3);
    assert.equal(res.bpm, 100);
    assert.equal(res.musicalDurationSeconds, 2.0); // from the MIDI stub
    assert.equal(res.outPath, out);
    assert.ok(fs.existsSync(out));
    // The stub FluidSynth emits 0.25s of 44100 Hz audio; header must round-trip.
    assert.ok(Math.abs((await wavDurationSeconds(out)) - 0.25) < 0.02);
  });
});

test('synthesizeMusic honors a requested sample rate through to the WAV', async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, 'song.wav');
    const res = await synthesizeMusic({ spec: SPEC, outPath: out, sampleRate: 22050, ...stubs });
    assert.equal(res.sampleRate, 22050);
    // duration is rate-independent (dataSize scales with rate), so still ~0.25s.
    assert.ok(Math.abs((await wavDurationSeconds(out)) - 0.25) < 0.02);
  });
});

test('synthesizeMusic maps a rejected spec to invalid_music_spec', async () => {
  await withTmp(async (dir) => {
    process.env.FAKE_MIDI_FAIL = 'spec';
    try {
      await assert.rejects(
        synthesizeMusic({ spec: SPEC, outPath: path.join(dir, 'song.wav'), ...stubs }),
        (e) => e.code === 'invalid_music_spec',
      );
    } finally {
      delete process.env.FAKE_MIDI_FAIL;
    }
  });
});

test('synthesizeMusic maps a generic MIDI-exe failure to music_failed', async () => {
  await withTmp(async (dir) => {
    process.env.FAKE_MIDI_FAIL = '1';
    try {
      await assert.rejects(
        synthesizeMusic({ spec: SPEC, outPath: path.join(dir, 'song.wav'), ...stubs }),
        (e) => e.code === 'music_failed',
      );
    } finally {
      delete process.env.FAKE_MIDI_FAIL;
    }
  });
});

test('synthesizeMusic maps a missing MIDI exe to music_unavailable', async () => {
  await withTmp(async (dir) => {
    await assert.rejects(
      synthesizeMusic({
        spec: SPEC, outPath: path.join(dir, 'song.wav'),
        midiExe: path.join(dir, 'nope.exe'), fluidsynth: FAKE_FLUIDSYNTH, soundfont: FAKE_SOUNDFONT,
      }),
      (e) => e.code === 'music_unavailable',
    );
  });
});
