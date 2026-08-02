/**
 * FFmpeg encoder (format-aware since v0.5).
 *
 * DEFAULT frame delivery = stream PNG buffers straight into FFmpeg's stdin
 * (image2pipe): no intermediate disk I/O, no cleanup, no disk-space failure
 * mode during capture. An optional `framesDir` switches to writing a PNG
 * sequence first (debuggability / resumability), encoded in a second pass.
 *
 * All codec decisions live in core/formats.js — this module only assembles
 * and runs FFmpeg commands:
 *
 *   FfmpegFrameSink       — stdin PNG pipe → target (or intermediate) format
 *   encodePngSequence()   — encode a frame-%06d.png directory
 *   transcode()           — lossless intermediate → final format (parallel path)
 *   concatSegments()      — lossless merge of per-worker segments
 *   muxAudio()            — -filter_complex delay/gain/mix pass over silent video
 *   buildAudioFilter()    — exported for unit tests
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EngineError, ErrorCodes } from './errors.js';
import { getFormat, INTERMEDIATE, outputColorFilter } from './formats.js';

const STDERR_TAIL_LINES = 40;

function collectStderr(proc, sink) {
  proc.stderr.on('data', (d) => {
    sink.push(...d.toString('utf8').split('\n').filter(Boolean));
    if (sink.length > STDERR_TAIL_LINES) sink.splice(0, sink.length - STDERR_TAIL_LINES);
  });
}

function waitExit(proc, stderrTail, what) {
  return new Promise((resolve, reject) => {
    proc.on('error', (e) =>
      reject(new EngineError(ErrorCodes.FFMPEG_FAILED, `${what}: failed to start ffmpeg: ${e.message}`)),
    );
    proc.on('close', (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new EngineError(ErrorCodes.CANCELLED, `${what}: ffmpeg terminated by ${signal}`));
      else
        reject(
          new EngineError(ErrorCodes.FFMPEG_FAILED, `${what}: ffmpeg exited with code ${code}`, {
            stderrTail: stderrTail.join('\n'),
          }),
        );
    });
  });
}

/**
 * Run one ffmpeg invocation to completion (saved-film finishing pass).
 *
 * Unlike the specialised helpers above/below, this takes a prebuilt argument
 * list — the film module composes overlay/subtitle graphs that no other
 * caller shares. `-progress pipe:1` is appended when `onProgressFrame` is
 * given, so a long finishing encode can report real frame progress instead
 * of an indeterminate spinner. `cwd` exists because the subtitles filter
 * cannot take a Windows absolute path without a fragile escaping dance —
 * the caller runs ffmpeg from the directory holding the .ass file instead.
 */
