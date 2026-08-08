/**
 * Frame-granular audio cues — the two signals a composition cannot get
 * (audio-cue plan, v0.27). Everything here is pure arithmetic over sample
 * arrays: no ffmpeg, no vendor, no model. The only I/O is `measureAudioCues`,
 * which reads a 16-bit PCM WAV exactly as `measureWavLevels` does.
 *
 * Two signals, and why neither is already available:
 *
 * 1. **A per-frame linear envelope.** `measureWavEnvelope` in ./audio.js
 *    answers "did the mix go silent" — its bucket is one second and its
 *    consumer is a warning. At 30 fps that is thirty frames of the same
 *    number, which is a bar chart, not an envelope. A composition driving a
 *    scale, radius or glow from the voice needs one value per frame, linear,
 *    so it can multiply by it.
 * 2. **Onset frames.** Nothing in the engine measured where the voice
 *    *pushes*. A word boundary is not emphasis: the stressed syllable inside
 *    a word is where a cut or a pop belongs, and it is recoverable from
 *    spectral flux with no model and no vendor.
 *
 * The detector is verified rather than trusted, and there is free ground
 * truth for it: narration the engine synthesized itself is assembled from
 * per-line clips (see concatWavBuffers), so the true line starts are known
 * exactly. `engine/test/audio-cues.test.js` asserts recovery within two
 * frames at 30 fps against that construction.
 *
 * Everything reports frames at the caller's fps — the invariant
 * `transcode_asset` already states, and the reason none of these functions
 * has an opinion about seconds.
 */

import fsp from 'node:fs/promises';
import { parseWavHeader } from './audio.js';

/* --------------------------------- defaults -------------------------------- */

/**
 * Analysis constants, in SECONDS rather than samples, because the three call
 * sites arrive at three sample rates (whisper's 16 kHz extraction, Piper's
 * 22.05 kHz, a 48 kHz mix) and a window that means 64 ms at one rate must not
 * silently mean 21 ms at another.
 */
export const CUE_DEFAULTS = Object.freeze({
  hopSeconds: 0.01,          // 10 ms — finer than a frame at any sane fps
  windowSeconds: 0.04,       // ~40 ms of context per STFT frame (rounded up to a power of two)
  medianSeconds: 0.2,        // ±100 ms local median, so a loud passage cannot out-vote a quiet one
  peakSeconds: 0.03,         // a peak must lead its ±30 ms neighbourhood
  refractorySeconds: 0.05,   // one syllable yields one onset
  minStrength: 0.12,         // fraction of the strongest flux peak in the clip
});

/* ----------------------------------- FFT ----------------------------------- */

/**
 * In-place iterative radix-2 Cooley-Tukey FFT over separate real/imaginary
 * arrays. Hand-written rather than depended upon: it is forty lines, the
 * engine's standing preference is spawned tools or nothing, and a native npm
 * dependency for one transform would be the heaviest thing in package.json.
 *
 * `re.length` must be a power of two.
 */
export function fftInPlace(re, im) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fftInPlace: length ${n} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Smallest power of two >= n (used to round the analysis window up, never down). */
export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* -------------------------------- the signals ------------------------------- */

/**
 * Half-wave rectified spectral flux: per STFT hop, the total INCREASE in
 * magnitude across bins since the previous hop. Increases only — a decay is
 * not an onset, and counting it would put a cue at the end of every syllable
 * as well as the start.
 *
 * Windows are CENTRED on their hop (hop h covers h·hop ± fftSize/2, reading
 * zeros outside the clip), which is what lets hop h be attributed to time
 * h·hop. The obvious alternative — windows that START at h·hop — has two
 * defects that only show up when you measure it: every cue is reported early
 * by most of a window, and a line that begins at frame 0 is invisible,
 * because the first window has no predecessor to be an increase over.
 *
 * @param {Float32Array|Float64Array|number[]} samples mono, -1..1
 * @returns {{flux: Float64Array, hopSize: number, fftSize: number}}
 */
export function spectralFlux(samples, { sampleRate, hopSeconds, windowSeconds } = {}) {
  const hop = Math.max(1, Math.round(sampleRate * (hopSeconds ?? CUE_DEFAULTS.hopSeconds)));
  const fftSize = nextPowerOfTwo(
    Math.max(hop * 2, Math.round(sampleRate * (windowSeconds ?? CUE_DEFAULTS.windowSeconds))),
  );
  const hops = samples.length ? Math.floor(samples.length / hop) + 1 : 0;
  const flux = new Float64Array(Math.max(0, hops));
  if (!hops) return { flux, hopSize: hop, fftSize };
  const half = fftSize / 2;

  // Hann window, computed once. Rectangular windowing smears a transient
  // across every bin, which is precisely the event being measured.
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize);

  const bins = fftSize / 2;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let prev = new Float64Array(bins);
  let mag = new Float64Array(bins);

  for (let h = 0; h < hops; h++) {
    const off = h * hop - half;
    for (let i = 0; i < fftSize; i++) {
      const s = off + i;
      re[i] = (s >= 0 && s < samples.length ? samples[s] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      const rise = mag[k] - prev[k];
      if (rise > 0) sum += rise;
    }
    flux[h] = h === 0 ? 0 : sum; // hop 0 has no predecessor; it is not an onset
    const swap = prev; prev = mag; mag = swap;
  }
  return { flux, hopSize: hop, fftSize };
}

