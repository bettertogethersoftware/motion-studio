/**
 * Vendor lockfile for the optional 3D library builds (v0.13).
 *
 * The builds live in engine/vendor/libs, which is **git-ignored**, so nothing in
 * the repo recorded which bytes a render was made against. Two independent
 * problems came out of that:
 *
 *   acquisition — two machines running fetch-libs.mjs at different times can
 *                 vendor different builds.
 *   provenance  — a project could not say what it rendered against, even on one
 *                 machine.
 *
 * A version pin alone fixes only the first, and demonstrably not even that:
 * `cdn.babylonjs.com/babylon.js` and `cdn.babylonjs.com/v9.18.0/babylon.js` BOTH
 * self-report Version="9.18.0" and are different code — they diverge around byte
 * 2,317,477, where the floating build carries an extra `var t;`. A version string
 * is a claim; a hash is a fact. So the lock is content-addressed.
 *
 * The lockfile itself is committed (unlike the artifacts it describes) and lives
 * at engine/vendor.lock.json — deliberately NOT inside engine/vendor/, which is
 * ignored wholesale. Same split npm and cargo use: ignored artifacts, tracked lock.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Committed lock describing the git-ignored vendor/libs contents. */
export function vendorLockPath() {
  return process.env.MOTION_STUDIO_VENDOR_LOCK || path.resolve(__dirname, '../../vendor.lock.json');
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Read the version a build reports about *itself*, so the lock records what the
 * bytes say rather than what the URL promised. Babylon embeds `Version="9.18.0"`;
 * Three embeds `REVISION="134"`. Returns null when nothing is recognisable —
 * unknown is fine, wrong would not be.
 */
export function detectVersion(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4_000_000));
  const babylon = /Version\s*=\s*"(\d+\.\d+\.\d+)"/.exec(head)
    ?? /babylonjs@(\d+\.\d+\.\d+)/.exec(head);
  if (babylon) return babylon[1];
  const three = /REVISION\s*=\s*["'](\d+[\w.]*)["']/.exec(head);
  if (three) return three[1];
  return null;
}

export async function readLock() {
  try {
    const raw = await fsp.readFile(vendorLockPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.files ?? {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new EngineError(ErrorCodes.DISK_ERROR, `vendor.lock.json is unreadable: ${err.message}`,
      { path: vendorLockPath() });
  }
}

export async function writeLock(files) {
  // Sorted keys so the committed file has a stable diff.
  const sorted = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k];
  const body = {
    comment: 'Content hashes for the git-ignored engine/vendor/libs builds. Run "node scripts/fetch-libs.mjs --update" to change.',
    lockfileVersion: 1,
    files: sorted,
  };
  await fsp.writeFile(vendorLockPath(), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

/** Describe a build from its bytes: what it is, not what we hoped it was. */
export function describe(buf, url) {
  return { version: detectVersion(buf), sha256: sha256(buf), bytes: buf.length, url };
}

/**
 * Verify one vendored file against the lock.
 * @returns {{ status: 'ok'|'missing'|'unlocked'|'mismatch', expected?, actual? }}
 */
export function verifyOne(vendorKey, absPath, lock) {
  const entry = lock[vendorKey];
  if (!fs.existsSync(absPath)) return { status: 'missing', expected: entry };
  const actual = describe(fs.readFileSync(absPath), entry?.url);
  if (!entry) return { status: 'unlocked', actual };
  if (entry.sha256 !== actual.sha256) return { status: 'mismatch', expected: entry, actual };
  return { status: 'ok', actual };
}

/**
 * Verify every file the registry expects. Never throws — callers decide whether
 * drift is fatal (fetch-libs does; addLibrary only warns, so a deliberate local
 * swap can still be rendered with).
 */
export async function verifyVendoredLibraries(LIBRARIES, libsDir) {
  const lock = await readLock();
  const results = [];
  for (const spec of Object.values(LIBRARIES)) {
    for (const f of [...spec.files, ...Object.values(spec.addons || {})]) {
      results.push({
        library: spec.id,
        file: f.vendor,
        ...verifyOne(f.vendor, path.join(libsDir, f.vendor), lock),
      });
    }
  }
  return {
    locked: Object.keys(lock).length > 0,
    results,
    ok: results.every((r) => r.status === 'ok'),
    problems: results.filter((r) => r.status === 'mismatch' || r.status === 'missing'),
  };
}
