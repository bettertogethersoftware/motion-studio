/**
 * ElevenLabs — cloud narration vendor (v0.20).
 *
 * The quality pick among the cloud speech vendors: ElevenLabs' voices are the
 * best-regarded of the REST-reachable ones, and its free tier includes API
 * access (10,000 credits/month, attribution required, no commercial license) —
 * so a user can audition it without a card. Like the Azure vendor
 * (core/tts-azure.js, whose shape this module deliberately clones), it is
 * plain `fetch` — no SDK, no npm dependency — and serves the same narration
 * contract so core/tts-vendors.js can dispatch to it interchangeably:
 *
 *   checkElevenlabsTts()          → { available, voices, voiceDetails, config|error }
 *   synthesizeElevenlabsSpeech()  → { ok, vendor, voice, durationSeconds, … }
 *
 * Credentials never live in settings.json — the key is read from the machine's
 * environment only, so a shared settings file can never leak one. Everything
 * else (default voice, model, output format) may come from settings, and an
 * explicit argument always wins.
 *
 *   MOTION_STUDIO_ELEVENLABS_KEY / ELEVENLABS_API_KEY / XI_API_KEY
 *   MOTION_STUDIO_ELEVENLABS_ENDPOINT   (default https://api.elevenlabs.io —
 *                                        the override exists for tests)
 *   MOTION_STUDIO_ELEVENLABS_VOICE      default voice_id or display name
 *
 * Two REST calls carry the whole feature (both authenticated with the
 * `xi-api-key` header):
 *
 *   GET  {endpoint}/v2/voices?page_size=100          (paged: next_page_token)
 *   POST {endpoint}/v1/text-to-speech/{voice_id}?output_format=wav_24000
 *        body: { text, model_id, seed?, voice_settings? } → binary WAV
 *
 * Output is requested as `wav_*` precisely because the rest of the engine
 * already speaks PCM WAV: those formats are headered RIFF, so the duration is
 * re-derived from the header the same way as every other vendor
 * (parseWavHeader), and FFmpeg re-encodes it at mux time. The default is
 * wav_24000 rather than 44.1k+ because ElevenLabs gates the high-rate WAV
 * formats to Pro plans — the default must work on the free tier.
 *
 * Model notes (settings.tts.elevenlabs.model overrides): the default
 * `eleven_multilingual_v2` is the proven narration model with a 10,000-char
 * request limit; `eleven_v3` is more expressive but capped at 5,000 chars;
 * `eleven_flash_v2_5` is the cheap/fast option. The engine does not chunk for
 * this vendor — film narration lines fit comfortably under the default cap.
 */

import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from '../../../core/errors.js';
import { parseWavHeader } from '../../../core/audio.js';
import { maskKey } from './azure.js';

/** Env hooks, in precedence order. Exported so the UI/docs list one truth. */
export const ELEVENLABS_ENV = Object.freeze({
  key: Object.freeze(['MOTION_STUDIO_ELEVENLABS_KEY', 'ELEVENLABS_API_KEY', 'XI_API_KEY']),
  endpoint: Object.freeze(['MOTION_STUDIO_ELEVENLABS_ENDPOINT']),
  voice: Object.freeze(['MOTION_STUDIO_ELEVENLABS_VOICE']),
});

/**
 * Only headered WAV output formats are offered. ElevenLabs will happily return
 * mp3/opus/raw pcm, but the engine's narration contract is "a PCM WAV whose
 * header is the authoritative duration", and every downstream consumer
 * (duration → frames, the audio mixer, the Studio's audition player) assumes it.
 */
export const ELEVENLABS_WAV_FORMATS = Object.freeze([
  'wav_8000',
  'wav_16000',
  'wav_22050',
  'wav_24000',
  'wav_44100',
  'wav_48000',
]);

/** 44.1k+ WAV is a Pro-plan feature; 24 kHz works on every tier. */
export const ELEVENLABS_DEFAULT_FORMAT = 'wav_24000';

export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

const DEFAULT_ENDPOINT = 'https://api.elevenlabs.io';

