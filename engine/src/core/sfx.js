/**
 * Sound-effects generator (v0.12) — pure JS, no external dependency.
 *
 * `synthesize_speech` covers voice and `synthesize_music` covers pitched notes,
 * but neither can make a *noise*: a whoosh on a cut, a chime between scenes, a
 * thud when a gate shuts, a shimmer under a reveal. Two ten-minute films each
 * hand-rolled ~100 lines of DSP plus a raw RIFF writer to get those, entirely
 * outside the engine and outside its tests. This is that code, owned properly.
 *
 * Unlike music there is nothing to install (no MIDI exe, no FluidSynth, no
 * SoundFont), so there is deliberately no `sfx_unavailable` twin to
 * `music_unavailable` — this module can always run.
 *
 * Shape: one call renders a whole *cue list* into a single mono WAV, because
 * that is how films consume it — a bed of cues at absolute times, laid over the
 * film as one track on `build_film`'s master timeline.
 *
 *   renderCues(spec)                → { samples, peakDb, … }  pure, no I/O
 *   synthesizeSfx({ spec, outPath }) → writes the WAV, returns metadata
 *
 * TIME IS IN FRAMES. Everything else that places audio in this engine speaks
 * frames (`config.audio.startInFrames`, `build_film`'s timeline, a scene's
 * `filmOffset`), so `atFrame` lets "a chime on every scene cut" be a plain map
 * over scene offsets instead of a hand-computed division that hides off-by-ones.
 * Seconds (`at`) are accepted for non-film use; exactly one of the two.
 *
 * DETERMINISM — read this before relying on it. All noise comes from a seeded
 * PRNG, so re-running the same spec on the same Node build is byte-identical,
 * and the tests assert that. It is NOT guaranteed across Node/V8 versions:
 * ECMAScript does not pin the results of `Math.sin`/`Math.exp`, and this module
 * uses both. Pinning that would mean shipping fixed-point transcendental
 * tables, which is not worth it for a sound-effects bed — but the limit is a
 * decision, not an oversight. (Frame *rendering* determinism is unaffected;
 * that contract is about the composition, and audio is generated once here.)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';

/* ------------------------------------------------------------- limits ---- */

export const SFX_TYPES = Object.freeze(['chime', 'whoosh', 'shimmer', 'thud', 'tone']);
/** Enough for a cue on every cut of a long film, low enough to bound the work. */
export const MAX_CUES = 512;
/** A single cue is a *cue*; anything longer is a music bed or an ambience loop. */
export const MAX_CUE_SECONDS = 30;
export const DEFAULT_SAMPLE_RATE = 44100;
/** 22050 halves the file for a long bed; below that, bell partials get dull. */
export const ALLOWED_SAMPLE_RATES = Object.freeze([22050, 44100, 48000]);
export const DEFAULT_CEILING_DB = -1;

const bad = (message, detail) => new EngineError(ErrorCodes.INVALID_SFX_SPEC, message, detail);

/* ------------------------------------------------------------- helpers --- */

const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => 20 * Math.log10(g);

/** mulberry32 — small, fast, and fully determined by its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;   // −1..1
  };
}

const num = (v, fallback) => (v === undefined || v === null ? fallback : v);

function requirePositive(name, v, cueIndex, { max } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw bad(`cue ${cueIndex}: ${name} must be a positive number (got ${JSON.stringify(v)})`, { cue: cueIndex });
  }
  if (max !== undefined && v > max) {
    throw bad(`cue ${cueIndex}: ${name} must be <= ${max} (got ${v})`, { cue: cueIndex });
  }
  return v;
}

/**
 * Frequency for a cue: `pitch` (MIDI, matching synthesize_music's vocabulary)
 * or `hz` for something untuned. Exactly one — silently preferring one would
 * make a typo'd `pitch: 62` look like it worked when `hz: 62` was meant.
 */
