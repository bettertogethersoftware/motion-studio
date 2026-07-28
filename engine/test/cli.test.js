/**
 * CLI integration tests: spawn `node src/cli/render.js` exactly as the
 * WinForms orchestrator does, with the fake-browser env hook standing in for
 * Chromium. Real ffmpeg, real multi-process parallel render, real concat.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { makeConfig } from '../src/core/scene.js';
import { ProgressStreamParser } from '../src/core/progress.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../src/cli/render.js');
const FAKE_BROWSER = path.resolve(__dirname, 'helpers/fake-browser-module.js');

let haveFfmpeg = false;
let tmp;
before(async () => {
  try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* skip */ }
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-cli-'));
});

async function makeProject(durationInFrames = 30) {
  const dir = await fsp.mkdtemp(path.join(tmp, 'proj-'));
  const config = makeConfig({ name: 'CliTest', fps: 30, width: 320, height: 240, durationInFrames });
  await fsp.writeFile(path.join(dir, 'scene.json'), JSON.stringify(config));
  // entry file existence isn't checked by the fake browser, but keep it honest:
  await fsp.writeFile(path.join(dir, 'composition.html'), '<!doctype html><title>t</title>');
  return dir;
}

function runCli(args, { env = {}, onMessage = () => {}, killAfterMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const messages = [];
    const parser = new ProgressStreamParser((m) => { messages.push(m); onMessage(m, child); });
    let stderr = '';
    child.stdout.on('data', (d) => parser.feed(d));
    child.stderr.on('data', (d) => { stderr += d; });
    if (killAfterMs) setTimeout(() => child.kill('SIGTERM'), killAfterMs);
    child.on('close', (code) => { parser.flush(); resolve({ code, messages, stderr }); });
  });
}

async function frameCount(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ]);
  return Number(stdout.trim());
}

/* ---------------------- ffmpeg binary resolution (v0.16) ---------------------- */
// The CLI used to accept only --ffmpeg, so a machine whose ffmpeg lives outside
// PATH was configured in the Studio and still broke here. Resolution is now the
// shared rule: --ffmpeg > MOTION_STUDIO_FFMPEG > settings.json > PATH. These
// drive the failure path with binaries that cannot exist, so they need no ffmpeg.

const BOGUS = path.join(os.tmpdir(), 'ms-no-such-ffmpeg');

/** Run --doctor with its own data dir; returns the parsed JSON report. */
async function doctor({ settings, env = {}, args = [] } = {}) {
  const home = await fsp.mkdtemp(path.join(tmp, 'home-'));
  if (settings) await fsp.writeFile(path.join(home, 'settings.json'), JSON.stringify(settings));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--doctor', ...args], {
      env: { ...process.env, MOTION_STUDIO_HOME: home, MOTION_STUDIO_FFMPEG: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, report: JSON.parse(stdout) }));
  });
}

test('cli: --doctor probes the binary from settings.json', async () => {
  const { code, report } = await doctor({ settings: { ffmpeg: { path: BOGUS } } });
  assert.equal(code, 3);
  assert.equal(report.ffmpeg.effectivePath, BOGUS);
  assert.equal(report.ffmpeg.source, 'settings');
  assert.equal(report.ffmpeg.found, false);
});

test('cli: MOTION_STUDIO_FFMPEG beats settings.json, and --ffmpeg beats both', async () => {
  const viaEnv = await doctor({
    settings: { ffmpeg: { path: BOGUS } },
    env: { MOTION_STUDIO_FFMPEG: BOGUS + '-env' },
  });
  assert.equal(viaEnv.report.ffmpeg.effectivePath, BOGUS + '-env');
  assert.equal(viaEnv.report.ffmpeg.source, 'env');

  const viaFlag = await doctor({
    settings: { ffmpeg: { path: BOGUS } },
    env: { MOTION_STUDIO_FFMPEG: BOGUS + '-env' },
    args: ['--ffmpeg', BOGUS + '-flag'],
  });
  assert.equal(viaFlag.report.ffmpeg.effectivePath, BOGUS + '-flag');
  assert.equal(viaFlag.report.ffmpeg.source, 'flag');
});

