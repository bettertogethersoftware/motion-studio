/**
 * The default vendor registry (Slice A-5): the composition point entrypoints
 * build their runtime from. Pinned here: its shape, its overridability (the
 * §10.6 seam — tests and custom packs inject catalogs), and the invariant
 * that the module lives outside core/ (the import-graph test polices the
 * other direction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRuntime } from '../src/vendors/default/registry.js';

test('registry: the default runtime carries all three capability dispatches', () => {
  const runtime = createDefaultRuntime();
  assert.deepEqual(Object.keys(runtime).sort(), ['music', 'speech', 'transcription']);
  assert.deepEqual([...runtime.speech.ids].sort(),
    ['azure', 'deepgram', 'elevenlabs', 'openai', 'piper', 'system']);
  assert.deepEqual([...runtime.music.ids].sort(), ['fluidsynth', 'node']);
  assert.deepEqual([...runtime.transcription.ids], ['whisper-cpp']);
  for (const cap of Object.values(runtime)) {
    assert.equal(typeof cap.catalog, 'object');
  }
});

test('registry: a catalog override replaces one capability without touching the others', async () => {
  const fake = {
    'fake-tts': {
      id: 'fake-tts',
      info: { id: 'fake-tts', label: 'Fake', summary: '', requires: '', offline: true },
      settingsKey: null,
      deterministic: true,
      warn: { azureOnly: false, nonDeterministic: false, unsupported: [] },
      probe: async () => ({ available: true, voices: ['v1'], voiceDetails: [{ name: 'v1' }], error: null, config: {} }),
      fix: () => 'nothing to fix',
      synthesize: async () => ({ ok: true, voice: 'v1' }),
    },
  };
  const runtime = createDefaultRuntime({ speech: fake });
  assert.deepEqual([...runtime.speech.ids], ['fake-tts']);
  const status = await runtime.speech.checkSpeechVendor('fake-tts', { settings: { tts: {} } });
  assert.equal(status.available, true);
  // The untouched capabilities keep their real catalogs.
  assert.deepEqual([...runtime.music.ids].sort(), ['fluidsynth', 'node']);
});
