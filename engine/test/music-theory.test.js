/**
 * Music theory compiler (v0.20): chord parsing, style expansion, and the
 * musical invariants the compiler promises — voice-led pads, per-role
 * registers, mix headroom, deterministic output, seeded variation.
 *
 * Everything here is pure (no server, no SoundFont, no synth): the contract
 * under test is "compileTheorySpec emits a spec validateMusicSpec accepts",
 * which is exactly the boundary the renderers already own. The audio path
 * itself is covered by music-vendors.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChord, parseKey, compileTheorySpec, THEORY_STYLES, THEORY_STYLE_NAMES,
} from '../src/core/music-theory.js';
import { validateMusicSpec } from '../src/core/music-node.js';

const PROG = ['C', 'G', 'Am', 'F'];

/** Group a track's notes by start beat → sorted pitch arrays, in time order. */
function chordGroups(track) {
  const byStart = new Map();
  for (const n of track.notes) {
    if (!byStart.has(n.start)) byStart.set(n.start, []);
    byStart.get(n.start).push(n.pitch);
  }
  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, pitches]) => ({ start, pitches: pitches.sort((a, b) => a - b) }));
}

const pcsOf = (pitches) => new Set(pitches.map((p) => ((p % 12) + 12) % 12));

/** Assert the named fields of a parsed chord (subset match; Node 18-safe). */
function chordIs(actual, expected) {
  for (const [field, want] of Object.entries(expected)) {
    assert.deepEqual(actual[field], want, `${field} of ${actual.symbol}`);
  }
}

/* ------------------------------ chord parsing ------------------------------ */

test('theory: letter chords cover roots, accidentals, qualities and slash bass', () => {
  chordIs(parseChord('C'), { rootPc: 0, quality: 'major', intervals: [0, 4, 7], bassPc: null });
  chordIs(parseChord('F#'), { rootPc: 6 });
  chordIs(parseChord('Bbm'), { rootPc: 10, intervals: [0, 3, 7] });
  chordIs(parseChord('Am7'), { rootPc: 9, intervals: [0, 3, 7, 10] });
  chordIs(parseChord('Dmaj7'), { rootPc: 2, intervals: [0, 4, 7, 11] });
  chordIs(parseChord('Esus4'), { rootPc: 4, intervals: [0, 5, 7] });
  chordIs(parseChord('Gdim'), { rootPc: 7, intervals: [0, 3, 6] });
  chordIs(parseChord('C/E'), { rootPc: 0, bassPc: 4 });
});

test('theory: roman numerals resolve against the key, lowercase meaning minor', () => {
  chordIs(parseChord('I', { key: 'D' }), { rootPc: 2, quality: 'major' });
  chordIs(parseChord('vi', { key: 'D' }), { rootPc: 11, quality: 'm' });
  chordIs(parseChord('IV', { key: 'D' }), { rootPc: 7 });
  chordIs(parseChord('V7', { key: 'D' }), { rootPc: 9, intervals: [0, 4, 7, 10] });
  assert.equal(parseChord('bVII', { key: 'D' }).rootPc, 0, 'bVII of D is C');
  // Minor keys use the natural-minor degrees.
  chordIs(parseChord('i', { key: 'Am' }), { rootPc: 9, quality: 'm' });
  chordIs(parseChord('VI', { key: 'Am' }), { rootPc: 5, quality: 'major' });
  // The 'm' suffix forces minor even on an uppercase numeral.
  assert.equal(parseChord('IVm', { key: 'C' }).quality, 'm');
});

test('theory: a bad chord names itself and shows the valid forms', () => {
  for (const bad of ['H7', 'Cxyz', 'c#', '']) {
    assert.throws(() => parseChord(bad), (e) => {
      assert.equal(e.code, 'invalid_music_spec');
      assert.ok(e.message.includes(`"${bad}"`), `should name the chord: ${e.message}`);
      assert.match(e.message, /roman numeral/i, 'should teach the valid forms');
      return true;
    });
  }
});

