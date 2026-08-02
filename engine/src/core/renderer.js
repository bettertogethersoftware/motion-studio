/**
 * Render Engine Core — the single implementation of "launch Chromium /
 * capture frames / run FFmpeg" (spec §3). Entry points that call into it:
 *
 *   src/cli/render.js     — command-line renders (humans, scripts, CI)
 *   src/mcp/server.js     — the MCP job manager (agent path)
 *   src/studio/server.js  — the Studio web UI's render endpoint
 *
 * Public surface:
 *   renderComposition(opts)     — serial capture+encode of a frame range
 *   renderParallel(opts)        — split range across worker processes + merge
 *   captureSingleFrame(opts)    — one frame as a PNG buffer (agent preview)
 *   captureFrames(opts)         — N frames from ONE page load (v0.10)
 *   renderStill(opts)           — one frame written to disk as a PNG still
 *   preflightFrameList(a, b, n) — the frames a pre-flight pass probes
 *   normalizeProxy(p)           — validate/default a proxy request (v0.21)
 *   proxyDimensions(w, h, s)    — scaled capture size, floored to even
 *   steppedFrameList(a, b, n)   — the frames a frame-step render captures
 *   proxyOutputPath(p)          — "output.mp4" → "output.proxy.mp4"
 *
 * Proxy/motion preview (v0.21): `proxy: { scale?, frameStep? }` renders a
 * cheap draft for checking motion before committing to the real thing. The
 * viewport shrinks to width×scale (so the screenshot — the dominant capture
 * cost — is small), every frameStep-th frame is captured, and the encode runs
 * at the rational rate fps/frameStep so wall-clock duration is preserved.
 * Proxies are serial-only (already cheap; renderParallel delegates), skip
 * pre-flight (the proxy IS the pre-flight), skip the audio mux (it is a
 * motion check, and audio would dominate the time saved), and write to
 * `<name>.proxy.<ext>` so a proxy can never overwrite the deliverable.
 *
 * Pre-flight (v0.10): a composition that throws only at, say, frame 90 used to
 * take the whole render down after ~90 frames of work (and after spawning every
 * worker). Both render paths now probe a handful of evenly-spaced frames first
 * and fail fast with the real composition_error. Serial renders reuse the page
 * they already opened, so the check is nearly free; the parallel path pays one
 * browser launch to avoid wasting N of them. Disable with `preflight: false`.
 *
 * Formats (v0.5): the target format comes from config.output.format
 * (core/formats.js). "png-sequence" writes a folder of frames and skips the
 * encode. For parallel renders, formats whose segments cannot be losslessly
 * copy-concatenated (gif) — or any transparent render — go through a
 * lossless FFV1 intermediate, then one final encode pass.
 *
 * Cancellation: pass an AbortSignal. On abort the capture loop stops between
 * frames, the FFmpeg sink and Chromium are killed, and a CANCELLED
 * EngineError is thrown. All spawned pids are reported via onChildPid so the
 * process owner can guarantee no orphaned Chromium/FFmpeg survives.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { EngineError, ErrorCodes, asEngineError } from './errors.js';
import { ProgressEmitter, ProgressStreamParser } from './progress.js';
import { createPuppeteerBrowser, isBrowserCrash } from './browser.js';
import { FfmpegFrameSink, encodePngSequence, concatSegments, muxAudio, transcode, measureAudioLevels, probeFrameCount, computeBalanceWarnings } from './encoder.js';
import {
  measureRenderedPicture, createDeliveryReview, assertReviewAllowsPromotion, resolveReviewPolicy,
} from './render-review.js';
import { measureWavLevels, wavDurationSeconds } from './tts.js';
import { getFormat, INTERMEDIATE, encodingCompatibilityWarnings } from './formats.js';
import { acquireRenderLock } from './lock.js';
import { sceneOutputPath, writeRenderMeta } from './film.js';
import { prepareStagingOutput, promoteStagingOutput, assertDeliveryWritable } from './delivery.js';
import { archiveRevision } from './revisions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function throwIfAborted(signal) {
  if (signal?.aborted) throw new EngineError(ErrorCodes.CANCELLED, 'Render cancelled');
}

function resolveRange(config, frameRange) {
  const total = config.durationInFrames;
  let [start, end] = frameRange ?? [0, total - 1];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= total) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `frameRange [${start}, ${end}] is invalid for a ${total}-frame composition (valid: 0..${total - 1})`,
    );
  }
  return [start, end];
}

/** Upper bound on a single batch preview request (one page load, N screenshots). */
export const MAX_PREVIEW_FRAMES = 24;

/** Below this many frames a render is short enough that pre-flight is pure overhead. */
export const MIN_FRAMES_FOR_PREFLIGHT = 30;

/**
 * Browser relaunches a single render will attempt when Chromium crashes
 * mid-capture (v0.14). Three is deliberate: the observed crash is a one-off
 * flake, so one relaunch almost always heals it — a render that eats the whole
 * budget is telling you something else is wrong (OOM, GPU driver), and should
 * fail loudly rather than crash-loop.
 */
export const CRASH_RELAUNCH_LIMIT = 3;

function assertFrameInRange(frame, config) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= config.durationInFrames) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `frame ${frame} out of range (composition has frames 0..${config.durationInFrames - 1})`,
    );
  }
}

/**
 * Evenly-spaced probe frames across an inclusive range, always including both
 * endpoints. Endpoints matter: "works at frame 0" is exactly the false positive
 * that lets a bad range or a late Sequence slip through to a full render.
 */
export function preflightFrameList(startFrame, endFrame, count = 5) {
  const total = endFrame - startFrame + 1;
  const n = Math.max(2, Math.min(count, total));
  const frames = new Set();
  for (let i = 0; i < n; i++) {
    frames.add(startFrame + Math.round(((total - 1) * i) / (n - 1)));
  }
  return [...frames].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Proxy/motion preview (v0.21)                                        */
/* ------------------------------------------------------------------ */

/** Factory defaults for a bare `proxy: {}` request: half size, every 2nd
 *  frame — roughly 1/8 the capture work of a full render. */
export const PROXY_DEFAULTS = Object.freeze({ scale: 0.5, frameStep: 2 });

/**
 * Validate a proxy request and fill defaults. The floor of 0.1 keeps the
 * scaled viewport from collapsing below anything a human could judge motion
 * on; there is no ceiling on frameStep because "one frame per second" is a
 * legitimate blocking check for slow moves.
 */
export function normalizeProxy(proxy) {
  const scale = proxy.scale ?? PROXY_DEFAULTS.scale;
  const frameStep = proxy.frameStep ?? PROXY_DEFAULTS.frameStep;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 1) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `proxy.scale must be a number between 0.1 and 1 (got ${JSON.stringify(proxy.scale)})`,
    );
  }
  if (!Number.isInteger(frameStep) || frameStep < 1) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `proxy.frameStep must be an integer >= 1 (got ${JSON.stringify(proxy.frameStep)})`,
    );
  }
  return { scale, frameStep };
}

