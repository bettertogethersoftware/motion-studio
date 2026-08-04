#!/usr/bin/env node
/**
 * Motion Studio MCP server — the agent path.
 *
 * Transport: stdio only (launched as a child process by the MCP client).
 * IMPORTANT: stdout belongs to the MCP protocol; all diagnostics go to stderr.
 *
 * THE MODEL (v0.20): this server is bound to ONE WORKSPACE — the folder tree
 * where this agent's work lives (MOTION_STUDIO_WORKSPACE, default "default";
 * give each AI its own name in its MCP client config). Inside the workspace:
 *
 *   film   "my-film"           — a film folder: film.json (the document),
 *                                assets/ (master audio, overlays), out/ (the
 *                                built film), scenes/
 *   scene  "my-film/scene-1"   — one composition inside a film; the unit that
 *                                renders — where composition code lives.
 *   library                    — workspace-level shared assets the human
 *                                drops in (large files); pull them into any
 *                                scene with use_shared_asset.
 *
 * Ids in this tool surface are always workspace-local: films are "<film>",
 * scenes are "<film>/<scene>". The Studio web UI shows every workspace; this
 * server sees only its own.
 *
 * Tool surface is a fixed set — no shell, no arbitrary file access. Every
 * file-touching tool goes through the path sandbox (core/sandbox.js); every
 * render/preview goes through the shared Render Engine Core, so agents, the
 * CLI, and the Studio web UI exercise the same code.
 *
 * Environment:
 *   MOTION_STUDIO_WORKSPACE     the workspace this server works in (default
 *                               "default"; created on first use). Give each
 *                               agent its own so their films don't mingle.
 *   MOTION_STUDIO_HOME          override data dir (default ~/.motion-studio)
 *   MOTION_STUDIO_VENDOR_DIR    override the vendor-asset root the bundled
 *                               defaults resolve from — exes, FluidSynth,
 *                               SoundFonts, Piper voices, Whisper models, 3D
 *                               libs (default <app>/vendor; configurable in
 *                               the Studio's storage settings too — v0.25).
 *                               Per-item hooks below still win over it.
 *   MOTION_STUDIO_FFMPEG        ffmpeg binary to use (default: the Studio's
 *                               settings.json ffmpeg.path, else "ffmpeg" on PATH).
 *                               MCP servers are spawned by a GUI client and often
 *                               inherit a minimal PATH, so this is the escape hatch
 *                               when ffmpeg is installed but not visible here.
 *   MOTION_STUDIO_MAX_RENDERS   per-session render cap (default unlimited)
 *   MOTION_STUDIO_TTS_EXE       path to the Windows text-to-speech exe (optional;
 *                               enables the "system" speech vendor — v0.6)
 *   MOTION_STUDIO_TTS_VENDOR    speech vendor for synthesize_speech: "system"
 *                               (default), "azure" or "piper". Overrides
 *                               settings.json's tts.vendor; a call that names
 *                               a vendor still wins over both.
 *   MOTION_STUDIO_PIPER_EXE     the piper executable, and the folder holding
 *   MOTION_STUDIO_PIPER_VOICES  its downloaded .onnx voices (v0.18). See
 *                               docs/tts-setup.md.
 *   AZURE_SPEECH_KEY            Azure AI Speech resource key + region for the
 *   AZURE_SPEECH_REGION         "azure" vendor (v0.17). Read from the
 *                               environment only — never stored in settings.
 *                               See docs/tts-setup.md.
 *   MOTION_STUDIO_MUSIC_VENDOR  music vendor for synthesize_music: "node"
 *                               (default — renders in-process, any OS) or
 *                               "fluidsynth" (the v0.8 exe chain) — v0.17.
 *   MOTION_STUDIO_SOUNDFONT     .sf2/.sf3 SoundFont — used by BOTH music
 *                               vendors (music, v0.8)
 *   MOTION_STUDIO_MIDI_EXE      MotionStudioMidi.exe (fluidsynth vendor, v0.8)
 *   MOTION_STUDIO_FLUIDSYNTH    fluidsynth.exe (fluidsynth vendor, v0.8)
 *   MOTION_STUDIO_WHISPER_BIN   whisper-cli.exe, and the ggml model (a file, or
 *   MOTION_STUDIO_WHISPER_MODEL a folder of them, or a bare name like
 *   MOTION_STUDIO_WHISPER_MODELS "small.en") that transcribe_asset reads speech
 *   MOTION_STUDIO_WHISPER_THREADS with — v0.22, local and offline, NO API key.
 *                               See docs/transcribe-setup.md.
 */

import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';

import { WorkspaceStore } from '../core/store.js';
import { JobManager } from '../core/jobs.js';
import {
  captureSingleFrame, captureFrames, renderComposition, renderParallel, renderStill,
  preflightFrameList, MAX_PREVIEW_FRAMES, normalizeProxy, proxyOutputPath,
} from '../core/renderer.js';
import { checkPrerequisites } from '../core/prereqs.js';
import {
  readSettings, resolveFfmpegPath, resolveFfprobePath, withNewSceneDefaults, outputSeedFromSettings,
  DEFAULT_SETTINGS,
} from '../core/settings.js';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes, asEngineError } from '../core/errors.js';
import { checkJsSyntax } from '../core/scene.js';
import { ADDON_IDS } from '../core/libraries.js';
import { resolveInTarget } from '../core/sandbox.js';
import {
  wavDurationSeconds, framesForDuration, measureWavLevels, measureWavEnvelope, splitSentences, concatWavBuffers,
} from '../core/audio.js';
import { TTS_VENDORS, MUSIC_VENDORS, TRANSCRIPTION_VENDORS } from '../core/settings.js';

/* ------------------------------------------------------------------ */
/* The vendor runtime (Slice A-6a; vendor-boundary plan Phase 4).      */
/*                                                                     */
/* Constructed from the default registry at startup — imported         */
/* DYNAMICALLY and failure-tolerantly, because a core-only install     */
/* (no vendors/default tree) must still initialize MCP, render video,  */
/* and answer every non-audio tool; the audio tools then return the    */
/* structured *_unavailable errors instead of the process dying with   */
/* ERR_MODULE_NOT_FOUND before initialize ever runs.                   */
/* The dispatch functions keep their historical local names so the     */
/* tool handlers below are unchanged.                                  */
/* ------------------------------------------------------------------ */

let vendorRuntime = null;
let vendorRuntimeError = null;
let capabilityTiers = null;
try {
  const { createDefaultRuntime } = await import('../vendors/default/registry.js');
  vendorRuntime = createDefaultRuntime();
} catch (e) {
  vendorRuntimeError = e;
}
// tiers.js lives in the vendors tree too (it describes the default vendors),
// so it gets the same tolerant load — the caught core-only test proved a
// static import here kills the server before initialize.
try {
  ({ capabilityTiers } = await import('../vendors/default/tiers.js'));
} catch { /* core-only install: get_capabilities reports the absence below */ }

const missingRuntime = (capability, code) => async () => {
  throw new EngineError(
    code,
    `The ${capability} vendor runtime is not installed (the default vendor package could not be loaded: ` +
    `${vendorRuntimeError?.message ?? 'vendors/default/registry.js not found'}). Video rendering and every ` +
    'non-audio tool are unaffected. This is a setup problem for the user to fix — do not retry blindly.',
    { capability, cause: vendorRuntimeError?.message },
  );
};

const {
  resolveSpeechVendor, checkSpeechVendor, synthesizeWithVendor, listSpeechVoices, speechVendorReport,
  unavailableWithAlternatives,
} = vendorRuntime?.speech ?? {
  resolveSpeechVendor: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  checkSpeechVendor: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  synthesizeWithVendor: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  listSpeechVoices: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  speechVendorReport: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
  unavailableWithAlternatives: missingRuntime('speech', ErrorCodes.TTS_UNAVAILABLE),
};
const {
  resolveMusicVendor, checkMusicVendor, synthesizeMusicWithVendor, musicVendorReport,
  musicUnavailableWithAlternatives,
} = vendorRuntime?.music ?? {
  resolveMusicVendor: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
  checkMusicVendor: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
  synthesizeMusicWithVendor: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
  musicVendorReport: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
  musicUnavailableWithAlternatives: missingRuntime('music', ErrorCodes.MUSIC_UNAVAILABLE),
};
const {
  resolveTranscriptionVendor, checkTranscriptionVendor, transcriptionVendorReport,
  unavailableWithAlternatives: transcriptionUnavailableWithAlternatives,
} = vendorRuntime?.transcription ?? {
  resolveTranscriptionVendor: missingRuntime('transcription', ErrorCodes.TRANSCRIPTION_UNAVAILABLE),
  checkTranscriptionVendor: missingRuntime('transcription', ErrorCodes.TRANSCRIPTION_UNAVAILABLE),
  transcriptionVendorReport: missingRuntime('transcription', ErrorCodes.TRANSCRIPTION_UNAVAILABLE),
  unavailableWithAlternatives: missingRuntime('transcription', ErrorCodes.TRANSCRIPTION_UNAVAILABLE),
};
import { transcribeMedia, looksTranscribable, MAX_TRANSCRIBE_SECONDS } from '../core/transcribe.js';
import {
  transcodeAsset, transcodeMetaPath, validateTranscode, formatForExtension, MAX_SPANS, MAX_CROSSFADE_MS,
} from '../core/transcode.js';
import { compileTheorySpec, THEORY_STYLE_NAMES } from '../core/music-theory.js';
import { chainFallbackNote } from '../core/vendors.js';
import { synthesizeSfx, SFX_TYPES, MAX_CUES, MAX_CUE_SECONDS, ALLOWED_SAMPLE_RATES } from '../core/sfx.js';
import { planFilm, submitFilmBuild } from '../core/films.js';
import {
  mixAudioOnly, measureAudioLevels, computeBalanceWarnings, probeMedia, measureAudioPeakPosition,
} from '../core/encoder.js';
import { getFormat } from '../core/formats.js';
import {
  MAX_RENDER_INSPECTION_FRAMES, MAX_REVIEW_GRID_CELLS, reviewFrameList, extractRenderedFrame,
  measureRenderedPicture, reviewGridCells, buildReviewGrid,
  resolveReviewPolicy, REVIEW_WARNING_CODES,
} from '../core/render-review.js';
import { ensureStableDataDir } from '../core/paths.js';
import { resolveDeliverableSelections } from '../core/deliverables.js';
import {
  createAdvice, listAdvice, getAdvice, acknowledgeAdvice, beginAdviceWork, resolveAdvice,
  ADVICE_OUTCOMES, writeAdviceEvidence, recordEvidenceFailure, adviceSummary,
} from '../core/advice.js';
import { listRevisions, useRevision, currentRevisionId } from '../core/revisions.js';
import { listDeliveries, getDeliveryManifest, currentDeliveryId } from '../core/deliveries.js';
import { reportActivity, productionStatus } from '../core/activity.js';
import { segmentRows, computeCursor, parseCursor, diffRows } from '../core/projections.js';
import { createAgentEconomy } from './agent-economy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAME_API_DOC = path.resolve(__dirname, '../../../docs/frame-api.md');
const FRAME_API_DOC_FALLBACK = path.resolve(__dirname, '../../docs/frame-api.md');

// Test/DI hook shared with the CLI (see cli/render.js).
let injectedBrowserFactory = null;
if (process.env.MOTION_STUDIO_BROWSER_MODULE) {
  const mod = await import(pathToFileURL(path.resolve(process.env.MOTION_STUDIO_BROWSER_MODULE)).href);
  injectedBrowserFactory = mod.createBrowser;
}

// Record a data dir inherited from a pre-v0.22 install before the store reads
// it, so this server and the Studio cannot disagree about which tree is "the"
// one (see core/paths.js). A no-op on a fresh install and whenever the
// environment or paths.json already decided.
await ensureStableDataDir();

const store = new WorkspaceStore();
// Migrates a pre-v0.20 flat layout on first start; a no-op forever after.
const migration = await store.ready();
if (migration?.migrated) {
  process.stderr.write(`[motion-studio-mcp] migrated legacy layout: ${migration.films.length} film(s) → workspace "${migration.workspace}"\n`);
}
// This server works inside exactly one workspace, named by the environment.
const WORKSPACE = (await store.ensureWorkspace(process.env.MOTION_STUDIO_WORKSPACE || 'default')).id;
// Who this director is (v0.23). Stamped on revisions, deliveries, advice
// events, and activity heartbeats so evidence names its author. Distinct from
// the workspace on purpose: a workspace is a production space, and two agents
// may legitimately share one.
const AGENT = (process.env.MOTION_STUDIO_AGENT || WORKSPACE).trim();

const jobs = new JobManager({
  maxConcurrent: 1,
  maxJobsPerSession: Number(process.env.MOTION_STUDIO_MAX_RENDERS) || Infinity,
});

/* ------------------------------------------------------------------ */
/* Workspace-local id helpers                                          */
/* ------------------------------------------------------------------ */

/** "<film>" → "<ws>/<film>", validating the shape with a helpful error. */
function qualifyFilm(film) {
  const parts = String(film ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length !== 1) {
    throw new EngineError(ErrorCodes.INVALID_ID,
      `"${film}" is not a film id — expected the bare film slug (e.g. "my-film"); scenes are "<film>/<scene>"`, { film });
  }
  return `${WORKSPACE}/${parts[0]}`;
}

/** "<film>/<scene>" → "<ws>/<film>/<scene>". */
function qualifyScene(scene) {
  const parts = String(scene ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new EngineError(ErrorCodes.INVALID_ID,
      `"${scene}" is not a scene id — expected "<film>/<scene>" (e.g. "my-film/scene-1")`, { scene });
  }
  return `${WORKSPACE}/${parts[0]}/${parts[1]}`;
}

/** A target is a film ("<film>") or a scene ("<film>/<scene>"). */
function qualifyTarget(target) {
  const parts = String(target ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 1) return qualifyFilm(target);
  if (parts.length === 2) return qualifyScene(target);
  throw new EngineError(ErrorCodes.INVALID_ID,
    `"${target}" is not a film or scene id — expected "<film>" or "<film>/<scene>"`, { target });
}

/** Strip this server's workspace prefix, so results speak workspace-local ids. */
function localId(id) {
  return typeof id === 'string' && id.startsWith(`${WORKSPACE}/`) ? id.slice(WORKSPACE.length + 1) : id;
}

/**
 * Everything the synth/asset tools need about a target, uniformly for scenes
 * and films: where assets live, the track list to attach to, the fps that
 * turns seconds into frames, and the natural bed length.
 */
async function describeTarget(target) {
  const t = await store.resolveAssetTarget(qualifyTarget(target));
  if (t.kind === 'scene') {
    const config = await store.readConfig(t.id);
    return { ...t, config, fps: config.fps, durationInFrames: config.durationInFrames, output: config.output ?? {} };
  }
  const film = await store.getFilm(t.id);
  const plan = await planFilm({ film, store });
  return {
    ...t,
    film,
    plan,
    fps: plan.fps ?? film.sceneDefaults?.fps ?? 30,
    durationInFrames: plan.totalFrames || null,
    output: {},
  };
}

/**
 * Locate ONE media file the way the read-only media tools address it: a path
 * inside a target under `assets/` (supplied material) or `out/` (something the
 * engine rendered), or a workspace-library path when `target` is omitted.
 *
 * Shared by `probe_asset` and `transcribe_asset` because they answer the two
 * questions you have about a file you did not make — "what is it?" and "what
 * does it say?" — and reaching them differently would be a trap.
 *
 * `out/` is readable here and nowhere else: verifying a finished cut means
 * probing or re-transcribing `out/film.mp4`, which both tools advertise. Writes
 * stay confined to assets/.
 */
async function locateMedia(relPath, target) {
  if (target === undefined || target === null || target === '') {
    const abs = store.libraryFilePath(WORKSPACE, relPath);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new EngineError(
        ErrorCodes.FILE_NOT_FOUND,
        `No such library file "${relPath}" (list_shared_assets shows what is there)`,
        { path: relPath },
      );
    }
    return {
      source: 'library',
      path: String(relPath).replace(/\\/g, '/'),
      abs,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
    };
  }
  const a = await store.resolveMediaFile(qualifyTarget(target), relPath);
  return {
    source: a.target.kind, target: localId(a.target.id), path: a.path,
    abs: a.abs, bytes: a.bytes, mtime: a.mtime, kind: a.kind,
  };
}

/** A stable, human-readable label for a source stored in a transcode sidecar. */
function sourceAssetReference(source) {
  return source.source === 'library'
    ? `library:${source.path}`
    : `${source.source}:${source.target}:${source.path}`;
}

/** Resolve an encoded deliverable, defaulting to the target's canonical out/ file. */
async function locateRenderedMedia(target, relPath) {
  const t = await describeTarget(target);
  if (relPath) {
    const located = await locateMedia(relPath, target);
    return { t, ...located };
  }
  const relative = t.kind === 'scene'
    ? `${t.output.dir ?? 'out'}/${t.output.filename ?? 'output.mp4'}`
    : `out/${String(t.film.outputFilename ?? 'film').replace(/\.[a-z0-9]+$/i, '')}${getFormat(t.plan.format ?? 'mp4').ext}`;
  const abs = path.join(t.path, ...relative.split('/'));
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat?.isFile()) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `No rendered output at "${relative}" — render the scene or build the film first, or pass an out/-relative path.`,
      { target, path: relative });
  }
  return { t, source: t.kind, target: localId(t.id), path: relative, abs, bytes: stat.size, mtime: stat.mtime.toISOString() };
}

function renderReviewLayout(t) {
  if (t.kind === 'film') {
    return (t.plan.scenes ?? []).map((entry) => ({
      ...entry,
      ...(entry.sceneId ? { sceneId: localId(entry.sceneId) } : {}),
    }));
  }
  return [{ sceneId: localId(t.id), name: t.config.name, filmOffset: 0, durationInFrames: t.durationInFrames }];
}

/**
 * The ffmpeg binary this server uses — for the prereq probe AND for every
 * render/film it runs, so the check can never pass on one binary while the
 * encode reaches for another. Shared with the Studio and the CLI.
 */
const resolveFfmpeg = () => resolveFfmpegPath({ dataDir: store.dataDir });

/** The resolved binary, for the tools that spawn ffmpeg themselves. */
const ffmpegPathOnly = async () => (await resolveFfmpeg()).path;

/**
 * The `vendorNote` a synthesize_* response carries when the vendor that ran is
 * not the obvious one (v0.19). Two cases, either or both:
 *
 *   - the call named a vendor explicitly that differs from this machine's
 *     configured default — the override applies to this call only;
 *   - resolution walked a preference chain past a higher-priority vendor that
 *     is not available here.
 *
 * A fallback nobody can see is the failure mode preference chains have to avoid,
 * so this is not decoration. Never throws: a note must not be able to fail the
 * synthesis it annotates.
 */
async function vendorNoteFor(capability, resolved) {
  const notes = [];
  try {
    const fallback = chainFallbackNote(capability, resolved);
    if (fallback) notes.push(fallback);
    if (resolved.source === 'argument') {
      const resolveDefault = {
        music: resolveMusicVendor,
        transcription: resolveTranscriptionVendor,
      }[capability] ?? resolveSpeechVendor;
      const dflt = await resolveDefault({ dataDir: store.dataDir });
      if (dflt.vendor !== resolved.vendor) {
        notes.push(
          `Explicit vendor "${resolved.vendor}" overrides this machine's default ` +
          `"${dflt.vendor}"${dflt.chain?.length > 1 ? ` (chain: ${dflt.chain.join(' → ')})` : ''} for this call only — ` +
          'vendor-less calls (and the Studio UI) keep using the default; change it in Studio settings to make this permanent.',
        );
      }
    }
  } catch { /* a hint is never worth failing over */ }
  return notes.length ? { vendorNote: notes.join(' ') } : {};
}

/**
 * Cache prereq result; re-check on demand if it previously failed, or if the
 * effective binary changed (the user can edit settings.json while we're up).
 */