test('theory: a roman numeral without a key says exactly what is missing', () => {
  assert.throws(() => parseChord('vi'), (e) => {
    assert.equal(e.code, 'invalid_music_spec');
    assert.match(e.message, /"vi"/);
    assert.match(e.message, /`key`/);
    return true;
  });
  assert.throws(() => parseKey('X'), (e) => e.code === 'invalid_music_spec' && /"X"/.test(e.message));
});

/* --------------------------------- compile -------------------------------- */

test('theory: an unknown style is refused by name, listing the valid ones', () => {
  assert.throws(() => compileTheorySpec({ progression: PROG, style: 'techno' }), (e) => {
    assert.equal(e.code, 'invalid_music_spec');
    assert.match(e.message, /"techno"/);
    for (const name of THEORY_STYLE_NAMES) assert.ok(e.message.includes(name), `should list ${name}`);
    return true;
  });
});

test('theory: an unknown layer is refused, listing the style\'s own layers', () => {
  assert.throws(() => compileTheorySpec({ progression: PROG, style: 'pad-ballad', layers: ['pad', 'kazoo'] }), (e) => {
    assert.equal(e.code, 'invalid_music_spec');
    assert.match(e.message, /"kazoo"/);
    assert.match(e.message, /pad, bass, piano/);
    return true;
  });
});

test('theory: malformed knobs are named — progression, bars, beatsPerBar, seed, bpm', () => {
  const cases = [
    [{ progression: [] }, /progression/],
    [{ progression: PROG, bars: 0 }, /bars/],
    [{ progression: PROG, bars: 2.5 }, /bars/],
    [{ progression: PROG, beatsPerBar: 1 }, /beatsPerBar/],
    [{ progression: PROG, seed: 1.5 }, /seed/],
    [{ progression: PROG, bpm: 0 }, /bpm/],
    [{ progression: PROG, bars: 128, beatsPerBar: 12 }, /≤ 512/],
  ];
  for (const [spec, re] of cases) {
    assert.throws(() => compileTheorySpec(spec), (e) => e.code === 'invalid_music_spec' && re.test(e.message), JSON.stringify(spec));
  }
});

test('theory: the progression cycles across bars and ends on a held tonic bar', () => {
  const { tracks, meta } = compileTheorySpec({ progression: PROG, style: 'pad', bars: 6, key: 'C', beatsPerBar: 4 });
  assert.equal(meta.bars, 6);
  assert.equal(meta.chords, 7, 'six bars of progression + the held close');

  const groups = chordGroups(tracks[0]);
  assert.equal(groups.length, 7);
  assert.deepEqual(groups.map((g) => g.start), [0, 4, 8, 12, 16, 20, 24]);
  // Bar 5 (index 4) cycles back to the opening C chord.
  assert.deepEqual(pcsOf(groups[4].pitches), pcsOf(groups[0].pitches));
  // The close is one whole held bar of the tonic triad.
  const close = tracks[0].notes.filter((n) => n.start === 24);
  assert.ok(close.every((n) => n.duration === 4), 'the final chord is held for the full bar');
  assert.deepEqual([...pcsOf(close.map((n) => n.pitch))].sort((a, b) => a - b), [0, 4, 7], 'and it is C major');
});

test('theory: bars defaults to one bar per chord, once through', () => {
  const { meta } = compileTheorySpec({ progression: ['D', 'A', 'Bm', 'G'] });
  assert.equal(meta.bars, 4);
  assert.equal(meta.style, 'pad');
  assert.equal(meta.beatsPerBar, 4);
  assert.equal(meta.seed, 1);
});

