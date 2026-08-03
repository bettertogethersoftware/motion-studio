/**
 * The vendor-boundary invariant (vendor-boundary plan, Phase 6), enforced
 * from BEFORE the migration so it can never regress silently during it:
 * nothing under core/ may import from vendors/ — statically or dynamically.
 * Under §5's low-churn single-package layout a package.json dependency check
 * cannot exist yet; this static scan is the stated substitute.
 *
 * The scan is line-based on import/require/import() specifiers, which is
 * enough: the engine has no computed import specifiers, and if one ever
 * appears in core/ pointing at vendors/, adding it should hurt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const jsFilesUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

const importSpecifiers = (source) => {
  const specs = [];
  const patterns = [
    /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,   // import x from '...'
    /import\s*['"]([^'"]+)['"]/g,                  // bare import '...'
    /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,   // re-export from '...'
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // dynamic import('...')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('...')
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
};

test('import graph: nothing under core/ imports from vendors/', () => {
  const offenders = [];
  for (const file of jsFilesUnder(path.join(SRC, 'core'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      if (/(^|\/)vendors\//.test(spec)) {
        offenders.push(`${path.relative(SRC, file)} imports "${spec}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('import graph: the MCP entrypoint is the composition root, not the Studio reaching around it', () => {
  // Weaker companion invariant that is already true and worth keeping: the
  // runtime/ (future) and vendors/ (future) trees must only be imported from
  // entrypoints (mcp/, studio/, cli/) — never from core/. Today vendors/
  // does not exist; when Phase 2 creates it, this test is already standing.
  const allowedRoots = ['mcp', 'studio', 'cli', 'vendors'];
  const offenders = [];
  for (const file of jsFilesUnder(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const top = rel.split('/')[0];
    if (allowedRoots.includes(top)) continue; // entrypoints and vendors themselves may
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      if (/(^|\/)vendors\//.test(spec)) offenders.push(`${rel} imports "${spec}"`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