export async function runFfmpeg({ args, ffmpegPath = 'ffmpeg', onSpawn, what = 'ffmpeg', cwd, onProgressFrame, signal }) {
  if (signal?.aborted) throw new EngineError(ErrorCodes.CANCELLED, `${what}: cancelled before start`);
  const fullArgs = onProgressFrame ? [...args, '-progress', 'pipe:1', '-nostats'] : args;
  const stderrTail = [];
  const proc = spawn(ffmpegPath, fullArgs, {
    stdio: ['ignore', onProgressFrame ? 'pipe' : 'ignore', 'pipe'],
    ...(cwd ? { cwd } : {}),
  });
  collectStderr(proc, stderrTail);
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (onProgressFrame) {
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = /^frame=\s*(\d+)/.exec(line);
        if (m) onProgressFrame(Number(m[1]));
      }
    });
  }
  try {
    await waitExit(proc, stderrTail, what);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Resolve the video-encode argument list for an output config. */
export function buildVideoArgs(output = {}) {
  if (output.intermediate) return INTERMEDIATE.videoArgs(output);
  const fmt = getFormat(output.format ?? 'mp4');
  if (!fmt.videoArgs) {
    throw new EngineError(ErrorCodes.UNSUPPORTED_FORMAT, `Format "${output.format}" has no encode step`, {
      format: output.format,
    });
  }
  return fmt.videoArgs(output);
}

/**
 * Video encoder accepting PNG frames pushed one at a time.
 * Handles stdin backpressure so a fast capture loop can't balloon memory.
 */
export class FfmpegFrameSink {
  /**
   * @param {object} opts
   * @param {string} opts.outputPath
   * @param {number|string} opts.fps  frames per second. A rational string like
   *   "30/2" is passed to -framerate verbatim — FFmpeg takes rationals — which
   *   is how proxy frame-step renders (v0.21) keep wall-clock duration exact
   *   at fractional rates no float could represent cleanly (e.g. 30/4 = 7.5).
   * @param {object} [opts.output]   { format, crf, preset, pixFmt, transparent, intermediate } from scene config
   * @param {string} [opts.ffmpegPath]
   * @param {(pid:number)=>void} [opts.onSpawn]  report pid for process-tree cleanup
   */
  constructor({ outputPath, fps, output = {}, ffmpegPath = 'ffmpeg', onSpawn }) {
    this.stderrTail = [];
    this.args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
      '-an',
      ...(outputColorFilter(output) ? ['-vf', outputColorFilter(output)] : []),
      ...buildVideoArgs(output),
      outputPath,
    ];
    this.proc = spawn(ffmpegPath, this.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    collectStderr(this.proc, this.stderrTail);
    this.exit = waitExit(this.proc, this.stderrTail, 'encode');
    // Surface EPIPE etc. through finish() rather than crashing the process.
    this.proc.stdin.on('error', () => {});
    if (onSpawn && this.proc.pid) onSpawn(this.proc.pid);
  }

  /** Push one PNG frame; resolves when stdin has drained. */
  writeFrame(pngBuffer) {
    return new Promise((resolve, reject) => {
      if (!this.proc.stdin.writable) {
        return reject(new EngineError(ErrorCodes.FFMPEG_FAILED, 'ffmpeg stdin closed unexpectedly', {
          stderrTail: this.stderrTail.join('\n'),
        }));
      }
      const ok = this.proc.stdin.write(pngBuffer);
      if (ok) resolve();
      else this.proc.stdin.once('drain', resolve);
    });
  }

  async finish() {
    this.proc.stdin.end();
    await this.exit;
  }

  kill() {
    // Nobody will await exit after a kill; swallow its rejection so tearing
    // down a failed/cancelled render can't surface an unhandledRejection.
    this.exit.catch(() => {});
    try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Encode a directory of zero-padded PNGs (frame-%06d.png) to the target format.
 *  `fps` takes the same number-or-rational-string as FfmpegFrameSink. */
export async function encodePngSequence({ framesDir, outputPath, fps, output = {}, ffmpegPath = 'ffmpeg', onSpawn }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps), '-i', path.join(framesDir, 'frame-%06d.png'),
    '-an',
    ...(outputColorFilter(output) ? ['-vf', outputColorFilter(output)] : []),
    ...buildVideoArgs(output),
    outputPath,
  ];
  const stderrTail = [];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  collectStderr(proc, stderrTail);
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  await waitExit(proc, stderrTail, 'encode-sequence');
}

/**
 * Transcode a lossless intermediate into the final target format.
 * Used by the parallel path for formats where segments cannot be
 * copy-concatenated (e.g. GIF's global palette) or when alpha must be
 * preserved end-to-end.
 */
export async function transcode({ inputPath, outputPath, output = {}, ffmpegPath = 'ffmpeg', onSpawn }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-an',
    ...(outputColorFilter(output) ? ['-vf', outputColorFilter(output)] : []),
    ...buildVideoArgs(output),
    outputPath,
  ];
  const stderrTail = [];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  collectStderr(proc, stderrTail);
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  await waitExit(proc, stderrTail, 'transcode');
}

/**
 * Losslessly concatenate segment files (identical codec params) in order.
 * Used by the parallel renderer's merge step.
 */
export async function concatSegments({ segmentPaths, outputPath, ffmpegPath = 'ffmpeg', onSpawn }) {
  const listPath = path.join(os.tmpdir(), `ms-concat-${process.pid}-${Date.now()}.txt`);
  // concat demuxer list: single-quoted paths, quotes escaped.
  const list = segmentPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listPath, list, 'utf8');
  try {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', outputPath,
    ];
    const stderrTail = [];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    collectStderr(proc, stderrTail);
    if (onSpawn && proc.pid) onSpawn(proc.pid);
    await waitExit(proc, stderrTail, 'concat');
  } finally {
    await fsp.unlink(listPath).catch(() => {});
  }
}

