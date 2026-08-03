/**
 * ElevenLabs speech vendor (v0.20): configuration precedence, paginated voice
 * listing, the REST round-trip against a local stub (helpers/fake-elevenlabs.mjs),
 * and the error mapping onto the engine's stable codes.
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
  resolveElevenlabsConfig, checkElevenlabsTts, synthesizeElevenlabsSpeech, pickElevenlabsVoice,
  speedForRate, clearElevenlabsVoiceCache, ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS,
} from '../src/core/tts-elevenlabs.js';
import { synthesizeWithVendor } from '../src/core/tts-vendors.js';
import { validateSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { wavDurationSeconds } from '../src/core/tts.js';
import { startFakeElevenlabs, FAKE_ELEVEN_VOICES } from './helpers/fake-elevenlabs.mjs';

/** The machine running the tests may legitimately have real ElevenLabs vars set. */
const ELEVEN_VARS = [...ELEVENLABS_ENV.key, ...ELEVENLABS_ENV.endpoint, ...ELEVENLABS_ENV.voice];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ELEVEN_VARS.map((k) => [k, process.env[k]]));
  for (const k of ELEVEN_VARS) delete process.env[k];
  clearElevenlabsVoiceCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-eleven-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

const withFake = async (fn, opts) => {
  const fake = await startFakeElevenlabs(opts);
  try { return await fn(fake); }
  finally { await fake.close(); }
};

/* ----------------------------- configuration ----------------------------- */

test('resolveElevenlabsConfig: argument beats env beats settings', () => {
  process.env.MOTION_STUDIO_ELEVENLABS_VOICE = 'env-voice';
  const fromEnv = resolveElevenlabsConfig({ elevenlabs: { voice: 'settings-voice' } });
  assert.equal(fromEnv.voice, 'env-voice');
  assert.equal(fromEnv.voiceSource, 'MOTION_STUDIO_ELEVENLABS_VOICE');

  const fromArg = resolveElevenlabsConfig({ voice: 'arg-voice', elevenlabs: { voice: 'settings-voice' } });
  assert.equal(fromArg.voice, 'arg-voice');
  assert.equal(fromArg.voiceSource, 'argument');

  delete process.env.MOTION_STUDIO_ELEVENLABS_VOICE;
  const fromSettings = resolveElevenlabsConfig({ elevenlabs: { voice: 'settings-voice' } });
  assert.equal(fromSettings.voice, 'settings-voice');
  assert.equal(fromSettings.voiceSource, 'settings');
});

test('resolveElevenlabsConfig: MOTION_STUDIO_ prefixed key wins over the plain ones', () => {
  process.env.XI_API_KEY = 'xi';
  process.env.ELEVENLABS_API_KEY = 'plain';
  process.env.MOTION_STUDIO_ELEVENLABS_KEY = 'motion';
  const cfg = resolveElevenlabsConfig();
  assert.equal(cfg.key, 'motion');
  assert.equal(cfg.keySource, 'MOTION_STUDIO_ELEVENLABS_KEY');
  assert.equal(cfg.keyMasked, '••••tion');

  delete process.env.MOTION_STUDIO_ELEVENLABS_KEY;
  assert.equal(resolveElevenlabsConfig().keySource, 'ELEVENLABS_API_KEY');
  delete process.env.ELEVENLABS_API_KEY;
  assert.equal(resolveElevenlabsConfig().keySource, 'XI_API_KEY');
});

test('resolveElevenlabsConfig: the key never comes from settings', () => {
  // Even if someone hand-edits one in, the vendor must not pick it up.
  const cfg = resolveElevenlabsConfig({ elevenlabs: { key: 'sneaky', voice: 'v' } });
  assert.equal(cfg.key, null);
  assert.deepEqual(cfg.missing, ['key']);
});

test('resolveElevenlabsConfig: defaults are the public endpoint, multilingual v2, wav_24000', () => {
  const cfg = resolveElevenlabsConfig();
  assert.equal(cfg.endpoint, 'https://api.elevenlabs.io');
  assert.equal(cfg.endpointSource, 'default');
  assert.equal(cfg.model, 'eleven_multilingual_v2');
  assert.equal(cfg.outputFormat, 'wav_24000');
  const custom = resolveElevenlabsConfig({ endpoint: 'https://proxy.example.net/' });
  assert.equal(custom.endpoint, 'https://proxy.example.net'); // trailing slash trimmed
});

