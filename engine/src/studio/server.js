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
 *   GET    /api/settings                     global settings + environment report (v0.15)
 *   PATCH  /api/settings                     {patch} — newProjectDefaults / render / ffmpeg / tts
 *   GET    /api/vendors                      speech + music vendors: active + live status (v0.17)
 *   GET    /api/vendors/speech/:id/voices    ?locale=&search=&limit=&offset=  (v0.17)
 *   POST   /api/vendors/speech/:id/preview   {text,voice,…} → audio/wav sample (v0.17)
 *   POST   /api/vendors/music/:id/preview    {program,drums} → audio/wav sample (v0.17)
 *   GET    /api/projects
 *   POST   /api/projects                     {name,fps?,width?,height?,durationInFrames?}
 *                                            (unset fields fall back to settings.newProjectDefaults)
 *   GET    /api/projects/:id                 config + file list
 *   PATCH  /api/projects/:id/config          {patch}
 *   DELETE /api/projects/:id?deleteFiles=1
 *   GET    /api/projects/:id/events          SSE: {type:"change"} on file edits (hot reload)
 *   GET    /api/projects/:id/outputs         list files in the out dir
 *   GET    /api/projects/:id/output?file=    download a rendered output
 *   GET    /api/projects/:id/assets          list files under assets/ + audioRefs (v0.15)
 *   PUT    /api/projects/:id/asset?path=     raw-body upload into assets/ (v0.15)
 *   GET    /api/projects/:id/asset?path=     stream/download an asset (v0.15)
 *   DELETE /api/projects/:id/asset?path=     delete an asset; &updateAudio=1 also
 *                                            drops config.audio tracks using it (v0.15)
 *   POST   /api/projects/:id/asset/rename    {from,to,updateAudio?} within assets/ (v0.15)
 *   POST   /api/projects/:id/render          {frameRange?,workers?} → job
 *   POST   /api/projects/:id/still           {frame,outputFilename?}
 *   GET    /api/jobs                         all jobs
 *   GET    /api/jobs/:id                     status (incl. etaMs, queuePosition)
 *   GET    /api/jobs/:id/logs?tail=
 *   POST   /api/jobs/:id/cancel
 *   GET    /preview/:id/<path>               sandboxed project file serving (iframe)
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ProjectStore, MAX_ASSET_BYTES } from '../core/project.js';
import {
  readSettings, updateSettings, resolveFfmpegPath, withNewProjectDefaults, outputSeedFromSettings,
} from '../core/settings.js';
import {
  speechVendorReport, listSpeechVoices, synthesizeWithVendor, TTS_VENDORS, AZURE_ENV, AZURE_WAV_FORMATS,
} from '../core/tts-vendors.js';
import {
  musicVendorReport, synthesizeMusicWithVendor, demoSpec, MUSIC_VENDORS, GM_PROGRAMS,
} from '../core/music-vendors.js';
import { maskKey } from '../core/tts-azure.js';
import { PIPER_ENV } from '../core/tts-piper.js';
import { parseWavHeader } from '../core/tts.js';
import { JobManager } from '../core/jobs.js';
import { renderComposition, renderParallel, renderStill } from '../core/renderer.js';
import { checkPrerequisites, MIN_NODE, MIN_FFMPEG } from '../core/prereqs.js';
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
  // Speech vendors (v0.17): an unconfigured vendor is a 503 like any missing
  // prerequisite; a bad voice is the caller's fault; a failed synthesis is an
  // upstream failure.
  [ErrorCodes.TTS_UNAVAILABLE]: 503,
  [ErrorCodes.UNSUPPORTED_VOICE]: 400,
  [ErrorCodes.TTS_FAILED]: 502,
  // Music vendors: same taxonomy as speech, so the vendors page reports "not
  // configured" (503) instead of a generic 500 when a preview fails.
  [ErrorCodes.MUSIC_UNAVAILABLE]: 503,
  [ErrorCodes.INVALID_MUSIC_SPEC]: 400,
  [ErrorCodes.MUSIC_FAILED]: 502,
  // Two states the UI can act on: another render owns the lock (retry later),
  // and a project name that already exists (pick another).
  [ErrorCodes.RENDER_ALREADY_IN_PROGRESS]: 409,
  [ErrorCodes.PROJECT_ALREADY_EXISTS]: 409,
};

