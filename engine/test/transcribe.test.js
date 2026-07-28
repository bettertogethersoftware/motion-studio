/**
 * Transcription (v0.22): `transcribe_asset`'s engine half.
 *
 * The derivations are pure and tested directly, because they are the product —
 * everything else here is a vendor wrapper. The load-bearing case has its own
 * test: **a decode window that spans three sentences must re-segment**, driven
 * from the verbatim `-ojf` sample in docs/todo_task/transcribe-asset-plan.md
 * (helpers/fake-whisper.mjs serves it). Splicing audio on the vendor's own
 * segments is the audible mid-clause cut the whole tool exists to prevent, so if
 * one test in this file matters, it is that one.
 *
 * No test needs the real model: `ggml-small.en.bin` is 466 MB, and downloading
 * half a gigabyte to assert a sentence split is a network dependency, not a
 * test. Cases that need real audio extraction are gated on ffmpeg, like the
 * other suites.
 */

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  flattenWords, segmentSentences, deriveSpeechRanges, deriveTranscript, withFrames,
  probeWavHeader, extractSpeechWav, transcribeMedia, looksTranscribable,
  transcriptCacheKey, readTranscriptCache, DERIVATION_VERSION,
  WHISPER_SAMPLE_RATE,
} from '../src/core/transcribe.js';
import {
  resolveWhisper, listWhisperModels, pickWhisperModel, modelNameFromFile,
  normalizeWhisperJson, checkWhisperTranscription, transcribeWithWhisper,
  MODEL_PREFERENCE, WHISPER_ENV,
} from '../src/core/transcribe-whisper.js';
import {
  checkTranscriptionVendor, resolveTranscriptionVendor, transcriptionVendorReport,
  TRANSCRIPTION_VENDORS,
} from '../src/core/transcribe-vendors.js';
import { JobManager } from '../src/core/jobs.js';
import { ErrorCodes } from '../src/core/errors.js';
import { validateSettings, DEFAULT_SETTINGS, updateSettings, readSettings } from '../src/core/settings.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = path.resolve(__dirname, 'helpers/fake-whisper.mjs');

let tmp, modelsDir, home, haveFfmpeg = true;
const WHISPER_VARS = [
  ...WHISPER_ENV.bin, ...WHISPER_ENV.model, ...WHISPER_ENV.models, ...WHISPER_ENV.threads,
  'MOTION_STUDIO_TRANSCRIPTION_VENDOR', 'FAKE_WHISPER_FIXTURE', 'FAKE_WHISPER_FAIL', 'FAKE_WHISPER_NO_JSON',
];
let savedEnv;

/** A model on disk is any ggml-*.bin; the stub never reads the bytes. */
const writeModel = (dir, name, bytes = 64) =>
  fsp.writeFile(path.join(dir, `ggml-${name}.bin`), Buffer.alloc(bytes, 1));

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-transcribe-'));
  modelsDir = path.join(tmp, 'models');
  home = path.join(tmp, 'home');
  await fsp.mkdir(modelsDir, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await writeModel(modelsDir, 'small.en', 128);
  await writeModel(modelsDir, 'tiny.en', 32);
  // Not a model: a stray file in the folder must not become one.
  await fsp.writeFile(path.join(modelsDir, 'README.txt'), 'not a model');
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
});

after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

