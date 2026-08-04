/**
 * Narrative sequences (v0.23): the story grouping over the play order.
 *
 * A sequence is a label on segments plus optional intent metadata on the
 * film. It renders nothing and owns nothing — reordering, renaming, or
 * regrouping is a film-document edit that never touches scene folders.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { validateFilm, normalizeFilm, planFilm, sequenceBands } from '../src/core/films.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/mcp/server.js');

const valid = (extra = {}) => validateFilm(normalizeFilm({
  name: 'Seq Film',
  scenes: [{ slug: 'a', sequence: 'Intro' }, { slug: 'b', sequence: 'Intro' }, { slug: 'c', sequence: 'Demo' }],
  sequences: { Intro: { intent: 'Hook the viewer' }, Demo: {} },
  ...extra,
}));

test('sequences: labels and metadata validate and survive normalization', () => {
  const film = valid();
  assert.equal(film.scenes[0].sequence, 'Intro');
  assert.equal(film.scenes[2].sequence, 'Demo');
  assert.equal(film.sequences.Intro.intent, 'Hook the viewer');

  // Footage segments carry labels too.
  const withFootage = validateFilm(normalizeFilm({
    name: 'F',
    scenes: [{ footage: 'assets/clip.mp4', durationInFrames: 30, sequence: 'B-roll' }],
  }));
  assert.equal(withFootage.scenes[0].sequence, 'B-roll');

  // A later unrelated normalization pass must not drop the labels.
  const again = validateFilm(normalizeFilm(film));
  assert.equal(again.scenes[1].sequence, 'Intro');
});

test('sequences: bad labels and metadata are refused with full problem lists', () => {
  assert.throws(() => valid({ scenes: [{ slug: 'a', sequence: '' }] }), (e) => {
    assert.equal(e.code, 'invalid_film');
    assert.ok(e.detail.problems.some((p) => p.includes('sequence')));
    return true;
  });
  assert.throws(() => valid({ sequences: { ['x'.repeat(81)]: {} } }), (e) => e.code === 'invalid_film');
  assert.throws(() => valid({ sequences: { Intro: { intent: 42 } } }), (e) => e.code === 'invalid_film');
  assert.throws(() => valid({ sequences: { Intro: { color: 'red' } } }), (e) => e.code === 'invalid_film');
  assert.throws(() => valid({ sequences: [] }), (e) => e.code === 'invalid_film');
});

test('sequences: bands derive from consecutive labels and cover the timeline', () => {
  const planned = [
    { index: 0, sequence: 'Intro', filmOffset: 0, startSeconds: 0, durationInFrames: 30 },
    { index: 1, sequence: 'Intro', filmOffset: 30, startSeconds: 1, durationInFrames: 30 },
    { index: 2, filmOffset: 60, startSeconds: 2, durationInFrames: 15 },
    { index: 3, sequence: 'Demo', filmOffset: 75, startSeconds: 2.5, durationInFrames: 45 },
    // The label recurs later: that is a SECOND band, in play order.
    { index: 4, sequence: 'Intro', filmOffset: 120, startSeconds: 4, durationInFrames: 30 },
  ];
  const bands = sequenceBands(planned, { Intro: { intent: 'Hook' } });
  assert.equal(bands.length, 4);
  assert.deepEqual(bands.map((b) => b.sequence), ['Intro', null, 'Demo', 'Intro']);
  assert.equal(bands[0].durationInFrames, 60);
  assert.equal(bands[0].segments, 2);
  assert.equal(bands[0].intent, 'Hook');
  assert.equal(bands[1].filmOffset, 60);
  assert.equal(bands[3].fromIndex, 4);
});

test('sequences: footage segments get a stable id that survives every rewrite', () => {
  const film = validateFilm(normalizeFilm({
    name: 'Clips',
    scenes: [
      { footage: 'assets/a.mp4', durationInFrames: 30, label: 'Plate' },
      // The SAME file cut in twice is legal, so identity cannot be the path.
      { footage: 'assets/a.mp4', durationInFrames: 12, label: 'Plate again' },
    ],
  }));
  const [first, second] = film.scenes;
  assert.match(first.id, /^seg-[0-9a-f]{8}$/);
  assert.notEqual(first.id, second.id);

  // Renormalizing (every save does) keeps the ids — otherwise advice left on
  // "the outro clip" would re-aim at whatever sat there after the next edit.
  const again = validateFilm(normalizeFilm(film));
  assert.equal(again.scenes[0].id, first.id);
  assert.equal(again.scenes[1].id, second.id);

  // Reordering carries the id with the clip, not with the position.
  const swapped = validateFilm(normalizeFilm({ ...film, scenes: [second, first] }));
  assert.equal(swapped.scenes[0].id, second.id);

  // A caller that duplicates an id is refused: two clips would share advice.
  assert.throws(
    () => validateFilm(normalizeFilm({ name: 'D', scenes: [{ ...first }, { ...first }] })),
    (e) => {
      assert.equal(e.code, 'invalid_film');
      assert.ok(e.detail.problems.some((p) => p.includes('appears more than once')));
      return true;
    },
  );
});

test('sequences: planFilm reports segment labels and bands', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-seq-'));
  const store = await makeStore(home);
  const film = await store.createFilm(TEST_WS, { name: 'Seq Plan' });
  await store.createScene(film.id, { name: 'One', durationInFrames: 10 });
  await store.createScene(film.id, { name: 'Two', durationInFrames: 20 });
  const updated = await store.updateFilm(film.id, {
    scenes: [{ slug: 'one', sequence: 'Intro' }, { slug: 'two', sequence: 'Close' }],
    sequences: { Intro: { intent: 'Open strong' } },
  });
  const plan = await planFilm({ film: updated, store });
  assert.equal(plan.scenes[0].sequence, 'Intro');
  assert.equal(plan.scenes[1].sequence, 'Close');
  assert.equal(plan.sequences.length, 2);
  assert.equal(plan.sequences[0].intent, 'Open strong');
  assert.equal(plan.sequences[1].filmOffset, 10);
  // Every key is on a segment, so the plan says nothing about orphans at all.
  assert.equal(plan.unreferencedSequences, undefined);
});

/* -------------------------------------------------------------------- */
/* Label loss through a play-order patch (v0.27)                        */
/* -------------------------------------------------------------------- */

