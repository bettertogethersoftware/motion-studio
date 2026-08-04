/**
 * v0.12 sound-effects generator: determinism, the normalize policies, per-cue
 * gain meaning the same thing across generators, cue placement, clamping, and
 * spec validation.
 *
 * No ffmpeg and no Chromium — core/sfx.js is pure JS, so these tests inspect the
 * Float32Array directly. Spectral checks use a small Goertzel probe rather than
 * pulling in an FFT dependency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  renderCues, synthesizeSfx, validateSfxSpec, encodeWavMono16,
  SFX_TYPES, MAX_CUES, MAX_CUE_SECONDS, ALLOWED_SAMPLE_RATES,
} from '../src/core/sfx.js';
import { parseWavHeader } from '../src/core/audio.js';
import { ErrorCodes } from '../src/core/errors.js';

const isSfxSpecError = (e) => e.code === ErrorCodes.INVALID_SFX_SPEC;

/** Energy at `hz` in `samples` — Goertzel, so no FFT dependency. */
function energyAt(samples, sampleRate, hz) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}

const peakOf = (a) => { let p = 0; for (const v of a) { const x = Math.abs(v); if (x > p) p = x; } return p; };

const spec = (over = {}) => ({
  fps: 30, durationInFrames: 90,
  cues: [{ atFrame: 0, type: 'chime', pitch: 69, gain: 0.5, decay: 0.5 }],
  ...over,
});

/* ----------------------------------------------------------- determinism -- */

test('sfx: the same spec renders byte-identically on this build', () => {
  const s = spec({
    durationInFrames: 150,
    cues: [
      { atFrame: 0, type: 'whoosh', rise: 0.3, fall: 0.2 },      // seeded noise
      { atFrame: 60, type: 'shimmer', rise: 0.4, hold: 0.2, fall: 0.4 },
      { atFrame: 120, type: 'chime', pitch: 82, decay: 0.4 },
    ],
  });
  const a = encodeWavMono16(renderCues(s).samples, 44100);
  const b = encodeWavMono16(renderCues(s).samples, 44100);
  assert.ok(a.equals(b), 're-rendering the same spec must produce identical bytes');
});

test('sfx: a cue seed changes the noise, and is stable when pinned', () => {
  const mk = (seed) => renderCues(spec({
    cues: [{ atFrame: 0, type: 'whoosh', rise: 0.3, fall: 0.2, seed }],
  })).samples;
  assert.ok(!Buffer.from(mk(1).buffer).equals(Buffer.from(mk(2).buffer)), 'different seeds must differ');
  assert.ok(Buffer.from(mk(7).buffer).equals(Buffer.from(mk(7).buffer)), 'the same seed must not');
});

test('sfx: cues are seeded independently, so two identical cues are not copies', () => {
  // Same params at different times: the noise must not be a duplicate, or a bed
  // of transition whooshes would sound mechanically repeated.
  const r = renderCues(spec({
    durationInFrames: 300, sampleRate: 44100,
    cues: [
      { atFrame: 0, type: 'whoosh', rise: 0.2, fall: 0.2 },
      { atFrame: 150, type: 'whoosh', rise: 0.2, fall: 0.2 },
    ],
  }));
  const sr = 44100;
  const a = r.samples.slice(0, Math.round(0.4 * sr));
  const b = r.samples.slice(Math.round(5 * sr), Math.round(5.4 * sr));
  assert.ok(!Buffer.from(a.buffer, a.byteOffset, a.byteLength)
    .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength)), 'per-cue seeds must differ');
});

/* -------------------------------------------------------- normalize ------- */

test('sfx: "ceiling" leaves a quiet bed alone', () => {
  const r = renderCues(spec({ cues: [{ atFrame: 0, type: 'chime', gain: 0.2, decay: 0.4 }] }));
  assert.equal(r.appliedGainDb, 0, 'a bed under the ceiling must not be touched');
  assert.ok(Math.abs(peakOf(r.samples) - 0.2) < 0.02, `expected peak ~0.2, got ${peakOf(r.samples)}`);
  // This is the whole point of the default: the reported number is the real one.
  assert.ok(Math.abs(r.peakDb - r.rawPeakDb) < 0.01);
});

