/**
 * whisper.cpp — reading speech out of supplied media (v0.22).
 *
 * The engine could always *write* speech and knew exactly where every word
 * landed (`synthesize_speech` returns `timings`). It could not *read* speech, so
 * everything about a recording a user supplied was a guess. This is the vendor
 * that closes that asymmetry. https://github.com/ggml-org/whisper.cpp
 *
 * It is shaped exactly like the Piper speech vendor, deliberately: **a single
 * self-contained binary plus one model file**, found through `MOTION_STUDIO_*`,
 * spawned as a separate process, never bundled or downloaded by us, degrading to
 * `transcription_unavailable` when absent. The alternative considered was
 * faster-whisper, which needs Python, pip and a CTranslate2 wheel — three moving
 * parts on a user's machine to read a WAV.
 *
 *   MOTION_STUDIO_WHISPER_BIN      whisper-cli.exe (or `whisper-cli` on PATH)
 *   MOTION_STUDIO_WHISPER_MODEL    a ggml-*.bin path, or a bare name ("small.en")
 *   MOTION_STUDIO_WHISPER_MODELS   the folder holding several ggml-*.bin
 *   MOTION_STUDIO_WHISPER_THREADS  -t (default: whisper.cpp's own, 4)
 *
 * **No API keys anywhere.** This is a local model, and nothing about it should
 * teach an agent to ask a user for a secret.
 *
 * Four facts about the vendor that this module exists to absorb, all verified
 * against a real run (whisper-cli + ggml-small.en on 72.8 s of narration →
 * 9.5 s wall, ≈7.7× realtime, no GPU):
 *
 *   - **`-ojf`, not `-oj`.** Plain `--output-json` omits the `tokens` array, and
 *     the tokens are the whole point: they are where per-word timing lives.
 *   - **Input must be 16 kHz mono PCM.** Not a preference — whisper.cpp requires
 *     it. Callers never have to know: core/transcribe.js resamples with the
 *     engine's own ffmpeg first, and hands this module a conforming WAV.
 *   - **`transcription[]` entries are decode windows, not sentences**, and their
 *     `tokens[]` include specials (`[_BEG_]`, `[_TT_280]`) with zero-width
 *     offsets. This module strips the specials and normalizes offsets to
 *     milliseconds; core/transcribe.js does the re-segmentation.
 *   - **There is no `no_speech_prob`.** What exists is per-token `p`, so
 *     confidence has to be *derived* — see core/transcribe.js.
 *
 * `-dtw` (token-level DTW alignment) is deliberately NOT enabled: whether it
 * measurably improves token boundaries here is untested, and an unmeasured
 * default that doubles encode work is not an improvement.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { vendorDir } from './paths.js';

const STDERR_TAIL_LINES = 40;

/** Env hooks, in precedence order. Exported so the UI and docs list one truth. */
export const WHISPER_ENV = Object.freeze({
  bin: Object.freeze(['MOTION_STUDIO_WHISPER_BIN']),
  model: Object.freeze(['MOTION_STUDIO_WHISPER_MODEL']),
  models: Object.freeze(['MOTION_STUDIO_WHISPER_MODELS']),
  threads: Object.freeze(['MOTION_STUDIO_WHISPER_THREADS']),
});

/** Where models live when nothing says otherwise (git-ignored, like piper's voices). */
const defaultModelsDir = () => path.join(vendorDir(), 'whisper', 'models');

/**
 * Which model to use when the machine has several and nobody named one.
 *
 * Ordered by the balance the plan measured rather than by size: `small.en` is
 * fast enough (≈6.5–7.7× realtime on 8 CPU threads) to transcribe on ingest AND
 * re-transcribe a finished cut to verify it, which is the property that makes
 * this tool worth calling twice. A machine holding only `large-v3` still uses
 * it; a machine holding both gets the cheap one unless it asks.
 *
 * Every response reports the model that actually ran, so this default is
 * visible rather than assumed.
 */
