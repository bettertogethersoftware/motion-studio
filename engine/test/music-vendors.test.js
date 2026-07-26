/**
 * Music vendors (v0.17): the in-process `node` renderer, the shared level
 * control, vendor dispatch, and the Studio's music vendor API.
 *
 * The synth is real — rendered against the tiny built-in soundbank
 * (helpers/tiny-soundfont.mjs) rather than a stub — so these tests cover the
 * actual spec→MIDI→audio path, not a mock of it. No 39 MB SoundFont, no exe.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStudioServer } from '../src/studio/server.js';
import { ProjectStore } from '../src/core/project.js';
import { JobManager } from '../src/core/jobs.js';
import {
  synthesizeNodeMusic, checkNodeMusic, validateMusicSpec, specToMidi, MUSIC_NODE_DEFAULTS,
} from '../src/core/music-node.js';
import {
  resolveMusicVendor, checkMusicVendor, musicVendorReport, synthesizeMusicWithVendor,
  conformWavLevel, demoSpec, GM_PROGRAMS, MUSIC_VENDORS,
} from '../src/core/music-vendors.js';
import { updateSettings, readSettings, validateSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { parseWavHeader, wavDurationSeconds } from '../src/core/tts.js';
import { writeTinySoundFont } from './helpers/tiny-soundfont.mjs';

let tmp, soundfont, home, store, server, base;

const SPEC = {
  bpm: 120,
  tracks: [
    { program: 0, notes: [
      { pitch: 60, start: 0, duration: 1 },
      { pitch: 64, start: 1, duration: 1 },
      { pitch: 67, start: 2, duration: 2 },
    ] },
    { drums: true, notes: [{ pitch: 36, start: 0, duration: 0.25 }, { pitch: 38, start: 2, duration: 0.25 }] },
  ],
};

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-music-v-'));
  soundfont = await writeTinySoundFont(tmp);
  home = path.join(tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  // Point every vendor at the tiny bank, the way a user would.
  process.env.MOTION_STUDIO_SOUNDFONT = soundfont;
  delete process.env.MOTION_STUDIO_MUSIC_VENDOR;

  store = new ProjectStore(home);
  server = createStudioServer({ store, jobs: new JobManager() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const out = (name) => path.join(tmp, name);
const j = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : null, res };
};

/* ------------------------------ the spec ------------------------------ */

test('music spec: a well-formed spec normalizes velocity and counts notes', () => {
  const v = validateMusicSpec(SPEC);
  assert.equal(v.bpm, 120);
  assert.equal(v.noteCount, 5);
  assert.equal(v.tracks[0].notes[0].velocity, 96); // documented default
  assert.equal(v.tracks[1].drums, true);
});

test('music spec: every malformed field is reported, not just the first', () => {
  assert.throws(() => validateMusicSpec({
    bpm: 900,
    tracks: [{ program: 300, notes: [{ pitch: 200, start: -1, duration: 0, velocity: 0 }] }],
  }), (e) => {
    assert.equal(e.code, 'invalid_music_spec');
    const joined = e.detail.problems.join(' ');
    for (const field of ['bpm', 'program', 'pitch', 'start', 'duration', 'velocity']) {
      assert.ok(joined.includes(field), `missing ${field} in ${joined}`);
    }
    return true;
  });
});

test('music spec: an empty track list is refused', () => {
  assert.throws(() => validateMusicSpec({ bpm: 120, tracks: [] }), (e) => e.code === 'invalid_music_spec');
});

test('specToMidi: drums land on channel 10 and melodic tracks skip it', async () => {
  const { midi, tracks, notes, musicalDurationSeconds } = await specToMidi(SPEC);
  assert.equal(tracks, 2);
  assert.equal(notes, 5);
  // 4 beats at 120bpm = 2s of notes.
  assert.equal(Math.round(musicalDurationSeconds * 100) / 100, 2);
  const bytes = midi.writeMIDI(); // an ArrayBuffer
  assert.ok(bytes.byteLength > 40, 'a MIDI file should have been written');
  const head = Buffer.from(bytes).toString('ascii', 0, 4);
  assert.equal(head, 'MThd', 'and it should be a real Standard MIDI File');
});

/* ---------------------------- the node vendor ---------------------------- */

