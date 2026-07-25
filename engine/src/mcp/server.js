#!/usr/bin/env node
/**
 * Motion Studio MCP server — the agent path (spec §5.8).
 *
 * Transport: stdio only (launched as a child process by the MCP client).
 * IMPORTANT: stdout belongs to the MCP protocol; all diagnostics go to stderr.
 *
 * Tool surface is exactly the fixed set from the spec — no shell, no
 * arbitrary file access. Every file-touching tool goes through the path
 * sandbox (core/sandbox.js); every render/preview goes through the shared
 * Render Engine Core, so agents, the CLI, and the Studio web UI exercise the
 * same code.
 *
 * Environment:
 *   MOTION_STUDIO_HOME          override data dir (default ~/.motion-studio)
 *   MOTION_STUDIO_MAX_RENDERS   per-session render cap (default unlimited; spec §10)
 *   MOTION_STUDIO_TTS_EXE       path to the Windows text-to-speech exe (optional;
 *                               enables synthesize_speech / list_voices — v0.6)
 *   MOTION_STUDIO_MIDI_EXE      MotionStudioMidi.exe (music, v0.8)
 *   MOTION_STUDIO_FLUIDSYNTH    fluidsynth.exe (music, v0.8)
 *   MOTION_STUDIO_SOUNDFONT     .sf2/.sf3 SoundFont (music, v0.8)
 */

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';

import { ProjectStore } from '../core/project.js';
import { JobManager } from '../core/jobs.js';
import {
  captureSingleFrame, captureFrames, renderComposition, renderParallel, renderStill,
  preflightFrameList, MAX_PREVIEW_FRAMES,
} from '../core/renderer.js';
import { checkPrerequisites } from '../core/prereqs.js';
import { pathToFileURL } from 'node:url';
import { EngineError, ErrorCodes, asEngineError } from '../core/errors.js';
import { resolveInProject } from '../core/sandbox.js';
import { synthesizeSpeech, wavDurationSeconds, framesForDuration, checkTts, resolveTtsExe } from '../core/tts.js';
import { synthesizeMusic, checkMusic } from '../core/music.js';
import { synthesizeSfx, SFX_TYPES, MAX_CUES, MAX_CUE_SECONDS, ALLOWED_SAMPLE_RATES } from '../core/sfx.js';
import { validateScenes, assembleFilm } from '../core/film.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAME_API_DOC = path.resolve(__dirname, '../../../docs/frame-api.md');
const FRAME_API_DOC_FALLBACK = path.resolve(__dirname, '../../docs/frame-api.md');

// Test/DI hook shared with the CLI (see cli/render.js).
let injectedBrowserFactory = null;
if (process.env.MOTION_STUDIO_BROWSER_MODULE) {
  const mod = await import(pathToFileURL(path.resolve(process.env.MOTION_STUDIO_BROWSER_MODULE)).href);
  injectedBrowserFactory = mod.createBrowser;
}

const store = new ProjectStore();
const jobs = new JobManager({
  maxConcurrent: 1,
  maxJobsPerSession: Number(process.env.MOTION_STUDIO_MAX_RENDERS) || Infinity,
});

/** Cache prereq result; re-check on demand if it previously failed. */
let prereqCache = null;
async function requirePrereqs() {
  if (!prereqCache || !prereqCache.ok) prereqCache = await checkPrerequisites();
  if (!prereqCache.ok) {
    throw new EngineError(
      ErrorCodes.PREREQS_MISSING,
      'Node.js and/or FFmpeg prerequisites are not satisfied on this machine. ' +
        'This must be fixed by the user (install FFmpeg / Node >= 18 and ensure they are on PATH) — do not retry.',
      prereqCache,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Result helpers: success JSON / structured tool errors               */
/* ------------------------------------------------------------------ */

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => {
  const e = asEngineError(err);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }] };
};
const wrap = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (err) {
    return fail(err);
  }
};

/** Smallest-free assets/narration-<n>.wav (mirrors render_still's still-<frame> defaulting). */
async function nextNarrationPath(assetsDir) {
  let existing;
  try {
    existing = new Set(await fsp.readdir(assetsDir));
  } catch {
    existing = new Set();
  }
  let n = 1;
  while (existing.has(`narration-${n}.wav`)) n++;
  return `assets/narration-${n}.wav`;
}

/** Smallest-free assets/music-<n>.wav. */
async function nextMusicPath(assetsDir) {
  let existing;
  try { existing = new Set(await fsp.readdir(assetsDir)); } catch { existing = new Set(); }
  let n = 1;
  while (existing.has(`music-${n}.wav`)) n++;
  return `assets/music-${n}.wav`;
}

/** Smallest-free assets/sfx-<n>.wav. */
async function nextSfxPath(assetsDir) {
  let existing;
  try { existing = new Set(await fsp.readdir(assetsDir)); } catch { existing = new Set(); }
  let n = 1;
  while (existing.has(`sfx-${n}.wav`)) n++;
  return `assets/sfx-${n}.wav`;
}

/* ------------------------------------------------------------------ */
/* Server + tools                                                      */
/* ------------------------------------------------------------------ */

const renderCompositionInjected = (o) => renderComposition({ ...o, browserFactory: injectedBrowserFactory });
// Workers inherit the env hook, but the parent's pre-flight page (v0.10) needs
// the factory handed to it explicitly.
const renderParallelInjected = (o) => renderParallel({ ...o, browserFactory: injectedBrowserFactory });

const server = new McpServer({ name: 'motion-studio', version: '0.15.0' });

server.registerTool(
  'list_projects',
  {
    title: 'List Motion Studio projects',
    description:
      'Enumerate known Motion Studio projects (id, name, path, lastModified). Projects created here are ' +
      'identical to ones created in the desktop UI. Returns prereqs_missing if Node/FFmpeg are not installed.',
    inputSchema: {},
  },
  wrap(async () => {
    await requirePrereqs();
    return ok({ projects: await store.listProjects() });
  }),
);