/**
 * Build the -filter_complex graph for the configured audio tracks.
 * Exported separately so it is unit-testable without running ffmpeg.
 *
 * Track: { src, startInFrames = 0, gainDb = 0,
 *          trimEndInFrames?, fadeInFrames?, fadeOutFrames? }   (v0.19)
 *
 * trimEndInFrames is CLIP-relative: keep only the clip's first N frames.
 * fadeOutFrames ends at the clip's effective end — trimEndInFrames when set,
 * otherwise where the composition ends (videoDurationSec), which is exactly
 * the "music bed longer than the video" case that used to hard-cut.
 *
 * Every track chain ends in aformat pinning 44.1 kHz stereo, so no single
 * input (a 16 kHz mono narration WAV, say) can drag the negotiated mix format
 * down. When ducking, the sidechain is silence-padded to the composition
 * length: sidechaincompress ends at its first input EOF, so an unpadded
 * sidechain used to silence the bed from the last narration clip onward.
 */
/**
 * Brick-wall limiter appended to the mix (v0.10). level=0 disables alimiter's
 * auto-levelling, which would otherwise make the filter *boost* quiet audio
 * instead of only catching peaks. Below the ceiling this is a no-op, so it
 * costs nothing on a mix that was already safe.
 *
 * limit=0.841 is -1.5 dBFS, not -1 (v0.24). The extra 0.5 dB is codec
 * headroom, and it is there because the -1 dB ceiling did not survive the mux:
 * alimiter bounds the SAMPLE peak of the mix, but the deliverable is AAC, and a
 * lossy encoder reconstructs intersample peaks ABOVE the samples it was given.
 * Measured on a 21-track music-video mix: preview_audio reported the WAV at
 * -1.0 dBFS while build_film measured the encoded result at 0.0 dBFS and
 * flagged audio_clipping — a full 1 dB of overshoot, on a mix the limiter had
 * already done its job on. That made `clipping: true` reachable on any
 * limited film, which trains callers to ignore the one audio warning they
 * cannot hear for themselves.
 *
 * -1.5 dBFS keeps the encoded peak under 0 with margin to spare while costing
 * half a decibel of loudness. Callers who want the old behaviour can still
 * disable the limiter per scene with output.audioLimiter=false and set their
 * own levels.
 */
export const LIMITER_FILTER = 'alimiter=limit=0.841:level=0';

/**
 * @param {object} [options]
 * @param {boolean} [options.limiter=true] append LIMITER_FILTER to the mix.
 *   amix runs with normalize=0 so gains sum directly — three tracks at 0 dB can
 *   sum well past full scale. Set false to pass the mix through untouched.
 * @param {number|null} [options.videoDurationSec=null] composition length in
 *   seconds; bounds a fadeOutFrames when the track has no trimEndInFrames.
 */