test('node vendor: probes available with a real soundbank', async () => {
  const probe = await checkNodeMusic({ soundfont });
  assert.equal(probe.available, true, probe.error);
  assert.equal(probe.config.library, 'spessasynth_core');
});

test('node vendor: a missing soundfont is music_unavailable, with the fix in the message', async () => {
  const probe = await checkNodeMusic({ soundfont: path.join(tmp, 'nope.sf2') });
  assert.equal(probe.available, false);
  assert.match(probe.error, /MOTION_STUDIO_SOUNDFONT/);
});

test('node vendor: renders a real PCM WAV whose header outlasts the notes', async () => {
  const file = out('a.wav');
  const r = await synthesizeNodeMusic({ spec: SPEC, outPath: file, soundfont });
  assert.equal(r.tracks, 2);
  assert.equal(r.notes, 5);
  assert.equal(r.bpm, 120);
  assert.equal(r.sampleRate, MUSIC_NODE_DEFAULTS.sampleRate);

  const buf = await fsp.readFile(file);
  const info = parseWavHeader(buf, file);
  assert.equal(info.channels, 2);
  assert.equal(info.bitsPerSample, 16);
  // The WAV carries a release/reverb tail past the last note-off, exactly like
  // the fluidsynth vendor — which is why callers take duration from the header.
  const seconds = await wavDurationSeconds(file);
  assert.ok(seconds > r.musicalDurationSeconds, `${seconds} should exceed ${r.musicalDurationSeconds}`);
  assert.ok(r.peakDb < 0 && r.peakDb > -90, `peak ${r.peakDb} should be real audio`);
});

test('node vendor: the same spec renders byte-identically twice', async () => {
  const a = out('det-1.wav');
  const b = out('det-2.wav');
  await synthesizeNodeMusic({ spec: SPEC, outPath: a, soundfont });
  await synthesizeNodeMusic({ spec: SPEC, outPath: b, soundfont });
  assert.deepEqual(await fsp.readFile(a), await fsp.readFile(b));
});

test('node vendor: gain is linear, so the calibration constant is meaningful', async () => {
  const quiet = await synthesizeNodeMusic({ spec: SPEC, outPath: out('q.wav'), soundfont, gain: 0.5 });
  const loud = await synthesizeNodeMusic({ spec: SPEC, outPath: out('l.wav'), soundfont, gain: 1.0 });
  // Doubling the gain is +6.02 dB; allow a hair for 16-bit quantization.
  assert.ok(Math.abs((loud.rawPeakDb - quiet.rawPeakDb) - 6.02) < 0.2,
    `${quiet.rawPeakDb} → ${loud.rawPeakDb}`);
});

test('node vendor: targetPeakDb attenuates a hot render and never boosts a quiet one', async () => {
  // Measure what this soundbank actually gives, then aim relative to it — the
  // rule under test is "attenuate-only", not any particular absolute level.
  const natural = await synthesizeNodeMusic({ spec: SPEC, outPath: out('nat.wav'), soundfont });
  const below = Number((natural.peakDb - 6).toFixed(2));
  const above = Number((natural.peakDb + 6).toFixed(2));

  const trimmed = await synthesizeNodeMusic({ spec: SPEC, outPath: out('hot.wav'), soundfont, targetPeakDb: below });
  assert.ok(trimmed.gainAppliedDb < 0, 'a render above the target should have been attenuated');
  assert.ok(Math.abs(trimmed.peakDb - below) < 0.1, `landed at ${trimmed.peakDb}, wanted ${below}`);

  const left = await synthesizeNodeMusic({ spec: SPEC, outPath: out('quiet.wav'), soundfont, targetPeakDb: above });
  assert.equal(left.gainAppliedDb, 0, 'a render below the target must be left alone, never boosted');
  assert.ok(left.peakDb < above);
});

/* ----------------------------- level control ----------------------------- */

test('conformWavLevel: measures, attenuates in place, and reports honestly', async () => {
  const file = out('level.wav');
  const rendered = await synthesizeNodeMusic({ spec: SPEC, outPath: file, soundfont });
  const target = Number((rendered.peakDb - 6).toFixed(2));

  const level = await conformWavLevel(file, target);
  assert.ok(Math.abs(level.peakDb - target) < 0.2, `landed at ${level.peakDb}, wanted ${target}`);
  assert.ok(level.gainAppliedDb < 0);
  // What it reports is what is on disk — re-measuring agrees.
  assert.ok(Math.abs((await conformWavLevel(file, null)).peakDb - level.peakDb) < 0.01);

  // Idempotent: conforming an already-conformed file changes nothing.
  const again = await conformWavLevel(file, target);
  assert.equal(again.gainAppliedDb, 0);
});