server.registerTool(
  'create_project',
  {
    title: 'Create a project',
    description:
      'Scaffold a new Motion Studio project from the default template. durationInFrames = seconds × fps. ' +
      'Returns the project id used by all other tools, plus the scaffolded file list.',
    inputSchema: {
      name: z.string().min(1).describe('Human-readable project name'),
      fps: z.number().int().min(1).max(240).default(30),
      width: z.number().int().min(2).max(7680).default(1920).describe('Must be even'),
      height: z.number().int().min(2).max(4320).default(1080).describe('Must be even'),
      durationInFrames: z.number().int().min(1).default(150),
    },
  },
  wrap(async ({ name, fps, width, height, durationInFrames }) => {
    await requirePrereqs();
    const proj = await store.createProject({ name, fps, width, height, durationInFrames });
    const files = await store.listFiles(proj.id);
    return ok({ id: proj.id, name: proj.name, path: proj.path, config: proj.config, files });
  }),
);

server.registerTool(
  'get_project',
  {
    title: 'Get project details',
    description: "Return a project's validated config plus its composition file listing.",
    inputSchema: { projectId: z.string().describe('Project id from list_projects/create_project') },
  },
  wrap(async ({ projectId }) => {
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const files = await store.listFiles(projectId);
    return ok({ id: entry.id, name: entry.name, path: entry.path, config, files });
  }),
);

server.registerTool(
  'update_project_config',
  {
    title: 'Update project config',
    description:
      'Patch project settings (fps, width, height, durationInFrames, audio tracks, output settings). ' +
      'output.format selects the deliverable: mp4 (default), webm, gif, prores (.mov), or png-sequence ' +
      '(a folder of frames). output.transparent=true keeps the alpha channel (webm/prores/png-sequence only; ' +
      'give the composition a transparent background). The output filename extension follows the format automatically. ' +
      'output.audioLimiter (default true) brick-walls the mixed audio at -1 dBFS; set false only if you want the ' +
      'summed mix passed through untouched, and remember track gains sum directly (amix runs with normalize=0). ' +
      'project.json cannot be written via write_composition_file; use this tool so config invariants are validated.',
    inputSchema: {
      projectId: z.string(),
      patch: z
        .object({
          name: z.string().min(1).optional(),
          fps: z.number().int().min(1).max(240).optional(),
          width: z.number().int().optional(),
          height: z.number().int().optional(),
          durationInFrames: z.number().int().min(1).optional(),
          audio: z
            .array(
              z.object({
                src: z.string().describe('Project-relative audio path, e.g. assets/music.mp3'),
                startInFrames: z.number().int().min(0).optional(),
                gainDb: z.number().optional(),
              }),
            )
            .optional(),
          output: z
            .object({
              dir: z.string().optional(),
              filename: z.string().optional(),
              format: z.enum(['mp4', 'webm', 'gif', 'prores', 'png-sequence']).optional(),
              transparent: z.boolean().optional().describe('Keep alpha channel (webm/prores/png-sequence only)'),
              crf: z.number().int().min(0).max(63).optional(),
              preset: z.string().optional(),
              pixFmt: z.string().optional(),
            })
            .optional(),
        })
        .describe('Fields to change; omitted fields are untouched'),
    },
  },
  wrap(async ({ projectId, patch }) => {
    const cur = await store.readConfig(projectId);
    if (patch.output) patch.output = { ...cur.output, ...patch.output };
    const config = await store.updateConfig(projectId, patch);
    return ok({ config });
  }),
);

server.registerTool(
  'read_composition_file',
  {
    title: 'Read a composition file',
    description: 'Read a source file from inside the project folder (project-relative path).',
    inputSchema: { projectId: z.string(), path: z.string().describe('Project-relative, e.g. composition.js') },
  },
  wrap(async ({ projectId, path: relPath }) => {
    const content = await store.readFile(projectId, relPath);
    return ok({ path: relPath, content });
  }),
);

server.registerTool(
  'write_composition_file',
  {
    title: 'Write a composition file',
    description:
      'Create/overwrite a composition source file (HTML/CSS/JS) inside the project folder. ' +
      'Paths are sandboxed to the project (no absolute paths, no ".."). ' +
      '.js files are syntax-checked before writing and fail fast with the parse error. ' +
      'Author against the frame API (resource motion-studio://reference/frame-api): no wall-clock time, ' +
      'register via MotionStudio.registerComposition(fn). ' +
      'JS/CSS is also scanned for frame-driven contract violations (Date.now, setInterval, Math.random, ' +
      'requestAnimationFrame, THREE.Clock, real-time CSS transitions). Those come back as a "warnings" array ' +
      'on success — the file IS written; fix them unless you are certain the usage is outside the frame function.',
    inputSchema: {
      projectId: z.string(),
      path: z.string().describe('Project-relative path, e.g. composition.js'),
      content: z.string(),
    },
  },
  wrap(async ({ projectId, path: relPath, content }) => {
    const res = await store.writeFile(projectId, relPath, content);
    return ok({ written: res });
  }),
);

server.registerTool(
  'sync_shared_files',
  {
    title: 'Copy shared source files to many scene projects',
    description:
      'Copy one or more source files from a source project into many target projects, overwriting them (new in v0.11). ' +
      'This is the maintenance half of the recommended film pattern (docs/film-setup.md): every scene project ships the ' +
      'SAME composition.js and differs only in a small scene.js. Each project owns its own copy, so without this a ' +
      'one-line fix to the shared engine means re-writing it once per scene. Files are syntax-checked and lint-scanned ' +
      'per target exactly as write_composition_file does, and every source file is read before anything is written, so a ' +
      'bad path fails before it half-updates the film. Does NOT touch scene.js unless you list it, and never project.json. ' +
      'After syncing, re-render the affected scenes — already-rendered output is not invalidated automatically.',
    inputSchema: {
      sourceProjectId: z.string().describe('Project holding the canonical copies'),
      targetProjectIds: z.array(z.string()).min(1).describe('Projects to overwrite; the source is skipped if listed'),
      files: z.array(z.string()).min(1).describe('Project-relative paths, e.g. ["composition.js", "styles.css"]'),
    },
  },
  wrap(async ({ sourceProjectId, targetProjectIds, files }) => {
    return ok(await store.syncSharedFiles({ sourceProjectId, targetProjectIds, files }));
  }),
);

