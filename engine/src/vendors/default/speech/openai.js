/**
 * OpenAI text-to-speech — cloud narration vendor (v0.20).
 *
 * OpenAI's `gpt-4o-mini-tts` voices over REST, in plain `fetch` — no SDK, no
 * npm dependency — mirroring core/tts-azure.js's shape so core/tts-vendors.js
 * can dispatch to it interchangeably:
 *
 *   checkOpenaiTts()          → { available, voices, voiceDetails, config|error }
 *   synthesizeOpenaiSpeech()  → { ok, vendor, voice, durationSeconds, … }
 *
 * What distinguishes this vendor: the current model takes free-form
 * *instructions* ("Speak in a cheerful style."), which is where the engine's
 * `style` option lands — no per-voice style list to consult, any adjective
 * works. There is no free tier (speech costs roughly $0.015 per minute of
 * audio on the default model), so the summary and setup hints say so.
 *
 * Credentials never live in settings.json — the key is read from the machine's
 * environment only, so a shared settings file can never leak one. Everything
 * else (default voice, model, standing instructions) may come from settings,
 * and an explicit argument always wins.
 *
 *   MOTION_STUDIO_OPENAI_KEY / OPENAI_API_KEY
 *   MOTION_STUDIO_OPENAI_ENDPOINT   (default https://api.openai.com — the
 *                                    override exists for tests and proxies)
 *   MOTION_STUDIO_OPENAI_VOICE      default voice, e.g. marin
 *
 * Two REST calls carry the whole feature (both authenticated with the
 * `Authorization: Bearer` header):
 *
 *   GET  {endpoint}/v1/models/gpt-4o-mini-tts    (the probe: 200 = key works)
 *   POST {endpoint}/v1/audio/speech              body: JSON → binary WAV
 *
 * Output is requested as `response_format: "wav"` because the engine's
 * narration contract is "a PCM WAV whose header is the authoritative duration"
 * (parseWavHeader is the authority; FFmpeg re-encodes at mux time).
 *
 * The API enforces a hard 4,096-character cap on `input`. Longer narration is
 * split into sentence-packed chunks, synthesized per chunk, and joined locally
 * (concatWavBuffers with no gap). The tradeoff is cross-chunk prosody: the
 * model reads each chunk with no knowledge of the others, so intonation resets
 * at every seam — seams land on sentence boundaries to keep that inaudible,
 * and the payload reports `chunked: N` so a caller knows it happened.
 *
 * There is no voice-listing endpoint; the catalogue below is the documented
 * set. Four of the voices exist only on gpt-4o-mini-tts, and the two legacy
 * models (tts-1 / tts-1-hd) also predate the `instructions` parameter — both
 * constraints are enforced here, before the request, with messages that name
 * the fix.
 */

import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from '../../../core/errors.js';
import { parseWavHeader, splitSentences, concatWavBuffers } from '../../../core/audio.js';
import { maskKey } from './azure.js';

/** Env hooks, in precedence order. Exported so the UI/docs list one truth. */
export const OPENAI_ENV = Object.freeze({
  key: Object.freeze(['MOTION_STUDIO_OPENAI_KEY', 'OPENAI_API_KEY']),
  endpoint: Object.freeze(['MOTION_STUDIO_OPENAI_ENDPOINT']),
  voice: Object.freeze(['MOTION_STUDIO_OPENAI_VOICE']),
});

export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini-tts';

/** Models that predate `instructions` — it must be omitted for them, not sent. */
export const OPENAI_LEGACY_MODELS = Object.freeze(['tts-1', 'tts-1-hd']);

/**
 * The documented voice set (there is no listing API). The last four are
 * gpt-4o-mini-tts-only; pickOpenaiVoice enforces that against the resolved
 * model so a legacy-model call fails here with the reason, not at the service
 * with a bare 400.
 */
export const OPENAI_VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer',
  'verse', 'marin', 'cedar',
]);
const GPT4O_MINI_TTS_ONLY = Object.freeze(['ballad', 'verse', 'marin', 'cedar']);

/** The no-config default (gpt-4o-mini-tts); legacy models fall back to alloy. */
export const OPENAI_DEFAULT_VOICE = 'marin';

const DEFAULT_ENDPOINT = 'https://api.openai.com';