/**
 * ElevenLabs honours a request seed for reproducible synthesis. The value is
 * arbitrary but must be *stable*: the point of `deterministic` (same intent as
 * the Piper flag) is that identical input yields identical output across runs.
 */
const DETERMINISTIC_SEED = 1337;

const VOICE_PAGE_SIZE = 100;
/** A library bigger than this is a paging bug or an account we should not enumerate. */
const MAX_VOICE_PAGES = 3;

/** Voice libraries change rarely; re-fetching per call is waste. */
const VOICE_CACHE_TTL_MS = 10 * 60 * 1000;
const voiceCache = new Map(); // cacheKey → { expires, voices }

/** Drop cached voice lists (a key change must not be masked by cache). */
export function clearElevenlabsVoiceCache() {
  voiceCache.clear();
}

function pickEnv(names, env) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { value, source: name };
  }
  return { value: null, source: null };
}

/**
 * Resolve every knob the ElevenLabs vendor needs, recording where each value
 * came from so the Studio can show "voice: Rachel (from settings)" instead of
 * leaving the user to guess which layer won.
 *
 *   explicit argument  >  environment  >  settings.tts.elevenlabs  >  built-in default
 *
 * The key is the exception: environment only, never settings.
 *
 * @returns {{key, keySource, keyMasked, endpoint, endpointSource,
 *            voice, voiceSource, model, outputFormat, missing: string[]}}
 */
export function resolveElevenlabsConfig({
  key, endpoint, voice, model, outputFormat,
  elevenlabs = {},         // settings.tts.elevenlabs
  env = process.env,
} = {}) {
  const fromEnv = {
    key: pickEnv(ELEVENLABS_ENV.key, env),
    endpoint: pickEnv(ELEVENLABS_ENV.endpoint, env),
    voice: pickEnv(ELEVENLABS_ENV.voice, env),
  };
  const layered = (explicit, envHit, settingValue) => {
    const e = typeof explicit === 'string' ? explicit.trim() : explicit;
    if (e) return { value: e, source: 'argument' };
    if (envHit.value) return { value: envHit.value, source: envHit.source };
    const s = typeof settingValue === 'string' ? settingValue.trim() : settingValue;
    if (s) return { value: s, source: 'settings' };
    return { value: null, source: null };
  };

  const k = key?.trim() ? { value: key.trim(), source: 'argument' } : fromEnv.key;
  const ep = layered(endpoint, fromEnv.endpoint, elevenlabs.endpoint);
  const v = layered(voice, fromEnv.voice, elevenlabs.voice);

  const missing = [];
  if (!k.value) missing.push('key');

  return {
    key: k.value,
    keySource: k.source,
    keyMasked: maskKey(k.value),
    endpoint: ep.value ? ep.value.replace(/\/+$/, '') : DEFAULT_ENDPOINT,
    endpointSource: ep.value ? ep.source : 'default',
    voice: v.value,
    voiceSource: v.source,
    model: model?.trim() || elevenlabs.model || ELEVENLABS_DEFAULT_MODEL,
    outputFormat: outputFormat?.trim() || elevenlabs.outputFormat || ELEVENLABS_DEFAULT_FORMAT,
    missing,
  };
}

/** How to fix an unconfigured vendor — the same sentence everywhere it matters. */
export function elevenlabsSetupHint(cfg) {
  if (!cfg.missing.includes('key')) return '';
  return `ElevenLabs is not configured: set ${ELEVENLABS_ENV.key[1]} to an API key from elevenlabs.io ` +
    '(profile → API keys). The free tier includes API access — 10,000 credits/month, attribution required, ' +
    `no commercial license. On Windows: setx ${ELEVENLABS_ENV.key[1]} "<key>" (open a new terminal afterwards).`;
}

function requireElevenlabsConfig(cfg) {
  if (cfg.missing.length) {
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, elevenlabsSetupHint(cfg), {
      vendor: 'elevenlabs',
      missing: cfg.missing,
      envHooks: { key: ELEVENLABS_ENV.key },
    });
  }
  return cfg;
}

