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
export async function mixAudioOnly({ audioTracks, outputPath, fps, projectRoot, output = {}, ffmpegPath = 'ffmpeg', onSpawn, videoDurationSec }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // dummy input 0 (the "video" slot in the shared filter graph)
    '-f', 'lavfi', '-t', videoDurationSec.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo',
  ];
  for (const t of audioTracks) args.push('-i', path.resolve(projectRoot, t.src));

  // Bounded pad — see muxAudio for why apad must carry whole_dur here.
  const filter =
    buildAudioFilter(audioTracks, fps, { limiter: output.audioLimiter !== false, videoDurationSec }) +
    `;[aout]apad=whole_dur=${videoDurationSec.toFixed(3)},atrim=0:${videoDurationSec.toFixed(3)}[afinal]`;

  args.push('-filter_complex', filter, '-map', '[afinal]', '-c:a', 'pcm_s16le', outputPath);
  const stderrTail = [];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  collectStderr(proc, stderrTail);
  if (onSpawn && proc.pid) onSpawn(proc.pid);
  await waitExit(proc, stderrTail, 'audio-preview');
}