test('sequences: planFilm names metadata keys no segment references', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-seq-orphan-'));
  const store = await makeStore(home);
  const film = await store.createFilm(TEST_WS, { name: 'Orphan Plan' });
  await store.createScene(film.id, { name: 'One', durationInFrames: 10 });
  await store.createScene(film.id, { name: 'Two', durationInFrames: 20 });
  // Labels on the segments, intent on the film — the healthy shape.
  await store.updateFilm(film.id, {
    scenes: [{ slug: 'one', sequence: 'Intro' }, { slug: 'two', sequence: 'Close' }],
    sequences: { Intro: { intent: 'Open strong' }, Close: { intent: 'Land it' } },
  });
  // Now the bug's shape: the play order restated as bare slugs. The labels go,
  // the metadata stays, and nothing in the document says so.
  const wiped = await store.updateFilm(film.id, { scenes: [{ slug: 'two' }, { slug: 'one' }] });
  const plan = await planFilm({ film: wiped, store });
  assert.deepEqual(plan.unreferencedSequences, ['Intro', 'Close']);
  assert.deepEqual(plan.sequences.map((b) => b.sequence), [null]); // one anonymous band

  // Relabel one of them and only the still-orphaned key is reported.
  const half = await store.updateFilm(film.id, { scenes: [{ slug: 'two', sequence: 'Close' }, { slug: 'one' }] });
  assert.deepEqual((await planFilm({ film: half, store })).unreferencedSequences, ['Intro']);
});

