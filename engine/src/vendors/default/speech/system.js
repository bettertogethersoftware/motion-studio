/**
 * Text-to-speech (narration) support — added in v0.6.
 *
 * Motion Studio does not synthesize speech itself: narration is produced by an
 * external, self-contained Windows console executable (built separately) that
 * this module spawns, exactly the way core/encoder.js spawns FFmpeg. The engine
 * stays cross-platform for everything except this optional feature, which is
 * Windows-only because it drives the OS speech voices.
 *
 * The exe contract (stable — the external tool must match it):
 *
 *   MotionStudioTts.exe --text-file <utf8 path> --out <abs .wav path> \
 *                       --voice "<name>" [--rate N] [--volume N]
 *   MotionStudioTts.exe --list-voices
 *
 *   success: exit 0, writes a PCM WAV to --out, prints ONE JSON line to stdout:
 *     { "ok": true, "voice", "durationSeconds", "sampleRate", "channels",
 *       "bytes", "outPath" }
 *     (--list-voices prints a JSON array of installed voice names instead)
 *   failure: non-zero exit, prints { "ok": false, "error": "...", "code": "..." }
 *
 * Node re-derives the authoritative clip duration from the WAV header
 * (wavDurationSeconds) because that is exactly what FFmpeg later muxes; the
 * exe's self-reported durationSeconds is kept only as reportedDurationSeconds.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from '../../../core/errors.js';
import { vendorDir } from '../../../core/paths.js';

const STDERR_TAIL_LINES = 40;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The zero-byte per-platform default (Slice 0, decided in the vendor-boundary
 * plan §10): the vendor id stays `system`, and the "exe" it spawns is chosen
 * per platform. On Windows the bundled MotionStudioTts.exe keeps priority
 * when present (back-compat: existing installs keep their exact voices);
 * otherwise a small Node backend drives the OS's own synthesis through the
 * same CLI contract — System.Speech via PowerShell, `say`, or espeak-ng.
 * Nothing is downloaded for any of them; quality is scratch-narration by
 * design and the documented upgrades are piper or a cloud vendor.
 * A function, not a constant: the vendor dir is configurable (v0.25).
 */
const defaultTtsExe = () => {
  if (process.platform === 'win32') {
    const bundled = path.join(vendorDir(), 'tts', 'MotionStudioTts.exe');
    if (fs.existsSync(bundled)) return bundled;
    return path.join(MODULE_DIR, 'system-tts', 'windows-sapi.mjs');
  }
  if (process.platform === 'darwin') return path.join(MODULE_DIR, 'system-tts', 'macos-say.mjs');
  return path.join(MODULE_DIR, 'system-tts', 'linux-espeak.mjs');
};

/**
 * Resolve the TTS executable path. Mirrors the ffmpegPath / browser-module DI
 * pattern: an explicit argument wins, then the MOTION_STUDIO_TTS_EXE env var,
 * then a bundled default. A `.js`/`.mjs`/`.cjs` target is treated as a Node
 * script (spawned through the current node binary) so tests can inject a stub
 * without a compiled binary.
 */
export function resolveTtsExe(explicit) {
  return explicit || process.env.MOTION_STUDIO_TTS_EXE || defaultTtsExe();
}

/**
 * The same resolution, but reporting which layer won — mirrors
 * resolveFfmpegPath()'s {path, source} so the Studio's vendors page can say
 * "not found at <path> (from env)" instead of an anonymous failure.
 *
 * @returns {{path: string, source: 'argument'|'env'|'bundled'|'os'}}
 */
export function resolveTtsExeInfo(explicit) {
  if (explicit) return { path: explicit, source: 'argument' };
  const env = process.env.MOTION_STUDIO_TTS_EXE?.trim();
  if (env) return { path: env, source: 'env' };
  const p = defaultTtsExe();
  // 'bundled' = the shipped Windows exe; 'os' = the per-platform zero-byte
  // backend (Slice 0) driving the operating system's own synthesis.
  return { path: p, source: p.endsWith('.mjs') ? 'os' : 'bundled' };
}

function spawnArgs(exe, ttsArgs) {
  if (/\.[mc]?js$/i.test(exe)) return { command: process.execPath, argv: [exe, ...ttsArgs] };
  return { command: exe, argv: ttsArgs };
}

