/**
 * Deepgram speech vendor (v0.20): configuration precedence, the fixed Aura-2
 * catalogue with the new-voice pattern passthrough, chunking past the
 * 2,000-char request cap, and the REST round-trip against a local stub
 * (helpers/fake-deepgram.mjs) — including the Token-not-Bearer auth scheme.
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
  resolveDeepgramConfig, checkDeepgramTts, synthesizeDeepgramSpeech, pickDeepgramVoice,
  DEEPGRAM_ENV, DEEPGRAM_VOICES, DEEPGRAM_DEFAULT_VOICE,
} from '../src/vendors/default/speech/deepgram.js';
import { createSpeechDispatch } from '../src/core/tts-vendors.js';
import { defaultSpeechCatalog } from '../src/vendors/default/speech/catalog.js';
const { synthesizeWithVendor } = createSpeechDispatch(defaultSpeechCatalog());
import { validateSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { wavDurationSeconds } from '../src/vendors/default/speech/system.js';
import { startFakeDeepgram, FAKE_DEEPGRAM_MODELS } from './helpers/fake-deepgram.mjs';

/** The machine running the tests may legitimately have a real Deepgram key set. */
const DEEPGRAM_VARS = [...DEEPGRAM_ENV.key, ...DEEPGRAM_ENV.endpoint, ...DEEPGRAM_ENV.voice];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(DEEPGRAM_VARS.map((k) => [k, process.env[k]]));
  for (const k of DEEPGRAM_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-deepgram-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

const withFake = async (fn, opts) => {
  const fake = await startFakeDeepgram(opts);
  try { return await fn(fake); }
  finally { await fake.close(); }
};

/* ----------------------------- configuration ----------------------------- */

test('resolveDeepgramConfig: argument beats env beats settings, and keySource is tracked', () => {
  process.env.DEEPGRAM_API_KEY = 'plain';
  process.env.MOTION_STUDIO_DEEPGRAM_KEY = 'motion';
  process.env.MOTION_STUDIO_DEEPGRAM_VOICE = 'aura-2-luna-en';
  const cfg = resolveDeepgramConfig({ deepgram: { voice: 'aura-2-zeus-en' } });
  assert.equal(cfg.key, 'motion');
  assert.equal(cfg.keySource, 'MOTION_STUDIO_DEEPGRAM_KEY');
  assert.equal(cfg.keyMasked, '••••tion');
  assert.equal(cfg.voice, 'aura-2-luna-en');
  assert.equal(cfg.voiceSource, 'MOTION_STUDIO_DEEPGRAM_VOICE');

  delete process.env.MOTION_STUDIO_DEEPGRAM_KEY;
  assert.equal(resolveDeepgramConfig().keySource, 'DEEPGRAM_API_KEY');

  const fromArg = resolveDeepgramConfig({ voice: 'aura-2-mars-en', deepgram: { voice: 'aura-2-zeus-en' } });
  assert.equal(fromArg.voice, 'aura-2-mars-en');
  assert.equal(fromArg.voiceSource, 'argument');

  delete process.env.MOTION_STUDIO_DEEPGRAM_VOICE;
  const fromSettings = resolveDeepgramConfig({ deepgram: { voice: 'aura-2-zeus-en' } });
  assert.equal(fromSettings.voice, 'aura-2-zeus-en');
  assert.equal(fromSettings.voiceSource, 'settings');
});

test('resolveDeepgramConfig: the key never comes from settings', () => {
  const cfg = resolveDeepgramConfig({ deepgram: { key: 'sneaky', voice: 'aura-2-thalia-en' } });
  assert.equal(cfg.key, null);
  assert.deepEqual(cfg.missing, ['key']);
  assert.equal(cfg.endpoint, 'https://api.deepgram.com');
});

test('settings refuse a stored Deepgram key, same rule as azure', () => {
  const withDeepgram = (deepgram) => ({
    ...structuredClone(DEFAULT_SETTINGS),
    tts: { ...structuredClone(DEFAULT_SETTINGS.tts), deepgram: { ...DEFAULT_SETTINGS.tts.deepgram, ...deepgram } },
  });
  assert.throws(() => validateSettings(withDeepgram({ key: 'secret' })),
    (e) => e.code === 'invalid_config' && /environment only/.test(e.message));
  assert.ok(validateSettings(withDeepgram({ voice: 'aura-2-orion-en' })));
});

test('checkDeepgramTts reports unavailable (not an exception) with the free-tier setup hint', async () => {
  const probe = await checkDeepgramTts({});
  assert.equal(probe.available, false);
  assert.match(probe.error, /DEEPGRAM_API_KEY/);
  assert.match(probe.error, /\$200/); // the reason to pick this vendor belongs in the hint
  assert.match(probe.error, /setx/);
});

/* ------------------------------ voice picking ---------------------------- */

test('pickDeepgramVoice: thalia by default, catalogue names and bare speaker names resolve', () => {
  assert.deepEqual(pickDeepgramVoice(undefined), { voice: DEEPGRAM_DEFAULT_VOICE, source: 'default' });
  assert.equal(pickDeepgramVoice('aura-2-orion-en').voice, 'aura-2-orion-en');
  assert.equal(pickDeepgramVoice('Orion').voice, 'aura-2-orion-en'); // display name, case-insensitive
});

test('pickDeepgramVoice passes through anything matching the aura pattern — new voices ship without notice', () => {
  const picked = pickDeepgramVoice('aura-2-brandnew-es');
  assert.equal(picked.voice, 'aura-2-brandnew-es');
  assert.equal(picked.passthrough, true);
  assert.ok(!DEEPGRAM_VOICES.includes('aura-2-brandnew-es'), 'the point is that it is NOT in the list');
});

test('pickDeepgramVoice rejects a non-aura name with suggestions rather than substituting', () => {
  assert.throws(() => pickDeepgramVoice('thal'), (e) => {
    assert.equal(e.code, 'unsupported_voice');
    assert.ok(e.detail.suggestions.includes('aura-2-thalia-en'), JSON.stringify(e.detail));
    return true;
  });
});

/* ----------------------------- the round trip ---------------------------- */

test('checkDeepgramTts probes /v1/projects with the Token (not Bearer) header', async () => {
  await withFake(async (fake) => {
    const probe = await checkDeepgramTts({ key: 'test-key', endpoint: fake.url });
    assert.equal(probe.available, true);
    assert.equal(probe.voices.length, DEEPGRAM_VOICES.length);
    assert.ok(probe.voices.includes('aura-2-thalia-en'));
    const get = fake.requests.find((r) => r.method === 'GET');
    assert.equal(get.path, '/v1/projects');
    assert.equal(get.headers.authorization, 'Token test-key');
  });
});

test('a rejected key maps to tts_unavailable, not tts_failed', async () => {
  await withFake(async (fake) => {
    const probe = await checkDeepgramTts({ key: 'wrong-key', endpoint: fake.url });
    assert.equal(probe.available, false);
    assert.equal(probe.code, 'tts_unavailable');
    assert.match(probe.error, /rejected the credentials/);
  });
});

test('synthesizeDeepgramSpeech writes a PCM WAV and sends the documented query params', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const out = path.join(dir, 'vo.wav');
      const res = await synthesizeDeepgramSpeech({
        text: 'Rome was not built in a day.', outPath: out, key: 'test-key', endpoint: fake.url,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'deepgram');
      assert.equal(res.voice, 'aura-2-thalia-en'); // the no-config default
      assert.equal(res.sampleRate, 24000);
      assert.equal(res.durationSeconds, 1);
      assert.equal(await wavDurationSeconds(out), 1);

      const post = fake.requests.find((r) => r.method === 'POST');
      assert.equal(post.headers.authorization, 'Token test-key');
      assert.match(post.path, /model=aura-2-thalia-en/);
      assert.match(post.path, /encoding=linear16/);
      assert.match(post.path, /container=wav/);
      assert.match(post.path, /sample_rate=24000/);
      assert.deepEqual(JSON.parse(post.body), { text: 'Rome was not built in a day.' });
    });
  });
});