test('sequences: update_film warns when a play-order patch clears labels', async (t) => {
  // The fixture is built through the store in THIS process (create_film and
  // create_scene gate on ffmpeg, which this test has no use for); the MCP
  // child serves the same data dir, exactly as the Studio and an agent do.
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-seq-mcp-'));
  const store = await makeStore(home);
  const fixture = await store.createFilm(TEST_WS, { name: 'Warned' });
  for (const name of ['Hook', 'Demo', 'Outro']) await store.createScene(fixture.id, { name });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, MOTION_STUDIO_HOME: home, MOTION_STUDIO_WORKSPACE: TEST_WS },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ms-seq-test', version: '0.0.1' });
  await client.connect(transport);
  after(async () => { await client.close().catch(() => {}); });

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(!!res.isError, false, res.content?.[0]?.text);
    return JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}');
  };

  const grouped = await call('update_film', {
    film: 'warned',
    scenes: [{ slug: 'hook', sequence: 'Opening' }, { slug: 'demo', sequence: 'Opening' }, { slug: 'outro', sequence: 'Close' }],
    sequences: { Opening: { intent: 'the first band' }, Close: { intent: 'the last band' } },
  });
  assert.equal(grouped.warnings, undefined, 'labelling segments loses nothing');

  // (a) The documented-looking reorder: bare {slug} entries. It still reorders
  // — and it takes every label with it, which is what the warning is for.
  const wiped = await call('update_film', {
    film: 'warned',
    scenes: [{ slug: 'outro' }, { slug: 'hook' }, { slug: 'demo' }],
  });
  assert.deepEqual(wiped.warnings, [
    'This patch cleared the `sequence` label on 3 segments (Close, Opening).'
    + ' 2 `sequences` entries are now unreferenced: Opening, Close.'
    + ' A segment object REPLACES the segment — carry the segment objects through from get_film rather than'
    + ' rebuilding a bare [{slug}] list. Ignore this if you meant to ungroup.',
  ]);
  // The same orphaned state the plan now reports, in the same response.
  assert.deepEqual(wiped.plan.unreferencedSequences, ['Opening', 'Close']);

  // (b) The recipe the description now gives: carry the segments through from
  // get_film and reorder THOSE. Nothing is lost, so nothing is said.
  await call('update_film', {
    film: 'warned',
    scenes: [{ slug: 'hook', sequence: 'Opening' }, { slug: 'demo', sequence: 'Opening' }, { slug: 'outro', sequence: 'Close' }],
  });
  const read = await call('get_film', { film: 'warned' });
  const reordered = await call('update_film', {
    film: 'warned',
    scenes: [read.scenes[2], read.scenes[0], read.scenes[1]].map((s) => ({ ...s })),
  });
  assert.equal(reordered.warnings, undefined, JSON.stringify(reordered.warnings));
  assert.equal(reordered.plan.unreferencedSequences, undefined);

  // (d) A deliberate ungroup — segments sent without the label AND the key
  // dropped from `sequences` — is not a mistake, but it did clear labels, so
  // it is still reported. What it does not claim is orphaned metadata.
  const cur = await call('get_film', { film: 'warned' });
  const ungrouped = await call('update_film', {
    film: 'warned',
    scenes: cur.scenes.map(({ sequence, ...rest }) => (sequence === 'Opening' ? rest : { ...rest, sequence })),
    sequences: { Close: cur.sequences.Close },
  });
  assert.deepEqual(ungrouped.warnings, [
    'This patch cleared the `sequence` label on 2 segments (Opening).'
    + ' A segment object REPLACES the segment — carry the segment objects through from get_film rather than'
    + ' rebuilding a bare [{slug}] list. Ignore this if you meant to ungroup.',
  ]);
  assert.equal(ungrouped.plan.unreferencedSequences, undefined, 'the ungroup took its metadata with it');

  // A patch that does not touch the play order never pays for the extra read.
  const renamed = await call('update_film', { film: 'warned', name: 'Warned Again' });
  assert.equal(renamed.warnings, undefined);
  t.diagnostic('sequence-loss warning covered end to end');
});
