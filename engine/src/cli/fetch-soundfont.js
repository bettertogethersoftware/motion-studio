/**
 * `npm run fetch-soundfont` — the pack-bootstrap pilot (Slice 0).
 *
 * A clean clone cannot synthesize music: the default `node` vendor needs a
 * General MIDI SoundFont and none is committed (40 MB does not belong in git
 * history). The decided policy (vendor-boundary plan §10) is
 * fetch-on-COMMAND: synthesis never downloads anything on its own — it
 * returns `music_unavailable` naming this command, and this command does one
 * verified download.
 *
 * This file is deliberately shaped like the pack mechanism the vendor
 * boundary plan's Phase 3 needs everywhere: pinned URL + pinned SHA-256,
 * stream to a `.part` file, verify BEFORE the destination name exists,
 * atomic rename, idempotent re-runs, and a structured offline failure. When
 * more packs arrive, `fetchVerified` is the piece they reuse.
 *
 * Exit codes: 0 fetched-or-already-present · 1 network failure ·
 * 2 hash mismatch (a mismatch is never renamed into place).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { vendorDir } from '../core/paths.js';

export const SOUNDFONT_PACK = Object.freeze({
  name: 'MuseScore_General.sf3',
  // MIT-licensed General MIDI SoundFont, MuseScore's canonical mirror.
  url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3',
  // Pinned 2026-08-04 from two independently fetched copies.
  sha256: '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3',
  bytes: 39900972,
});

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

export async function fetchSoundFont({ fetchImpl } = {}) {
  const dest = path.join(vendorDir(), 'soundfonts', SOUNDFONT_PACK.name);
  const result = await fetchVerified({ ...SOUNDFONT_PACK, dest, fetchImpl });
  if (result.ok && process.env.MOTION_STUDIO_SOUNDFONT
      && path.resolve(process.env.MOTION_STUDIO_SOUNDFONT) !== path.resolve(dest)) {
    result.note = `MOTION_STUDIO_SOUNDFONT is set to ${process.env.MOTION_STUDIO_SOUNDFONT} and overrides ` +
      'this file; unset it (or point it here) to use the fetched SoundFont.';
  }
  return result;
}

// CLI entry: one JSON result on stdout, exit code per the header.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await fetchSoundFont();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : (result.code === 'hash_mismatch' ? 2 : 1));
}
