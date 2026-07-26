/**
 * Speech vendors — one dispatch point for narration (v0.17).
 *
 * Until v0.17 there was exactly one way to make speech: spawn the Windows
 * MotionStudioTts.exe (core/tts.js). v0.17 added Azure AI Speech
 * (core/tts-azure.js), v0.18 added Piper (core/tts-piper.js), and v0.20 adds
 * three more cloud vendors — ElevenLabs, OpenAI, and Deepgram Aura
 * (core/tts-elevenlabs.js / tts-openai.js / tts-deepgram.js). This module is
 * what keeps that from becoming six parallel code paths: it owns the vendor
 * list, the "which vendor is active" rule, and the probe/synthesize/
 * list-voices calls, so the Studio, the MCP server, and the CLI all ask the
 * same question and get the same answer.
 *
 * The selection rule, the report shape and the unavailable-vendor sentence are
 * shared with the music capability in core/vendors.js; what lives here is the
 * speech-specific half. Precedence:
 *
 *   explicit argument  >  MOTION_STUDIO_TTS_VENDOR  >  settings.tts.vendor  >  "system"
 *
 * The default stays "system" on purpose: an existing project that has been
 * narrating with the local exe must not start billing an Azure subscription
 * because a newer version knows how to.
 *
 * Every vendor returns the same synthesis payload shape ({ ok, voice,
 * durationSeconds, sampleRate, channels, bytes, outPath }) and the same probe
 * shape ({ available, voices, error }) — see the provider modules — so the
 * only vendor-aware code in the engine lives here.
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
import { defaultDataDir } from './project.js';

export {
  TTS_VENDORS, AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT, AZURE_ENV,
  ELEVENLABS_ENV, ELEVENLABS_WAV_FORMATS, ELEVENLABS_DEFAULT_FORMAT, OPENAI_ENV, DEEPGRAM_ENV,
};

export const SPEECH_VENDORS = TTS_VENDORS;
export const DEFAULT_SPEECH_VENDOR = 'system';

export const VENDOR_INFO = Object.freeze({
  system: Object.freeze({
    id: 'system',
    label: 'System speech (Windows)',
    summary: 'The local MotionStudioTts.exe driving the OS voices. Offline, free, Windows-only.',
    requires: 'MOTION_STUDIO_TTS_EXE (or the bundled engine/vendor/tts/MotionStudioTts.exe)',
    offline: true,
  }),
  azure: Object.freeze({
    id: 'azure',
    label: 'Azure AI Speech',
    summary: 'Microsoft\'s cloud neural voices over REST. Cross-platform, hundreds of voices and locales, expressive styles. Billed per character.',
    requires: `${AZURE_ENV.key[1]} + ${AZURE_ENV.region[1]} in the environment`,
    offline: false,
  }),
  piper: Object.freeze({
    id: 'piper',
    label: 'Piper (local neural)',
    summary: 'Neural voices running entirely on this machine — no account, no per-character billing, no network. Cross-platform. GPLv3, installed separately (pip install piper-tts) with voices you download.',
    requires: `${PIPER_ENV.exe[0]} (or piper / python -m piper on PATH) + voices in ${PIPER_ENV.voices[0]}`,
    offline: true,
  }),
  elevenlabs: Object.freeze({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    summary: 'ElevenLabs\' cloud voices over REST — the strongest voice quality of the cloud vendors, with API access on the free tier (10,000 credits/month, attribution required, no commercial license).',
    requires: `${ELEVENLABS_ENV.key[1]} in the environment`,
    offline: false,
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI TTS',
    summary: 'OpenAI\'s gpt-4o-mini-tts voices over REST, steerable with free-form style instructions — no free tier, roughly $0.015 per minute of audio.',
    requires: `${OPENAI_ENV.key[1]} in the environment`,
    offline: false,
  }),
  deepgram: Object.freeze({
    id: 'deepgram',
    label: 'Deepgram Aura',
    summary: 'Deepgram\'s Aura-2 voices over REST — the most generous free cloud tier: $200 of signup credit (≈6.6M characters) with no card and no expiry.',
    requires: `${DEEPGRAM_ENV.key[1]} in the environment`,
    offline: false,
  }),
});

const isVendor = (v) => TTS_VENDORS.includes(v);

/** Load settings.tts once, tolerating a missing/older settings file. */
async function ttsSettings(dataDir, settings) {
  if (settings) return settings.tts ?? { vendor: 'system', azure: {} };
  const s = await readSettings(dataDir ?? defaultDataDir()).catch(() => null);
  return s?.tts ?? { vendor: 'system', azure: {} };
}

