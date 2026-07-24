#!/usr/bin/env node
/**
 * Motion Studio — Studio web server (new in v0.5).
 *
 * The human path. Replaces the v0.2 Windows-only WinForms app with a local,
 * cross-platform web UI served from this zero-dependency node:http server
 * (rationale in docs/CHANGELOG.md). It is a thin shell over the same Render
 * Engine Core the CLI and the MCP server use — no render logic lives here.
 *
 *   npm run studio          # http://127.0.0.1:7345
 *   PORT=8000 npm run studio
 *
 * Security model: binds to 127.0.0.1 only. Every project-file read goes
 * through the same path sandbox as the MCP tools (path_outside_project →
 * HTTP 403). No shell, no arbitrary-path endpoints.
 *
 * Preview fidelity: the preview iframe loads the project's real entry HTML
 * (served from /preview/:id/), i.e. the exact file Chromium renders, and the
 * UI drives it through the same window.setFrame(n) contract. What you scrub
 * is what you ship.
 *
 * API (all JSON unless noted):
 *   GET    /api/prereqs
 *   GET    /api/projects
 *   POST   /api/projects                     {name,fps,width,height,durationInFrames}
 *   GET    /api/projects/:id                 config + file list
 *   PATCH  /api/projects/:id/config          {patch}
 *   DELETE /api/projects/:id?deleteFiles=1
 *   GET    /api/projects/:id/events          SSE: {type:"change"} on file edits (hot reload)
 *   GET    /api/projects/:id/outputs         list files in the out dir
 *   GET    /api/projects/:id/output?file=    download a rendered output
 *   POST   /api/projects/:id/render          {frameRange?,workers?} → job
 *   POST   /api/projects/:id/still           {frame,outputFilename?}
 *   GET    /api/jobs                         all jobs
 *   GET    /api/jobs/:id                     status (incl. etaMs, queuePosition)
 *   GET    /api/jobs/:id/logs?tail=
 *   POST   /api/jobs/:id/cancel
 *   GET    /preview/:id/<path>               sandboxed project file serving (iframe)
 */

import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ProjectStore } from '../core/project.js';
import { JobManager } from '../core/jobs.js';
import { renderComposition, renderParallel, renderStill } from '../core/renderer.js';
import { checkPrerequisites } from '../core/prereqs.js';
import { resolveInProject } from '../core/sandbox.js';
import { EngineError, ErrorCodes, asEngineError } from '../core/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const STATUS_FOR_CODE = {
  [ErrorCodes.PATH_OUTSIDE_PROJECT]: 403,
  [ErrorCodes.PROJECT_NOT_FOUND]: 404,
  [ErrorCodes.JOB_NOT_FOUND]: 404,
  [ErrorCodes.FILE_NOT_FOUND]: 404,
  [ErrorCodes.INVALID_CONFIG]: 400,
  [ErrorCodes.SYNTAX_ERROR]: 400,
  [ErrorCodes.UNSUPPORTED_FORMAT]: 400,
  [ErrorCodes.ASSET_TOO_LARGE]: 413,
  [ErrorCodes.QUEUE_FULL]: 429,
  [ErrorCodes.PREREQS_MISSING]: 503,
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, err) {
  const e = asEngineError(err);
  sendJson(res, STATUS_FOR_CODE[e.code] ?? 500, e.toJSON());
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new EngineError(ErrorCodes.INVALID_CONFIG, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new EngineError(ErrorCodes.INVALID_CONFIG, `request body is not valid JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function streamFile(res, absPath, { download = false } = {}) {
  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such file: ${path.basename(absPath)}`);
  }
  if (!stat.isFile()) throw new EngineError(ErrorCodes.FILE_NOT_FOUND, 'Not a file');
  const ext = path.extname(absPath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(absPath)}"`;
  res.writeHead(200, headers);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absPath);
    stream.pipe(res);
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
  });
}

/**
 * Create (but do not listen) the Studio HTTP server. Exported for tests.
 *
 * @param {object} [opts]
 * @param {ProjectStore} [opts.store]
 * @param {JobManager}  [opts.jobs]
 * @param {Function}    [opts.browserFactory]  DI for tests (fake Chromium)
 */
