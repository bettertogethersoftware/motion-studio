/**
 * Global (per-user) settings for the Studio UI — v0.15.
 *
 *   <dataDir>/settings.json      (both halves configurable — see core/paths.js)
 *
 * This file is the machine's single source of truth: the Studio UI presents it
 * as "Global Settings", so every front end honours it — the Studio, the MCP
 * server, and (for the ffmpeg binary) the CLI. A setting that applied only to
 * whichever surface happened to write it would not be global, it would be a
 * per-app preference wearing the wrong label.
 *
 * What that means in practice:
 *   newSceneDefaults   fill in the fields a create-film/create-scene call left unset
 *   render.defaultWorkers  the default worker count for a render that does not
 *                        name one
 *   ffmpeg.path          the binary used for the prereq check AND every encode
 *   ffmpeg.crf/preset    seed a newly scaffolded scene's output config
 *   tts.vendor           which speech vendor narration goes through (v0.17)
 *   tts.azure.*          the Azure vendor's non-secret options (region, default
 *                        voice, output format, style) — never the API key
 *   transcription.*      which vendor READS speech out of supplied media, and
 *                        where its binary and models live (v0.22)
 *
 * Two invariants hold throughout. An explicit argument always beats a global
 * default — these fill gaps, they do not override a caller who spoke up. And
 * they only ever apply at scene *creation*: an existing scene.json is
 * never rewritten because a global changed. See resolveFfmpegPath() below for
 * the one full precedence chain (CLI flag > env > this file > PATH).
 *
 * The remaining machine-level knobs (TTS/music exes) and every credential stay
 * env vars (MOTION_STUDIO_*, AZURE_SPEECH_KEY); the Studio settings endpoint
 * reports them read-only — secrets masked — so the UI can show where everything
 * lives without this file ever holding one.
 *
 * The three STORAGE locations — data dir, workspaces root, and the path to this
 * very file — are the exception, and they live in core/paths.js rather than
 * here. They cannot live here: this file's own location is one of them. They are
 * editable from the same settings page all the same (v0.22).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir, settingsFileFor } from './paths.js';
import { AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT } from './tts-azure.js';
import { ELEVENLABS_WAV_FORMATS, ELEVENLABS_DEFAULT_FORMAT } from './tts-elevenlabs.js';
import { DEFAULT_REVIEW_POLICY, REVIEW_WARNING_CODES } from './render-review.js';
import {
  DEFAULT_DELIVERABLE_PRESETS, DELIVERABLE_ID_RE, MAX_FILM_DELIVERABLES,
  normalizeDeliverable, validateDeliverablePreset,
} from './deliverables.js';

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
export const TTS_VENDORS = Object.freeze(['system', 'azure', 'piper', 'elevenlabs', 'openai', 'deepgram']);
export const MUSIC_VENDORS = Object.freeze(['node', 'fluidsynth']);
export const TRANSCRIPTION_VENDORS = Object.freeze(['whisper-cpp']);

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  newSceneDefaults: Object.freeze({ fps: 30, width: 1920, height: 1080, durationInFrames: 150 }),
  // New films are master-only unless an agent/user explicitly names platforms
  // or opts into workspace defaults. Presets are snapshots seeded into the
  // film; changing this list never mutates an existing film document.
  newFilmDefaults: Object.freeze({ deliverableIds: Object.freeze([]) }),
  deliverablePresets: DEFAULT_DELIVERABLE_PRESETS,
  render: Object.freeze({
    defaultWorkers: 1,
    // Review policy is a list of stable warning codes. The default refuses a
    // known-short file and records intentional dark/static frames as warnings.
    review: Object.freeze({
      block: Object.freeze([...DEFAULT_REVIEW_POLICY.block]),
      warn: Object.freeze([...DEFAULT_REVIEW_POLICY.warn]),
    }),
  }),
  // path: null → "ffmpeg" on PATH. defaultCrf/defaultPreset: null → the
  // engine's per-format defaults; when set they seed newly created scenes'
  // output config (existing scenes are untouched — same rule as everything
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
    // Voices the user starred in the Studio (v0.22), keyed by vendor:
    // { azure: ["en-US-AvaNeural"], piper: [...] }. null = none recorded.
    // Surfaced through list_vendors so narrating agents can prefer voices the
    // user actually auditioned and chose. Mirrors music.favoritePrograms.
    favoriteVoices: null,
    azure: Object.freeze({ region: null, voice: null, outputFormat: AZURE_DEFAULT_FORMAT, style: null }),
    // Piper (v0.18): where the CLI and the downloaded .onnx voices live, and
    // which voice to use when a call doesn't name one. All paths, no secrets.
    piper: Object.freeze({ exe: null, python: null, voicesDir: null, voice: null }),
    // The v0.20 cloud vendors, each following azure's rule: the non-secret
    // half only — every API key is environment-only. See the vendor modules
    // (core/tts-elevenlabs.js, core/tts-openai.js, core/tts-deepgram.js).
    elevenlabs: Object.freeze({ voice: null, model: null, outputFormat: ELEVENLABS_DEFAULT_FORMAT }),
    openai: Object.freeze({ voice: null, model: null, instructions: null }),
    deepgram: Object.freeze({ voice: null }),
  }),
  // Which music vendor renders a note spec (v0.17). "node" is the default
  // because it is the only one that works off Windows and needs no binaries a
  // fresh clone has to build. targetPeakDb applies to *both* vendors and only
  // ever attenuates, so swapping vendors cannot re-balance a film's mix.
  music: Object.freeze({
    vendor: 'node',
    vendors: null,          // ordered preference chain (v0.19) — see tts.vendors
    targetPeakDb: -3,
    // General MIDI programs (0..127) the user has auditioned and starred in
    // the Studio (v0.22). null = no preference recorded. Surfaced through
    // list_vendors so composing agents can voice music with instruments the
    // user actually likes instead of defaulting to piano-and-strings.
    favoritePrograms: null,
    node: Object.freeze({ soundfont: null, sampleRate: 44100, gain: 1.575 }),
  }),
  // Which vendor READS speech out of supplied media (v0.22) — the transcription
  // capability behind `transcribe_asset`. Local and offline like piper, so the
  // same rule applies: paths and knobs here, no credentials, because there is
  // no account to have. See core/transcribe-vendors.js and
  // docs/transcribe-setup.md.
  transcription: Object.freeze({
    vendor: 'whisper-cpp',
    vendors: null,          // ordered preference chain (v0.19) — see tts.vendors
    whisper: Object.freeze({
      // The whisper-cli executable, the ggml model (a file path or a bare name
      // like "small.en"), and the folder holding several of them. null = follow
      // the resolution chain in core/transcribe-whisper.js.
      exe: null,
      model: null,
      modelsDir: null,
      // null = whisper.cpp's own default (4). Threads is the one knob that
      // changes wall-clock by more than noise: the measured 6.5× realtime in
      // docs/transcribe-setup.md is at 8.
      threads: null,
      // null = auto-detect per file. A film in one language is the normal case,
      // and naming it is both faster and more accurate than detection.
      language: null,
    }),
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
    const presets = s.deliverablePresets;
    if (!Array.isArray(presets) || presets.length === 0 || presets.length > MAX_FILM_DELIVERABLES * 3) {
      problems.push(`deliverablePresets: array of 1..${MAX_FILM_DELIVERABLES * 3} presets required`);
    } else {
      const ids = new Set();
      presets.forEach((preset, index) => {
        const normalized = normalizeDeliverable(preset, { baseFilename: 'film' });
        validateDeliverablePreset(normalized, `deliverablePresets[${index}]`, problems);
        if (typeof normalized?.id === 'string') {
          if (ids.has(normalized.id)) problems.push(`deliverablePresets[${index}].id "${normalized.id}" is duplicated`);
          ids.add(normalized.id);
        }
      });
    }
    const nfd = s.newFilmDefaults;
    if (!nfd || typeof nfd !== 'object' || Array.isArray(nfd)) {
      problems.push('newFilmDefaults: object required');
    } else {
      const ids = nfd.deliverableIds;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !DELIVERABLE_ID_RE.test(id))) {
        problems.push('newFilmDefaults.deliverableIds: array of deliverable ids required');
      } else {
        if (new Set(ids).size !== ids.length) problems.push('newFilmDefaults.deliverableIds: duplicate ids are not allowed');
        const known = new Set((Array.isArray(presets) ? presets : []).map((preset) => preset?.id));
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length) problems.push(`newFilmDefaults.deliverableIds: unknown preset id(s) ${unknown.join(', ')}`);
      }
      for (const key of Object.keys(nfd)) {
        if (key !== 'deliverableIds') problems.push(`newFilmDefaults.${key} is not a new-film default`);
      }
    }
    const d = s.newSceneDefaults;
    if (!d || typeof d !== 'object') problems.push('newSceneDefaults: object required');
    else {
      if (!isPosInt(d.fps) || d.fps > 240) problems.push('newSceneDefaults.fps: integer in 1..240 required');
      if (!isPosInt(d.width) || d.width > 7680) problems.push('newSceneDefaults.width: integer in 1..7680 required');
      if (!isPosInt(d.height) || d.height > 4320) problems.push('newSceneDefaults.height: integer in 1..4320 required');
      if (!isPosInt(d.durationInFrames)) problems.push('newSceneDefaults.durationInFrames: positive integer required');
    }
    const r = s.render;
    if (!r || typeof r !== 'object') problems.push('render: object required');
    else {
      if (!isPosInt(r.defaultWorkers) || r.defaultWorkers > 10) problems.push('render.defaultWorkers: integer in 1..10 required');
      const review = r.review;
      if (!review || typeof review !== 'object' || Array.isArray(review)) {
        problems.push('render.review: object with block/warn arrays required');
      } else {
        for (const field of ['block', 'warn']) {
          const values = review[field];
          if (!Array.isArray(values)) {
            problems.push(`render.review.${field}: array of review warning codes required`);
            continue;
          }
          const unknown = values.filter((value) => !REVIEW_WARNING_CODES.includes(value));
          if (unknown.length) problems.push(`render.review.${field}: unknown warning code(s) ${unknown.join(', ')}`);
          if (new Set(values).size !== values.length) problems.push(`render.review.${field}: duplicate warning codes are not allowed`);
        }
        const overlap = (review.block ?? []).filter((code) => (review.warn ?? []).includes(code));
        if (overlap.length) problems.push(`render.review: a code cannot be both block and warn (${overlap.join(', ')})`);
      }
    }
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
      // The v0.20 cloud vendors, mirroring the azure rules above: nullable
      // strings for the non-secret knobs, and a key is refused rather than
      // stored — accepting one, even to "help", would write a live credential
      // into a file users share freely.
      const cloudVendor = (section, fields, label) => {
        const c = t[section];
        if (!c || typeof c !== 'object') {
          problems.push(`tts.${section}: object required`);
          return null;
        }
        for (const k of fields) {
          if (c[k] !== null && (typeof c[k] !== 'string' || !c[k].trim())) {
            problems.push(`tts.${section}.${k}: non-empty string or null required`);
          }
        }
        if ('key' in c || 'apiKey' in c) {
          problems.push(`tts.${section}.key: the ${label} API key is read from the environment only and is never stored in settings.json`);
        }
        return c;
      };
      const el = cloudVendor('elevenlabs', ['voice', 'model'], 'ElevenLabs');
      // Same duration contract as tts.azure.outputFormat: only headered WAV.
      if (el && !ELEVENLABS_WAV_FORMATS.includes(el.outputFormat)) {
        problems.push(`tts.elevenlabs.outputFormat: one of ${ELEVENLABS_WAV_FORMATS.join(', ')}`);
      }
      cloudVendor('openai', ['voice', 'model', 'instructions'], 'OpenAI');
      cloudVendor('deepgram', ['voice'], 'Deepgram');
      // Starred voices (v0.22): a map of vendor → distinct voice names.
      // Unknown vendor keys are refused rather than dropped, same reasoning
      // as duplicate chain entries: they mean the author misunderstood.
      const fv = t.favoriteVoices;
      if (fv !== null && fv !== undefined) {
        if (typeof fv !== 'object' || Array.isArray(fv)) {
          problems.push('tts.favoriteVoices: object mapping vendor → array of voice names, or null required');
        } else {
          for (const [vendor, voices] of Object.entries(fv)) {
            if (!TTS_VENDORS.includes(vendor)) {
              problems.push(`tts.favoriteVoices.${vendor}: unknown vendor (one of ${TTS_VENDORS.join(', ')})`);
            } else if (!Array.isArray(voices) || voices.some((v) => typeof v !== 'string' || !v.trim())) {
              problems.push(`tts.favoriteVoices.${vendor}: array of non-empty voice names required`);
            } else if (new Set(voices).size !== voices.length) {
              problems.push(`tts.favoriteVoices.${vendor}: duplicate voices not allowed`);
            }
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
      // Empty array is allowed (= no favorites left after un-starring); null
      // means the feature was never used. Duplicates refused like vendor
      // chains: a repeated program means the author misunderstood the list.
      const fav = mu.favoritePrograms;
      if (fav !== null && fav !== undefined) {
        if (!Array.isArray(fav) || fav.some((p) => !Number.isInteger(p) || p < 0 || p > 127)) {
          problems.push('music.favoritePrograms: array of General MIDI programs (integers 0..127) or null required');
        } else if (new Set(fav).size !== fav.length) {
          problems.push('music.favoritePrograms: duplicate programs not allowed');
        }
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
    // Transcription (v0.22). Absent is fine — every settings.json written before
    // this release omits it, and readSettings() merges the defaults in.
    const tr = s.transcription;
    if (tr !== null && tr !== undefined) {
      if (typeof tr !== 'object' || Array.isArray(tr)) problems.push('transcription: object or absent required');
      else {
        if (!TRANSCRIPTION_VENDORS.includes(tr.vendor)) {
          problems.push(`transcription.vendor: one of ${TRANSCRIPTION_VENDORS.join(', ')}`);
        }
        vendorChain(tr.vendors, 'transcription.vendors', TRANSCRIPTION_VENDORS);
        const w = tr.whisper;
        if (!w || typeof w !== 'object') problems.push('transcription.whisper: object required');
        else {
          for (const k of ['exe', 'model', 'modelsDir', 'language']) {
            if (w[k] !== null && (typeof w[k] !== 'string' || !w[k].trim())) {
              problems.push(`transcription.whisper.${k}: non-empty string or null required`);
            }
          }
          // 64 is well past any consumer core count; a typo like 800 would just
          // thrash. null = let whisper.cpp choose.
          if (w.threads !== null && (!Number.isInteger(w.threads) || w.threads < 1 || w.threads > 64)) {
            problems.push('transcription.whisper.threads: integer in 1..64 or null required');
          }
        }
      }
    }
  }
  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, `Invalid settings: ${problems.join('; ')}`, { problems });
  }
  return s;
}

/**
 * Where this data dir's settings.json lives. Usually right inside it — but the
 * file is separately configurable since v0.22, so core/paths.js gets the last
 * word (and only for the machine's configured data dir; see settingsFileFor).
 */
