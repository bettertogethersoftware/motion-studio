/**
 * Music theory compiler — chord progressions → the note-level music spec (v0.20).
 *
 * `synthesize_music` renders exactly what it is given: every pitch, start and
 * duration written out by hand. That is the right *rendering* contract — the
 * two vendors (core/music-node.js, core/music.js) stay simple and identical —
 * but it is a miserable *authoring* contract: a 30-second bed is ~100 raw MIDI
 * notes of JSON, and an agent hand-voicing triads gets the craft details
 * (voice leading, register, headroom) subtly wrong more often than right.
 *
 * This module is the missing compile step. An agent writes intent:
 *
 *   { bpm: 96, progression: ['D', 'A', 'Bm', 'G'], style: 'pad-ballad', bars: 8 }
 *
 * and compileTheorySpec() emits the same `{ bpm, tracks: [{ program, drums?,
 * notes }] }` spec the renderers already accept — NOTHING downstream of this
 * file changes, and the raw note form stays available for pieces the styles
 * cannot express. Pure functions, no I/O, no engine state.
 *
 * Musical choices, and why they are built in rather than knobs:
 *
 *   - Chords are voice-led: each chord takes the inversion/register that moves
 *     least from the previous voicing (the classic nearest-voicing rule),
 *     because parallel root-position triads are the most recognizable
 *     "programmer music" tell there is.
 *   - Registers are fixed per role — bass 36..50, chord pads ~52..81, arps and
 *     melodic figures 60..84 — so layers never collide, whatever the
 *     progression.
 *   - Velocities sit around 45..65. Beds are mixed UNDER narration, and
 *     core/music-vendors.js only ever *attenuates* toward targetPeakDb, so
 *     headroom has to be authored in; it cannot be added later.
 *   - Every piece ends on one extra held bar of the tonic (or the opening
 *     chord when no key is known): a bed that stops mid-phrase reads as a bug
 *     in the film, not a choice.
 *
 * Determinism: identical input → identical output, always — that is what makes
 * the node vendor's byte-identical renders meaningful end to end. The only
 * "random" touches (velocity humanization, arp contour) come from a local
 * mulberry32 seeded by `seed` (default 1) — the same PRNG runtime/frame-api.js
 * uses, and for the same reason: Math.random would make every take
 * unreproducible.
 */

import { EngineError, ErrorCodes } from './errors.js';

/* ------------------------------ chord symbols ----------------------------- */

const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Chord qualities as semitone intervals from the root. Keys are the exact
 * suffix an author writes after the root letter ('' = plain major), which is
 * also why the error message can list them verbatim.
 */
const QUALITIES = Object.freeze({
  '': [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14],
});

const QUALITY_LIST = Object.keys(QUALITIES).map((q) => (q === '' ? '(none = major)' : q)).join(', ');

// Longest alternatives first, so "maj7" is not consumed as "m" + garbage.
const QUALITY_ALT = 'maj7|m7b5|dim7|m7|m6|sus2|sus4|add9|dim|aug|m|6|7';
const CHORD_RE = new RegExp(`^([A-G])(#|b)?(${QUALITY_ALT})?(?:/([A-G])(#|b)?)?$`);
const ROMAN_RE = new RegExp(`^(#|b)?(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(${QUALITY_ALT}|°|o|\\+)?$`);
const KEY_RE = /^([A-G])(#|b)?(maj|major|m|min|minor)?$/;

const ROMAN_DEGREE = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };
const MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_OFFSETS = [0, 2, 3, 5, 7, 8, 10]; // natural minor

const mod12 = (n) => ((n % 12) + 12) % 12;
const pc = (letter, acc) => mod12(NOTE_PC[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0));
const invalid = (message, detail) => new EngineError(ErrorCodes.INVALID_MUSIC_SPEC, message, detail);

/**
 * Parse a key name ('C', 'F#', 'Bb', 'Am', 'F#m', 'Ebmin') into a tonic pitch
 * class and a mode. Roman numerals resolve against this; the closing held
 * chord is its tonic triad.
 */