/**
 * Subtract a running local median, clamping at zero. This is the step that
 * lets a quiet passage keep its onsets: without it a single loud phrase sets
 * a global scale under which every softer syllable disappears.
 *
 * Pure: array in, array out, no sample rate involved.
 */
export function subtractLocalMedian(values, halfWindow) {
  const n = values.length;
  const out = new Float64Array(n);
  if (!n) return out;
  const w = Math.max(1, Math.round(halfWindow));
  const scratch = new Float64Array(2 * w + 1);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    const len = hi - lo + 1;
    for (let j = 0; j < len; j++) scratch[j] = values[lo + j];
    const slice = scratch.subarray(0, len);
    slice.sort();
    const median = len % 2 ? slice[(len - 1) / 2] : (slice[len / 2 - 1] + slice[len / 2]) / 2;
    out[i] = Math.max(0, values[i] - median);
  }
  return out;
}

/**
 * Peak-pick a detection function: a peak leads its ±`halfWindow` neighbourhood,
 * clears `minStrength` of the strongest peak in the whole signal, and no two
 * peaks land within `refractory` samples of each other. The refractory gap is
 * what turns "a syllable's attack" into one cue instead of three.
 *
 * @returns {Array<{index: number, strength: number}>} strength is 0..1,
 *   relative to the strongest peak in this signal.
 */
export function pickPeaks(values, { halfWindow, refractory, minStrength } = {}) {
  const n = values.length;
  const w = Math.max(1, Math.round(halfWindow ?? 3));
  const gap = Math.max(1, Math.round(refractory ?? w));
  const floor = minStrength ?? CUE_DEFAULTS.minStrength;

  let max = 0;
  for (let i = 0; i < n; i++) if (values[i] > max) max = values[i];
  if (max <= 0) return [];
  const cutoff = max * floor;

  const peaks = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < cutoff) continue;
    let leads = true;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      // > on the left and >= on the right: a plateau reports its first sample.
      if (j < i ? values[j] >= v : (j > i && values[j] > v)) { leads = false; break; }
    }
    if (!leads) continue;
    const last = peaks[peaks.length - 1];
    if (last && i - last.index < gap) {
      // Within the refractory window the louder of the two wins, so a slow
      // attack reports its strongest moment rather than its earliest.
      if (v > last.rawValue) { last.index = i; last.rawValue = v; last.strength = v / max; }
      continue;
    }
    peaks.push({ index: i, rawValue: v, strength: v / max });
  }
  return peaks.map(({ index, strength }) => ({ index, strength: Number(strength.toFixed(4)) }));
}

/**
 * Per-frame linear RMS. The bucket is `sampleRate / fps` rather than
 * `sampleRate` — the one change that turns ./audio.js's QA envelope into
 * something an animation can multiply by.
 *
 * Linear, not dB, and deliberately NOT normalised: it is a measurement, so
 * `measureAudioCues` reports the clip's peak beside it and a caller that wants
 * 0..1 divides. Values are rounded to 4 decimals — at 30 fps a five-minute
 * film is 9,000 of them, and the fourth decimal is already below what any
 * scale or opacity can show.
 */
export function perFrameRms(samples, { sampleRate, fps, frameCount } = {}) {
  const per = sampleRate / fps;
  const frames = frameCount ?? Math.ceil(samples.length / per);
  const out = new Array(Math.max(0, frames));
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * per);
    const end = Math.min(samples.length, Math.round((f + 1) * per));
    let sumSquares = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      sumSquares += v * v;
      count++;
    }
    out[f] = count ? Number(Math.sqrt(sumSquares / count).toFixed(4)) : 0;
  }
  return out;
}

/**
 * The whole onset chain over raw samples: flux → local median → peak pick,
 * mapped to frame indices at `fps`.
 *
 * A hop is 10 ms and a frame at 30 fps is 33 ms, so several hops can map to
 * one frame; the refractory gap makes that rare, and where it happens the
 * stronger cue is kept rather than emitting the same frame twice.
 *
 * @returns {Array<{frame: number, seconds: number, strength: number}>}
 */
