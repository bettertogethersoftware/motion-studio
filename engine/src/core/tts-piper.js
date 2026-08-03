/**
 * Piper — local neural narration (v0.18).
 *
 * The third speech vendor, and the one that splits the difference between the
 * other two: neural voice quality like Azure, but running entirely on this
 * machine like the Windows exe, with no account, no per-character billing, and
 * no network. https://github.com/OHF-Voice/piper1-gpl
 *
 * Piper is **GPLv3**, so it is spawned as a separate process and never bundled,
 * linked, or vendored into this MIT repository — the same arm's-length
 * arrangement the engine already has with FFmpeg and FluidSynth. Nothing here
 * downloads it either; the user installs it and points an env var at it.
 *
 * It ships as a Python wheel rather than a standalone binary (`pip install
 * piper-tts`), which installs both a `piper` console script and the
 * `python -m piper` module form. Both are supported:
 *
 *   MOTION_STUDIO_PIPER_EXE      an executable (…/Scripts/piper.exe), or
 *   MOTION_STUDIO_PIPER_PYTHON   a Python that has piper installed → `-m piper`
 *   (otherwise: `piper` on PATH)
 *
 * Voices are **files you download**, two per voice — `en_US-lessac-medium.onnx`
 * and its `.onnx.json` — from https://huggingface.co/rhasspy/piper-voices.
 * Point MOTION_STUDIO_PIPER_VOICES at the folder holding them; every `.onnx`
 * in it becomes a voice. Each voice carries its own licence (see its
 * MODEL_CARD), which is the user's business, not the engine's.
 *
 * Two behaviours worth knowing, both verified against the real CLI:
 *
 *   - Piper **normalizes to full scale unless told not to**. Narration is mixed
 *     against music at fixed gains later, so a line that silently arrives at
 *     0 dBFS every time would make every balance decision a fiction. We always
 *     pass --no-normalize and let the measured level be the truth.
 *   - Its inference is stochastic (noise_scale / noise_w), so the same text does
 *     *not* render byte-identically twice — and clip DURATION drifts ±2%
 *     run-to-run, which silently invalidates cue frames computed from a prior
 *     synthesis. That is why `deterministic: true` exists: it passes
 *     --noise-scale 0 --noise-w 0, pinning durations (Piper has no seed flag).
 *     The cost is slightly flatter prosody; the default remains stochastic.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineError, ErrorCodes } from './errors.js';
import { parseWavHeader } from './tts.js';
import { vendorDir } from './paths.js';

const STDERR_TAIL_LINES = 40;

/** Env hooks, in precedence order. Exported so the UI and docs list one truth. */
export const PIPER_ENV = Object.freeze({
  exe: Object.freeze(['MOTION_STUDIO_PIPER_EXE']),
  python: Object.freeze(['MOTION_STUDIO_PIPER_PYTHON']),
  voices: Object.freeze(['MOTION_STUDIO_PIPER_VOICES']),
});

/** Where voices live when nothing says otherwise (git-ignored, like the other vendored assets). */
const defaultVoicesDir = () => path.join(vendorDir(), 'piper', 'voices');

/**
 * Map the engine's −10..10 rate onto Piper's `--length-scale`, which is a
 * duration multiplier (1 = the voice's natural pace, 2 = half speed).
 *
 * The scale means the same thing it means for the Azure vendor — each step is
 * 10% of default speed — so a film can change vendors without re-timing
 * every line. Clamped because the arithmetic has a singularity at rate −10 and
 * nobody wants a ten-times-slower narrator by arithmetic accident.
 */
export function lengthScaleForRate(rate) {
  const speed = 1 + Math.max(-10, Math.min(10, Number(rate))) / 10;
  const scale = speed <= 0 ? 3 : 1 / speed;
  return Number(Math.max(0.4, Math.min(3, scale)).toFixed(4));
}

/**
 * Resolve how to run Piper, recording which layer won so the Studio can show
 * "piper.exe (from MOTION_STUDIO_PIPER_EXE)" rather than leaving the user to
 * guess.
 *
 * @returns {{command: string, argv: string[], source: string, voicesDir: string, voicesSource: string}}
 */
