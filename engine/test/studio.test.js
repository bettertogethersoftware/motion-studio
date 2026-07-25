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

test('studio: prereqs names the probed ffmpeg binary and its source (v0.15)', async () => {
  const { status, data } = await j('/api/prereqs');
  assert.equal(status, 200);
  assert.equal(data.ffmpeg.effectivePath, 'ffmpeg');
  assert.equal(data.ffmpeg.source, 'PATH');
  assert.equal(data.minimums.ffmpeg, '5.0');
  assert.equal(data.minimums.node, '18.0.0');

  // With a configured path, a failure can be attributed to settings rather
  // than reported as an anonymous "prerequisites missing".
  await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { path: 'C:/nope/ffmpeg.exe' } } } });
  const bad = await j('/api/prereqs');
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.ffmpeg.found, false);
  assert.equal(bad.data.ffmpeg.effectivePath, 'C:/nope/ffmpeg.exe');
  assert.equal(bad.data.ffmpeg.source, 'settings');
  await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { path: null } } } });
});

test('studio: config PATCH covers the whole output block and clears with null (v0.15)', async () => {
  const full = await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: {
      patch: {
        output: {
          format: 'mp4', dir: 'renders', filename: 'take-1',
          crf: 20, preset: 'slow', pixFmt: 'yuv444p', audioLimiter: false, transparent: false,
        },
      },
    },
  });
  assert.equal(full.status, 200, JSON.stringify(full.data));
  const o = full.data.config.output;
  assert.equal(o.dir, 'renders');
  assert.equal(o.filename, 'take-1.mp4'); // extension normalized to the format
  assert.equal(o.crf, 20);
  assert.equal(o.preset, 'slow');
  assert.equal(o.pixFmt, 'yuv444p');
  assert.equal(o.audioLimiter, false);

  // null removes a key so the format's own default applies again; an omitted
  // key keeps its current value.
  const cleared = await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: { patch: { output: { preset: null, pixFmt: null } } },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal('preset' in cleared.data.config.output, false);
  assert.equal('pixFmt' in cleared.data.config.output, false);
  assert.equal(cleared.data.config.output.crf, 20, 'omitted keys survive the merge');

  // Restore the defaults the later render tests expect.
  await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: { patch: { output: { dir: 'out', filename: 'output', crf: 18, audioLimiter: true } } },
  });
});

test('studio: audio tracks round-trip through config PATCH (v0.15)', async () => {
  const withAudio = await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: {
      patch: {
        audio: [
          { src: 'assets/music.mp3', startInFrames: 0, gainDb: -6 },
          { src: 'assets/vo.wav', startInFrames: 45, gainDb: 0 },
        ],
      },
    },
  });
  assert.equal(withAudio.status, 200, JSON.stringify(withAudio.data));
  assert.equal(withAudio.data.config.audio.length, 2);
  assert.equal(withAudio.data.config.audio[1].startInFrames, 45);

  const bad = await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: { patch: { audio: [{ src: 'assets/x.wav', startInFrames: -3 }] } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_config');

  // Empty array is how the UI says "no tracks".
  const none = await j(`/api/projects/${projectId}/config`, { method: 'PATCH', body: { patch: { audio: [] } } });
  assert.equal(none.status, 200);
  assert.deepEqual(none.data.config.audio, []);
});

