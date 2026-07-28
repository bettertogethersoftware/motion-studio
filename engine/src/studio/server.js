#!/usr/bin/env node
/**
 * Motion Studio — Studio web server (new in v0.5; workspace model in v0.20).
 *
 * The human path. A local, cross-platform web UI served from this
 * zero-dependency node:http server. It is a thin shell over the same Render
 * Engine Core the CLI and the MCP server use — no render logic lives here.
 *
 *   npm run studio          # http://127.0.0.1:7345
 *   PORT=8000 npm run studio
 *
 * THE MODEL (v0.20): the Studio shows EVERY workspace (each AI's MCP server
 * is bound to one; the human sees them all). A workspace holds films; a film
 * holds scenes plus its own assets/ (master audio, overlays) and out/ (the
 * built film); a workspace also holds a LIBRARY of shared assets the human
 * uploads for that workspace's agent to use. Ids are slug paths —
 * "ws", "ws/film", "ws/film/scene" — sent URL-encoded as ONE path segment
 * (encodeURIComponent), so route shapes stay fixed-position.
 *
 * Security model: binds to 127.0.0.1 only. Every scene/film file read goes
 * through the same path sandbox as the MCP tools (path_not_allowed →
 * HTTP 403). No shell, no arbitrary-path endpoints.
 *
 * Preview fidelity: the preview iframe loads the scene's real entry HTML
 * (served from /preview/:sceneId/), i.e. the exact file Chromium renders, and
 * the UI drives it through the same window.setFrame(n) contract. What you
 * scrub is what you ship.
 *
 * API (all JSON unless noted; :fid = encoded "ws/film", :sid = encoded
 * "ws/film/scene", :tid = either — the asset/output/tts routes serve both):
 *   GET    /api/prereqs
 *   GET    /api/settings                     global settings + environment report
 *   PATCH  /api/settings                     {patch}
 *   GET    /api/vendors                      speech + music vendors: active + live status
 *   GET    /api/vendors/speech/:id/voices    ?locale=&search=&limit=&offset=
 *   POST   /api/vendors/speech/:id/preview   {text,voice,…} → audio/wav sample
 *   POST   /api/vendors/music/:id/preview    {program,drums} → audio/wav sample
 *   GET    /api/workspaces                   all workspaces, each with its films
 *   POST   /api/workspaces                   {name}
 *   GET    /api/workspaces/:ws/library       shared-asset library listing
 *   GET    /api/workspaces/:ws/library/file?path=          stream/download
 *   PUT    /api/workspaces/:ws/library/file?path=          raw-body upload (no size cap beyond 2 GB guard)
 *   DELETE /api/workspaces/:ws/library/file?path=
 *   POST   /api/workspaces/:ws/films         {name,fps?,width?,height?,durationInFrames?,slug?}
 *   GET    /api/films/:fid                   film document + resolved detail (layout, problems)
 *   PATCH  /api/films/:fid                   {patch} — scenes order/audio/overlays/captions/…
 *   DELETE /api/films/:fid?deleteFiles=1
 *   POST   /api/films/:fid/build             {outputFilename?,audioTargetPeakDb?,burnCaptions?} → job
 *   POST   /api/films/:fid/preview-audio     master mix as WAV (the build's exact ffmpeg graph)
 *   POST   /api/films/:fid/scenes            {name,fps?,…} → scaffold a scene into the film
 *   GET    /api/scenes/:sid                  config + file list
 *   PATCH  /api/scenes/:sid/config           {patch}
 *   DELETE /api/scenes/:sid?deleteFiles=1
 *   GET    /api/scenes/:sid/events           SSE: {type:"change"} on file edits (hot reload)
 *   POST   /api/scenes/:sid/render           {frameRange?,workers?} → job
 *   POST   /api/scenes/:sid/still            {frame,outputFilename?}
 *   GET    /api/{films|scenes}/:tid/outputs  list files in the out dir
 *   GET    /api/{films|scenes}/:tid/output?file=            download a rendered output / built film
 *   GET    /api/{films|scenes}/:tid/assets   list assets + audioRefs
 *   PUT    /api/{films|scenes}/:tid/asset?path=             raw-body upload into assets/
 *   GET    /api/{films|scenes}/:tid/asset?path=             stream/download an asset
 *   DELETE /api/{films|scenes}/:tid/asset?path=&updateAudio=1
 *   POST   /api/{films|scenes}/:tid/asset/rename            {from,to,updateAudio?}
 *   POST   /api/{films|scenes}/:tid/tts      {text,vendor?,voice?,sentenceTimings?,…} → WAV into assets/
 *   GET    /api/jobs                         all jobs
 *   GET    /api/jobs/:id                     status (incl. etaMs, queuePosition)
 *   GET    /api/jobs/:id/logs?tail=
 *   POST   /api/jobs/:id/cancel
 *   GET    /preview/:sid/<path>              sandboxed scene file serving (iframe)
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_ASSET_BYTES } from '../core/scene.js';
import { WorkspaceStore } from '../core/store.js';
import {
  readSettings, updateSettings, resolveFfmpegPath, withNewSceneDefaults, outputSeedFromSettings,
} from '../core/settings.js';
import {
  speechVendorReport, listSpeechVoices, synthesizeWithVendor, TTS_VENDORS, AZURE_ENV, AZURE_WAV_FORMATS,
  ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS, OPENAI_ENV, DEEPGRAM_ENV,
  resolveSpeechVendor, checkSpeechVendor, unavailableWithAlternatives,
} from '../core/tts-vendors.js';
import {
  musicVendorReport, synthesizeMusicWithVendor, demoSpec, MUSIC_VENDORS, GM_PROGRAMS,
} from '../core/music-vendors.js';
import { maskKey } from '../core/tts-azure.js';
import { PIPER_ENV } from '../core/tts-piper.js';
import {
  parseWavHeader, wavDurationSeconds, framesForDuration, measureWavLevels, splitSentences, concatWavBuffers,
} from '../core/tts.js';
import { JobManager } from '../core/jobs.js';
import { renderComposition, renderParallel, renderStill } from '../core/renderer.js';
import { checkPrerequisites, MIN_NODE, MIN_FFMPEG } from '../core/prereqs.js';
import { resolveInTarget } from '../core/sandbox.js';
import { EngineError, ErrorCodes, asEngineError } from '../core/errors.js';
import { planFilm, submitFilmBuild, toMixerTracks } from '../core/films.js';
import { mixAudioOnly } from '../core/encoder.js';

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
  [ErrorCodes.PATH_NOT_ALLOWED]: 403,
  [ErrorCodes.SCENE_NOT_FOUND]: 404,
  [ErrorCodes.WORKSPACE_NOT_FOUND]: 404,
  [ErrorCodes.JOB_NOT_FOUND]: 404,
  [ErrorCodes.FILE_NOT_FOUND]: 404,
  [ErrorCodes.INVALID_CONFIG]: 400,
  [ErrorCodes.INVALID_ID]: 400,
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
  // States the UI can act on: another render owns the lock (retry later), a
  // name that already exists (pick another).
  [ErrorCodes.RENDER_ALREADY_IN_PROGRESS]: 409,
  [ErrorCodes.SCENE_ALREADY_EXISTS]: 409,
  [ErrorCodes.FILM_ALREADY_EXISTS]: 409,
  // Films.
  [ErrorCodes.FILM_NOT_FOUND]: 404,
  [ErrorCodes.INVALID_FILM]: 400,
  [ErrorCodes.SCENE_NOT_RENDERED]: 409,
  [ErrorCodes.INCONSISTENT_SCENES]: 409,
  [ErrorCodes.NO_AUDIO_TRACKS]: 400,
  [ErrorCodes.MIGRATION_FAILED]: 500,
};

/** Preview clips are for auditioning a voice, not for rendering a script. */
const MAX_PREVIEW_CHARS = 400;

