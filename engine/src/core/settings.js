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
 *   tts.vendor           which speech vendor narration goes through (v0.17)
 *   tts.azure.*          the Azure vendor's non-secret options (region, default
 *                        voice, output format, style) — never the API key
 *
 * Two invariants hold throughout. An explicit argument always beats a global
 * default — these fill gaps, they do not override a caller who spoke up. And
 * they only ever apply at project *creation*: an existing project.json is
 * never rewritten because a global changed. See resolveFfmpegPath() below for
 * the one full precedence chain (CLI flag > env > this file > PATH).
 *
 * Other machine-level knobs (data dir, TTS/music exes) and every credential
 * stay env vars (MOTION_STUDIO_*, AZURE_SPEECH_KEY); the Studio settings
 * endpoint reports them read-only — secrets masked — so the UI can show where
 * everything lives without this file ever holding one.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './project.js';
import { AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT } from './tts-azure.js';

export const SETTINGS_SCHEMA_VERSION = 1;

export const FFMPEG_PRESETS = Object.freeze([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow',
]);

/**
 * Vendor lists, newest last. They live here rather than in the vendor modules
 * because they are what validates `tts.vendor` / `music.vendor`, and those
 * modules already read settings — putting the lists there would make the
 * import a cycle. The vendor modules re-export them.
 */
export const TTS_VENDORS = Object.freeze(['system', 'azure', 'piper']);
export const MUSIC_VENDORS = Object.freeze(['node', 'fluidsynth']);

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  newProjectDefaults: Object.freeze({ fps: 30, width: 1920, height: 1080, durationInFrames: 150 }),
  render: Object.freeze({ defaultWorkers: 1 }),
  // path: null → "ffmpeg" on PATH. defaultCrf/defaultPreset: null → the
  // engine's per-format defaults; when set they seed newly created projects'
  // output config (existing projects are untouched — same rule as everything
  // else in this file).
  ffmpeg: Object.freeze({ path: null, defaultCrf: null, defaultPreset: null }),
  // Which speech vendor narration goes through, and the non-secret half of the
  // Azure vendor's configuration (v0.17). The API key is deliberately absent:
  // it is read from the environment only, so this file stays safe to sync,
  // copy, or paste into a bug report. See core/tts-vendors.js.
  tts: Object.freeze({
    vendor: 'system',
    // Ordered preference chain (v0.19). null = "no chain configured", and the
    // scalar `vendor` above is the whole story — which is what every settings
    // file written before v0.19 says. A chain of one behaves identically to the
    // scalar; only a chain of two or more introduces fallback, and then only
    // past a vendor that is *not configured*. See core/vendors.js.
    vendors: null,
    azure: Object.freeze({ region: null, voice: null, outputFormat: AZURE_DEFAULT_FORMAT, style: null }),
    // Piper (v0.18): where the CLI and the downloaded .onnx voices live, and
    // which voice to use when a call doesn't name one. All paths, no secrets.
    piper: Object.freeze({ exe: null, python: null, voicesDir: null, voice: null }),
  }),
  // Which music vendor renders a note spec (v0.17). "node" is the default
  // because it is the only one that works off Windows and needs no binaries a
  // fresh clone has to build. targetPeakDb applies to *both* vendors and only
  // ever attenuates, so swapping vendors cannot re-balance a film's mix.
  music: Object.freeze({
    vendor: 'node',
    vendors: null,          // ordered preference chain (v0.19) — see tts.vendors
    targetPeakDb: -3,
    node: Object.freeze({ soundfont: null, sampleRate: 44100, gain: 1.575 }),
  }),
});

