/**
 * Safe delivery-file staging and promotion.
 *
 * A renderer must never stream an in-progress encode into the name callers use
 * as a deliverable.  A cancelled ffmpeg process can leave a syntactically valid
 * but short file, and an audio re-mux used to briefly remove the old file
 * altogether.  These helpers give scene renders and film builds one protocol:
 *
 *   final out/name.mp4 stays untouched
 *     → encode out/.staging/name-<job>.mp4
 *     → validate it
 *     → rename it over the final name
 *
 * `rename` is deliberately the only promotion primitive.  Do not add a
 * delete-then-rename fallback: if replacement cannot be performed atomically on
 * the host filesystem, failing while retaining the old delivery is safer than
 * making a gap at the delivery name.
 *
 * The side-step below is NOT that fallback, and the difference is the whole
 * point: it never deletes the old delivery before the new one is in place.  It
 * renames the old one aside — which Windows permits even while a reader holds
 * it open — puts the new one at the delivery name, and only then drops the
 * aside copy.  If the second rename fails, the aside copy is renamed straight
 * back, so the failure mode is identical to before: old delivery intact.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';

/** The hidden folder that holds incomplete/reviewable outputs beside a delivery. */
export function stagingDir(outputPath) {
  return path.join(path.dirname(path.resolve(outputPath)), '.staging');
}

/**
 * Choose a sibling staging path without exposing a caller-controlled directory.
 * A JobManager id is ideal; direct renderer callers get a UUID instead.
 */
export function stagingOutputPath(outputPath, { jobId = randomUUID() } = {}) {
  const finalPath = path.resolve(outputPath);
  const ext = path.extname(finalPath);
  const base = path.basename(finalPath, ext);
  // Direct core callers historically pass `jobId: null`; treat that exactly
  // like an omitted id so concurrent/direct retries cannot collide on
  // `name-null.ext` in the staging folder.
  const id = jobId == null || jobId === '' ? randomUUID() : jobId;
  // Job ids are UUIDs today, but this helper is a core boundary: never let a
  // future caller turn an id into a path segment.
  const token = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stagingDir(finalPath), `${base}-${token}${ext}`);
}

/** Ensure the staging folder exists, returning a unique path inside it. */
export async function prepareStagingOutput(outputPath, opts = {}) {
  const stagedPath = stagingOutputPath(outputPath, opts);
  await fsp.mkdir(path.dirname(stagedPath), { recursive: true });
  return stagedPath;
}

/**
 * Fail a held delivery BEFORE the work, not after it (v0.24).
 *
 * Promotion is the last step of a render, so a destination nobody can replace
 * is discovered only once every frame has already been captured and encoded.
 * Measured incident: two consecutive 600-frame renders each ran to 100%, took
 * ~3.5 minutes apiece, and then died with EPERM at the rename because a reader
 * held out/output.mp4 open — roughly seven minutes spent to learn something a
 * single file handle could have reported at submission time.
 *
 * The probe is a WRITE open of the existing destination, which is the access
 * that a Windows sharing violation actually denies: a reader that granted only
 * FILE_SHARE_READ blocks both this open and the later rename, while a reader
 * that granted delete/write sharing permits both. It never truncates (mode
 * 'r+'), never creates, and treats a missing destination as fine — the first
 * render of a scene has nothing to replace.
 *
 * Deliberately advisory about its own limits: a holder can appear in the window
 * between this check and the promotion, so this reduces wasted work rather than
 * guaranteeing success. promoteStagingOutput keeps its full backoff and
 * side-step path unchanged.
 */
