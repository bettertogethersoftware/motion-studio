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
import { FfmpegFrameSink, encodePngSequence, concatSegments, muxAudio, transcode, measureAudioLevels, probeFrameCount } from './encoder.js';
import { getFormat, INTERMEDIATE } from './formats.js';
import { acquireRenderLock } from './lock.js';

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
async function reportAudioLevels({ outputPath, config, output, ffmpegPath, progress, onChildPid, signal }) {
  const levels = await measureAudioLevels({
    filePath: outputPath, ffmpegPath, onSpawn: onChildPid, signal,
  }).catch(() => null);
  const limiter = output.audioLimiter !== false;
  if (!levels) {
    progress.log('warn', 'Could not measure output audio levels.');
    return { tracks: config.audio.length, limiter };
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
  return { tracks: config.audio.length, limiter, ...levels, clipping };
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
export async function verifyFrameCount({ outputPath, expected, progress = new ProgressEmitter(null), onChildPid, signal }) {
  const actual = await probeFrameCount({ filePath: outputPath, onSpawn: onChildPid, signal }).catch(() => null);
  if (actual === null) {
    progress.log('warn', 'Could not verify the output frame count (ffprobe unavailable?).');
    return { frames: expected, verified: false };
  }
  if (actual !== expected) {
    throw new EngineError(
      ErrorCodes.SHORT_RENDER,
      `output has ${actual} frames but ${expected} were rendered — the encode did not complete. ` +
        'Re-render this project; do not assemble this file into a film.',
      { outputPath, expected, actual },
    );
  }
  return { frames: actual, verified: true };
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
 * @param {string} opts.projectPath     absolute path to project folder
 * @param {object} opts.config          validated project config
 * @param {string} opts.outputPath      absolute output path (file, or directory for png-sequence)
 * @param {[number,number]} [opts.frameRange]  inclusive, defaults to full duration
 * @param {string} [opts.framesDir]     if set: write PNG sequence, encode second-pass
 * @param {boolean} [opts.skipAudio]    used for parallel segments (audio muxed once at the end)
 * @param {boolean} [opts.asIntermediate]  encode to the lossless intermediate codec (parallel workers)
 * @param {boolean} [opts.lock=true]    take the project's cross-process render lock.
 *   Parallel *workers* must pass false: they render the same project by design,
 *   and their parent already holds the lock on their behalf.
 * @param {AbortSignal} [opts.signal]
 * @param {ProgressEmitter} [opts.progress]
 * @param {Function} [opts.browserFactory]  DI for tests; defaults to Puppeteer
 * @param {(pid:number)=>void} [opts.onChildPid]
 */
export async function renderComposition(opts) {
  const {
    projectPath, config, outputPath,
    frameRange, framesDir, skipAudio = false, asIntermediate = false,
    signal, progress = new ProgressEmitter(null),
    browserFactory = createPuppeteerBrowser,
    ffmpegPath = 'ffmpeg',
    onChildPid = () => {},
    jobId = null,
    preflight = true,
    preflightCount = 5,
    lock = true,
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
  const { output, transparent } = settings;
  const isPngSequence = output.format === 'png-sequence' && !asIntermediate;
  const encodeOutput = asIntermediate ? { ...output, intermediate: true } : output;

  const totalFrames = endFrame - startFrame + 1;
  const startedAt = Date.now();
  const entryUrl = pathToFileURL(path.resolve(projectPath, config.entry)).href;

  progress.start({ jobId, totalFrames, fps: config.fps, width: config.width, height: config.height });
  await fsp.mkdir(isPngSequence ? outputPath : path.dirname(outputPath), { recursive: true });

  // Before Chromium: a lock failure should cost nothing.
  let held = null;
  try {
    if (lock) held = await acquireRenderLock(projectPath, { label: 'render' });
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
    throwIfAborted(signal);
    const openPage = () =>
      browser.openPage({ url: entryUrl, width: config.width, height: config.height, transparent });
    let page = await openPage();

    // Free here: the page is already warm, so probing costs a few frame renders
    // instead of the tail of a doomed render.
    if (preflight && totalFrames >= MIN_FRAMES_FOR_PREFLIGHT) {
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
    const sequenceDir = isPngSequence ? outputPath : framesDir;
    if (sequenceDir) {
      await fsp.mkdir(sequenceDir, { recursive: true });
    } else {
      sink = new FfmpegFrameSink({ outputPath, fps: config.fps, output: encodeOutput, ffmpegPath, onSpawn: onChildPid });
    }

    let framesDone = 0;
    for (let frame = startFrame; frame <= endFrame; frame++) {
      throwIfAborted(signal);
      const png = await captureWithRecovery(frame);
      if (sequenceDir) {
        // zero-padded, range-relative index so a sequence encode is contiguous
        const name = `frame-${String(frame - startFrame).padStart(6, '0')}.png`;
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
        await encodePngSequence({ framesDir, outputPath, fps: config.fps, output: encodeOutput, ffmpegPath, onSpawn: onChildPid });
      } else {
        await sink.finish();
        sink = null;
      }
    }

    let audio;
    if (!skipAudio && !isPngSequence && config.audio?.length) {
      const fmt = getFormat(output.format);
      if (!fmt.audioArgs) {
        progress.log('warn', `Format "${output.format}" cannot carry audio; audio tracks skipped.`);
      } else {
        throwIfAborted(signal);
        progress.phase('audio');
        const ext = path.extname(outputPath);
        const silent = outputPath.slice(0, -ext.length) + '.video-only' + ext;
        await fsp.rename(outputPath, silent);
        try {
          await muxAudio({
            videoPath: silent,
            audioTracks: config.audio,
            outputPath,
            fps: config.fps,
            projectRoot: projectPath,
            output,
            ffmpegPath,
            onSpawn: onChildPid,
            videoDurationSec: totalFrames / config.fps,
          });
        } finally {
          await fsp.unlink(silent).catch(() => {});
        }
        audio = await reportAudioLevels({ outputPath, config, output, ffmpegPath, progress, onChildPid, signal });
      }
    }

    // A segment is one chunk of a bigger render; only the whole file is checked.
    const verified = isPngSequence || skipAudio
      ? { frames: totalFrames, verified: false }
      : await verifyFrameCount({ outputPath, expected: totalFrames, progress, onChildPid, signal });

    const elapsedMs = Date.now() - startedAt;
    progress.done({ outputPath, frames: totalFrames, elapsedMs, audio });
    return {
      outputPath, frames: totalFrames, elapsedMs,
      framesVerified: verified.verified,
      ...(audio ? { audio } : {}),
    };
  } catch (err) {
    const engineErr = asEngineError(err, signal?.aborted ? ErrorCodes.CANCELLED : ErrorCodes.INTERNAL);
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
  projectPath, config, frames,
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
      url: pathToFileURL(path.resolve(projectPath, config.entry)).href,
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
  projectPath, config, frame,
  browserFactory = createPuppeteerBrowser, onChildPid = () => {}, signal,
}) {
  assertFrameInRange(frame, config);
  const [only] = await captureFrames({
    projectPath, config, frames: [frame], browserFactory, onChildPid, signal,
  });
  return only.png;
}

/** Render one frame to a PNG file on disk (the "still export" path). */
export async function renderStill({ projectPath, config, frame, outputPath, browserFactory, onChildPid, signal }) {
  const png = await captureSingleFrame({
    projectPath, config, frame, signal,
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
    projectPath, config, outputPath,
    frameRange, workers = Math.max(1, Math.min(os.cpus().length, 4)),
    signal, progress = new ProgressEmitter(null),
    browserFactory = createPuppeteerBrowser,
    ffmpegPath = 'ffmpeg',
    onChildPid = () => {},
    jobId = null,
    nodeExecutable = process.execPath,
    preflight = true,
    preflightCount = 5,
    lock = true,
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
  const workerCount = Math.max(1, Math.min(workers, totalFrames));

  // Delegating, not locking: renderComposition takes the lock itself, so taking
  // it here first would deadlock against our own delegate.
  if (workerCount === 1) {
    return renderComposition({ ...opts, frameRange: [startFrame, endFrame] });
  }

  const isPngSequence = output.format === 'png-sequence';
  const useIntermediate = !isPngSequence && (!fmt.copyConcat || transparent);

  // Held for the whole fan-out. Workers run with --segment (lock:false): they
  // write this same project deliberately, and this lock covers them.
  let held = null;
  try {
    if (lock) held = await acquireRenderLock(projectPath, { label: `render x${workerCount}` });
  } catch (err) {
    const e = asEngineError(err);
    progress.error(e);
    throw e;
  }

  const startedAt = Date.now();
  progress.start({ jobId, totalFrames, fps: config.fps, width: config.width, height: config.height });

  // One browser launch here buys the chance to fail before spawning N of them.
  if (preflight && totalFrames >= MIN_FRAMES_FOR_PREFLIGHT) {
    const probeBrowser = await browserFactory({});
    if (probeBrowser.pid) onChildPid(probeBrowser.pid);
    try {
      const probePage = await probeBrowser.openPage({
        url: pathToFileURL(path.resolve(projectPath, config.entry)).href,
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
  await fsp.mkdir(isPngSequence ? outputPath : path.dirname(outputPath), { recursive: true });

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
        '--project', projectPath,
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
            path.join(outputPath, `frame-${String(globalIdx).padStart(6, '0')}.png`),
          );
        }
      }
    } else {
      progress.phase('concat');
      const wantsAudio = !!config.audio?.length && !!fmt.audioArgs;
      const ext = path.extname(outputPath);
      const silentOut = wantsAudio ? outputPath.slice(0, -ext.length) + '.video-only' + ext : outputPath;

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
            outputPath,
            fps: config.fps,
            projectRoot: projectPath,
            output,
            ffmpegPath,
            onSpawn: onChildPid,
            videoDurationSec: totalFrames / config.fps,
          });
        } finally {
          await fsp.unlink(silentOut).catch(() => {});
        }
        audio = await reportAudioLevels({ outputPath, config, output, ffmpegPath, progress, onChildPid, signal });
      } else if (config.audio?.length && !fmt.audioArgs) {
        progress.log('warn', `Format "${output.format}" cannot carry audio; audio tracks skipped.`);
      }
    }

    // The whole point of the parallel path: N workers each encoded a piece, and
    // a piece that silently came up short would otherwise ship inside the merge.
    const verified = isPngSequence
      ? { frames: totalFrames, verified: false }
      : await verifyFrameCount({ outputPath, expected: totalFrames, progress, onChildPid, signal });

    const elapsedMs = Date.now() - startedAt;
    progress.done({ outputPath, frames: totalFrames, elapsedMs, audio });
    return {
      outputPath, frames: totalFrames, elapsedMs,
      framesVerified: verified.verified,
      ...(audio ? { audio } : {}),
    };
  } catch (err) {
    killChildren();
    const engineErr = asEngineError(err, signal?.aborted ? ErrorCodes.CANCELLED : ErrorCodes.INTERNAL);
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
