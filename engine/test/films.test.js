/**
 * Saved films: FilmStore CRUD + validation, the pure caption/overlay builders
 * (no ffmpeg), planFilm against a real ProjectStore, and the Studio films API
 * end to end — create → edit → render scenes (fake browser) → build (real
 * ffmpeg concat + finishing pass) → download, gated on ffmpeg where needed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  FilmStore, validateFilm, normalizeFilm, captionsToSrt, captionsToAss, buildOverlayGraph, planFilm,
} from '../src/core/films.js';
import { ProjectStore } from '../src/core/project.js';
import { JobManager } from '../src/core/jobs.js';
import { createStudioServer } from '../src/studio/server.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';

const execFileP = promisify(execFile);
let haveFfmpeg = false;
try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated */ }

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-films-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

/* ------------------------------ validation ------------------------------ */

test('validateFilm collects every problem at once', () => {
  const bad = normalizeFilm({
    name: '',
    audio: [{ src: 'not-under-assets.wav', gainDb: 'loud' }],
    captions: [{ text: 'x', fromFrame: 10, toFrame: 5 }],
    overlays: [{ src: 'assets/logo.png', fromFrame: 0, toFrame: 0 }],
  });
  try {
    validateFilm(bad);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'invalid_film');
    assert.ok(e.detail.problems.length >= 4, JSON.stringify(e.detail.problems));
  }
});

test('normalizeFilm stamps ids and fills defaults', () => {
  const film = normalizeFilm({ name: 'F', captions: [{ text: 'hi', fromFrame: 0, toFrame: 30 }] });
  assert.ok(film.captions[0].id);
  assert.equal(film.outputFilename, 'film');
  assert.equal(film.captionStyle.sizePct, 4.5);
  assert.equal(film.burnCaptions, false);
  assert.deepEqual(film.audio, []);
  validateFilm(film); // defaults must validate
});

test('validateFilm rejects a path-escaping outputFilename', () => {
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', outputFilename: '../evil' })),
    (e) => e.code === 'invalid_film');
});

/* ------------------------------- captions ------------------------------- */

test('captionsToSrt formats and orders cues', () => {
  const srt = captionsToSrt([
    { text: 'World', fromFrame: 90, toFrame: 150 },
    { text: 'Hello', fromFrame: 0, toFrame: 60 },
  ], 30);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nHello\n/);
  assert.match(srt, /2\n00:00:03,000 --> 00:00:05,000\nWorld\n/);
});

test('captionsToAss pins resolution, style and escapes override syntax', () => {
  const ass = captionsToAss(
    [{ text: 'brace {\\test}\nsecond line', fromFrame: 30, toFrame: 90 }],
    30,
    { width: 1920, height: 1080, style: { sizePct: 5, position: 'top' } },
  );
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /PlayResY: 1080/);
  assert.match(ass, /Style: Caption,Arial,54,/); // 1080 * 5% = 54
  assert.match(ass, /,8,/); // top alignment in the style line
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.00,Caption,,0,0,0,,brace \(\/test\)\\Nsecond line/);
  assert.ok(!ass.includes('{')); // no ASS override blocks survive
});

/* ---------------------------- overlay graph ----------------------------- */

test('buildOverlayGraph places, scales and gates overlays', () => {
  const { filterComplex, outLabel } = buildOverlayGraph([
    { fromFrame: 30, toFrame: 90, xPct: 10, yPct: 20, widthPct: 50, opacity: 0.5, isVideo: false },
  ], { width: 1920, height: 1080, fps: 30 });
  assert.equal(outLabel, 'v0');
  assert.match(filterComplex, /\[1:v\]format=rgba,scale=960:-1,colorchannelmixer=aa=0\.500\[ov0\]/);
  assert.match(filterComplex, /\[0:v\]\[ov0\]overlay=x=192:y=216:enable='between\(t,1\.000,3\.000\)'\[v0\]/);
});

test('buildOverlayGraph shifts video overlays and chains + subtitles', () => {
  const { filterComplex, outLabel } = buildOverlayGraph([
    { fromFrame: 0, toFrame: 60, isVideo: true },
    { fromFrame: 60, toFrame: 120, isVideo: false },
  ], { width: 640, height: 360, fps: 30, subtitlesFile: 'captions.ass' });
  assert.match(filterComplex, /setpts=PTS-STARTPTS\+0\.000\/TB/);
  assert.match(filterComplex, /\[v0\]\[ov1\]overlay=/);
  assert.match(filterComplex, /\[v1\]subtitles=captions\.ass\[vsub\]/);
  assert.equal(outLabel, 'vsub');
});