function cueHz(cue, i, fallbackMidi) {
  const hasPitch = cue.pitch !== undefined && cue.pitch !== null;
  const hasHz = cue.hz !== undefined && cue.hz !== null;
  if (hasPitch && hasHz) throw bad(`cue ${i}: set pitch OR hz, not both`, { cue: i });
  if (hasHz) return requirePositive('hz', cue.hz, i, { max: 20000 });
  if (hasPitch) {
    if (!Number.isInteger(cue.pitch) || cue.pitch < 0 || cue.pitch > 127) {
      throw bad(`cue ${i}: pitch must be an integer MIDI note 0..127 (got ${cue.pitch})`, { cue: i });
    }
    return midiToHz(cue.pitch);
  }
  return midiToHz(fallbackMidi);
}

/* ---------------------------------------------------------- generators --- */
/*
 * Each generator is a pair:
 *
 *   resolve(cue, i) → params   validate + apply defaults, and report the cue's
 *                              natural `lengthSeconds`. Throws INVALID_SFX_SPEC.
 *   render(out, n, params, sr, rng)   write samples; params are already trusted.
 *
 * The split exists because a half-validating validator is worse than none: with
 * the checks living inside render, `validateSfxSpec` would return happily and
 * then renderCues would throw on the same spec — so a caller who validated up
 * front (the whole point of exporting it) got the error at the worst moment.
 * Every parameter is now checked before a single sample is allocated.
 *
 * Output is scaled afterwards so the cue's PEAK equals its `gain`. That is why
 * `gain` means the same thing across every type — 0.4 is 0.4 of full scale
 * whether it is a bell or a filtered-noise sweep.
 *
 * Descending-pitch cues accumulate phase rather than evaluating sin(2π·f(t)·t):
 * the latter sweeps roughly twice as fast as its own frequency curve claims,
 * which is a bug shipped by hand twice before it got written down here.
 */

/** Shared: validate a MIDI-note array for the stacked generators. */
function resolvePitches(c, i, fallback) {
  const pitches = c.pitches ?? fallback;
  if (!Array.isArray(pitches) || !pitches.length) {
    throw bad(`cue ${i}: shimmer needs a non-empty pitches array`, { cue: i });
  }
  if (pitches.length > 24) throw bad(`cue ${i}: shimmer takes at most 24 pitches`, { cue: i });
  for (const m of pitches) {
    if (!Number.isInteger(m) || m < 0 || m > 127) {
      throw bad(`cue ${i}: shimmer pitches must be MIDI notes 0..127 (got ${JSON.stringify(m)})`, { cue: i });
    }
  }
  return pitches;
}

