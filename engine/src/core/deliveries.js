/**
 * Immutable deliveries (v0.23) — every successful film build, kept.
 *
 * `out/<name>.mp4` is the film's LIVE delivery: one file, atomically replaced
 * by each build (v0.22's staged promotion). That shape is right for "give me
 * the film", and wrong for review: the human opens the Studio hours after the
 * AI moved on, watches, and leaves advice — and their advice must bind to the
 * exact film they watched, not to whatever the AI has rebuilt since. So each
 * promoted build is also archived immutably:
 *
 *   <film>/deliveries/
 *     current.json          { deliveryId } — the newest master build
 *     <delivery>/
 *       manifest.json       the frozen record: layout, per-scene revision
 *                           ids, tracks, captions, overlays, sequences,
 *                           signature, review warnings, file identity
 *       film.<ext>          the delivered video (hardlink; copy fallback)
 *       film.srt            caption sidecar, when the film has captions
 *       film.contact.png    the build's contact sheet
 *       film.review.json    the build's review report
 *
 * The manifest maps every film frame back to the segment, scene revision and
 * sequence that produced it — which is what lets a click on played video
 * resolve to "Sequence 2 › Scene demo-shot at frame 42 of revision rev-…",
 * and lets that resolution stay correct forever. Hardlinks make the archive
 * free on one volume; the engine's rename-only replacement of the live
 * output means an archived inode is never written again.
 *
 * Archiving is best-effort at the call site (a promoted build must not be
 * failed by history-keeping), and the functions here throw honestly.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';
import { outputIdentity } from './delivery.js';
import { currentRevisionId } from './revisions.js';

export const DELIVERIES_DIR = 'deliveries';

export function newDeliveryId(now = Date.now()) {
  return `del-${String(now).padStart(13, '0')}-${randomUUID().slice(0, 8)}`;
}

export function deliveriesRoot(filmPath) {
  return path.join(filmPath, DELIVERIES_DIR);
}

export function deliveryPath(filmPath, deliveryId) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(deliveryId ?? '')) || String(deliveryId) === 'current.json') {
    throw new EngineError(ErrorCodes.DELIVERY_NOT_FOUND, `No such delivery "${deliveryId}"`, { deliveryId });
  }
  return path.join(deliveriesRoot(filmPath), String(deliveryId));
}

async function writeJsonAtomic(abs, obj) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, abs);
}

async function linkOrCopy(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await fsp.link(src, dest); }
  catch { await fsp.copyFile(src, dest); }
}

/**
 * Archive a just-promoted film build as an immutable delivery.
 *
 * @param {object} opts
 * @param {object} opts.store   WorkspaceStore (resolves scene paths for revision ids)
 * @param {object} opts.film    the film document (with id/path)
 * @param {object} opts.result  buildFilmArtifact's return value
 * @param {string} [opts.agent]
 * @param {string} [opts.jobId]
 * @returns {{ id, path, manifest }}
 */
export async function archiveDelivery({ store, film, result, agent = null, jobId = null }) {
  const outputPath = result.outputPath;
  if (!outputPath || !fs.existsSync(outputPath)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `Cannot archive a delivery: no output at ${outputPath}`, { outputPath });
  }
  const id = newDeliveryId();
  const dir = deliveryPath(film.path, id);
  const stage = dir + '.tmp-' + process.pid;
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });

  const ext = path.extname(outputPath);
  const outputFile = `film${ext}`;
  await linkOrCopy(outputPath, path.join(stage, outputFile));
  if (result.srtPath && fs.existsSync(result.srtPath)) {
    await linkOrCopy(result.srtPath, path.join(stage, 'film.srt')).catch(() => {});
  }
  for (const [key, name] of [['contactPath', 'film.contact.png'], ['reviewPath', 'film.review.json']]) {
    const src = result.review?.[key];
    if (src && fs.existsSync(src)) await linkOrCopy(src, path.join(stage, name)).catch(() => {});
  }

  // Freeze the frame→revision mapping. The layout already places every
  // segment; here each scene segment gains the revision id whose bytes the
  // concat consumed, and footage gains the file identity that played.
  const segments = [];
  for (const seg of result.sceneLayout ?? []) {
    if (seg.kind === 'footage') {
      let identity = null;
      try { identity = outputIdentity(path.join(film.path, seg.footage)); } catch { /* reported null */ }
      segments.push({ ...seg, fileIdentity: identity });
      continue;
    }
    let revisionId = null;
    try { revisionId = await currentRevisionId(store.scenePath(seg.sceneId)); }
    catch { /* a layout entry the store cannot resolve keeps revisionId null */ }
    segments.push({ ...seg, revisionId });
  }

  const createdAt = new Date().toISOString();
  const deliverableId = result.deliverable?.id ?? 'master';
  const manifest = {
    schema: 'motion-studio.delivery/1',
    id,
    filmId: film.id,
    createdAt,
    agent,
    ...(jobId ? { jobId } : {}),
    deliverable: result.deliverable ?? { id: 'master' },
    outputFile,
    sourceOutputPath: outputPath,
    totalFrames: result.totalFrames ?? null,
    fps: result.fps ?? null,
    format: result.format ?? null,
    durationSeconds: result.durationSeconds ?? null,
    segments,
    sequences: film.sequences ?? {},
    audio: film.audio ?? [],
    captions: film.captions ?? [],
    overlays: film.overlays ?? [],
    captionStyle: film.captionStyle ?? null,
    burnCaptions: !!film.burnCaptions,
    ...(result.audio ? { audioMeasurement: result.audio } : {}),
    ...(result.review?.warnings ? { reviewWarnings: result.review.warnings } : {}),
    reEncoded: !!result.reEncoded,
    outputIdentity: outputIdentity(outputPath),
  };
  await writeJsonAtomic(path.join(stage, 'manifest.json'), manifest);
  await fsp.rename(stage, dir);

  // The review surface follows the master; a variant build is archived and
  // listed but never becomes "the film" the Studio pins by default.
  if (deliverableId === 'master') {
    await writeJsonAtomic(path.join(deliveriesRoot(film.path), 'current.json'), {
      deliveryId: id, updatedAt: createdAt,
    });
  }
  return { id, path: dir, manifest };
}

