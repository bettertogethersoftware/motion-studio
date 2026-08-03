/**
 * Azure AI Speech — the cloud narration vendor (v0.17).
 *
 * The original speech path (core/tts.js) spawns a Windows console exe and is
 * therefore Windows-only and limited to the voices installed on the machine.
 * This module is the alternative: the same narration contract served by Azure's
 * text-to-speech REST API, in plain Node — `fetch` and nothing else. No SDK, no
 * npm dependency, no binary to build, and it works on any OS.
 *
 * It deliberately mirrors core/tts.js's shape so core/tts-vendors.js can treat
 * the two interchangeably:
 *
 *   checkAzureTts()          → { available, voices, error }        (cf. checkTts)
 *   synthesizeAzureSpeech()  → { ok, voice, durationSeconds, … }   (cf. synthesizeSpeech)
 *
 * Credentials never live in settings.json — the key is read from the machine's
 * environment only (Windows: setx AZURE_SPEECH_KEY …), so a shared settings
 * file can never leak one. Everything else (region, default voice, output
 * format) may come from settings, and an explicit argument always wins.
 *
 *   MOTION_STUDIO_AZURE_SPEECH_KEY    / AZURE_SPEECH_KEY    / SPEECH_KEY
 *   MOTION_STUDIO_AZURE_SPEECH_REGION / AZURE_SPEECH_REGION / SPEECH_REGION
 *   MOTION_STUDIO_AZURE_SPEECH_ENDPOINT / AZURE_SPEECH_ENDPOINT   (sovereign
 *                                     clouds, private endpoints, tests)
 *   MOTION_STUDIO_AZURE_SPEECH_VOICE  default voice, e.g. en-US-AvaNeural
 *
 * Two REST calls carry the whole feature (both authenticated with the
 * `Ocp-Apim-Subscription-Key` header — no token exchange needed):
 *
 *   GET  {endpoint}/cognitiveservices/voices/list
 *   POST {endpoint}/cognitiveservices/v1     body: SSML, out: RIFF PCM WAV
 *
 * Output is requested as `riff-*-pcm` precisely because the rest of the engine
 * already speaks PCM WAV: the duration is re-derived from the RIFF header the
 * same way (parseWavHeader), and FFmpeg re-encodes it at mux time.
 */

import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';
import { parseWavHeader } from './audio.js';

/** Env hooks, in precedence order. Exported so the UI/docs list one truth. */
export const AZURE_ENV = Object.freeze({
  key: Object.freeze(['MOTION_STUDIO_AZURE_SPEECH_KEY', 'AZURE_SPEECH_KEY', 'SPEECH_KEY']),
  region: Object.freeze(['MOTION_STUDIO_AZURE_SPEECH_REGION', 'AZURE_SPEECH_REGION', 'SPEECH_REGION']),
  endpoint: Object.freeze(['MOTION_STUDIO_AZURE_SPEECH_ENDPOINT', 'AZURE_SPEECH_ENDPOINT']),
  voice: Object.freeze(['MOTION_STUDIO_AZURE_SPEECH_VOICE']),
});

/**
 * Only RIFF (WAV) container formats are offered. Azure will happily return
 * mp3/ogg/webm, but the engine's narration contract is "a PCM WAV whose header
 * is the authoritative duration", and every downstream consumer (duration →
 * frames, the audio mixer, the Studio's audition player) assumes it.
 */
export const AZURE_WAV_FORMATS = Object.freeze([
  'riff-8khz-16bit-mono-pcm',
  'riff-16khz-16bit-mono-pcm',
  'riff-22050hz-16bit-mono-pcm',
  'riff-24khz-16bit-mono-pcm',
  'riff-44100hz-16bit-mono-pcm',
  'riff-48khz-16bit-mono-pcm',
]);

export const AZURE_DEFAULT_FORMAT = 'riff-24khz-16bit-mono-pcm';

/** Preferred locale when nothing is configured and we must pick a voice. */
const FALLBACK_LOCALE = 'en-US';

/** Voice lists are ~1 MB and change about never; re-fetching per call is waste. */
const VOICE_CACHE_TTL_MS = 10 * 60 * 1000;
const voiceCache = new Map(); // cacheKey → { expires, voices }

