/**
 * Global (per-user) settings for the Studio UI — v0.15.
 *
 *   <dataDir>/settings.json      (dataDir default: ~/.motion-studio)
 *
 * Scope is deliberately narrow: these are *user preferences* that seed the
 * Studio's forms (new-project defaults, default render workers) plus the
 * ffmpeg block (v0.15): a binary path override and encode defaults
 * (crf/preset) that seed newly created projects. They never override a
 * project's own project.json, and they are not consulted by the MCP server —
 * an agent that wants 24 fps says so explicitly (the CLI takes --ffmpeg for
 * the binary path). Other machine-level knobs (data dir, TTS/music exes) stay
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