beforeEach(() => {
  savedEnv = Object.fromEntries(WHISPER_VARS.map((k) => [k, process.env[k]]));
  for (const k of WHISPER_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Provider-level calls take the binary directly. */
const withStub = (extra = {}) => ({ exe: FAKE_WHISPER, modelsDir, ...extra });

/**
 * Pipeline-level calls do not: transcribeMedia is vendor-agnostic and reaches
 * the binary the way a user configures it, so the tests configure it that way
 * too — which also means the env-var path is exercised rather than bypassed.
 * beforeEach clears these, so it never leaks between tests.
 */
function useStubEnv() {
  process.env[WHISPER_ENV.bin[0]] = FAKE_WHISPER;
  process.env[WHISPER_ENV.models[0]] = modelsDir;
}

/* ------------------------------------------------------------------ */
/* The plan's sample, verbatim — the fixture the parser must survive    */
/* ------------------------------------------------------------------ */

/**
 * One decode window, 8.56 s → 16.04 s, whose text starts mid-sentence and
 * crosses three sentence boundaries — plus the specials and a zero-width token.
 */
const PLAN_DOC = {
  model: { type: 'small', multilingual: false },
  params: { model: 'ggml-small.en.bin', language: 'en', translate: false },
  result: { language: 'en' },
  transcription: [{
    timestamps: { from: '00:00:08,560', to: '00:00:16,040' },
    offsets: { from: 8560, to: 16040 },
    text: ' the salvation and the redemption of the entire world. Jordan death. Jesus Christ',
    tokens: [
      { text: '[_BEG_]', offsets: { from: 8560, to: 8560 }, id: 50363, p: 0.999991, t_dtw: -1 },
      { text: ' the', offsets: { from: 8600, to: 8860 }, id: 1, p: 0.981, t_dtw: -1 },
      { text: ' salvation', offsets: { from: 8860, to: 9760 }, id: 21005, p: 0.994888, t_dtw: -1 },
      { text: ' and', offsets: { from: 9760, to: 10020 }, id: 2, p: 0.97, t_dtw: -1 },
      { text: ' the', offsets: { from: 10020, to: 10240 }, id: 3, p: 0.96, t_dtw: -1 },
      { text: ' redemption', offsets: { from: 10240, to: 11000 }, id: 4, p: 0.988, t_dtw: -1 },
      { text: ' of', offsets: { from: 11000, to: 11180 }, id: 5, p: 0.99, t_dtw: -1 },
      { text: ' the', offsets: { from: 11180, to: 11340 }, id: 6, p: 0.99, t_dtw: -1 },
      { text: ' entire', offsets: { from: 11340, to: 11800 }, id: 7, p: 0.97, t_dtw: -1 },
      { text: ' world', offsets: { from: 11800, to: 12400 }, id: 8, p: 0.99, t_dtw: -1 },
      { text: '.', offsets: { from: 12400, to: 12400 }, id: 13, p: 0.88, t_dtw: -1 },
      { text: ' Jordan', offsets: { from: 12900, to: 13400 }, id: 9, p: 0.41, t_dtw: -1 },
      { text: ' death', offsets: { from: 13400, to: 13900 }, id: 10, p: 0.35, t_dtw: -1 },
      { text: '.', offsets: { from: 13900, to: 13900 }, id: 13, p: 0.71, t_dtw: -1 },
      { text: ' Jesus', offsets: { from: 14400, to: 14900 }, id: 11, p: 0.96, t_dtw: -1 },
      { text: ' Christ', offsets: { from: 15400, to: 15400 }, id: 12, p: 0.93, t_dtw: -1 },
      { text: '[_TT_280]', offsets: { from: 16040, to: 16040 }, id: 50643, p: 0.53, t_dtw: -1 },
    ],
  }],
};

/* ------------------------------------------------------------------ */
/* normalization: milliseconds in, specials out                        */
/* ------------------------------------------------------------------ */

test('normalizeWhisperJson strips special tokens and keeps millisecond offsets', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  assert.equal(n.language, 'en');
  assert.equal(n.segments.length, 1);
  assert.equal(n.segments[0].startMs, 8560);
  // 17 tokens in, 2 specials ([_BEG_] and [_TT_280]) out.
  assert.equal(n.tokens.length, 15);
  assert.ok(!n.tokens.some((t) => t.text.includes('[_')));
  assert.equal(n.tokens[1].text, ' salvation');
  assert.equal(n.tokens[1].startMs, 8860);
  assert.equal(n.tokens[1].endMs, 9760);
});

test('normalizeWhisperJson tolerates a document with no transcription at all', () => {
  const n = normalizeWhisperJson({ result: {} });
  assert.deepEqual(n.segments, []);
  assert.deepEqual(n.tokens, []);
});

/* ------------------------------------------------------------------ */
/* words: sub-word tokens merged, zero-width widened                   */
/* ------------------------------------------------------------------ */

test('flattenWords merges sub-word tokens on the leading-space rule', () => {
  const words = flattenWords([
    { text: ' Un', startMs: 30800, endMs: 30920, p: 0.867 },
    { text: 'matched', startMs: 30920, endMs: 31140, p: 0.984 },
    { text: ' accuracy', startMs: 31800, endMs: 32000, p: 0.996 },
  ]);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, 'Unmatched');
  assert.equal(words[0].startMs, 30800);
  assert.equal(words[0].endMs, 31140);
  // The MINIMUM token probability: a word is only as trustworthy as its least
  // certain piece, and this number exists to be distrusted.
  assert.equal(words[0].p, 0.867);
});

test('flattenWords attaches bare punctuation to the word before it', () => {
  const words = flattenWords([
    { text: ' device', startMs: 29210, endMs: 30160, p: 0.99 },
    { text: '?', startMs: 30310, endMs: 30800, p: 0.888 },
    { text: ' Un', startMs: 30800, endMs: 30920, p: 0.867 },
  ]);
  assert.deepEqual(words.map((w) => w.text), ['device?', 'Un']);
});

test('flattenWords widens a zero-width word to the next word start', () => {
  const words = flattenWords([
    { text: ' accuracy', startMs: 31800, endMs: 31800, p: 0.996 },
    { text: ' at', startMs: 31920, endMs: 32100, p: 0.99 },
  ]);
  assert.equal(words[0].startMs, 31800);
  assert.equal(words[0].endMs, 31920, 'a word an instant wide is a cue frame decided by rounding');
});

test('flattenWords leaves a trailing zero-width word alone rather than inventing an end', () => {
  const words = flattenWords([{ text: ' Christ', startMs: 15400, endMs: 15400, p: 0.93 }]);
  assert.equal(words[0].endMs, 15400);
});

/* ------------------------------------------------------------------ */
/* THE case: one decode window, three sentences                        */
/* ------------------------------------------------------------------ */

test('a decode window spanning three sentences re-segments on sentence boundaries', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const sentences = segmentSentences(flattenWords(n.tokens));
  assert.equal(sentences.length, 3, 'the vendor reported ONE segment; grammar says three');
  assert.equal(sentences[0].text, 'the salvation and the redemption of the entire world.');
  assert.equal(sentences[1].text, 'Jordan death.');
  assert.equal(sentences[2].text, 'Jesus Christ');
  // Spans come from token offsets, not from the window: sentence 1 ends where
  // the full stop is (12400 ms), not where the decode window ends (16040 ms).
  assert.equal(sentences[0].startMs, 8600);
  assert.equal(sentences[0].endMs, 12400);
  assert.equal(sentences[1].startMs, 12900);
  assert.equal(sentences[1].endMs, 13900);
});

