#!/usr/bin/env node
/**
 * CLI entry point — the human path. The WinForms Render Orchestrator spawns:
 *
 *   node render.js --scene <folder> --output <file.mp4>
 *                  [--frame-range <start> <end>] [--workers N]
 *                  [--frames-dir <dir>] [--segment]
 *                  [--proxy [scale]] [--frame-step N]
 *                  [--capture-frame N --capture-out <file.png>]
 *
 * stdout: JSON-line progress protocol (src/core/progress.js) — nothing else.
 * stderr: human-readable diagnostics.
 * exit codes: 0 ok · 2 bad args · 3 prereqs missing · 4 cancelled · 1 render error
 *
 * Dependency-free arg parsing (no minimist): the surface is small and fixed,
 * and one fewer dependency in the npm-install-on-first-run path.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { renderComposition, renderParallel, captureSingleFrame } from '../core/renderer.js';
import { validateConfig, SCENE_CONFIG } from '../core/scene.js';
import { checkPrerequisites } from '../core/prereqs.js';
import { readSettings, resolveFfmpegPath } from '../core/settings.js';
import { ProgressEmitter } from '../core/progress.js';
import { EngineError, ErrorCodes } from '../core/errors.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scene': out.scene = argv[++i]; break;
      case '--output': out.output = argv[++i]; break;
      case '--frame-range': out.frameRange = [Number(argv[++i]), Number(argv[++i])]; break;
      case '--workers': out.workers = Number(argv[++i]); break;
      case '--frames-dir': out.framesDir = argv[++i]; break;
      case '--segment': out.segment = true; break;
      case '--intermediate': out.intermediate = true; break;
      case '--proxy': {
        // Optional value: `--proxy` takes the default scale, `--proxy 0.25`
        // sets it. Only consume the next token when it parses as a number, so
        // `--proxy --workers 2` keeps working.
        out.proxy = {};
        const peek = argv[i + 1];
        if (peek !== undefined && peek !== '' && !Number.isNaN(Number(peek))) {
          out.proxy.scale = Number(argv[++i]);
        }
        break;
      }
      case '--frame-step': out.frameStep = Number(argv[++i]); break;
      case '--doctor': out.doctor = true; break;
      case '--no-preflight': out.preflight = false; break;
      case '--ffmpeg': out.ffmpeg = argv[++i]; break;
      case '--capture-frame': out.captureFrame = Number(argv[++i]); break;
      case '--capture-out': out.captureOut = argv[++i]; break;
      case '--help': case '-h': out.help = true; break;
      default: out._.push(a);
    }
  }
  return out;
}

const USAGE = `Usage:
  render.js --scene <folder> --output <file.mp4> [options]
  render.js --scene <folder> --capture-frame N --capture-out <file.png>

Options:
  --frame-range <start> <end>   inclusive frame range (default: full composition)
  --workers N                   parallel worker processes (default: 10)
  --proxy [scale]               proxy/motion preview: capture at scale (0.1-1,
                                default 0.5, dims floored to even), every 2nd
                                frame, encoded at fps/step so duration is kept.
                                Serial (ignores --workers), skips audio and
                                pre-flight, and writes to <output>.proxy.<ext>
                                so it can never overwrite the deliverable
  --frame-step N                with --proxy: capture every Nth frame (default 2)
  --frames-dir <dir>            write PNG sequence to dir, encode second-pass
  --segment                     internal: render a segment, skip audio pass
  --intermediate                internal: encode segment as lossless FFV1
  --no-preflight                skip the pre-render frame probe (default: probe 5 frames)
  --ffmpeg <path>               ffmpeg binary to use (default: $MOTION_STUDIO_FFMPEG,
                                then settings.json ffmpeg.path, then "ffmpeg" on PATH)
  --doctor                      print prerequisite check results as JSON and exit
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const progress = new ProgressEmitter(process.stdout);

  if (args.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  // --ffmpeg wins; otherwise the machine's configured binary (env, then the
  // Studio's settings.json), then PATH — the same rule the Studio and the MCP
  // server use, so `--doctor` diagnoses the binary a real render would use.
  // Workers (--segment) are always handed an explicit --ffmpeg by the parent,
  // so this fallback cannot split a fan-out across two different binaries.
  const { path: ffmpegPath, source: ffmpegSource } = await resolveFfmpegPath({ override: args.ffmpeg });
  if (args.doctor) {
    const prereqs = await checkPrerequisites({ ffmpegPath });
    // Capability tiers (Slice 0): which capability sits in which tier and,
    // when it is not ready, the exact command that fixes it on this OS.
    const { capabilityTiers } = await import('../vendors/default/tiers.js');
    const tiers = await capabilityTiers({ ffmpegReady: !!prereqs.ffmpeg?.meetsMinimum }).catch((e) => ({ error: e.message }));
    process.stdout.write(
      JSON.stringify(
        { ...prereqs, ffmpeg: { ...prereqs.ffmpeg, effectivePath: ffmpegPath, source: ffmpegSource }, tiers },
        null,
        2,
      ) + '\n',
    );
    return prereqs.ok ? 0 : 3;
  }
  if (!args.scene) {
    progress.error(new EngineError(ErrorCodes.INVALID_CONFIG, 'Missing --scene'));
    process.stderr.write(USAGE);
    return 2;
  }

  const prereqs = await checkPrerequisites({ ffmpegPath });
  if (!prereqs.ok) {
    progress.error(new EngineError(ErrorCodes.PREREQS_MISSING, 'Node.js/FFmpeg prerequisites not satisfied', prereqs));
    return 3;
  }

  const scenePath = path.resolve(args.scene);
  let config;
  try {
    config = validateConfig(JSON.parse(await fsp.readFile(path.join(scenePath, SCENE_CONFIG), 'utf8')));
  } catch (e) {
    progress.error(e instanceof EngineError ? e : new EngineError(ErrorCodes.INVALID_CONFIG, `Cannot read ${SCENE_CONFIG}: ${e.message}`));
    return 2;
  }
  const settings = await readSettings().catch(() => null);

  // Cooperative cancellation: WinForms sends CTRL_BREAK / SIGTERM before
  // resorting to Job Object termination; SIGINT covers manual runs.
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(sig, () => controller.abort()); } catch { /* SIGBREAK non-Windows */ }
  }

  // Test/DI hook: MOTION_STUDIO_BROWSER_MODULE points at an ES module
  // exporting createBrowser(opts) with the interface in core/browser.js.
  // Used by the test suite to exercise the multi-process parallel path on
  // machines without Chromium. Ignored in normal operation.
  let browserFactory;
  if (process.env.MOTION_STUDIO_BROWSER_MODULE) {
    const mod = await import(pathToFileURL(path.resolve(process.env.MOTION_STUDIO_BROWSER_MODULE)).href);
    browserFactory = mod.createBrowser;
  }

  try {
    if (args.captureFrame !== undefined) {
      if (!args.captureOut) {
        progress.error(new EngineError(ErrorCodes.INVALID_CONFIG, '--capture-frame requires --capture-out'));
        return 2;
      }
      const png = await captureSingleFrame({
        scenePath, config, frame: args.captureFrame, signal: controller.signal,
        ...(browserFactory ? { browserFactory } : {}),
      });
      await fsp.mkdir(path.dirname(path.resolve(args.captureOut)), { recursive: true });
      await fsp.writeFile(args.captureOut, png);
      progress.done({ outputPath: path.resolve(args.captureOut), frames: 1, elapsedMs: 0 });
      return 0;
    }

    if (!args.output) {
      progress.error(new EngineError(ErrorCodes.INVALID_CONFIG, 'Missing --output'));
      return 2;
    }
    // --frame-step only means something inside a proxy render; a bare
    // --frame-step is almost always a forgotten --proxy, so say so instead of
    // silently rendering every frame.
    if (args.frameStep !== undefined && !args.proxy) {
      progress.error(new EngineError(ErrorCodes.INVALID_CONFIG, '--frame-step requires --proxy'));
      return 2;
    }
    const proxy = args.proxy
      ? { ...args.proxy, ...(args.frameStep !== undefined ? { frameStep: args.frameStep } : {}) }
      : undefined;
    const common = {
      scenePath,
      config,
      outputPath: path.resolve(args.output),
      frameRange: args.frameRange,
      framesDir: args.framesDir ? path.resolve(args.framesDir) : undefined,
      skipAudio: !!args.segment,
      asIntermediate: !!args.intermediate,
      // The renderer inserts ".proxy" before the extension itself, so the
      // deliverable at --output is safe even when both name the same file.
      ...(proxy ? { proxy } : {}),
      signal: controller.signal,
      progress,
      // Workers render a slice each and are spawned by an already-pre-flighted
      // parent; probing again in every worker would just repeat the same check.
      preflight: args.preflight !== false && !args.segment,
      // Likewise the render lock: every worker targets the same scene on
      // purpose, and the parent holds one lock covering all of them. A worker
      // taking its own would deadlock the fan-out against itself.
      lock: !args.segment,
      ffmpegPath,
      ...(settings?.render?.review ? { reviewPolicy: settings.render.review } : {}),
      ...(browserFactory ? { browserFactory } : {}),
    };
    if (args.workers && args.workers > 1) {
      await renderParallel({ ...common, workers: args.workers });
    } else {
      await renderComposition(common);
    }
    return 0;
  } catch (err) {
    // The renderer emits protocol errors itself; emit here only for paths
    // that bypass it (e.g. capture-frame validation) so consumers always get
    // exactly one {"type":"error"} line.
    if (!err._emitted) progress.error(err.toJSON ? err : new EngineError(ErrorCodes.INTERNAL, String(err.message ?? err)));
    process.stderr.write(`[render] ${err.code ?? 'error'}: ${err.message}\n`);
    return err.code === ErrorCodes.CANCELLED ? 4 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[render] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