/**
 * The scaled capture size for a proxy: floored to EVEN numbers because the
 * mp4/webm/prores encoders reject odd dimensions (chroma subsampling), and a
 * proxy must work with whatever format the scene is configured for.
 * Clamped to 2 so a tiny composition at scale 0.1 cannot round to zero.
 */
export function proxyDimensions(width, height, scale) {
  const even = (n) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * The frames a frame-step render captures: start, start+step, start+2·step, …
 * within the inclusive range. Deliberately does NOT force the final frame in:
 * keeping the arithmetic exactly "every Nth frame" is what lets the encode
 * rate fps/frameStep reproduce wall-clock timing without a hiccup at the end.
 */
export function steppedFrameList(startFrame, endFrame, step = 1) {
  const frames = [];
  for (let frame = startFrame; frame <= endFrame; frame += step) frames.push(frame);
  return frames;
}

/**
 * Insert ".proxy" before the extension (output.mp4 → output.proxy.mp4), or
 * append it when there is none (a png-sequence output is a directory).
 * Idempotent, because both the MCP server (to report the path up front) and
 * renderComposition (as the single enforcement point) apply it.
 */
export function proxyOutputPath(outputPath) {
  const ext = path.extname(outputPath);
  const base = outputPath.slice(0, outputPath.length - ext.length);
  return base.endsWith('.proxy') ? outputPath : base + '.proxy' + ext;
}

/**
 * Drive an already-open page over the probe frames, discarding the pixels.
 * Errors keep their original code (composition_error / frame_timeout) so the
 * agent sees the real fix, with phase:'preflight' added for context.
 */
async function runPreflight(page, frames, signal, progress) {
  progress.phase('preflight');
  for (const frame of frames) {
    throwIfAborted(signal);
    try {
      await page.captureFrame(frame);
    } catch (err) {
      const e = asEngineError(err);
      e.detail = { ...(e.detail ?? {}), phase: 'preflight', probedFrames: frames };
      e.message = `Pre-flight failed at frame ${frame} (probed ${frames.join(', ')}): ${e.message}`;
      throw e;
    }
  }
  progress.log('info', `Pre-flight passed: frames ${frames.join(', ')}`);
}

/**
 * Measure the muxed result and report it (v0.10). amix runs with normalize=0,
 * so track gains sum straight through — without this the only symptom of a
 * clipped mix is that it sounds bad, which an agent cannot hear. Never fatal:
 * a measurement failure must not fail an otherwise good render.
 */
async function reportAudioLevels({ outputPath, config, output, ffmpegPath, assetRoot, progress, onChildPid, signal }) {
  const levels = await measureAudioLevels({
    filePath: outputPath, ffmpegPath, onSpawn: onChildPid, signal,
  }).catch(() => null);
  const limiter = output.audioLimiter !== false;
  // Balance check (v0.22): a buried track passes every automated check — the
  // mix only gets QUIETER — so measure each source clip and flag any track
  // sitting far under a louder overlapping one. Never fatal, like the rest of
  // this function: a measurement failure just skips that track.
  const balanceWarnings = assetRoot
    ? await measureTrackBalance({ config, assetRoot, ffmpegPath, onChildPid, signal }).catch(() => [])
    : [];
  for (const w of balanceWarnings) progress.log('warn', w);
  if (!levels) {
    progress.log('warn', 'Could not measure output audio levels.');
    return { tracks: config.audio.length, limiter, balanceWarnings };
  }
  const clipping = levels.peakDb !== null && levels.peakDb >= -0.1;
  if (clipping) {
    progress.log(
      'warn',
      `Mixed audio peaks at ${levels.peakDb} dBFS — the mix is clipping. ` +
        (limiter
          ? 'The limiter is enabled, so this is likely a very hot single track; lower its gainDb.'
          : 'Lower the track gainDb values, or set output.audioLimiter to true.'),
    );
  }
  return { tracks: config.audio.length, limiter, ...levels, clipping, balanceWarnings };
}

/** Measure each config.audio clip's own level/duration and run the shared
 *  balance check. WAVs are read directly (fast header+PCM pass); anything else
 *  decodes through ffmpeg. Unmeasurable clips are skipped, never fatal. */
async function measureTrackBalance({ config, assetRoot, ffmpegPath, onChildPid, signal }) {
  if (!config.audio || config.audio.length < 2) return [];
  const measured = [];
  for (const t of config.audio) {
    const abs = path.resolve(assetRoot, t.src);
    let clipMeanDb = null;
    let clipDurationSec = null;
    if (/\.wav$/i.test(t.src)) {
      clipMeanDb = (await measureWavLevels(abs).catch(() => ({ meanDb: null }))).meanDb;
      clipDurationSec = await wavDurationSeconds(abs).catch(() => null);
    } else {
      clipMeanDb = ((await measureAudioLevels({ filePath: abs, ffmpegPath, onSpawn: onChildPid, signal })) ?? {}).meanDb ?? null;
    }
    measured.push({ ...t, clipMeanDb, clipDurationSec });
  }
  return computeBalanceWarnings(measured, {
    fps: config.fps,
    videoDurationSec: config.durationInFrames / config.fps,
  });
}

/**
 * Is this render the scene's canonical output — the whole scene, at its
 * current settings, in its real destination (v0.21)?
 *
 * Only such a render may stamp the sidecar that build_film trusts. A proxy
 * writes to <name>.proxy.<ext>, a worker segment writes a slice, and a
 * partial frameRange deliberately leaves the rest of the file stale.
 */
function isFullSceneRender({ prx, skipAudio, asIntermediate, startFrame, endFrame, config }) {
  if (prx || skipAudio || asIntermediate) return false;
  return startFrame === 0 && endFrame === config.durationInFrames - 1;
}

/**
 * A top-level file output is a delivery even when it is a proxy, a custom
 * filename, or a deliberately partial range.  Internal parallel-worker
 * segments are not: their caller owns their temporary directory and does the
 * eventual promotion.  PNG sequences are directories, so their safe directory
 * replacement is intentionally a separate concern from file promotion.
 */
function isStagedFileDelivery({ isPngSequence, skipAudio, asIntermediate }) {
  return !isPngSequence && !skipAudio && !asIntermediate;
}

/** Is this the canonical scene delivery, rather than a proxy, segment, or export? */
function isCanonicalSceneDelivery({ scenePath, config, outputPath, prx, skipAudio, asIntermediate, startFrame, endFrame, isPngSequence }) {
  return isStagedFileDelivery({ isPngSequence, skipAudio, asIntermediate })
    && isFullSceneRender({ prx, skipAudio, asIntermediate, startFrame, endFrame, config })
    && path.resolve(outputPath) === path.resolve(sceneOutputPath(scenePath, config));
}

/** Keep a failed staging file discoverable through the job's structured error. */
function withStagingDetail(err, stagingPath, signal) {
  const e = asEngineError(err, signal?.aborted ? ErrorCodes.CANCELLED : ErrorCodes.INTERNAL);
  if (!stagingPath) return e;
  e.detail = { ...(e.detail ?? {}), stagingPath };
  return e;
}

/**
 * Archive the just-promoted canonical delivery as an immutable revision
 * (v0.23). Best-effort by the same rule as the render sidecar: a render that
 * already succeeded must not be failed by history-keeping. Returns the
 * revision id, or null when archiving was not possible.
 */
async function archiveCanonicalRevision({
  scenePath, config, frames, outputPath, renderMeta, revision, jobId, progress,
}) {
  try {
    const archived = await archiveRevision({
      scenePath, config, frames, outputPath, renderMeta,
      jobId: jobId ?? null,
      ...(revision?.agent !== undefined ? { agent: revision.agent } : {}),
      ...(revision?.note ? { note: revision.note } : {}),
      ...(revision?.adviceIds?.length ? { adviceIds: revision.adviceIds } : {}),
      ...(revision?.parentRevisionId ? { parentRevisionId: revision.parentRevisionId } : {}),
    });
    return archived.id;
  } catch (err) {
    progress.log('warn', `revision archive failed (delivery is unaffected): ${err?.message ?? err}`);
    return null;
  }
}

/** Promote the review pair after the movie; JSON lands last as the ready marker. */
async function promoteReviewArtifacts(review, progress) {
  if (!review) return null;
  try {
    await promoteStagingOutput({ stagedPath: review.stagedPaths.contactPath, outputPath: review.paths.contactPath });
    await promoteStagingOutput({ stagedPath: review.stagedPaths.reviewPath, outputPath: review.paths.reviewPath });
    return null;
  } catch (err) {
    const message = err?.message ?? 'Review artefacts could not be promoted';
    progress.log('warn', message);
    return message;
  }
}

function reviewResult(review) {
  if (!review) return null;
  return {
    reviewPath: review.paths.reviewPath,
    contactPath: review.paths.contactPath,
    warnings: review.report.warnings,
  };
}

/**
 * Verify the encoded file actually contains the frames we captured (v0.11).
 *
 * A worker killed mid-encode leaves a short but perfectly valid video behind,
 * and nothing downstream notices: build_film happily concatenates it and the
 * finished film simply has a scene that stops early. Checking the count here is
 * what makes "the render succeeded" mean something, and what lets a resumable
 * driver trust an existing output instead of re-rendering it.
 *
 * Unverifiable (no ffprobe) is not a failure — it is reported as such.
 */
export async function verifyFrameCount({
  outputPath, expected, progress = new ProgressEmitter(null), onChildPid, signal,
  // Delivery review owns the decision for staged outputs.  Internal segments
  // retain the historical fail-fast behaviour because no policy-bearing
  // delivery is being created for them.
  throwOnMismatch = true,
}) {
  const actual = await probeFrameCount({ filePath: outputPath, onSpawn: onChildPid, signal }).catch(() => null);
  if (actual === null) {
    progress.log('warn', 'Could not verify the output frame count (ffprobe unavailable?).');
    return { frames: expected, verified: false };
  }
  if (actual !== expected) {
    const error = new EngineError(
      ErrorCodes.SHORT_RENDER,
      `output has ${actual} frames but ${expected} were rendered — the encode did not complete. ` +
        'Re-render this scene; do not assemble this file into a film.',
      { outputPath, expected, actual },
    );
    if (throwOnMismatch) throw error;
    progress.log('warn', error.message);
    return { frames: actual, verified: true, matches: false };
  }
  // Preserve the public result shape for existing callers.  A staged delivery
  // needs the explicit comparison so review can classify it; ordinary renders
  // already throw on a mismatch and historically returned only these fields.
  return throwOnMismatch
    ? { frames: actual, verified: true }
    : { frames: actual, verified: true, matches: true };
}

function outputSettings(config) {
  const output = config.output ?? {};
  const format = output.format ?? 'mp4';
  const fmt = getFormat(format);
  const transparent = !!output.transparent && fmt.supportsAlpha;
  return { output: { ...output, format, transparent }, fmt, transparent };
}

/**
 * Serial render of a frame range.
 *
 * @param {object} opts
 * @param {string} opts.scenePath     absolute path to the scene folder
 * @param {object} opts.config          validated scene config
 * @param {string} opts.outputPath      absolute output path (file, or directory for png-sequence)
 * @param {[number,number]} [opts.frameRange]  inclusive, defaults to full duration
 * @param {string} [opts.framesDir]     if set: write PNG sequence, encode second-pass
 * @param {boolean} [opts.skipAudio]    used for parallel segments (audio muxed once at the end)
 * @param {boolean} [opts.asIntermediate]  encode to the lossless intermediate codec (parallel workers)
 * @param {{scale?: number, frameStep?: number}} [opts.proxy]  proxy/motion
 *   preview (v0.21): capture at width×scale (floored to even), every
 *   frameStep-th frame, encoded at fps/frameStep, written to <name>.proxy.<ext>.
 *   Implies no pre-flight and no audio mux; see the module header.
 * @param {boolean} [opts.lock=true]    take the scene's cross-process render lock.
 *   Parallel *workers* must pass false: they render the same scene by design,
 *   and their parent already holds the lock on their behalf.
 * @param {AbortSignal} [opts.signal]
 * @param {ProgressEmitter} [opts.progress]
 * @param {Function} [opts.browserFactory]  DI for tests; defaults to Puppeteer
 * @param {(pid:number)=>void} [opts.onChildPid]
 */
export async function renderComposition(opts) {
  const {
    scenePath, config, outputPath,
    frameRange, framesDir, skipAudio = false, asIntermediate = false,
    proxy = null,
    signal, progress = new ProgressEmitter(null),
    browserFactory = createPuppeteerBrowser,
    ffmpegPath = 'ffmpeg',
    onChildPid = () => {},
    jobId = null,
    preflight = true,
    preflightCount = 5,
    lock = true,
    reviewPolicy = null,
    revision = null,
  } = opts;

  let startFrame, endFrame, settings, prx;
  try {
    [startFrame, endFrame] = resolveRange(config, frameRange);
    settings = outputSettings(config);
    prx = proxy ? normalizeProxy(proxy) : null;
  } catch (err) {
    const e = asEngineError(err);
    progress.error(e);
    throw e;
  }
  const { output, transparent } = settings;
  const isPngSequence = output.format === 'png-sequence' && !asIntermediate;
  const encodeOutput = asIntermediate ? { ...output, intermediate: true } : output;

  // Proxy geometry and rate. capture is the viewport (= screenshot) size;
  // contentScale is the exact per-axis factor that maps the fixed-pixel
  // composition onto it — derived from the EVEN-floored dims, not the
  // requested scale, so the content fills the viewport with no letterbox
  // strip from the rounding. Frames are `every frameStep-th`, encoded at the
  // rational rate fps/frameStep (FFmpeg accepts "30/2"), which preserves
  // wall-clock duration exactly. The output name gets ".proxy" here — the
  // renderer is the single enforcement point for "a proxy never overwrites
  // the deliverable", whatever path the caller handed in.
  const capture = prx
    ? proxyDimensions(config.width, config.height, prx.scale)
    : { width: config.width, height: config.height };
  const contentScale = prx
    ? { x: capture.width / config.width, y: capture.height / config.height }
    : null;
  const encodeFps = prx && prx.frameStep > 1 ? `${config.fps}/${prx.frameStep}` : config.fps;
  const deliveryPath = prx ? proxyOutputPath(outputPath) : path.resolve(outputPath);
  const stagedDelivery = isStagedFileDelivery({ isPngSequence, skipAudio, asIntermediate });
  const canonicalDelivery = isCanonicalSceneDelivery({
    scenePath, config, outputPath: deliveryPath, prx, skipAudio, asIntermediate,
    startFrame, endFrame, isPngSequence,
  });
  // Assigned only after the render lock is held. Until promotion, every encoder
  // and muxer sees this path rather than the existing delivery.
  let stagingPath = null;
  let outPath = deliveryPath;

  const frameList = steppedFrameList(startFrame, endFrame, prx ? prx.frameStep : 1);
  const totalFrames = frameList.length;
  const reviewFps = prx && prx.frameStep > 1 ? config.fps / prx.frameStep : config.fps;
  const effectiveReviewPolicy = resolveReviewPolicy({ globalPolicy: reviewPolicy });
  const startedAt = Date.now();
  const entryUrl = pathToFileURL(path.resolve(scenePath, config.entry)).href;

  progress.start({ jobId, totalFrames, fps: config.fps, width: capture.width, height: capture.height });
  // Advisory, never fatal: the render proceeds, but the caller learns NOW that
  // the file may not play (crf 0 → Hi444PP), not after shipping black video.
  const encodingWarnings = skipAudio ? [] : encodingCompatibilityWarnings(output);
  for (const w of encodingWarnings) progress.log('warn', w);
  await fsp.mkdir(isPngSequence ? deliveryPath : path.dirname(deliveryPath), { recursive: true });
  // Same rule as the lock below: a destination we will never be able to replace
  // should cost nothing to discover. Without this the sharing violation only
  // surfaces at promotion, i.e. after every frame has been captured.
  if (stagedDelivery) await assertDeliveryWritable({ outputPath: deliveryPath });

  // Before Chromium: a lock failure should cost nothing.
  let held = null;
  try {
    if (lock) held = await acquireRenderLock(scenePath, { label: 'render' });
  } catch (err) {
    const e = asEngineError(err);
    progress.error(e);
    throw e;
  }

  let browser;
  try {
    browser = await browserFactory({});
  } catch (err) {
    await held?.release();
    throw err;
  }
  if (browser.pid) onChildPid(browser.pid);
  let sink = null;

  try {
    if (stagedDelivery) {
      stagingPath = await prepareStagingOutput(deliveryPath, { jobId });
      outPath = stagingPath;
    }
    throwIfAborted(signal);
    const openPage = () =>
      browser.openPage({
        url: entryUrl, width: capture.width, height: capture.height, transparent,
        ...(contentScale ? { contentScale } : {}),
      });
    let page = await openPage();

    // Free here: the page is already warm, so probing costs a few frame renders
    // instead of the tail of a doomed render. A proxy skips it: the proxy IS
    // the pre-flight — its whole run costs about what a probe pass would.
    if (!prx && preflight && totalFrames >= MIN_FRAMES_FOR_PREFLIGHT) {
      await runPreflight(page, preflightFrameList(startFrame, endFrame, preflightCount), signal, progress);
    }

    // Chromium dies intermittently mid-capture ("Target closed") on long runs —
    // a transient flake, not a bad scene (docs/knowledge-base.md). Every frame
    // already written to the sink is good, so instead of failing the job and
    // re-rendering from zero, relaunch the browser and retry the SAME frame.
    // The budget is per render, not per frame: a machine that keeps crashing
    // should fail, not loop.
    let crashRelaunches = 0;
    const captureWithRecovery = async (frame) => {
      for (;;) {
        try {
          return await page.captureFrame(frame);
        } catch (err) {
          // Aborted renders keep their cancellation semantics even mid-crash.
          if (!isBrowserCrash(err) || signal?.aborted) throw err;
          if (crashRelaunches >= CRASH_RELAUNCH_LIMIT) {
            // Re-code here: a raw Puppeteer rejection matched by message would
            // otherwise leave the renderer as internal_error and lose the
            // "this was a crash, after N relaunches" story.
            throw new EngineError(
              ErrorCodes.BROWSER_CRASHED,
              `${err.message} (relaunch budget of ${CRASH_RELAUNCH_LIMIT} spent — this machine keeps crashing, not flaking)`,
              { frame, relaunches: crashRelaunches },
            );
          }
          crashRelaunches++;
          progress.log(
            'warn',
            `Chromium crashed at frame ${frame}; relaunching (${crashRelaunches}/${CRASH_RELAUNCH_LIMIT}): ${err.message}`,
          );
          await browser.close().catch(() => {});
          await new Promise((r) => setTimeout(r, 500 * crashRelaunches));
          throwIfAborted(signal);
          browser = await browserFactory({});
          if (browser.pid) onChildPid(browser.pid);
          page = await openPage();
        }
      }
    };

    progress.phase('capturing');
    const sequenceDir = isPngSequence ? outPath : framesDir;
    if (sequenceDir) {
      await fsp.mkdir(sequenceDir, { recursive: true });
    } else {
      sink = new FfmpegFrameSink({ outputPath: outPath, fps: encodeFps, output: encodeOutput, ffmpegPath, onSpawn: onChildPid });
    }

    let framesDone = 0;
    for (const frame of frameList) {
      throwIfAborted(signal);
      const png = await captureWithRecovery(frame);
      if (sequenceDir) {
        // zero-padded, list-relative index (== range-relative for a full
        // render; contiguous even under a proxy's frameStep) so a sequence
        // encode is contiguous
        const name = `frame-${String(framesDone).padStart(6, '0')}.png`;
        try {
          await fsp.writeFile(path.join(sequenceDir, name), png);
        } catch (e) {
          throw new EngineError(ErrorCodes.DISK_ERROR, `Failed writing frame PNG (disk full?): ${e.message}`);
        }
      } else {
        await sink.writeFrame(png);
      }
      framesDone++;
      progress.progress({ frame, totalFrames, framesDone, elapsedMs: Date.now() - startedAt });
    }

    await page.close();

    if (!isPngSequence) {
      progress.phase('encoding');
      if (framesDir) {
        await encodePngSequence({ framesDir, outputPath: outPath, fps: encodeFps, output: encodeOutput, ffmpegPath, onSpawn: onChildPid });
      } else {
        await sink.finish();
        sink = null;
      }
    }

    // A proxy skips the mux entirely: it exists to check MOTION, and on a
    // typical scene the audio pass (decode, filter graph, re-mux) would
    // dominate the very time the proxy just saved.
    let audio;
    if (!skipAudio && !prx && !isPngSequence && config.audio?.length) {
      const fmt = getFormat(output.format);
      if (!fmt.audioArgs) {
        progress.log('warn', `Format "${output.format}" cannot carry audio; audio tracks skipped.`);
      } else {
        throwIfAborted(signal);
        progress.phase('audio');
        const ext = path.extname(outPath);
        const silent = outPath.slice(0, -ext.length) + '.video-only' + ext;
        await fsp.rename(outPath, silent);
        try {
          await muxAudio({
            videoPath: silent,
            audioTracks: config.audio,
            outputPath: outPath,
            fps: config.fps,
            assetRoot: scenePath,
            output,
            ffmpegPath,
            onSpawn: onChildPid,
            videoDurationSec: totalFrames / config.fps,
          });
        } finally {
          await fsp.unlink(silent).catch(() => {});
        }
        audio = await reportAudioLevels({ outputPath: outPath, config, output, ffmpegPath, assetRoot: scenePath, progress, onChildPid, signal });
      }
    }

    // A segment is one chunk of a bigger render; only the whole file is
    // checked. A proxy IS the whole file, so it is verified like any render —
    // expected is the stepped count, which is what the sink was fed.
    const verified = isPngSequence || skipAudio
      ? { frames: totalFrames, verified: false }
      : await verifyFrameCount({
        outputPath: outPath,
        expected: totalFrames,
        progress,
        onChildPid,
        signal,
        throwOnMismatch: !stagedDelivery,
      });

    let staticFrames = null;
    let pictureReport = null;
    let pictureError = null;
    if (stagedDelivery) {
      try {
        const picture = await measureRenderedPicture({
          filePath: outPath, fps: reviewFps, totalFrames,
          sceneLayout: [{ sceneId: config.name, name: config.name, filmOffset: 0, durationInFrames: totalFrames }],
          ffmpegPath, signal, onSpawn: onChildPid,
        });
        pictureReport = picture;
        if (canonicalDelivery) staticFrames = picture.summary.staticFrames;
      } catch (err) {
        if (signal?.aborted) throw err;
        pictureError = err?.message ?? String(err);
        progress.log('warn', `Picture measurement unavailable: ${pictureError}`);
      }
    }

    let review = null;
    if (stagedDelivery) {
      progress.phase('creating-review');
      review = await createDeliveryReview({
        stagedOutputPath: outPath,
        deliveryPath,
        fps: reviewFps,
        totalFrames,
        sceneLayout: [{ sceneId: config.name, name: config.name, filmOffset: 0, durationInFrames: totalFrames }],
        captions: [],
        audio: audio ?? null,
        picture: pictureReport,
        pictureError,
        frameCheck: {
          expected: totalFrames,
          actual: verified.verified ? verified.frames : null,
          verified: verified.verified,
        },
        policy: effectiveReviewPolicy,
        ffmpegPath,
        signal,
        onSpawn: onChildPid,
      });
      assertReviewAllowsPromotion(review, { stagingPath: outPath });
    }

    // A top-level file render is only visible at its delivery path after the
    // output has completed and been frame-checked. The canonical sidecar follows
    // its video so an interruption can never make metadata vouch for a delivery
    // that was not promoted.
    let promoted = false;
    let reviewArtifactWarning = null;
    let revisionId = null;
    if (stagedDelivery) {
      throwIfAborted(signal);
      progress.phase('promoting');
      await promoteStagingOutput({ stagedPath: outPath, outputPath: deliveryPath });
      reviewArtifactWarning = await promoteReviewArtifacts(review, progress);
      if (canonicalDelivery) {
        const renderMeta = await writeRenderMeta({ scenePath, config, frames: totalFrames, outputPath: deliveryPath });
        revisionId = await archiveCanonicalRevision({
          scenePath, config, frames: totalFrames, outputPath: deliveryPath, renderMeta, revision, jobId, progress,
        });
      }
      promoted = true;
    }

    const deliveredOutputPath = stagedDelivery ? deliveryPath : outPath;

    const elapsedMs = Date.now() - startedAt;
    progress.done({
      outputPath: deliveredOutputPath, frames: totalFrames, elapsedMs, audio,
      ...(staticFrames !== null ? { staticFrames } : {}),
      ...(review ? { review: reviewResult(review) } : {}),
      ...(revisionId ? { revisionId } : {}),
    });
    return {
      outputPath: deliveredOutputPath, frames: totalFrames, elapsedMs,
      framesVerified: verified.verified,
      ...(stagedDelivery ? { promoted } : {}),
      ...(revisionId ? { revisionId } : {}),
      ...(audio ? { audio } : {}),
      ...(staticFrames !== null ? { staticFrames } : {}),
      ...(review ? { review: reviewResult(review) } : {}),
      ...(reviewArtifactWarning ? { reviewArtifactWarning } : {}),
      ...(prx ? { proxy: prx } : {}),
      ...(encodingWarnings.length ? { encodingWarnings } : {}),
    };
  } catch (err) {
    const engineErr = withStagingDetail(err, stagingPath, signal);
    progress.error(engineErr);
    throw engineErr;
  } finally {
    if (sink) sink.kill();
    await browser.close();
    await held?.release();
  }
}

/**
 * Capture several frames through the *real* render path from a SINGLE page load
 * (v0.10). Returns [{ frame, png }] in the order requested.
 *
 * This exists because per-frame previews are dominated by fixed costs, not by
 * the frame itself: every call to captureSingleFrame used to launch Chromium,
 * load the page, and re-run all of the composition's one-time setup (canvas
 * textures, geometry merging) to produce one screenshot. Checking five frames
 * paid that five times. The capture loop itself has always supported many
 * frames per page — this just exposes it to the preview path.
 */
export async function captureFrames({
  scenePath, config, frames,
  browserFactory = createPuppeteerBrowser, onChildPid = () => {}, signal,
}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'frames: a non-empty array of frame numbers is required');
  }
  if (frames.length > MAX_PREVIEW_FRAMES) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `frames: at most ${MAX_PREVIEW_FRAMES} frames per request (got ${frames.length})`,
      { max: MAX_PREVIEW_FRAMES, requested: frames.length },
    );
  }
  for (const frame of frames) assertFrameInRange(frame, config);

  const transparent = !!config.output?.transparent;
  const browser = await browserFactory({});
  if (browser.pid) onChildPid(browser.pid);
  try {
    throwIfAborted(signal);
    const page = await browser.openPage({
      url: pathToFileURL(path.resolve(scenePath, config.entry)).href,
      width: config.width,
      height: config.height,
      transparent,
    });
    const out = [];
    for (const frame of frames) {
      throwIfAborted(signal);
      out.push({ frame, png: await page.captureFrame(frame) });
    }
    await page.close();
    return out;
  } catch (err) {
    throw asEngineError(err);
  } finally {
    await browser.close();
  }
}

