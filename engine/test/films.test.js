/**
 * Films: document validation, the pure caption/overlay builders (no ffmpeg),
 * planFilm against a real WorkspaceStore, and the Studio films API end to end
 * — create → add scenes → edit → render scenes (fake browser) → build (real
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
  validateFilm, normalizeFilm, captionsToSrt, captionsToAss, buildOverlayGraph, planFilm,
} from '../src/core/films.js';
import { JobManager } from '../src/core/jobs.js';
import { createStudioServer } from '../src/studio/server.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';

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

test('validateFilm rejects bad scene refs and duplicates', () => {
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{ slug: '../nope' }] })),
    (e) => e.code === 'invalid_film');
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', scenes: [{ slug: 'a' }, { slug: 'a' }] })),
    (e) => e.code === 'invalid_film' && /more than once/.test(e.detail.problems.join(' ')));
});

test('validateFilm checks sceneDefaults shape', () => {
  validateFilm(normalizeFilm({ name: 'F', sceneDefaults: { fps: 24, width: 640 } }));
  assert.throws(() => validateFilm(normalizeFilm({ name: 'F', sceneDefaults: { fps: 0 } })),
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

test('film documents: create → get → update → list → remove (folder survives)', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'My Film' });
    assert.equal(film.id, `${TEST_WS}/my-film`);
    assert.equal((await store.getFilm(film.id)).name, 'My Film');

    const updated = await store.updateFilm(film.id, {
      audio: [{ src: 'assets/bed.wav', gainDb: -8, duck: true }],
      captions: [{ text: 'Hi', fromFrame: 0, toFrame: 30 }],
    });
    assert.equal(updated.audio.length, 1);
    assert.ok(updated.audio[0].id, 'update stamps ids too');

    assert.equal((await store.listFilms(TEST_WS)).length, 1);
    await assert.rejects(store.updateFilm(film.id, { nope: 1 }), (e) => e.code === 'invalid_film');
    await assert.rejects(store.getFilm(`${TEST_WS}/missing`), (e) => e.code === 'film_not_found');

    // Without deleteFiles only the document goes; the folder lists as broken.
    await store.removeFilm(film.id);
    const after = await store.listFilms(TEST_WS);
    assert.equal(after.length, 1);
    assert.equal(after[0].broken, true);
    assert.ok(fs.existsSync(film.path));

    await store.removeFilm(film.id, { deleteFiles: true }).catch(() => {});
    await fsp.rm(film.path, { recursive: true, force: true });
    assert.equal((await store.listFilms(TEST_WS)).length, 0);
  });
});

/* -------------------------------- planFilm ------------------------------ */

test('planFilm reports problems instead of throwing', async () => {
  await withTmp(async (home) => {
    const store = await makeStore(home);
    const film = await store.createFilm(TEST_WS, { name: 'Plan' });
    await store.createScene(film.id, { name: 'Scene A', width: 320, height: 240, fps: 30, durationInFrames: 10 });
    await store.createScene(film.id, { name: 'Scene B', width: 640, height: 480, fps: 30, durationInFrames: 20 });

    const doc = await store.updateFilm(film.id, {
      scenes: [{ slug: 'scene-a' }, { slug: 'scene-b' }, { slug: 'ghost' }],
      audio: [{ src: 'assets/missing.wav' }],
    });
    const plan = await planFilm({ film: doc, store });
    const codes = plan.problems.map((p) => p.code);
    assert.ok(codes.includes('scene_missing'), codes.join(','));
    assert.ok(codes.includes('signature_mismatch'));
    assert.ok(codes.includes('scene_not_rendered'));
    assert.ok(codes.includes('asset_missing'));
    assert.equal(plan.totalFrames, 30); // ghost contributes 0
    assert.equal(plan.scenes[1].filmOffset, 10);
    assert.equal(plan.scenes[0].sceneId, `${film.id}/scene-a`);
  });
});

/* ------------------------------ studio API ------------------------------ */