/**
 * Low-level: run the exe, buffer stdout, tail stderr. Resolves with
 * { code, signal, stdout, stderr } for ANY exit code; rejects only when the
 * process cannot be started (ENOENT etc.) or the timeout fires.
 */
function execTts(exe, ttsArgs, { timeoutMs }) {
  const { command, argv } = spawnArgs(exe, ttsArgs);
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new EngineError(ErrorCodes.TTS_UNAVAILABLE, `Could not start speech engine: ${e.message}`, { exe }));
      return;
    }
    let stdout = '';
    const stderrTail = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => {
      stderrTail.push(...d.toString('utf8').split('\n').filter(Boolean));
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      const unavailable = e.code === 'ENOENT';
      reject(new EngineError(
        unavailable ? ErrorCodes.TTS_UNAVAILABLE : ErrorCodes.TTS_FAILED,
        unavailable ? `Speech engine not found at "${exe}"` : `Speech engine failed to start: ${e.message}`,
        { exe },
      ));
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new EngineError(ErrorCodes.TTS_FAILED, `Speech synthesis timed out after ${timeoutMs}ms`, { exe }));
        return;
      }
      resolve({ code, signal, stdout, stderr: stderrTail.join('\n') });
    });
  });
}

/** Parse the last non-empty stdout line as JSON, or null. */
function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning up */ }
  }
  return null;
}

/**
 * Synthesize `text` to a WAV at `outPath` using the external exe.
 * @returns the parsed success payload: { ok, voice, durationSeconds, sampleRate, channels, bytes, outPath }
 * @throws EngineError with TTS_UNAVAILABLE / UNSUPPORTED_VOICE / TTS_FAILED.
 */
export async function synthesizeSpeech({ text, outPath, voice, rate, volume, ttsExe, timeoutMs = 60_000 }) {
  const exe = resolveTtsExe(ttsExe);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-tts-'));
  const textFile = path.join(dir, 'narration.txt');
  try {
    await fsp.writeFile(textFile, text, 'utf8');
    const args = ['--text-file', textFile, '--out', outPath];
    if (voice) args.push('--voice', voice);
    if (rate !== undefined) args.push('--rate', String(rate));
    if (volume !== undefined) args.push('--volume', String(volume));

    const { code, stdout, stderr } = await execTts(exe, args, { timeoutMs });
    const parsed = lastJsonLine(stdout);

    if (code === 0 && parsed && parsed.ok === true) return parsed;

    // Failure: prefer the exe's structured { ok:false, code, error }.
    const exeCode = parsed && parsed.ok === false ? parsed.code : undefined;
    const message = (parsed && parsed.error) || stderr || `speech engine exited with code ${code}`;
    if (exeCode === 'unsupported_voice') {
      throw new EngineError(ErrorCodes.UNSUPPORTED_VOICE, message, { voice, code: exeCode });
    }
    throw new EngineError(ErrorCodes.TTS_FAILED, message, { code: exeCode, exitCode: code, stderrTail: stderr });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Probe the exe by asking it for the installed voices. Never throws — returns
 * { available, voices?, error? } so the tool layer can surface tts_unavailable
 * with a helpful hint while the rest of the engine keeps working.
 */
export async function checkTts({ ttsExe, timeoutMs = 10_000 } = {}) {
  const exe = resolveTtsExe(ttsExe);
  try {
    const { code, stdout, stderr } = await execTts(exe, ['--list-voices'], { timeoutMs });
    if (code !== 0) return { available: false, error: stderr || `--list-voices exited with code ${code}` };
    const parsed = lastJsonLine(stdout);
    if (!Array.isArray(parsed)) return { available: false, error: 'unexpected --list-voices output (not a JSON array)' };
    return { available: true, voices: parsed };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Generic WAV/audio utilities moved to core/audio.js (Slice A).       */
/* Re-exported here so existing imports keep working; new code should  */
/* import from '../../../core/audio.js' directly.                                  */
/* ------------------------------------------------------------------ */
export {
  wavDurationSeconds, parseWavHeader, framesForDuration, splitSentences,
  concatWavBuffers, pcmToWavBuffer, measureWavLevels, measureWavEnvelope,
} from '../../../core/audio.js';