/** Drop cached voice lists (a key/region change must not be masked by cache). */
export function clearAzureVoiceCache() {
  voiceCache.clear();
}

function pickEnv(names, env) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { value, source: name };
  }
  return { value: null, source: null };
}

/** Last four characters only — enough to tell two keys apart, useless if leaked. */
export function maskKey(key) {
  if (!key) return null;
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

/**
 * Resolve every knob the Azure vendor needs, recording where each value came
 * from so the Studio can show "region: westeurope (from AZURE_SPEECH_REGION)"
 * instead of leaving the user to guess which layer won.
 *
 *   explicit argument  >  environment  >  settings.tts.azure  >  built-in default
 *
 * The key is the exception: environment only, never settings.
 *
 * @returns {{key, keySource, keyMasked, region, regionSource, endpoint, endpointSource,
 *            voice, voiceSource, outputFormat, style, missing: string[]}}
 */
export function resolveAzureConfig({
  key, region, endpoint, voice, outputFormat, style,
  azure = {},              // settings.tts.azure
  env = process.env,
} = {}) {
  const fromEnv = {
    key: pickEnv(AZURE_ENV.key, env),
    region: pickEnv(AZURE_ENV.region, env),
    endpoint: pickEnv(AZURE_ENV.endpoint, env),
    voice: pickEnv(AZURE_ENV.voice, env),
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
  const r = layered(region, fromEnv.region, azure.region);
  const v = layered(voice, fromEnv.voice, azure.voice);
  const ep = layered(endpoint, fromEnv.endpoint, azure.endpoint);

  const resolvedEndpoint = ep.value
    ? ep.value.replace(/\/+$/, '')
    : r.value
      ? `https://${r.value}.tts.speech.microsoft.com`
      : null;

  const missing = [];
  if (!k.value) missing.push('key');
  if (!resolvedEndpoint) missing.push('region');

  return {
    key: k.value,
    keySource: k.source,
    keyMasked: maskKey(k.value),
    region: r.value,
    regionSource: r.source,
    endpoint: resolvedEndpoint,
    endpointSource: ep.value ? ep.source : r.value ? 'region' : null,
    voice: v.value,
    voiceSource: v.source,
    outputFormat: outputFormat?.trim() || azure.outputFormat || AZURE_DEFAULT_FORMAT,
    style: style?.trim() || azure.style || null,
    missing,
  };
}

/** How to fix an unconfigured vendor — the same sentence everywhere it matters. */
export function azureSetupHint(cfg) {
  const parts = [];
  if (cfg.missing.includes('key')) {
    parts.push(`set ${AZURE_ENV.key[1]} to your Azure Speech resource key`);
  }
  if (cfg.missing.includes('region')) {
    parts.push(`set ${AZURE_ENV.region[1]} to its region (e.g. eastus), or fill in the region on the Studio's tts page`);
  }
  return parts.length
    ? `Azure Speech is not configured: ${parts.join(', and ')}. On Windows: setx ${AZURE_ENV.key[1]} "<key>" (open a new terminal afterwards).`
    : '';
}

function requireAzureConfig(cfg) {
  if (cfg.missing.length) {
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, azureSetupHint(cfg), {
      vendor: 'azure',
      missing: cfg.missing,
      envHooks: { key: AZURE_ENV.key, region: AZURE_ENV.region },
    });
  }
  return cfg;
}

/* ------------------------------- REST calls ------------------------------- */

const USER_AGENT = 'motion-studio';

async function azureFetch(url, init, { timeoutMs, what }) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // A DNS/TLS/timeout failure is not a synthesis failure — the service was
    // never reached. Callers decide whether that is fatal or just "unavailable".
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || String(err);
    throw new EngineError(ErrorCodes.TTS_UNAVAILABLE, `Could not reach Azure Speech (${what}): ${reason}`, {
      vendor: 'azure', url, reason,
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
 * Map an HTTP failure onto the engine's stable codes. A rejected key or an
 * unknown region is a *setup* problem (tts_unavailable — the caller must stop
 * and tell the user), everything else is a synthesis failure (tts_failed).
 */
function httpError(res, body, { what }) {
  const detail = { vendor: 'azure', status: res.status, body: body || undefined };
  if (res.status === 401 || res.status === 403) {
    return new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      `Azure Speech rejected the credentials (HTTP ${res.status}) — check the key and that it belongs to the ` +
        'configured region. Fix the environment variable, then retry; do not retry blindly.',
      detail,
    );
  }
  if (res.status === 404) {
    return new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      `Azure Speech endpoint not found (HTTP 404 on ${what}) — the region is probably wrong.`,
      detail,
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return new EngineError(
      ErrorCodes.TTS_FAILED,
      `Azure Speech rate limit hit (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ''}.`,
      { ...detail, retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined },
    );
  }
  return new EngineError(ErrorCodes.TTS_FAILED, `Azure Speech ${what} failed (HTTP ${res.status})${body ? `: ${body}` : ''}`, detail);
}

/**
 * Fetch (and cache) the voice catalogue for a resource.
 * @returns {Promise<Array<object>>} raw Azure voice objects (ShortName, Locale, …)
 */
export async function listAzureVoices(cfg, { timeoutMs = 15_000, force = false } = {}) {
  requireAzureConfig(cfg);
  const cacheKey = `${cfg.endpoint}|${cfg.key}`;
  const hit = voiceCache.get(cacheKey);
  if (!force && hit && hit.expires > Date.now()) return hit.voices;

  const url = `${cfg.endpoint}/cognitiveservices/voices/list`;
  const res = await azureFetch(url, {
    method: 'GET',
    headers: { 'Ocp-Apim-Subscription-Key': cfg.key, 'User-Agent': USER_AGENT },
  }, { timeoutMs, what: 'voices/list' });

  if (!res.ok) throw httpError(res, await errorBody(res), { what: 'voices/list' });

  let voices;
  try {
    voices = await res.json();
  } catch (e) {
    throw new EngineError(ErrorCodes.TTS_FAILED, `Azure Speech returned an unreadable voice list: ${e.message}`, { vendor: 'azure' });
  }
  if (!Array.isArray(voices)) {
    throw new EngineError(ErrorCodes.TTS_FAILED, 'Azure Speech voice list was not a JSON array', { vendor: 'azure' });
  }
  voiceCache.set(cacheKey, { expires: Date.now() + VOICE_CACHE_TTL_MS, voices });
  return voices;
}

/** Normalize one Azure voice object into the shape the UI and MCP hand out. */
export function normalizeVoice(v) {
  return {
    name: v.ShortName ?? v.Name,
    displayName: v.DisplayName ?? v.LocalName ?? v.ShortName ?? v.Name,
    locale: v.Locale ?? null,
    localeName: v.LocaleName ?? null,
    gender: v.Gender ?? null,
    type: v.VoiceType ?? null,
    styles: Array.isArray(v.StyleList) ? v.StyleList : [],
    sampleRateHertz: v.SampleRateHertz ? Number(v.SampleRateHertz) : null,
  };
}

/**
 * Probe the vendor: does it have credentials, and can it reach the service?
 * Never throws — same contract as core/tts.js's checkTts, so the tool layer can
 * report `tts_unavailable` with a useful hint while the rest of the engine
 * keeps working.
 *
 * `voices` is a plain name array (interchangeable with the exe vendor);
 * `voiceDetails` carries the locale/gender/style metadata the Studio page uses.
 */
export async function checkAzureTts({ timeoutMs = 15_000, force = false, ...opts } = {}) {
  const cfg = resolveAzureConfig(opts);
  if (cfg.missing.length) return { available: false, error: azureSetupHint(cfg), config: cfg };
  try {
    const raw = await listAzureVoices(cfg, { timeoutMs, force });
    const voiceDetails = raw.map(normalizeVoice).filter((v) => v.name);
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

/* ---------------------------------- SSML ---------------------------------- */

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Map the engine's integer rate/volume scale onto SSML prosody.
 *
 * `rate` keeps the exe vendor's −10..10 scale so a film can switch vendors
 * without re-tuning every call: each step is 10% of the default speed, i.e.
 * rate 3 → "+30%", rate −4 → "-40%". `volume` is already 0..100, which SSML
 * takes verbatim.
 */
function prosodyAttrs({ rate, volume, pitch }) {
  const attrs = [];
  if (rate !== undefined && rate !== null) {
    const pct = Math.round(Math.max(-10, Math.min(10, Number(rate))) * 10);
    attrs.push(`rate="${pct >= 0 ? '+' : ''}${pct}%"`);
  }
  if (volume !== undefined && volume !== null) {
    attrs.push(`volume="${Math.max(0, Math.min(100, Number(volume)))}"`);
  }
  if (pitch !== undefined && pitch !== null) {
    const pct = Math.round(Math.max(-50, Math.min(50, Number(pitch))));
    attrs.push(`pitch="${pct >= 0 ? '+' : ''}${pct}%"`);
  }
  return attrs.join(' ');
}

/**
 * Build the SSML document for one clip. The narration text is escaped, never
 * interpolated raw — text arrives from an agent or a user and a stray `&` would
 * otherwise be a 400 from the service (and a `<` an injection).
 */
export function buildSsml({ text, voice, locale = 'en-US', rate, volume, pitch, style, styleDegree, role }) {
  let inner = escapeXml(text);

  if (style) {
    const degree = styleDegree === undefined || styleDegree === null ? '' : ` styledegree="${Number(styleDegree)}"`;
    const asRole = role ? ` role="${escapeXml(role)}"` : '';
    inner = `<mstts:express-as style="${escapeXml(style)}"${degree}${asRole}>${inner}</mstts:express-as>`;
  }
  const prosody = prosodyAttrs({ rate, volume, pitch });
  if (prosody) inner = `<prosody ${prosody}>${inner}</prosody>`;

  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(locale)}">` +
    `<voice name="${escapeXml(voice)}">${inner}</voice></speak>`
  );
}

/* ------------------------------ voice picking ----------------------------- */

/**
 * Resolve the requested voice against the catalogue. An unknown voice is a hard
 * error with suggestions rather than a silent substitution — the exe vendor
 * behaves the same way, and a film that quietly changed narrator between takes
 * would be worse than a failed call.
 */
export function pickVoice(requested, catalogue, { preferLocale = FALLBACK_LOCALE } = {}) {
  const voices = catalogue.map(normalizeVoice).filter((v) => v.name);
  if (requested) {
    const want = requested.trim().toLowerCase();
    const exact = voices.find((v) => v.name.toLowerCase() === want);
    if (exact) return { voice: exact, source: 'requested' };
    const byDisplay = voices.filter((v) => (v.displayName ?? '').toLowerCase() === want);
    if (byDisplay.length === 1) return { voice: byDisplay[0], source: 'requested' };

    const localePrefix = want.split('-').slice(0, 2).join('-');
    const suggestions = voices
      .filter((v) => (v.locale ?? '').toLowerCase().startsWith(localePrefix) ||
        (v.displayName ?? '').toLowerCase().includes(want.replace(/neural$/, '')))
      .slice(0, 8)
      .map((v) => v.name);
    throw new EngineError(
      ErrorCodes.UNSUPPORTED_VOICE,
      `Azure Speech has no voice named "${requested}". Call list_voices (vendor "azure") and pass a ShortName ` +
        'verbatim, e.g. en-US-AvaNeural.',
      {
        vendor: 'azure',
        voice: requested,
        suggestions: suggestions.length ? suggestions : voices.slice(0, 8).map((v) => v.name),
      },
    );
  }

  // Nothing requested and nothing configured: prefer a neural voice in the
  // fallback locale over hard-coding a name that Azure may retire.
  const neural = voices.filter((v) => (v.type ?? '').toLowerCase().includes('neural'));
  const pool = neural.length ? neural : voices;
  const preferred = pool.find((v) => (v.locale ?? '').toLowerCase() === preferLocale.toLowerCase());
  const chosen = preferred ?? pool[0];
  if (!chosen) {
    throw new EngineError(ErrorCodes.TTS_FAILED, 'Azure Speech returned an empty voice list', { vendor: 'azure' });
  }
  return { voice: chosen, source: 'default' };
}

/* -------------------------------- synthesis ------------------------------- */

/**
 * Synthesize `text` to a PCM WAV at `outPath` through Azure Speech.
 *
 * Returns the same success payload the exe vendor produces (plus Azure-specific
 * extras), so callers — MCP's synthesize_speech in particular — need no
 * per-vendor branching:
 *
 *   { ok, voice, engine: 'azure', durationSeconds, sampleRate, channels, bytes, outPath, … }
 *
 * @throws EngineError TTS_UNAVAILABLE / UNSUPPORTED_VOICE / TTS_FAILED
 */
export async function synthesizeAzureSpeech({
  text, outPath, voice, rate, volume, pitch, style, styleDegree, role,
  outputFormat, key, region, endpoint, azure, env, timeoutMs = 60_000,
}) {
  const cfg = requireAzureConfig(resolveAzureConfig({ key, region, endpoint, voice, outputFormat, style, azure, env }));
  if (!AZURE_WAV_FORMATS.includes(cfg.outputFormat)) {
    throw new EngineError(
      ErrorCodes.TTS_FAILED,
      `Unsupported Azure output format "${cfg.outputFormat}" — narration must be a RIFF PCM WAV, one of: ${AZURE_WAV_FORMATS.join(', ')}`,
      { vendor: 'azure', outputFormat: cfg.outputFormat, allowed: AZURE_WAV_FORMATS },
    );
  }

  const catalogue = await listAzureVoices(cfg, { timeoutMs });
  const picked = pickVoice(cfg.voice, catalogue);
  const chosen = picked.voice;

  // A style the voice doesn't support is a 400 from the service; catching it
  // here names the voice and lists what it *does* support.
  if (cfg.style && chosen.styles.length && !chosen.styles.some((s) => s.toLowerCase() === cfg.style.toLowerCase())) {
    throw new EngineError(
      ErrorCodes.TTS_FAILED,
      `Voice ${chosen.name} does not support the style "${cfg.style}" (supported: ${chosen.styles.join(', ') || 'none'})`,
      { vendor: 'azure', voice: chosen.name, style: cfg.style, styles: chosen.styles },
    );
  }

  const ssml = buildSsml({
    text,
    voice: chosen.name,
    locale: chosen.locale ?? FALLBACK_LOCALE,
    rate, volume, pitch,
    style: cfg.style,
    styleDegree,
    role,
  });

  const url = `${cfg.endpoint}/cognitiveservices/v1`;
  const res = await azureFetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': cfg.outputFormat,
      'User-Agent': USER_AGENT,
    },
    body: ssml,
  }, { timeoutMs, what: 'synthesis' });

  if (!res.ok) {
    const body = await errorBody(res);
    // 400 with a voice complaint is the service's way of saying unsupported_voice.
    if (res.status === 400 && /voice/i.test(body)) {
      throw new EngineError(
        ErrorCodes.UNSUPPORTED_VOICE,
        `Azure Speech rejected the voice "${chosen.name}": ${body}`,
        { vendor: 'azure', voice: chosen.name, status: 400, body },
      );
    }
    throw httpError(res, body, { what: 'synthesis' });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new EngineError(ErrorCodes.TTS_FAILED, 'Azure Speech returned an empty audio body', { vendor: 'azure' });
  }
  // parseWavHeader would also catch this, but the message "not a RIFF file"
  // is clearer when the cause is a non-WAV output format slipping through.
  const info = parseWavHeader(buf, outPath);
  await fsp.writeFile(outPath, buf);

  return {
    ok: true,
    vendor: 'azure',
    engine: 'azure',
    voice: chosen.name,
    voiceSource: picked.source === 'default' ? 'auto' : (cfg.voiceSource ?? 'argument'),
    locale: chosen.locale ?? null,
    style: cfg.style ?? null,
    region: cfg.region ?? null,
    outputFormat: cfg.outputFormat,
    durationSeconds: info.dataSize / info.byteRate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bytes: buf.length,
    outPath,
  };
}
