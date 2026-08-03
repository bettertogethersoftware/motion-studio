/**
 * The per-platform `system` speech backends (Slice 0) speak MotionStudioTts's
 * CLI contract: one JSON line on stdout, structured failures, non-zero exits.
 * These tests pin the contract without requiring any synthesis tool: the
 * argument check precedes every tool spawn, and tool-missing is itself a
 * contract case (backend_missing). Real synthesis is covered by the platform
 * that can do it (Windows always has System.Speech; Linux CI installs
 * nothing, so its backend must fail structurally).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveTtsExeInfo } from '../src/core/tts.js';

const execFileP = promisify(execFile);
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/core/system-tts');
const BACKENDS = ['windows-sapi.mjs', 'macos-say.mjs', 'linux-espeak.mjs'];

const run = async (backend, args) => {
  try {
    const { stdout } = await execFileP(process.execPath, [path.join(backendDir, backend), ...args]);
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '' };
  }
};
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

test('system-tts: every backend answers bad arguments with a structured JSON failure', async () => {
  for (const backend of BACKENDS) {
    const { code, stdout } = await run(backend, ['--text-file-missing-everything']);
    assert.notEqual(code, 0, `${backend} must exit non-zero`);
    const parsed = lastJson(stdout);
    assert.equal(parsed.ok, false, backend);
    assert.equal(parsed.code, 'bad_arguments', backend);
  }
});

test('system-tts: a backend whose tool is absent fails as backend_missing, not a stack trace', async (t) => {
  // The foreign platform's tool is reliably absent: espeak-ng on Windows,
  // powershell.exe on POSIX.
  const foreign = process.platform === 'win32' ? 'linux-espeak.mjs' : 'windows-sapi.mjs';
  const { code, stdout } = await run(foreign, ['--list-voices']);
  const parsed = lastJson(stdout);
  // A successful --list-voices is a bare array — meaning the "foreign" tool
  // is actually installed on this machine (espeak-ng ships for Windows too).
  if (Array.isArray(parsed) || parsed.ok === true) {
    return t.skip(`${foreign}'s tool is unexpectedly installed here`);
  }
  assert.notEqual(code, 0);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'backend_missing');
  assert.match(parsed.error, /install|not found/i, 'the error names the fix');
});

test('system-tts: the native platform backend lists voices as a JSON array', async (t) => {
  const native = process.platform === 'win32' ? 'windows-sapi.mjs'
    : process.platform === 'darwin' ? 'macos-say.mjs' : 'linux-espeak.mjs';
  const { code, stdout } = await run(native, ['--list-voices']);
  const parsed = lastJson(stdout);
  if (parsed?.code === 'backend_missing') {
    return t.skip(`no synthesis tool on this machine (${parsed.error})`);
  }
  assert.equal(code, 0);
  assert.ok(Array.isArray(parsed), 'voices are a JSON array');
  assert.ok(parsed.length > 0, 'at least one voice');
});

test('system-tts: the default resolution is per-platform and reports its source', () => {
  const saved = process.env.MOTION_STUDIO_TTS_EXE;
  delete process.env.MOTION_STUDIO_TTS_EXE;
  try {
    const info = resolveTtsExeInfo();
    assert.ok(['bundled', 'os'].includes(info.source), info.source);
    if (info.source === 'os') {
      assert.match(path.basename(info.path), /^(windows-sapi|macos-say|linux-espeak)\.mjs$/);
    } else {
      assert.match(info.path, /MotionStudioTts\.exe$/);
    }
  } finally {
    if (saved !== undefined) process.env.MOTION_STUDIO_TTS_EXE = saved;
  }
});