export function resolvePiper({ exe, python, voicesDir, piper = {}, env = process.env } = {}) {
  const pick = (explicit, names, setting) => {
    const e = typeof explicit === 'string' ? explicit.trim() : explicit;
    if (e) return { value: e, source: 'argument' };
    for (const name of names) {
      const v = env[name]?.trim();
      if (v) return { value: v, source: name };
    }
    const s = typeof setting === 'string' ? setting.trim() : setting;
    if (s) return { value: s, source: 'settings' };
    return { value: null, source: null };
  };

  const exeHit = pick(exe, PIPER_ENV.exe, piper.exe);
  const pyHit = pick(python, PIPER_ENV.python, piper.python);
  const voiceHit = pick(voicesDir, PIPER_ENV.voices, piper.voicesDir);

  let command;
  let argv;
  let source;
  if (exeHit.value) {
    command = exeHit.value;
    argv = [];
    source = exeHit.source;
  } else if (pyHit.value) {
    command = pyHit.value;
    argv = ['-m', 'piper'];
    source = pyHit.source;
  } else {
    command = 'piper';
    argv = [];
    source = 'PATH';
  }

  return {
    command,
    argv,
    source,
    voicesDir: voiceHit.value ?? defaultVoicesDir(),
    voicesSource: voiceHit.source ?? 'bundled',
  };
}

/**
 * The commands worth trying for a resolution, in order.
 *
 * On Windows, `pip install piper-tts` typically drops piper.exe into a Scripts
 * folder that is NOT on PATH — pip prints a warning saying exactly that, and
 * everyone ignores it. The *module* is still importable through whichever
 * Python is on PATH, so when nothing is configured and `piper` cannot be
 * found, fall back to `python -m piper`, then `py -m piper`. An explicitly
 * configured command never falls back: a user who named a binary means it.
 */
export function piperCandidates(resolved) {
  if (resolved.source !== 'PATH') return [resolved];
  return [
    resolved,
    { ...resolved, command: 'python', argv: ['-m', 'piper'], source: 'PATH (python -m piper)' },
    { ...resolved, command: 'py', argv: ['-m', 'piper'], source: 'PATH (py -m piper)' },
  ];
}

/**
 * Run one candidate, buffering stdout and tailing stderr. Resolves for any
 * exit code; rejects on start failure or timeout.
 *
 * A `.js`/`.mjs` target is spawned through the current node binary — Windows
 * cannot execute a script directly (EFTYPE), and it lets the tests inject a
 * stub without installing Python. Same rule as core/tts.js.
 */
function execOne(candidate, args, { timeoutMs }) {
  const isScript = /\.[mc]?js$/i.test(candidate.command);
  const command = isScript ? process.execPath : candidate.command;
  const prefix = isScript ? [candidate.command, ...candidate.argv] : candidate.argv;
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, [...prefix, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new EngineError(ErrorCodes.TTS_UNAVAILABLE, `Could not start Piper: ${e.message}`, { vendor: 'piper' }));
      return;
    }
    let stdout = '';
    const stderrTail = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => {
      stderrTail.push(...d.toString('utf8').split('\n').filter(Boolean));
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      const missing = e.code === 'ENOENT';
      reject(new EngineError(
        missing ? ErrorCodes.TTS_UNAVAILABLE : ErrorCodes.TTS_FAILED,
        missing
          ? `Piper not found (tried "${candidate.command}"). Install it with \`pip install piper-tts\` and set ` +
            `${PIPER_ENV.exe[0]} to the piper executable, or ${PIPER_ENV.python[0]} to a Python that has it.`
          : `Piper failed to start: ${e.message}`,
        { vendor: 'piper', command: candidate.command, enoent: missing },
      ));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new EngineError(ErrorCodes.TTS_FAILED, `Piper timed out after ${timeoutMs}ms`, { vendor: 'piper' }));
        return;
      }
      resolve({ code, stdout, stderr: stderrTail.join('\n') });
    });
  });
}

/**
 * Run piper, walking the candidate chain on "command not found" only. Returns
 * the result plus `used` — the candidate that actually answered — so the probe
 * can report `python -m piper (PATH)` rather than the `piper` that wasn't there.
 */