test('studio: settings — defaults, patch, validation, unknown keys (v0.15)', async () => {
  const got = await j('/api/settings');
  assert.equal(got.status, 200);
  assert.equal(got.data.settings.newProjectDefaults.fps, 30);
  assert.equal(got.data.settings.render.defaultWorkers, 1);
  assert.ok(got.data.environment.dataDir);
  assert.ok(got.data.environment.projectsRoot);
  assert.ok('MOTION_STUDIO_TTS_EXE' in got.data.environment.env);

  const patched = await j('/api/settings', {
    method: 'PATCH',
    body: { patch: { newProjectDefaults: { fps: 24, width: 1280, height: 720 }, render: { defaultWorkers: 2 } } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal(patched.data.settings.newProjectDefaults.fps, 24);
  assert.equal(patched.data.settings.newProjectDefaults.durationInFrames, 150); // untouched field survives

  // Persisted: a fresh GET reads the file back.
  const again = await j('/api/settings');
  assert.equal(again.data.settings.render.defaultWorkers, 2);

  const invalid = await j('/api/settings', { method: 'PATCH', body: { patch: { render: { defaultWorkers: 99 } } } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'invalid_config');

  const unknown = await j('/api/settings', { method: 'PATCH', body: { patch: { evil: true } } });
  assert.equal(unknown.status, 400);
});

test('studio: ffmpeg settings — probe report, path override, encode defaults (v0.15)', async (t) => {
  const got = await j('/api/settings');
  assert.deepEqual(got.data.settings.ffmpeg, { path: null, defaultCrf: null, defaultPreset: null });
  if (haveFfmpeg) {
    assert.equal(got.data.environment.ffmpeg.source, 'PATH');
    assert.equal(got.data.environment.ffmpeg.found, true);
  }

  // Validation.
  const badPreset = await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { defaultPreset: 'warp9' } } } });
  assert.equal(badPreset.status, 400);
  const badCrf = await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { defaultCrf: 99 } } } });
  assert.equal(badCrf.status, 400);

  // A bogus binary path is saved (it might not exist *yet*) but the probe and
  // /api/prereqs both report it as missing.
  const bogus = await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { path: 'C:/nope/ffmpeg.exe' } } } });
  assert.equal(bogus.status, 200);
  const probed = await j('/api/settings');
  assert.equal(probed.data.environment.ffmpeg.source, 'settings');
  assert.equal(probed.data.environment.ffmpeg.found, false);
  const prereqs = await j('/api/prereqs');
  assert.equal(prereqs.data.ffmpeg.found, false);
  await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { path: null } } } });

  // Encode defaults seed newly created projects (and only new ones).
  await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { defaultCrf: 28, defaultPreset: 'fast' } } } });
  const created = await j('/api/projects', { method: 'POST', body: { name: 'Encode Defaults Probe' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.config.output.crf, 28);
  assert.equal(created.data.config.output.preset, 'fast');
  await j(`/api/projects/${created.data.id}?deleteFiles=1`, { method: 'DELETE' });
  await j('/api/settings', { method: 'PATCH', body: { patch: { ffmpeg: { defaultCrf: null, defaultPreset: null } } } });
});

