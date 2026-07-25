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
import { getFormat, INTERMEDIATE } from './formats.js';

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
   * @param {number} opts.fps
   * @param {object} [opts.output]   { format, crf, preset, pixFmt, transparent, intermediate } from project config
   * @param {string} [opts.ffmpegPath]
   * @param {(pid:number)=>void} [opts.onSpawn]  report pid for process-tree cleanup
   */
  constructor({ outputPath, fps, output = {}, ffmpegPath = 'ffmpeg', onSpawn }) {
    this.stderrTail = [];
    this.args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
      '-an',
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

/** Encode a directory of zero-padded PNGs (frame-%06d.png) to the target format. */
export async function encodePngSequence({ framesDir, outputPath, fps, output = {}, ffmpegPath = 'ffmpeg', onSpawn }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps), '-i', path.join(framesDir, 'frame-%06d.png'),
    '-an',
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
 * Track: { src, startInFrames = 0, gainDb = 0 }
 */
/**
 * Brick-wall limiter appended to the mix (v0.10). limit=0.891 is -1 dBFS;
 * level=0 disables alimiter's auto-levelling, which would otherwise make the
 * filter *boost* quiet audio instead of only catching peaks. Below -1 dBFS this
 * is a no-op, so it costs nothing on a mix that was already safe.
 */
export const LIMITER_FILTER = 'alimiter=limit=0.891:level=0';

/**
 * @param {object} [options]
 * @param {boolean} [options.limiter=true] append LIMITER_FILTER to the mix.
 *   amix runs with normalize=0 so gains sum directly — three tracks at 0 dB can
 *   sum well past full scale. Set false to pass the mix through untouched.
 */
export function buildAudioFilter(tracks, fps, { limiter = true } = {}) {
  const chains = [];
  const mixInputs = [];
  tracks.forEach((t, i) => {
    const delayMs = Math.round(((t.startInFrames ?? 0) / fps) * 1000);
    const gain = t.gainDb ?? 0;
    const label = `a${i}`;
    // input 0 is the video; audio inputs start at 1
    chains.push(`[${i + 1}:a]adelay=${delayMs}|${delayMs},volume=${gain}dB[${label}]`);
    mixInputs.push(`[${label}]`);
  });
  const mixOut = limiter ? '[amix]' : '[aout]';
  const mix =
    tracks.length === 1
      ? `${mixInputs[0]}anull${mixOut}`
      : `${mixInputs.join('')}amix=inputs=${tracks.length}:normalize=0${mixOut}`;
  const graph = [...chains, mix];
  if (limiter) graph.push(`[amix]${LIMITER_FILTER}[aout]`);
  return graph.join(';');
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

/**
 * Mux audio tracks into a silent video. Video stream is copied (no
 * re-encode); audio codec comes from the format registry. Output trimmed to
 * video duration (-shortest is wrong here — a short music bed would truncate
 * the video — so we trim the mixed audio to the video length with apad+atrim).
 */
export async function muxAudio({ videoPath, audioTracks, outputPath, fps, projectRoot, output = {}, ffmpegPath = 'ffmpeg', onSpawn, videoDurationSec }) {
  const fmt = getFormat(output.format ?? 'mp4');
  if (!fmt.audioArgs) {
    throw new EngineError(ErrorCodes.UNSUPPORTED_FORMAT, `Format "${output.format}" does not carry audio`, {
      format: output.format,
    });
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  for (const t of audioTracks) args.push('-i', path.resolve(projectRoot, t.src));

  const filter =
    buildAudioFilter(audioTracks, fps, { limiter: output.audioLimiter !== false }) +
    `;[aout]apad,atrim=0:${videoDurationSec.toFixed(3)}[afinal]`;

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
