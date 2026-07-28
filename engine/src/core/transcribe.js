/**
 * Transcription — turning supplied media into text WITH TIMING (v0.22).
 *
 * `synthesize_speech` returns `timings`: each sentence's start and duration in
 * seconds *and frames*. That single field is why generated narration is easy to
 * build against — captions, cue frames and visual beats all land on the word
 * because the engine reported where the word is. For a user's own recording
 * there was no equivalent, so every in-point was arithmetic against the clip's
 * duration and nothing else. This module is the other half of that field.
 *
 * The layering, top to bottom:
 *
 *   this file                  extract → bound → cache → DERIVE
 *   core/transcribe-vendors.js which vendor, and the chain rule
 *   core/transcribe-whisper.js one CLI contract, normalized to milliseconds
 *
 * Four derivations live here, and they are the product — not conveniences:
 *
 * 1. **Sentence re-segmentation.** whisper.cpp's `transcription[]` entries are
 *    *decode windows*, roughly 7.5 s of audio bounded by the model's context,
 *    and nothing about them respects grammar: a single entry routinely starts
 *    mid-clause and crosses three sentence boundaries. Splicing audio on those
 *    boundaries produces exactly the audible mid-word cut this tool exists to
 *    prevent, so sentences are rebuilt from token offsets. The engine owns this
 *    so every caller gets it right once, instead of re-deriving it per session.
 * 2. **Words.** The reason `-ojf` exists. Sentence timing cannot cue a graphic
 *    to a name spoken *inside* a sentence; per-word offsets can, and that is
 *    what turns a transcript from documentation into direction.
 * 3. **Frames.** Everything that places anything in this engine speaks frames. A
 *    tool that returns only seconds forces a hand division at exactly the spot
 *    where an off-by-one hides, so `sentences[]` mirrors `synthesize_speech`'s
 *    `timings[]` field-for-field — same names, same units, both reported.
 * 4. **`speechRanges` / `leadingSilenceFrames`.** Collapsing the sentence list
 *    into "where is there actually speech" is a few lines and worth more than
 *    the text: the raw words answer "what does it say", these answer "where can
 *    I cut", which is the question a film actually has.
 *
 * And two rules it obeys:
 *
 * - **Never invent words.** Per-sentence `minTokenP`/`meanTokenP` and per-word
 *   `p` are reported so a caller can decide; a confidently-wrong transcript
 *   quoted on screen is worse than no transcript. (Measured: `small.en` rendered
 *   "cutting-edge OLED" as "cutting, HOLED" on one pass — a caption generated
 *   blind from that would have been wrong on screen.)
 * - **Convert units once.** Vendor offsets are integer milliseconds. Every
 *   seconds/frames field in the response is derived here, never by the caller.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EngineError, ErrorCodes } from './errors.js';
import { framesForDuration } from './tts.js';
import { runFfmpeg } from './encoder.js';
import { defaultDataDir } from './scene.js';
import {
  resolveTranscriptionVendor, checkTranscriptionVendor, transcribeWithVendor,
  unavailableWithAlternatives,
} from './transcribe-vendors.js';

/**
 * Bounds. A twenty-minute silent job is the failure mode these exist to
 * prevent — at ≈6.5× realtime an hour of audio is ~9 minutes of CPU, which is
 * the most that can plausibly be waited out, and anything past it is a mistake
 * (a whole conference recording, the wrong file) rather than an intention.
 */
export const MAX_TRANSCRIBE_SECONDS = 3600;
export const MAX_TRANSCRIBE_BYTES = 2 * 1024 * 1024 * 1024;

/** whisper.cpp requires exactly this, so the extraction targets exactly this. */
export const WHISPER_SAMPLE_RATE = 16000;
export const WHISPER_CHANNELS = 1;

/**
 * Bumped whenever a derivation below changes shape or meaning. It is part of the
 * cache key, so a build with better sentence splitting does not serve the old
 * split from a sidecar written by the previous one.
 */
export const DERIVATION_VERSION = 1;

/* ------------------------------- derivations ------------------------------- */

/** Sentence-final punctuation, including the CJK forms — same set as splitSentences(). */
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;

