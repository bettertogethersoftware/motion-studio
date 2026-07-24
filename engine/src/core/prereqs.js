/**
 * Prerequisite detection: Node.js and FFmpeg on PATH.
 *
 * Minimum supported versions (spec §9 open question, resolved here):
 *   Node.js >= 18.0.0  — first LTS with stable fetch/AbortSignal.timeout and
 *                        the process APIs the engine relies on.
 *   FFmpeg  >= 5.0     — concat demuxer + libx264 flags used here are stable
 *                        from 5.x; 4.x mostly works but is not tested.
 *
 * (The v0.2 C# WinForms PrereqChecker that used to mirror these floors was
 * removed in v0.5 when the desktop shell was replaced by the Studio web UI —
 * see docs/CHANGELOG.md. The optional text-to-speech exe (v0.6) does not
 * participate in these checks; it has its own probe in core/tts.js.)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const MIN_NODE = [18, 0, 0];
export const MIN_FFMPEG = [5, 0];

function cmpVersion(actual, min) {
  for (let i = 0; i < min.length; i++) {
    const a = actual[i] ?? 0;
    if (a > min[i]) return 1;
    if (a < min[i]) return -1;
  }
  return 0;
}

export function parseNodeVersion(stdout) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

export function parseFfmpegVersion(stdout) {
  // "ffmpeg version 6.1.1-3ubuntu5 ..." — also tolerate git builds like
  // "ffmpeg version n7.0-19-g0f1a" by extracting the first numeric pair.
  const m = /ffmpeg version [^\d]*(\d+)\.(\d+)/.exec(stdout);
  return m ? [+m[1], +m[2]] : null;
}

/**
 * @returns {Promise<{ok: boolean, node: object, ffmpeg: object}>}
 * Each of node/ffmpeg: { found, version?, meetsMinimum?, error? }
 */
export async function checkPrerequisites({ ffmpegPath = 'ffmpeg' } = {}) {
  const node = { found: true, version: process.versions.node };
  node.meetsMinimum = cmpVersion(parseNodeVersion(process.versions.node), MIN_NODE) >= 0;

  let ffmpeg;
  try {
    const { stdout } = await execFileP(ffmpegPath, ['-version'], { timeout: 10_000 });
    const ver = parseFfmpegVersion(stdout);
    ffmpeg = {
      found: true,
      version: ver ? ver.join('.') : 'unknown',
      meetsMinimum: ver ? cmpVersion(ver, MIN_FFMPEG) >= 0 : true, // unknown builds: assume ok, fail later loudly
    };
  } catch (err) {
    ffmpeg = { found: false, error: err.code === 'ENOENT' ? 'ffmpeg not found on PATH' : String(err.message) };
  }

  return {
    ok: node.found && node.meetsMinimum && ffmpeg.found && ffmpeg.meetsMinimum !== false,
    node,
    ffmpeg,
  };
}
