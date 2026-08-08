/**
 * Frame-granular audio cues (v0.27): the per-frame envelope and the onset
 * detector behind `synthesize_speech`, `preview_audio` and `transcribe_asset`.
 *
 * Everything here is pure arithmetic — no ffmpeg, no speech vendor, no model —
 * which is the point of the plan's rule 5. The one file-touching function,
 * `measureAudioCues`, is exercised against a WAV this file writes itself.
 *
 * The test that matters is the last one. A cue detector that is three frames
 * off produces work that looks right and is wrong, so the detector is
 * VERIFIED rather than trusted, against narration assembled the way
 * `synthesize_speech` assembles it: one clip per line, concatenated with a
 * known gap, so the true line starts are arithmetic rather than opinion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  fftInPlace, nextPowerOfTwo, spectralFlux, subtractLocalMedian, pickPeaks,
  perFrameRms, detectOnsets, decodeWav16Mono, measureAudioCues, projectCues,
  CUE_DEFAULTS, MAX_INLINE_ONSETS,
} from '../src/core/audio-cues.js';
import { pcmToWavBuffer, parseWavHeader } from '../src/core/audio.js';

const SR = 16000; // whisper's extraction rate; the cheapest honest rate to test at
const FPS = 30;

/* --------------------------------- helpers -------------------------------- */

/** A voiced-speech-ish burst: an f0 stack, a fast attack, syllable modulation. */
function speechBurst(seconds, { sampleRate = SR, f0 = 120, syllablesPerSecond = 4 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    // Syllable envelope, never fully closing, plus a 5 ms attack on the line.
    const syll = 0.35 + 0.65 * Math.max(0, Math.sin(2 * Math.PI * syllablesPerSecond * t));
    const attack = Math.min(1, t / 0.005);
    out[i] = 0.35 * v * syll * attack;
  }
  return out;
}

/** Concatenate clips with a silent gap, reporting where each one starts. */
function concatWithGaps(clips, gapSeconds, sampleRate = SR) {
  const gap = Math.round(gapSeconds * sampleRate);
  const total = clips.reduce((n, c) => n + c.length, 0) + gap * (clips.length - 1);
  const out = new Float32Array(total);
  const starts = [];
  let at = 0;
  for (const c of clips) {
    starts.push(at / sampleRate);
    out.set(c, at);
    at += c.length + gap;
  }
  return { samples: out, starts };
}

const floatsToPcm16 = (samples) => {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
};

/* ----------------------------------- FFT ----------------------------------- */

test('audio-cues: the FFT puts a pure tone in the bin its frequency belongs to', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bin = 64; // exactly periodic in the window: no leakage to argue about
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
  fftInPlace(re, im);

  const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
  const peak = mags.indexOf(Math.max(...mags));
  assert.equal(peak, bin, 'tone lands in its own bin');
  assert.ok(mags[bin] > 100 * (mags[bin + 4] + 1e-9), 'and the neighbours stay empty');
});

test('audio-cues: a non-power-of-two length is refused rather than mangled', () => {
  assert.throws(() => fftInPlace(new Float64Array(100), new Float64Array(100)), /power of two/);
  assert.equal(nextPowerOfTwo(640), 1024);
  assert.equal(nextPowerOfTwo(1024), 1024);
});

/* ----------------------------- the pure signals ---------------------------- */

