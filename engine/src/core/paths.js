/**
 * Where Motion Studio keeps its data — v0.22.
 *
 * Four locations decide where everything lives:
 *
 *   dataDir         the root.             default: <app>/data
 *   workspacesRoot  the workspace tree.   default: <dataDir>/workspaces
 *   settingsFile    global settings.json. default: <dataDir>/settings.json
 *   vendorDir       vendor binaries/models/voices (v0.25). default: <app>/vendor
 *
 * vendorDir is the odd one out: it is not user *data* but the root the engine
 * resolves bundled runtime assets from — the TTS/MIDI exes, FluidSynth,
 * SoundFonts, Piper voices, Whisper models and the committed 3D libs. It lives
 * here all the same because it shares every property that put the other three
 * here: machine-level, needed synchronously by module-level resolvers, and
 * overridable per process by an env var (MOTION_STUDIO_VENDOR_DIR). The
 * per-item hooks (MOTION_STUDIO_TTS_EXE, _SOUNDFONT, _WHISPER_MODELS, …) all
 * still win over it — this only moves the *default* root those fall back to.
 *
 * Until v0.22 all three were derived from MOTION_STUDIO_HOME (or ~/.motion-studio)
 * and could only be changed by restarting every front end with a different
 * environment — which the Studio's own settings page reported read-only, because
 * it had no way to write them. They are editable now, and that needs somewhere to
 * record them that is NOT settings.json: settings.json is one of the things being
 * located. Hence this module and its own tiny bootstrap file:
 *
 *   <app>/paths.json    { dataDir, workspacesRoot, settingsFile }   any may be null
 *
 * Resolution, per key, highest wins:
 *
 *   MOTION_STUDIO_HOME / _WORKSPACES / _SETTINGS      (env)
 *   paths.json                                        (what the Studio writes)
 *   the default above
 *
 * Env sits on top for the same reason it does for the ffmpeg binary (see
 * core/settings.js): an MCP server is spawned by its client with whatever
 * environment that client chose, and a value named there is a deliberate
 * statement about THAT process which a shared file must not silently overrule.
 * resolvePaths() reports which layer won for each key, so the settings page can
 * grey out a field the environment has already decided instead of offering an
 * edit that would do nothing.
 *
 * Why <app>/data and not ~/.motion-studio: a checkout that carries its own data
 * is one folder to copy, back up, or move to another drive, and `paths.json`
 * stores app-relative values relative — so moving the folder moves the install
 * intact. Nothing outside this module knows the default; every consumer asks.
 *
 * THE LEGACY EXCEPTION. The pre-v0.22 default was ~/.motion-studio, and an
 * upgrade must not make an existing library of films vanish. So when nothing is
 * configured, <app>/data does not exist yet, and ~/.motion-studio does, the old
 * directory wins and is reported as source "legacy" — then ensureStableDataDir()
 * writes it into paths.json, so the answer stops depending on which folders
 * happen to exist and starts being a recorded decision the user can see and
 * change. A fresh install never takes this branch and lands on <app>/data.
 *
 * Everything here is synchronous by design: defaultDataDir() is a default
 * parameter value on constructors and module-level functions all over the
 * engine, and making it async would push a promise into every one of them to
 * read a file measured in bytes. The read is memoized (and the memo keyed on the
 * env vars, so a test that sets one is never served a stale answer).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The folder that holds engine/ — the checkout root in every supported install. */
export const APP_ROOT = path.resolve(__dirname, '../../..');

/**
 * Installed as somebody's dependency, APP_ROOT is a node_modules folder: writing
 * a film library there would put user data somewhere `npm ci` deletes. That mode
 * is not otherwise supported (the bin entries point into src/), but the failure
 * is bad enough to be worth three lines — fall back to the home directory, which
 * is what every version before v0.22 used anyway.
 */
const PORTABLE = path.basename(APP_ROOT) !== 'node_modules';

/** The home-directory data dir: the pre-v0.22 default, and the non-portable one. */
export const LEGACY_DATA_DIR = path.join(os.homedir(), '.motion-studio');

/** Where a relative path in paths.json is resolved from, and where the file lives. */
export const CONFIG_ROOT = PORTABLE ? APP_ROOT : LEGACY_DATA_DIR;

/** The default data dir — the one a fresh install gets. */
export const APP_DATA_DIR = PORTABLE ? path.join(APP_ROOT, 'data') : LEGACY_DATA_DIR;

/** The default vendor dir — the checkout's own vendor/ tree (moved to the repo
 *  root in v0.25; see docs/CHANGELOG.md). */
export const APP_VENDOR_DIR = path.join(APP_ROOT, 'vendor');

/** The configurable keys, in display order. */
export const PATH_KEYS = Object.freeze(['dataDir', 'workspacesRoot', 'settingsFile', 'vendorDir']);

/** The environment variable that overrides each key. */
export const PATH_ENV = Object.freeze({
  dataDir: 'MOTION_STUDIO_HOME',
  workspacesRoot: 'MOTION_STUDIO_WORKSPACES',
  settingsFile: 'MOTION_STUDIO_SETTINGS',
  vendorDir: 'MOTION_STUDIO_VENDOR_DIR',
});

