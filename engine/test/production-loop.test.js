/**
 * The production loop over MCP (v0.23): capabilities → advice reconciliation
 * → revisions → deliveries → status, driven by a real MCP client over stdio.
 *
 * The cross-process story is exercised for real: advice is written by THIS
 * process (standing in for the Studio server) through the core API, against
 * the same data dir the MCP child serves — exactly how a human's advice
 * reaches an agent that was not running when they left it.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { WorkspaceStore } from '../src/core/store.js';
import { createAdvice, getAdvice, listAdvice } from '../src/core/advice.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/mcp/server.js');
const FAKE_BROWSER = path.resolve(__dirname, 'helpers/fake-browser-module.js');

// Top-level await, not before(): test() skip options evaluate at module load.
let haveFfmpeg = false;
try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* gated below */ }

let tmp, home, client, transport, store;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-loop-'));
  home = path.join(tmp, 'home');
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: home,
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_WORKSPACE: 'loop',
      MOTION_STUDIO_AGENT: 'director-1',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'ms-loop-test', version: '0.0.1' });
  await client.connect(transport);
  // The Studio-side view of the same tree.
  store = new WorkspaceStore(home);
});

after(async () => {
  await client?.close().catch(() => {});
});

const callJson = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { isError: !!res.isError, data: JSON.parse(text) };
};

const filmPathOf = (slug) => store.filmPath(`loop/${slug}`);

test('loop: get_capabilities states the model, identity, and protocol', async () => {
  const caps = await callJson('get_capabilities');
  assert.equal(caps.isError, false, JSON.stringify(caps.data));
  assert.equal(caps.data.workspace, 'loop');
  assert.equal(caps.data.agent, 'director-1');
  assert.match(caps.data.model.atomicRenderUnit, /scene/);
  assert.match(caps.data.model.narrativeGrouping, /sequence/);
  assert.equal(caps.data.productionLoop.approvalGate.startsWith('none'), true);
  assert.ok(caps.data.productionLoop.checkpoints.includes('before build_film'));
  // Fetchable packs (Slice B): every manifest pack with its install state,
  // and the command that fetches one.
  assert.match(caps.data.packs.fetchCommand, /fetch-pack/);
  const packIds = caps.data.packs.packs.map((p) => p.id);
  assert.ok(packIds.includes('soundfont'), JSON.stringify(packIds));
  for (const p of caps.data.packs.packs) assert.equal(typeof p.installed, 'boolean');
});

test('loop: advice left while no agent ran is found, leased, and resolved over MCP', async () => {
  const film = await callJson('create_film', { name: 'Advice Film', fps: 30, width: 320, height: 240, durationInFrames: 12 });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  const slug = film.data.film;
  await callJson('create_scene', { film: slug, name: 'Shot One', durationInFrames: 12 });

  // No advice yet: the agent is told to continue immediately.
  const empty = await callJson('check_human_advice', { film: slug });
  assert.equal(empty.data.unresolved, 0);
  assert.match(empty.data.note, /continue immediately/);

  // The "human" (Studio process) leaves advice on the scene while the agent
  // is elsewhere. Same disk, different process — the durable channel.
  const filmDoc = await store.getFilm(`loop/${slug}`);
  const created = await createAdvice({
    filmPath: filmDoc.path, filmId: filmDoc.id,
    message: 'The title lingers too long — tighten it.',
    target: { type: 'scene', scene: 'shot-one', sceneFrame: 6 },
    observation: { source: 'scene-preview' },
  });

  const found = await callJson('check_human_advice', {});
  assert.equal(found.data.unresolved, 1);
  const item = found.data.advice[0];
  assert.equal(item.adviceId, created.id);
  assert.equal(item.film, slug);
  assert.equal(item.target.scene, 'shot-one');
  assert.equal(item.status, 'open');

  const ack = await callJson('acknowledge_human_advice', { film: slug, adviceId: created.id });
  assert.equal(ack.data.status, 'acknowledged');

  const lease = await callJson('begin_advice_work', { film: slug, adviceId: created.id, ttlSeconds: 120 });
  assert.equal(lease.data.status, 'working');
  assert.equal(lease.data.lease.agent, 'director-1');

  const resolved = await callJson('resolve_human_advice', {
    film: slug, adviceId: created.id, outcome: 'applied',
    explanation: 'Shortened the title hold by 12 frames.',
  });
  assert.equal(resolved.data.status, 'resolved');

  // The human's history view reads the same record back.
  const history = await getAdvice({ filmPath: filmDoc.path, adviceId: created.id });
  assert.equal(history.resolution.outcome, 'applied');
  assert.equal(history.resolution.agent, 'director-1');
  assert.deepEqual(
    history.events.map((e) => e.type).slice(0, 4),
    ['created', 'acknowledged', 'work-started', 'resolved'],
  );

  // Idempotent double-resolution is refused with a stable code.
  const again = await callJson('resolve_human_advice', {
    film: slug, adviceId: created.id, outcome: 'not-applied', explanation: 'changed my mind',
  });
  assert.equal(again.isError, true);
  assert.equal(again.data.code, 'advice_already_resolved');
});