export function buildAudioFilter(tracks, fps, { limiter = true, videoDurationSec = null } = {}) {
  const chains = [];
  const mixInputs = [];
  tracks.forEach((t, i) => {
    const startFrames = t.startInFrames ?? 0;
    const delayMs = Math.round((startFrames / fps) * 1000);
    const gain = t.gainDb ?? 0;
    const label = `a${i}`;
    const steps = [];
    // Clip-relative operations first (trim, fades), then placement (adelay)
    // and gain — so frame numbers in the track config mean clip frames.
    const trimSec = t.trimEndInFrames !== undefined ? t.trimEndInFrames / fps : null;
    if (trimSec !== null) steps.push(`atrim=0:${trimSec.toFixed(3)}`);
    if (t.fadeInFrames) {
      steps.push(`afade=t=in:st=0:d=${(t.fadeInFrames / fps).toFixed(3)}`);
    }
    if (t.fadeOutFrames) {
      const boundSec = trimSec
        ?? (videoDurationSec !== null ? Math.max(0, videoDurationSec - startFrames / fps) : null);
      if (boundSec !== null) {
        const d = t.fadeOutFrames / fps;
        steps.push(`afade=t=out:st=${Math.max(0, boundSec - d).toFixed(3)}:d=${d.toFixed(3)}`);
      }
    }
    steps.push(`adelay=${delayMs}|${delayMs}`, `volume=${gain}dB`);
    // Pin every track to one rate/layout BEFORE any mixing. Without this,
    // ffmpeg negotiates a common format across the mix inputs and a 16 kHz
    // mono narration WAV (e.g. Piper) can drag the entire mix — music bed
    // included — down to 16 kHz. It also keeps sidechaincompress timing exact,
    // which otherwise drifts when its two inputs arrive at different rates.
    steps.push('aformat=sample_rates=44100:channel_layouts=stereo');
    // input 0 is the video; audio inputs start at 1
    chains.push(`[${i + 1}:a]${steps.join(',')}[${label}]`);
    mixInputs.push(`[${label}]`);
  });
  // Auto-duck (v0.19): tracks marked duck:true are compressed by the mix of
  // the tracks that are NOT marked — narration pushes the bed down, and the
  // bed comes back up in the gaps. Only engages when both sides exist.
  const duckIdx = tracks.map((t, i) => (t.duck ? i : -1)).filter((i) => i >= 0);
  const useDucking = duckIdx.length > 0 && duckIdx.length < tracks.length;

  const mixOut = limiter ? '[amix]' : '[aout]';
  const graph = [...chains];
  if (useDucking) {
    const fg = mixInputs.filter((_, i) => !tracks[i].duck);
    const bed = mixInputs.filter((_, i) => tracks[i].duck);
    const sub = (inputs, out) =>
      inputs.length === 1
        ? `${inputs[0]}anull${out}`
        : `${inputs.join('')}amix=inputs=${inputs.length}:normalize=0${out}`;
    // aformat: sidechaincompress needs both sides in one layout, and the mono
    // narration WAVs would otherwise disagree with a stereo bed.
    // The per-track aformat above already made both sides 44.1 kHz stereo, so
    // no branch-level format fixup is needed here.
    graph.push(sub(fg, '[fgraw]'));
    graph.push(sub(bed, '[bed0]'));
    graph.push('[fgraw]asplit=2[fgmix][sc0]');
    // sidechaincompress is asymmetric about EOF: it ends cleanly when the
    // SIDECHAIN ends first, but that used to hard-silence the bed from the
    // last narration clip onward; and if the BED ends first while the
    // sidechain continues, the filter stalls forever making no progress.
    // Silence-pad BOTH branches to the composition length so they reach EOF
    // together: the bed plays out in full, the compressor releases naturally
    // into the padded silence, and the graph always terminates. Without a
    // known composition length (tests only — both muxer callers pass it) the
    // pads are skipped and ducking keeps the legacy early-end behavior.
    if (videoDurationSec !== null) {
      const pad = `apad=whole_dur=${videoDurationSec.toFixed(3)}`;
      graph.push(`[bed0]${pad}[bed]`);
      graph.push(`[sc0]${pad}[sc]`);
    } else {
      graph.push('[bed0]anull[bed]');
      graph.push('[sc0]anull[sc]');
    }
    // threshold=0.02 ≈ -34 dBFS: quiet narration still ducks the bed. ratio 8
    // is a firm push (~10 dB on a typical bed); 50/400 ms keeps word-rate
    // pumping out of the release.
    graph.push('[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=50:release=400[bedduck]');
    graph.push(`[fgmix][bedduck]amix=inputs=2:normalize=0${mixOut}`);
  } else {
    graph.push(
      tracks.length === 1
        ? `${mixInputs[0]}anull${mixOut}`
        : `${mixInputs.join('')}amix=inputs=${tracks.length}:normalize=0${mixOut}`,
    );
  }
  if (limiter) graph.push(`[amix]${LIMITER_FILTER}[aout]`);
  return graph.join(';');
}

/**
 * Flag tracks that are almost certainly inaudible in the mix (v0.22).
 *
 * A track buried under a much louder concurrent track is the OTHER audio
 * failure an agent cannot hear: the render succeeds, nothing clips (the mix
 * only got quieter), and every automated check passes — yet a layer is
 * missing to the ear. Seen in practice when gains are assigned by template
 * ("lead -2, layers -6/-10") against source files whose own levels already
 * differ by more than the template assumes.
 *
 * Pure function over measured data so it is unit-testable and both callers
 * (preview_audio and the render's audio report) share one definition:
 *
 *   tracks: config.audio entries + { clipMeanDb, clipDurationSec? } —
 *     clipMeanDb is the file's own measured mean level; null skips the track.
 *     clipDurationSec bounds its play window; null = plays to the end.
 *
 * A warning fires when a track's effective mean (clipMeanDb + gainDb) sits
 * >= thresholdDb below a louder track that overlaps at least half of its play
 * window. Default 8 dB: the motivating real-world case had a layer 9.3 dB
 * down and the user reported hearing only the lead. Tracks marked duck:true
 * are declared background — being under the foreground is their job, so they
 * never warn as the quiet side.
 */