test('cli: parallel workers inherit the parent\'s binary, not their own environment', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // The parent is told explicitly to use PATH while the environment points
  // somewhere that does not exist. Workers must take the parent's choice: if a
  // worker re-resolved for itself it would pick up MOTION_STUDIO_FFMPEG and the
  // fan-out would encode half the film with a different binary — or, as here,
  // fail outright. Regression test for the parent-only "--ffmpeg" forwarding.
  const proj = await makeProject(20);
  const out = path.join(tmp, 'workers-inherit.mp4');
  const { code, messages } = await runCli(
    ['--scene', proj, '--output', out, '--workers', '2', '--ffmpeg', 'ffmpeg'],
    { env: { MOTION_STUDIO_FFMPEG: BOGUS } },
  );
  assert.equal(code, 0, `exit ${code}: ${JSON.stringify(messages.at(-1))}`);
  assert.equal(await frameCount(out), 20);
});

test('cli: serial render emits protocol and exits 0', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(30);
  const out = path.join(tmp, 'serial.mp4');
  const { code, messages } = await runCli(['--scene', proj, '--output', out]);
  assert.equal(code, 0);
  assert.equal(messages[0].type, 'start');
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(messages.at(-1).outputPath, out);
  assert.equal(await frameCount(out), 30);
});

test('cli: parallel render (3 workers, real processes) concats to exact frame count', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(50); // 50 frames / 3 workers → 17,17,16
  const out = path.join(tmp, 'parallel.mp4');
  const { code, messages } = await runCli(['--scene', proj, '--output', out, '--workers', '3']);
  assert.equal(code, 0, JSON.stringify(messages.filter((m) => m.type === 'error')));
  assert.equal(await frameCount(out), 50);
  const phases = messages.filter((m) => m.type === 'phase').map((m) => m.phase);
  assert.ok(phases.includes('concat'), `phases: ${phases}`);
  // aggregated progress reaches the full total
  const last = messages.filter((m) => m.type === 'progress').at(-1);
  assert.equal(last.framesDone, 50);
  assert.equal(last.totalFrames, 50);
});

test('cli: --frame-range renders a partial segment', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(100);
  const out = path.join(tmp, 'range.mp4');
  const { code } = await runCli(['--scene', proj, '--output', out, '--frame-range', '10', '19']);
  assert.equal(code, 0);
  assert.equal(await frameCount(out), 10);
});

test('cli: --capture-frame writes a PNG', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(30);
  const out = path.join(tmp, 'frame.png');
  const { code } = await runCli(['--scene', proj, '--capture-frame', '5', '--capture-out', out]);
  assert.equal(code, 0);
  const head = await fsp.readFile(out);
  assert.deepEqual([...head.subarray(1, 4)], [...Buffer.from('PNG')]);
});

test('cli: bad frame range → structured error, exit 1', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(30);
  const { code, messages } = await runCli(['--scene', proj, '--output', path.join(tmp, 'x.mp4'), '--frame-range', '0', '999']);
  assert.notEqual(code, 0);
  const err = messages.find((m) => m.type === 'error');
  assert.equal(err.code, 'invalid_config');
});

test('cli: missing scene.json → exit 2 with invalid_config', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { code, messages } = await runCli(['--scene', tmp, '--output', path.join(tmp, 'x.mp4')]);
  assert.equal(code, 2);
  assert.equal(messages.find((m) => m.type === 'error')?.code, 'invalid_config');
});

/**
 * POSIX-only. Windows has no signal mechanism: child.kill('SIGTERM') cannot
 * deliver anything, so libuv falls back to TerminateProcess(), which destroys
 * the process before any handler runs — `close` then reports code `null`
 * rather than the 4 the CLI would have chosen. Nothing here is fixable in the
 * engine, and cancellation itself is not affected: the Studio and MCP paths
 * abort in-process through JobManager.cancel (covered on every platform by
 * studio.test.js "queue is visible over HTTP and cancel works"), and Ctrl+C
 * still works because Node translates Windows console control events into
 * SIGINT. Skipped rather than left failing so a red run stays meaningful.
 */
test('cli: SIGTERM mid-render cancels with exit code 4', async (t) => {
  if (process.platform === 'win32') return t.skip('signals are not deliverable on Windows (TerminateProcess kills outright)');
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(500);
  const out = path.join(tmp, 'cancelled.mp4');
  let sent = false;
  const { code, messages } = await runCli(['--scene', proj, '--output', out], {
    onMessage: (m, child) => {
      if (!sent && m.type === 'progress' && m.framesDone >= 3) {
        sent = true;
        child.kill('SIGTERM');
      }
    },
  });
  assert.equal(code, 4, `exit ${code}: ${JSON.stringify(messages.at(-1))}`);
  assert.equal(messages.find((m) => m.type === 'error')?.code, 'cancelled');
});
