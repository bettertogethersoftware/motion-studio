#!/usr/bin/env node
// Emit the agent entry files at the tools root (the directory beside this
// repository), and create MACHINE.md there from the template if absent.
//
//   node deploy/provision.mjs [--tools-root <dir>] [--os windows|linux|macos] [--dry-run]
//
// AGENTS.md and CLAUDE.md are generated copies of deploy/ENTRY.md — filtered
// for the target OS — and are always overwritten (they must never drift from
// the repo). MACHINE.md is machine-owned and is never overwritten once it
// exists.
//
// ENTRY.md is a single source containing OS-conditional blocks:
//
//   <!-- os:windows -->  …PowerShell examples…  <!-- /os:windows -->
//   <!-- os:posix -->    …bash examples…        <!-- /os:posix -->
//
// Emitting keeps only the blocks matching the target (windows, or posix for
// linux/macos), strips the marker lines, and stamps __MOTION_STUDIO_OS__ in
// the header. Markers must sit alone on their line and cannot nest.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(deployDir);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootFlag = args.indexOf('--tools-root');
const toolsRoot = resolve(rootFlag !== -1 && args[rootFlag + 1] ? args[rootFlag + 1] : dirname(repoRoot));

const osFlag = args.indexOf('--os');
const osArg = osFlag !== -1 ? String(args[osFlag + 1] ?? '') : (process.platform === 'win32' ? 'windows' : 'posix');
const OS_ALIASES = { windows: 'windows', win32: 'windows', posix: 'posix', linux: 'posix', macos: 'posix', darwin: 'posix' };
const targetOs = OS_ALIASES[osArg.toLowerCase()];
if (!targetOs) {
  console.error(`Unknown --os "${osArg}". Use one of: windows, linux, macos.`);
  process.exit(1);
}
const osLabel = targetOs === 'windows' ? 'Windows' : (osArg.toLowerCase() === 'macos' || osArg.toLowerCase() === 'darwin' ? 'macOS' : 'Linux');

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

function emitForOs(source, os) {
  const out = [];
  let inBlock = null; // the os value of the block we are inside, or null
  let keep = true;
  source.split('\n').forEach((line, i) => {
    const open = /^<!-- os:(windows|posix) -->\s*$/.exec(line);
    const close = /^<!-- \/os:(windows|posix) -->\s*$/.exec(line);
    if (open) {
      if (inBlock) throw new Error(`ENTRY.md line ${i + 1}: nested os block (already inside os:${inBlock})`);
      inBlock = open[1];
      keep = open[1] === os;
      return;
    }
    if (close) {
      if (inBlock !== close[1]) throw new Error(`ENTRY.md line ${i + 1}: closing os:${close[1]} but inside os:${inBlock ?? 'nothing'}`);
      inBlock = null;
      keep = true;
      return;
    }
    if (keep) out.push(line);
  });
  if (inBlock) throw new Error(`ENTRY.md: unclosed os:${inBlock} block`);
  return out.join('\n')
    .replace(/__MOTION_STUDIO_OS__/g, osLabel)
    .replace(/\n{3,}/g, '\n\n');
}

const entry = emitForOs(readFileSync(entryPath, 'utf8'), targetOs);
const actions = [];
if (!dryRun) mkdirSync(toolsRoot, { recursive: true });

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
  if (!dryRun) copyFileSync(machineTemplatePath, machinePath);
}

console.log(`tools root: ${toolsRoot}  (os: ${osLabel})${dryRun ? '  (dry run)' : ''}`);
for (const a of actions) console.log(`  ${a.action.padEnd(12)} ${a.target}`);