test('confidence is derived per sentence from token p, since the vendor emits no no_speech_prob', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const sentences = segmentSentences(flattenWords(n.tokens));
  // "Jordan death." is the model guessing (the plan's measured example of a
  // caption that would have been wrong on screen).
  assert.equal(sentences[1].minTokenP, 0.35);
  assert.ok(sentences[1].meanTokenP > 0.35 && sentences[1].meanTokenP < 0.6);
  assert.ok(sentences[0].minTokenP > 0.8, 'the confident sentence reads as confident');
});

test('a recording that stops mid-sentence still reports what it said', () => {
  const sentences = segmentSentences(flattenWords([
    { text: ' and then we', startMs: 0, endMs: 900, p: 0.9 },
  ]));
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, 'and then we');
});

test('a period that is an abbreviation or an initial does not end a sentence', () => {
  const split = (raw) => segmentSentences(flattenWords(
    raw.split(' ').map((t, i) => ({ text: ` ${t}`, startMs: i * 500, endMs: i * 500 + 400, p: 0.9 })),
  )).map((s) => s.text);
  assert.deepEqual(split('Dr. Bell arrived. He waited.'), ['Dr. Bell arrived.', 'He waited.']);
  assert.deepEqual(split('J. R. Tolkien wrote it.'), ['J. R. Tolkien wrote it.']);
  assert.deepEqual(split('It cost 3.5 million.'), ['It cost 3.5 million.']);
});

test('sentence-final punctuation inside quotes still closes the sentence', () => {
  const sentences = segmentSentences(flattenWords([
    { text: ' "Stop', startMs: 0, endMs: 400, p: 0.9 },
    { text: '!"', startMs: 400, endMs: 500, p: 0.9 },
    { text: ' Then', startMs: 900, endMs: 1200, p: 0.9 },
    { text: ' silence', startMs: 1200, endMs: 1700, p: 0.9 },
    { text: '.', startMs: 1700, endMs: 1700, p: 0.9 },
  ]));
  assert.deepEqual(sentences.map((s) => s.text), ['"Stop!"', 'Then silence.']);
});

/* ------------------------------------------------------------------ */
/* speechRanges — "where can I cut", not "what does it say"            */
/* ------------------------------------------------------------------ */

test('deriveSpeechRanges merges sentences across short gaps and splits on a real pause', () => {
  const sentences = [
    { startMs: 1000, endMs: 3000 },
    { startMs: 3400, endMs: 5000 },   // 400 ms — breathing, not an edit point
    { startMs: 9000, endMs: 11000 },  // 4 s — a pause you could cut on
  ];
  const ranges = deriveSpeechRanges(sentences, { silenceGapSeconds: 1 });
  assert.deepEqual(ranges, [{ startMs: 1000, endMs: 5000 }, { startMs: 9000, endMs: 11000 }]);
});

test('a continuous talk collapses to ONE range, which is the useful answer', () => {
  const sentences = Array.from({ length: 12 }, (_, i) => ({ startMs: i * 4000, endMs: i * 4000 + 3800 }));
  assert.equal(deriveSpeechRanges(sentences, { silenceGapSeconds: 1 }).length, 1);
});

test('pauseSeconds decides what counts as a cut point', () => {
  // A 400 ms hole: breathing at the default, an edit point if you say so.
  const sentences = [{ startMs: 0, endMs: 2000 }, { startMs: 2400, endMs: 4000 }];
  assert.equal(deriveSpeechRanges(sentences, { silenceGapSeconds: 1 }).length, 1);
  assert.equal(deriveSpeechRanges(sentences, { silenceGapSeconds: 0.5 }).length, 1);
  assert.equal(deriveSpeechRanges(sentences, { silenceGapSeconds: 0.3 }).length, 2);
});

test('no speech at all yields no ranges and a null leading silence, not a crash', () => {
  const d = deriveTranscript({ tokens: [], segments: [], durationSeconds: 12 });
  assert.equal(d.text, '');
  assert.deepEqual(d.sentences, []);
  assert.deepEqual(d.speechRanges, []);
  assert.equal(d.leadingSilenceSeconds, null);
  assert.equal(d.trailingSilenceSeconds, null);
});

/* ------------------------------------------------------------------ */
/* frames — the product, and the reason seconds alone are not enough   */
/* ------------------------------------------------------------------ */

test('withFrames mirrors synthesize_speech timings field-for-field', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const f = withFrames(deriveTranscript({ tokens: n.tokens, segments: n.segments, durationSeconds: 20 }), 30);
  for (const key of ['text', 'startSeconds', 'startInFrames', 'durationSeconds', 'durationInFrames']) {
    assert.ok(key in f.sentences[0], `sentences[] must carry ${key}, like timings[]`);
  }
  // 8.6 s at 30 fps = frame 258; 3.8 s of speech = 114 frames.
  assert.equal(f.sentences[0].startInFrames, 258);
  assert.equal(f.sentences[0].durationInFrames, 114);
  assert.equal(f.fps, 30);
});

test('the same transcript converts to any fps, and durations round UP so audio is never clipped', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const derived = deriveTranscript({ tokens: n.tokens, segments: n.segments, durationSeconds: 20 });
  assert.equal(withFrames(derived, 24).sentences[0].startInFrames, 206);   // 8.6 × 24 = 206.4
  assert.equal(withFrames(derived, 60).sentences[0].startInFrames, 516);
  // 12.9 s → 13.9 s is exactly 1.0 s; a 25 fps clip of 1.0 s is 25 frames.
  assert.equal(withFrames(derived, 25).sentences[1].durationInFrames, 25);
  // Sub-frame durations must never floor to zero.
  const tiny = deriveTranscript({
    tokens: [{ text: ' hm', startMs: 0, endMs: 10, p: 0.9 }, { text: '.', startMs: 10, endMs: 10, p: 0.9 }],
    segments: [], durationSeconds: 1,
  });
  assert.equal(withFrames(tiny, 30).sentences[0].durationInFrames, 1);
});