test('conformWavLevel: a null target measures without touching the file', async () => {
  const file = out('untouched.wav');
  await synthesizeNodeMusic({ spec: SPEC, outPath: file, soundfont, gain: 4 });
  const bytes = await fsp.readFile(file);
  const level = await conformWavLevel(file, null);
  assert.equal(level.gainAppliedDb, 0);
  assert.deepEqual(await fsp.readFile(file), bytes);
  assert.ok(level.peakDb < 0);
});

/* ------------------------------- dispatch -------------------------------- */

test('music vendors: "node" is the default — the cross-platform one wins', async () => {
  const resolved = await resolveMusicVendor({ dataDir: home });
  assert.deepEqual(resolved, { vendor: 'node', source: 'default', chain: ['node'] });
});

test('music vendors: env overrides settings, an argument overrides both', async () => {
  await updateSettings({ music: { vendor: 'node' } }, home);
  assert.deepEqual(await resolveMusicVendor({ dataDir: home }), { vendor: 'node', source: 'settings', chain: ['node'] });
  process.env.MOTION_STUDIO_MUSIC_VENDOR = 'fluidsynth';
  try {
    assert.deepEqual(await resolveMusicVendor({ dataDir: home }),
      { vendor: 'fluidsynth', source: 'env', chain: ['fluidsynth'] });
    assert.deepEqual(await resolveMusicVendor({ vendor: 'node', dataDir: home }),
      { vendor: 'node', source: 'argument', chain: ['node'] });
  } finally {
    delete process.env.MOTION_STUDIO_MUSIC_VENDOR;
  }
});

test('music vendors: an unknown vendor is invalid_config, never a fallback', async () => {
  await assert.rejects(resolveMusicVendor({ vendor: 'timidity', dataDir: home }), (e) => e.code === 'invalid_config');
  await assert.rejects(checkMusicVendor('timidity', { dataDir: home }), (e) => e.code === 'invalid_config');
});

test('music vendors: the report covers both vendors and names the active one', async () => {
  const report = await musicVendorReport({ dataDir: home });
  assert.equal(report.capability, 'music');
  assert.deepEqual(report.vendors.map((v) => v.id), MUSIC_VENDORS);
  const node = report.vendors.find((v) => v.id === 'node');
  assert.equal(node.available, true, node.error);
  assert.equal(node.active, true);
  assert.equal(node.config.soundfont, soundfont);
});

test('music vendors: synthesizing through the dispatcher tags the vendor and level', async () => {
  const r = await synthesizeMusicWithVendor({ vendor: 'node', spec: SPEC, outPath: out('d.wav'), dataDir: home });
  assert.equal(r.vendor, 'node');
  assert.equal(r.vendorSource, 'argument');
  assert.equal(r.targetPeakDb, -3); // the shipped default
  assert.ok(typeof r.peakDb === 'number');
});

test('music vendors: a bad spec fails the same way whichever vendor is named', async () => {
  for (const vendor of MUSIC_VENDORS) {
    await assert.rejects(
      synthesizeMusicWithVendor({ vendor, spec: { bpm: 120, tracks: [] }, outPath: out('x.wav'), dataDir: home }),
      (e) => e.code === 'invalid_music_spec' || e.code === 'music_unavailable',
      `vendor ${vendor}`,
    );
  }
});

test('music vendors: an unusable vendor names one that works', async () => {
  const saved = process.env.MOTION_STUDIO_SOUNDFONT;
  process.env.MOTION_STUDIO_SOUNDFONT = path.join(tmp, 'gone.sf2');
  try {
    await assert.rejects(
      synthesizeMusicWithVendor({ vendor: 'node', spec: SPEC, outPath: out('y.wav'), dataDir: home }),
      (e) => {
        assert.equal(e.code, 'music_unavailable');
        assert.match(e.message, /do not retry blindly/);
        return true;
      },
    );
  } finally {
    process.env.MOTION_STUDIO_SOUNDFONT = saved;
  }
});