/* ------------------------------- REST calls ------------------------------- */

const USER_AGENT = 'motion-studio';

async function elevenFetch(url, init, { timeoutMs, what }) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // A DNS/TLS/timeout failure is not a synthesis failure — the service was
    // never reached. Callers decide whether that is fatal or just "unavailable".
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || String(err);
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, `Could not reach ElevenLabs (${what}): ${reason}`, {
      vendor: 'elevenlabs', url, reason,
    });
  }
}

/** Read an error response body without letting a huge/binary payload through. */
async function errorBody(res) {
  try {
    return (await res.text()).slice(0, 500).trim();
  } catch {
    return '';
  }
}

/**
 * Map an HTTP failure onto the engine's stable codes. A rejected key is a
 * *setup* problem (tts_unavailable — the caller must stop and tell the user),
 * everything else is a synthesis failure (tts_failed).
 */
function httpError(res, body, { what }) {
  const detail = { vendor: 'elevenlabs', status: res.status, body: body || undefined };
  if (res.status === 401 || res.status === 403) {
    return new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      `ElevenLabs rejected the credentials (HTTP ${res.status}) — check ${ELEVENLABS_ENV.key[1]}. ` +
        'Fix the environment variable, then retry; do not retry blindly.',
      detail,
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return new EngineError(
      ErrorCodes.TTS_FAILED,
      `ElevenLabs rate/quota limit hit (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ''} — on the free tier this usually means the monthly credits ran out.`,
      { ...detail, retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined },
    );
  }
  return new EngineError(ErrorCodes.TTS_FAILED, `ElevenLabs ${what} failed (HTTP ${res.status})${body ? `: ${body}` : ''}`, detail);
}

/**
 * Fetch (and cache) the account's voice library, walking `next_page_token`
 * until the service says `has_more: false` (capped defensively — an account
 * with 300+ voices is not one we should exhaustively enumerate per call).
 *
 * @returns {Promise<Array<object>>} raw ElevenLabs voice objects (voice_id, name, …)
 */
export async function listElevenlabsVoices(cfg, { timeoutMs = 15_000, force = false } = {}) {
  requireElevenlabsConfig(cfg);
  const cacheKey = `${cfg.endpoint}|${cfg.key}`;
  const hit = voiceCache.get(cacheKey);
  if (!force && hit && hit.expires > Date.now()) return hit.voices;

  const voices = [];
  let pageToken = null;
  for (let page = 0; page < MAX_VOICE_PAGES; page++) {
    const url = new URL(`${cfg.endpoint}/v2/voices`);
    url.searchParams.set('page_size', String(VOICE_PAGE_SIZE));
    if (pageToken) url.searchParams.set('next_page_token', pageToken);

    const res = await elevenFetch(url, {
      method: 'GET',
      headers: { 'xi-api-key': cfg.key, 'User-Agent': USER_AGENT },
    }, { timeoutMs, what: 'voices' });
    if (!res.ok) throw httpError(res, await errorBody(res), { what: 'voices' });

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new EngineError(ErrorCodes.TTS_FAILED, `ElevenLabs returned an unreadable voice list: ${e.message}`, { vendor: 'elevenlabs' });
    }
    if (!Array.isArray(data?.voices)) {
      throw new EngineError(ErrorCodes.TTS_FAILED, 'ElevenLabs voice list had no voices array', { vendor: 'elevenlabs' });
    }
    voices.push(...data.voices);
    if (!data.has_more || !data.next_page_token) break;
    pageToken = data.next_page_token;
  }

  voiceCache.set(cacheKey, { expires: Date.now() + VOICE_CACHE_TTL_MS, voices });
  return voices;
}

/**
 * Normalize one ElevenLabs voice object into the shape the UI and MCP hand
 * out. `name` is the voice_id — the only stable handle the API accepts —
 * with the human name kept as displayName; locale/styles are carried as
 * null/empty so every vendor's voice shape matches (ElevenLabs voices are
 * multilingual and carry free-form labels instead).
 */
