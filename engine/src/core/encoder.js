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
export function buildAudioFilter(tracks, fps) {
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
  const mix =
    tracks.length === 1
      ? `${mixInputs[0]}anull[aout]`
      : `${mixInputs.join('')}amix=inputs=${tracks.length}:normalize=0[aout]`;
  return [...chains, mix].join(';');
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
    buildAudioFilter(audioTracks, fps) +
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