test('buildOverlayGraph with captions only burns straight off the base', () => {
  const { filterComplex, outLabel } = buildOverlayGraph([], { width: 640, height: 360, fps: 30, subtitlesFile: 'c.ass' });
  assert.equal(filterComplex, '[0:v]subtitles=c.ass[vsub]');
  assert.equal(outLabel, 'vsub');
});

/* -------------------------------- store --------------------------------- */

test('FilmStore: create → get → update → list → remove', async () => {
  await withTmp(async (home) => {
    const films = new FilmStore(home);
    const film = await films.createFilm({ name: 'My Film', scenes: [{ projectId: 'a' }] });
    assert.ok(film.id);
    assert.equal((await films.getFilm(film.id)).name, 'My Film');

    const updated = await films.updateFilm(film.id, {
      audio: [{ src: 'assets/bed.wav', gainDb: -8, duck: true }],
      captions: [{ text: 'Hi', fromFrame: 0, toFrame: 30 }],
    });
    assert.equal(updated.audio.length, 1);
    assert.ok(updated.audio[0].id, 'update stamps ids too');
    assert.equal(updated.scenes.length, 1, 'unpatched fields survive');

    assert.equal((await films.listFilms()).length, 1);
    await assert.rejects(films.updateFilm(film.id, { nope: 1 }), (e) => e.code === 'invalid_film');
    await assert.rejects(films.getFilm('missing'), (e) => e.code === 'film_not_found');

    await films.removeFilm(film.id);
    assert.equal((await films.listFilms()).length, 0);
  });
});

/* -------------------------------- planFilm ------------------------------ */

test('planFilm reports problems instead of throwing', async () => {
  await withTmp(async (home) => {
    const store = new ProjectStore(home);
    const films = new FilmStore(home);
    const a = await store.createProject({ name: 'Scene A', width: 320, height: 240, fps: 30, durationInFrames: 10 });
    const b = await store.createProject({ name: 'Scene B', width: 640, height: 480, fps: 30, durationInFrames: 20 });

    const film = await films.createFilm({
      name: 'Plan',
      scenes: [{ projectId: a.id }, { projectId: b.id }, { projectId: 'ghost' }],
      outputProjectId: a.id,
      audio: [{ src: 'assets/missing.wav' }],
    });
    const plan = await planFilm({ film, store });
    const codes = plan.problems.map((p) => p.code);
    assert.ok(codes.includes('scene_missing'), codes.join(','));
    assert.ok(codes.includes('signature_mismatch'));
    assert.ok(codes.includes('scene_not_rendered'));
    assert.ok(codes.includes('asset_missing'));
    assert.equal(plan.totalFrames, 30); // ghost contributes 0
    assert.equal(plan.scenes[1].filmOffset, 10);
  });
});

/* ------------------------------ studio API ------------------------------ */

