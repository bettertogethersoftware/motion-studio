/**
 * `npm run fetch-pack -- <id>` / `npm run fetch-pack -- --list` — the pack
 * bootstrap (vendor-boundary plan, Phase 3 / Slice B), generalized from
 * Slice 0's fetch-soundfont pilot.
 *
 * The manifest (what exists to fetch) is vendor knowledge and loads
 * dynamically and failure-tolerantly from vendors/default/packs.js, so a
 * core-only install answers with a structured "vendor package not
 * installed" instead of ERR_MODULE_NOT_FOUND — the same rule the MCP server
 * follows for the registry. The transport (verify-before-rename downloads)
 * is core/fetch-verified.js.
 *
 * Exit codes: 0 fetched-or-already-present (or a successful --list) ·
 * 1 network failure or unknown pack · 2 hash mismatch (a mismatch is never
 * renamed into place).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchVerified } from '../core/fetch-verified.js';
import { vendorDir } from '../core/paths.js';

/** Injectable for tests; the tolerant-import behavior is part of the contract. */
export async function loadPacks({ importImpl = (spec) => import(spec) } = {}) {
  try {
    const m = await importImpl('../vendors/default/packs.js');
    return { ok: true, manifestVersion: m.PACKS_MANIFEST_VERSION, packs: m.PACKS };
  } catch (err) {
    return {
      ok: false, code: 'packs_unavailable',
      message: 'The pack manifest is unavailable: the default vendor package is not installed ' +
        `(core-only install). ${err.message}`,
    };
  }
}

/**
 * Availability report: which packs exist, which are installed (every file
 * present at its destination — existence only; hashes were verified at
 * fetch time and re-hashing 150 MB on every list would punish honesty).
 */
export async function listPacks({ root = vendorDir(), loaded = null } = {}) {
  const manifest = loaded ?? await loadPacks();
  if (!manifest.ok) return manifest;
  const packs = Object.values(manifest.packs)
    .filter((p) => !p.platforms || p.platforms.includes(process.platform))
    .map((p) => {
      const files = p.files.map((f) => {
        const dest = path.join(root, ...f.path.split('/'));
        return { path: f.path, dest, bytes: f.bytes, present: fs.existsSync(dest) };
      });
      return {
        id: p.id, title: p.title, summary: p.summary, enables: p.enables,
        license: p.license.name, installed: files.every((f) => f.present), files,
      };
    });
  return { ok: true, manifestVersion: manifest.manifestVersion, root, packs };
}

/**
 * Fetch one pack: every file verified through fetchVerified, stopping at the
 * first failure (a half-fetched pack reports `installed: false` on the next
 * --list, and a re-run resumes idempotently — already-verified files are
 * reused, not re-downloaded).
 */
export async function fetchPack(id, { root = vendorDir(), fetchImpl, loaded = null } = {}) {
  const manifest = loaded ?? await loadPacks();
  if (!manifest.ok) return manifest;
  const pack = manifest.packs[id];
  if (!pack) {
    return {
      ok: false, code: 'unknown_pack', id,
      message: `Unknown pack "${id}". Known packs: ${Object.keys(manifest.packs).join(', ')} ` +
        '(npm run fetch-pack -- --list for details).',
    };
  }
  if (pack.platforms && !pack.platforms.includes(process.platform)) {
    return {
      ok: false, code: 'wrong_platform', id,
      message: `Pack "${id}" supports ${pack.platforms.join(', ')}, not ${process.platform}.`,
    };
  }
  const files = [];
  for (const f of pack.files) {
    const dest = path.join(root, ...f.path.split('/'));
    const result = await fetchVerified({ url: f.url, sha256: f.sha256, dest, fetchImpl });
    files.push({ path: f.path, ...result });
    if (!result.ok) {
      return { ok: false, code: result.code, id, message: result.message, files };
    }
  }
  const out = { ok: true, id, files };
  const override = pack.envOverride && process.env[pack.envOverride];
  if (override && !files.some((f) => path.resolve(override) === path.resolve(f.dest))) {
    out.note = `${pack.envOverride} is set to ${override} and overrides this file; ` +
      'unset it (or point it here) to use the fetched copy.';
  }
  return out;
}

// CLI entry: one JSON result on stdout, exit code per the header.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  const result = !arg || arg === '--list' ? await listPacks() : await fetchPack(arg);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : (result.code === 'hash_mismatch' ? 2 : 1));
}
