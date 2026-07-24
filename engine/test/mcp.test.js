/**
 * MCP server integration tests: connect a real MCP client (official SDK) to
 * the server over stdio, exactly as Claude Desktop would, and drive the full
 * agent workflow: create project → write composition (incl. syntax-error
 * fast-fail and sandbox rejection) → capture preview frame → render → poll →
 * logs. Chromium is replaced via the env hook; ffmpeg is real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/mcp/server.js');
const FAKE_BROWSER = path.resolve(__dirname, 'helpers/fake-browser-module.js');
const FAKE_TTS = path.resolve(__dirname, 'helpers/fake-tts.mjs');
const FAKE_MIDI = path.resolve(__dirname, 'helpers/fake-music.mjs');
const FAKE_FLUIDSYNTH = path.resolve(__dirname, 'helpers/fake-fluidsynth.mjs');
const FAKE_SOUNDFONT = path.resolve(__dirname, 'fixtures/fake.sf2');

let haveFfmpeg = false;
let tmp, client, transport;

before(async () => {
  try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* skip below */ }
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-mcp-'));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_TTS_EXE: FAKE_TTS,
      MOTION_STUDIO_MIDI_EXE: FAKE_MIDI,
      MOTION_STUDIO_FLUIDSYNTH: FAKE_FLUIDSYNTH,
      MOTION_STUDIO_SOUNDFONT: FAKE_SOUNDFONT,
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'ms-test-client', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
});

const callJson = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { isError: !!res.isError, data: JSON.parse(text), content: res.content };
};

test('mcp: exposes the full spec tool surface', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  for (const required of [
    'list_projects', 'create_project', 'get_project', 'read_composition_file',
    'write_composition_file', 'capture_preview_frame', 'render',
    'get_render_status', 'cancel_render', 'list_render_jobs', 'get_logs',
    'update_project_config',
    // new in v0.5
    'render_still', 'write_asset_file', 'remove_project',
    // new in v0.6 (text-to-speech)
    'synthesize_speech', 'list_voices',
    // new in v0.7 (3D libraries)
    'add_library',
    // new in v0.8 (music generation)
    'synthesize_music',
    // new in v0.9 (film assembly)
    'build_film',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
});

test('mcp: resources include frame-api reference', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes('motion-studio://reference/frame-api'), uris.join(','));
  const doc = await client.readResource({ uri: 'motion-studio://reference/frame-api' });
  assert.match(doc.contents[0].text, /registerComposition|setFrame/);
});

let projectId;

test('mcp: create_project scaffolds and lists', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('create_project', {
    name: 'Agent Demo', fps: 30, width: 320, height: 240, durationInFrames: 20,
  });
  assert.equal(isError, false, JSON.stringify(data));
  projectId = data.id;
  assert.ok(data.files.some((f) => f.path === 'composition.js'));
  assert.ok(fs.existsSync(path.join(data.path, 'frame-api.js')));

  const list = await callJson('list_projects');
  assert.equal(list.data.projects.length, 1);
});

test('mcp: write with syntax error fails fast with structured code', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('write_composition_file', {
    projectId, path: 'composition.js', content: 'function ( { nope',
  });
  assert.equal(isError, true);
  assert.equal(data.code, 'syntax_error');
  assert.match(data.message, /Syntax error/);
});

test('mcp: path traversal rejected with path_outside_project', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('write_composition_file', {
    projectId, path: '../../evil.js', content: '1',
  });
  assert.equal(isError, true);
  assert.equal(data.code, 'path_outside_project');
});

test('mcp: read/write round trip', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ok = await callJson('write_composition_file', {
    projectId, path: 'composition.js',
    content: 'MotionStudio.registerComposition(function (f) { /* agent edit */ });\n',
  });
  assert.equal(ok.isError, false);
  const read = await callJson('read_composition_file', { projectId, path: 'composition.js' });
  assert.match(read.data.content, /agent edit/);
});

test('mcp: capture_preview_frame returns an image content block', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await client.callTool({ name: 'capture_preview_frame', arguments: { projectId, frame: 3 } });
  assert.ok(!res.isError, JSON.stringify(res.content));
  const img = res.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  const bytes = Buffer.from(img.data, 'base64');
  assert.deepEqual([...bytes.subarray(1, 4)], [...Buffer.from('PNG')]);
});

test('mcp: out-of-range preview frame → invalid_config', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('capture_preview_frame', { projectId, frame: 999 });
  assert.equal(isError, true);
  assert.equal(data.code, 'invalid_config');
});