test('sfx: "ceiling" pulls a hot bed down to the ceiling and reports the offset', () => {
  // Three loud cues stacked at the same instant — deliberately over full scale.
  const r = renderCues(spec({
    cues: [0, 1, 2].map((i) => ({ atFrame: i, type: 'chime', pitch: 69 + i, gain: 1, decay: 0.4 })),
  }));
  assert.ok(r.rawPeakDb > -1, `raw mix should have been hot, got ${r.rawPeakDb}`);
  assert.ok(r.appliedGainDb < 0, 'a hot bed must be attenuated');
  assert.ok(Math.abs(r.peakDb - -1) < 0.05, `expected the ceiling at -1 dBFS, got ${r.peakDb}`);
  assert.ok(peakOf(r.samples) <= 1, 'must not clip');
});

test('sfx: "peak" always lands on the ceiling; "none" leaves even a hot mix alone', () => {
  const hot = { cues: [0, 1, 2].map((i) => ({ atFrame: i, type: 'chime', pitch: 69 + i, gain: 1, decay: 0.4 })) };

  const up = renderCues(spec({ ...hot, normalize: 'peak', cues: [{ atFrame: 0, type: 'chime', gain: 0.1, decay: 0.4 }] }));
  assert.ok(up.appliedGainDb > 0, '"peak" must lift a quiet bed, unlike "ceiling"');
  assert.ok(Math.abs(up.peakDb - -1) < 0.05);

  const none = renderCues(spec({ ...hot, normalize: 'none' }));
  assert.equal(none.appliedGainDb, 0);
  assert.ok(none.rawPeakDb > -1, '"none" must let a hot mix stay hot');
});

test('sfx: ceilingDb is honoured', () => {
  const r = renderCues(spec({
    normalize: 'peak', ceilingDb: -6,
    cues: [{ atFrame: 0, type: 'chime', gain: 0.9, decay: 0.4 }],
  }));
  assert.ok(Math.abs(r.peakDb - -6) < 0.05, `expected -6 dBFS, got ${r.peakDb}`);
});

/* ------------------------------------------------------------ generators -- */

test('sfx: gain is the cue peak, identically across every generator', () => {
  // The contract that makes gain portable between types: 0.4 is 0.4 of full
  // scale whether it is a bell, a noise sweep or a sub thud.
  for (const type of SFX_TYPES) {
    const r = renderCues(spec({
      durationInFrames: 300, normalize: 'none',
      cues: [{ atFrame: 0, type, gain: 0.4, decay: 0.5, dur: 0.5, rise: 0.2, fall: 0.2, hold: 0.2 }],
    }));
    const p = peakOf(r.samples);
    assert.ok(Math.abs(p - 0.4) < 0.01, `${type}: expected peak 0.4, got ${p.toFixed(4)}`);
  }
});

test('sfx: chime energy sits at its requested pitch', () => {
  const sr = 44100;
  const r = renderCues(spec({
    durationInFrames: 60, sampleRate: sr, normalize: 'none',
    cues: [{ atFrame: 0, type: 'chime', pitch: 69, decay: 0.5 }],   // A4 = 440
  }));
  const at440 = energyAt(r.samples, sr, 440);
  const at700 = energyAt(r.samples, sr, 700);      // between partials 1 and 2
  assert.ok(at440 > at700 * 4, `fundamental should dominate: 440=${at440.toFixed(6)} 700=${at700.toFixed(6)}`);
});

