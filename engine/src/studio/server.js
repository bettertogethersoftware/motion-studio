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
 *   GET    /api/vendors                      speech + music + transcription vendors: active + live status
 *   GET    /api/vendors/speech/:id/voices    ?locale=&search=&limit=&offset=
 *   POST   /api/vendors/speech/:id/preview   {text,voice,…} → audio/wav sample
 *   POST   /api/vendors/music/:id/preview    {program,drums} → audio/wav sample
 *   POST   /api/vendors/transcription/:id/preview?name=  raw media body → transcript JSON
 *   GET    /api/workspaces                   all workspaces, each with its films
 *   POST   /api/workspaces                   {name}
 *   GET    /api/workspaces/:ws/library       shared-asset library listing
 *   GET    /api/workspaces/:ws/library/file?path=          stream/download
 *   PUT    /api/workspaces/:ws/library/file?path=          raw-body upload (no size cap beyond 2 GB guard)
 *   DELETE /api/workspaces/:ws/library/file?path=
 *   POST   /api/workspaces/:ws/films         {name,fps?,width?,height?,durationInFrames?,slug?,deliverables?}
 *   GET    /api/films/:fid                   film document + resolved detail (layout, problems)
 *   PATCH  /api/films/:fid                   {patch} — scenes order/audio/overlays/captions/…
 *   DELETE /api/films/:fid?deleteFiles=1
 *   POST   /api/films/:fid/build             {outputFilename?,audioTargetPeakDb?,burnCaptions?,deliverable?} → job
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
 *   GET    /api/{films|scenes}/:tid/probe?path=            one asset's media properties
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
 *
 * The production loop (v0.23 — AI-directed, human-advised). These feed the
 * ONE film page: there is no separate review route or review document.
 *   GET    /api/films/:fid/overview          one-call film-page snapshot (doc, plan,
 *                                            deliveries, advice, revisions, status)
 *   GET    /api/films/:fid/status            production status projection
 *   GET    /api/films/:fid/deliveries        archived immutable builds + current
 *   GET    /api/films/:fid/deliveries/:did          frozen manifest
 *   GET    /api/films/:fid/deliveries/:did/file     pinned playback video (ranges)
 *   GET    /api/films/:fid/deliveries/:did/contact  contact sheet PNG
 *   GET    /api/films/:fid/resolve?frame=&delivery= film frame → scene/sequence/
 *                                            revision/track items, via the manifest
 *   POST   /api/films/:fid/advice            {message,target?,observation?,…} → receipt
 *                                            (evidence captured asynchronously)
 *   GET    /api/films/:fid/advice?status=&scene=&…  list + summary
 *   GET    /api/films/:fid/advice/:aid              request+state+events+resolution
 *   GET    /api/films/:fid/advice/:aid/evidence/:which  before/after PNG
 *   GET    /api/scenes/:sid/revisions        immutable revision history
 *   GET    /api/scenes/:sid/revisions/:rid/file     archived output (ranges)
 *   GET    /api/scenes/:sid/revisions/:rid/contact  archived contact sheet
 *   POST   /api/scenes/:sid/revisions/:rid/prefer   "Ask AI to use this version"
 *                                            → prefer-revision ADVICE (never a direct switch)
 *   GET    /api/workspaces/:ws/activity      agent heartbeats
 *   GET    /api/events                       SSE production stream (Last-Event-ID replay)
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
  readSettings, updateSettings, resolveFfmpegPath, resolveFfprobePath,
  withNewSceneDefaults, outputSeedFromSettings, DEFAULT_SETTINGS,
} from '../core/settings.js';
import {
  resolvePaths, updateLocations, ensureStableDataDir, PATH_KEYS, PATH_ENV, APP_DATA_DIR,
} from '../core/paths.js';
import { TTS_VENDORS, MUSIC_VENDORS, TRANSCRIPTION_VENDORS } from '../core/settings.js';
import { AZURE_ENV, AZURE_WAV_FORMATS } from '../vendors/default/speech/azure.js';
import { ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS } from '../vendors/default/speech/elevenlabs.js';
import { OPENAI_ENV } from '../vendors/default/speech/openai.js';
import { DEEPGRAM_ENV } from '../vendors/default/speech/deepgram.js';
import { WHISPER_ENV, MODEL_PREFERENCE } from '../vendors/default/transcription/whisper-cpp.js';
import { demoSpec, GM_PROGRAMS } from '../core/music-vendors.js';

/* ------------------------------------------------------------------ */
/* The vendor runtime (Slice A-6b) — the Studio is a compatibility     */
/* consumer of the SAME injected runtime the MCP entrypoint builds     */
/* (vendor-boundary plan Phase 4), so the two can never drift apart.   */
/* Same dynamic, failure-tolerant construction: a core-only install    */
/* still serves every non-audio page; the vendor pages report the      */
/* structured unavailable error instead of the server failing to load. */
/* Historical local names keep every route handler unchanged.          */
/* ------------------------------------------------------------------ */

let vendorRuntime = null;
let vendorRuntimeError = null;
try {
  const { createDefaultRuntime } = await import('../vendors/default/registry.js');
  vendorRuntime = createDefaultRuntime();
} catch (e) {
  vendorRuntimeError = e;
}

