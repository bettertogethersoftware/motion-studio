/**
 * Scene revisions (v0.23) — immutable history for the atomic render unit.
 *
 * Every promoted canonical scene render is archived as an immutable revision
 * beside the live output:
 *
 *   <scene>/revisions/
 *     current.json            { revisionId }  — atomically replaced pointer
 *     <revision>/
 *       revision.json         identity, provenance, render metadata
 *       output.<ext>          the promoted delivery (hardlink; copy fallback)
 *       output.contact.png    the render's contact sheet, when one exists
 *       output.review.json    the render's review report, when one exists
 *       source/               snapshot of the composition source files
 *
 * Why this exists: the AI director reworks scenes unattended, and a rework
 * that OVERWRITES the only output destroys the evidence a human adviser needs
 * ("the previous version was better" is unanswerable once the previous
 * version is gone). A revision directory is immutable after it is written;
 * a new attempt never touches an old one.
 *
 * The live output at `out/<filename>` remains what build_film consumes — the
 * *materialized current revision*. `useRevision` repoints it: it stages a
 * copy of an archived output and promotes it with the same atomic rename the
 * renderer uses, then rewrites the render sidecar from the revision's
 * recorded metadata so staleness checks agree with what is now on disk. It
 * never regenerates media and never deletes newer history.
 *
 * Source snapshots make provenance real rather than claimed: text files are
 * copied (small), binary assets are hardlinked (free on one volume, and safe
 * against the engine's own writes because every engine write is a temp file
 * + rename, which replaces the inode rather than mutating it).
 *
 * Archiving is best-effort AT THE CALLER: a render that already promoted its
 * delivery must not be failed by history-keeping (same philosophy as the
 * render sidecar). The functions here throw honestly; the renderer catches.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';
import { sceneOutputPath, renderMetaPath, renderStaleness } from './film.js';
import { prepareStagingOutput, promoteStagingOutput, outputIdentity } from './delivery.js';

export const REVISIONS_DIR = 'revisions';

/** Bytes at or above which a snapshot file is hardlinked rather than copied. */
const LINK_THRESHOLD = 256 * 1024;

/** Directories never snapshotted into a revision's source/. */
const SNAPSHOT_EXCLUDE_DIRS = new Set(['node_modules', REVISIONS_DIR, '.staging']);

/** The identity this process stamps on work it creates (see docs/mcp-setup.md). */
export function currentAgentId() {
  const explicit = process.env.MOTION_STUDIO_AGENT?.trim();
  if (explicit) return explicit;
  const ws = process.env.MOTION_STUDIO_WORKSPACE?.trim();
  return ws || null;
}

/** New opaque revision id. Time-prefixed so folder listings sort chronologically. */
export function newRevisionId(now = Date.now()) {
  return `rev-${String(now).padStart(13, '0')}-${randomUUID().slice(0, 8)}`;
}

export function revisionsRoot(scenePath) {
  return path.join(scenePath, REVISIONS_DIR);
}

export function revisionPath(scenePath, revisionId) {
  // Revision ids are opaque but they become path segments; refuse separators.
  if (!/^[a-zA-Z0-9._-]+$/.test(String(revisionId ?? ''))) {
    throw new EngineError(ErrorCodes.REVISION_NOT_FOUND, `No such revision "${revisionId}"`, { revisionId });
  }
  return path.join(revisionsRoot(scenePath), String(revisionId));
}

async function writeJsonAtomic(abs, obj) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, abs);
}

/** Hardlink src → dest, falling back to a copy across volumes. */
async function linkOrCopy(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.link(src, dest);
    return 'link';
  } catch {
    await fsp.copyFile(src, dest);
    return 'copy';
  }
}

/**
 * Snapshot the composition source tree into `destDir`.
 *
 * Includes everything an author wrote — composition files, scene.json,
 * assets — and excludes what a render derives (the out dir, staging,
 * revisions themselves, node_modules, dotfiles, temp files). Small files
 * are copied; large binaries are hardlinked (see module header for why
 * that is immutable enough).
 */
async function snapshotSource(scenePath, destDir, { outDirName }) {
  const files = [];
  const walk = async (dir, rel) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const d of entries) {
      if (d.name.startsWith('.') || d.name.includes('.tmp-')) continue;
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (SNAPSHOT_EXCLUDE_DIRS.has(d.name) || (!rel && d.name === outDirName)) continue;
        await walk(path.join(dir, d.name), relPath);
        continue;
      }
      if (!d.isFile()) continue;
      const abs = path.join(dir, d.name);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) continue;
      const dest = path.join(destDir, ...relPath.split('/'));
      const how = st.size >= LINK_THRESHOLD
        ? await linkOrCopy(abs, dest)
        : await (async () => {
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(abs, dest);
          return 'copy';
        })();
      files.push({ path: relPath, bytes: st.size, stored: how });
    }
  };
  await walk(scenePath, '');
  return files;
}