server.registerTool(
  'capture_preview_frame',
  {
    title: 'Capture one frame as PNG',
    description:
      'Render a single frame through the REAL render path (headless Chromium, identical to the final render) ' +
      'and return the image. Use this to visually verify your composition at representative frames ' +
      '(first, midpoints, Sequence boundaries, last) BEFORE starting a full render. ' +
      'Checking more than one frame? Use capture_preview_frames instead — it does them all in one page load.',
    inputSchema: { projectId: z.string(), frame: z.number().int().min(0) },
  },
  wrap(async ({ projectId, frame }) => {
    await requirePrereqs();
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const png = await captureSingleFrame({
      projectPath: entry.path, config, frame,
      ...(injectedBrowserFactory ? { browserFactory: injectedBrowserFactory } : {}),
    });
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ frame, width: config.width, height: config.height }) },
      ],
    };
  }),
);

server.registerTool(
  'capture_preview_frames',
  {
    title: 'Capture several frames as PNGs',
    description:
      'Render SEVERAL frames from one page load and return them all as images (new in v0.10). ' +
      'Prefer this over repeated capture_preview_frame: each single capture launches Chromium, loads the page, ' +
      'and re-runs the composition\'s one-time setup, so checking five frames one at a time pays that cost five ' +
      'times. Pass explicit `frames`, or just `count` to get evenly-spaced frames spanning the composition ' +
      `(first and last always included). Maximum ${MAX_PREVIEW_FRAMES} frames per call.`,
    inputSchema: {
      projectId: z.string(),
      frames: z.array(z.number().int().min(0)).optional().describe('Explicit frame numbers, in the order you want them back'),
      count: z.number().int().min(2).max(MAX_PREVIEW_FRAMES).optional().describe('Evenly-spaced frames across the composition (default 5 when `frames` is omitted)'),
    },
  },
  wrap(async ({ projectId, frames, count }) => {
    await requirePrereqs();
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const list = frames?.length
      ? frames
      : preflightFrameList(0, config.durationInFrames - 1, count ?? 5);
    const shots = await captureFrames({
      projectPath: entry.path, config, frames: list,
      ...(injectedBrowserFactory ? { browserFactory: injectedBrowserFactory } : {}),
    });
    return {
      content: [
        ...shots.map((s) => ({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' })),
        {
          type: 'text',
          text: JSON.stringify({
            frames: shots.map((s) => s.frame),
            width: config.width,
            height: config.height,
            note: 'Images are in the same order as "frames".',
          }),
        },
      ],
    };
  }),
);

server.registerTool(
  'render',
  {
    title: 'Start a render job',
    description:
      'Start rendering the composition to the configured output format (mp4/webm/gif/prores/png-sequence — ' +
      'set via update_project_config). Returns a jobId immediately; block on it with wait_for_render (or poll ' +
      'get_render_status) until state is done/error/cancelled. Optional frameRange renders a cheap partial ' +
      'segment first. If another job is ' +
      'running, the new job is QUEUED (FIFO, one render at a time) and starts automatically — the response ' +
      'then has state "queued" and a queuePosition. A full queue fails with queue_full.',
    inputSchema: {
      projectId: z.string(),
      frameRange: z
        .tuple([z.number().int().min(0), z.number().int().min(0)])
        .optional()
        .describe('[startFrame, endFrame] inclusive; omit for the full composition'),
      workers: z.number().int().min(1).max(16).optional().describe('Parallel capture processes (default 1)'),
      outputFilename: z.string().optional().describe('Filename inside the project "out" dir (default from config)'),
      preflight: z
        .boolean()
        .optional()
        .describe('Probe a few evenly-spaced frames before committing to the render (default true; skipped under 30 frames)'),
    },
  },
  wrap(async ({ projectId, frameRange, workers, outputFilename, preflight }) => {
    await requirePrereqs();
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const name = outputFilename ?? config.output.filename;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'outputFilename must be a bare filename');
    }
    const outputPath = path.join(entry.path, config.output.dir, name);
    const { jobId, state, queuePosition } = jobs.startRender({
      projectId, projectPath: entry.path, config, outputPath, frameRange, workers, preflight,
      ...(injectedBrowserFactory
        ? { renderFn: (o) => (o.workers > 1 ? renderParallelInjected(o) : renderCompositionInjected(o)) }
        : {}),
    });
    return ok({
      jobId, state, ...(queuePosition ? { queuePosition } : {}), outputPath,
      totalFrames: frameRange ? frameRange[1] - frameRange[0] + 1 : config.durationInFrames,
    });
  }),
);

server.registerTool(
  'get_render_status',
  {
    title: 'Poll render job status',
    description:
      'Get progress/state for a jobId: state (queued|running|done|error|cancelled), phase, framesDone/totalFrames, ' +
      'percent, renderFps, etaMs (null until measurable), queuePosition while queued, and the structured error ' +
      'if it failed. Wait for a terminal state before reporting completion. When the render carried audio, the ' +
      'done status also has `audio` with the measured peakDb/meanDb of the final mix and a `clipping` flag. ' +
      'To wait for one or more jobs without a polling loop, use wait_for_render instead.',
    inputSchema: { jobId: z.string() },
  },
  wrap(async ({ jobId }) => ok(jobs.getStatus(jobId))),
);

server.registerTool(
  'wait_for_render',
  {
    title: 'Wait for render job(s) to reach a terminal state',
    description:
      'Block until every listed job is done/error/cancelled, or until timeoutMs elapses — one call instead of a ' +
      'get_render_status polling loop (new in v0.14). Returns { timedOut, jobs } where each jobs[] entry has the ' +
      'same shape as get_render_status, including the structured error for failed jobs and the measured `audio` ' +
      'block for finished ones — check states individually, since one failed scene does not stop the others. ' +
      'Waiting on queued jobs is fine; they complete in FIFO order. A timeout is NOT an error: the jobs keep ' +
      'running and you get the current snapshots with timedOut: true (wait again to keep watching). ' +
      'Errors: job_not_found if any id is unknown.',
    inputSchema: {
      jobIds: z.array(z.string()).min(1).max(16).describe('Job ids from render; every id must exist'),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(600_000)
        .default(300_000)
        .describe('Stop waiting after this long; the jobs themselves are unaffected'),
    },
  },
  wrap(async ({ jobIds, timeoutMs }) => ok(await jobs.waitFor(jobIds, { timeoutMs }))),
);

server.registerTool(
  'cancel_render',
  {
    title: 'Cancel a render job',
    description:
      'Abort a job. Running jobs have their whole process tree killed (Chromium workers + FFmpeg); ' +
      'queued jobs are dequeued without ever starting. Idempotent.',
    inputSchema: { jobId: z.string() },
  },
  wrap(async ({ jobId }) => ok(jobs.cancel(jobId))),
);

server.registerTool(
  'list_render_jobs',
  {
    title: 'List render jobs',
    description: 'List active and recent render jobs with their states.',
    inputSchema: {},
  },
  wrap(async () => ok({ jobs: jobs.listJobs() })),
);

server.registerTool(
  'get_logs',
  {
    title: 'Get job logs',
    description:
      "Retrieve a job's captured log lines (phases, warnings, stderr summaries, the failure message). " +
      'Read these before guessing at a fix: Chromium launch failures and FFmpeg encode errors need different fixes.',
    inputSchema: { jobId: z.string(), tail: z.number().int().min(1).max(500).default(100) },
  },
  wrap(async ({ jobId, tail }) => ok({ jobId, logs: jobs.getLogs(jobId, { tail }) })),
);

server.registerTool(
  'render_still',
  {
    title: 'Render a still frame to a PNG file',
    description:
      'Render one frame through the real render path and save it as a PNG inside the project\'s "out" dir ' +
      '(new in v0.5). Use this to export poster frames / thumbnails; use capture_preview_frame when you want ' +
      'the image returned inline for visual inspection instead of written to disk.',
    inputSchema: {
      projectId: z.string(),
      frame: z.number().int().min(0),
      outputFilename: z.string().optional().describe('Bare .png filename inside the "out" dir (default still-<frame>.png)'),
    },
  },
  wrap(async ({ projectId, frame, outputFilename }) => {
    await requirePrereqs();
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const name = outputFilename ?? `still-${frame}.png`;
    if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.png')) {
      throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'outputFilename must be a bare .png filename');
    }
    const outputPath = path.join(entry.path, config.output.dir, name);
    const res = await renderStill({
      projectPath: entry.path, config, frame, outputPath,
      ...(injectedBrowserFactory ? { browserFactory: injectedBrowserFactory } : {}),
    });
    return ok(res);
  }),
);

