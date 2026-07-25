/**
 * Project management: config schema, validation, registry, scaffolding, and
 * syntax-checked composition file writes.
 *
 * A "project" is a plain folder on disk:
 *
 *   my-project/
 *     project.json        <- config (this module owns its schema)
 *     composition.html    <- entry point loaded by the renderer
 *     composition.js      <- animation code (frame API)
 *     styles.css
 *     frame-api.js        <- copied runtime helpers (interpolate/Sequence/...)
 *     assets/             <- images, fonts, audio
 *     out/                <- render outputs (default)
 *
 * Projects created via MCP and via the WinForms UI are identical on disk
 * (spec §5.2). Both consumers share the same registry file so `list_projects`
 * shows the same set everywhere:
 *
 *   <dataDir>/projects.json   (dataDir default: ~/.motion-studio)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';
import { resolveInProject, ASSET_EXTENSIONS } from './sandbox.js';
import { FORMATS, getFormat, normalizeOutputFilename } from './formats.js';
import { getLibrary, libsVendorDir, LIBRARY_IDS } from './libraries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, '../../templates/default');
const TEMPLATES_ROOT = path.resolve(__dirname, '../../templates');
const RUNTIME_FRAME_API = path.resolve(__dirname, '../runtime/frame-api.js');

export const CONFIG_SCHEMA_VERSION = 2;

export function defaultDataDir() {
  return process.env.MOTION_STUDIO_HOME || path.join(os.homedir(), '.motion-studio');
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
      });
    }
    if (cfg.libraries !== undefined) {
      if (!Array.isArray(cfg.libraries) || cfg.libraries.some((l) => typeof l !== 'string'))
        problems.push('libraries: must be an array of strings');
    }
  }
  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, `Invalid project config: ${problems.join('; ')}`, { problems });
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
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export class ProjectStore {
  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
    this.registryPath = path.join(dataDir, 'projects.json');
    this.projectsRoot = path.join(dataDir, 'projects');
  }

  async _loadRegistry() {
    try {
      const raw = await fsp.readFile(this.registryPath, 'utf8');
      const reg = JSON.parse(raw);
      return Array.isArray(reg.projects) ? reg : { projects: [] };
    } catch {
      return { projects: [] };
    }
  }

  async _saveRegistry(reg) {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const tmp = this.registryPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(reg, null, 2));
    await fsp.rename(tmp, this.registryPath); // atomic on same volume
  }

  /** List registered projects, tolerating folders deleted out from under us. */
  async listProjects() {
    const reg = await this._loadRegistry();
    const out = [];
    for (const p of reg.projects) {
      const exists = fs.existsSync(path.join(p.path, 'project.json'));
      let lastModified = p.createdAt;
      if (exists) {
        try { lastModified = (await fsp.stat(path.join(p.path, 'project.json'))).mtime.toISOString(); } catch { /* keep */ }
      }
      out.push({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt, lastModified, missing: !exists });
    }
    return out;
  }

  async getProjectEntry(projectId) {
    const reg = await this._loadRegistry();
    const entry = reg.projects.find((p) => p.id === projectId);
    if (!entry) throw new EngineError(ErrorCodes.PROJECT_NOT_FOUND, `No project with id "${projectId}"`, { projectId });
    if (!fs.existsSync(path.join(entry.path, 'project.json'))) {
      throw new EngineError(ErrorCodes.PROJECT_NOT_FOUND, `Project folder missing on disk: ${entry.path}`, { projectId });
    }
    return entry;
  }

  async readConfig(projectId) {
    const entry = await this.getProjectEntry(projectId);
    const raw = await fsp.readFile(path.join(entry.path, 'project.json'), 'utf8');
    let cfg;
    try { cfg = JSON.parse(raw); }
    catch (e) { throw new EngineError(ErrorCodes.INVALID_CONFIG, `project.json is not valid JSON: ${e.message}`); }
    return validateConfig(migrateConfig(cfg));
  }

  async updateConfig(projectId, patch) {
    const entry = await this.getProjectEntry(projectId);
    const cfg = await this.readConfig(projectId);
    const ALLOWED = new Set(['fps', 'width', 'height', 'durationInFrames', 'audio', 'output', 'name', 'libraries']);
    for (const k of Object.keys(patch)) {
      if (!ALLOWED.has(k)) throw new EngineError(ErrorCodes.INVALID_CONFIG, `Config field "${k}" cannot be updated`, { field: k });
    }
    const next = validateConfig({ ...cfg, ...patch });
    // Keep the output filename's extension in lockstep with the format so a
    // format switch never silently produces "output.mp4" containing VP9.
    next.output = { ...next.output, filename: normalizeOutputFilename(next.output) };
    await fsp.writeFile(path.join(entry.path, 'project.json'), JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Scaffold a new project from the default template.
   * @returns {{id, name, path, config}}
   */
  async createProject({ name, fps, width, height, durationInFrames, dir = undefined }) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'Project name is required');
    }
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const projectPath = dir ? path.resolve(dir) : path.join(this.projectsRoot, slug);
    if (fs.existsSync(path.join(projectPath, 'project.json'))) {
      throw new EngineError(ErrorCodes.PROJECT_ALREADY_EXISTS, `A project already exists at ${projectPath}`, { path: projectPath });
    }

    const config = makeConfig({ name: name.trim(), fps, width, height, durationInFrames });
    await fsp.mkdir(path.join(projectPath, 'assets'), { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'out'), { recursive: true });

    // Template files with placeholder substitution.
    for (const file of await fsp.readdir(TEMPLATE_DIR)) {
      const content = await fsp.readFile(path.join(TEMPLATE_DIR, file), 'utf8');
      await fsp.writeFile(
        path.join(projectPath, file),
        content
          .replaceAll('__PROJECT_NAME__', config.name)
          .replaceAll('__FPS__', String(config.fps))
          .replaceAll('__DURATION__', String(config.durationInFrames))
          .replaceAll('__WIDTH__', String(config.width))
          .replaceAll('__HEIGHT__', String(config.height))
      );
    }
    // Runtime helper library is copied (not referenced) so projects are self-contained.
    await fsp.copyFile(RUNTIME_FRAME_API, path.join(projectPath, 'frame-api.js'));
    await fsp.writeFile(path.join(projectPath, 'project.json'), JSON.stringify(config, null, 2));

    const id = randomUUID();
    const reg = await this._loadRegistry();
    reg.projects.push({ id, name: config.name, path: projectPath, createdAt: new Date().toISOString() });
    await this._saveRegistry(reg);
    return { id, name: config.name, path: projectPath, config };
  }

  /* ------------------------------------------------------------------ */
  /* Composition files (sandboxed)                                       */
  /* ------------------------------------------------------------------ */

  async listFiles(projectId) {
    const entry = await this.getProjectEntry(projectId);
    const files = [];
    const walk = async (dir, rel) => {
      for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
        if (d.name === 'node_modules' || d.name === 'out' || d.name.startsWith('.')) continue;
        const abs = path.join(dir, d.name);
        const relPath = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) await walk(abs, relPath);
        else files.push({ path: relPath, size: (await fsp.stat(abs)).size });
      }
    };
    await walk(entry.path, '');
    return files;
  }

  async readFile(projectId, relPath) {
    const entry = await this.getProjectEntry(projectId);
    const abs = resolveInProject(entry.path, relPath);
    try {
      return await fsp.readFile(abs, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such file in project: ${relPath}`, { path: relPath });
      throw e;
    }
  }

  /**
   * Write a composition source file. JavaScript files are syntax-checked
   * before hitting disk (spec §5.7: fail fast at write time, not render time).
   */
  async writeFile(projectId, relPath, content) {
    const entry = await this.getProjectEntry(projectId);
    const abs = resolveInProject(entry.path, relPath, { forWrite: true });

    const ext = path.extname(abs).toLowerCase();
    if (ext === '.js' || ext === '.mjs') checkJsSyntax(content, relPath);
    if (ext === '.json') {
      try { JSON.parse(content); }
      catch (e) { throw new EngineError(ErrorCodes.SYNTAX_ERROR, `JSON parse error in ${relPath}: ${e.message}`, { path: relPath }); }
    }
    // Advisory only — a determinism violation still writes (v0.10).
    const warnings = checkDeterminism(content, relPath);

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
    return {
      path: relPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * Copy shared source files from one project to many (v0.11).
   *
   * docs/film-setup.md recommends that every scene project ship the *same*
   * `composition.js` and differ only in a small `scene.js` — but each project
   * holds its own copy, so editing the original reaches nothing already
   * scaffolded. On a 16-scene film that made a one-line art fix a 16-project
   * chore, which is exactly the kind of friction that discourages fixing it.
   *
   * Writes go through writeFile, so every target still gets the syntax check,
   * the determinism lint, and the atomic temp-and-rename.
   *
   * @param {object} opts
   * @param {string} opts.sourceProjectId  project holding the canonical copies
   * @param {string[]} opts.targetProjectIds  projects to overwrite (source is skipped if listed)
   * @param {string[]} opts.files  project-relative paths, e.g. ['composition.js']
   */
  async syncSharedFiles({ sourceProjectId, targetProjectIds, files }) {
    if (!files?.length) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'syncSharedFiles needs at least one file');
    }
    if (!targetProjectIds?.length) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'syncSharedFiles needs at least one target project');
    }
    // Read every source file before writing anything: a typo in the file list
    // should fail before it has half-updated the film.
    const body = {};
    for (const f of files) body[f] = await this.readFile(sourceProjectId, f);

    const results = [];
    for (const projectId of targetProjectIds) {
      if (projectId === sourceProjectId) continue;
      const written = [];
      for (const f of files) written.push(await this.writeFile(projectId, f, body[f]));
      results.push({ projectId, written });
    }
    return {
      sourceProjectId,
      files,
      projectsUpdated: results.length,
      results,
    };
  }

  /**
   * Write a binary asset (image / audio / font) from base64 into the
   * project's assets/ folder (v0.5). This is the only way binary content
   * enters a project through the tool surface: the destination is confined
   * to assets/, extensions are allow-listed, and the decoded size is capped.
   */
  async writeAssetFile(projectId, relPath, base64Content, { maxBytes = MAX_ASSET_BYTES } = {}) {
    const entry = await this.getProjectEntry(projectId);
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(
        ErrorCodes.PATH_OUTSIDE_PROJECT,
        `Assets must be written under assets/ (got "${relPath}")`,
        { path: relPath },
      );
    }
    const abs = resolveInProject(entry.path, normalized, { forWrite: true, asAsset: true });
    let buf;
    try {
      buf = Buffer.from(base64Content, 'base64');
    } catch (e) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `content is not valid base64: ${e.message}`);
    }
    if (buf.length === 0) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'decoded asset is empty');
    if (buf.length > maxBytes) {
      throw new EngineError(
        ErrorCodes.ASSET_TOO_LARGE,
        `Asset is ${buf.length} bytes; limit is ${maxBytes}. Place larger files in the project's assets/ folder manually.`,
        { bytes: buf.length, maxBytes },
      );
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
    return { path: normalized, bytes: buf.length };
  }

  /**
   * Attach an optional 3D library (v0.7). Copies the vendored library build
   * into the project (kept local so renders stay hermetic) and, unless
   * scaffold===false, replaces composition.html/js/css with the library's
   * frame-driven starter. Records the library id in config.libraries.
   * @returns {{library, name, version, global, copied, scaffolded, notes, config}}
   */
  async addLibrary(projectId, { library, scaffold = true, addons = [] } = {}) {
    const spec = getLibrary(library);
    if (!spec) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `Unknown library "${library}"; available: ${LIBRARY_IDS.join(', ')}`, { library });
    }
    // Resolve requested addons against the library's registry.
    const addonSpecs = [];
    for (const a of addons || []) {
      const av = spec.addons && spec.addons[a];
      if (!av) {
        throw new EngineError(ErrorCodes.INVALID_CONFIG, `Library "${spec.id}" has no addon "${a}"; available: ${Object.keys(spec.addons || {}).join(', ') || '(none)'}`, { library: spec.id, addon: a });
      }
      addonSpecs.push({ id: a, ...av });
    }

    const entry = await this.getProjectEntry(projectId);
    const cfg = await this.readConfig(projectId);
    const vendorDir = libsVendorDir();

    // 1) copy the vendored library + addon build(s) into the project
    const copied = [];
    for (const f of [...spec.files, ...addonSpecs]) {
      const srcAbs = path.join(vendorDir, f.vendor);
      if (!fs.existsSync(srcAbs)) {
        throw new EngineError(
          ErrorCodes.LIBRARY_UNAVAILABLE,
          `Library build not found: ${f.vendor}. Run "node scripts/fetch-libs.mjs ${spec.id}" in the engine folder (git-ignored, ~${spec.approxKB} KB).`,
          { library: spec.id, file: f.vendor },
        );
      }
      const abs = resolveInProject(entry.path, f.dest, { forWrite: true });
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.copyFile(srcAbs, abs);
      copied.push({ path: f.dest, bytes: (await fsp.stat(abs)).size });
    }

    // Addon <script> tags injected into the scaffolded HTML (after the core lib).
    const addonScripts = addonSpecs.map((a) => `<script src="${a.dest}"></script>`).join('\n  ');

    // 2) scaffold the starter composition (placeholder substitution) unless opted out
    const scaffolded = [];
    if (scaffold) {
      const tdir = path.join(TEMPLATES_ROOT, spec.template);
      for (const file of await fsp.readdir(tdir)) {
        const content = (await fsp.readFile(path.join(tdir, file), 'utf8'))
          .replaceAll('<!--__ADDONS__-->', addonScripts)
          .replaceAll('__PROJECT_NAME__', cfg.name)
          .replaceAll('__FPS__', String(cfg.fps))
          .replaceAll('__DURATION__', String(cfg.durationInFrames))
          .replaceAll('__WIDTH__', String(cfg.width))
          .replaceAll('__HEIGHT__', String(cfg.height));
        const abs = resolveInProject(entry.path, file, { forWrite: true });
        const tmp = abs + '.tmp-' + process.pid;
        await fsp.writeFile(tmp, content, 'utf8');
        await fsp.rename(tmp, abs);
        scaffolded.push(file);
      }
    }

    // 3) record the library in config
    const libs = Array.from(new Set([...(cfg.libraries || []), spec.id]));
    const config = await this.updateConfig(projectId, { libraries: libs });

    // Addon notes are appended to `notes` rather than dropped. The registry has
    // always carried them (e.g. the glTF addon's note that loading a model needs
    // MOTION_STUDIO_ALLOW_LOCAL_FETCH=1), but only spec.notes was returned, so a
    // core-level caller never saw them. `addons` deliberately stays a plain id
    // array — it is part of the tool's public result shape.
    const addonNotes = addonSpecs.filter((a) => a.note).map((a) => `[${a.id}] ${a.note}`);

    return {
      library: spec.id,
      name: spec.name,
      version: spec.version,
      global: spec.global,
      addons: addonSpecs.map((a) => a.id),
      copied,
      scaffolded,
      notes: [...(spec.notes ?? []), ...addonNotes],
      config,
    };
  }

  /**
   * Unregister a project (v0.5). Files are deleted only when deleteFiles is
   * true AND the folder lives under this store's managed projects root —
   * a registered project pointing at an arbitrary user folder is never
   * removed from disk by this tool.
   */
  async removeProject(projectId, { deleteFiles = false } = {}) {
    const reg = await this._loadRegistry();
    const idx = reg.projects.findIndex((p) => p.id === projectId);
    if (idx < 0) throw new EngineError(ErrorCodes.PROJECT_NOT_FOUND, `No project with id "${projectId}"`, { projectId });
    const entry = reg.projects[idx];
    reg.projects.splice(idx, 1);
    await this._saveRegistry(reg);

    let filesDeleted = false;
    if (deleteFiles) {
      const root = path.resolve(this.projectsRoot);
      const target = path.resolve(entry.path);
      const rel = path.relative(root, target);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        await fsp.rm(target, { recursive: true, force: true });
        filesDeleted = true;
      }
    }
    return { id: entry.id, name: entry.name, path: entry.path, unregistered: true, filesDeleted };
  }
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