export function computeBalanceWarnings(tracks, { fps, videoDurationSec, thresholdDb = 8 } = {}) {
  const infos = tracks.map((t) => {
    const start = (t.startInFrames ?? 0) / fps;
    const clipLen = t.trimEndInFrames !== undefined
      ? t.trimEndInFrames / fps
      : (typeof t.clipDurationSec === 'number' ? t.clipDurationSec : null);
    const end = Math.min(clipLen !== null ? start + clipLen : videoDurationSec, videoDurationSec);
    const gain = t.gainDb ?? 0;
    const level = typeof t.clipMeanDb === 'number' ? t.clipMeanDb + gain : null;
    return { t, start, end, gain, level };
  });

  const warnings = [];
  for (const a of infos) {
    if (a.level === null || a.t.duck || a.end <= a.start) continue;
    let loudest = null;
    for (const b of infos) {
      if (b === a || b.level === null) continue;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap < 0.5 * (a.end - a.start)) continue;
      if (b.level - a.level >= thresholdDb && (!loudest || b.level > loudest.level)) loudest = b;
    }
    if (loudest) {
      const gap = Math.round(loudest.level - a.level);
      warnings.push(
        `${a.t.src} plays ~${gap} dB below ${loudest.t.src} while they overlap — likely inaudible. ` +
          `Effective mean ${a.level.toFixed(1)} dBFS (clip ${a.t.clipMeanDb.toFixed(1)} + gain ${a.gain}) vs ` +
          `${loudest.level.toFixed(1)} dBFS. Raise this track's gainDb, lower the louder track's, or mark ` +
          `this track duck:true if it is meant as background.`,
      );
    }
  }
  return warnings;
}

/**
 * Decode a rendered file and report its integrated/peak audio level in dBFS
 * (v0.10). Used to tell the caller whether the mix clipped — the one audio
 * failure an agent has no way to notice on its own.
 *
 * Returns null if the file has no audio or ffmpeg's output cannot be parsed;
 * callers treat that as "unknown", never as a render failure.
 */
export async function measureAudioLevels({ filePath, ffmpegPath = 'ffmpeg', onSpawn, signal }) {
  // Check first: an 'abort' listener registered after the fact never fires for a
  // signal that is already aborted, so without this the process would spawn and
  // run to completion on a cancelled job.
  if (signal?.aborted) return null;

  const args = ['-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  // This pass decodes the whole file, so on a long film it owns the process for
  // a meaningful window. Report the pid and honour cancellation like every other
  // spawn here — otherwise a cancel mid-measurement orphans an ffmpeg.
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
  signal?.addEventListener('abort', onAbort, { once: true });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => {
    proc.on('error', () => resolve(-1));
    proc.on('close', (c) => resolve(c));
  }).finally(() => signal?.removeEventListener('abort', onAbort));

  if (code !== 0) return null;
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!mean && !peak) return null;
  return {
    meanDb: mean ? Number(mean[1]) : null,
    peakDb: peak ? Number(peak[1]) : null,
  };
}

/** Analysis window for peak-position measurement: 20 ms at the resampled rate. */
const PEAK_WINDOW_SEC = 0.02;
const PEAK_PROBE_RATE = 8000;

/**
 * Find WHERE a clip is loudest, not just how loud it is (v0.24).
 *
 * measureAudioLevels answers "does this clip clip?"; this answers "when does it
 * hit?", which is the question you must answer before placing a one-shot on a
 * beat. A cue's transient is very often not at 0 s — measured across five
 * generated cues: impact 0.00 s, glitch 0.09 s, sub-drop 0.87 s, downlifter
 * 3.22 s, riser 4.31 s. Place those by their start and four of the five land
 * late, the riser by more than four seconds; place them by `peakAtSeconds` and
 * the hit lands on the beat. Without this the only way to get the number was to
 * decode the PCM outside the tool surface entirely.
 *
 * Deliberately opt-in at the call sites: this decodes the whole file, so it is
 * not something probe_asset should do on every metadata read.
 *
 * Returns null (never throws) when the file has no audio or ffmpeg cannot be
 * parsed — same contract as measureAudioLevels.
 */
