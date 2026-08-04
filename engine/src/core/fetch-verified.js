/**
 * Verified downloads — the transport half of the pack mechanism (vendor
 * boundary plan, Phase 3). Deliberately vendor-agnostic and dependency-free:
 * pinned URL + pinned SHA-256 in, verified bytes on disk out. What to fetch
 * (the manifest) is vendor knowledge and lives in vendors/default/packs.js;
 * this module must stay usable in a core-only install.
 *
 * The contract, proven by test/fetch-soundfont.test.js since Slice 0:
 * stream to a `.part` file, verify BEFORE the destination name exists,
 * atomic rename, idempotent re-runs, and a structured offline failure —
 * never a hang, never a stack trace, never unverified bytes under the
 * destination name.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export async function sha256Of(filePath) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Download `url` to `dest` with hash verification. The destination path only
 * ever comes into existence containing verified bytes; a mismatch leaves the
 * `.part` file behind for diagnosis and reports rather than renaming.
 */
export async function fetchVerified({ url, sha256, dest, retries = 3, fetchImpl = fetch }) {
  if (fs.existsSync(dest) && (await sha256Of(dest)) === sha256) {
    return { ok: true, reused: true, dest };
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
      const got = await sha256Of(part);
      if (got !== sha256) {
        return {
          ok: false, code: 'hash_mismatch', dest, part,
          message: `Downloaded file hashes ${got}, expected ${sha256}. Refusing to install it; ` +
            `the partial file is kept at ${part} for diagnosis. The mirror may have changed the ` +
            'file — verify upstream before updating the pin.',
        };
      }
      await fsp.rename(part, dest);
      return { ok: true, reused: false, dest, attempt };
    } catch (err) {
      lastError = err;
      await fsp.rm(part, { force: true }).catch(() => {});
    }
  }
  return {
    ok: false, code: 'download_failed', dest,
    message: `Could not download ${url} after ${retries} attempts: ${lastError?.message}. ` +
      'If this machine is offline, fetch the file on another machine and place it at the destination ' +
      'path — synthesis only needs the file to exist there.',
  };
}
