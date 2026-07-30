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
 * Atomically replace the delivery file with a fully-written staging file.
 *
 * Node delegates replacement semantics to the native rename operation.  If the
 * filesystem refuses an existing destination, deliberately surface DISK_ERROR
 * rather than deleting a valid prior delivery first.
 */
export async function promoteStagingOutput({ stagedPath, outputPath }) {
  const staged = path.resolve(stagedPath);
  const finalPath = path.resolve(outputPath);
  if (staged === finalPath) {
    throw new EngineError(ErrorCodes.INTERNAL, 'staging output must differ from the delivery path', { stagedPath, outputPath });
  }
  try {
    await fsp.rename(staged, finalPath);
  } catch (err) {
    throw new EngineError(
      ErrorCodes.DISK_ERROR,
      `Could not promote staged output to its delivery path: ${err.message}`,
      { stagedPath: staged, outputPath: finalPath },
    );
  }
  return finalPath;
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
