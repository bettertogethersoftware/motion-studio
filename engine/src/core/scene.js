/**
 * Scene composition model: config schema, validation, scaffolding, and the
 * source lints (syntax / determinism / canvas-state / sequence-coverage).
 *
 * A "scene" is a plain folder on disk — the unit the renderer consumes:
 *
 *   my-scene/
 *     scene.json          <- config (this module owns its schema)
 *     composition.html    <- entry point loaded by the renderer
 *     composition.js      <- animation code (frame API)
 *     styles.css
 *     frame-api.js        <- copied runtime helpers (interpolate/Sequence/...)
 *     assets/             <- images, fonts, audio
 *     out/                <- render outputs (default)
 *
 * Where scenes live — inside a film, inside a workspace — is owned by
 * core/store.js (WorkspaceStore). This module deliberately knows nothing
 * about that hierarchy: it takes absolute scene paths and config objects.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from './errors.js';
import { ASSET_EXTENSIONS } from './sandbox.js';
import { FORMATS } from './formats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, '../../templates/default');
export const TEMPLATES_ROOT = path.resolve(__dirname, '../../templates');
export const RUNTIME_FRAME_API = path.resolve(__dirname, '../runtime/frame-api.js');

export const CONFIG_SCHEMA_VERSION = 2;

/**
 * The scene config filename. One constant so the scaffolder, the store, the
 * sandbox denylist and the CLI cannot disagree about what makes a folder a
 * scene — its presence is the definition.
 */
export const SCENE_CONFIG = 'scene.json';

export function defaultDataDir() {
  return process.env.MOTION_STUDIO_HOME || path.join(os.homedir(), '.motion-studio');
}

/**
 * Lowercase a display name into a filesystem/id slug. Shared by every layer
 * that turns a human name into a folder: workspaces, films, and scenes all
 * use the same alphabet so an id is always a valid folder name and vice versa.
 */
export function slugify(name, fallback = 'untitled') {
  return String(name ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export function validateConfig(cfg) {
  const problems = [];
  const isPosInt = (v) => Number.isInteger(v) && v > 0;

  if (!cfg || typeof cfg !== 'object') problems.push('config must be an object');
  else {
    if (typeof cfg.name !== 'string' || !cfg.name.trim()) problems.push('name: non-empty string required');
    if (!isPosInt(cfg.fps) || cfg.fps > 240) problems.push('fps: integer in 1..240 required');
    if (!isPosInt(cfg.width) || cfg.width > 7680) problems.push('width: integer in 1..7680 required');
    if (!isPosInt(cfg.height) || cfg.height > 4320) problems.push('height: integer in 1..4320 required');
    if (!isPosInt(cfg.durationInFrames)) problems.push('durationInFrames: positive integer required');
    const format = cfg.output?.format ?? 'mp4';
    if (!FORMATS[format]) problems.push(`output.format: one of ${Object.keys(FORMATS).join(', ')}`);
    else {
      const fmt = FORMATS[format];
      if (fmt.requiresEvenDims && (cfg.width % 2 !== 0 || cfg.height % 2 !== 0))
        problems.push(`width/height must be even for ${format} (chroma-subsampled pixel formats)`);
      if (cfg.output?.transparent && !fmt.supportsAlpha)
        problems.push(`output.transparent: format "${format}" cannot carry an alpha channel (use webm, prores, or png-sequence)`);
    }
    if (cfg.output?.crf !== undefined && (!Number.isInteger(cfg.output.crf) || cfg.output.crf < 0 || cfg.output.crf > 63))
      problems.push('output.crf: integer in 0..63 required');
    if (cfg.output?.audioLimiter !== undefined && typeof cfg.output.audioLimiter !== 'boolean')
      problems.push('output.audioLimiter: boolean');
    if (typeof cfg.entry !== 'string' || !cfg.entry.endsWith('.html')) problems.push('entry: path to an .html file required');
    if (cfg.audio !== undefined) {
      if (!Array.isArray(cfg.audio)) problems.push('audio: must be an array of tracks');
      else cfg.audio.forEach((t, i) => {
        if (!t || typeof t.src !== 'string') problems.push(`audio[${i}].src: string required`);
        if (t.startInFrames !== undefined && (!Number.isInteger(t.startInFrames) || t.startInFrames < 0))
          problems.push(`audio[${i}].startInFrames: non-negative integer`);
        if (t.gainDb !== undefined && typeof t.gainDb !== 'number') problems.push(`audio[${i}].gainDb: number`);
        // v0.19: clip-relative trim + fades (frames, like everything else here)
        for (const key of ['trimEndInFrames', 'fadeInFrames', 'fadeOutFrames']) {
          if (t[key] !== undefined && (!Number.isInteger(t[key]) || t[key] < 0))
            problems.push(`audio[${i}].${key}: non-negative integer`);
        }
        if (t.trimEndInFrames !== undefined && t.trimEndInFrames === 0)
          problems.push(`audio[${i}].trimEndInFrames: must be >= 1 (0 would silence the track)`);
        if (t.duck !== undefined && typeof t.duck !== 'boolean')
          problems.push(`audio[${i}].duck: boolean`);
      });
    }
    if (cfg.libraries !== undefined) {
      if (!Array.isArray(cfg.libraries) || cfg.libraries.some((l) => typeof l !== 'string'))
        problems.push('libraries: must be an array of strings');
    }
    // Provenance for vendored library builds (v0.13): which bytes this scene
    // actually holds, so a render can be traced to an exact build. The vendor dir
    // is git-ignored and a version string is not enough to identify a build, so
    // the hash is the identity — see core/vendor-lock.js.
    if (cfg.libraryBuilds !== undefined) {
      const b = cfg.libraryBuilds;
      if (b === null || typeof b !== 'object' || Array.isArray(b)) {
        problems.push('libraryBuilds: must be an object keyed by scene-relative file path');
      } else {
        for (const [k, v] of Object.entries(b)) {
          if (!v || typeof v !== 'object' || typeof v.sha256 !== 'string' || typeof v.bytes !== 'number') {
            problems.push(`libraryBuilds.${k}: must be { sha256: string, bytes: number, version?: string|null }`);
          }
        }
      }
    }
  }
  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, `Invalid scene config: ${problems.join('; ')}`, { problems });
  }
  return cfg;
}