export async function measureAudioPeakPosition({ filePath, ffmpegPath = 'ffmpeg', onSpawn, signal }) {
  if (signal?.aborted) return null;

  // Resample first so the window is a known sample count regardless of source
  // rate; reset=1 makes astats report one measurement per window, and
  // ametadata prints it with the window's own pts_time.
  const filter = [
    `aresample=${PEAK_PROBE_RATE}`,
    `asetnsamples=n=${Math.round(PEAK_PROBE_RATE * PEAK_WINDOW_SEC)}:p=0`,
    'astats=metadata=1:reset=1',
    'ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-',
  ].join(',');

  const args = ['-hide_banner', '-nostats', '-i', filePath, '-af', filter, '-f', 'null', '-'];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
  signal?.addEventListener('abort', onAbort, { once: true });

  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  const code = await new Promise((resolve) => {
    proc.on('error', () => resolve(-1));
    proc.on('close', (c) => resolve(c));
  }).finally(() => signal?.removeEventListener('abort', onAbort));

  if (code !== 0) return null;

  let windowTime = null;
  let peakDb = null;
  let peakAtSeconds = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) { windowTime = Number(t[1]); continue; }
    const v = /Peak_level=(-?[\d.]+|-?inf)/.exec(line);
    // "-inf" is a digitally silent window: real, but never the peak.
    if (!v || v[1].endsWith('inf') || windowTime === null) continue;
    const db = Number(v[1]);
    if (peakDb === null || db > peakDb) { peakDb = db; peakAtSeconds = windowTime; }
  }
  if (peakDb === null) return null;
  return {
    peakDb: Number(peakDb.toFixed(2)),
    peakAtSeconds: Number(peakAtSeconds.toFixed(3)),
    windowSeconds: PEAK_WINDOW_SEC,
  };
}

/**
 * Count the video frames actually present in an encoded file (v0.11).
 *
 * Returns null when the count cannot be established (no ffprobe on PATH, an
 * unreadable file, a container that reports nothing) — callers treat that as
 * "unverified", never as a failure, because ffprobe is not a declared
 * prerequisite (see core/prereqs.js: only ffmpeg is).
 *
 * Tries the container's own `nb_frames` first: muxers write it from the frames
 * actually written, so a truncated file reports the truncated number and the
 * check costs one metadata read. Only if that is missing/unusable do we fall
 * back to `-count_frames`, which decodes the whole file.
 */