export function detectOnsets(samples, { sampleRate, fps, ...opts } = {}) {
  const cfg = { ...CUE_DEFAULTS, ...opts };
  const { flux, hopSize } = spectralFlux(samples, {
    sampleRate, hopSeconds: cfg.hopSeconds, windowSeconds: cfg.windowSeconds,
  });
  if (!flux.length) return [];
  const hopSeconds = hopSize / sampleRate;
  const detection = subtractLocalMedian(flux, (cfg.medianSeconds / 2) / hopSeconds);
  const peaks = pickPeaks(detection, {
    halfWindow: cfg.peakSeconds / hopSeconds,
    refractory: cfg.refractorySeconds / hopSeconds,
    minStrength: cfg.minStrength,
  });

  const byFrame = new Map();
  for (const p of peaks) {
    // Windows are centred (see spectralFlux), so hop h IS time h·hopSeconds.
    const seconds = p.index * hopSeconds;
    const frame = Math.round(seconds * fps);
    const prior = byFrame.get(frame);
    if (!prior || p.strength > prior.strength) {
      byFrame.set(frame, { frame, seconds: Number(seconds.toFixed(4)), strength: p.strength });
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/* --------------------------------- decoding -------------------------------- */

/**
 * 16-bit PCM WAV body → mono Float32Array in -1..1, averaging channels.
 * Mono because both signals are about the programme, not the image: a
 * stereo-panned cue is still one cue.
 */
export function decodeWav16Mono(buf, info) {
  const channels = info.channels || 1;
  const start = info.dataOffset;
  const end = start + info.dataSize - (info.dataSize % 2);
  const frames = Math.floor((end - start) / (2 * channels));
  const out = new Float32Array(Math.max(0, frames));
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = start + f * 2 * channels;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(base + c * 2) / 32768;
    out[f] = sum / channels;
  }
  return out;
}

/** Cap on the inline cue list; past it the response says so rather than trimming quietly. */
export const MAX_INLINE_ONSETS = 400;

/**
 * The response projection for a cue measurement — the shape `synthesize_speech`
 * and `preview_audio` both return, written once so they cannot drift.
 *
 * Why there are two detail levels at all: a five-minute film at 30 fps is 9,000
 * envelope floats, and this engine spent a whole program (the token-efficient
 * plan, v0.26) removing exactly that kind of payload from the default read. So
 * the *summary* carries what a caller decides with — how many cues, which
 * frames, the peak to normalise against — and `full` carries the arrays, on
 * request, visibly. `envelopePeak` is what makes the summary usable on its own:
 * an animation wants `envelope[f] / envelopePeak`, and the divisor is the part
 * you cannot compute yourself.
 */
export function projectCues(cues, detail = 'summary') {
  if (!cues) return null;
  const onsetFrames = cues.onsets.map((o) => o.frame);
  const base = {
    fps: cues.fps,
    frameCount: cues.frameCount,
    onsetCount: cues.onsets.length,
    envelopePeak: cues.envelopePeak,
  };
  if (detail === 'full') {
    return { ...base, onsetFrames, onsets: cues.onsets, envelope: cues.envelope };
  }
  const capped = onsetFrames.slice(0, MAX_INLINE_ONSETS);
  return {
    ...base,
    onsetFrames: capped,
    ...(capped.length < onsetFrames.length
      ? {
        onsetFramesTruncated: true,
        hint: `Showing ${capped.length} of ${onsetFrames.length} cue frames — ask for cues: "full" to get them all, plus per-frame envelope and per-cue strength.`,
      }
      : {}),
  };
}

/**
 * Both cue signals for one 16-bit PCM WAV, at one fps.
 *
 * Returns null for anything that is not 16-bit PCM, mirroring
 * `measureWavLevels` and `measureWavEnvelope` — "unknown", never an error, so
 * a cue measurement can never fail a synthesis or a mix that otherwise worked.
 *
 * @returns {Promise<{fps, frameCount, sampleRate, channels, envelope: number[],
 *   envelopePeak: number, onsets: Array<{frame, seconds, strength}>}|null>}
 */
export async function measureAudioCues(filePath, { fps, ...opts } = {}) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`measureAudioCues: bad fps ${fps}`);
  const buf = await fsp.readFile(filePath);
  const info = parseWavHeader(buf, filePath);
  if (info.bitsPerSample !== 16 || info.dataOffset === undefined || info.dataSize === 0) return null;

  const samples = decodeWav16Mono(buf, info);
  const sampleRate = info.sampleRate;
  const durationSeconds = samples.length / sampleRate;
  // Ceil, so the envelope covers the clip the same way framesForDuration does
  // and a caller can index it by the frame the clip is playing on.
  const frameCount = Math.max(0, Math.ceil(durationSeconds * fps));
  const envelope = perFrameRms(samples, { sampleRate, fps, frameCount });
  const onsets = detectOnsets(samples, { sampleRate, fps, ...opts });

  let peak = 0;
  for (const v of envelope) if (v > peak) peak = v;
  return {
    fps,
    frameCount,
    sampleRate,
    channels: info.channels ?? 1,
    envelope,
    envelopePeak: Number(peak.toFixed(4)),
    onsets,
  };
}