/**
 * Words that end in a period without ending a sentence. Deliberately short: a
 * mis-split shifts one boundary, an over-long list is a maintenance burden that
 * silently stops matching how people actually write. Callers that need
 * paragraph-perfect segmentation have `rawSegments` and `words[]`.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'no', 'fig', 'approx',
  'dept', 'est', 'ie', 'eg', 'al', 'inc', 'ltd', 'co', 'etc',
]);

/**
 * Merge whisper's sub-word tokens into words.
 *
 * The rule is the vendor's own: a token that begins a word carries a leading
 * space (" Un" + "matched" → "Unmatched"), so anything without one — including
 * bare punctuation — attaches to the word before it. That is why `text` keeps
 * its punctuation ("device?"): stripping it would be a second, lossy opinion
 * about where a word ends.
 *
 * Zero-width tokens are common (whisper emits from === to whenever it has no
 * better estimate). A word left with no duration is widened to the next word's
 * start rather than reported as an instant, because a cue frame computed from an
 * instant lands wherever rounding puts it.
 */
export function flattenWords(tokens) {
  const words = [];
  for (const t of tokens ?? []) {
    const raw = t.text ?? '';
    if (!raw.trim()) continue;
    const startsWord = /^\s/.test(raw) || words.length === 0;
    if (startsWord) {
      words.push({ raw, text: raw.trim(), startMs: t.startMs, endMs: t.endMs, ps: [t.p] });
    } else {
      const w = words[words.length - 1];
      w.raw += raw;
      w.text = w.raw.trim();
      w.endMs = Math.max(w.endMs, t.endMs);
      w.ps.push(t.p);
    }
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.endMs <= w.startMs) w.endMs = words[i + 1]?.startMs > w.startMs ? words[i + 1].startMs : w.startMs;
    const ps = w.ps.filter((p) => typeof p === 'number');
    // The MINIMUM token probability, not the mean: a word is only as trustworthy
    // as its least certain piece, and this number exists to be distrusted.
    w.p = ps.length ? Math.min(...ps) : null;
    delete w.ps;
  }
  return words;
}

