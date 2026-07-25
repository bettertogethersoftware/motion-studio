/**
 * Text-to-speech (narration) support — added in v0.6.
 *
 * Motion Studio does not synthesize speech itself: narration is produced by an
 * external, self-contained Windows console executable (built separately) that
 * this module spawns, exactly the way core/encoder.js spawns FFmpeg. The engine
 * stays cross-platform for everything except this optional feature, which is
 * Windows-only because it drives the OS speech voices.
 *
 * The exe contract (stable — the external project must match it):
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
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STDERR_TAIL_LINES = 40;

/** Path to the bundled default exe (may not exist — checkTts reports that). */
const DEFAULT_TTS_EXE = path.resolve(__dirname, '../../vendor/tts/MotionStudioTts.exe');

/**
 * Resolve the TTS executable path. Mirrors the ffmpegPath / browser-module DI
 * pattern: an explicit argument wins, then the MOTION_STUDIO_TTS_EXE env var,
 * then a bundled default. A `.js`/`.mjs`/`.cjs` target is treated as a Node
 * script (spawned through the current node binary) so tests can inject a stub
 * without a compiled binary.
 */
export function resolveTtsExe(explicit) {
  return explicit || process.env.MOTION_STUDIO_TTS_EXE || DEFAULT_TTS_EXE;
}

/**
 * The same resolution, but reporting which layer won — mirrors
 * resolveFfmpegPath()'s {path, source} so the Studio's vendors page can say
 * "not found at <path> (from env)" instead of an anonymous failure.
 *
 * @returns {{path: string, source: 'argument'|'env'|'bundled'}}
 */
export function resolveTtsExeInfo(explicit) {
  if (explicit) return { path: explicit, source: 'argument' };
  const env = process.env.MOTION_STUDIO_TTS_EXE?.trim();
  if (env) return { path: env, source: 'env' };
  return { path: DEFAULT_TTS_EXE, source: 'bundled' };
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

/**
 * Duration (seconds) of a PCM WAV, parsed authoritatively from its RIFF header
 * with no external dependency. Walks the sub-chunks (honoring word-alignment
 * padding), reads `byteRate` from `fmt ` and the declared `data` size, and
 * returns dataSize / byteRate.
 */
export async function wavDurationSeconds(filePath) {
  const buf = await fsp.readFile(filePath);
  const info = parseWavHeader(buf, filePath);
  return info.dataSize / info.byteRate;
}

/** Parse fmt/data facts from a WAV buffer. Exported shape used by callers/tests. */
export function parseWavHeader(buf, filePath = '<buffer>') {
  const bad = (why) => new EngineError(ErrorCodes.TTS_FAILED, `Unreadable WAV (${filePath}): ${why}`);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw bad('missing RIFF/WAVE header');
  }
  let offset = 12;
  let byteRate, sampleRate, channels, bitsPerSample, dataSize, dataOffset;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // Declared size can exceed the actual file for streamed WAVs; clamp.
      dataSize = Math.min(size, Math.max(0, buf.length - body));
      dataOffset = body; // where the samples start — callers that rewrite levels need it
    }
    offset = body + size + (size & 1); // pad to even boundary
  }
  if (!byteRate) throw bad("no 'fmt ' chunk / zero byte-rate");
  if (dataSize === undefined) throw bad("no 'data' chunk");
  return { byteRate, sampleRate, channels, bitsPerSample, dataSize, dataOffset };
}

/** Frames a clip of `seconds` occupies at `fps` (rounded up so audio is never clipped short). */
export function framesForDuration(seconds, fps) {
  return Math.ceil(seconds * fps);
}
