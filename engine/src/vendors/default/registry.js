/**
 * The default vendor registry (Slice A-5; vendor-boundary plan §5).
 *
 * One composition point for everything vendor-shaped: the three capability
 * catalogs and the dispatch surfaces built over them. Entrypoints construct
 * their runtime HERE (Phase 4 / §10.6: constructor-injected, imported
 * dynamically and failure-tolerantly — a missing registry must become
 * structured-unavailable, never ERR_MODULE_NOT_FOUND); core never imports
 * this module, and test/import-graph.test.js fails the build if it ever
 * does.
 *
 * Since Phase 2 the catalogs and every provider implementation live in
 * this tree (speech/, music/, transcription/); core keeps only the generic
 * dispatch factories, and this file is the one place that knows which
 * providers exist.
 */

import { createSpeechDispatch } from '../../core/tts-vendors.js';
import { defaultSpeechCatalog } from './speech/catalog.js';
import { createMusicDispatch } from '../../core/music-vendors.js';
import { defaultMusicCatalog } from './music/catalog.js';
import { createTranscriptionDispatch } from '../../core/transcribe-vendors.js';
import { defaultTranscriptionCatalog } from './transcription/catalog.js';

/**
 * Build the default runtime: every capability's dispatch surface, each over
 * its default catalog. Callers may override any catalog (tests inject fakes;
 * a future custom pack swaps one capability without touching the others).
 */
export function createDefaultRuntime({ speech, music, transcription } = {}) {
  return Object.freeze({
    speech: createSpeechDispatch(speech ?? defaultSpeechCatalog()),
    music: createMusicDispatch(music ?? defaultMusicCatalog()),
    transcription: createTranscriptionDispatch(transcription ?? defaultTranscriptionCatalog()),
  });
}