let prereqCache = null;
async function requirePrereqs() {
  const ffmpeg = await resolveFfmpeg();
  if (!prereqCache || !prereqCache.result.ok || prereqCache.ffmpeg.path !== ffmpeg.path) {
    prereqCache = { ffmpeg, result: await checkPrerequisites({ ffmpegPath: ffmpeg.path }) };
  }
  if (!prereqCache.result.ok) {
    const where =
      ffmpeg.source === 'PATH'
        ? 'ensure ffmpeg is on PATH'
        : `the configured binary "${ffmpeg.path}" (from ${ffmpeg.source}) could not be run`;
    throw new EngineError(
      ErrorCodes.PREREQS_MISSING,
      'Node.js and/or FFmpeg prerequisites are not satisfied on this machine. ' +
        `This must be fixed by the user (install FFmpeg / Node >= 18; ${where}) — do not retry.`,
      {
        ...prereqCache.result,
        ffmpeg: { ...prereqCache.result.ffmpeg, effectivePath: ffmpeg.path, source: ffmpeg.source },
      },
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

/** Smallest-free assets/<prefix>-<n>.wav (mirrors render_still's still-<frame> defaulting). */
async function nextAssetWav(assetsDir, prefix) {
  let existing;
  try { existing = new Set(await fsp.readdir(assetsDir)); } catch { existing = new Set(); }
  let n = 1;
  while (existing.has(`${prefix}-${n}.wav`)) n++;
  return `assets/${prefix}-${n}.wav`;
}

/* ------------------------------------------------------------------ */
/* Server + tools                                                      */
/* ------------------------------------------------------------------ */

const renderCompositionInjected = (o) => renderComposition({ ...o, browserFactory: injectedBrowserFactory });
// Workers inherit the env hook, but the parent's pre-flight page (v0.10) needs
// the factory handed to it explicitly.
const renderParallelInjected = (o) => renderParallel({ ...o, browserFactory: injectedBrowserFactory });

// The engine's one version lives in package.json; advertising a hardcoded copy
// here drifted once (0.15.0 while the engine was at 0.19.0) and never again.
const enginePkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);

const server = new McpServer({ name: 'motion-studio', version: enginePkg.version });

/* ------------------------------------------------------------------ */
/* Agent-economy proxies (TE P1-4)                                     */
/* ------------------------------------------------------------------ */

// Every tool is counted from ONE place: registerTool is decorated here, so a
// new tool is measured the day it is written and no handler carries telemetry
// code. `wrap()` itself cannot do this — it never sees the tool's name.
// Counting happens AFTER the handler resolved, adds no async hop to the
// response path, and can never fail a call.
const economy = createAgentEconomy({ dataDir: store.dataDir, workspace: WORKSPACE, agent: AGENT });
economy.installExitFlush();
const registerToolDirect = server.registerTool.bind(server);
server.registerTool = (name, def, handler) => {
  const hasInput = def?.inputSchema !== undefined; // the SDK calls cb(extra) when there is none
  return registerToolDirect(name, def, async (...callArgs) => {
    const result = await handler(...callArgs);
    try { economy.record(name, hasInput ? callArgs[0] : undefined, result); }
    catch { /* a counter is never worth failing a tool call over */ }
    return result;
  });
};

/** Plan projection shared by the film tools: layout + problems, local ids. */
function planSummary(plan) {
  return {
    totalFrames: plan.totalFrames,
    durationSeconds: plan.durationSeconds,
    fps: plan.fps,
    format: plan.format,
    // The film's encode contract (v0.22) — what a file must look like to join
    // this film. planFilm computed the comparison string long before this, and
    // this projection dropped it, so no agent could see the one thing only the
    // engine knows. One edit here covers get_film, list_films, update_film and
    // build_film { plan: true }.
    signature: plan.signature,
    // Orphaned narrative metadata (v0.27): `sequences` keys no segment carries
    // any more. Additive and omitted when clean, so a healthy film's plan looks
    // exactly as it always did.
    ...(plan.unreferencedSequences?.length ? { unreferencedSequences: plan.unreferencedSequences } : {}),
    sceneLayout: plan.scenes.map((s) => (s.kind === 'footage'
      // Footage segments (v0.22) report the same placement fields as scenes, so
      // "where does segment 6 start" is one question regardless of kind — plus
      // what the probe measured, since a supplied file's truth is the file.
      ? {
        kind: 'footage',
        footage: s.footage,
        name: s.name,
        filmOffset: s.filmOffset,
        durationInFrames: s.durationInFrames,
        startSeconds: s.startSeconds,
        ...(s.label ? { label: s.label } : {}),
        ...(s.derivedFrom ? { derivedFrom: s.derivedFrom } : {}),
        ...(s.probed
          ? {
            width: s.width, height: s.height, fps: s.fps, codec: s.codec, pixFmt: s.pixFmt,
            signature: s.signature, hasAudio: s.hasAudio,
            actualFrames: s.actualFrames,
            // true = the declaration matches the file; false = it does not;
            // null = ffprobe could not say, which is NOT "matches".
            framesVerified: s.framesVerified,
          }
          : { probed: false, framesVerified: null }),
        ...(s.missing ? { missing: true } : {}),
      }
      : {
        kind: 'scene',
        scene: localId(s.sceneId), slug: s.slug, name: s.name, filmOffset: s.filmOffset,
        durationInFrames: s.durationInFrames, startSeconds: s.startSeconds,
        // rendered = a file is there; renderVerified = it still matches the
        // scene's settings (null when it predates the render sidecar).
        rendered: s.rendered, renderVerified: s.renderVerified ?? null,
        ...(s.staleRender ? { staleRender: s.staleRender } : {}),
        ...(s.missing ? { missing: true } : {}),
      })),
    problems: plan.problems,
  };
}

server.registerTool(
  'get_workspace',
  {
    title: 'This agent\'s workspace',
    description:
      'Describe the workspace this server is bound to (MOTION_STUDIO_WORKSPACE): its name, folder, films, and ' +
      'the shared-asset library summary. Every other tool operates inside this workspace — films are addressed ' +
      'as "<film>" and scenes as "<film>/<scene>". The human\'s Studio UI shows all workspaces; this server ' +
      'sees only this one. Returns prereqs_missing if Node/FFmpeg are not installed. ' +
      'Production protocol (v0.23): after this call, run check_human_advice before planning new work — the ' +
      'human may have left advice while no agent was running — and again at each checkpoint. There is no ' +
      'approval gate; never wait for a human response.',
    inputSchema: {},
  },
  wrap(async () => {
    await requirePrereqs();
    const ws = await store.getWorkspace(WORKSPACE);
    const films = await store.listFilms(WORKSPACE);
    const library = await store.listLibrary(WORKSPACE);
    return ok({
      workspace: ws.id,
      name: ws.name,
      path: ws.path,
      films: films.map((f) => ({ film: f.slug, name: f.name, scenes: f.scenes, ...(f.broken ? { broken: true } : {}) })),
      library: { files: library.length, bytes: library.reduce((n, f) => n + f.bytes, 0) },
    });
  }),
);

server.registerTool(
  'list_films',
  {
    title: 'List this workspace\'s films',
    description:
      'Every film in this workspace. COMPACT BY DEFAULT (detail "summary"): per film its length, format, ' +
      'readiness counts, and problem count. detail "full" adds each film\'s complete resolved plan (scene ' +
      'layout with every filmOffset, the signature, the full problems list) — ask for it only when you need ' +
      'the layout of every film at once; get_film serves one film\'s plan. A film with problems can be ' +
      'edited but not built. Use create_film / update_film to change one, build_film to assemble one.',
    inputSchema: {
      detail: z.enum(['summary', 'full']).optional()
        .describe('summary (default): compact per-film rows. full: each film\'s complete resolved plan.'),
    },
  },
  wrap(async ({ detail = 'summary' } = {}) => {
    const films = await store.listFilms(WORKSPACE);
    const out = [];
    for (const f of films) {
      if (f.broken) { out.push({ film: f.slug, name: f.name, broken: true }); continue; }
      const film = await store.getFilm(f.id).catch(() => null);
      const plan = film && await planFilm({ film, store }).catch(() => null);
      if (detail === 'full' || !plan) {
        out.push({ film: f.slug, name: f.name, updatedAt: f.updatedAt, ...(plan ? planSummary(plan) : {}) });
        continue;
      }
      const rows = segmentRows(plan, localId);
      out.push({
        film: f.slug,
        name: f.name,
        updatedAt: f.updatedAt,
        totalFrames: plan.totalFrames,
        durationSeconds: plan.durationSeconds,
        fps: plan.fps,
        format: plan.format,
        readiness: {
          total: rows.length,
          rendered: rows.filter((r) => r.state === 'rendered' || r.state === 'present').length,
          stale: rows.filter((r) => r.state === 'stale').length,
          missing: rows.filter((r) => r.state === 'missing').length,
          problems: plan.problems.length,
        },
      });
    }
    return ok({ workspace: WORKSPACE, detail, films: out });
  }),
);

// A creation request may name a global preset by id or supply a full custom
// variant. The core resolver snapshots presets into the film document; this
// input intentionally keeps fields optional so `{ id: "shorts-9x16" }` is the
// normal agent call while validation still rejects incomplete custom ids.
const DELIVERABLE_INSETS = z.object({
  leftPct: z.number().min(0).max(100).optional(),
  rightPct: z.number().min(0).max(100).optional(),
  topPct: z.number().min(0).max(100).optional(),
  bottomPct: z.number().min(0).max(100).optional(),
}).passthrough();
const DELIVERABLE_POINT = z.object({
  xPct: z.number().min(0).max(100).optional(),
  yPct: z.number().min(0).max(100).optional(),
}).passthrough();
const FILM_DELIVERABLE_INPUT = z.union([
  z.string(),
  z.object({
    id: z.string(),
    label: z.string().optional(),
    width: z.number().int().min(2).max(7680).optional(),
    height: z.number().int().min(2).max(4320).optional(),
    outputFilename: z.string().optional(),
    captionStyle: z.object({
      sizePct: z.number().min(1).max(20).optional(),
      position: z.enum(['bottom', 'top']).optional(),
    }).passthrough().optional(),
    safeAreas: z.object({
      title: DELIVERABLE_INSETS.optional(),
      caption: DELIVERABLE_INSETS.optional(),
    }).passthrough().optional(),
    reframe: z.object({
      default: DELIVERABLE_POINT.optional(),
      segments: z.record(DELIVERABLE_POINT).optional(),
    }).passthrough().optional(),
  }).passthrough(),
]);

server.registerTool(
  'create_film',
  {
    title: 'Create a film',
    description:
      'Create a new film in this workspace — the container a video is authored in. A film holds ordered SCENES ' +
      '(each its own composition, made with create_scene), a master audio timeline, caption and overlay tracks, ' +
      'and its built output. fps/width/height/durationInFrames become the film\'s sceneDefaults: every scene ' +
      'created inside inherits them unless overridden, which keeps scenes concat-compatible (scenes must share ' +
      'resolution/fps/format to stitch losslessly) without restating dimensions per scene. Omitted dimensions ' +
      'fall back to the user\'s global settings (factory: 30fps 1920×1080, 150 frames). ' +
      'Even a short single-scene video is a film with one scene — a film is always the container. ' +
      'deliverables optionally names platform preset ids (for example youtube-16x9 and shorts-9x16); they are ' +
      'snapshotted onto the new film before any scene exists, so the editor only reviews/refines the AI choice.',
    inputSchema: {
      name: z.string().min(1).describe('Human-readable film name; the film id is its slug'),
      slug: z.string().optional().describe('Override the derived film slug (lowercase a-z0-9-_)'),
      fps: z.number().int().min(1).max(240).optional().describe('Scene default fps'),
      width: z.number().int().min(2).max(7680).optional().describe('Scene default width (even)'),
      height: z.number().int().min(2).max(4320).optional().describe('Scene default height (even)'),
      durationInFrames: z.number().int().min(1).optional().describe('Scene default duration'),
      outputFilename: z.string().optional().describe('Bare output filename for builds (default "film")'),
      deliverables: z.array(FILM_DELIVERABLE_INPUT).optional().describe(
        'Platform preset ids or full deliverable objects. Example: [{id:"youtube-16x9"},{id:"shorts-9x16"}]. ' +
        'Omit for the workspace new-film default (normally master only).',
      ),
    },
  },
  wrap(async ({ name, slug, fps, width, height, durationInFrames, outputFilename, deliverables }) => {
    await requirePrereqs();
    const settings = await readSettings(store.dataDir).catch(() => structuredClone(DEFAULT_SETTINGS));
    const resolvedDeliverables = resolveDeliverableSelections({
      presets: settings.deliverablePresets,
      requested: deliverables,
      defaultIds: settings.newFilmDefaults?.deliverableIds ?? [],
      baseFilename: outputFilename ?? 'film',
    });
    const sceneDefaults = withNewSceneDefaults(settings, { fps, width, height, durationInFrames });
    const primary = resolvedDeliverables[0];
    // Platform intent becomes the master canvas only when the caller did not
    // explicitly choose a dimension. AI calls like "YouTube and TikTok" thus
    // start landscape, then derive portrait from the same cut.
    if (primary) {
      if (width === undefined) sceneDefaults.width = primary.width;
      if (height === undefined) sceneDefaults.height = primary.height;
    }
    const film = await store.createFilm(WORKSPACE, {
      name, slug, sceneDefaults, outputFilename, deliverables: resolvedDeliverables,
    });
    return ok({
      film: film.slug,
      name: film.name,
      path: film.path,
      sceneDefaults: film.sceneDefaults,
      outputFilename: film.outputFilename,
      deliverables: film.deliverables,
      next: 'Add scenes with create_scene { film, name }, then author each with write_composition_file.',
    });
  }),
);

server.registerTool(
  'get_film',
  {
    title: 'Get a film',
    description:
      'The full film document (scene order, master audio, overlays, captions, mastering options) plus the ' +
      'resolved plan: per-scene filmOffset/duration/rendered state and a `problems` list. filmOffset is what ' +
      'master audio, sfx cues and captions are placed against — never accumulate scene durations by hand. ' +
      'Also returns `revision`: pass it to update_film as expectedRevision so your patch cannot silently ' +
      'revert edits the human made in the Studio while you were thinking. detail "full" (default) is this ' +
      'complete editing shape; for the production loop prefer detail "scenes" (readiness + one compact row ' +
      'per segment, no document body) or "summary" (readiness only) — or get_production_status, which also ' +
      'carries advice/delivery state and a cursor.',
    inputSchema: {
      film: z.string().describe('Film id (slug) from list_films/create_film'),
      detail: z.enum(['summary', 'scenes', 'full']).optional()
        .describe('full (default): the complete document + plan, for editing. scenes: compact per-segment rows. summary: readiness facts only.'),
    },
  },
  wrap(async ({ film, detail = 'full' }) => {
    const doc = await store.getFilm(qualifyFilm(film));
    const plan = await planFilm({ film: doc, store });
    if (detail !== 'full') {
      const rows = segmentRows(plan, localId);
      return ok({
        film: doc.slug,
        name: doc.name,
        revision: doc.revision,
        totalFrames: plan.totalFrames,
        durationSeconds: plan.durationSeconds,
        fps: plan.fps,
        format: plan.format,
        signature: plan.signature,
        readiness: {
          total: rows.length,
          rendered: rows.filter((r) => r.state === 'rendered' || r.state === 'present').length,
          stale: rows.filter((r) => r.state === 'stale').length,
          missing: rows.filter((r) => r.state === 'missing').length,
          problems: plan.problems.length,
        },
        problems: plan.problems, // complete, always
        ...(detail === 'scenes' ? { scenes: rows } : {}),
      });
    }
    const { id, workspace, path: filmPath, ...fields } = doc;
    return ok({
      film: doc.slug,
      path: filmPath,
      ...fields,
      plan: planSummary(plan),
      editorUrl: `/film.html?id=${encodeURIComponent(id)}`,
    });
  }),
);

/**
 * A number-or-null argument that survives schema-flattening clients (v0.23).
 *
 * The union publishes as anyOf[number, null] — the portable shape, and the
 * one the schema test guards — but a client that flattens anyOf to `{}` has
 * no type to coerce against and delivers the model's argument as a STRING
 * ("-2"), which the plain union then rejects. Measured in production: a
 * build_film call with audioTargetPeakDb -2 failed input validation because
 * it arrived as "-2". The preprocess accepts those string forms at runtime
 * ("-2" → -2, "null"/"" → null) while leaving the published schema and every
 * well-typed caller untouched; a non-numeric string still fails with the
 * normal typed error.
 */
const nullableNumber = (inner) => z.preprocess((v) => {
  if (v === 'null' || v === '') return null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}, z.union([inner, z.null()]));

const FILM_AUDIO_TRACK = z.object({
  id: z.string().optional().describe('Stable track id (assigned if omitted)'),
  label: z.string().optional().describe('Editor display label (not used by the mixer)'),
  src: z.string().describe('Film-relative audio under the film\'s assets/'),
  startInFrames: z.number().int().min(0).optional(),
  gainDb: z.number().optional(),
  trimEndInFrames: z.number().int().min(1).optional(),
  fadeInFrames: z.number().int().min(0).optional(),
  fadeOutFrames: z.number().int().min(0).optional(),
  duck: z.boolean().optional(),
});
const FILM_OVERLAY = z.object({
  id: z.string().optional(),
  src: z.string().describe('Image or video under the film\'s assets/ (transparent .webm keeps alpha)'),
  fromFrame: z.number().int().min(0),
  toFrame: z.number().int().min(1),
  xPct: z.number().min(-100).max(200).optional().describe('Top-left x as % of frame width (default 0)'),
  yPct: z.number().min(-100).max(200).optional().describe('Top-left y as % of frame height (default 0)'),
  // Do not use `.nullable()` here: the MCP SDK's Zod → JSON Schema conversion
  // publishes that form as `{}`, so clients cannot coerce a numeric argument.
  // nullableNumber further accepts the string forms sent by clients that
  // flattened the published anyOf anyway — see its definition above.
  widthPct: nullableNumber(z.number().min(0.1).max(400)).optional()
    .describe('Width as % of frame width, aspect kept; null = natural size'),
  opacity: z.number().min(0).max(1).optional(),
});
const FILM_CAPTION = z.object({
  id: z.string().optional(),
  text: z.string().min(1),
  fromFrame: z.number().int().min(0),
  toFrame: z.number().int().min(1),
});
const FILM_DERIVED_FROM = z.object({
  asset: z.string().min(1).describe('Source asset reference returned by transcode_asset, e.g. library:raw.mp4'),
  transcodeMeta: z.string().describe('Film-relative .transcode.json sidecar returned by transcode_asset'),
});
const FILM_REVIEW_POLICY = z.object({
  block: z.array(z.enum(REVIEW_WARNING_CODES)).optional(),
  warn: z.array(z.enum(REVIEW_WARNING_CODES)).optional(),
}).nullable();

server.registerTool(
  'update_film',
  {
    title: 'Update a film document',
    description:
      'Patch the film document: name, scene ORDER (`scenes` — this is how you reorder or drop segments from the ' +
      'cut; the scene folders themselves are untouched), master audio timeline, overlay track, caption ' +
      'track, captionStyle, audioTargetPeakDb, burnCaptions, outputFilename, deliverables, sceneDefaults, and review policy. Omitted fields keep ' +
      'their saved values; ARRAY FIELDS REPLACE WHOLESALE (a timeline edit is a statement of the whole track) — ' +
      'and inside `scenes` each SEGMENT OBJECT REPLACES THAT SEGMENT, so a field you leave out is a field you ' +
      'ERASE: {slug:"intro"} with no `sequence` CLEARS that segment\'s narrative label and strands its ' +
      '`sequences` metadata. The safe way to reorder or drop is therefore to CARRY THE SEGMENT OBJECTS THROUGH ' +
      'from get_film — reorder/filter the array you read and spread each entry ({...seg}) — not to hand-build a ' +
      'bare [{slug}] list. (Clearing IS how you ungroup: send the segment without `sequence` on purpose, and ' +
      'drop the now-unused key from `sequences` in the same patch.) The response carries a `warnings` array ' +
      'whenever a patch cleared labels, and the plan reports `unreferencedSequences`. ' +
      'Audio, meanwhile, has two ADDRESSED alternatives for editing a saved timeline without restating it: ' +
      'audioPatch (change named tracks by id) and audioGainOffsetDb (shift the whole mix, preserving balance). ' +
      'Audio/overlay src paths are relative to the FILM\'s assets/ — put master audio there by targeting the ' +
      'film id in synthesize_* / write_asset_file. Times are frames on the film timeline; get scene offsets ' +
      'from get_film\'s plan. The response echoes the plan with its `problems` — a film with problems saves ' +
      'fine but cannot build. The Studio\'s film editor edits this same document; changes are shared both ways.',
    inputSchema: {
      film: z.string(),
      name: z.string().min(1).optional(),
      // A union, not an object with optional keys: zod strips unknown keys, so a
      // single loose shape would silently discard whichever half the caller sent
      // — which for footage means the entry vanishes before the handler runs.
      scenes: z.array(z.union([
        z.object({
          slug: z.string(),
          sequence: z.string().max(80).optional()
            .describe('Narrative sequence label (v0.23) — consecutive segments sharing one form a story band the human navigates by'),
        }),
        z.object({
          id: z.string().optional()
            .describe('Stable clip id (assigned if omitted). Keep it when reordering — human advice on this clip is bound to it'),
          footage: z.string(),
          durationInFrames: z.number().int().positive(),
          label: z.string().optional(),
          sequence: z.string().max(80).optional(),
          derivedFrom: FILM_DERIVED_FROM.optional(),
        }),
      ])).optional()
        .describe('Play order — a heterogeneous list of SEGMENTS. A scene is {slug:"intro"}; a piece of FOOTAGE is ' +
          '{footage:"assets/clip.mp4", durationInFrames:231} (v0.22), which puts real video on the timeline beside ' +
          'the rendered scenes — that is how you build "footage, then a scene, then footage". Footage must be silent ' +
          'and must match the film signature (get_film reports it); `durationInFrames` is verified against the file, ' +
          'because every later offset derives from it. A prepared clip may also carry the `derivedFrom` object returned ' +
          'by transcode_asset; it makes planFilm flag a source replacement before a build. Reorder or drop segments here; create scenes with create_scene ' +
          'and put footage in the film\'s assets/ first (use_shared_asset or write_asset_file). ' +
          'This array REPLACES the play order and each entry REPLACES that segment, so start from the segments in ' +
          'get_film and spread them ({...seg}): every field you do not restate is erased, including `sequence` ' +
          'labels and a footage segment\'s stable `id` — the anchor the human\'s advice on that clip is bound to.'),
      outputFilename: z.string().optional().describe('Bare output filename (default "film")'),
      sceneDefaults: z.object({
        fps: z.number().int().min(1).max(240).optional(),
        width: z.number().int().min(2).max(7680).optional(),
        height: z.number().int().min(2).max(4320).optional(),
        durationInFrames: z.number().int().min(1).optional(),
      }).optional().describe('Defaults inherited by newly created scenes'),
      audio: z.array(FILM_AUDIO_TRACK).optional().describe('Master audio timeline (replaces per-scene audio at build)'),
      audioPatch: z.array(FILM_AUDIO_TRACK.partial().extend({ id: z.string() })).optional().describe(
        'Edit NAMED tracks on the saved timeline instead of re-sending it whole: [{id, gainDb: -6}]. Fields you omit '
        + 'keep their values, tracks you do not name are untouched. Cannot add or remove tracks (use `audio`), and an '
        + 'unknown id is an error rather than a silent no-op. Mutually exclusive with `audio`.',
      ),
      audioGainOffsetDb: z.number().min(-60).max(60).optional().describe(
        'Shift EVERY track on the saved timeline by this many dB, preserving the balance between them. This is the '
        + 'documented fix when a build reports clipping: the mix comes down as one, so a balance you already verified '
        + 'with preview_audio still holds. Applied after audioPatch. Mutually exclusive with `audio`.',
      ),
      overlays: z.array(FILM_OVERLAY).optional(),
      captions: z.array(FILM_CAPTION).optional(),
      captionStyle: z.object({
        sizePct: z.number().min(1).max(20).optional().describe('Font size as % of frame height (default 4.5)'),
        position: z.enum(['bottom', 'top']).optional(),
      }).optional(),
      sequences: z.record(z.object({
        intent: z.string().max(500).optional().describe('What this sequence is for — shown to the human, and to future directors'),
      })).optional().describe(
        'Narrative sequence metadata keyed by the labels used on segments (v0.23). Label segments via ' +
        'scenes[i].sequence; describe each label\'s intent here. Presentation only — renders nothing, moves no files. ' +
        'This record replaces the saved one, and it does NOT follow the labels: a key whose label no longer sits on ' +
        'any segment stays behind describing nothing, and the plan reports it as `unreferencedSequences`.',
      ),
      deliverables: z.array(FILM_DELIVERABLE_INPUT).optional().describe(
        'Whole Stage-A deliverable list. Entries are saved platform snapshots; update their output name, caption style, safe areas, or reframe centers here.',
      ),
      audioTargetPeakDb: nullableNumber(z.number().min(-60).max(0)).optional()
        .describe('Master the mix to this peak on build (e.g. -2); null disables'),
      burnCaptions: z.boolean().optional().describe('Burn captions into the picture (a .srt sidecar is written either way)'),
      review: FILM_REVIEW_POLICY.optional().describe(
        'Per-film delivery review policy. block/warn are arrays of stable warning codes; omitted fields inherit the global setting, and null restores full inheritance.',
      ),
      expectedRevision: z.string().optional().describe(
        'The `revision` from your get_film. Array fields replace wholesale, so a patch written against a stale ' +
        'read silently reverts whatever the human changed in the Studio meanwhile. Pass this and you get a ' +
        'film_conflict error instead — re-read, re-apply, retry. Omit only for a field you know nobody else touches.',
      ),
    },
  },
  wrap(async ({ film, expectedRevision, ...fields }) => {
    const provided = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const filmId = qualifyFilm(film);
    // Read the play order BEFORE the write, and only when this patch restates
    // it — the one case where a label can vanish without anybody saying so.
    const before = provided.scenes !== undefined ? await store.getFilm(filmId) : null;
    const doc = await store.updateFilm(filmId, provided, { expectedRevision });
    const warnings = before ? sequenceLossWarnings(before, doc) : [];
    const plan = await planFilm({ film: doc, store });
    return ok({
      film: doc.slug,
      name: doc.name,
      updatedAt: doc.updatedAt,
      revision: doc.revision,
      plan: planSummary(plan),
      ...(warnings.length ? { warnings } : {}),
    });
  }),
);

/**
 * Narrative labels a `scenes` patch cleared without saying so (v0.27).
 *
 * `scenes` replaces the play order and each entry replaces its segment, so a
 * patch hand-built from bare {slug} objects — the shape it is most tempting to
 * write for a reorder — erases every `sequence` label while `film.sequences`
 * stays behind describing nothing. Replacement is the right store semantics
 * (the Studio's ungroup is exactly a segment sent without its label), so the
 * fix is not to change the write: it is to say what the write did, here at the
 * boundary where the agent that wrote it can still read the answer.
 *
 * Only segments present in BOTH documents count. Dropping a labelled segment
 * from the cut is a stated intention, not a loss, and warning about it would
 * teach agents to ignore the field.
 */
function sequenceLossWarnings(before, after) {
  const key = (s) => (s?.footage !== undefined ? `footage:${s.id}` : `scene:${s.slug}`);
  const wasLabelled = new Map();
  for (const s of before.scenes ?? []) if (s?.sequence) wasLabelled.set(key(s), s.sequence);
  const cleared = [];
  for (const s of after.scenes ?? []) {
    const had = wasLabelled.get(key(s));
    if (had && !s?.sequence) cleared.push(had);
  }
  if (!cleared.length) return [];
  const labels = [...new Set(cleared)];
  // Only metadata THIS patch stranded: a key that was already describing
  // nothing before the call is the plan's `unreferencedSequences` to report,
  // not this call's fault to confess.
  const wasInUse = new Set((before.scenes ?? []).map((s) => s?.sequence).filter(Boolean));
  const inUse = new Set((after.scenes ?? []).map((s) => s?.sequence).filter(Boolean));
  const orphans = Object.keys(after.sequences ?? {}).filter((label) => wasInUse.has(label) && !inUse.has(label));
  return [
    `This patch cleared the \`sequence\` label on ${cleared.length} segment${cleared.length === 1 ? '' : 's'} (${labels.join(', ')}).`
    + (orphans.length
      ? ` ${orphans.length} \`sequences\` ${orphans.length === 1 ? 'entry is' : 'entries are'} now unreferenced: ${orphans.join(', ')}.`
      : '')
    + ' A segment object REPLACES the segment — carry the segment objects through from get_film rather than'
    + ' rebuilding a bare [{slug}] list. Ignore this if you meant to ungroup.',
  ];
}

server.registerTool(
  'remove_film',
  {
    title: 'Remove a film',
    description:
      'Remove a film. deleteFiles=false (default) removes only the film document — the folder with its scenes, ' +
      'assets and built output stays on disk (listed as `broken` until cleaned up). deleteFiles=true deletes the ' +
      'ENTIRE film folder including every scene and rendered output. Irreversible — confirm with the user first.',
    inputSchema: {
      film: z.string(),
      deleteFiles: z.boolean().default(false),
    },
  },
  wrap(async ({ film, deleteFiles }) => {
    const res = await store.removeFilm(qualifyFilm(film), { deleteFiles });
    return ok({ ...res, id: localId(res.id) });
  }),
);

server.registerTool(
  'build_film',
  {
    title: 'Build a film (async job)',
    description:
      'Assemble the film\'s rendered scenes into its deliverable, as an ASYNC JOB — returns a jobId immediately; ' +
      'block with wait_for_render (or poll get_render_status). The build concatenates scene outputs LOSSLESSLY ' +
      '(ffmpeg -c copy, no re-encode, near-instant), lays the film\'s master audio timeline over the whole length ' +
      '(replacing per-scene audio when present), and — only when the film has overlays or burns captions — runs ' +
      'ONE finishing encode that composites them (crf/preset from the first scene\'s output config). Captions ' +
      'always also write a .srt sidecar. Output lands in the film\'s out/. Every scene must already be rendered ' +
      '(scene_not_rendered lists offenders); scenes must share resolution/fps/format (inconsistent_scenes). ' +
      'The finished job\'s status carries the measured audio block (peakDb/meanDb/clipping) when a master ' +
      'timeline exists — READ IT; a bad mix is the one defect you cannot see. Set audioTargetPeakDb (e.g. -2) ' +
      'to have the film measured and re-muxed once to that level instead of guessing gains. ' +
      'Pass plan:true to get the scene layout WITHOUT building — works before the scenes are rendered, which is ' +
      'exactly when you need each filmOffset to place narration and cues; nothing is assembled or written. ' +
      'Pass deliverable to build a configured Stage-A platform variant from the same master cut; it re-encodes to ' +
      'the target geometry and writes independent captions/review artefacts. Iterating? Re-render only the scene you changed, then build_film again — other scenes\' outputs are reused. ' +
      'Every successful build is also archived as an immutable delivery (v0.23) with a frozen manifest of the ' +
      'exact scene revisions it played; the finished job status carries its deliveryId — link it when resolving advice.',
    inputSchema: {
      film: z.string(),
      plan: z.boolean().optional()
        .describe('Return the resolved layout + problems without building (works before scenes are rendered)'),
      outputFilename: z.string().optional().describe('Override + persist the film\'s output filename'),
      audioTargetPeakDb: nullableNumber(z.number().min(-60).max(0)).optional()
        .describe('Override + persist the mastering target'),
      burnCaptions: z.boolean().optional().describe('Override + persist caption burn-in'),
      deliverable: z.string().optional().describe('Configured deliverable id to build (for example "shorts-9x16"); omit for the master'),
    },
  },
  wrap(async ({ film, plan: planOnly, deliverable, ...knobs }) => {
    await requirePrereqs();
    const id = qualifyFilm(film);
    if (planOnly) {
      const doc = await store.getFilm(id);
      const plan = await planFilm({ film: doc, store });
      return ok({ film: doc.slug, plan: true, ...planSummary(plan) });
    }
    if (deliverable && knobs.outputFilename !== undefined) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG,
        'outputFilename belongs to the configured deliverable when building a variant; update that deliverable instead');
    }
    const patch = Object.fromEntries(Object.entries(knobs).filter(([, v]) => v !== undefined));
    const doc = Object.keys(patch).length
      ? await store.updateFilm(id, patch)
      : await store.getFilm(id);
    const submitted = await submitFilmBuild({
      film: doc, store, jobs, ffmpegPath: await ffmpegPathOnly(), deliverableId: deliverable ?? null,
      agent: AGENT,
    });
    return ok({
      ...submitted,
      filmId: localId(submitted.filmId),
      hint: 'Poll with get_render_status { jobId } or wait_for_render { jobIds: [jobId] }.',
    });
  }),
);

