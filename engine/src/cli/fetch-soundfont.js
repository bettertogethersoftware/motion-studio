/**
 * `npm run fetch-soundfont` — kept as the friendly alias for
 * `npm run fetch-pack -- soundfont` (every unavailable-message and doc since
 * Slice 0 names this command, and one SoundFont download is still the
 * distance between a clean clone and synthesize_music).
 *
 * Slice 0 built the verify-before-rename mechanism here as the pack pilot;
 * Slice B generalized it — the transport now lives in
 * core/fetch-verified.js (re-exported below for compatibility) and the
 * SoundFont's pinned URL/SHA-256 is the `soundfont` entry of the pack
 * manifest, vendors/default/packs.js.
 *
 * Exit codes: 0 fetched-or-already-present · 1 network failure ·
 * 2 hash mismatch (a mismatch is never renamed into place).
 */

import { pathToFileURL } from 'node:url';
import { fetchPack } from './fetch-pack.js';

export { fetchVerified, sha256Of } from '../core/fetch-verified.js';

/** Single-file compat shape: the flattened result Slice 0 callers parse. */
export async function fetchSoundFont({ fetchImpl } = {}) {
  const result = await fetchPack('soundfont', { fetchImpl });
  if (!result.ok && !result.files?.length) return result; // manifest/unknown-pack failure
  const file = result.files[result.files.length - 1];
  const { path: _relPath, ...flat } = file;
  if (result.note) flat.note = result.note;
  if (!result.ok) flat.message ??= result.message;
  return flat;
}

// CLI entry: one JSON result on stdout, exit code per the header.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await fetchSoundFont();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : (result.code === 'hash_mismatch' ? 2 : 1));
}
