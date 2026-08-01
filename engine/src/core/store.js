/**
 * WorkspaceStore — the storage model, v0.20.
 *
 * The filesystem is the registry. Everything lives under one data dir
 * (default ~/.motion-studio, override MOTION_STUDIO_HOME):
 *
 *   <dataDir>/
 *     settings.json
 *     workspaces/
 *       <workspace>/            one per AI (and any the human creates)
 *         workspace.json        { name, createdAt } — display metadata only
 *         library/              human-managed shared assets (large files);
 *                               scenes pull from it via useLibraryAsset()
 *         films/
 *           <film>/
 *             film.json         the film document (core/films.js owns schema)
 *             assets/           master audio / overlay files for the film
 *             out/              the built film (+ .srt sidecar)
 *             scenes/
 *               <scene>/        scene.json + the composition (core/scene.js)
 *
 * Identity is the slug path: a workspace is "<ws>", a film "<ws>/<film>",
 * a scene "<ws>/<film>/<scene>". Slugs share one alphabet (see slugify) so
 * every id is exactly its folder path relative to workspaces/ — copying a
 * film folder into another workspace IS moving the film. There are no
 * registry files to fall out of sync and no UUIDs to resolve: presence of
 * film.json makes a film, presence of scene.json makes a scene.
 *
 * Why this shape (v0.20, replacing the flat projects/ + projects.json +
 * films.json model):
 *   - a "project" was really a scene of a film; the hierarchy now says so;
 *   - films used a by-convention "<name> — Master" output project to hold
 *     master audio and the built file — the film folder itself now holds
 *     assets/ and out/, so that hack is gone;
 *   - every agent dumped scenes into one shared folder; workspaces give each
 *     AI its own tree while the Studio (the human) sees them all;
 *   - concurrent writers now touch disjoint files in the common case (each
 *     film document is its own file), where the shared registries were a
 *     lost-update hazard.
 *
 * Concurrency: writes are atomic (temp + rename). Cross-process render
 * collisions are prevented by core/lock.js, not by this store.
 *
 * Two writers editing the SAME film.json used to be last-write-wins. That is
 * not survivable for films specifically, because a film patch REPLACES whole
 * arrays: a writer holding a page-load-old `scenes` snapshot does not lose its
 * own field, it reverts every scene edit anyone made in between, silently. An
 * open Studio tab did exactly that to an agent's scene reorder. So getFilm now
 * returns a `revision` (a hash of the stored document) and updateFilm takes an
 * optional `expectedRevision`; a mismatch is FILM_CONFLICT rather than a write.
 * Optional, not mandatory: internal single-field callers below (createScene,
 * removeScene, renameAsset) read-modify-write in the same tick and would only
 * be made noisier by it. The two writers that hold a snapshot across human or
 * agent think-time — the Studio film page and the update_film tool — send it.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';
import { resolveInTarget } from './sandbox.js';
import { defaultDataDir, workspacesRootFor } from './paths.js';
import {
  slugify, makeConfig, validateConfig, migrateConfig,
  scaffoldSceneFiles, MAX_ASSET_BYTES, TEMPLATES_ROOT, SCENE_CONFIG,
  checkJsSyntax, checkDeterminism, checkCanvasStateBalance, checkSequenceCoverage,
} from './scene.js';
import { normalizeOutputFilename } from './formats.js';
import { validateFilm, normalizeFilm } from './films.js';
import { getLibrary, libsVendorDir, LIBRARY_IDS, addonFiles } from './libraries.js';
import { detectVersion, sha256 } from './vendor-lock.js';
import { migrateLegacyLayout } from './migrate.js';

const SLUG_RE = /^[a-z0-9_][a-z0-9-_]*$/;

export const FILM_SCHEMA_VERSION = 1;

/** Reserved names that cannot be scene/film/workspace slugs. */
const RESERVED = new Set(['assets', 'out', 'scenes', 'films', 'library', 'node_modules']);

function checkSlug(part, what) {
  if (!SLUG_RE.test(part) || RESERVED.has(part)) {
    throw new EngineError(ErrorCodes.INVALID_ID,
      `Invalid ${what} "${part}" — ids are lowercase slugs (a-z, 0-9, "-", "_")`, { [what]: part });
  }
  return part;
}

/**
 * Split and validate an id. Depth 1 = workspace, 2 = film, 3 = scene.
 * Slug validation doubles as path-safety: a valid slug can never contain
 * separators, dots, or drive letters, so joining parts under workspacesRoot
 * cannot escape it.
 */
export function parseId(id, depth, what) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new EngineError(ErrorCodes.INVALID_ID, `A ${what} id is required`, { id });
  }
  const parts = id.trim().replace(/\\/g, '/').split('/');
  if (parts.length !== depth) {
    const shapes = ['"<workspace>"', '"<workspace>/<film>"', '"<workspace>/<film>/<scene>"'];
    throw new EngineError(ErrorCodes.INVALID_ID,
      `"${id}" is not a ${what} id — expected ${shapes[depth - 1]}`, { id });
  }
  const names = ['workspace', 'film', 'scene'];
  parts.forEach((p, i) => checkSlug(p, names[i]));
  return parts;
}

/**
 * An opaque tag for one state of a film document, used for optimistic
 * concurrency (see updateFilm). Derived, never stored — the file on disk stays
 * the plain document it always was, and an editor that hand-edits film.json
 * gets a new revision for free.
 *
 * Hashes the document as read. That includes `updatedAt`, so two saves that
 * change nothing still produce different revisions; that costs a caller one
 * harmless re-read and is the safe direction to be wrong in. Key order comes
 * from the file, and every write here goes through JSON.stringify of the
 * validated document, so it round-trips stably.
 */
export function filmRevision(doc) {
  return createHash('sha1').update(JSON.stringify(doc ?? null)).digest('hex').slice(0, 12);
}