test('words carry start AND end frames — the field that cues a graphic mid-sentence', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const f = withFrames(deriveTranscript({ tokens: n.tokens, segments: n.segments, durationSeconds: 20 }), 30);
  const word = f.words.find((w) => w.text === 'salvation');
  assert.equal(word.startInFrames, 266, 'the plan\'s worked example');
  assert.equal(word.endInFrames, 293);
  assert.equal(word.p, 0.994888);
});

test('leading/trailing silence come back in frames as well as seconds', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const f = withFrames(deriveTranscript({ tokens: n.tokens, segments: n.segments, durationSeconds: 20 }), 30);
  assert.equal(f.leadingSilenceSeconds, 8.6);
  assert.equal(f.leadingSilenceFrames, 258);
  assert.equal(f.trailingSilenceFrames, 138); // 20 s − 15.4 s of speech
});

test('rawSegments are reported verbatim, so a wrong-looking sentence can be checked', () => {
  const n = normalizeWhisperJson(PLAN_DOC);
  const d = deriveTranscript({ tokens: n.tokens, segments: n.segments, durationSeconds: 20 });
  assert.equal(d.rawSegments.length, 1);
  assert.match(d.rawSegments[0].text, /^the salvation .* Jesus Christ$/);
  assert.equal(d.rawSegments[0].startSeconds, 8.56);
});

/* ------------------------------------------------------------------ */
/* vendor resolution: binary, models folder, model choice              */
/* ------------------------------------------------------------------ */

test('resolveWhisper: argument beats env beats settings', () => {
  process.env.MOTION_STUDIO_WHISPER_BIN = '/from/env/whisper-cli';
  const fromEnv = resolveWhisper({ whisper: { exe: '/from/settings/whisper-cli' } });
  assert.equal(fromEnv.command, '/from/env/whisper-cli');
  assert.equal(fromEnv.commandSource, 'MOTION_STUDIO_WHISPER_BIN');

  const fromArg = resolveWhisper({ exe: '/from/arg/whisper-cli', whisper: { exe: '/from/settings/whisper-cli' } });
  assert.equal(fromArg.commandSource, 'argument');

  delete process.env.MOTION_STUDIO_WHISPER_BIN;
  assert.equal(resolveWhisper({ whisper: { exe: '/from/settings/whisper-cli' } }).command, '/from/settings/whisper-cli');
  assert.equal(resolveWhisper({}).command, 'whisper-cli', 'PATH is the last resort');
});

test('resolveWhisper finds models BESIDE the binary — the shipped release layout', () => {
  const r = resolveWhisper({ exe: 'C:/tools/whisper/Release/whisper-cli.exe' });
  assert.equal(r.modelsDir, path.resolve('C:/tools/whisper/Release/models'));
  assert.equal(r.modelsDirSource, 'beside the binary');
});

test('resolveWhisper takes the models folder from a model given as a file path', () => {
  process.env.MOTION_STUDIO_WHISPER_MODEL = 'D:/models/ggml-large-v3.bin';
  const r = resolveWhisper({ exe: 'C:/tools/whisper-cli.exe' });
  assert.equal(r.modelsDir, path.resolve('D:/models'));
  assert.match(r.modelsDirSource, /beside MOTION_STUDIO_WHISPER_MODEL/);
});

test('resolveWhisper: an explicit models folder outranks both', () => {
  process.env.MOTION_STUDIO_WHISPER_MODELS = 'E:/whisper-models';
  const r = resolveWhisper({ exe: 'C:/tools/whisper-cli.exe', whisper: { model: 'D:/m/ggml-tiny.bin' } });
  assert.equal(r.modelsDir, 'E:/whisper-models');
  assert.equal(r.modelsDirSource, 'MOTION_STUDIO_WHISPER_MODELS');
});

test('resolveWhisper parses threads and ignores nonsense', () => {
  process.env.MOTION_STUDIO_WHISPER_THREADS = '8';
  assert.equal(resolveWhisper({}).threads, 8);
  process.env.MOTION_STUDIO_WHISPER_THREADS = 'lots';
  assert.equal(resolveWhisper({}).threads, null, 'a bad value means "let whisper decide", not NaN threads');
});

test('listWhisperModels reports ggml-*.bin only, and names them without the prefix', async () => {
  const models = await listWhisperModels(modelsDir);
  assert.deepEqual(models.map((m) => m.name), ['small.en', 'tiny.en']);
  assert.ok(models[0].englishOnly);
  assert.equal(models[0].bytes, 128);
  assert.equal(modelNameFromFile('/x/y/ggml-large-v3-turbo.bin'), 'large-v3-turbo');
  assert.deepEqual(await listWhisperModels(path.join(tmp, 'nope')), [], 'a missing folder is empty, not an error');
});

test('pickWhisperModel: the documented preference order decides when nobody names one', async () => {
  const models = await listWhisperModels(modelsDir);
  assert.equal(pickWhisperModel(undefined, models).name, 'small.en');
  assert.ok(MODEL_PREFERENCE.indexOf('small.en') < MODEL_PREFERENCE.indexOf('tiny.en'));
  assert.equal(pickWhisperModel('tiny.en', models).name, 'tiny.en', 'a named model wins');
  assert.equal(pickWhisperModel('TINY.EN', models).name, 'tiny.en', 'case-insensitive');
});

