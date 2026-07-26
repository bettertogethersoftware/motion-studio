/**
 * Piper speech vendor (v0.18): command/voice resolution, the voices folder,
 * the rate→--length-scale mapping, and the CLI round-trip against the stub
 * (helpers/fake-piper.mjs).
 *
 * The stub records the argv it was given, so the tests can assert the two
 * things that are easy to get wrong and impossible to see afterwards: that
 * --no-normalize is always passed (Piper otherwise slams every line to full
 * scale) and that rate reaches the CLI as a length scale.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolvePiper, piperCandidates, listPiperVoices, describePiperVoice, pickPiperVoice, checkPiperTts,
  synthesizePiperSpeech, lengthScaleForRate, PIPER_ENV,
} from '../src/core/tts-piper.js';
import { checkSpeechVendor, synthesizeWithVendor, speechVendorReport } from '../src/core/tts-vendors.js';
import { wavDurationSeconds } from '../src/core/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PIPER = path.resolve(__dirname, 'helpers/fake-piper.mjs');

/** A voice on disk is an .onnx plus its .onnx.json; the stub never reads them. */
async function writeVoice(dir, name, config = {}) {
  await fsp.writeFile(path.join(dir, `${name}.onnx`), 'not really an onnx model');
  await fsp.writeFile(path.join(dir, `${name}.onnx.json`), JSON.stringify({
    audio: { sample_rate: 16000, quality: name.split('-')[2] ?? 'low' },
    language: { code: name.split('-')[0], name_english: 'English', country_english: 'United States' },
    num_speakers: 1,
    ...config,
  }));
}

let tmp, voicesDir, home;
const PIPER_VARS = [...PIPER_ENV.exe, ...PIPER_ENV.python, ...PIPER_ENV.voices, 'MOTION_STUDIO_TTS_VENDOR'];
let savedEnv;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-piper-'));
  voicesDir = path.join(tmp, 'voices');
  home = path.join(tmp, 'home');
  await fsp.mkdir(voicesDir, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await writeVoice(voicesDir, 'en_US-lessac-low');
  await writeVoice(voicesDir, 'de_DE-thorsten-medium', {
    language: { code: 'de_DE', name_english: 'German', country_english: 'Germany' },
  });
  // A model with no sidecar: Piper cannot load it, so it must not be offered.
  await fsp.writeFile(path.join(voicesDir, 'orphan-voice.onnx'), 'no config beside me');
});

after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