test('sfx: thud is low-frequency, whoosh is not', () => {
  const sr = 44100;
  const mk = (cue) => renderCues(spec({ durationInFrames: 120, sampleRate: sr, normalize: 'none', cues: [cue] })).samples;

  const thud = mk({ atFrame: 0, type: 'thud', hz: 60, dur: 1.0 });
  assert.ok(energyAt(thud, sr, 60) > energyAt(thud, sr, 2000) * 20, 'thud energy must be in the bass');

  const whoosh = mk({ atFrame: 0, type: 'whoosh', rise: 0.4, fall: 0.3 });
  assert.ok(energyAt(whoosh, sr, 3000) > energyAt(thud, sr, 3000), 'whoosh must carry high content a thud does not');
});

test('sfx: tone honours its waveform', () => {
  const sr = 44100;
  const mk = (wave) => renderCues(spec({
    durationInFrames: 60, sampleRate: sr, normalize: 'none',
    cues: [{ atFrame: 0, type: 'tone', hz: 440, dur: 1.0, wave }],
  })).samples;
  // A square's third harmonic is far stronger than a sine's (which has none).
  const sine = mk('sine'), square = mk('square');
  assert.ok(energyAt(square, sr, 1320) > energyAt(sine, sr, 1320) * 10, 'square must be harmonically rich');
});

test('sfx: shimmer stacks all of its pitches', () => {
  const sr = 44100;
  const r = renderCues(spec({
    durationInFrames: 150, sampleRate: sr, normalize: 'none',
    cues: [{ atFrame: 0, type: 'shimmer', pitches: [69, 76], rise: 0.5, hold: 1.0, fall: 0.5 }],
  }));
  const floorE = energyAt(r.samples, sr, 1500);
  assert.ok(energyAt(r.samples, sr, 440) > floorE * 4, 'A4 voice missing');
  assert.ok(energyAt(r.samples, sr, 659.26) > floorE * 4, 'E5 voice missing');
});

/* ------------------------------------------------------------- placement -- */

test('sfx: a cue lands on its frame, within a frame', () => {
  const sr = 44100, fps = 30;
  const r = renderCues(spec({
    fps, sampleRate: sr, durationInFrames: 120, normalize: 'none',
    cues: [{ atFrame: 60, type: 'chime', gain: 0.8, decay: 0.3 }],
  }));
  let first = -1;
  for (let i = 0; i < r.samples.length; i++) if (Math.abs(r.samples[i]) > 1e-4) { first = i; break; }
  const expected = (60 / fps) * sr;
  assert.ok(Math.abs(first - expected) < sr / fps, `onset at ${first}, expected ~${expected}`);
  // And nothing before it.
  assert.equal(peakOf(r.samples.slice(0, Math.round(expected) - 10)), 0);
});

test('sfx: `at` in seconds is equivalent to the matching atFrame', () => {
  const byFrame = renderCues(spec({ cues: [{ atFrame: 30, type: 'chime', decay: 0.3 }] })).samples;
  const bySec = renderCues(spec({ cues: [{ at: 1.0, type: 'chime', decay: 0.3 }] })).samples;
  assert.ok(Buffer.from(byFrame.buffer).equals(Buffer.from(bySec.buffer)));
});

test('sfx: overhanging the end clamps and is reported, rather than throwing', () => {
  const r = renderCues(spec({
    durationInFrames: 30,                                   // 1.0 s
    cues: [{ atFrame: 27, type: 'chime', decay: 2.0 }],     // wants 6 s
  }));
  assert.equal(r.clamped, 1, 'the clamp must be reported, not silent');
  assert.equal(r.samples.length, Math.ceil((30 / 30) * 44100));
});

test('sfx: duration defaults to just long enough to hold every cue', () => {
  const r = renderCues({
    fps: 30,
    cues: [{ atFrame: 30, type: 'chime', decay: 0.5 }],      // 1.0s + 1.5s tail
  });
  assert.equal(r.clamped, 0, 'the default duration must not clip its own cues');
  assert.ok(Math.abs(r.durationSeconds - 2.5) < 0.05, `got ${r.durationSeconds}`);
});

