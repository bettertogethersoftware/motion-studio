/**
 * The film page over HTTP (v0.23.1): the human half of the production loop —
 * the one-call overview snapshot, advice submission with async evidence
 * (including footage clips), revision history + "Ask AI to use this version",
 * delivery pinning and frame resolution, production events over SSE.
 *
 * There is exactly one film surface, so the static shell test asserts BOTH
 * halves: film.html is served, and the retired review page is not.
 *
 * Renders use the fake browser; builds use real ffmpeg (gated). The flow is
 * the acceptance scenario from the plan: produce → watch → advise →
 * (agent acts elsewhere) → history shows before/words/after.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createStudioServer } from '../src/studio/server.js';
import { JobManager } from '../src/core/jobs.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';
import { listAdvice, resolveAdvice } from '../src/core/advice.js';

const execFileP = promisify(execFile);
let haveFfmpeg = false;
try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated */ }

const enc = encodeURIComponent;
let server, base, store;

before(async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-review-'));
  store = await makeStore(home);
  server = createStudioServer({
    store,
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
  if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.json();
  return { status: res.status, data, res };
};

const waitJob = async (jobId) => {
  for (let i = 0; i < 600; i++) {
    const { data } = await j(`/api/jobs/${jobId}`);
    if (['done', 'error', 'cancelled'].includes(data.state)) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job never finished');
};

let filmId, sceneId;

test('film page: the static shell serves ONE film surface', async () => {
  for (const file of ['/film.html', '/film.js', '/film.css']) {
    assert.equal((await fetch(base + file)).status, 200, `${file} is served`);
  }
  // The separate review page is gone: watching and advising happen on the film
  // page itself. A stale bookmark must 404 rather than half-work.
  for (const file of ['/review.html', '/review.js', '/review.css']) {
    assert.equal((await fetch(base + file)).status, 404, `${file} is retired`);
  }
});

test('film page: film with no delivery reports advisable-but-unbuilt state', async () => {
  const film = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST',
    body: { name: 'Review Film', fps: 30, width: 320, height: 240, durationInFrames: 8 },
  });
  assert.equal(film.status, 201, JSON.stringify(film.data));
  filmId = film.data.film.id;

  const scene = await j(`/api/films/${enc(filmId)}/scenes`, {
    method: 'POST', body: { name: 'Hero Shot', durationInFrames: 8 },
  });
  assert.equal(scene.status, 201);
  sceneId = scene.data.id;

  const overview = await j(`/api/films/${enc(filmId)}/overview`);
  assert.equal(overview.status, 200);
  assert.equal(overview.data.currentDeliveryId, null);
  assert.equal(overview.data.deliveries.length, 0);
  assert.equal(overview.data.status.readiness.total, 1);
  assert.equal(overview.data.status.readiness.rendered, 0);

  // Resolving a frame with no delivery is a clear structured error.
  const resolve = await j(`/api/films/${enc(filmId)}/resolve?frame=3`);
  assert.equal(resolve.status, 404);
  assert.equal(resolve.data.code, 'delivery_not_found');
});

test('film page: advice submission returns a durable receipt and captures evidence async', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  // Render the scene so scene-preview evidence has bytes to grab.
  const render = await j(`/api/scenes/${enc(sceneId)}/render`, { method: 'POST', body: {} });
  assert.equal(render.status, 202);
  const job = await waitJob(render.data.jobId);
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.ok(job.revisionId, 'studio-side renders archive revisions too');

  const created = await j(`/api/films/${enc(filmId)}/advice`, {
    method: 'POST',
    body: {
      message: 'The hero shot feels rushed at the end.',
      target: { type: 'scene', scene: 'hero-shot', sceneFrame: 6 },
      observation: { source: 'scene-preview', sceneFrame: 6 },
      requestId: 'ui-test-1',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(created.data.id.startsWith('adv-'));

  // Idempotent retry (a resubmitted form) returns the same advice.
  const retry = await j(`/api/films/${enc(filmId)}/advice`, {
    method: 'POST',
    body: { message: 'The hero shot feels rushed at the end.', requestId: 'ui-test-1' },
  });
  assert.equal(retry.data.id, created.data.id);
  assert.equal(retry.data.deduplicated, true);

  // Evidence lands asynchronously; poll the detail briefly.
  let detail;
  for (let i = 0; i < 100; i++) {
    detail = (await j(`/api/films/${enc(filmId)}/advice/${created.data.id}`)).data;
    if (detail.evidence.before) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(detail.evidence.before, 'before evidence captured');
  assert.equal(detail.evidence.before.image, true);
  const png = await fetch(`${base}/api/films/${enc(filmId)}/advice/${created.data.id}/evidence/before`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');

  const listed = await j(`/api/films/${enc(filmId)}/advice?status=unresolved`);
  assert.equal(listed.data.advice.length, 1);
  assert.equal(listed.data.summary.unresolved, 1);
});

test('film page: revision history + Ask AI to use this version creates advice, never repoints', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  // A second take.
  const render = await j(`/api/scenes/${enc(sceneId)}/render`, { method: 'POST', body: {} });
  const job = await waitJob(render.data.jobId);
  assert.equal(job.state, 'done');

  const history = await j(`/api/scenes/${enc(sceneId)}/revisions`);
  assert.equal(history.status, 200);
  assert.equal(history.data.revisions.length, 2);
  const current = history.data.currentRevisionId;
  const older = history.data.revisions.find((r) => !r.current);
  assert.ok(older);

  // The archived video and the current one are both previewable.
  const file = await fetch(`${base}/api/scenes/${enc(sceneId)}/revisions/${older.id}/file`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(file.status, 206);

  const prefer = await j(`/api/scenes/${enc(sceneId)}/revisions/${older.id}/prefer`, {
    method: 'POST', body: { message: 'The first take had better pacing.' },
  });
  assert.equal(prefer.status, 201, JSON.stringify(prefer.data));

  // The pointer did NOT move — Studio only advises.
  const after = await j(`/api/scenes/${enc(sceneId)}/revisions`);
  assert.equal(after.data.currentRevisionId, current);

  // The advice records the preference precisely.
  const filmPath = store.filmPath(filmId);
  const items = await listAdvice({ filmPath, status: 'unresolved', target: { scene: 'hero-shot' } });
  const preferAdvice = items.find((a) => a.suggestedAction === 'prefer-revision');
  assert.ok(preferAdvice);
  assert.equal(preferAdvice.preferredRevisionId, older.id);
  assert.equal(preferAdvice.observation.revisionId, older.id);
  assert.equal(preferAdvice.observation.currentRevisionId, current);

  // Unknown revision → 404, and no advice is created.
  const bad = await j(`/api/scenes/${enc(sceneId)}/revisions/rev-nope/prefer`, { method: 'POST', body: {} });
  assert.equal(bad.status, 404);
});

test('film page: build archives a delivery; resolve pins to its manifest', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  // Label the sequence so resolution can name it.
  await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: { patch: { scenes: [{ slug: 'hero-shot', sequence: 'Opening' }], sequences: { Opening: { intent: 'Hook' } } } },
  });
  const build = await j(`/api/films/${enc(filmId)}/build`, { method: 'POST', body: {} });
  assert.equal(build.status, 202, JSON.stringify(build.data));
  const job = await waitJob(build.data.jobId);
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.ok(job.deliveryId);

  const deliveries = await j(`/api/films/${enc(filmId)}/deliveries`);
  assert.equal(deliveries.data.currentDeliveryId, job.deliveryId);

  const manifest = await j(`/api/films/${enc(filmId)}/deliveries/${job.deliveryId}`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.data.segments[0].sequence, 'Opening');
  assert.ok(manifest.data.segments[0].revisionId);

  // Frame resolution uses the pinned manifest.
  const hit = await j(`/api/films/${enc(filmId)}/resolve?frame=5&delivery=${job.deliveryId}`);
  assert.equal(hit.status, 200);
  assert.equal(hit.data.segment.slug, 'hero-shot');
  assert.equal(hit.data.segmentFrame, 5);
  assert.equal(hit.data.sequence, 'Opening');

  // The pinned video plays with range support.
  const video = await fetch(`${base}/api/films/${enc(filmId)}/deliveries/${job.deliveryId}/file`, {
    headers: { Range: 'bytes=0-1023' },
  });
  assert.equal(video.status, 206);

  // Review snapshot now reflects the delivery + unresolved advice count.
  const overview = await j(`/api/films/${enc(filmId)}/overview`);
  assert.equal(overview.data.currentDeliveryId, job.deliveryId);
  assert.ok(overview.data.status.advice.unresolved >= 1);
});

test('film page: past advice shows before/words/after once an agent resolves', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const filmPath = store.filmPath(filmId);
  const [first] = await listAdvice({ filmPath, status: 'unresolved' });
  assert.ok(first);
  // The "agent" (another process in real life) resolves through the core API.
  await resolveAdvice({
    filmPath, adviceId: first.id, agent: 'director-1',
    outcome: 'applied', explanation: 'Slowed the ending by 6 frames.', revisionIds: ['rev-x'],
  });
  const detail = await j(`/api/films/${enc(filmId)}/advice/${first.id}`);
  assert.equal(detail.data.state.status, 'resolved');
  assert.equal(detail.data.resolution.explanation, 'Slowed the ending by 6 frames.');
  assert.ok(detail.data.events.some((e) => e.type === 'resolved'));

  const resolvedList = await j(`/api/films/${enc(filmId)}/advice?status=resolved`);
  assert.ok(resolvedList.data.advice.some((a) => a.id === first.id));
});

test('film page: SSE stream emits production events with replayable ids', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const collected = (async () => {
    for (let i = 0; i < 50; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (/event: advice/.test(buffer)) return true;
    }
    return false;
  })();

  // Trigger an in-process emission through the advice route.
  await j(`/api/films/${enc(filmId)}/advice`, {
    method: 'POST', body: { message: 'sse smoke test' },
  });
  const sawAdvice = await Promise.race([
    collected,
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  controller.abort();
  assert.equal(sawAdvice, true, `no advice event seen in: ${buffer.slice(0, 500)}`);
  assert.match(buffer, /id: \d+/);
});

test('film page: evidence path traversal and unknown ids are refused', async () => {
  const bad = await j(`/api/films/${enc(filmId)}/advice/..%5C..%5Cfilm/evidence/before`);
  assert.equal(bad.status, 404);
  const unknown = await j(`/api/films/${enc(filmId)}/deliveries/del-nope`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 'delivery_not_found');
});

test('film page: a footage clip is an advisable target with a stable id', async () => {
  const patched = await j(`/api/films/${enc(filmId)}`, {
    method: 'PATCH',
    body: {
      patch: {
        scenes: [
          { slug: 'hero-shot', sequence: 'Opening' },
          { footage: 'assets/outro.mp4', durationInFrames: 12, label: 'Outro clip', sequence: 'Close' },
        ],
      },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  const clip = patched.data.film.scenes[1];
  assert.ok(clip.id, 'the server stamps footage segments with a stable id');
  // The plan surfaces both the id and the band, which is what the tree draws.
  const planned = patched.data.detail.scenes[1];
  assert.equal(planned.id, clip.id);
  assert.deepEqual(patched.data.detail.sequences.map((b) => b.sequence), ['Opening', 'Close']);

  const created = await j(`/api/films/${enc(filmId)}/advice`, {
    method: 'POST',
    body: {
      message: 'The outro clip holds too long after the logo lands.',
      target: { type: 'footage', itemId: clip.id, label: 'Outro clip', filmFrame: 10 },
      observation: { source: 'scene-preview', filmFrame: 10 },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const listed = await j(`/api/films/${enc(filmId)}/advice?itemId=${enc(clip.id)}`);
  assert.equal(listed.data.advice.length, 1);
  assert.equal(listed.data.advice[0].target.type, 'footage');

  // Without an id the request is refused, rather than quietly re-aimed at the
  // whole film — a clip the human clicked must resolve to that clip.
  const noId = await j(`/api/films/${enc(filmId)}/advice`, {
    method: 'POST', body: { message: 'which clip?', target: { type: 'footage' } },
  });
  assert.equal(noId.status, 400);
  assert.equal(noId.data.code, 'invalid_advice');
});

/**
 * `+ image` (v0.28): the toolbar button's endpoint. It is the same engine call
 * the MCP `create_scene_from_image` makes, so a still the human drops in and
 * one the AI places are one operation — and, crucially, the play order gains
 * an ordinary scene rather than a third kind of segment.
 */
test('film page: + image scaffolds a scene from a library still', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const film = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST', body: { name: 'Stills Film', fps: 30, width: 320, height: 180, durationInFrames: 30 },
  });
  assert.equal(film.status, 201, JSON.stringify(film.data));
  const stillsFilm = film.data.film.id;

  // A PORTRAIT plate in the workspace library — the case a guessed fit would
  // stretch. The library is a human's folder, so the file is put there on disk.
  const libDir = path.join(store.libraryPath(TEST_WS), 'plates');
  await fsp.mkdir(libDir, { recursive: true });
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320',
    '-frames:v', '1', path.join(libDir, 'tall.png')]);

  const made = await j(`/api/films/${enc(stillsFilm)}/scenes/from-image`, {
    method: 'POST', body: { image: 'plates/tall.png', durationInFrames: 45 },
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.config.width, 320, 'the film\'s geometry');
  assert.equal(made.data.config.durationInFrames, 45);
  assert.equal(made.data.fit.mode, 'contain', 'measured, so it letterboxes instead of stretching');
  assert.equal(made.data.image.source, 'library');

  // One ordinary {slug} segment, and the film still plans as a film.
  const read = await j(`/api/films/${enc(stillsFilm)}`);
  assert.equal(read.data.film.scenes.length, 1);
  assert.deepEqual(Object.keys(read.data.film.scenes[0]), ['slug']);
  assert.equal(read.data.detail.scenes[0].kind, 'scene');
  assert.deepEqual(
    read.data.detail.problems.filter((p) => p.code !== 'scene_not_rendered'),
    [],
    JSON.stringify(read.data.detail.problems),
  );

  // A path that is not there fails as a structured 404, not a half-made scene.
  const missing = await j(`/api/films/${enc(stillsFilm)}/scenes/from-image`, {
    method: 'POST', body: { image: 'plates/nope.png' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'file_not_found');
  assert.equal((await j(`/api/films/${enc(stillsFilm)}`)).data.film.scenes.length, 1);
});

/**
 * Trimming footage from the timeline (v0.28): the handle's two endpoints. The
 * grid is what the handle snaps to, and the trim is the same engine call the
 * MCP `trim_footage` makes — so a cut the human drags and one the AI asks for
 * are one operation.
 */
test('film page: footage trim reports its keyframe grid and re-cuts the segment', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const made = await j(`/api/workspaces/${TEST_WS}/films`, {
    method: 'POST', body: { name: 'Trim Film', fps: 30, width: 320, height: 240, durationInFrames: 30 },
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const trimFilm = made.data.film.id;

  // A clip with the engine's own 10-frame GOP — the grid a prepared clip has.
  const clip = path.join(os.tmpdir(), `ms-trim-route-${Date.now()}.mp4`);
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=30:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-frames:v', '180', clip]);
  const put = await fetch(`${base}/api/films/${enc(trimFilm)}/asset?path=${enc('assets/clip.mp4')}`,
    { method: 'PUT', body: await fsp.readFile(clip) });
  assert.ok(put.ok, `asset upload failed: ${put.status}`);
  await fsp.rm(clip, { force: true });

  const patched = await j(`/api/films/${enc(trimFilm)}`, {
    method: 'PATCH',
    body: { patch: { scenes: [{ footage: 'assets/clip.mp4', durationInFrames: 180, label: 'Clip' }] } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  const segId = patched.data.film.scenes[0].id;

  // The grid the handle snaps to.
  const grid = await j(`/api/films/${enc(trimFilm)}/footage/${enc(segId)}/keyframes`);
  assert.equal(grid.status, 200, JSON.stringify(grid.data));
  assert.equal(grid.data.frames[0], 0, 'frame 0 is always a keyframe');
  assert.ok(grid.data.count > 10, `expected a fine grid, got ${grid.data.count}`);
  assert.equal(grid.data.coarse, false);

  // A dry run changes nothing.
  const dry = await j(`/api/films/${enc(trimFilm)}/footage/${enc(segId)}/trim`, {
    method: 'POST', body: { startInFrames: 30, durationInFrames: 60, dryRun: true },
  });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.method, 'copy');
  assert.equal((await j(`/api/films/${enc(trimFilm)}`)).data.film.scenes[0].durationInFrames, 180);

  // The commit: a keyframe-aligned head trim is a copy.
  const cut = await j(`/api/films/${enc(trimFilm)}/footage/${enc(segId)}/trim`, {
    method: 'POST', body: { startInFrames: 30, durationInFrames: 60, snapToKeyframe: true },
  });
  assert.equal(cut.status, 201, JSON.stringify(cut.data));
  assert.equal(cut.data.method, 'copy');
  assert.equal(cut.data.startFrame, 30);
  assert.equal(cut.data.framesVerified, true);

  // The segment moved; the film still plans; the original is still there.
  const read = await j(`/api/films/${enc(trimFilm)}`);
  assert.equal(read.data.film.scenes[0].footage, cut.data.file);
  assert.equal(read.data.film.scenes[0].durationInFrames, 60);
  assert.equal(read.data.film.scenes[0].id, segId, 'the segment keeps its identity');
  assert.equal(read.data.detail.scenes[0].framesVerified, true);
  assert.deepEqual(read.data.detail.problems, [], JSON.stringify(read.data.detail.problems));
  const assets = await j(`/api/films/${enc(trimFilm)}/assets`);
  assert.ok(assets.data.files.some((f) => f.path === 'assets/clip.mp4'), 'the original is kept, so this is reversible');

  // An unknown segment is a clean 404, not a half-applied edit.
  const nope = await j(`/api/films/${enc(trimFilm)}/footage/${enc('seg-nope')}/keyframes`);
  assert.equal(nope.status, 404);
});
