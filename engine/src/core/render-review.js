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
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { runFfmpeg, probeMedia } from './encoder.js';
import { outputIdentity } from './delivery.js';

export const MAX_RENDER_INSPECTION_FRAMES = 24;
/** A persistent contact sheet needs more coverage than an inline MCP response. */
export const MAX_DELIVERY_REVIEW_FRAMES = 96;
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

/** Stable policy names persisted in review artifacts and accepted by settings. */
export const REVIEW_WARNING_CODES = Object.freeze([
  'frame_count_mismatch',
  'frame_count_unverified',
  'static_run',
  'black_run',
  'suspect_cut',
  'audio_clipping',
  'audio_balance',
  'audio_silent_tail',
  'picture_measurement_unavailable',
  'probe_unavailable',
  'contact_sheet_truncated',
]);

/** Conservative by default: production intent, not a heuristic, owns a block. */
export const DEFAULT_REVIEW_POLICY = Object.freeze({
  block: Object.freeze(['frame_count_mismatch']),
  warn: Object.freeze([
    'static_run',
    'black_run',
    'suspect_cut',
    'audio_clipping',
    'audio_balance',
    'audio_silent_tail',
    'picture_measurement_unavailable',
    'frame_count_unverified',
    'contact_sheet_truncated',
  ]),
});

/** Find the segment that owns a frame, for both review JSON and Studio labels. */
export function contextAtFrame(sceneLayout = [], frame) {
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

function uniqueKnownCodes(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => REVIEW_WARNING_CODES.includes(value)))];
}

/** Normalize a policy without silently letting the same rule block and warn. */
export function normalizeReviewPolicy(policy = DEFAULT_REVIEW_POLICY) {
  const block = uniqueKnownCodes(policy?.block ?? DEFAULT_REVIEW_POLICY.block);
  const warn = uniqueKnownCodes(policy?.warn ?? DEFAULT_REVIEW_POLICY.warn)
    .filter((code) => !block.includes(code));
  return { block, warn };
}

/** Global settings seed a film; a supplied film policy wins field-by-field. */
export function resolveReviewPolicy({ globalPolicy, filmPolicy } = {}) {
  const global = normalizeReviewPolicy(globalPolicy ?? DEFAULT_REVIEW_POLICY);
  if (!filmPolicy) return global;
  return normalizeReviewPolicy({
    block: filmPolicy.block ?? global.block,
    warn: filmPolicy.warn ?? global.warn,
  });
}

