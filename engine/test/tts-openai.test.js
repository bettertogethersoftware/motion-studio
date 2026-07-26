/**
 * OpenAI speech vendor (v0.20): configuration precedence, the fixed
 * model-gated voice catalogue, chunking past the 4,096-char input cap, and
 * the REST round-trip against a local stub (helpers/fake-openai-tts.mjs).
 *
 * No account, no network: every test points the vendor at the stub through the
 * same `endpoint` hook the real service is reached with.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveOpenaiConfig, checkOpenaiTts, synthesizeOpenaiSpeech, pickOpenaiVoice,
  openaiVoicesForModel, speedForRate, OPENAI_ENV, OPENAI_VOICES,
} from '../src/core/tts-openai.js';
import { synthesizeWithVendor } from '../src/core/tts-vendors.js';
import { validateSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { wavDurationSeconds } from '../src/core/tts.js';
import { startFakeOpenai } from './helpers/fake-openai-tts.mjs';

/** The machine running the tests may legitimately have a real OpenAI key set. */
const OPENAI_VARS = [...OPENAI_ENV.key, ...OPENAI_ENV.endpoint, ...OPENAI_ENV.voice];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(OPENAI_VARS.map((k) => [k, process.env[k]]));
  for (const k of OPENAI_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-openai-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

const withFake = async (fn, opts) => {
  const fake = await startFakeOpenai(opts);
  try { return await fn(fake); }
  finally { await fake.close(); }
};

/* ----------------------------- configuration ----------------------------- */

test('resolveOpenaiConfig: argument beats env beats settings, and keySource is tracked', () => {
  process.env.OPENAI_API_KEY = 'plain';
  process.env.MOTION_STUDIO_OPENAI_KEY = 'motion';
  process.env.MOTION_STUDIO_OPENAI_VOICE = 'nova';
  const cfg = resolveOpenaiConfig({ openai: { voice: 'onyx' } });
  assert.equal(cfg.key, 'motion');
  assert.equal(cfg.keySource, 'MOTION_STUDIO_OPENAI_KEY');
  assert.equal(cfg.voice, 'nova');
  assert.equal(cfg.voiceSource, 'MOTION_STUDIO_OPENAI_VOICE');

  delete process.env.MOTION_STUDIO_OPENAI_KEY;
  assert.equal(resolveOpenaiConfig().keySource, 'OPENAI_API_KEY');

  const fromArg = resolveOpenaiConfig({ voice: 'sage', openai: { voice: 'onyx' } });
  assert.equal(fromArg.voice, 'sage');
  assert.equal(fromArg.voiceSource, 'argument');

  delete process.env.MOTION_STUDIO_OPENAI_VOICE;
  const fromSettings = resolveOpenaiConfig({ openai: { voice: 'onyx', model: 'tts-1' } });
  assert.equal(fromSettings.voice, 'onyx');
  assert.equal(fromSettings.voiceSource, 'settings');
  assert.equal(fromSettings.model, 'tts-1');
});

test('resolveOpenaiConfig: the key never comes from settings, and the model defaults sensibly', () => {
  const cfg = resolveOpenaiConfig({ openai: { key: 'sneaky' } });
  assert.equal(cfg.key, null);
  assert.deepEqual(cfg.missing, ['key']);
  assert.equal(cfg.model, 'gpt-4o-mini-tts');
  assert.equal(cfg.endpoint, 'https://api.openai.com');
});

test('settings refuse a stored OpenAI key, same rule as azure', () => {
  const withOpenai = (openai) => ({
    ...structuredClone(DEFAULT_SETTINGS),
    tts: { ...structuredClone(DEFAULT_SETTINGS.tts), openai: { ...DEFAULT_SETTINGS.tts.openai, ...openai } },
  });
  assert.throws(() => validateSettings(withOpenai({ key: 'secret' })),
    (e) => e.code === 'invalid_config' && /environment only/.test(e.message));
  assert.ok(validateSettings(withOpenai({ voice: 'marin', model: 'tts-1', instructions: 'Speak warmly.' })));
});

test('checkOpenaiTts reports unavailable (not an exception) with a setup hint', async () => {
  const probe = await checkOpenaiTts({});
  assert.equal(probe.available, false);
  assert.match(probe.error, /OPENAI_API_KEY/);
  assert.match(probe.error, /setx/); // the Windows instruction the user needs
});

/* ------------------------------ voice picking ---------------------------- */

test('pickOpenaiVoice: marin by default, alloy on the legacy models', () => {
  assert.deepEqual(pickOpenaiVoice(undefined), { voice: 'marin', source: 'default' });
  assert.deepEqual(pickOpenaiVoice(undefined, { model: 'tts-1' }), { voice: 'alloy', source: 'default' });
});

test('pickOpenaiVoice enforces model compatibility for the gpt-4o-mini-tts-only voices', () => {
  assert.equal(pickOpenaiVoice('verse').voice, 'verse'); // fine on the default model
  assert.equal(pickOpenaiVoice('alloy', { model: 'tts-1' }).voice, 'alloy');
  assert.throws(() => pickOpenaiVoice('verse', { model: 'tts-1' }), (e) => {
    assert.equal(e.code, 'unsupported_voice');
    assert.match(e.message, /requires the gpt-4o-mini-tts model/);
    assert.ok(e.detail.suggestions.includes('alloy'));
    return true;
  });
  assert.ok(!openaiVoicesForModel('tts-1-hd').includes('marin'));
  assert.equal(openaiVoicesForModel('gpt-4o-mini-tts').length, OPENAI_VOICES.length);
});

test('pickOpenaiVoice rejects an unknown voice with suggestions rather than substituting', () => {
  assert.throws(() => pickOpenaiVoice('jarvis'), (e) => {
    assert.equal(e.code, 'unsupported_voice');
    assert.ok(e.detail.suggestions.length > 0);
    return true;
  });
});

test('speedForRate maps the engine scale onto the API\'s 0.25..4.0 window', () => {
  assert.equal(speedForRate(0), 1);
  assert.equal(speedForRate(3), 1.3);
  assert.equal(speedForRate(-4), 0.6);
  assert.equal(speedForRate(-10), 0.25); // 0 by arithmetic, clamped to the floor
});

/* ----------------------------- the round trip ---------------------------- */

test('checkOpenaiTts probes the model endpoint with the Bearer header', async () => {
  await withFake(async (fake) => {
    const probe = await checkOpenaiTts({ key: 'test-key', endpoint: fake.url });
    assert.equal(probe.available, true);
    assert.deepEqual(probe.voices, [...OPENAI_VOICES]);
    const get = fake.requests.find((r) => r.method === 'GET');
    assert.equal(get.path, '/v1/models/gpt-4o-mini-tts');
    assert.equal(get.headers.authorization, 'Bearer test-key');
  });
});

test('a rejected key maps to tts_unavailable, not tts_failed', async () => {
  await withFake(async (fake) => {
    const probe = await checkOpenaiTts({ key: 'wrong-key', endpoint: fake.url });
    assert.equal(probe.available, false);
    assert.equal(probe.code, 'tts_unavailable');
    assert.match(probe.error, /rejected the credentials/);
  });
});

test('synthesizeOpenaiSpeech writes a PCM WAV and sends the documented JSON body', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const out = path.join(dir, 'vo.wav');
      const res = await synthesizeOpenaiSpeech({
        text: 'Rome was not built in a day.', outPath: out, rate: 3, style: 'cheerful',
        key: 'test-key', endpoint: fake.url,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'openai');
      assert.equal(res.voice, 'marin'); // the no-config default
      assert.equal(res.model, 'gpt-4o-mini-tts');
      assert.equal(res.durationSeconds, 1);
      assert.equal(res.chunked, undefined, 'short text must not be chunked');
      assert.equal(await wavDurationSeconds(out), 1);

      const post = fake.requests.find((r) => r.method === 'POST');
      assert.equal(post.headers.authorization, 'Bearer test-key');
      const body = JSON.parse(post.body);
      assert.equal(body.model, 'gpt-4o-mini-tts');
      assert.equal(body.voice, 'marin');
      assert.equal(body.response_format, 'wav');
      assert.equal(body.speed, 1.3);
      assert.equal(body.instructions, 'Speak in a cheerful style.');
    });
  });
});