test('settings refuse a stored ElevenLabs key, same rule as azure', () => {
  const withEleven = (elevenlabs) => ({
    ...structuredClone(DEFAULT_SETTINGS),
    tts: { ...structuredClone(DEFAULT_SETTINGS.tts), elevenlabs: { ...DEFAULT_SETTINGS.tts.elevenlabs, ...elevenlabs } },
  });
  assert.throws(() => validateSettings(withEleven({ key: 'secret' })),
    (e) => e.code === 'invalid_config' && /environment only/.test(e.message));
  // Since Slice A the format enum is validated at use time by the vendor
  // ("refused before the request" below); settings accepts any non-empty
  // string so a newer build's format survives this build's validation.
  assert.ok(validateSettings(withEleven({ outputFormat: 'mp3_44100_128' })));
  assert.ok(validateSettings(withEleven({ voice: 'Rachel', model: 'eleven_flash_v2_5' })));
});

test('checkElevenlabsTts reports unavailable (not an exception) with a setup hint', async () => {
  const probe = await checkElevenlabsTts({});
  assert.equal(probe.available, false);
  assert.match(probe.error, /ELEVENLABS_API_KEY/);
  assert.match(probe.error, /setx/); // the Windows instruction the user needs
});

/* ------------------------------ voice picking ---------------------------- */

test('pickElevenlabsVoice accepts a voice_id verbatim and a unique display name case-insensitively', () => {
  const byId = pickElevenlabsVoice('EXAVITQu4vr4xnSDxMaL', FAKE_ELEVEN_VOICES);
  assert.equal(byId.voice.displayName, 'Rachel');
  assert.equal(byId.source, 'requested');
  const byName = pickElevenlabsVoice('rachel', FAKE_ELEVEN_VOICES);
  assert.equal(byName.voice.name, 'EXAVITQu4vr4xnSDxMaL');
});

test('pickElevenlabsVoice rejects an unknown voice with suggestions rather than substituting', () => {
  assert.throws(() => pickElevenlabsVoice('Nobody', FAKE_ELEVEN_VOICES), (e) => {
    assert.equal(e.code, 'unsupported_voice');
    assert.ok(e.detail.suggestions.length > 0, JSON.stringify(e.detail));
    return true;
  });
});

test('pickElevenlabsVoice defaults to a premade voice, not whichever came first', () => {
  const catalogue = [
    { voice_id: 'clone-1', name: 'My Clone', category: 'cloned', labels: {} },
    { voice_id: 'premade-1', name: 'Narrator', category: 'premade', labels: {} },
  ];
  const { voice, source } = pickElevenlabsVoice(undefined, catalogue);
  assert.equal(voice.name, 'premade-1');
  assert.equal(source, 'default');
});

test('speedForRate maps the engine scale onto ElevenLabs\' narrow 0.7..1.2 window', () => {
  assert.equal(speedForRate(0), 1);
  assert.equal(speedForRate(2), 1.1);
  assert.equal(speedForRate(10), 1.2);  // clamped at the top
  assert.equal(speedForRate(-10), 0.7); // 0.5 by arithmetic, clamped to the floor
});

/* ----------------------------- the round trip ---------------------------- */

test('checkElevenlabsTts walks both voice pages — pagination is real, not vestigial', async () => {
  await withFake(async (fake) => {
    const probe = await checkElevenlabsTts({ key: 'test-key', endpoint: fake.url });
    assert.equal(probe.available, true);
    assert.equal(probe.voices.length, 3, 'voices from page 2 must be present');
    assert.ok(probe.voices.includes('cLoneVo1ce0000000001'));
    const pageCalls = fake.requests.filter((r) => r.path.startsWith('/v2/voices'));
    assert.equal(pageCalls.length, 2);
    assert.match(pageCalls[1].path, /next_page_token=page-1/);
    assert.equal(probe.voiceDetails[0].category, 'premade');
    assert.equal(probe.voiceDetails[0].gender, 'female'); // surfaced from labels
  });
});

