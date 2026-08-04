/**
 * The default speech catalog (Slice A Phase 2): every vendor-specific fact —
 * providers, info cards, probes, fix sentences, option policies — lives in
 * this tree now. core/tts-vendors.js keeps only the generic dispatch, and
 * the registry (../registry.js) hands the constructed dispatch to the
 * entrypoints.
 */

import { checkTts, synthesizeSpeech, resolveTtsExeInfo } from './system.js';
import {
  checkAzureTts, synthesizeAzureSpeech, resolveAzureConfig, azureSetupHint,
  AZURE_ENV, AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT,
} from './azure.js';
import { checkPiperTts, synthesizePiperSpeech, PIPER_ENV } from './piper.js';
import {
  checkElevenlabsTts, synthesizeElevenlabsSpeech, resolveElevenlabsConfig, elevenlabsSetupHint,
  ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS, ELEVENLABS_DEFAULT_FORMAT,
} from './elevenlabs.js';
import {
  checkOpenaiTts, synthesizeOpenaiSpeech, resolveOpenaiConfig, openaiSetupHint, OPENAI_ENV,
} from './openai.js';
import {
  checkDeepgramTts, synthesizeDeepgramSpeech, resolveDeepgramConfig, deepgramSetupHint, DEEPGRAM_ENV,
} from './deepgram.js';

/** Shrink a cloud probe's resolved config to the reportable, secret-free view. */
const cloudConfigView = (cfg, hint, extraFields = []) => ({
  // Never the key itself — only whether one was found and where from.
  keyConfigured: Boolean(cfg.key),
  keySource: cfg.keySource,
  keyMasked: cfg.keyMasked,
  endpoint: cfg.endpoint,
  endpointSource: cfg.endpointSource,
  voice: cfg.voice,
  voiceSource: cfg.voiceSource,
  ...Object.fromEntries(extraFields.map((f) => [f, cfg[f]])),
  missing: cfg.missing,
  setupHint: cfg.missing.length ? hint(cfg) : null,
});

/**
 * The default speech catalog: one entry per vendor, carrying everything the
 * generic dispatch needs to know about it.
 *
 * Entry contract:
 *   info                  the card list_vendors / the Studio shows
 *   probe({section, timeoutMs, force}) → {available, voices, voiceDetails, error, config}
 *   fix(status) → string  the one-sentence remedy for an unavailable probe
 *   synthesize(args, {section, timeoutMs}) → provider payload
 *   warn: {azureOnly, nonDeterministic, unsupported: [option names]}
 *                         which requested options this vendor cannot honour;
 *                         the dispatcher reports them, never silently drops
 *   deterministic         true when the vendor honours `deterministic`
 *   settingsKey           which tts.<section> the vendor reads (null = none)
 *   probeBeforeSynthesize false for vendors whose synthesize already maps a
 *                         missing tool to tts_unavailable (spawning twice per
 *                         narration call is the thing this avoids)
 */