export function normalizeElevenlabsVoice(v) {
  return {
    name: v.voice_id ?? null,
    displayName: v.name ?? v.voice_id ?? null,
    category: v.category ?? null,
    labels: v.labels && typeof v.labels === 'object' ? v.labels : {},
    locale: null,
    localeName: null,
    gender: v.labels?.gender ?? null,
    styles: [],
    previewUrl: v.preview_url ?? null,
  };
}

/**
 * Probe the vendor: does it have a key, and can it reach the service? Never
 * throws — same contract as the other vendors' checks, so the tool layer can
 * report `tts_unavailable` with a useful hint while the rest of the engine
 * keeps working.
 */
export async function checkElevenlabsTts({ timeoutMs = 15_000, force = false, ...opts } = {}) {
  const cfg = resolveElevenlabsConfig(opts);
  if (cfg.missing.length) return { available: false, error: elevenlabsSetupHint(cfg), config: cfg };
  try {
    const raw = await listElevenlabsVoices(cfg, { timeoutMs, force });
    const voiceDetails = raw.map(normalizeElevenlabsVoice).filter((v) => v.name);
    return {
      available: true,
      voices: voiceDetails.map((v) => v.name),
      voiceDetails,
      config: cfg,
    };
  } catch (err) {
    return { available: false, error: err.message, code: err.code, config: cfg };
  }
}

/* ------------------------------ voice picking ----------------------------- */

/**
 * Resolve the requested voice against the account's library. A voice_id is
 * accepted verbatim; a display name is accepted only when it matches exactly
 * one voice (case-insensitively) — "Rachel" is a fine handle for an agent, but
 * two voices sharing a name must not resolve to whichever came first. An
 * unknown voice is a hard error with suggestions rather than a silent
 * substitution — the same rule every other speech vendor follows.
 */
export function pickElevenlabsVoice(requested, catalogue) {
  const voices = catalogue.map(normalizeElevenlabsVoice).filter((v) => v.name);
  if (requested) {
    const want = requested.trim();
    const wantLower = want.toLowerCase();
    const exact = voices.find((v) => v.name === want)
      ?? voices.find((v) => v.name.toLowerCase() === wantLower);
    if (exact) return { voice: exact, source: 'requested' };
    const byDisplay = voices.filter((v) => (v.displayName ?? '').toLowerCase() === wantLower);
    if (byDisplay.length === 1) return { voice: byDisplay[0], source: 'requested' };

    const near = (byDisplay.length ? byDisplay : voices.filter((v) =>
      (v.displayName ?? '').toLowerCase().includes(wantLower)))
      .slice(0, 8)
      .map((v) => v.name);
    throw new EngineError(
      ErrorCodes.UNSUPPORTED_VOICE,
      byDisplay.length > 1
        ? `ElevenLabs has ${byDisplay.length} voices named "${requested}" — pass the voice_id instead (see suggestions).`
        : `ElevenLabs has no voice matching "${requested}". Call list_voices (vendor "elevenlabs") and pass a ` +
          'voice_id verbatim (or a display name that is unique in your library).',
      {
        vendor: 'elevenlabs',
        voice: requested,
        suggestions: near.length ? near : voices.slice(0, 8).map((v) => v.name),
      },
    );
  }

  // Nothing requested and nothing configured: prefer a premade voice — every
  // account has those, they are tuned for narration, and a cloned voice is a
  // deliberate choice the user should make, not a default we guess at.
  const premade = voices.filter((v) => (v.category ?? '').toLowerCase() === 'premade');
  const pool = premade.length ? premade : voices;
  const chosen = pool[0];
  if (!chosen) {
    throw new EngineError(ErrorCodes.TTS_FAILED, 'ElevenLabs returned an empty voice list', { vendor: 'elevenlabs' });
  }
  return { voice: chosen, source: 'default' };
}

/**
 * Map the engine's −10..10 rate onto voice_settings.speed. Each step is 5% of
 * the default speed rather than the 10% the other vendors use, because
 * ElevenLabs only accepts 0.7..1.2 — the full ±10 range maps onto (and is
 * clamped to) that window, so a film switching vendors keeps the *sign and
 * ordering* of its rate choices even though the magnitude compresses.
 */
