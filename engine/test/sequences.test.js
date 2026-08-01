/**
 * Narrative sequences (v0.23): the story grouping over the play order.
 *
 * A sequence is a label on segments plus optional intent metadata on the
 * film. It renders nothing and owns nothing — reordering, renaming, or
 * regrouping is a film-document edit that never touches scene folders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateFilm, normalizeFilm, planFilm, sequenceBands } from '../src/core/films.js';
import { makeStore, TEST_WS } from './helpers/workspace.mjs';

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
});