export function parseKey(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key.trim()) : null;
  if (!m) {
    throw invalid(
      `Unknown key "${key}" — expected a tonic like 'C', 'F#' or 'Bb', optionally minor ('Am', 'F#m').`,
      { key },
    );
  }
  const [, letter, acc, mode = ''] = m;
  return { name: key.trim(), tonicPc: pc(letter, acc), minor: mode !== '' && mode !== 'maj' && mode !== 'major' };
}

/** Roman-numeral quality: case carries major/minor; a suffix refines it. */
function romanQuality(lower, suffix) {
  switch (suffix) {
    case '': return lower ? 'm' : '';
    case '7': return lower ? 'm7' : '7';
    case '6': return lower ? 'm6' : '6';
    case '°': case 'o': return 'dim';
    case '+': return 'aug';
    default: return suffix; // m, m7, maj7, dim, dim7, aug, sus2, sus4, m6, m7b5, add9 — as written
  }
}

/**
 * Parse one chord symbol into `{ symbol, rootPc, quality, intervals, bassPc }`.
 *
 * Two grammars, tried in order (their alphabets are disjoint — letter roots
 * are A..G, roman numerals use only I and V characters):
 *
 *   letters:  C, F#, Bbm, Am7, Dmaj7, Esus4, Gdim, C/E (slash = bass note)
 *   romans:   I, ii, V7, bVII, vii° — resolved against `key` (lowercase =
 *             minor, per the common lead-sheet convention)
 *
 * @param {string} symbol
 * @param {{key?: string|{tonicPc:number,minor:boolean}}} [options]
 * @throws EngineError INVALID_MUSIC_SPEC naming the symbol and the valid forms
 */
export function parseChord(symbol, { key } = {}) {
  const s = typeof symbol === 'string' ? symbol.trim() : '';
  let m = s ? CHORD_RE.exec(s) : null;
  if (m) {
    const [, letter, acc, quality = '', bassLetter, bassAcc] = m;
    return {
      symbol: s,
      rootPc: pc(letter, acc),
      quality: quality === '' ? 'major' : quality,
      intervals: QUALITIES[quality],
      bassPc: bassLetter ? pc(bassLetter, bassAcc) : null,
    };
  }
  m = s ? ROMAN_RE.exec(s) : null;
  if (m) {
    if (!key) {
      throw invalid(
        `Roman numeral "${s}" needs a \`key\` to resolve to a chord — e.g. { progression: ['I','V','vi','IV'], key: 'D' }.`,
        { chord: s },
      );
    }
    const k = typeof key === 'string' ? parseKey(key) : key;
    const [, acc, numeral, suffix = ''] = m;
    const lower = numeral === numeral.toLowerCase();
    const degree = ROMAN_DEGREE[numeral.toUpperCase()];
    const offsets = k.minor ? MINOR_OFFSETS : MAJOR_OFFSETS;
    const quality = romanQuality(lower, suffix);
    return {
      symbol: s,
      rootPc: mod12(k.tonicPc + offsets[degree - 1] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0)),
      quality: quality === '' ? 'major' : quality,
      intervals: QUALITIES[quality],
      bassPc: null,
    };
  }
  throw invalid(
    `Unknown chord "${symbol}" — use a letter chord (C, F#m, Bb7, Am7, Dmaj7, Esus4, Gdim, C/E) ` +
      `or a roman numeral with \`key\` (I, ii, V7, bVII; lowercase = minor). Qualities: ${QUALITY_LIST}.`,
    { chord: symbol },
  );
}

/* --------------------------------- styles --------------------------------- */

/**
 * Each style is a set of named layers; each layer is one output track with a
 * General MIDI program, a base velocity (deliberately 45..65 — see the module
 * header on headroom) and a `role` the renderer below knows how to play.
 * Layer order here is track order in the compiled spec.
 */