const GENERATORS = {
  /** Struck bell. Inharmonic partials, upper ones decaying faster. */
  chime: {
    resolve(c, i) {
      const decay = requirePositive('decay', num(c.decay, 2.0), i, { max: MAX_CUE_SECONDS / 3 });
      return { hz: cueHz(c, i, 82), decay, lengthSeconds: decay * 3 };
    },
    render(out, n, p, sr) {
      const partials = [
        { r: 1.00, a: 1.00, d: 1.00 },
        { r: 2.00, a: 0.44, d: 0.72 },
        { r: 2.76, a: 0.26, d: 0.50 },
        { r: 4.16, a: 0.13, d: 0.32 },
        { r: 5.43, a: 0.07, d: 0.22 },
      ];
      for (let k = 0; k < n; k++) {
        const t = k / sr;
        const attack = Math.min(1, t / 0.004);        // 4 ms: soft strike, no click
        let s = 0;
        for (const q of partials) s += Math.sin(2 * Math.PI * p.hz * q.r * t) * q.a * Math.exp(-t / (p.decay * q.d));
        out[k] = s * attack;
      }
    },
  },

  /** Transition sweep: seeded noise through a moving filter, peaking on the cut. */
  whoosh: {
    resolve(c, i) {
      const rise = requirePositive('rise', num(c.rise, 0.6), i, { max: MAX_CUE_SECONDS });
      const fall = requirePositive('fall', num(c.fall, 0.45), i, { max: MAX_CUE_SECONDS });
      return { rise, fall, lengthSeconds: rise + fall };
    },
    render(out, n, p, sr, rng) {
      let lp = 0, hp = 0, prev = 0, phase = 0;
      for (let k = 0; k < n; k++) {
        const t = k / sr;
        const rel = t - p.rise;                        // 0 exactly on the hit
        const env = rel <= 0
          ? Math.pow(Math.max(0, t / p.rise), 3.2)
          : Math.exp(-rel / (p.fall * 0.34));
        // Cutoff opens into the hit and shuts after it — the "whoosh" shape.
        const openness = rel <= 0 ? 0.04 + 0.5 * (t / p.rise) : 0.5 * Math.exp(-rel / 0.16);
        lp += (rng() - lp) * Math.max(0.01, openness);
        hp = lp - prev + hp * 0.86;                    // one-pole HP: removes mud
        prev = lp;
        const f = 132 * Math.exp(-Math.max(0, rel) * 2.4);
        phase += (2 * Math.PI * f) / sr;
        const body = Math.sin(phase) * 0.22 * (rel <= 0 ? env : Math.exp(-rel / 0.2));
        out[k] = (hp * 0.9 + body) * env;
      }
    },
  },

  /** Slow awe bloom: detuned sine stack, per-voice tremolo, air underneath. */
  shimmer: {
    resolve(c, i) {
      const rise = requirePositive('rise', num(c.rise, 3.0), i, { max: MAX_CUE_SECONDS });
      const hold = requirePositive('hold', num(c.hold, 2.4), i, { max: MAX_CUE_SECONDS });
      const fall = requirePositive('fall', num(c.fall, 4.0), i, { max: MAX_CUE_SECONDS });
      const pitches = resolvePitches(c, i, [70, 74, 77, 82, 86, 89, 94]);
      return { rise, hold, fall, pitches, lengthSeconds: rise + hold + fall };
    },
    render(out, n, p, sr, rng) {
      const mid = (p.pitches.length - 1) / 2;
      const voices = p.pitches.map((m, v) => ({
        f: midiToHz(m) * (1 + (v - mid) * 0.0004),     // micro-detune, so it breathes
        a: 1 / (1 + v * 0.55),
        ph: rng() * Math.PI,
      }));
      let lp = 0;
      for (let k = 0; k < n; k++) {
        const t = k / sr;
        const env = t < p.rise
          ? Math.pow(t / p.rise, 2.0)
          : t < p.rise + p.hold ? 1 : Math.exp(-(t - p.rise - p.hold) / (p.fall * 0.42));
        let s = 0;
        for (const v of voices) {
          const trem = 1 + 0.14 * Math.sin(2 * Math.PI * 0.23 * t + v.ph);
          s += Math.sin(2 * Math.PI * v.f * t + v.ph) * v.a * trem;
        }
        lp += (rng() - lp) * 0.035;
        out[k] = (s * 0.12 + lp * 0.10) * env;
      }
    },
  },

  /** Weight: a descending body that settles rather than clicks. */
  thud: {
    resolve(c, i) {
      const dur = requirePositive('dur', num(c.dur, 2.6), i, { max: MAX_CUE_SECONDS });
      return { hz: cueHz(c, i, 34), dur, lengthSeconds: dur };   // default ~62 Hz
    },
    render(out, n, p, sr) {
      let phase = 0;
      for (let k = 0; k < n; k++) {
        const t = k / sr;
        const env = Math.min(1, t / 0.09) * Math.exp(-t / (p.dur * 0.30));
        const f = p.hz * Math.exp(-t * 0.55);
        phase += (2 * Math.PI * f) / sr;
        out[k] = (Math.sin(phase) + 0.34 * Math.sin(2 * phase)) * env;
      }
    },
  },

  /** Plain oscillator + AR envelope. The escape hatch: blips, counters, beeps. */
  tone: {
    resolve(c, i) {
      const dur = requirePositive('dur', num(c.dur, 0.25), i, { max: MAX_CUE_SECONDS });
      const wave = num(c.wave, 'sine');
      if (!['sine', 'triangle', 'square'].includes(wave)) {
        throw bad(`cue ${i}: wave must be sine, triangle or square (got ${JSON.stringify(wave)})`, { cue: i });
      }
      return {
        hz: cueHz(c, i, 69),
        dur,
        wave,
        attack: Math.max(0.001, num(c.attack, 0.01)),
        release: Math.max(0.001, num(c.release, 0.08)),
        lengthSeconds: dur,
      };
    },
    render(out, n, p, sr) {
      for (let k = 0; k < n; k++) {
        const t = k / sr;
        const ph = (p.hz * t) % 1;
        const osc = p.wave === 'sine' ? Math.sin(2 * Math.PI * ph)
          : p.wave === 'square' ? (ph < 0.5 ? 1 : -1)
            : 4 * Math.abs(ph - 0.5) - 1;
        const env = Math.min(1, t / p.attack) * Math.min(1, Math.max(0, (p.dur - t) / p.release));
        out[k] = osc * env;
      }
    },
  },
};