/** Attach the producer-facing severity, leaving unconfigured facts as info. */
export function classifyReviewWarnings(warnings = [], policy) {
  const resolved = normalizeReviewPolicy(policy);
  return warnings.map((warning) => ({
    ...warning,
    level: resolved.block.includes(warning.code)
      ? 'block'
      : resolved.warn.includes(warning.code)
        ? 'warn'
        : 'info',
  }));
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
  const scale = `scale=${maxWidth}:-2:force_original_aspect_ratio=decrease`;
  try {
    const png = await ffmpegCapture({
      ffmpegPath,
      what: 'inspect-render',
      signal,
      onSpawn,
      args: [
        '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', filePath,
        '-frames:v', '1', '-vf', scale,
        '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
      ],
    });
    if (png.length) return png;
  } catch (fastSeekError) {
    // Some short MP4s advertise their last packet at the exact container end;
    // an input seek to that timestamp can return no decoded frame even though
    // ffprobe counted it. Retry through select=n so the review still samples
    // the final delivery frame rather than failing an otherwise valid build.
    if (frame < 1) throw fastSeekError;
  }
  const png = await ffmpegCapture({
    ffmpegPath,
    what: 'inspect-render fallback',
    signal,
    onSpawn,
    args: [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-vf', `select=eq(n\\,${Math.round(frame)}),${scale}`,
      '-frames:v', '1', '-vsync', '0',
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

/* ------------------------------------------------------------------ */
/* Persistent delivery review (P0-2)                                  */
/* ------------------------------------------------------------------ */

/** Paths beside a delivery, rather than beside an in-progress staging file. */
export function reviewArtifactPaths(deliveryPath) {
  const abs = path.resolve(deliveryPath);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  const dir = path.dirname(abs);
  return {
    reviewPath: path.join(dir, `${base}.review.json`),
    contactPath: path.join(dir, `${base}.contact.png`),
  };
}

/**
 * First/last, every timeline cut, and every caption onset make a compact
 * producer review. Long timelines may exceed the contact-sheet safety cap;
 * the report says so instead of pretending the omitted points were sampled.
 */
export function deliveryReviewFrameList({
  totalFrames, sceneLayout = [], captions = [], maxFrames = MAX_DELIVERY_REVIEW_FRAMES,
}) {
  const limit = Math.max(0, Number(totalFrames ?? 0) - 1);
  const frames = [0, limit];
  for (const entry of sceneLayout.slice(1)) frames.push(entry.filmOffset ?? 0);
  for (const caption of captions) frames.push(caption?.fromFrame ?? 0);
  const requested = [...new Set(frames.map((frame) => Math.max(0, Math.min(limit, Math.round(frame)))))]
    .sort((a, b) => a - b);
  const cap = Number.isFinite(maxFrames) ? Math.max(2, Math.floor(maxFrames)) : requested.length;
  if (requested.length <= cap) return { frames: requested, requestedFrames: requested.length, truncated: false };
  const sampled = [...new Set(Array.from({ length: cap }, (_, index) =>
    requested[Math.round(index * (requested.length - 1) / (cap - 1))],
  ))].sort((a, b) => a - b);
  return { frames: sampled, requestedFrames: requested.length, truncated: true };
}

function pictureWarnings(picture) {
  if (!picture) return [];
  return [
    ...(picture.staticRuns ?? []).filter((run) => run.durationSeconds >= 2).map((run) => ({
      code: 'static_run',
      message: `Picture is nearly static for ${run.durationSeconds}s from frame ${run.startFrame}.`,
      frame: run.startFrame,
      durationFrames: run.durationFrames,
      ...(run.scene ? { context: run.scene } : {}),
    })),
    ...(picture.blackRuns ?? []).filter((run) => run.durationSeconds >= 1).map((run) => ({
      code: 'black_run',
      message: `Picture is near-black for ${run.durationSeconds}s from frame ${run.startFrame}.`,
      frame: run.startFrame,
      durationFrames: run.durationFrames,
      ...(run.scene ? { context: run.scene } : {}),
    })),
    ...(picture.cutCheck ?? []).filter((cut) => cut.verdict === 'near-identical').map((cut) => ({
      code: 'suspect_cut',
      message: `Expected cut at frame ${cut.expectedFrame} is nearly identical on both sides.`,
      frame: cut.expectedFrame,
      ...(cut.scene ? { context: cut.scene } : {}),
    })),
  ];
}

function audioWarnings(audio) {
  if (!audio) return [];
  return [
    ...(audio.clipping ? [{
      code: 'audio_clipping',
      message: `Mixed audio peaks at ${audio.peakDb ?? '?'} dBFS.`,
    }] : []),
    ...((audio.balanceWarnings ?? []).map((message) => ({ code: 'audio_balance', message }))),
    ...(audio.silentTailSeconds > 0 ? [{
      code: 'audio_silent_tail',
      message: `Audio is silent for the final ${round(audio.silentTailSeconds)}s.`,
    }] : []),
  ];
}

function rawReviewWarnings({ frameCheck, picture, pictureError, audio, probe, selection }) {
  const expected = frameCheck?.expected ?? null;
  const actual = frameCheck?.actual ?? null;
  return [
    ...(Number.isInteger(actual) && Number.isInteger(expected) && actual !== expected ? [{
      code: 'frame_count_mismatch',
      message: `Encoded output has ${actual} frames; ${expected} were required.`,
      expectedFrames: expected,
      actualFrames: actual,
    }] : []),
    ...(frameCheck && frameCheck.verified === false ? [{
      code: 'frame_count_unverified',
      message: 'The output frame count could not be verified because ffprobe was unavailable.',
    }] : []),
    ...pictureWarnings(picture),
    ...(pictureError ? [{
      code: 'picture_measurement_unavailable',
      message: `Picture measurement was unavailable: ${pictureError}`,
    }] : []),
    ...audioWarnings(audio),
    ...(probe ? [] : [{
      code: 'probe_unavailable',
      message: 'Media probe was unavailable; codec and stream facts were not recorded.',
    }]),
    ...(selection.truncated ? [{
      code: 'contact_sheet_truncated',
      message: `Contact sheet sampled ${selection.frames.length} of ${selection.requestedFrames} requested review frames.`,
    }] : []),
  ];
}

function safeGuideFilters(safeAreas) {
  if (!safeAreas || typeof safeAreas !== 'object') return [];
  const guide = (insets, color) => {
    if (!insets || typeof insets !== 'object') return null;
    const left = Number(insets.leftPct);
    const right = Number(insets.rightPct);
    const top = Number(insets.topPct);
    const bottom = Number(insets.bottomPct);
    if (![left, right, top, bottom].every(Number.isFinite)) return null;
    const width = 100 - left - right;
    const height = 100 - top - bottom;
    if (width <= 0 || height <= 0) return null;
    // These expressions draw on every extracted target-sized thumbnail before
    // tile packs it. `iw`/`ih` keep the guide correct for landscape, portrait,
    // and square contact sheets without guessing their thumbnail dimensions.
    return `drawbox=x=iw*${left / 100}:y=ih*${top / 100}:w=iw*${width / 100}:h=ih*${height / 100}:color=${color}:t=2`;
  };
  return [
    guide(safeAreas.title, '0x4fd1c5@0.92'),
    guide(safeAreas.caption, '0xf6c85f@0.92'),
  ].filter(Boolean);
}

async function writeContactSheet({ images, outputPath, safeAreas = null, ffmpegPath, signal, onSpawn }) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-contact-sheet-'));
  try {
    for (let index = 0; index < images.length; index += 1) {
      await fsp.writeFile(path.join(tmp, `frame-${String(index + 1).padStart(4, '0')}.png`), images[index].png);
    }
    const columns = Math.max(1, Math.ceil(Math.sqrt(images.length * (16 / 9))));
    const rows = Math.ceil(images.length / columns);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const guides = safeGuideFilters(safeAreas);
    await runFfmpeg({
      ffmpegPath,
      signal,
      onSpawn,
      what: 'render-review contact sheet',
      args: [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-framerate', '1', '-start_number', '1', '-i', path.join(tmp, 'frame-%04d.png'),
        '-vf', [...guides, `tile=${columns}x${rows}:padding=4:margin=4:color=0x10141d`].join(','),
        '-frames:v', '1', outputPath,
      ],
    });
    return { columns, rows, safeAreas: guides.length ? safeAreas : null };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build review JSON + contact PNG from the staged file. The caller owns policy
 * enforcement and promotion, so this function can be shared by scene renders
 * and film builds without either layer guessing at output paths.
 */
export async function createDeliveryReview({
  stagedOutputPath,
  deliveryPath = stagedOutputPath,
  fps,
  totalFrames,
  sceneLayout = [],
  captions = [],
  audio = null,
  picture = null,
  pictureError = null,
  frameCheck = null,
  policy,
  safeAreas = null,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  signal,
  onSpawn,
  maxFrames = MAX_DELIVERY_REVIEW_FRAMES,
}) {
  const stagedPaths = reviewArtifactPaths(stagedOutputPath);
  const paths = reviewArtifactPaths(deliveryPath);
  const selection = deliveryReviewFrameList({ totalFrames, sceneLayout, captions, maxFrames });
  const onsetText = new Map((captions ?? []).map((caption) => [Math.round(caption.fromFrame ?? 0), caption.text ?? '']));
  const images = [];
  for (const frame of selection.frames) {
    images.push({
      frame,
      png: await extractRenderedFrame({
        filePath: stagedOutputPath, frame, fps, maxWidth: 360, ffmpegPath, signal, onSpawn,
      }),
      context: contextAtFrame(sceneLayout, frame),
      ...(onsetText.has(frame) ? { captionOnset: onsetText.get(frame) } : {}),
    });
  }
  const contact = await writeContactSheet({
    images, outputPath: stagedPaths.contactPath, safeAreas, ffmpegPath, signal, onSpawn,
  });
  const probe = await probeMedia({ filePath: stagedOutputPath, ffprobePath, signal, onSpawn }).catch(() => null);
  const resolvedPolicy = normalizeReviewPolicy(policy);
  const warnings = classifyReviewWarnings(
    rawReviewWarnings({ frameCheck, picture, pictureError, audio, probe, selection }),
    resolvedPolicy,
  );
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    delivery: {
      filename: path.basename(deliveryPath),
      fps,
      expectedFrames: totalFrames,
      actualFrames: frameCheck?.actual ?? null,
      framesVerified: frameCheck?.verified === true,
      durationSeconds: round(totalFrames / fps),
      outputIdentity: outputIdentity(stagedOutputPath),
      probe,
    },
    audio,
    picture,
    policy: resolvedPolicy,
    warnings,
    contact: {
      filename: path.basename(paths.contactPath),
      columns: contact.columns,
      rows: contact.rows,
      ...(contact.safeAreas ? { safeAreas: contact.safeAreas } : {}),
      requestedFrames: selection.requestedFrames,
      truncated: selection.truncated,
      thumbnails: images.map(({ png, ...thumbnail }, index) => ({
        ...thumbnail,
        index,
        row: Math.floor(index / contact.columns),
        column: index % contact.columns,
      })),
    },
  };
  await fsp.writeFile(stagedPaths.reviewPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return { report, paths, stagedPaths };
}

/** Prevent promotion while preserving the complete staged evidence for review. */
export function assertReviewAllowsPromotion(review, { stagingPath } = {}) {
  const blocked = (review?.report?.warnings ?? []).filter((warning) => warning.level === 'block');
  if (!blocked.length) return;
  throw new EngineError(
    ErrorCodes.PROMOTION_BLOCKED,
    `Delivery promotion blocked by review policy: ${blocked.map((warning) => warning.code).join(', ')}.`,
    {
      stagingPath,
      reviewPath: review.stagedPaths?.reviewPath,
      contactPath: review.stagedPaths?.contactPath,
      rules: blocked.map((warning) => ({ code: warning.code, message: warning.message })),
    },
  );
}
