/**
 * Music generation (v0.8) — the LLM→MIDI→FluidSynth→WAV pipeline.
 *
 *   note spec (from the agent)
 *     → MotionStudioMidi.exe (DryWetMIDI)  → song.mid
 *     → FluidSynth + a General MIDI SoundFont → WAV
 *     → a config.audio track, mixed by the same muxAudio pass as narration.
 *
 * Windows-only, optional. Three external pieces, each resolvable by env var with
 * a vendored default under engine/vendor/ (git-ignored):
 *   MOTION_STUDIO_MIDI_EXE     MotionStudioMidi.exe   (music/MotionStudioMidi)
 *   MOTION_STUDIO_FLUIDSYNTH   fluidsynth.exe         (provided binary)
 *   MOTION_STUDIO_SOUNDFONT    a .sf2/.sf3 SoundFont  (MuseScore_General.sf3)
 * See docs/music-setup.md.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, ErrorCodes } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(__dirname, '../../vendor');
const STDERR_TAIL = 40;

export function resolveMidiExe(explicit) {
  return explicit || process.env.MOTION_STUDIO_MIDI_EXE || path.join(VENDOR, 'music', 'MotionStudioMidi.exe');
}
export function resolveFluidSynth(explicit) {
  return explicit || process.env.MOTION_STUDIO_FLUIDSYNTH || path.join(VENDOR, 'fluidsynth', 'bin', 'fluidsynth.exe');
}
export function resolveSoundFont(explicit) {
  return explicit || process.env.MOTION_STUDIO_SOUNDFONT || path.join(VENDOR, 'soundfonts', 'MuseScore_General.sf3');
}

// A `.js`/`.mjs` target is treated as a Node script (spawned via node) so tests
// can inject a stub without a compiled binary.
function spawnArgs(exe, args) {
  if (/\.[mc]?js$/i.test(exe)) return { command: process.execPath, argv: [exe, ...args] };
  return { command: exe, argv: args };
}

function execProc(exe, argv, { timeoutMs, failCode }) {
  const { command, argv: full } = spawnArgs(exe, argv);
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(command, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new EngineError(ErrorCodes.MUSIC_UNAVAILABLE, `could not start ${path.basename(exe)}: ${e.message}`, { exe })); return; }
    let stdout = '';
    const tail = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { tail.push(...d.toString('utf8').split('\n').filter(Boolean)); if (tail.length > STDERR_TAIL) tail.splice(0, tail.length - STDERR_TAIL); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      const missing = e.code === 'ENOENT';
      reject(new EngineError(missing ? ErrorCodes.MUSIC_UNAVAILABLE : failCode, missing ? `not found: ${exe}` : `${path.basename(exe)} failed to start: ${e.message}`, { exe }));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new EngineError(failCode, `${path.basename(exe)} timed out after ${timeoutMs}ms`, { exe })); return; }
      resolve({ code, stdout, stderr: tail.join('\n') });
    });
  });
}

function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep scanning */ } }
  return null;
}

/** Probe that the three pieces exist. Never throws — returns { available, error? }. */
export async function checkMusic({ midiExe, fluidsynth, soundfont } = {}) {
  const parts = { 'MIDI exe': resolveMidiExe(midiExe), fluidsynth: resolveFluidSynth(fluidsynth), soundfont: resolveSoundFont(soundfont) };
  const missing = Object.entries(parts).filter(([, p]) => !fs.existsSync(p)).map(([k, p]) => `${k} (${p})`);
  if (missing.length) return { available: false, error: `missing: ${missing.join('; ')}` };
  return { available: true };
}

/**
 * Compose `spec` to a WAV at `outPath` (spec → MIDI → FluidSynth). Returns the
 * MIDI exe's metadata ({ tracks, notes, bpm, musicalDurationSeconds }). The WAV
 * is longer than musicalDurationSeconds by FluidSynth's reverb/release tail — the
 * engine derives the authoritative audio duration from the WAV header.
 */
export async function synthesizeMusic({ spec, outPath, midiExe, fluidsynth, soundfont, sampleRate = 44100, timeoutMs = 60_000 }) {
  const exe = resolveMidiExe(midiExe), fsy = resolveFluidSynth(fluidsynth), sf = resolveSoundFont(soundfont);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-music-'));
  const specFile = path.join(dir, 'spec.json');
  const midFile = path.join(dir, 'song.mid');
  try {
    await fsp.writeFile(specFile, JSON.stringify(spec), 'utf8');

    // 1) note spec → MIDI (DryWetMIDI)
    const midi = await execProc(exe, ['--spec-file', specFile, '--out', midFile], { timeoutMs, failCode: ErrorCodes.MUSIC_FAILED });
    const parsed = lastJsonLine(midi.stdout);
    if (midi.code !== 0 || !parsed || parsed.ok !== true) {
      const code = parsed && parsed.ok === false ? parsed.code : undefined;
      throw new EngineError(
        code === 'invalid_music_spec' ? ErrorCodes.INVALID_MUSIC_SPEC : ErrorCodes.MUSIC_FAILED,
        (parsed && parsed.error) || midi.stderr || `MIDI exe exited with code ${midi.code}`,
        { code, stderrTail: midi.stderr },
      );
    }

    // 2) MIDI → WAV (FluidSynth + SoundFont)
    const wav = await execProc(fsy, ['-ni', '-T', 'wav', '-F', outPath, '-r', String(sampleRate), '-g', '0.7', sf, midFile], { timeoutMs, failCode: ErrorCodes.MUSIC_FAILED });
    if (wav.code !== 0) throw new EngineError(ErrorCodes.MUSIC_FAILED, `fluidsynth exited with code ${wav.code}: ${wav.stderr}`, { stderrTail: wav.stderr });
    if (!fs.existsSync(outPath)) throw new EngineError(ErrorCodes.MUSIC_FAILED, 'fluidsynth reported success but wrote no audio', { outPath });

    return {
      tracks: parsed.tracks,
      notes: parsed.notes,
      bpm: parsed.bpm,
      musicalDurationSeconds: parsed.durationSeconds,
      sampleRate,
      outPath,
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