/**
 * Which vendor speaks, and why.
 *
 * `probe: true` additionally walks a multi-entry preference chain and returns
 * the first vendor that is actually available, along with the `status` it got
 * (so the caller need not probe again) and the `skipped` entries it passed. A
 * single-vendor configuration — the default — probes nothing and behaves exactly
 * as it did before chains existed. See core/vendors.js for the guarantees.
 *
 * @returns {Promise<{vendor: string, source: 'argument'|'env'|'settings'|'default',
 *                    chain: string[], status?: object|null, skipped?: object[], exhausted?: true}>}
 */
export async function resolveSpeechVendor({ vendor, dataDir, settings, probe = false, timeoutMs, force = false } = {}) {
  // Read the file as stored, not as merged: "system" from a settings.json that
  // never mentions a vendor is the built-in default, and the Studio says so.
  const stored = settings
    ? settings.tts
    : (await readStoredSettings(dataDir ?? defaultDataDir()).catch(() => null))?.tts;
  const resolved = resolveVendorFrom('speech', {
    vendor,
    storedVendor: stored?.vendor,
    storedVendors: stored?.vendors,
    allowed: SPEECH_VENDORS,
    fallback: DEFAULT_SPEECH_VENDOR,
  });
  if (!probe) return resolved;
  return walkVendorChain(resolved, (id) => checkSpeechVendor(id, { dataDir, settings, timeoutMs, force }));
}

/**
 * Probe one vendor. Never throws for an unavailable vendor (that is data, not
 * an error) — only for an unknown vendor id.
 *
 * @returns {Promise<{vendor, available, voices?: string[], voiceDetails?: object[], error?: string, config?: object}>}
 */
