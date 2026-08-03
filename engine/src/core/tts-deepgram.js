/**
 * Deepgram Aura — cloud narration vendor (v0.20).
 *
 * The free-tier pick among the cloud speech vendors: a new Deepgram account
 * gets $200 of signup credit with no card and no expiry — at Aura's
 * per-character price that is roughly 6.6 million characters of narration,
 * which for this engine's purposes is "free indefinitely". Like the Azure
 * vendor (core/tts-azure.js, whose shape this module deliberately clones), it
 * is plain `fetch` — no SDK, no npm dependency — and serves the same narration
 * contract so core/tts-vendors.js can dispatch to it interchangeably:
 *
 *   checkDeepgramTts()          → { available, voices, voiceDetails, config|error }
 *   synthesizeDeepgramSpeech()  → { ok, vendor, voice, durationSeconds, … }
 *
 * Credentials never live in settings.json — the key is read from the machine's
 * environment only, so a shared settings file can never leak one. The default
 * voice may come from settings, and an explicit argument always wins.
 *
 *   MOTION_STUDIO_DEEPGRAM_KEY / DEEPGRAM_API_KEY
 *   MOTION_STUDIO_DEEPGRAM_ENDPOINT   (default https://api.deepgram.com — the
 *                                      override exists for tests)
 *   MOTION_STUDIO_DEEPGRAM_VOICE      default voice, e.g. aura-2-thalia-en
 *
 * Two REST calls carry the whole feature:
 *
 *   GET  {endpoint}/v1/projects       (the probe: 200 = the key works)
 *   POST {endpoint}/v1/speak?model=<voice>&encoding=linear16&container=wav
 *                           &sample_rate=24000    body: { text } → binary WAV
 *
 * Output is requested as linear16-in-a-wav-container because the engine's
 * narration contract is "a PCM WAV whose header is the authoritative duration"
 * (parseWavHeader is the authority; FFmpeg re-encodes at mux time). 24 kHz
 * matches the other cloud vendors' default.
 *
 * The API enforces a hard 2,000-character cap per request (413 beyond).
 * Longer narration is split into sentence-packed chunks, synthesized per
 * chunk, and joined locally with no gap — same strategy and same cross-chunk
 * prosody tradeoff as the OpenAI vendor; the payload reports `chunked: N`.
 *
 * There is no voice-listing endpoint; the catalogue below is the documented
 * Aura-2 English set. Deepgram ships new voices without notice, so any name
 * matching the aura-2-<speaker>-<lang> pattern is passed through to the
 * service even when it is not in the list — the service 400s an unknown one,
 * which is mapped back to unsupported_voice.
 */

import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';
import { parseWavHeader, splitSentences, concatWavBuffers } from './audio.js';
import { maskKey } from './tts-azure.js';

/** Env hooks, in precedence order. Exported so the UI/docs list one truth. */
export const DEEPGRAM_ENV = Object.freeze({
  key: Object.freeze(['MOTION_STUDIO_DEEPGRAM_KEY', 'DEEPGRAM_API_KEY']),
  endpoint: Object.freeze(['MOTION_STUDIO_DEEPGRAM_ENDPOINT']),
  voice: Object.freeze(['MOTION_STUDIO_DEEPGRAM_VOICE']),
});

export const DEEPGRAM_DEFAULT_VOICE = 'aura-2-thalia-en';

const DEFAULT_ENDPOINT = 'https://api.deepgram.com';

/** Matches PCM WAV downstream and the other cloud vendors' default rate. */
const SAMPLE_RATE = 24000;

/** The service 413s text beyond this; chunks are packed with headroom. */
const INPUT_CHAR_LIMIT = 2000;
const CHUNK_CHAR_TARGET = 1900;

/** Any speaker name in any language, e.g. aura-2-thalia-en — see pickDeepgramVoice. */
const AURA_VOICE_PATTERN = /^aura-2-[a-z]+-[a-z]{2}$/;

/**
 * The documented Aura-2 English speakers (voice = `aura-2-<speaker>-en`).
 * Mythological names all; Deepgram publishes no structured gender/locale
 * metadata to go with them, so the catalogue carries none.
 */
const AURA_2_EN_SPEAKERS = Object.freeze([
  'thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries', 'asteria', 'athena', 'atlas', 'aurora',
  'callista', 'cora', 'cordelia', 'delia', 'draco', 'electra', 'harmonia', 'hera', 'hermes', 'hyperion',
  'iris', 'janus', 'juno', 'jupiter', 'luna', 'mars', 'minerva', 'neptune', 'odysseus', 'ophelia',
  'orion', 'orpheus', 'pandora', 'phoebe', 'pluto', 'saturn', 'selene', 'theia', 'vesta', 'zeus',
]);

