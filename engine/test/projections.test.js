/**
 * Token-efficient projections (TE P0-1/P0-2), unit level: row shapes and
 * state folding, cursor round-trip, stateless diffs, and the tolerance
 * contract — garbage cursors parse to null, never throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentRows, computeCursor, parseCursor, diffRows } from '../src/core/projections.js';

const plan = (scenes) => ({ scenes, problems: [] });

const scene = (slug, extra = {}) => ({
  kind: 'scene', sceneId: `ws/film/${slug}`, slug, name: slug,
  filmOffset: 0, durationInFrames: 30, startSeconds: 0,
  rendered: false, ...extra,
});

test('projections: scene state folds missing > stale > rendered > unrendered', () => {
  const rows = segmentRows(plan([
    scene('a', { missing: true, rendered: true, staleRender: true }),
    scene('b', { staleRender: true, rendered: true }),
    scene('c', { rendered: true, renderVerified: true }),
    scene('d'),
  ]));
  assert.deepEqual(rows.map((r) => r.state), ['missing', 'stale', 'rendered', 'unrendered']);
  assert.equal(rows[2].renderVerified, true);
  assert.equal(rows[3].renderVerified, null, 'pre-sidecar renders read as null, not false');
});

test('projections: footage rows carry their own identity and state', () => {
  const rows = segmentRows(plan([
    { kind: 'footage', footage: 'clip-1', name: 'Clip', filmOffset: 30, durationInFrames: 60, framesVerified: true },
    { kind: 'footage', footage: 'clip-2', filmOffset: 90, durationInFrames: 10, missing: true },
  ]));
  assert.deepEqual(rows.map((r) => r.state), ['present', 'missing']);
  assert.equal(rows[0].footage, 'clip-1');
  assert.equal(rows[1].framesVerified, null);
});

test('projections: rows never carry document or composition payloads', () => {
  const rows = segmentRows(plan([scene('a', { config: { huge: 'x'.repeat(64) }, composition: 'html' })]));
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('huge') && !text.includes('composition'), text);
});

test('cursor: same state → same cursor; a changed row → a delta naming exactly it', () => {
  const rowsA = segmentRows(plan([scene('a'), scene('b')]));
  const marks = { revision: 'r1' };
  const c1 = computeCursor({ film: 'f', rows: rowsA, marks });
  const c2 = computeCursor({ film: 'f', rows: segmentRows(plan([scene('a'), scene('b')])), marks });
  assert.equal(c1, c2, 'deterministic');
  assert.equal(parseCursor(c1).o, parseCursor(c2).o);

  const rowsB = segmentRows(plan([scene('a'), scene('b', { rendered: true })]));
  const c3 = computeCursor({ film: 'f', rows: rowsB, marks });
  assert.notEqual(parseCursor(c1).o, parseCursor(c3).o);
  const { changed, removed } = diffRows(parseCursor(c1), rowsB);
  assert.deepEqual(changed.map((r) => r.slug), ['b']);
  assert.deepEqual(removed, []);
});

test('cursor: marks changes alone (revision, advice, delivery) change the cursor', () => {
  const rows = segmentRows(plan([scene('a')]));
  const c1 = computeCursor({ film: 'f', rows, marks: { revision: 'r1' } });
  const c2 = computeCursor({ film: 'f', rows, marks: { revision: 'r2' } });
  assert.notEqual(parseCursor(c1).o, parseCursor(c2).o);
  assert.deepEqual(diffRows(parseCursor(c1), rows).changed, [], 'no row lies about changing');
});

test('cursor: removed segments are named by key', () => {
  const before = segmentRows(plan([scene('a'), { kind: 'footage', footage: 'clip', filmOffset: 0, durationInFrames: 5 }]));
  const cursor = computeCursor({ film: 'f', rows: before, marks: {} });
  const { removed } = diffRows(parseCursor(cursor), segmentRows(plan([scene('a')])));
  assert.deepEqual(removed, ['f:clip']);
});

test('cursor: garbage parses to null, never throws', () => {
  for (const bad of ['', 'nope', 'c1.', 'c1.!!!', `c1.${Buffer.from('[]').toString('base64url')}`, 'c2.abc', 42, null, undefined]) {
    assert.equal(parseCursor(bad), null, String(bad));
  }
});