export const THEORY_STYLES = Object.freeze({
  pad: Object.freeze({
    summary: 'sustained close-voiced chords — a minimal ambient bed',
    layers: Object.freeze({
      pad: Object.freeze({ program: 89, velocity: 58, role: 'sustain' }),
    }),
  }),
  'pad-ballad': Object.freeze({
    summary: 'warm pad + root–fifth bass + soft piano arpeggios',
    layers: Object.freeze({
      pad: Object.freeze({ program: 89, velocity: 55, role: 'sustain' }),
      bass: Object.freeze({ program: 32, velocity: 60, role: 'root-fifth' }),
      piano: Object.freeze({ program: 0, velocity: 52, role: 'arp-gentle' }),
    }),
  }),
  arp: Object.freeze({
    summary: 'eighth-note arpeggios over held bass roots',
    layers: Object.freeze({
      arp: Object.freeze({ program: 0, velocity: 62, role: 'arp-eighths' }),
      bass: Object.freeze({ program: 32, velocity: 58, role: 'root-hold' }),
    }),
  }),
  drive: Object.freeze({
    summary: 'rhythmic eighths pad + walking bass + light drums',
    layers: Object.freeze({
      pad: Object.freeze({ program: 90, velocity: 56, role: 'pulse-eighths' }),
      bass: Object.freeze({ program: 33, velocity: 62, role: 'walking' }),
      drums: Object.freeze({ drums: true, velocity: 60, role: 'backbeat' }),
    }),
  }),
  lullaby: Object.freeze({
    summary: 'slow broken music-box chords over soft strings',
    layers: Object.freeze({
      'music-box': Object.freeze({ program: 10, velocity: 54, role: 'broken-slow' }),
      strings: Object.freeze({ program: 48, velocity: 45, role: 'sustain' }),
      bass: Object.freeze({ program: 32, velocity: 48, role: 'root-hold' }),
    }),
  }),
});

export const THEORY_STYLE_NAMES = Object.freeze(Object.keys(THEORY_STYLES));

/* ------------------------- deterministic variation ------------------------ */

/** mulberry32 — the exact PRNG runtime/frame-api.js random() uses. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base velocity ± 3 of humanization, clamped to MIDI range. */
const vel = (base, rng) => Math.min(127, Math.max(1, base + Math.floor(rng() * 7) - 3));

/* ------------------------------ voice leading ----------------------------- */

// Chord-pad register. Wide enough for every inversion of a 4-note chord,
// narrow enough that pads never brush the bass (≤50) or the arps (≥60 — pads
// overlap that seam on purpose; sustained chords under a moving line blend,
// two moving lines in one register fight).
const VOICE_LOW = 52;
const VOICE_HIGH = 81;
const VOICE_CENTER = 64;

/** All close voicings (every inversion, every octave) inside [low, high]. */
function closeVoicings(chord, low = VOICE_LOW, high = VOICE_HIGH) {
  // Normalize to unique pitch classes so e.g. add9's 14 folds into the stack.
  const ivs = [...new Set(chord.intervals.map((i) => i % 12))].sort((a, b) => a - b);
  const out = [];
  for (let inv = 0; inv < ivs.length; inv++) {
    const rotated = [...ivs.slice(inv), ...ivs.slice(0, inv).map((i) => i + 12)];
    const rel = rotated.map((i) => i - rotated[0]);
    const bottomPc = mod12(chord.rootPc + rotated[0]);
    for (let bottom = low + mod12(bottomPc - low); bottom + rel[rel.length - 1] <= high; bottom += 12) {
      out.push(rel.map((r) => bottom + r));
    }
  }
  return out;
}

/** Mean per-voice motion from voicing `a` to `b` (nearest-note matching, so a triad against a 7th chord still compares). */
function motion(a, b) {
  let sum = 0;
  for (const p of b) {
    let best = Infinity;
    for (const q of a) best = Math.min(best, Math.abs(p - q));
    sum += best;
  }
  return sum / b.length;
}

const centerPull = (v, center) => Math.abs(v.reduce((s, p) => s + p, 0) / v.length - center);

