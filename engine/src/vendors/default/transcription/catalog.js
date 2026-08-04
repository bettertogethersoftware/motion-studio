/**
 * The default transcription catalog (Slice A Phase 2) — see
 * speech/catalog.js for the pattern.
 */

import {
  checkWhisperTranscription, transcribeWithWhisper, whisperSetupHint, WHISPER_ENV, MODEL_PREFERENCE,
} from './whisper-cpp.js';

/**
 * The default transcription catalog — same entry contract as the speech and
 * music catalogs: info card, probe, fix sentence, and the capability verb
 * (here `transcribe`). Phase 2 moves this to vendors/default/.
 */
export function defaultTranscriptionCatalog() {
  return Object.freeze({
    'whisper-cpp': {
      id: 'whisper-cpp',
      info: Object.freeze({
        id: 'whisper-cpp',
        label: 'whisper.cpp (local)',
        summary: 'OpenAI\'s Whisper models running entirely on this machine through whisper.cpp — no account, no API key, ' +
          'no network, any OS. One self-contained binary plus one ggml model file you download. Measured ≈6.5× realtime ' +
          'on ggml-small.en with 8 CPU threads, no GPU.',
        requires: `${WHISPER_ENV.bin[0]} (or whisper-cli on PATH) + a ggml-*.bin model ` +
          `(${WHISPER_ENV.model[0]}, ${WHISPER_ENV.models[0]}, or a "models" folder beside the binary)`,
        offline: true,
      }),
      settingsKey: 'whisper',
      async probe({ section = {}, timeoutMs } = {}) {
        const probe = await checkWhisperTranscription({ whisper: section, ...(timeoutMs ? { timeoutMs } : {}) });
        return {
          available: probe.available,
          models: probe.models ?? [],
          modelDetails: probe.modelDetails ?? [],
          error: probe.error,
          config: probe.config,
        };
      },
      fix: (status) => whisperSetupHint({ modelsDir: status?.config?.modelsDir }),
      async transcribe({ wavPath, model, language, threads, timeoutMs, signal }, { section }) {
        return transcribeWithWhisper({
          wavPath, model, language, threads,
          whisper: section ?? {},
          ...(timeoutMs ? { timeoutMs } : {}),
          signal,
        });
      },
    },
  });
}

