/**
 * One-time migration: pre-v0.20 flat layout → workspaces.
 *
 * The old world:  <dataDir>/projects.json  (flat UUID registry)
 *                 <dataDir>/films.json     (film docs referencing UUIDs)
 *                 <dataDir>/projects/<slug>/  (all projects, all agents, mixed)
 * The new world:  <dataDir>/workspaces/<ws>/films/<film>/scenes/<scene>/
 *                 (see core/store.js)
 *
 * Mapping rules:
 *   - Everything lands in the "default" workspace — the old layout had no
 *     notion of who made what, so inventing an attribution would be a guess.
 *   - Each moved scene folder's `project.json` is renamed to `scene.json`;
 *     the old name is read here and nowhere else in the engine.
 *   - Each saved film becomes a film folder: its scene projects move into
 *     scenes/<slug>, its output project's assets/ and out/ become the film's
 *     own assets/ and out/ (that project was the "— Master" convention — a
 *     film pretending to be a project — and it stops existing as a project).
 *   - Projects in no film become single-scene films of the same name, so
 *     nothing silently disappears from the Studio.
 *   - The old registries and any leftover output-project files move to
 *     <dataDir>/legacy-v019/ together with a migration-report.json mapping
 *     old UUIDs to new ids. Nothing is deleted.
 *
 * Trigger and idempotence: runs only when projects.json exists; the last
 * step moves it into legacy-v019/, so a completed migration never re-runs.
 * A crash mid-way leaves projects.json in place and the migration resumes on
 * next start — folder moves that already happened are detected by their
 * destination existing (slugs are then suffixed, and the report says so).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { slugify, SCENE_CONFIG } from './scene.js';
import { normalizeFilm, validateFilm } from './films.js';

export const LEGACY_BACKUP_DIR = 'legacy-v019';
export const DEFAULT_WORKSPACE = 'default';

/** What a scene's config was called before v0.20 — read here, nowhere else. */
const LEGACY_CONFIG = 'project.json';

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return null; }
}

async function writeJsonAtomic(abs, obj) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, abs);
}

/** Move a folder; cross-device falls back to copy + remove. */
async function moveDir(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Move every child of `from` into `to` (merging), then remove `from` if empty. */
async function moveChildren(from, to) {
  let entries;
  try { entries = await fsp.readdir(from); }
  catch { return; }
  await fsp.mkdir(to, { recursive: true });
  for (const name of entries) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) continue; // never clobber; leftover goes to backup with the rest
    try { await fsp.rename(src, dest); }
    catch {
      const st = await fsp.stat(src);
      if (st.isDirectory()) { await fsp.cp(src, dest, { recursive: true }); await fsp.rm(src, { recursive: true, force: true }); }
      else { await fsp.copyFile(src, dest); await fsp.rm(src, { force: true }); }
    }
  }
  try { if (!(await fsp.readdir(from)).length) await fsp.rmdir(from); } catch { /* keep */ }
}

