#!/usr/bin/env node
/**
 * Download the optional 3D library builds into engine/vendor/libs (git-ignored).
 * These are required for the `add_library` tool; run once after cloning:
 *
 *   node scripts/fetch-libs.mjs            # all libraries
 *   node scripts/fetch-libs.mjs three      # just one
 *
 * The URLs and destinations come from src/core/libraries.js so this stays in
 * lockstep with what add_library copies into projects.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIBRARIES, libsVendorDir } from '../src/core/libraries.js';

const only = process.argv.slice(2);
const root = libsVendorDir();

for (const [id, spec] of Object.entries(LIBRARIES)) {
  if (only.length && !only.includes(id)) continue;
  const files = [...spec.files, ...Object.values(spec.addons || {})];
  for (const f of files) {
    const dest = path.join(root, f.vendor);
    process.stderr.write(`↓ ${spec.name} ${spec.version}: ${f.url}\n`);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`fetch ${f.url} → HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    process.stderr.write(`  → ${f.vendor} (${(buf.length / 1024).toFixed(0)} KB)\n`);
  }
}
process.stderr.write('done.\n');
