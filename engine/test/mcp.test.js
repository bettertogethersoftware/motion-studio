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