/** Redirects the bootstrap file itself. See locationsFile(). */
export const PATHS_FILE_ENV = 'MOTION_STUDIO_PATHS_FILE';

/**
 * The bootstrap file. Fixed at <app>/paths.json — it is the one location that
 * cannot be recorded in a file, since it is the file.
 *
 * The env override exists because "cannot be redirected" also means the test
 * suite would have to write the developer's real config to cover the write
 * path, and a test that can destroy your film library is a test nobody runs.
 * It follows the same rule as every other location here: the environment is
 * a statement about this process, and it wins.
 */
export function locationsFile() {
  const v = process.env[PATHS_FILE_ENV]?.trim();
  return v ? path.resolve(v) : path.join(CONFIG_ROOT, 'paths.json');
}

/** Relative locations are read and written against the folder holding it. */
const configAnchor = () => path.dirname(locationsFile());

/* ------------------------------------------------------------------------ */
/* Reading                                                                   */
/* ------------------------------------------------------------------------ */

let cache = null;
let cacheKey = null;

/** Env values folded into one string, so setting one busts the memo. */
function envFingerprint() {
  return [...PATH_KEYS.map((k) => process.env[PATH_ENV[k]] ?? ''), process.env[PATHS_FILE_ENV] ?? ''].join(' ');
}

/** Drop the memo. Called after a write; exported for tests. */
export function invalidatePaths() {
  cache = null;
  cacheKey = null;
}

/**
 * paths.json as absolute paths, `{}` when absent, unreadable, or corrupt.
 *
 * A broken bootstrap file falls back to the defaults rather than throwing: it is
 * read on the way to answering *every* request, so a stray character in it would
 * otherwise take down the Studio, the MCP servers, and the CLI at once — with no
 * working surface left to fix it from.
 */
function readLocationsFile() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(locationsFile(), 'utf8')); }
  catch { return {}; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const out = {};
  for (const key of PATH_KEYS) {
    const v = doc[key];
    if (typeof v === 'string' && v.trim() && !v.includes('\0')) {
      out[key] = path.resolve(configAnchor(), v.trim());
    }
  }
  return out;
}

/** The data dir nothing configured — and whether it is the legacy exception. */
function defaultDataDir_() {
  if (fs.existsSync(APP_DATA_DIR)) return [APP_DATA_DIR, 'default'];
  if (APP_DATA_DIR !== LEGACY_DATA_DIR && fs.existsSync(LEGACY_DATA_DIR)) return [LEGACY_DATA_DIR, 'legacy'];
  return [APP_DATA_DIR, 'default'];
}

function envValue(key) {
  const v = process.env[PATH_ENV[key]]?.trim();
  return v ? path.resolve(v) : null;
}

/**
 * The three locations plus, for each, which layer decided it
 * ('env' | 'configured' | 'default' | 'legacy') and what paths.json holds.
 *
 * @returns {{dataDir: string, workspacesRoot: string, settingsFile: string,
 *   sources: object, stored: object, defaults: object, locationsFile: string}}
 */
export function resolvePaths() {
  const key = envFingerprint();
  if (cache && cacheKey === key) return cache;

  const stored = readLocationsFile();
  const sources = {};

  let dataDir = envValue('dataDir');
  if (dataDir) sources.dataDir = 'env';
  else if (stored.dataDir) { dataDir = stored.dataDir; sources.dataDir = 'configured'; }
  else [dataDir, sources.dataDir] = defaultDataDir_();

  // The other two default *from* the resolved data dir, so moving the root moves
  // both with it unless they were pinned somewhere else on purpose.
  const defaults = {
    dataDir: APP_DATA_DIR,
    workspacesRoot: path.join(dataDir, 'workspaces'),
    settingsFile: path.join(dataDir, 'settings.json'),
    // Vendor assets ship with the app, not the data — the default does NOT
    // follow a relocated data dir.
    vendorDir: APP_VENDOR_DIR,
  };
  const derive = (k) => {
    const env = envValue(k);
    if (env) { sources[k] = 'env'; return env; }
    if (stored[k]) { sources[k] = 'configured'; return stored[k]; }
    sources[k] = 'default';
    return defaults[k];
  };

  cache = Object.freeze({
    dataDir,
    workspacesRoot: derive('workspacesRoot'),
    settingsFile: derive('settingsFile'),
    vendorDir: derive('vendorDir'),
    sources: Object.freeze(sources),
    stored: Object.freeze({ ...stored }),
    defaults: Object.freeze(defaults),
    locationsFile: locationsFile(),
  });
  cacheKey = key;
  return cache;
}

/** The effective data dir. The default for every `dataDir` parameter in the engine. */
export function defaultDataDir() {
  return resolvePaths().dataDir;
}

/**
 * The effective vendor dir (v0.25) — what every vendor-asset resolver joins its
 * relative default onto: tts/, music/, fluidsynth/, soundfonts/, piper/voices/,
 * whisper/models/, libs/. Synchronous and memoized like everything else here,
 * because the resolvers that need it are synchronous default-parameter code.
 */