server.registerTool(
  'create_scene',
  {
    title: 'Create a scene in a film',
    description:
      'Scaffold a new scene inside a film from the default template and append it to the film\'s play order. ' +
      'A scene is one composition — the unit that renders. durationInFrames = seconds × fps. Dimensions you ' +
      'omit inherit the film\'s sceneDefaults (set at create_film), which keeps every scene concat-compatible; ' +
      'read `config` in the response to see what it actually got. Returns the scene id ("<film>/<scene>") used ' +
      'by all composition/render tools. A duration over ~90 seconds returns structureWarnings: long videos ' +
      'should be MANY short scenes stitched by build_film, not one giant composition — heed it before authoring.',
    inputSchema: {
      film: z.string().describe('The film this scene belongs to'),
      name: z.string().min(1).describe('Human-readable scene name'),
      slug: z.string().optional().describe('Override the derived scene slug'),
      fps: z.number().int().min(1).max(240).optional().describe('Default: the film\'s sceneDefaults'),
      width: z.number().int().min(2).max(7680).optional().describe('Must be even. Default: film sceneDefaults'),
      height: z.number().int().min(2).max(4320).optional().describe('Must be even. Default: film sceneDefaults'),
      durationInFrames: z.number().int().min(1).optional().describe('Default: film sceneDefaults'),
    },
  },
  wrap(async ({ film, name, slug, fps, width, height, durationInFrames }) => {
    await requirePrereqs();
    const scene = await store.createScene(qualifyFilm(film), { name, slug, fps, width, height, durationInFrames });
    // Global encode defaults seed the scaffolded output config, same as the Studio.
    const settings = await readSettings(store.dataDir).catch(() => null);
    const seed = settings && outputSeedFromSettings(settings, scene.config.output);
    if (seed) scene.config = await store.updateConfig(scene.id, { output: seed });
    const files = await store.listFiles(scene.id);
    return ok({
      scene: localId(scene.id), name: scene.name, path: scene.path, config: scene.config, files,
      ...structureAdvisory(scene.config),
    });
  }),
);

server.registerTool(
  'clone_scene',
  {
    title: 'Clone a scene into a film',
    description:
      'Copy an existing scene — composition files, assets, vendored 3D library builds AND its settings — into ' +
      'another film in this workspace, or into the same film again (new in v0.27). This is the one operation ' +
      'that can move BINARY assets between scenes: nothing else in this tool surface returns asset bytes, so a ' +
      'hand-built copy (create_scene → update_scene_config → sync_shared_files) arrives with dead references and ' +
      'the wrong duration. Reach for it whenever a new scene should start from one that already works — a title ' +
      'card restyled, a second take of a shot, a proven layout reused in another film — instead of re-authoring ' +
      'it from the template. The copy is verbatim and then DIVERGES BY DESIGN: editing the clone never touches ' +
      'the source, and its assets are real copies, not links. `name` defaults to the source name + " (copy)" and ' +
      'the slug is derived from it, auto-deduped ("-2", "-3", …); an explicit `slug` that is already taken is an ' +
      'error rather than a surprise. The clone lands at the end of the destination film\'s play order and records ' +
      'where it came from (config.clonedFrom, pinned to the source\'s current revision when it has one). Check ' +
      '`warnings`: a signature mismatch means the clone\'s fps/dimensions differ from the destination film\'s ' +
      'sceneDefaults and it will not concat losslessly — fix it with update_scene_config, or keep it if you are ' +
      'deliberately reframing. Rendered output is NOT copied; render the clone before building the film.',
    inputSchema: {
      from: z.string().describe('Source scene id "<film>/<scene>" — any film in this workspace'),
      toFilm: z.string().describe('Destination film slug; may be the source\'s own film'),
      name: z.string().min(1).optional().describe('Clone\'s display name (default: the source name + " (copy)")'),
      slug: z.string().optional().describe('Explicit scene slug; errors if taken. Omit to derive + auto-dedupe.'),
    },
  },
  wrap(async ({ from, toFilm, name, slug }) => {
    const res = await store.cloneScene(qualifyScene(from), qualifyFilm(toFilm), { name, slug });
    return ok({
      scene: localId(res.id),
      name: res.name,
      path: res.path,
      config: res.config,
      copied: res.copied,
      warnings: res.warnings,
    });
  }),
);

server.registerTool(
  'get_scene',
  {
    title: 'Get scene details',
    description: 'Return a scene\'s validated config plus its composition file listing.',
    inputSchema: { scene: z.string().describe('Scene id "<film>/<scene>" from create_scene/get_film') },
  },
  wrap(async ({ scene }) => {
    const s = await store.getScene(qualifyScene(scene));
    const config = await store.readConfig(s.id);
    const files = await store.listFiles(s.id);
    return ok({ scene: localId(s.id), name: config.name, path: s.path, config, files });
  }),
);

server.registerTool(
  'remove_scene',
  {
    title: 'Remove a scene',
    description:
      'Remove a scene from its film\'s play order. deleteFiles=true also deletes the scene folder (composition, ' +
      'assets, rendered output) — irreversible, confirm with the user first. Without it the folder stays on disk ' +
      'and lists as `unlisted`, so nothing silently disappears.',
    inputSchema: {
      scene: z.string(),
      deleteFiles: z.boolean().default(false),
    },
  },
  wrap(async ({ scene, deleteFiles }) => {
    const res = await store.removeScene(qualifyScene(scene), { deleteFiles });
    return ok({ ...res, id: localId(res.id) });
  }),
);