/**
 * Voice-lead a chord sequence: the first chord sits nearest the register
 * center, every later chord takes the candidate voicing that moves least from
 * the previous one (with a slight pull back to center so eight bars of
 * descending bass lines cannot walk the pad off its register). Strict `<`
 * comparison keeps ties deterministic: first candidate generated wins.
 */
function voiceLead(chords) {
  const out = [];
  let prev = null;
  for (const chord of chords) {
    let best = null;
    let bestScore = Infinity;
    for (const v of closeVoicings(chord)) {
      const score = prev ? motion(prev, v) + centerPull(v, VOICE_CENTER) * 0.15 : centerPull(v, VOICE_CENTER);
      if (score < bestScore) { best = v; bestScore = score; }
    }
    out.push(best);
    prev = best;
  }
  return out;
}

/* ------------------------------ note builders ----------------------------- */

const BASS_LOW = 36; // C2
const BASS_HIGH = 50;

/** The chord's bass pitch (slash bass wins) folded into the bass register. */
function bassPitch(chord) {
  return BASS_LOW + mod12(chord.bassPc ?? chord.rootPc);
}

function foldBass(p) {
  while (p < BASS_LOW) p += 12;
  while (p > BASS_HIGH) p -= 12;
  return p;
}

/**
 * Chord tones stacked ascending inside [low, high], starting from the lowest
 * in-range root — the pitch ladder arps and broken chords walk on.
 */
function arpLadder(chord, low, high) {
  const base = low + mod12(chord.rootPc - low);
  const ladder = [];
  for (let oct = 0; oct < 4; oct++) {
    for (const iv of chord.intervals) {
      const p = base + (iv % 12) + oct * 12;
      if (p >= low && p <= high && !ladder.includes(p)) ladder.push(p);
    }
  }
  ladder.sort((a, b) => a - b);
  return ladder;
}

const upDown = (ladder) => (ladder.length < 3 ? ladder : [...ladder, ...ladder.slice(1, -1).reverse()]);

/**
 * Render one layer across the whole piece. `slots` is one chord per bar with
 * the final entry being the held close; `voicings` is the voice-led pad
 * voicing per slot (shared by every chordal layer, so the layers agree).
 */
