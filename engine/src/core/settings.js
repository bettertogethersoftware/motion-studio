/**
 * Global (per-user) settings for the Studio UI — v0.15.
 *
 *   <dataDir>/settings.json      (dataDir default: ~/.motion-studio)
 *
 * This file is the machine's single source of truth: the Studio UI presents it
 * as "Global Settings", so every front end honours it — the Studio, the MCP
 * server, and (for the ffmpeg binary) the CLI. A setting that applied only to
 * whichever surface happened to write it would not be global, it would be a
 * per-app preference wearing the wrong label.
 *
 * What that means in practice:
 *   newProjectDefaults   fill in the fields a create-project call left unset
 *   render.defaultWorkers  the default worker count for a render that does not
 *                        name one
 *   ffmpeg.path          the binary used for the prereq check AND every encode
 *   ffmpeg.crf/preset    seed a newly scaffolded project's output config
 *
 * Two invariants hold throughout. An explicit argument always beats a global
 * default — these fill gaps, they do not override a caller who spoke up. And
 * they only ever apply at project *creation*: an existing project.json is
 * never rewritten because a global changed. See resolveFfmpegPath() below for
 * the one full precedence chain (CLI flag > env > this file > PATH).
 *
 * Other machine-level knobs (data dir, TTS/music exes) stay
 * env vars (MOTION_STUDIO_*); the Studio settings endpoint reports them
 * read-only so the UI can show where everything lives.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './project.js';

export const SETTINGS_SCHEMA_VERSION = 1;

export const FFMPEG_PRESETS = Object.freeze([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  newProjectDefaults: Object.freeze({ fps: 30, width: 1920, height: 1080, durationInFrames: 150 }),
  render: Object.freeze({ defaultWorkers: 1 }),
  // path: null → "ffmpeg" on PATH. defaultCrf/defaultPreset: null → the
  // engine's per-format defaults; when set they seed newly created projects'
  // output config (existing projects are untouched — same rule as everything
  // else in this file).
  ffmpeg: Object.freeze({ path: null, defaultCrf: null, defaultPreset: null }),
});

export function validateSettings(s) {
  const problems = [];
  const isPosInt = (v) => Number.isInteger(v) && v > 0;
  if (!s || typeof s !== 'object') problems.push('settings must be an object');
  else {
    const d = s.newProjectDefaults;
    if (!d || typeof d !== 'object') problems.push('newProjectDefaults: object required');
    else {
      if (!isPosInt(d.fps) || d.fps > 240) problems.push('newProjectDefaults.fps: integer in 1..240 required');
      if (!isPosInt(d.width) || d.width > 7680) problems.push('newProjectDefaults.width: integer in 1..7680 required');
      if (!isPosInt(d.height) || d.height > 4320) problems.push('newProjectDefaults.height: integer in 1..4320 required');
      if (!isPosInt(d.durationInFrames)) problems.push('newProjectDefaults.durationInFrames: positive integer required');
    }
    const r = s.render;
    if (!r || typeof r !== 'object') problems.push('render: object required');
    else if (!isPosInt(r.defaultWorkers) || r.defaultWorkers > 8) problems.push('render.defaultWorkers: integer in 1..8 required');
    const f = s.ffmpeg;
    if (!f || typeof f !== 'object') problems.push('ffmpeg: object required');
    else {
      if (f.path !== null && (typeof f.path !== 'string' || !f.path.trim())) problems.push('ffmpeg.path: non-empty string or null required');
      if (f.defaultCrf !== null && (!Number.isInteger(f.defaultCrf) || f.defaultCrf < 0 || f.defaultCrf > 63))
        problems.push('ffmpeg.defaultCrf: integer in 0..63 or null required');
      if (f.defaultPreset !== null && !FFMPEG_PRESETS.includes(f.defaultPreset))
        problems.push(`ffmpeg.defaultPreset: null or one of ${FFMPEG_PRESETS.join(', ')}`);
    }
  }
  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, `Invalid settings: ${problems.join('; ')}`, { problems });
  }
  return s;
}

function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json');
}

/**
 * Resolve the ffmpeg binary for every entry point, so the prereq probe and the
 * encode can never disagree about which one they mean.
 *
 *   explicit override (CLI --ffmpeg)  >  MOTION_STUDIO_FFMPEG  >  ffmpeg.path
 *   >  "ffmpeg" on PATH
 *
 * The env var sits above settings because an MCP server is spawned by its
 * client and inherits whatever PATH that client had; the override sits above
 * everything because a caller who names a binary means it.
 *
 * @returns {Promise<{path: string, source: 'flag'|'env'|'settings'|'PATH'}>}
 */