/* ---------------------------------------------------------- validation --- */

/**
 * Normalize + budget-check a spec. Returns a plain resolved object; throws
 * INVALID_SFX_SPEC with the offending cue index in `detail`.
 */
export function validateSfxSpec(spec) {
  if (!spec || typeof spec !== 'object') throw bad('spec must be an object');

  const fps = spec.fps;
  if (!Number.isFinite(fps) || fps <= 0) throw bad(`spec.fps must be a positive number (got ${JSON.stringify(fps)})`);

  const sampleRate = num(spec.sampleRate, DEFAULT_SAMPLE_RATE);
  if (!ALLOWED_SAMPLE_RATES.includes(sampleRate)) {
    throw bad(`spec.sampleRate must be one of ${ALLOWED_SAMPLE_RATES.join(', ')} (got ${sampleRate})`);
  }

  const normalize = num(spec.normalize, 'ceiling');
  if (!['ceiling', 'peak', 'none'].includes(normalize)) {
    throw bad(`spec.normalize must be ceiling, peak or none (got ${JSON.stringify(normalize)})`);
  }
  const ceilingDb = num(spec.ceilingDb, DEFAULT_CEILING_DB);
  if (!Number.isFinite(ceilingDb) || ceilingDb > 0 || ceilingDb < -60) {
    throw bad(`spec.ceilingDb must be between -60 and 0 (got ${ceilingDb})`);
  }

  const cues = spec.cues;
  if (!Array.isArray(cues) || cues.length === 0) throw bad('spec.cues must be a non-empty array');
  if (cues.length > MAX_CUES) throw bad(`spec.cues has ${cues.length} cues; the limit is ${MAX_CUES}`);

  // Resolve each cue's start and natural length before allocating anything, so
  // an over-budget spec is rejected instead of being half-rendered.
  const resolved = cues.map((cue, i) => {
    if (!cue || typeof cue !== 'object') throw bad(`cue ${i} must be an object`, { cue: i });
    if (!SFX_TYPES.includes(cue.type)) {
      throw bad(`cue ${i}: type must be one of ${SFX_TYPES.join(', ')} (got ${JSON.stringify(cue.type)})`, { cue: i });
    }
    const hasFrame = cue.atFrame !== undefined && cue.atFrame !== null;
    const hasSec = cue.at !== undefined && cue.at !== null;
    if (hasFrame === hasSec) {
      throw bad(`cue ${i}: set exactly one of atFrame (preferred) or at (seconds)`, { cue: i });
    }
    let atSeconds;
    if (hasFrame) {
      if (!Number.isInteger(cue.atFrame) || cue.atFrame < 0) {
        throw bad(`cue ${i}: atFrame must be a non-negative integer (got ${cue.atFrame})`, { cue: i });
      }
      atSeconds = cue.atFrame / fps;
    } else {
      if (!Number.isFinite(cue.at) || cue.at < 0) {
        throw bad(`cue ${i}: at must be a non-negative number of seconds (got ${cue.at})`, { cue: i });
      }
      atSeconds = cue.at;
    }
    const gain = num(cue.gain, 0.5);
    if (!Number.isFinite(gain) || gain <= 0 || gain > 1) {
      throw bad(`cue ${i}: gain must be >0 and <=1 — it is the cue's peak amplitude (got ${gain})`, { cue: i });
    }
    if (cue.seed !== undefined && cue.seed !== null && !Number.isInteger(cue.seed)) {
      throw bad(`cue ${i}: seed must be an integer (got ${JSON.stringify(cue.seed)})`, { cue: i });
    }
    // Full per-type validation happens HERE, not at render time, so a caller who
    // validates up front cannot still be surprised mid-render.
    const params = GENERATORS[cue.type].resolve(cue, i);
    const lengthSeconds = params.lengthSeconds;
    if (lengthSeconds > MAX_CUE_SECONDS) {
      throw bad(`cue ${i}: resolves to ${lengthSeconds.toFixed(2)}s; a single cue is capped at ${MAX_CUE_SECONDS}s`,
        { cue: i, lengthSeconds });
    }
    return { cue, index: i, type: cue.type, atSeconds, gain, lengthSeconds, params };
  });

  // Duration: explicit, or just long enough to hold every cue.
  let durationInFrames = spec.durationInFrames;
  if (durationInFrames === undefined || durationInFrames === null) {
    const endSeconds = Math.max(...resolved.map((r) => r.atSeconds + r.lengthSeconds));
    durationInFrames = Math.ceil(endSeconds * fps);
  }
  if (!Number.isInteger(durationInFrames) || durationInFrames <= 0) {
    throw bad(`spec.durationInFrames must be a positive integer (got ${durationInFrames})`);
  }
  const durationSeconds = durationInFrames / fps;

  // A cue starting past the end is a mistake, not something to clamp silently:
  // overhang is a taste decision, but placement outside the piece is a bug.
  for (const r of resolved) {
    if (r.atSeconds >= durationSeconds) {
      throw bad(
        `cue ${r.index}: starts at ${r.atSeconds.toFixed(2)}s, past the end of the ${durationSeconds.toFixed(2)}s bed`,
        { cue: r.index, atSeconds: r.atSeconds, durationSeconds },
      );
    }
  }

  return { fps, sampleRate, normalize, ceilingDb, durationInFrames, durationSeconds, cues: resolved };
}