/** Preview clips are for auditioning a voice, not for rendering a script. */
const MAX_PREVIEW_CHARS = 400;

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

/** Collect a raw (binary) request body — asset uploads bypass JSON/base64. */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new EngineError(ErrorCodes.ASSET_TOO_LARGE, `upload exceeds ${limit} bytes`, { maxBytes: limit }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
  // Parallel renders need the factory too: workers inherit the env hook, but
  // the parent's preflight page does not — without it a fake-browser test that
  // asks for workers > 1 would reach for real Chromium (same rule as the MCP
  // server's renderParallelInjected).
  const renderFn = browserFactory
    ? (o) => (o.workers > 1
      ? renderParallel({ ...o, browserFactory })
      : renderComposition({ ...o, browserFactory }))
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

      // Effective ffmpeg binary — resolved by the shared rule (see core/settings.js).
      const ffmpegPath = async () => (await resolveFfmpegPath({ dataDir: store.dataDir })).path;

      // GET /api/prereqs — the ffmpeg block names the binary that was actually
      // probed and where that path came from, so a failure can be reported as
      // "not found at <path> (from settings)" rather than an anonymous
      // "prerequisites missing".
      if (req.method === 'GET' && parts[1] === 'prereqs' && parts.length === 2) {
        const { path: effectivePath, source } = await resolveFfmpegPath({ dataDir: store.dataDir });
        const prereqs = await checkPrerequisites({ ffmpegPath: effectivePath });
        return sendJson(res, 200, {
          ...prereqs,
          minimums: { node: MIN_NODE.join('.'), ffmpeg: MIN_FFMPEG.join('.') },
          ffmpeg: { ...prereqs.ffmpeg, effectivePath, source },
        });
      }

      // /api/settings — global settings + a read-only environment report so
      // the UI has one place that answers "where does everything live".
      if (parts[1] === 'settings' && parts.length === 2) {
        if (req.method === 'GET') {
          const ENV_HOOKS = [
            'MOTION_STUDIO_HOME', 'MOTION_STUDIO_FFMPEG', 'MOTION_STUDIO_TTS_EXE',
            'MOTION_STUDIO_MIDI_EXE',
            'MOTION_STUDIO_FLUIDSYNTH', 'MOTION_STUDIO_SOUNDFONT', 'MOTION_STUDIO_LIBS_DIR',
            'MOTION_STUDIO_ALLOW_LOCAL_FETCH', 'MOTION_STUDIO_MAX_RENDERS',
            'PUPPETEER_EXECUTABLE_PATH',
          ];
          const settings = await readSettings(store.dataDir);
          const { path: effectiveFfmpeg, source } = await resolveFfmpegPath({ dataDir: store.dataDir });
          const probe = await checkPrerequisites({ ffmpegPath: effectiveFfmpeg });
          return sendJson(res, 200, {
            settings,
            environment: {
              dataDir: store.dataDir,
              projectsRoot: store.projectsRoot,
              registryPath: store.registryPath,
              settingsPath: path.join(store.dataDir, 'settings.json'),
              ffmpeg: { effectivePath: effectiveFfmpeg, source, ...probe.ffmpeg },
              env: {
                ...Object.fromEntries(ENV_HOOKS.map((k) => [k, process.env[k] ?? null])),
                // Vendor credentials are reported as "set, ending in …" and
                // never in full: this endpoint feeds a browser page, and a key
                // that reaches the DOM is a key in every screenshot.
                ...Object.fromEntries(AZURE_ENV.key.map((k) => [k, maskKey(process.env[k]?.trim())])),
                ...Object.fromEntries(
                  [
                    ...AZURE_ENV.region, ...AZURE_ENV.endpoint, ...AZURE_ENV.voice,
                    ...PIPER_ENV.exe, ...PIPER_ENV.python, ...PIPER_ENV.voices,
                    'MOTION_STUDIO_TTS_VENDOR', 'MOTION_STUDIO_MUSIC_VENDOR',
                  ].map((k) => [k, process.env[k] ?? null]),
                ),
              },
            },
          });
        }
        if (req.method === 'PATCH') {
          const { patch } = await readBody(req);
          return sendJson(res, 200, { settings: await updateSettings(patch ?? {}, store.dataDir) });
        }
      }

      /* -------------------------------- vendors ------------------------------ */
      // v0.17. The vendors page is the human half of core/vendors.js: pick which
      // vendor narrates and which renders music, configure the non-secret half
      // of each, browse voices/instruments, and hear one before committing a
      // render to it.
      if (parts[1] === 'vendors') {
        // GET /api/vendors — status of every vendor in both capabilities.
        // ?probe=0 answers from configuration alone (no exe spawn, no network).
        if (req.method === 'GET' && parts.length === 2) {
          const probe = url.searchParams.get('probe') !== '0';
          const force = url.searchParams.get('force') === '1';
          const [speech, music] = await Promise.all([
            speechVendorReport({ dataDir: store.dataDir, probe, force }),
            musicVendorReport({ dataDir: store.dataDir, probe }),
          ]);
          return sendJson(res, 200, {
            speech,
            music,
            azure: { outputFormats: AZURE_WAV_FORMATS, env: AZURE_ENV },
            gmPrograms: GM_PROGRAMS,
          });
        }

        /* --------------------------- music vendors --------------------------- */
        if (parts[2] === 'music' && parts.length >= 4) {
          const vendor = parts[3];
          if (!MUSIC_VENDORS.includes(vendor)) {
            throw new EngineError(
              ErrorCodes.INVALID_CONFIG,
              `Unknown music vendor "${vendor}" — expected one of: ${MUSIC_VENDORS.join(', ')}`,
              { vendor, allowed: MUSIC_VENDORS },
            );
          }
          // POST …/preview — render the demo phrase and stream the WAV back.
          // Like the speech preview it writes nothing into a project: trying an
          // instrument out must not litter assets/ with take-1 files.
          if (req.method === 'POST' && parts[4] === 'preview' && parts.length === 5) {
            const body = await readBody(req);
            const program = Number(body.program ?? 0);
            if (!Number.isInteger(program) || program < 0 || program > 127) {
              throw new EngineError(ErrorCodes.INVALID_CONFIG, 'program must be a General MIDI number 0..127');
            }
            const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-music-preview-'));
            const outPath = path.join(dir, 'preview.wav');
            try {
              const result = await synthesizeMusicWithVendor({
                vendor,
                spec: demoSpec({ program, drums: body.drums === true }),
                outPath,
                dataDir: store.dataDir,
              });
              const wav = await fsp.readFile(outPath);
              const { dataSize, byteRate } = parseWavHeader(wav, outPath);
              res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': wav.length,
                'Cache-Control': 'no-store',
                'X-Music-Vendor': result.vendor,
                'X-Music-Peak-Db': String(result.peakDb ?? ''),
                'X-Music-Duration': (dataSize / byteRate).toFixed(3),
              });
              return res.end(wav);
            } finally {
              await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }

        /* --------------------------- speech vendors -------------------------- */
        if (parts[2] === 'speech' && parts.length >= 4) {
          const vendor = parts[3];
          if (!TTS_VENDORS.includes(vendor)) {
            throw new EngineError(
              ErrorCodes.INVALID_CONFIG,
              `Unknown speech vendor "${vendor}" — expected one of: ${TTS_VENDORS.join(', ')}`,
              { vendor, allowed: TTS_VENDORS },
            );
          }

          // GET …/voices — the catalogue, filtered. Azure ships several hundred
          // voices, so paging is the default rather than an afterthought.
          if (req.method === 'GET' && parts[4] === 'voices' && parts.length === 5) {
            const limit = Number(url.searchParams.get('limit')) || 0;
            const offset = Number(url.searchParams.get('offset')) || 0;
            return sendJson(res, 200, await listSpeechVoices({
              vendor,
              locale: url.searchParams.get('locale') ?? undefined,
              search: url.searchParams.get('search') ?? undefined,
              limit, offset,
              dataDir: store.dataDir,
              force: url.searchParams.get('force') === '1',
            }));
          }

          // POST …/preview — synthesize a sample and stream the WAV straight
          // back. It is deliberately not written into a project: auditioning a
          // voice must not litter assets/ with take-1 files.
          if (req.method === 'POST' && parts[4] === 'preview' && parts.length === 5) {
            const body = await readBody(req);
            const text = String(body.text ?? '').trim();
            if (!text) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'preview needs some text to speak');
            if (text.length > MAX_PREVIEW_CHARS) {
              throw new EngineError(
                ErrorCodes.INVALID_CONFIG,
                `preview text is limited to ${MAX_PREVIEW_CHARS} characters (got ${text.length})`,
                { maxChars: MAX_PREVIEW_CHARS },
              );
            }
            const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-voice-preview-'));
            const outPath = path.join(dir, 'preview.wav');
            try {
              const result = await synthesizeWithVendor({
                vendor, text, outPath,
                voice: body.voice || undefined,
                rate: body.rate ?? undefined,
                volume: body.volume ?? undefined,
                style: body.style || undefined,
                dataDir: store.dataDir,
              });
              const wav = await fsp.readFile(outPath);
              // Duration from the WAV header, not the vendor's self-report —
              // the same rule synthesize_speech follows, so what the page
              // prints matches what a render would mux.
              const { dataSize, byteRate } = parseWavHeader(wav, outPath);
              res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': wav.length,
                'Cache-Control': 'no-store',
                // The player needs the bytes; the page also wants to print
                // which voice actually spoke and how long the take is.
                'X-Speech-Vendor': result.vendor,
                'X-Speech-Voice': encodeURIComponent(result.voice ?? ''),
                'X-Speech-Duration': (dataSize / byteRate).toFixed(3),
              });
              return res.end(wav);
            } finally {
              await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      }

      // /api/projects...
      if (parts[1] === 'projects') {
        if (parts.length === 2) {
          if (req.method === 'GET') return sendJson(res, 200, { projects: await store.listProjects() });
          if (req.method === 'POST') {
            const body = await readBody(req);
            // Unset fields fall back to the user's global defaults. Shared with
            // the MCP server so the two cannot disagree about what "global" means.
            const settings = await readSettings(store.dataDir);
            const proj = await store.createProject(withNewProjectDefaults(settings, body));
            const seed = outputSeedFromSettings(settings, proj.config.output);
            if (seed) proj.config = await store.updateConfig(proj.id, { output: seed });
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
          if (merged.output) {
            merged.output = { ...cur.output, ...merged.output };
            // An omitted key keeps its current value through the merge, so
            // null is how a caller says "remove this and use the format's
            // default" (e.g. clearing an x264 preset).
            for (const [k, v] of Object.entries(merged.output)) {
              if (v === null) delete merged.output[k];
            }
          }
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

        // assets CRUD (v0.15) — all paths are project-relative and confined
        // to assets/ by ProjectStore/sandbox; the UI previews images through
        // the existing /preview/:id/ route.
        if (req.method === 'GET' && parts[3] === 'assets') {
          return sendJson(res, 200, { files: await store.listAssets(projectId) });
        }
        if (parts[3] === 'asset' && parts.length === 4) {
          const rel = url.searchParams.get('path') ?? '';
          if (req.method === 'GET') {
            const entry = await store.getProjectEntry(projectId);
            if (!rel.replace(/\\/g, '/').startsWith('assets/')) {
              throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, `Assets must live under assets/ (got "${rel}")`);
            }
            const abs = resolveInProject(entry.path, rel);
            return await streamFile(res, abs, { download: url.searchParams.get('download') === '1' });
          }
          if (req.method === 'PUT') {
            const buf = await readRawBody(req, MAX_ASSET_BYTES);
            const result = await store.writeAssetBuffer(projectId, rel, buf);
            return sendJson(res, 201, result);
          }
          if (req.method === 'DELETE') {
            const updateAudio = url.searchParams.get('updateAudio') === '1';
            return sendJson(res, 200, await store.deleteAsset(projectId, rel, { updateAudio }));
          }
        }
        if (req.method === 'POST' && parts[3] === 'asset' && parts[4] === 'rename') {
          const { from, to, updateAudio = false } = await readBody(req);
          return sendJson(res, 200, await store.renameAsset(projectId, from, to, { updateAudio }));
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
            // The UI seeds its form from the global default, but a direct API
            // caller may omit it — fall back here so both paths agree with MCP.
            workers: body.workers ?? (await readSettings(store.dataDir)).render.defaultWorkers,
            ffmpegPath: await ffmpegPath(),
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