server.registerTool(
  'write_asset_file',
  {
    title: 'Write a binary asset (base64)',
    description:
      'Write a binary asset (image / audio / font) into the project\'s assets/ folder from base64 content ' +
      '(new in v0.5). Destination is confined to assets/, extensions are allow-listed ' +
      '(png jpg jpeg gif webp svg mp3 wav ogg m4a flac woff woff2 ttf otf json txt), and size is capped at 25 MB ' +
      '(fails with asset_too_large). Reference the file from the composition as e.g. "assets/logo.png".',
    inputSchema: {
      projectId: z.string(),
      path: z.string().describe('Project-relative path under assets/, e.g. assets/logo.png'),
      contentBase64: z.string().describe('File content, base64-encoded'),
    },
  },
  wrap(async ({ projectId, path: relPath, contentBase64 }) => {
    const res = await store.writeAssetFile(projectId, relPath, contentBase64);
    return ok({ written: res });
  }),
);

server.registerTool(
  'list_assets',
  {
    title: 'List a project\'s assets',
    description:
      'Enumerate every file under the project\'s assets/ folder (new in v0.15): path, bytes, mtime, a coarse ' +
      'kind (image/audio/font/data), and audioRefs — how many config.audio tracks reference the file. ' +
      'get_project also lists files, but undifferentiated and without reference counts; use this to answer ' +
      '"which assets does the audio timeline actually use, and which are orphaned?" before cleaning up.',
    inputSchema: {
      projectId: z.string(),
    },
  },
  wrap(async ({ projectId }) => {
    return ok({ files: await store.listAssets(projectId) });
  }),
);

server.registerTool(
  'delete_asset',
  {
    title: 'Delete an asset',
    description:
      'Delete one file under the project\'s assets/ folder (new in v0.15). Always reports audioRefs — the number ' +
      'of config.audio tracks that referenced the file — so a dangling reference is never created silently. ' +
      'Pass updateAudio: true to also drop those tracks in the same call; leaving it false keeps them, which ' +
      'means the next render fails at the ffmpeg mux step with a missing input. Irreversible: the file is ' +
      'removed from disk. Folders are not deleted (manage those on disk).',
    inputSchema: {
      projectId: z.string(),
      path: z.string().describe('Project-relative path under assets/, e.g. assets/narration-3.wav'),
      updateAudio: z.boolean().default(false)
        .describe('Also remove any config.audio tracks whose src is this file'),
    },
  },
  wrap(async ({ projectId, path: relPath, updateAudio }) => {
    return ok(await store.deleteAsset(projectId, relPath, { updateAudio }));
  }),
);

server.registerTool(
  'rename_asset',
  {
    title: 'Rename or move an asset',
    description:
      'Rename/move a file within the project\'s assets/ folder (new in v0.15). Both paths must stay under ' +
      'assets/, and an existing destination is refused rather than overwritten. Reports audioRefs; pass ' +
      'updateAudio: true to repoint those config.audio tracks at the new path (each track\'s startInFrames ' +
      'and gainDb are preserved). Without it the tracks keep pointing at the old, now-missing file.',
    inputSchema: {
      projectId: z.string(),
      from: z.string().describe('Existing project-relative path under assets/'),
      to: z.string().describe('New project-relative path under assets/'),
      updateAudio: z.boolean().default(false)
        .describe('Also repoint any config.audio tracks that reference the old path'),
    },
  },
  wrap(async ({ projectId, from, to, updateAudio }) => {
    return ok(await store.renameAsset(projectId, from, to, { updateAudio }));
  }),
);