export function makeConfig({ name, fps = 30, width = 1920, height = 1080, durationInFrames = 150, audio = undefined }) {
  const cfg = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name,
    fps,
    width,
    height,
    durationInFrames,
    entry: 'composition.html',
    output: { dir: 'out', filename: 'output.mp4', format: 'mp4', transparent: false, crf: 18, preset: 'medium', pixFmt: 'yuv420p', audioLimiter: true },
    ...(audio ? { audio } : {}),
  };
  return validateConfig(cfg);
}

/**
 * Migrate an older on-disk config to the current schema (non-destructive:
 * callers decide whether to persist). v1 → v2 adds output.format ("mp4") and
 * output.transparent (false).
 */
export function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = { ...cfg };
  if ((out.schemaVersion ?? 1) < 2) {
    out.output = { format: 'mp4', transparent: false, ...(out.output ?? {}) };
    out.schemaVersion = 2;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Scaffolding                                                         */
/* ------------------------------------------------------------------ */

/**
 * Materialize a scene folder from the default template: assets/ + out/, the
 * template files with placeholders substituted, the copied frame-api runtime,
 * and the validated scene.json. The caller (WorkspaceStore) owns *where*
 * the folder lives and having checked that nothing is already there.
 */
export async function scaffoldSceneFiles(scenePath, config) {
  if (fs.existsSync(path.join(scenePath, SCENE_CONFIG))) {
    throw new EngineError(ErrorCodes.SCENE_ALREADY_EXISTS, `A scene already exists at ${scenePath}`, { path: scenePath });
  }
  await fsp.mkdir(path.join(scenePath, 'assets'), { recursive: true });
  await fsp.mkdir(path.join(scenePath, 'out'), { recursive: true });

  // Template files with placeholder substitution.
  for (const file of await fsp.readdir(TEMPLATE_DIR)) {
    const content = await fsp.readFile(path.join(TEMPLATE_DIR, file), 'utf8');
    await fsp.writeFile(
      path.join(scenePath, file),
      content
        .replaceAll('__SCENE_NAME__', config.name)
        .replaceAll('__FPS__', String(config.fps))
        .replaceAll('__DURATION__', String(config.durationInFrames))
        .replaceAll('__WIDTH__', String(config.width))
        .replaceAll('__HEIGHT__', String(config.height))
    );
  }
  // Runtime helper library is copied (not referenced) so scenes are self-contained.
  await fsp.copyFile(RUNTIME_FRAME_API, path.join(scenePath, 'frame-api.js'));
  await fsp.writeFile(path.join(scenePath, SCENE_CONFIG), JSON.stringify(config, null, 2));
}

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export { ASSET_EXTENSIONS };

/* ------------------------------------------------------------------ */
/* Determinism lint (v0.10)                                            */
/* ------------------------------------------------------------------ */

/**
 * The frame-driven contract bans wall-clock time and unseeded randomness, but
 * until now nothing checked it: a composition using Date.now() wrote cleanly and
 * only misbehaved under parallel or out-of-order rendering, which is the hardest
 * class of bug to notice from a still. These are WARNINGS, never write
 * rejections — a loader outside the frame function may legitimately use a timer,
 * and refusing the write would be worse than flagging it.
 *
 * Deliberately regex-based: the engine keeps its dependency list short (see
 * cli/render.js on arg parsing), and vm.Script gives a compile check but no AST.
 * Blanking comments and string literals first removes the false positives that
 * would otherwise make this noise — the scaffold's own header comment names
 * three of the banned APIs.
 */

/** Blank JS comments and string literals in place, preserving offsets/lines. */
function blankJs(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, j + 2); i = j + 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        if (c !== '`' && src[j] === '\n') break; // unterminated literal; stop at EOL
        j++;
      }
      blank(i, j + 1); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/** Blank CSS block comments only — `//` is not a CSS comment and appears in url(http://…). */