test('studio: new project inherits settings defaults for unset fields (v0.15)', async () => {
  // Settings currently hold fps 24 / 1280×720 from the previous test.
  const created = await j('/api/projects', { method: 'POST', body: { name: 'Defaults Probe' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.config.fps, 24);
  assert.equal(created.data.config.width, 1280);
  assert.equal(created.data.config.height, 720);

  // Explicit fields still win over defaults.
  const explicit = await j('/api/projects', { method: 'POST', body: { name: 'Explicit Probe', fps: 60 } });
  assert.equal(explicit.data.config.fps, 60);
  assert.equal(explicit.data.config.width, 1280);

  // Clean up so the registry-count assertions below stay valid.
  await j(`/api/projects/${created.data.id}?deleteFiles=1`, { method: 'DELETE' });
  await j(`/api/projects/${explicit.data.id}?deleteFiles=1`, { method: 'DELETE' });

  // Restore stock defaults for any later test.
  await j('/api/settings', {
    method: 'PATCH',
    body: { patch: { newProjectDefaults: { fps: 30, width: 1920, height: 1080 }, render: { defaultWorkers: 1 } } },
  });
});

test('studio: asset upload → list → download → rename → delete (v0.15)', async () => {
  // 1×1 red PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const up = await fetch(`${base}/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/dot.png')}`, {
    method: 'PUT',
    body: png,
  });
  assert.equal(up.status, 201);
  assert.deepEqual(await up.json(), { path: 'assets/dot.png', bytes: png.length });

  const list = await j(`/api/projects/${projectId}/assets`);
  assert.equal(list.status, 200);
  const entry = list.data.files.find((f) => f.path === 'assets/dot.png');
  assert.ok(entry, JSON.stringify(list.data));
  assert.equal(entry.kind, 'image');
  assert.equal(entry.bytes, png.length);

  const dl = await fetch(`${base}/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/dot.png')}&download=1`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /image\/png/);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, png.length);

  const renamed = await j(`/api/projects/${projectId}/asset/rename`, {
    method: 'POST',
    body: { from: 'assets/dot.png', to: 'assets/img/pixel.png' },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.to, 'assets/img/pixel.png');
  const afterRename = await j(`/api/projects/${projectId}/assets`);
  assert.ok(afterRename.data.files.some((f) => f.path === 'assets/img/pixel.png'));
  assert.ok(!afterRename.data.files.some((f) => f.path === 'assets/dot.png'));

  // Rename refuses to clobber an existing destination.
  const again = await fetch(`${base}/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/dot.png')}`, {
    method: 'PUT', body: png,
  });
  assert.equal(again.status, 201);
  const clobber = await j(`/api/projects/${projectId}/asset/rename`, {
    method: 'POST',
    body: { from: 'assets/dot.png', to: 'assets/img/pixel.png' },
  });
  assert.equal(clobber.status, 400);

  const del = await j(`/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/dot.png')}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);
  const delMissing = await j(`/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/dot.png')}`, { method: 'DELETE' });
  assert.equal(delMissing.status, 404);
});

test('studio: deleting/renaming an asset can fix the audio tracks that use it (v0.15)', async () => {
  const wav = Buffer.alloc(2048, 7);
  const put = (p) =>
    fetch(`${base}/api/projects/${projectId}/asset?path=${encodeURIComponent(p)}`, { method: 'PUT', body: wav });
  await put('assets/theme.wav');
  await put('assets/vo.wav');
  await j(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    body: {
      patch: {
        audio: [
          { src: 'assets/theme.wav', startInFrames: 0, gainDb: -6 },
          { src: 'assets/vo.wav', startInFrames: 10, gainDb: 0 },
        ],
      },
    },
  });

  // The listing reports the reference count, so the UI can warn before the click.
  const listed = await j(`/api/projects/${projectId}/assets`);
  assert.equal(listed.data.files.find((f) => f.path === 'assets/theme.wav').audioRefs, 1);
  assert.equal(listed.data.files.find((f) => f.path === 'assets/dot.png')?.audioRefs ?? 0, 0);

  // Rename with updateAudio rewrites the track's src.
  const renamed = await j(`/api/projects/${projectId}/asset/rename`, {
    method: 'POST',
    body: { from: 'assets/theme.wav', to: 'assets/music/theme.wav', updateAudio: true },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.audioRefs, 1);
  assert.equal(renamed.data.audioTracksUpdated, 1);
  assert.equal(renamed.data.config.audio[0].src, 'assets/music/theme.wav');
  assert.equal(renamed.data.config.audio[0].gainDb, -6, 'other track fields survive the rewrite');

  // Delete without the flag leaves the reference dangling, but says so.
  const kept = await j(`/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/vo.wav')}`, { method: 'DELETE' });
  assert.equal(kept.status, 200);
  assert.equal(kept.data.audioRefs, 1);
  assert.equal(kept.data.audioTracksRemoved, 0);
  const stillThere = await j(`/api/projects/${projectId}`);
  assert.equal(stillThere.data.config.audio.length, 2);

  // Delete with the flag drops exactly the matching track.
  const cleaned = await j(
    `/api/projects/${projectId}/asset?path=${encodeURIComponent('assets/music/theme.wav')}&updateAudio=1`,
    { method: 'DELETE' },
  );
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.data));
  assert.equal(cleaned.data.audioTracksRemoved, 1);
  assert.equal(cleaned.data.config.audio.length, 1);
  assert.equal(cleaned.data.config.audio[0].src, 'assets/vo.wav');

  await j(`/api/projects/${projectId}/config`, { method: 'PATCH', body: { patch: { audio: [] } } });
});

test('studio: asset endpoints enforce the assets/ sandbox (v0.15)', async () => {
  const put = (p) =>
    fetch(`${base}/api/projects/${projectId}/asset?path=${encodeURIComponent(p)}`, { method: 'PUT', body: Buffer.from('x') });

  assert.equal((await put('composition.js')).status, 403);         // outside assets/
  assert.equal((await put('assets/../project.json')).status, 403); // traversal
  assert.equal((await put('assets/tool.exe')).status, 403);        // extension not allow-listed

  const read = await fetch(`${base}/api/projects/${projectId}/asset?path=${encodeURIComponent('project.json')}`);
  assert.equal(read.status, 403);

  const del = await j(`/api/projects/${projectId}/asset?path=${encodeURIComponent('../registry.json')}`, { method: 'DELETE' });
  assert.equal(del.status, 403);

  const rename = await j(`/api/projects/${projectId}/asset/rename`, {
    method: 'POST',
    body: { from: 'assets/img/pixel.png', to: '../escape.png' },
  });
  assert.equal(rename.status, 403);
});

test('studio: DELETE unregisters the project', async () => {
  const removed = await j(`/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.unregistered, true);
  const list = await j('/api/projects');
  assert.equal(list.data.projects.length, 0);
});