/* ------------------------------------------------------------- render ---- */

/**
 * Render a cue list to a mono Float32Array. Pure: no I/O, no clock, no globals.
 *
 * `normalize` policy:
 *   'ceiling' (default) — attenuate ONLY if the mix exceeds ceilingDb.
 *   'peak'              — always scale so the mix sits exactly at ceilingDb.
 *   'none'              — leave it alone, even if it clips.
 *
 * 'ceiling' is the default because a bed normalized to −1 dBFS reports a peak
 * that tells the caller nothing, and then has to be undone with a large negative
 * gainDb at mix time (both hand-rolled beds ended up around −20). Leaving a
 * quiet bed quiet keeps the number meaningful and composes with build_film's
 * audioTargetPeakDb instead of fighting it.
 */
export function renderCues(spec) {
  const s = validateSfxSpec(spec);
  const total = Math.ceil(s.durationSeconds * s.sampleRate);
  const mix = new Float32Array(total);

  // One scratch buffer, reused: cues are short, so this stays small regardless
  // of how long the bed is.
  const scratchLen = Math.ceil(MAX_CUE_SECONDS * s.sampleRate) + 1;
  const scratch = new Float32Array(scratchLen);

  let clamped = 0;
  const clampedCues = [];
  for (const r of s.cues) {
    const start = Math.round(r.atSeconds * s.sampleRate);
    const natural = Math.max(1, Math.round(r.lengthSeconds * s.sampleRate));
    const n = Math.min(natural, scratchLen);

    scratch.fill(0, 0, n);
    // Seed from the cue index unless given, so cues differ from each other but
    // the whole spec still re-renders identically.
    const rng = mulberry32(num(r.cue.seed, 1013 + r.index * 7919));
    GENERATORS[r.type].render(scratch, n, r.params, s.sampleRate, rng);

    // Scale so this cue's peak IS its gain — that is what makes `gain` mean the
    // same thing across generators.
    let cuePeak = 0;
    for (let k = 0; k < n; k++) { const a = Math.abs(scratch[k]); if (a > cuePeak) cuePeak = a; }
    const scale = cuePeak > 0 ? r.gain / cuePeak : 0;

    const room = total - start;
    const write = Math.min(n, room);
    if (write < natural) {
      clamped++;
      // Name the victim (v0.14): a bare count told the caller *something* was
      // cut but not what to fix. `cue` is the index into spec.cues; lostSeconds
      // is how much of the cue's tail ran past the end of the bed.
      clampedCues.push({
        cue: r.index,
        type: r.type,
        atSeconds: Number(r.atSeconds.toFixed(3)),
        lostSeconds: Number(((natural - write) / s.sampleRate).toFixed(3)),
      });
    }
    for (let k = 0; k < write; k++) mix[start + k] += scratch[k] * scale;
  }

  let rawPeak = 0;
  for (let i = 0; i < total; i++) { const a = Math.abs(mix[i]); if (a > rawPeak) rawPeak = a; }

  const ceiling = dbToGain(s.ceilingDb);
  let appliedGainDb = 0;
  if (rawPeak > 0 && (s.normalize === 'peak' || (s.normalize === 'ceiling' && rawPeak > ceiling))) {
    const factor = ceiling / rawPeak;
    for (let i = 0; i < total; i++) mix[i] *= factor;
    appliedGainDb = Number(gainToDb(factor).toFixed(2));
  }

  const peak = rawPeak > 0 ? rawPeak * dbToGain(appliedGainDb) : 0;
  return {
    samples: mix,
    sampleRate: s.sampleRate,
    fps: s.fps,
    durationInFrames: s.durationInFrames,
    durationSeconds: Number(s.durationSeconds.toFixed(3)),
    cues: s.cues.length,
    clamped,
    clampedCues,
    normalize: s.normalize,
    rawPeakDb: rawPeak > 0 ? Number(gainToDb(rawPeak).toFixed(2)) : null,
    peakDb: peak > 0 ? Number(gainToDb(peak).toFixed(2)) : null,
    appliedGainDb,
  };
}

/* --------------------------------------------------------------- WAV ----- */

/**
 * Mono 16-bit PCM WAV. Deliberately local rather than shared: `tts.js` owns the
 * only WAV *reader* and this is the only writer, so a `core/wav.js` would exist
 * to hold one function each. It graduates there when a second writer appears.
 */
export function encodeWavMono16(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric on purpose: int16 range is −32768..32767.
    data.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Render `spec` and write it to `outPath` as a mono 16-bit WAV.
 * @returns {Promise<object>} render metadata plus `outPath` / `bytes`
 */
export async function synthesizeSfx({ spec, outPath }) {
  if (!outPath) throw bad('synthesizeSfx needs an outPath');
  const res = renderCues(spec);
  const buf = encodeWavMono16(res.samples, res.sampleRate);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, buf);
  const { samples, ...meta } = res;      // don't hand back 50 MB of Float32
  return { outPath, bytes: buf.length, channels: 1, ...meta };
}