export async function assertDeliveryWritable({ outputPath, openImpl = fsp.open }) {
  const finalPath = path.resolve(outputPath);
  let handle;
  try {
    handle = await openImpl(finalPath, 'r+');
  } catch (err) {
    // Nothing there yet, or a path we cannot even stat — both are the
    // renderer's problem later, not a held-file problem now.
    if (err?.code === 'ENOENT') return;
    if (!RETRYABLE_RENAME_CODES.has(err?.code)) return;
    throw new EngineError(
      ErrorCodes.DISK_ERROR,
      `Another process is holding the output file open, so this render could not be delivered: ${finalPath}. `
      + 'Close whatever is playing it (the Studio scene page is the usual holder), or give this target a different '
      + 'output filename with update_scene_config { patch: { output: { filename } } }, then render again.',
      { outputPath: finalPath, code: err.code, phase: 'preflight' },
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Transient Windows lock codes worth waiting out (v0.23). Measured incident:
 * three consecutive re-renders failed EPERM renaming over an existing
 * delivery while no process held the file open — an unlink of the same path
 * succeeded immediately afterwards. That is the signature of an antivirus /
 * indexer briefly locking the DESTINATION during rename-over-existing, not
 * of a real owner. ENOENT and friends are not here on purpose: a missing
 * staged file will not appear by waiting.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Backoff schedule (~1.5s total) — scanner locks clear in well under that. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

/** Marks a previous delivery moved aside so a held-open name could be reused. */
const SUPERSEDED_MARK = '.superseded-';

/**
 * Replace a destination that a reader is holding open (v0.23.1).
 *
 * Measured, and the reason this exists: while the Studio streams a scene's
 * output to a `<video>` (a human watching the film page), Windows fails
 * `rename(staged → output.mp4)` with EPERM for as long as that page is open —
 * so a human watching a scene could fail the director's re-render of it. The
 * bounded backoff above cannot help, because the handle is held for minutes,
 * not milliseconds.
 *
 * What Windows *does* allow is renaming the open file itself. So: move the old
 * delivery aside, put the new one in its place, then drop the aside copy. The
 * reader keeps streaming the bytes it already opened — its handle follows the
 * inode, not the name — and sees no corruption.
 *
 * Ordering is the safety property. The delivery name is only ever empty
 * between two renames, and if the second one fails the first is undone, so a
 * failure still leaves the previous delivery exactly where it was.
 */
async function replaceHeldDestination(staged, finalPath, renameImpl, unlinkImpl) {
  const aside = `${finalPath}${SUPERSEDED_MARK}${process.pid}`;
  await unlinkImpl(aside).catch(() => {});  // a previous attempt may have left one
  await renameImpl(finalPath, aside);
  try {
    await renameImpl(staged, finalPath);
  } catch (err) {
    // Put the old delivery back before surfacing the failure.
    await renameImpl(aside, finalPath).catch(() => {});
    throw err;
  }
  // Best effort: Node opens read streams with FILE_SHARE_DELETE, so this
  // normally succeeds even mid-stream. If a reader without it holds on, the
  // leftover is inert and self-describing rather than a corrupted delivery.
  await unlinkImpl(aside).catch(() => {});
  return finalPath;
}

/**
 * Atomically replace the delivery file with a fully-written staging file.
 *
 * Node delegates replacement semantics to the native rename operation.  If the
 * filesystem refuses an existing destination, deliberately surface DISK_ERROR
 * rather than deleting a valid prior delivery first — but ride out a
 * transient scanner lock with a bounded backoff first, because failing a
 * finished multi-minute render over a sub-second lock helps nobody.  The
 * promotion primitive remains rename-only: no delete-then-rename fallback,
 * ever, because a gap at the delivery name is worse than a failure.
 *
 * @param {object} opts
 * @param {string} opts.stagedPath
 * @param {string} opts.outputPath
 * @param {Function} [opts.renameImpl]  injectable for tests (default fsp.rename)
 * @param {Function} [opts.unlinkImpl]  injectable for tests (default fsp.unlink)
 */
export async function promoteStagingOutput({
  stagedPath, outputPath, renameImpl = fsp.rename, unlinkImpl = fsp.unlink,
}) {
  const staged = path.resolve(stagedPath);
  const finalPath = path.resolve(outputPath);
  if (staged === finalPath) {
    throw new EngineError(ErrorCodes.INTERNAL, 'staging output must differ from the delivery path', { stagedPath, outputPath });
  }
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      await renameImpl(staged, finalPath);
      return finalPath;
    } catch (err) {
      lastErr = err;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // The backoff is exhausted and the lock is still there. If a destination
  // exists, the likely holder is a reader (the Studio streaming this very
  // file), which no amount of waiting will clear — side-step it.
  if (RETRYABLE_RENAME_CODES.has(lastErr?.code) && fs.existsSync(finalPath)) {
    try {
      return await replaceHeldDestination(staged, finalPath, renameImpl, unlinkImpl);
    } catch (err) {
      lastErr = err;
    }
  }

  throw new EngineError(
    ErrorCodes.DISK_ERROR,
    `Could not promote staged output to its delivery path: ${lastErr.message}`,
    { stagedPath: staged, outputPath: finalPath },
  );
}

/** A cheap file identity for detecting a sidecar left beside a different output. */
export function outputIdentity(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * `null` means a legacy sidecar supplied no identity.  It is intentionally not
 * treated as a match: callers can present it as unverified rather than assume
 * an old metadata file describes a newly-replaced delivery.
 */
export function outputIdentityMatches(recorded, filePath) {
  if (!recorded || !Number.isFinite(recorded.bytes) || !Number.isFinite(recorded.mtimeMs)) return null;
  const actual = outputIdentity(filePath);
  if (!actual) return false;
  return actual.bytes === recorded.bytes && actual.mtimeMs === recorded.mtimeMs;
}