/**
 * Capture a single frame through the *real* render path (Puppeteer). Returns
 * PNG bytes. Respects config.output.transparent for alpha-capable use.
 */
export async function captureSingleFrame({
  scenePath, config, frame,
  browserFactory = createPuppeteerBrowser, onChildPid = () => {}, signal,
}) {
  assertFrameInRange(frame, config);
  const [only] = await captureFrames({
    scenePath, config, frames: [frame], browserFactory, onChildPid, signal,
  });
  return only.png;
}

/** Render one frame to a PNG file on disk (the "still export" path). */
export async function renderStill({ scenePath, config, frame, outputPath, browserFactory, onChildPid, signal }) {
  const png = await captureSingleFrame({
    scenePath, config, frame, signal,
    ...(browserFactory ? { browserFactory } : {}),
    ...(onChildPid ? { onChildPid } : {}),
  });
  await fsp.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fsp.writeFile(outputPath, png);
  return { outputPath: path.resolve(outputPath), bytes: png.length, frame };
}

/**
 * Parallel render: split the frame range into contiguous chunks, render each
 * in its own worker process (`node render.js --frame-range a b --segment`),
 * merge the segments, and run the audio pass once.
 *
 * Merge strategy (v0.5):
 *   - copy-concat formats (mp4/webm/prores), opaque: workers encode the
 *     target codec directly; segments are concatenated with `-c copy`.
 *   - everything else (gif, or any transparent render): workers encode a
 *     lossless FFV1 intermediate; intermediates are copy-concatenated and a
 *     single final encode pass produces the target file. Bit-exact with the
 *     serial path because FFV1 is lossless.
 *   - png-sequence: workers write frames straight into the output folder
 *     with globally consistent zero-padded numbering; no merge needed.
 *
 * Worker count defaults to min(cpu cores, 4): beyond ~4 Chromium instances,
 * memory pressure usually erases the speedup on typical desktops.
 */