let server, base, home;
before(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-films-studio-'));
  server = createStudioServer({
    store: new ProjectStore(home),
    jobs: new JobManager(),
    browserFactory: makeFakeBrowserFactory(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
});

const j = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.json();
  return { status: res.status, data, res };
};

async function waitJob(jobId, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await j(`/api/jobs/${jobId}`);
    if (['done', 'error', 'cancelled'].includes(data.state)) return data;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} timed out in state ${data.state}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

let sceneA, sceneB, filmId, masterId;

test('films API: create film + auto master project', async () => {
  sceneA = (await j('/api/projects', { method: 'POST', body: { name: 'Cut A', width: 320, height: 240, fps: 30, durationInFrames: 8 } })).data;
  sceneB = (await j('/api/projects', { method: 'POST', body: { name: 'Cut B', width: 320, height: 240, fps: 30, durationInFrames: 8 } })).data;

  const created = await j('/api/films', {
    method: 'POST',
    body: { name: 'E2E Film', scenes: [{ projectId: sceneA.id }, { projectId: sceneB.id }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  filmId = created.data.film.id;
  masterId = created.data.film.outputProjectId;
  assert.ok(masterId, 'a dedicated master project is scaffolded');

  const { data } = await j('/api/projects');
  const master = data.projects.find((p) => p.id === masterId);
  assert.match(master.name, /E2E Film — Master/);

  const list = await j('/api/films');
  assert.equal(list.data.films.length, 1);
  assert.equal(list.data.films[0].scenes, 2);
});

test('films API: detail reports layout and problems', async () => {
  const { status, data } = await j(`/api/films/${filmId}`);
  assert.equal(status, 200);
  assert.equal(data.detail.totalFrames, 16);
  assert.equal(data.detail.scenes[1].filmOffset, 8);
  const codes = data.detail.problems.map((p) => p.code);
  assert.ok(codes.includes('scene_not_rendered'));
});

test('films API: PATCH edits tracks, rejects junk', async () => {
  const bad = await j(`/api/films/${filmId}`, { method: 'PATCH', body: { patch: { bogus: true } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_film');

  const patched = await j(`/api/films/${filmId}`, {
    method: 'PATCH',
    body: { patch: { captions: [{ text: 'Hello film', fromFrame: 0, toFrame: 12 }] } },
  });
  assert.equal(patched.status, 200);
  assert.ok(patched.data.film.captions[0].id);
});

test('films API: build refuses while scenes are unrendered', async () => {
  const res = await j(`/api/films/${filmId}/build`, { method: 'POST', body: {} });
  assert.equal(res.status, haveFfmpeg ? 409 : 503); // no ffmpeg: prereq resolution wins
  if (haveFfmpeg) assert.equal(res.data.code, 'scene_not_rendered');
});

test('films API: render scenes → build with master audio + captions → sidecar', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');

  for (const p of [sceneA, sceneB]) {
    const job = (await j(`/api/projects/${p.id}/render`, { method: 'POST', body: { workers: 1 } })).data;
    const done = await waitJob(job.jobId);
    assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  }

  // A one-second bed into the master project's assets (raw-body upload).
  const wavPath = path.join(home, 'bed.wav');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '44100', wavPath]);
  const put = await fetch(`${base}/api/projects/${masterId}/asset?path=${encodeURIComponent('assets/bed.wav')}`, {
    method: 'PUT', body: await fsp.readFile(wavPath),
  });
  assert.equal(put.status, 201);

  const patched = await j(`/api/films/${filmId}`, {
    method: 'PATCH',
    body: { patch: { audio: [{ src: 'assets/bed.wav', gainDb: -6 }] } },
  });
  assert.equal(patched.status, 200);

  const build = await j(`/api/films/${filmId}/build`, { method: 'POST', body: { outputFilename: 'e2e', audioTargetPeakDb: -2 } });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  assert.ok(done.audio, 'master timeline reports measured levels');

  const master = (await j(`/api/projects/${masterId}`)).data;
  const outDir = path.join(master.path, 'out');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.mp4')), 'film written');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.srt')), 'caption sidecar written');
  const srt = await fsp.readFile(path.join(outDir, 'e2e.srt'), 'utf8');
  assert.match(srt, /Hello film/);
});

test('films API: overlay triggers the finishing pass', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');

  const pngPath = path.join(home, 'logo.png');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', pngPath]);
  const put = await fetch(`${base}/api/projects/${masterId}/asset?path=${encodeURIComponent('assets/logo.png')}`, {
    method: 'PUT', body: await fsp.readFile(pngPath),
  });
  assert.equal(put.status, 201);

  await j(`/api/films/${filmId}`, {
    method: 'PATCH',
    body: { patch: { overlays: [{ src: 'assets/logo.png', fromFrame: 0, toFrame: 16, xPct: 5, yPct: 5, widthPct: 20, opacity: 0.8 }] } },
  });
  const build = await j(`/api/films/${filmId}/build`, { method: 'POST', body: { outputFilename: 'e2e-overlay' } });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));

  const master = (await j(`/api/projects/${masterId}`)).data;
  const outPath = path.join(master.path, 'out', 'e2e-overlay.mp4');
  assert.ok(fs.existsSync(outPath));
  assert.ok((await fsp.stat(outPath)).size > 0);
});

test('films API: preview-audio streams the master mix', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await fetch(`${base}/api/films/${filmId}/preview-audio`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 44, 'more than a WAV header');
});

test('asset streaming honours Range requests (video scrubbing)', async () => {
  const res = await fetch(`${base}/api/projects/${masterId}/asset?path=${encodeURIComponent('assets/bed.wav')}`, {
    headers: { Range: 'bytes=0-3' },
  });
  if (res.status === 404) return; // wav upload skipped without ffmpeg
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '4');
  assert.match(res.headers.get('content-range'), /^bytes 0-3\/\d+$/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('ascii'), 'RIFF');
});

test('studio TTS endpoint rejects empty text up front', async () => {
  const res = await j(`/api/projects/${masterId}/tts`, { method: 'POST', body: { text: '  ' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'invalid_config');
});

test('films API: delete leaves projects alone', async () => {
  const res = await j(`/api/films/${filmId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await j('/api/films')).data.films.length, 0);
  assert.equal((await j(`/api/projects/${masterId}`)).status, 200, 'master project survives');
});