/** Would a word ending in "." plausibly not end the sentence? */
function isAbbreviation(text) {
  const bare = text.replace(/["'”’)\]]+$/, '');
  if (!bare.endsWith('.')) return false;
  const stem = bare.slice(0, -1);
  // "J." — an initial, not a full stop. Two letters ("Dr") are covered by the list.
  if (/^[A-Z]$/.test(stem)) return true;
  return ABBREVIATIONS.has(stem.toLowerCase());
}

/**
 * Rebuild sentences from a word list.
 *
 * This is the load-bearing derivation of the whole tool: the vendor's segments
 * are decode windows and cannot be used as edit points. A sentence closes after
 * a word whose text ends in sentence-final punctuation, and its span is its
 * first word's start to its last word's end — so a splice on a sentence boundary
 * lands in the pause, not in a clause.
 */
export function segmentSentences(words) {
  const sentences = [];
  let current = [];
  const close = () => {
    if (!current.length) return;
    const raw = current.map((w) => w.raw).join('');
    const ps = current.map((w) => w.p).filter((p) => typeof p === 'number');
    sentences.push({
      text: raw.replace(/\s+/g, ' ').trim(),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      minTokenP: ps.length ? Number(Math.min(...ps).toFixed(6)) : null,
      meanTokenP: ps.length ? Number((ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(6)) : null,
      words: current.length,
    });
    current = [];
  };
  for (const w of words) {
    current.push(w);
    if (SENTENCE_END.test(w.text) && !isAbbreviation(w.text)) close();
  }
  close(); // a recording that stops mid-sentence still reports what it said
  return sentences;
}

/**
 * Collapse sentences into the spans that actually contain speech.
 *
 * `silenceGapSeconds` is the pause long enough to be an edit point rather than
 * breathing. One second is deliberately generous: a continuous talk should come
 * back as ONE range (which is the useful answer — "the speech runs from here to
 * here"), and a range per sentence would be a slower way of reading
 * `sentences[]`.
 */
export function deriveSpeechRanges(sentences, { silenceGapSeconds = 1 } = {}) {
  const gapMs = Math.max(0, silenceGapSeconds * 1000);
  const ranges = [];
  for (const s of sentences) {
    const last = ranges[ranges.length - 1];
    if (last && s.startMs - last.endMs < gapMs) last.endMs = Math.max(last.endMs, s.endMs);
    else ranges.push({ startMs: s.startMs, endMs: Math.max(s.endMs, s.startMs) });
  }
  return ranges;
}

/* ----------------------------- unit conversion ---------------------------- */

const sec = (ms) => Number((ms / 1000).toFixed(4));
const atFrame = (ms, fps) => Math.round((ms / 1000) * fps);

/**
 * Everything derived, in SECONDS only — the form that goes into the cache,
 * because seconds are fps-independent and one cached transcript must serve a
 * 24 fps film and a 30 fps one alike.
 */
export function deriveTranscript({ tokens, segments = [], durationSeconds, silenceGapSeconds = 1 }) {
  const words = flattenWords(tokens);
  const sentences = segmentSentences(words);
  const ranges = deriveSpeechRanges(sentences, { silenceGapSeconds });
  const text = words.map((w) => w.raw).join('').replace(/\s+/g, ' ').trim();
  const speechEnd = ranges.length ? ranges[ranges.length - 1].endMs / 1000 : null;
  return {
    text,
    durationSeconds: Number(durationSeconds.toFixed(4)),
    sentences: sentences.map((s) => ({
      text: s.text,
      startSeconds: sec(s.startMs),
      durationSeconds: sec(Math.max(0, s.endMs - s.startMs)),
      endSeconds: sec(s.endMs),
      minTokenP: s.minTokenP,
      meanTokenP: s.meanTokenP,
      words: s.words,
    })),
    words: words.map((w) => ({
      text: w.text,
      startSeconds: sec(w.startMs),
      endSeconds: sec(w.endMs),
      p: w.p === null ? null : Number(w.p.toFixed(6)),
    })),
    speechRanges: ranges.map((r) => ({ startSeconds: sec(r.startMs), endSeconds: sec(r.endMs) })),
    leadingSilenceSeconds: ranges.length ? sec(ranges[0].startMs) : null,
    trailingSilenceSeconds: speechEnd === null ? null : Number(Math.max(0, durationSeconds - speechEnd).toFixed(4)),
    rawSegments: segments.map((s) => ({
      text: s.text.trim(), startSeconds: sec(s.startMs), endSeconds: sec(s.endMs),
    })),
  };
}

/**
 * Add the frame fields at one fps. `sentences[]` mirrors `synthesize_speech`'s
 * `timings[]` exactly — {text, startSeconds, startInFrames, durationSeconds,
 * durationInFrames} — so an agent treats "narration I generated" and "narration
 * the user recorded" identically, with the same field names in the same units.
 */
export function withFrames(derived, fps) {
  const frames = (s) => framesForDuration(s, fps);
  return {
    ...derived,
    fps,
    durationInFrames: frames(derived.durationSeconds),
    sentences: derived.sentences.map((s) => ({
      text: s.text,
      startSeconds: s.startSeconds,
      startInFrames: atFrame(s.startSeconds * 1000, fps),
      durationSeconds: s.durationSeconds,
      durationInFrames: frames(s.durationSeconds),
      endSeconds: s.endSeconds,
      endInFrames: atFrame(s.endSeconds * 1000, fps),
      minTokenP: s.minTokenP,
      meanTokenP: s.meanTokenP,
      words: s.words,
    })),
    words: derived.words.map((w) => ({
      text: w.text,
      startSeconds: w.startSeconds,
      startInFrames: atFrame(w.startSeconds * 1000, fps),
      endSeconds: w.endSeconds,
      endInFrames: atFrame(w.endSeconds * 1000, fps),
      p: w.p,
    })),
    speechRanges: derived.speechRanges.map((r) => ({
      startSeconds: r.startSeconds,
      startInFrames: atFrame(r.startSeconds * 1000, fps),
      endSeconds: r.endSeconds,
      endInFrames: atFrame(r.endSeconds * 1000, fps),
    })),
    leadingSilenceSeconds: derived.leadingSilenceSeconds,
    leadingSilenceFrames: derived.leadingSilenceSeconds === null
      ? null
      : atFrame(derived.leadingSilenceSeconds * 1000, fps),
    trailingSilenceSeconds: derived.trailingSilenceSeconds,
    trailingSilenceFrames: derived.trailingSilenceSeconds === null
      ? null
      : atFrame(derived.trailingSilenceSeconds * 1000, fps),
  };
}

/* -------------------------------- extraction ------------------------------- */

/**
 * Duration/format of a PCM WAV from its header alone.
 *
 * Not `wavDurationSeconds()`, which reads the whole file: an hour of 16 kHz mono
 * is 115 MB and we only need six numbers. The declared `data` size is trusted
 * only when it fits inside the file — ffmpeg writes a placeholder when it cannot
 * seek back, and a LIST chunk before `data` means the header is not always 44
 * bytes.
 */
export async function probeWavHeader(filePath) {
  const st = await fsp.stat(filePath);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(65536, st.size));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new EngineError(ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
        `Extracted audio is not a RIFF/WAVE file (${path.basename(filePath)})`);
    }
    let offset = 12;
    let byteRate, sampleRate, channels, dataOffset, declared;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 16 <= buf.length) {
        channels = buf.readUInt16LE(body + 2);
        sampleRate = buf.readUInt32LE(body + 4);
        byteRate = buf.readUInt32LE(body + 8);
      } else if (id === 'data') {
        dataOffset = body;
        declared = size;
        break;
      }
      offset = body + size + (size & 1);
    }
    if (!byteRate || dataOffset === undefined) {
      throw new EngineError(ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
        `Extracted audio has no usable fmt/data chunk (${path.basename(filePath)})`);
    }
    const available = Math.max(0, st.size - dataOffset);
    const dataSize = declared > 0 && declared <= available ? declared : available;
    return { seconds: dataSize / byteRate, sampleRate, channels, bytes: st.size, dataSize };
  } finally {
    await fh.close();
  }
}