export const MODEL_PREFERENCE = Object.freeze([
  'small.en', 'small',
  'base.en', 'base',
  'medium.en', 'medium',
  'large-v3-turbo', 'large-v3', 'large-v2', 'large',
  'tiny.en', 'tiny',
]);

/** ggml-small.en.bin → small.en */
export const modelNameFromFile = (file) =>
  path.basename(file).replace(/^ggml-/i, '').replace(/\.bin$/i, '');

const looksLikeModelFile = (v) => /\.bin$/i.test(v) || v.includes('/') || v.includes('\\');

/**
 * The executable names a whisper.cpp build produces. `whisper-cli` is the
 * current one; `main` is what releases before mid-2024 called it, and old
 * unzipped folders are still out there.
 */
const WHISPER_BINARY_NAMES = Object.freeze(['whisper-cli', 'main']);

/**
 * Where those binaries sit relative to a folder a human is likely to point at.
 * The prebuilt Windows zip unpacks to `whisper-bin-x64/Release/whisper-cli.exe`
 * and a source build lands in `build/bin/Release/`, so pointing at either the
 * extracted root or the folder actually holding the exe has to work.
 */
const WHISPER_BIN_SUBDIRS = Object.freeze(['', 'Release', 'bin', 'build/bin/Release', 'build/bin']);

const isDirectory = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

/**
 * Find the whisper executable inside a folder, or null.
 *
 * Pointing a "where is whisper.cpp" setting at the folder you unzipped is the
 * obvious reading of it, and it used to spawn the directory and fail ENOENT
 * with "not found" while the binary sat one name away inside it. Resolving it
 * here fixes the setting, the probe and the run in one place — and returning
 * null (rather than guessing) keeps a genuinely empty folder an honest error.
 */