export const DEEPGRAM_VOICES = Object.freeze(AURA_2_EN_SPEAKERS.map((s) => `aura-2-${s}-en`));

/** Normalize one voice name into the shape the UI and MCP hand out. */
export function describeDeepgramVoice(name) {
  const m = /^aura-2-([a-z]+)-([a-z]{2})$/.exec(name);
  const speaker = m?.[1] ?? name;
  return {
    name,
    displayName: speaker.charAt(0).toUpperCase() + speaker.slice(1),
    locale: m?.[2] ?? null,
    localeName: null,
    gender: null,
    styles: [],
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
 * Resolve every knob the Deepgram vendor needs, recording where each value
 * came from so the Studio can show "voice: aura-2-orion-en (from settings)"
 * instead of leaving the user to guess which layer won.
 *
 *   explicit argument  >  environment  >  settings.tts.deepgram  >  built-in default
 *
 * The key is the exception: environment only, never settings.
 *
 * @returns {{key, keySource, keyMasked, endpoint, endpointSource,
 *            voice, voiceSource, missing: string[]}}
 */
export function resolveDeepgramConfig({
  key, endpoint, voice,
  deepgram = {},           // settings.tts.deepgram
  env = process.env,
} = {}) {
  const fromEnv = {
    key: pickEnv(DEEPGRAM_ENV.key, env),
    endpoint: pickEnv(DEEPGRAM_ENV.endpoint, env),
    voice: pickEnv(DEEPGRAM_ENV.voice, env),
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
  const ep = layered(endpoint, fromEnv.endpoint, deepgram.endpoint);
  const v = layered(voice, fromEnv.voice, deepgram.voice);

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
    missing,
  };
}

/** How to fix an unconfigured vendor — the same sentence everywhere it matters. */
export function deepgramSetupHint(cfg) {
  if (!cfg.missing.includes('key')) return '';
  return `Deepgram is not configured: set ${DEEPGRAM_ENV.key[1]} to an API key from console.deepgram.com — ` +
    'a new account gets $200 of credit (roughly 6.6M characters) with no card and no expiry. ' +
    `On Windows: setx ${DEEPGRAM_ENV.key[1]} "<key>" (open a new terminal afterwards).`;
}

function requireDeepgramConfig(cfg) {
  if (cfg.missing.length) {
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, deepgramSetupHint(cfg), {
      vendor: 'deepgram',
      missing: cfg.missing,
      envHooks: { key: DEEPGRAM_ENV.key },
    });
  }
  return cfg;
}

/* ------------------------------- REST calls ------------------------------- */

const USER_AGENT = 'motion-studio';

async function deepgramFetch(url, init, { timeoutMs, what }) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // A DNS/TLS/timeout failure is not a synthesis failure — the service was
    // never reached. Callers decide whether that is fatal or just "unavailable".
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || String(err);
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, `Could not reach Deepgram (${what}): ${reason}`, {
      vendor: 'deepgram', url, reason,
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
  const detail = { vendor: 'deepgram', status: res.status, body: body || undefined };
  if (res.status === 401 || res.status === 403) {
    return new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      `Deepgram rejected the credentials (HTTP ${res.status}) — check ${DEEPGRAM_ENV.key[1]}. ` +
        'Fix the environment variable, then retry; do not retry blindly.',
      detail,
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return new EngineError(
      ErrorCodes.TTS_FAILED,
      `Deepgram rate limit hit (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ''}.`,
      { ...detail, retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined },
    );
  }
  return new EngineError(ErrorCodes.TTS_FAILED, `Deepgram ${what} failed (HTTP ${res.status})${body ? `: ${body}` : ''}`, detail);
}

/**
 * Probe the vendor: does the key work? /v1/projects is the cheapest
 * authenticated call Deepgram offers — a valid key of any scope can list its
 * own projects. Never throws — same contract as the other vendors' checks.
 */
export async function checkDeepgramTts({ timeoutMs = 15_000, force = false, ...opts } = {}) {
  void force; // no cache to bust — the catalogue is a constant
  const cfg = resolveDeepgramConfig(opts);
  if (cfg.missing.length) return { available: false, error: deepgramSetupHint(cfg), config: cfg };
  try {
    const res = await deepgramFetch(`${cfg.endpoint}/v1/projects`, {
      method: 'GET',
      // `Token`, NOT `Bearer` — Deepgram's own auth scheme. A Bearer header is
      // a 401 that looks exactly like a bad key, so get this one right here.
      headers: { Authorization: `Token ${cfg.key}`, 'User-Agent': USER_AGENT },
    }, { timeoutMs, what: 'projects' });
    if (!res.ok) throw httpError(res, await errorBody(res), { what: 'projects' });
    const voiceDetails = DEEPGRAM_VOICES.map(describeDeepgramVoice);
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
 * Resolve the requested voice. Known names (and bare speaker names like
 * "orion") resolve from the documented catalogue; anything else matching the
 * aura-2-<speaker>-<lang> pattern is passed through untouched, because
 * Deepgram ships new voices without notice and a hardcoded list must not be
 * the thing that blocks them — the service 400s a genuinely unknown model and
 * synthesis maps that to unsupported_voice. A name matching nothing is a hard
 * error with suggestions rather than a silent substitution — the same rule
 * every other speech vendor follows.
 */
export function pickDeepgramVoice(requested) {
  if (!requested) return { voice: DEEPGRAM_DEFAULT_VOICE, source: 'default' };
  const want = requested.trim().toLowerCase();
  const exact = DEEPGRAM_VOICES.find((v) => v === want);
  if (exact) return { voice: exact, source: 'requested' };
  if (AURA_2_EN_SPEAKERS.includes(want)) return { voice: `aura-2-${want}-en`, source: 'requested' };
  if (AURA_VOICE_PATTERN.test(want)) return { voice: want, source: 'requested', passthrough: true };

  const near = DEEPGRAM_VOICES.filter((v) => v.includes(want)).slice(0, 8);
  throw new EngineError(
    ErrorCodes.UNSUPPORTED_VOICE,
    `Deepgram has no voice matching "${requested}". Call list_voices (vendor "deepgram") and pass a name ` +
      'verbatim, e.g. aura-2-thalia-en.',
    {
      vendor: 'deepgram',
      voice: requested,
      suggestions: near.length ? near : DEEPGRAM_VOICES.slice(0, 8),
    },
  );
}

/**
 * Greedily pack sentences into chunks under `limit` characters. A single
 * sentence longer than the limit is hard-split mid-sentence — degenerate
 * input should degrade to an audible seam, not a 413 from the service.
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
 * Synthesize `text` to a PCM WAV at `outPath` through Deepgram Aura.
 *
 * Returns the same success payload every speech vendor produces, so callers
 * need no per-vendor branching:
 *
 *   { ok, vendor: 'deepgram', voice, durationSeconds, sampleRate, channels, bytes, outPath, … }
 *
 * Aura takes text and a voice — no rate/volume/pitch/style knobs exist on the
 * API, so the dispatcher reports those in `warnings` rather than pretending.
 * Text over the 2,000-char request cap is chunked at sentence boundaries and
 * joined locally; `chunked: N` reports when that happened.
 *
 * @throws EngineError TTS_UNAVAILABLE / UNSUPPORTED_VOICE / TTS_FAILED
 */
export async function synthesizeDeepgramSpeech({
  text, outPath, voice,
  key, endpoint, deepgram, env, timeoutMs = 60_000,
}) {
  const cfg = requireDeepgramConfig(resolveDeepgramConfig({ key, endpoint, voice, deepgram, env }));
  const picked = pickDeepgramVoice(cfg.voice);

  const url = new URL(`${cfg.endpoint}/v1/speak`);
  url.searchParams.set('model', picked.voice);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('container', 'wav');
  url.searchParams.set('sample_rate', String(SAMPLE_RATE));

  const chunks = text.length > INPUT_CHAR_LIMIT ? packSentences(text, CHUNK_CHAR_TARGET) : [text];
  const clips = [];
  for (const chunk of chunks) {
    const res = await deepgramFetch(url, {
      method: 'POST',
      headers: {
        // `Token`, NOT `Bearer` — Deepgram's own auth scheme (see the probe).
        Authorization: `Token ${cfg.key}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ text: chunk }),
    }, { timeoutMs, what: 'synthesis' });

    if (!res.ok) {
      const errText = await errorBody(res);
      // A 400 naming the model is the service refusing the voice — reachable
      // through the pattern passthrough above, and mapped to the same code a
      // catalogue miss produces so callers see one behaviour.
      if (res.status === 400 && /model|voice/i.test(errText)) {
        throw new EngineError(
          ErrorCodes.UNSUPPORTED_VOICE,
          `Deepgram rejected the voice "${picked.voice}": ${errText}`,
          { vendor: 'deepgram', voice: picked.voice, status: 400, body: errText },
        );
      }
      throw httpError(res, errText, { what: 'synthesis' });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new EngineError(ErrorCodes.TTS_FAILED, 'Deepgram returned an empty audio body', { vendor: 'deepgram' });
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
    vendor: 'deepgram',
    engine: 'deepgram',
    voice: picked.voice,
    voiceSource: picked.source === 'default' ? 'auto' : (cfg.voiceSource ?? 'argument'),
    ...(clips.length > 1 ? { chunked: clips.length } : {}),
    durationSeconds: info.dataSize / info.byteRate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bytes: buf.length,
    outPath,
  };
}