/**
 * Archive a just-promoted canonical scene render as an immutable revision and
 * make it current.
 *
 * @param {object} opts
 * @param {string} opts.scenePath   absolute scene folder
 * @param {object} opts.config      the scene config the render used
 * @param {number} opts.frames      frames actually rendered
 * @param {string} [opts.outputPath]  the promoted delivery (defaults to the
 *   scene's canonical output path)
 * @param {object} [opts.renderMeta]  the sidecar body writeRenderMeta returned
 * @param {string} [opts.agent]     creator identity (default: this process's)
 * @param {string} [opts.note]      short human-readable summary of the attempt
 * @param {string[]} [opts.adviceIds]  advice this revision responds to
 * @param {string} [opts.parentRevisionId]  the revision this one was derived from
 * @param {string} [opts.jobId]
 * @returns {{ id, path, createdAt, outputFile, source: {files} }}
 */
export async function archiveRevision({
  scenePath, config, frames, outputPath = null, renderMeta = null,
  agent = currentAgentId(), note = null, adviceIds = [], parentRevisionId = null,
  jobId = null,
}) {
  const delivered = outputPath ?? sceneOutputPath(scenePath, config);
  if (!fs.existsSync(delivered)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `Cannot archive a revision: no output at ${delivered}`, { outputPath: delivered });
  }
  const id = newRevisionId();
  const revDir = revisionPath(scenePath, id);
  // Write into a temp sibling and rename, so a crash mid-archive can never
  // leave a folder that lists as a (partial) revision.
  const stageDir = revDir + '.tmp-' + process.pid;
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  const ext = path.extname(delivered);
  const outputFile = `output${ext}`;
  await linkOrCopy(delivered, path.join(stageDir, outputFile));

  // The render's review evidence rides along when it exists — the contact
  // sheet is the revision's visual preview, and it is already computed.
  for (const [suffix, name] of [['.contact.png', 'output.contact.png'], ['.review.json', 'output.review.json']]) {
    const src = delivered + suffix;
    if (fs.existsSync(src)) await linkOrCopy(src, path.join(stageDir, name)).catch(() => {});
  }

  const sourceFiles = await snapshotSource(scenePath, path.join(stageDir, 'source'), {
    outDirName: config?.output?.dir ?? 'out',
  });

  const createdAt = new Date().toISOString();
  const doc = {
    schema: 'motion-studio.revision/1',
    id,
    createdAt,
    agent: agent ?? null,
    frames,
    outputFile,
    config: {
      name: config?.name ?? null,
      fps: config?.fps ?? null,
      width: config?.width ?? null,
      height: config?.height ?? null,
      durationInFrames: config?.durationInFrames ?? null,
      format: config?.output?.format ?? 'mp4',
    },
    renderMeta: renderMeta ?? null,
    outputIdentity: outputIdentity(delivered),
    ...(note ? { note } : {}),
    ...(adviceIds.length ? { adviceIds } : {}),
    ...(parentRevisionId ? { parentRevisionId } : {}),
    ...(jobId ? { jobId } : {}),
    source: { files: sourceFiles.length, bytes: sourceFiles.reduce((n, f) => n + f.bytes, 0), manifest: sourceFiles },
  };
  await writeJsonAtomic(path.join(stageDir, 'revision.json'), doc);
  await fsp.rename(stageDir, revDir);
  await writeJsonAtomic(path.join(revisionsRoot(scenePath), 'current.json'), { revisionId: id, updatedAt: createdAt });
  return { id, path: revDir, createdAt, outputFile, source: doc.source };
}