export function whisperBinaryIn(dir) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['', '.exe'];
  for (const sub of WHISPER_BIN_SUBDIRS) {
    for (const name of WHISPER_BINARY_NAMES) {
      for (const ext of exts) {
        const abs = path.join(dir, ...sub.split('/').filter(Boolean), name + ext);
        try { if (fs.statSync(abs).isFile()) return abs; } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

/**
 * Resolve how to run whisper.cpp and where its models are, recording which
 * layer won so the Studio can show "whisper-cli.exe (from
 * MOTION_STUDIO_WHISPER_BIN)" rather than leaving the user to guess.
 *
 * The models folder has one resolution step the speech vendors don't need: when
 * nothing names it, look **beside the binary**. That is the layout every
 * prebuilt whisper.cpp release ships (`.../Release/whisper-cli.exe` with
 * `.../Release/models/ggml-small.en.bin`), so pointing one env var at the exe
 * is enough to have a working setup.
 *
 * @returns {{command, commandSource, modelsDir, modelsDirSource,
 *            model: string|null, modelSource: string|null,
 *            threads: number|null, threadsSource: string|null,
 *            language: string|null, languageSource: string|null}}
 */
export function resolveWhisper({
  exe, model, modelsDir, threads, language, whisper = {}, env = process.env,
} = {}) {
  const pick = (explicit, names, setting) => {
    const e = typeof explicit === 'string' ? explicit.trim() : explicit;
    if (e || e === 0) return { value: e, source: 'argument' };
    for (const name of names) {
      const v = env[name]?.trim();
      if (v) return { value: v, source: name };
    }
    const s = typeof setting === 'string' ? setting.trim() : setting;
    if (s || s === 0) return { value: s, source: 'settings' };
    return { value: null, source: null };
  };

  const exeHit = pick(exe, WHISPER_ENV.bin, whisper.exe);
  const modelHit = pick(model, WHISPER_ENV.model, whisper.model);
  const dirHit = pick(modelsDir, WHISPER_ENV.models, whisper.modelsDir);
  const threadHit = pick(threads, WHISPER_ENV.threads, whisper.threads);
  const langHit = pick(language, [], whisper.language);

  let command = exeHit.value ?? 'whisper-cli';
  const commandSource = exeHit.source ?? 'PATH';

  // Pointed at a FOLDER? Look inside it for the binary. A "where is
  // whisper.cpp" box invites the install folder, and the previous behaviour
  // spawned the directory itself and reported "not found" while whisper-cli
  // sat inside it. A folder with no binary keeps its own value, so the error
  // still names what the human actually typed.
  let commandFolder = null;
  if (exeHit.value && isDirectory(exeHit.value)) {
    const found = whisperBinaryIn(exeHit.value);
    if (found) { commandFolder = exeHit.value; command = found; }
  }

  // A model given as a file path also tells us where the models live.
  const modelDir = modelHit.value && looksLikeModelFile(modelHit.value)
    ? path.dirname(path.resolve(modelHit.value))
    : null;
  // …and so does the binary, when it was given as a path. Resolved from the
  // final command, so a folder that resolved into `Release/whisper-cli.exe`
  // finds `Release/models` — the layout every prebuilt release ships.
  const besideBinary = command.includes('/') || command.includes('\\')
    ? path.join(path.dirname(path.resolve(command)), 'models')
    : null;

  let resolvedDir = dirHit.value;
  let resolvedDirSource = dirHit.source;
  if (!resolvedDir && modelDir) [resolvedDir, resolvedDirSource] = [modelDir, `beside ${WHISPER_ENV.model[0]}`];
  if (!resolvedDir && besideBinary) [resolvedDir, resolvedDirSource] = [besideBinary, 'beside the binary'];

  const parsedThreads = threadHit.value === null ? null : Number.parseInt(String(threadHit.value), 10);
  return {
    command,
    commandSource,
    // Set when the configured value was a folder we looked inside — the UI
    // shows it so "I typed a folder and it works" is visible, not magic.
    commandFolder,
    modelsDir: resolvedDir ?? defaultModelsDir(),
    modelsDirSource: resolvedDirSource ?? 'bundled',
    model: modelHit.value,
    modelSource: modelHit.source,
    threads: Number.isInteger(parsedThreads) && parsedThreads > 0 ? parsedThreads : null,
    threadsSource: Number.isInteger(parsedThreads) && parsedThreads > 0 ? threadHit.source : null,
    language: langHit.value,
    languageSource: langHit.source,
  };
}

/* --------------------------------- models --------------------------------- */

/**
 * The models in `dir`: every `ggml-*.bin`, largest last. Unlike Piper's voices
 * there is no sidecar to validate against, so size is the only honest thing we
 * can report about a file we have not loaded.
 */
export async function listWhisperModels(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const models = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^ggml-.*\.bin$/i.test(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const st = await fsp.stat(abs).catch(() => null);
    models.push({
      name: modelNameFromFile(entry.name),
      path: abs,
      bytes: st?.size ?? null,
      // ".en" models are English-only and noticeably better at English than the
      // multilingual model of the same size; worth showing in a picker.
      englishOnly: /\.en$/i.test(modelNameFromFile(entry.name)),
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** The install sentence, in one place — a missing model is the common failure. */
export function whisperSetupHint(resolved) {
  return 'Install whisper.cpp (a prebuilt release, or `cmake --build`), point ' +
    `${WHISPER_ENV.bin[0]} at its whisper-cli executable (or at the folder holding it), ` +
    'and put at least one ggml model ' +
    `(e.g. ggml-small.en.bin from huggingface.co/ggerganov/whisper.cpp) in ${resolved?.modelsDir ?? 'the models folder'} ` +
    `— or name the file directly with ${WHISPER_ENV.model[0]}. Models sitting beside the binary in a "models" ` +
    'folder are found automatically.';
}

/**
 * Resolve the requested model against what is on disk. An unknown name is a hard
 * error with suggestions — never a silent substitution, the same rule every
 * speech vendor follows for voices.
 */
export function pickWhisperModel(requested, models, resolved = null) {
  const want = typeof requested === 'string' ? requested.trim() : '';
  // An explicit path is honoured even when the folder scan found nothing (a
  // model file outside any models dir is a perfectly normal setup).
  if (want && looksLikeModelFile(want)) {
    const abs = path.resolve(want);
    const hit = models.find((m) => m.path.toLowerCase() === abs.toLowerCase());
    return hit ?? { name: modelNameFromFile(abs), path: abs, bytes: null, englishOnly: /\.en$/i.test(modelNameFromFile(abs)) };
  }
  if (!models.length) {
    throw new EngineError(
      ErrorCodes.TRANSCRIPTION_UNAVAILABLE,
      `No whisper.cpp models found in ${resolved?.modelsDir ?? 'the configured folder'}. ${whisperSetupHint(resolved)}`,
      { vendor: 'whisper-cpp', modelsDir: resolved?.modelsDir ?? null },
    );
  }
  if (!want) {
    for (const name of MODEL_PREFERENCE) {
      const hit = models.find((m) => m.name.toLowerCase() === name);
      if (hit) return hit;
    }
    return models[0];
  }
  const hit = models.find((m) => m.name.toLowerCase() === want.toLowerCase());
  if (hit) return hit;
  throw new EngineError(
    ErrorCodes.INVALID_CONFIG,
    `whisper.cpp has no model named "${requested}" in ${resolved?.modelsDir ?? 'the configured folder'}. ` +
      `Installed: ${models.map((m) => m.name).join(', ')}.`,
    { vendor: 'whisper-cpp', model: requested, suggestions: models.map((m) => m.name) },
  );
}

/* ------------------------------- invocation -------------------------------- */

/**
 * Run whisper-cli once, buffering stdout and tailing stderr. Resolves for any
 * exit code; rejects on start failure, timeout or abort.
 *
 * A `.js`/`.mjs` target is spawned through the current node binary — Windows
 * cannot execute a script directly (EFTYPE), and it lets the tests inject a stub
 * without a 466 MB model download. Same rule as core/tts.js and tts-piper.js.
 */
function execWhisper(command, args, { timeoutMs, signal }) {
  const isScript = /\.[mc]?js$/i.test(command);
  const bin = isScript ? process.execPath : command;
  const argv = isScript ? [command, ...args] : args;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineError(ErrorCodes.CANCELLED, 'transcription cancelled before start'));
      return;
    }
    let proc;
    try {
      proc = spawn(bin, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new EngineError(ErrorCodes.TRANSCRIPTION_UNAVAILABLE, `Could not start whisper.cpp: ${e.message}`, {
        vendor: 'whisper-cpp', command,
      }));
      return;
    }
    let stdout = '';
    const stderrTail = [];
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    const onAbort = () => { aborted = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => {
      stderrTail.push(...d.toString('utf8').split('\n').filter(Boolean));
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const missing = e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EISDIR';
      // A folder that exists but holds no whisper binary is a different
      // mistake from a path that is not there at all, and saying "not found"
      // for the folder you are looking straight at reads as a bug.
      const dir = isDirectory(command);
      reject(new EngineError(
        missing ? ErrorCodes.TRANSCRIPTION_UNAVAILABLE : ErrorCodes.TRANSCRIPTION_FAILED,
        missing
          ? (dir
            ? `"${command}" is a folder, and no whisper binary (${WHISPER_BINARY_NAMES.join(' / ')}) `
              + `was found in it or in its ${WHISPER_BIN_SUBDIRS.filter(Boolean).join(' / ')} subfolders. `
              + 'Point the executable setting at the folder that holds whisper-cli, or at the file itself.'
            : `whisper.cpp not found (tried "${command}"). Set ${WHISPER_ENV.bin[0]} to the whisper-cli `
              + 'executable, or to the folder holding it.')
          : `whisper.cpp failed to start: ${e.message}`,
        { vendor: 'whisper-cpp', command, enoent: missing, isDirectory: dir },
      ));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new EngineError(ErrorCodes.CANCELLED, 'transcription cancelled'));
        return;
      }
      if (timedOut) {
        reject(new EngineError(
          ErrorCodes.TRANSCRIPTION_FAILED,
          `whisper.cpp timed out after ${Math.round(timeoutMs / 1000)}s`,
          { vendor: 'whisper-cpp', timeoutMs },
        ));
        return;
      }
      resolve({ code, stdout, stderr: stderrTail.join('\n') });
    });
  });
}

/* --------------------------------- probing -------------------------------- */

/**
 * Probe: can whisper.cpp run, and is there a model to run it with? Never throws
 * — same contract as every other vendor's check, because "not set up" is data.
 *
 * @returns {Promise<{available: boolean, models?: string[], modelDetails?: object[],
 *                    error?: string, config: object}>}
 */
export async function checkWhisperTranscription({ timeoutMs = 20_000, ...opts } = {}) {
  const resolved = resolveWhisper(opts);
  const config = {
    command: resolved.command,
    commandSource: resolved.commandSource,
    commandFolder: resolved.commandFolder,
    modelsDir: resolved.modelsDir,
    modelsDirSource: resolved.modelsDirSource,
    model: resolved.model,
    modelSource: resolved.modelSource,
    threads: resolved.threads,
    threadsSource: resolved.threadsSource,
    language: resolved.language,
  };
  try {
    // `--help` exits 0 and touches no model, so this answers "is the binary
    // runnable" without a multi-hundred-MB load.
    const { code, stderr } = await execWhisper(resolved.command, ['--help'], { timeoutMs });
    if (code !== 0) {
      return {
        available: false,
        error: `whisper-cli --help exited with code ${code}${stderr ? `: ${stderr.split('\n').slice(-2).join(' ')}` : ''}`,
        config,
      };
    }
  } catch (err) {
    return { available: false, error: err.message, code: err.code, config };
  }

  const models = await listWhisperModels(resolved.modelsDir);
  let chosen = null;
  try {
    chosen = pickWhisperModel(resolved.model, models, resolved);
  } catch (err) {
    return { available: false, error: err.message, code: err.code, config: { ...config, modelCount: models.length } };
  }
  // A named-by-path model that is not on disk: runnable binary, unusable setup.
  if (!(await fsp.stat(chosen.path).catch(() => null))) {
    return {
      available: false,
      error: `The configured whisper model "${chosen.path}" does not exist. ${whisperSetupHint(resolved)}`,
      config: { ...config, modelCount: models.length },
    };
  }
  return {
    available: true,
    models: models.map((m) => m.name),
    modelDetails: models,
    config: {
      ...config,
      modelCount: models.length,
      activeModel: chosen.name,
      activeModelPath: chosen.path,
      activeModelBytes: chosen.bytes,
    },
  };
}

/* ------------------------------ transcription ------------------------------ */

/** whisper.cpp emits specials like `[_BEG_]` / `[_TT_280]` in the token array. */
const isSpecialToken = (text) => /^\s*\[_.*_?\]\s*$/.test(text ?? '');

/**
 * Normalize one `-ojf` document into the shape core/transcribe.js derives from:
 * milliseconds, real tokens only, and nothing vendor-specific left in it.
 *
 * Exported for the tests, which drive it from the verbatim sample in
 * the transcribe-asset design record (git history; see docs/plans/completed.md).
 */
export function normalizeWhisperJson(doc) {
  const windows = Array.isArray(doc?.transcription) ? doc.transcription : [];
  const segments = [];
  const tokens = [];
  for (const w of windows) {
    const startMs = Number(w?.offsets?.from ?? 0);
    const endMs = Number(w?.offsets?.to ?? startMs);
    segments.push({ text: String(w?.text ?? ''), startMs, endMs });
    for (const t of Array.isArray(w.tokens) ? w.tokens : []) {
      if (isSpecialToken(t?.text)) continue;
      const from = Number(t?.offsets?.from);
      const to = Number(t?.offsets?.to);
      if (!Number.isFinite(from)) continue;
      tokens.push({
        text: String(t.text ?? ''),
        startMs: from,
        // Zero-width tokens are common (a token whose from === to); the caller
        // widens them against the following token rather than reporting a word
        // with no duration.
        endMs: Number.isFinite(to) && to >= from ? to : from,
        p: typeof t.p === 'number' ? t.p : null,
      });
    }
  }
  return {
    language: doc?.result?.language ?? doc?.params?.language ?? null,
    modelType: doc?.model?.type ?? null,
    multilingual: doc?.model?.multilingual ?? null,
    segments,
    tokens,
  };
}

/**
 * Transcribe a **16 kHz mono PCM WAV** with whisper.cpp.
 *
 * Takes a conforming WAV rather than arbitrary media on purpose: the resampling
 * belongs to the engine (one ffmpeg invocation, one place, one error code) and
 * this module stays a thin, testable wrapper over one CLI contract.
 *
 * @returns {Promise<{vendor, model, modelPath, language, requestedLanguage,
 *                    threads, segments, tokens, elapsedMs, raw}>}
 * @throws EngineError TRANSCRIPTION_UNAVAILABLE / TRANSCRIPTION_FAILED / INVALID_CONFIG / CANCELLED
 */
export async function transcribeWithWhisper({
  wavPath, model, language, threads, exe, modelsDir, whisper = {}, env,
  timeoutMs = 600_000, signal,
}) {
  const resolved = resolveWhisper({ exe, model, modelsDir, threads, language, whisper, env });
  const models = await listWhisperModels(resolved.modelsDir);
  const chosen = pickWhisperModel(resolved.model, models, resolved);
  const lang = resolved.language || 'auto';

  // whisper.cpp accepts `-l ja` with an `.en` model, but the result is a
  // well-formed English hallucination rather than a usable transcript. Refuse
  // before spawning so callers cannot mistake its timings for real speech.
  if (chosen.englishOnly && !['auto', 'en'].includes(String(lang).toLowerCase())) {
    throw new EngineError(
      ErrorCodes.TRANSCRIPTION_LANGUAGE_UNSUPPORTED,
      `Model "${chosen.name}" is English-only and cannot transcribe "${lang}". ` +
        'Install and select a multilingual ggml model (for example, ggml-small.bin).',
      {
        model: chosen.name,
        requestedLanguage: lang,
        multilingualModels: models.filter((candidate) => !candidate.englishOnly).map((candidate) => candidate.name),
      },
    );
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-whisper-'));
  const prefix = path.join(dir, 'transcript');
  const started = Date.now();
  try {
    const args = [
      '-m', chosen.path,
      '-f', wavPath,
      '-l', lang,
      // The tokens are the whole point — see the module header.
      '-ojf',
      '-of', prefix,
      // Progress chatter on stdout would be indistinguishable from output.
      '-np',
    ];
    if (resolved.threads) args.push('-t', String(resolved.threads));

    const { code, stderr } = await execWhisper(resolved.command, args, { timeoutMs, signal });
    if (code !== 0) {
      throw new EngineError(
        ErrorCodes.TRANSCRIPTION_FAILED,
        `whisper.cpp exited with code ${code}${stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''}`,
        { vendor: 'whisper-cpp', model: chosen.name, exitCode: code, stderrTail: stderr },
      );
    }
    let doc;
    try {
      doc = JSON.parse(await fsp.readFile(`${prefix}.json`, 'utf8'));
    } catch (e) {
      throw new EngineError(
        ErrorCodes.TRANSCRIPTION_FAILED,
        `whisper.cpp reported success but wrote no usable JSON (${e.message}). ` +
          'This build may predate --output-json-full.',
        { vendor: 'whisper-cpp', model: chosen.name, stderrTail: stderr },
      );
    }
    const norm = normalizeWhisperJson(doc);
    return {
      vendor: 'whisper-cpp',
      model: chosen.name,
      modelPath: chosen.path,
      // What whisper decided it heard, which with `-l auto` is the answer the
      // caller actually wanted; `requestedLanguage` keeps what we asked for.
      language: norm.language ?? (lang === 'auto' ? null : lang),
      requestedLanguage: lang,
      threads: resolved.threads,
      segments: norm.segments,
      tokens: norm.tokens,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