test('mcp: render → status poll → done → logs', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const start = await callJson('render', { projectId, frameRange: [0, 9] });
  assert.equal(start.isError, false, JSON.stringify(start.data));
  const { jobId, outputPath, totalFrames } = start.data;
  assert.equal(totalFrames, 10);

  let status;
  const deadline = Date.now() + 30_000;
  do {
    await new Promise((r) => setTimeout(r, 100));
    status = (await callJson('get_render_status', { jobId })).data;
  } while (status.state === 'running' && Date.now() < deadline);

  assert.equal(status.state, 'done', JSON.stringify(status));
  assert.equal(status.framesDone, 10);
  assert.ok(fs.existsSync(outputPath));

  const logs = (await callJson('get_logs', { jobId })).data.logs;
  assert.ok(logs.some((l) => /phase: encoding/.test(l.message)));

  const jobsList = (await callJson('list_render_jobs')).data.jobs;
  assert.equal(jobsList[0].jobId, jobId);
});

test('mcp: unknown project → project_not_found', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('get_project', { projectId: 'nope' });
  assert.equal(isError, true);
  assert.equal(data.code, 'project_not_found');
});

/* ----------------------------- v0.5 tools ----------------------------- */

test('mcp: render returns state and queues concurrent submissions (v0.5)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const a = await callJson('render', { projectId });
  assert.equal(a.isError, false, JSON.stringify(a.data));
  assert.equal(a.data.state, 'running');
  const b = await callJson('render', { projectId });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  assert.equal(b.data.state, 'queued');
  assert.equal(b.data.queuePosition, 1);
  // Cancel the queued one, then wait for the first to finish.
  const cancelled = await callJson('cancel_render', { jobId: b.data.jobId });
  assert.equal(cancelled.data.state, 'cancelled');
  for (let i = 0; i < 200; i++) {
    const { data } = await callJson('get_render_status', { jobId: a.data.jobId });
    if (data.state !== 'running' && data.state !== 'queued') {
      assert.equal(data.state, 'done', JSON.stringify(data));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('mcp: render_still writes a PNG into out/ and rejects bad filenames', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ok1 = await callJson('render_still', { projectId, frame: 3 });
  assert.equal(ok1.isError, false, JSON.stringify(ok1.data));
  assert.ok(ok1.data.outputPath.endsWith('still-3.png'));
  assert.ok(fs.existsSync(ok1.data.outputPath));
  const bad = await callJson('render_still', { projectId, frame: 0, outputFilename: '../evil.png' });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'path_outside_project');
});

test('mcp: write_asset_file round-trips base64 and enforces the sandbox', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const bytes = Buffer.from('{"brand":"#f9564f"}', 'utf8');
  const w = await callJson('write_asset_file', {
    projectId, path: 'assets/brand.json', contentBase64: bytes.toString('base64'),
  });
  assert.equal(w.isError, false, JSON.stringify(w.data));
  assert.equal(w.data.written.bytes, bytes.length);
  const r = await callJson('read_composition_file', { projectId, path: 'assets/brand.json' });
  assert.equal(r.data.content, bytes.toString('utf8'));
  const outside = await callJson('write_asset_file', {
    projectId, path: 'brand.json', contentBase64: bytes.toString('base64'),
  });
  assert.equal(outside.isError, true);
  assert.equal(outside.data.code, 'path_outside_project');
});

test('mcp: remove_project unregisters (files kept by default)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const made = await callJson('create_project', { name: 'Disposable', fps: 30, width: 320, height: 240, durationInFrames: 10 });
  const rm = await callJson('remove_project', { projectId: made.data.id });
  assert.equal(rm.isError, false, JSON.stringify(rm.data));
  assert.equal(rm.data.unregistered, true);
  assert.equal(rm.data.filesDeleted, false);
  assert.ok(fs.existsSync(path.join(made.data.path, 'project.json')));
  const gone = await callJson('get_project', { projectId: made.data.id });
  assert.equal(gone.isError, true);
  assert.equal(gone.data.code, 'project_not_found');
});

test('mcp: update_project_config switches format and fixes the filename extension (v0.5)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('update_project_config', {
    projectId, patch: { output: { format: 'webm', transparent: true } },
  });
  assert.equal(isError, false, JSON.stringify(data));
  assert.equal(data.config.output.format, 'webm');
  assert.equal(data.config.output.transparent, true);
  assert.ok(data.config.output.filename.endsWith('.webm'), data.config.output.filename);
  // transparent mp4 is rejected by validation
  const bad = await callJson('update_project_config', {
    projectId, patch: { output: { format: 'mp4', transparent: true } },
  });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'invalid_config');
  // restore mp4 for any later tests
  await callJson('update_project_config', { projectId, patch: { output: { format: 'mp4', transparent: false } } });
});

