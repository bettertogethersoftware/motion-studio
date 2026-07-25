/**
 * Speech vendors (v0.17) — the dispatch layer and the Studio's vendors page API.
 *
 * Both vendors are stubbed: the system vendor by the fake exe
 * (helpers/fake-tts.mjs) and the Azure vendor by a local HTTP stand-in
 * (helpers/fake-azure-speech.mjs), wired in through the same env hooks a user
 * would set. Nothing here touches the network or a real subscription.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStudioServer } from '../src/studio/server.js';
import { ProjectStore } from '../src/core/project.js';
import { JobManager } from '../src/core/jobs.js';
import {
  resolveSpeechVendor, checkSpeechVendor, synthesizeWithVendor, listSpeechVoices, speechVendorReport, filterVoices,
} from '../src/core/tts-vendors.js';
import { updateSettings, readSettings, validateSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { clearAzureVoiceCache } from '../src/core/tts-azure.js';
import { startFakeAzure } from './helpers/fake-azure-speech.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_TTS = path.resolve(__dirname, 'helpers/fake-tts.mjs');

let server, base, fakeAzure, home, store;

before(async () => {
  fakeAzure = await startFakeAzure();
  // The vendor reads these at call time, exactly as it would on the user's box.
  process.env.MOTION_STUDIO_TTS_EXE = FAKE_TTS;
  process.env.AZURE_SPEECH_KEY = 'test-key';
  process.env.AZURE_SPEECH_ENDPOINT = fakeAzure.url;
  delete process.env.MOTION_STUDIO_TTS_VENDOR;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.MOTION_STUDIO_AZURE_SPEECH_KEY;
  delete process.env.MOTION_STUDIO_AZURE_SPEECH_REGION;
  delete process.env.MOTION_STUDIO_AZURE_SPEECH_VOICE;

  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-vendors-'));
  store = new ProjectStore(home);
  server = createStudioServer({ store, jobs: new JobManager() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fakeAzure.close();
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => clearAzureVoiceCache());

const j = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : null, res };
};

/* ------------------------------ core dispatch ----------------------------- */

test('vendors: the default vendor is "system" — adding Azure does not silently start billing', async () => {
  const resolved = await resolveSpeechVendor({ dataDir: home });
  assert.equal(resolved.vendor, 'system');
});

test('vendors: MOTION_STUDIO_TTS_VENDOR overrides settings, an argument overrides both', async () => {
  await updateSettings({ tts: { vendor: 'system' } }, home);
  process.env.MOTION_STUDIO_TTS_VENDOR = 'azure';
  try {
    assert.deepEqual(await resolveSpeechVendor({ dataDir: home }), { vendor: 'azure', source: 'env' });
    assert.deepEqual(await resolveSpeechVendor({ vendor: 'system', dataDir: home }), { vendor: 'system', source: 'argument' });
  } finally {
    delete process.env.MOTION_STUDIO_TTS_VENDOR;
  }
});

test('vendors: an unknown vendor is invalid_config, not a silent fallback', async () => {
  await assert.rejects(resolveSpeechVendor({ vendor: 'elevenlabs', dataDir: home }), (e) => e.code === 'invalid_config');
});

test('vendors: both stubs probe as available', async () => {
  const report = await speechVendorReport({ dataDir: home });
  const byId = Object.fromEntries(report.vendors.map((v) => [v.id, v]));
  assert.equal(byId.system.available, true);
  assert.equal(byId.azure.available, true);
  assert.equal(byId.azure.voiceCount, 3);
  assert.deepEqual(byId.azure.locales, ['en-GB', 'en-US', 'zh-TW']);
  // The report is safe to hand to a browser page or an agent.
  assert.equal(JSON.stringify(report).includes('test-key'), false);
  assert.equal(byId.azure.config.keyMasked, '••••-key');
});