test('audio-cues: flux rises where energy arrives and nowhere else', () => {
  const samples = new Float32Array(SR); // one second of silence
  const at = Math.round(0.5 * SR);
  const len = Math.round(0.2 * SR);
  const fade = Math.round(0.04 * SR);
  for (let i = 0; i < len; i++) {
    // Faded out rather than cut off. An instant cut-off is a broadband click,
    // and a click IS a transient — the detector is right to fire on one, so a
    // fixture that ends abruptly would be testing the fixture, not the claim.
    const decay = i > len - fade ? (len - i) / fade : 1;
    samples[at + i] = 0.4 * decay * Math.sin((2 * Math.PI * 440 * (at + i)) / SR);
  }
  const { flux, hopSize } = spectralFlux(samples, { sampleRate: SR });
  const hopSeconds = hopSize / SR;

  const peakHop = flux.indexOf(Math.max(...flux));
  assert.ok(
    Math.abs(peakHop * hopSeconds - 0.5) < 0.02,
    `flux peaks at the arrival (got ${(peakHop * hopSeconds).toFixed(3)}s)`,
  );
  // The tone's END is a decay, and a decay is not an onset.
  const endHop = Math.round(0.7 / hopSeconds);
  assert.ok(flux[endHop] < flux[peakHop] * 0.1, 'the tail produces no rival peak');
});

test('audio-cues: the local median lets a quiet passage keep its onsets', () => {
  // A loud plateau and a quiet one, each carrying one spike of its own scale.
  const n = 400;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = i < 200 ? 10 : 1;
  values[100] = 40;
  values[300] = 4;

  const flat = subtractLocalMedian(values, 20);
  assert.equal(flat[10], 0, 'a flat run is flattened to zero');
  assert.ok(flat[100] > 0 && flat[300] > 0, 'both spikes survive');
  // Against the raw signal the quiet spike (4) is far below the loud plateau
  // (10) and would never be picked; after subtraction it is a real peak.
  assert.ok(values[300] < values[10], 'raw: the quiet spike is under the loud floor');
  assert.ok(flat[300] > flat[10], 'subtracted: it stands above it');
});

test('audio-cues: peak picking obeys the refractory gap and keeps the strongest', () => {
  const values = new Float64Array(100);
  values[20] = 5;
  values[23] = 9;   // same syllable, 3 samples later — must collapse into one
  values[26] = 4;
  values[70] = 8;   // a genuinely separate event
  values[75] = 0.2; // below minStrength

  const peaks = pickPeaks(values, { halfWindow: 2, refractory: 10, minStrength: 0.12 });
  assert.deepEqual(peaks.map((p) => p.index), [23, 70], 'one cue per event, the loudest instant');
  assert.equal(peaks[0].strength, 1, 'strength is relative to the strongest peak');
  assert.ok(peaks[1].strength > 0.8 && peaks[1].strength < 1);
});

test('audio-cues: the envelope is per FRAME, linear, and honest about level', () => {
  // A full-scale square wave: RMS is exactly 1 wherever it plays.
  const seconds = 2;
  const samples = new Float32Array(seconds * SR);
  for (let i = 0; i < samples.length / 2; i++) samples[i] = i % 2 ? 1 : -1;

  const env = perFrameRms(samples, { sampleRate: SR, fps: FPS });
  assert.equal(env.length, seconds * FPS, 'one value per frame, not per second');
  assert.equal(env[0], 1, 'full-scale reads 1.0 linear, not dB');
  assert.equal(env[env.length - 1], 0, 'and silence reads 0');
  // The point of the whole field: within the first second the value CHANGES
  // frame to frame, which a one-second bucket cannot express.
  const firstSecond = env.slice(0, FPS);
  assert.ok(firstSecond.every((v) => v === 1), 'steady tone is steady');
  assert.ok(env[Math.round(1.5 * FPS)] === 0, 'and the drop lands on the right frame');
});

/* ------------------------------ decode + file ------------------------------ */

