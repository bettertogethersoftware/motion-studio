/**
 * Vendor provenance for the 3D library builds (v0.13).
 *
 * **vendor/libs is committed** (the only part of vendor that is —
 * ~9 MB of immutable third-party JS, three.js MIT and Babylon Apache-2.0). So git
 * already guarantees every clone has identical bytes, and this module is NOT the
 * integrity mechanism for them. It answers the two questions git cannot:
 *
 *   origin  — which upstream build produced the committed bytes? Git records
 *             content, never where it came from. vendor.lock.json pairs each file
 *             with the exact URL + version + hash it was fetched from.
 *   drift   — fetch-libs.mjs can overwrite committed files. Hash-checking on
 *             download turns an accidental dependency bump into a refusal
 *             instead of an unreviewed diff in someone's next commit.
 *
 * Content-addressed rather than version-pinned, because a version string does not
 * identify a build: `cdn.babylonjs.com/babylon.js` and
 * `cdn.babylonjs.com/v9.18.0/babylon.js` BOTH self-report Version="9.18.0" and are
 * different code — they diverge around byte 2,317,477, where the floating build
 * carries an extra `var t;`. A version string is a claim; a hash is a fact.
 *
 * Also used by WorkspaceStore.addLibrary to stamp config.libraryBuilds: a scene
 * copies these files at a point in time, so "what does the repo hold now" (git)
 * and "what did this scene copy" (libraryBuilds) are different facts once the
 * libraries are ever upgraded.
 *
 * The lockfile lives at vendor.lock.json — outside vendor/, whose
 * *contents* are ignored by default with only libs/ negated back in.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from './errors.js';
import { addonFiles } from './libraries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Origin record for the committed vendor/libs builds. */
export function vendorLockPath() {
  return process.env.MOTION_STUDIO_VENDOR_LOCK || path.resolve(__dirname, '../../../vendor.lock.json');
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
    comment: 'Upstream origin of the committed vendor/libs builds. Git guarantees the bytes; this records where they came from and stops a re-fetch changing them silently. Run "node scripts/fetch-libs.mjs --update" to change.',
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
    for (const f of [...spec.files, ...Object.values(spec.addons || {}).flatMap(addonFiles)]) {
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