test('vendors: the system vendor warns instead of silently dropping Azure-only options', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-vendor-syn-'));
  try {
    const res = await synthesizeWithVendor({
      vendor: 'system', text: 'hello', outPath: path.join(dir, 'a.wav'), style: 'cheerful', dataDir: home,
    });
    assert.equal(res.vendor, 'system');
    assert.equal(res.ok, true);
    assert.match(res.warnings.join(' '), /"style" is an Azure-only option/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('vendors: synthesizing through azure returns the same payload shape as the exe vendor', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-vendor-syn-'));
  try {
    const res = await synthesizeWithVendor({
      vendor: 'azure', text: 'hello', outPath: path.join(dir, 'a.wav'), voice: 'en-GB-RyanNeural', dataDir: home,
    });
    for (const key of ['ok', 'voice', 'durationSeconds', 'sampleRate', 'channels', 'bytes', 'outPath']) {
      assert.ok(key in res, `azure payload is missing ${key}`);
    }
    assert.equal(res.vendor, 'azure');
    assert.equal(res.voice, 'en-GB-RyanNeural');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('vendors: listSpeechVoices filters by locale and pages', async () => {
  const all = await listSpeechVoices({ vendor: 'azure', dataDir: home });
  assert.equal(all.total, 3);
  const en = await listSpeechVoices({ vendor: 'azure', locale: 'en', dataDir: home });
  assert.equal(en.total, 2);
  const one = await listSpeechVoices({ vendor: 'azure', limit: 1, dataDir: home });
  assert.equal(one.voices.length, 1);
  assert.equal(one.truncated, true);
});

test('vendors: filterVoices searches name, locale name and gender', () => {
  const voices = [
    { name: 'en-US-AvaNeural', displayName: 'Ava', locale: 'en-US', localeName: 'English (United States)', gender: 'Female' },
    { name: 'de-DE-KatjaNeural', displayName: 'Katja', locale: 'de-DE', localeName: 'German (Germany)', gender: 'Female' },
  ];
  assert.equal(filterVoices(voices, { search: 'katja' }).total, 1);
  assert.equal(filterVoices(voices, { search: 'female' }).total, 2);
  assert.equal(filterVoices(voices, { locale: 'de' }).total, 1);
});

/* -------------------------------- settings -------------------------------- */

test('settings: tts.vendor must be a known vendor', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, tts: { vendor: 'nope', azure: DEFAULT_SETTINGS.tts.azure } }),
    (e) => e.code === 'invalid_config');
});

test('settings: an Azure key is refused rather than stored', async () => {
  await assert.rejects(
    updateSettings({ tts: { azure: { key: 'secret' } } }, home),
    (e) => e.code === 'invalid_config' && /environment only/.test(e.message),
  );
});

test('settings: a non-WAV output format is refused', async () => {
  await assert.rejects(
    updateSettings({ tts: { azure: { outputFormat: 'audio-24khz-96kbitrate-mono-mp3' } } }, home),
    (e) => e.code === 'invalid_config',
  );
});

test('settings: patching one azure field keeps the others', async () => {
  await updateSettings({ tts: { azure: { voice: 'en-US-AvaNeural' } } }, home);
  await updateSettings({ tts: { azure: { region: 'eastus' } } }, home);
  const s = await readSettings(home);
  assert.equal(s.tts.azure.voice, 'en-US-AvaNeural');
  assert.equal(s.tts.azure.region, 'eastus');
  await updateSettings({ tts: { vendor: 'system', azure: { voice: null, region: null } } }, home);
});

/* ------------------------------ studio routes ----------------------------- */

test('studio: GET /api/vendors reports both vendors and the active one', async () => {
  const { status, data } = await j('/api/vendors');
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.speech.active, 'system');
  assert.deepEqual(data.speech.vendors.map((v) => v.id), ['system', 'azure']);
  assert.ok(data.azure.outputFormats.includes('riff-24khz-16bit-mono-pcm'));
  assert.equal(JSON.stringify(data).includes('test-key'), false);
});

test('studio: GET /api/vendors?probe=0 skips the probes', async () => {
  const { data } = await j('/api/vendors?probe=0');
  assert.equal(data.speech.vendors[0].available, null);
});

test('studio: voice listing filters and pages', async () => {
  const { status, data } = await j('/api/vendors/speech/azure/voices?locale=en-GB');
  assert.equal(status, 200);
  assert.equal(data.total, 1);
  assert.equal(data.voices[0].name, 'en-GB-RyanNeural');

  const sys = await j('/api/vendors/speech/system/voices');
  assert.equal(sys.data.voices[0].name, 'Microsoft David Desktop');
});

test('studio: an unknown vendor is a 400, not a 404 or a crash', async () => {
  const { status, data } = await j('/api/vendors/speech/elevenlabs/voices');
  assert.equal(status, 400);
  assert.equal(data.code, 'invalid_config');
});

test('studio: the preview endpoint returns playable WAV bytes with the voice that spoke', async () => {
  const { res } = await j('/api/vendors/speech/azure/preview', {
    method: 'POST',
    body: { text: 'Scene one, take one.', voice: 'en-US-AvaNeural' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(decodeURIComponent(res.headers.get('x-speech-voice')), 'en-US-AvaNeural');
  assert.equal(res.headers.get('x-speech-duration'), '1.000');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
});

test('studio: preview through the system vendor works the same way', async () => {
  const { res } = await j('/api/vendors/speech/system/preview', { method: 'POST', body: { text: 'take one' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-speech-vendor'), 'system');
});

test('studio: preview refuses an essay (it is an audition, not a render)', async () => {
  const { status, data } = await j('/api/vendors/speech/azure/preview', {
    method: 'POST', body: { text: 'x'.repeat(401) },
  });
  assert.equal(status, 400);
  assert.match(data.message, /400 characters/);
});

test('studio: an unconfigured vendor answers 503 with a fixable message', async () => {
  const saved = process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_KEY;
  clearAzureVoiceCache();
  try {
    const { status, data } = await j('/api/vendors/speech/azure/preview', { method: 'POST', body: { text: 'hi' } });
    assert.equal(status, 503);
    assert.equal(data.code, 'tts_unavailable');
    assert.match(data.message, /AZURE_SPEECH_KEY/);
  } finally {
    process.env.AZURE_SPEECH_KEY = saved;
    clearAzureVoiceCache();
  }
});

test('studio: PATCH /api/settings switches the active vendor', async () => {
  const patched = await j('/api/settings', {
    method: 'PATCH',
    body: { patch: { tts: { vendor: 'azure', azure: { voice: 'en-GB-RyanNeural' } } } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal(patched.data.settings.tts.vendor, 'azure');

  const { data } = await j('/api/vendors');
  assert.equal(data.speech.active, 'azure');
  assert.equal(data.speech.settings.azure.voice, 'en-GB-RyanNeural');

  // …and the configured voice is what an unqualified preview now speaks with.
  const { res } = await j('/api/vendors/speech/azure/preview', { method: 'POST', body: { text: 'take two' } });
  assert.equal(decodeURIComponent(res.headers.get('x-speech-voice')), 'en-GB-RyanNeural');

  await j('/api/settings', { method: 'PATCH', body: { patch: { tts: { vendor: 'system' } } } });
});

test('studio: the settings environment report masks the key', async () => {
  const { data } = await j('/api/settings');
  const env = data.environment.env;
  assert.equal(env.AZURE_SPEECH_KEY, '••••-key');
  assert.equal(env.AZURE_SPEECH_ENDPOINT, fakeAzure.url); // not a secret: shown in full
  assert.equal(JSON.stringify(data).includes('test-key'), false);
});
