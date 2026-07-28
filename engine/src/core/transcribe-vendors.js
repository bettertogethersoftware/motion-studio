/**
 * Transcription vendors — one dispatch point for reading speech (v0.22).
 *
 * The twin of core/tts-vendors.js and core/music-vendors.js, for the capability
 * that runs the other way: `transcribe_asset` turns supplied media into text
 * plus per-sentence and per-word timing. There is exactly **one** vendor today
 * (whisper.cpp, core/transcribe-whisper.js) and this module still exists, for
 * the same reason the music capability had a dispatcher while it had one
 * synthesizer: the parts above the provider — the selection rule, the chain
 * walk, the report shape, the "not set up" sentence — are shared with the other
 * capabilities in core/vendors.js, and re-deriving them per capability is what
 * that kit exists to prevent.
 *
 * Precedence, as everywhere:
 *
 *   explicit argument  >  MOTION_STUDIO_TRANSCRIPTION_VENDOR
 *                      >  settings.transcription.vendor  >  "whisper-cpp"
 *
 * A provider returns `{ vendor, model, language, segments, tokens }` in
 * milliseconds and nothing else vendor-shaped; every derivation an agent
 * actually consumes (sentence re-segmentation, words, frames, speech ranges)
 * lives once in core/transcribe.js, above this line. That split is the whole
 * value proposition — a shell can run whisper-cli, but then it re-derives
 * sentence boundaries by hand, per session, from millisecond offsets.
 */

import {
  checkWhisperTranscription, transcribeWithWhisper, whisperSetupHint, WHISPER_ENV, MODEL_PREFERENCE,
} from './transcribe-whisper.js';
import { readSettings, readStoredSettings, TRANSCRIPTION_VENDORS } from './settings.js';
import {
  resolveVendorFrom, walkVendorChain, unavailableError, buildReport,
} from './vendors.js';
import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './scene.js';

export { TRANSCRIPTION_VENDORS, WHISPER_ENV, MODEL_PREFERENCE };

export const DEFAULT_TRANSCRIPTION_VENDOR = 'whisper-cpp';

export const VENDOR_INFO = Object.freeze({
  'whisper-cpp': Object.freeze({
    id: 'whisper-cpp',
    label: 'whisper.cpp (local)',
    summary: 'OpenAI\'s Whisper models running entirely on this machine through whisper.cpp — no account, no API key, ' +
      'no network, any OS. One self-contained binary plus one ggml model file you download. Measured ≈6.5× realtime ' +
      'on ggml-small.en with 8 CPU threads, no GPU.',
    requires: `${WHISPER_ENV.bin[0]} (or whisper-cli on PATH) + a ggml-*.bin model ` +
      `(${WHISPER_ENV.model[0]}, ${WHISPER_ENV.models[0]}, or a "models" folder beside the binary)`,
    offline: true,
  }),
});

const isVendor = (v) => TRANSCRIPTION_VENDORS.includes(v);

/** Load settings.transcription once, tolerating a missing/older settings file. */
export async function transcriptionSettings(dataDir, settings) {
  if (settings) return settings.transcription ?? { vendor: DEFAULT_TRANSCRIPTION_VENDOR, whisper: {} };
  const s = await readSettings(dataDir ?? defaultDataDir()).catch(() => null);
  return s?.transcription ?? { vendor: DEFAULT_TRANSCRIPTION_VENDOR, whisper: {} };
}

/**
 * Which vendor reads speech, and why. `probe: true` additionally walks a
 * multi-entry chain to the first available vendor — a one-entry chain (today's
 * only possibility) probes nothing, exactly as the speech capability does.
 */
export async function resolveTranscriptionVendor({ vendor, dataDir, settings, probe = false, timeoutMs } = {}) {
  const stored = settings
    ? settings.transcription
    : (await readStoredSettings(dataDir ?? defaultDataDir()).catch(() => null))?.transcription;
  const resolved = resolveVendorFrom('transcription', {
    vendor,
    storedVendor: stored?.vendor,
    storedVendors: stored?.vendors,
    allowed: TRANSCRIPTION_VENDORS,
    fallback: DEFAULT_TRANSCRIPTION_VENDOR,
  });
  if (!probe) return resolved;
  return walkVendorChain(resolved, (id) => checkTranscriptionVendor(id, { dataDir, settings, timeoutMs }));
}

/**
 * Probe one vendor. Never throws for an unavailable vendor (that is data, not an
 * error) — only for an unknown vendor id.
 *
 * @returns {Promise<{vendor, available, models?: string[], modelDetails?: object[],
 *                    error?: string, config?: object}>}
 */