server.registerTool(
  'synthesize_speech',
  {
    title: 'Synthesize narration (text-to-speech)',
    description:
      'Turn narration text into a spoken WAV in the project\'s assets/ folder using the system speech engine ' +
      '(Windows-only; requires MOTION_STUDIO_TTS_EXE — otherwise fails with tts_unavailable). ' +
      'Returns the clip length as durationSeconds AND durationInFrames — use durationInFrames to size the ' +
      'Sequence() block the narration plays under. mode="attach" (default) also appends the clip to the ' +
      'project\'s audio tracks so the next render mixes it in automatically; mode="asset-only" just writes the ' +
      'WAV and reports its duration, leaving you to wire it later with update_project_config. ' +
      'List available voices first with list_voices. Text is sent to the engine via a UTF-8 file, so quotes / ' +
      'newlines / unicode in the narration are safe.',
    inputSchema: {
      projectId: z.string(),
      text: z.string().min(1).describe('Narration text (UTF-8)'),
      voice: z.string().optional().describe('Voice name from list_voices; omit for the system default'),
      rate: z.number().int().min(-10).max(10).optional().describe('Speaking rate (engine scale, e.g. -10..10)'),
      volume: z.number().int().min(0).max(100).optional().describe('Volume 0..100'),
      mode: z.enum(['attach', 'asset-only']).default('attach')
        .describe('attach = also add an audio track; asset-only = just synthesize + report'),
      assetPath: z.string().optional()
        .describe('Project-relative .wav under assets/ (default assets/narration-<n>.wav)'),
      startInFrames: z.number().int().min(0).optional().describe('attach mode: track start offset in frames'),
      gainDb: z.number().optional().describe('attach mode: track gain in dB'),
    },
  },
  wrap(async ({ projectId, text, voice, rate, volume, mode, assetPath, startInFrames, gainDb }) => {
    const ttsExe = resolveTtsExe();
    const probe = await checkTts({ ttsExe });
    if (!probe.available) {
      throw new EngineError(
        ErrorCodes.TTS_UNAVAILABLE,
        `Speech engine not available: ${probe.error}. Build MotionStudioTts.exe and set MOTION_STUDIO_TTS_EXE ` +
          'to its path (Windows only), then retry — do not retry blindly.',
        { error: probe.error },
      );
    }

    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const assetsDir = path.join(entry.path, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });

    const relPath = assetPath ?? (await nextNarrationPath(assetsDir));
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(
        ErrorCodes.PATH_OUTSIDE_PROJECT,
        `Narration must be written under assets/ (got "${relPath}")`,
        { path: relPath },
      );
    }
    // Reuse the sandbox's write guards (allow-list incl. .wav, traversal/symlink checks).
    const abs = resolveInProject(entry.path, normalized, { forWrite: true, asAsset: true });

    const result = await synthesizeSpeech({ text, outPath: abs, voice, rate, volume, ttsExe });

    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new EngineError(
        ErrorCodes.TTS_FAILED,
        `Speech engine reported success but no audio was written to ${normalized}`,
        { path: normalized },
      );
    }

    const durationSeconds = await wavDurationSeconds(abs);
    const durationInFrames = framesForDuration(durationSeconds, config.fps);

    let attached = false;
    let audio;
    let audioTrackIndex;
    if (mode === 'attach') {
      const track = { src: normalized };
      if (startInFrames !== undefined) track.startInFrames = startInFrames;
      if (gainDb !== undefined) track.gainDb = gainDb;
      audioTrackIndex = config.audio?.length ?? 0;
      const updated = await store.updateConfig(projectId, { audio: [...(config.audio ?? []), track] });
      audio = updated.audio;
      attached = true;
    }

    return ok({
      mode,
      assetPath: normalized,
      voice: result.voice ?? voice ?? null,
      durationSeconds,
      durationInFrames,
      fps: config.fps,
      sampleRate: result.sampleRate,
      channels: result.channels,
      bytes: stat.size,
      reportedDurationSeconds: result.durationSeconds,
      attached,
      ...(attached
        ? { audioTrackIndex, audio }
        : { hint: `Wire this in later with update_project_config { audio: [{ src: "${normalized}" }] }` }),
    });
  }),
);

server.registerTool(
  'list_voices',
  {
    title: 'List installed TTS voices',
    description:
      'List the speech voices installed on this machine, for use as the "voice" argument to synthesize_speech. ' +
      'Windows-only; requires MOTION_STUDIO_TTS_EXE (otherwise fails with tts_unavailable).',
    inputSchema: {},
  },
  wrap(async () => {
    const ttsExe = resolveTtsExe();
    const probe = await checkTts({ ttsExe });
    if (!probe.available) {
      throw new EngineError(
        ErrorCodes.TTS_UNAVAILABLE,
        `Speech engine not available: ${probe.error}. Build MotionStudioTts.exe and set MOTION_STUDIO_TTS_EXE ` +
          '(Windows only).',
        { error: probe.error },
      );
    }
    return ok({ voices: probe.voices });
  }),
);

