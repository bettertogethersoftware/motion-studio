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
 * Today the catalogs still live beside their dispatchers in core/ — this
 * module is deliberately thin. Phase 2 moves the catalogs (and the provider
 * implementations they close over) into this tree, at which point core
 * keeps only the generic dispatch factories and this file becomes the one
 * place that knows which providers exist.
 */

import { createSpeechDispatch, defaultSpeechCatalog } from '../../core/tts-vendors.js';
import { createMusicDispatch, defaultMusicCatalog } from '../../core/music-vendors.js';
import { createTranscriptionDispatch, defaultTranscriptionCatalog } from '../../core/transcribe-vendors.js';

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