export async function checkTranscriptionVendor(vendor, { dataDir, settings, timeoutMs } = {}) {
  if (!isVendor(vendor)) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      `Unknown transcription vendor "${vendor}" — expected one of: ${TRANSCRIPTION_VENDORS.join(', ')}`,
      { vendor, allowed: TRANSCRIPTION_VENDORS },
    );
  }
  const whisper = (await transcriptionSettings(dataDir, settings)).whisper ?? {};
  const probe = await checkWhisperTranscription({ whisper, ...(timeoutMs ? { timeoutMs } : {}) });
  return {
    vendor,
    available: probe.available,
    models: probe.models ?? [],
    modelDetails: probe.modelDetails ?? [],
    error: probe.error,
    config: probe.config,
  };
}

/**
 * The whole transcription surface in one object: which vendor is active, where
 * that choice came from, and the live status of every vendor. Backs the Studio's
 * transcription page and the `list_vendors` MCP tool — same shape as its speech
 * and music twins, so one UI renders all three.
 */
export async function transcriptionVendorReport({ dataDir, settings, probe = true, timeoutMs } = {}) {
  const transcription = await transcriptionSettings(dataDir, settings);
  const resolved = await resolveTranscriptionVendor({ dataDir, settings });
  const chain = resolved.chain;
  const vendors = [];
  for (const id of TRANSCRIPTION_VENDORS) {
    const info = VENDOR_INFO[id];
    const priority = chain.includes(id) ? chain.indexOf(id) + 1 : null;
    if (!probe) {
      vendors.push({ ...info, active: id === resolved.vendor, priority, available: null, modelCount: null });
      continue;
    }
    const status = await checkTranscriptionVendor(id, { dataDir, settings, timeoutMs });
    vendors.push({
      ...info,
      priority,
      available: status.available,
      error: status.error ?? null,
      modelCount: status.models.length,
      models: status.modelDetails,
      config: status.config,
    });
  }
  const usable = probe ? chain.find((id) => vendors.find((v) => v.id === id)?.available) : null;
  const active = usable ?? resolved.vendor;
  for (const v of vendors) v.active = v.id === active;
  return buildReport({
    capability: 'transcription',
    active,
    activeSource: resolved.source,
    chain,
    settings: transcription,
    vendors,
  });
}

/** The models one vendor can run, for a picker. Throws when it is not set up. */
export async function listTranscriptionModels({ vendor, dataDir, settings, timeoutMs } = {}) {
  const resolved = await resolveTranscriptionVendor({ vendor, dataDir, settings, probe: true, timeoutMs });
  const status = resolved.status ?? await checkTranscriptionVendor(resolved.vendor, { dataDir, settings, timeoutMs });
  if (!status.available) throw await unavailableWithAlternatives(resolved.vendor, status, { dataDir, settings });
  return {
    vendor: resolved.vendor,
    vendorSource: resolved.source,
    active: status.config?.activeModel ?? null,
    models: status.modelDetails,
  };
}

/** How to fix each transcription vendor, in one sentence. */
function fixFor(vendor) {
  if (vendor === 'whisper-cpp') {
    return (status) => whisperSetupHint({ modelsDir: status?.config?.modelsDir });
  }
  return () => 'Configure a transcription vendor on the Studio\'s transcribe page.';
}

/** The transcription vendors that *are* usable, so a failure can point somewhere. */
async function availableAlternatives(failing, opts) {
  const others = [];
  for (const id of TRANSCRIPTION_VENDORS) {
    if (id === failing) continue;
    const probe = await checkTranscriptionVendor(id, { ...opts, timeoutMs: 4000 }).catch(() => null);
    if (probe?.available) others.push(id);
  }
  return others;
}

export function unavailable(vendor, status, alternatives = []) {
  return unavailableError('transcription', vendor, status, { fix: fixFor(vendor)(status), alternatives });
}

export async function unavailableWithAlternatives(vendor, status, opts = {}) {
  return unavailable(vendor, status, await availableAlternatives(vendor, opts));
}

/**
 * Transcribe a 16 kHz mono WAV through whichever vendor is active (or the one
 * named). `resolved` lets a caller that has already resolved (and probed) hand
 * the decision in, so the probe that guarded the work and the run that follows
 * it cannot disagree — the same rule synthesizeWithVendor follows.
 */
export async function transcribeWithVendor({
  vendor, wavPath, model, language, threads,
  dataDir, settings, timeoutMs, signal, resolved: preResolved,
}) {
  const resolved = preResolved
    ?? await resolveTranscriptionVendor({ vendor, dataDir, settings, probe: true });
  const transcription = await transcriptionSettings(dataDir, settings);
  // With one vendor this is a straight call; resolveTranscriptionVendor has
  // already refused anything that is not in TRANSCRIPTION_VENDORS, so a second
  // vendor lands here as a branch rather than as a validation hole.
  const result = await transcribeWithWhisper({
    wavPath, model, language, threads,
    whisper: transcription.whisper ?? {},
    ...(timeoutMs ? { timeoutMs } : {}),
    signal,
  });
  return { ...result, vendorSource: resolved.source };
}
