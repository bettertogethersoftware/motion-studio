/**
 * Azure speech vendor (v0.17): configuration precedence, SSML construction,
 * the REST round-trip against a local stub (helpers/fake-azure-speech.mjs), and
 * the error mapping onto the engine's stable codes.
 *
 * No subscription, no network: every test points the vendor at the stub through
 * the same `endpoint` hook a sovereign-cloud user would use.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveAzureConfig, checkAzureTts, synthesizeAzureSpeech, buildSsml, escapeXml, pickVoice,
  clearAzureVoiceCache, maskKey, AZURE_ENV, AZURE_WAV_FORMATS,
} from '../src/core/tts-azure.js';
import { wavDurationSeconds } from '../src/core/tts.js';
import { startFakeAzure, FAKE_VOICES } from './helpers/fake-azure-speech.mjs';

/** The machine running the tests may legitimately have real Azure vars set. */
const AZURE_VARS = [...AZURE_ENV.key, ...AZURE_ENV.region, ...AZURE_ENV.endpoint, ...AZURE_ENV.voice];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(AZURE_VARS.map((k) => [k, process.env[k]]));
  for (const k of AZURE_VARS) delete process.env[k];
  clearAzureVoiceCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const withTmp = async (fn) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-azure-test-'));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

const withFake = async (fn, opts) => {
  const fake = await startFakeAzure(opts);
  try { return await fn(fake); }
  finally { await fake.close(); }
};

/* ----------------------------- configuration ----------------------------- */

test('resolveAzureConfig: argument beats env beats settings', () => {
  process.env.AZURE_SPEECH_REGION = 'eastus';
  const fromEnv = resolveAzureConfig({ azure: { region: 'westeurope' } });
  assert.equal(fromEnv.region, 'eastus');
  assert.equal(fromEnv.regionSource, 'AZURE_SPEECH_REGION');

  const fromArg = resolveAzureConfig({ region: 'japaneast', azure: { region: 'westeurope' } });
  assert.equal(fromArg.region, 'japaneast');
  assert.equal(fromArg.regionSource, 'argument');

  delete process.env.AZURE_SPEECH_REGION;
  const fromSettings = resolveAzureConfig({ azure: { region: 'westeurope' } });
  assert.equal(fromSettings.region, 'westeurope');
  assert.equal(fromSettings.regionSource, 'settings');
});

test('resolveAzureConfig: MOTION_STUDIO_ prefixed vars win over the plain ones', () => {
  process.env.SPEECH_KEY = 'plain';
  process.env.AZURE_SPEECH_KEY = 'azure';
  process.env.MOTION_STUDIO_AZURE_SPEECH_KEY = 'motion';
  const cfg = resolveAzureConfig();
  assert.equal(cfg.key, 'motion');
  assert.equal(cfg.keySource, 'MOTION_STUDIO_AZURE_SPEECH_KEY');
});

test('resolveAzureConfig: the key never comes from settings', () => {
  // Even if someone hand-edits one in, the vendor must not pick it up.
  const cfg = resolveAzureConfig({ azure: { key: 'sneaky', region: 'eastus' } });
  assert.equal(cfg.key, null);
  assert.deepEqual(cfg.missing, ['key']);
});

test('resolveAzureConfig: region builds the endpoint, an explicit endpoint overrides it', () => {
  assert.equal(resolveAzureConfig({ region: 'eastus' }).endpoint, 'https://eastus.tts.speech.microsoft.com');
  const custom = resolveAzureConfig({ region: 'eastus', endpoint: 'https://my-private.example.net/' });
  assert.equal(custom.endpoint, 'https://my-private.example.net'); // trailing slash trimmed
  assert.equal(custom.endpointSource, 'argument');
});

test('maskKey never reveals more than the last four characters', () => {
  assert.equal(maskKey('abcdefghijklmnop'), '••••mnop');
  assert.equal(maskKey('abc'), '••••');
  assert.equal(maskKey(null), null);
});

test('checkAzureTts reports unavailable (not an exception) with a setup hint', async () => {
  const probe = await checkAzureTts({});
  assert.equal(probe.available, false);
  assert.match(probe.error, /AZURE_SPEECH_KEY/);
  assert.match(probe.error, /setx/); // the Windows instruction the user needs
});

/* --------------------------------- SSML ---------------------------------- */

test('escapeXml neutralizes markup in narration text', () => {
  assert.equal(escapeXml('Tom & "Jerry" <b>'), 'Tom &amp; &quot;Jerry&quot; &lt;b&gt;');
});

test('buildSsml escapes the text and maps rate/volume onto prosody', () => {
  const ssml = buildSsml({ text: 'A & B', voice: 'en-US-AvaNeural', locale: 'en-US', rate: 3, volume: 80 });
  assert.match(ssml, /<voice name="en-US-AvaNeural">/);
  assert.match(ssml, /A &amp; B/);
  assert.match(ssml, /rate="\+30%"/);
  assert.match(ssml, /volume="80"/);
  assert.ok(!ssml.includes('A & B'), 'raw ampersand must not survive into the SSML');
});

test('buildSsml maps a negative rate and wraps styles in mstts:express-as', () => {
  const ssml = buildSsml({ text: 'hi', voice: 'en-US-AvaNeural', rate: -4, style: 'cheerful', styleDegree: 1.5 });
  assert.match(ssml, /rate="-40%"/);
  assert.match(ssml, /<mstts:express-as style="cheerful" styledegree="1.5">/);
});

/* ------------------------------ voice picking ---------------------------- */