export function validateSettings(s) {
  const problems = [];
  const isPosInt = (v) => Number.isInteger(v) && v > 0;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  /**
   * A vendor preference chain (v0.19): null/absent, or a non-empty ordered
   * array of distinct known vendors. Duplicates are refused rather than
   * de-duplicated, because a chain listing the same vendor twice means the
   * author misunderstood what the list is, and silently "fixing" it hides that.
   */
  const vendorChain = (value, key, allowed) => {
    if (value === null || value === undefined) return;
    if (!Array.isArray(value) || value.length === 0) {
      problems.push(`${key}: non-empty array of ${allowed.join(', ')} (in preference order) or null required`);
      return;
    }
    const unknown = value.filter((v) => !allowed.includes(v));
    if (unknown.length) problems.push(`${key}: unknown vendor(s) ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`);
    if (new Set(value).size !== value.length) problems.push(`${key}: duplicate entries are not allowed`);
  };
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
    const t = s.tts;
    if (!t || typeof t !== 'object') problems.push('tts: object required');
    else {
      if (!TTS_VENDORS.includes(t.vendor)) problems.push(`tts.vendor: one of ${TTS_VENDORS.join(', ')}`);
      vendorChain(t.vendors, 'tts.vendors', TTS_VENDORS);
      const a = t.azure;
      if (!a || typeof a !== 'object') problems.push('tts.azure: object required');
      else {
        const nullableString = (k) => {
          if (a[k] !== null && (typeof a[k] !== 'string' || !a[k].trim())) {
            problems.push(`tts.azure.${k}: non-empty string or null required`);
          }
        };
        nullableString('region');
        nullableString('voice');
        nullableString('style');
        // A non-WAV format would break the duration contract every consumer
        // relies on, so it is refused here rather than at synthesis time.
        if (!AZURE_WAV_FORMATS.includes(a.outputFormat)) {
          problems.push(`tts.azure.outputFormat: one of ${AZURE_WAV_FORMATS.join(', ')}`);
        }
        // The key is environment-only. Accepting it here — even to "help" —
        // would write a live credential into a file users share freely.
        if ('key' in a || 'apiKey' in a) {
          problems.push('tts.azure.key: the Azure Speech key is read from the environment only and is never stored in settings.json');
        }
      }
      const p = t.piper;
      if (!p || typeof p !== 'object') problems.push('tts.piper: object required');
      else {
        for (const k of ['exe', 'python', 'voicesDir', 'voice']) {
          if (p[k] !== null && (typeof p[k] !== 'string' || !p[k].trim())) {
            problems.push(`tts.piper.${k}: non-empty string or null required`);
          }
        }
      }
    }
    const mu = s.music;
    if (!mu || typeof mu !== 'object') problems.push('music: object required');
    else {
      if (!MUSIC_VENDORS.includes(mu.vendor)) problems.push(`music.vendor: one of ${MUSIC_VENDORS.join(', ')}`);
      vendorChain(mu.vendors, 'music.vendors', MUSIC_VENDORS);
      // null = leave levels exactly as rendered. A positive value would mean
      // "boost to here", which this setting deliberately cannot do.
      if (mu.targetPeakDb !== null && (!isNum(mu.targetPeakDb) || mu.targetPeakDb > 0 || mu.targetPeakDb < -60)) {
        problems.push('music.targetPeakDb: number in -60..0 (dBFS) or null required');
      }
      const n = mu.node;
      if (!n || typeof n !== 'object') problems.push('music.node: object required');
      else {
        if (n.soundfont !== null && (typeof n.soundfont !== 'string' || !n.soundfont.trim())) {
          problems.push('music.node.soundfont: non-empty path or null required');
        }
        if (!isPosInt(n.sampleRate) || n.sampleRate < 8000 || n.sampleRate > 192000) {
          problems.push('music.node.sampleRate: integer in 8000..192000 required');
        }
        if (!isNum(n.gain) || n.gain <= 0 || n.gain > 4) problems.push('music.node.gain: number in 0..4 required');
      }
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

/** Copy just the named keys that are actually present on `obj`. */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
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

/**
 * The stored file exactly as written, or null when there is none. For callers
 * that must distinguish "the user chose this" from "this is the default" —
 * readSettings() answers with a complete object either way, which is right for
 * *using* a setting and wrong for *explaining* it.
 */
export async function readStoredSettings(dataDir = defaultDataDir()) {
  try {
    return JSON.parse(await fsp.readFile(settingsPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
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
    // Only known fields survive the read. A hand-edited file that parked an
    // `azure.key` in here is ignored rather than treated as corrupt (which
    // would reset every *other* setting too) — and the key still never
    // reaches the vendor, which reads the environment.
    tts: {
      ...DEFAULT_SETTINGS.tts,
      ...pick(raw.tts, ['vendor', 'vendors']),
      azure: { ...DEFAULT_SETTINGS.tts.azure, ...pick(raw.tts?.azure, ['region', 'voice', 'outputFormat', 'style']) },
      piper: { ...DEFAULT_SETTINGS.tts.piper, ...pick(raw.tts?.piper, ['exe', 'python', 'voicesDir', 'voice']) },
    },
    music: {
      ...DEFAULT_SETTINGS.music,
      ...pick(raw.music, ['vendor', 'vendors', 'targetPeakDb']),
      node: { ...DEFAULT_SETTINGS.music.node, ...pick(raw.music?.node, ['soundfont', 'sampleRate', 'gain']) },
    },
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
  const ALLOWED = new Set(['newProjectDefaults', 'render', 'ffmpeg', 'tts', 'music']);
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
    // tts.azure merges one level deeper so a patch may set just the region
    // without clearing the default voice (and vice versa).
    tts: {
      ...cur.tts,
      ...(patch.tts ?? {}),
      azure: { ...cur.tts.azure, ...(patch.tts?.azure ?? {}) },
      piper: { ...cur.tts.piper, ...(patch.tts?.piper ?? {}) },
    },
    music: {
      ...cur.music,
      ...(patch.music ?? {}),
      node: { ...cur.music.node, ...(patch.music?.node ?? {}) },
    },
  });
  await fsp.mkdir(dataDir, { recursive: true });
  const abs = settingsPath(dataDir);
  const tmp = abs + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, abs); // atomic on same volume
  return next;
}