test('theory: every style compiles to a spec the validator accepts, with headroom and registers', () => {
  for (const style of THEORY_STYLE_NAMES) {
    const compiled = compileTheorySpec({ bpm: 90, progression: PROG, style, bars: 4, key: 'C', seed: 3 });
    const v = validateMusicSpec(compiled);
    assert.ok(v.noteCount > 0, `${style} should produce notes`);
    assert.equal(v.bpm, 90);

    const layerNames = Object.keys(THEORY_STYLES[style].layers);
    assert.equal(compiled.tracks.length, layerNames.length, `${style} renders every layer`);

    compiled.tracks.forEach((track, i) => {
      const name = layerNames[i];
      for (const n of track.notes) {
        assert.ok(n.velocity <= 80, `${style}/${name}: velocity ${n.velocity} must leave mix headroom`);
        if (name === 'bass') {
          assert.ok(n.pitch >= 36 && n.pitch <= 50, `${style}/bass: pitch ${n.pitch} out of 36..50`);
        }
        if (name === 'arp' || name === 'music-box') {
          assert.ok(n.pitch >= 60 && n.pitch <= 84, `${style}/${name}: pitch ${n.pitch} out of 60..84`);
        }
      }
    });
    if (style === 'drive') {
      assert.equal(compiled.tracks[2].drums, true, 'drive carries a drums track');
    }
  }
});

test('theory: identical input compiles identically', () => {
  const spec = { bpm: 96, progression: ['D', 'A', 'Bm', 'G'], style: 'pad-ballad', bars: 8, key: 'D', seed: 5 };
  assert.deepEqual(compileTheorySpec(spec), compileTheorySpec(spec));
});

test('theory: a different seed is a different (but still valid, same-shape) take', () => {
  const base = { progression: ['D', 'A', 'Bm', 'G'], style: 'arp', bars: 8, key: 'D' };
  const one = compileTheorySpec({ ...base, seed: 1 });
  const two = compileTheorySpec({ ...base, seed: 2 });
  assert.notDeepEqual(one.tracks, two.tracks, 'the seed must audibly vary the take');
  validateMusicSpec(two);
  // Variation is decoration, not structure: same layers, same length.
  assert.deepEqual(one.tracks.map((t) => t.program), two.tracks.map((t) => t.program));
  assert.equal(one.meta.chords, two.meta.chords);
});

test('theory: adjacent pad chords are voice-led, not jumped', () => {
  const { tracks } = compileTheorySpec({ progression: PROG, style: 'pad', bars: 8, key: 'C' });
  const groups = chordGroups(tracks[0]);
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1].pitches;
    const cur = groups[i].pitches;
    const avg = cur.reduce((s, p) => s + Math.min(...prev.map((q) => Math.abs(p - q))), 0) / cur.length;
    assert.ok(avg <= 2.5, `chord ${i} moved ${avg.toFixed(2)} semitones on average — that is a jump, not voice leading`);
  }
});

test('theory: layers selects a subset, kept in the style\'s layer order', () => {
  const compiled = compileTheorySpec({ progression: PROG, style: 'pad-ballad', layers: ['piano', 'bass'] });
  assert.deepEqual(compiled.tracks.map((t) => t.program), [32, 0], 'bass then piano — definition order, not request order');
  assert.deepEqual(compiled.meta.layers, ['bass', 'piano']);
  validateMusicSpec(compiled);
});

test('theory: slash bass steers the bass layer, not the pad voicing', () => {
  const compiled = compileTheorySpec({ progression: ['C/E', 'F'], style: 'pad-ballad', bars: 2 });
  const bassRoots = chordGroups(compiled.tracks[1]);
  assert.equal(bassRoots[0].pitches[0] % 12, 4, 'the C/E bar walks from E, not C');
});

test('theory: odd meters compile too', () => {
  const compiled = compileTheorySpec({ progression: ['Am', 'F', 'C', 'G'], style: 'lullaby', beatsPerBar: 3, key: 'Am' });
  const v = validateMusicSpec(compiled);
  assert.ok(v.noteCount > 0);
  const groups = chordGroups(compiled.tracks[1]); // sustained strings mark the bars
  assert.deepEqual(groups.map((g) => g.start), [0, 3, 6, 9, 12]);
});