async function execPiper(resolved, args, opts) {
  const candidates = piperCandidates(resolved);
  for (const candidate of candidates) {
    try {
      return { ...(await execOne(candidate, args, opts)), used: candidate };
    } catch (err) {
      // Only a missing command moves on; a command that started and failed is
      // a real answer and must surface as-is. When every candidate is missing,
      // the loop falls through to the aggregate error below, which names them
      // all — more useful than "py not found" when the story is really "piper
      // is not on PATH".
      if (err?.detail?.enoent && candidates.length > 1) continue;
      throw err;
    }
  }
  const tried = candidates.map((c) => [c.command, ...c.argv].join(' '));
  throw new EngineError(
    ErrorCodes.TTS_UNAVAILABLE,
    `Piper not found (tried: ${tried.join(', ')}). Install it with \`pip install piper-tts\`. On Windows, pip ` +
      `usually puts piper.exe in a Scripts folder that is NOT on PATH (pip prints a warning saying so) — set ` +
      `${PIPER_ENV.exe[0]} to that piper.exe, or ${PIPER_ENV.python[0]} to the matching python.`,
    { vendor: 'piper', tried },
  );
}

/* --------------------------------- voices --------------------------------- */

/**
 * Turn `en_US-lessac-medium` into something a human can pick from. Piper's file
 * naming is `{locale}-{speaker}-{quality}`, and the sidecar JSON carries the
 * sample rate and speaker count, so the catalogue can look like Azure's without
 * inventing anything.
 */
export function describePiperVoice(name, config = null) {
  const [locale, speaker, quality] = name.split('-');
  const normalizedLocale = locale?.includes('_') ? locale.replace('_', '-') : locale ?? null;
  return {
    name,
    displayName: speaker ? `${speaker}${quality ? ` (${quality})` : ''}` : name,
    locale: config?.language?.code ? config.language.code.replace('_', '-') : normalizedLocale,
    localeName: config?.language
      ? [config.language.name_english, config.language.country_english].filter(Boolean).join(' — ')
      : null,
    gender: null, // Piper voice metadata does not carry one
    quality: quality ?? config?.audio?.quality ?? null,
    sampleRate: config?.audio?.sample_rate ?? null,
    speakers: config?.num_speakers ?? 1,
    styles: [], // no expressive styles; kept so every vendor's voice shape matches
  };
}

/**
 * The voices in `voicesDir`: every `.onnx` with its required `.onnx.json`
 * sidecar. A model missing its config is skipped rather than offered, because
 * Piper cannot load it and a voice you can select but not use is worse than one
 * that isn't listed.
 */