/* --------------------------- v0.6 text-to-speech --------------------------- */

test('mcp: synthesize_speech attach mode adds an audio track and reports frames', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('synthesize_speech', {
    projectId, text: 'Welcome to Motion Studio.', voice: 'Microsoft David Desktop', mode: 'attach',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, true);
  assert.equal(res.data.mode, 'attach');
  assert.equal(res.data.assetPath, 'assets/narration-1.wav');
  // Stub clip is 1.0s; project fps is 30 → ceil(1.0 * 30) = 30 frames.
  assert.equal(res.data.durationInFrames, 30);
  assert.equal(res.data.fps, 30);

  const proj = await callJson('get_project', { projectId });
  assert.ok(fs.existsSync(path.join(proj.data.path, 'assets', 'narration-1.wav')));
  assert.ok(
    (proj.data.config.audio ?? []).some((tk) => tk.src === 'assets/narration-1.wav'),
    JSON.stringify(proj.data.config.audio),
  );
});

test('mcp: synthesize_speech asset-only mode writes a WAV but leaves config.audio unchanged', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const before = await callJson('get_project', { projectId });
  const beforeCount = (before.data.config.audio ?? []).length;

  const res = await callJson('synthesize_speech', {
    projectId, text: 'Second clip, not attached.', voice: 'Microsoft Zira Desktop', mode: 'asset-only',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, false);
  assert.match(res.data.hint, /update_project_config/);
  assert.ok(Number.isInteger(res.data.durationInFrames));

  const proj = await callJson('get_project', { projectId });
  assert.ok(fs.existsSync(path.join(proj.data.path, ...res.data.assetPath.split('/'))));
  assert.equal((proj.data.config.audio ?? []).length, beforeCount);
});

test('mcp: synthesize_speech rejects an assetPath outside assets/', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('synthesize_speech', {
    projectId, text: 'x', voice: 'Microsoft David Desktop', assetPath: '../evil.wav',
  });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'path_outside_project');
});

test('mcp: list_voices / synthesize_speech return tts_unavailable when the exe is missing', async () => {
  // A second server pointed at a nonexistent exe — no ffmpeg needed (TTS tools do not gate on prereqs).
  const badTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home-no-tts'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_TTS_EXE: path.join(tmp, 'no-such-tts.exe'),
    },
    stderr: 'pipe',
  });
  const badClient = new Client({ name: 'ms-test-client-no-tts', version: '0.0.1' });
  await badClient.connect(badTransport);
  try {
    const res = await badClient.callTool({ name: 'list_voices', arguments: {} });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    assert.equal(!!res.isError, true);
    assert.equal(JSON.parse(text).code, 'tts_unavailable');
  } finally {
    await badClient.close().catch(() => {});
  }
});

/* ---------------------------- v0.8 music generation ---------------------------- */
// The music toolchain (MIDI exe + fluidsynth + soundfont) is stubbed via env in the
// shared server. These need no ffmpeg — synthesize_music does not gate on prereqs.

const MUSIC_SPEC = {
  bpm: 96,
  tracks: [
    { program: 0, notes: [{ pitch: 72, start: 0, duration: 1 }, { pitch: 76, start: 1, duration: 1 }] },
    { program: 32, notes: [{ pitch: 48, start: 0, duration: 2 }] },
  ],
};

let musicProjectId;

test('mcp: synthesize_music attach mode writes a WAV and adds an audio track', async () => {
  const proj = await callJson('create_project', { name: 'Music MCP', fps: 30, width: 320, height: 240, durationInFrames: 30 });
  musicProjectId = proj.data.id;

  const res = await callJson('synthesize_music', { projectId: musicProjectId, spec: MUSIC_SPEC, mode: 'attach', gainDb: -8 });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, true);
  assert.equal(res.data.mode, 'attach');
  assert.equal(res.data.assetPath, 'assets/music-1.wav');
  assert.equal(res.data.bpm, 96);
  assert.equal(res.data.tracks, 2);
  assert.equal(res.data.notes, 3);
  assert.ok(res.data.bytes > 0);
  // Stub fluidsynth emits 0.25s; fps 30 → ceil(0.25 * 30) = 8 frames.
  assert.equal(res.data.durationInFrames, 8);
  assert.equal(res.data.fps, 30);

  const after = await callJson('get_project', { projectId: musicProjectId });
  assert.ok(fs.existsSync(path.join(after.data.path, 'assets', 'music-1.wav')));
  const track = (after.data.config.audio ?? []).find((tk) => tk.src === 'assets/music-1.wav');
  assert.ok(track, JSON.stringify(after.data.config.audio));
  assert.equal(track.gainDb, -8);
});