export function speedForRate(rate) {
  const speed = 1 + Math.max(-10, Math.min(10, Number(rate))) * 0.05;
  return Number(Math.max(0.7, Math.min(1.2, speed)).toFixed(4));
}

/* -------------------------------- synthesis ------------------------------- */

/**
 * Synthesize `text` to a PCM WAV at `outPath` through ElevenLabs.
 *
 * Returns the same success payload every speech vendor produces (plus
 * ElevenLabs-specific extras), so callers need no per-vendor branching:
 *
 *   { ok, vendor: 'elevenlabs', voice, durationSeconds, sampleRate, channels, bytes, outPath, … }
 *
 * `deterministic: true` sends a fixed seed — the same reproducibility intent
 * as the Piper flag, served by the mechanism this API actually offers.
 *
 * @throws EngineError TTS_UNAVAILABLE / UNSUPPORTED_VOICE / TTS_FAILED
 */
export async function synthesizeElevenlabsSpeech({
  text, outPath, voice, rate, model, outputFormat, deterministic,
  key, endpoint, elevenlabs, env, timeoutMs = 60_000,
}) {
  const cfg = requireElevenlabsConfig(resolveElevenlabsConfig({ key, endpoint, voice, model, outputFormat, elevenlabs, env }));
  if (!ELEVENLABS_WAV_FORMATS.includes(cfg.outputFormat)) {
    throw new EngineError(
      ErrorCodes.TTS_FAILED,
      `Unsupported ElevenLabs output format "${cfg.outputFormat}" — narration must be a headered WAV, one of: ${ELEVENLABS_WAV_FORMATS.join(', ')}`,
      { vendor: 'elevenlabs', outputFormat: cfg.outputFormat, allowed: ELEVENLABS_WAV_FORMATS },
    );
  }

  const catalogue = await listElevenlabsVoices(cfg, { timeoutMs });
  const picked = pickElevenlabsVoice(cfg.voice, catalogue);
  const chosen = picked.voice;

  const body = { text, model_id: cfg.model };
  if (deterministic) body.seed = DETERMINISTIC_SEED;
  if (rate !== undefined && rate !== null) body.voice_settings = { speed: speedForRate(rate) };

  const url = `${cfg.endpoint}/v1/text-to-speech/${encodeURIComponent(chosen.name)}?output_format=${cfg.outputFormat}`;
  const res = await elevenFetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': cfg.key,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
  }, { timeoutMs, what: 'synthesis' });

  if (!res.ok) {
    const errText = await errorBody(res);
    // A voice complaint from the service is its way of saying unsupported_voice
    // (reachable when the library changed between the catalogue fetch and now).
    if ((res.status === 400 || res.status === 404) && /voice/i.test(errText)) {
      throw new EngineError(
        ErrorCodes.UNSUPPORTED_VOICE,
        `ElevenLabs rejected the voice "${chosen.name}": ${errText}`,
        { vendor: 'elevenlabs', voice: chosen.name, status: res.status, body: errText },
      );
    }
    throw httpError(res, errText, { what: 'synthesis' });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new EngineError(ErrorCodes.TTS_FAILED, 'ElevenLabs returned an empty audio body', { vendor: 'elevenlabs' });
  }
  const info = parseWavHeader(buf, outPath);
  await fsp.writeFile(outPath, buf);

  return {
    ok: true,
    vendor: 'elevenlabs',
    engine: 'elevenlabs',
    voice: chosen.name,             // the voice_id — the stable handle
    voiceName: chosen.displayName,  // the human name, for logs and the Studio
    voiceSource: picked.source === 'default' ? 'auto' : (cfg.voiceSource ?? 'argument'),
    model: cfg.model,
    outputFormat: cfg.outputFormat,
    ...(deterministic ? { seed: DETERMINISTIC_SEED } : {}),
    durationSeconds: info.dataSize / info.byteRate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bytes: buf.length,
    outPath,
  };
}