/** Library uploads are for large media; this is an abuse guard, not a policy. */
const MAX_LIBRARY_BYTES = 2 * 1024 * 1024 * 1024;

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

async function streamFile(res, absPath, { download = false, range = null } = {}) {
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
    'Cache-Control': 'no-store',
    // The film editor's preview <video> seeks scene outputs; without byte
    // ranges Chromium can only ever play them from the start.
    'Accept-Ranges': 'bytes',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(absPath)}"`;

  let status = 200;
  let readOpts;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? Math.max(0, stat.size - Number(m[2])) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    readOpts = { start, end };
  } else {
    headers['Content-Length'] = stat.size;
  }
  res.writeHead(status, headers);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absPath, readOpts);
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
 * @param {WorkspaceStore} [opts.store]
 * @param {JobManager}  [opts.jobs]
 * @param {Function}    [opts.browserFactory]  DI for tests (fake Chromium)
 */
export function createStudioServer({ store = new WorkspaceStore(), jobs = new JobManager(), browserFactory = null } = {}) {
  // Parallel renders need the factory too: workers inherit the env hook, but
  // the parent's preflight page does not — without it a fake-browser test that
  // asks for workers > 1 would reach for real Chromium (same rule as the MCP
  // server's renderParallelInjected).
  const renderFn = browserFactory
    ? (o) => (o.workers > 1
      ? renderParallel({ ...o, browserFactory })
      : renderComposition({ ...o, browserFactory }))
    : null;

  /**
   * Resolve an asset/output target — a film ("ws/film") or a scene
   * ("ws/film/scene") — to everything the shared routes need. Mirrors the
   * MCP server's describeTarget so the two surfaces cannot disagree.
   */
  const describeTarget = async (targetId) => {
    const t = await store.resolveAssetTarget(targetId);
    if (t.kind === 'scene') {
      const config = await store.readConfig(t.id);
      return { ...t, config, fps: config.fps, outDir: config.output?.dir ?? 'out', output: config.output ?? {} };
    }
    const film = await store.getFilm(t.id);
    const plan = await planFilm({ film, store });
    return { ...t, film, plan, fps: plan.fps ?? film.sceneDefaults?.fps ?? 30, outDir: 'out', output: {} };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

    try {
      // One-time legacy migration; memoized inside the store, so this is a
      // resolved promise on every request after the first.
      await store.ready();

      /* ------------------------------ static UI ------------------------------ */
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return await streamFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      if (req.method === 'GET' && parts.length === 1
          && ['app.js', 'styles.css', 'film.html', 'film.js', 'film.css'].includes(parts[0])) {
        return await streamFile(res, path.join(PUBLIC_DIR, parts[0]));
      }

      /* --------------------------- sandboxed preview ------------------------- */
      // GET /preview/:sceneId/<rel path> — serves the scene's own files so the
      // iframe renders the exact composition Chromium will render. The scene id
      // is one URL-encoded segment, so the composition's relative asset URLs
      // resolve against /preview/<id>/ unchanged.
      if (req.method === 'GET' && parts[0] === 'preview' && parts.length >= 2) {
        const scene = await store.getScene(parts[1]);
        const rel = parts.slice(2).join('/') || 'composition.html';
        const abs = resolveInTarget(scene.path, rel); // throws path_not_allowed on escape
        return await streamFile(res, abs, { range: req.headers.range });
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
            'MOTION_STUDIO_WORKSPACE',
            'PUPPETEER_EXECUTABLE_PATH',
          ];
          const settings = await readSettings(store.dataDir);
          const { path: effectiveFfmpeg, source } = await resolveFfmpegPath({ dataDir: store.dataDir });
          const probe = await checkPrerequisites({ ffmpegPath: effectiveFfmpeg });
          return sendJson(res, 200, {
            settings,
            environment: {
              dataDir: store.dataDir,
              workspacesRoot: store.workspacesRoot,
              settingsPath: path.join(store.dataDir, 'settings.json'),
              ffmpeg: { effectivePath: effectiveFfmpeg, source, ...probe.ffmpeg },
              env: {
                ...Object.fromEntries(ENV_HOOKS.map((k) => [k, process.env[k] ?? null])),
                // Vendor credentials are reported as "set, ending in …" and
                // never in full: this endpoint feeds a browser page, and a key
                // that reaches the DOM is a key in every screenshot.
                ...Object.fromEntries(
                  [...AZURE_ENV.key, ...ELEVENLABS_ENV.key, ...OPENAI_ENV.key, ...DEEPGRAM_ENV.key]
                    .map((k) => [k, maskKey(process.env[k]?.trim())]),
                ),
                ...Object.fromEntries(
                  [
                    ...AZURE_ENV.region, ...AZURE_ENV.endpoint, ...AZURE_ENV.voice,
                    ...PIPER_ENV.exe, ...PIPER_ENV.python, ...PIPER_ENV.voices,
                    ...ELEVENLABS_ENV.endpoint, ...ELEVENLABS_ENV.voice,
                    ...OPENAI_ENV.endpoint, ...OPENAI_ENV.voice,
                    ...DEEPGRAM_ENV.endpoint, ...DEEPGRAM_ENV.voice,
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
            elevenlabs: { outputFormats: ELEVENLABS_WAV_FORMATS, env: ELEVENLABS_ENV },
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
          // Like the speech preview it writes nothing into a scene: trying an
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
          // back. It is deliberately not written into a scene: auditioning a
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
              // the same rule the MCP path follows, so what the page prints
              // matches what a render would mux.
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

      /* ------------------------------ workspaces ------------------------------ */
      if (parts[1] === 'workspaces') {
        // GET /api/workspaces — the whole tree in one call: every workspace
        // with its films. This is what the rail renders from.
        if (parts.length === 2) {
          if (req.method === 'GET') {
            const workspaces = [];
            for (const ws of await store.listWorkspaces()) {
              const films = await store.listFilms(ws.id).catch(() => []);
              const library = await store.listLibrary(ws.id).catch(() => []);
              workspaces.push({
                id: ws.id, name: ws.name, path: ws.path,
                films,
                library: { files: library.length, bytes: library.reduce((n, f) => n + f.bytes, 0) },
              });
            }
            return sendJson(res, 200, { workspaces });
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            if (!String(body.name ?? '').trim()) {
              throw new EngineError(ErrorCodes.INVALID_CONFIG, 'a workspace needs a name');
            }
            const ws = await store.ensureWorkspace(body.name);
            return sendJson(res, ws.created ? 201 : 200, { workspace: ws });
          }
        }

        const wsId = parts[2];

        // Library: the human's upload surface for large shared assets.
        if (parts[3] === 'library') {
          if (req.method === 'GET' && parts.length === 4) {
            return sendJson(res, 200, { files: await store.listLibrary(wsId) });
          }
          if (parts[4] === 'file' && parts.length === 5) {
            const rel = url.searchParams.get('path') ?? '';
            if (req.method === 'GET') {
              const abs = store.libraryFilePath(wsId, rel);
              return await streamFile(res, abs, { download: url.searchParams.get('download') === '1', range: req.headers.range });
            }
            if (req.method === 'PUT') {
              const buf = await readRawBody(req, MAX_LIBRARY_BYTES);
              return sendJson(res, 201, await store.writeLibraryBuffer(wsId, rel, buf));
            }
            if (req.method === 'DELETE') {
              return sendJson(res, 200, await store.deleteLibraryFile(wsId, rel));
            }
          }
        }

        // POST /api/workspaces/:ws/films — create a film. Unset dimensions
        // fall back to global settings and become the film's sceneDefaults.
        if (req.method === 'POST' && parts[3] === 'films' && parts.length === 4) {
          const body = await readBody(req);
          const settings = await readSettings(store.dataDir);
          const { name: _n, ...sceneDefaults } = withNewSceneDefaults(settings, {
            name: body.name,
            fps: body.fps, width: body.width, height: body.height, durationInFrames: body.durationInFrames,
          });
          const film = await store.createFilm(wsId, {
            name: body.name, slug: body.slug, sceneDefaults,
            outputFilename: body.outputFilename,
          });
          return sendJson(res, 201, { film });
        }
      }

      /* ----------------------- films and scenes ------------------------------ */
      // The two resource families share their asset/output/tts routes: a film
      // id is "ws/film", a scene id "ws/film/scene", both sent as one encoded
      // path segment. parts[2] is the decoded id either way.
      const isFilmRoute = parts[1] === 'films';
      const isSceneRoute = parts[1] === 'scenes';

      if ((isFilmRoute || isSceneRoute) && parts.length >= 3) {
        const targetId = parts[2];
        const sub = parts[3];

        /* ---- film document routes ---- */
        if (isFilmRoute && parts.length === 3) {
          if (req.method === 'GET') {
            const film = await store.getFilm(targetId);
            const detail = await planFilm({ film, store });
            const scenes = await store.listScenes(film.id);
            return sendJson(res, 200, { film, detail, sceneFolders: scenes });
          }
          if (req.method === 'PATCH') {
            const { patch } = await readBody(req);
            const film = await store.updateFilm(targetId, patch ?? {});
            const detail = await planFilm({ film, store });
            return sendJson(res, 200, { film, detail });
          }
          if (req.method === 'DELETE') {
            const deleteFiles = url.searchParams.get('deleteFiles') === '1';
            return sendJson(res, 200, await store.removeFilm(targetId, { deleteFiles }));
          }
        }

        // POST /api/films/:id/scenes — scaffold a scene into the film (the
        // editor's "+ scene"). Same defaults path as the MCP create_scene.
        if (isFilmRoute && req.method === 'POST' && sub === 'scenes' && parts.length === 4) {
          const body = await readBody(req);
          const scene = await store.createScene(targetId, {
            name: body.name, slug: body.slug,
            fps: body.fps, width: body.width, height: body.height, durationInFrames: body.durationInFrames,
          });
          const settings = await readSettings(store.dataDir).catch(() => null);
          const seed = settings && outputSeedFromSettings(settings, scene.config.output);
          if (seed) scene.config = await store.updateConfig(scene.id, { output: seed });
          return sendJson(res, 201, scene);
        }

        // POST /api/films/:id/build — persist any last-minute mastering knobs,
        // then submit the assembly as a job (poll /api/jobs/:id like a render).
        if (isFilmRoute && req.method === 'POST' && sub === 'build' && parts.length === 4) {
          const body = await readBody(req);
          const patch = {};
          for (const k of ['outputFilename', 'audioTargetPeakDb', 'burnCaptions']) {
            if (body[k] !== undefined) patch[k] = body[k];
          }
          const film = Object.keys(patch).length
            ? await store.updateFilm(targetId, patch)
            : await store.getFilm(targetId);
          const submitted = await submitFilmBuild({ film, store, jobs, ffmpegPath: await ffmpegPath() });
          return sendJson(res, 202, submitted);
        }

        // POST /api/films/:id/preview-audio — the REAL master mix (gains,
        // fades, trims, ducking, limiter — the same ffmpeg graph the build
        // uses) as one WAV, so the editor auditions exactly what ships.
        // A WebAudio approximation cannot reproduce sidechain ducking.
        if (isFilmRoute && req.method === 'POST' && sub === 'preview-audio' && parts.length === 4) {
          const film = await store.getFilm(targetId);
          if (!film.audio.length) {
            throw new EngineError(ErrorCodes.NO_AUDIO_TRACKS, 'This film has no master audio tracks to preview');
          }
          const detail = await planFilm({ film, store });
          if (!detail.totalFrames || !detail.fps) {
            throw new EngineError(ErrorCodes.INVALID_FILM, 'Add at least one scene first — the mix length is the film length');
          }
          const tracks = toMixerTracks(film.audio).map((t) => {
            const abs = resolveInTarget(film.path, t.src.replace(/\\/g, '/'));
            if (!fs.existsSync(abs)) {
              throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `audio not found: ${t.src}`, { path: t.src });
            }
            return { ...t, src: abs };
          });
          const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-film-mix-'));
          const outPath = path.join(dir, 'mix.wav');
          try {
            await mixAudioOnly({
              audioTracks: tracks,
              outputPath: outPath,
              fps: detail.fps,
              assetRoot: film.path,
              output: { audioLimiter: true },
              ffmpegPath: await ffmpegPath(),
              videoDurationSec: detail.totalFrames / detail.fps,
            });
            const wav = await fsp.readFile(outPath);
            const levels = await measureWavLevels(outPath).catch(() => null);
            res.writeHead(200, {
              'Content-Type': 'audio/wav',
              'Content-Length': wav.length,
              'Cache-Control': 'no-store',
              'X-Mix-Peak-Db': String(levels?.peakDb ?? ''),
              'X-Mix-Mean-Db': String(levels?.meanDb ?? ''),
            });
            return res.end(wav);
          } finally {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
          }
        }

        /* ---- scene document routes ---- */
        if (isSceneRoute && parts.length === 3) {
          if (req.method === 'GET') {
            const scene = await store.getScene(targetId);
            const config = await store.readConfig(scene.id);
            const files = await store.listFiles(scene.id);
            return sendJson(res, 200, { id: scene.id, name: config.name, path: scene.path, config, files });
          }
          if (req.method === 'DELETE') {
            const deleteFiles = url.searchParams.get('deleteFiles') === '1';
            return sendJson(res, 200, await store.removeScene(targetId, { deleteFiles }));
          }
        }

        if (isSceneRoute && req.method === 'PATCH' && sub === 'config') {
          const { patch } = await readBody(req);
          const cur = await store.readConfig(targetId);
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
          const config = await store.updateConfig(targetId, merged);
          return sendJson(res, 200, { config });
        }

        // SSE hot-reload events
        if (isSceneRoute && req.method === 'GET' && sub === 'events') {
          const scene = await store.getScene(targetId);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          res.write('retry: 1000\n\n');
          let timer = null;
          let watcher;
          try {
            watcher = fs.watch(scene.path, { recursive: true }, (_ev, filename) => {
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

        // render / still (scenes only)
        if (isSceneRoute && req.method === 'POST' && sub === 'render') {
          const body = await readBody(req);
          const scene = await store.getScene(targetId);
          const config = await store.readConfig(scene.id);
          const outputPath = path.join(scene.path, config.output.dir, config.output.filename);
          const submitted = jobs.startRender({
            targetId: scene.id,
            scenePath: scene.path,
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
        if (isSceneRoute && req.method === 'POST' && sub === 'still') {
          const body = await readBody(req);
          const scene = await store.getScene(targetId);
          const config = await store.readConfig(scene.id);
          const frame = body.frame ?? 0;
          const name = body.outputFilename ?? `still-${frame}.png`;
          if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.png')) {
            throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, 'outputFilename must be a bare .png filename');
          }
          const result = await renderStill({
            scenePath: scene.path,
            config,
            frame,
            outputPath: path.join(scene.path, config.output.dir, name),
            ...(browserFactory ? { browserFactory } : {}),
          });
          return sendJson(res, 200, result);
        }

        /* ---- shared target routes: outputs, assets, tts ---- */

        // outputs listing / download (a film's out/ holds its builds)
        if (req.method === 'GET' && sub === 'outputs') {
          const t = await describeTarget(targetId);
          const outDir = path.join(t.path, t.outDir);
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
          return sendJson(res, 200, { dir: t.outDir, files });
        }
        if (req.method === 'GET' && sub === 'output') {
          const t = await describeTarget(targetId);
          const file = url.searchParams.get('file') ?? '';
          // Confine strictly to the out dir: path.join would collapse ".."
          // segments before the sandbox could see them.
          if (!file || file.split(/[\\/]/).some((seg) => seg === '..' || seg === '') || path.isAbsolute(file)) {
            throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, 'file must be a plain name inside the out dir');
          }
          const abs = resolveInTarget(t.path, path.posix.join(t.outDir, file));
          return await streamFile(res, abs, { download: url.searchParams.get('download') === '1', range: req.headers.range });
        }

        // assets CRUD — all paths are target-relative and confined to assets/
        // by WorkspaceStore/sandbox; the UI previews scene images through the
        // /preview/:id/ route and film assets through GET …/asset.
        if (req.method === 'GET' && sub === 'assets') {
          return sendJson(res, 200, { files: await store.listAssets(targetId) });
        }
        if (sub === 'asset' && parts.length === 4) {
          const rel = url.searchParams.get('path') ?? '';
          if (req.method === 'GET') {
            const t = await store.resolveAssetTarget(targetId);
            if (!rel.replace(/\\/g, '/').startsWith('assets/')) {
              throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Assets must live under assets/ (got "${rel}")`);
            }
            const abs = resolveInTarget(t.path, rel);
            return await streamFile(res, abs, { download: url.searchParams.get('download') === '1', range: req.headers.range });
          }
          if (req.method === 'PUT') {
            const buf = await readRawBody(req, MAX_ASSET_BYTES);
            const result = await store.writeAssetBuffer(targetId, rel, buf);
            return sendJson(res, 201, result);
          }
          if (req.method === 'DELETE') {
            const updateAudio = url.searchParams.get('updateAudio') === '1';
            return sendJson(res, 200, await store.deleteAsset(targetId, rel, { updateAudio }));
          }
        }
        if (req.method === 'POST' && sub === 'asset' && parts[4] === 'rename') {
          const { from, to, updateAudio = false } = await readBody(req);
          return sendJson(res, 200, await store.renameAsset(targetId, from, to, { updateAudio }));
        }

        // POST …/tts — synthesize narration straight into the target's
        // assets/ (asset-only; the caller decides where it sits on a
        // timeline). The film editor's "+ narration" runs through here. With
        // sentenceTimings the per-sentence offsets come back too, which is
        // what turns one narration take into a synced caption track.
        if (req.method === 'POST' && sub === 'tts' && parts.length === 4) {
          const body = await readBody(req);
          const text = String(body.text ?? '').trim();
          if (!text) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'tts needs text to speak');
          if (text.length > 20_000) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'tts text is limited to 20000 characters');

          const resolved = await resolveSpeechVendor({ vendor: body.vendor || undefined, dataDir: store.dataDir, probe: true });
          const probe = resolved.status ?? await checkSpeechVendor(resolved.vendor, { dataDir: store.dataDir });
          if (!probe.available) throw await unavailableWithAlternatives(resolved.vendor, probe, { dataDir: store.dataDir });

          const t = await describeTarget(targetId);
          const assetsDir = path.join(t.path, 'assets');
          await fsp.mkdir(assetsDir, { recursive: true });

          let rel = body.assetPath;
          if (!rel) {
            const taken = new Set(await fsp.readdir(assetsDir).catch(() => []));
            let n = 1;
            while (taken.has(`narration-${n}.wav`)) n++;
            rel = `assets/narration-${n}.wav`;
          }
          const normalized = String(rel).replace(/\\/g, '/');
          if (!normalized.startsWith('assets/')) {
            throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Narration must be written under assets/ (got "${rel}")`);
          }
          const abs = resolveInTarget(t.path, normalized, { forWrite: true, asAsset: true });

          const common = {
            voice: body.voice || undefined, rate: body.rate ?? undefined,
            volume: body.volume ?? undefined, style: body.style || undefined,
            deterministic: body.deterministic ?? undefined,
            dataDir: store.dataDir, resolved,
          };
          const sentences = body.sentenceTimings ? splitSentences(text) : null;
          const gapSeconds = Math.min(5, Math.max(0, Number(body.sentenceGapSeconds ?? 0.3)));
          let result;
          let timings = null;
          if (sentences && sentences.length > 1) {
            const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-studio-tts-'));
            try {
              const clips = [];
              for (let i = 0; i < sentences.length; i++) {
                const clipPath = path.join(dir, `sentence-${i}.wav`);
                result = await synthesizeWithVendor({ ...common, text: sentences[i], outPath: clipPath, sentenceSilence: 0 });
                clips.push(await fsp.readFile(clipPath));
              }
              const joined = concatWavBuffers(clips, { gapSeconds });
              await fsp.writeFile(abs, joined.buffer);
              timings = joined.segments.map((seg, i) => ({
                text: sentences[i],
                startSeconds: seg.startSeconds,
                startInFrames: Math.round(seg.startSeconds * t.fps),
                durationSeconds: seg.durationSeconds,
                durationInFrames: framesForDuration(seg.durationSeconds, t.fps),
              }));
            } finally {
              await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          } else {
            result = await synthesizeWithVendor({ ...common, text, outPath: abs });
          }

          const stat = await fsp.stat(abs).catch(() => null);
          if (!stat || stat.size === 0) {
            throw new EngineError(ErrorCodes.TTS_FAILED, `Speech engine reported success but no audio was written to ${normalized}`);
          }
          const durationSeconds = await wavDurationSeconds(abs);
          const durationInFrames = framesForDuration(durationSeconds, t.fps);
          const levels = await measureWavLevels(abs).catch(() => ({ peakDb: null, meanDb: null }));
          if (sentences && !timings) {
            timings = [{
              text: sentences[0], startSeconds: 0, startInFrames: 0,
              durationSeconds: Number(durationSeconds.toFixed(4)), durationInFrames,
            }];
          }
          return sendJson(res, 201, {
            assetPath: normalized,
            vendor: result.vendor,
            voice: result.voice ?? body.voice ?? null,
            durationSeconds,
            durationInFrames,
            fps: t.fps,
            bytes: stat.size,
            peakDb: levels.peakDb,
            meanDb: levels.meanDb,
            ...(timings ? { timings } : {}),
          });
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