export function vendorDir() {
  return resolvePaths().vendorDir;
}

/**
 * The workspace tree / settings file for a given data dir.
 *
 * A configured override applies to the CONFIGURED data dir only; any other one
 * gets the conventional layout underneath it. That rule is what keeps a caller
 * who names a directory — a test over a temp dir, a CLI run against a copy —
 * getting a self-contained tree there instead of silently borrowing the
 * machine's real workspaces.
 */
export function workspacesRootFor(dataDir) {
  const p = resolvePaths();
  return path.resolve(dataDir) === path.resolve(p.dataDir)
    ? p.workspacesRoot
    : path.join(dataDir, 'workspaces');
}

export function settingsFileFor(dataDir) {
  const p = resolvePaths();
  return path.resolve(dataDir) === path.resolve(p.dataDir)
    ? p.settingsFile
    : path.join(dataDir, 'settings.json');
}

/* ------------------------------------------------------------------------ */
/* Writing                                                                   */
/* ------------------------------------------------------------------------ */

/** Store app-relative locations relatively, so moving the folder moves the install. */
function relativize(abs) {
  const rel = path.relative(configAnchor(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : abs;
}

/**
 * Check one supplied location. Returns the absolute path, or pushes onto
 * `problems` and returns null. Empty string and null both mean "use the default".
 */
function checkOne(key, value, problems) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    problems.push(`${key}: a path string or null is required`);
    return null;
  }
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes('\0')) {
    problems.push(`${key}: path contains a NUL byte`);
    return null;
  }
  const abs = path.resolve(configAnchor(), raw);
  // A settings file that is not a .json file is nearly always a directory typed
  // into the wrong box; caught here it is one message, caught later it is a
  // settings save that appears to work and reads back as defaults.
  if (key === 'settingsFile' && path.extname(abs).toLowerCase() !== '.json') {
    problems.push(`settingsFile: must be a .json file (got "${raw}")`);
    return null;
  }
  let st = null;
  try { st = fs.statSync(abs); } catch { /* absent is fine — it gets created */ }
  if (st) {
    const wantDir = key !== 'settingsFile';
    if (wantDir && !st.isDirectory()) problems.push(`${key}: "${abs}" exists and is not a directory`);
    if (!wantDir && !st.isFile()) problems.push(`settingsFile: "${abs}" exists and is not a file`);
  }
  return abs;
}

/**
 * Merge a patch into paths.json, create the directories it names, and persist
 * atomically. A key set to null (or "") is cleared back to its default. Unknown
 * keys are rejected so a typo fails loudly instead of being ignored forever.
 *
 * The directories are created here rather than lazily at first use because this
 * is the moment the user is looking at the result: a data dir that cannot be
 * created should say so while the settings page is still open, not at the start
 * of the next render.
 *
 * @returns {Promise<object>} the freshly resolved paths (see resolvePaths)
 */
export async function updateLocations(patch) {
  for (const k of Object.keys(patch ?? {})) {
    if (!PATH_KEYS.includes(k)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG,
        `Location "${k}" cannot be set — expected one of: ${PATH_KEYS.join(', ')}`, { field: k });
    }
  }
  const stored = readLocationsFile();
  const problems = [];
  const next = {};
  for (const key of PATH_KEYS) {
    const supplied = patch && key in patch ? patch[key] : (stored[key] ?? null);
    next[key] = checkOne(key, supplied, problems);
  }
  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      `Invalid storage locations: ${problems.join('; ')}`, { problems });
  }

  const dataDir = next.dataDir ?? defaultDataDir_()[0];
  const workspacesRoot = next.workspacesRoot ?? path.join(dataDir, 'workspaces');
  const settingsFile = next.settingsFile ?? path.join(dataDir, 'settings.json');
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(workspacesRoot, { recursive: true });
    await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
    // Only an explicitly configured vendor dir is created — the default is the
    // checkout's own vendor/ tree, which exists (or intentionally doesn't).
    if (next.vendorDir) await fsp.mkdir(next.vendorDir, { recursive: true });
  } catch (e) {
    throw new EngineError(ErrorCodes.DISK_ERROR,
      `Could not create the storage location: ${e.message}`, { dataDir, workspacesRoot, settingsFile });
  }

  const doc = Object.fromEntries(PATH_KEYS.map((k) => [k, next[k] === null ? null : relativize(next[k])]));
  const file = locationsFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
  await fsp.rename(tmp, file); // atomic on same volume
  invalidatePaths();
  return resolvePaths();
}

/**
 * Record the legacy data dir in paths.json the first time it is used, so the
 * resolution stops depending on which folders exist. Called once at startup by
 * the servers; a no-op in every other case, including when the environment
 * decided the answer (nothing to remember — the client owns that).
 *
 * @returns {Promise<{pinned: string}|null>}
 */
export async function ensureStableDataDir() {
  const p = resolvePaths();
  if (p.sources.dataDir !== 'legacy') return null;
  await updateLocations({ dataDir: p.dataDir });
  return { pinned: p.dataDir };
}