test('mcp: synthesize_music asset-only mode writes a WAV but leaves config.audio unchanged', async () => {
  const before = await callJson('get_project', { projectId: musicProjectId });
  const beforeCount = (before.data.config.audio ?? []).length;

  const res = await callJson('synthesize_music', { projectId: musicProjectId, spec: MUSIC_SPEC, mode: 'asset-only' });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, false);
  assert.match(res.data.hint, /update_project_config/);
  assert.equal(res.data.assetPath, 'assets/music-2.wav');

  const after = await callJson('get_project', { projectId: musicProjectId });
  assert.ok(fs.existsSync(path.join(after.data.path, ...res.data.assetPath.split('/'))));
  assert.equal((after.data.config.audio ?? []).length, beforeCount);
});

test('mcp: synthesize_music rejects an assetPath outside assets/', async () => {
  const res = await callJson('synthesize_music', { projectId: musicProjectId, spec: MUSIC_SPEC, assetPath: '../evil.wav' });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'path_outside_project');
});

test('mcp: synthesize_music returns music_unavailable when the toolchain is missing', async () => {
  const badTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home-no-music'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_TTS_EXE: FAKE_TTS,
      MOTION_STUDIO_MIDI_EXE: path.join(tmp, 'no-such-midi.exe'),
      MOTION_STUDIO_FLUIDSYNTH: path.join(tmp, 'no-such-fs.exe'),
      MOTION_STUDIO_SOUNDFONT: path.join(tmp, 'no-such.sf2'),
    },
    stderr: 'pipe',
  });
  const badClient = new Client({ name: 'ms-test-client-no-music', version: '0.0.1' });
  await badClient.connect(badTransport);
  try {
    const proj = await badClient.callTool({ name: 'create_project', arguments: { name: 'No Music', fps: 30 } });
    const projId = JSON.parse(proj.content.find((c) => c.type === 'text').text).id;
    const res = await badClient.callTool({ name: 'synthesize_music', arguments: { projectId: projId, spec: MUSIC_SPEC } });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    assert.equal(!!res.isError, true);
    assert.equal(JSON.parse(text).code, 'music_unavailable');
  } finally {
    await badClient.close().catch(() => {});
  }
});

/* ------------------------------- v0.9 film assembly ------------------------------- */

const renderToDone = async (projectId) => {
  const start = await callJson('render', { projectId });
  let status; const deadline = Date.now() + 30_000;
  do { await new Promise((r) => setTimeout(r, 100)); status = (await callJson('get_render_status', { jobId: start.data.jobId })).data; }
  while (status.state === 'running' && Date.now() < deadline);
  assert.equal(status.state, 'done', JSON.stringify(status));
};

test('mcp: build_film concatenates rendered scenes into one film', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const sceneIds = [];
  for (const name of ['Scene A', 'Scene B']) {
    const p = await callJson('create_project', { name, fps: 30, width: 320, height: 240, durationInFrames: 6 });
    sceneIds.push(p.data.id);
    await renderToDone(p.data.id);
  }
  const res = await callJson('build_film', { scenes: sceneIds.map((id) => ({ projectId: id })) });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.scenes, 2);
  assert.equal(res.data.totalFrames, 12);
  assert.ok(fs.existsSync(res.data.outputPath));
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', res.data.outputPath]);
  assert.ok(Math.abs(parseFloat(stdout) - 0.4) < 0.2, `film ~0.4s, got ${stdout.trim()}`);
});

test('mcp: build_film reports scene_not_rendered when a scene has no output', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const p = await callJson('create_project', { name: 'Unrendered Scene', fps: 30, width: 320, height: 240, durationInFrames: 6 });
  const res = await callJson('build_film', { scenes: [{ projectId: p.data.id }] });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'scene_not_rendered');
});

test('mcp: build_film rejects scenes with mismatched dimensions', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const a = await callJson('create_project', { name: 'Wide', fps: 30, width: 320, height: 240, durationInFrames: 6 });
  const b = await callJson('create_project', { name: 'Tall', fps: 30, width: 640, height: 480, durationInFrames: 6 });
  await renderToDone(a.data.id);
  await renderToDone(b.data.id);
  const res = await callJson('build_film', { scenes: [{ projectId: a.data.id }, { projectId: b.data.id }] });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'inconsistent_scenes');
});
