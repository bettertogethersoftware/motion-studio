/**
 * Review the file that ffmpeg actually wrote (v0.23).
 *
 * A composition preview is valuable before rendering, but it cannot expose a
 * concat seam, a burned caption, or an overlay. These helpers deliberately
 * read an encoded output: still extraction gives the caller images to inspect;
 * low-resolution greyscale sampling compresses the whole picture into bounded
 * motion/black/static facts without introducing a cloud review dependency.
 */

import { spawn } from 'node:child_process';
import { EngineError, ErrorCodes } from './errors.js';

export const MAX_RENDER_INSPECTION_FRAMES = 24;
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

function contextAtFrame(sceneLayout = [], frame) {
  const item = sceneLayout.find((entry) => {
    const start = entry.filmOffset ?? 0;
    return frame >= start && frame < start + (entry.durationInFrames ?? 0);
  });
  if (!item) return null;
  return {
    ...(item.sceneId ? { scene: item.sceneId } : {}),
    ...(item.footage ? { footage: item.footage } : {}),
    ...(item.name ? { name: item.name } : {}),
    startFrame: item.filmOffset ?? 0,
    durationFrames: item.durationInFrames ?? null,
  };
}

/** Return explicitly useful review frames, not a generic uniform sample. */
export function reviewFrameList({ totalFrames, sceneLayout = [], frames, count = 5, around = 'uniform', maxFrames }) {
  const limit = Math.max(0, totalFrames - 1);
  const unique = (items) => [...new Set(items.map((frame) => Math.max(0, Math.min(limit, Math.round(frame)))))];
  const evenlySpaced = (items, maximum) => {
    if (!maximum || items.length <= maximum) return items;
    if (maximum === 1) return [items[0]];
    return Array.from({ length: maximum }, (_, index) => items[Math.round(index * (items.length - 1) / (maximum - 1))]);
  };
  if (frames?.length) return unique(frames);
  if (around === 'cuts' && sceneLayout.length) {
    // A frame triple is useful only together. On long films, choose cut
    // locations across the timeline rather than making the default unusable.
    const cuts = evenlySpaced(sceneLayout, Math.max(1, Math.floor((maxFrames ?? Infinity) / 3)));
    return unique(cuts.flatMap((entry) => {
      const cut = entry.filmOffset ?? 0;
      return [cut - 1, cut, cut + 2];
    })).slice(0, maxFrames ?? Infinity);
  }
  if (around === 'holds' && sceneLayout.length) {
    return unique(evenlySpaced(sceneLayout, maxFrames)
      .map((entry) => (entry.filmOffset ?? 0) + ((entry.durationInFrames ?? 1) - 1) / 2));
  }
  const n = Math.max(1, count);
  if (n === 1 || limit === 0) return [0];
  return unique(Array.from({ length: n }, (_, i) => Math.round((limit * i) / (n - 1))));
}

