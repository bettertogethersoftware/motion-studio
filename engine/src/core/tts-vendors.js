/**
 * Speech vendors — one dispatch point for narration (v0.17).
 *
 * Until v0.17 there was exactly one way to make speech: spawn the Windows
 * MotionStudioTts.exe (core/tts.js). v0.17 adds Azure AI Speech
 * (core/tts-azure.js), which needs no exe, no Windows, and reaches several
 * hundred neural voices. This module is what keeps that from becoming two
 * parallel code paths: it owns the vendor list, the "which vendor is active"
 * rule, and the probe/synthesize/list-voices calls, so the Studio, the MCP
 * server, and the CLI all ask the same question and get the same answer.
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
 * Both vendors return the same synthesis payload shape ({ ok, voice,
 * durationSeconds, sampleRate, channels, bytes, outPath }) and the same probe
 * shape ({ available, voices, error }) — see the two provider modules — so the
 * only vendor-aware code in the engine lives here.
 */

import { checkTts, synthesizeSpeech, resolveTtsExeInfo } from './tts.js';
import {
  checkAzureTts, synthesizeAzureSpeech, resolveAzureConfig, azureSetupHint,
  AZURE_ENV, AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT,
} from './tts-azure.js';
import { readSettings, readStoredSettings, TTS_VENDORS } from './settings.js';
import { resolveVendorFrom, unavailableError, buildReport, CAPABILITY_META } from './vendors.js';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './project.js';

export { TTS_VENDORS, AZURE_WAV_FORMATS, AZURE_DEFAULT_FORMAT, AZURE_ENV };

export const SPEECH_VENDORS = TTS_VENDORS;
export const DEFAULT_SPEECH_VENDOR = 'system';
export const VENDOR_ENV = CAPABILITY_META.speech.env;

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
 * @returns {Promise<{vendor: string, source: 'argument'|'env'|'settings'|'default'}>}
 */
export async function resolveSpeechVendor({ vendor, dataDir, settings } = {}) {
  // Read the file as stored, not as merged: "system" from a settings.json that
  // never mentions a vendor is the built-in default, and the Studio says so.
  const stored = settings
    ? settings.tts?.vendor
    : (await readStoredSettings(dataDir ?? defaultDataDir()).catch(() => null))?.tts?.vendor;
  return resolveVendorFrom('speech', {
    vendor,
    storedVendor: stored,
    allowed: SPEECH_VENDORS,
    fallback: DEFAULT_SPEECH_VENDOR,
  });
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
  const active = await resolveSpeechVendor({ dataDir, settings });
  const vendors = [];
  for (const id of TTS_VENDORS) {
    const info = VENDOR_INFO[id];
    if (!probe) {
      vendors.push({ ...info, active: id === active.vendor, available: null, voiceCount: null });
      continue;
    }
    const status = await checkSpeechVendor(id, { dataDir, settings, timeoutMs, force });
    vendors.push({
      ...info,
      active: id === active.vendor,
      available: status.available,
      error: status.error ?? null,
      voiceCount: status.voices.length,
      config: status.config,
      // Locales are the useful axis for picking an Azure voice; the exe vendor
      // reports none and the UI hides the filter accordingly.
      locales: [...new Set(status.voiceDetails.map((v) => v.locale).filter(Boolean))].sort(),
    });
  }
  return buildReport({
    capability: 'speech',
    active: active.vendor,
    activeSource: active.source,
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
  const resolved = await resolveSpeechVendor({ vendor, dataDir, settings });
  const status = await checkSpeechVendor(resolved.vendor, { dataDir, settings, timeoutMs, force });
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
  return vendor === 'azure'
    ? (status) => status?.config?.setupHint ||
      `Check ${AZURE_ENV.key[1]} / ${AZURE_ENV.region[1]} in the environment, or the Studio's vendors page.`
    : () => 'Build MotionStudioTts.exe and set MOTION_STUDIO_TTS_EXE to its path (Windows only), or switch the ' +
      'speech vendor to "azure" on the Studio\'s vendors page.';
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
 */
export async function synthesizeWithVendor({
  vendor, text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
  dataDir, settings, timeoutMs,
}) {
  const resolved = await resolveSpeechVendor({ vendor, dataDir, settings });
  const warnings = [];

  if (resolved.vendor === 'system') {
    for (const [name, value] of Object.entries({ style, styleDegree, role, pitch })) {
      if (value !== undefined && value !== null) {
        warnings.push(`"${name}" is an Azure-only option and was ignored by the system vendor`);
      }
    }
    // No probe first: synthesizeSpeech already maps a missing/unstartable exe
    // to tts_unavailable, and probing here would spawn the exe twice on every
    // narration call (the MCP tool probes once, before it touches the project).
    const result = await synthesizeSpeech({
      text, outPath, voice, rate, volume, ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { ...result, vendor: 'system', vendorSource: resolved.source, warnings };
  }

  const tts = await ttsSettings(dataDir, settings);
  const result = await synthesizeAzureSpeech({
    text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
    azure: tts.azure ?? {},
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { ...result, vendorSource: resolved.source, warnings };
}