test('pickWhisperModel: an unknown name is an error with suggestions, never a substitution', async () => {
  const models = await listWhisperModels(modelsDir);
  assert.throws(() => pickWhisperModel('enormous-v9', models), (err) => {
    assert.equal(err.code, ErrorCodes.INVALID_CONFIG);
    assert.deepEqual(err.detail.suggestions, ['small.en', 'tiny.en']);
    return true;
  });
});

test('pickWhisperModel: no models at all is transcription_unavailable naming the fix', () => {
  assert.throws(() => pickWhisperModel(undefined, [], { modelsDir: '/x/models' }), (err) => {
    assert.equal(err.code, ErrorCodes.TRANSCRIPTION_UNAVAILABLE);
    assert.match(err.message, /MOTION_STUDIO_WHISPER_BIN/);
    assert.match(err.message, /ggml/);
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* probing and degradation                                             */
/* ------------------------------------------------------------------ */

test('checkWhisperTranscription reports the model that will run', async () => {
  const probe = await checkWhisperTranscription(withStub());
  assert.equal(probe.available, true);
  assert.deepEqual(probe.models, ['small.en', 'tiny.en']);
  assert.equal(probe.config.activeModel, 'small.en');
  assert.equal(probe.config.modelCount, 2);
});

test('a missing binary degrades to unavailable with the install sentence — never a throw', async () => {
  const probe = await checkWhisperTranscription({ exe: path.join(tmp, 'no-such-whisper-cli'), modelsDir });
  assert.equal(probe.available, false);
  assert.match(probe.error, /not found|ENOENT|Could not start/i);
  assert.equal(probe.config.modelsDir, modelsDir, 'it still reports where it looked');
});

test('a runnable binary with no models is unavailable, and says which folder is empty', async () => {
  const empty = path.join(tmp, 'empty-models');
  await fsp.mkdir(empty, { recursive: true });
  const probe = await checkWhisperTranscription({ exe: FAKE_WHISPER, modelsDir: empty });
  assert.equal(probe.available, false);
  assert.match(probe.error, /No whisper.cpp models found/);
  assert.ok(probe.error.includes(empty));
});

test('a configured model that is not on disk is unavailable, not a late failure', async () => {
  const probe = await checkWhisperTranscription({
    exe: FAKE_WHISPER, modelsDir, whisper: { model: path.join(tmp, 'ggml-ghost.bin') },
  });
  assert.equal(probe.available, false);
  assert.match(probe.error, /does not exist/);
});

test('the capability report has the same shape as speech and music', async () => {
  process.env.MOTION_STUDIO_WHISPER_BIN = FAKE_WHISPER;
  process.env.MOTION_STUDIO_WHISPER_MODELS = modelsDir;
  const report = await transcriptionVendorReport({ dataDir: home });
  assert.equal(report.capability, 'transcription');
  assert.equal(report.active, 'whisper-cpp');
  assert.equal(report.activeSource, 'default');
  assert.deepEqual(report.chain, ['whisper-cpp']);
  assert.equal(report.fellBack, false);
  assert.equal(report.vendorEnv, 'MOTION_STUDIO_TRANSCRIPTION_VENDOR');
  assert.equal(report.vendors[0].available, true);
  assert.equal(report.vendors[0].offline, true, 'local and offline, like piper');
});

test('an unknown vendor id is a config error; the env var can name the one there is', async () => {
  await assert.rejects(() => checkTranscriptionVendor('deepgram-asr', { dataDir: home }), (err) => {
    assert.equal(err.code, ErrorCodes.INVALID_CONFIG);
    return true;
  });
  process.env.MOTION_STUDIO_TRANSCRIPTION_VENDOR = 'whisper-cpp';
  const resolved = await resolveTranscriptionVendor({ dataDir: home });
  assert.equal(resolved.source, 'env');
  assert.deepEqual(TRANSCRIPTION_VENDORS, ['whisper-cpp']);
});

/* ------------------------------------------------------------------ */
/* the CLI contract                                                    */
/* ------------------------------------------------------------------ */

test('the engine passes -ojf (not -oj), and threads reach -t', async () => {
  const wav = path.join(tmp, 'in.wav');
  const argsOut = path.join(tmp, 'argv.json');
  await fsp.writeFile(wav, 'pretend audio');
  process.env.FAKE_WHISPER_ARGS_OUT = argsOut;
  try {
    const result = await transcribeWithWhisper({ wavPath: wav, ...withStub(), threads: 6 });
    assert.equal(result.vendor, 'whisper-cpp');
    assert.equal(result.model, 'small.en');
    assert.equal(result.language, 'en');
    assert.equal(result.threads, 6);
    assert.equal(result.segments.length, 1);
    assert.equal(result.tokens.length, 15);

    const argv = JSON.parse(await fsp.readFile(argsOut, 'utf8'));
    // -ojf, never -oj: plain --output-json omits the tokens, and the tokens ARE
    // the per-word timing this tool exists to report.
    assert.ok(argv.includes('-ojf'), `expected -ojf in ${argv.join(' ')}`);
    assert.ok(!argv.includes('-oj'));
    assert.deepEqual(argv.slice(argv.indexOf('-t'), argv.indexOf('-t') + 2), ['-t', '6']);
    assert.ok(argv.includes('-np'), 'progress chatter on stdout would look like output');
    assert.equal(argv[argv.indexOf('-m') + 1], result.modelPath);
  } finally {
    delete process.env.FAKE_WHISPER_ARGS_OUT;
  }
});

test('an unnamed language asks for auto-detect and reports what came back', async () => {
  const wav = path.join(tmp, 'in2.wav');
  await fsp.writeFile(wav, 'pretend audio');
  const result = await transcribeWithWhisper({ wavPath: wav, ...withStub() });
  assert.equal(result.requestedLanguage, 'auto');
  assert.equal(result.language, 'en');
});

test('a vendor that exits non-zero is transcription_failed with its stderr tail', async () => {
  process.env.FAKE_WHISPER_FAIL = 'out of memory';
  const wav = path.join(tmp, 'in3.wav');
  await fsp.writeFile(wav, 'pretend audio');
  await assert.rejects(() => transcribeWithWhisper({ wavPath: wav, ...withStub() }), (err) => {
    assert.equal(err.code, ErrorCodes.TRANSCRIPTION_FAILED);
    assert.match(err.message, /out of memory/);
    return true;
  });
});

test('a build that writes no JSON fails naming --output-json-full', async () => {
  process.env.FAKE_WHISPER_NO_JSON = '1';
  const wav = path.join(tmp, 'in4.wav');
  await fsp.writeFile(wav, 'pretend audio');
  await assert.rejects(() => transcribeWithWhisper({ wavPath: wav, ...withStub() }), (err) => {
    assert.equal(err.code, ErrorCodes.TRANSCRIPTION_FAILED);
    assert.match(err.message, /output-json-full/);
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* bounds and input handling                                           */
/* ------------------------------------------------------------------ */

test('looksTranscribable accepts audio and video, refuses everything else', () => {
  for (const p of ['a.wav', 'b.MP3', 'c.m4a', 'd.mp4', 'e.mov', 'f.webm']) assert.ok(looksTranscribable(p), p);
  for (const p of ['a.png', 'b.json', 'c.ttf', 'd', '']) assert.ok(!looksTranscribable(p), p);
});

test('a file over the byte bound fails before any work is done', async () => {
  const big = path.join(tmp, 'big.wav');
  await fsp.writeFile(big, Buffer.alloc(4096));
  await assert.rejects(
    () => transcribeMedia({ filePath: big, dataDir: home, maxBytes: 1024, cache: false }),
    (err) => {
      assert.equal(err.code, ErrorCodes.ASSET_TOO_LARGE);
      assert.equal(err.detail.maxBytes, 1024);
      return true;
    },
  );
});

test('a missing file is file_not_found, and a bad fps is invalid_config', async () => {
  await assert.rejects(
    () => transcribeMedia({ filePath: path.join(tmp, 'ghost.wav'), dataDir: home, cache: false }),
    (err) => (assert.equal(err.code, ErrorCodes.FILE_NOT_FOUND), true),
  );
  await assert.rejects(
    () => transcribeMedia({ filePath: path.join(tmp, 'ghost.wav'), fps: 0, dataDir: home, cache: false }),
    (err) => (assert.equal(err.code, ErrorCodes.INVALID_CONFIG), true),
  );
});

test('an unconfigured vendor fails with the fix before an extraction is attempted', async () => {
  const wav = path.join(tmp, 'unconfigured.wav');
  await fsp.writeFile(wav, 'pretend audio');
  process.env.MOTION_STUDIO_WHISPER_BIN = path.join(tmp, 'no-such-whisper-cli');
  await assert.rejects(
    () => transcribeMedia({ filePath: wav, dataDir: home, cache: false }),
    (err) => {
      assert.equal(err.code, ErrorCodes.TRANSCRIPTION_UNAVAILABLE);
      assert.match(err.message, /do not retry blindly/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* extraction + the whole pipeline (needs real ffmpeg)                 */
/* ------------------------------------------------------------------ */

/** A real WAV, so ffmpeg has something to resample. 48 kHz stereo, 2 s of tone. */
async function writeToneWav(file, { seconds = 2, sampleRate = 48000, channels = 2 } = {}) {
  const bytes = sampleRate * channels * 2 * seconds;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 30)), 44 + i);
  await fsp.writeFile(file, buf);
  return file;
}

test('extraction always produces 16 kHz mono, whatever went in', { skip: !haveFfmpeg }, async () => {
  const src = await writeToneWav(path.join(tmp, 'stereo48.wav'));
  const out = path.join(tmp, 'extracted.wav');
  const header = await extractSpeechWav({ inputPath: src, outPath: out });
  assert.equal(header.sampleRate, WHISPER_SAMPLE_RATE, 'whisper.cpp requires it; the engine guarantees it');
  assert.equal(header.channels, 1);
  assert.ok(Math.abs(header.seconds - 2) < 0.05);
});

test('probeWavHeader measures duration from the header, not by reading the file', { skip: !haveFfmpeg }, async () => {
  const src = await writeToneWav(path.join(tmp, 'measure.wav'), { seconds: 3, sampleRate: 16000, channels: 1 });
  const header = await probeWavHeader(src);
  assert.ok(Math.abs(header.seconds - 3) < 0.001);
  assert.equal(header.sampleRate, 16000);
});

test('a file with no audio stream is transcription_input_unsupported, naming the mistake', { skip: !haveFfmpeg }, async () => {
  const notMedia = path.join(tmp, 'notmedia.wav');
  await fsp.writeFile(notMedia, 'this is not a wav at all');
  await assert.rejects(
    () => extractSpeechWav({ inputPath: notMedia, outPath: path.join(tmp, 'x.wav') }),
    (err) => {
      assert.equal(err.code, ErrorCodes.TRANSCRIPTION_INPUT_UNSUPPORTED);
      assert.match(err.message, /no readable audio stream|not supported/);
      return true;
    },
  );
});

test('transcribeMedia: extract → transcribe → derive, in frames', { skip: !haveFfmpeg }, async () => {
  const src = await writeToneWav(path.join(tmp, 'pipeline.wav'), { seconds: 20 });
  const phases = [];
  useStubEnv();
  const r = await transcribeMedia({
    filePath: src, fps: 30, cache: false, dataDir: home,
    onPhase: (p) => phases.push(p),
  });
  assert.deepEqual(phases, ['extracting', 'transcribing', 'deriving']);
  assert.equal(r.vendor, 'whisper-cpp');
  assert.equal(r.model, 'small.en');
  assert.equal(r.cached, false);
  assert.equal(r.sentences.length, 3, 'the plan fixture: one window, three sentences');
  assert.equal(r.sentences[0].startInFrames, 258);
  // 15 real tokens merged into 13 words: the two bare full stops attach to the
  // words before them.
  assert.equal(r.words.length, 13);
  assert.equal(r.fps, 30);
  assert.ok(r.durationInFrames >= 600);
});

test('transcribeMedia: the duration bound fires after extraction with the measurement', { skip: !haveFfmpeg }, async () => {
  const src = await writeToneWav(path.join(tmp, 'toolong.wav'), { seconds: 5 });
  useStubEnv();
  await assert.rejects(
    () => transcribeMedia({ filePath: src, cache: false, dataDir: home, maxSeconds: 2 }),
    (err) => {
      assert.equal(err.code, ErrorCodes.ASSET_TOO_LARGE);
      assert.equal(err.detail.maxSeconds, 2);
      assert.ok(err.detail.durationSeconds > 4);
      return true;
    },
  );
});

test('two speech spans with a hole between them come back as two speechRanges', { skip: !haveFfmpeg }, async () => {
  process.env.FAKE_WHISPER_FIXTURE = 'gap';
  const src = await writeToneWav(path.join(tmp, 'gap.wav'), { seconds: 12 });
  useStubEnv();
  const r = await transcribeMedia({ filePath: src, fps: 30, cache: false, dataDir: home });
  assert.equal(r.speechRanges.length, 2);
  assert.equal(r.speechRanges[0].startInFrames, 30);
  assert.equal(r.speechRanges[1].startInFrames, 210);
  assert.equal(r.leadingSilenceFrames, 30);
});

test('a recording with no speech reports empty results, not an error', { skip: !haveFfmpeg }, async () => {
  process.env.FAKE_WHISPER_FIXTURE = 'empty';
  const src = await writeToneWav(path.join(tmp, 'silent.wav'), { seconds: 2 });
  useStubEnv();
  const r = await transcribeMedia({ filePath: src, cache: false, dataDir: home });
  assert.equal(r.text, '');
  assert.deepEqual(r.sentences, []);
  assert.equal(r.leadingSilenceFrames, null);
});

/* ------------------------------------------------------------------ */
/* the cache                                                           */
/* ------------------------------------------------------------------ */

test('the cache key changes with the file, the model and the language', () => {
  const base = { absPath: 'C:/a/b.wav', bytes: 100, mtimeMs: 5, vendor: 'whisper-cpp', model: 'small.en', language: 'en' };
  const key = transcriptCacheKey(base);
  assert.equal(transcriptCacheKey({ ...base }), key, 'stable for identical inputs');
  assert.notEqual(transcriptCacheKey({ ...base, mtimeMs: 6 }), key, 'an edited file is a different transcript');
  assert.notEqual(transcriptCacheKey({ ...base, bytes: 101 }), key);
  assert.notEqual(transcriptCacheKey({ ...base, model: 'large-v3' }), key, 'a better model must not serve a stale read');
  assert.notEqual(transcriptCacheKey({ ...base, language: 'de' }), key);
  // Windows paths differ in case between callers; the same file is one key.
  assert.equal(transcriptCacheKey({ ...base, absPath: 'C:/A/B.WAV' }), key);
});

test('a second call is served from the sidecar, at whatever fps it asks for', { skip: !haveFfmpeg }, async () => {
  const cacheDir = path.join(tmp, 'cache');
  const src = await writeToneWav(path.join(tmp, 'cached.wav'), { seconds: 20 });
  useStubEnv();
  const first = await transcribeMedia({ filePath: src, fps: 30, dataDir: home, cacheDir });
  assert.equal(first.cached, false);

  const second = await transcribeMedia({ filePath: src, fps: 24, dataDir: home, cacheDir });
  assert.equal(second.cached, true);
  assert.equal(second.elapsedMs, 0);
  assert.equal(second.text, first.text);
  // Seconds are cached; frames are derived per call, so one transcript serves
  // a 24 fps film and a 30 fps one.
  assert.equal(second.fps, 24);
  assert.equal(second.sentences[0].startInFrames, 206);

  const refreshed = await transcribeMedia({ filePath: src, fps: 30, dataDir: home, cacheDir, refresh: true });
  assert.equal(refreshed.cached, false, 'refresh re-runs the model');

  const files = await fsp.readdir(cacheDir);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 1, 'one entry per (file, model, language)');
  const doc = await readTranscriptCache(cacheDir, files[0].replace(/\.json$/, ''));
  assert.equal(doc.derivationVersion, DERIVATION_VERSION);
  assert.equal(doc.vendor, 'whisper-cpp');
  assert.ok(doc.derived.sentences[0].startSeconds > 0, 'the cache holds seconds, not frames');
});

test('a sidecar from an older derivation is ignored rather than trusted', async () => {
  const cacheDir = path.join(tmp, 'cache-old');
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(path.join(cacheDir, 'abc.json'), JSON.stringify({
    key: 'abc', derivationVersion: DERIVATION_VERSION - 1, derived: { sentences: [] },
  }));
  assert.equal(await readTranscriptCache(cacheDir, 'abc'), null);
});

/* ------------------------------------------------------------------ */
/* the task lane                                                       */
/* ------------------------------------------------------------------ */

test('a transcription job does not wait behind a render', async () => {
  const jobs = new JobManager({ maxConcurrent: 1 });
  let releaseRender;
  const renderFn = () => new Promise((resolve) => { releaseRender = () => resolve({ ok: true }); });
  const render = jobs.startRender({
    targetId: 'r', scenePath: tmp, config: { durationInFrames: 10, fps: 30 },
    outputPath: path.join(tmp, 'out.mp4'), renderFn,
  });
  assert.equal(render.state, 'running');

  const task = jobs.startTask({ kind: 'transcribe', targetId: 'clip.wav', run: async () => ({ text: 'hi' }) });
  assert.equal(task.state, 'running', 'the render lane is full; the task lane is not');

  const waited = await jobs.waitFor([task.jobId], { timeoutMs: 4000 });
  assert.equal(waited.timedOut, false);
  const status = waited.jobs[0];
  assert.equal(status.kind, 'transcribe');
  assert.deepEqual(status.result, { text: 'hi' }, "a task's result IS its answer, so the status carries it");
  assert.equal(jobs.getStatus(render.jobId).state, 'running', 'the render was never disturbed');
  releaseRender();
});

test('the task lane has its own concurrency limit and queue', async () => {
  const jobs = new JobManager({ maxConcurrentTasks: 1, maxQueuedTasks: 1 });
  const hold = [];
  const blocker = () => new Promise((resolve) => hold.push(resolve));
  const a = jobs.startTask({ kind: 'transcribe', run: blocker });
  const b = jobs.startTask({ kind: 'transcribe', run: blocker });
  assert.equal(a.state, 'running');
  assert.equal(b.state, 'queued');
  assert.equal(b.queuePosition, 1);
  assert.throws(() => jobs.startTask({ kind: 'transcribe', run: blocker }), (err) => {
    assert.equal(err.code, ErrorCodes.QUEUE_FULL);
    return true;
  });
  // Cancelling a queued task dequeues it from the TASK queue, not the render one.
  assert.equal(jobs.cancel(b.jobId).state, 'cancelled');
  hold.forEach((r) => r());
});

test('a failing task ends as error with the structured code, and no result', async () => {
  const jobs = new JobManager();
  const { jobId } = jobs.startTask({
    kind: 'transcribe',
    run: async () => { throw Object.assign(new Error('nope'), {}); },
  });
  const { jobs: [status] } = await jobs.waitFor([jobId], { timeoutMs: 4000 });
  assert.equal(status.state, 'error');
  assert.equal(status.error.message, 'nope');
  assert.equal('result' in status, false);
});

test('render jobs still report kind "render", and the session cap ignores tasks', () => {
  const jobs = new JobManager({ maxJobsPerSession: 1 });
  const r = jobs.startRender({
    targetId: 'r', scenePath: tmp, config: { durationInFrames: 1, fps: 30 },
    outputPath: path.join(tmp, 'o.mp4'), renderFn: async () => ({}),
  });
  assert.equal(jobs.getStatus(r.jobId).kind, 'render');
  // The cap bounds an unattended agent's RENDERS; reading a file it was handed
  // is not one, so a task still starts.
  const t = jobs.startTask({ kind: 'transcribe', run: async () => 1 });
  assert.ok(t.jobId);
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

test('settings: the transcription section validates, and a bad thread count is refused', () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  assert.doesNotThrow(() => validateSettings(s));
  s.transcription.whisper.threads = 8;
  assert.doesNotThrow(() => validateSettings(s));
  s.transcription.whisper.threads = 0;
  assert.throws(() => validateSettings(s), /threads/);
  s.transcription.whisper.threads = null;
  s.transcription.vendor = 'faster-whisper';
  assert.throws(() => validateSettings(s), /transcription.vendor/);
});

test('settings: a file written before v0.22 still reads, and the section round-trips', async () => {
  const dir = path.join(tmp, 'settings-home');
  await fsp.mkdir(dir, { recursive: true });
  // A pre-v0.22 file has no transcription key at all.
  await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    schemaVersion: 1, tts: { vendor: 'piper' },
  }));
  const read = await readSettings(dir);
  assert.deepEqual(read.transcription, DEFAULT_SETTINGS.transcription);

  const saved = await updateSettings({ transcription: { whisper: { model: 'large-v3', threads: 12 } } }, dir);
  assert.equal(saved.transcription.whisper.model, 'large-v3');
  assert.equal(saved.transcription.whisper.threads, 12);
  // A one-level-deeper merge: setting the model must not clear the threads.
  const again = await updateSettings({ transcription: { whisper: { language: 'de' } } }, dir);
  assert.equal(again.transcription.whisper.threads, 12);
  assert.equal(again.transcription.whisper.language, 'de');
});