/** The service 400s input beyond this; chunks are packed with headroom. */
const INPUT_CHAR_LIMIT = 4096;
const CHUNK_CHAR_TARGET = 4000;

/** The voices usable with `model`. */
export function openaiVoicesForModel(model) {
  return OPENAI_LEGACY_MODELS.includes(model)
    ? OPENAI_VOICES.filter((v) => !GPT4O_MINI_TTS_ONLY.includes(v))
    : OPENAI_VOICES;
}

/** Normalize one voice name into the shape the UI and MCP hand out. */
export function describeOpenaiVoice(name) {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    locale: null,   // OpenAI voices are multilingual; there is no locale axis
    localeName: null,
    gender: null,
    styles: [],     // styling is free-form `instructions`, not a per-voice list
    models: GPT4O_MINI_TTS_ONLY.includes(name)
      ? [OPENAI_DEFAULT_MODEL]
      : [OPENAI_DEFAULT_MODEL, ...OPENAI_LEGACY_MODELS],
  };
}

function pickEnv(names, env) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { value, source: name };
  }
  return { value: null, source: null };
}

/**
 * Resolve every knob the OpenAI vendor needs, recording where each value came
 * from so the Studio can show "voice: marin (from OPENAI setting)" instead of
 * leaving the user to guess which layer won.
 *
 *   explicit argument  >  environment  >  settings.tts.openai  >  built-in default
 *
 * The key is the exception: environment only, never settings.
 *
 * @returns {{key, keySource, keyMasked, endpoint, endpointSource,
 *            voice, voiceSource, model, instructions, missing: string[]}}
 */
export function resolveOpenaiConfig({
  key, endpoint, voice, model, instructions,
  openai = {},             // settings.tts.openai
  env = process.env,
} = {}) {
  const fromEnv = {
    key: pickEnv(OPENAI_ENV.key, env),
    endpoint: pickEnv(OPENAI_ENV.endpoint, env),
    voice: pickEnv(OPENAI_ENV.voice, env),
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
  const ep = layered(endpoint, fromEnv.endpoint, openai.endpoint);
  const v = layered(voice, fromEnv.voice, openai.voice);

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
    model: model?.trim() || openai.model || OPENAI_DEFAULT_MODEL,
    instructions: instructions?.trim() || openai.instructions || null,
    missing,
  };
}

/** How to fix an unconfigured vendor — the same sentence everywhere it matters. */
export function openaiSetupHint(cfg) {
  if (!cfg.missing.includes('key')) return '';
  return `OpenAI text-to-speech is not configured: set ${OPENAI_ENV.key[1]} to an API key from ` +
    'platform.openai.com (there is no free tier — speech costs about $0.015 per minute of audio on ' +
    `gpt-4o-mini-tts). On Windows: setx ${OPENAI_ENV.key[1]} "<key>" (open a new terminal afterwards).`;
}

function requireOpenaiConfig(cfg) {
  if (cfg.missing.length) {
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, openaiSetupHint(cfg), {
      vendor: 'openai',
      missing: cfg.missing,
      envHooks: { key: OPENAI_ENV.key },
    });
  }
  return cfg;
}

/* ------------------------------- REST calls ------------------------------- */

const USER_AGENT = 'motion-studio';

async function openaiFetch(url, init, { timeoutMs, what }) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // A DNS/TLS/timeout failure is not a synthesis failure — the service was
    // never reached. Callers decide whether that is fatal or just "unavailable".
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || String(err);
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, `Could not reach OpenAI (${what}): ${reason}`, {
      vendor: 'openai', url, reason,
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
 * Map an HTTP failure onto the engine's stable codes. A rejected key or a
 * model the account cannot see is a *setup* problem (tts_unavailable — the
 * caller must stop and tell the user), everything else is a synthesis failure
 * (tts_failed).
 */
function httpError(res, body, { what }) {
  const detail = { vendor: 'openai', status: res.status, body: body || undefined };
  if (res.status === 401 || res.status === 403) {
    return new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      `OpenAI rejected the credentials (HTTP ${res.status}) — check ${OPENAI_ENV.key[1]}. ` +
        'Fix the environment variable, then retry; do not retry blindly.',
      detail,
    );
  }
  if (res.status === 404) {
    return new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      `OpenAI endpoint or model not found (HTTP 404 on ${what}) — the endpoint override or the configured model is probably wrong.`,
      detail,
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return new EngineError(
      ErrorCodes.TTS_FAILED,
      `OpenAI rate limit hit (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ''}.`,
      { ...detail, retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined },
    );
  }
  return new EngineError(ErrorCodes.TTS_FAILED, `OpenAI ${what} failed (HTTP ${res.status})${body ? `: ${body}` : ''}`, detail);
}