test('audio-cues: measureAudioCues reads a real WAV and reports what it measured', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-cues-'));
  try {
    const samples = speechBurst(1.0);
    const file = path.join(dir, 'clip.wav');
    await fsp.writeFile(file, pcmToWavBuffer(floatsToPcm16(samples), { sampleRate: SR, channels: 1 }));

    const cues = await measureAudioCues(file, { fps: FPS });
    assert.equal(cues.fps, FPS);
    assert.equal(cues.sampleRate, SR);
    assert.equal(cues.frameCount, 30, 'a one-second clip at 30 fps is 30 frames');
    assert.equal(cues.envelope.length, cues.frameCount, 'the envelope covers every frame');
    assert.ok(cues.envelopePeak > 0.05, 'and reports the clip peak so a caller can normalise');
    assert.ok(cues.onsets.length >= 3, 'four syllables per second produce cues');
    for (const o of cues.onsets) {
      assert.ok(Number.isInteger(o.frame) && o.frame >= 0 && o.frame <= cues.frameCount);
      assert.ok(o.strength > 0 && o.strength <= 1);
    }
    const frames = cues.onsets.map((o) => o.frame);
    assert.deepEqual(frames, [...frames].sort((a, b) => a - b), 'cues are in time order');
    assert.equal(new Set(frames).size, frames.length, 'and never repeat a frame');

    // 8-bit is "unknown", not an error: a cue measurement must never fail a
    // synthesis or a mix that otherwise worked.
    const raw = await fsp.readFile(file);
    const info = parseWavHeader(raw, file);
    const eight = Buffer.from(raw);
    eight.writeUInt16LE(8, info.dataOffset - 8 - 16 + 14);
    const oddFile = path.join(dir, 'eight-bit.wav');
    await fsp.writeFile(oddFile, eight);
    assert.equal(await measureAudioCues(oddFile, { fps: FPS }), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('audio-cues: stereo is averaged to one programme before analysis', () => {
  const n = 100;
  const pcm = Buffer.alloc(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(16384, i * 4);      // left  +0.5
    pcm.writeInt16LE(-16384, i * 4 + 2); // right -0.5
  }
  const wav = pcmToWavBuffer(pcm, { sampleRate: SR, channels: 2 });
  const mono = decodeWav16Mono(wav, parseWavHeader(wav));
  assert.equal(mono.length, n, 'sample frames, not bytes');
  assert.ok(Math.abs(mono[0]) < 1e-3, 'a hard-panned pair cancels to the centre');
});

/* -------------------------------- projection ------------------------------- */

test('audio-cues: the summary is small, the arrays are opt-in, the cap is stated', () => {
  const onsets = Array.from({ length: MAX_INLINE_ONSETS + 25 }, (_, i) => ({
    frame: i * 2, seconds: i / 15, strength: 0.5,
  }));
  const cues = { fps: 30, frameCount: 900, envelope: new Array(900).fill(0.2), envelopePeak: 0.8, onsets };

  const summary = projectCues(cues, 'summary');
  assert.equal(summary.onsetCount, onsets.length, 'the true count is always reported');
  assert.equal(summary.onsetFrames.length, MAX_INLINE_ONSETS);
  assert.equal(summary.onsetFramesTruncated, true, 'a cap that bites says so — never a silent trim');
  assert.ok(summary.hint.includes('full'), 'and names the way to get the rest');
  assert.equal(summary.envelope, undefined, '9,000 floats are not a default payload');
  assert.equal(summary.envelopePeak, 0.8, 'but the divisor a caller needs is');

  const full = projectCues(cues, 'full');
  assert.equal(full.envelope.length, 900);
  assert.equal(full.onsets.length, onsets.length, 'full carries every cue, with strength');
  assert.equal(full.onsetFramesTruncated, undefined);

  assert.equal(projectCues(null), null, 'an unmeasurable file projects to nothing, not a throw');
  const small = projectCues({ ...cues, onsets: onsets.slice(0, 3) }, 'summary');
  assert.equal(small.onsetFramesTruncated, undefined, 'no flag when the cap does not bite');
});

/* --------------------------- the verification test -------------------------- */

test('audio-cues: recovers known line starts from assembled narration, within 2 frames', () => {
  // The construction synthesize_speech uses for its timings: one clip per
  // line, concatenated with a fixed gap, so every start is exact by
  // arithmetic. Lines vary in length so the starts are not on a grid the
  // detector could accidentally match.
  const lines = [0.9, 1.4, 0.7, 1.8, 1.1].map((s, i) => speechBurst(s, { f0: 110 + i * 15 }));
  const { samples, starts } = concatWithGaps(lines, 0.35);

  const onsets = detectOnsets(samples, { sampleRate: SR, fps: FPS });
  assert.ok(onsets.length >= starts.length, 'at least one cue per line');

  const tolerance = 2; // frames, at 30 fps — the plan's budget
  const errors = starts.map((startSeconds) => {
    const trueFrame = Math.round(startSeconds * FPS);
    const nearest = onsets.reduce(
      (best, o) => (Math.abs(o.frame - trueFrame) < Math.abs(best - trueFrame) ? o.frame : best),
      Infinity,
    );
    return { trueFrame, nearest, error: Math.abs(nearest - trueFrame) };
  });

  for (const e of errors) {
    assert.ok(
      e.error <= tolerance,
      `line start at frame ${e.trueFrame}: nearest cue ${e.nearest} is ${e.error} frames off`,
    );
  }
  // A detector that fires on every hop would also pass the test above, so
  // bound the other side: five lines of ~4 syllables/second should not
  // produce hundreds of cues.
  const seconds = samples.length / SR;
  assert.ok(onsets.length < seconds * 12, `${onsets.length} cues in ${seconds.toFixed(1)}s is not a detector, it is a metronome`);
});

test('audio-cues: the reported time tracks the attack, not the analysis window', () => {
  // Measured, and worth freezing: the cue lands within a hop of a hard attack
  // and drifts by about HALF the attack ramp as the attack softens — which is
  // the perceptual answer, not an error to calibrate away. A window-length
  // bias (±20-40 ms) would look identical on one fixture and be wrong on the
  // next, so pin all four.
  const SEEN = [];
  for (const attackMs of [0, 5, 20, 40]) {
    const n = SR * 2;
    const s = new Float32Array(n);
    const at = Math.round(0.5 * SR);
    const ramp = Math.round((attackMs / 1000) * SR);
    for (let i = at; i < n; i++) {
      const env = ramp ? Math.min(1, (i - at) / ramp) : 1;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * 130 * h * i) / SR) / h;
      s[i] = 0.35 * v * env;
    }
    const first = detectOnsets(s, { sampleRate: SR, fps: FPS })[0];
    assert.ok(first, `an attack ramping over ${attackMs} ms is detected at all`);
    SEEN.push({ attackMs, biasMs: Math.round((first.seconds - 0.5) * 1000), frame: first.frame });
  }
  assert.deepEqual(SEEN, [
    { attackMs: 0, biasMs: -10, frame: 15 },
    { attackMs: 5, biasMs: 0, frame: 15 },
    { attackMs: 20, biasMs: 10, frame: 15 },
    { attackMs: 40, biasMs: 20, frame: 16 },
  ], 'bias stays within one hop of half the attack ramp');
});

test('audio-cues: a line that begins at frame 0 is still detected', () => {
  // The centred-window property, as a test: with windows that START at their
  // hop, hop 0 has no predecessor and the opening cue is invisible.
  const samples = speechBurst(1.2);
  const onsets = detectOnsets(samples, { sampleRate: SR, fps: FPS });
  assert.ok(onsets.length > 0, 'something was detected');
  assert.ok(onsets[0].frame <= 2, `the opening attack is at frame ${onsets[0].frame}, not lost`);
});

test('audio-cues: silence produces no cues and an all-zero envelope', () => {
  const samples = new Float32Array(SR);
  assert.deepEqual(detectOnsets(samples, { sampleRate: SR, fps: FPS }), []);
  const env = perFrameRms(samples, { sampleRate: SR, fps: FPS });
  assert.ok(env.every((v) => v === 0));
  assert.equal(CUE_DEFAULTS.hopSeconds, 0.01, 'the documented hop is the one in use');
});