export async function resolveFfmpegPath({ dataDir = defaultDataDir(), override } = {}) {
  const flag = override?.trim();
  if (flag) return { path: flag, source: 'flag' };
  const env = process.env.MOTION_STUDIO_FFMPEG?.trim();
  if (env) return { path: env, source: 'env' };
  // An unreadable dataDir must not be fatal: readSettings already falls back to
  // defaults for a missing/corrupt file, this covers the directory itself.
  const settings = await readSettings(dataDir).catch(() => null);
  const configured = settings?.ffmpeg?.path?.trim();
  if (configured) return { path: configured, source: 'settings' };
  return { path: 'ffmpeg', source: 'PATH' };
}

/**
 * Apply the global new-project defaults to a create-project request. Only
 * fields the caller actually left out are filled in — an explicit value always
 * wins, and `undefined` is stripped first so it cannot clobber a default by
 * spreading over it (MCP hands unset optional fields through as undefined).
 */
export function withNewProjectDefaults(settings, body = {}) {
  const explicit = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  return { ...settings.newProjectDefaults, ...explicit };
}

/**
 * The output-config patch implied by the global encode defaults, or null when
 * neither is set. Applied when scaffolding a project so a user who set
 * crf/preset once gets them on every new project, whichever front end created
 * it; existing projects keep their own (same rule as everything else here).
 */
export function outputSeedFromSettings(settings, currentOutput = {}) {
  const { defaultCrf, defaultPreset } = settings.ffmpeg;
  if (defaultCrf === null && defaultPreset === null) return null;
  return {
    ...currentOutput,
    ...(defaultCrf !== null ? { crf: defaultCrf } : {}),
    ...(defaultPreset !== null ? { preset: defaultPreset } : {}),
  };
}

/** Read settings, falling back to defaults for a missing/unreadable file. */
export async function readSettings(dataDir = defaultDataDir()) {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(settingsPath(dataDir), 'utf8'));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
  // Merge over defaults so a settings.json from an older schema (or a
  // hand-edited partial one) still yields a complete object.
  const merged = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    newProjectDefaults: { ...DEFAULT_SETTINGS.newProjectDefaults, ...(raw.newProjectDefaults ?? {}) },
    render: { ...DEFAULT_SETTINGS.render, ...(raw.render ?? {}) },
    ffmpeg: { ...DEFAULT_SETTINGS.ffmpeg, ...(raw.ffmpeg ?? {}) },
  };
  try {
    return validateSettings(merged);
  } catch {
    return structuredClone(DEFAULT_SETTINGS); // corrupted file: don't brick the UI
  }
}

/**
 * Section-wise merge a patch into the stored settings, validate, and persist
 * atomically. Unknown top-level keys are rejected so typos fail loudly.
 */
export async function updateSettings(patch, dataDir = defaultDataDir()) {
  const ALLOWED = new Set(['newProjectDefaults', 'render', 'ffmpeg']);
  for (const k of Object.keys(patch ?? {})) {
    if (!ALLOWED.has(k)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `Settings field "${k}" cannot be updated`, { field: k });
    }
  }
  const cur = await readSettings(dataDir);
  const next = validateSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    newProjectDefaults: { ...cur.newProjectDefaults, ...(patch.newProjectDefaults ?? {}) },
    render: { ...cur.render, ...(patch.render ?? {}) },
    ffmpeg: { ...cur.ffmpeg, ...(patch.ffmpeg ?? {}) },
  });
  await fsp.mkdir(dataDir, { recursive: true });
  const abs = settingsPath(dataDir);
  const tmp = abs + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, abs); // atomic on same volume
  return next;
}