/**
 * Audio tracks in a track list whose src points at `relPath`.
 *
 * Comparison is deliberately lenient — slashes normalized, leading "./"
 * dropped, case-insensitive — because the goal is to *catch* a reference
 * before the file disappears under it. A missed match means a build that
 * fails at the mux step with a confusing ffmpeg error; a false match only
 * means the UI offers to fix one extra track, which the user can decline.
 */
export function audioRefs(tracks, relPath) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const target = norm(relPath);
  return (tracks ?? [])
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => norm(track.src) === target);
}

/**
 * How many of a film's timeline segments are this footage file (v0.22).
 *
 * The twin of audioRefs, for the same reason it exists: a dangling reference does
 * not fail at delete time, it fails much later as a build error naming a missing
 * input. Footage segments were invisible to that machinery, so deleting a clip a
 * film plays reported `audioRefs: 0` and succeeded quietly.
 */
export function footageRefs(scenes, relPath) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const target = norm(relPath);
  return (scenes ?? [])
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment?.footage !== undefined && norm(segment.footage) === target);
}

const ASSET_KINDS = (ext) => {
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) return 'audio';
  if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext)) return 'font';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  return 'data';
};

export class WorkspaceStore {
  /**
   * @param {string} [dataDir]  the storage root (core/paths.js decides the default)
   * @param {object} [opts]
   * @param {string} [opts.workspacesRoot]  where the workspace tree lives; defaults
   *   to <dataDir>/workspaces, or to the configured override when `dataDir` is the
   *   machine's configured one (v0.22 — see core/paths.js on why it is scoped
   *   that way rather than applied to every data dir a caller might name).
   */
  constructor(dataDir = defaultDataDir(), { workspacesRoot } = {}) {
    this.dataDir = dataDir;
    this.workspacesRoot = workspacesRoot ?? workspacesRootFor(dataDir);
    this._ready = null;
  }

  /**
   * One-time startup work: migrate a pre-v0.20 flat layout if present.
   * Entry points (MCP server, Studio server) await this before serving;
   * it is memoized so calling it again is free.
   *
   * A FAILED migration is deliberately not memoized. The Studio awaits this
   * on every request, so caching the rejection would turn one transient
   * failure — a file locked by a backup scanner, say — into a server that
   * stays broken until restarted, even after the cause is gone. Migration is
   * resumable by design (see core/migrate.js), so retrying is the right
   * behaviour; the caller still sees the error each time it fails.
   */
  ready() {
    if (!this._ready) {
      this._ready = migrateLegacyLayout(this.dataDir, { workspacesRoot: this.workspacesRoot }).catch((err) => {
        this._ready = null;
        throw err;
      });
    }
    return this._ready;
  }

  /* ---------------------------------------------------------------- */
  /* Paths                                                             */
  /* ---------------------------------------------------------------- */

  workspacePath(ws) {
    return path.join(this.workspacesRoot, ...parseId(ws, 1, 'workspace'));
  }

  libraryPath(ws) {
    return path.join(this.workspacePath(ws), 'library');
  }

  filmPath(filmId) {
    const [ws, film] = parseId(filmId, 2, 'film');
    return path.join(this.workspacesRoot, ws, 'films', film);
  }

  scenePath(sceneId) {
    const [ws, film, scene] = parseId(sceneId, 3, 'scene');
    return path.join(this.workspacesRoot, ws, 'films', film, 'scenes', scene);
  }

  _filmDocPath(filmPath) {
    return path.join(filmPath, 'film.json');
  }

  /* ---------------------------------------------------------------- */
  /* Workspaces                                                        */
  /* ---------------------------------------------------------------- */