server.registerTool(
  'update_scene_config',
  {
    title: 'Update scene config',
    description:
      'Patch scene settings (fps, width, height, durationInFrames, audio tracks, output settings). ' +
      'output.format selects the deliverable: mp4 (default), webm, gif, prores (.mov), or png-sequence ' +
      '(a folder of frames). output.transparent=true keeps the alpha channel (webm/prores/png-sequence only; ' +
      'give the composition a transparent background). The output filename extension follows the format automatically. ' +
      'output.audioLimiter (default true) brick-walls the mixed audio at -1 dBFS; set false only if you want the ' +
      'summed mix passed through untouched, and remember track gains sum directly (amix runs with normalize=0). ' +
      'Audio tracks take clip-relative trim/fades (v0.19): trimEndInFrames keeps only the clip\'s first N frames; ' +
      'fadeInFrames fades up from the clip start; fadeOutFrames fades to silence ending at trimEndInFrames if set, ' +
      'else at the composition end — so a music bed longer than the video resolves instead of hard-cutting. ' +
      'duck:true on a track auto-ducks it under the mix of all non-ducked tracks (sidechain compression — the bed ' +
      'dips while narration speaks and recovers in the gaps; engages only when ducked and non-ducked tracks both exist). ' +
      'scene.json cannot be written via write_composition_file; use this tool so config invariants are validated. ' +
      'NOTE: diverging fps/width/height from the film\'s other scenes breaks the lossless concat — get_film\'s plan ' +
      'reports the mismatch.',
    inputSchema: {
      scene: z.string(),
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
                src: z.string().describe('Scene-relative audio path, e.g. assets/music.mp3'),
                startInFrames: z.number().int().min(0).optional(),
                gainDb: z.number().optional(),
                trimEndInFrames: z.number().int().min(1).optional()
                  .describe('Keep only the clip\'s first N frames (clip-relative)'),
                fadeInFrames: z.number().int().min(0).optional()
                  .describe('Fade up from silence over the clip\'s first N frames'),
                fadeOutFrames: z.number().int().min(0).optional()
                  .describe('Fade to silence over the last N frames before trimEndInFrames (or the composition end)'),
                duck: z.boolean().optional()
                  .describe('Auto-duck: compress this track under the mix of all non-ducked tracks (music bed under narration)'),
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
  wrap(async ({ scene, patch }) => {
    const id = qualifyScene(scene);
    const cur = await store.readConfig(id);
    if (patch.output) patch.output = { ...cur.output, ...patch.output };
    const config = await store.updateConfig(id, patch);
    // Only nag when this call is what made it long — resizing audio on an
    // already-long scene shouldn't repeat the advisory every time.
    return ok({ config, ...(patch.durationInFrames ? structureAdvisory(config) : {}) });
  }),
);

/**
 * Long-composition advisory (v0.22). A single composition manages every
 * scene's visibility in one DOM — the structure where scene-bleed bugs live —
 * and one broken frame forces re-rendering the whole thing. The engine can't
 * know the agent's intent, so this is advisory: returned once, at the moment
 * the duration is set, which is when restructuring is still free.
 */
function structureAdvisory(config) {
  const seconds = config.durationInFrames / config.fps;
  if (seconds <= 90) return {};
  return {
    structureWarnings: [
      `This composition is ${Math.round(seconds)}s long (${config.durationInFrames} frames). Motion Studio's ` +
        'intended shape for long videos is one scene per shot/beat, stitched losslessly with build_film — a single ' +
        'multi-minute composition must keep every scene hidden-by-default and switch visibility per frame in one ' +
        'DOM, which is exactly where scene-bleed bugs come from, and any fix re-renders the entire length. ' +
        'Split into scenes unless there is a strong reason not to (see the skill\'s "Long-form: multi-scene films").',
    ],
  };
}

server.registerTool(
  'read_composition_file',
  {
    title: 'Read a composition file',
    description: 'Read a source file from inside the scene folder (scene-relative path).',
    inputSchema: { scene: z.string(), path: z.string().describe('Scene-relative, e.g. composition.js') },
  },
  wrap(async ({ scene, path: relPath }) => {
    const content = await store.readFile(qualifyScene(scene), relPath);
    return ok({ path: relPath, content });
  }),
);

server.registerTool(
  'write_composition_file',
  {
    title: 'Write a composition file',
    description:
      'Create/overwrite a composition source file (HTML/CSS/JS) inside the scene folder. ' +
      'Paths are sandboxed to the scene (no absolute paths, no ".."). ' +
      '.js files are syntax-checked before writing and fail fast with the parse error. ' +
      'Author against the frame API (resource motion-studio://reference/frame-api): no wall-clock time, ' +
      'register via MotionStudio.registerComposition(fn). ' +
      'JS/CSS is also scanned for frame-driven contract violations (Date.now, setInterval, Math.random, ' +
      'requestAnimationFrame, THREE.Clock, real-time CSS transitions, and classList.add/remove — persistent DOM ' +
      'state that breaks frame purity: hide containers by DEFAULT in CSS and have each Sequence only turn ' +
      'its own content on). Literal Sequence(start, duration) calls are additionally checked against the scene ' +
      'duration: gaps and uncovered tails come back as "sequence-gap" warnings, and a function calling ctx.save() ' +
      'more often than ctx.restore() as "canvas-save-restore" (the leaked transform/clip moves or hides everything ' +
      'drawn later in the frame). All of it arrives as a "warnings" ' +
      'array on success — the file IS written; fix each one unless you are certain it is deliberate.',
    inputSchema: {
      scene: z.string(),
      path: z.string().describe('Scene-relative path, e.g. composition.js'),
      content: z.string(),
    },
  },
  wrap(async ({ scene, path: relPath, content }) => {
    const res = await store.writeFile(qualifyScene(scene), relPath, content);
    return ok({ written: res });
  }),
);

server.registerTool(
  'sync_shared_files',
  {
    title: 'Copy shared source files to many scenes',
    description:
      'Copy one or more source files from a source scene into many target scenes, overwriting them (new in v0.11). ' +
      'This is the maintenance half of the recommended film pattern (docs/film-setup.md): every scene ships the ' +
      'SAME composition.js and differs only in a small scene.js. Each scene owns its own copy, so without this a ' +
      'one-line fix to the shared engine means re-writing it once per scene. Files are syntax-checked and lint-scanned ' +
      'per target exactly as write_composition_file does, and every source file is read before anything is written, so a ' +
      'bad path fails before it half-updates the film. Does NOT touch scene.js unless you list it, and never scene.json. ' +
      'After syncing, re-render the affected scenes — already-rendered output is not invalidated automatically.',
    inputSchema: {
      sourceScene: z.string().describe('Scene holding the canonical copies'),
      targetScenes: z.array(z.string()).min(1).describe('Scenes to overwrite; the source is skipped if listed'),
      files: z.array(z.string()).min(1).describe('Scene-relative paths, e.g. ["composition.js", "styles.css"]'),
    },
  },
  wrap(async ({ sourceScene, targetScenes, files }) => {
    const res = await store.syncSharedFiles({
      sourceSceneId: qualifyScene(sourceScene),
      targetSceneIds: targetScenes.map(qualifyScene),
      files,
    });
    return ok({
      sourceScene: localId(res.sourceSceneId),
      files: res.files,
      scenesUpdated: res.scenesUpdated,
      results: res.results.map((r) => ({ scene: localId(r.sceneId), written: r.written })),
    });
  }),
);

server.registerTool(
  'write_composition_bundle',
  {
    title: 'Write the same composition files to many scenes',
    description:
      'Batch authoring (v0.26, TE P0-5): write the SAME set of files to many scenes in one call — the ' +
      'film pattern\'s "every scene ships the same composition.js" without one call per scene. The bundle is ' +
      'validated ONCE (a .js/.json parse error fails the whole call before anything is written anywhere); ' +
      'each target is then written independently, so one missing scene reports an error row while the rest ' +
      'succeed — a failed target never makes the operation look successful, and a successful one is never ' +
      'blocked by a neighbour. Per-target lint warnings arrive exactly as write_composition_file reports ' +
      'them. Returns per-file content hashes plus per-scene results and aggregate counts. Differs from ' +
      'sync_shared_files in taking content directly instead of copying from a source scene. After writing, ' +
      're-render the affected scenes.',
    inputSchema: {
      targets: z.array(z.string()).min(1).max(100).describe('Scene ids "<film>/<scene>" to write into'),
      files: z.record(z.string()).describe('Map of scene-relative path → file content, e.g. {"composition.js": "..."}'),
      detail: z.enum(['summary', 'full']).optional()
        .describe('summary (default): counts + per-scene status and warnings. full: adds per-file byte sizes per scene.'),
    },
  },
  wrap(async ({ targets, files, detail = 'summary' }) => {
    const entries = Object.entries(files);
    if (!entries.length) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'files must contain at least one path → content entry');
    }
    // Validate the bundle once — the same content cannot be a syntax error
    // for one scene and fine for another (TE plan: "Validate the bundle once").
    const fileHashes = {};
    for (const [relPath, content] of entries) {
      const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
      if (ext === '.js' || ext === '.mjs') checkJsSyntax(content, relPath);
      if (ext === '.json') {
        try { JSON.parse(content); }
        catch (e) { throw new EngineError(ErrorCodes.SYNTAX_ERROR, `JSON parse error in ${relPath}: ${e.message}`, { path: relPath }); }
      }
      fileHashes[relPath] = createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
    const results = [];
    for (const target of targets) {
      try {
        const written = [];
        for (const [relPath, content] of entries) {
          const res = await store.writeFile(qualifyScene(target), relPath, content);
          written.push({ path: res.path, ...(detail === 'full' ? { bytes: res.bytes } : {}), ...(res.warnings ? { warnings: res.warnings } : {}) });
        }
        results.push({ scene: target, written });
      } catch (e) {
        results.push({ scene: target, error: { code: e.code ?? 'error', message: e.message } });
      }
    }
    economy.addBatch('bundleTargets', targets.length); // per-scene write_composition_file calls replaced
    return ok({
      files: fileHashes,
      counts: {
        targets: targets.length,
        written: results.filter((r) => !r.error).length,
        errors: results.filter((r) => r.error).length,
      },
      results,
    });
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
    inputSchema: { scene: z.string(), frame: z.number().int().min(0) },
  },
  wrap(async ({ scene, frame }) => {
    await requirePrereqs();
    const s = await store.getScene(qualifyScene(scene));
    const config = await store.readConfig(s.id);
    const png = await captureSingleFrame({
      scenePath: s.path, config, frame,
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
      scene: z.string(),
      frames: z.array(z.number().int().min(0)).optional().describe('Explicit frame numbers, in the order you want them back'),
      count: z.number().int().min(2).max(MAX_PREVIEW_FRAMES).optional().describe('Evenly-spaced frames across the composition (default 5 when `frames` is omitted)'),
    },
  },
  wrap(async ({ scene, frames, count }) => {
    await requirePrereqs();
    const s = await store.getScene(qualifyScene(scene));
    const config = await store.readConfig(s.id);
    const list = frames?.length
      ? frames
      : preflightFrameList(0, config.durationInFrames - 1, count ?? 5);
    const shots = await captureFrames({
      scenePath: s.path, config, frames: list,
      ...(injectedBrowserFactory ? { browserFactory: injectedBrowserFactory } : {}),
    });
    return {
      content: [
        ...shots.map((sh) => ({ type: 'image', data: sh.png.toString('base64'), mimeType: 'image/png' })),
        {
          type: 'text',
          text: JSON.stringify({
            frames: shots.map((sh) => sh.frame),
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
  'inspect_render',
  {
    title: 'Return frames from the encoded deliverable',
    description:
      'Extract downscaled PNG frames from a scene render or built film in out/ — unlike capture_preview_frames, ' +
      'these images include the file that ffmpeg actually wrote: concat seams, burned captions, overlays and muxed ' +
      'picture. For a film, around="cuts" samples before/at/after known scene or footage boundaries across the ' +
      'timeline; around="holds" samples block midpoints. Pass frames for a follow-up. Maximum 24 images.',
    inputSchema: {
      target: z.string().describe('Film id "<film>" or scene id "<film>/<scene>"'),
      path: z.string().optional().describe('Optional target-relative media path. It must begin with "out/" or "assets/" (for example, "out/output.mp4"); bare filenames are rejected. Defaults to the target\'s canonical output'),
      frames: z.array(z.number().int().min(0)).min(1).max(MAX_RENDER_INSPECTION_FRAMES).optional(),
      count: z.number().int().min(1).max(MAX_RENDER_INSPECTION_FRAMES).optional()
        .describe('Uniform samples when frames/around are omitted (default 5)'),
      around: z.enum(['cuts', 'holds']).optional()
        .describe('Film-aware samples: cuts = before/at/after each boundary; holds = midpoint of each block'),
      maxWidth: z.number().int().min(160).max(1920).default(960).describe('Maximum returned PNG width'),
    },
  },
  wrap(async ({ target, path: relPath, frames, count, around, maxWidth }) => {
    await requirePrereqs();
    if (frames?.length && (count !== undefined || around !== undefined)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'inspect_render takes frames, count, or around — not a combination');
    }
    const located = await locateRenderedMedia(target, relPath);
    const { t } = located;
    const layout = renderReviewLayout(t);
    const totalFrames = t.durationInFrames;
    const mode = around ?? (t.kind === 'film' ? 'cuts' : 'uniform');
    const list = reviewFrameList({
      totalFrames, sceneLayout: layout, frames, count: count ?? 5, around: mode,
      maxFrames: frames ? undefined : MAX_RENDER_INSPECTION_FRAMES,
    });
    const ffmpegPath = await ffmpegPathOnly();
    const shots = await Promise.all(list.map(async (frame) => ({
      frame,
      png: await extractRenderedFrame({ filePath: located.abs, frame, fps: t.fps, maxWidth, ffmpegPath }),
    })));
    return {
      content: [
        ...shots.map((shot) => ({ type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' })),
        {
          type: 'text',
          text: JSON.stringify({
            target: localId(t.id), path: located.path, fps: t.fps,
            frames: shots.map((shot) => {
              const context = layout.find((entry) => shot.frame >= (entry.filmOffset ?? 0)
                && shot.frame < (entry.filmOffset ?? 0) + (entry.durationInFrames ?? 0));
              return { frame: shot.frame, ...(context ? { context } : {}) };
            }),
            note: 'Images are in the same order as frames.',
          }, null, 2),
        },
      ],
    };
  }),
);

server.registerTool(
  'measure_render',
  {
    title: 'Measure the encoded picture for static, black, and suspect cuts',
    description:
      'Read a rendered scene or built film end-to-end at low resolution and report per-second motion, static/black ' +
      'runs, solid frames and known-cut checks. This is a report, not a quality verdict: title cards and fades can ' +
      'be intentional. Long files run as a task job and return their detailed report through wait_for_render.',
    inputSchema: {
      target: z.string().describe('Film id "<film>" or scene id "<film>/<scene>"'),
      path: z.string().optional().describe('Optional target-relative media path. It must begin with "out/" or "assets/" (for example, "out/output.mp4"); bare filenames are rejected. Defaults to the target\'s canonical output'),
      waitMs: z.number().int().min(0).max(50_000).default(45_000)
        .describe('Block up to this long; a longer inspection returns a jobId to poll with wait_for_render'),
    },
  },
  wrap(async ({ target, path: relPath, waitMs }) => {
    await requirePrereqs();
    const located = await locateRenderedMedia(target, relPath);
    const { t } = located;
    const layout = renderReviewLayout(t);
    const ffmpegPath = await ffmpegPathOnly();
    const submitted = jobs.startTask({
      kind: 'render-review',
      targetId: t.id,
      run: async ({ onPhase, signal, onChildPid }) => {
        onPhase('measuring-picture');
        return measureRenderedPicture({
          filePath: located.abs, fps: t.fps, totalFrames: t.durationInFrames,
          sceneLayout: layout, ffmpegPath, signal, onSpawn: onChildPid,
        });
      },
    });
    const waited = await jobs.waitFor([submitted.jobId], { timeoutMs: waitMs, pollMs: 200 });
    const status = waited.jobs[0];
    if (status.state === 'error') {
      throw new EngineError(status.error?.code ?? ErrorCodes.FFMPEG_FAILED,
        status.error?.message ?? 'render measurement failed', status.error?.detail);
    }
    if (status.state !== 'done') {
      return ok({
        jobId: submitted.jobId, state: status.state, phase: status.phase,
        target: localId(t.id), path: located.path, stillRunning: true,
        hint: `Still measuring the picture (${status.phase}). Poll with wait_for_render { jobIds: ["${submitted.jobId}"] } — the report arrives as the job result.`,
      });
    }
    return ok({ jobId: submitted.jobId, target: localId(t.id), path: located.path, ...status.result });
  }),
);

/* ------------------------------------------------------------------ */
/* Review grids (v0.26, TE P1-2): N frames from N scenes as ONE image. */
/* ------------------------------------------------------------------ */

// A grid is a FILE (sheet + its metadata) under <film>/review-grids/, not a
// buffer in memory: the image can then be collected after a timeout, after a
// restart, or by the human's Studio — and the async job's result stays
// compact (a path and counts, never base64, which get_render_status would
// otherwise repeat back through every status poll).
const gridsDirFor = (filmPath) => path.join(filmPath, 'review-grids');
const MAX_KEPT_REVIEW_GRIDS = 20;

/** m:ss.mmm on the film timeline — the position a producer reads back. */
function timecode(frames, fps) {
  const ms = Math.round((Math.max(0, frames) / (fps || 30)) * 1000);
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

/** Review sheets are cheap to rebuild; keep the newest few, drop the rest. */
async function pruneReviewGrids(dir) {
  const ids = (await fsp.readdir(dir).catch(() => []))
    .filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  if (ids.length <= MAX_KEPT_REVIEW_GRIDS) return;
  const dated = await Promise.all(ids.map(async (id) => ({
    id, mtimeMs: (await fsp.stat(path.join(dir, `${id}.json`)).catch(() => null))?.mtimeMs ?? 0,
  })));
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { id } of dated.slice(MAX_KEPT_REVIEW_GRIDS)) {
    await fsp.rm(path.join(dir, `${id}.json`), { force: true }).catch(() => {});
    await fsp.rm(path.join(dir, `${id}.png`), { force: true }).catch(() => {});
  }
}

/** Serve a built sheet: one image block plus its (optionally full) metadata. */
async function collectReviewGrid({ doc, gridId, includeMetadata }) {
  const dir = gridsDirFor(doc.path);
  const meta = await fsp.readFile(path.join(dir, `${gridId}.json`), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const png = meta && await fsp.readFile(path.join(dir, `${gridId}.png`)).catch(() => null);
  if (!meta || !png) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `No review grid "${gridId}" for film "${doc.slug}". Sheets live under review-grids/ and only the newest ` +
      `${MAX_KEPT_REVIEW_GRIDS} are kept — call review_render_grid without gridId to build a fresh one.`,
      { film: doc.slug, gridId });
  }
  const { cells, ...rest } = meta;
  return {
    content: [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      {
        type: 'text',
        text: JSON.stringify(includeMetadata
          ? meta
          : { ...rest, cellCount: cells.length, note: `${rest.note} Call again with includeMetadata (default) for the per-cell rows.` },
        null, 2),
      },
    ],
  };
}

server.registerTool(
  'review_render_grid',
  {
    title: 'One contact sheet for a whole film\'s encoded output',
    description:
      'Visual review of MANY scenes as ONE image (v0.26, TE P1-2): representative frames are extracted from the ' +
      'ENCODED outputs — the built film when it exists, otherwise each scene\'s own rendered file — tiled into a ' +
      'single contact sheet, and returned as one image block plus a compact row per cell (scene, frame, film ' +
      'offset, timestamp). scope "cuts-and-holds" (default) takes two cells per segment: the first frame (does the ' +
      'cut land) and the midpoint (does the shot hold); "scenes" takes the midpoint only. This is a TRANSPORT ' +
      'reduction, not a replacement for inspection: cells are downscaled and the labels live in the metadata, not ' +
      'burned into the picture, so read the sheet to decide WHERE to look, then use inspect_render for exact ' +
      'full-width frames and measure_render for the motion/black/cut measurements. Nothing is hidden: scenes with ' +
      'no encoded output are listed in `unavailable`, and a film with more segments than fit is sampled evenly ' +
      `with truncated: true naming the omitted ones (max ${MAX_REVIEW_GRID_CELLS} cells). The sheet is a file ` +
      'under the film\'s review-grids/, so a long extraction returns a jobId and the image is collected later ' +
      'with { film, gridId }.',
    inputSchema: {
      film: z.string().describe('Film id "<film>" — the grid always spans a film, never a single scene'),
      scope: z.enum(['cuts-and-holds', 'scenes']).optional()
        .describe('cuts-and-holds (default): first frame + midpoint of every segment. scenes: one midpoint per segment.'),
      scenes: z.array(z.string()).max(64).optional()
        .describe('Restrict to these scene slugs (or footage names); an unknown name is rejected, never ignored'),
      source: z.enum(['auto', 'film', 'scenes']).optional()
        .describe('auto (default): the built film if it exists, else the per-scene renders. film: require the built film (concat seams, overlays, burned captions). scenes: always the individual scene renders — how you review before a build.'),
      maxWidth: z.number().int().min(320).max(1920).default(960)
        .describe('Maximum width of the WHOLE sheet (not of one cell); the per-cell size follows from the packing'),
      includeMetadata: z.boolean().optional().describe('Return the per-cell rows (default true); false keeps only the image and the aggregate facts'),
      gridId: z.string().optional().describe('Collect an already-built sheet instead of extracting again (the id a timed-out call returned)'),
      waitMs: z.number().int().min(0).max(50_000).default(45_000)
        .describe('Block up to this long; a longer extraction returns a jobId plus its gridId to collect afterwards'),
    },
  },
  wrap(async ({ film, scope = 'cuts-and-holds', scenes, source = 'auto', maxWidth, includeMetadata = true, gridId, waitMs }) => {
    await requirePrereqs();
    const doc = await store.getFilm(qualifyFilm(film));
    if (gridId) return collectReviewGrid({ doc, gridId, includeMetadata });

    // Encoded-file truth, addressed exactly as inspect_render addresses it.
    let located = null;
    try {
      located = await locateRenderedMedia(film, undefined);
    } catch (error) {
      if (error?.code !== ErrorCodes.FILE_NOT_FOUND) throw error;
      if (source === 'film') {
        throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
          `Film "${doc.slug}" has no built output to grid. Build it with build_film (or finish_film), or pass ` +
          'source: "scenes" to review the individual scene renders.', { film: doc.slug });
      }
    }
    const useFilm = source === 'film' || (source === 'auto' && !!located);
    const plan = located ? located.t.plan : await planFilm({ film: doc, store });
    const filmFps = located ? located.t.fps : (plan.fps ?? doc.sceneDefaults?.fps ?? 30);
    const rows = segmentRows(plan, localId);
    const nameOf = (row) => row.slug ?? row.footage;

    if (scenes?.length) {
      const known = new Set(rows.map(nameOf));
      const unknown = scenes.filter((name) => !known.has(name));
      if (unknown.length) {
        throw new EngineError(ErrorCodes.INVALID_CONFIG,
          `No such scene(s) in film "${doc.slug}": ${unknown.join(', ')}.`,
          { unknown, known: [...known] });
      }
    }
    const wanted = scenes?.length ? rows.filter((row) => scenes.includes(nameOf(row))) : rows;

    const segments = [];
    const unavailable = [];
    const stale = [];
    for (const row of wanted) {
      const base = { key: nameOf(row), row, filmOffset: row.filmOffset, durationInFrames: row.frames };
      if (useFilm) {
        segments.push({ ...base, filePath: located.abs, fps: filmFps });
        continue;
      }
      if (row.kind !== 'scene') {
        unavailable.push({ segment: base.key, reason: 'supplied footage has no scene render — build the film to see it in a grid' });
        continue;
      }
      const scene = await store.getScene(qualifyScene(`${doc.slug}/${row.slug}`));
      const config = await store.readConfig(scene.id);
      const relative = `${config.output.dir}/${config.output.filename}`;
      const abs = path.join(scene.path, config.output.dir, config.output.filename);
      if (!(await fsp.stat(abs).catch(() => null))?.isFile()) {
        unavailable.push({ segment: base.key, reason: `scene is ${row.state} — no encoded output to sample` });
        continue;
      }
      if (row.state === 'stale') stale.push(row.slug);
      segments.push({ ...base, filePath: abs, fps: config.fps ?? filmFps, path: relative });
    }

    // A built film shows the LAST build. If scene work moved on since, the
    // sheet is still real evidence — of the wrong cut, unless it is said.
    const behind = useFilm
      ? rows.filter((row) => row.kind === 'scene' && row.state !== 'rendered').map((row) => row.slug)
      : [];

    const planned = reviewGridCells({ segments, scope, maxCells: MAX_REVIEW_GRID_CELLS });
    if (!planned.cells.length) {
      throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
        `Nothing to review in film "${doc.slug}": no encoded output was found for the requested segments. ` +
        'Render the scenes (render_group) or build the film (build_film) first.',
        { film: doc.slug, source: useFilm ? 'film' : 'scenes', unavailable });
    }

    const newGridId = `grid-${randomUUID().slice(0, 12)}`;
    const dir = gridsDirFor(doc.path);
    const contactPath = path.join(dir, `${newGridId}.png`);
    const ffmpegPath = await ffmpegPathOnly();
    const extraction = planned.cells.map((cell) => ({
      filePath: cell.segment.filePath,
      fps: cell.segment.fps,
      // A film file is addressed on the film timeline; a scene file is
      // addressed from its own frame 0.
      frame: useFilm ? cell.filmFrame : cell.localFrame,
    }));

    const submitted = jobs.startTask({
      kind: 'review-grid',
      targetId: doc.id,
      run: async ({ onPhase, signal, onChildPid }) => {
        onPhase('extracting-frames');
        const sheet = await buildReviewGrid({
          cells: extraction, outputPath: contactPath, maxWidth, ffmpegPath, signal, onSpawn: onChildPid,
        });
        const meta = {
          film: doc.slug,
          gridId: newGridId,
          source: useFilm ? 'film' : 'scenes',
          scope,
          fps: filmFps,
          ...(useFilm ? { path: located.path } : {}),
          contactPath,
          grid: {
            columns: sheet.columns, rows: sheet.rows, cells: extraction.length,
            thumbnailWidth: sheet.thumbnailWidth, maxWidth, bytes: sheet.bytes,
          },
          truncated: planned.truncated,
          requestedCells: planned.requestedCells,
          ...(planned.truncated ? { omitted: planned.omitted } : {}),
          ...(unavailable.length ? { unavailable } : {}),
          ...(stale.length ? { staleScenes: stale } : {}),
          ...(behind.length ? {
            warnings: [`This sheet is the BUILT film; ${behind.join(', ')} ${behind.length === 1 ? 'is' : 'are'} ` +
              'not currently rendered/current, so the build predates that work. Rebuild, or pass source: "scenes".'],
          } : {}),
          cells: planned.cells.map((cell, index) => ({
            index,
            row: Math.floor(index / sheet.columns),
            column: index % sheet.columns,
            kind: cell.kind,
            ...(cell.segment.row.kind === 'scene'
              ? { scene: cell.segment.row.scene, slug: cell.segment.row.slug }
              : { footage: cell.segment.key }),
            frame: useFilm ? cell.filmFrame : cell.localFrame,
            filmOffset: cell.segment.filmOffset,
            filmFrame: cell.filmFrame,
            timestamp: timecode(cell.filmFrame, filmFps),
            ...(useFilm ? {} : { path: cell.segment.path }),
          })),
          note: 'Cells run left-to-right, top-to-bottom in `cells` order; `frame` is the frame inside the file ' +
            'that was read and `filmFrame` its position on the film timeline. Labels are metadata, not burned ' +
            'into the picture. inspect_render returns exact full-width frames for anything this sheet flags.',
        };
        await fsp.writeFile(path.join(dir, `${newGridId}.json`), JSON.stringify(meta, null, 2) + '\n', 'utf8');
        await pruneReviewGrids(dir);
        // The job result stays compact on purpose: the image is a file, and
        // every get_render_status poll would otherwise repeat it.
        return {
          gridId: newGridId, film: doc.slug, contactPath,
          columns: sheet.columns, rows: sheet.rows, cells: extraction.length,
          truncated: planned.truncated,
          hint: `Collect the image with review_render_grid { film: "${doc.slug}", gridId: "${newGridId}" }.`,
        };
      },
    });

    const status = (await jobs.waitFor([submitted.jobId], { timeoutMs: waitMs, pollMs: 200 })).jobs[0];
    if (status.state === 'error') {
      throw new EngineError(status.error?.code ?? ErrorCodes.FFMPEG_FAILED,
        status.error?.message ?? 'review grid failed', status.error?.detail);
    }
    if (status.state !== 'done') {
      return ok({
        jobId: submitted.jobId, gridId: newGridId, state: status.state, phase: status.phase,
        film: doc.slug, cells: extraction.length, stillRunning: true,
        hint: `Still extracting (${status.phase}). Wait with wait_for_render { jobIds: ["${submitted.jobId}"] }, ` +
          `then collect the sheet with review_render_grid { film: "${doc.slug}", gridId: "${newGridId}" } — it is a ` +
          'file, so the image is never lost to a timeout.',
      });
    }
    return collectReviewGrid({ doc, gridId: newGridId, includeMetadata });
  }),
);

/**
 * Proxy metadata per jobId, so get_render_status can tell a proxy draft from
 * a deliverable render. It lives BESIDE the JobManager rather than inside it:
 * the job manager schedules renders and does not know what a proxy is, and
 * teaching it would put MCP-surface concerns in core. Pruned against the
 * manager's own job map on insert, so it tracks the manager's retention
 * instead of growing for the session's lifetime.
 */
const proxyByJob = new Map();

server.registerTool(
  'render',
  {
    title: 'Start a render job',
    description:
      'Start rendering a scene to its configured output format (mp4/webm/gif/prores/png-sequence — ' +
      'set via update_scene_config). Returns a jobId immediately; block on it with wait_for_render (or poll ' +
      'get_render_status) until state is done/error/cancelled. Optional frameRange renders a cheap partial ' +
      'segment first. Pass `proxy` for a proxy/motion preview — a low-res, frame-skipping draft that checks ' +
      'motion in roughly 1/8 the time before committing to a full render. Proxy renders are serial (workers is ' +
      'ignored), skip pre-flight and the audio mux, keep wall-clock duration (encoded at fps/frameStep), and ' +
      'write to <name>.proxy.<ext> so they never overwrite the deliverable. If another job is ' +
      'running, the new job is QUEUED (FIFO, one render at a time) and starts automatically — the response ' +
      'then has state "queued" and a queuePosition. A full queue fails with queue_full. Do NOT set mp4 crf to 0 ' +
      'for "maximum quality": CRF 0 is lossless H.264 (Hi444PP profile), which most players show as BLACK video ' +
      'with working audio — crf 18 is the visually-lossless choice that plays everywhere. Such a render still ' +
      'succeeds but carries encodingWarnings in the job status; relay them to the user.',
    inputSchema: {
      scene: z.string(),
      frameRange: z
        // Keep this a homogeneous, fixed-length array rather than a Zod tuple.
        // Zod emits tuples as draft-07 `items: [...]`; strict MCP importers that
        // accept only a schema object in `items` reject the whole render tool.
        .array(z.number().int().min(0))
        .length(2)
        .optional()
        .describe('[startFrame, endFrame] inclusive; omit for the full composition'),
      workers: z.number().int().min(1).max(16).optional()
        .describe("Parallel capture processes (default: the user's global render setting, factory default 1; ignored for proxy renders)"),
      outputFilename: z.string().optional().describe('Filename inside the scene "out" dir (default from config)'),
      preflight: z
        .boolean()
        .optional()
        .describe('Probe a few evenly-spaced frames before committing to the render (default true; skipped under 30 frames and for proxy renders)'),
      proxy: z
        .object({
          scale: z.number().optional()
            .describe('Capture scale, 0.1–1 (default 0.5); scaled dimensions are floored to even numbers for the encoders'),
          frameStep: z.number().optional()
            .describe('Capture every Nth frame (default 2); playback speed is preserved by encoding at fps/frameStep'),
        })
        .optional()
        .describe('Proxy/motion preview: cheap low-res + frame-skip draft. {} takes both defaults. No audio, no pre-flight, serial, output gets ".proxy" before the extension.'),
      note: z.string().max(200).optional()
        .describe('One-line summary of what this attempt changes ("slower title fade") — shown on the revision card in the human\'s history view'),
      adviceIds: z.array(z.string()).max(20).optional()
        .describe('Advice ids this render responds to; the archived revision links to them as evidence'),
    },
  },
  wrap(async ({ scene, frameRange, workers, outputFilename, preflight, proxy, note, adviceIds }) => {
    await requirePrereqs();
    // Validate the proxy request FIRST so bad values fail this call with
    // invalid_config and a named value, instead of surfacing later as a
    // failed job the caller has to go fish the error out of.
    const prx = proxy ? normalizeProxy(proxy) : null;
    const s = await store.getScene(qualifyScene(scene));
    const config = await store.readConfig(s.id);
    const name = outputFilename ?? config.output.filename;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, 'outputFilename must be a bare filename');
    }
    // The renderer inserts ".proxy" itself (its own overwrite guard); applying
    // the same idempotent rename here just makes the path in THIS response the
    // path the file really lands at.
    const outputPath0 = path.join(s.path, config.output.dir, name);
    const outputPath = prx ? proxyOutputPath(outputPath0) : outputPath0;
    const settings = await readSettings(store.dataDir).catch(() => null);
    const parentFilm = await store.getFilm(s.film);
    const reviewPolicy = resolveReviewPolicy({
      globalPolicy: settings?.render?.review,
      filmPolicy: parentFilm.review,
    });
    // Proxies are serial by design: already ~1/8 the work, so a Chromium
    // fan-out would cost more in launches than it saves in capture.
    const effectiveWorkers = prx ? 1 : (workers ?? settings?.render?.defaultWorkers ?? 1);
    const { jobId, state, queuePosition } = jobs.startRender({
      targetId: s.id, scenePath: s.path, config, outputPath, frameRange, preflight,
      workers: effectiveWorkers,
      ffmpegPath: await ffmpegPathOnly(),
      reviewPolicy,
      // Provenance for the archived revision (v0.23): who, why, and which
      // advice it answers. A completed full-scene render reports the archived
      // `revisionId` in its job status.
      revision: { agent: AGENT, ...(note ? { note } : {}), ...(adviceIds?.length ? { adviceIds } : {}) },
      // A proxy always goes straight to the serial renderer with the proxy
      // options attached; otherwise the injected-factory split is as before.
      ...(prx
        ? { renderFn: (o) => (injectedBrowserFactory ? renderCompositionInjected : renderComposition)({ ...o, proxy: prx }) }
        : injectedBrowserFactory
          ? { renderFn: (o) => (o.workers > 1 ? renderParallelInjected(o) : renderCompositionInjected(o)) }
          : {}),
    });
    const span = frameRange ? frameRange[1] - frameRange[0] + 1 : config.durationInFrames;
    // Captured frames under frameStep: 0, N, 2N, … within the span.
    const totalFrames = prx ? Math.floor((span - 1) / prx.frameStep) + 1 : span;
    if (prx) {
      // The JobManager sized job.totalFrames from the frame range; a stepped
      // proxy captures fewer, so fix the snapshot at submission — otherwise
      // percent tops out around 100/frameStep and a finished job reads
      // half-done. Reaching into the record here keeps the manager
      // proxy-agnostic (see proxyByJob above).
      jobs.jobs.get(jobId).totalFrames = totalFrames;
      for (const id of proxyByJob.keys()) if (!jobs.jobs.has(id)) proxyByJob.delete(id);
      proxyByJob.set(jobId, prx);
    }
    return ok({
      jobId, state, ...(queuePosition ? { queuePosition } : {}), outputPath,
      totalFrames,
      workers: effectiveWorkers,
      ...(prx ? { proxy: prx } : {}),
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
      'Proxy jobs carry `proxy: { scale, frameStep }` so a draft is never mistaken for the deliverable. ' +
      'Non-render jobs share this surface (v0.22): `kind` says which — "render" or e.g. "transcribe" — they have no ' +
      'frames (percent stays 0, watch `phase`), and a finished one carries its whole answer in `result`, which for ' +
      'transcribe_asset is the transcript. To wait for one or more jobs without a polling loop, use wait_for_render.',
    inputSchema: { jobId: z.string() },
  },
  wrap(async ({ jobId }) => {
    // proxy rides on the status rather than living in the JobManager — the
    // manager stays proxy-agnostic; see the map beside the render tool.
    const status = jobs.getStatus(jobId);
    const prx = proxyByJob.get(jobId);
    return ok(prx ? { ...status, proxy: prx } : status);
  }),
);

server.registerTool(
  'wait_for_render',
  {
    title: 'Wait for render job(s) to reach a terminal state',
    description:
      'Block until every listed job is done/error/cancelled, or until timeoutMs elapses — one call instead of a ' +
      'get_render_status polling loop (new in v0.14). Returns { timedOut, jobs } where each jobs[] entry has the ' +
      'same shape as get_render_status, including the structured error for failed jobs, the measured `audio` ' +
      'block for finished renders, and `result` for a finished non-render job (a transcribe_asset job\'s transcript ' +
      'arrives this way) — check states individually, since one failed scene does not stop the others. ' +
      'Waiting on queued jobs is fine; they complete in FIFO order. A timeout is NOT an error: the jobs keep ' +
      'running and you get the current snapshots with timedOut: true — CALL IT AGAIN to keep watching, which is the ' +
      'normal way to wait out a long render. The ceiling is deliberately below the typical 60s MCP client request ' +
      'timeout: waiting longer in one call returns a transport error instead of the snapshot, which tells you nothing ' +
      'about the jobs. Job ids live in server memory only — if the server restarts, wait_for_render returns each lost ' +
      'id as terminal state "not_found" while preserving the other snapshots. Verify finished work by its output file; ' +
      'get_render_status still reports job_not_found for its one unknown id.',
    inputSchema: {
      jobIds: z.array(z.string()).min(1).max(16).describe('Job ids from render or a task; expired ids return state "not_found"'),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(50_000)
        .default(30_000)
        .describe('Stop waiting after this long, then return snapshots with timedOut:true; the jobs are unaffected. ' +
          'Capped below the MCP client request timeout on purpose — call again to keep waiting'),
    },
  },
  wrap(async ({ jobIds, timeoutMs }) => ok(await jobs.waitFor(jobIds, { timeoutMs }))),
);

server.registerTool(
  'cancel_render',
  {
    title: 'Cancel a render job',
    description:
      'Abort a job in either lane. Running jobs have their whole process tree killed (Chromium workers + FFmpeg, ' +
      'or whisper-cli for a transcription); queued jobs are dequeued without ever starting. Idempotent.',
    inputSchema: { jobId: z.string() },
  },
  wrap(async ({ jobId }) => ok(jobs.cancel(jobId))),
);

/* ------------------------------------------------------------------ */
/* Render groups (v0.26, TE P0-6/P0-7): one operation instead of the   */
/* agent-side submit-and-poll loop over N scenes.                      */
/* ------------------------------------------------------------------ */

// Group records persist under <film>/render-groups/<groupId>.json so a
// restart can answer "what remains?" from files (job ids die with the
// process; scene truth is recomputed from the plan's output/sidecar state).
// The in-memory index is only a fast path — lookup falls back to scanning
// the workspace's films.
const groupIndex = new Map(); // groupId → { filmId, recordPath }
const groupsDirFor = (filmPath) => path.join(filmPath, 'render-groups');

async function findGroupRecord(groupId) {
  const hit = groupIndex.get(groupId);
  const read = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'));
  if (hit) {
    try { return { record: await read(hit.recordPath), recordPath: hit.recordPath }; } catch { /* fall through to scan */ }
  }
  for (const f of await store.listFilms(WORKSPACE)) {
    if (f.broken) continue;
    const p = path.join(groupsDirFor(store.filmPath(f.id)), `${groupId}.json`);
    try {
      const record = await read(p);
      groupIndex.set(groupId, { filmId: f.id, recordPath: p });
      return { record, recordPath: p };
    } catch { /* not this film */ }
  }
  throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
    `No render group "${groupId}" in this workspace. Groups persist per film under render-groups/; start one with render_group.`);
}

// A member ends here and nowhere else. `not_found` is deliberately absent: a
// job id that died with a previous process is lost memory, not an outcome, and
// stamping it as one would put a fiction in the run history (the scene's real
// truth is its output file, which is what `done` is computed from).
const TERMINAL_MEMBER_STATES = new Set(['done', 'error', 'cancelled', 'not-submitted']);

/**
 * Complete a persisted group record in place (TE P1-3). Best effort and
 * atomic-ish (temp file + rename, the store's idiom): a record that cannot be
 * updated is one stderr line, NEVER an error — the record informs, while
 * output files and sidecars decide what is done.
 *
 * `mutate` returns false when nothing changed, so a heartbeat wait does not
 * rewrite the file.
 */
async function updateGroupRecord(recordPath, mutate) {
  try {
    const record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
    if (!mutate(record)) return;
    // The store's temp+rename idiom, with a per-write suffix as well as the
    // pid: two waits on one group are a normal thing for an agent to do, and
    // they must not share a temp file.
    const tmp = `${recordPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2));
    await fsp.rename(tmp, recordPath); // atomic on same volume
  } catch (e) {
    process.stderr.write(`[motion-studio-mcp] group record not updated (${recordPath}): ${e.message}\n`);
  }
}

/**
 * Stamp each member that has reached a terminal job state, plus the group's
 * `completedAt` once every member has. The submission `state` is left alone —
 * it says what happened at submit time, and `terminalState` says how the
 * member ended. Already-stamped members are never restamped.
 *
 * @param {(member: object) => string|undefined} stateOf  observed job state
 * @returns {boolean} whether anything changed
 */
function stampGroupTerminals(record, stateOf) {
  const at = new Date().toISOString();
  let changed = false;
  for (const m of record.members ?? []) {
    if (m.terminalState) continue;
    const state = m.jobId ? stateOf(m) : 'not-submitted';
    if (!TERMINAL_MEMBER_STATES.has(state)) continue;
    m.terminalState = state;
    m.finishedAt = at;
    changed = true;
  }
  if (!record.completedAt && (record.members ?? []).every((m) => m.terminalState)) {
    record.completedAt = at;
    changed = true;
  }
  return changed;
}

server.registerTool(
  'render_group',
  {
    title: 'Render every missing/stale scene of a film as one group',
    description:
      'One idempotent operation instead of the per-scene submit loop (v0.26, TE P0-6): computes the film plan ' +
      'ONCE, refuses structurally broken films (missing scene folders/footage) before submitting anything, ' +
      'skips scenes that are already rendered and current, and submits only missing/stale scenes to the normal ' +
      'FIFO render queue (serial policy unchanged — this removes orchestration, not the queue). Returns a ' +
      'groupId plus per-scene job ids, skipped scenes, and counts. The group record persists with the film and ' +
      'is completed as members end and a delivery is built (TE P1-3), so ' +
      'a server restart recovers scene truth from output files — and re-running render_group after a partial ' +
      'submission (e.g. queue_full rows) is the designed resume: already-rendered scenes are skipped, the rest ' +
      'submit. Wait on it with wait_render_group; cancel with cancel_render_group.',
    inputSchema: {
      film: z.string(),
      scenePolicy: z.enum(['missing-or-stale', 'all']).optional()
        .describe('missing-or-stale (default): only scenes whose render is absent or stale. all: re-render every scene.'),
      sceneIds: z.array(z.string()).max(64).optional()
        .describe('Restrict to these scene slugs (still filtered by scenePolicy)'),
      workers: z.number().int().min(1).max(16).optional()
        .describe('Parallel capture processes per scene render (default: the global render setting)'),
      note: z.string().max(200).optional()
        .describe('One-line provenance note stamped on every revision this group produces'),
    },
  },
  wrap(async ({ film, scenePolicy = 'missing-or-stale', sceneIds, workers, note }) => {
    await requirePrereqs();
    return ok(await startRenderGroupOp({ film, scenePolicy, sceneIds, workers, note }));
  }),
);

/** The render_group core, shared with finish_film (TE P1-1). */
async function startRenderGroupOp({ film, scenePolicy = 'missing-or-stale', sceneIds, workers, note }) {
  {
    const doc = await store.getFilm(qualifyFilm(film));
    const plan = await planFilm({ film: doc, store });
    const rows = segmentRows(plan, localId);

    const missing = rows.filter((r) => r.state === 'missing');
    if (missing.length) {
      throw new EngineError(ErrorCodes.INVALID_FILM,
        `Cannot render a structurally broken film: ${missing.map((r) => r.slug ?? r.footage).join(', ')} missing. ` +
        'Fix the plan first (get_film names every problem).',
        { missing: missing.map((r) => r.slug ?? r.footage) });
    }

    const wanted = rows.filter((r) => r.kind === 'scene')
      .filter((r) => !sceneIds || sceneIds.includes(r.slug))
      .filter((r) => (scenePolicy === 'all' ? true : r.state !== 'rendered'));
    const skipped = rows.filter((r) => r.kind === 'scene' && !wanted.includes(r))
      .map((r) => ({ slug: r.slug, reason: sceneIds && !sceneIds.includes(r.slug) ? 'not-selected' : 'rendered' }));

    // Same submission facts as the single `render` tool (no proxy, no
    // frameRange — a group renders deliverables), read once for the group.
    const settings = await readSettings(store.dataDir).catch(() => null);
    const reviewPolicy = resolveReviewPolicy({ globalPolicy: settings?.render?.review, filmPolicy: doc.review });
    const effectiveWorkers = workers ?? settings?.render?.defaultWorkers ?? 1;

    const groupId = `rg-${randomUUID().slice(0, 12)}`;
    const members = [];
    for (const row of wanted) {
      try {
        const s = await store.getScene(qualifyScene(`${doc.slug}/${row.slug}`));
        const config = await store.readConfig(s.id);
        const outputPath = path.join(s.path, config.output.dir, config.output.filename);
        const { jobId, state, queuePosition } = jobs.startRender({
          targetId: s.id, scenePath: s.path, config, outputPath,
          workers: effectiveWorkers,
          ffmpegPath: await ffmpegPathOnly(),
          reviewPolicy,
          revision: { agent: AGENT, ...(note ? { note } : {}), group: groupId },
          ...(injectedBrowserFactory
            ? { renderFn: (o) => (o.workers > 1 ? renderParallelInjected(o) : renderCompositionInjected(o)) }
            : {}),
        });
        members.push({ slug: row.slug, jobId, state, ...(queuePosition ? { queuePosition } : {}) });
      } catch (e) {
        // queue_full (or a broken scene) is one honest row; re-running the
        // group after the queue drains submits exactly the remainder.
        members.push({ slug: row.slug, jobId: null, state: 'not-submitted', error: { code: e.code ?? 'error', message: e.message } });
      }
    }

    const record = {
      groupId, film: doc.slug, filmRevision: doc.revision, scenePolicy,
      ...(sceneIds ? { sceneIds } : {}), ...(note ? { note } : {}),
      engine: enginePkg.version, createdAt: new Date().toISOString(),
      members, skipped,
    };
    const recordPath = path.join(groupsDirFor(doc.path), `${groupId}.json`);
    await fsp.mkdir(path.dirname(recordPath), { recursive: true });
    await fsp.writeFile(recordPath, JSON.stringify(record, null, 2));
    groupIndex.set(groupId, { filmId: doc.id, recordPath });
    economy.addBatch('groupScenes', members.length); // per-scene render/poll loops replaced

    return {
      groupId,
      film: doc.slug,
      counts: {
        submitted: members.filter((m) => m.jobId).length,
        notSubmitted: members.filter((m) => !m.jobId).length,
        skipped: skipped.length,
      },
      members, skipped,
      // Plan problems that are NOT the unrendered scenes this group exists to
      // fix still matter for build_film — surfaced, never hidden.
      planProblems: plan.problems,
    };
  }
}

server.registerTool(
  'wait_render_group',
  {
    title: 'Wait on a render group with delta reporting',
    description:
      'Block on a render_group (v0.26, TE P0-7) for up to timeoutMs (same 50 s ceiling as wait_for_render — a ' +
      'timeout is a progress snapshot, never a failure; call again to keep waiting). Returns aggregate counts, ' +
      'per-scene member states, full detail for FAILED scenes only, and `done` — true when every member scene ' +
      'is rendered per the CURRENT film plan, which is recomputed from output files and sidecars: after a ' +
      'server restart the job ids are gone (state "not_found") but a scene whose verified output exists still ' +
      'counts done — files are the truth, not process memory. Pass the returned `cursor` back as `since` to get ' +
      'a heartbeat when nothing changed, or a `delta` naming exactly the scenes that did. Waiting also COMPLETES ' +
      'the persisted group record (TE P1-3): each member that ended gains `terminalState` + `finishedAt`, and ' +
      'the group gains `completedAt` once every member has — run history for a later reader, never the source ' +
      'of `done`.',
    inputSchema: {
      groupId: z.string(),
      timeoutMs: z.number().int().min(1_000).max(50_000).default(30_000),
      since: z.string().optional().describe('Cursor from a previous wait; unchanged state answers a tiny heartbeat'),
    },
  },
  wrap(async ({ groupId, timeoutMs, since }) => {
    const { record, recordPath } = await findGroupRecord(groupId);
    const liveIds = record.members.filter((m) => m.jobId).map((m) => m.jobId);
    const waited = liveIds.length
      ? await jobs.waitFor(liveIds, { timeoutMs })
      : { timedOut: false, jobs: [] };
    const byJob = new Map(waited.jobs.map((j) => [j.jobId, j]));

    // Scene truth from the CURRENT plan — output files and sidecars, not
    // process memory (the restart rule).
    const doc = await store.getFilm(qualifyFilm(record.film));
    const plan = await planFilm({ film: doc, store });
    const rows = segmentRows(plan, localId);
    const rowBySlug = new Map(rows.filter((r) => r.kind === 'scene').map((r) => [r.slug, r]));

    const members = record.members.map((m) => {
      const job = m.jobId ? byJob.get(m.jobId) : null;
      const row = rowBySlug.get(m.slug);
      return {
        slug: m.slug,
        jobId: m.jobId,
        jobState: job?.state ?? (m.jobId ? 'not_found' : 'not-submitted'),
        sceneState: row?.state ?? 'missing',
        ...(job?.state === 'running' ? { percent: job.percent } : {}),
      };
    });
    const counts = members.reduce((acc, m) => {
      acc[m.jobState] = (acc[m.jobState] ?? 0) + 1;
      return acc;
    }, {});
    const done = members.every((m) => m.sceneState === 'rendered');
    // Failure detail is local (plan principle 6): only failed members carry
    // their full job snapshot, error and all.
    const errors = record.members
      .map((m) => (m.jobId ? byJob.get(m.jobId) : null))
      .filter((j) => j && j.state === 'error');

    // The run history is completed where the outcome is first observed (TE
    // P1-3): this is the only place a group's jobs are waited on, so it is the
    // only place that can see them end. Awaited because it is one small write
    // and a caller that got `done` must be able to read the finished record.
    await updateGroupRecord(recordPath, (rec) => stampGroupTerminals(rec, (m) => byJob.get(m.jobId)?.state));

    const memberRows = members.map(({ percent, ...m }) => m); // percent churns; keep it out of the cursor
    const cursor = computeCursor({ film: record.film, rows: memberRows, marks: { groupId, done } });
    const parsed = since !== undefined ? parseCursor(since) : undefined;
    if (parsed && parsed.o === parseCursor(cursor).o) {
      return ok({ groupId, unchanged: true, done, timedOut: waited.timedOut, cursor });
    }
    const delta = parsed ? diffRows(parsed, memberRows) : undefined;

    return ok({
      groupId,
      film: record.film,
      timedOut: waited.timedOut,
      done,
      counts,
      members,
      ...(errors.length ? { errors } : {}),
      ...(delta ? { delta } : {}),
      ...(since !== undefined && !parsed ? { cursorReset: true } : {}),
      cursor,
    });
  }),
);

server.registerTool(
  'cancel_render_group',
  {
    title: 'Cancel every job of a render group',
    description:
      'Cancels each of a render group\'s jobs with the same per-job semantics as cancel_render (running jobs ' +
      'have their process tree killed, queued jobs dequeue, terminal/lost jobs are left as they are). ' +
      'Idempotent; the group record stays on disk for the run history.',
    inputSchema: { groupId: z.string() },
  },
  wrap(async ({ groupId }) => {
    const { record } = await findGroupRecord(groupId);
    const results = record.members.map((m) => {
      if (!m.jobId) return { slug: m.slug, cancelled: false, reason: 'never-submitted' };
      try { return { slug: m.slug, ...jobs.cancel(m.jobId) }; }
      catch { return { slug: m.slug, cancelled: false, reason: 'not_found' }; }
    });
    return ok({ groupId, film: record.film, results });
  }),
);

server.registerTool(
  'finish_film',
  {
    title: 'Finish a film: render what remains, build, verify — one job',
    description:
      'The composite finishing operation (v0.26, TE P1-1): checks the adviser loop and the film plan, renders ' +
      'every missing/stale scene through a render group, waits, builds the film, waits for the delivery, and ' +
      '(verify, default true) measures the encoded picture — as ONE async task job. Returns a jobId ' +
      'immediately; wait_for_render delivers the evidence as the job result: groupId, deliveryId, output path, ' +
      'the measured audio block, picture findings, and final readiness. It STOPS structurally rather than ' +
      'cutting corners: unresolved advice or a broken plan refuses the call up front (`blockers` names each), ' +
      'a failed scene render fails the job naming the scenes, and nothing bypasses promotion, frame ' +
      'verification, or review policy — this removes orchestration, not evidence. dryRun: true returns the ' +
      'assessment (what would render, what blocks) without starting anything. The record of the group it ' +
      'renders through is completed on disk as it goes: member terminal states, then the final deliveryId ' +
      '(TE P1-3).',
    inputSchema: {
      film: z.string(),
      dryRun: z.boolean().optional().describe('Assess only: blockers, scenes that would render, plan problems. Starts nothing.'),
      renderPolicy: z.enum(['missing-or-stale', 'all']).optional()
        .describe('Which scenes the render phase submits (default missing-or-stale)'),
      audioTargetPeakDb: nullableNumber(z.number().min(-60).max(0)).optional()
        .describe('Override + persist the mastering target before building'),
      workers: z.number().int().min(1).max(16).optional(),
      note: z.string().max(200).optional().describe('Provenance note stamped on the revisions this run produces'),
      verify: z.boolean().optional().describe('Measure the encoded picture after the build (default true)'),
    },
  },
  wrap(async ({ film, dryRun, renderPolicy = 'missing-or-stale', audioTargetPeakDb, workers, note, verify = true }) => {
    await requirePrereqs();
    const doc = await store.getFilm(qualifyFilm(film));
    const plan = await planFilm({ film: doc, store });
    const rows = segmentRows(plan, localId);
    const advice = await adviceSummary(doc.path);

    const missing = rows.filter((r) => r.state === 'missing');
    const toRender = rows.filter((r) => r.kind === 'scene')
      .filter((r) => (renderPolicy === 'all' ? true : r.state !== 'rendered'))
      .map((r) => r.slug);
    const blockers = [];
    if (advice.unresolved > 0) {
      blockers.push({
        kind: 'unresolved_advice', count: advice.unresolved,
        fix: 'check_human_advice, act on each item, resolve_human_advice — the adviser loop is never bypassed.',
      });
    }
    if (missing.length) {
      blockers.push({ kind: 'missing_segments', segments: missing.map((r) => r.slug ?? r.footage) });
    }
    const assessment = {
      film: doc.slug,
      wouldRender: toRender,
      alreadyRendered: rows.filter((r) => r.kind === 'scene' && r.state === 'rendered').length,
      planProblems: plan.problems,
      advice,
      blockers,
      readyToFinish: blockers.length === 0,
    };
    if (dryRun) return ok({ dryRun: true, ...assessment });
    if (blockers.length) {
      throw new EngineError(ErrorCodes.INVALID_FILM,
        `finish_film stopped before doing any work: ${blockers.map((b) => b.kind).join(', ')}.`,
        { blockers });
    }
    if (audioTargetPeakDb !== undefined) await store.updateFilm(doc.id, { audioTargetPeakDb });
    const ffmpegPath = await ffmpegPathOnly();

    const submitted = jobs.startTask({
      kind: 'finish-film',
      targetId: doc.id,
      run: async ({ onPhase, signal }) => {
        const HOUR = 60 * 60_000;
        // Cancelling the finish task cancels the work it started.
        const subJobs = new Set();
        const abort = () => { for (const id of subJobs) { try { jobs.cancel(id); } catch { /* already terminal */ } } };
        signal?.addEventListener?.('abort', abort, { once: true });

        onPhase('rendering');
        const group = await startRenderGroupOp({ film: doc.slug, scenePolicy: renderPolicy, workers, note });
        const notSubmitted = group.members.filter((m) => !m.jobId);
        if (notSubmitted.length) {
          throw new EngineError(ErrorCodes.QUEUE_FULL,
            `finish_film could not submit every scene: ${notSubmitted.map((m) => m.slug).join(', ')}. ` +
            'Drain the queue and run finish_film again — it resumes.',
            { notSubmitted });
        }
        const renderIds = group.members.map((m) => m.jobId);
        renderIds.forEach((id) => subJobs.add(id));
        const rendered = renderIds.length
          ? await jobs.waitFor(renderIds, { timeoutMs: HOUR })
          : { jobs: [] };
        // finish_film never calls wait_render_group, so it completes its own
        // group's record here — the run history must not depend on which door
        // the render was started through (TE P1-3).
        const renderedByJob = new Map(rendered.jobs.map((j) => [j.jobId, j]));
        await updateGroupRecord(
          path.join(groupsDirFor(doc.path), `${group.groupId}.json`),
          (rec) => stampGroupTerminals(rec, (m) => renderedByJob.get(m.jobId)?.state),
        );

        const plan2 = await planFilm({ film: await store.getFilm(doc.id), store });
        const failed = segmentRows(plan2, localId).filter((r) => r.kind === 'scene' && r.state !== 'rendered');
        if (failed.length) {
          const errors = renderIds.map((id) => { try { return jobs.getStatus(id); } catch { return null; } })
            .filter((j) => j && j.state !== 'done');
          throw new EngineError(ErrorCodes.INVALID_FILM,
            `Scenes failed to render: ${failed.map((r) => r.slug).join(', ')} — the film was NOT built.`,
            { scenes: failed.map((r) => r.slug), jobs: errors });
        }

        onPhase('building');
        const build = await submitFilmBuild({
          film: await store.getFilm(doc.id), store, jobs, ffmpegPath, deliverableId: null, agent: AGENT,
        });
        subJobs.add(build.jobId);
        const built = (await jobs.waitFor([build.jobId], { timeoutMs: HOUR })).jobs[0];
        if (built.state !== 'done') {
          throw new EngineError(built.error?.code ?? ErrorCodes.FFMPEG_FAILED,
            `The film build did not finish (state ${built.state}): ${built.error?.message ?? 'see get_logs'}.`,
            { jobId: build.jobId, job: built });
        }
        // The build succeeded, so the group that fed it now has its delivery.
        // Stamped here rather than after `verify` so a failed measurement
        // cannot erase the fact that this group was delivered (TE P1-3).
        if (built.deliveryId) {
          await updateGroupRecord(
            path.join(groupsDirFor(doc.path), `${group.groupId}.json`),
            (rec) => {
              if (rec.deliveryId === built.deliveryId) return false;
              rec.deliveryId = built.deliveryId;
              rec.deliveredAt = new Date().toISOString();
              return true;
            },
          );
        }

        let picture = null;
        if (verify) {
          onPhase('verifying');
          const located = await locateRenderedMedia(doc.slug, undefined);
          picture = await measureRenderedPicture({
            filePath: located.abs, fps: located.t.fps, totalFrames: located.t.durationInFrames,
            sceneLayout: renderReviewLayout(located.t), ffmpegPath, signal,
          });
        }

        const status = await productionStatus({ store, film: await store.getFilm(doc.id) });
        return {
          film: doc.slug,
          groupId: group.groupId,
          rendered: renderIds.length,
          skipped: group.skipped.length,
          deliveryId: built.deliveryId ?? null,
          outputPath: built.outputPath ?? null,
          audio: built.audio ?? null,
          ...(picture ? { picture } : {}),
          readiness: status.readiness,
          newerWorkThanDelivery: status.newerWorkThanDelivery,
        };
      },
    });
    return ok({
      jobId: submitted.jobId, state: submitted.state, film: doc.slug,
      willRender: toRender, alreadyRendered: assessment.alreadyRendered,
      hint: `wait_for_render { jobIds: ["${submitted.jobId}"] } — the finished result carries the delivery evidence.`,
    });
  }),
);

server.registerTool(
  'list_render_jobs',
  {
    title: 'List render jobs',
    description:
      'List active and recent jobs with their states. Both lanes appear here: renders/film builds (`kind: ' +
      '"render"`, one at a time) and non-render jobs such as transcriptions, which run in their own lane and never ' +
      'wait behind a render.',
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
      'Render one frame through the real render path and save it as a PNG inside the scene\'s "out" dir ' +
      '(new in v0.5). Use this to export poster frames / thumbnails; use capture_preview_frame when you want ' +
      'the image returned inline for visual inspection instead of written to disk.',
    inputSchema: {
      scene: z.string(),
      frame: z.number().int().min(0),
      outputFilename: z.string().optional().describe('Bare .png filename inside the "out" dir (default still-<frame>.png)'),
    },
  },
  wrap(async ({ scene, frame, outputFilename }) => {
    await requirePrereqs();
    const s = await store.getScene(qualifyScene(scene));
    const config = await store.readConfig(s.id);
    const name = outputFilename ?? `still-${frame}.png`;
    if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.png')) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, 'outputFilename must be a bare .png filename');
    }
    const outputPath = path.join(s.path, config.output.dir, name);
    const res = await renderStill({
      scenePath: s.path, config, frame, outputPath,
      ...(injectedBrowserFactory ? { browserFactory: injectedBrowserFactory } : {}),
    });
    return ok(res);
  }),
);

server.registerTool(
  'preview_audio',
  {
    title: 'Mix an audio timeline to a standalone WAV',
    description:
      'Render just the audio timeline to a WAV in the target\'s "out" dir — the exact filter graph the ' +
      'final render/build will use (delay, gain, trim/fades, ducking, limiter), minus the video (new in v0.19). ' +
      'Target a SCENE ("<film>/<scene>", mixes config.audio at the scene length) or a FILM ("<film>", mixes the ' +
      'film\'s master audio timeline at the full film length — audition the whole soundtrack before building). ' +
      'Takes seconds instead of a full render: use it to audition the mix and check levels BEFORE rendering. ' +
      'Returns the mixed peakDb/meanDb, a clipping flag, and each source clip\'s own measured level so a bad ' +
      'balance points at the track that caused it. balanceWarnings lists tracks whose effective level (clip mean ' +
      '+ gainDb) sits >=8 dB below a louder overlapping track — such a track is likely INAUDIBLE even though the ' +
      'render succeeds and nothing clips; fix the gains before rendering (gainDb must compensate each file\'s ' +
      'measured level, not encode a template). mix.envelopeDb is the per-second RMS of the mix (null = digital ' +
      'silence) and mix.silentTailSeconds the length of the dead tail, so a mix that goes silent early is ' +
      'visible here without measuring the WAV yourself. Fails with no_audio_tracks when the timeline is empty.',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      outputFilename: z.string().optional()
        .describe('Bare .wav filename inside the "out" dir (default audio-preview.wav)'),
      waitMs: z.number().int().min(0).max(50_000).default(45_000)
        .describe('Block up to this long; a longer mix returns a jobId to poll with wait_for_render'),
    },
  },
  wrap(async ({ target, outputFilename, waitMs }) => {
    await requirePrereqs();
    const t = await describeTarget(target);
    const tracks = await t.getTracks();
    if (!tracks.length) {
      throw new EngineError(
        ErrorCodes.NO_AUDIO_TRACKS,
        t.kind === 'scene'
          ? 'This scene has no audio tracks — attach one with synthesize_speech / synthesize_music / synthesize_sfx, or update_scene_config { audio: [...] }.'
          : 'This film has no master audio timeline — attach tracks by targeting the film in synthesize_*, or update_film { audio: [...] }.',
        { target },
      );
    }
    if (!t.durationInFrames) {
      throw new EngineError(
        ErrorCodes.INVALID_FILM,
        'The film has no scenes yet, so there is no timeline length to mix against — add scenes first.',
        { target },
      );
    }
    const name = outputFilename ?? 'audio-preview.wav';
    if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.wav')) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, 'outputFilename must be a bare .wav filename');
    }
    const outDir = path.join(t.path, t.output.dir ?? 'out');
    await fsp.mkdir(outDir, { recursive: true });
    const outputPath = path.join(outDir, name);
    const ffmpegPath = await ffmpegPathOnly();
    const videoDurationSec = t.durationInFrames / t.fps;

    const submitted = jobs.startTask({
      kind: 'audio-preview',
      targetId: t.id,
      run: async ({ onPhase, signal }) => {
        onPhase('mixing');
        await mixAudioOnly({
          audioTracks: tracks,
          outputPath,
          fps: t.fps,
          assetRoot: t.path,
          output: { audioLimiter: t.output.audioLimiter !== false },
          ffmpegPath,
          videoDurationSec,
          signal,
        });

        onPhase('measuring');
        // Per-clip levels: direct PCM read for WAVs, ffmpeg decode for the rest.
        const trackReport = [];
        for (const tr of tracks) {
          const abs = path.resolve(t.path, tr.src);
          let levels = { peakDb: null, meanDb: null };
          let clipDurationSec = null;
          if (/\.wav$/i.test(tr.src)) {
            levels = await measureWavLevels(abs).catch(() => levels);
            clipDurationSec = await wavDurationSeconds(abs).catch(() => null);
          } else {
            levels = (await measureAudioLevels({ filePath: abs, ffmpegPath, signal })) ?? levels;
          }
          trackReport.push({ ...tr, clipPeakDb: levels.peakDb, clipMeanDb: levels.meanDb, ...(clipDurationSec !== null ? { clipDurationSec: Number(clipDurationSec.toFixed(3)) } : {}) });
        }
        // Balance check: a track buried >=10 dB under a louder overlapping track
        // renders "successfully" and never clips — this is the only place the
        // problem becomes visible to a caller that cannot listen.
        const balanceWarnings = computeBalanceWarnings(trackReport, { fps: t.fps, videoDurationSec });
        const mix = await measureWavLevels(outputPath).catch(() => ({ peakDb: null, meanDb: null }));
        // Whole-file peak/mean can look healthy while the tail is dead — report a
        // per-second envelope so a mix that goes silent early is visible here
        // instead of only in the rendered film.
        const envelope = await measureWavEnvelope(outputPath).catch(() => null);

        return {
          target: localId(t.id),
          kind: t.kind,
          outputPath,
          durationSeconds: Number(videoDurationSec.toFixed(3)),
          limiter: t.output.audioLimiter !== false,
          balanceWarnings,
          tracks: trackReport,
          mix: {
            peakDb: mix.peakDb,
            meanDb: mix.meanDb,
            clipping: mix.peakDb !== null && mix.peakDb >= -0.1,
            ...(envelope ? {
              envelopeDb: envelope.envelopeDb,
              silentTailSeconds: envelope.silentTailSeconds,
            } : {}),
          },
        };
      },
    });

    const waited = await jobs.waitFor([submitted.jobId], { timeoutMs: waitMs, pollMs: 200 });
    const status = waited.jobs[0];
    if (status.state === 'error') {
      throw new EngineError(status.error?.code ?? ErrorCodes.FFMPEG_FAILED,
        status.error?.message ?? 'audio preview failed', status.error?.detail);
    }
    if (status.state !== 'done') {
      return ok({
        jobId: submitted.jobId, state: status.state, phase: status.phase,
        target: localId(t.id), kind: t.kind, outputPath, stillRunning: true,
        hint: `Still mixing audio (${status.phase}). Poll with wait_for_render { jobIds: ["${submitted.jobId}"] } — the report arrives as the job result.`,
      });
    }
    return ok({ jobId: submitted.jobId, ...status.result });
  }),
);

server.registerTool(
  'write_asset_file',
  {
    title: 'Write a binary asset (base64)',
    description:
      'Write a binary asset (image / audio / font / video) into a scene\'s or film\'s assets/ folder from base64 ' +
      'content. Target a scene ("<film>/<scene>") for composition assets, or a film ("<film>") for master-audio ' +
      'and overlay files. Destination is confined to assets/, extensions are allow-listed ' +
      '(png jpg jpeg gif webp svg mp3 wav ogg m4a flac woff woff2 ttf otf json txt mp4 webm mov), and size is ' +
      'capped at 25 MB (fails with asset_too_large — put big files in the workspace library instead and pull ' +
      'them with use_shared_asset). Reference the file from the composition as e.g. "assets/logo.png".',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      path: z.string().describe('Relative path under assets/, e.g. assets/logo.png'),
      contentBase64: z.string().describe('File content, base64-encoded'),
    },
  },
  wrap(async ({ target, path: relPath, contentBase64 }) => {
    const res = await store.writeAssetFile(qualifyTarget(target), relPath, contentBase64);
    return ok({ written: res });
  }),
);

server.registerTool(
  'list_assets',
  {
    title: 'List a scene\'s or film\'s assets',
    description:
      'Enumerate every file under the target\'s assets/ folder: path, bytes, mtime, a coarse kind ' +
      '(image/audio/font/video/data), and audioRefs — how many audio tracks reference the file (the scene\'s ' +
      'config.audio, or the film\'s master timeline, per target). Use this to answer "which assets does the ' +
      'audio timeline actually use, and which are orphaned?" before cleaning up.',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
    },
  },
  wrap(async ({ target }) => {
    return ok({ files: await store.listAssets(qualifyTarget(target)) });
  }),
);

server.registerTool(
  'probe_asset',
  {
    title: 'Probe a media asset (duration, dimensions, fps, codecs)',
    description:
      'Read the technical properties of ONE media file with ffprobe: container, duration, bit rate, and per-stream ' +
      'video (codec, width, height, fps, frame count, pixel format) and audio (codec, channels, sample rate). ' +
      'list_assets and list_shared_assets only report bytes/mtime/kind — this is how you find out how LONG a clip ' +
      'is, what size it is, and whether it has an audio track, before building a scene around it. ' +
      'Probe an asset by passing its target ("<film>" or "<film>/<scene>") with an assets/-relative path — or an ' +
      'out/-relative one to probe what the engine rendered, e.g. out/film.mp4 after build_film; OMIT ' +
      'target to probe a workspace-library file by its library-relative path (from list_shared_assets). ' +
      'Also returns `notes` for properties that will bite at render time — most importantly that H.264/HEVC ' +
      'cannot be decoded by the render browser, so a <video> using such a file fails even though the page\'s own ' +
      'canPlayType() says otherwise. Returns probed:false (never an error) when ffprobe is unavailable or the ' +
      'file is not media; ffprobe is not a declared prerequisite. ' +
      'Pass audioPeak:true to also measure WHERE the clip is loudest — `audio.peakDb` and `audio.peakAtSeconds`. ' +
      'THAT is the number you need before placing a one-shot (an impact, riser, downlifter, glitch) on a beat: a ' +
      'cue\'s transient is usually NOT at 0 s — measured across five generated cues it ranged from 0.00 s to ' +
      '4.31 s — so a riser started ON the downbeat peaks four seconds late. Start the track ' +
      '`peakAtSeconds * fps` frames EARLY and the hit lands on the beat. Off by default because it decodes the ' +
      'whole file, unlike the metadata-only default read. Exact for a TRANSIENT (an impact, a stab); for a broad ' +
      'swell the loudest part is a plateau, so treat the number as the middle of the climax rather than an edge.',
    inputSchema: {
      path: z.string()
        .describe('assets/ or out/-relative path when `target` is given (out/ reads what the engine rendered), else a library-relative path from list_shared_assets'),
      target: z.string().optional()
        .describe('Scene id "<film>/<scene>" or film id "<film>". Omit to probe a workspace-library file.'),
      audioPeak: z.boolean().optional()
        .describe('Also measure peak level and its position in seconds (decodes the file). Use before placing a one-shot cue on a beat.'),
    },
  },
  wrap(async ({ path: relPath, target, audioPeak = false }) => {
    const { path: ffprobePath } = await resolveFfprobePath({ dataDir: store.dataDir });
    const located = await locateMedia(relPath, target);
    const { abs, ...rest } = located;
    const media = await probeMedia({ filePath: abs, ffprobePath });
    let peak = null;
    if (audioPeak && media?.hasAudio) {
      const { path: ffmpegPath } = await resolveFfmpegPath({ dataDir: store.dataDir });
      peak = await measureAudioPeakPosition({ filePath: abs, ffmpegPath }).catch(() => null);
    }
    return ok({
      ...rest,
      probed: media !== null,
      ...(media ?? {}),
      ...(peak ? { audio: { ...(media?.audio ?? {}), ...peak } } : {}),
    });
  }),
);

server.registerTool(
  'transcribe_asset',
  {
    title: 'Transcribe speech in a media asset (text + sentence/word timing)',
    description:
      'Read the speech in a supplied recording — audio OR video — and get back the words WITH TIMING. Addressed ' +
      'exactly like probe_asset: pass a target ("<film>" or "<film>/<scene>") with an assets/-relative path — or an ' +
      'out/-relative one to hear what the engine rendered, which is how you verify a finished cut (out/film.mp4) — ' +
      'or OMIT target to transcribe a workspace-library file by its library-relative path (from list_shared_assets). Video ' +
      'is accepted directly; the 16 kHz mono extraction happens internally and leaves nothing behind. ' +
      'DO THIS BEFORE CHOOSING SCENE DURATIONS when a film is built around a recording — the same way narration is ' +
      'synthesized before durations are chosen. Without it every in-point is arithmetic against the clip length, ' +
      'and you cannot know what the person is saying. ' +
      'Returns: `text` (everything said), `sentences[]` — REBUILT on sentence boundaries, mirroring ' +
      'synthesize_speech\'s `timings` field-for-field ({text, startSeconds, startInFrames, durationSeconds, ' +
      'durationInFrames}) so recorded and generated narration are handled by one code path — `words[]` with ' +
      'per-word start/end frames (this is how you cue a graphic to a spoken word inside a sentence), ' +
      '`speechRanges[]` + `leadingSilenceFrames`/`trailingSilenceFrames` (where you can cut without clipping a ' +
      'word), and `rawSegments[]` (the vendor\'s own decode windows, for debugging only — they start mid-clause ' +
      'and are NOT edit points). ' +
      'CONFIDENCE IS REPORTED, NOT HIDDEN: per-sentence `minTokenP`/`meanTokenP` and per-word `p`. A low minTokenP ' +
      'means the model guessed — never put such a sentence on screen verbatim without the user reading it. Proper ' +
      'nouns and technical terms come back wrong often enough to matter; TIMING is far more reliable than spelling. ' +
      'An English-only .en model refuses an explicit non-English language with transcription_language_unsupported ' +
      'rather than returning a plausible but wrong transcript; use a multilingual model or omit language for auto-detection. ' +
      'Vendor: whisper.cpp, local and offline, NO API key. An unconfigured machine fails with ' +
      'transcription_unavailable naming the fix — that is for the user to fix, do not retry. Check availability ' +
      'with list_vendors (capability "transcription"). ' +
      'It is a JOB in its own lane, so it never waits behind a render: the call blocks up to `waitMs` and returns ' +
      'the transcript if it finished, otherwise a jobId to poll with get_render_status / wait_for_render (the ' +
      'transcript arrives as the job\'s `result`). Results are cached per (file, model, language), so asking again ' +
      'is free — including after a render, which is how you verify a finished cut by re-transcribing it. ' +
      `Bounded at ${MAX_TRANSCRIBE_SECONDS / 60} minutes of audio per call: cut the span you care about first ` +
      'rather than reading a whole conference recording.',
    inputSchema: {
      path: z.string()
        .describe('assets/ or out/-relative path when `target` is given (out/ reads what the engine rendered), else a library-relative path from list_shared_assets'),
      target: z.string().optional()
        .describe('Scene id "<film>/<scene>" or film id "<film>". Omit to transcribe a workspace-library file.'),
      fps: z.number().positive().max(240).optional()
        .describe('Frame rate every *InFrames field is reported at (default: the target\'s fps, else 30)'),
      language: z.string().optional()
        .describe('Spoken language, e.g. "en" — omit to auto-detect; an English-only .en model refuses an explicit non-English language'),
      model: z.string().optional()
        .describe('Vendor model name, e.g. "small.en" / "large-v3" (see list_vendors); omit for the configured default'),
      vendor: z.enum(TRANSCRIPTION_VENDORS).optional()
        .describe('Transcription vendor; omit to use the configured default'),
      words: z.boolean().default(true)
        .describe('Include the per-word array. Leave true unless you only need sentences — words are what let a graphic land on a spoken word.'),
      wordsMatching: z.string().optional()
        .describe('Only return words containing this text (case-insensitive) — the direct way to find the frame a given name is spoken on'),
      maxWords: z.number().int().min(1).max(20000).default(3000)
        .describe('Cap on returned words (a long recording is thousands); reports wordsTruncated when it bites'),
      pauseSeconds: z.number().min(0.1).max(10).default(1)
        .describe('Silence this long or longer splits speechRanges — i.e. what counts as a pause you could cut on'),
      refresh: z.boolean().default(false)
        .describe('Ignore the cached transcript and run the model again'),
      waitMs: z.number().int().min(0).max(600000).default(45000)
        .describe('Block up to this long for the job; past it you get a jobId to poll instead of a timed-out call'),
    },
  },
  wrap(async ({
    path: relPath, target, fps, language, model, vendor, words, wordsMatching, maxWords,
    pauseSeconds, refresh, waitMs,
  }) => {
    // ffmpeg does the extraction, so the same prereq every render needs applies
    // here — and failing on it now beats failing inside a queued job.
    await requirePrereqs();
    const located = await locateMedia(relPath, target);
    if (!looksTranscribable(located.path)) {
      throw new EngineError(
        ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
        `"${located.path}" is not an audio or video file, so there is no speech in it to read. ` +
          'Pass a recording (wav/mp3/m4a/flac/ogg or mp4/mov/mkv/webm).',
        { path: located.path },
      );
    }

    // Probe before queueing: an unconfigured vendor should fail immediately with
    // the fix, not sit in a queue and then fail. The job re-resolves (cheaply,
    // one-entry chains probe nothing) so the two cannot disagree.
    const resolved = await resolveTranscriptionVendor({ vendor, dataDir: store.dataDir, probe: true });
    const probe = resolved.status ?? await checkTranscriptionVendor(resolved.vendor, { dataDir: store.dataDir });
    if (!probe.available) {
      throw await transcriptionUnavailableWithAlternatives(resolved.vendor, probe, { dataDir: store.dataDir });
    }

    const effectiveFps = fps ?? (target ? (await describeTarget(target)).fps : 30);
    const ffmpegPath = await ffmpegPathOnly();
    const submitted = jobs.startTask({
      kind: 'transcribe',
      targetId: located.path,
      run: ({ signal, onPhase }) => transcribeMedia({
        transcription: vendorRuntime?.transcription ?? null,
        filePath: located.abs,
        fps: effectiveFps,
        vendor, model, language,
        silenceGapSeconds: pauseSeconds,
        dataDir: store.dataDir,
        ffmpegPath,
        refresh,
        signal,
        onPhase,
      }),
    });

    const waited = await jobs.waitFor([submitted.jobId], { timeoutMs: waitMs, pollMs: 200 });
    const status = waited.jobs[0];
    if (status.state === 'error') {
      // Re-raise the job's failure as this call's failure: the caller asked a
      // question and a jobId it must poll to learn "your vendor is missing" is
      // strictly worse than the error itself.
      throw new EngineError(status.error?.code ?? ErrorCodes.TRANSCRIPTION_FAILED,
        status.error?.message ?? 'transcription failed', status.error?.detail);
    }
    if (status.state !== 'done') {
      return ok({
        jobId: submitted.jobId,
        state: status.state,
        phase: status.phase,
        path: located.path,
        ...(located.target ? { target: located.target } : {}),
        vendor: resolved.vendor,
        model: probe.config?.activeModel ?? model ?? null,
        fps: effectiveFps,
        stillRunning: true,
        hint: `Still transcribing (${status.phase}). Poll with wait_for_render { jobIds: ["${submitted.jobId}"] } — ` +
          'the transcript comes back as the job\'s `result`. Nothing is blocking a render; this runs in its own lane.',
      });
    }

    const t = status.result;
    const matched = wordsMatching
      ? t.words.filter((w) => w.text.toLowerCase().includes(wordsMatching.toLowerCase()))
      : t.words;
    const page = words ? matched.slice(0, maxWords) : [];
    return ok({
      jobId: submitted.jobId,
      source: located.source,
      ...(located.target ? { target: located.target } : {}),
      path: located.path,
      vendor: t.vendor,
      vendorSource: t.vendorSource,
      ...(resolved.chain.length > 1 ? { vendorChain: resolved.chain } : {}),
      ...(await vendorNoteFor('transcription', resolved)),
      model: t.model,
      language: t.language,
      cached: t.cached,
      elapsedMs: t.elapsedMs,
      durationSeconds: t.durationSeconds,
      durationInFrames: t.durationInFrames,
      fps: t.fps,
      text: t.text,
      sentences: t.sentences,
      wordCount: t.words.length,
      ...(wordsMatching ? { wordsMatching, matchedWords: matched.length } : {}),
      ...(words ? { words: page } : {}),
      ...(words && page.length < matched.length
        ? { wordsTruncated: true, hint: `Showing ${page.length} of ${matched.length} words — raise maxWords, or use wordsMatching to find the one you need.` }
        : {}),
      speechRanges: t.speechRanges,
      leadingSilenceSeconds: t.leadingSilenceSeconds,
      leadingSilenceFrames: t.leadingSilenceFrames,
      trailingSilenceSeconds: t.trailingSilenceSeconds,
      trailingSilenceFrames: t.trailingSilenceFrames,
      // Verbatim decode windows: useful when a derived sentence looks wrong, and
      // never an edit point — they start mid-clause by construction.
      rawSegments: t.rawSegments,
    });
  }),
);

server.registerTool(
  'transcode_asset',
  {
    title: 'Prepare a media asset (conform, trim, crop, scale, extract audio)',
    description:
      'CHANGE a media file, inside the tool surface. probe_asset reads a file and transcribe_asset hears one; this ' +
      'is the one that produces a new file, which every real job with supplied footage needs. The output lands under ' +
      'the target\'s assets/ and is reported by MEASURING it, never by echoing the request. ' +
      'THREE MODES. mode="video" (default): conform footage — trim to an EXACT frame count, crop a tighter framing, ' +
      'scale, change fps, pick a codec by the `to` extension (.mp4/.webm/.mov). This is how you fix the H.264 trap: ' +
      'the render browser cannot decode H.264, so a clip a composition will play must become VP9/WebM first ' +
      '(probe_asset warns about it; this acts on the warning). mode="audio": cut N spans out of one source and JOIN ' +
      'them into a PCM WAV — a talk becomes a spine — with a bounded crossfade so the joins do not click. ' +
      'mode="frames": a PNG sequence under assets/<dir>/. ' +
      'matchFilm="<film>" is the option that prevents the common disaster: it conforms the output to that film\'s ' +
      'encode signature using the film\'s OWN encoder arguments, so the result can be stream-copied onto its ' +
      'timeline as a footage segment (update_film { scenes: [{footage, durationInFrames}] }). Without it you are ' +
      'hand-matching an invariant, and the failure is a broken concat much later. ' +
      'TRIM IN FRAMES, not seconds: `durationInFrames` maps to ffmpeg\'s -frames:v, which guarantees the count; a ' +
      'seconds-based duration does not, and one frame of drift shifts every subsequent scene, caption and cue. ' +
      '`trim.durationInFrames` always means frames OF SOURCE. ' +
      'NO ARBITRARY FFMPEG ARGUMENTS exist here and none will be added — every operation is a named, validated ' +
      'field, because a passthrough would be a shell wearing a hat and would take the path sandbox with it. If you ' +
      'need something absent from the field list, say so; do not look for an escape hatch. ' +
      'Idempotent: a sidecar beside the output records the source identity and every parameter, so repeating an ' +
      'unchanged call returns skipped:true and costs nothing. It NEVER overwrites its source. ' +
      'Runs as a job in the same lane as transcribe_asset, so it never waits behind a render: the call blocks up ' +
      'to `waitMs` and returns the result, otherwise a jobId to poll with wait_for_render.',
    inputSchema: {
      target: z.string().describe('Where the OUTPUT lands: scene id "<film>/<scene>" or film id "<film>"'),
      from: z.string()
        .describe('Source path. Library-relative when `fromTarget` is omitted (the usual case — no need to copy a 500 MB source in first); else assets/-relative inside `fromTarget`'),
      fromTarget: z.string().optional()
        .describe('Read the source from this scene/film\'s assets/ instead of the workspace library'),
      to: z.string()
        .describe('Destination under the target\'s assets/ — e.g. "assets/host-pip.webm". The extension picks the codec (.mp4 H.264, .webm VP9, .mov ProRes); mode="frames" treats it as a directory'),
      mode: z.enum(['video', 'audio', 'frames']).default('video')
        .describe('video = a video file; audio = a WAV from spans[]; frames = a PNG sequence'),
      matchFilm: z.string().optional()
        .describe('Conform the output to this film\'s encode signature, using the film\'s own ffmpegArgs — makes it concat-compatible by construction'),
      trim: z.object({
        startSeconds: z.number().min(0).optional(),
        startInFrames: z.number().int().min(0).optional(),
        durationInFrames: z.number().int().positive().optional().describe('PREFER THIS — an exact frame count of source'),
        durationSeconds: z.number().positive().optional(),
      }).optional().describe('Cut a span out of the source. Pass exactly one of startSeconds|startInFrames and one of durationInFrames|durationSeconds'),
      crop: z.object({
        x: z.number().int().min(0).default(0), y: z.number().int().min(0).default(0),
        width: z.number().int().positive(), height: z.number().int().positive(),
      }).optional().describe('Source-pixel rectangle, applied BEFORE scale'),
      scale: z.object({
        width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
      }).optional().describe('Give one dimension to keep the aspect ratio. Dimensions floor to even for video (chroma subsampling); the response reports what you actually got'),
      fps: z.number().positive().max(240).optional().describe('Output frame rate'),
      video: z.object({
        quality: z.number().int().min(0).max(63).optional().describe('CRF — lower is better; ~18 for mp4, ~32 for webm'),
        gop: z.number().int().positive().optional().describe('Keyframe interval. Use ~10 for footage a composition will seekVideo() through — it makes per-frame seeking much faster. NOT needed to concatenate.'),
      }).optional(),
      audio: z.boolean().optional()
        .describe('video mode: keep the source audio (default false — footage on a film timeline must be silent, and a composition PIP has no use for it)'),
      spans: z.array(z.object({
        startSeconds: z.number().min(0),
        durationInFrames: z.number().int().positive().optional(),
        durationSeconds: z.number().positive().optional(),
      })).max(MAX_SPANS).optional()
        .describe('audio mode: spans to cut and join, in SOURCE order. Building a spine from a talk is N trims joined, not one'),
      crossfadeMs: z.number().min(0).max(MAX_CROSSFADE_MS).default(12)
        .describe('audio mode: triangular crossfade at each join. A hard butt-join between two spans of speech CLICKS; 12ms fixes it. 0 = hard join. Note a crossfade consumes time: the result is sum(spans) − (N−1)×crossfade'),
      sampleRate: z.number().int().optional().describe('audio mode: 48000 default; use 16000 mono for a file you will transcribe'),
      channels: z.number().int().min(1).max(2).optional().describe('audio mode: 1 or 2 (default 2)'),
      frames: z.object({ every: z.number().int().positive().optional() }).optional()
        .describe('frames mode: keep every Nth frame of the trimmed span'),
      refresh: z.boolean().default(false).describe('Re-run even if the sidecar says nothing changed'),
      waitMs: z.number().int().min(0).max(600000).default(45000)
        .describe('Block up to this long; past it you get a jobId to poll instead of a timed-out call'),
    },
  },
  wrap(async ({
    target, from, fromTarget, to, mode, matchFilm, trim, crop, scale, fps, video, audio,
    spans, crossfadeMs, sampleRate, channels, frames, refresh, waitMs,
  }) => {
    await requirePrereqs();
    // Everything shell-shaped is refused before a process is spawned, and every
    // complaint comes back at once.
    validateTranscode({ mode, to, trim, crop, scale, fps, video, spans, crossfadeMs, sampleRate, channels, frames });

    const source = await locateMedia(from, fromTarget);
    const t = await describeTarget(target);

    const normalized = String(to).replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED,
        `Output must be written under assets/ (got "${to}")`, { path: to });
    }
    if (mode === 'video' && !formatForExtension(normalized)) {
      throw new EngineError(ErrorCodes.UNSUPPORTED_FORMAT,
        `Cannot tell the output format from "${normalized}" — use .mp4, .webm or .mov`, { path: to });
    }
    // The same write guards write_asset_file uses. A frames directory is not an
    // asset filename, so only the single-file modes go through the extension
    // allow-list; the directory itself is still confined to assets/.
    const outAbs = mode === 'frames'
      ? resolveInTarget(t.path, normalized)
      : resolveInTarget(t.path, normalized, { forWrite: true, asAsset: true });

    // matchFilm resolves from the film's stated signature — never from a second
    // derivation of the encode table.
    let signature = null;
    if (matchFilm) {
      const doc = await store.getFilm(qualifyFilm(matchFilm));
      signature = (await planFilm({ film: doc, store })).signature;
      if (!signature?.ffmpegArgs) {
        throw new EngineError(ErrorCodes.INVALID_FILM,
          `Film "${matchFilm}" has no encode signature to match yet — it needs at least one scene whose format ` +
          'has an encode step. get_film reports the signature once it does.',
          { film: matchFilm });
      }
    }

    const ffmpegPath = await ffmpegPathOnly();
    const { path: ffprobePath } = await resolveFfprobePath({ dataDir: store.dataDir });
    const submitted = jobs.startTask({
      kind: 'transcode',
      targetId: normalized,
      run: ({ signal, onPhase, onChildPid }) => transcodeAsset({
        sourceAbs: source.abs, outPath: outAbs, mode,
        trim, crop, scale, fps, video: video ?? {}, audio,
        spans, crossfadeMs, sampleRate, channels, frames,
        signature,
        // Frame counts in a trim or a span are converted with the TARGET's rate,
        // so "90 frames" means the same thing here as everywhere else in the film.
        fpsForFrames: t.fps,
        ffmpegPath, ffprobePath, refresh, signal,
        onSpawn: onChildPid, onPhase,
      }),
    });

    const waited = await jobs.waitFor([submitted.jobId], { timeoutMs: waitMs, pollMs: 200 });
    const status = waited.jobs[0];
    if (status.state === 'error') {
      throw new EngineError(status.error?.code ?? ErrorCodes.TRANSCODE_FAILED,
        status.error?.message ?? 'transcode failed', status.error?.detail);
    }
    if (status.state !== 'done') {
      return ok({
        jobId: submitted.jobId, state: status.state, phase: status.phase,
        target: localId(t.id), path: normalized, mode, stillRunning: true,
        hint: `Still transcoding (${status.phase}). Poll with wait_for_render { jobIds: ["${submitted.jobId}"] } — ` +
          'the result comes back as the job\'s `result`. Nothing is blocking a render; this runs in its own lane.',
      });
    }

    const r = status.result;
    // A timeline segment keeps only pointers to the transcode evidence. The
    // sidecar remains authoritative for the source identity and transform; do
    // not copy that manifest into film.json where it could drift.
    const sidecarExists = mode === 'video' && t.kind === 'film'
      ? !!(await fsp.stat(transcodeMetaPath(outAbs)).catch(() => null))
      : false;
    const timelineSegment = mode === 'video' && signature && t.kind === 'film'
      && Number.isInteger(r.frames) && r.frames > 0 && sidecarExists
      ? {
        footage: normalized,
        durationInFrames: r.frames,
        derivedFrom: {
          asset: sourceAssetReference(source),
          transcodeMeta: transcodeMetaPath(normalized),
        },
      }
      : null;
    return ok({
      jobId: submitted.jobId,
      target: localId(t.id),
      path: normalized,
      source: `${source.source}:${source.path}`,
      mode,
      bytes: r.bytes,
      skipped: r.skipped,
      elapsedMs: r.elapsedMs,
      applied: r.applied,
      ...(signature ? { matchedFilm: matchFilm, signature: signature.id } : {}),
      // Measured on the RESULT — the same block probe_asset returns, including
      // `notes` if the output still is not browser-decodable.
      probed: r.probed,
      ...(r.container ? { container: r.container } : {}),
      ...(r.durationSeconds !== undefined ? { durationSeconds: r.durationSeconds } : {}),
      ...(r.video !== undefined ? { video: r.video } : {}),
      ...(r.audio !== undefined ? { audio: r.audio } : {}),
      ...(r.hasAudio !== undefined ? { hasAudio: r.hasAudio } : {}),
      ...(r.frames ? { frames: r.frames } : {}),
      ...(r.notes ? { notes: r.notes } : {}),
      ...(r.assumptions ? { assumptions: r.assumptions } : {}),
      ...(timelineSegment ? { timelineSegment } : {}),
      hint: mode === 'audio'
        ? `Put it on a timeline with ${t.kind === 'scene' ? 'update_scene_config' : 'update_film'} { audio: [{ src: "${normalized}" }] }, then check the mix with preview_audio.`
        : mode === 'video' && signature
          ? timelineSegment
            ? `Place the returned timelineSegment on the film with update_film { scenes: [...] }; it preserves this clip's source provenance.`
            : `Place it on the film timeline with update_film { scenes: [..., { footage: "${normalized}", durationInFrames: ${r.frames ?? '<frames>'} }] }. Its provenance sidecar was unavailable, so the plan cannot verify later source changes.`
          : `Reference it from a composition as "${normalized}" — drive video with seekVideo(), never play().`,
    });
  }),
);

server.registerTool(
  'delete_asset',
  {
    title: 'Delete an asset',
    description:
      'Delete one file under the target\'s assets/ folder. Always reports audioRefs — the number of audio ' +
      'tracks that referenced the file — so a dangling reference is never created silently. ' +
      'Pass updateAudio: true to also drop those tracks in the same call; leaving it false keeps them, which ' +
      'means the next render/build fails at the ffmpeg mux step with a missing input. Irreversible: the file is ' +
      'removed from disk. Folders are not deleted (manage those on disk).',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      path: z.string().describe('Relative path under assets/, e.g. assets/narration-3.wav'),
      updateAudio: z.boolean().default(false)
        .describe('Also remove any audio tracks whose src is this file'),
    },
  },
  wrap(async ({ target, path: relPath, updateAudio }) => {
    return ok(await store.deleteAsset(qualifyTarget(target), relPath, { updateAudio }));
  }),
);

server.registerTool(
  'rename_asset',
  {
    title: 'Rename or move an asset',
    description:
      'Rename/move a file within the target\'s assets/ folder. Both paths must stay under assets/, and an ' +
      'existing destination is refused rather than overwritten. Reports audioRefs; pass updateAudio: true to ' +
      'repoint those audio tracks at the new path (each track\'s startInFrames and gainDb are preserved). ' +
      'Without it the tracks keep pointing at the old, now-missing file.',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      from: z.string().describe('Existing relative path under assets/'),
      to: z.string().describe('New relative path under assets/'),
      updateAudio: z.boolean().default(false)
        .describe('Also repoint any audio tracks that reference the old path'),
    },
  },
  wrap(async ({ target, from, to, updateAudio }) => {
    return ok(await store.renameAsset(qualifyTarget(target), from, to, { updateAudio }));
  }),
);

server.registerTool(
  'list_shared_assets',
  {
    title: 'List the workspace\'s shared-asset library',
    description:
      'Enumerate the workspace LIBRARY — files the human placed for this agent to use (typically large media: ' +
      'background plates, footage, soundtracks; the Studio has an upload panel and the folder is ' +
      '<workspace>/library on disk). Returns path, bytes, mtime and kind per file. The library is read-only ' +
      'from this surface: pull a file into a scene or film with use_shared_asset, which links it under the ' +
      'target\'s assets/ without copying the bytes when possible. If the user mentions having provided a file, ' +
      'look here first.',
    inputSchema: {},
  },
  wrap(async () => {
    const files = await store.listLibrary(WORKSPACE);
    return ok({ workspace: WORKSPACE, files });
  }),
);

server.registerTool(
  'use_shared_asset',
  {
    title: 'Pull a library file into a scene or film',
    description:
      'Make a workspace-library file available to a scene or film as a normal asset: it appears under the ' +
      'target\'s assets/library/… (or the `as` path you give) and is referenced from compositions and audio ' +
      'timelines like any other asset. Hardlinked when the filesystem allows — a 500 MB plate costs no extra ' +
      'disk — copied otherwise; either way the scene stays self-contained and renders hermetically. Pulling the ' +
      'same file again refreshes the link/copy, so an updated library file propagates on request. ' +
      'Fails with file_not_found if the library path does not exist (list_shared_assets shows what is there).',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      path: z.string().describe('Library-relative path from list_shared_assets, e.g. plates/rome-forum.png'),
      as: z.string().optional().describe('Destination under the target\'s assets/ (default assets/library/<path>)'),
    },
  },
  wrap(async ({ target, path: libPath, as }) => {
    return ok(await store.useLibraryAsset(qualifyTarget(target), libPath, { as }));
  }),
);