function uniqueSlug(base, taken) {
  let slug = base, n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

/**
 * Migrate `dataDir` if the legacy registries are present. Safe to call every
 * startup; returns a report ({ migrated: false } when there was nothing to do).
 */
export async function migrateLegacyLayout(dataDir) {
  const projectsRegistry = path.join(dataDir, 'projects.json');
  if (!fs.existsSync(projectsRegistry)) return { migrated: false };

  const backupDir = path.join(dataDir, LEGACY_BACKUP_DIR);
  const wsPath = path.join(dataDir, 'workspaces', DEFAULT_WORKSPACE);
  const filmsRoot = path.join(wsPath, 'films');
  const report = {
    migratedAt: new Date().toISOString(),
    workspace: DEFAULT_WORKSPACE,
    films: [],
    notes: [],
    projectIdMap: {},   // legacy project UUID → new scene/film id (or null if missing)
    filmIdMap: {},      // legacy film UUID → new film id
  };

  try {
    const reg = (await readJson(projectsRegistry)) ?? { projects: [] };
    const filmsReg = (await readJson(path.join(dataDir, 'films.json'))) ?? { films: [] };
    const projects = Array.isArray(reg.projects) ? reg.projects : [];
    const films = Array.isArray(filmsReg.films) ? filmsReg.films : [];

    await fsp.mkdir(filmsRoot, { recursive: true });
    await fsp.mkdir(path.join(wsPath, 'library'), { recursive: true });
    if (!fs.existsSync(path.join(wsPath, 'workspace.json'))) {
      await writeJsonAtomic(path.join(wsPath, 'workspace.json'),
        { name: DEFAULT_WORKSPACE, createdAt: new Date().toISOString() });
    }

    const byId = new Map(projects.map((p) => [p.id, p]));
    const claimed = new Set();          // project UUIDs placed somewhere
    const filmSlugs = new Set(fs.existsSync(filmsRoot) ? await fsp.readdir(filmsRoot) : []);
    const movedTo = new Map();          // project UUID → absolute new folder (for reuse-by-copy)

    const projectConfig = async (p) => (p && p.path ? readJson(path.join(p.path, LEGACY_CONFIG)) : null);

    /**
     * The config file was renamed with the concept (project.json → scene.json),
     * so a moved folder is only a scene once its config carries the new name.
     * Idempotent: a folder that already has scene.json is left alone.
     */
    const renameConfig = async (sceneDir) => {
      const from = path.join(sceneDir, LEGACY_CONFIG);
      const to = path.join(sceneDir, SCENE_CONFIG);
      if (fs.existsSync(from) && !fs.existsSync(to)) await fsp.rename(from, to);
    };

    /** Place one legacy project folder as a scene of a film; returns slug or null. */
    const placeScene = async (filmPath, filmId, projectId, sceneSlugs) => {
      const p = byId.get(projectId);
      const cfg = await projectConfig(p);
      if (!p || !cfg) {
        report.notes.push(`Film ${filmId}: scene project ${projectId} is missing on disk — dropped from the film`);
        report.projectIdMap[projectId] = null;
        return null;
      }
      const slug = uniqueSlug(slugify(cfg.name ?? p.name ?? 'scene'), sceneSlugs);
      const dest = path.join(filmPath, 'scenes', slug);
      if (movedTo.has(projectId)) {
        // Already placed in another film — a scene lives in one film, so the
        // second reference gets its own copy.
        await fsp.cp(movedTo.get(projectId), dest, { recursive: true });
        report.notes.push(`Project ${p.name} was in more than one film; copied into ${filmId}/${slug}`);
      } else {
        await moveDir(p.path, dest);
        movedTo.set(projectId, dest);
        report.projectIdMap[projectId] = `${filmId}/${slug}`;
      }
      await renameConfig(dest);
      claimed.add(projectId);
      return slug;
    };

    // ---- saved films become film folders -------------------------------
    for (const legacy of films) {
      const filmSlug = uniqueSlug(slugify(legacy.name ?? 'film'), filmSlugs);
      const filmId = `${DEFAULT_WORKSPACE}/${filmSlug}`;
      const filmPath = path.join(filmsRoot, filmSlug);
      await fsp.mkdir(path.join(filmPath, 'scenes'), { recursive: true });
      await fsp.mkdir(path.join(filmPath, 'assets'), { recursive: true });
      await fsp.mkdir(path.join(filmPath, 'out'), { recursive: true });

      const sceneSlugs = new Set();
      const sceneRefs = [];
      const sceneIds = (legacy.scenes ?? []).map((s) => s.projectId).filter(Boolean);
      for (const pid of sceneIds) {
        const slug = await placeScene(filmPath, filmId, pid, sceneSlugs);
        if (slug) sceneRefs.push({ slug });
      }

      // The output project's assets/out fold into the film folder itself.
      const outId = legacy.outputProjectId;
      if (outId && !sceneIds.includes(outId)) {
        const outP = byId.get(outId);
        if (outP && fs.existsSync(outP.path)) {
          await moveChildren(path.join(outP.path, 'assets'), path.join(filmPath, 'assets'));
          await moveChildren(path.join(outP.path, 'out'), path.join(filmPath, 'out'));
          // Whatever else the output project held (scaffold files, hand
          // edits) is preserved in the backup, not deleted.
          if (fs.existsSync(outP.path)) {
            await moveDir(outP.path, path.join(backupDir, 'output-projects', path.basename(outP.path)));
          }
          claimed.add(outId);
          report.projectIdMap[outId] = filmId;
        } else if (outId) {
          report.notes.push(`Film ${filmId}: output project ${outId} was missing on disk`);
        }
      }

      // sceneDefaults from the first scene keeps future scenes consistent.
      let sceneDefaults;
      const firstCfg = sceneRefs.length
        ? await readJson(path.join(filmPath, 'scenes', sceneRefs[0].slug, SCENE_CONFIG))
        : null;
      if (firstCfg) {
        sceneDefaults = { fps: firstCfg.fps, width: firstCfg.width, height: firstCfg.height };
      }

      const doc = validateFilm({
        ...normalizeFilm({
          name: legacy.name ?? filmSlug,
          scenes: sceneRefs,
          outputFilename: legacy.outputFilename,
          sceneDefaults,
          audio: legacy.audio,
          overlays: legacy.overlays,
          captions: legacy.captions,
          captionStyle: legacy.captionStyle,
          audioTargetPeakDb: legacy.audioTargetPeakDb,
          burnCaptions: legacy.burnCaptions,
        }),
        schemaVersion: 1,
        createdAt: legacy.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path.join(filmPath, 'film.json'), doc);
      report.films.push({ id: filmId, from: legacy.id, scenes: sceneRefs.length });
      report.filmIdMap[legacy.id] = filmId;
    }

    // ---- loose projects become single-scene films ----------------------
    for (const p of projects) {
      if (claimed.has(p.id)) continue;
      const cfg = await projectConfig(p);
      if (!cfg) {
        report.notes.push(`Project "${p.name}" (${p.id}) is missing on disk — skipped`);
        report.projectIdMap[p.id] = null;
        continue;
      }
      const filmSlug = uniqueSlug(slugify(cfg.name ?? p.name ?? 'film'), filmSlugs);
      const filmId = `${DEFAULT_WORKSPACE}/${filmSlug}`;
      const filmPath = path.join(filmsRoot, filmSlug);
      const sceneSlugs = new Set();
      const slug = await placeScene(filmPath, filmId, p.id, sceneSlugs);
      const doc = validateFilm({
        ...normalizeFilm({
          name: cfg.name ?? p.name,
          scenes: slug ? [{ slug }] : [],
          sceneDefaults: { fps: cfg.fps, width: cfg.width, height: cfg.height },
        }),
        schemaVersion: 1,
        createdAt: p.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await fsp.mkdir(path.join(filmPath, 'assets'), { recursive: true });
      await fsp.mkdir(path.join(filmPath, 'out'), { recursive: true });
      await writeJsonAtomic(path.join(filmPath, 'film.json'), doc);
      report.films.push({ id: filmId, from: p.id, scenes: slug ? 1 : 0, wasLooseProject: true });
    }

    // ---- retire the registries (this is what makes migration one-shot) --
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.rename(projectsRegistry, path.join(backupDir, 'projects.json'));
    if (fs.existsSync(path.join(dataDir, 'films.json'))) {
      await fsp.rename(path.join(dataDir, 'films.json'), path.join(backupDir, 'films.json'));
    }
    // The old projects/ root may retain folders that were never registered;
    // leave it in place if non-empty (it is user data), remove if empty.
    const oldRoot = path.join(dataDir, 'projects');
    try { if (fs.existsSync(oldRoot) && !(await fsp.readdir(oldRoot)).length) await fsp.rmdir(oldRoot); }
    catch { /* keep */ }

    await writeJsonAtomic(path.join(backupDir, 'migration-report.json'), report);
    return { migrated: true, ...report };
  } catch (e) {
    throw new EngineError(
      ErrorCodes.MIGRATION_FAILED,
      `Migrating the pre-v0.20 layout failed: ${e?.message ?? e}. The legacy registries were left in place; ` +
        `re-running will resume. Nothing has been deleted (see ${backupDir}).`,
      { dataDir, cause: String(e?.stack ?? e) },
    );
  }
}
