/**
 * Speech vendors — one dispatch point for narration (v0.17; catalog-driven
 * since Slice A of the vendor-boundary plan).
 *
 * Until v0.17 there was exactly one way to make speech: spawn the Windows
 * MotionStudioTts.exe (core/tts.js). v0.17 added Azure AI Speech, v0.18
 * Piper, v0.20 ElevenLabs / OpenAI / Deepgram. This module keeps that from
 * becoming six parallel code paths — and since Slice A it does so with a
 * **capability catalog**: every vendor-specific fact (info card, probe,
 * fix sentence, synthesis call, which options it honours) is one catalog
 * entry, and the dispatch functions are generic over the catalog.
 *
 * `createSpeechDispatch(catalog)` is the injectable seam (§10.6, decided
 * 2026-08-04): entrypoints will construct their runtime with a registry's
 * catalog in Phase 4; until then the module-level exports are the same
 * functions bound to `defaultSpeechCatalog()`, so no caller changes. In
 * Phase 2 the catalog itself moves to engine/src/vendors/default/ and this
 * file keeps only the generic dispatch.
 *
 * The selection rule, the report shape and the unavailable-vendor sentence
 * are shared with music/transcription in core/vendors.js. Precedence:
 *
 *   explicit argument  >  MOTION_STUDIO_TTS_VENDOR  >  settings.tts.vendor  >  "system"
 *
 * The default stays "system" on purpose: an existing setup that has been
 * narrating with the local exe must not start billing an Azure subscription
 * because a newer version knows how to.
 *
 * Every vendor returns the same synthesis payload shape ({ ok, voice,
 * durationSeconds, sampleRate, channels, bytes, outPath }) and the same
 * probe shape ({ available, voices, error }) — see the provider modules.
 */

import { checkTts, synthesizeSpeech, resolveTtsExeInfo } from './tts.js';
import {
  checkAzureTts, synthesizeAzureSpeech, resolveAzureConfig, azureSetupHint,
  AZURE_ENV, AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT,
} from './tts-azure.js';
import { checkPiperTts, synthesizePiperSpeech, PIPER_ENV } from './tts-piper.js';
import {
  checkElevenlabsTts, synthesizeElevenlabsSpeech, resolveElevenlabsConfig, elevenlabsSetupHint,
  ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS, ELEVENLABS_DEFAULT_FORMAT,
} from './tts-elevenlabs.js';
import {
  checkOpenaiTts, synthesizeOpenaiSpeech, resolveOpenaiConfig, openaiSetupHint, OPENAI_ENV,
} from './tts-openai.js';
import {
  checkDeepgramTts, synthesizeDeepgramSpeech, resolveDeepgramConfig, deepgramSetupHint, DEEPGRAM_ENV,
} from './tts-deepgram.js';
import { readSettings, readStoredSettings, TTS_VENDORS } from './settings.js';
import {
  resolveVendorFrom, walkVendorChain, unavailableError, buildReport,
} from './vendors.js';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './scene.js';

export {
  TTS_VENDORS, AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT, AZURE_ENV,
  ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS, ELEVENLABS_DEFAULT_FORMAT, OPENAI_ENV, DEEPGRAM_ENV,
};

export const SPEECH_VENDORS = TTS_VENDORS;
export const DEFAULT_SPEECH_VENDOR = 'system';

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

/** Case-insensitive substring/locale filtering shared by the Studio and MCP. */
export function filterVoices(voices, { locale, search, limit = 0, offset = 0 } = {}) {
  let matched = voices;
  if (locale) {
    const want = locale.trim().toLowerCase();
    matched = matched.filter((v) => (v.locale ?? '').toLowerCase().startsWith(want));
  }
  if (search) {
    const want = search.trim().toLowerCase();
    matched = matched.filter((v) =>
      `${v.name} ${v.displayName ?? ''} ${v.localeName ?? ''} ${v.gender ?? ''}`.toLowerCase().includes(want));
  }
  const total = matched.length;
  const page = limit > 0 ? matched.slice(offset, offset + limit) : matched.slice(offset);
  return { total, voices: page, truncated: page.length < total };
}

/**
 * Build the speech dispatch surface over a catalog. Everything below is
 * generic: vendor-specific knowledge comes only from the entries.
 */
