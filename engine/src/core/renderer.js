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
 *   renderStill(opts)           — one frame written to disk as a PNG still
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
import { createPuppeteerBrowser } from './browser.js';
import { FfmpegFrameSink, encodePngSequence, concatSegments, muxAudio, transcode } from './encoder.js';
import { getFormat, INTERMEDIATE } from './formats.js';

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

  const browser = await browserFactory({});
  if (browser.pid) onChildPid(browser.pid);
  let sink = null;

  try {
    throwIfAborted(signal);
    const page = await browser.openPage({ url: entryUrl, width: config.width, height: config.height, transparent });

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
      const png = await page.captureFrame(frame);
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
      }
    }

    const elapsedMs = Date.now() - startedAt;
    progress.done({ outputPath, frames: totalFrames, elapsedMs });
    return { outputPath, frames: totalFrames, elapsedMs };
  } catch (err) {
    const engineErr = asEngineError(err, signal?.aborted ? ErrorCodes.CANCELLED : ErrorCodes.INTERNAL);
    progress.error(engineErr);
    throw engineErr;
  } finally {
    if (sink) sink.kill();
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
  if (!Number.isInteger(frame) || frame < 0 || frame >= config.durationInFrames) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `frame ${frame} out of range (composition has frames 0..${config.durationInFrames - 1})`,
    );
  }
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
    const png = await page.captureFrame(frame);
    await page.close();
    return png;
  } catch (err) {
    throw asEngineError(err);
  } finally {
    await browser.close();
  }
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
    ffmpegPath = 'ffmpeg',
    onChildPid = () => {},
    jobId = null,
    nodeExecutable = process.execPath,
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

  if (workerCount === 1) {
    return renderComposition({ ...opts, frameRange: [startFrame, endFrame] });
  }

  const isPngSequence = output.format === 'png-sequence';
  const useIntermediate = !isPngSequence && (!fmt.copyConcat || transparent);

  const startedAt = Date.now();
  progress.start({ jobId, totalFrames, fps: config.fps, width: config.width, height: config.height });
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
      } else if (config.audio?.length && !fmt.audioArgs) {
        progress.log('warn', `Format "${output.format}" cannot carry audio; audio tracks skipped.`);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    progress.done({ outputPath, frames: totalFrames, elapsedMs });
    return { outputPath, frames: totalFrames, elapsedMs };
  } catch (err) {
    killChildren();
    const engineErr = asEngineError(err, signal?.aborted ? ErrorCodes.CANCELLED : ErrorCodes.INTERNAL);
    progress.error(engineErr);
    throw engineErr;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await fsp.rm(segDir, { recursive: true, force: true }).catch(() => {});
  }
}
