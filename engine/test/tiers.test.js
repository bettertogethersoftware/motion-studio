/**
 * Capability tiers (Slice 0): the shape agents orient by, and the rule that
 * an unready capability always names its fix. Env-driven — resolveSoundFont
 * and friends read the environment per call, so pointing the env at nowhere
 * exercises the not-ready paths without touching the real machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityTiers } from '../src/core/tiers.js';

const withEnv = async (patch, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

test('tiers: every capability reports a tier, and the set is the documented one', async () => {
  const t = await capabilityTiers();
  assert.deepEqual(Object.keys(t).sort(), ['cloud', 'music', 'render', 'sfx', 'speech', 'transcription']);
  for (const [name, cap] of Object.entries(t)) {
    assert.ok(['core', 'free-local', 'pack', 'byok'].includes(cap.tier), `${name}: ${cap.tier}`);
  }
  assert.equal(t.sfx.ready, true, 'sfx is pure JS and can never be unready');
});

test('tiers: a missing SoundFont names npm run fetch-soundfont as the fix', async () => {
  const t = await withEnv({ MOTION_STUDIO_SOUNDFONT: '/nowhere/at/all.sf3' }, () => capabilityTiers());
  assert.equal(t.music.ready, false);
  assert.match(t.music.fix, /fetch-soundfont/);
});

test('tiers: a missing whisper reports which half is missing and the per-OS fix', async () => {
  const t = await withEnv({
    MOTION_STUDIO_WHISPER_BIN: '/nowhere/whisper-cli',
    MOTION_STUDIO_WHISPER_MODEL: '/nowhere/ggml-tiny.bin',
  }, () => capabilityTiers());
  assert.equal(t.transcription.ready, false);
  assert.equal(t.transcription.binReady, false);
  assert.equal(t.transcription.modelReady, false);
  assert.match(t.transcription.fix, /MOTION_STUDIO_WHISPER_BIN/);
});

test('tiers: cloud reports key presence only, never values', async () => {
  const t = await withEnv({ DEEPGRAM_API_KEY: 'super-secret-value' }, () => capabilityTiers());
  assert.equal(t.cloud.keysPresent.deepgram, true);
  assert.ok(!JSON.stringify(t).includes('super-secret-value'), 'a key value must never appear in the report');
});