export function createSpeechDispatch(catalog) {
  const ids = Object.freeze(Object.keys(catalog));
  const isVendor = (v) => ids.includes(v);
  const entry = (v) => catalog[v];
  const deterministicVendors = ids.filter((id) => catalog[id].deterministic);

  /** Load settings.tts once, tolerating a missing/older settings file. */
  async function ttsSettings(dataDir, settings) {
    if (settings) return settings.tts ?? { vendor: 'system', azure: {} };
    const s = await readSettings(dataDir ?? defaultDataDir()).catch(() => null);
    return s?.tts ?? { vendor: 'system', azure: {} };
  }

  const sectionFor = async (vendorId, dataDir, settings) => {
    const key = entry(vendorId).settingsKey;
    if (!key) return {};
    return (await ttsSettings(dataDir, settings))[key] ?? {};
  };

  async function resolveSpeechVendor({ vendor, dataDir, settings, probe = false, timeoutMs, force = false } = {}) {
    // Read the file as stored, not as merged: "system" from a settings.json
    // that never mentions a vendor is the built-in default, and the Studio
    // says so.
    const stored = settings
      ? settings.tts
      : (await readStoredSettings(dataDir ?? defaultDataDir()).catch(() => null))?.tts;
    const resolved = resolveVendorFrom('speech', {
      vendor,
      storedVendor: stored?.vendor,
      storedVendors: stored?.vendors,
      allowed: ids,
      fallback: DEFAULT_SPEECH_VENDOR,
    });
    if (!probe) return resolved;
    return walkVendorChain(resolved, (id) => checkSpeechVendor(id, { dataDir, settings, timeoutMs, force }));
  }

  async function checkSpeechVendor(vendor, { dataDir, settings, timeoutMs, force = false } = {}) {
    if (!isVendor(vendor)) {
      throw new EngineError(
        ErrorCodes.INVALID_CONFIG,
        `Unknown speech vendor "${vendor}" — expected one of: ${ids.join(', ')}`,
        { vendor, allowed: ids },
      );
    }
    const section = await sectionFor(vendor, dataDir, settings);
    const status = await entry(vendor).probe({ section, timeoutMs, force });
    return { vendor, ...status };
  }

  async function speechVendorReport({ dataDir, settings, probe = true, timeoutMs, force = false } = {}) {
    const tts = await ttsSettings(dataDir, settings);
    // Resolve without probing: this function is about to probe every vendor
    // for its cards anyway; the chain walk is done below from those results.
    const resolved = await resolveSpeechVendor({ dataDir, settings });
    const chain = resolved.chain;
    const vendors = [];
    for (const id of ids) {
      const info = entry(id).info;
      const priority = chain.includes(id) ? chain.indexOf(id) + 1 : null;
      if (!probe) {
        vendors.push({ ...info, active: id === resolved.vendor, priority, available: null, voiceCount: null });
        continue;
      }
      const status = await checkSpeechVendor(id, { dataDir, settings, timeoutMs, force });
      vendors.push({
        ...info,
        priority,
        available: status.available,
        error: status.error ?? null,
        voiceCount: status.voices.length,
        config: status.config,
        // Locales are the useful axis for picking a cloud voice; vendors that
        // report none get an empty list and the UI hides the filter.
        locales: [...new Set(status.voiceDetails.map((v) => v.locale).filter(Boolean))].sort(),
      });
    }
    // The effective vendor: first in the chain that probed available.
    const usable = probe ? chain.find((id) => vendors.find((v) => v.id === id)?.available) : null;
    const active = usable ?? resolved.vendor;
    for (const v of vendors) v.active = v.id === active;
    return buildReport({ capability: 'speech', active, activeSource: resolved.source, chain, settings: tts, vendors });
  }

  async function listSpeechVoices({
    vendor, locale, search, limit = 0, offset = 0, dataDir, settings, timeoutMs, force = false,
  } = {}) {
    const resolved = await resolveSpeechVendor({ vendor, dataDir, settings, probe: true, timeoutMs, force });
    const status = resolved.status ?? await checkSpeechVendor(resolved.vendor, { dataDir, settings, timeoutMs, force });
    if (!status.available) throw await unavailableWithAlternatives(resolved.vendor, status, { dataDir, settings });
    const page = filterVoices(status.voiceDetails, { locale, search, limit, offset });
    return {
      vendor: resolved.vendor,
      vendorSource: resolved.source,
      installed: status.voices.length,
      ...page,
      locales: [...new Set(status.voiceDetails.map((v) => v.locale).filter(Boolean))].sort(),
    };
  }

  /** The speech vendors that *are* usable, so a failure can point somewhere useful. */
  async function availableAlternatives(failing, opts) {
    const others = [];
    for (const id of ids) {
      if (id === failing) continue;
      // Short timeout: this runs only on an error path, to enrich a message.
      const probe = await checkSpeechVendor(id, { ...opts, timeoutMs: 4000 }).catch(() => null);
      if (probe?.available) others.push(id);
    }
    return others;
  }

  function unavailable(vendor, status, alternatives = []) {
    return unavailableError('speech', vendor, status, { fix: entry(vendor).fix(status), alternatives });
  }

  async function unavailableWithAlternatives(vendor, status, opts = {}) {
    return unavailable(vendor, status, await availableAlternatives(vendor, opts));
  }

  async function synthesizeWithVendor({
    vendor, text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
    sentenceSilence, deterministic,
    dataDir, settings, timeoutMs, resolved: preResolved,
  }) {
    const resolved = preResolved ?? await resolveSpeechVendor({ vendor, dataDir, settings, probe: true });
    const e = entry(resolved.vendor);
    const warnings = [];

    // Requested options the vendor cannot honour are reported, never
    // silently dropped — the policy is data on the catalog entry.
    if (e.warn.azureOnly) {
      for (const [name, value] of Object.entries({ style, styleDegree, role, pitch })) {
        if (value !== undefined && value !== null) {
          warnings.push(`"${name}" is an Azure-only option and was ignored by the ${resolved.vendor} vendor`);
        }
      }
    }
    if (e.warn.unsupported.length) {
      const requested = { rate, volume, style, styleDegree, role, pitch };
      for (const name of e.warn.unsupported) {
        if (requested[name] !== undefined && requested[name] !== null) {
          warnings.push(`"${name}" is not supported by the ${resolved.vendor} vendor and was ignored`);
        }
      }
    }
    if (e.warn.nonDeterministic && deterministic) {
      warnings.push(`"deterministic" is only supported by the ${deterministicVendors.join(' and ')} vendors ` +
        `and was ignored by the ${resolved.vendor} vendor`);
    }

    const section = await sectionFor(resolved.vendor, dataDir, settings);
    const result = await e.synthesize(
      { text, outPath, voice, rate, volume, pitch, style, styleDegree, role, sentenceSilence, deterministic },
      { section, timeoutMs },
    );
    return { ...result, vendorSource: resolved.source, warnings: [...warnings, ...(result.warnings ?? [])] };
  }

  return {
    ids,
    catalog,
    resolveSpeechVendor,
    checkSpeechVendor,
    speechVendorReport,
    listSpeechVoices,
    synthesizeWithVendor,
    unavailable,
    unavailableWithAlternatives,
  };
}

/* ------------------------------------------------------------------ */
/* Default-bound surface — today's public API, unchanged for callers.  */
/* Phase 4 constructs dispatches from the injected registry instead.   */
/* ------------------------------------------------------------------ */

const defaultDispatch = createSpeechDispatch(defaultSpeechCatalog());

export const VENDOR_INFO = Object.freeze(
  Object.fromEntries(Object.entries(defaultDispatch.catalog).map(([id, e]) => [id, e.info])),
);

export const resolveSpeechVendor = defaultDispatch.resolveSpeechVendor;
export const checkSpeechVendor = defaultDispatch.checkSpeechVendor;
export const speechVendorReport = defaultDispatch.speechVendorReport;
export const listSpeechVoices = defaultDispatch.listSpeechVoices;
export const synthesizeWithVendor = defaultDispatch.synthesizeWithVendor;
export const unavailable = defaultDispatch.unavailable;
export const unavailableWithAlternatives = defaultDispatch.unavailableWithAlternatives;