function ffmpegCapture({ args, ffmpegPath = 'ffmpeg', what, signal, onSpawn, maxBytes = MAX_CAPTURE_BYTES }) {
  if (signal?.aborted) return Promise.reject(new EngineError(ErrorCodes.CANCELLED, `${what}: cancelled before start`));
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    const stderr = [];
    const abort = () => { try { proc.kill('SIGKILL'); } catch { /* already exited */ } };
    if (onSpawn && proc.pid) onSpawn(proc.pid);
    signal?.addEventListener('abort', abort, { once: true });
    proc.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        abort();
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8'));
      if (stderr.length > 20) stderr.shift();
    });
    proc.on('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(new EngineError(ErrorCodes.FFMPEG_FAILED, `${what}: failed to start ffmpeg: ${error.message}`));
    });
    proc.on('close', (code, killedBy) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new EngineError(ErrorCodes.CANCELLED, `${what}: cancelled`));
      if (bytes > maxBytes) {
        return reject(new EngineError(ErrorCodes.FFMPEG_FAILED, `${what}: output exceeded ${maxBytes} bytes`));
      }
      if (code !== 0) {
        return reject(new EngineError(
          ErrorCodes.FFMPEG_FAILED,
          `${what}: ffmpeg exited with code ${code}${killedBy ? ` (${killedBy})` : ''}`,
          { stderrTail: stderr.join('').trim().split('\n').slice(-20) },
        ));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Extract one downscaled PNG from an encoded output, at a frame-number time. */
export async function extractRenderedFrame({ filePath, frame, fps, maxWidth = 960, ffmpegPath = 'ffmpeg', signal, onSpawn }) {
  const seconds = Math.max(0, frame) / fps;
  const png = await ffmpegCapture({
    ffmpegPath,
    what: 'inspect-render',
    signal,
    onSpawn,
    args: [
      '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', filePath,
      '-frames:v', '1', '-vf', `scale=${maxWidth}:-2:force_original_aspect_ratio=decrease`,
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ],
  });
  if (!png.length) throw new EngineError(ErrorCodes.FFMPEG_FAILED, `inspect-render: no frame decoded at ${frame}`);
  return png;
}

const mean = (frame) => frame.reduce((sum, pixel) => sum + pixel, 0) / frame.length;
const variance = (frame, average) => frame.reduce((sum, pixel) => sum + ((pixel - average) ** 2), 0) / frame.length;
const delta = (a, b) => {
  if (!a?.length || !b?.length || a.length !== b.length) return null;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
};

async function greyFrame({ filePath, frame, fps, ffmpegPath, signal, onSpawn }) {
  const raw = await ffmpegCapture({
    ffmpegPath,
    what: 'measure-render cut',
    signal,
    onSpawn,
    maxBytes: SAMPLE_BYTES * 2,
    args: [
      '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, frame) / fps), '-i', filePath,
      '-frames:v', '1', '-vf', `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ],
  });
  return raw.length >= SAMPLE_BYTES ? raw.subarray(0, SAMPLE_BYTES) : null;
}

function runsFrom(flags, fps, sceneLayout, map = () => ({})) {
  const out = [];
  let start = null;
  const push = (end) => {
    if (start === null) return;
    const seconds = end - start;
    if (seconds > 0) {
      const startFrame = Math.round(start * fps);
      out.push({
        startFrame,
        durationFrames: Math.round(seconds * fps),
        durationSeconds: round(seconds),
        ...(contextAtFrame(sceneLayout, startFrame) ? { scene: contextAtFrame(sceneLayout, startFrame) } : {}),
        ...map(start, end),
      });
    }
    start = null;
  };
  flags.forEach((on, index) => {
    if (on && start === null) start = index;
    if (!on) push(index);
  });
  push(flags.length);
  return out;
}

/**
 * Read the full output at one low-resolution greyscale frame per second.
 * The result is intentionally a report, not a pass/fail gate: title cards and
 * fades are often static or dark on purpose.
 */
export async function measureRenderedPicture({
  filePath, fps, totalFrames, sceneLayout = [], ffmpegPath = 'ffmpeg', signal, onSpawn,
}) {
  const raw = await ffmpegCapture({
    ffmpegPath,
    what: 'measure-render',
    signal,
    onSpawn,
    args: [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-vf', `fps=1,scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ],
  });
  const samples = [];
  for (let offset = 0; offset + SAMPLE_BYTES <= raw.length; offset += SAMPLE_BYTES) {
    samples.push(raw.subarray(offset, offset + SAMPLE_BYTES));
  }
  if (!samples.length) {
    const first = await greyFrame({ filePath, frame: 0, fps, ffmpegPath, signal, onSpawn });
    if (first) samples.push(first);
  }

  const deltas = samples.map((sample, index) => (index ? delta(samples[index - 1], sample) : null));
  const motionEnvelope = samples.map((sample, index) => ({
    startFrame: Math.round(index * fps),
    delta: deltas[index] === null ? null : round(deltas[index]),
  }));
  // At 64×36 greyscale this leaves normal compression shimmer alone while a
  // truly still held frame is zero or close to it.
  const staticRuns = runsFrom(deltas.map((value, index) => index > 0 && value !== null && value <= 0.75), fps, sceneLayout);
  const levels = samples.map((sample) => ({ mean: mean(sample), variance: variance(sample, mean(sample)) }));
  const blackRuns = runsFrom(levels.map((level) => level.mean <= 4), fps, sceneLayout);
  const solidFrames = levels
    .map((level, index) => ({ frame: Math.round(index * fps), mean: level.mean, variance: level.variance }))
    .filter((level) => level.variance <= 2)
    .slice(0, MAX_RENDER_INSPECTION_FRAMES)
    .map((level) => ({ frame: level.frame, luma: round(level.mean), ...(contextAtFrame(sceneLayout, level.frame) ? { scene: contextAtFrame(sceneLayout, level.frame) } : {}) }));

  const cuts = sceneLayout.slice(1, 49);
  const cutCheck = [];
  for (const entry of cuts) {
    const expectedFrame = entry.filmOffset ?? 0;
    if (expectedFrame <= 0) continue;
    const [before, after] = await Promise.all([
      greyFrame({ filePath, frame: expectedFrame - 1, fps, ffmpegPath, signal, onSpawn }),
      greyFrame({ filePath, frame: expectedFrame, fps, ffmpegPath, signal, onSpawn }),
    ]);
    const difference = delta(before, after);
    cutCheck.push({
      expectedFrame,
      deltaAtCut: difference === null ? null : round(difference),
      verdict: difference === null ? 'unmeasurable' : difference <= 0.75 ? 'near-identical' : 'changed',
      ...(contextAtFrame(sceneLayout, expectedFrame) ? { scene: contextAtFrame(sceneLayout, expectedFrame) } : {}),
    });
  }

  const warnings = [
    ...staticRuns.filter((run) => run.durationSeconds >= 2).map((run) =>
      `Picture is nearly static for ${run.durationSeconds}s from frame ${run.startFrame}${run.scene?.name ? ` (${run.scene.name})` : ''}.`),
    ...blackRuns.filter((run) => run.durationSeconds >= 1).map((run) =>
      `Picture is near-black for ${run.durationSeconds}s from frame ${run.startFrame}${run.scene?.name ? ` (${run.scene.name})` : ''}.`),
    ...cutCheck.filter((cut) => cut.verdict === 'near-identical').map((cut) =>
      `Expected cut at frame ${cut.expectedFrame} is nearly identical on both sides.`),
  ];

  const frames = totalFrames ?? Math.round(samples.length * fps);
  return {
    frames,
    fps,
    durationSeconds: round(frames / fps),
    motionEnvelope,
    staticRuns,
    blackRuns,
    solidFrames,
    cutCheck,
    warnings,
    summary: {
      staticFrames: staticRuns.reduce((sum, run) => sum + run.durationFrames, 0),
      blackFrames: blackRuns.reduce((sum, run) => sum + run.durationFrames, 0),
      cutsChecked: cutCheck.length,
      cutsSuspect: cutCheck.filter((cut) => cut.verdict === 'near-identical').length,
    },
  };
}