let server, base, home;
before(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-films-studio-'));
  server = createStudioServer({
    store: await makeStore(home),
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

const enc = encodeURIComponent;
let filmId, sceneA, sceneB;

test('films API: create film in a workspace, add scenes', async () => {
  const created = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST',
    body: { name: 'E2E Film', width: 320, height: 240, fps: 30, durationInFrames: 8 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  filmId = created.data.film.id;
  assert.equal(filmId, `${TEST_WS}/e2e-film`);
  assert.deepEqual(created.data.film.sceneDefaults, { fps: 30, width: 320, height: 240, durationInFrames: 8 });

  sceneA = (await j(`/api/films/${enc(filmId)}/scenes`, { method: 'POST', body: { name: 'Cut A' } })).data;
  sceneB = (await j(`/api/films/${enc(filmId)}/scenes`, { method: 'POST', body: { name: 'Cut B' } })).data;
  assert.equal(sceneA.config.width, 320, 'sceneDefaults inherited');

  const tree = await j('/api/workspaces');
  const ws = tree.data.workspaces.find((w) => w.id === TEST_WS);
  assert.ok(ws, 'workspace listed');
  assert.equal(ws.films.length, 1);
  assert.equal(ws.films[0].scenes, 2);
});

test('films API: detail reports layout and problems', async () => {
  const { status, data } = await j(`/api/films/${enc(filmId)}`);
  assert.equal(status, 200);
  assert.equal(data.detail.totalFrames, 16);
  assert.equal(data.detail.scenes[1].filmOffset, 8);
  const codes = data.detail.problems.map((p) => p.code);
  assert.ok(codes.includes('scene_not_rendered'));
  assert.equal(data.sceneFolders.length, 2);
});

test('films API: PATCH edits tracks, rejects junk', async () => {
  const bad = await j(`/api/films/${enc(filmId)}`, { method: 'PATCH', body: { patch: { bogus: true } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_film');

  const patched = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { captions: [{ text: 'Hello film', fromFrame: 0, toFrame: 12 }] } },
  });
  assert.equal(patched.status, 200);
  assert.ok(patched.data.film.captions[0].id);
});

test('films API: build refuses while scenes are unrendered', async () => {
  const res = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'scene_not_rendered');
});

test('films API: render scenes → build with master audio + captions → sidecar', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');

  for (const s of [sceneA, sceneB]) {
    const job = (await j(`/api/scenes/${enc(s.id)}/render`, { method: 'POST', body: { workers: 1 } })).data;
    const done = await waitJob(job.jobId);
    assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  }

  // A one-second bed into the FILM's own assets (raw-body upload).
  const wavPath = path.join(home, 'bed.wav');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '44100', wavPath]);
  const put = await fetch(`${base}/api/films/${enc(filmId)}/asset?path=${enc('assets/bed.wav')}`, {
    method: 'PUT', body: await fsp.readFile(wavPath),
  });
  assert.equal(put.status, 201);

  const patched = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { audio: [{ src: 'assets/bed.wav', gainDb: -6 }] } },
  });
  assert.equal(patched.status, 200);

  const build = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: { outputFilename: 'e2e', audioTargetPeakDb: -2 } });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  assert.ok(done.audio, 'master timeline reports measured levels');

  // The film folder's out/ holds the build + sidecar.
  const { data: film } = await j(`/api/films/${enc(filmId)}`);
  const outDir = path.join(film.film.path, 'out');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.mp4')), 'film written');
  assert.ok(fs.existsSync(path.join(outDir, 'e2e.srt')), 'caption sidecar written');
  const srt = await fsp.readFile(path.join(outDir, 'e2e.srt'), 'utf8');
  assert.match(srt, /Hello film/);

  // And downloads through the film output route.
  const dl = await fetch(`${base}/api/films/${enc(filmId)}/output?file=e2e.mp4`);
  assert.equal(dl.status, 200);
});

test('films API: overlay triggers the finishing pass', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');

  const pngPath = path.join(home, 'logo.png');
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', pngPath]);
  const put = await fetch(`${base}/api/films/${enc(filmId)}/asset?path=${enc('assets/logo.png')}`, {
    method: 'PUT', body: await fsp.readFile(pngPath),
  });
  assert.equal(put.status, 201);

  await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { overlays: [{ src: 'assets/logo.png', fromFrame: 0, toFrame: 16, xPct: 5, yPct: 5, widthPct: 20, opacity: 0.8 }] } },
  });
  const build = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: { outputFilename: 'e2e-overlay' } });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const done = await waitJob(build.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));

  const { data: film } = await j(`/api/films/${enc(filmId)}`);
  const outPath = path.join(film.film.path, 'out', 'e2e-overlay.mp4');
  assert.ok(fs.existsSync(outPath));
  assert.ok((await fsp.stat(outPath)).size > 0);
});

test('films API: preview-audio streams the master mix', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await fetch(`${base}/api/films/${enc(filmId)}/preview-audio`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 44, 'more than a WAV header');
});

test('film asset streaming honours Range requests (video scrubbing)', async () => {
  const res = await fetch(`${base}/api/films/${enc(filmId)}/asset?path=${enc('assets/bed.wav')}`, {
    headers: { Range: 'bytes=0-3' },
  });
  if (res.status === 404) return; // wav upload skipped without ffmpeg
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '4');
  assert.match(res.headers.get('content-range'), /^bytes 0-3\/\d+$/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('ascii'), 'RIFF');
});

test('studio TTS endpoint rejects empty text up front (film target)', async () => {
  const res = await j(`/api/films/${enc(filmId)}/tts`, { method: 'POST', body: { text: '  ' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'invalid_config');
});

test('workspace library: upload → list → use in a scene via the store', async () => {
  const put = await fetch(`${base}/api/workspaces/${TEST_WS}/library/file?path=${enc('plates/bg.png')}`, {
    method: 'PUT', body: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  assert.equal(put.status, 201);
  const list = await j(`/api/workspaces/${TEST_WS}/library`);
  assert.deepEqual(list.data.files.map((f) => f.path), ['plates/bg.png']);

  const get = await fetch(`${base}/api/workspaces/${TEST_WS}/library/file?path=${enc('plates/bg.png')}`);
  assert.equal(get.status, 200);

  const del = await j(`/api/workspaces/${TEST_WS}/library/file?path=${enc('plates/bg.png')}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await j(`/api/workspaces/${TEST_WS}/library`)).data.files.length, 0);
});

test('films API: delete without deleteFiles keeps the folder (listed as broken)', async () => {
  const res = await j(`/api/films/${enc(filmId)}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const tree = await j('/api/workspaces');
  const ws = tree.data.workspaces.find((w) => w.id === TEST_WS);
  const entry = ws.films.find((f) => f.id === filmId);
  assert.ok(entry?.broken, 'film folder still present, flagged broken');
  // Scene folders inside survive.
  assert.equal((await j(`/api/scenes/${enc(sceneA.id)}`)).status, 200, 'scene folder survives');
});