server.registerTool(
  'use_shared_asset_batch',
  {
    title: 'Pull many library files into scenes/films in one call',
    description:
      'Batch asset linking (v0.26, TE P0-4): one call for a list of library → target links instead of one ' +
      'call per plate. Each item is `{target, path, as?}` exactly as use_shared_asset takes them; items are ' +
      'independent — a missing library file reports an error row for that item while the rest link, and the ' +
      'aggregate counts say at a glance whether everything landed. Idempotent like the single tool: pulling ' +
      'the same file again refreshes the link/copy, so a repeat run is cheap and never an error. Returns one ' +
      'row per item (`linked` = hardlinked, `copied` = filesystem could not hardlink, or `error`) plus counts.',
    inputSchema: {
      items: z.array(z.object({
        target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
        path: z.string().describe('Library-relative path from list_shared_assets'),
        as: z.string().optional().describe('Destination under the target\'s assets/ (default assets/library/<path>)'),
      })).min(1).max(200),
    },
  },
  wrap(async ({ items }) => {
    const results = [];
    for (const { target, path: libPath, as } of items) {
      try {
        const res = await store.useLibraryAsset(qualifyTarget(target), libPath, { as });
        results.push({
          target, path: libPath, dest: res.path, bytes: res.bytes,
          result: res.linked ? 'linked' : 'copied',
        });
      } catch (e) {
        results.push({ target, path: libPath, result: 'error', error: { code: e.code ?? 'error', message: e.message } });
      }
    }
    economy.addBatch('itemsLinked', items.length); // per-scene use_shared_asset calls replaced
    return ok({
      counts: {
        items: items.length,
        linked: results.filter((r) => r.result === 'linked').length,
        copied: results.filter((r) => r.result === 'copied').length,
        errors: results.filter((r) => r.result === 'error').length,
      },
      results,
    });
  }),
);