test('a legacy model omits instructions and warns instead of sending them', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const res = await synthesizeOpenaiSpeech({
        text: 'hi', outPath: path.join(dir, 'vo.wav'), model: 'tts-1', voice: 'alloy', style: 'cheerful',
        key: 'test-key', endpoint: fake.url,
      });
      assert.match(res.warnings.join(' '), /"style" needs the gpt-4o-mini-tts model/);
      const body = JSON.parse(fake.requests.find((r) => r.method === 'POST').body);
      assert.equal(body.instructions, undefined, 'legacy models must not receive the parameter at all');
    });
  });
});

test('text past the 4,096-char cap is chunked at sentence seams and joined into one WAV', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const sentence = 'All work and no play makes Jack a dull agent. ';
      const text = sentence.repeat(120).trim(); // ~5,500 chars → two chunks
      assert.ok(text.length > 4096);
      const out = path.join(dir, 'vo.wav');
      const res = await synthesizeOpenaiSpeech({ text, outPath: out, key: 'test-key', endpoint: fake.url });

      const posts = fake.requests.filter((r) => r.method === 'POST');
      assert.equal(posts.length, 2, 'two upstream requests for two chunks');
      for (const post of posts) {
        assert.ok(JSON.parse(post.body).input.length <= 4000, 'every chunk stays under the packing target');
      }
      assert.equal(res.chunked, 2);
      // Each stub clip is exactly 1.0s; the joined WAV must be their sum.
      assert.equal(res.durationSeconds, 2);
      assert.equal(await wavDurationSeconds(out), 2);
    });
  });
});

test('a rate limit maps to tts_failed (transient), not unavailable', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeOpenaiSpeech({ text: 'hi', outPath: path.join(dir, 'vo.wav'), key: 'test-key', endpoint: fake.url }),
        (e) => e.code === 'tts_failed' && /429/.test(e.message),
      );
    });
  }, { failStatus: 429 });
});

/* --------------------------- through the dispatcher ----------------------- */

test('synthesizeWithVendor: pitch/volume/deterministic warn, style is honoured', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.MOTION_STUDIO_OPENAI_ENDPOINT = fake.url;
      const res = await synthesizeWithVendor({
        vendor: 'openai', text: 'hello', outPath: path.join(dir, 'a.wav'),
        style: 'calm', pitch: 5, volume: 60, deterministic: true, dataDir: dir,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'openai');
      const joined = res.warnings.join(' ');
      assert.match(joined, /"pitch" is not supported by the openai vendor/);
      assert.match(joined, /"volume" is not supported/);
      assert.match(joined, /"deterministic" is only supported by the piper and elevenlabs vendors/);
      assert.ok(!/"style"/.test(joined), 'style maps to instructions on the default model and must not warn');
      const body = JSON.parse(fake.requests.find((r) => r.method === 'POST').body);
      assert.equal(body.instructions, 'Speak in a calm style.');
    });
  });
});
