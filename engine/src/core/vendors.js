/**
 * Vendors — the capability-agnostic half (v0.17).
 *
 * Motion Studio has three capabilities with more than one possible
 * implementation:
 *
 *   speech         →  system (Windows exe)  |  azure (Azure AI Speech)  |  …
 *   music          →  node   (spessasynth)  |  fluidsynth (C# exe + fluidsynth.exe)
 *   transcription  →  whisper-cpp (whisper-cli.exe + a ggml model)   — v0.22
 *
 * Everything those axes share lives here — the selection rule, the env
 * hooks, the shape of a status report, and the sentence a caller sees when a
 * vendor cannot be used. `core/tts-vendors.js`, `core/music-vendors.js` and
 * `core/transcribe-vendors.js` supply the per-capability providers on top.
 *
 * Transcription has exactly one vendor today and still lives here rather than
 * standing alone: a capability with one provider costs nothing extra to run
 * through the kit, and the alternative — a second, near-identical resolution
 * path — is what the kit exists to prevent.
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
 * ## Preference chains (v0.19)
 *
 * A settings file may name an ordered *chain* (`tts.vendors` / `music.vendors`)
 * instead of a single vendor, and the env var accepts a comma-separated list for
 * the same purpose. Resolution then walks the chain and uses the first entry
 * that is actually **configured and available**.
 *
 * Until v0.19 this module said there was no "try the other one" anywhere, on the
 * grounds that a machine quietly swapping synthesizers mid-film would produce a
 * soundtrack that changes character between scenes. That reasoning still holds,
 * so the fallback is deliberately narrow and the guarantees it keeps are:
 *
 *   - **A named vendor is never redirected.** An `argument` or a single-valued
 *     env var resolves to a one-entry chain, so an explicit request either runs
 *     on that vendor or fails saying why. Agents asking for `azure` never get
 *     `piper` instead.
 *   - **Only *unavailability* is fallen back past, never failure.** The walk
 *     skips a vendor whose probe says it is not set up (no key, no exe, no
 *     voices). A vendor that probes fine and then fails during synthesis is
 *     still a hard error — the mix is not silently finished by someone else.
 *   - **A one-entry chain probes nothing.** The default settings are exactly
 *     that, so single-vendor machines keep the old behaviour and the old cost:
 *     no extra exe spawns or network round-trips at resolution time.
 *   - **Falling back is reported, never silent** (`skipped` here, `vendorNote`
 *     over MCP, the chain badges on the Studio's vendor pages).
 *
 * The honest caveat: with a chain of two or more, the choice is made per call,
 * so a vendor that becomes unavailable *between* two narration calls in one film
 * will change the voice of everything after it. That is the price of the
 * feature; a one-entry chain declines to pay it.
 */

import { EngineError, ErrorCodes } from './errors.js';

export const CAPABILITIES = Object.freeze(['speech', 'music', 'transcription']);

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
  // v0.22. The first capability that *reads* audio rather than writing it; it
  // joins the kit because everything above the provider is identical — the
  // selection rule, the chain walk, the report shape, and the sentence a caller
  // sees when nothing is set up. See core/transcribe-vendors.js.
  transcription: Object.freeze({
    id: 'transcription',
    label: 'transcription',
    env: 'MOTION_STUDIO_TRANSCRIPTION_VENDOR',
    settingsKey: 'transcription',
    unavailableCode: ErrorCodes.TRANSCRIPTION_UNAVAILABLE,
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
 * Clean a raw preference list into a usable chain: known vendors only, in the
 * order given, first occurrence of each kept. Returns null for anything that is
 * not a usable chain, so callers can treat "no chain" and "empty chain"
 * identically and fall through to the scalar setting.
 *
 * Unknown ids are dropped rather than thrown on, because this also runs over the
 * settings file *as stored* — which may have been hand-edited or written by a
 * newer build that knows a vendor this one doesn't. validateSettings() is where
 * a bad chain is refused loudly; here the job is to keep working.
 */
export function normalizeVendorChain(value, allowed) {
  if (!Array.isArray(value)) return null;
  const chain = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (allowed.includes(id) && !chain.includes(id)) chain.push(id);
  }
  return chain.length ? chain : null;
}

/**
 * Resolve which vendor a capability uses, and why.
 *
 * `storedVendor`/`storedVendors` must come from the settings file **as written**
 * rather than from the merged defaults, so the Studio can tell "the user picked
 * this" from "this is what ships" — the two read identically once defaults are
 * applied.
 *
 * `chain` is the ordered candidate list, and `vendor` is its head: the answer
 * for every caller that does not care about fallback. A chain longer than one
 * entry only ever comes from a settings array or a comma-separated env var —
 * an explicitly named vendor always yields a chain of exactly itself.
 *
 * @returns {{vendor: string, source: 'argument'|'env'|'settings'|'default', chain: string[]}}
 */
export function resolveVendorFrom(capability, { vendor, storedVendor, storedVendors, allowed, fallback }) {
  const meta = requireCapability(capability);
  if (vendor) {
    if (!allowed.includes(vendor)) throw badVendor(capability, vendor, allowed);
    return { vendor, source: 'argument', chain: [vendor] };
  }
  const env = process.env[meta.env]?.trim();
  if (env) {
    // "piper,system" is a preference chain; "piper" is a chain of one. Unknown
    // ids throw here (unlike the stored chain): someone typed this by hand just
    // now, and a typo they can still see is worth failing on.
    const ids = env.split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) if (!allowed.includes(id)) throw badVendor(capability, id, allowed);
    const chain = normalizeVendorChain(ids, allowed);
    if (chain) return { vendor: chain[0], source: 'env', chain };
  }
  const stored = normalizeVendorChain(storedVendors, allowed);
  if (stored) return { vendor: stored[0], source: 'settings', chain: stored };
  if (storedVendor && allowed.includes(storedVendor)) {
    return { vendor: storedVendor, source: 'settings', chain: [storedVendor] };
  }
  return { vendor: fallback, source: 'default', chain: [fallback] };
}