server.registerTool(
  'synthesize_speech',
  {
    title: 'Synthesize narration (text-to-speech)',
    description:
      'Turn narration text into a spoken WAV in the target\'s assets/ folder. Target a SCENE for scene-local ' +
      'narration, or a FILM ("<film>") to write master-timeline narration into the film\'s assets — placed by ' +
      'absolute film frame, the normal choice for long-form. Six vendors: "system" = the ' +
      'local Windows speech exe (offline, needs MOTION_STUDIO_TTS_EXE), "azure" = Azure AI Speech neural voices ' +
      '(cloud, needs AZURE_SPEECH_KEY + AZURE_SPEECH_REGION in the environment, billed per character), "piper" = ' +
      'local neural voices (offline and free, any OS, needs Piper installed plus downloaded .onnx voices), ' +
      '"elevenlabs" = ElevenLabs cloud voices (best quality, needs ELEVENLABS_API_KEY, free tier with attribution), ' +
      '"openai" = OpenAI gpt-4o-mini-tts (style-instructable, needs OPENAI_API_KEY, no free tier), "deepgram" = ' +
      'Deepgram Aura-2 (best free cloud tier — $200 signup credit, needs DEEPGRAM_API_KEY). ' +
      'Omit `vendor` to use the machine\'s configured default — check it with list_vendors; an unconfigured vendor ' +
      'fails with tts_unavailable, which the user must fix (do not retry). The user may have STARRED favorite ' +
      'voices in the Studio: check `favoriteVoices` (vendor → voice names) in list_vendors\' speech settings and ' +
      'prefer one of them when the request doesn\'t name a voice — they are voices the user auditioned and chose. ' +
      'Returns the clip length as durationSeconds AND durationInFrames — use durationInFrames to size the ' +
      'Sequence() block the narration plays under — plus the measured peakDb/meanDb of the clip, so you can set ' +
      'a music bed\'s gainDb relative to the narration without rendering first. ' +
      'sentenceTimings=true additionally synthesizes per sentence and returns `timings` — each sentence\'s ' +
      'start/duration in seconds AND frames — so captions and cues can be placed exactly instead of eyeballed ' +
      '(inter-sentence pacing becomes sentenceGapSeconds rather than the vendor\'s own; the vendor\'s per-clip ' +
      'trailing silence is zeroed so the gap replaces, never stacks on, its pacing). ' +
      'deterministic=true (piper and elevenlabs only) pins the output so identical input yields identical timing ' +
      'across runs (Piper: --noise-scale 0 --noise-w 0; ElevenLabs: a fixed seed) — use it whenever cue frames ' +
      'are computed from the clip. ' +
      'mode="attach" (default) also appends the clip to the target\'s audio tracks (scene config.audio, or the ' +
      'film\'s master timeline) so the next render/build mixes it in automatically; mode="asset-only" just writes ' +
      'the WAV and reports its duration, leaving you to wire it later. ' +
      'List available voices first with list_voices. Narration text is passed safely (UTF-8 file for the exe, ' +
      'escaped SSML for Azure, JSON bodies for the other cloud vendors), so quotes / newlines / unicode are safe.',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      text: z.string().min(1).describe('Narration text (UTF-8)'),
      vendor: z.enum(TTS_VENDORS).optional()
        .describe('Speech vendor; omit to use the configured default (see list_vendors)'),
      voice: z.string().optional().describe('Voice name from list_voices; omit for the vendor default'),
      rate: z.number().int().min(-10).max(10).optional().describe('Speaking rate (engine scale, e.g. -10..10)'),
      volume: z.number().int().min(0).max(100).optional().describe('Volume 0..100'),
      style: z.string().optional()
        .describe('azure/openai: expressive style, e.g. "newscast", "cheerful" — azure needs the voice to support it (see list_voices styles); openai turns it into a spoken-style instruction (gpt-4o-mini-tts only)'),
      mode: z.enum(['attach', 'asset-only']).default('attach')
        .describe('attach = also add an audio track; asset-only = just synthesize + report'),
      assetPath: z.string().optional()
        .describe('Relative .wav under assets/ (default assets/narration-<n>.wav)'),
      startInFrames: z.number().int().min(0).optional().describe('attach mode: track start offset in frames'),
      gainDb: z.number().optional().describe('attach mode: track gain in dB'),
      sentenceTimings: z.boolean().default(false)
        .describe('Synthesize per sentence and report each sentence\'s start/duration in the clip — for caption sync, cue placement, lip-sync (v0.19)'),
      sentenceGapSeconds: z.number().min(0).max(5).default(0.3)
        .describe('sentenceTimings only: silence inserted between sentences'),
      deterministic: z.boolean().optional()
        .describe('piper/elevenlabs: pin the output so identical input yields identical timing across runs (piper: slightly flatter prosody; elevenlabs: fixed seed)'),
    },
  },
  wrap(async ({ target, text, vendor, voice, rate, volume, style, mode, assetPath, startInFrames, gainDb, sentenceTimings, sentenceGapSeconds, deterministic }) => {
    // Probe before touching the target: an unconfigured vendor should fail
    // without leaving a half-written asset behind. `probe: true` also walks a
    // configured preference chain to the first available vendor (v0.19) and
    // hands back the status it used, so nothing is probed twice.
    const resolved = await resolveSpeechVendor({ vendor, dataDir: store.dataDir, probe: true });
    const probe = resolved.status ?? await checkSpeechVendor(resolved.vendor, { dataDir: store.dataDir });
    if (!probe.available) throw await unavailableWithAlternatives(resolved.vendor, probe, { dataDir: store.dataDir });

    const t = await describeTarget(target);
    const assetsDir = path.join(t.path, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });

    const relPath = assetPath ?? (await nextAssetWav(assetsDir, 'narration'));
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(
        ErrorCodes.PATH_NOT_ALLOWED,
        `Narration must be written under assets/ (got "${relPath}")`,
        { path: relPath },
      );
    }
    // Reuse the sandbox's write guards (allow-list incl. .wav, traversal/symlink checks).
    const abs = resolveInTarget(t.path, normalized, { forWrite: true, asAsset: true });
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    // Hand the dispatcher the decision already made above rather than letting it
    // resolve again. Before preference chains that was merely wasted work
    // (resolution was deterministic); now resolution consults live availability,
    // so resolving twice could pick two different vendors — the probe that
    // guarded the write and the synthesis that follows it must agree.
    let result;
    let timings = null;
    let vendorReportedSeconds = null;
    const sentences = sentenceTimings ? splitSentences(text) : null;
    if (sentences && sentences.length > 1) {
      // Per-sentence synthesis + local concat: the only vendor-agnostic way to
      // get alignment data out of CLIs that cannot emit any (v0.19). Offsets
      // are exact because we place the clips ourselves; the trade-off is that
      // inter-sentence pacing is sentenceGapSeconds, not the vendor's own.
      // sentenceSilence: 0 zeroes Piper's own trailing pad per clip — without
      // it the gap STACKS on the vendor's pacing and the timings clip comes out
      // ~(N-1)×0.2s longer than the plain rendering of the same text.
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-timings-'));
      try {
        const clips = [];
        vendorReportedSeconds = 0;
        for (let i = 0; i < sentences.length; i++) {
          const clipPath = path.join(tmpDir, `sentence-${i}.wav`);
          result = await synthesizeWithVendor({
            vendor, text: sentences[i], outPath: clipPath, voice, rate, volume, style,
            sentenceSilence: 0, deterministic,
            dataDir: store.dataDir, resolved,
          });
          vendorReportedSeconds += result.durationSeconds ?? 0;
          clips.push(await fsp.readFile(clipPath));
        }
        // The vendor synthesized the sentences; the engine placed the gaps.
        vendorReportedSeconds += (sentences.length - 1) * sentenceGapSeconds;
        const joined = concatWavBuffers(clips, { gapSeconds: sentenceGapSeconds });
        await fsp.writeFile(abs, joined.buffer);
        timings = joined.segments.map((seg, i) => ({
          text: sentences[i],
          startSeconds: seg.startSeconds,
          startInFrames: Math.round(seg.startSeconds * t.fps),
          durationSeconds: seg.durationSeconds,
          durationInFrames: framesForDuration(seg.durationSeconds, t.fps),
        }));
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      result = await synthesizeWithVendor({
        vendor, text, outPath: abs, voice, rate, volume, style, deterministic,
        dataDir: store.dataDir, resolved,
      });
      vendorReportedSeconds = result.durationSeconds ?? null;
      if (sentences) {
        timings = null; // single sentence: filled in below once the duration is measured
      }
    }

    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new EngineError(
        ErrorCodes.TTS_FAILED,
        `Speech engine reported success but no audio was written to ${normalized}`,
        { path: normalized, vendor: resolved.vendor },
      );
    }

    const durationSeconds = await wavDurationSeconds(abs);
    const durationInFrames = framesForDuration(durationSeconds, t.fps);
    // Same level report music/sfx return, so narration can be balanced against
    // a bed without a render (v0.19). Nulls = unmeasurable, never an error.
    const levels = await measureWavLevels(abs).catch(() => ({ peakDb: null, meanDb: null }));
    if (sentences && !timings) {
      // Single sentence: the clip IS the sentence; report it in the same shape.
      timings = [{
        text: sentences[0], startSeconds: 0, startInFrames: 0,
        durationSeconds: Number(durationSeconds.toFixed(4)), durationInFrames,
      }];
    }

    let attached = false;
    let audio;
    let audioTrackIndex;
    if (mode === 'attach') {
      const track = { src: normalized };
      if (startInFrames !== undefined) track.startInFrames = startInFrames;
      if (gainDb !== undefined) track.gainDb = gainDb;
      const tracks = await t.getTracks();
      audioTrackIndex = tracks.length;
      audio = await t.setTracks([...tracks, track]);
      attached = true;
    }

    return ok({
      mode,
      target: localId(t.id),
      assetPath: normalized,
      vendor: result.vendor,
      vendorSource: result.vendorSource,
      ...(resolved.chain.length > 1 ? { vendorChain: resolved.chain } : {}),
      ...(await vendorNoteFor('speech', resolved)),
      voice: result.voice ?? voice ?? null,
      ...(result.style ? { style: result.style } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      durationSeconds,
      durationInFrames,
      fps: t.fps,
      sampleRate: result.sampleRate,
      channels: result.channels,
      bytes: stat.size,
      peakDb: levels.peakDb,
      meanDb: levels.meanDb,
      ...(timings ? { timings } : {}),
      // The vendor's own duration claim (summed + gaps in the per-sentence
      // path), vs the header-measured durationSeconds above. Before v0.20 this
      // leaked the LAST sentence's duration in the timings path.
      reportedDurationSeconds: vendorReportedSeconds != null
        ? Number(vendorReportedSeconds.toFixed(4))
        : result.durationSeconds,
      attached,
      ...(attached
        ? { audioTrackIndex, audio }
        : { hint: `Wire this in later with ${t.kind === 'scene' ? 'update_scene_config' : 'update_film'} { audio: [{ src: "${normalized}" }] }` }),
    });
  }),
);