test('pickVoice matches a ShortName case-insensitively', () => {
  const { voice, source } = pickVoice('EN-us-avaNEURAL', FAKE_VOICES);
  assert.equal(voice.name, 'en-US-AvaNeural');
  assert.equal(source, 'requested');
});

test('pickVoice defaults to a neural voice in the fallback locale', () => {
  const { voice, source } = pickVoice(undefined, FAKE_VOICES);
  assert.equal(voice.name, 'en-US-AvaNeural');
  assert.equal(source, 'default');
});

test('pickVoice rejects an unknown voice with suggestions rather than substituting', () => {
  assert.throws(() => pickVoice('en-US-NoSuchNeural', FAKE_VOICES), (e) => {
    assert.equal(e.code, 'unsupported_voice');
    assert.ok(e.detail.suggestions.includes('en-US-AvaNeural'), JSON.stringify(e.detail));
    return true;
  });
});

/* ----------------------------- the round trip ---------------------------- */

test('checkAzureTts lists voices from the service', async () => {
  await withFake(async (fake) => {
    const probe = await checkAzureTts({ key: 'test-key', endpoint: fake.url });
    assert.equal(probe.available, true);
    assert.equal(probe.voices.length, 3);
    assert.ok(probe.voices.includes('zh-TW-HsiaoChenNeural'));
    assert.equal(probe.voiceDetails[0].styles.length, 2);
  });
});

test('synthesizeAzureSpeech writes a PCM WAV and reports the header duration', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const out = path.join(dir, 'vo.wav');
      const res = await synthesizeAzureSpeech({
        text: 'Rome was not built in a day.', outPath: out, key: 'test-key', endpoint: fake.url,
      });
      assert.equal(res.ok, true);
      assert.equal(res.vendor, 'azure');
      assert.equal(res.voice, 'en-US-AvaNeural'); // auto-picked
      assert.equal(res.sampleRate, 24000);
      assert.equal(res.channels, 1);
      assert.equal(res.durationSeconds, 1);
      assert.equal(await wavDurationSeconds(out), 1);

      const post = fake.requests.find((r) => r.method === 'POST');
      assert.equal(post.headers['content-type'], 'application/ssml+xml');
      assert.equal(post.headers['x-microsoft-outputformat'], 'riff-24khz-16bit-mono-pcm');
      assert.match(post.body, /Rome was not built in a day\./);
    });
  });
});

test('synthesizeAzureSpeech honours the configured default voice and output format', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      const res = await synthesizeAzureSpeech({
        text: '你好', outPath: path.join(dir, 'vo.wav'), key: 'test-key', endpoint: fake.url,
        azure: { voice: 'zh-TW-HsiaoChenNeural', outputFormat: 'riff-16khz-16bit-mono-pcm' },
      });
      assert.equal(res.voice, 'zh-TW-HsiaoChenNeural');
      assert.equal(res.locale, 'zh-TW');
      const post = fake.requests.find((r) => r.method === 'POST');
      assert.equal(post.headers['x-microsoft-outputformat'], 'riff-16khz-16bit-mono-pcm');
      assert.match(post.body, /xml:lang="zh-TW"/);
    });
  });
});

test('an unknown voice fails as unsupported_voice before any audio is requested', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeAzureSpeech({
          text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'en-US-Nope', key: 'test-key', endpoint: fake.url,
        }),
        (e) => e.code === 'unsupported_voice',
      );
      assert.equal(fake.requests.filter((r) => r.method === 'POST').length, 0);
    });
  });
});

test('a style the voice does not support fails with the supported list', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeAzureSpeech({
          text: 'hi', outPath: path.join(dir, 'vo.wav'), voice: 'en-US-AvaNeural', style: 'whispering',
          key: 'test-key', endpoint: fake.url,
        }),
        (e) => {
          assert.equal(e.code, 'tts_failed');
          assert.match(e.message, /cheerful, newscast/);
          return true;
        },
      );
    });
  });
});

test('a rejected key maps to tts_unavailable, not tts_failed', async () => {
  await withFake(async (fake) => {
    const probe = await checkAzureTts({ key: 'wrong-key', endpoint: fake.url });
    assert.equal(probe.available, false);
    assert.equal(probe.code, 'tts_unavailable');
    assert.match(probe.error, /rejected the credentials/);
  });
});

test('a rate limit maps to tts_failed (transient), not unavailable', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeAzureSpeech({ text: 'hi', outPath: path.join(dir, 'vo.wav'), key: 'test-key', endpoint: fake.url }),
        (e) => e.code === 'tts_failed' && /429/.test(e.message),
      );
    });
  }, { failStatus: 429, failBody: 'Too many requests' });
});

test('a non-WAV output format is refused before the request', async () => {
  await withFake(async (fake) => {
    await withTmp(async (dir) => {
      await assert.rejects(
        synthesizeAzureSpeech({
          text: 'hi', outPath: path.join(dir, 'vo.wav'), outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
          key: 'test-key', endpoint: fake.url,
        }),
        (e) => e.code === 'tts_failed' && /RIFF PCM WAV/.test(e.message),
      );
      assert.equal(fake.requests.length, 0);
    });
  });
});

test('every offered output format is a RIFF container', () => {
  assert.ok(AZURE_WAV_FORMATS.every((f) => f.startsWith('riff-') && f.endsWith('-pcm')));
});

test('an unreachable endpoint is unavailable, not a synthesis failure', async () => {
  const probe = await checkAzureTts({ key: 'k', endpoint: 'http://127.0.0.1:1', timeoutMs: 2000 });
  assert.equal(probe.available, false);
  assert.match(probe.error, /Could not reach Azure Speech/);
});