  /** All workspaces on disk, sorted by slug. */
  async listWorkspaces() {
    let entries;
    try { entries = await fsp.readdir(this.workspacesRoot, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const d of entries) {
      if (!d.isDirectory() || !SLUG_RE.test(d.name)) continue;
      const wsPath = path.join(this.workspacesRoot, d.name);
      let name = d.name;
      try { name = JSON.parse(await fsp.readFile(path.join(wsPath, 'workspace.json'), 'utf8')).name || d.name; }
      catch { /* folder without metadata is still a workspace */ }
      const films = await this.listFilms(d.name).catch(() => []);
      out.push({ id: d.name, name, path: wsPath, films: films.length });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Resolve a workspace, throwing workspace_not_found if absent. */
  async getWorkspace(ws) {
    const wsPath = this.workspacePath(ws);
    if (!fs.existsSync(wsPath)) {
      throw new EngineError(ErrorCodes.WORKSPACE_NOT_FOUND, `No workspace "${ws}"`, { workspace: ws });
    }
    let name = ws;
    try { name = JSON.parse(await fsp.readFile(path.join(wsPath, 'workspace.json'), 'utf8')).name || ws; }
    catch { /* metadata optional */ }
    return { id: parseId(ws, 1, 'workspace')[0], name, path: wsPath };
  }

  /**
   * Create a workspace if it does not exist; either way return it. Accepts a
   * display name — the slug is derived — so both "Claude Desktop" and
   * "claude-desktop" land in the same folder. This is how an MCP server
   * binds its MOTION_STUDIO_WORKSPACE on first use.
   */
  async ensureWorkspace(nameOrSlug) {
    const slug = checkSlug(slugify(nameOrSlug, 'default'), 'workspace');
    const wsPath = path.join(this.workspacesRoot, slug);
    const metaPath = path.join(wsPath, 'workspace.json');
    const created = !fs.existsSync(metaPath);
    await fsp.mkdir(path.join(wsPath, 'films'), { recursive: true });
    await fsp.mkdir(path.join(wsPath, 'library'), { recursive: true });
    if (created) {
      const meta = { name: String(nameOrSlug ?? slug).trim() || slug, createdAt: new Date().toISOString() };
      await this._writeJsonAtomic(metaPath, meta);
    }
    return { id: slug, ...(await this.getWorkspace(slug)), created };
  }

  /* ---------------------------------------------------------------- */
  /* Films                                                             */
  /* ---------------------------------------------------------------- */

  async _readFilmDoc(filmPath, filmId) {
    let raw;
    try { raw = await fsp.readFile(this._filmDocPath(filmPath), 'utf8'); }
    catch {
      throw new EngineError(ErrorCodes.FILM_NOT_FOUND, `No film "${filmId}"`, { filmId });
    }
    let doc;
    try { doc = JSON.parse(raw); }
    catch (e) {
      throw new EngineError(ErrorCodes.INVALID_FILM, `film.json for "${filmId}" is not valid JSON: ${e.message}`, { filmId });
    }
    return doc;
  }

  async _writeJsonAtomic(abs, obj) {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, abs); // atomic on same volume
  }

  async _writeFilmDoc(filmPath, doc) {
    await this._writeJsonAtomic(this._filmDocPath(filmPath), doc);
  }

  /**
   * Create a film in a workspace. `sceneDefaults` (fps/width/height/
   * durationInFrames, all optional) seed every scene created inside the film,
   * which is how the lossless-concat consistency invariant — all scenes share
   * resolution/fps — becomes the default instead of a discipline.
   */
  async createFilm(ws, {
    name, slug = undefined, sceneDefaults = undefined, outputFilename = undefined, deliverables = undefined,
  } = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new EngineError(ErrorCodes.INVALID_FILM, 'Film name is required', { problems: ['name is required'] });
    }
    await this.getWorkspace(ws);
    const filmSlug = checkSlug(slug ?? slugify(name), 'film');
    const filmId = `${ws}/${filmSlug}`;
    const filmPath = this.filmPath(filmId);
    if (fs.existsSync(this._filmDocPath(filmPath))) {
      throw new EngineError(ErrorCodes.FILM_ALREADY_EXISTS, `A film already exists at ${filmId}`, { filmId });
    }
    const now = new Date().toISOString();
    const doc = validateFilm({
      ...normalizeFilm({
        name: name.trim(), sceneDefaults,
        ...(outputFilename ? { outputFilename } : {}),
        ...(deliverables !== undefined ? { deliverables } : {}),
      }),
      schemaVersion: FILM_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await fsp.mkdir(path.join(filmPath, 'assets'), { recursive: true });
    await fsp.mkdir(path.join(filmPath, 'out'), { recursive: true });
    await fsp.mkdir(path.join(filmPath, 'scenes'), { recursive: true });
    await this._writeFilmDoc(filmPath, doc);
    return this.getFilm(filmId);
  }

  /** Films in a workspace: light listing (no plan resolution). */
  async listFilms(ws) {
    const wsPath = this.workspacePath(ws);
    let entries;
    try { entries = await fsp.readdir(path.join(wsPath, 'films'), { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const d of entries) {
      if (!d.isDirectory() || !SLUG_RE.test(d.name)) continue;
      const filmId = `${ws}/${d.name}`;
      try {
        const doc = await this._readFilmDoc(path.join(wsPath, 'films', d.name), filmId);
        out.push({
          id: filmId,
          slug: d.name,
          name: doc.name ?? d.name,
          scenes: Array.isArray(doc.scenes) ? doc.scenes.length : 0,
          updatedAt: doc.updatedAt ?? null,
          createdAt: doc.createdAt ?? null,
        });
      } catch {
        // A folder with a broken/missing film.json is reported, not hidden —
        // hiding it would make "where did my film go" undiagnosable from the UI.
        out.push({ id: filmId, slug: d.name, name: d.name, scenes: 0, broken: true });
      }
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** The full film document plus its identity/paths and its `revision`. */
  async getFilm(filmId) {
    const [ws, slug] = parseId(filmId, 2, 'film');
    const filmPath = this.filmPath(filmId);
    const doc = await this._readFilmDoc(filmPath, filmId);
    return {
      ...doc, id: `${ws}/${slug}`, workspace: ws, slug, path: filmPath, revision: filmRevision(doc),
    };
  }

  /**
   * Merge a patch into a film document. Only document fields are accepted,
   * and array fields REPLACE (a timeline edit is a statement of the whole
   * track — merging item-by-item would need addressing semantics no caller
   * wants).
   *
   * Because arrays replace, a caller that read the film and then thought for a
   * while is proposing to undo everything written in between. Pass the
   * `revision` from that read as `expectedRevision` and this refuses with
   * FILM_CONFLICT instead. Omitting it keeps the old last-write-wins behaviour,
   * which is correct only for read-modify-write within the same tick.
   */
  async updateFilm(filmId, patch, { expectedRevision = undefined } = {}) {
    const ALLOWED = new Set(['name', 'scenes', 'outputFilename', 'audio', 'overlays', 'captions',
      'captionStyle', 'sequences', 'audioTargetPeakDb', 'burnCaptions', 'review', 'sceneDefaults', 'deliverables']);
    for (const k of Object.keys(patch ?? {})) {
      if (!ALLOWED.has(k)) throw new EngineError(ErrorCodes.INVALID_FILM, `Film field "${k}" cannot be updated`, { field: k });
    }
    const cur = await this.getFilm(filmId);
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== cur.revision) {
      throw new EngineError(
        ErrorCodes.FILM_CONFLICT,
        `"${filmId}" changed since you read it (you have ${expectedRevision}, current is ${cur.revision}). `
        + 'Re-read the film and re-apply your edit — patching now would revert the change you have not seen.',
        { filmId, expectedRevision, revision: cur.revision, updatedAt: cur.updatedAt ?? null },
      );
    }
    const { id, workspace, slug, path: filmPath, revision, ...doc } = cur;
    const merged = validateFilm({
      ...normalizeFilm({ ...doc, ...patch }),
      schemaVersion: FILM_SCHEMA_VERSION,
      createdAt: doc.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await this._writeFilmDoc(filmPath, merged);
    return { ...merged, id, workspace, slug, path: filmPath, revision: filmRevision(merged) };
  }

  /**
   * Remove a film. With deleteFiles the whole film folder — scenes, assets,
   * built output — is deleted; without it only film.json is removed and the
   * folder remains on disk for manual salvage (it will list as `broken`
   * until deleted, which is the honest state).
   */
  async removeFilm(filmId, { deleteFiles = false } = {}) {
    const film = await this.getFilm(filmId);
    if (deleteFiles) {
      await fsp.rm(film.path, { recursive: true, force: true });
    } else {
      await fsp.rm(this._filmDocPath(film.path), { force: true });
    }
    return { id: film.id, name: film.name, path: film.path, removed: true, filesDeleted: deleteFiles };
  }

  /* ---------------------------------------------------------------- */
  /* Scenes                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Scaffold a new scene inside a film and append it to the film's play
   * order. Explicit dimensions win; unset ones fall back to the film's
   * sceneDefaults (then to makeConfig's own defaults), so scenes match the
   * film's signature unless the caller deliberately diverges.
   */
  async createScene(filmId, { name, slug = undefined, fps, width, height, durationInFrames } = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'Scene name is required');
    }
    const film = await this.getFilm(filmId);
    const sceneSlug = checkSlug(slug ?? slugify(name), 'scene');
    const sceneId = `${filmId}/${sceneSlug}`;
    const scenePath = this.scenePath(sceneId);
    if (fs.existsSync(path.join(scenePath, SCENE_CONFIG))) {
      throw new EngineError(ErrorCodes.SCENE_ALREADY_EXISTS, `A scene already exists at ${sceneId}`, { sceneId });
    }
    const d = film.sceneDefaults ?? {};
    const config = makeConfig({
      name: name.trim(),
      fps: fps ?? d.fps ?? 30,
      width: width ?? d.width ?? 1920,
      height: height ?? d.height ?? 1080,
      durationInFrames: durationInFrames ?? d.durationInFrames ?? 150,
    });
    await scaffoldSceneFiles(scenePath, config);
    // Append to the play order unless a folder-only scene with this slug was
    // already listed (possible after a manual copy).
    if (!(film.scenes ?? []).some((s) => s.slug === sceneSlug)) {
      await this.updateFilm(filmId, { scenes: [...(film.scenes ?? []), { slug: sceneSlug }] });
    }
    return { id: sceneId, name: config.name, path: scenePath, config };
  }

  /**
   * The film's scenes in play order, then any scene folders on disk that the
   * document does not list (flagged `unlisted` — e.g. a hand-copied folder).
   * Config unreadable → `missing: true`, same tolerance the old registry had
   * for folders deleted out from under it.
   */
  async listScenes(filmId) {
    const film = await this.getFilm(filmId);
    const listed = new Set((film.scenes ?? []).map((s) => s.slug));
    const out = [];
    const describe = async (slug, unlisted) => {
      const sceneId = `${film.id}/${slug}`;
      const scenePath = this.scenePath(sceneId);
      const base = { id: sceneId, slug, path: scenePath, ...(unlisted ? { unlisted: true } : {}) };
      try {
        const config = await this.readConfig(sceneId);
        const st = await fsp.stat(path.join(scenePath, SCENE_CONFIG));
        return {
          ...base,
          name: config.name,
          fps: config.fps,
          width: config.width,
          height: config.height,
          durationInFrames: config.durationInFrames,
          format: config.output?.format ?? 'mp4',
          lastModified: st.mtime.toISOString(),
        };
      } catch {
        return { ...base, name: slug, missing: true };
      }
    };
    for (const s of film.scenes ?? []) out.push(await describe(s.slug, false));
    let onDisk = [];
    try {
      onDisk = (await fsp.readdir(path.join(film.path, 'scenes'), { withFileTypes: true }))
        .filter((d) => d.isDirectory() && SLUG_RE.test(d.name) && !listed.has(d.name))
        .map((d) => d.name).sort();
    } catch { /* no scenes/ dir yet */ }
    for (const slug of onDisk) {
      if (fs.existsSync(path.join(film.path, 'scenes', slug, SCENE_CONFIG))) {
        out.push(await describe(slug, true));
      }
    }
    return out;
  }

  /** Resolve a scene id to its identity + absolute path, or scene_not_found. */
  async getScene(sceneId) {
    const [ws, film, slug] = parseId(sceneId, 3, 'scene');
    const scenePath = this.scenePath(sceneId);
    if (!fs.existsSync(path.join(scenePath, SCENE_CONFIG))) {
      throw new EngineError(ErrorCodes.SCENE_NOT_FOUND, `No scene "${sceneId}"`, { sceneId });
    }
    return { id: `${ws}/${film}/${slug}`, workspace: ws, film: `${ws}/${film}`, slug, path: scenePath };
  }

  /**
   * Remove a scene from its film's play order and (optionally) delete its
   * folder. Keeping the folder leaves it visible as `unlisted`, so nothing
   * silently disappears.
   */
  async removeScene(sceneId, { deleteFiles = false } = {}) {
    const scene = await this.getScene(sceneId);
    const film = await this.getFilm(scene.film);
    const kept = (film.scenes ?? []).filter((s) => s.slug !== scene.slug);
    if (kept.length !== (film.scenes ?? []).length) {
      await this.updateFilm(scene.film, { scenes: kept });
    }
    if (deleteFiles) await fsp.rm(scene.path, { recursive: true, force: true });
    return { id: scene.id, path: scene.path, removed: true, filesDeleted: deleteFiles };
  }

  /* ---------------------------------------------------------------- */
  /* Scene config                                                      */
  /* ---------------------------------------------------------------- */

  async readConfig(sceneId) {
    const scene = await this.getScene(sceneId);
    const raw = await fsp.readFile(path.join(scene.path, SCENE_CONFIG), 'utf8');
    let cfg;
    try { cfg = JSON.parse(raw); }
    catch (e) { throw new EngineError(ErrorCodes.INVALID_CONFIG, `${SCENE_CONFIG} is not valid JSON: ${e.message}`); }
    return validateConfig(migrateConfig(cfg));
  }

  async updateConfig(sceneId, patch) {
    const scene = await this.getScene(sceneId);
    const cfg = await this.readConfig(sceneId);
    const ALLOWED = new Set(['fps', 'width', 'height', 'durationInFrames', 'audio', 'output', 'name', 'libraries', 'libraryBuilds']);
    for (const k of Object.keys(patch)) {
      if (!ALLOWED.has(k)) throw new EngineError(ErrorCodes.INVALID_CONFIG, `Config field "${k}" cannot be updated`, { field: k });
    }
    const next = validateConfig({ ...cfg, ...patch });
    // Keep the output filename's extension in lockstep with the format so a
    // format switch never silently produces "output.mp4" containing VP9.
    next.output = { ...next.output, filename: normalizeOutputFilename(next.output) };
    await this._writeJsonAtomic(path.join(scene.path, SCENE_CONFIG), next);
    return next;
  }

  /* ---------------------------------------------------------------- */
  /* Composition files (sandboxed)                                     */
  /* ---------------------------------------------------------------- */

  async listFiles(sceneId) {
    const scene = await this.getScene(sceneId);
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
    await walk(scene.path, '');
    return files;
  }

  async readFile(sceneId, relPath) {
    const scene = await this.getScene(sceneId);
    const abs = resolveInTarget(scene.path, relPath);
    try {
      return await fsp.readFile(abs, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such file in scene: ${relPath}`, { path: relPath });
      throw e;
    }
  }

  /**
   * Write a composition source file. JavaScript files are syntax-checked
   * before hitting disk (fail fast at write time, not render time).
   */
  async writeFile(sceneId, relPath, content) {
    const scene = await this.getScene(sceneId);
    const abs = resolveInTarget(scene.path, relPath, { forWrite: true });

    const ext = path.extname(abs).toLowerCase();
    if (ext === '.js' || ext === '.mjs') checkJsSyntax(content, relPath);
    if (ext === '.json') {
      try { JSON.parse(content); }
      catch (e) { throw new EngineError(ErrorCodes.SYNTAX_ERROR, `JSON parse error in ${relPath}: ${e.message}`, { path: relPath }); }
    }
    // Advisory only — a determinism violation still writes (v0.10).
    const warnings = checkDeterminism(content, relPath);
    // Sequence-coverage advisory (v0.22): literal Sequence(start, dur) calls
    // that leave holes against the configured duration. Config read is
    // best-effort — a missing/broken scene.json must not fail the write.
    if (ext === '.js' || ext === '.mjs') {
      warnings.push(...checkCanvasStateBalance(content));
      const config = await this.readConfig(sceneId).catch(() => null);
      if (config?.durationInFrames) {
        warnings.push(...checkSequenceCoverage(content, config.durationInFrames));
      }
    }

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
   * Copy shared source files from one scene to many (v0.11).
   *
   * docs/film-setup.md recommends that every scene ship the *same*
   * `composition.js` and differ only in a small `scene.js` — but each scene
   * holds its own copy, so editing the original reaches nothing already
   * scaffolded. On a 16-scene film that made a one-line art fix a 16-scene
   * chore, which is exactly the kind of friction that discourages fixing it.
   *
   * Writes go through writeFile, so every target still gets the syntax check,
   * the determinism lint, and the atomic temp-and-rename.
   */
  async syncSharedFiles({ sourceSceneId, targetSceneIds, files }) {
    if (!files?.length) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'syncSharedFiles needs at least one file');
    }
    if (!targetSceneIds?.length) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'syncSharedFiles needs at least one target scene');
    }
    // Read every source file before writing anything: a typo in the file list
    // should fail before it has half-updated the film.
    const body = {};
    for (const f of files) body[f] = await this.readFile(sourceSceneId, f);

    const results = [];
    for (const sceneId of targetSceneIds) {
      if (sceneId === sourceSceneId) continue;
      const written = [];
      for (const f of files) written.push(await this.writeFile(sceneId, f, body[f]));
      results.push({ sceneId, written });
    }
    return {
      sourceSceneId,
      files,
      scenesUpdated: results.length,
      results,
    };
  }

  /**
   * Attach an optional 3D library (v0.7). Copies the vendored library build
   * into the scene (kept local so renders stay hermetic) and, unless
   * scaffold===false, replaces composition.html/js/css with the library's
   * frame-driven starter. Records the library id in config.libraries.
   */
  async addLibrary(sceneId, { library, scaffold = true, addons = [] } = {}) {
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

    const scene = await this.getScene(sceneId);
    const cfg = await this.readConfig(sceneId);
    const vendorDir = libsVendorDir();

    // 1) copy the vendored library + addon build(s) into the scene
    const copied = [];
    const builds = {};
    for (const f of [...spec.files, ...addonSpecs.flatMap(addonFiles)]) {
      const srcAbs = path.join(vendorDir, f.vendor);
      if (!fs.existsSync(srcAbs)) {
        throw new EngineError(
          ErrorCodes.LIBRARY_UNAVAILABLE,
          `Library build not found: ${f.vendor}. This file is committed to the repo, so a clean checkout should have it — `
            + `restore it with "git checkout -- engine/vendor/libs", or re-download with `
            + `"node scripts/fetch-libs.mjs ${spec.id}" in the engine folder (~${spec.approxKB} KB).`,
          { library: spec.id, file: f.vendor },
        );
      }
      const abs = resolveInTarget(scene.path, f.dest, { forWrite: true });
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.copyFile(srcAbs, abs);
      // Hash what we actually copied, so the scene records the exact build it
      // holds. Not redundant with git tracking engine/vendor/libs: git says what
      // the repo holds *now*, this says what the scene copied *then* — they
      // diverge the moment the libraries are upgraded, and it is the second one a
      // finished render was made from. (A version string would not do: see
      // core/vendor-lock.js on two builds both reporting 9.18.0.)
      const bytes = await fsp.readFile(abs);
      builds[f.dest] = { version: detectVersion(bytes), sha256: sha256(bytes), bytes: bytes.length };
      copied.push({ path: f.dest, bytes: bytes.length, sha256: builds[f.dest].sha256 });
    }

    // Addon <script> tags injected into the scaffolded HTML (after the core
    // lib), in each addon's declared load order — postprocessing's shader files
    // must precede the passes that reference them.
    const addonScripts = addonSpecs
      .flatMap(addonFiles)
      .map((f) => `<script src="${f.dest}"></script>`)
      .join('\n  ');

    // 2) scaffold the starter composition (placeholder substitution) unless opted out
    const scaffolded = [];
    if (scaffold) {
      const tdir = path.join(TEMPLATES_ROOT, spec.template);
      for (const file of await fsp.readdir(tdir)) {
        const content = (await fsp.readFile(path.join(tdir, file), 'utf8'))
          .replaceAll('<!--__ADDONS__-->', addonScripts)
          .replaceAll('__SCENE_NAME__', cfg.name)
          .replaceAll('__FPS__', String(cfg.fps))
          .replaceAll('__DURATION__', String(cfg.durationInFrames))
          .replaceAll('__WIDTH__', String(cfg.width))
          .replaceAll('__HEIGHT__', String(cfg.height));
        const abs = resolveInTarget(scene.path, file, { forWrite: true });
        const tmp = abs + '.tmp-' + process.pid;
        await fsp.writeFile(tmp, content, 'utf8');
        await fsp.rename(tmp, abs);
        scaffolded.push(file);
      }
    }

    // 3) record the library in config
    const libs = Array.from(new Set([...(cfg.libraries || []), spec.id]));
    const config = await this.updateConfig(sceneId, {
      libraries: libs,
      libraryBuilds: { ...(cfg.libraryBuilds || {}), ...builds },
    });

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

  /* ---------------------------------------------------------------- */
  /* Assets — scenes AND films                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve an asset target: a scene id ("ws/film/scene") or a film id
   * ("ws/film"). A film's assets/ holds its master audio and overlays —
   * exactly what the old "— Master" output project's assets/ held — and its
   * audio track list lives in film.json instead of scene.json. The
   * returned accessor pair hides that difference from every asset operation.
   *
   * @returns {{ kind: 'scene'|'film', id, path, getTracks(), setTracks(t) }}
   */
  async resolveAssetTarget(targetId) {
    const parts = String(targetId ?? '').replace(/\\/g, '/').split('/');
    if (parts.length === 3) {
      const scene = await this.getScene(targetId);
      return {
        kind: 'scene',
        id: scene.id,
        path: scene.path,
        getTracks: async () => (await this.readConfig(scene.id).catch(() => null))?.audio ?? [],
        setTracks: async (audio) => (await this.updateConfig(scene.id, { audio })).audio ?? [],
      };
    }
    const film = await this.getFilm(targetId);
    return {
      kind: 'film',
      id: film.id,
      path: film.path,
      getTracks: async () => (await this.getFilm(film.id)).audio ?? [],
      setTracks: async (audio) => (await this.updateFilm(film.id, { audio })).audio ?? [],
      // Footage segments (v0.22) reference assets/ too, and a dangling one fails
      // at build time rather than at delete time — so deletes and renames have to
      // see them. A scene target has no timeline, hence the empty default above.
      getSegments: async () => (await this.getFilm(film.id)).scenes ?? [],
    };
  }

  /** Normalize + confine a caller-supplied path to the assets/ folder. */
  _assetRelPath(relPath) {
    const normalized = String(relPath ?? '').replace(/\\/g, '/');
    if (!normalized.startsWith('assets/')) {
      throw new EngineError(
        ErrorCodes.PATH_NOT_ALLOWED,
        `Assets must live under assets/ (got "${relPath}")`,
        { path: relPath },
      );
    }
    return normalized;
  }

  /**
   * Write a binary asset (image / audio / font / video) from base64 into the
   * target's assets/ folder (v0.5). This is the only way binary content
   * enters a scene or film through the tool surface: the destination is
   * confined to assets/, extensions are allow-listed, and the size is capped.
   */
  async writeAssetFile(targetId, relPath, base64Content, { maxBytes = MAX_ASSET_BYTES } = {}) {
    let buf;
    try {
      buf = Buffer.from(base64Content, 'base64');
    } catch (e) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `content is not valid base64: ${e.message}`);
    }
    return this.writeAssetBuffer(targetId, relPath, buf, { maxBytes });
  }

  /**
   * Buffer-level asset write shared by the base64 MCP path and the Studio's
   * raw-body upload (v0.15) — one place enforces the assets/ confinement, the
   * extension allow-list, and the size cap.
   */
  async writeAssetBuffer(targetId, relPath, buf, { maxBytes = MAX_ASSET_BYTES } = {}) {
    const target = await this.resolveAssetTarget(targetId);
    const normalized = this._assetRelPath(relPath);
    const abs = resolveInTarget(target.path, normalized, { forWrite: true, asAsset: true });
    if (buf.length === 0) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'decoded asset is empty');
    if (buf.length > maxBytes) {
      throw new EngineError(
        ErrorCodes.ASSET_TOO_LARGE,
        `Asset is ${buf.length} bytes; limit is ${maxBytes}. Place larger files in the workspace library ` +
          '(or the assets/ folder directly on disk) and pull them in from there.',
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
   * List everything under the target's assets/: relative path, size, mtime,
   * a coarse kind for UI grouping, and how many audio tracks reference it
   * (scene config.audio or film.audio, per target kind).
   */
  async listAssets(targetId) {
    const target = await this.resolveAssetTarget(targetId);
    const root = path.join(target.path, 'assets');
    const tracks = await target.getTracks();
    const files = [];
    const walk = async (dir, rel) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch { return; } // assets/ deleted out from under us: report empty
      for (const d of entries) {
        if (d.name.startsWith('.') || d.name.includes('.tmp-')) continue;
        const abs = path.join(dir, d.name);
        const relPath = `${rel}/${d.name}`;
        if (d.isDirectory()) { await walk(abs, relPath); continue; }
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) continue;
        files.push({
          path: relPath,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
          kind: ASSET_KINDS(path.extname(d.name).toLowerCase()),
          audioRefs: audioRefs(tracks, relPath).length,
        });
      }
    };
    await walk(root, 'assets');
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  /**
   * Read-side resolver for one asset: assets/-relative path → absolute path
   * plus its stat/kind (v0.21). The write-side rules do NOT apply — no
   * extension allow-list — because reading a file the human dropped into
   * assets/ on disk must work whatever its extension is. The sandbox escape
   * checks still do.
   */
  async resolveAssetFile(targetId, relPath) {
    const target = await this.resolveAssetTarget(targetId);
    const normalized = this._assetRelPath(relPath);
    const abs = resolveInTarget(target.path, normalized);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new EngineError(
        ErrorCodes.FILE_NOT_FOUND,
        `No such asset "${normalized}" in ${target.kind} "${target.id}" (list_assets shows what is there)`,
        { target: target.id, path: normalized },
      );
    }
    return {
      target,
      abs,
      path: normalized,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      kind: ASSET_KINDS(path.extname(abs).toLowerCase()),
    };
  }

  /**
   * Read-side resolver for one MEDIA file: like `resolveAssetFile`, but the path
   * may also point under the target's `out/` — a file the engine rendered
   * (v0.22).
   *
   * This exists because the read-only media tools promise it: `probe_asset` and
   * `transcribe_asset` are how a finished cut is verified ("re-transcribe the
   * render and check the words that came out are the words that went in"), and
   * that means opening `out/film.mp4`. Confining the *read* to assets/ made that
   * documented workflow impossible while protecting nothing — the file is one
   * the engine itself just wrote.
   *
   * The write side is untouched: `_assetRelPath` still confines every write,
   * delete and rename to assets/, so a rendered deliverable cannot be
   * overwritten through the tool surface. The sandbox escape checks apply to
   * both.
   */
  async resolveMediaFile(targetId, relPath) {
    const target = await this.resolveAssetTarget(targetId);
    const normalized = String(relPath ?? '').replace(/\\/g, '/');
    if (!normalized.startsWith('assets/') && !normalized.startsWith('out/')) {
      throw new EngineError(
        ErrorCodes.PATH_NOT_ALLOWED,
        `Media path must begin with "assets/" (supplied material) or "out/" (rendered output), for example "out/output.mp4" — got "${relPath}"`,
        { path: relPath },
      );
    }
    const abs = resolveInTarget(target.path, normalized);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new EngineError(
        ErrorCodes.FILE_NOT_FOUND,
        normalized.startsWith('out/')
          ? `No such rendered file "${normalized}" in ${target.kind} "${target.id}" (render it first)`
          : `No such asset "${normalized}" in ${target.kind} "${target.id}" (list_assets shows what is there)`,
        { target: target.id, path: normalized },
      );
    }
    return {
      target,
      abs,
      path: normalized,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      kind: ASSET_KINDS(path.extname(abs).toLowerCase()),
    };
  }

  /**
   * Delete a single file under assets/ (v0.15).
   *
   * `updateAudio` also drops any audio track pointing at the file (scene
   * config or film document, per target). Without it the tracks are left
   * alone and reported in `audioRefs`, because a dangling reference is the
   * caller's decision to make — but it is never silent: deleting narration a
   * film still references would otherwise surface as an ffmpeg mux failure
   * minutes into the next build.
   */
  async deleteAsset(targetId, relPath, { updateAudio = false } = {}) {
    const target = await this.resolveAssetTarget(targetId);
    const normalized = this._assetRelPath(relPath);
    const abs = resolveInTarget(target.path, normalized);
    let st;
    try { st = await fsp.stat(abs); }
    catch { throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such asset: ${normalized}`, { path: normalized }); }
    if (!st.isFile()) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `Not a file: ${normalized} (folders are managed on disk)`, { path: normalized });
    }

    const tracks = await target.getTracks();
    const refs = audioRefs(tracks, normalized);
    // A film segment playing this file is a harder dependency than an audio
    // track: there is no "drop the track" fix, the film simply loses a piece of
    // its picture. Refuse instead of leaving a build to fail later.
    const segRefs = footageRefs(await target.getSegments?.() ?? [], normalized);
    if (segRefs.length) {
      throw new EngineError(
        ErrorCodes.INVALID_CONFIG,
        `"${normalized}" is used as footage by ${segRefs.length} segment(s) of this film ` +
          `(position${segRefs.length > 1 ? 's' : ''} ${segRefs.map((r) => r.index + 1).join(', ')}). ` +
          'Remove those segments from the play order first (update_film { scenes: [...] }), then delete the file.',
        { path: normalized, footageRefs: segRefs.length, segments: segRefs.map((r) => r.index) },
      );
    }

    await fsp.rm(abs);

    let audioTracksRemoved = 0;
    let audio;
    if (updateAudio && refs.length) {
      const drop = new Set(refs.map((r) => r.index));
      audio = await target.setTracks(tracks.filter((_, i) => !drop.has(i)));
      audioTracksRemoved = refs.length;
    }
    return {
      path: normalized,
      deleted: true,
      audioRefs: refs.length,
      footageRefs: 0,
      audioTracksRemoved,
      ...(audio ? { audio } : {}),
    };
  }

  /**
   * Rename/move a file within assets/ (v0.15). The destination must not
   * already exist — an accidental overwrite of a hand-placed 20 MB soundtrack
   * is exactly the mistake this surface should refuse.
   */
  async renameAsset(targetId, fromRel, toRel, { updateAudio = false } = {}) {
    const target = await this.resolveAssetTarget(targetId);
    const from = this._assetRelPath(fromRel);
    const to = this._assetRelPath(toRel);
    const absFrom = resolveInTarget(target.path, from);
    const absTo = resolveInTarget(target.path, to, { forWrite: true, asAsset: true });
    if (!fs.existsSync(absFrom)) {
      throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such asset: ${from}`, { path: from });
    }
    if (fs.existsSync(absTo)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `Destination already exists: ${to}`, { path: to });
    }

    const tracks = await target.getTracks();
    const refs = audioRefs(tracks, from);
    // Footage segments are repointed unconditionally, unlike audio tracks: a
    // rename is a move of the same file, and a segment left pointing at the old
    // path is a film that no longer builds. There is no version of "keep the old
    // reference" that a caller could want here.
    const segments = await target.getSegments?.() ?? [];
    const segRefs = footageRefs(segments, from);

    await fsp.mkdir(path.dirname(absTo), { recursive: true });
    await fsp.rename(absFrom, absTo);

    let audioTracksUpdated = 0;
    let audio;
    if (updateAudio && refs.length) {
      const move = new Set(refs.map((r) => r.index));
      audio = await target.setTracks(tracks.map((t, i) => (move.has(i) ? { ...t, src: to } : t)));
      audioTracksUpdated = refs.length;
    }
    if (segRefs.length) {
      const move = new Set(segRefs.map((r) => r.index));
      await this.updateFilm(target.id, {
        scenes: segments.map((s, i) => (move.has(i) ? { ...s, footage: to } : s)),
      });
    }
    return {
      from,
      to,
      audioRefs: refs.length,
      audioTracksUpdated,
      footageRefs: segRefs.length,
      footageSegmentsUpdated: segRefs.length,
      ...(audio ? { audio } : {}),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Workspace library — human-managed shared assets                   */
  /* ---------------------------------------------------------------- */

  /**
   * List the workspace library. The human drops files here on disk (or via
   * the Studio's library panel) — typically the large ones the 25 MB base64
   * tool cap exists to keep out of the MCP channel — and any scene or film
   * in the workspace can pull them in with useLibraryAsset().
   */
  async listLibrary(ws) {
    await this.getWorkspace(ws);
    const root = this.libraryPath(ws);
    const files = [];
    const walk = async (dir, rel) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const d of entries) {
        if (d.name.startsWith('.') || d.name.includes('.tmp-')) continue;
        const abs = path.join(dir, d.name);
        const relPath = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { await walk(abs, relPath); continue; }
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) continue;
        files.push({
          path: relPath,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
          kind: ASSET_KINDS(path.extname(d.name).toLowerCase()),
        });
      }
    };
    await walk(root, '');
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  /** Public read-side resolver: library-relative path → absolute file path. */
  libraryFilePath(ws, relPath) {
    return this._resolveLibraryFile(ws, relPath).abs;
  }

  /** Resolve a library-relative path safely (read side of the library). */
  _resolveLibraryFile(ws, relPath) {
    const root = this.libraryPath(ws);
    const normalized = String(relPath ?? '').replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || path.isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized)) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Invalid library path "${relPath}"`, { path: relPath });
    }
    const abs = path.resolve(root, normalized);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Library path escapes the library: "${relPath}"`, { path: relPath });
    }
    return { abs, rel: rel.replace(/\\/g, '/') };
  }

  /**
   * Write a file into the workspace library (Studio upload path). Same
   * extension allow-list as assets, but no size cap — the library exists
   * precisely for the files too large for the tool channel.
   */
  async writeLibraryBuffer(ws, relPath, buf) {
    await this.getWorkspace(ws);
    const { abs, rel } = this._resolveLibraryFile(ws, relPath);
    // Reuse the sandbox's write rules (extension allow-list) by resolving
    // against the library root as if it were an assets/ write.
    resolveInTarget(this.libraryPath(ws), rel, { forWrite: true, asAsset: true });
    if (!buf.length) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'library file is empty');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
    return { path: rel, bytes: buf.length };
  }

  /** Delete a library file (Studio path; the human's surface). */
  async deleteLibraryFile(ws, relPath) {
    await this.getWorkspace(ws);
    const { abs, rel } = this._resolveLibraryFile(ws, relPath);
    let st;
    try { st = await fsp.stat(abs); }
    catch { throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such library file: ${rel}`, { path: rel }); }
    if (!st.isFile()) throw new EngineError(ErrorCodes.INVALID_CONFIG, `Not a file: ${rel}`, { path: rel });
    await fsp.rm(abs);
    return { path: rel, deleted: true };
  }

  /**
   * Pull a library file into a scene's (or film's) assets/ so compositions
   * and audio timelines can reference it as a normal asset. Hardlinked when
   * the volume allows (zero extra disk for a 500 MB background plate),
   * copied otherwise — either way the scene stays self-contained and the
   * render path is unchanged.
   *
   * Default destination mirrors the library layout under assets/library/…
   * so a scene's asset list shows where the file came from.
   */
  async useLibraryAsset(targetId, libraryPath, { as = undefined } = {}) {
    const target = await this.resolveAssetTarget(targetId);
    const ws = target.id.split('/')[0];
    const { abs: srcAbs, rel: srcRel } = this._resolveLibraryFile(ws, libraryPath);
    let st;
    try { st = await fsp.stat(srcAbs); }
    catch {
      throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
        `No such library file: ${srcRel} (list_shared_assets shows what the library holds)`, { path: srcRel });
    }
    if (!st.isFile()) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `Not a file: ${srcRel}`, { path: srcRel });
    }
    const destRel = this._assetRelPath(as ?? `assets/library/${srcRel}`);
    const destAbs = resolveInTarget(target.path, destRel, { forWrite: true, asAsset: true });
    await fsp.mkdir(path.dirname(destAbs), { recursive: true });
    // Refresh-in-place: pulling the same file again replaces the previous
    // link/copy, so an updated library file propagates on request.
    await fsp.rm(destAbs, { force: true });
    let linked = true;
    try {
      await fsp.link(srcAbs, destAbs);
    } catch {
      linked = false;
      await fsp.copyFile(srcAbs, destAbs);
    }
    return { from: srcRel, path: destRel, bytes: st.size, linked };
  }
}