export function createStudioServer({ store = new ProjectStore(), jobs = new JobManager(), browserFactory = null } = {}) {
  const renderFn = browserFactory
    ? (o) => (o.workers > 1 ? renderParallel(o) : renderComposition({ ...o, browserFactory }))
    : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      /* ------------------------------ static UI ------------------------------ */
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return await streamFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      if (req.method === 'GET' && parts.length === 1 && ['app.js', 'styles.css'].includes(parts[0])) {
        return await streamFile(res, path.join(PUBLIC_DIR, parts[0]));
      }

      /* --------------------------- sandboxed preview ------------------------- */
      // GET /preview/:id/<rel path> — serves the project's own files so the
      // iframe renders the exact composition Chromium will render.
      if (req.method === 'GET' && parts[0] === 'preview' && parts.length >= 2) {
        const entry = await store.getProjectEntry(parts[1]);
        const rel = decodeURIComponent(parts.slice(2).join('/')) || 'composition.html';
        const abs = resolveInProject(entry.path, rel); // throws path_outside_project on escape
        return await streamFile(res, abs);
      }

      /* -------------------------------- API ---------------------------------- */
      if (parts[0] !== 'api') {
        return sendJson(res, 404, { error: 'not_found' });
      }

      // GET /api/prereqs
      if (req.method === 'GET' && parts[1] === 'prereqs' && parts.length === 2) {
        return sendJson(res, 200, await checkPrerequisites());
      }

      // /api/projects...
      if (parts[1] === 'projects') {
        if (parts.length === 2) {
          if (req.method === 'GET') return sendJson(res, 200, { projects: await store.listProjects() });
          if (req.method === 'POST') {
            const body = await readBody(req);
            const proj = await store.createProject(body);
            return sendJson(res, 201, proj);
          }
        }
        const projectId = parts[2];

        if (parts.length === 3) {
          if (req.method === 'GET') {
            const entry = await store.getProjectEntry(projectId);
            const config = await store.readConfig(projectId);
            const files = await store.listFiles(projectId);
            return sendJson(res, 200, { id: entry.id, name: entry.name, path: entry.path, config, files });
          }
          if (req.method === 'DELETE') {
            const deleteFiles = url.searchParams.get('deleteFiles') === '1';
            return sendJson(res, 200, await store.removeProject(projectId, { deleteFiles }));
          }
        }

        if (req.method === 'PATCH' && parts[3] === 'config') {
          const { patch } = await readBody(req);
          const cur = await store.readConfig(projectId);
          const merged = { ...patch };
          if (merged.output) merged.output = { ...cur.output, ...merged.output };
          const config = await store.updateConfig(projectId, merged);
          return sendJson(res, 200, { config });
        }

        // SSE hot-reload events
        if (req.method === 'GET' && parts[3] === 'events') {
          const entry = await store.getProjectEntry(projectId);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          res.write('retry: 1000\n\n');
          let timer = null;
          let watcher;
          try {
            watcher = fs.watch(entry.path, { recursive: true }, (_ev, filename) => {
              if (filename && (filename.startsWith('out') || filename.includes('.tmp-'))) return; // ignore render outputs
              clearTimeout(timer);
              timer = setTimeout(() => {
                res.write(`data: ${JSON.stringify({ type: 'change', file: filename ?? null })}\n\n`);
              }, 120); // debounce editor save bursts
            });
          } catch {
            // recursive fs.watch unavailable on some platforms — degrade to no hot reload
          }
          const ping = setInterval(() => res.write(': ping\n\n'), 15000);
          req.on('close', () => {
            clearInterval(ping);
            clearTimeout(timer);
            watcher?.close();
          });
          return;
        }

        // outputs listing / download
        if (req.method === 'GET' && parts[3] === 'outputs') {
          const entry = await store.getProjectEntry(projectId);
          const config = await store.readConfig(projectId);
          const outDir = path.join(entry.path, config.output.dir);
          let files = [];
          try {
            const names = await fsp.readdir(outDir);
            files = (
              await Promise.all(
                names.map(async (n) => {
                  const st = await fsp.stat(path.join(outDir, n)).catch(() => null);
                  if (!st) return null;
                  return { name: n, bytes: st.isFile() ? st.size : null, dir: st.isDirectory(), mtime: st.mtime.toISOString() };
                }),
              )
            ).filter(Boolean);
          } catch { /* out dir not created yet */ }
          files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
          return sendJson(res, 200, { dir: config.output.dir, files });
        }
        if (req.method === 'GET' && parts[3] === 'output') {
          const entry = await store.getProjectEntry(projectId);
          const config = await store.readConfig(projectId);
          const file = url.searchParams.get('file') ?? '';
          // Confine strictly to the out dir: path.join would collapse ".."
          // segments before the sandbox could see them.
          if (!file || file.split(/[\\/]/).some((seg) => seg === '..' || seg === '') || path.isAbsolute(file)) {
            throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'file must be a plain name inside the out dir');
          }
          const abs = resolveInProject(entry.path, path.posix.join(config.output.dir, file));
          return await streamFile(res, abs, { download: url.searchParams.get('download') === '1' });
        }

        // render / still
        if (req.method === 'POST' && parts[3] === 'render') {
          const body = await readBody(req);
          const entry = await store.getProjectEntry(projectId);
          const config = await store.readConfig(projectId);
          const outputPath = path.join(entry.path, config.output.dir, config.output.filename);
          const submitted = jobs.startRender({
            projectId,
            projectPath: entry.path,
            config,
            outputPath,
            frameRange: body.frameRange,
            workers: body.workers,
            ...(renderFn ? { renderFn } : {}),
          });
          return sendJson(res, 202, { ...submitted, outputPath });
        }
        if (req.method === 'POST' && parts[3] === 'still') {
          const body = await readBody(req);
          const entry = await store.getProjectEntry(projectId);
          const config = await store.readConfig(projectId);
          const frame = body.frame ?? 0;
          const name = body.outputFilename ?? `still-${frame}.png`;
          if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.png')) {
            throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'outputFilename must be a bare .png filename');
          }
          const result = await renderStill({
            projectPath: entry.path,
            config,
            frame,
            outputPath: path.join(entry.path, config.output.dir, name),
            ...(browserFactory ? { browserFactory } : {}),
          });
          return sendJson(res, 200, result);
        }
      }

      // /api/jobs...
      if (parts[1] === 'jobs') {
        if (req.method === 'GET' && parts.length === 2) return sendJson(res, 200, { jobs: jobs.listJobs() });
        const jobId = parts[2];
        if (req.method === 'GET' && parts.length === 3) return sendJson(res, 200, jobs.getStatus(jobId));
        if (req.method === 'GET' && parts[3] === 'logs') {
          const tail = Number(url.searchParams.get('tail')) || 100;
          return sendJson(res, 200, { jobId, logs: jobs.getLogs(jobId, { tail }) });
        }
        if (req.method === 'POST' && parts[3] === 'cancel') return sendJson(res, 200, jobs.cancel(jobId));
      }

      return sendJson(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      if (!res.headersSent) return sendError(res, err);
      res.destroy();
    }
  });

  return server;
}

/* --------------------------- direct execution --------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Same DI hook as the CLI and MCP server, for parity when testing manually.
  let browserFactory = null;
  if (process.env.MOTION_STUDIO_BROWSER_MODULE) {
    const mod = await import(pathToFileURL(path.resolve(process.env.MOTION_STUDIO_BROWSER_MODULE)).href);
    browserFactory = mod.createBrowser;
  }
  const port = Number(process.env.PORT) || 7345;
  const host = '127.0.0.1'; // local tool: never expose on the network
  const server = createStudioServer({ browserFactory });
  server.listen(port, host, () => {
    process.stderr.write(`[motion-studio] Studio running at http://${host}:${port}\n`);
  });
}