/* -------------------------------- settings -------------------------------- */

test('settings: music.targetPeakDb cannot ask for a boost', () => {
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, music: { ...DEFAULT_SETTINGS.music, targetPeakDb: 3 } }),
    (e) => e.code === 'invalid_config',
  );
});

test('settings: patching one music field keeps the others', async () => {
  await updateSettings({ music: { node: { gain: 1.2 } } }, home);
  await updateSettings({ music: { targetPeakDb: -6 } }, home);
  const s = await readSettings(home);
  assert.equal(s.music.node.gain, 1.2);
  assert.equal(s.music.targetPeakDb, -6);
  await updateSettings({ music: { targetPeakDb: -3, node: { gain: DEFAULT_SETTINGS.music.node.gain } } }, home);
});

/* ------------------------ favorite programs (v0.22) ------------------------ */

test('settings: favoritePrograms round-trips through save and read', async () => {
  await updateSettings({ music: { favoritePrograms: [19, 30, 118] } }, home);
  const s = await readSettings(home);
  assert.deepEqual(s.music.favoritePrograms, [19, 30, 118]);
  // The vendor report carries them to list_vendors / the Studio verbatim.
  const report = await musicVendorReport({ dataDir: home, probe: false });
  assert.deepEqual(report.settings.favoritePrograms, [19, 30, 118]);
  await updateSettings({ music: { favoritePrograms: null } }, home);
  assert.equal((await readSettings(home)).music.favoritePrograms, null);
});

test('settings: favoritePrograms refuses out-of-range programs and duplicates', () => {
  for (const bad of [[128], [-1], [1.5], ['piano'], [19, 19]]) {
    assert.throws(
      () => validateSettings({ ...DEFAULT_SETTINGS, music: { ...DEFAULT_SETTINGS.music, favoritePrograms: bad } }),
      (e) => e.code === 'invalid_config',
      `expected invalid_config for ${JSON.stringify(bad)}`,
    );
  }
  // Empty array = "un-starred everything" — allowed.
  validateSettings({ ...DEFAULT_SETTINGS, music: { ...DEFAULT_SETTINGS.music, favoritePrograms: [] } });
});

/* ------------------------------ studio routes ----------------------------- */

test('studio: GET /api/vendors reports speech and music side by side', async () => {
  const { status, data } = await j('/api/vendors');
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.speech.capability, 'speech');
  assert.equal(data.music.capability, 'music');
  assert.equal(data.music.active, 'node');
  assert.equal(data.gmPrograms.length, 128);
  assert.equal(data.gmPrograms[48], GM_PROGRAMS[48]);
});

test('studio: the music preview renders the demo phrase on the chosen instrument', async () => {
  const { res } = await j('/api/vendors/music/node/preview', { method: 'POST', body: { program: 48 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(res.headers.get('x-music-vendor'), 'node');
  assert.ok(Number(res.headers.get('x-music-duration')) > 0);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
});

test('studio: the music preview refuses a non-GM program', async () => {
  const { status, data } = await j('/api/vendors/music/node/preview', { method: 'POST', body: { program: 999 } });
  assert.equal(status, 400);
  assert.match(data.message, /0\.\.127/);
});

test('studio: an unknown music vendor is a 400', async () => {
  const { status, data } = await j('/api/vendors/music/timidity/preview', { method: 'POST', body: {} });
  assert.equal(status, 400);
  assert.equal(data.code, 'invalid_config');
});

test('studio: PATCH /api/settings switches the music vendor', async () => {
  const patched = await j('/api/settings', {
    method: 'PATCH', body: { patch: { music: { vendor: 'fluidsynth' } } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  const { data } = await j('/api/vendors');
  assert.equal(data.music.active, 'fluidsynth');
  await j('/api/settings', { method: 'PATCH', body: { patch: { music: { vendor: 'node' } } } });
});

test('demoSpec: the audition phrase is a valid spec for any instrument', () => {
  for (const program of [0, 48, 127]) {
    const v = validateMusicSpec(demoSpec({ program }));
    assert.ok(v.noteCount > 0);
  }
  assert.equal(validateMusicSpec(demoSpec({ drums: true })).tracks[0].drums, true);
});