test('loop: needs-clarification keeps the item open and asks a visible question', async () => {
  const film = await callJson('create_film', { name: 'Clarify Film' });
  const slug = film.data.film;
  const filmDoc = await store.getFilm(`loop/${slug}`);
  const created = await createAdvice({ filmPath: filmDoc.path, filmId: filmDoc.id, message: 'Make it pop' });

  const q = await callJson('resolve_human_advice', {
    film: slug, adviceId: created.id, outcome: 'needs-clarification',
    explanation: 'Pop how — color, speed, or scale?',
  });
  assert.equal(q.data.status, 'needs-clarification');
  const unresolved = await callJson('check_human_advice', { film: slug });
  assert.equal(unresolved.data.unresolved, 1);
  assert.match(unresolved.data.advice[0].clarification.question, /Pop how/);
});

test('loop: nullable numeric arguments accept the string forms flattening clients send', async () => {
  // Measured in production: a client that flattens the published anyOf schema
  // delivered audioTargetPeakDb as the STRING "-2" and the call failed input
  // validation. The runtime coercion accepts numeric strings and "null".
  const film = await callJson('create_film', { name: 'Coerce Film' });
  const slug = film.data.film;
  const asString = await callJson('update_film', { film: slug, audioTargetPeakDb: '-2' });
  assert.equal(asString.isError, false, JSON.stringify(asString.data));
  const asNullString = await callJson('update_film', { film: slug, audioTargetPeakDb: 'null' });
  assert.equal(asNullString.isError, false, JSON.stringify(asNullString.data));
  // Real types keep working, and garbage still fails. The SDK reports an
  // input-validation rejection as an isError result whose text is the raw
  // "MCP error -32602 …" message (not JSON), so assert on the raw call.
  const asNumber = await callJson('update_film', { film: slug, audioTargetPeakDb: -3 });
  assert.equal(asNumber.isError, false);
  const garbage = await client.callTool({ name: 'update_film', arguments: { film: slug, audioTargetPeakDb: 'loud' } });
  assert.equal(garbage.isError, true);
  assert.match(garbage.content?.[0]?.text ?? '', /audioTargetPeakDb/);
});

test('loop: activity heartbeat and production status', async () => {
  const film = await callJson('create_film', { name: 'Status Film', fps: 30, width: 320, height: 240, durationInFrames: 12 });
  const slug = film.data.film;
  await callJson('create_scene', { film: slug, name: 'Only Shot', durationInFrames: 12 });

  const beat = await callJson('report_agent_activity', {
    activity: 'Creating scene only-shot', film: slug, scene: `${slug}/only-shot`,
  });
  assert.equal(beat.isError, false, JSON.stringify(beat.data));
  assert.equal(beat.data.agent, 'director-1');

  const status = await callJson('get_production_status', { film: slug });
  assert.equal(status.isError, false, JSON.stringify(status.data));
  assert.equal(status.data.film, slug);
  assert.equal(status.data.readiness.total, 1);
  assert.equal(status.data.readiness.rendered, 0);
  assert.equal(status.data.currentDelivery, null);
  assert.equal(status.data.activity[0].activity, 'Creating scene only-shot');
  assert.equal(status.data.activity[0].stale, false);
});