export async function probeFrameCount({ filePath, ffprobePath = 'ffprobe', onSpawn, signal }) {
  if (signal?.aborted) return null;

  const run = async (args) => {
    let proc;
    try {
      proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;                                  // ffprobe missing entirely
    }
    if (onSpawn && proc.pid) onSpawn(proc.pid);
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      return await new Promise((resolve) => {
        proc.on('error', () => resolve(null));
        proc.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const base = ['-v', 'error', '-select_streams', 'v:0', '-of', 'default=nk=1:nw=1'];

  const fast = await run([...base, '-show_entries', 'stream=nb_frames', filePath]);
  const n = Number(fast);
  if (Number.isInteger(n) && n > 0) return n;

  const slow = await run([...base, '-count_frames', '-show_entries', 'stream=nb_read_frames', filePath]);
  const m = Number(slow);
  return Number.isInteger(m) && m > 0 ? m : null;
}

/** Parse ffprobe's "30000/1001" rational into a rounded-to-3dp number. */
function parseRational(str) {
  if (typeof str !== 'string' || !str.includes('/')) return null;
  const [n, d] = str.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return Number((n / d).toFixed(3));
}

const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A colour tag the file does not carry, normalized to null (v0.22).
 *
 * ffprobe prints the literal string `unknown` for an untagged stream and
 * `reserved` for a code the spec does not assign. Both mean "the file does not
 * say", which is the same `null` every other unanswerable field in this summary
 * uses — and neither may be read as a colour. It matters here more than most:
 * an untagged matrix is precisely the case a player resolves by GUESSING, so
 * reporting the string `"unknown"` as if it were a value would hide the one
 * fact worth knowing about it.
 */
const colorTagOrNull = (v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return !s || s === 'unknown' || s === 'reserved' ? null : s;
};

/**
 * Codecs headless Chromium cannot decode (v0.21).
 *
 * Chromium's bundled build ships without the proprietary codecs, so an
 * `<video src="clip.mp4">` inside a composition fails with a MEDIA_ELEMENT
 * format error while `canPlayType()` still answers "probably" — the feature
 * check lies, and the render either hangs or draws nothing. Naming it at
 * probe time is the whole point of the tool: it is the one property of a
 * media file that decides whether a composition can use it at all.
 */
const BROWSER_UNDECODABLE = new Set(['h264', 'hevc', 'h265', 'mpeg4', 'aac', 'mp3']);
const BROWSER_OK_VIDEO = 'vp8, vp9 or av1 in .webm';

/**
 * Choose the frame rate to report for a video stream (v0.24).
 *
 * `avg_frame_rate` is frames ÷ duration, so a perfectly constant-rate file
 * lands just off its nominal rate once the last frame's presentation time is
 * accounted for: every film this engine builds probed as **30.001 fps** while
 * its `r_frame_rate` was exactly 30/1. Reporting the average therefore made
 * `probe_asset` describe the engine's own conformant output as fractional AND
 * attach a warning that seeking would not land on source frames — advice that
 * is wrong, and aimed at a future agent deciding whether to trust the file.
 *
 * `r_frame_rate` is the stream's base rate: exact for CFR, and meaningless for
 * genuinely variable material (containers often declare 1000/1). So prefer it
 * only when the two agree to within 1%, which is true for CFR and false for
 * VFR. Real fractional rates (29.97 = 30000/1001, 23.976) are preserved by
 * both paths and still earn the note.
 */
export function pickFrameRate(v) {
  const avg = parseRational(v?.avg_frame_rate);
  const base = parseRational(v?.r_frame_rate);
  if (base == null) return avg;
  if (avg == null || avg === 0) return base;
  return Math.abs(avg - base) / base <= 0.01 ? base : avg;
}

/**
 * Turn raw `ffprobe -show_format -show_streams -of json` output into the tidy
 * shape the tool surface returns. Pure, so it is unit-testable without ffprobe.
 */
export function summarizeMedia(raw) {
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];
  const fmt = raw?.format ?? {};
  const v = streams.find((s) => s.codec_type === 'video') ?? null;
  const a = streams.find((s) => s.codec_type === 'audio') ?? null;

  // A cover-art JPEG inside an mp3 is a video stream by ffprobe's reckoning;
  // treating it as one would report a "1-frame video" for an audio file.
  const isCoverArt = !!v && (v.disposition?.attached_pic === 1);

  const video = v && !isCoverArt ? {
    codec: v.codec_name ?? null,
    width: numOrNull(v.width),
    height: numOrNull(v.height),
    fps: pickFrameRate(v),
    frames: numOrNull(v.nb_frames),
    pixFmt: v.pix_fmt ?? null,
    // Colour tags (v0.22). NOT part of the concat signature — a mismatch never
    // breaks a stream copy — but the joined file advertises only the FIRST
    // segment's, so footage tagged differently from the scenes beside it is a
    // visible difference that nothing else in the tool surface reports.
    //
    // `matrix` is ffprobe's `color_space`, renamed on the way out: "colour
    // space" reads as the whole colorimetry in every other sentence it appears
    // in, while the field is only the YUV↔RGB matrix coefficients. Keeping
    // ffprobe's name here would make every doc sentence about it ambiguous.
    color: {
      primaries: colorTagOrNull(v.color_primaries),
      transfer: colorTagOrNull(v.color_transfer),
      matrix: colorTagOrNull(v.color_space),
      range: colorTagOrNull(v.color_range),
    },
    durationSeconds: numOrNull(v.duration),
  } : null;

  const audio = a ? {
    codec: a.codec_name ?? null,
    channels: numOrNull(a.channels),
    sampleRate: numOrNull(a.sample_rate),
    durationSeconds: numOrNull(a.duration),
  } : null;

  const notes = [];
  if (video && BROWSER_UNDECODABLE.has(String(video.codec).toLowerCase())) {
    notes.push(
      `Video codec "${video.codec}" cannot be decoded by the render browser — a <video> element using this ` +
      `file will fail at render time even though canPlayType() claims otherwise. Transcode to ${BROWSER_OK_VIDEO} ` +
      'before referencing it from a composition. (It is still fine as a film overlay, which ffmpeg composites.)',
    );
  }
  if (video && video.fps && video.fps % 1 !== 0) {
    notes.push(`Frame rate is fractional (${video.fps}); scenes render at integer fps, so seeking will not land on source frames exactly.`);
  }

  return {
    container: fmt.format_name ?? null,
    durationSeconds: numOrNull(fmt.duration),
    bitRate: numOrNull(fmt.bit_rate),
    streams: streams.length,
    video,
    audio,
    hasAudio: !!audio,
    ...(notes.length ? { notes } : {}),
  };
}

/**
 * Probe any media file for duration / dimensions / fps / codecs (v0.21).
 *
 * Returns null when ffprobe is unavailable or the file is not media, exactly
 * like probeFrameCount(): ffprobe is not a declared prerequisite (see
 * core/prereqs.js), so "cannot tell" is a normal answer, never a failure.
 */
export async function probeMedia({ filePath, ffprobePath = 'ffprobe', onSpawn, signal }) {
  if (signal?.aborted) return null;
  let proc;
  try {
    proc = spawn(ffprobePath, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  const onAbort = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    const code = await new Promise((resolve) => {
      proc.on('error', () => resolve(-1));
      proc.on('close', resolve);
    });
    if (code !== 0 || !stdout.trim()) return null;
    try {
      return summarizeMedia(JSON.parse(stdout));
    } catch {
      return null;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Mux audio tracks into a silent video. Video stream is copied (no
 * re-encode); audio codec comes from the format registry. Output trimmed to
 * video duration (-shortest is wrong here — a short music bed would truncate
 * the video — so we trim the mixed audio to the video length with apad+atrim).
 */
export async function muxAudio({ videoPath, audioTracks, outputPath, fps, assetRoot, output = {}, ffmpegPath = 'ffmpeg', onSpawn, videoDurationSec }) {
  const fmt = getFormat(output.format ?? 'mp4');
  if (!fmt.audioArgs) {
    throw new EngineError(ErrorCodes.UNSUPPORTED_FORMAT, `Format "${output.format}" does not carry audio`, {
      format: output.format,
    });
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  for (const t of audioTracks) args.push('-i', path.resolve(assetRoot, t.src));

  // apad is BOUNDED (whole_dur): with the duck branches also padded to the
  // composition length, an unbounded apad into atrim can busy-spin forever
  // when the mix ends at exactly the trim point. whole_dur keeps the graph
  // free of infinite generators, so it terminates by construction.
  const filter =
    buildAudioFilter(audioTracks, fps, { limiter: output.audioLimiter !== false, videoDurationSec }) +
    `;[aout]apad=whole_dur=${videoDurationSec.toFixed(3)},atrim=0:${videoDurationSec.toFixed(3)}[afinal]`;

  args.push(
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[afinal]',
    '-c:v', 'copy', ...fmt.audioArgs(),
    outputPath,
  );
  const stderrTail = [];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  collectStderr(proc, stderrTail);
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  await waitExit(proc, stderrTail, 'audio-mux');
}

/**
 * Mix the configured audio tracks to a standalone WAV — the same graph the
 * final render uses (delay/gain/trim/fades/limiter), minus the video (v0.19).
 * Lets a caller audition and level-check the mix in seconds instead of paying
 * for a full render. A silent anullsrc stands in as input 0 so the
 * buildAudioFilter graph (whose audio inputs start at 1) is reused verbatim —
 * what you hear is what the render will mux.
 */
export async function mixAudioOnly({ audioTracks, outputPath, fps, assetRoot, output = {}, ffmpegPath = 'ffmpeg', onSpawn, videoDurationSec, signal }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // dummy input 0 (the "video" slot in the shared filter graph)
    '-f', 'lavfi', '-t', videoDurationSec.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo',
  ];
  for (const t of audioTracks) args.push('-i', path.resolve(assetRoot, t.src));

  // Bounded pad — see muxAudio for why apad must carry whole_dur here.
  const filter =
    buildAudioFilter(audioTracks, fps, { limiter: output.audioLimiter !== false, videoDurationSec }) +
    `;[aout]apad=whole_dur=${videoDurationSec.toFixed(3)},atrim=0:${videoDurationSec.toFixed(3)}[afinal]`;

  args.push('-filter_complex', filter, '-map', '[afinal]', '-c:a', 'pcm_s16le', outputPath);
  await runFfmpeg({ args, ffmpegPath, onSpawn, what: 'audio-preview', signal });
}
