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
 */

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';

import { ProjectStore } from '../core/project.js';
import { JobManager } from '../core/jobs.js';
import { captureSingleFrame, renderComposition, renderParallel, renderStill } from '../core/renderer.js';
import { checkPrerequisites } from '../core/prereqs.js';
import { pathToFileURL } from 'node:url';
import { EngineError, ErrorCodes, asEngineError } from '../core/errors.js';

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

/* ------------------------------------------------------------------ */
/* Server + tools                                                      */
/* ------------------------------------------------------------------ */

const renderCompositionInjected = (o) => renderComposition({ ...o, browserFactory: injectedBrowserFactory });
const renderParallelInjected = (o) => renderParallel(o); // workers inherit the env hook

const server = new McpServer({ name: 'motion-studio', version: '0.5.0' });

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
      'register via MotionStudio.registerComposition(fn).',
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
  'capture_preview_frame',
  {
    title: 'Capture one frame as PNG',
    description:
      'Render a single frame through the REAL render path (headless Chromium, identical to the final render) ' +
      'and return the image. Use this to visually verify your composition at representative frames ' +
      '(first, midpoints, Sequence boundaries, last) BEFORE starting a full render.',
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
  'render',
  {
    title: 'Start a render job',
    description:
      'Start rendering the composition to the configured output format (mp4/webm/gif/prores/png-sequence — ' +
      'set via update_project_config). Returns a jobId immediately; poll get_render_status until state is ' +
      'done/error/cancelled. Optional frameRange renders a cheap partial segment first. If another job is ' +
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
    },
  },
  wrap(async ({ projectId, frameRange, workers, outputFilename }) => {
    await requirePrereqs();
    const entry = await store.getProjectEntry(projectId);
    const config = await store.readConfig(projectId);
    const name = outputFilename ?? config.output.filename;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'outputFilename must be a bare filename');
    }
    const outputPath = path.join(entry.path, config.output.dir, name);
    const { jobId, state, queuePosition } = jobs.startRender({
      projectId, projectPath: entry.path, config, outputPath, frameRange, workers,
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
      'if it failed. Wait for a terminal state before reporting completion.',
    inputSchema: { jobId: z.string() },
  },
  wrap(async ({ jobId }) => ok(jobs.getStatus(jobId))),
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