export async function listPiperVoices(voicesDir) {
  let entries;
  try {
    entries = await fsp.readdir(voicesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const voices = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.onnx')) continue;
    const modelPath = path.join(voicesDir, entry.name);
    const configPath = `${modelPath}.json`;
    let config = null;
    try {
      config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    } catch {
      continue; // no usable sidecar → not a usable voice
    }
    const name = entry.name.replace(/\.onnx$/, '');
    voices.push({ ...describePiperVoice(name, config), modelPath });
  }
  return voices.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the requested voice against what is on disk. An unknown voice is a
 * hard error with suggestions — never a silent substitution, the same rule the
 * other two vendors follow.
 */
export function pickPiperVoice(requested, voices) {
  if (!voices.length) {
    throw new EngineError(
      ErrorCodes.TTS_UNAVAILABLE,
      'No Piper voices found. Download a voice (an .onnx plus its .onnx.json) from ' +
        `https://huggingface.co/rhasspy/piper-voices and put both files in the folder named by ${PIPER_ENV.voices[0]}.`,
      { vendor: 'piper' },
    );
  }
  if (!requested) return voices[0];
  const want = requested.trim().toLowerCase();
  const hit = voices.find((v) => v.name.toLowerCase() === want)
    // A full path is accepted too — an agent that read the catalogue may echo it back.
    ?? voices.find((v) => v.modelPath.toLowerCase() === want);
  if (hit) return hit;
  throw new EngineError(
    ErrorCodes.UNSUPPORTED_VOICE,
    `Piper has no voice named "${requested}" in the configured folder. Call list_voices (vendor "piper") and pass ` +
      'a name verbatim, e.g. en_US-lessac-medium.',
    { vendor: 'piper', voice: requested, suggestions: voices.slice(0, 8).map((v) => v.name) },
  );
}

/* --------------------------------- probing -------------------------------- */

/**
 * Probe: can Piper run, and are there voices to run it with? Never throws —
 * same contract as the other vendors' checks.
 */
export async function checkPiperTts({ timeoutMs = 20_000, ...opts } = {}) {
  const resolved = resolvePiper(opts);
  const config = {
    command: [resolved.command, ...resolved.argv].join(' '),
    commandSource: resolved.source,
    voicesDir: resolved.voicesDir,
    voicesSource: resolved.voicesSource,
  };
  try {
    const { code, stderr, used } = await execPiper(resolved, ['--help'], { timeoutMs });
    // Report the candidate that answered — after a fallback that is
    // `python -m piper`, not the `piper` that wasn't on PATH.
    config.command = [used.command, ...used.argv].join(' ');
    config.commandSource = used.source;
    if (code !== 0) {
      return { available: false, error: `piper --help exited with code ${code}${stderr ? `: ${stderr}` : ''}`, config };
    }
  } catch (err) {
    return { available: false, error: err.message, code: err.code, config };
  }

  const voices = await listPiperVoices(resolved.voicesDir);
  if (!voices.length) {
    return {
      available: false,
      error: `Piper runs, but no voices were found in ${resolved.voicesDir}. Download a voice (.onnx + .onnx.json) ` +
        `from https://huggingface.co/rhasspy/piper-voices, or point ${PIPER_ENV.voices[0]} at the folder holding them.`,
      config,
    };
  }
  return {
    available: true,
    voices: voices.map((v) => v.name),
    voiceDetails: voices,
    config: { ...config, voiceCount: voices.length },
  };
}

/* -------------------------------- synthesis ------------------------------- */

/**
 * Synthesize `text` to a PCM WAV at `outPath` with Piper.
 *
 * Returns the same success payload shape the other speech vendors produce, so
 * callers need no per-vendor branching.
 *
 * @throws EngineError TTS_UNAVAILABLE / UNSUPPORTED_VOICE / TTS_FAILED
 */
export async function synthesizePiperSpeech({
  text, outPath, voice, rate, volume, speaker, sentenceSilence, deterministic,
  exe, python, voicesDir, piper = {}, env, timeoutMs = 120_000,
}) {
  const resolved = resolvePiper({ exe, python, voicesDir, piper, env });
  const voices = await listPiperVoices(resolved.voicesDir);
  const chosen = pickPiperVoice(voice ?? piper.voice ?? undefined, voices);

  // Text goes through a UTF-8 file, never argv — the same rule the Windows exe
  // vendor follows, so quotes / newlines / unicode in a script are safe.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-piper-'));
  const textFile = path.join(dir, 'narration.txt');
  try {
    await fsp.writeFile(textFile, text, 'utf8');
    const args = [
      '-m', chosen.modelPath,
      '-i', textFile,
      '-f', outPath,
      // Piper normalizes to full scale by default; that would erase every level
      // decision made downstream. See the module header.
      '--no-normalize',
    ];
    if (rate !== undefined && rate !== null) args.push('--length-scale', String(lengthScaleForRate(rate)));
    if (volume !== undefined && volume !== null) {
      args.push('--volume', String(Math.max(0, Math.min(100, Number(volume))) / 100));
    }
    if (speaker !== undefined && speaker !== null) args.push('-s', String(speaker));
    if (sentenceSilence !== undefined && sentenceSilence !== null) {
      args.push('--sentence-silence', String(sentenceSilence));
    }
    if (deterministic) {
      // VITS samples fresh noise per run (see the module header), which moves
      // phoneme durations ±2% between otherwise identical invocations. Zeroing
      // both noise sources pins the output so cue frames computed from one
      // synthesis stay valid for the next. Piper has no seed flag; this is the
      // only determinism lever its CLI offers. Slightly flatter prosody.
      args.push('--noise-scale', '0', '--noise-w', '0');
    }

    const { code, stderr } = await execPiper(resolved, args, { timeoutMs });
    if (code !== 0) {
      throw new EngineError(
        ErrorCodes.TTS_FAILED,
        `Piper exited with code ${code}${stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''}`,
        { vendor: 'piper', voice: chosen.name, exitCode: code, stderrTail: stderr },
      );
    }
    if (!fs.existsSync(outPath)) {
      throw new EngineError(ErrorCodes.TTS_FAILED, 'Piper reported success but wrote no audio', {
        vendor: 'piper', voice: chosen.name, outPath,
      });
    }

    const buf = await fsp.readFile(outPath);
    const info = parseWavHeader(buf, outPath);
    return {
      ok: true,
      vendor: 'piper',
      engine: 'piper',
      voice: chosen.name,
      locale: chosen.locale,
      quality: chosen.quality,
      durationSeconds: info.dataSize / info.byteRate,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bytes: buf.length,
      modelPath: chosen.modelPath,
      outPath,
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