function settingsPath(dataDir) {
  return settingsFileFor(dataDir);
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
 * Resolve ffprobe by following whatever ffmpeg resolved to (v0.21).
 *
 * ffprobe has no setting of its own because it is never configured separately
 * in practice — it ships beside ffmpeg in every distribution. So when ffmpeg
 * was found by an absolute path (env/settings/flag), look for its sibling;
 * only fall back to bare "ffprobe" on PATH when ffmpeg came from PATH too.
 * Without this, `probe_asset` would be unusable in exactly the case
 * MOTION_STUDIO_FFMPEG exists for: an MCP server with a minimal PATH.
 *
 * @returns {Promise<{path: string, source: 'sibling'|'PATH'}>}
 */
export async function resolveFfprobePath({ dataDir = defaultDataDir(), override } = {}) {
  const { path: ffmpeg, source } = await resolveFfmpegPath({ dataDir, override });
  if (source === 'PATH' || !ffmpeg.includes(path.sep)) return { path: 'ffprobe', source: 'PATH' };
  const dir = path.dirname(ffmpeg);
  const base = path.basename(ffmpeg).replace(/ffmpeg/i, (m) => (m === 'FFMPEG' ? 'FFPROBE' : m === 'Ffmpeg' ? 'Ffprobe' : 'ffprobe'));
  return { path: path.join(dir, base), source: 'sibling' };
}

/**
 * Apply the global new-scene defaults to a create request. Only
 * fields the caller actually left out are filled in — an explicit value always
 * wins, and `undefined` is stripped first so it cannot clobber a default by
 * spreading over it (MCP hands unset optional fields through as undefined).
 */
export function withNewSceneDefaults(settings, body = {}) {
  const explicit = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  return { ...settings.newSceneDefaults, ...explicit };
}

/**
 * The output-config patch implied by the global encode defaults, or null when
 * neither is set. Applied when scaffolding a scene so a user who set
 * crf/preset once gets them on every new scene, whichever front end created
 * it; existing scenes keep their own (same rule as everything else here).
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
    newSceneDefaults: { ...DEFAULT_SETTINGS.newSceneDefaults, ...(raw.newSceneDefaults ?? {}) },
    newFilmDefaults: { ...DEFAULT_SETTINGS.newFilmDefaults, ...(raw.newFilmDefaults ?? {}) },
    deliverablePresets: Array.isArray(raw.deliverablePresets)
      ? raw.deliverablePresets.map((preset) => normalizeDeliverable(preset, { baseFilename: 'film' }))
      : structuredClone(DEFAULT_SETTINGS.deliverablePresets),
    render: {
      ...DEFAULT_SETTINGS.render,
      ...(raw.render ?? {}),
      review: { ...DEFAULT_SETTINGS.render.review, ...(raw.render?.review ?? {}) },
    },
    ffmpeg: { ...DEFAULT_SETTINGS.ffmpeg, ...(raw.ffmpeg ?? {}) },
    // Only known fields survive the read. A hand-edited file that parked an
    // `azure.key` in here is ignored rather than treated as corrupt (which
    // would reset every *other* setting too) — and the key still never
    // reaches the vendor, which reads the environment.
    tts: {
      ...DEFAULT_SETTINGS.tts,
      ...pick(raw.tts, ['vendor', 'vendors', 'favoriteVoices']),
      azure: { ...DEFAULT_SETTINGS.tts.azure, ...pick(raw.tts?.azure, ['region', 'voice', 'outputFormat', 'style']) },
      piper: { ...DEFAULT_SETTINGS.tts.piper, ...pick(raw.tts?.piper, ['exe', 'python', 'voicesDir', 'voice']) },
      elevenlabs: { ...DEFAULT_SETTINGS.tts.elevenlabs, ...pick(raw.tts?.elevenlabs, ['voice', 'model', 'outputFormat']) },
      openai: { ...DEFAULT_SETTINGS.tts.openai, ...pick(raw.tts?.openai, ['voice', 'model', 'instructions']) },
      deepgram: { ...DEFAULT_SETTINGS.tts.deepgram, ...pick(raw.tts?.deepgram, ['voice']) },
    },
    music: {
      ...DEFAULT_SETTINGS.music,
      ...pick(raw.music, ['vendor', 'vendors', 'targetPeakDb', 'favoritePrograms']),
      node: { ...DEFAULT_SETTINGS.music.node, ...pick(raw.music?.node, ['soundfont', 'sampleRate', 'gain']) },
    },
    transcription: {
      ...DEFAULT_SETTINGS.transcription,
      ...pick(raw.transcription, ['vendor', 'vendors']),
      whisper: {
        ...DEFAULT_SETTINGS.transcription.whisper,
        ...pick(raw.transcription?.whisper, ['exe', 'model', 'modelsDir', 'threads', 'language']),
      },
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
  const ALLOWED = new Set(['newSceneDefaults', 'newFilmDefaults', 'deliverablePresets', 'render', 'ffmpeg', 'tts', 'music', 'transcription']);
  for (const k of Object.keys(patch ?? {})) {
    if (!ALLOWED.has(k)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `Settings field "${k}" cannot be updated`, { field: k });
    }
  }
  const cur = await readSettings(dataDir);
  const next = validateSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    newSceneDefaults: { ...cur.newSceneDefaults, ...(patch.newSceneDefaults ?? {}) },
    newFilmDefaults: { ...cur.newFilmDefaults, ...(patch.newFilmDefaults ?? {}) },
    deliverablePresets: patch.deliverablePresets === undefined
      ? cur.deliverablePresets
      : patch.deliverablePresets.map((preset) => normalizeDeliverable(preset, { baseFilename: 'film' })),
    render: {
      ...cur.render,
      ...(patch.render ?? {}),
      review: { ...cur.render.review, ...(patch.render?.review ?? {}) },
    },
    ffmpeg: { ...cur.ffmpeg, ...(patch.ffmpeg ?? {}) },
    // tts.azure merges one level deeper so a patch may set just the region
    // without clearing the default voice (and vice versa).
    tts: {
      ...cur.tts,
      ...(patch.tts ?? {}),
      azure: { ...cur.tts.azure, ...(patch.tts?.azure ?? {}) },
      piper: { ...cur.tts.piper, ...(patch.tts?.piper ?? {}) },
      elevenlabs: { ...cur.tts.elevenlabs, ...(patch.tts?.elevenlabs ?? {}) },
      openai: { ...cur.tts.openai, ...(patch.tts?.openai ?? {}) },
      deepgram: { ...cur.tts.deepgram, ...(patch.tts?.deepgram ?? {}) },
    },
    music: {
      ...cur.music,
      ...(patch.music ?? {}),
      node: { ...cur.music.node, ...(patch.music?.node ?? {}) },
    },
    transcription: {
      ...cur.transcription,
      ...(patch.transcription ?? {}),
      whisper: { ...cur.transcription.whisper, ...(patch.transcription?.whisper ?? {}) },
    },
  });
  const abs = settingsPath(dataDir);
  // The settings file need not live inside the data dir (v0.22), so create the
  // folder it is actually going into rather than assuming the two agree.
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, abs); // atomic on same volume
  return next;
}