server.registerTool(
  'list_voices',
  {
    title: 'List available TTS voices',
    description:
      'List the speech voices available from a vendor, for use as the "voice" argument to synthesize_speech. ' +
      'Omit "vendor" to query the configured default (see list_vendors). The system vendor returns the ' +
      'voices installed on this Windows machine; the azure vendor returns several hundred cloud neural voices, so ' +
      'filter with "locale" (e.g. "en-US") or "search" — results are capped at "limit" (default 50) and the ' +
      'response reports the true "total"; the piper vendor returns the voice files the user has downloaded ' +
      '(names like en_US-lessac-medium); the elevenlabs vendor returns the voices in the user\'s ElevenLabs ' +
      'library (pass the voice_id, or a display name that is unique); the openai and deepgram vendors have fixed ' +
      'catalogues (openai names like "marin", deepgram names like "aura-2-thalia-en"). ' +
      'Each voice carries any expressive "styles" it supports (azure only). ' +
      'Fails with tts_unavailable when the vendor is not configured.',
    inputSchema: {
      vendor: z.enum(TTS_VENDORS).optional().describe('Speech vendor; omit for the configured default'),
      locale: z.string().optional().describe('Filter by locale prefix, e.g. "en" or "en-GB" (azure)'),
      search: z.string().optional().describe('Filter by substring of the name / locale name / gender'),
      limit: z.number().int().min(1).max(500).default(50).describe('Max voices to return'),
      offset: z.number().int().min(0).default(0).describe('Skip this many matches (paging)'),
    },
  },
  wrap(async ({ vendor, locale, search, limit, offset }) => {
    const result = await listSpeechVoices({
      vendor, locale, search, limit, offset, dataDir: store.dataDir,
    });
    return ok({
      vendor: result.vendor,
      vendorSource: result.vendorSource,
      total: result.total,
      returned: result.voices.length,
      truncated: result.truncated,
      // Names alone for the system vendor (that is all it has); full metadata
      // for the others, where locale/gender/styles/quality are how you choose.
      voices: result.vendor === 'system'
        ? result.voices.map((v) => v.name)
        : result.voices.map((v) => ({
          name: v.name,
          locale: v.locale,
          ...(v.gender ? { gender: v.gender } : {}),
          ...(v.quality ? { quality: v.quality } : {}),
          ...(v.styles.length ? { styles: v.styles } : {}),
        })),
      ...(result.truncated ? { hint: 'Narrow the list with locale/search, or page with offset.' } : {}),
    });
  }),
);

server.registerTool(
  'list_vendors',
  {
    title: 'List generator vendors and their status',
    description:
      'Report what this machine can actually do, per capability: "speech" (narration — synthesize_speech / ' +
      'list_voices), "music" (synthesize_music) and "transcription" (transcribe_asset — READING speech out of ' +
      'supplied media, v0.22). For each vendor: whether it is available right now, whether it ' +
      'is the one that will be used when no vendor is named, and — if it is not available — exactly what the user ' +
      'must configure. Call this when a generator returns tts_unavailable / music_unavailable / ' +
      'transcription_unavailable, so you can tell the ' +
      'user which vendor to fix, or switch to one that is already working. ' +
      'The transcription capability also lists the ggml `models` installed and which one is `active`, so a call ' +
      'that wants better accuracy can name a bigger one. ' +
      'Each capability reports `chain` — the user\'s ordered vendor preference (v0.19) — with `preferred` as its ' +
      'head, `active` as the vendor that will ACTUALLY run (the first one in the chain that is available), and ' +
      '`fellBack: true` when those differ; each vendor carries its 1-based `priority` in the chain, or null when ' +
      'it is not in it. A chain of one is the common case and behaves exactly as a single configured vendor. ' +
      'The music capability\'s settings include `favoritePrograms` (v0.22) — General MIDI instruments the user ' +
      'starred in the Studio; prefer them when composing. The speech capability\'s settings likewise include ' +
      '`favoriteVoices` (vendor → starred voice names) — prefer them when narrating. Reports credential ' +
      '*sources* only; never a key itself.',
    inputSchema: {
      capability: z.enum(['speech', 'music', 'transcription']).optional().describe('Omit to report all three'),
      probe: z.boolean().default(true)
        .describe('false = report configuration only, skipping the exe spawn / network round-trip'),
    },
  },
  wrap(async ({ capability, probe }) => {
    const want = (c) => !capability || capability === c;
    const out = {};
    if (want('speech')) {
      const report = await speechVendorReport({ dataDir: store.dataDir, probe });
      out.speech = {
        active: report.active,
        activeSource: report.activeSource,
        // The preference chain and its head (v0.19). This description has always
        // promised them; until v0.20 the projection below quietly dropped them,
        // so an agent could not see that a fallback had happened — which is the
        // one thing chains are required to make visible (architecture.md §9.2).
        chain: report.chain,
        preferred: report.preferred,
        fellBack: report.fellBack,
        settings: report.settings,
        allVendors: TTS_VENDORS,
        vendors: report.vendors.map((v) => ({
          id: v.id,
          label: v.label,
          active: v.active,
          priority: v.priority ?? null,
          available: v.available,
          voiceCount: v.voiceCount,
          requires: v.requires,
          offline: v.offline,
          ...(v.error ? { error: v.error } : {}),
          ...(v.locales?.length ? { localeCount: v.locales.length } : {}),
        })),
      };
    }
    if (want('music')) {
      const report = await musicVendorReport({ dataDir: store.dataDir, probe });
      out.music = {
        active: report.active,
        activeSource: report.activeSource,
        chain: report.chain,
        preferred: report.preferred,
        fellBack: report.fellBack,
        settings: report.settings,
        allVendors: MUSIC_VENDORS,
        targetPeakDb: report.settings?.targetPeakDb ?? null,
        vendors: report.vendors.map((v) => ({
          id: v.id,
          label: v.label,
          active: v.active,
          priority: v.priority ?? null,
          available: v.available,
          requires: v.requires,
          offline: v.offline,
          ...(v.error ? { error: v.error } : {}),
          ...(v.config?.soundfont ? { soundfont: v.config.soundfont } : {}),
        })),
      };
    }
    if (want('transcription')) {
      const report = await transcriptionVendorReport({ dataDir: store.dataDir, probe });
      out.transcription = {
        active: report.active,
        activeSource: report.activeSource,
        chain: report.chain,
        preferred: report.preferred,
        fellBack: report.fellBack,
        settings: report.settings,
        allVendors: TRANSCRIPTION_VENDORS,
        vendors: report.vendors.map((v) => ({
          id: v.id,
          label: v.label,
          active: v.active,
          priority: v.priority ?? null,
          available: v.available,
          requires: v.requires,
          offline: v.offline,
          ...(v.error ? { error: v.error } : {}),
          // Which model will run, and what else is installed — the one thing a
          // transcribing agent may legitimately want to override per call.
          ...(v.config?.activeModel ? { activeModel: v.config.activeModel } : {}),
          ...(v.modelCount != null ? { modelCount: v.modelCount } : {}),
          ...(v.models?.length
            ? { models: v.models.map((m) => ({ name: m.name, bytes: m.bytes, englishOnly: m.englishOnly })) }
            : {}),
        })),
      };
    }
    return ok(out);
  }),
);