/**
 * Walk a resolved chain and pick the first vendor that is actually usable.
 *
 * A one-entry chain returns immediately **without probing** — that is the
 * default configuration, and resolution has never cost an exe spawn before; the
 * caller probes it as it always has. Only a real chain pays for the walk.
 *
 * When nothing in the chain is usable, this reports the *head* of the chain (the
 * user's first preference) along with its status, so the caller's existing
 * "unavailable" path fires on the vendor they actually asked for rather than on
 * whichever one happened to be last.
 *
 * @param {object} resolved  the {vendor, source, chain} from resolveVendorFrom
 * @param {(id: string) => Promise<{available: boolean, error?: string}>} probe
 * @returns {Promise<{vendor, source, chain, status: object|null,
 *                    skipped: Array<{vendor: string, error: string}>, exhausted?: true}>}
 */
export async function walkVendorChain({ vendor, source, chain }, probe) {
  if (!chain || chain.length <= 1) return { vendor, source, chain: chain ?? [vendor], status: null, skipped: [] };
  const skipped = [];
  let headStatus = null;
  for (const id of chain) {
    const status = await probe(id);
    if (headStatus === null) headStatus = status;
    if (status?.available) return { vendor: id, source, chain, status, skipped };
    skipped.push({ vendor: id, error: status?.error ?? 'unavailable' });
  }
  return { vendor: chain[0], source, chain, status: headStatus, skipped, exhausted: true };
}

/**
 * One sentence describing a fallback that happened, or null when the resolution
 * ran on the caller's first choice. Shared so the MCP tools and the Studio say
 * the same thing — a fallback the user cannot see is the failure mode this
 * feature has to avoid.
 */
export function chainFallbackNote(capability, resolved) {
  if (!resolved?.skipped?.length || resolved.exhausted) return null;
  const past = resolved.skipped.map((s) => `"${s.vendor}"`).join(', ');
  return `Used the ${capability} vendor "${resolved.vendor}": ${past} ${resolved.skipped.length > 1 ? 'are' : 'is'} ` +
    `higher priority but not available on this machine (chain: ${resolved.chain.join(' → ')}).`;
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
export function buildReport({ capability, active, activeSource, settings, vendors, chain }) {
  const meta = requireCapability(capability);
  const order = chain ?? [active];
  return {
    capability,
    // What will actually be used. With a chain this is the effective vendor —
    // the first available one — not merely the top preference, because "active"
    // has always meant "the one that runs" and a chain must not quietly change
    // that to "the one we hoped would run".
    active,
    activeSource,
    // The preference order itself (v0.19), plus its head, so a UI can show
    // ranking and mark the case where the top choice is being skipped.
    chain: order,
    preferred: order[0],
    fellBack: active !== order[0],
    settings,
    vendorEnv: meta.env,
    vendors,
  };
}
