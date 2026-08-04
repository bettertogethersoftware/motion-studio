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

import { readSettings, readStoredSettings } from './settings.js';
import {
  resolveVendorFrom, walkVendorChain, unavailableError, buildReport,
} from './vendors.js';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './scene.js';

export const DEFAULT_SPEECH_VENDOR = 'system';

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