/**
 * Extract 16 kHz mono 16-bit PCM from ANY media the engine's ffmpeg can read.
 *
 * Accepting a video directly is the point: requiring the caller to demux first
 * is exactly the friction this tool exists to remove, and ffmpeg is already a
 * declared prerequisite of the engine — nothing renders without it — so this
 * needs no other tool in place. The WAV is a **temp file, not an asset**: nobody
 * asked for it, and leaving 16 kHz mono debris in `assets/` invites someone to
 * put it on a timeline.
 *
 * @throws EngineError TRANSCRIPTION_INPUT_UNSUPPORTED when the file yields no audio
 */
export async function extractSpeechWav({ inputPath, outPath, ffmpegPath = 'ffmpeg', signal }) {
  try {
    await runFfmpeg({
      args: [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputPath,
        // Audio only: a video stream here would be decoded for nothing, and a
        // data/subtitle stream can make the wav muxer refuse outright.
        '-vn', '-sn', '-dn',
        '-ac', String(WHISPER_CHANNELS),
        '-ar', String(WHISPER_SAMPLE_RATE),
        '-acodec', 'pcm_s16le',
        '-f', 'wav',
        outPath,
      ],
      ffmpegPath,
      what: 'transcribe:extract',
      signal,
    });
  } catch (err) {
    if (err?.code === ErrorCodes.CANCELLED) throw err;
    throw new EngineError(
      ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
      `Could not extract 16 kHz mono audio from "${path.basename(inputPath)}" — it has no readable audio stream, ` +
        'or its codec is not supported by this ffmpeg build. Transcription needs speech in the file; a silent ' +
        'video cannot be transcribed. (probe_asset reports whether a file has an audio stream.)',
      { path: inputPath, stderrTail: err?.detail?.stderrTail ?? null, cause: err?.message },
    );
  }
  const header = await probeWavHeader(outPath);
  if (header.dataSize <= 0) {
    throw new EngineError(
      ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
      `"${path.basename(inputPath)}" produced no audio samples — it has no audio stream to transcribe.`,
      { path: inputPath },
    );
  }
  // A build that ignored -ar/-ac would silently hand whisper.cpp an input it
  // cannot use, and whisper's own failure would name the temp file, not this.
  if (header.sampleRate !== WHISPER_SAMPLE_RATE || header.channels !== WHISPER_CHANNELS) {
    throw new EngineError(
      ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED,
      `Extraction produced ${header.sampleRate} Hz / ${header.channels}ch audio, but whisper.cpp requires ` +
        `${WHISPER_SAMPLE_RATE} Hz mono. Check the ffmpeg binary in Studio settings.`,
      { path: inputPath, sampleRate: header.sampleRate, channels: header.channels },
    );
  }
  return header;
}