/* ------------------------------------------------------------ validation -- */

test('sfx: rejects an unknown type, an empty cue list and a bad sample rate', () => {
  assert.throws(() => renderCues(spec({ cues: [{ atFrame: 0, type: 'explosion' }] })), isSfxSpecError);
  assert.throws(() => renderCues(spec({ cues: [] })), isSfxSpecError);
  assert.throws(() => renderCues(spec({ sampleRate: 12345 })), isSfxSpecError);
  assert.ok(ALLOWED_SAMPLE_RATES.includes(44100));
});

test('sfx: rejects ambiguous or missing placement', () => {
  assert.throws(() => renderCues(spec({ cues: [{ type: 'chime' }] })), isSfxSpecError);
  assert.throws(() => renderCues(spec({ cues: [{ type: 'chime', atFrame: 0, at: 0 }] })), isSfxSpecError);
  assert.throws(() => renderCues(spec({ cues: [{ type: 'chime', atFrame: -1 }] })), isSfxSpecError);
});

test('sfx: rejects pitch and hz together, and an out-of-range pitch', () => {
  assert.throws(() => renderCues(spec({ cues: [{ atFrame: 0, type: 'chime', pitch: 69, hz: 440 }] })), isSfxSpecError);
  assert.throws(() => renderCues(spec({ cues: [{ atFrame: 0, type: 'chime', pitch: 200 }] })), isSfxSpecError);
});

test('sfx: rejects a cue placed entirely past the end', () => {
  // Overhang clamps, but placement outside the bed is a bug worth surfacing.
  assert.throws(
    () => renderCues(spec({ durationInFrames: 30, cues: [{ atFrame: 60, type: 'chime' }] })),
    (e) => isSfxSpecError(e) && /past the end/.test(e.message),
  );
});

test('sfx: enforces the cue-count and cue-length budgets', () => {
  const many = Array.from({ length: MAX_CUES + 1 }, (_, i) => ({ atFrame: i, type: 'tone', dur: 0.05 }));
  assert.throws(() => renderCues(spec({ durationInFrames: 2000, cues: many })), isSfxSpecError);
  assert.throws(
    () => renderCues(spec({ durationInFrames: 60000, cues: [{ atFrame: 0, type: 'thud', dur: MAX_CUE_SECONDS + 1 }] })),
    isSfxSpecError,
  );
});

test('sfx: gain must be a real amplitude, not a dB value', () => {
  // Catches the likely mistake of passing gainDb here; -8 is not an amplitude.
  assert.throws(() => renderCues(spec({ cues: [{ atFrame: 0, type: 'chime', gain: -8 }] })), isSfxSpecError);
  assert.throws(() => renderCues(spec({ cues: [{ atFrame: 0, type: 'chime', gain: 4 }] })), isSfxSpecError);
});

test('validateSfxSpec: resolves defaults without rendering anything', () => {
  const s = validateSfxSpec(spec());
  assert.equal(s.sampleRate, 44100);
  assert.equal(s.normalize, 'ceiling');
  assert.equal(s.ceilingDb, -1);
  assert.equal(s.cues.length, 1);
});