export async function renderParallel(opts) {
  const {
    scenePath, config, outputPath,
    frameRange, workers = Math.max(1, Math.min(os.cpus().length, 4)),
    proxy = null,
    signal, progress = new ProgressEmitter(null),
    browserFactory = createPuppeteerBrowser,
    ffmpegPath = 'ffmpeg',
    onChildPid = () => {},
    jobId = null,
    nodeExecutable = process.execPath,
    preflight = true,
    preflightCount = 5,
    lock = true,
    reviewPolicy = null,
    revision = null,
  } = opts;

  let startFrame, endFrame, settings;
  try {
    [startFrame, endFrame] = resolveRange(config, frameRange);
    settings = outputSettings(config);
  } catch (err) {
    const e = asEngineError(err);
    progress.error(e);
    throw e;
  }
  const { output, fmt, transparent } = settings;
  const totalFrames = endFrame - startFrame + 1;
  const effectiveReviewPolicy = resolveReviewPolicy({ globalPolicy: reviewPolicy });
  const workerCount = Math.max(1, Math.min(workers, totalFrames));

  // Delegating, not locking: renderComposition takes the lock itself, so taking
  // it here first would deadlock against our own delegate. Proxies are SERIAL
  // BY DESIGN, whatever `workers` says: a proxy is already ~1/8 the work, so
  // fanning out N Chromium processes to save seconds would cost more in
  // launches than it saves in capture — the workers value is simply ignored.
  if (workerCount === 1 || proxy) {
    return renderComposition({ ...opts, frameRange: [startFrame, endFrame] });
  }

  const isPngSequence = output.format === 'png-sequence';
  const useIntermediate = !isPngSequence && (!fmt.copyConcat || transparent);
  const deliveryPath = path.resolve(outputPath);
  const stagedDelivery = isStagedFileDelivery({ isPngSequence, skipAudio: false, asIntermediate: false });
  const canonicalDelivery = isCanonicalSceneDelivery({
    scenePath, config, outputPath: deliveryPath, prx: null, skipAudio: false,
    asIntermediate: false, startFrame, endFrame, isPngSequence,
  });
  let stagingPath = null;
  let workOutputPath = deliveryPath;

  // Cheapest possible failure, before the lock and long before N browsers: a
  // destination held open by a reader can never be promoted, and finding that
  // out at the end costs the entire fan-out.
  if (stagedDelivery) await assertDeliveryWritable({ outputPath: deliveryPath });

  // Held for the whole fan-out. Workers run with --segment (lock:false): they
  // write this same scene deliberately, and this lock covers them.
  let held = null;
  try {
    if (lock) held = await acquireRenderLock(scenePath, { label: `render x${workerCount}` });
  } catch (err) {
    const e = asEngineError(err);
    progress.error(e);
    throw e;
  }

  const startedAt = Date.now();
  progress.start({ jobId, totalFrames, fps: config.fps, width: config.width, height: config.height });

  // Warn once from the parent — workers run with --segment (skipAudio) and
  // stay quiet, and the concat inherits the segments' profile anyway.
  const encodingWarnings = encodingCompatibilityWarnings(output);
  for (const w of encodingWarnings) progress.log('warn', w);

  // One browser launch here buys the chance to fail before spawning N of them.
  if (preflight && totalFrames >= MIN_FRAMES_FOR_PREFLIGHT) {
    const probeBrowser = await browserFactory({});
    if (probeBrowser.pid) onChildPid(probeBrowser.pid);
    try {
      const probePage = await probeBrowser.openPage({
        url: pathToFileURL(path.resolve(scenePath, config.entry)).href,
        width: config.width,
        height: config.height,
        transparent,
      });
      await runPreflight(probePage, preflightFrameList(startFrame, endFrame, preflightCount), signal, progress);
      await probePage.close();
    } catch (err) {
      const e = asEngineError(err, signal?.aborted ? ErrorCodes.CANCELLED : ErrorCodes.INTERNAL);
      progress.error(e);
      await held?.release();
      throw e;
    } finally {
      await probeBrowser.close();
    }
  }

  progress.phase('capturing');

  // Contiguous chunks, remainder spread across the first chunks.
  const base = Math.floor(totalFrames / workerCount);
  const extra = totalFrames % workerCount;
  const chunks = [];
  let cursor = startFrame;
  for (let i = 0; i < workerCount; i++) {
    const size = base + (i < extra ? 1 : 0);
    chunks.push([cursor, cursor + size - 1]);
    cursor += size;
  }

  const segDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-segments-'));
  const segExt = useIntermediate ? INTERMEDIATE.ext : fmt.ext;
  const segmentPaths = chunks.map((_, i) =>
    isPngSequence
      ? path.join(segDir, `seq-${String(i).padStart(3, '0')}`)
      : path.join(segDir, `segment-${String(i).padStart(3, '0')}${segExt}`),
  );
  const cliPath = path.resolve(__dirname, '../cli/render.js');
  const perWorkerDone = new Array(workerCount).fill(0);
  const children = [];

  const runWorker = (i) =>
    new Promise((resolve, reject) => {
      const [a, b] = chunks[i];
      const workerArgs = [
        cliPath,
        '--scene', scenePath,
        '--output', segmentPaths[i],
        '--frame-range', String(a), String(b),
        '--segment', // suppress audio pass in workers
      ];
      if (useIntermediate) workerArgs.push('--intermediate');
      // Workers encode their own segments, so the parent's binary must reach
      // them too — the parent using one and the workers another would be a
      // silent config split. Passed ALWAYS, including the literal "ffmpeg":
      // the worker CLI would otherwise resolve its own default from the
      // environment/settings and could land somewhere else entirely.
      workerArgs.push('--ffmpeg', ffmpegPath);
      const child = spawn(nodeExecutable, workerArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      children.push(child);
      onChildPid(child.pid);

      const stderrTail = [];
      child.stderr.on('data', (d) => {
        stderrTail.push(d.toString());
        if (stderrTail.length > 50) stderrTail.shift();
      });

      let workerError = null;
      const parser = new ProgressStreamParser((msg) => {
        if (msg.type === 'progress') {
          perWorkerDone[i] = msg.framesDone;
          const framesDone = perWorkerDone.reduce((s, n) => s + n, 0);
          progress.progress({ frame: msg.frame, totalFrames, framesDone, elapsedMs: Date.now() - startedAt });
        } else if (msg.type === 'error') {
          workerError = new EngineError(msg.code || ErrorCodes.INTERNAL, `worker ${i}: ${msg.message}`, msg.detail);
        }
      });
      child.stdout.on('data', (d) => parser.feed(d));

      child.on('error', (e) => reject(new EngineError(ErrorCodes.INTERNAL, `worker ${i} spawn failed: ${e.message}`)));
      child.on('close', (code, sig) => {
        parser.flush();
        if (workerError) return reject(workerError);
        if (code === 0) return resolve();
        if (sig || signal?.aborted) return reject(new EngineError(ErrorCodes.CANCELLED, `worker ${i} terminated`));
        reject(new EngineError(ErrorCodes.INTERNAL, `worker ${i} exited with code ${code}`, { stderrTail: stderrTail.join('') }));
      });
    });

  const killChildren = () => {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* gone */ }
    }
  };
  const onAbort = () => killChildren();
  signal?.addEventListener('abort', onAbort, { once: true });

  let audio;
  try {
    if (stagedDelivery) {
      stagingPath = await prepareStagingOutput(deliveryPath, { jobId });
      workOutputPath = stagingPath;
    }
    await fsp.mkdir(isPngSequence ? workOutputPath : path.dirname(workOutputPath), { recursive: true });
    throwIfAborted(signal);
    await Promise.all(chunks.map((_, i) => runWorker(i)));
    throwIfAborted(signal);

    if (isPngSequence) {
      // Move each worker's frames into the output folder with global numbering.
      progress.phase('concat');
      for (let i = 0; i < chunks.length; i++) {
        const [a] = chunks[i];
        const files = (await fsp.readdir(segmentPaths[i])).sort();
        for (const f of files) {
          const local = Number(/frame-(\d+)\.png/.exec(f)?.[1] ?? NaN);
          if (Number.isNaN(local)) continue;
          const globalIdx = a - startFrame + local;
          await fsp.rename(
            path.join(segmentPaths[i], f),
            path.join(workOutputPath, `frame-${String(globalIdx).padStart(6, '0')}.png`),
          );
        }
      }
    } else {
      progress.phase('concat');
      const wantsAudio = !!config.audio?.length && !!fmt.audioArgs;
      const ext = path.extname(workOutputPath);
      const silentOut = wantsAudio ? workOutputPath.slice(0, -ext.length) + '.video-only' + ext : workOutputPath;

      if (useIntermediate) {
        const merged = path.join(segDir, `merged${INTERMEDIATE.ext}`);
        await concatSegments({ segmentPaths, outputPath: merged, ffmpegPath, onSpawn: onChildPid });
        throwIfAborted(signal);
        progress.phase('encoding');
        await transcode({ inputPath: merged, outputPath: silentOut, output, ffmpegPath, onSpawn: onChildPid });
      } else {
        await concatSegments({ segmentPaths, outputPath: silentOut, ffmpegPath, onSpawn: onChildPid });
      }

      if (wantsAudio) {
        progress.phase('audio');
        try {
          await muxAudio({
            videoPath: silentOut,
            audioTracks: config.audio,
            outputPath: workOutputPath,
            fps: config.fps,
            assetRoot: scenePath,
            output,
            ffmpegPath,
            onSpawn: onChildPid,
            videoDurationSec: totalFrames / config.fps,
          });
        } finally {
          await fsp.unlink(silentOut).catch(() => {});
        }
        audio = await reportAudioLevels({ outputPath: workOutputPath, config, output, ffmpegPath, assetRoot: scenePath, progress, onChildPid, signal });
      } else if (config.audio?.length && !fmt.audioArgs) {
        progress.log('warn', `Format "${output.format}" cannot carry audio; audio tracks skipped.`);
      }
    }

    // The whole point of the parallel path: N workers each encoded a piece, and
    // a piece that silently came up short would otherwise ship inside the merge.
    const verified = isPngSequence
      ? { frames: totalFrames, verified: false }
      : await verifyFrameCount({
        outputPath: workOutputPath,
        expected: totalFrames,
        progress,
        onChildPid,
        signal,
        throwOnMismatch: !stagedDelivery,
      });

    let staticFrames = null;
    let pictureReport = null;
    let pictureError = null;
    if (stagedDelivery) {
      try {
        const picture = await measureRenderedPicture({
          filePath: workOutputPath, fps: config.fps, totalFrames,
          sceneLayout: [{ sceneId: config.name, name: config.name, filmOffset: 0, durationInFrames: totalFrames }],
          ffmpegPath, signal, onSpawn: onChildPid,
        });
        pictureReport = picture;
        if (canonicalDelivery) staticFrames = picture.summary.staticFrames;
      } catch (err) {
        if (signal?.aborted) throw err;
        pictureError = err?.message ?? String(err);
        progress.log('warn', `Picture measurement unavailable: ${pictureError}`);
      }
    }

    let review = null;
    if (stagedDelivery) {
      progress.phase('creating-review');
      review = await createDeliveryReview({
        stagedOutputPath: workOutputPath,
        deliveryPath,
        fps: config.fps,
        totalFrames,
        sceneLayout: [{ sceneId: config.name, name: config.name, filmOffset: 0, durationInFrames: totalFrames }],
        captions: [],
        audio: audio ?? null,
        picture: pictureReport,
        pictureError,
        frameCheck: {
          expected: totalFrames,
          actual: verified.verified ? verified.frames : null,
          verified: verified.verified,
        },
        policy: effectiveReviewPolicy,
        ffmpegPath,
        signal,
        onSpawn: onChildPid,
      });
      assertReviewAllowsPromotion(review, { stagingPath: workOutputPath });
    }

    let promoted = false;
    let reviewArtifactWarning = null;
    let revisionId = null;
    if (stagedDelivery) {
      throwIfAborted(signal);
      progress.phase('promoting');
      await promoteStagingOutput({ stagedPath: workOutputPath, outputPath: deliveryPath });
      reviewArtifactWarning = await promoteReviewArtifacts(review, progress);
      if (canonicalDelivery) {
        const renderMeta = await writeRenderMeta({ scenePath, config, frames: totalFrames, outputPath: deliveryPath });
        revisionId = await archiveCanonicalRevision({
          scenePath, config, frames: totalFrames, outputPath: deliveryPath, renderMeta, revision, jobId, progress,
        });
      }
      promoted = true;
    }
    const deliveredOutputPath = stagedDelivery ? deliveryPath : workOutputPath;

    const elapsedMs = Date.now() - startedAt;
    progress.done({
      outputPath: deliveredOutputPath, frames: totalFrames, elapsedMs, audio,
      ...(staticFrames !== null ? { staticFrames } : {}),
      ...(review ? { review: reviewResult(review) } : {}),
      ...(revisionId ? { revisionId } : {}),
    });
    return {
      outputPath: deliveredOutputPath, frames: totalFrames, elapsedMs,
      framesVerified: verified.verified,
      ...(stagedDelivery ? { promoted } : {}),
      ...(revisionId ? { revisionId } : {}),
      ...(audio ? { audio } : {}),
      ...(staticFrames !== null ? { staticFrames } : {}),
      ...(review ? { review: reviewResult(review) } : {}),
      ...(reviewArtifactWarning ? { reviewArtifactWarning } : {}),
      ...(encodingWarnings.length ? { encodingWarnings } : {}),
    };
  } catch (err) {
    killChildren();
    const engineErr = withStagingDetail(err, stagingPath, signal);
    progress.error(engineErr);
    throw engineErr;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await fsp.rm(segDir, { recursive: true, force: true }).catch(() => {});
    // Best-effort: an unreleased lock self-heals, because the next acquirer
    // clears any lock whose owning pid is no longer alive.
    await held?.release();
  }
}