export function defaultSpeechCatalog() {
  return Object.freeze({
    system: {
      id: 'system',
      info: Object.freeze({
        id: 'system',
        label: 'System speech (OS voices)',
        summary: 'The operating system\'s own voices — bundled exe or System.Speech on Windows, `say` on macOS, espeak-ng on Linux. Offline, free, zero-byte; scratch-narration quality by design.',
        requires: 'nothing (MOTION_STUDIO_TTS_EXE overrides the per-platform default)',
        offline: true,
      }),
      settingsKey: null,
      deterministic: false,
      warn: { azureOnly: true, nonDeterministic: true, unsupported: [] },
      async probe({ timeoutMs } = {}) {
        const exe = resolveTtsExeInfo();
        const probe = await checkTts(timeoutMs ? { timeoutMs } : {});
        return {
          available: probe.available,
          voices: probe.voices ?? [],
          voiceDetails: (probe.voices ?? []).map((name) => ({ name, displayName: name, locale: null, gender: null, styles: [] })),
          error: probe.error,
          config: { exePath: exe.path, exeSource: exe.source },
        };
      },
      fix: () => 'The system vendor needs no install — unset MOTION_STUDIO_TTS_EXE to use the per-platform OS ' +
        'backend, or switch to another speech vendor on the Studio\'s tts page.',
      // synthesizeSpeech already maps a missing/unstartable exe to
      // tts_unavailable, and probing here would spawn the exe twice on every
      // narration call (the MCP tool probes once, before it touches the target).
      async synthesize({ text, outPath, voice, rate, volume }, { timeoutMs }) {
        const result = await synthesizeSpeech({ text, outPath, voice, rate, volume, ...(timeoutMs ? { timeoutMs } : {}) });
        return { ...result, vendor: 'system' };
      },
    },

    azure: {
      id: 'azure',
      info: Object.freeze({
        id: 'azure',
        label: 'Azure AI Speech',
        summary: 'Microsoft\'s cloud neural voices over REST. Cross-platform, hundreds of voices and locales, expressive styles. Billed per character.',
        requires: `${AZURE_ENV.key[1]} + ${AZURE_ENV.region[1]} in the environment`,
        offline: false,
      }),
      settingsKey: 'azure',
      settingsFields: Object.freeze(['region', 'voice', 'style', 'outputFormat']),
      deterministic: false,
      warn: { azureOnly: false, nonDeterministic: true, unsupported: [] },
      async probe({ section = {}, timeoutMs, force } = {}) {
        const probe = await checkAzureTts({ azure: section, ...(timeoutMs ? { timeoutMs } : {}), force });
        const cfg = probe.config ?? resolveAzureConfig({ azure: section });
        return {
          available: probe.available,
          voices: probe.voices ?? [],
          voiceDetails: probe.voiceDetails ?? [],
          error: probe.error,
          config: {
            ...cloudConfigView(cfg, azureSetupHint, ['outputFormat', 'style']),
            region: cfg.region,
            regionSource: cfg.regionSource,
          },
        };
      },
      fix: (status) => status?.config?.setupHint ||
        `Check ${AZURE_ENV.key[1]} / ${AZURE_ENV.region[1]} in the environment, or the Studio's tts page.`,
      async synthesize({ text, outPath, voice, rate, volume, pitch, style, styleDegree, role }, { section, timeoutMs }) {
        return synthesizeAzureSpeech({
          text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
          azure: section ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
        });
      },
    },

    piper: {
      id: 'piper',
      info: Object.freeze({
        id: 'piper',
        label: 'Piper (local neural)',
        summary: 'Neural voices running entirely on this machine — no account, no per-character billing, no network. Cross-platform. GPLv3, installed separately (pip install piper-tts) with voices you download.',
        requires: `${PIPER_ENV.exe[0]} (or piper / python -m piper on PATH) + voices in ${PIPER_ENV.voices[0]}`,
        offline: true,
      }),
      settingsKey: 'piper',
      settingsFields: Object.freeze(['exe', 'python', 'voicesDir', 'voice']),
      deterministic: true,
      warn: { azureOnly: true, nonDeterministic: false, unsupported: [] },
      async probe({ section = {}, timeoutMs } = {}) {
        const probe = await checkPiperTts({ piper: section, ...(timeoutMs ? { timeoutMs } : {}) });
        return {
          available: probe.available,
          voices: probe.voices ?? [],
          voiceDetails: probe.voiceDetails ?? [],
          error: probe.error,
          config: probe.config,
        };
      },
      fix: () => 'Install Piper (`pip install piper-tts`), point ' + PIPER_ENV.exe[0] + ' at its executable, and put ' +
        'at least one voice (.onnx + .onnx.json from huggingface.co/rhasspy/piper-voices) in the folder named by ' +
        PIPER_ENV.voices[0] + '.',
      async synthesize({ text, outPath, voice, rate, volume, sentenceSilence, deterministic }, { section, timeoutMs }) {
        return synthesizePiperSpeech({
          text, outPath, voice, rate, volume, sentenceSilence, deterministic,
          piper: section ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
        });
      },
    },

    elevenlabs: {
      id: 'elevenlabs',
      info: Object.freeze({
        id: 'elevenlabs',
        label: 'ElevenLabs',
        summary: 'ElevenLabs\' cloud voices over REST — the strongest voice quality of the cloud vendors, with API access on the free tier (10,000 credits/month, attribution required, no commercial license).',
        requires: `${ELEVENLABS_ENV.key[1]} in the environment`,
        offline: false,
      }),
      settingsKey: 'elevenlabs',
      settingsFields: Object.freeze(['voice', 'model', 'outputFormat']),
      deterministic: true,
      // ElevenLabs has no SSML: style/styleDegree/role/pitch/volume have no
      // mapping there. `rate` becomes voice_settings.speed and `deterministic`
      // a fixed seed — see core/tts-elevenlabs.js.
      warn: { azureOnly: false, nonDeterministic: false, unsupported: ['style', 'styleDegree', 'role', 'pitch', 'volume'] },
      async probe({ section = {}, timeoutMs, force } = {}) {
        const probe = await checkElevenlabsTts({ elevenlabs: section, ...(timeoutMs ? { timeoutMs } : {}), force });
        const cfg = probe.config ?? resolveElevenlabsConfig({ elevenlabs: section });
        return {
          available: probe.available,
          voices: probe.voices ?? [],
          voiceDetails: probe.voiceDetails ?? [],
          error: probe.error,
          config: cloudConfigView(cfg, elevenlabsSetupHint, ['model', 'outputFormat']),
        };
      },
      fix: (status) => status?.config?.setupHint ||
        `Set ${ELEVENLABS_ENV.key[1]} to an ElevenLabs API key (elevenlabs.io → profile → API keys — the free tier ` +
        'includes API access: 10,000 credits/month, attribution required).',
      async synthesize({ text, outPath, voice, rate, deterministic }, { section, timeoutMs }) {
        return synthesizeElevenlabsSpeech({
          text, outPath, voice, rate, deterministic,
          elevenlabs: section ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
        });
      },
    },

    openai: {
      id: 'openai',
      info: Object.freeze({
        id: 'openai',
        label: 'OpenAI TTS',
        summary: 'OpenAI\'s gpt-4o-mini-tts voices over REST, steerable with free-form style instructions — no free tier, roughly $0.015 per minute of audio.',
        requires: `${OPENAI_ENV.key[1]} in the environment`,
        offline: false,
      }),
      settingsKey: 'openai',
      settingsFields: Object.freeze(['voice', 'model', 'instructions']),
      deterministic: false,
      // `style` maps onto the API's free-form `instructions` (the module warns
      // when the configured model predates that parameter); the remaining SSML
      // knobs and `deterministic` have no OpenAI mapping.
      warn: { azureOnly: false, nonDeterministic: true, unsupported: ['styleDegree', 'role', 'pitch', 'volume'] },
      async probe({ section = {}, timeoutMs, force } = {}) {
        const probe = await checkOpenaiTts({ openai: section, ...(timeoutMs ? { timeoutMs } : {}), force });
        const cfg = probe.config ?? resolveOpenaiConfig({ openai: section });
        return {
          available: probe.available,
          voices: probe.voices ?? [],
          voiceDetails: probe.voiceDetails ?? [],
          error: probe.error,
          config: cloudConfigView(cfg, openaiSetupHint, ['model', 'instructions']),
        };
      },
      fix: (status) => status?.config?.setupHint ||
        `Set ${OPENAI_ENV.key[1]} to an OpenAI API key (platform.openai.com — no free tier; speech costs about ` +
        '$0.015 per minute of audio on gpt-4o-mini-tts).',
      async synthesize({ text, outPath, voice, rate, style }, { section, timeoutMs }) {
        return synthesizeOpenaiSpeech({
          text, outPath, voice, rate, style,
          openai: section ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
        });
      },
    },

    deepgram: {
      id: 'deepgram',
      info: Object.freeze({
        id: 'deepgram',
        label: 'Deepgram Aura',
        summary: 'Deepgram\'s Aura-2 voices over REST — the most generous free cloud tier: $200 of signup credit (≈6.6M characters) with no card and no expiry.',
        requires: `${DEEPGRAM_ENV.key[1]} in the environment`,
        offline: false,
      }),
      settingsKey: 'deepgram',
      settingsFields: Object.freeze(['voice']),
      deterministic: false,
      // Aura takes text and a voice — every prosody knob is reported instead.
      warn: { azureOnly: false, nonDeterministic: true, unsupported: ['rate', 'volume', 'style', 'styleDegree', 'role', 'pitch'] },
      async probe({ section = {}, timeoutMs, force } = {}) {
        const probe = await checkDeepgramTts({ deepgram: section, ...(timeoutMs ? { timeoutMs } : {}), force });
        const cfg = probe.config ?? resolveDeepgramConfig({ deepgram: section });
        return {
          available: probe.available,
          voices: probe.voices ?? [],
          voiceDetails: probe.voiceDetails ?? [],
          error: probe.error,
          config: cloudConfigView(cfg, deepgramSetupHint),
        };
      },
      fix: (status) => status?.config?.setupHint ||
        `Set ${DEEPGRAM_ENV.key[1]} to a Deepgram API key (console.deepgram.com — a new account gets $200 of ` +
        'credit, no card, no expiry: roughly 6.6M characters).',
      async synthesize({ text, outPath, voice }, { section, timeoutMs }) {
        return synthesizeDeepgramSpeech({
          text, outPath, voice,
          deepgram: section ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
        });
      },
    },
  });
}

