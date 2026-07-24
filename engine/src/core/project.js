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
    output: { dir: 'out', filename: 'output.mp4', format: 'mp4', transparent: false, crf: 18, preset: 'medium', pixFmt: 'yuv420p' },
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

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
    return { path: relPath, bytes: Buffer.byteLength(content, 'utf8') };
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

    return { library: spec.id, name: spec.name, version: spec.version, global: spec.global, addons: addonSpecs.map((a) => a.id), copied, scaffolded, notes: spec.notes, config };
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
