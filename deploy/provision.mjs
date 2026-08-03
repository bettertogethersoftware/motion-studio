#!/usr/bin/env node
// Emit the agent entry files at the tools root (the directory beside this
// repository), and create MACHINE.md there from the template if absent.
//
//   node deploy/provision.mjs [--tools-root <dir>] [--dry-run]
//
// AGENTS.md and CLAUDE.md are generated copies of deploy/ENTRY.md and are
// always overwritten (they must never drift from the repo). MACHINE.md is
// machine-owned and is never overwritten once it exists.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(deployDir);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootFlag = args.indexOf('--tools-root');
const toolsRoot = resolve(rootFlag !== -1 && args[rootFlag + 1] ? args[rootFlag + 1] : dirname(repoRoot));

const entryPath = join(deployDir, 'ENTRY.md');
const machineTemplatePath = join(deployDir, 'MACHINE-template.md');
if (!existsSync(entryPath) || !existsSync(machineTemplatePath)) {
  console.error('deploy/ENTRY.md or deploy/MACHINE-template.md is missing; refusing to run.');
  process.exit(1);
}
if (!existsSync(join(repoRoot, 'engine', 'src', 'mcp', 'server.js'))) {
  console.error(`This script must live inside a Motion Studio repository: ${repoRoot}`);
  process.exit(1);
}

const entry = readFileSync(entryPath, 'utf8');
const actions = [];

for (const name of ['AGENTS.md', 'CLAUDE.md']) {
  const target = join(toolsRoot, name);
  actions.push({ target, action: existsSync(target) ? 'overwrite' : 'create' });
  if (!dryRun) writeFileSync(target, entry);
}

const machinePath = join(toolsRoot, 'MACHINE.md');
if (existsSync(machinePath)) {
  actions.push({ target: machinePath, action: 'kept (machine-owned, never overwritten)' });
} else {
  actions.push({ target: machinePath, action: 'create from template — fill in every TODO' });
  if (!dryRun) {
    mkdirSync(toolsRoot, { recursive: true });
    copyFileSync(machineTemplatePath, machinePath);
  }
}

console.log(`tools root: ${toolsRoot}${dryRun ? '  (dry run)' : ''}`);
for (const a of actions) console.log(`  ${a.action.padEnd(12)} ${a.target}`);