/**
 * Probe the vendor: does it have a key, and does that key see the default TTS
 * model? One cheap GET answers both (a bad key is a 401; a project key scoped
 * away from the model is a 404). Never throws — same contract as the other
 * vendors' checks.
 */
export async function checkOpenaiTts({ timeoutMs = 15_000, force = false, ...opts } = {}) {
  void force; // no cache to bust — the catalogue is a constant
  const cfg = resolveOpenaiConfig(opts);
  if (cfg.missing.length) return { available: false, error: openaiSetupHint(cfg), config: cfg };
  try {
    const url = `${cfg.endpoint}/v1/models/${OPENAI_DEFAULT_MODEL}`;
    const res = await openaiFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.key}`, 'User-Agent': USER_AGENT },
    }, { timeoutMs, what: 'models' });
    if (!res.ok) throw httpError(res, await errorBody(res), { what: 'models' });
    const voiceDetails = openaiVoicesForModel(cfg.model).map(describeOpenaiVoice);
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
 * Resolve the requested voice against the fixed catalogue, enforcing model
 * compatibility. An unknown voice is a hard error with suggestions rather
 * than a silent substitution — the same rule every other speech vendor
 * follows, and doubly important here where the "catalogue" is small enough
 * that a typo is the only way to miss.
 */
export function pickOpenaiVoice(requested, { model = OPENAI_DEFAULT_MODEL } = {}) {
  const legacy = OPENAI_LEGACY_MODELS.includes(model);
  if (!requested) {
    // marin is the strongest narration default but is gpt-4o-mini-tts-only;
    // the legacy models fall back to their original first voice.
    return { voice: legacy ? 'alloy' : OPENAI_DEFAULT_VOICE, source: 'default' };
  }
  const want = requested.trim().toLowerCase();
  const hit = OPENAI_VOICES.find((v) => v === want);
  if (!hit) {
    throw new EngineError(
      ErrorCodes.UNSUPPORTED_VOICE,
      `OpenAI has no voice named "${requested}". The catalogue is fixed — call list_voices (vendor "openai") ` +
        `and pass one of: ${openaiVoicesForModel(model).join(', ')}.`,
      { vendor: 'openai', voice: requested, suggestions: [...openaiVoicesForModel(model)].slice(0, 8) },
    );
  }
  if (legacy && GPT4O_MINI_TTS_ONLY.includes(hit)) {
    throw new EngineError(
      ErrorCodes.UNSUPPORTED_VOICE,
      `The voice "${hit}" requires the ${OPENAI_DEFAULT_MODEL} model — ${model} only supports: ` +
        `${openaiVoicesForModel(model).join(', ')}.`,
      { vendor: 'openai', voice: hit, model, suggestions: [...openaiVoicesForModel(model)].slice(0, 8) },
    );
  }
  return { voice: hit, source: 'requested' };
}

/**
 * Map the engine's −10..10 rate onto the API's `speed` multiplier. Each step
 * is 10% of default speed — the same meaning as every other vendor — clamped
 * to the API's documented 0.25..4.0 window.
 */
export function speedForRate(rate) {
  const speed = 1 + Math.max(-10, Math.min(10, Number(rate))) * 0.1;
  return Number(Math.max(0.25, Math.min(4.0, speed)).toFixed(4));
}

/**
 * Greedily pack sentences into chunks under `limit` characters. A single
 * sentence longer than the limit is hard-split mid-sentence — degenerate
 * input should degrade to an audible seam, not a 400 from the service.
 */
function packSentences(text, limit) {
  const chunks = [];
  let current = '';
  for (const sentence of splitSentences(text)) {
    const pieces = [];
    for (let i = 0; i < sentence.length; i += limit) pieces.push(sentence.slice(i, i + limit));
    for (const piece of pieces) {
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= limit) current += ` ${piece}`;
      else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

/* -------------------------------- synthesis ------------------------------- */

/**
 * Synthesize `text` to a PCM WAV at `outPath` through OpenAI.
 *
 * Returns the same success payload every speech vendor produces (plus
 * OpenAI-specific extras), so callers need no per-vendor branching:
 *
 *   { ok, vendor: 'openai', voice, durationSeconds, sampleRate, channels, bytes, outPath, … }
 *
 * `style` becomes an `instructions` sentence on models that take one; on the
 * legacy models it is reported in `warnings` (the parameter must be omitted
 * there, not sent). Text over the API's 4,096-char cap is chunked at sentence
 * boundaries and joined locally — `chunked: N` reports when that happened,
 * because cross-chunk prosody (intonation resetting at each seam) is a real
 * tradeoff the caller may want to hear before shipping.
 *
 * @throws EngineError TTS_UNAVAILABLE / UNSUPPORTED_VOICE / TTS_FAILED
 */
export async function synthesizeOpenaiSpeech({
  text, outPath, voice, rate, style, instructions, model,
  key, endpoint, openai, env, timeoutMs = 60_000,
}) {
  const cfg = requireOpenaiConfig(resolveOpenaiConfig({ key, endpoint, voice, model, instructions, openai, env }));
  const picked = pickOpenaiVoice(cfg.voice, { model: cfg.model });
  const legacy = OPENAI_LEGACY_MODELS.includes(cfg.model);
  const warnings = [];

  // A per-call `style` outranks standing settings instructions: it is the more
  // specific ask. Legacy models take neither — warn, never silently drop.
  let instr = null;
  if (style?.trim()) {
    if (legacy) warnings.push(`"style" needs the ${OPENAI_DEFAULT_MODEL} model and was ignored (${cfg.model} predates the instructions parameter)`);
    else instr = `Speak in a ${style.trim()} style.`;
  } else if (cfg.instructions) {
    if (legacy) warnings.push(`tts.openai.instructions was ignored (${cfg.model} predates the instructions parameter)`);
    else instr = cfg.instructions;
  }

  const chunks = text.length > INPUT_CHAR_LIMIT ? packSentences(text, CHUNK_CHAR_TARGET) : [text];
  const clips = [];
  for (const chunk of chunks) {
    const res = await openaiFetch(`${cfg.endpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        model: cfg.model,
        input: chunk,
        voice: picked.voice,
        response_format: 'wav',
        ...(rate !== undefined && rate !== null ? { speed: speedForRate(rate) } : {}),
        ...(instr ? { instructions: instr } : {}),
      }),
    }, { timeoutMs, what: 'synthesis' });

    if (!res.ok) {
      const errText = await errorBody(res);
      if (res.status === 400 && /voice/i.test(errText)) {
        throw new EngineError(
          ErrorCodes.UNSUPPORTED_VOICE,
          `OpenAI rejected the voice "${picked.voice}": ${errText}`,
          { vendor: 'openai', voice: picked.voice, status: 400, body: errText },
        );
      }
      throw httpError(res, errText, { what: 'synthesis' });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new EngineError(ErrorCodes.TTS_FAILED, 'OpenAI returned an empty audio body', { vendor: 'openai' });
    }
    clips.push(buf);
  }

  // One chunk writes through untouched; several are joined gaplessly — the
  // seams already sit on sentence boundaries, so no extra silence belongs there.
  const buf = clips.length === 1 ? clips[0] : concatWavBuffers(clips, { gapSeconds: 0 }).buffer;
  const info = parseWavHeader(buf, outPath);
  await fsp.writeFile(outPath, buf);

  return {
    ok: true,
    vendor: 'openai',
    engine: 'openai',
    voice: picked.voice,
    voiceSource: picked.source === 'default' ? 'auto' : (cfg.voiceSource ?? 'argument'),
    model: cfg.model,
    ...(instr ? { instructions: instr } : {}),
    ...(clips.length > 1 ? { chunked: clips.length } : {}),
    durationSeconds: info.dataSize / info.byteRate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bytes: buf.length,
    outPath,
    ...(warnings.length ? { warnings } : {}),
  };
}