function blankCss(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      for (let k = i; k < Math.min(n, j + 2); k++) if (out[k] !== '\n') out[k] = ' ';
      i = j + 2; continue;
    }
    i++;
  }
  return out.join('');
}

const JS_RULES = [
  { rule: 'date-now', re: /\bDate\s*\.\s*now\s*\(/g,
    message: 'Date.now() reads the wall clock. Derive the value from `frame` instead.' },
  { rule: 'performance-now', re: /\bperformance\s*\.\s*now\s*\(/g,
    message: 'performance.now() reads the wall clock. Derive the value from `frame` instead.' },
  { rule: 'new-date', re: /\bnew\s+Date\s*\(\s*\)/g,
    message: 'new Date() reads the wall clock. Derive the value from `frame` instead.' },
  { rule: 'set-timeout', re: /\bsetTimeout\s*\(/g,
    message: 'setTimeout does not advance with the frame number; sequence with Sequence(from, duration, fn).' },
  { rule: 'set-interval', re: /\bsetInterval\s*\(/g,
    message: 'setInterval does not advance with the frame number; loop with Loop(durationInFrames, fn).' },
  { rule: 'request-animation-frame', re: /\brequestAnimationFrame\s*\(/g,
    message: 'requestAnimationFrame is wall-clock driven. The engine calls setFrame(n) once per frame instead.' },
  { rule: 'math-random', re: /\bMath\s*\.\s*random\s*\(/g,
    message: 'Math.random() is not reproducible across workers. Use MotionStudio.random(seed).' },
  { rule: 'three-clock', re: /\bTHREE\s*\.\s*Clock\b|\.\s*getDelta\s*\(/g,
    message: 'THREE.Clock/getDelta() measure real elapsed time. Compute transforms from `frame`.' },
  { rule: 'babylon-render-loop', re: /\.\s*runRenderLoop\s*\(/g,
    message: 'engine.runRenderLoop() drives itself off the wall clock. Call scene.render() inside setFrame.' },
  { rule: 'babylon-begin-animation', re: /\.\s*beginAnimation\s*\(/g,
    message: 'scene.beginAnimation() is wall-clock based. Animate transforms from `frame`.' },
  // Persistent DOM state (v0.22): classList.add/remove inside composition code
  // accumulates across frames — a class added at frame N is still there at
  // frame N+1000, and NEVER there for a worker that starts mid-composition.
  // The real-world failure: sections shown by adding a class when their
  // Sequence first runs, "hidden" by a reset that only selects that class — so
  // every section whose time hasn't come yet is fully visible over the current
  // one. classList.toggle(name, condition) is exempt: with a boolean it sets
  // an absolute per-frame state, which is the correct pattern.
  //
  // "section", not "scene": this is about several parts of ONE composition. A
  // scene is a whole composition folder in its own right (core/store.js), and
  // splitting into real scenes is the better fix when a composition gets long.
  { rule: 'classlist-mutation', re: /\bclassList\s*\.\s*(?:add|remove)\s*\(/g,
    message: 'classList.add/remove persists across frames and breaks frame purity — a worker starting mid-render ' +
      'never sees classes earlier frames would have added. Hide section containers by DEFAULT in CSS and have each ' +
      'Sequence only turn its own section on (direct style writes, or classList.toggle(name, condition) which sets ' +
      'an absolute state every frame).' },
];

const CSS_RULES = [
  { rule: 'css-transition', re: /(?:^|[;{\s])transition(?:-duration)?\s*:([^;}]*)/gi,
    message: 'CSS transitions run on real time, not frame number. Compute the final value and set it directly.' },
  { rule: 'css-animation', re: /(?:^|[;{\s])animation(?:-duration)?\s*:([^;}]*)/gi,
    message: 'CSS animations run on real time, not frame number. Drive the property from `frame` instead.' },
];

/** True if a CSS value carries a non-zero time — `transition: none` is harmless. */
function hasNonZeroTime(value = '') {
  const re = /(\d*\.?\d+)\s*(ms|s)\b/gi;
  let m;
  while ((m = re.exec(value))) if (Number(m[1]) > 0) return true;
  return false;
}

/**
 * Scan composition source for frame-driven contract violations.
 * @returns {{rule: string, line: number, snippet: string, message: string}[]}
 */
export function checkDeterminism(source, filename = 'composition.js') {
  const ext = path.extname(filename).toLowerCase();
  const isCss = ext === '.css';
  if (!isCss && ext !== '.js' && ext !== '.mjs') return [];

  const scanned = isCss ? blankCss(source) : blankJs(source);
  const lines = source.split('\n');
  const warnings = [];

  for (const { rule, re, message } of isCss ? CSS_RULES : JS_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanned))) {
      if (isCss && !hasNonZeroTime(m[1])) continue;
      const line = scanned.slice(0, m.index).split('\n').length;
      warnings.push({ rule, line, snippet: (lines[line - 1] ?? '').trim().slice(0, 120), message });
      if (warnings.length >= 50) return warnings; // pathological input; stop scanning
    }
  }
  return warnings.sort((a, b) => a.line - b.line);
}

/**
 * Canvas save/restore balance check (v0.22).
 *
 * `ctx.save()` without a matching `ctx.restore()` leaves the transform, clip
 * and style stack mutated for EVERY later draw call in that frame — the title,
 * the letterbox, the vignette all silently relocate or vanish. It is the
 * canvas twin of the DOM-state rule above: state that outlives the drawing it
 * belonged to. Cost a whole scene in a real film; nothing flagged it, because
 * the code is perfectly valid JavaScript and the frame still renders.
 *
 * Scoped per function body — declarations, function expressions and arrow
 * functions with a block body, since drawing helpers are written in all three
 * (`.forEach((p) => { ctx.save(); … })` is as common as a named helper).
 * Whole-file counting would instead flag legitimate conditional pairs.
 *
 * A nested offender makes its enclosing scopes look unbalanced too, so only
 * the INNERMOST unbalanced scope is reported — that is the one to fix.
 */
export function checkCanvasStateBalance(source) {
  const scanned = blankJs(source);
  const lines = source.split('\n');

  // Every construct whose body is a `{ … }` block we should balance-check.
  // The capture group, where present, is the name we can show the author.
  const OPENERS = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/g,        // function decl + expr
    // named arrow — parenthesised or bare single param
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
    /(?:async\s+)?\([^)]*\)\s*=>\s*\{/g,                                // inline arrow, e.g. forEach
    // bare single-param arrow; the identifier is the PARAMETER, not a name to
    // report, so it is deliberately not captured.
    /(?:async\s+)?(?:[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
  ];

  const scopes = [];
  for (const re of OPENERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanned))) {
      const open = scanned.indexOf('{', m.index + m[0].length - 1);
      if (open < 0) continue;
      let depth = 0, end = -1;
      for (let i = open; i < scanned.length; i++) {
        if (scanned[i] === '{') depth++;
        else if (scanned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      const body = scanned.slice(open, end);
      const saves = (body.match(/\.\s*save\s*\(\s*\)/g) ?? []).length;
      const restores = (body.match(/\.\s*restore\s*\(\s*\)/g) ?? []).length;
      if (saves > restores) scopes.push({ start: m.index, end, name: m[1], saves, restores });
    }
  }

  // Keep only innermost offenders, and one warning per body.
  const seen = new Set();
  return scopes
    // Strictly-nested only: several patterns can match the SAME body (a named
    // arrow also matches the inline-arrow pattern), and those are one function,
    // not an outer and an inner. Same `end` ⇒ same body ⇒ dedupe below keeps
    // the first, which is the pattern that knows the name.
    .filter((s) => !scopes.some((o) => o.start > s.start && o.end < s.end))
    .filter((s) => (seen.has(s.end) ? false : seen.add(s.end)))
    .map((s) => {
      const line = scanned.slice(0, s.start).split('\n').length;
      const who = s.name ? `${s.name}()` : `the function at line ${line}`;
      return {
        rule: 'canvas-save-restore',
        line,
        snippet: (lines[line - 1] ?? '').trim().slice(0, 120),
        message: `${who} calls save() ${s.saves}× but restore() ${s.restores}× — an unrestored canvas state leaks its ` +
          'transform/clip/style into every later draw call in the frame (titles and overlays end up moved or ' +
          'invisible). Pair every save() with a restore().',
      };
    })
    .sort((a, b) => a.line - b.line);
}

/**
 * Static Sequence-coverage check (v0.22). A long composition is usually a
 * chain of literal `Sequence(start, duration, …)` calls; when they don't tile
 * the configured duration, the result is dead air (a gap nothing animates) or
 * a scene that never plays — both invisible to the determinism lint and to a
 * spot-check of frames that happen to land inside covered ranges. The
 * real-world failure: a 4,840-frame film with a 298-frame hole where one
 * Sequence's duration was retimed but not recomputed.
 *
 * Only literal number pairs are considered, and only when there are at least
 * two of them — dynamically computed sequences (variables, arithmetic) make
 * coverage unknowable statically, and a single Sequence is usually a partial
 * overlay by design. Advisory, never a rejection, same contract as
 * checkDeterminism.
 */
export function checkSequenceCoverage(source, durationInFrames, { gapFrames = 30 } = {}) {
  if (!Number.isInteger(durationInFrames) || durationInFrames <= 0) return [];
  const scanned = blankJs(source);
  const calls = [];
  const re = /\bSequence\s*\(\s*(\d+)\s*,\s*(\d+)/g;
  let m;
  while ((m = re.exec(scanned))) {
    calls.push({
      start: Number(m[1]),
      end: Number(m[1]) + Number(m[2]),
      line: scanned.slice(0, m.index).split('\n').length,
    });
  }
  if (calls.length < 2) return [];

  const lines = source.split('\n');
  const snippetAt = (line) => (lines[line - 1] ?? '').trim().slice(0, 120);
  const warnings = [];
  const warn = (line, message) =>
    warnings.push({ rule: 'sequence-gap', line, snippet: snippetAt(line), message });

  // Merge into covered intervals, then walk for holes.
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  let coveredEnd = 0;
  for (const c of sorted) {
    if (c.start > coveredEnd + gapFrames) {
      warn(c.line,
        `Sequence coverage gap: frames ${coveredEnd}–${c.start} have no Sequence scheduled — ` +
        `${c.start - coveredEnd} frames of dead air unless a base layer animates there.`);
    }
    coveredEnd = Math.max(coveredEnd, Math.min(c.end, durationInFrames));
  }
  if (coveredEnd < durationInFrames - gapFrames) {
    warn(sorted[sorted.length - 1].line,
      `Sequence coverage ends at frame ${coveredEnd} but the composition runs to ` +
      `${durationInFrames} — the last ${durationInFrames - coveredEnd} frames have no Sequence scheduled.`);
  }
  return warnings;
}

/**
 * Compile-check JavaScript without executing it. Catches SyntaxError with
 * line/column so an agent gets an actionable tool error instead of a broken
 * render later. Classic-script compile covers the template's script style;
 * ESM sources ("import"/"export") are compile-checked via the module path.
 */
export function checkJsSyntax(source, filename = 'composition.js') {
  const looksEsm = /^\s*(import|export)\s/m.test(source);
  try {
    if (looksEsm) {
      // vm.SourceTextModule needs a flag; a Function-wrapper trick misparses ESM.
      // Fallback: strip to a compile check via dynamic module is unavailable,
      // so approximate with a Script check of the transformed source.
      new vm.Script(source.replace(/^\s*import\s[^;]+;?/gm, '').replace(/^\s*export\s+/gm, ''), { filename });
    } else {
      new vm.Script(source, { filename });
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new EngineError(ErrorCodes.SYNTAX_ERROR, `Syntax error in ${filename}: ${e.message}`, {
        path: filename,
        stack: String(e.stack || '').split('\n').slice(0, 5).join('\n'),
      });
    }
    throw e;
  }
}