test('a passthrough voice reaches the service; a 400 for it maps to unsupported_voice', async () => {
  // The stub accepts an extra model the engine's list does not know — proving
  // the engine sent it through instead of blocking on its own catalogue.
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const res = await synthesizeDeepgramSpeech({
        text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'aura-2-brandnew-en',
        key: 'test-key', endpoint: fake.url,
      });
      assert.equal(res.voice, 'aura-2-brandnew-en');
    });
  }, { models: [...FAKE_DEEPGRAM_MODELS, 'aura-2-brandnew-en'] });

  // …and when the service genuinely does not know it, the 400 comes back as
  // the same code a catalogue miss produces.
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeDeepgramSpeech({
          text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'aura-2-imaginary-en',
          key: 'test-key', endpoint: fake.url,
        }),
        (e) => e.code === 'unsupported_voice' && /aura-2-imaginary-en/.test(e.message),
      );
    });
  });
});

test('text past the 2,000-char cap is chunked at sentence seams and joined into one WAV', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const sentence = 'All work and no play makes Jack a dull agent. ';
      const text = sentence.repeat(60).trim(); // ~2,760 chars → two chunks
      assert.ok(text.length > 2000);
      const out = path.join(dir, 'vo.wav');
      const res = await synthesizeDeepgramSpeech({ text, outPath: out, key: 'test-key', endpoint: fake.url });

      const posts = fake.requests.filter((r) => r.method === 'POST');
      assert.equal(posts.length, 2, 'two upstream requests for two chunks');
      for (const post of posts) {
        assert.ok(JSON.parse(post.body).text.length <= 1900, 'every chunk stays under the packing target');
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
        synthesizeDeepgramSpeech({ text: 'hi', outPath: path.join(dir, 'vo.wav'), key: 'test-key', endpoint: fake.url }),
        (e) => e.code === 'tts_failed' && /429/.test(e.message),
      );
    });
  }, { failStatus: 429 });
});

/* --------------------------- through the dispatcher ----------------------- */

test('synthesizeWithVendor: every prosody knob warns — Aura takes text and a voice, nothing else', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      process.env.DEEPGRAM_API_KEY = 'test-key';
      process.env.MOTION_STUDIO_DEEPGRAM_ENDPOINT = fake.url;
      const res = await synthesizeWithVendor({
        vendor: 'deepgram', text: 'hello', outPath: path.join(dir, 'a.wav'),
        rate: 3, volume: 60, style: 'cheerful', pitch: 5, deterministic: true, dataDir: dir,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'deepgram');
      const joined = res.warnings.join(' ');
      for (const knob of ['rate', 'volume', 'style', 'pitch']) {
        assert.match(joined, new RegExp(`"${knob}" is not supported by the deepgram vendor`));
      }
      assert.match(joined, /"deterministic" is only supported by the piper and elevenlabs vendors/);
    });
  });
});