server.registerTool(
  'synthesize_music',
  {
    title: 'Generate music (note spec → SoundFont)',
    description:
      'Compose a short piece of music from a note spec YOU author, and add it as an audio track. Target a SCENE ' +
      'for scene-local music, or a FILM ("<film>") to write the score into the film\'s master timeline — the ' +
      'normal choice for long-form (tile a short theme across the film at stepped startInFrames). ' +
      'The spec becomes MIDI and is rendered against a General MIDI SoundFont. Two vendors (v0.17): "node" ' +
      '(default — renders in-process, works on any OS, nothing to install beyond a SoundFont) and "fluidsynth" ' +
      '(the Windows exe chain). Omit `vendor` to use the machine\'s configured default — check it with ' +
      'list_vendors; an unconfigured vendor fails with music_unavailable (see docs/music-setup.md). ' +
      'mode="attach" (default) writes assets/music-<n>.wav AND appends the audio track so the next render/build ' +
      'mixes it; mode="asset-only" writes + reports only. Returns durationSeconds/durationInFrames (the WAV, ' +
      'which includes a reverb tail) and musicalDurationSeconds (the note content). Use durationInFrames to size ' +
      'the video, and startInFrames/gainDb to place and balance the bed against narration. ' +
      'Spec: bpm, plus tracks of notes. program = General MIDI instrument 0..127 (0 piano, 24 nylon guitar, 32 acoustic ' +
      'bass, 40 violin, 48 strings, 56 trumpet, 73 flute…). The user may have STARRED favorite instruments in the ' +
      'Studio: check `favoritePrograms` in list_vendors\' music settings and prefer those programs when the brief ' +
      'doesn\'t name instruments — they are sounds the user auditioned and chose. drums:true routes the track to GM percussion. ' +
      'Each note: pitch 0..127 (60 = middle C), start & duration in beats (quarter notes), velocity 1..127. ' +
      'OR (v0.20) skip note-writing: pass a chord progression + style and the server compiles the notes — e.g. ' +
      "spec: { bpm: 96, progression: ['D','A','Bm','G'], style: 'pad-ballad', bars: 8 }. Chords are letters " +
      '(C, F#m, Bb7, Dmaj7, Esus4, C/E) or roman numerals (I, vi, V7, bVII) with `key`; styles: ' +
      `${THEORY_STYLE_NAMES.join(', ')}. Optional bars (progression cycles one chord per bar; +1 held closing bar), ` +
      'beatsPerBar (4), layers (subset of the style\'s named layers), seed (deterministic variation). The compiled ' +
      'take is voice-led with mix headroom built in, and the response adds compiled: {style, bars, chords, notes}. ' +
      'Exactly one of tracks | progression.',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
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
        })).min(1).optional().describe('Note form: the piece written out note by note'),
        progression: z.array(z.string()).min(1).optional()
          .describe("Compiled form (v0.20): chord symbols — letters ('D', 'Bm7', 'C/E') or roman numerals ('I', 'vi') with key"),
        style: z.enum(THEORY_STYLE_NAMES).optional()
          .describe('Compiled form: arrangement style (default "pad")'),
        bars: z.number().int().min(1).max(128).optional()
          .describe('Compiled form: bars to fill, cycling the progression (default: one bar per chord, once through)'),
        beatsPerBar: z.number().int().min(2).max(12).optional().describe('Compiled form: beats per bar (default 4)'),
        key: z.string().optional()
          .describe("Compiled form: key for roman numerals and the closing tonic, e.g. 'D' or 'F#m'"),
        layers: z.array(z.string()).min(1).optional()
          .describe("Compiled form: subset of the style's layers to render (e.g. ['pad','bass'])"),
        seed: z.number().int().optional().describe('Compiled form: deterministic-variation seed (default 1)'),
      }).refine((s) => (s.tracks === undefined) !== (s.progression === undefined), {
        message: 'spec takes exactly one of `tracks` (note form) or `progression` (compiled form)',
      }).describe('The piece to compose — written-out notes, or a progression + style to compile'),
      vendor: z.enum(MUSIC_VENDORS).optional()
        .describe('Music vendor; omit to use the configured default (see list_vendors)'),
      mode: z.enum(['attach', 'asset-only']).default('attach'),
      assetPath: z.string().optional().describe('Relative .wav under assets/ (default assets/music-<n>.wav)'),
      startInFrames: z.number().int().min(0).optional().describe('attach mode: track start offset in frames'),
      gainDb: z.number().optional().describe('attach mode: track gain in dB (e.g. -8 for a background bed)'),
      duck: z.boolean().optional().describe('attach mode: auto-duck this bed under the non-ducked tracks (see update_scene_config)'),
    },
  },
  wrap(async ({ target, spec, vendor, mode, assetPath, startInFrames, gainDb, duck }) => {
    // Progression form (v0.20): compile chords + style down to the note spec
    // first — it is pure and touches nothing, so a bad chord or style fails
    // before any vendor probe, identically whichever vendor would render it.
    let compiled = null;
    if (spec.progression !== undefined) {
      const theory = compileTheorySpec(spec);
      compiled = { style: theory.meta.style, bars: theory.meta.bars, chords: theory.meta.chords, notes: theory.meta.notes };
      spec = { bpm: theory.bpm, tracks: theory.tracks };
    }
    // Resolve + probe before touching the target, so an unconfigured vendor
    // fails without leaving a half-written asset behind. `probe: true` also
    // walks a configured preference chain to the first available vendor (v0.19).
    const resolved = await resolveMusicVendor({ vendor, dataDir: store.dataDir, probe: true });
    const probe = resolved.status ?? await checkMusicVendor(resolved.vendor, { dataDir: store.dataDir });
    if (!probe.available) throw await musicUnavailableWithAlternatives(resolved.vendor, probe, { dataDir: store.dataDir });
    const t = await describeTarget(target);
    const assetsDir = path.join(t.path, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });

    const relPath = assetPath ?? (await nextAssetWav(assetsDir, 'music'));
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Music must be written under assets/ (got "${relPath}")`, { path: relPath });
    }
    const abs = resolveInTarget(t.path, normalized, { forWrite: true, asAsset: true });
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    // As with speech: hand the dispatcher the resolution already made, so the
    // vendor that was probed is the vendor that renders (see synthesize_speech).
    const result = await synthesizeMusicWithVendor({
      vendor, spec, outPath: abs, dataDir: store.dataDir, resolved,
    });

    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new EngineError(ErrorCodes.MUSIC_FAILED, `Rendered no audio to ${normalized}`, { path: normalized, vendor: resolved.vendor });
    }
    const durationSeconds = await wavDurationSeconds(abs);
    const durationInFrames = framesForDuration(durationSeconds, t.fps);

    let attached = false, audio, audioTrackIndex;
    if (mode === 'attach') {
      const track = { src: normalized };
      if (startInFrames !== undefined) track.startInFrames = startInFrames;
      if (gainDb !== undefined) track.gainDb = gainDb;
      if (duck !== undefined) track.duck = duck;
      const tracks = await t.getTracks();
      audioTrackIndex = tracks.length;
      audio = await t.setTracks([...tracks, track]);
      attached = true;
    }

    return ok({
      mode,
      target: localId(t.id),
      assetPath: normalized,
      vendor: result.vendor,
      vendorSource: result.vendorSource,
      ...(resolved.chain.length > 1 ? { vendorChain: resolved.chain } : {}),
      ...(await vendorNoteFor('music', resolved)),
      ...(compiled ? { compiled } : {}),
      bpm: result.bpm,
      tracks: result.tracks,
      notes: result.notes,
      musicalDurationSeconds: result.musicalDurationSeconds,
      durationSeconds,
      durationInFrames,
      fps: t.fps,
      bytes: stat.size,
      // The measured peak of what was actually written — you cannot hear it,
      // and this is how you know whether the bed will fight the narration.
      peakDb: result.peakDb,
      ...(result.gainAppliedDb ? { attenuatedDb: result.gainAppliedDb, targetPeakDb: result.targetPeakDb } : {}),
      attached,
      ...(attached
        ? { audioTrackIndex, audio }
        : { hint: `Wire this in later with ${t.kind === 'scene' ? 'update_scene_config' : 'update_film'} { audio: [{ src: "${normalized}" }] }` }),
    });
  }),
);

server.registerTool(
  'synthesize_sfx',
  {
    title: 'Generate sound effects (pure JS, no toolchain)',
    description:
      'Render a list of sound-effect CUES into one mono WAV and add it as an audio track (new in v0.12). ' +
      'Target a SCENE, or a FILM to lay the cue bed over the whole film\'s master timeline — "a chime on every ' +
      'scene cut" is a plain map over the scene filmOffsets from get_film\'s plan. ' +
      'Use this for the noises a film needs that speech and music cannot make: a whoosh on a cut, a chime between ' +
      'scenes, a thud when something heavy lands, a slow shimmer under a reveal. Unlike synthesize_music there is ' +
      'NOTHING to install — it is pure JS, works on every OS, and never returns an "unavailable" error. ' +
      'One call makes the whole bed: you get a single track holding every cue at its absolute time. ' +
      'TIME IS IN FRAMES: `atFrame` matches startInFrames and a scene\'s filmOffset. ' +
      '`at` (seconds) is accepted instead; set exactly one. ' +
      '`gain` is the cue\'s PEAK AMPLITUDE 0..1 (not dB) and means the same thing for every type. ' +
      'Levels: by default (`normalize:"ceiling"`) a quiet bed is left quiet and only a mix hotter than `ceilingDb` is ' +
      'pulled down — so the returned `peakDb` is the real level and your `gainDb` at mix time stays meaningful. ' +
      `Types: ${SFX_TYPES.join(', ')}. Pitched cues take pitch (MIDI, like synthesize_music) or hz, not both. ` +
      `Limits: ${MAX_CUES} cues, ${MAX_CUE_SECONDS}s per cue. sampleRate ∈ ${ALLOWED_SAMPLE_RATES.join('/')} — ` +
      'prefer 22050 for a long bed (a 10-minute 44.1k bed is ~53 MB). ' +
      'mode="attach" (default) writes assets/sfx-<n>.wav AND appends the track; "asset-only" writes + reports only. ' +
      'See docs/sfx-setup.md.',
    inputSchema: {
      target: z.string().describe('Scene id "<film>/<scene>" or film id "<film>"'),
      spec: z.object({
        durationInFrames: z.number().int().min(1).optional()
          .describe('Bed length (default: the scene duration, or the whole film length for a film target)'),
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
      assetPath: z.string().optional().describe('Relative .wav under assets/ (default assets/sfx-<n>.wav)'),
      startInFrames: z.number().int().min(0).optional().describe('attach mode: track start offset in frames'),
      gainDb: z.number().optional().describe('attach mode: track gain in dB (e.g. -12 to tuck the bed under narration)'),
    },
  },
  wrap(async ({ target, spec, mode, assetPath, startInFrames, gainDb }) => {
    const t = await describeTarget(target);
    if (!spec.durationInFrames && !t.durationInFrames) {
      throw new EngineError(ErrorCodes.INVALID_SFX_SPEC,
        'The film has no scenes yet, so the bed length cannot default to the film length — pass spec.durationInFrames or add scenes first.',
        { target });
    }
    const assetsDir = path.join(t.path, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });

    const relPath = assetPath ?? (await nextAssetWav(assetsDir, 'sfx'));
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `SFX must be written under assets/ (got "${relPath}")`, { path: relPath });
    }
    const abs = resolveInTarget(t.path, normalized, { forWrite: true, asAsset: true });
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    // fps and the default length come from the target, so a bed spans the
    // composition (or the film) without the caller restating what the engine
    // already knows.
    const result = await synthesizeSfx({
      spec: {
        ...spec,
        fps: t.fps,
        durationInFrames: spec.durationInFrames ?? t.durationInFrames,
      },
      outPath: abs,
    });

    let attached = false, audio, audioTrackIndex;
    if (mode === 'attach') {
      const track = { src: normalized };
      if (startInFrames !== undefined) track.startInFrames = startInFrames;
      if (gainDb !== undefined) track.gainDb = gainDb;
      const tracks = await t.getTracks();
      audioTrackIndex = tracks.length;
      audio = await t.setTracks([...tracks, track]);
      attached = true;
    }

    return ok({
      mode,
      target: localId(t.id),
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
      fps: t.fps,
      bytes: result.bytes,
      attached,
      ...(attached
        ? { audioTrackIndex, audio }
        : { hint: `Wire this in later with ${t.kind === 'scene' ? 'update_scene_config' : 'update_film'} { audio: [{ src: "${normalized}" }] }` }),
    });
  }),
);

server.registerTool(
  'add_library',
  {
    title: 'Add a 3D library (Three.js / Babylon.js)',
    description:
      'Vendor an optional 3D rendering library into the scene — copied locally so renders stay hermetic ' +
      '(no CDN at render time) — and scaffold a frame-driven starter composition. ' +
      'library="three" (Three.js, ~600 KB, lightweight) or "babylon" (Babylon.js, ~8 MB, built-in ' +
      'glow/bloom/postprocessing). scaffold=true (default) replaces composition.html/js/css with the library ' +
      'starter; set false to only vendor the library and keep your composition. ' +
      'The result includes determinism notes you MUST follow: drive all animation from the injected frame — ' +
      'no requestAnimationFrame, no THREE.Clock / Babylon render loop / particle systems (all wall-clock based) — ' +
      'and compile shaders before the first frame (the starters warm up materials, else single-frame captures render blank). ' +
      'addons (v0.19): three supports "geometries" (THREE.TeapotGeometry), "loaders" (THREE.GLTFLoader), and ' +
      '"postprocessing" (EffectComposer / RenderPass / UnrealBloomPass / ShaderPass); babylon supports "loaders" ' +
      '(glTF/GLB import via SceneLoader). Loading a model file with either loader also needs env ' +
      'MOTION_STUDIO_ALLOW_LOCAL_FETCH=1. ' +
      'Requires the vendored build (run scripts/fetch-libs.mjs once); otherwise fails with library_unavailable.',
    inputSchema: {
      scene: z.string(),
      library: z.enum(['three', 'babylon']),
      scaffold: z.boolean().default(true).describe('Replace composition.html/js/css with the library starter'),
      addons: z.array(z.enum(ADDON_IDS)).optional()
        .describe('Optional addons — three: geometries/loaders/postprocessing; babylon: loaders'),
    },
  },
  wrap(async ({ scene, library, scaffold, addons }) => ok(await store.addLibrary(qualifyScene(scene), { library, scaffold, addons }))),
);

/* ------------------------------------------------------------------ */
/* The production loop (v0.23): advice, revisions, deliveries, status  */
/*                                                                     */
/* Motion Studio's working model is AI-directed, human-advised: this   */
/* agent plans and produces the film unattended, and the human watches */
/* in the Studio and leaves plain-language advice on what they see.    */
/* Advice never blocks production — there is NO approval gate and no   */
/* waiting loop. The contract these tools implement:                   */
/*                                                                     */
/*   check_human_advice at your checkpoints: task start, after         */
/*   publishing a plan, before expensive generation, after each scene  */
/*   revision, before build_film, before reporting completion.         */
/*   Acknowledge what you received, lease what you work on, and        */
/*   resolve every item with an outcome — including "not-applied with  */
/*   a reason". Never silently ignore advice; never wait for it.       */
/* ------------------------------------------------------------------ */

/** Resolve a film's document + path for the advice/status tools. */
async function filmForAdvice(film) {
  return store.getFilm(qualifyFilm(film));
}

/** Advice listing entry in workspace-local vocabulary. */
function localAdvice(a, filmDoc) {
  return {
    adviceId: a.id,
    film: filmDoc.slug,
    status: a.status,
    from: a.from,
    message: a.message,
    target: a.target,
    observation: a.observation,
    suggestedAction: a.suggestedAction,
    ...(a.preferredRevisionId ? { preferredRevisionId: a.preferredRevisionId } : {}),
    ...(a.followUpOf ? { followUpOf: a.followUpOf } : {}),
    ...(a.lease ? { lease: a.lease } : {}),
    ...(a.clarification ? { clarification: a.clarification } : {}),
    ...(a.resolution ? { resolution: a.resolution } : {}),
    createdAt: a.createdAt,
  };
}

/**
 * Best-effort "after" evidence for a resolved advice: the same scene frame
 * the human flagged, extracted from the scene's CURRENT output. Failure is
 * recorded on the advice and never fails the resolution.
 */
async function captureAfterEvidence(filmDoc, adviceId) {
  try {
    const full = await getAdvice({ filmPath: filmDoc.path, adviceId });
    const slug = full.request.target?.scene;
    if (!slug) return; // film/sequence/track advice has no single after-frame
    const sceneId = `${filmDoc.id}/${slug}`;
    const scene = await store.getScene(sceneId);
    const config = await store.readConfig(sceneId);
    const outPath = path.join(scene.path, config.output?.dir ?? 'out', config.output?.filename ?? 'output.mp4');
    const st = await fsp.stat(outPath).catch(() => null);
    if (!st?.isFile()) throw new Error('scene has no rendered output');
    const frame = Math.min(
      full.request.target?.sceneFrame ?? Math.floor(config.durationInFrames / 2),
      Math.max(0, config.durationInFrames - 1),
    );
    const png = await extractRenderedFrame({
      filePath: outPath, frame, fps: config.fps, ffmpegPath: await ffmpegPathOnly(),
    });
    await writeAdviceEvidence({
      filmPath: filmDoc.path, adviceId, which: 'after',
      png,
      meta: {
        scene: slug, sceneFrame: frame,
        revisionId: await currentRevisionId(scene.path).catch(() => null),
      },
    });
  } catch (err) {
    await recordEvidenceFailure({
      filmPath: filmDoc.path, adviceId, which: 'after', reason: err?.message ?? String(err),
    }).catch(() => {});
  }
}

server.registerTool(
  'get_capabilities',
  {
    title: 'What this Motion Studio can do',
    description:
      'One call that tells a director what it is working with: engine version, agent/workspace identity, ' +
      'supported output formats, scene/footage/sequence model, configured speech/music/transcription vendors ' +
      '(names only — no probing, no secrets), media limits, and which production-loop features (advice, ' +
      'revisions, deliveries, activity) are live. Call this once at task start, then check_human_advice.',
    inputSchema: {},
  },
  wrap(async () => {
    const settings = await readSettings(store.dataDir).catch(() => structuredClone(DEFAULT_SETTINGS));
    return ok({
      engine: enginePkg.version,
      workspace: WORKSPACE,
      agent: AGENT,
      model: {
        hierarchy: 'workspace → film → scene',
        atomicRenderUnit: 'scene — one composition folder, rendered and revised independently',
        narrativeGrouping: 'sequence — a label on film segments (film.scenes[i].sequence) plus optional film.sequences metadata; groups scenes for human navigation and advice, renders nothing',
        segments: 'a film plays scenes ({slug}) and footage ({id, footage, durationInFrames}) in one ordered list; a scene is addressed by slug, a footage clip by its stable id',
        adviceTargets: 'film, sequence, scene, footage, audio, caption, overlay — the human clicks, Studio fills the ids',
      },
      formats: ['mp4', 'webm', 'gif', 'prores', 'png-sequence'],
      vendors: {
        speech: { configured: settings?.tts?.vendor ?? 'system', available: TTS_VENDORS },
        music: { configured: settings?.music?.vendor ?? 'node', available: MUSIC_VENDORS },
        transcription: { configured: settings?.transcription?.vendor ?? 'whisper-cpp', available: TRANSCRIPTION_VENDORS },
      },
      // Capability tiers (Slice 0): core / free-local / pack / byok, with the
      // per-OS fix command when a capability is not ready. Existence-level
      // checks only — the deep probes stay behind list_vendors.
      tiers: capabilityTiers
        ? await capabilityTiers().catch((e) => ({ error: e.message }))
        : { error: 'capability tiers unavailable: the default vendor package is not installed (core-only install)' },
      // Fetchable packs (Slice B): what `npm run fetch-pack -- <id>` can
      // install and what is already present. The CLI module tolerates a
      // missing vendor tree itself, so this needs no separate guard.
      packs: await import('../cli/fetch-pack.js')
        .then(async ({ listPacks }) => {
          const list = await listPacks();
          if (!list.ok) return { error: list.message };
          return {
            fetchCommand: 'npm run fetch-pack -- <id>   (from engine/)',
            root: list.root,
            packs: list.packs.map((p) => ({ id: p.id, installed: p.installed, enables: p.enables })),
          };
        })
        .catch((e) => ({ error: e.message })),
      productionLoop: {
        advice: 'check_human_advice / acknowledge_human_advice / begin_advice_work / resolve_human_advice / list_human_advice',
        revisions: 'every promoted full-scene render is archived immutably; list_scene_revisions / use_scene_revision',
        deliveries: 'every build_film is archived with a frozen manifest; the Studio pins review to one delivery',
        activity: 'report_agent_activity keeps the human\'s progress line honest; heartbeats expire after 180s',
        checkpoints: [
          'task start', 'after publishing the plan', 'before expensive generation',
          'after each scene revision', 'before build_film', 'before reporting completion',
        ],
        approvalGate: 'none — never wait for a human response; unresolved advice is handled at the next checkpoint',
      },
      limits: {
        maxAssetBytes: 25 * 1024 * 1024,
        maxAdviceMessageChars: 4000,
        renderQueue: 'one at a time, FIFO, bounded at 10',
      },
    });
  }),
);

server.registerTool(
  'check_human_advice',
  {
    title: 'Check for human advice (non-blocking)',
    description:
      'Unresolved human advice, oldest first — the reconciliation read. Call at your checkpoints (task start, ' +
      'after planning, before expensive generation, after each scene revision, before build_film, before ' +
      'reporting done). Read-only: it marks nothing and hides nothing, including items another agent ' +
      'acknowledged and then abandoned (their lease expires and the advice becomes actionable again). ' +
      'Each item carries the human\'s wording, the structural target (film / sequence / scene / footage / ' +
      'audio / caption / overlay + frames), and the exact delivery/revision they were looking at — compare that ' +
      'observation with current state before acting, and prefer-revision items name the exact revision the ' +
      'human wants reconsidered. No advice = continue immediately. NEVER poll this in a wait loop.',
    inputSchema: {
      film: z.string().optional().describe('Limit to one film; omit to sweep every film in this workspace'),
      limit: z.number().int().min(1).max(100).optional().describe('Cap the result (default 25)'),
    },
  },
  wrap(async ({ film, limit }) => {
    const films = film
      ? [await filmForAdvice(film)]
      : await Promise.all((await store.listFilms(WORKSPACE))
        .filter((f) => !f.broken)
        .map((f) => store.getFilm(f.id)));
    const out = [];
    for (const doc of films) {
      const items = await listAdvice({ filmPath: doc.path, status: 'unresolved' });
      out.push(...items.map((a) => localAdvice(a, doc)));
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const capped = out.slice(0, limit ?? 25);
    return ok({
      unresolved: out.length,
      returned: capped.length,
      advice: capped,
      ...(out.length === 0 ? { note: 'No unresolved advice — continue immediately; do not wait or poll.' } : {}),
    });
  }),
);

server.registerTool(
  'acknowledge_human_advice',
  {
    title: 'Acknowledge advice receipt',
    description:
      'Record that this agent has SEEN an advice item. The human\'s Studio then shows "AI received it" instead ' +
      'of a silent void. Acknowledging does not commit you to applying it and does not hide it from other ' +
      'agents — take a lease with begin_advice_work before actually working on it. Idempotent.',
    inputSchema: {
      film: z.string().describe('The film the advice belongs to'),
      adviceId: z.string(),
    },
  },
  wrap(async ({ film, adviceId }) => {
    const doc = await filmForAdvice(film);
    return ok(await acknowledgeAdvice({ filmPath: doc.path, adviceId, agent: AGENT }));
  }),
);

server.registerTool(
  'begin_advice_work',
  {
    title: 'Lease an advice item for work',
    description:
      'Take a renewable TTL lease on one advice item so two agents cannot process it concurrently. Fails with ' +
      'advice_lease_held (naming the holder and expiry) while another agent\'s lease is live; an expired lease ' +
      'is taken over silently — that is the crash recovery. Renew by calling again. The human sees ' +
      '"AI is working on it".',
    inputSchema: {
      film: z.string(),
      adviceId: z.string(),
      ttlSeconds: z.number().int().min(30).max(86400).optional()
        .describe('Lease length (default 900). Renew before it expires for long work.'),
    },
  },
  wrap(async ({ film, adviceId, ttlSeconds }) => {
    const doc = await filmForAdvice(film);
    return ok(await beginAdviceWork({ filmPath: doc.path, adviceId, agent: AGENT, ttlSeconds }));
  }),
);

server.registerTool(
  'resolve_human_advice',
  {
    title: 'Resolve advice with an outcome',
    description:
      'Record what happened to an advice item. Outcomes: "applied", "partially-applied", "not-applied" (you ' +
      'considered it and chose otherwise — say why), "superseded" (a later change made it moot), or ' +
      '"needs-clarification" (NOT terminal: the explanation is your question, the human answers with linked ' +
      'follow-up advice, and the item stays open). Link every revision you created or selected via ' +
      '`revisionIds` and the resulting build via `deliveryId` — that linkage is the human\'s ' +
      '"what the AI changed" evidence, and an after-frame is captured automatically for scene targets. ' +
      'One revision may resolve several compatible items: resolve each, listing the others in ' +
      '`combinedAdviceIds`. Terminal resolutions are immutable; retry safely with the same requestId.',
    inputSchema: {
      film: z.string(),
      adviceId: z.string(),
      outcome: z.enum(ADVICE_OUTCOMES),
      explanation: z.string().min(1).max(2000)
        .describe('One or two sentences the human will read — what you did, or why you did not'),
      revisionIds: z.array(z.string()).max(20).optional()
        .describe('Scene revision ids this resolution produced or selected'),
      deliveryId: z.string().optional().describe('The film delivery that includes the change'),
      combinedAdviceIds: z.array(z.string()).max(20).optional()
        .describe('Other advice ids answered by the same change'),
      requestId: z.string().max(120).optional().describe('Idempotency key for safe retries'),
    },
  },
  wrap(async ({ film, adviceId, outcome, explanation, revisionIds, deliveryId, combinedAdviceIds, requestId }) => {
    const doc = await filmForAdvice(film);
    const result = await resolveAdvice({
      filmPath: doc.path, adviceId, agent: AGENT, outcome, explanation,
      revisionIds: revisionIds ?? [], deliveryId: deliveryId ?? null,
      combinedAdviceIds: combinedAdviceIds ?? [], requestId: requestId ?? null,
    });
    if (result.status === 'resolved' && !result.deduplicated) {
      // After-evidence rides behind the durable resolution, like all evidence.
      await captureAfterEvidence(doc, adviceId);
    }
    return ok(result);
  }),
);

server.registerTool(
  'list_human_advice',
  {
    title: 'List advice history',
    description:
      'A film\'s advice at any scope — unresolved, resolved, or all; optionally filtered to one scene, ' +
      'sequence, or timeline item. History order (newest first) unless status is "unresolved". Use it to ' +
      'review past direction before reworking an area the human has already commented on.',
    inputSchema: {
      film: z.string(),
      status: z.enum(['unresolved', 'resolved', 'all']).optional(),
      scene: z.string().optional().describe('Filter: advice targeting this scene slug'),
      sequence: z.string().optional().describe('Filter: advice targeting this sequence'),
      itemId: z.string().optional().describe('Filter: advice targeting this footage/audio/caption/overlay item id'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  wrap(async ({ film, status, scene, sequence, itemId, limit }) => {
    const doc = await filmForAdvice(film);
    const target = (scene || sequence || itemId)
      ? { ...(scene ? { scene } : {}), ...(sequence ? { sequence } : {}), ...(itemId ? { itemId } : {}) }
      : null;
    const items = await listAdvice({ filmPath: doc.path, status: status ?? 'all', target, limit: limit ?? 50 });
    return ok({ film: doc.slug, count: items.length, advice: items.map((a) => localAdvice(a, doc)) });
  }),
);

server.registerTool(
  'list_scene_revisions',
  {
    title: 'List a scene\'s archived revisions',
    description:
      'Every archived revision of one scene, newest first: id, creation time, creating agent, frame count, ' +
      'note, linked advice, and which one is current. Every promoted full-scene render archives one ' +
      'automatically (output + source snapshot + review evidence). Previewing an old revision changes ' +
      'nothing; switch with use_scene_revision.',
    inputSchema: { scene: z.string() },
  },
  wrap(async ({ scene }) => {
    const s = await store.getScene(qualifyScene(scene));
    const revisions = await listRevisions(s.path);
    return ok({
      scene: localId(s.id),
      count: revisions.length,
      currentRevisionId: revisions.find((r) => r.current)?.id ?? null,
      revisions: revisions.map(({ path: _p, renderMeta: _m, ...r }) => r),
    });
  }),
);

server.registerTool(
  'use_scene_revision',
  {
    title: 'Make an archived revision current',
    description:
      'Repoint a scene\'s live output at an archived revision — the normal answer to prefer-revision advice. ' +
      'Copies the archived bytes back to the canonical output (staged + atomic rename), re-stamps the render ' +
      'sidecar, and moves the current pointer. Never regenerates media and never deletes newer history; the ' +
      'newer revision stays in the list. Fails with revision_mismatch if the scene\'s settings changed since ' +
      'that revision was rendered. Afterwards run build_film so the film picks it up, and resolve the advice ' +
      'linking this revisionId.',
    inputSchema: {
      scene: z.string(),
      revisionId: z.string(),
    },
  },
  wrap(async ({ scene, revisionId }) => {
    const s = await store.getScene(qualifyScene(scene));
    const config = await store.readConfig(s.id);
    const result = await useRevision({ scenePath: s.path, config, revisionId, agent: AGENT });
    return ok({
      scene: localId(s.id),
      ...result,
      note: 'The scene\'s live output now holds this revision. Run build_film to update the film, then resolve the advice with this revisionId.',
    });
  }),
);

server.registerTool(
  'list_deliveries',
  {
    title: 'List archived film deliveries',
    description:
      'Every archived build of a film, newest first, with the current (review-pinned) one flagged. Each ' +
      'delivery is immutable and its manifest froze the exact scene revisions, tracks, captions, and overlays ' +
      'that produced it — which is what human advice observations reference. build_film archives one ' +
      'automatically; its job status carries the new deliveryId.',
    inputSchema: {
      film: z.string(),
      manifest: z.string().optional().describe('Return one delivery\'s full frozen manifest instead of the listing'),
    },
  },
  wrap(async ({ film, manifest }) => {
    const doc = await filmForAdvice(film);
    if (manifest) {
      const m = await getDeliveryManifest(doc.path, manifest);
      const { path: _p, ...body } = m;
      return ok(body);
    }
    return ok({
      film: doc.slug,
      currentDeliveryId: await currentDeliveryId(doc.path),
      deliveries: await listDeliveries(doc.path),
    });
  }),
);

server.registerTool(
  'report_agent_activity',
  {
    title: 'Report what you are doing',
    description:
      'A heartbeat for the human\'s progress line: one short present-tense phrase ("Creating scene demo-shot", ' +
      '"Revising opening narration", "Building film"). Cheap and overwrite-in-place — call it when your ' +
      'activity changes and every minute or two during long work. Heartbeats expire after ~3 minutes, after ' +
      'which the Studio shows "Waiting for the next AI run"; a stale heartbeat never blocks anything.',
    inputSchema: {
      activity: z.string().min(1).max(120),
      film: z.string().optional().describe('The film this work is for'),
      scene: z.string().optional().describe('The scene this work is on ("<film>/<scene>")'),
      detail: z.string().max(300).optional(),
    },
  },
  wrap(async ({ activity, film, scene, detail }) => {
    const workspacePath = store.workspacePath(WORKSPACE);
    const body = await reportActivity({
      workspacePath,
      agent: AGENT,
      activity,
      filmId: film ? qualifyFilm(film) : null,
      sceneId: scene ? qualifyScene(scene) : null,
      detail,
    });
    return ok(body);
  }),
);

server.registerTool(
  'get_production_status',
  {
    title: 'Production status snapshot',
    description:
      'One film\'s production facts: segment readiness (rendered / stale / missing / problems), unresolved ' +
      'advice counts, archived deliveries, the current review-pinned delivery, whether promoted work is newer ' +
      'than that delivery (build_film would publish it), and live agent activity. The same projection the ' +
      'Studio header renders. Use it to decide "is there anything left to do" before reporting completion. ' +
      'COMPACT BY DEFAULT (detail "summary"); "scenes" adds one compact row per segment; "full" is the ' +
      'complete legacy shape. Pass the returned `cursor` back as `since` on the next call: unchanged state ' +
      'answers with a tiny heartbeat, changed state includes a `delta` naming exactly the changed segments.',
    inputSchema: {
      film: z.string(),
      detail: z.enum(['summary', 'scenes', 'full']).optional()
        .describe('summary (default): readiness/advice/delivery facts. scenes: + one compact row per segment. full: the complete legacy shape.'),
      since: z.string().optional()
        .describe('The cursor from a previous call. Unchanged → heartbeat; changed → delta of changed segments; unparseable → cursorReset: true + full projection.'),
    },
  },
  wrap(async ({ film, detail = 'summary', since }) => {
    const doc = await filmForAdvice(film);
    const plan = await planFilm({ film: doc, store });
    const status = await productionStatus({ store, film: doc, plan });
    const rows = segmentRows(plan, localId);
    const activity = status.activity.map(({ filmId, sceneId, ...a }) => ({
      ...a,
      ...(filmId ? { film: localId(filmId) } : {}),
      ...(sceneId ? { scene: localId(sceneId) } : {}),
    }));
    // Everything summary-visible except rows, timestamps, and live-activity
    // heartbeats — those churn every call and would make "unchanged"
    // unreachable (see core/projections.js).
    const marks = {
      revision: doc.revision,
      name: status.name,
      totalFrames: status.totalFrames,
      fps: status.fps,
      durationSeconds: status.durationSeconds,
      advice: status.advice,
      deliveries: status.deliveries,
      currentDeliveryId: status.currentDelivery?.id ?? null,
      newerWorkThanDelivery: status.newerWorkThanDelivery,
      problems: plan.problems,
    };
    const cursor = computeCursor({ film: doc.slug, rows, marks });

    const parsed = since !== undefined ? parseCursor(since) : undefined;
    if (parsed && parsed.film === doc.slug && parsed.o === parseCursor(cursor).o) {
      return ok({
        film: doc.slug, unchanged: true, cursor,
        activityAt: activity.reduce((latest, a) => (a.at > latest ? a.at : latest), '') || null,
        generatedAt: status.generatedAt,
      });
    }

    const summary = {
      film: doc.slug,
      name: status.name,
      revision: doc.revision,
      totalFrames: status.totalFrames,
      fps: status.fps,
      durationSeconds: status.durationSeconds,
      readiness: status.readiness,
      problems: plan.problems, // complete, always — compactness never hides failure
      advice: status.advice,
      deliveries: status.deliveries,
      currentDelivery: status.currentDelivery,
      newerWorkThanDelivery: status.newerWorkThanDelivery,
      activity,
      generatedAt: status.generatedAt,
      cursor,
    };
    // A stale-but-parseable cursor for this film earns a delta naming
    // exactly the changed segments; garbage earns cursorReset, never an error.
    const delta = parsed && parsed.film === doc.slug ? diffRows(parsed, rows) : undefined;
    const reset = since !== undefined && !delta ? { cursorReset: true } : {};

    if (detail === 'full') {
      return ok({
        ...status, filmId: undefined, film: doc.slug,
        activity, cursor, ...(delta ? { delta } : {}), ...reset,
      });
    }
    return ok({
      ...summary,
      ...(detail === 'scenes' ? { scenes: rows } : {}),
      ...(delta ? { delta } : {}),
      ...reset,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

server.registerResource(
  'frame-api-reference',
  'motion-studio://reference/frame-api',
  {
    title: 'Motion Studio Frame API v1.3',
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
  'workspace-manifest',
  'motion-studio://workspace/manifest',
  {
    title: 'Workspace manifest',
    description: 'This workspace\'s films, their scenes and configs, and the shared-asset library, as structured JSON.',
    mimeType: 'application/json',
  },
  async (uri) => {
    const films = [];
    for (const f of await store.listFilms(WORKSPACE)) {
      if (f.broken) { films.push({ film: f.slug, broken: true }); continue; }
      const doc = await store.getFilm(f.id).catch(() => null);
      if (!doc) continue;
      const scenes = [];
      for (const s of await store.listScenes(f.id).catch(() => [])) {
        const config = await store.readConfig(s.id).catch(() => null);
        scenes.push({ scene: localId(s.id), slug: s.slug, ...(s.unlisted ? { unlisted: true } : {}), ...(config ? { config } : { missing: true }) });
      }
      const { id, workspace, path: filmPath, ...fields } = doc;
      films.push({ film: doc.slug, path: filmPath, ...fields, sceneConfigs: scenes });
    }
    const library = await store.listLibrary(WORKSPACE).catch(() => []);
    const manifest = { workspace: WORKSPACE, films, library };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifest, null, 2) }] };
  },
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[motion-studio-mcp] ready (stdio) — workspace "${WORKSPACE}"\n`);
