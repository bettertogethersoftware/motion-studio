/**
 * A real — but tiny — SoundFont for tests.
 *
 * test/fixtures/fake.sf2 is 82 bytes of nothing, which is all the fluidsynth
 * vendor's tests ever needed: they stub the synthesizer, so the file only has
 * to exist. The `node` vendor actually parses and renders it, so its tests need
 * a valid SF2 — without committing megabytes of samples or making the suite
 * depend on the 39 MB MuseScore SoundFont a developer may not have.
 *
 * spessasynth_core ships one for exactly this: an 890-byte single-preset
 * "Saw Wave" bank. Writing it to disk gives the tests a genuine soundbank the
 * real synth renders real audio from.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Write the library's built-in sample soundbank into `dir`.
 * @returns {Promise<string>} absolute path to the .sf2
 */
export async function writeTinySoundFont(dir, name = 'tiny.sf2') {
  const { BasicSoundBank } = await import('spessasynth_core');
  const file = path.join(dir, name);
  await fsp.writeFile(file, Buffer.from(BasicSoundBank.getSampleSoundBankFile()));
  return file;
}
