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

import { makeConfig } from '../src/core/project.js';
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
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(config));
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

test('cli: serial render emits protocol and exits 0', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(30);
  const out = path.join(tmp, 'serial.mp4');
  const { code, messages } = await runCli(['--project', proj, '--output', out]);
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
  const { code, messages } = await runCli(['--project', proj, '--output', out, '--workers', '3']);
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
  const { code } = await runCli(['--project', proj, '--output', out, '--frame-range', '10', '19']);
  assert.equal(code, 0);
  assert.equal(await frameCount(out), 10);
});

test('cli: --capture-frame writes a PNG', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(30);
  const out = path.join(tmp, 'frame.png');
  const { code } = await runCli(['--project', proj, '--capture-frame', '5', '--capture-out', out]);
  assert.equal(code, 0);
  const head = await fsp.readFile(out);
  assert.deepEqual([...head.subarray(1, 4)], [...Buffer.from('PNG')]);
});

test('cli: bad frame range → structured error, exit 1', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(30);
  const { code, messages } = await runCli(['--project', proj, '--output', path.join(tmp, 'x.mp4'), '--frame-range', '0', '999']);
  assert.notEqual(code, 0);
  const err = messages.find((m) => m.type === 'error');
  assert.equal(err.code, 'invalid_config');
});

test('cli: missing project.json → exit 2 with invalid_config', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { code, messages } = await runCli(['--project', tmp, '--output', path.join(tmp, 'x.mp4')]);
  assert.equal(code, 2);
  assert.equal(messages.find((m) => m.type === 'error')?.code, 'invalid_config');
});

test('cli: SIGTERM mid-render cancels with exit code 4', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const proj = await makeProject(500);
  const out = path.join(tmp, 'cancelled.mp4');
  let sent = false;
  const { code, messages } = await runCli(['--project', proj, '--output', out], {
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