test('validateSfxSpec: rejects EVERY spec renderCues rejects — no late surprises', () => {
  // The bug this guards: per-type parameter checks originally lived inside the
  // generators' render functions, so validateSfxSpec returned happily and the
  // caller ate the error mid-render — defeating the point of exporting it.
  const badSpecs = [
    ['unknown type', { cues: [{ atFrame: 0, type: 'explosion' }] }],
    ['no placement', { cues: [{ type: 'chime' }] }],
    ['both placements', { cues: [{ type: 'chime', atFrame: 0, at: 0 }] }],
    ['pitch AND hz', { cues: [{ atFrame: 0, type: 'chime', pitch: 69, hz: 440 }] }],
    ['pitch out of range', { cues: [{ atFrame: 0, type: 'chime', pitch: 200 }] }],
    ['negative hz', { cues: [{ atFrame: 0, type: 'thud', hz: -5 }] }],
    ['bad wave', { cues: [{ atFrame: 0, type: 'tone', wave: 'sawtooth' }] }],
    ['empty pitches', { cues: [{ atFrame: 0, type: 'shimmer', pitches: [] }] }],
    ['non-MIDI pitches', { cues: [{ atFrame: 0, type: 'shimmer', pitches: [70, 999] }] }],
    ['too many pitches', { cues: [{ atFrame: 0, type: 'shimmer', pitches: Array(25).fill(70) }] }],
    ['negative decay', { cues: [{ atFrame: 0, type: 'chime', decay: -1 }] }],
    ['zero dur', { cues: [{ atFrame: 0, type: 'thud', dur: 0 }] }],
    ['gain as dB', { cues: [{ atFrame: 0, type: 'chime', gain: -8 }] }],
    ['non-integer seed', { cues: [{ atFrame: 0, type: 'whoosh', seed: 1.5 }] }],
  ];
  for (const [label, over] of badSpecs) {
    assert.throws(() => validateSfxSpec(spec(over)), isSfxSpecError, `validate should reject: ${label}`);
    assert.throws(() => renderCues(spec(over)), isSfxSpecError, `render should reject: ${label}`);
  }
});

test('validateSfxSpec: hands back resolved per-type params, defaults applied', () => {
  const s = validateSfxSpec(spec({
    cues: [
      { atFrame: 0, type: 'tone', hz: 440 },
      { atFrame: 1, type: 'shimmer' },
    ],
  }));
  const [tone, shimmer] = s.cues;
  assert.equal(tone.params.hz, 440);
  assert.equal(tone.params.wave, 'sine');
  assert.equal(tone.params.dur, 0.25);
  assert.equal(shimmer.params.pitches.length, 7, 'shimmer should get its default chord');
  assert.equal(shimmer.params.lengthSeconds, 3.0 + 2.4 + 4.0);
});

/* ------------------------------------------------------------------ WAV --- */

test('sfx: writes a readable mono 16-bit WAV of the right length', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-sfx-'));
  const out = path.join(tmp, 'bed.wav');
  const res = await synthesizeSfx({
    spec: spec({ fps: 30, durationInFrames: 60, cues: [{ atFrame: 0, type: 'chime', decay: 0.4 }] }),
    outPath: out,
  });

  assert.equal(res.channels, 1);
  assert.equal(res.outPath, out);
  const info = parseWavHeader(await fsp.readFile(out), out);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataSize / info.byteRate, 2);            // 60 frames @30fps
  assert.equal(res.durationInFrames, 60);
  // The 50 MB sample array must not come back with the metadata.
  assert.equal(res.samples, undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('sfx: 22050 halves the bytes of the same bed', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-sfx-sr-'));
  const mk = async (sampleRate, name) => (await synthesizeSfx({
    spec: spec({ durationInFrames: 60, sampleRate, cues: [{ atFrame: 0, type: 'chime', decay: 0.4 }] }),
    outPath: path.join(tmp, name),
  })).bytes;
  const hi = await mk(44100, 'hi.wav');
  const lo = await mk(22050, 'lo.wav');
  assert.ok(Math.abs((hi - 44) / 2 - (lo - 44)) < 4, `expected half the payload: ${hi} vs ${lo}`);
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('sfx: int16 conversion clamps instead of wrapping', () => {
  // Without clamping, a sample above 1.0 wraps to full negative — an audible
  // click exactly where the mix was loudest.
  const buf = encodeWavMono16(Float32Array.from([2, -2, 0]), 44100);
  assert.equal(buf.readInt16LE(44), 32767);
  assert.equal(buf.readInt16LE(46), -32768);
  assert.equal(buf.readInt16LE(48), 0);
});