beforeEach(() => {
  savedEnv = Object.fromEntries(PIPER_VARS.map((k) => [k, process.env[k]]));
  for (const k of PIPER_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const withStub = (extra = {}) => ({ exe: FAKE_PIPER, voicesDir, ...extra });

/* ------------------------------- resolution ------------------------------- */

test('resolvePiper: argument beats env beats settings', () => {
  process.env.MOTION_STUDIO_PIPER_EXE = '/from/env/piper';
  const fromEnv = resolvePiper({ piper: { exe: '/from/settings/piper' } });
  assert.equal(fromEnv.command, '/from/env/piper');
  assert.equal(fromEnv.source, 'MOTION_STUDIO_PIPER_EXE');

  const fromArg = resolvePiper({ exe: '/from/arg/piper', piper: { exe: '/from/settings/piper' } });
  assert.equal(fromArg.command, '/from/arg/piper');
  assert.equal(fromArg.source, 'argument');

  delete process.env.MOTION_STUDIO_PIPER_EXE;
  assert.equal(resolvePiper({ piper: { exe: '/from/settings/piper' } }).command, '/from/settings/piper');
});

test('resolvePiper: a configured Python runs the module form, and PATH is the last resort', () => {
  const viaPython = resolvePiper({ python: 'C:/py/python.exe' });
  assert.equal(viaPython.command, 'C:/py/python.exe');
  assert.deepEqual(viaPython.argv, ['-m', 'piper']);

  const bare = resolvePiper({});
  assert.equal(bare.command, 'piper');
  assert.deepEqual(bare.argv, []);
  assert.equal(bare.source, 'PATH');
});

test('piperCandidates: an unconfigured PATH resolution falls back to python -m piper', () => {
  // pip on Windows routinely installs piper.exe into a Scripts folder that is
  // not on PATH; the module is still importable, so a bare install must work.
  const cands = piperCandidates(resolvePiper({}));
  assert.deepEqual(
    cands.map((c) => [c.command, ...c.argv].join(' ')),
    ['piper', 'python -m piper', 'py -m piper'],
  );
});

test('piperCandidates: a configured command never falls back', () => {
  // A user who named a binary meant it — no silent substitution.
  assert.equal(piperCandidates(resolvePiper({ exe: 'C:/x/piper.exe' })).length, 1);
  process.env.MOTION_STUDIO_PIPER_PYTHON = 'C:/py/python.exe';
  assert.equal(piperCandidates(resolvePiper({})).length, 1);
});

test('lengthScaleForRate matches the Azure rate scale and stays bounded', () => {
  assert.equal(lengthScaleForRate(0), 1);        // natural pace
  assert.equal(lengthScaleForRate(10), 0.5);     // twice the speed
  assert.equal(lengthScaleForRate(3), 0.7692);   // +30% speed
  assert.equal(lengthScaleForRate(-5), 2);       // half the speed
  // No singularity at the bottom of the scale, and no ten-times-slower narrator.
  assert.equal(lengthScaleForRate(-10), 3);
  assert.equal(lengthScaleForRate(-100), 3);
});

/* --------------------------------- voices --------------------------------- */

test('describePiperVoice parses the {locale}-{speaker}-{quality} convention', () => {
  const v = describePiperVoice('en_US-lessac-medium');
  assert.equal(v.name, 'en_US-lessac-medium');
  assert.equal(v.locale, 'en-US');
  assert.equal(v.quality, 'medium');
  assert.match(v.displayName, /lessac/);
  assert.deepEqual(v.styles, []); // shape matches the other vendors' voices
});

test('listPiperVoices reads the folder and skips a model with no config', async () => {
  const voices = await listPiperVoices(voicesDir);
  assert.deepEqual(voices.map((v) => v.name), ['de_DE-thorsten-medium', 'en_US-lessac-low']);
  assert.equal(voices.find((v) => v.name.startsWith('de')).locale, 'de-DE');
  assert.equal(voices[1].sampleRate, 16000);
  assert.ok(voices.every((v) => v.modelPath.endsWith('.onnx')));
});

test('listPiperVoices returns nothing for a folder that is not there', async () => {
  assert.deepEqual(await listPiperVoices(path.join(tmp, 'nope')), []);
});

test('pickPiperVoice refuses an unknown voice with suggestions rather than substituting', async () => {
  const voices = await listPiperVoices(voicesDir);
  assert.equal(pickPiperVoice(undefined, voices).name, 'de_DE-thorsten-medium'); // first, deterministically
  assert.equal(pickPiperVoice('en_US-lessac-low', voices).name, 'en_US-lessac-low');
  assert.throws(() => pickPiperVoice('en_US-nope-high', voices), (e) => {
    assert.equal(e.code, 'unsupported_voice');
    assert.ok(e.detail.suggestions.includes('en_US-lessac-low'));
    return true;
  });
});

/* -------------------------------- the probe ------------------------------- */

test('checkPiperTts reports available with the stub and a stocked folder', async () => {
  const probe = await checkPiperTts(withStub());
  assert.equal(probe.available, true, probe.error);
  assert.equal(probe.voices.length, 2);
  assert.equal(probe.config.voiceCount, 2);
});

test('checkPiperTts: installed but no voices is unavailable, and says how to fix it', async () => {
  const empty = path.join(tmp, 'empty-voices');
  await fsp.mkdir(empty, { recursive: true });
  const probe = await checkPiperTts(withStub({ voicesDir: empty }));
  assert.equal(probe.available, false);
  assert.match(probe.error, /huggingface\.co\/rhasspy\/piper-voices/);
  assert.match(probe.error, new RegExp(PIPER_ENV.voices[0]));
});

test('checkPiperTts: a missing command is unavailable, not an exception', async () => {
  const probe = await checkPiperTts({ exe: path.join(tmp, 'no-such-piper.exe'), voicesDir });
  assert.equal(probe.available, false);
  assert.match(probe.error, /pip install piper-tts/);
});

/* ------------------------------- synthesis -------------------------------- */

const argsFor = async (out) => JSON.parse(await fsp.readFile(`${out}.args.json`, 'utf8'));

test('synthesizePiperSpeech writes a PCM WAV and reports the header duration', async () => {
  const out = path.join(tmp, 'a.wav');
  const res = await synthesizePiperSpeech({
    text: 'Rome was not built in a day.', outPath: out, voice: 'en_US-lessac-low', ...withStub(),
  });
  assert.equal(res.ok, true);
  assert.equal(res.vendor, 'piper');
  assert.equal(res.voice, 'en_US-lessac-low');
  assert.equal(res.locale, 'en-US');
  assert.equal(res.sampleRate, 16000);
  assert.equal(res.channels, 1);
  assert.equal(await wavDurationSeconds(out), 1);
});

test('synthesizePiperSpeech always passes --no-normalize', async () => {
  const out = path.join(tmp, 'b.wav');
  await synthesizePiperSpeech({ text: 'level check', outPath: out, ...withStub() });
  // Without this, Piper normalizes every line to 0 dBFS and the mix balance
  // downstream becomes fiction.
  assert.ok((await argsFor(out)).includes('--no-normalize'));
});

test('synthesizePiperSpeech maps rate onto --length-scale and volume onto --volume', async () => {
  const out = path.join(tmp, 'c.wav');
  await synthesizePiperSpeech({ text: 'faster please', outPath: out, rate: 3, volume: 80, ...withStub() });
  const args = await argsFor(out);
  assert.equal(args[args.indexOf('--length-scale') + 1], '0.7692');
  assert.equal(args[args.indexOf('--volume') + 1], '0.8');
});

test('synthesizePiperSpeech sends the text as a file, never as an argument', async () => {
  const out = path.join(tmp, 'd.wav');
  const text = 'Quotes "like this", newlines\nand — dashes.';
  await synthesizePiperSpeech({ text, outPath: out, ...withStub() });
  const args = await argsFor(out);
  assert.ok(args.includes('-i'), 'text must go through --input-file');
  assert.ok(!args.some((a) => a.includes('Quotes')), 'narration must never reach argv');
});

test('synthesizePiperSpeech maps a failed run to tts_failed with the stderr tail', async () => {
  process.env.FAKE_PIPER_FAIL = 'boom';
  try {
    await assert.rejects(
      synthesizePiperSpeech({ text: 'x', outPath: path.join(tmp, 'e.wav'), ...withStub() }),
      (err) => {
        assert.equal(err.code, 'tts_failed');
        assert.match(err.message, /boom/);
        return true;
      },
    );
  } finally {
    delete process.env.FAKE_PIPER_FAIL;
  }
});

/* -------------------------------- dispatch -------------------------------- */

test('the vendor layer treats piper like any other speech vendor', async () => {
  process.env.MOTION_STUDIO_PIPER_EXE = FAKE_PIPER;
  process.env.MOTION_STUDIO_PIPER_VOICES = voicesDir;
  const status = await checkSpeechVendor('piper', { dataDir: home });
  assert.equal(status.available, true, status.error);
  assert.equal(status.voices.length, 2);

  const out = path.join(tmp, 'dispatch.wav');
  const res = await synthesizeWithVendor({
    vendor: 'piper', text: 'through the dispatcher', outPath: out, style: 'cheerful', dataDir: home,
  });
  assert.equal(res.vendor, 'piper');
  assert.equal(res.vendorSource, 'argument');
  // Azure-only options are reported, never silently dropped.
  assert.match(res.warnings.join(' '), /"style" is an Azure-only option .* piper/);
  for (const key of ['ok', 'voice', 'durationSeconds', 'sampleRate', 'channels', 'bytes', 'outPath']) {
    assert.ok(key in res, `piper payload is missing ${key}`);
  }
});

test('the speech report lists all three vendors', async () => {
  process.env.MOTION_STUDIO_PIPER_EXE = FAKE_PIPER;
  process.env.MOTION_STUDIO_PIPER_VOICES = voicesDir;
  const report = await speechVendorReport({ dataDir: home });
  assert.deepEqual(report.vendors.map((v) => v.id), ['system', 'azure', 'piper']);
  const piper = report.vendors.find((v) => v.id === 'piper');
  assert.equal(piper.available, true, piper.error);
  assert.equal(piper.offline, true, 'piper runs locally — that is its whole point');
  assert.deepEqual(piper.locales, ['de-DE', 'en-US']);
});