export async function checkSpeechVendor(vendor, { dataDir, settings, timeoutMs, force = false } = {}) {
  if (!isVendor(vendor)) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `Unknown speech vendor "${vendor}" — expected one of: ${SPEECH_VENDORS.join(', ')}`,
      { vendor, allowed: SPEECH_VENDORS },
    );
  }

  if (vendor === 'system') {
    const exe = resolveTtsExeInfo();
    const probe = await checkTts(timeoutMs ? { timeoutMs } : {});
    return {
      vendor,
      available: probe.available,
      voices: probe.voices ?? [],
      voiceDetails: (probe.voices ?? []).map((name) => ({ name, displayName: name, locale: null, gender: null, styles: [] })),
      error: probe.error,
      config: { exePath: exe.path, exeSource: exe.source },
    };
  }

  if (vendor === 'piper') {
    const piper = (await ttsSettings(dataDir, settings)).piper ?? {};
    const probe = await checkPiperTts({ piper, ...(timeoutMs ? { timeoutMs } : {}) });
    return {
      vendor,
      available: probe.available,
      voices: probe.voices ?? [],
      voiceDetails: probe.voiceDetails ?? [],
      error: probe.error,
      config: probe.config,
    };
  }

  if (vendor === 'elevenlabs') {
    const elevenlabs = (await ttsSettings(dataDir, settings)).elevenlabs ?? {};
    const probe = await checkElevenlabsTts({ elevenlabs, ...(timeoutMs ? { timeoutMs } : {}), force });
    const cfg = probe.config ?? resolveElevenlabsConfig({ elevenlabs });
    return {
      vendor,
      available: probe.available,
      voices: probe.voices ?? [],
      voiceDetails: probe.voiceDetails ?? [],
      error: probe.error,
      // Never the key itself — only whether one was found and where from.
      config: {
        keyConfigured: Boolean(cfg.key),
        keySource: cfg.keySource,
        keyMasked: cfg.keyMasked,
        endpoint: cfg.endpoint,
        endpointSource: cfg.endpointSource,
        voice: cfg.voice,
        voiceSource: cfg.voiceSource,
        model: cfg.model,
        outputFormat: cfg.outputFormat,
        missing: cfg.missing,
        setupHint: cfg.missing.length ? elevenlabsSetupHint(cfg) : null,
      },
    };
  }

  if (vendor === 'openai') {
    const openai = (await ttsSettings(dataDir, settings)).openai ?? {};
    const probe = await checkOpenaiTts({ openai, ...(timeoutMs ? { timeoutMs } : {}), force });
    const cfg = probe.config ?? resolveOpenaiConfig({ openai });
    return {
      vendor,
      available: probe.available,
      voices: probe.voices ?? [],
      voiceDetails: probe.voiceDetails ?? [],
      error: probe.error,
      config: {
        keyConfigured: Boolean(cfg.key),
        keySource: cfg.keySource,
        keyMasked: cfg.keyMasked,
        endpoint: cfg.endpoint,
        endpointSource: cfg.endpointSource,
        voice: cfg.voice,
        voiceSource: cfg.voiceSource,
        model: cfg.model,
        instructions: cfg.instructions,
        missing: cfg.missing,
        setupHint: cfg.missing.length ? openaiSetupHint(cfg) : null,
      },
    };
  }

  if (vendor === 'deepgram') {
    const deepgram = (await ttsSettings(dataDir, settings)).deepgram ?? {};
    const probe = await checkDeepgramTts({ deepgram, ...(timeoutMs ? { timeoutMs } : {}), force });
    const cfg = probe.config ?? resolveDeepgramConfig({ deepgram });
    return {
      vendor,
      available: probe.available,
      voices: probe.voices ?? [],
      voiceDetails: probe.voiceDetails ?? [],
      error: probe.error,
      config: {
        keyConfigured: Boolean(cfg.key),
        keySource: cfg.keySource,
        keyMasked: cfg.keyMasked,
        endpoint: cfg.endpoint,
        endpointSource: cfg.endpointSource,
        voice: cfg.voice,
        voiceSource: cfg.voiceSource,
        missing: cfg.missing,
        setupHint: cfg.missing.length ? deepgramSetupHint(cfg) : null,
      },
    };
  }

  const azure = (await ttsSettings(dataDir, settings)).azure ?? {};
  const probe = await checkAzureTts({ azure, ...(timeoutMs ? { timeoutMs } : {}), force });
  const cfg = probe.config ?? resolveAzureConfig({ azure });
  return {
    vendor,
    available: probe.available,
    voices: probe.voices ?? [],
    voiceDetails: probe.voiceDetails ?? [],
    error: probe.error,
    // Never the key itself — only whether one was found and where from.
    config: {
      keyConfigured: Boolean(cfg.key),
      keySource: cfg.keySource,
      keyMasked: cfg.keyMasked,
      region: cfg.region,
      regionSource: cfg.regionSource,
      endpoint: cfg.endpoint,
      endpointSource: cfg.endpointSource,
      voice: cfg.voice,
      voiceSource: cfg.voiceSource,
      outputFormat: cfg.outputFormat,
      style: cfg.style,
      missing: cfg.missing,
      setupHint: cfg.missing.length ? azureSetupHint(cfg) : null,
    },
  };
}

/**
 * The whole speech surface in one object: which vendor is active, where that
 * choice came from, and the live status of every vendor. Backs the Studio's
 * vendors page and the `list_vendors` MCP tool. Its music twin is
 * musicVendorReport() — same shape, so one UI renders both.
 *
 * `probe: false` skips the network/exe round-trips when the caller only needs
 * the configuration (the Studio uses it to paint the page before probing).
 */