const missingRuntime = (capability, code) => async () => {
  throw new EngineError(
    code,
    `The ${capability} vendor runtime is not installed (the default vendor package could not be loaded: ` +
    `${vendorRuntimeError?.message ?? 'vendors/default/registry.js not found'}).`,
    { capability, cause: vendorRuntimeError?.message },
  );
};

const {
  speechVendorReport, listSpeechVoices, synthesizeWithVendor,
  resolveSpeechVendor, checkSpeechVendor, unavailableWithAlternatives,
} = vendorRuntime?.speech ?? {
  speechVendorReport: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  listSpeechVoices: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  synthesizeWithVendor: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  resolveSpeechVendor: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  checkSpeechVendor: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  unavailableWithAlternatives: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
};
const { musicVendorReport, synthesizeMusicWithVendor } = vendorRuntime?.music ?? {
  musicVendorReport: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
  synthesizeMusicWithVendor: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
};
const { transcriptionVendorReport } = vendorRuntime?.transcription ?? {
  transcriptionVendorReport: missingRuntime('transcription', ErrorCodes.TRANSCRIPTION_UNAVAILABLE),
};
import { transcribeMedia, looksTranscribable, MAX_TRANSCRIBE_SECONDS } from '../core/transcribe.js';
import { maskKey } from '../vendors/default/speech/azure.js';
import { PIPER_ENV } from '../vendors/default/speech/piper.js';
import {
  parseWavHeader, wavDurationSeconds, framesForDuration, measureWavLevels, splitSentences, concatWavBuffers,
} from '../core/audio.js';
import { JobManager, RENDER_LANE, TASK_LANE } from '../core/jobs.js';
import { renderComposition, renderParallel, renderStill } from '../core/renderer.js';
import { checkPrerequisites, MIN_NODE, MIN_FFMPEG } from '../core/prereqs.js';
import { resolveInTarget } from '../core/sandbox.js';
import { EngineError, ErrorCodes, asEngineError } from '../core/errors.js';
import { planFilm, submitFilmBuild, toMixerTracks } from '../core/films.js';
import { mixAudioOnly, probeMedia } from '../core/encoder.js';
import { resolveReviewPolicy, extractRenderedFrame } from '../core/render-review.js';
import { resolveDeliverableSelections } from '../core/deliverables.js';
import {
  createAdvice, listAdvice, getAdvice, adviceSummary,
  writeAdviceEvidence, recordEvidenceFailure, adviceEvidencePath,
  withdrawAdvice, withdrawAllAdvice,
} from '../core/advice.js';
import { listRevisions, revisionFilePath, getRevision, currentRevisionId } from '../core/revisions.js';
import {
  listDeliveries, getDeliveryManifest, currentDeliveryId, deliveryFilePath, resolveDeliveryFrame,
} from '../core/deliveries.js';
import { listActivity, productionStatus } from '../core/activity.js';
import { ProductionEvents, startWorkspaceWatcher, sseFrame } from '../core/events.js';

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
  // Transcription (v0.22): the same three-way split. No binary/model = a
  // prerequisite the user must install; a file with no readable speech = the
  // caller's fault; whisper running and failing = upstream.
  [ErrorCodes.TRANSCRIPTION_UNAVAILABLE]: 503,
  [ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED]: 400,
  [ErrorCodes.TRANSCRIPTION_FAILED]: 502,
  // Footage segments (v0.22): a missing or non-conforming file is the caller's
  // to fix, like an unrendered scene (409) rather than a server fault.
  [ErrorCodes.FOOTAGE_MISSING]: 404,
  [ErrorCodes.FOOTAGE_DURATION_MISMATCH]: 409,
  [ErrorCodes.FOOTAGE_SIGNATURE_MISMATCH]: 409,
  // States the UI can act on: another render owns the lock (retry later), a
  // name that already exists (pick another).
  [ErrorCodes.RENDER_ALREADY_IN_PROGRESS]: 409,
  // Relocating storage while jobs are in flight (v0.22) — the same "come back
  // when the conflict has cleared" shape as the render lock.
  [ErrorCodes.STORAGE_BUSY]: 409,
  [ErrorCodes.SCENE_ALREADY_EXISTS]: 409,
  [ErrorCodes.FILM_ALREADY_EXISTS]: 409,
  [ErrorCodes.UNKNOWN_DELIVERABLE]: 404,
  // A review rule held a technically complete staged delivery; callers can
  // inspect the retained review evidence and change the policy or source.
  [ErrorCodes.PROMOTION_BLOCKED]: 409,
  // Films.
  [ErrorCodes.FILM_NOT_FOUND]: 404,
  [ErrorCodes.INVALID_FILM]: 400,
  // Classic optimistic-concurrency 409: re-read and retry, don't resend.
  [ErrorCodes.FILM_CONFLICT]: 409,
  [ErrorCodes.SCENE_NOT_RENDERED]: 409,
  [ErrorCodes.INCONSISTENT_SCENES]: 409,
  [ErrorCodes.NO_AUDIO_TRACKS]: 400,
  [ErrorCodes.MIGRATION_FAILED]: 500,
  // The production loop (v0.23): advice, revisions, deliveries.
  [ErrorCodes.ADVICE_NOT_FOUND]: 404,
  [ErrorCodes.INVALID_ADVICE]: 400,
  [ErrorCodes.ADVICE_LEASE_HELD]: 409,
  [ErrorCodes.ADVICE_ALREADY_RESOLVED]: 409,
  [ErrorCodes.REVISION_NOT_FOUND]: 404,
  [ErrorCodes.REVISION_MISMATCH]: 409,
  [ErrorCodes.DELIVERY_NOT_FOUND]: 404,
};