/** The scene's current revision id, or null when none has been archived. */
export async function currentRevisionId(scenePath) {
  try {
    const raw = await fsp.readFile(path.join(revisionsRoot(scenePath), 'current.json'), 'utf8');
    const id = JSON.parse(raw)?.revisionId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** Read one revision's document, or throw revision_not_found. */
export async function getRevision(scenePath, revisionId) {
  const dir = revisionPath(scenePath, revisionId);
  let doc;
  try {
    doc = JSON.parse(await fsp.readFile(path.join(dir, 'revision.json'), 'utf8'));
  } catch {
    throw new EngineError(ErrorCodes.REVISION_NOT_FOUND, `No such revision "${revisionId}"`, { revisionId });
  }
  return { ...doc, path: dir };
}

/**
 * All archived revisions, newest first, with the current one flagged.
 * The `manifest` detail of each source snapshot is elided from listings —
 * revision.json keeps it for provenance, but a history strip does not need
 * a per-file inventory to render a card.
 */
export async function listRevisions(scenePath) {
  const root = revisionsRoot(scenePath);
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const current = await currentRevisionId(scenePath);
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.name.includes('.tmp-')) continue;
    try {
      const doc = JSON.parse(await fsp.readFile(path.join(root, d.name, 'revision.json'), 'utf8'));
      const { manifest, ...source } = doc.source ?? {};
      out.push({
        ...doc,
        source,
        current: doc.id === current,
        hasContactSheet: fs.existsSync(path.join(root, d.name, 'output.contact.png')),
      });
    } catch { /* a folder without revision.json is not a revision */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** Absolute path of a revision's archived artefact, existence-checked. */
export function revisionFilePath(scenePath, revisionId, name) {
  const allowed = new Set(['output.contact.png', 'output.review.json']);
  const dir = revisionPath(scenePath, revisionId);
  const doc = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'revision.json'), 'utf8')); }
    catch { return null; }
  })();
  if (!doc) {
    throw new EngineError(ErrorCodes.REVISION_NOT_FOUND, `No such revision "${revisionId}"`, { revisionId });
  }
  if (name !== doc.outputFile && !allowed.has(name)) {
    throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Not a revision artefact: ${name}`, { name });
  }
  const abs = path.join(dir, name);
  if (!fs.existsSync(abs)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `Revision "${revisionId}" has no ${name}`, { revisionId, name });
  }
  return abs;
}

/**
 * Repoint the scene's live output at an archived revision (v0.23).
 *
 * This is the AI-only "use this version" mutation: it changes which bytes sit
 * at the canonical output path and which revision the pointer names — nothing
 * else. It never regenerates media, never rewrites a revision directory, and
 * never deletes newer history.
 *
 * Refuses with `revision_mismatch` when the archived render no longer matches
 * the scene's current settings — repointing would make a film build that this
 * scene's own plan immediately calls stale, which helps nobody.
 */
export async function useRevision({ scenePath, config, revisionId, agent = currentAgentId() }) {
  const rev = await getRevision(scenePath, revisionId);
  const already = await currentRevisionId(scenePath);

  // Compare the revision's recorded render facts against today's config with
  // the same rule the film planner uses, so this check and stale_render can
  // never disagree about what "matches" means.
  const meta = rev.renderMeta ?? { frames: rev.frames, ...rev.config };
  const stale = renderStaleness(meta, config);
  if (stale) {
    throw new EngineError(ErrorCodes.REVISION_MISMATCH,
      `Revision "${revisionId}" was rendered at settings the scene no longer has ` +
      `(${stale.changed.map((k) => `${k} ${stale.recorded[k]} → ${stale.current[k]}`).join(', ')}). ` +
      'Update the scene settings back, or create a new revision instead.',
      { revisionId, changed: stale.changed, recorded: stale.recorded, current: stale.current });
  }

  const archived = path.join(rev.path, rev.outputFile);
  if (!fs.existsSync(archived)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `Revision "${revisionId}" has no archived output`, { revisionId });
  }

  const outputPath = sceneOutputPath(scenePath, config);
  // Same staging + one-rename protocol as a render: the live output is never
  // half-written, and a failure leaves the prior delivery untouched.
  const staged = await prepareStagingOutput(outputPath, { jobId: `use-${revisionId}` });
  await fsp.copyFile(archived, staged);
  await promoteStagingOutput({ stagedPath: staged, outputPath });

  // Re-stamp the sidecar from the revision's recorded metadata with the NEW
  // file identity, so planFilm sees a verified render rather than a mystery.
  const body = {
    ...(rev.renderMeta ?? {}),
    frames: rev.frames,
    renderedAt: rev.renderMeta?.renderedAt ?? rev.createdAt,
    restoredAt: new Date().toISOString(),
    restoredFrom: revisionId,
    ...(agent ? { restoredBy: agent } : {}),
    outputIdentity: outputIdentity(outputPath),
  };
  try {
    await writeJsonAtomic(renderMetaPath(scenePath, config), body);
  } catch { /* best-effort, same as writeRenderMeta */ }

  // The archived review pair describes the restored bytes exactly; put copies
  // beside the live output so the Studio's evidence views keep working.
  for (const [name, suffix] of [['output.contact.png', '.contact.png'], ['output.review.json', '.review.json']]) {
    const src = path.join(rev.path, name);
    if (!fs.existsSync(src)) continue;
    try {
      const stagedSide = await prepareStagingOutput(outputPath + suffix, { jobId: `use-${revisionId}` });
      await fsp.copyFile(src, stagedSide);
      await promoteStagingOutput({ stagedPath: stagedSide, outputPath: outputPath + suffix });
    } catch { /* evidence is best-effort; the delivery is what matters */ }
  }

  await writeJsonAtomic(path.join(revisionsRoot(scenePath), 'current.json'), {
    revisionId, updatedAt: new Date().toISOString(),
  });
  return {
    revisionId,
    previousRevisionId: already,
    outputPath,
    frames: rev.frames,
    restored: true,
  };
}

/**
 * Delete old, unpinned revisions beyond a retention count (v0.23).
 *
 * Explicit and caller-driven — cleanup never runs inside a promotion path.
 * Never deletes the current revision or any id in `pinned` (delivery
 * manifests and advice evidence pin what they reference).
 *
 * @returns {{ kept: string[], deleted: string[] }}
 */
export async function pruneRevisions({ scenePath, keep = 10, pinned = new Set() }) {
  const all = await listRevisions(scenePath);
  const kept = [];
  const deleted = [];
  let retained = 0;
  for (const rev of all) { // newest first
    const pin = rev.current || pinned.has(rev.id);
    if (pin || retained < keep) {
      kept.push(rev.id);
      if (!pin) retained += 1;
      continue;
    }
    await fsp.rm(revisionPath(scenePath, rev.id), { recursive: true, force: true });
    deleted.push(rev.id);
  }
  return { kept, deleted };
}