function renderLayer(layer, { slots, voicings, beatsPerBar: B, rng }) {
  const notes = [];
  const last = slots.length - 1;
  const push = (pitch, start, duration, velocity) => notes.push({ pitch, start, duration, velocity });

  slots.forEach((chord, i) => {
    const at = i * B;
    const held = i === last;
    switch (layer.role) {
      case 'sustain': {
        for (const p of voicings[i]) push(p, at, B, vel(layer.velocity, rng));
        break;
      }
      case 'pulse-eighths': {
        if (held) {
          for (const p of voicings[i]) push(p, at, B, vel(layer.velocity, rng));
          break;
        }
        for (let t = 0; t < B * 2; t++) {
          const accent = t % 2 === 0 ? 4 : -4;
          for (const p of voicings[i]) push(p, at + t * 0.5, 0.45, vel(layer.velocity + accent, rng));
        }
        break;
      }
      case 'root-fifth': {
        const root = bassPitch(chord);
        const fifth = foldBass(root + 7);
        if (held) {
          push(root, at, B, vel(layer.velocity, rng));
          push(fifth, at, B, vel(layer.velocity - 6, rng));
          break;
        }
        push(root, at, B / 2, vel(layer.velocity, rng));
        push(fifth, at + B / 2, B / 2, vel(layer.velocity - 4, rng));
        break;
      }
      case 'root-hold': {
        push(bassPitch(chord), at, B, vel(layer.velocity, rng));
        break;
      }
      case 'walking': {
        const root = bassPitch(chord);
        if (held) {
          push(root, at, B, vel(layer.velocity, rng));
          break;
        }
        const third = foldBass(BASS_LOW + mod12(chord.rootPc + chord.intervals[1]));
        const fifth = foldBass(BASS_LOW + mod12(chord.rootPc + chord.intervals[2]));
        const target = bassPitch(slots[i + 1]);
        const approach = foldBass(target >= fifth ? target - 1 : target + 1);
        for (let q = 0; q < B; q++) {
          const p = q === 0 ? root : q === B - 1 ? approach : q % 2 === 1 ? third : fifth;
          push(p, at + q, 0.9, vel(layer.velocity - (q === 0 ? 0 : 4), rng));
        }
        break;
      }
      case 'arp-eighths': {
        const ladder = arpLadder(chord, 60, 84);
        if (held) {
          ladder.slice(0, 4).forEach((p, k) => push(p, at + k * 0.5, B - k * 0.5, vel(layer.velocity - 4, rng)));
          break;
        }
        const seq = rng() < 0.6 ? ladder : upDown(ladder);
        for (let t = 0; t < B * 2; t++) {
          push(seq[t % seq.length], at + t * 0.5, 0.5, vel(layer.velocity + (t % 2 === 0 ? 2 : -4), rng));
        }
        break;
      }
      case 'arp-gentle': {
        const ladder = arpLadder(chord, 60, 79);
        if (held) {
          ladder.slice(0, 3).forEach((p, k) => push(p, at + k * 0.5, B - k * 0.5, vel(layer.velocity - 4, rng)));
          break;
        }
        const pattern = rng() < 0.5 ? [0, 1, 2, 1] : [0, 2, 1, 2];
        for (let q = 0; q < B; q++) {
          const p = ladder[pattern[q % 4] % ladder.length];
          push(p, at + q, 1, vel(layer.velocity + (q === 0 ? 2 : -2), rng));
        }
        break;
      }
      case 'broken-slow': {
        const ladder = arpLadder(chord, 64, 84);
        if (held) {
          ladder.slice(0, 3).forEach((p, k) => push(p, at + k * 0.5, B - k * 0.5, vel(layer.velocity - 4, rng)));
          break;
        }
        const pattern = rng() < 0.5 ? [0, 2, 1, 2] : [0, 1, 2, 1];
        for (let q = 0; q < B; q++) {
          const p = ladder[pattern[q % 4] % ladder.length];
          // 1.8 beats: each tone rings into the next, which is the whole sound
          // of a music box. Overlap is fine — the validator allows it and the
          // synth just holds both.
          push(p, at + q, 1.8, vel(layer.velocity - (q % 2) * 4, rng));
        }
        break;
      }
      case 'backbeat': {
        if (held) {
          push(36, at, 1, vel(layer.velocity + 2, rng)); // final kick
          push(49, at, 2, vel(layer.velocity - 4, rng)); // crash, let ring
          break;
        }
        for (let q = 0; q < B; q++) {
          push(q % 2 === 0 ? 36 : 38, at + q, 0.25, vel(layer.velocity + (q % 2 === 0 ? 2 : -2), rng));
        }
        for (let t = 0; t < B * 2; t++) {
          push(42, at + t * 0.5, 0.25, vel(layer.velocity - (t % 2 === 0 ? 6 : 10), rng));
        }
        break;
      }
      default: // roles are module-internal — reaching this is a programming error, not bad input
        throw invalid(`internal: unknown layer role "${layer.role}"`);
    }
  });

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { ...(layer.drums ? { drums: true } : { program: layer.program }), notes };
}

/* -------------------------------- compile --------------------------------- */

// Enough for ~4 minutes of 4/4 at 120 bpm; also what keeps the densest style
// (drive, ~12 notes/beat across its layers) far under music-node's MAX_NOTES.
const MAX_BARS = 128;
const MAX_BEATS = 512;
const MAX_PROGRESSION = 64;