server.registerTool(
  'synthesize_music',
  {
    title: 'Generate music (MIDI → FluidSynth)',
    description:
      'Compose a short piece of music from a note spec YOU author, and add it as an audio track. ' +
      'The spec is rendered to MIDI (DryWetMIDI) then to audio (FluidSynth + a General MIDI SoundFont). ' +
      'Windows-only; requires the music toolchain (MotionStudioMidi.exe + fluidsynth + a soundfont) — otherwise ' +
      'fails with music_unavailable (see docs/music-setup.md). ' +
      'mode="attach" (default) writes assets/music-<n>.wav AND appends the audio track so the next render mixes it; ' +
      'mode="asset-only" writes + reports only. Returns durationSeconds/durationInFrames (the WAV, which includes a ' +
      'reverb tail) and musicalDurationSeconds (the note content). Use durationInFrames to size the video, and ' +
      'startInFrames/gainDb to place and balance the bed against narration. ' +
      'Spec: bpm, plus tracks of notes. program = General MIDI instrument 0..127 (0 piano, 24 nylon guitar, 32 acoustic ' +
      'bass, 40 violin, 48 strings, 56 trumpet, 73 flute…). drums:true routes the track to GM percussion. ' +
      'Each note: pitch 0..127 (60 = middle C), start & duration in beats (quarter notes), velocity 1..127.',
    inputSchema: {
      projectId: z.string(),
      spec: z.object({
        bpm: z.number().min(20).max(400).default(120),
        tracks: z.array(z.object({
          program: z.number().int().min(0).max(127).default(0).describe('General MIDI instrument (ignored if drums)'),
          drums: z.boolean().optional().describe('Route to GM percussion (channel 10)'),
          notes: z.array(z.object({
            pitch: z.number().int().min(0).max(127).describe('MIDI note; 60 = middle C'),
            start: z.number().min(0).describe('Start time in beats (quarter notes)'),
            duration: z.number().min(0).describe('Length in beats'),
            velocity: z.number().int().min(1).max(127).optional(),
          })).min(1),
        })).min(1),
      }).describe('The piece to compose'),
      mode: z.enum(['attach', 'asset-only']).default('attach'),
      assetPath: z.string().optional().describe('Project-relative .wav under assets/ (default assets/music-<n>.wav)'),
      startInFrames: z.number().int().min(0).optional().describe('attach mode: track start offset in frames'),
      gainDb: z.number().optional().describe('attach mode: track gain in dB (e.g. -8 for a background bed)'),
    },
  },
  wrap(async ({ projectId, spec, mode, assetPath, startInFrames, gainDb }) => {
    const probe = await checkMusic();
    if (!probe.available) {
      throw new EngineError(
        ErrorCodes.MUSIC_UNAVAILABLE,
        `Music toolchain not available: ${probe.error}. Build MotionStudioMidi.exe, place fluidsynth + a SoundFont, ` +
          'or set MOTION_STUDIO_MIDI_EXE / MOTION_STUDIO_FLUIDSYNTH / MOTION_STUDIO_SOUNDFONT (Windows only). See docs/music-setup.md.',
        { error: probe.error },
      );
    }
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const assetsDir = path.join(entry.path, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });

    const relPath = assetPath ?? (await nextMusicPath(assetsDir));
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Music must be written under assets/ (got "${relPath}")`, { path: relPath });
    }
    const abs = resolveInProject(entry.path, normalized, { forWrite: true, asAsset: true });

    const result = await synthesizeMusic({ spec, outPath: abs });

    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new EngineError(ErrorCodes.MUSIC_FAILED, `Rendered no audio to ${normalized}`, { path: normalized });
    }
    const durationSeconds = await wavDurationSeconds(abs);
    const durationInFrames = framesForDuration(durationSeconds, config.fps);

    let attached = false, audio, audioTrackIndex;
    if (mode === 'attach') {
      const track = { src: normalized };
      if (startInFrames !== undefined) track.startInFrames = startInFrames;
      if (gainDb !== undefined) track.gainDb = gainDb;
      audioTrackIndex = config.audio?.length ?? 0;
      const updated = await store.updateConfig(projectId, { audio: [...(config.audio ?? []), track] });
      audio = updated.audio;
      attached = true;
    }

    return ok({
      mode,
      assetPath: normalized,
      bpm: result.bpm,
      tracks: result.tracks,
      notes: result.notes,
      musicalDurationSeconds: result.musicalDurationSeconds,
      durationSeconds,
      durationInFrames,
      fps: config.fps,
      bytes: stat.size,
      attached,
      ...(attached
        ? { audioTrackIndex, audio }
        : { hint: `Wire this in later with update_project_config { audio: [{ src: "${normalized}" }] }` }),
    });
  }),
);

server.registerTool(
  'synthesize_sfx',
  {
    title: 'Generate sound effects (pure JS, no toolchain)',
    description:
      'Render a list of sound-effect CUES into one mono WAV and add it as an audio track (new in v0.12). ' +
      'Use this for the noises a film needs that speech and music cannot make: a whoosh on a cut, a chime between ' +
      'scenes, a thud when something heavy lands, a slow shimmer under a reveal. Unlike synthesize_music there is ' +
      'NOTHING to install — it is pure JS, works on every OS, and never returns an "unavailable" error. ' +
      'One call makes the whole bed: you get a single track holding every cue at its absolute time, which is what you ' +
      'want for build_film\'s master audio timeline (one track, not one per cue). ' +
      'TIME IS IN FRAMES: `atFrame` matches config.audio.startInFrames and a scene\'s filmOffset, so "a chime on every ' +
      'scene cut" is a plain map over your scene offsets. `at` (seconds) is accepted instead; set exactly one. ' +
      '`gain` is the cue\'s PEAK AMPLITUDE 0..1 (not dB) and means the same thing for every type. ' +
      'Levels: by default (`normalize:"ceiling"`) a quiet bed is left quiet and only a mix hotter than `ceilingDb` is ' +
      'pulled down — so the returned `peakDb` is the real level and your `gainDb` at mix time stays meaningful. ' +
      `Types: ${SFX_TYPES.join(', ')}. Pitched cues take pitch (MIDI, like synthesize_music) or hz, not both. ` +
      `Limits: ${MAX_CUES} cues, ${MAX_CUE_SECONDS}s per cue. sampleRate ∈ ${ALLOWED_SAMPLE_RATES.join('/')} — ` +
      'prefer 22050 for a long bed (a 10-minute 44.1k bed is ~53 MB). ' +
      'mode="attach" (default) writes assets/sfx-<n>.wav AND appends the track; "asset-only" writes + reports only. ' +
      'See docs/sfx-setup.md.',
    inputSchema: {
      projectId: z.string(),
      spec: z.object({
        durationInFrames: z.number().int().min(1).optional()
          .describe('Bed length (default: the project duration, so it spans the composition)'),
        sampleRate: z.number().int().optional().describe(`One of ${ALLOWED_SAMPLE_RATES.join(', ')} (default 44100)`),
        normalize: z.enum(['ceiling', 'peak', 'none']).optional()
          .describe('ceiling (default): attenuate only if over ceilingDb · peak: always sit exactly at it · none: leave alone'),
        ceilingDb: z.number().min(-60).max(0).optional().describe('Ceiling in dBFS (default -1)'),
        cues: z.array(z.object({
          type: z.enum(['chime', 'whoosh', 'shimmer', 'thud', 'tone']),
          atFrame: z.number().int().min(0).optional().describe('Start frame (preferred; matches startInFrames/filmOffset)'),
          at: z.number().min(0).optional().describe('Start in seconds — use instead of atFrame, never both'),
          gain: z.number().min(0.001).max(1).optional().describe('Peak amplitude 0..1, NOT dB (default 0.5)'),
          pitch: z.number().int().min(0).max(127).optional().describe('MIDI note (chime/shimmer/tone); 60 = middle C'),
          hz: z.number().min(1).max(20000).optional().describe('Frequency instead of pitch (thud/tone)'),
          pitches: z.array(z.number().int().min(0).max(127)).optional().describe('shimmer: the chord to stack'),
          decay: z.number().optional().describe('chime: decay time in seconds (default 2.0)'),
          rise: z.number().optional().describe('whoosh/shimmer: time up to the hit (default 0.6 / 3.0)'),
          fall: z.number().optional().describe('whoosh/shimmer: release (default 0.45 / 4.0)'),
          hold: z.number().optional().describe('shimmer: time held at full before the fall (default 2.4)'),
          dur: z.number().optional().describe('thud/tone: length in seconds (default 2.6 / 0.25)'),
          attack: z.number().optional().describe('tone: attack in seconds (default 0.01)'),
          release: z.number().optional().describe('tone: release in seconds (default 0.08)'),
          wave: z.enum(['sine', 'triangle', 'square']).optional().describe('tone: waveform (default sine)'),
          seed: z.number().int().optional().describe('Pin the noise for whoosh/shimmer (default: derived from the cue index)'),
        })).min(1).describe('The cues, in any order'),
      }).describe('The sound-effect bed to render'),
      mode: z.enum(['attach', 'asset-only']).default('attach'),
      assetPath: z.string().optional().describe('Project-relative .wav under assets/ (default assets/sfx-<n>.wav)'),
      startInFrames: z.number().int().min(0).optional().describe('attach mode: track start offset in frames'),
      gainDb: z.number().optional().describe('attach mode: track gain in dB (e.g. -12 to tuck the bed under narration)'),
    },
  },
  wrap(async ({ projectId, spec, mode, assetPath, startInFrames, gainDb }) => {
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const assetsDir = path.join(entry.path, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });

    const relPath = assetPath ?? (await nextSfxPath(assetsDir));
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, `SFX must be written under assets/ (got "${relPath}")`, { path: relPath });
    }
    const abs = resolveInProject(entry.path, normalized, { forWrite: true, asAsset: true });

    // fps and the default length come from the project, so a bed spans the
    // composition without the caller restating what the engine already knows.
    const result = await synthesizeSfx({
      spec: {
        ...spec,
        fps: config.fps,
        durationInFrames: spec.durationInFrames ?? config.durationInFrames,
      },
      outPath: abs,
    });

    let attached = false, audio, audioTrackIndex;
    if (mode === 'attach') {
      const track = { src: normalized };
      if (startInFrames !== undefined) track.startInFrames = startInFrames;
      if (gainDb !== undefined) track.gainDb = gainDb;
      audioTrackIndex = config.audio?.length ?? 0;
      const updated = await store.updateConfig(projectId, { audio: [...(config.audio ?? []), track] });
      audio = updated.audio;
      attached = true;
    }

    return ok({
      mode,
      assetPath: normalized,
      cues: result.cues,
      clamped: result.clamped,
      ...(result.clamped ? { clampedCues: result.clampedCues } : {}),
      normalize: result.normalize,
      rawPeakDb: result.rawPeakDb,
      peakDb: result.peakDb,
      appliedGainDb: result.appliedGainDb,
      sampleRate: result.sampleRate,
      channels: result.channels,
      durationSeconds: result.durationSeconds,
      durationInFrames: result.durationInFrames,
      fps: config.fps,
      bytes: result.bytes,
      attached,
      ...(attached
        ? { audioTrackIndex, audio }
        : { hint: `Wire this in later with update_project_config { audio: [{ src: "${normalized}" }] }` }),
    });
  }),
);

server.registerTool(
  'add_library',
  {
    title: 'Add a 3D library (Three.js / Babylon.js)',
    description:
      'Vendor an optional 3D rendering library into the project — copied locally so renders stay hermetic ' +
      '(no CDN at render time) — and scaffold a frame-driven starter composition. ' +
      'library="three" (Three.js, ~600 KB, lightweight) or "babylon" (Babylon.js, ~8 MB, built-in ' +
      'glow/bloom/postprocessing). scaffold=true (default) replaces composition.html/js/css with the library ' +
      'starter; set false to only vendor the library and keep your composition. ' +
      'The result includes determinism notes you MUST follow: drive all animation from the injected frame — ' +
      'no requestAnimationFrame, no THREE.Clock / Babylon render loop / particle systems (all wall-clock based) — ' +
      'and compile shaders before the first frame (the starters warm up materials, else single-frame captures render blank). ' +
      'addons: babylon supports "loaders" (glTF/GLB import via SceneLoader); loading a model also needs env MOTION_STUDIO_ALLOW_LOCAL_FETCH=1. ' +
      'Requires the vendored build (run scripts/fetch-libs.mjs once); otherwise fails with library_unavailable.',
    inputSchema: {
      projectId: z.string(),
      library: z.enum(['three', 'babylon']),
      scaffold: z.boolean().default(true).describe('Replace composition.html/js/css with the library starter'),
      addons: z.array(z.enum(['loaders'])).optional().describe('Optional addons — babylon "loaders" for glTF/GLB'),
    },
  },
  wrap(async ({ projectId, library, scaffold, addons }) => ok(await store.addLibrary(projectId, { library, scaffold, addons }))),
);

server.registerTool(
  'remove_project',
  {
    title: 'Remove a project',
    description:
      'Unregister a project from the registry (new in v0.5). With deleteFiles=true the project folder is also ' +
      'deleted, but ONLY if it lives under the managed projects root (~/.motion-studio/projects); projects ' +
      'registered at user-chosen locations are never deleted from disk. Irreversible — confirm with the user first.',
    inputSchema: {
      projectId: z.string(),
      deleteFiles: z.boolean().default(false),
    },
  },
  wrap(async ({ projectId, deleteFiles }) => ok(await store.removeProject(projectId, { deleteFiles }))),
);

server.registerTool(
  'build_film',
  {
    title: 'Assemble scenes into a film',
    description:
      'Stitch several already-rendered scene projects into one continuous film — the way to build videos longer than a single ' +
      'composition. Author each scene as its own project (create_project → write_composition_file → render), then list them here ' +
      'in play order. Scenes are concatenated LOSSLESSLY (ffmpeg -c copy, no re-encode), so they must share resolution, fps, format ' +
      'and pixel format — use mp4, webm, or prores (gif / png-sequence cannot be concatenated). This tool renders nothing: every ' +
      'scene must already be rendered, or it fails with scene_not_rendered listing which. Mismatched scenes fail with ' +
      'inconsistent_scenes. Audio: with no `audio`, each scene\'s own audio is preserved (all scenes must be consistently audio ' +
      'or all silent); pass `audio` to lay ONE master timeline (music bed + narration, startInFrames/gainDb like config.audio) over ' +
      'the whole film, which replaces per-scene audio. When a master timeline is present the result includes an `audio` block with ' +
      'the measured peak/mean dBFS and a `clipping` flag — check it, since a bad mix is the one defect you cannot see. Pass ' +
      '`audioTargetPeakDb` (e.g. -2) to have the film measured and re-muxed once to that level instead of guessing gains. ' +
      'Tip for quality: render scenes as prores (or low crf), assemble, then do a single final encode. See docs/film-setup.md.',
    inputSchema: {
      scenes: z.array(z.object({ projectId: z.string() })).min(1)
        .describe('Scene projects in play order; each must already be rendered'),
      outputProjectId: z.string().optional()
        .describe('Project that receives out/<film> and holds master-audio assets (default: the first scene)'),
      outputFilename: z.string().optional()
        .describe('Bare filename for the film; extension is forced to the scenes\' format (default film.<ext>)'),
      audio: z.array(z.object({
        src: z.string().describe('Project-relative audio under assets/ of the output project'),
        startInFrames: z.number().int().min(0).optional().describe('Track start offset in frames'),
        gainDb: z.number().optional().describe('Track gain in dB (e.g. -8 for a background bed)'),
      })).optional().describe('Optional master audio laid over the entire film (replaces per-scene audio)'),
      audioTargetPeakDb: z.number().min(-60).max(0).optional()
        .describe('Measure the mixed film and re-mux once so it peaks here (e.g. -2). Shifts every track by the ' +
          'same amount, so your relative balance is preserved. Use it instead of guessing a master gain.'),
    },
  },
  wrap(async ({ scenes, outputProjectId, outputFilename, audio, audioTargetPeakDb }) => {
    await requirePrereqs();
    const sceneData = [];
    for (const s of scenes) {
      const entry = await store.getProjectEntry(s.projectId);
      const config = await store.readConfig(s.projectId);
      sceneData.push({ projectId: s.projectId, path: entry.path, config });
    }
    const info = validateScenes(sceneData, { hasMasterAudio: !!(audio && audio.length) });

    const outId = outputProjectId ?? scenes[0].projectId;
    const outEntry = await store.getProjectEntry(outId);
    const outCfg = await store.readConfig(outId);

    const ext = path.extname(sceneData[0].config.output?.filename ?? 'output.mp4') || '.mp4';
    const base = (outputFilename ?? 'film').replace(/\.[a-z0-9]+$/i, '');
    if (base.includes('/') || base.includes('\\') || base.includes('..') || base === '') {
      throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'outputFilename must be a bare filename');
    }
    const outDir = path.join(outEntry.path, outCfg.output?.dir ?? 'out');
    await fsp.mkdir(outDir, { recursive: true });
    const outputPath = path.join(outDir, base + ext);

    let audioTracks;
    if (audio && audio.length) {
      audioTracks = [];
      for (const t of audio) {
        const normalized = t.src.replace(/\\/g, '/');
        if (!normalized.startsWith('assets/')) {
          throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, `master audio must be under assets/ (got "${t.src}")`, { path: t.src });
        }
        const abs = resolveInProject(outEntry.path, normalized, { asAsset: true });
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat) throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `master audio not found: ${normalized} in project ${outId}`, { path: normalized });
        audioTracks.push({ src: abs, startInFrames: t.startInFrames, gainDb: t.gainDb });
      }
    }

    const result = await assembleFilm({
      scenes: sceneData, format: info.format, outputPath, audioTracks,
      projectRoot: outEntry.path,
      audioLimiter: outCfg.output?.audioLimiter !== false,
      audioTargetPeakDb,
    });
    return ok({ outputProjectId: outId, sceneOrder: scenes.map((s) => s.projectId), ...result });
  }),
);

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

server.registerResource(
  'frame-api-reference',
  'motion-studio://reference/frame-api',
  {
    title: 'Motion Studio Frame API v1.1',
    description: 'The setFrame/interpolate/Sequence/frameReady contract every composition must follow.',
    mimeType: 'text/markdown',
  },
  async (uri) => {
    let text;
    try {
      text = await fsp.readFile(FRAME_API_DOC, 'utf8');
    } catch {
      text = await fsp.readFile(FRAME_API_DOC_FALLBACK, 'utf8');
    }
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  },
);

server.registerResource(
  'project-manifests',
  'motion-studio://projects/manifest',
  {
    title: 'Project manifests',
    description: 'All registered projects and their configs as structured JSON.',
    mimeType: 'application/json',
  },
  async (uri) => {
    const projects = await store.listProjects();
    const manifests = [];
    for (const p of projects) {
      if (p.missing) continue;
      try {
        manifests.push({ id: p.id, name: p.name, path: p.path, config: await store.readConfig(p.id) });
      } catch { /* skip unreadable */ }
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifests, null, 2) }] };
  },
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[motion-studio-mcp] ready (stdio)\n');
