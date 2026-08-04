/**
 * Slice A guard: settings.js no longer imports vendor modules, so its vendor
 * default values are literals — which can drift from the vendor's own
 * constants. This test is the tether: it may import both sides (tests are
 * not core) and fails the moment they disagree. Enum validation itself moved
 * to the vendors' use-time checks on purpose — settings-time enum validation
 * destroyed settings written by newer builds that know newer formats.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, VENDOR_SETTINGS_FIELDS } from '../src/core/settings.js';
import { AZURE_DEFAULT_FORMAT, AZURE_WAV_FORMATS } from '../src/vendors/default/speech/azure.js';
import { ELEVENLABS_DEFAULT_FORMAT, ELEVENLABS_WAV_FORMATS } from '../src/vendors/default/speech/elevenlabs.js';

test('settings defaults match the vendor constants they no longer import', () => {
  assert.equal(DEFAULT_SETTINGS.tts.azure.outputFormat, AZURE_DEFAULT_FORMAT);
  assert.equal(DEFAULT_SETTINGS.tts.elevenlabs.outputFormat, ELEVENLABS_DEFAULT_FORMAT);
  // And the defaults are valid members of their own enums, so use-time
  // validation can never refuse an untouched configuration.
  assert.ok(AZURE_WAV_FORMATS.includes(DEFAULT_SETTINGS.tts.azure.outputFormat));
  assert.ok(ELEVENLABS_WAV_FORMATS.includes(DEFAULT_SETTINGS.tts.elevenlabs.outputFormat));
});

test('settings.js does not import the cloud vendor modules', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/core/settings.js', import.meta.url), 'utf8');
  for (const forbidden of ['tts-azure', 'tts-elevenlabs', 'tts-openai', 'tts-deepgram', 'tts-piper']) {
    assert.ok(!source.includes(`from './${forbidden}.js'`), `settings.js must not import ${forbidden}.js`);
  }
});

test('settings field table matches what the catalogs declare (P2-d tether)', async () => {
  const { createDefaultRuntime, vendorSettingsFields } = await import('../src/vendors/default/registry.js');
  const fromRegistry = vendorSettingsFields(createDefaultRuntime());
  assert.deepEqual(fromRegistry, JSON.parse(JSON.stringify(VENDOR_SETTINGS_FIELDS)),
    'core fallback table and catalog-declared settingsFields must agree');
});