/** The newest master delivery's id, or null before the first build. */
export async function currentDeliveryId(filmPath) {
  try {
    const raw = await fsp.readFile(path.join(deliveriesRoot(filmPath), 'current.json'), 'utf8');
    const id = JSON.parse(raw)?.deliveryId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** One delivery's frozen manifest, or delivery_not_found. */
export async function getDeliveryManifest(filmPath, deliveryId) {
  const dir = deliveryPath(filmPath, deliveryId);
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch {
    throw new EngineError(ErrorCodes.DELIVERY_NOT_FOUND, `No such delivery "${deliveryId}"`, { deliveryId });
  }
  return { ...manifest, path: dir };
}

/** All archived deliveries, newest first (light listing for pickers). */
export async function listDeliveries(filmPath) {
  const root = deliveriesRoot(filmPath);
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const current = await currentDeliveryId(filmPath);
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.name.includes('.tmp-')) continue;
    try {
      const m = JSON.parse(await fsp.readFile(path.join(root, d.name, 'manifest.json'), 'utf8'));
      const st = await fsp.stat(path.join(root, d.name, m.outputFile)).catch(() => null);
      out.push({
        id: m.id,
        createdAt: m.createdAt,
        agent: m.agent ?? null,
        deliverableId: m.deliverable?.id ?? 'master',
        outputFile: m.outputFile,
        totalFrames: m.totalFrames,
        fps: m.fps,
        durationSeconds: m.durationSeconds,
        segments: (m.segments ?? []).length,
        bytes: st?.size ?? null,
        current: m.id === current,
      });
    } catch { /* not a delivery */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** Absolute path of one archived delivery artefact, allow-listed by name. */
export function deliveryFilePath(filmPath, deliveryId, name) {
  const dir = deliveryPath(filmPath, deliveryId);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch {
    throw new EngineError(ErrorCodes.DELIVERY_NOT_FOUND, `No such delivery "${deliveryId}"`, { deliveryId });
  }
  const allowed = new Set([manifest.outputFile, 'film.srt', 'film.contact.png', 'film.review.json', 'manifest.json']);
  if (!allowed.has(name)) {
    throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, `Not a delivery artefact: ${name}`, { name });
  }
  const abs = path.join(dir, name);
  if (!fs.existsSync(abs)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `Delivery "${deliveryId}" has no ${name}`, { deliveryId, name });
  }
  return abs;
}

/**
 * Resolve a film frame against a frozen manifest (pure).
 *
 * This is the click-to-selection primitive: the Studio's player asks "the
 * human clicked frame N of delivery D — what were they looking at?" and the
 * answer must come from D's manifest, never from the film's present state.
 *
 * @returns {{ filmFrame, timeSeconds, segment, segmentFrame, sequence,
 *             captions, overlays, audio }}
 */
export function resolveDeliveryFrame(manifest, filmFrame) {
  const frame = Number(filmFrame);
  if (!Number.isInteger(frame) || frame < 0) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'filmFrame must be a non-negative integer', { filmFrame });
  }
  const total = manifest.totalFrames ?? 0;
  const clamped = total > 0 ? Math.min(frame, total - 1) : frame;
  const segments = manifest.segments ?? [];
  let segment = null;
  for (const seg of segments) {
    const from = seg.filmOffset ?? 0;
    if (clamped >= from && clamped < from + (seg.durationInFrames ?? 0)) { segment = seg; break; }
  }
  if (!segment && segments.length) segment = segments[segments.length - 1];
  const segmentFrame = segment ? clamped - (segment.filmOffset ?? 0) : null;
  const fps = manifest.fps ?? null;
  const overlapping = (items) => (items ?? [])
    .filter((c) => Number.isInteger(c.fromFrame) && clamped >= c.fromFrame && clamped < (c.toFrame ?? c.fromFrame))
    .map((c) => ({ ...c }));
  const audioAt = (tracks) => (tracks ?? [])
    .filter((t) => {
      const start = t.startInFrames ?? 0;
      // Without a recorded trim there is no end to test against; report the
      // track as present from its start onward, which is what the UI needs
      // to offer "this narration" as a target.
      const head = t.trimStartInFrames ?? 0;
      const end = t.trimEndInFrames != null ? start + (t.trimEndInFrames - head) : Infinity;
      return clamped >= start && clamped < end;
    })
    .map((t) => ({ ...t }));
  return {
    filmFrame: clamped,
    timeSeconds: fps ? Number((clamped / fps).toFixed(3)) : null,
    segment,
    segmentFrame,
    sequence: segment?.sequence ?? null,
    captions: overlapping(manifest.captions),
    overlays: overlapping(manifest.overlays),
    audio: audioAt(manifest.audio),
  };
}

/** Revision ids frozen into any delivery manifest — retention must keep them. */
export async function deliveryPinnedRevisionIds(filmPath) {
  const pinned = new Set();
  for (const d of await listDeliveries(filmPath)) {
    try {
      const m = await getDeliveryManifest(filmPath, d.id);
      for (const seg of m.segments ?? []) if (seg.revisionId) pinned.add(seg.revisionId);
    } catch { /* skip unreadable */ }
  }
  return pinned;
}
