/**
 * The GitHub-URL install wrapper (vendor-boundary plan §10.7, Slice B): npm
 * git-installs pack the repo ROOT, but the engine lives in engine/ — so a
 * root package.json mirrors the engine's contract and points into it. These
 * tests are the tether: the two package files cannot drift apart, the bins
 * must exist, and the packed artifact must never carry machine state
 * (data/, vendor/, paths.json) or the heavyweight optional Windows provider
 * builds (music/, tts/ — future packs, not npm payload).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const engine = JSON.parse(fs.readFileSync(path.join(repoRoot, 'engine', 'package.json'), 'utf8'));

test('root package: version, dependencies, engines, and type mirror the engine exactly', () => {
  assert.equal(root.version, engine.version, 'one version, two files — bump both');
  assert.deepEqual(root.dependencies, engine.dependencies, 'dependency lists are mirrored, not merged');
  assert.deepEqual(root.engines, engine.engines);
  assert.equal(root.type, engine.type);
});

test('root package: every bin is the engine bin behind an engine/ prefix, and the file exists', () => {
  assert.deepEqual(Object.keys(root.bin).sort(), Object.keys(engine.bin).sort());
  for (const [name, target] of Object.entries(root.bin)) {
    assert.equal(target, `engine/${engine.bin[name]}`, `${name} points at the engine's own bin`);
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `${target} exists`);
  }
});

test('root package: the files whitelist ships the runtime and never machine state', () => {
  for (const required of ['engine/src', 'engine/templates', 'engine/package.json', 'engine/.puppeteerrc.cjs']) {
    assert.ok(root.files.includes(required), `files must include ${required}`);
  }
  for (const entry of root.files) {
    assert.ok(fs.existsSync(path.join(repoRoot, entry)), `listed path exists: ${entry}`);
    assert.ok(!/^(data|vendor|music|tts|paths\.json)/.test(entry),
      `machine state and optional provider builds stay out of the artifact: ${entry}`);
  }
});
