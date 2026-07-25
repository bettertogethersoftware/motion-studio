/**
 * Cross-process render lock (v0.11).
 *
 * Two renders writing one project is silent corruption, not a loud failure:
 * both processes write the same frame files and both run ffmpeg on the same
 * output path, so the survivor is whichever finished last and any torn frame in
 * between is invisible. Observed for real — an orphaned background render raced
 * a foreground one through the same scene, and the only symptom was an
 * unexpected process count.
 *
 * `ErrorCodes.RENDER_ALREADY_IN_PROGRESS` has existed since v0.2 but was never
 * raised by anything; this is the guard it was reserved for.
 *
 * The lock is a `.render.lock` file in the project folder holding the owning
 * pid. Liveness, not age, decides staleness: a render may legitimately run for
 * hours, so a timeout would eventually evict a healthy job, whereas a crashed
 * owner's pid stops existing immediately.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';

export const LOCK_FILENAME = '.render.lock';

export function lockPath(projectPath) {
  return path.join(projectPath, LOCK_FILENAME);
}

/**
 * Is `pid` still running? EPERM means it exists but belongs to another user —
 * that is very much "alive", so it must not be treated as a stale lock.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function readLock(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    // Unreadable or truncated (e.g. killed mid-write) — treat as no owner.
    return null;
  }
}

/**
 * Take the render lock for a project.
 *
 * @param {string} projectPath
 * @param {object} [opts]
 * @param {number} [opts.pid]    owning pid (override for tests)
 * @param {string} [opts.label]  what is holding it, for the error message
 * @returns {Promise<{release: () => Promise<void>, path: string}>}
 * @throws {EngineError} RENDER_ALREADY_IN_PROGRESS if a live process holds it
 */
export async function acquireRenderLock(projectPath, { pid = process.pid, label = 'render' } = {}) {
  const file = lockPath(projectPath);
  const body = JSON.stringify({ pid, label, host: os.hostname(), startedAt: new Date().toISOString() });

  await fsp.mkdir(projectPath, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists — an atomic create, so two processes
      // racing here cannot both believe they won.
      const fh = await fsp.open(file, 'wx');
      try { await fh.writeFile(body, 'utf8'); } finally { await fh.close(); }
      return { path: file, release: () => releaseRenderLock(file, pid) };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new EngineError(ErrorCodes.DISK_ERROR, `could not take the render lock: ${err.message}`, { path: file });
      }
      const held = await readLock(file);

      // Re-entrant within one process: nested calls in the same pid are our own.
      if (held && held.pid === pid) return { path: file, release: async () => {} };

      if (held && isProcessAlive(held.pid)) {
        throw new EngineError(
          ErrorCodes.RENDER_ALREADY_IN_PROGRESS,
          `another render (pid ${held.pid}${held.host ? ` on ${held.host}` : ''}) is already writing this project. ` +
            'Wait for it to finish or cancel it — two renders writing one project corrupt each other\'s frames. ' +
            `If that process is gone, delete ${LOCK_FILENAME} in the project folder.`,
          { pid: held.pid, startedAt: held.startedAt, host: held.host, lockPath: file },
        );
      }

      // Owner is dead (or the file was unreadable): clear it and retry once.
      await fsp.rm(file, { force: true });
    }
  }

  throw new EngineError(ErrorCodes.RENDER_ALREADY_IN_PROGRESS,
    'could not take the render lock after clearing a stale one', { lockPath: file });
}

/** Release only if we still own it, so a stale-lock takeover can't be undone by the loser. */
export async function releaseRenderLock(file, pid = process.pid) {
  const held = await readLock(file);
  if (held && held.pid !== pid) return;
  await fsp.rm(file, { force: true }).catch(() => {});
}
