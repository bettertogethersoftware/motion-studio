/**
 * Human advice (v0.23): durable requests, lifecycle events, leases,
 * resolutions, and evidence — the asynchronous human→AI channel.
 *
 * Everything here is plain filesystem state: no browser, no ffmpeg, and
 * "restart recovery" is literally re-reading the same folders, which several
 * tests do by calling the API twice with nothing shared but the disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeSceneIn } from './helpers/workspace.mjs';
import {
  createAdvice, getAdvice, listAdvice, adviceSummary,
  acknowledgeAdvice, beginAdviceWork, resolveAdvice,
  withdrawAdvice, withdrawAllAdvice,
  writeAdviceEvidence, recordEvidenceFailure, adviceEvidencePath,
  advicePinnedRevisionIds, leaseActive,
} from '../src/core/advice.js';

async function filmFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-advice-'));
  const { store, film, scene } = await makeSceneIn(dir, { durationInFrames: 10 });
  return { store, film, scene };
}

test('advice: create → durable request with observation and receipt', async () => {
  const { film } = await filmFixture();
  const receipt = await createAdvice({
    filmPath: film.path,
    filmId: film.id,
    message: 'The product changes shape halfway through. Keep it identical to the reference.',
    target: { type: 'scene', scene: 'scene-1', filmFrame: 1152, sceneFrame: 42 },
    observation: { source: 'delivery', deliveryId: 'd-123', revisionId: 'rev-6', filmFrame: 1152 },
  });
  assert.ok(receipt.id.startsWith('adv-'));
  assert.equal(receipt.status, 'open');

  const full = await getAdvice({ filmPath: film.path, adviceId: receipt.id });
  assert.equal(full.request.message.slice(0, 11), 'The product');
  assert.equal(full.request.target.scene, 'scene-1');
  assert.equal(full.request.observation.deliveryId, 'd-123');
  assert.equal(full.request.observation.revisionId, 'rev-6');
  assert.equal(full.state.status, 'open');
  assert.equal(full.events[0].type, 'created');
});

test('advice: structural nonsense is refused; the human message is required', async () => {
  const { film } = await filmFixture();
  const base = { filmPath: film.path, filmId: film.id };
  await assert.rejects(() => createAdvice({ ...base, message: '  ' }), (e) => e.code === 'invalid_advice');
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'blob' } }),
    (e) => e.code === 'invalid_advice',
  );
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'scene' } }),
    (e) => e.code === 'invalid_advice',
  );
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'audio' } }),
    (e) => e.code === 'invalid_advice',
  );
  // Footage is addressed by its stable segment id, never by its path: the same
  // plate can be cut in twice, and advice on the second must not hit the first.
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'footage' } }),
    (e) => e.code === 'invalid_advice',
  );
  // A lane is a row of the timeline: it needs to say which stack, and "row -1"
  // is not a row.
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'lane' } }),
    (e) => e.code === 'invalid_advice',
  );
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'lane', family: 'advice' } }),
    (e) => e.code === 'invalid_advice',
  );
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x', target: { type: 'lane', family: 'audio', lane: -1 } }),
    (e) => e.code === 'invalid_advice',
  );
  await assert.rejects(
    () => createAdvice({ ...base, message: 'x'.repeat(4001) }),
    (e) => e.code === 'invalid_advice',
  );
});

test('advice: a footage clip is a first-class target, addressed by segment id', async () => {
  const { film } = await filmFixture();
  const receipt = await createAdvice({
    filmPath: film.path,
    filmId: film.id,
    message: 'The outro clip holds too long after the logo lands.',
    target: { type: 'footage', itemId: 'seg-abc123', label: 'Outro clip', filmFrame: 900 },
  });
  const full = await getAdvice({ filmPath: film.path, adviceId: receipt.id });
  assert.equal(full.request.target.type, 'footage');
  assert.equal(full.request.target.itemId, 'seg-abc123');
  assert.equal(full.request.target.label, 'Outro clip');
  // Filtering by item id is what the film page uses to badge that one clip.
  const found = await listAdvice({ filmPath: film.path, target: { itemId: 'seg-abc123' } });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, receipt.id);
});

test('advice: a timeline lane is a target, and row 2 is not row 1', async () => {
  const { film } = await filmFixture();
  const base = { filmPath: film.path, filmId: film.id };
  const bed = await createAdvice({
    ...base,
    message: 'This music bed is fighting the narration all the way through.',
    target: { type: 'lane', family: 'audio', lane: 1, label: 'audio 2', filmFrame: 300 },
  });
  await createAdvice({
    ...base,
    message: 'Every caption lands a beat after the line it belongs to.',
    target: { type: 'lane', family: 'captions', lane: 0 },
  });
  // The single-row families do not have to say which row they mean.
  await createAdvice({ ...base, message: 'The cuts are too even.', target: { type: 'lane', family: 'scenes' } });

  const full = await getAdvice({ filmPath: film.path, adviceId: bed.id });
  assert.equal(full.request.target.type, 'lane');
  assert.equal(full.request.target.family, 'audio');
  assert.equal(full.request.target.lane, 1);
  assert.equal(full.request.target.label, 'audio 2');

  // A lane omitting its index is row 0, so the Studio's badge on the first row
  // and the AI's filter agree without either of them guessing.
  const scenes = await listAdvice({ filmPath: film.path, target: { family: 'scenes' } });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].target.lane, 0);

  // Family narrows to the stack; lane narrows to the row within it.
  assert.equal((await listAdvice({ filmPath: film.path, target: { type: 'lane' } })).length, 3);
  assert.equal((await listAdvice({ filmPath: film.path, target: { family: 'audio' } })).length, 1);
  assert.equal((await listAdvice({ filmPath: film.path, target: { family: 'audio', lane: 0 } })).length, 0);
  assert.equal((await listAdvice({ filmPath: film.path, target: { family: 'audio', lane: 1 } })).length, 1);
});

test('advice: the human can withdraw one, and it stops being served', async () => {
  const { film } = await filmFixture();
  const base = { filmPath: film.path, filmId: film.id };
  const keep = await createAdvice({ ...base, message: 'The chorus drags.' });
  const oops = await createAdvice({ ...base, message: 'wrong film, ignore' });

  assert.equal((await listAdvice({ filmPath: film.path, status: 'unresolved' })).length, 2);
  const r = await withdrawAdvice({ filmPath: film.path, adviceId: oops.id });
  assert.equal(r.status, 'resolved');

  // Gone from what the next AI run is offered…
  const open = await listAdvice({ filmPath: film.path, status: 'unresolved' });
  assert.deepEqual(open.map((a) => a.id), [keep.id]);

  // …but nothing the human wrote was destroyed. Withdrawing is a resolution,
  // not a delete: the record of "I asked and took it back" survives.
  const full = await getAdvice({ filmPath: film.path, adviceId: oops.id });
  assert.equal(full.request.message, 'wrong film, ignore');
  assert.equal(full.resolution.withdrawnByHuman, true);
  assert.equal(full.resolution.outcome, 'not-applied');
  assert.ok(full.events.some((e) => e.type === 'withdrawn'));

  // Idempotent — "clear all" may race an agent that just resolved something.
  const again = await withdrawAdvice({ filmPath: film.path, adviceId: oops.id });
  assert.equal(again.alreadyClosed, true);
});

test('advice: withdrawAll clears the board without touching resolved history', async () => {
  const { film } = await filmFixture();
  const base = { filmPath: film.path, filmId: film.id };
  const a = await createAdvice({ ...base, message: 'one' });
  await createAdvice({ ...base, message: 'two' });
  await createAdvice({ ...base, message: 'three' });
  // One already answered by an agent — its outcome must not be overwritten.
  await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'director-1',
    outcome: 'applied', explanation: 'Done.',
  });

  const result = await withdrawAllAdvice({ filmPath: film.path });
  assert.equal(result.count, 2, 'only the still-open ones');
  assert.equal((await listAdvice({ filmPath: film.path, status: 'unresolved' })).length, 0);

  const answered = await getAdvice({ filmPath: film.path, adviceId: a.id });
  assert.equal(answered.resolution.outcome, 'applied');
  assert.equal(answered.resolution.explanation, 'Done.');
  assert.equal(answered.resolution.withdrawnByHuman, undefined);
});

test('advice: full lifecycle — check, acknowledge, lease, resolve — with events', async () => {
  const { film } = await filmFixture();
  const a = await createAdvice({ filmPath: film.path, filmId: film.id, message: 'Slower titles please' });

  // Reconciliation view: unresolved, oldest first.
  const unresolved = await listAdvice({ filmPath: film.path, status: 'unresolved' });
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].status, 'open');

  const ack = await acknowledgeAdvice({ filmPath: film.path, adviceId: a.id, agent: 'claude' });
  assert.equal(ack.status, 'acknowledged');
  // Idempotent.
  const ack2 = await acknowledgeAdvice({ filmPath: film.path, adviceId: a.id, agent: 'claude' });
  assert.equal(ack2.alreadyAcknowledged, true);

  const lease = await beginAdviceWork({ filmPath: film.path, adviceId: a.id, agent: 'claude', ttlSeconds: 60 });
  assert.equal(lease.status, 'working');
  assert.ok(leaseActive(lease.lease));

  const res = await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'claude',
    outcome: 'applied', explanation: 'Re-timed the title cards to 3s each.',
    revisionIds: ['rev-9'], deliveryId: 'd-2',
  });
  assert.equal(res.status, 'resolved');
  assert.equal(res.resolution.outcome, 'applied');

  const full = await getAdvice({ filmPath: film.path, adviceId: a.id });
  assert.deepEqual(full.events.map((e) => e.type), ['created', 'acknowledged', 'work-started', 'resolved']);
  assert.equal(full.resolution.deliveryId, 'd-2');
  assert.equal((await listAdvice({ filmPath: film.path, status: 'unresolved' })).length, 0);
});

test('advice: a live lease blocks other agents; an expired one recovers', async () => {
  const { film } = await filmFixture();
  const a = await createAdvice({ filmPath: film.path, filmId: film.id, message: 'Fix the chart colors' });

  await beginAdviceWork({ filmPath: film.path, adviceId: a.id, agent: 'agent-one', ttlSeconds: 60 });
  await assert.rejects(
    () => beginAdviceWork({ filmPath: film.path, adviceId: a.id, agent: 'agent-two' }),
    (e) => {
      assert.equal(e.code, 'advice_lease_held');
      assert.equal(e.detail.holder, 'agent-one');
      return true;
    },
  );
  // The holder renews without conflict.
  const renewed = await beginAdviceWork({ filmPath: film.path, adviceId: a.id, agent: 'agent-one', ttlSeconds: 60 });
  assert.equal(renewed.renewed, true);

  // Simulate a crashed agent: rewrite the lease as expired (the disk is the
  // only shared state, so this IS what expiry looks like after a restart).
  const stateFile = path.join(film.path, 'advice', a.id, 'state.json');
  const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  state.lease.expiresAt = new Date(Date.now() - 1000).toISOString();
  await fsp.writeFile(stateFile, JSON.stringify(state));

  // The item is actionable again and another agent can take over.
  const listed = await listAdvice({ filmPath: film.path, status: 'unresolved' });
  assert.equal(listed[0].status, 'acknowledged', 'expired working lease reads as acknowledged');
  const takeover = await beginAdviceWork({ filmPath: film.path, adviceId: a.id, agent: 'agent-two' });
  assert.equal(takeover.lease.agent, 'agent-two');
});

test('advice: needs-clarification is not terminal; follow-up advice links to it', async () => {
  const { film } = await filmFixture();
  const a = await createAdvice({ filmPath: film.path, filmId: film.id, message: 'Make it pop more' });

  const q = await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'claude',
    outcome: 'needs-clarification', explanation: 'Pop how — brighter colors, faster motion, or bigger type?',
  });
  assert.equal(q.status, 'needs-clarification');

  // Still unresolved; the question is visible.
  const listed = await listAdvice({ filmPath: film.path, status: 'unresolved' });
  assert.equal(listed[0].status, 'needs-clarification');
  assert.match(listed[0].clarification.question, /Pop how/);

  // Human answers with linked follow-up advice; the original wording is untouched.
  const followUp = await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'Brighter colors.', followUpOf: a.id,
  });
  const fu = await getAdvice({ filmPath: film.path, adviceId: followUp.id });
  assert.equal(fu.request.followUpOf, a.id);

  // A dangling follow-up link is refused.
  await assert.rejects(
    () => createAdvice({ filmPath: film.path, filmId: film.id, message: 'x', followUpOf: 'adv-nope' }),
    (e) => e.code === 'advice_not_found',
  );

  // The thread can then be resolved normally.
  const res = await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'claude',
    outcome: 'applied', explanation: 'Brightened the palette.', combinedAdviceIds: [followUp.id],
  });
  assert.deepEqual(res.resolution.combinedAdviceIds, [followUp.id]);
});

test('advice: resolutions are immutable; idempotent retries return the original', async () => {
  const { film } = await filmFixture();
  const a = await createAdvice({ filmPath: film.path, filmId: film.id, message: 'Trim the intro' });
  await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'claude',
    outcome: 'applied', explanation: 'Cut 2 seconds.', requestId: 'req-1',
  });
  // Same requestId → the original resolution, no error.
  const retry = await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'claude',
    outcome: 'applied', explanation: 'Cut 2 seconds.', requestId: 'req-1',
  });
  assert.equal(retry.deduplicated, true);
  // A different attempt is refused.
  await assert.rejects(
    () => resolveAdvice({
      filmPath: film.path, adviceId: a.id, agent: 'claude',
      outcome: 'not-applied', explanation: 'changed my mind',
    }),
    (e) => e.code === 'advice_already_resolved',
  );
  // So is starting work on it.
  await assert.rejects(
    () => beginAdviceWork({ filmPath: film.path, adviceId: a.id, agent: 'claude' }),
    (e) => e.code === 'advice_already_resolved',
  );
});

test('advice: createAdvice requestId dedupes across retries', async () => {
  const { film } = await filmFixture();
  const first = await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'Louder narration', requestId: 'studio-abc',
  });
  const second = await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'Louder narration', requestId: 'studio-abc',
  });
  assert.equal(second.deduplicated, true);
  assert.equal(second.id, first.id);
  assert.equal((await listAdvice({ filmPath: film.path })).length, 1);
});

test('advice: evidence is best-effort and never rewrites the request', async () => {
  const { film } = await filmFixture();
  const a = await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'This frame is wrong',
    observation: { source: 'delivery', deliveryId: 'd-1', revisionId: 'rev-1', filmFrame: 100 },
  });
  const png = Buffer.from('89504e470d0a1a0a', 'hex'); // just bytes; nothing decodes it
  await writeAdviceEvidence({
    filmPath: film.path, adviceId: a.id, which: 'before',
    png, meta: { deliveryId: 'd-1', filmFrame: 100 },
  });
  const full = await getAdvice({ filmPath: film.path, adviceId: a.id });
  assert.equal(full.evidence.before.image, true);
  assert.equal(full.evidence.before.filmFrame, 100);
  assert.ok(adviceEvidencePath(film.path, a.id, 'before'));

  await recordEvidenceFailure({ filmPath: film.path, adviceId: a.id, which: 'after', reason: 'ffmpeg missing' });
  const again = await getAdvice({ filmPath: film.path, adviceId: a.id });
  assert.equal(again.evidence.after.image, false);
  assert.match(again.evidence.after.warning, /ffmpeg/);
  assert.throws(() => adviceEvidencePath(film.path, a.id, 'after'), (e) => e.code === 'file_not_found');

  // The request file is byte-identical to what was first written (immutable).
  assert.equal(full.request.message, 'This frame is wrong');
});

test('advice: summary counts and pinned revision ids', async () => {
  const { film } = await filmFixture();
  const a = await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'prefer the older take',
    suggestedAction: 'prefer-revision', preferredRevisionId: 'rev-old',
    observation: { source: 'revision-preview', revisionId: 'rev-old' },
  });
  await createAdvice({ filmPath: film.path, filmId: film.id, message: 'second note' });
  await resolveAdvice({
    filmPath: film.path, adviceId: a.id, agent: 'claude',
    outcome: 'applied', explanation: 'Switched to it.', revisionIds: ['rev-old'],
  });

  const summary = await adviceSummary(film.path);
  assert.equal(summary.total, 2);
  assert.equal(summary.unresolved, 1);

  const pinned = await advicePinnedRevisionIds(film.path);
  assert.ok(pinned.has('rev-old'));
});

test('advice: target filters answer scoped history questions', async () => {
  const { film } = await filmFixture();
  await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'scene note',
    target: { type: 'scene', scene: 'intro' },
  });
  await createAdvice({
    filmPath: film.path, filmId: film.id, message: 'caption note',
    target: { type: 'caption', itemId: 'cap-1' },
  });
  await createAdvice({ filmPath: film.path, filmId: film.id, message: 'film note' });

  assert.equal((await listAdvice({ filmPath: film.path, target: { type: 'scene', scene: 'intro' } })).length, 1);
  assert.equal((await listAdvice({ filmPath: film.path, target: { itemId: 'cap-1' } })).length, 1);
  assert.equal((await listAdvice({ filmPath: film.path })).length, 3);
});
