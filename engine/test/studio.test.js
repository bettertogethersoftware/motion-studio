/**
 * Studio web server tests: boot on an ephemeral port with the fake browser
 * injected, then drive the same flow the UI does — create project → fetch
 * config → preview file serving (incl. sandbox 403) → patch config → render →
 * poll job → download output → still export → remove project.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createStudioServer } from '../src/studio/server.js';
import { ProjectStore } from '../src/core/project.js';
import { JobManager } from '../src/core/jobs.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';

const execFileP = promisify(execFile);

let server, base, haveFfmpeg = true;

before(async () => {
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-studio-'));
  server = createStudioServer({
    store: new ProjectStore(home),
    jobs: new JobManager(),
    browserFactory: makeFakeBrowserFactory(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const j = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) data = await res.json();
  return { status: res.status, data, res };
};

let projectId;

test('studio: serves the UI shell and static assets', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /MOTION/);
  const app = await fetch(base + '/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);
});

test('studio: prereqs endpoint reports engine state', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { status, data } = await j('/api/prereqs');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('studio: create project → list → get', async () => {
  const created = await j('/api/projects', {
    method: 'POST',
    body: { name: 'Studio Demo', fps: 30, width: 320, height: 240, durationInFrames: 20 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  projectId = created.data.id;

  const list = await j('/api/projects');
  assert.equal(list.data.projects.length, 1);

  const got = await j(`/api/projects/${projectId}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.config.output.format, 'mp4');
  assert.ok(got.data.files.some((f) => f.path === 'composition.js'));
});

test('studio: preview serves project files through the sandbox (403 on escape)', async () => {
  const okRes = await fetch(`${base}/preview/${projectId}/composition.html`);
  assert.equal(okRes.status, 200);
  assert.match(okRes.headers.get('content-type'), /text\/html/);
  assert.match(await okRes.text(), /frame-api\.js/);

  const jsRes = await fetch(`${base}/preview/${projectId}/frame-api.js`);
  assert.equal(jsRes.status, 200);

  const escape = await fetch(`${base}/preview/${projectId}/..%2F..%2Fregistry.json`);
  assert.equal(escape.status, 403);
  const escape2 = await fetch(`${base}/preview/${projectId}/${encodeURIComponent('../../../etc/passwd')}`);
  assert.equal(escape2.status, 403);
});

test('studio: PATCH config validates and normalizes the output filename', async () => {
  const good = await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: { patch: { output: { format: 'webm' } } },
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.config.output.filename, 'output.webm');

  const bad = await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: { patch: { output: { format: 'mp4', transparent: true } } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_config');

  // restore mp4
  await j(`/api/projects/${projectId}/config`, { method: 'PATCH', body: { patch: { output: { format: 'mp4', transparent: false } } } });
});

test('studio: render → poll to done → outputs list → download', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const started = await j(`/api/projects/${projectId}/render`, { method: 'POST', body: { workers: 1 } });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.state, 'running');
  const { jobId } = started.data;

  let status;
  for (let i = 0; i < 300; i++) {
    status = (await j(`/api/jobs/${jobId}`)).data;
    if (!['running', 'queued'].includes(status.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.state, 'done', JSON.stringify(status));
  assert.equal(status.framesDone, 20);

  const logs = await j(`/api/jobs/${jobId}/logs`);
  assert.ok(logs.data.logs.some((l) => /encoding/.test(l.message)));

  const outputs = await j(`/api/projects/${projectId}/outputs`);
  assert.ok(outputs.data.files.some((f) => f.name === 'output.mp4'));

  const dl = await fetch(`${base}/api/projects/${projectId}/output?file=output.mp4&download=1`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /video\/mp4/);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.ok(bytes.length > 1000, `mp4 is ${bytes.length} bytes`);

  // Output download is sandboxed too.
  const escape = await fetch(`${base}/api/projects/${projectId}/output?file=${encodeURIComponent('../project.json')}`);
  assert.equal(escape.status, 403);
});

test('studio: still export writes a PNG into out/ and rejects bad names', async () => {
  const ok = await j(`/api/projects/${projectId}/still`, { method: 'POST', body: { frame: 4 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.outputPath.endsWith('still-4.png'));
  const bad = await j(`/api/projects/${projectId}/still`, { method: 'POST', body: { frame: 0, outputFilename: '../x.png' } });
  assert.equal(bad.status, 403);
});

test('studio: queue is visible over HTTP and cancel works', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const a = await j(`/api/projects/${projectId}/render`, { method: 'POST', body: {} });
  const b = await j(`/api/projects/${projectId}/render`, { method: 'POST', body: {} });
  assert.equal(a.data.state, 'running');
  assert.equal(b.data.state, 'queued');
  assert.equal(b.data.queuePosition, 1);

  const cancelled = await j(`/api/jobs/${b.data.jobId}/cancel`, { method: 'POST' });
  assert.equal(cancelled.data.state, 'cancelled');

  // Drain the running job so `after` can close the server cleanly.
  for (let i = 0; i < 300; i++) {
    const s = (await j(`/api/jobs/${a.data.jobId}`)).data;
    if (!['running', 'queued'].includes(s.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('studio: SSE hot-reload stream emits a change event on file edits', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/projects/${projectId}/events`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const gotChange = (async () => {
    let buf = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('"type":"change"')) return true;
    }
    return false;
  })();

  // Touch a project file after the stream is up.
  await new Promise((r) => setTimeout(r, 300));
  const proj = (await j(`/api/projects/${projectId}`)).data;
  await fsp.writeFile(path.join(proj.path, 'styles.css'), `/* edited ${Date.now()} */\n`, { flag: 'a' });

  assert.equal(await gotChange, true, 'expected an SSE change event within 8s');
  ctrl.abort();
});

test('studio: unknown routes and unknown projects are structured errors', async () => {
  assert.equal((await j('/api/nope')).status, 404);
  const missing = await j('/api/projects/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'project_not_found');
});

test('studio: DELETE unregisters the project', async () => {
  const removed = await j(`/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.unregistered, true);
  const list = await j('/api/projects');
  assert.equal(list.data.projects.length, 0);
});