/**
 * Compile `{ bpm?, progression, style?, bars?, beatsPerBar?, key?, layers?,
 * seed? }` into the note-level `{ bpm, tracks }` spec both music vendors
 * accept, plus a `meta` block (`{ style, bars, beatsPerBar, key?, chords,
 * notes, seed, layers }`) describing what was compiled. Extra keys on the
 * result are harmless downstream: validateMusicSpec reads only bpm + tracks.
 *
 * The progression cycles one chord per bar across `bars` (default: one bar
 * per chord, once through), then one extra bar holds the close — the key's
 * tonic when a key is known, else the opening chord. `meta.chords` counts
 * that closing bar, which is why it is `bars + 1`.
 *
 * @throws EngineError INVALID_MUSIC_SPEC naming the offending chord / style /
 *         layer and listing the valid options
 */
export function compileTheorySpec(spec) {
  if (!spec || typeof spec !== 'object') throw invalid('spec must be an object');
  const { bpm = 120, progression, style: styleName = 'pad', beatsPerBar = 4, key, layers, seed = 1 } = spec;

  if (!Array.isArray(progression) || progression.length === 0) {
    throw invalid("progression: a non-empty array of chord symbols is required — e.g. ['D', 'A', 'Bm', 'G'] or ['I', 'V', 'vi', 'IV'] with key");
  }
  if (progression.length > MAX_PROGRESSION) {
    throw invalid(`progression: at most ${MAX_PROGRESSION} chords (got ${progression.length})`);
  }
  const bars = spec.bars ?? progression.length;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 1 || bpm > 400) {
    throw invalid(`bpm: number in 1..400 required (got ${bpm})`);
  }
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) {
    throw invalid(`bars: integer in 1..${MAX_BARS} required (got ${spec.bars})`);
  }
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 2 || beatsPerBar > 12) {
    throw invalid(`beatsPerBar: integer in 2..12 required (got ${beatsPerBar})`);
  }
  if (bars * beatsPerBar > MAX_BEATS) {
    throw invalid(`bars × beatsPerBar must stay ≤ ${MAX_BEATS} beats (got ${bars} × ${beatsPerBar} = ${bars * beatsPerBar})`);
  }
  if (!Number.isInteger(seed)) throw invalid(`seed: integer required (got ${seed})`);

  const style = THEORY_STYLES[styleName];
  if (!style) throw invalid(`Unknown style "${styleName}" — valid styles: ${THEORY_STYLE_NAMES.join(', ')}`, { style: styleName });

  const allLayers = Object.keys(style.layers);
  let layerNames = allLayers;
  if (layers !== undefined) {
    if (!Array.isArray(layers) || layers.length === 0) {
      throw invalid(`layers: a non-empty array of layer names is required when given — style "${styleName}" has: ${allLayers.join(', ')}`);
    }
    for (const name of layers) {
      if (!allLayers.includes(name)) {
        throw invalid(`Style "${styleName}" has no layer "${name}" — its layers: ${allLayers.join(', ')}`, { style: styleName, layer: name });
      }
    }
    layerNames = allLayers.filter((n) => layers.includes(n)); // definition order, not caller order
  }

  const parsedKey = key !== undefined ? parseKey(key) : null;
  const chords = progression.map((c) => parseChord(c, { key: parsedKey ?? undefined }));

  const slots = [];
  for (let b = 0; b < bars; b++) slots.push(chords[b % chords.length]);
  slots.push(parsedKey
    ? {
      symbol: parsedKey.name,
      rootPc: parsedKey.tonicPc,
      quality: parsedKey.minor ? 'm' : 'major',
      intervals: QUALITIES[parsedKey.minor ? 'm' : ''],
      bassPc: null,
    }
    : chords[0]);

  const voicings = voiceLead(slots);
  const rng = mulberry32(seed);
  const tracks = layerNames.map((name) => renderLayer(style.layers[name], { slots, voicings, beatsPerBar, rng }));
  const notes = tracks.reduce((s, t) => s + t.notes.length, 0);

  return {
    bpm,
    tracks,
    meta: {
      style: styleName,
      bars,
      beatsPerBar,
      ...(parsedKey ? { key: parsedKey.name } : {}),
      chords: slots.length,
      notes,
      seed,
      layers: layerNames,
    },
  };
}
