/**
 * Desktop viewer smoke (Slice C-1): launch the Electron shell in smoke mode,
 * require a clean exit 0 with its JSON proof line, and then verify the
 * plan's cleanup rule — the Studio child (and its port) must not survive
 * the shell. Exit 0 on success, 1 with a reason otherwise.
 *
 * Needs a display (a real desktop or xvfb); not wired into CI's headless
 * suite jobs. Run from desktop/: `npm run smoke` (after `npm install`).
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// The smoke never touches the machine's real film library.
const smokeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-desktop-smoke-'));
const require = createRequire(import.meta.url);
const electron = require('electron'); // resolves to the electron binary path when required from plain Node

const fail = (why) => { console.error(`SMOKE FAIL: ${why}`); process.exit(1); };

const run = () => new Promise((resolve) => {
  const child = spawn(electron, ['.'], {
    cwd: here,
    env: {
      ...process.env,
      MOTION_STUDIO_DESKTOP_SMOKE: '1',
      MOTION_STUDIO_HOME: smokeHome,
      MOTION_STUDIO_PATHS_FILE: path.join(smokeHome, 'paths.json'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  const timer = setTimeout(() => { child.kill(); resolve({ code: -1, out, timedOut: true }); }, 90000);
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
});

const portOpen = (port) => new Promise((resolve) => {
  const sock = net.connect({ port, host: '127.0.0.1' }, () => { sock.destroy(); resolve(true); });
  sock.on('error', () => resolve(false));
  sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
});

const { code, out, timedOut } = await run();
if (timedOut) fail('the shell did not finish within 90 s');
if (code !== 0) fail(`the shell exited ${code}`);

const proofLine = out.split(/\r?\n/).find((l) => l.trimStart().startsWith('{'));
if (!proofLine) fail('no JSON proof line on stdout');
const proof = JSON.parse(proofLine);
if (!proof.ok || !proof.url) fail(`bad proof: ${proofLine}`);

// Cleanup rule: the Studio's port must be closed once the shell is gone.
const port = Number(new URL(proof.url).port);
await new Promise((r) => setTimeout(r, 1500)); // let taskkill finish
if (await portOpen(port)) fail(`the Studio child survived the shell — port ${port} still answers`);

await fsp.rm(smokeHome, { recursive: true, force: true }).catch(() => {});
console.log(`SMOKE OK: ${proof.url} loaded (title "${proof.title}"), child tree cleaned up`);
