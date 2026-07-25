#!/usr/bin/env node
/**
 * CLI entry point — the human path. The WinForms Render Orchestrator spawns:
 *
 *   node render.js --project <folder> --output <file.mp4>
 *                  [--frame-range <start> <end>] [--workers N]
 *                  [--frames-dir <dir>] [--segment]
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
import { validateConfig } from '../core/project.js';
import { checkPrerequisites } from '../core/prereqs.js';
import { ProgressEmitter } from '../core/progress.js';
import { EngineError, ErrorCodes } from '../core/errors.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--project': out.project = argv[++i]; break;
      case '--output': out.output = argv[++i]; break;
      case '--frame-range': out.frameRange = [Number(argv[++i]), Number(argv[++i])]; break;
      case '--workers': out.workers = Number(argv[++i]); break;
      case '--frames-dir': out.framesDir = argv[++i]; break;
      case '--segment': out.segment = true; break;
      case '--intermediate': out.intermediate = true; break;
      case '--doctor': out.doctor = true; break;
      case '--no-preflight': out.preflight = false; break;
      case '--capture-frame': out.captureFrame = Number(argv[++i]); break;
      case '--capture-out': out.captureOut = argv[++i]; break;
      case '--help': case '-h': out.help = true; break;
      default: out._.push(a);
    }
  }
  return out;
}

const USAGE = `Usage:
  render.js --project <folder> --output <file.mp4> [options]
  render.js --project <folder> --capture-frame N --capture-out <file.png>

Options:
  --frame-range <start> <end>   inclusive frame range (default: full composition)
  --workers N                   parallel worker processes (default: 1)
  --frames-dir <dir>            write PNG sequence to dir, encode second-pass
  --segment                     internal: render a segment, skip audio pass
  --intermediate                internal: encode segment as lossless FFV1
  --no-preflight                skip the pre-render frame probe (default: probe 5 frames)
  --doctor                      print prerequisite check results as JSON and exit
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const progress = new ProgressEmitter(process.stdout);

  if (args.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  if (args.doctor) {
    const prereqs = await checkPrerequisites();
    process.stdout.write(JSON.stringify(prereqs, null, 2) + '\n');
    return prereqs.ok ? 0 : 3;
  }
  if (!args.project) {
    progress.error(new EngineError(ErrorCodes.INVALID_CONFIG, 'Missing --project'));
    process.stderr.write(USAGE);
    return 2;
  }

  const prereqs = await checkPrerequisites();
  if (!prereqs.ok) {
    progress.error(new EngineError(ErrorCodes.PREREQS_MISSING, 'Node.js/FFmpeg prerequisites not satisfied', prereqs));
    return 3;
  }

  const projectPath = path.resolve(args.project);
  let config;
  try {
    config = validateConfig(JSON.parse(await fsp.readFile(path.join(projectPath, 'project.json'), 'utf8')));
  } catch (e) {
    progress.error(e instanceof EngineError ? e : new EngineError(ErrorCodes.INVALID_CONFIG, `Cannot read project.json: ${e.message}`));
    return 2;
  }

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
        projectPath, config, frame: args.captureFrame, signal: controller.signal,
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
    const common = {
      projectPath,
      config,
      outputPath: path.resolve(args.output),
      frameRange: args.frameRange,
      framesDir: args.framesDir ? path.resolve(args.framesDir) : undefined,
      skipAudio: !!args.segment,
      asIntermediate: !!args.intermediate,
      signal: controller.signal,
      progress,
      // Workers render a slice each and are spawned by an already-pre-flighted
      // parent; probing again in every worker would just repeat the same check.
      preflight: args.preflight !== false && !args.segment,
      // Likewise the render lock: every worker targets the same project on
      // purpose, and the parent holds one lock covering all of them. A worker
      // taking its own would deadlock the fan-out against itself.
      lock: !args.segment,
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