test('synthesizeElevenlabsSpeech writes a PCM WAV with the right header and body', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const out = path.join(dir, 'vo.wav');
      const res = await synthesizeElevenlabsSpeech({
        text: 'Rome was not built in a day.', outPath: out, key: 'test-key', endpoint: fake.url,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'elevenlabs');
      assert.equal(res.voice, 'EXAVITQu4vr4xnSDxMaL'); // auto-picked premade
      assert.equal(res.voiceName, 'Rachel');
      assert.equal(res.model, 'eleven_multilingual_v2');
      assert.equal(res.sampleRate, 24000);
      assert.equal(res.durationSeconds, 1);
      assert.equal(await wavDurationSeconds(out), 1);

      const post = fake.requests.find((r) => r.method === 'POST');
      assert.equal(post.headers['xi-api-key'], 'test-key');
      assert.equal(post.headers['content-type'], 'application/json');
      assert.match(post.path, /output_format=wav_24000/);
      const body = JSON.parse(post.body);
      assert.equal(body.text, 'Rome was not built in a day.');
      assert.equal(body.model_id, 'eleven_multilingual_v2');
      assert.equal(body.seed, undefined, 'no seed unless deterministic was asked for');
    });
  });
});

test('deterministic sends the fixed seed; rate becomes voice_settings.speed', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const res = await synthesizeElevenlabsSpeech({
        text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'Adam', rate: 4, deterministic: true,
        key: 'test-key', endpoint: fake.url,
      });
      assert.equal(res.seed, 1337);
      const body = JSON.parse(fake.requests.find((r) => r.method === 'POST').body);
      assert.equal(body.seed, 1337);
      assert.equal(body.voice_settings.speed, 1.2);
    });
  });
});

test('an unknown voice fails as unsupported_voice before any audio is requested', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeElevenlabsSpeech({
          text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'Nobody', key: 'test-key', endpoint: fake.url,
        }),
        (e) => e.code === 'unsupported_voice',
      );
      assert.equal(fake.requests.filter((r) => r.method === 'POST').length, 0);
    });
  });
});

test('a non-WAV output format is refused before the request', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeElevenlabsSpeech({
          text: 'hi', outPath: path.join(dir, 'vo.wav'), outputFormat: 'mp3_44100_128',
          key: 'test-key', endpoint: fake.url,
        }),
        (e) => e.code === 'tts_failed' && /headered WAV/.test(e.message),
      );
      assert.equal(fake.requests.length, 0);
    });
  });
});

test('every offered output format is a headered wav_* container', () => {
  assert.ok(ELEVENLABS_WAV_FORMATS.every((f) => f.startsWith('wav_')));
  assert.ok(ELEVENLABS_WAV_FORMATS.includes('wav_24000'), 'the free-tier-safe default must stay offered');
});

test('a rejected key maps to tts_unavailable, not tts_failed', async () => {
  await withFake(async (fake) => {
    const probe = await checkElevenlabsTts({ key: 'wrong-key', endpoint: fake.url });
    assert.equal(probe.available, false);
    assert.equal(probe.code, 'tts_unavailable');
    assert.match(probe.error, /rejected the credentials/);
  });
});

test('a rate/quota limit maps to tts_failed (transient), not unavailable', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeElevenlabsSpeech({ text: 'hi', outPath: path.join(dir, 'vo.wav'), key: 'test-key', endpoint: fake.url }),
        (e) => e.code === 'tts_failed' && /429/.test(e.message),
      );
    });
  }, { failStatus: 429, failBody: '{"detail":{"status":"quota_exceeded"}}' });
});

test('an unreachable endpoint is unavailable, not a synthesis failure', async () => {
  const probe = await checkElevenlabsTts({ key: 'k', endpoint: 'http://127.0.0.1:1', timeoutMs: 2000 });
  assert.equal(probe.available, false);
  assert.match(probe.error, /Could not reach ElevenLabs/);
});

/* --------------------------- through the dispatcher ----------------------- */

test('synthesizeWithVendor: unsupported knobs warn, deterministic does not (it is honoured)', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      process.env.ELEVENLABS_API_KEY = 'test-key';
      process.env.MOTION_STUDIO_ELEVENLABS_ENDPOINT = fake.url;
      const res = await synthesizeWithVendor({
        vendor: 'elevenlabs', text: 'hello', outPath: path.join(dir, 'a.wav'),
        style: 'cheerful', pitch: 5, volume: 60, deterministic: true, dataDir: dir,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'elevenlabs');
      const joined = res.warnings.join(' ');
      assert.match(joined, /"style" is not supported by the elevenlabs vendor/);
      assert.match(joined, /"pitch" is not supported/);
      assert.match(joined, /"volume" is not supported/);
      assert.ok(!/deterministic/.test(joined), 'deterministic is supported here and must not warn');
      assert.equal(JSON.parse(fake.requests.find((r) => r.method === 'POST').body).seed, 1337);
    });
  });
});