export async function speechVendorReport({ dataDir, settings, probe = true, timeoutMs, force = false } = {}) {
  const tts = await ttsSettings(dataDir, settings);
  // Resolve without probing: this function is about to probe every vendor for
  // its cards anyway, so the chain walk is done below from those results rather
  // than paying for a second round of exe spawns.
  const resolved = await resolveSpeechVendor({ dataDir, settings });
  const chain = resolved.chain;
  const vendors = [];
  for (const id of TTS_VENDORS) {
    const info = VENDOR_INFO[id];
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
      // Locales are the useful axis for picking an Azure voice; the exe vendor
      // reports none and the UI hides the filter accordingly.
      locales: [...new Set(status.voiceDetails.map((v) => v.locale).filter(Boolean))].sort(),
    });
  }
  // The effective vendor: first in the chain that probed available. Unprobed (or
  // nothing usable) falls back to the head, which is also what a caller asking
  // to synthesize would hit — and then fail on, with a message naming the fix.
  const usable = probe ? chain.find((id) => vendors.find((v) => v.id === id)?.available) : null;
  const active = usable ?? resolved.vendor;
  for (const v of vendors) v.active = v.id === active;
  return buildReport({
    capability: 'speech',
    active,
    activeSource: resolved.source,
    chain,
    settings: tts,
    vendors,
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
 * Voices for one vendor, filtered. Throws tts_unavailable when the vendor is
 * not usable — the caller is asking for data the vendor cannot supply.
 */
export async function listSpeechVoices({
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

/** How to fix each speech vendor, in one sentence. */
function fixFor(vendor) {
  if (vendor === 'azure') {
    return (status) => status?.config?.setupHint ||
      `Check ${AZURE_ENV.key[1]} / ${AZURE_ENV.region[1]} in the environment, or the Studio's tts page.`;
  }
  if (vendor === 'piper') {
    return () => 'Install Piper (`pip install piper-tts`), point ' + PIPER_ENV.exe[0] + ' at its executable, and put ' +
      'at least one voice (.onnx + .onnx.json from huggingface.co/rhasspy/piper-voices) in the folder named by ' +
      PIPER_ENV.voices[0] + '.';
  }
  if (vendor === 'elevenlabs') {
    return (status) => status?.config?.setupHint ||
      `Set ${ELEVENLABS_ENV.key[1]} to an ElevenLabs API key (elevenlabs.io → profile → API keys — the free tier ` +
      'includes API access: 10,000 credits/month, attribution required).';
  }
  if (vendor === 'openai') {
    return (status) => status?.config?.setupHint ||
      `Set ${OPENAI_ENV.key[1]} to an OpenAI API key (platform.openai.com — no free tier; speech costs about ` +
      '$0.015 per minute of audio on gpt-4o-mini-tts).';
  }
  if (vendor === 'deepgram') {
    return (status) => status?.config?.setupHint ||
      `Set ${DEEPGRAM_ENV.key[1]} to a Deepgram API key (console.deepgram.com — a new account gets $200 of ` +
      'credit, no card, no expiry: roughly 6.6M characters).';
  }
  return () => 'Build MotionStudioTts.exe and set MOTION_STUDIO_TTS_EXE to its path (Windows only), or switch to ' +
    'another speech vendor on the Studio\'s tts page.';
}

/** The speech vendors that *are* usable, so a failure can point somewhere useful. */
async function availableAlternatives(failing, opts) {
  const others = [];
  for (const id of SPEECH_VENDORS) {
    if (id === failing) continue;
    // Short timeout: this runs only on an error path, to enrich a message.
    const probe = await checkSpeechVendor(id, { ...opts, timeoutMs: 4000 }).catch(() => null);
    if (probe?.available) others.push(id);
  }
  return others;
}

/**
 * "This vendor cannot be used right now" — phrased once, in core/vendors.js,
 * and shared with the music capability. Synchronous callers keep the old
 * behaviour (no alternatives probe); `unavailableWithAlternatives` adds the
 * "…but the other vendor is ready" hint where an await is available.
 */
export function unavailable(vendor, status, alternatives = []) {
  return unavailableError('speech', vendor, status, { fix: fixFor(vendor)(status), alternatives });
}

export async function unavailableWithAlternatives(vendor, status, opts = {}) {
  return unavailable(vendor, status, await availableAlternatives(vendor, opts));
}

/**
 * Synthesize through whichever vendor is active (or the one named).
 * The payload is the provider's, plus `vendor`/`vendorSource` and any warnings
 * about options the chosen vendor ignored.
 *
 * `resolved` lets a caller that has *already* resolved (and probed) hand the
 * decision in rather than have it recomputed. With preference chains that
 * matters for more than speed: resolution now consults live availability, so
 * resolving twice could legitimately reach two different vendors — the caller's
 * check and the actual synthesis must agree on one.
 */
export async function synthesizeWithVendor({
  vendor, text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
  sentenceSilence, deterministic,
  dataDir, settings, timeoutMs, resolved: preResolved,
}) {
  const resolved = preResolved ?? await resolveSpeechVendor({ vendor, dataDir, settings, probe: true });
  const warnings = [];

  /** Options only the Azure vendor implements — reported, never silently dropped. */
  const warnAzureOnly = (vendorName) => {
    for (const [name, value] of Object.entries({ style, styleDegree, role, pitch })) {
      if (value !== undefined && value !== null) {
        warnings.push(`"${name}" is an Azure-only option and was ignored by the ${vendorName} vendor`);
      }
    }
  };

  /** `deterministic` is honoured by exactly two vendors — Piper zeroes its
   *  noise sources, ElevenLabs pins a request seed — so everywhere else the
   *  flag is reported, naming the vendors that DO support it, never silently
   *  dropped. (`sentenceSilence` is engine plumbing — the sentence-timings
   *  path zeroes Piper's own pacing — and warrants no warning.) */
  const warnNonDeterministic = (vendorName) => {
    if (deterministic) {
      warnings.push(`"deterministic" is only supported by the piper and elevenlabs vendors and was ignored by the ${vendorName} vendor`);
    }
  };

  /** Options with no mapping on the named vendor — reported, never dropped. */
  const warnUnsupported = (vendorName, options) => {
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined && value !== null) {
        warnings.push(`"${name}" is not supported by the ${vendorName} vendor and was ignored`);
      }
    }
  };

  if (resolved.vendor === 'piper') {
    warnAzureOnly('piper');
    const tts = await ttsSettings(dataDir, settings);
    const result = await synthesizePiperSpeech({
      text, outPath, voice, rate, volume, sentenceSilence, deterministic,
      piper: tts.piper ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { ...result, vendorSource: resolved.source, warnings };
  }

  if (resolved.vendor === 'elevenlabs') {
    // ElevenLabs has no SSML: style/styleDegree/role/pitch/volume have no
    // mapping there. `rate` becomes voice_settings.speed and `deterministic`
    // becomes a fixed seed — see core/tts-elevenlabs.js.
    warnUnsupported('elevenlabs', { style, styleDegree, role, pitch, volume });
    const tts = await ttsSettings(dataDir, settings);
    const result = await synthesizeElevenlabsSpeech({
      text, outPath, voice, rate, deterministic,
      elevenlabs: tts.elevenlabs ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { ...result, vendorSource: resolved.source, warnings };
  }

  if (resolved.vendor === 'openai') {
    // `style` maps onto the API's free-form `instructions` (the module warns
    // when the configured model predates that parameter); the remaining SSML
    // knobs and `deterministic` have no OpenAI mapping.
    warnUnsupported('openai', { styleDegree, role, pitch, volume });
    warnNonDeterministic('openai');
    const tts = await ttsSettings(dataDir, settings);
    const result = await synthesizeOpenaiSpeech({
      text, outPath, voice, rate, style,
      openai: tts.openai ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { ...result, vendorSource: resolved.source, warnings: [...warnings, ...(result.warnings ?? [])] };
  }

  if (resolved.vendor === 'deepgram') {
    // Aura takes text and a voice — every prosody knob is reported instead.
    warnUnsupported('deepgram', { rate, volume, style, styleDegree, role, pitch });
    warnNonDeterministic('deepgram');
    const tts = await ttsSettings(dataDir, settings);
    const result = await synthesizeDeepgramSpeech({
      text, outPath, voice,
      deepgram: tts.deepgram ?? {}, ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { ...result, vendorSource: resolved.source, warnings };
  }

  if (resolved.vendor === 'system') {
    warnAzureOnly('system');
    warnNonDeterministic('system');
    // No probe first: synthesizeSpeech already maps a missing/unstartable exe
    // to tts_unavailable, and probing here would spawn the exe twice on every
    // narration call (the MCP tool probes once, before it touches the project).
    const result = await synthesizeSpeech({
      text, outPath, voice, rate, volume, ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { ...result, vendor: 'system', vendorSource: resolved.source, warnings };
  }

  warnNonDeterministic('azure');
  const tts = await ttsSettings(dataDir, settings);
  const result = await synthesizeAzureSpeech({
    text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
    azure: tts.azure ?? {},
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { ...result, vendorSource: resolved.source, warnings };
}
