/**
 * The core-only install (vendor-boundary plan, acceptance test 1): with the
 * vendors/ tree ABSENT, the MCP server must still start, initialize, answer
 * get_capabilities, and refuse audio with the structured *_unavailable error
 * — never ERR_MODULE_NOT_FOUND, never a dead process.
 *
 * Simulated honestly: the engine source is mirrored to a temp dir WITHOUT
 * src/vendors/, node_modules is junction-linked in, and the mirrored server
 * is spawned over real stdio. That is exactly what a future core-only
 * package is — this tree, minus the vendor package.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp, client, transport, home;

const copyTree = async (from, to, skip) => {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (skip(path.join(from, entry.name))) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest, skip);
    else await fsp.copyFile(src, dest);
  }
};

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-core-only-'));
  home = path.join(tmp, 'data');
  const vendorsDir = path.join(engineDir, 'src', 'vendors');
  await copyTree(path.join(engineDir, 'src'), path.join(tmp, 'src'),
    (p) => p === vendorsDir);
  assert.equal(fs.existsSync(path.join(tmp, 'src', 'vendors')), false, 'the mirror must NOT contain vendors/');
  await fsp.copyFile(path.join(engineDir, 'package.json'), path.join(tmp, 'package.json'));
  // Scene scaffolding reads templates/ relative to the app root — app data,
  // not vendor code, so the core-only mirror carries it.
  await copyTree(path.join(engineDir, 'templates'), path.join(tmp, 'templates'), () => false);
  // Junction (no admin needed on Windows) so bare imports resolve.
  await fsp.symlink(path.join(engineDir, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(tmp, 'src', 'mcp', 'server.js')],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: home,
      MOTION_STUDIO_WORKSPACE: 'core-only',
      // No whisper/piper/soundfont hooks: this machine's audio config must
      // not leak into the "nothing is installed" simulation.
      MOTION_STUDIO_TTS_EXE: '', MOTION_STUDIO_SOUNDFONT: '',
      MOTION_STUDIO_WHISPER_BIN: '', MOTION_STUDIO_WHISPER_MODEL: '',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'core-only-test', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return { isError: !!res.isError, data: JSON.parse(text) };
  } catch {
    // A transport/validation-level error is not a tool payload; surface it
    // as data so assertions can name it instead of dying on JSON.parse.
    return { isError: true, data: { code: 'mcp_protocol_error', message: text } };
  }
};

test('core-only: the server initializes and answers get_capabilities without the vendors tree', async () => {
  const caps = await call('get_capabilities');
  assert.equal(caps.isError, false);
  assert.ok(caps.data.engine, 'reports an engine version');
  assert.ok(caps.data.formats.includes('mp4'), 'render formats are core, not vendor');
});

test('core-only: non-audio operations work — a film and scene can be created', async () => {
  const film = await call('create_film', { name: 'Core Only', fps: 30, width: 320, height: 240 });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  const scene = await call('create_scene', { film: film.data.film, name: 'sc', fps: 30, width: 320, height: 240, durationInFrames: 6 });
  assert.equal(scene.isError, false, JSON.stringify(scene.data));
});

test('core-only: every audio tool returns its structured unavailable, not a crash', async () => {
  const speech = await call('synthesize_speech', { target: 'core-only/sc', text: 'hi' });
  assert.equal(speech.isError, true);
  assert.equal(speech.data.code, 'tts_unavailable');
  assert.match(speech.data.message, /vendor runtime is not installed/i);
  assert.match(speech.data.message, /non-audio tool/i, 'says what still works');

  const music = await call('synthesize_music', { target: 'core-only/sc', spec: { bpm: 100, tracks: [{ program: 0, notes: [{ pitch: 60, start: 0, duration: 1 }] }] } });
  assert.equal(music.isError, true);
  assert.equal(music.data.code, 'music_unavailable');

  const transcript = await call('transcribe_asset', { path: 'nothing.wav' });
  assert.equal(transcript.isError, true);
  // file check may fire first depending on tool ordering; either structured
  // error is acceptable — what is NOT acceptable is a module-load crash.
  assert.ok(['transcription_unavailable', 'file_not_found'].includes(transcript.data.code), transcript.data.code);
});