/** Preview clips are for auditioning a voice, not for rendering a script. */
const MAX_PREVIEW_CHARS = 400;

/**
 * The transcription page's test is "drop a recording in and see what comes
 * back", so its bounds are about a *page test*, not about the tool: a couple of
 * minutes is enough to judge accuracy on your own microphone, and it keeps the
 * button honest about how long it will take. `transcribe_asset` has its own,
 * much larger, bounds.
 */
const MAX_TRANSCRIBE_PREVIEW_BYTES = 256 * 1024 * 1024;
const MAX_TRANSCRIBE_PREVIEW_SECONDS = 180;

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
export function createStudioServer({ store: initialStore = null, jobs = new JobManager(), browserFactory = null } = {}) {
  // Rebindable since v0.22: PATCH /api/settings can move the storage root, and a
  // store captured by `const` would leave this process serving the old tree
  // until it was restarted — the one thing a user who just changed the setting
  // would read as "it did not work".
  let store = initialStore ?? new WorkspaceStore();

  // The production event stream (v0.23): one bus per server, fed by (a) this
  // process's own writes at their call sites and (b) a recursive watcher on
  // the workspaces root, which is how an MCP server's work in ANOTHER process
  // becomes visible here without polling. Events are refetch triggers, never
  // truth, so double-emission for our own writes is harmless.
  const events = new ProductionEvents();
  let watcher = startWorkspaceWatcher({ root: store.workspacesRoot, events });

  /**
   * Best-effort before/after frame evidence for advice. Runs AFTER the advice
   * request is durable, detached from the request/response cycle; failure is
   * recorded on the advice rather than surfaced as an error.
   */
  const captureAdviceEvidence = async (film, adviceId, which, observation, target) => {
    try {
      let filePath = null;
      let frame = null;
      let fps = null;
      const meta = {};
      if (observation?.deliveryId && observation?.filmFrame !== undefined) {
        const manifest = await getDeliveryManifest(film.path, observation.deliveryId);
        filePath = deliveryFilePath(film.path, observation.deliveryId, manifest.outputFile);
        frame = Math.max(0, Math.min(observation.filmFrame, (manifest.totalFrames ?? 1) - 1));
        fps = manifest.fps ?? 30;
        Object.assign(meta, { deliveryId: observation.deliveryId, filmFrame: frame });
      } else if (target?.scene && (target?.sceneFrame !== undefined || observation?.sceneFrame !== undefined)) {
        const sceneId = `${film.id}/${target.scene}`;
        const scene = await store.getScene(sceneId);
        const config = await store.readConfig(sceneId);
        filePath = path.join(scene.path, config.output?.dir ?? 'out', config.output?.filename ?? 'output.mp4');
        frame = Math.max(0, Math.min(target.sceneFrame ?? observation.sceneFrame, config.durationInFrames - 1));
        fps = config.fps;
        Object.assign(meta, {
          scene: target.scene, sceneFrame: frame,
          revisionId: observation?.revisionId ?? await currentRevisionId(scene.path).catch(() => null),
        });
      } else if (target?.type === 'footage' && target?.itemId) {
        // A footage clip has no scene folder and no revision — the frame the
        // human saw lives in the film's own asset. Resolved from the document
        // by id, never from a client-supplied path.
        const doc = await store.getFilm(film.id);
        const seg = (doc.scenes ?? []).find((s) => s.id === target.itemId && s.footage);
        if (!seg) throw new EngineError(ErrorCodes.FILE_NOT_FOUND, 'that footage segment is no longer in the play order');
        filePath = resolveInTarget(film.path, String(seg.footage).replace(/\\/g, '/'), { asAsset: true });
        frame = Math.max(0, Math.min(target.sceneFrame ?? 0, (seg.durationInFrames ?? 1) - 1));
        fps = (await planFilm({ film: doc, store }).catch(() => null))?.fps ?? 30;
        Object.assign(meta, { footage: seg.footage, itemId: target.itemId, segmentFrame: frame });
      } else if (observation?.revisionId && target?.scene) {
        const sceneId = `${film.id}/${target.scene}`;
        const scene = await store.getScene(sceneId);
        const config = await store.readConfig(sceneId);
        const rev = await getRevision(scene.path, observation.revisionId);
        filePath = path.join(rev.path, rev.outputFile);
        frame = Math.max(0, Math.min(target.sceneFrame ?? Math.floor((rev.frames ?? 2) / 2), (rev.frames ?? 1) - 1));
        fps = rev.config?.fps ?? config.fps;
        Object.assign(meta, { scene: target.scene, revisionId: observation.revisionId, sceneFrame: frame });
      }
      if (!filePath || !fs.existsSync(filePath)) {
        throw new EngineError(ErrorCodes.FILE_NOT_FOUND, 'no visible media to capture evidence from');
      }
      const png = await extractRenderedFrame({
        filePath, frame: frame ?? 0, fps: fps ?? 30, ffmpegPath: (await resolveFfmpegPath({ dataDir: store.dataDir })).path,
      });
      await writeAdviceEvidence({ filmPath: film.path, adviceId, which, png, meta });
    } catch (err) {
      await recordEvidenceFailure({
        filmPath: film.path, adviceId, which, reason: err?.message ?? String(err),
      }).catch(() => {});
    }
  };

  /**
   * Where everything lives, plus — for each configurable location (the three
   * storage paths of v0.22, and the vendor dir since v0.25) — which layer
   * decided it and what the settings page may do about it.
   *
   * `editable: false` is the honest report for a location the environment has
   * fixed: MOTION_STUDIO_HOME is set by whoever launched this process, writing
   * paths.json underneath it would change nothing, and an input that silently
   * does nothing is worse than one that explains why it is disabled.
   */
  const storageReport = () => {
    const p = resolvePaths();
    return {
      locationsFile: p.locationsFile,
      appDataDir: APP_DATA_DIR,
      locations: Object.fromEntries(PATH_KEYS.map((key) => [key, {
        value: p[key],
        source: p.sources[key],           // env | configured | default | legacy
        stored: p.stored[key] ?? null,    // what paths.json holds, if anything
        default: p.defaults[key],
        env: { name: PATH_ENV[key], value: process.env[PATH_ENV[key]] ?? null },
        editable: p.sources[key] !== 'env',
        exists: fs.existsSync(p[key]),
      }])),
    };
  };

  const environmentReport = async () => {
    const ENV_HOOKS = [
      'MOTION_STUDIO_FFMPEG', 'MOTION_STUDIO_TTS_EXE',
      'MOTION_STUDIO_MIDI_EXE',
      'MOTION_STUDIO_FLUIDSYNTH', 'MOTION_STUDIO_SOUNDFONT', 'MOTION_STUDIO_LIBS_DIR',
      'MOTION_STUDIO_ALLOW_LOCAL_FETCH', 'MOTION_STUDIO_MAX_RENDERS',
      'MOTION_STUDIO_WORKSPACE',
      'PUPPETEER_EXECUTABLE_PATH',
    ];
    const { path: effectiveFfmpeg, source } = await resolveFfmpegPath({ dataDir: store.dataDir });
    const probe = await checkPrerequisites({ ffmpegPath: effectiveFfmpeg });
    const storage = storageReport();
    return {
      // The flat trio predates the storage block and is what this server is
      // actually serving from right now — which is the same thing until a
      // relocation is applied, and the truth about this process either way.
      dataDir: store.dataDir,
      workspacesRoot: store.workspacesRoot,
      settingsPath: storage.locations.settingsFile.value,
      storage,
      ffmpeg: { effectivePath: effectiveFfmpeg, source, ...probe.ffmpeg },
      env: {
        // MOTION_STUDIO_HOME/_WORKSPACES/_SETTINGS are deliberately absent: they
        // are reported inside `storage`, against the field each one locks.
        ...Object.fromEntries(ENV_HOOKS.map((k) => [k, process.env[k] ?? null])),
        // Vendor credentials are reported as "set, ending in …" and never in
        // full: this endpoint feeds a browser page, and a key that reaches the
        // DOM is a key in every screenshot.
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
            ...WHISPER_ENV.bin, ...WHISPER_ENV.model, ...WHISPER_ENV.models, ...WHISPER_ENV.threads,
            'MOTION_STUDIO_TTS_VENDOR', 'MOTION_STUDIO_MUSIC_VENDOR',
            'MOTION_STUDIO_TRANSCRIPTION_VENDOR',
          ].map((k) => [k, process.env[k] ?? null]),
        ),
      },
    };
  };

  /**
   * Write new storage locations and, if the tree this process serves moved,
   * re-point it — without a restart, because "changed the data dir, saw no
   * change" is indistinguishable from a broken setting.
   *
   * Refused outright while any job is in flight. A render holds absolute paths
   * into the old tree and writes its frames there over the next several minutes;
   * swapping the store underneath it would leave the output somewhere the film
   * that commissioned it no longer looks, which is a corrupted result rather
   * than an error. Waiting is cheap and the message says what to wait for.
   *
   * Only THIS process is re-pointed. Connected MCP servers resolved their own
   * paths when their client spawned them, so the response says they need a
   * restart rather than pretending otherwise.
   */
  const relocateStorage = async (patch) => {
    const busy = jobs.runningCount(RENDER_LANE) + jobs.runningCount(TASK_LANE)
      + jobs.queuedCount(RENDER_LANE) + jobs.queuedCount(TASK_LANE);
    if (busy) {
      throw new EngineError(
        ErrorCodes.STORAGE_BUSY,
        `${busy} job(s) are running or queued against the current storage location. `
          + 'Let them finish (or cancel them) before moving it.',
        { jobs: busy },
      );
    }
    const before = { dataDir: store.dataDir, workspacesRoot: store.workspacesRoot };
    const p = await updateLocations(patch);
    const moved = p.dataDir !== before.dataDir || p.workspacesRoot !== before.workspacesRoot;
    if (moved) {
      store = new WorkspaceStore(p.dataDir, { workspacesRoot: p.workspacesRoot });
      await store.ready();
      // The event watcher follows the tree it reports on.
      watcher.close();
      watcher = startWorkspaceWatcher({ root: store.workspacesRoot, events });
    }
    return {
      moved,
      from: before,
      to: { dataDir: p.dataDir, workspacesRoot: p.workspacesRoot, settingsFile: p.settingsFile },
      // Nothing here can reach into another process's environment.
      restartAgents: moved,
    };
  };

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

      // /api/settings — global settings + the environment report, so the UI has
      // one place that answers "where does everything live". Since v0.22 the
      // three storage locations in that report are writable, and PATCH takes
      // them alongside the settings patch.
      if (parts[1] === 'settings' && parts.length === 2) {
        if (req.method === 'GET') {
          return sendJson(res, 200, {
            settings: await readSettings(store.dataDir),
            environment: await environmentReport(),
          });
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          // Locations first: a body carrying both means the settings patch is
          // meant for the NEW settings file, not a parting write to the old one.
          const relocated = body.paths ? await relocateStorage(body.paths) : null;
          const settings = body.patch
            ? await updateSettings(body.patch, store.dataDir)
            : await readSettings(store.dataDir);
          return sendJson(res, 200, {
            settings,
            // The report costs an ffmpeg probe, so it rides along only when the
            // storage moved — the case where the UI cannot re-derive the answer.
            ...(relocated ? { relocated, environment: await environmentReport() } : {}),
          });
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
          const [speech, music, transcription] = await Promise.all([
            speechVendorReport({ dataDir: store.dataDir, probe, force }),
            musicVendorReport({ dataDir: store.dataDir, probe }),
            transcriptionVendorReport({ dataDir: store.dataDir, probe }),
          ]);
          return sendJson(res, 200, {
            speech,
            music,
            transcription,
            azure: { outputFormats: AZURE_WAV_FORMATS, env: AZURE_ENV },
            elevenlabs: { outputFormats: ELEVENLABS_WAV_FORMATS, env: ELEVENLABS_ENV },
            whisper: {
              env: WHISPER_ENV,
              modelPreference: MODEL_PREFERENCE,
              maxPreviewSeconds: MAX_TRANSCRIBE_PREVIEW_SECONDS,
              maxSeconds: MAX_TRANSCRIBE_SECONDS,
            },
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

        /* ------------------------ transcription vendors ----------------------- */
        // v0.22. The page's test is the mirror image of the speech page's: there
        // you type a line and hear it, here you hand over a recording and read
        // what came back. Both exist for the same reason — "is this vendor good
        // enough for my film" is a question you want answered before a render,
        // not after one — and neither writes anything into a scene.
        if (parts[2] === 'transcription' && parts.length >= 4) {
          const vendor = parts[3];
          if (!TRANSCRIPTION_VENDORS.includes(vendor)) {
            throw new EngineError(
              ErrorCodes.INVALID_CONFIG,
              `Unknown transcription vendor "${vendor}" — expected one of: ${TRANSCRIPTION_VENDORS.join(', ')}`,
              { vendor, allowed: TRANSCRIPTION_VENDORS },
            );
          }

          // POST …/preview — raw media body (the file the user picked in the
          // browser), transcribed and returned as JSON.
          if (req.method === 'POST' && parts[4] === 'preview' && parts.length === 5) {
            const name = url.searchParams.get('name') ?? 'preview';
            if (!looksTranscribable(name)) {
              throw new EngineError(
                ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
                `"${name}" is not an audio or video file — pick a recording (wav/mp3/m4a/flac/ogg, mp4/mov/mkv/webm).`,
                { name },
              );
            }
            const buf = await readRawBody(req, MAX_TRANSCRIBE_PREVIEW_BYTES);
            if (!buf.length) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'preview needs a file to transcribe');
            const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-transcribe-preview-'));
            const src = path.join(dir, `input${path.extname(name) || '.wav'}`);
            try {
              await fsp.writeFile(src, buf);
              const result = await transcribeMedia({
        transcription: vendorRuntime?.transcription ?? null,
                filePath: src,
                fps: Number(url.searchParams.get('fps')) || 30,
                model: url.searchParams.get('model') || undefined,
                language: url.searchParams.get('language') || undefined,
                dataDir: store.dataDir,
                ffmpegPath: await ffmpegPath(),
                // The temp path never recurs, so a cache entry for it would be
                // dead weight the moment this request ends.
                cache: false,
                maxSeconds: MAX_TRANSCRIBE_PREVIEW_SECONDS,
                maxBytes: MAX_TRANSCRIBE_PREVIEW_BYTES,
              });
              return sendJson(res, 200, {
                file: name,
                vendor: result.vendor,
                model: result.model,
                language: result.language,
                durationSeconds: result.durationSeconds,
                elapsedMs: result.elapsedMs,
                // How much faster than realtime this machine reads speech — the
                // number that decides whether transcribing on ingest is viable.
                realtimeFactor: result.elapsedMs
                  ? Number((result.durationSeconds / (result.elapsedMs / 1000)).toFixed(2))
                  : null,
                text: result.text,
                sentences: result.sentences,
                wordCount: result.words.length,
                // A page shows a sample, not a corpus: the words are here to
                // prove per-word timing exists, and the tool returns them all.
                words: result.words.slice(0, 200),
                speechRanges: result.speechRanges,
                leadingSilenceSeconds: result.leadingSilenceSeconds,
              });
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
          const settings = await readSettings(store.dataDir).catch(() => structuredClone(DEFAULT_SETTINGS));
          const deliverables = resolveDeliverableSelections({
            presets: settings.deliverablePresets,
            requested: body.deliverables,
            defaultIds: settings.newFilmDefaults?.deliverableIds ?? [],
            baseFilename: body.outputFilename ?? 'film',
          });
          const sceneDefaults = withNewSceneDefaults(settings, {
            fps: body.fps, width: body.width, height: body.height, durationInFrames: body.durationInFrames,
          });
          const primary = deliverables[0];
          if (primary) {
            if (body.width === undefined) sceneDefaults.width = primary.width;
            if (body.height === undefined) sceneDefaults.height = primary.height;
          }
          const film = await store.createFilm(wsId, {
            name: body.name, slug: body.slug, sceneDefaults,
            outputFilename: body.outputFilename,
            deliverables,
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
            // `revision` is what the client last read. Sending it turns a
            // stale whole-array patch into a 409 instead of a silent revert
            // of everything an agent changed while the tab sat open.
            const { patch, revision } = await readBody(req);
            const film = await store.updateFilm(targetId, patch ?? {}, { expectedRevision: revision });
            const detail = await planFilm({ film, store });
            return sendJson(res, 200, { film, detail });
          }
          if (req.method === 'DELETE') {
            const deleteFiles = url.searchParams.get('deleteFiles') === '1';
            return sendJson(res, 200, await store.removeFilm(targetId, { deleteFiles }));
          }
        }

        /* ---- production loop (v0.23): deliveries, advice, resolution ---- */

        // GET /api/films/:fid/overview — one snapshot the film page opens on:
        // document + plan + deliveries + advice summary + activity + per-scene
        // revision counts. One call, because the human just clicked a film.
        if (isFilmRoute && req.method === 'GET' && sub === 'overview' && parts.length === 4) {
          const film = await store.getFilm(targetId);
          const plan = await planFilm({ film, store });
          const deliveries = await listDeliveries(film.path);
          const currentId = await currentDeliveryId(film.path);
          const advice = await listAdvice({ filmPath: film.path, status: 'all', order: 'newest', limit: 200 });
          const revisions = {};
          for (const seg of plan.scenes) {
            if (seg.kind !== 'scene' || seg.missing) continue;
            const revs = await listRevisions(store.scenePath(seg.sceneId)).catch(() => []);
            revisions[seg.slug] = {
              count: revs.length,
              currentRevisionId: revs.find((r) => r.current)?.id ?? null,
              latestAt: revs[0]?.createdAt ?? null,
            };
          }
          const status = await productionStatus({ store, film, plan });
          return sendJson(res, 200, {
            film, plan, deliveries, currentDeliveryId: currentId, advice, revisions, status,
            lastEventId: events.nextId - 1,
          });
        }

        // GET /api/films/:fid/status — the light header refresh.
        if (isFilmRoute && req.method === 'GET' && sub === 'status' && parts.length === 4) {
          const film = await store.getFilm(targetId);
          return sendJson(res, 200, await productionStatus({ store, film }));
        }

        // Deliveries: list, manifest, pinned playback file, contact sheet.
        if (isFilmRoute && sub === 'deliveries') {
          const film = await store.getFilm(targetId);
          if (req.method === 'GET' && parts.length === 4) {
            return sendJson(res, 200, {
              currentDeliveryId: await currentDeliveryId(film.path),
              deliveries: await listDeliveries(film.path),
            });
          }
          const deliveryId = parts[4];
          if (req.method === 'GET' && parts.length === 5) {
            const { path: _p, ...manifest } = await getDeliveryManifest(film.path, deliveryId);
            return sendJson(res, 200, manifest);
          }
          if (req.method === 'GET' && parts[5] === 'file' && parts.length === 6) {
            const manifest = await getDeliveryManifest(film.path, deliveryId);
            const abs = deliveryFilePath(film.path, deliveryId, manifest.outputFile);
            return await streamFile(res, abs, { range: req.headers.range, download: url.searchParams.get('download') === '1' });
          }
          if (req.method === 'GET' && parts[5] === 'contact' && parts.length === 6) {
            return await streamFile(res, deliveryFilePath(film.path, deliveryId, 'film.contact.png'));
          }
        }

        // GET /api/films/:fid/resolve?frame=N[&delivery=ID] — what is the
        // human looking at? Resolved against the PINNED delivery's manifest,
        // never against the film's present state (snapshot consistency).
        if (isFilmRoute && req.method === 'GET' && sub === 'resolve' && parts.length === 4) {
          const film = await store.getFilm(targetId);
          const deliveryId = url.searchParams.get('delivery') || await currentDeliveryId(film.path);
          if (!deliveryId) {
            throw new EngineError(ErrorCodes.DELIVERY_NOT_FOUND,
              'This film has no built delivery yet — scene previews are still advisable individually');
          }
          const manifest = await getDeliveryManifest(film.path, deliveryId);
          const hit = resolveDeliveryFrame(manifest, Number(url.searchParams.get('frame') ?? 0));
          return sendJson(res, 200, { deliveryId, ...hit });
        }

        // Advice: create (durable receipt first, evidence async), list, detail.
        if (isFilmRoute && sub === 'advice') {
          const film = await store.getFilm(targetId);
          if (req.method === 'POST' && parts.length === 4) {
            const body = await readBody(req);
            const receipt = await createAdvice({
              filmPath: film.path,
              filmId: film.id,
              message: body.message,
              target: body.target ?? { type: 'film' },
              observation: body.observation ?? { source: 'none' },
              suggestedAction: body.suggestedAction ?? 'rework',
              preferredRevisionId: body.preferredRevisionId ?? null,
              followUpOf: body.followUpOf ?? null,
              requestId: body.requestId ?? null,
              from: 'human',
            });
            events.emit('advice', { filmId: film.id, adviceId: receipt.id });
            if (!receipt.deduplicated) {
              // Detached on purpose: the receipt IS the durable commitment;
              // evidence lands (or records its failure) when it lands.
              void captureAdviceEvidence(film, receipt.id, 'before', body.observation ?? {}, body.target ?? {});
            }
            return sendJson(res, 201, receipt);
          }
          if (req.method === 'GET' && parts.length === 4) {
            const target = ['scene', 'sequence', 'itemId', 'type'].some((k) => url.searchParams.get(k))
              ? {
                ...(url.searchParams.get('type') ? { type: url.searchParams.get('type') } : {}),
                ...(url.searchParams.get('scene') ? { scene: url.searchParams.get('scene') } : {}),
                ...(url.searchParams.get('sequence') ? { sequence: url.searchParams.get('sequence') } : {}),
                ...(url.searchParams.get('itemId') ? { itemId: url.searchParams.get('itemId') } : {}),
              }
              : null;
            const items = await listAdvice({
              filmPath: film.path,
              status: url.searchParams.get('status') ?? 'all',
              order: url.searchParams.get('order') ?? null,
              target,
              limit: Number(url.searchParams.get('limit')) || 0,
            });
            return sendJson(res, 200, { advice: items, summary: await adviceSummary(film.path) });
          }
          // POST /api/films/:fid/advice/withdraw-all — the human clears the
          // board. Advice is otherwise one-way: without this, a typo or a
          // note they changed their mind about is re-served to every later
          // AI run forever.
          if (req.method === 'POST' && parts[4] === 'withdraw-all' && parts.length === 5) {
            const body = await readBody(req);
            const result = await withdrawAllAdvice({ filmPath: film.path, reason: body.reason ?? null });
            events.emit('advice', { filmId: film.id });
            return sendJson(res, 200, result);
          }
          const adviceId = parts[4];
          if (req.method === 'GET' && parts.length === 5) {
            const full = await getAdvice({ filmPath: film.path, adviceId });
            const { path: _p, ...body } = full;
            return sendJson(res, 200, body);
          }
          // POST /api/films/:fid/advice/:aid/withdraw — take one back. Closes
          // it terminally; the wording and evidence stay on disk.
          if (req.method === 'POST' && parts[5] === 'withdraw' && parts.length === 6) {
            const body = await readBody(req);
            const result = await withdrawAdvice({
              filmPath: film.path, adviceId, reason: body.reason ?? null,
            });
            events.emit('advice', { filmId: film.id, adviceId });
            return sendJson(res, 200, result);
          }
          if (req.method === 'GET' && parts[5] === 'evidence' && parts.length === 7) {
            return await streamFile(res, adviceEvidencePath(film.path, adviceId, parts[6]));
          }
        }

        // Scene revisions: history, artefacts, and "Ask AI to use this version".
        if (isSceneRoute && sub === 'revisions') {
          const scene = await store.getScene(targetId);
          if (req.method === 'GET' && parts.length === 4) {
            const revisions = await listRevisions(scene.path);
            return sendJson(res, 200, {
              scene: scene.id,
              currentRevisionId: revisions.find((r) => r.current)?.id ?? null,
              revisions: revisions.map(({ path: _p, renderMeta: _m, ...r }) => r),
            });
          }
          const revisionId = parts[4];
          if (req.method === 'GET' && parts[5] === 'file' && parts.length === 6) {
            const rev = await getRevision(scene.path, revisionId);
            return await streamFile(res, path.join(rev.path, rev.outputFile), { range: req.headers.range });
          }
          if (req.method === 'GET' && parts[5] === 'contact' && parts.length === 6) {
            return await streamFile(res, revisionFilePath(scene.path, revisionId, 'output.contact.png'));
          }
          // POST …/revisions/:rid/prefer — "Ask AI to use this version".
          // Studio NEVER repoints production; it records high-priority advice
          // naming the exact revision, and the next director decides.
          if (req.method === 'POST' && parts[5] === 'prefer' && parts.length === 6) {
            const body = await readBody(req);
            const rev = await getRevision(scene.path, revisionId); // 404s before advice is created
            const film = await store.getFilm(scene.film);
            const revisions = await listRevisions(scene.path);
            const current = revisions.find((r) => r.current)?.id ?? null;
            const receipt = await createAdvice({
              filmPath: film.path,
              filmId: film.id,
              message: String(body.message ?? '').trim()
                || `Please use this earlier version of "${scene.slug}" (${revisionId}) — it reads better than the current one.`,
              target: { type: 'scene', scene: scene.slug },
              observation: {
                source: 'revision-preview',
                revisionId,
                ...(current ? { currentRevisionId: current } : {}),
              },
              suggestedAction: 'prefer-revision',
              preferredRevisionId: revisionId,
              requestId: body.requestId ?? null,
              from: 'human',
            });
            events.emit('advice', { filmId: film.id, adviceId: receipt.id });
            if (!receipt.deduplicated) {
              void captureAdviceEvidence(film, receipt.id, 'before',
                { revisionId, sceneFrame: Math.floor((rev.frames ?? 2) / 2) }, { scene: scene.slug });
            }
            return sendJson(res, 201, receipt);
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
          if (body.deliverable && body.outputFilename !== undefined) {
            throw new EngineError(ErrorCodes.INVALID_CONFIG,
              'outputFilename belongs to the configured deliverable when building a variant; update that deliverable instead');
          }
          for (const k of ['outputFilename', 'audioTargetPeakDb', 'burnCaptions']) {
            if (body[k] !== undefined) patch[k] = body[k];
          }
          const film = Object.keys(patch).length
            ? await store.updateFilm(targetId, patch)
            : await store.getFilm(targetId);
          const submitted = await submitFilmBuild({
            film, store, jobs, ffmpegPath: await ffmpegPath(), deliverableId: body.deliverable ?? null,
          });
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
          const settings = await readSettings(store.dataDir);
          const film = await store.getFilm(scene.film);
          const reviewPolicy = resolveReviewPolicy({
            globalPolicy: settings.render.review,
            filmPolicy: film.review,
          });
          const submitted = jobs.startRender({
            targetId: scene.id,
            scenePath: scene.path,
            config,
            outputPath,
            frameRange: body.frameRange,
            // The UI seeds its form from the global default, but a direct API
            // caller may omit it — fall back here so both paths agree with MCP.
            workers: body.workers ?? settings.render.defaultWorkers,
            ffmpegPath: await ffmpegPath(),
            reviewPolicy,
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
                names.filter((n) => !n.startsWith('.')).map(async (n) => {
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
        // GET …/probe?path= — one asset's real media properties (v0.22). The film
        // editor needs a footage file's FRAME COUNT to put it on the timeline, and
        // that number must come from the file: it is what every later offset is
        // built on, so a typed guess would shift every subsequent segment. Same
        // summarizer the probe_asset tool returns, and the same addressing —
        // assets/ or out/ — so both surfaces agree.
        if (req.method === 'GET' && sub === 'probe' && parts.length === 4) {
          const rel = url.searchParams.get('path') ?? '';
          const a = await store.resolveMediaFile(targetId, rel);
          const { path: ffprobePath } = await resolveFfprobePath({ dataDir: store.dataDir });
          const media = await probeMedia({ filePath: a.abs, ffprobePath });
          // probed:false rather than an error — ffprobe is not a prerequisite.
          return sendJson(res, 200, { path: a.path, bytes: a.bytes, probed: media !== null, ...(media ?? {}) });
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

      // GET /api/events — the production event stream (v0.23). One
      // reconnectable SSE feed for every workspace: advice, revisions,
      // deliveries, film documents, outputs, and activity heartbeats.
      // Reconnect with Last-Event-ID (or ?lastEventId=): buffered events are
      // replayed; a gap sends `reset` and the client refetches canonical
      // state. Events are notifications — the client always refetches.
      if (req.method === 'GET' && parts[1] === 'events' && parts.length === 2) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write('retry: 1500\n\n');
        const lastId = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
        if (lastId) {
          const missed = events.since(lastId);
          if (missed === null) {
            res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'event gap — refetch state' })}\n\n`);
          } else {
            for (const e of missed) res.write(sseFrame(e));
          }
        }
        const unsubscribe = events.subscribe((e) => res.write(sseFrame(e)));
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }

      // GET /api/workspaces/:ws/activity — agent heartbeats (v0.23).
      if (req.method === 'GET' && parts[1] === 'workspaces' && parts[3] === 'activity' && parts.length === 4) {
        const ws = await store.getWorkspace(parts[2]);
        return sendJson(res, 200, { activity: await listActivity(ws.path) });
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

  // The watcher holds an OS handle; a closed server (tests, shutdown) must
  // not leak it or keep the process alive.
  server.on('close', () => watcher.close());

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
  // Record a data dir inherited from a pre-v0.22 install before anything reads
  // it, so the location stops depending on which folders happen to exist (see
  // core/paths.js). A no-op on a fresh install and whenever the environment or
  // paths.json already decided.
  const pinned = await ensureStableDataDir();
  if (pinned) {
    process.stderr.write(
      `[motion-studio] using the existing data dir ${pinned.pinned} (recorded in ${resolvePaths().locationsFile}; `
      + 'change it in Global Settings)\n',
    );
  }
  const port = Number(process.env.PORT) || 7345;
  // Local tool by default: 127.0.0.1 unless the operator opts in. The opt-in
  // exists for the server-hosted deployment (Motion Studio on one box, the
  // human adviser viewing the Studio from another) — but the Studio has no
  // authentication of its own, so a non-loopback bind belongs on a trusted
  // network or behind an authenticating reverse proxy, never the open
  // internet. MACHINE.md should record which of those applies.
  const host = process.env.MOTION_STUDIO_STUDIO_HOST || '127.0.0.1';
  const server = createStudioServer({ browserFactory });
  server.listen(port, host, () => {
    process.stderr.write(`[motion-studio] Studio running at http://${host}:${port}\n`);
  });
}
