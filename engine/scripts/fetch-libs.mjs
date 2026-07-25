#!/usr/bin/env node
/**
 * Download the optional 3D library builds into engine/vendor/libs (git-ignored).
 * Required for the `add_library` tool; run once after cloning:
 *
 *   node scripts/fetch-libs.mjs              # all libraries, verified against the lock
 *   node scripts/fetch-libs.mjs three        # just one
 *   node scripts/fetch-libs.mjs --verify     # check what's on disk, download nothing
 *   node scripts/fetch-libs.mjs --update     # fetch AND rewrite the lock (bump a version)
 *
 * The URLs and destinations come from src/core/libraries.js so this stays in
 * lockstep with what add_library copies into projects.
 *
 * Every download is hashed and checked against engine/vendor.lock.json, which IS
 * committed even though the artifacts it describes are not. Without that, two
 * machines could vendor different code and nothing would record which a render
 * used — and a version pin alone does not close it: the floating and versioned
 * Babylon URLs both report 9.18.0 and are different code. See core/vendor-lock.js.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIBRARIES, libsVendorDir } from '../src/core/libraries.js';
import {
  readLock, writeLock, describe, verifyVendoredLibraries, vendorLockPath,
} from '../src/core/vendor-lock.js';

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const verifyOnly = argv.includes('--verify');
const only = argv.filter((a) => !a.startsWith('--'));
const root = libsVendorDir();
const out = (s) => process.stderr.write(s);

/* ------------------------------------------------------------- --verify -- */

if (verifyOnly) {
  const report = await verifyVendoredLibraries(LIBRARIES, root);
  if (!report.locked) {
    out(`no lock at ${vendorLockPath()} — run "node scripts/fetch-libs.mjs --update" to create it\n`);
    process.exit(1);
  }
  for (const r of report.results) {
    const mark = { ok: '✓', missing: '✗ MISSING', unlocked: '? UNLOCKED', mismatch: '✗ MISMATCH' }[r.status];
    out(`${mark}  ${r.file}${r.status === 'mismatch'
      ? `\n     locked ${r.expected.sha256.slice(0, 16)} (${r.expected.bytes} B, v${r.expected.version ?? "?"})`
        + `\n     ondisk ${r.actual.sha256.slice(0, 16)} (${r.actual.bytes} B, v${r.actual.version ?? "?"})`
      : ''}\n`);
  }
  if (!report.ok) {
    out('\nvendored builds do not match the lock. Re-fetch to restore them, or\n'
      + '--update if the change is intentional.\n');
    process.exit(1);
  }
  out('\nall vendored builds match the lock.\n');
  process.exit(0);
}

/* -------------------------------------------------------------- fetch ---- */

const lock = await readLock();
const drift = [];
let added = 0, confirmed = 0;

for (const [id, spec] of Object.entries(LIBRARIES)) {
  if (only.length && !only.includes(id)) continue;
  const files = [...spec.files, ...Object.values(spec.addons || {})];
  for (const f of files) {
    const dest = path.join(root, f.vendor);
    out(`↓ ${spec.name} ${spec.version}: ${f.url}\n`);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`fetch ${f.url} → HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = describe(buf, f.url);

    const known = lock[f.vendor];
    if (known && known.sha256 !== got.sha256 && !update) {
      // Do NOT write the file: leaving the verified copy in place means a failed
      // run cannot half-upgrade the vendor dir.
      drift.push({ file: f.vendor, expected: known, actual: got });
      out(`  ✗ hash mismatch — not written\n`);
      continue;
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    if (known && known.sha256 === got.sha256) confirmed++;
    else { lock[f.vendor] = got; added++; }
    out(`  → ${f.vendor} (${(buf.length / 1024).toFixed(0)} KB, v${got.version ?? '?'},`
      + ` sha256 ${got.sha256.slice(0, 16)}…)${known ? '' : ' [locked]'}\n`);
  }
}

if (drift.length) {
  out(`\n${drift.length} build(s) differ from ${path.basename(vendorLockPath())}:\n`);
  for (const d of drift) {
    out(`  ${d.file}\n`
      + `    locked ${d.expected.sha256.slice(0, 16)} (${d.expected.bytes} B, v${d.expected.version ?? "?"})\n`
      + `    served ${d.actual.sha256.slice(0, 16)} (${d.actual.bytes} B, v${d.actual.version ?? "?"})\n`);
  }
  out('\nThe CDN is serving something other than what this repo was built against.\n'
    + 'Nothing was overwritten. Re-run with --update to accept the new build\n'
    + '(then re-render a 3D project to confirm it still draws).\n');
  process.exit(1);
}

if (added) await writeLock(lock);
out(`done. ${confirmed} verified, ${added} locked.\n`);