/* --------------------------------- caching -------------------------------- */

/**
 * Model load plus inference is seconds-to-minutes and the same file gets asked
 * about repeatedly while authoring — "what does it say", then "where does that
 * sentence start", then the same again after a reload. So the derived transcript
 * is cached under the data dir, keyed on (file identity, vendor, model,
 * language, derivation version).
 *
 * It lives in `<dataDir>/cache/transcripts/`, NOT beside the file: a transcript
 * dropped into the workspace library would be debris in a folder the human
 * curates, and one dropped into `assets/` invites someone to put it on a
 * timeline. Deleting the folder only costs the next call its inference.
 */
export function transcriptCacheKey({ absPath, bytes, mtimeMs, vendor, model, language }) {
  const identity = JSON.stringify([
    path.resolve(absPath).replace(/\\/g, '/').toLowerCase(),
    bytes, Math.round(mtimeMs), vendor, model ?? null, language ?? 'auto', DERIVATION_VERSION,
  ]);
  return createHash('sha1').update(identity).digest('hex');
}

export const transcriptCacheDir = (dataDir = defaultDataDir()) => path.join(dataDir, 'cache', 'transcripts');

export async function readTranscriptCache(dir, key) {
  try {
    const doc = JSON.parse(await fsp.readFile(path.join(dir, `${key}.json`), 'utf8'));
    if (doc?.key !== key || doc?.derivationVersion !== DERIVATION_VERSION) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Best-effort: a cache that cannot be written must never fail work that succeeded. */
export async function writeTranscriptCache(dir, key, doc) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const abs = path.join(dir, `${key}.json`);
    const tmp = `${abs}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2));
    await fsp.rename(tmp, abs);
  } catch { /* non-fatal by design */ }
}

/* ------------------------------ orchestration ----------------------------- */

/**
 * Read the speech in one media file: extract → bound → transcribe → derive.
 *
 * @param {object} opts
 * @param {string} opts.filePath          absolute path to any media ffmpeg can read
 * @param {number} [opts.fps=30]          the rate every frame field is reported at
 * @param {string} [opts.vendor]          omit for the machine's configured default
 * @param {string} [opts.model]           vendor model name or path (e.g. "small.en")
 * @param {string} [opts.language]        omit to auto-detect
 * @param {boolean} [opts.refresh=false]  ignore a cached transcript and re-run
 * @param {(phase: string) => void} [opts.onPhase]  'extracting' | 'transcribing' | 'deriving'
 * @returns {Promise<object>} the frame-bearing payload, plus `cached` and `elapsedMs`
 */
export async function transcribeMedia({
  filePath, fps = 30, vendor, model, language, silenceGapSeconds = 1,
  dataDir = defaultDataDir(), settings, ffmpegPath = 'ffmpeg',
  cacheDir, refresh = false, cache = true,
  maxSeconds = MAX_TRANSCRIBE_SECONDS, maxBytes = MAX_TRANSCRIBE_BYTES,
  timeoutMs, signal, onPhase = () => {},
}) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, `fps must be a positive number (got ${fps})`, { fps });
  }
  const st = await fsp.stat(filePath).catch(() => null);
  if (!st || !st.isFile()) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such file: ${filePath}`, { path: filePath });
  }
  if (st.size > maxBytes) {
    throw new EngineError(
      ErrorCodes.ASSET_TOO_LARGE,
      `"${path.basename(filePath)}" is ${(st.size / 1e9).toFixed(2)} GB, over the ` +
        `${(maxBytes / 1e9).toFixed(2)} GB transcription limit. Trim or split the file first.`,
      { path: filePath, bytes: st.size, maxBytes },
    );
  }

  // Probe before doing any work: an unconfigured vendor must fail without having
  // spent an ffmpeg extraction, and the probe also tells us which model will run
  // — which is part of the cache key.
  const resolved = await resolveTranscriptionVendor({ vendor, dataDir, settings, probe: true });
  const status = resolved.status ?? await checkTranscriptionVendor(resolved.vendor, { dataDir, settings });
  if (!status.available) throw await unavailableWithAlternatives(resolved.vendor, status, { dataDir, settings });

  const effectiveModel = model ?? status.config?.activeModel ?? null;
  const effectiveLanguage = language ?? status.config?.language ?? null;
  const dir = cacheDir ?? transcriptCacheDir(dataDir);
  const key = transcriptCacheKey({
    absPath: filePath, bytes: st.size, mtimeMs: st.mtimeMs,
    vendor: resolved.vendor, model: effectiveModel, language: effectiveLanguage,
  });

  if (cache && !refresh) {
    const hit = await readTranscriptCache(dir, key);
    if (hit) {
      return {
        ...withFrames(hit.derived, fps),
        vendor: hit.vendor,
        vendorSource: resolved.source,
        model: hit.model,
        language: hit.language,
        cached: true,
        transcribedAt: hit.transcribedAt,
        elapsedMs: 0,
      };
    }
  }

  const started = Date.now();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-transcribe-'));
  const wavPath = path.join(tmp, 'speech.wav');
  try {
    onPhase('extracting');
    const header = await extractSpeechWav({ inputPath: filePath, outPath: wavPath, ffmpegPath, signal });
    if (header.seconds > maxSeconds) {
      throw new EngineError(
        ErrorCodes.ASSET_TOO_LARGE,
        `"${path.basename(filePath)}" is ${Math.round(header.seconds)}s of audio, over the ${maxSeconds}s ` +
          'transcription limit. Cut the span you care about first — a whole-recording transcript is minutes of ' +
          'CPU that nothing asked for.',
        { path: filePath, durationSeconds: header.seconds, maxSeconds },
      );
    }

    onPhase('transcribing');
    const raw = await transcribeWithVendor({
      wavPath, model, language, dataDir, settings, resolved,
      // ffmpeg measured the audio, so the timeout can be proportional to it
      // instead of a flat guess: 4 s of wall per second of audio is ~26× the
      // measured 6.5× realtime — generous enough for a cold model load on a
      // slow machine, tight enough to fail rather than hang.
      timeoutMs: timeoutMs ?? Math.max(120_000, Math.round(header.seconds * 4000)),
      signal,
    });

    onPhase('deriving');
    const derived = deriveTranscript({
      tokens: raw.tokens,
      segments: raw.segments,
      durationSeconds: header.seconds,
      silenceGapSeconds,
    });
    const doc = {
      key,
      derivationVersion: DERIVATION_VERSION,
      vendor: raw.vendor,
      model: raw.model,
      language: raw.language,
      transcribedAt: new Date().toISOString(),
      source: { path: filePath, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) },
      derived,
    };
    if (cache) await writeTranscriptCache(dir, key, doc);
    return {
      ...withFrames(derived, fps),
      vendor: raw.vendor,
      vendorSource: raw.vendorSource ?? resolved.source,
      model: raw.model,
      language: raw.language,
      requestedLanguage: raw.requestedLanguage,
      threads: raw.threads ?? null,
      cached: false,
      transcribedAt: doc.transcribedAt,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Whether a path is worth handing to ffmpeg at all. Used to refuse a `.png` or a
 * `.json` up front with a sentence that names the mistake, instead of spending an
 * extraction to discover it has no audio.
 */
export const looksTranscribable = (p) =>
  /\.(wav|mp3|m4a|aac|flac|ogg|opus|wma|mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|ts|3gp)$/i.test(String(p ?? ''));