test('loop: render → revision history → rework → use_scene_revision → build → delivery', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const film = await callJson('create_film', { name: 'Rev Film', fps: 30, width: 320, height: 240, durationInFrames: 8 });
  const slug = film.data.film;
  await callJson('create_scene', { film: slug, name: 'Hero Shot', durationInFrames: 8 });
  const sceneId = `${slug}/hero-shot`;

  const run = async (note, adviceIds) => {
    const started = await callJson('render', { scene: sceneId, note, ...(adviceIds ? { adviceIds } : {}) });
    assert.equal(started.isError, false, JSON.stringify(started.data));
    const done = await callJson('wait_for_render', { jobIds: [started.data.jobId], timeoutMs: 50_000 });
    const job = done.data.jobs[0];
    assert.equal(job.state, 'done', JSON.stringify(job));
    return job;
  };

  const first = await run('first take');
  assert.ok(first.revisionId, 'a promoted canonical render reports its archived revisionId');

  const second = await run('brighter background');
  assert.ok(second.revisionId && second.revisionId !== first.revisionId);

  const listed = await callJson('list_scene_revisions', { scene: sceneId });
  assert.equal(listed.data.count, 2);
  assert.equal(listed.data.currentRevisionId, second.revisionId);
  assert.equal(listed.data.revisions[0].note, 'brighter background');

  // The human prefers take one → the director repoints, never regenerates.
  const use = await callJson('use_scene_revision', { scene: sceneId, revisionId: first.revisionId });
  assert.equal(use.isError, false, JSON.stringify(use.data));
  assert.equal(use.data.restored, true);
  const after = await callJson('list_scene_revisions', { scene: sceneId });
  assert.equal(after.data.currentRevisionId, first.revisionId);
  assert.equal(after.data.count, 2, 'newer history survives');

  // Sequence labels + build → archived delivery whose manifest froze take one.
  await callJson('update_film', {
    film: slug,
    scenes: [{ slug: 'hero-shot', sequence: 'Opening' }],
    sequences: { Opening: { intent: 'Establish the product' } },
  });
  const build = await callJson('build_film', { film: slug });
  assert.equal(build.isError, false, JSON.stringify(build.data));
  const done = await callJson('wait_for_render', { jobIds: [build.data.jobId], timeoutMs: 50_000 });
  const job = done.data.jobs[0];
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.ok(job.deliveryId, 'a promoted build reports its archived deliveryId');

  const deliveries = await callJson('list_deliveries', { film: slug });
  assert.equal(deliveries.data.currentDeliveryId, job.deliveryId);
  assert.equal(deliveries.data.deliveries.length, 1);

  const manifest = await callJson('list_deliveries', { film: slug, manifest: job.deliveryId });
  assert.equal(manifest.data.segments[0].revisionId, first.revisionId);
  assert.equal(manifest.data.segments[0].sequence, 'Opening');
  assert.equal(manifest.data.agent, 'director-1');

  // Status now reports the delivery as current with nothing newer.
  const status = await callJson('get_production_status', { film: slug });
  assert.equal(status.data.currentDelivery.id, job.deliveryId);
  assert.equal(status.data.newerWorkThanDelivery, false);

  // A fresh render after the build IS newer work awaiting a rebuild.
  await run('post-delivery tweak');
  const status2 = await callJson('get_production_status', { film: slug });
  assert.equal(status2.data.newerWorkThanDelivery, true);
});

test('loop: prefer-revision advice round-trip with after-evidence', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const film = await callJson('create_film', { name: 'Prefer Film', fps: 30, width: 320, height: 240, durationInFrames: 8 });
  const slug = film.data.film;
  await callJson('create_scene', { film: slug, name: 'Pick Shot', durationInFrames: 8 });
  const sceneId = `${slug}/pick-shot`;

  const render = async () => {
    const started = await callJson('render', { scene: sceneId });
    const done = await callJson('wait_for_render', { jobIds: [started.data.jobId], timeoutMs: 50_000 });
    return done.data.jobs[0].revisionId;
  };
  const rev1 = await render();
  const rev2 = await render();
  assert.ok(rev1 && rev2);

  // Studio-side: the human previews rev1 and asks the AI to use it.
  const filmDoc = await store.getFilm(`loop/${slug}`);
  const advice = await createAdvice({
    filmPath: filmDoc.path, filmId: filmDoc.id,
    message: 'The first take reads better.',
    target: { type: 'scene', scene: 'pick-shot', sceneFrame: 4 },
    suggestedAction: 'prefer-revision',
    preferredRevisionId: rev1,
    observation: { source: 'revision-preview', revisionId: rev1 },
  });

  const found = await callJson('check_human_advice', { film: slug });
  const item = found.data.advice.find((a) => a.adviceId === advice.id);
  assert.equal(item.suggestedAction, 'prefer-revision');
  assert.equal(item.preferredRevisionId, rev1);

  await callJson('use_scene_revision', { scene: sceneId, revisionId: rev1 });
  const resolved = await callJson('resolve_human_advice', {
    film: slug, adviceId: advice.id, outcome: 'applied',
    explanation: 'Switched back to the first take.', revisionIds: [rev1],
  });
  assert.equal(resolved.data.status, 'resolved');

  // After-evidence was captured from the restored output (best-effort but
  // expected to succeed here: ffmpeg is present and the scene is rendered).
  const full = await getAdvice({ filmPath: filmDoc.path, adviceId: advice.id });
  assert.ok(full.evidence.after, 'after evidence recorded');
  assert.equal(full.evidence.after.revisionId, rev1);

  // History confirms both takes still exist — nothing was deleted.
  const revs = await callJson('list_scene_revisions', { scene: sceneId });
  assert.equal(revs.data.count, 2);
  const unresolvedLeft = await listAdvice({ filmPath: filmDoc.path, status: 'unresolved' });
  assert.equal(unresolvedLeft.length, 0);
});
