/**
 * Vendors — the capability-agnostic half (v0.17).
 *
 * Motion Studio has two generators with more than one possible implementation:
 *
 *   speech  →  system (Windows exe)  |  azure (Azure AI Speech)
 *   music   →  node   (spessasynth)  |  fluidsynth (C# exe + fluidsynth.exe)
 *
 * Everything those two axes share lives here — the selection rule, the env
 * hooks, the shape of a status report, and the sentence a caller sees when a
 * vendor cannot be used. `core/tts-vendors.js` and `core/music-vendors.js`
 * supply the per-capability providers on top.
 *
 * This module imports neither of them: capability modules depend on the shared
 * kit, never the reverse, so there is no cycle and no registry to keep in sync.
 * A consumer that wants both (the Studio's vendors page, the MCP
 * `list_vendors` tool) asks each capability module directly.
 *
 * The one rule worth stating plainly: **selection is explicit and layered**,
 *
 *   argument  >  MOTION_STUDIO_<CAP>_VENDOR  >  settings.json  >  built-in default
 *
 * and there is no "try the other one if this fails" anywhere. A machine that
 * quietly swapped synthesizers mid-film would produce a soundtrack that changes
 * character between scenes, which is far worse than a clear failure naming what
 * to install.
 */

import { EngineError, ErrorCodes } from './errors.js';

export const CAPABILITIES = Object.freeze(['speech', 'music']);

/** Per-capability env hook and settings section. */
export const CAPABILITY_META = Object.freeze({
  speech: Object.freeze({
    id: 'speech',
    label: 'speech',
    env: 'MOTION_STUDIO_TTS_VENDOR',
    settingsKey: 'tts',
    unavailableCode: ErrorCodes.TTS_UNAVAILABLE,
  }),
  music: Object.freeze({
    id: 'music',
    label: 'music',
    env: 'MOTION_STUDIO_MUSIC_VENDOR',
    settingsKey: 'music',
    unavailableCode: ErrorCodes.MUSIC_UNAVAILABLE,
  }),
});

export function requireCapability(capability) {
  const meta = CAPABILITY_META[capability];
  if (!meta) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `Unknown vendor capability "${capability}" — expected one of: ${CAPABILITIES.join(', ')}`,
      { capability, allowed: CAPABILITIES },
    );
  }
  return meta;
}

export function badVendor(capability, vendor, allowed) {
  return new EngineError(
    ErrorCodes.INVALID_CONFIG,
    `Unknown ${capability} vendor "${vendor}" — expected one of: ${allowed.join(', ')}`,
    { capability, vendor, allowed },
  );
}

/**
 * Resolve which vendor a capability uses, and why.
 *
 * `storedVendor` must come from the settings file **as written** rather than
 * from the merged defaults, so the Studio can tell "the user picked this" from
 * "this is what ships" — the two read identically once defaults are applied.
 *
 * @returns {{vendor: string, source: 'argument'|'env'|'settings'|'default'}}
 */
export function resolveVendorFrom(capability, { vendor, storedVendor, allowed, fallback }) {
  const meta = requireCapability(capability);
  if (vendor) {
    if (!allowed.includes(vendor)) throw badVendor(capability, vendor, allowed);
    return { vendor, source: 'argument' };
  }
  const env = process.env[meta.env]?.trim();
  if (env) {
    if (!allowed.includes(env)) throw badVendor(capability, env, allowed);
    return { vendor: env, source: 'env' };
  }
  if (storedVendor && allowed.includes(storedVendor)) return { vendor: storedVendor, source: 'settings' };
  return { vendor: fallback, source: 'default' };
}

/**
 * The one place that phrases "this vendor cannot be used right now".
 *
 * `alternatives` names the vendors that *are* usable, because the most useful
 * thing to tell someone whose Azure key is missing is that the local exe is
 * sitting there ready — and the most useful thing to tell an agent is that
 * retrying will not help, but naming another vendor might.
 */
export function unavailableError(capability, vendor, status, { fix, alternatives = [] } = {}) {
  const meta = requireCapability(capability);
  // The provider's message is a complete sentence; strip its full stop rather
  // than emitting "…do not retry blindly.. Check AZURE_SPEECH_KEY…".
  const because = (status?.error ?? 'unknown reason').replace(/\s*\.\s*$/, '');
  const others = alternatives.length
    ? ` The ${capability} vendor${alternatives.length > 1 ? 's' : ''} ${alternatives.map((v) => `"${v}"`).join(' / ')} ` +
      `${alternatives.length > 1 ? 'are' : 'is'} available on this machine if you want to use ${alternatives.length > 1 ? 'one of those' : 'that'} instead.`
    : '';
  return new EngineError(
    meta.unavailableCode,
    `The ${capability} vendor "${vendor}" is not available: ${because}. ${fix}${others} ` +
      'This is a setup problem for the user to fix — do not retry blindly.',
    { capability, vendor, error: status?.error, config: status?.config, alternatives },
  );
}

/**
 * Assemble one capability's report from its per-vendor probes. Kept here so the
 * speech and music pages of the Studio are fed by identical shapes and the UI
 * can render either with one code path.
 */
export function buildReport({ capability, active, activeSource, settings, vendors }) {
  const meta = requireCapability(capability);
  return {
    capability,
    active,
    activeSource,
    settings,
    vendorEnv: meta.env,
    vendors,
  };
}
