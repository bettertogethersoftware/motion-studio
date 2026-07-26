/**
 * Music vendor "node" — the whole pipeline in-process (v0.17).
 *
 * v0.8's music path spawns two external programs: a C# exe (DryWetMIDI) to turn
 * the note spec into a .mid, then fluidsynth.exe to render that against a
 * SoundFont. That works, but it is Windows-only, needs ~74 MB of binaries a
 * fresh clone has to build or download, and costs two process spawns per cue.
 *
 * This module does both stages in Node with `spessasynth_core` (Apache-2.0, no
 * transitive dependencies): MIDIBuilder writes the MIDI, SpessaSynthProcessor
 * renders it against the *same* SoundFont file the fluidsynth vendor uses. Same
 * spec in, same kind of PCM WAV out — measured at ~45× realtime versus ~11× for
 * the spawned chain, on any OS.
 *
 * Two things this deliberately does differently from the library's defaults:
 *
 *   - `audioToWav` normalizes to full scale unless told not to. Narration and
 *     music are mixed at fixed gains later, so a bed that silently arrives at
 *     0 dBFS every time would make every balance decision a fiction. We render
 *     honest levels and then attenuate (never boost) toward `targetPeakDb`,
 *     the same rule core/sfx.js follows.
 *   - The library is imported *dynamically*, so a missing or unloadable package
 *     degrades to `music_unavailable` like every other optional piece of the
 *     toolchain instead of taking the engine down at import time.
 */

import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';
import { resolveSoundFont } from './music.js';

/** Ticks per quarter note in the MIDI we author. 480 is the DAW convention. */
const PPQ = 480;

/** Seconds of silence rendered past the last note-off, for release + reverb tails. */
const TAIL_SECONDS = 3;

/** Render granularity. Matches the block size the library's own examples use. */
const BLOCK = 128;

export const MUSIC_NODE_DEFAULTS = Object.freeze({
  sampleRate: 44100,
  /**
   * Calibrated, not guessed. The two synths scale their master gain
   * differently: rendering one identical spec through both, fluidsynth at its
   * `-g 0.7` peaks at −9.1 dBFS while spessasynth at 0.7 peaks at −16.1 dBFS —
   * 7 dB quieter. Gain here is exactly linear (0.7 → −16.14, 1.0 → −13.04,
   * 1.575 → −9.10), so 1.575 is the value that makes a bed land at the same
   * loudness whichever vendor rendered it. Changing vendors must not silently
   * re-balance a film's mix against its narration.
   */
  gain: 1.575,
});

/** A runaway agent should hit a clear error, not a 40-minute render. */
export const MAX_NOTES = 20_000;
export const MAX_MELODIC_TRACKS = 15; // 16 MIDI channels less the drum channel

let libPromise = null;

/**
 * Load spessasynth_core once. Failure is `music_unavailable` rather than a
 * crash: an engine whose npm install is incomplete should still render video.
 */
async function lib() {
  if (!libPromise) {
    libPromise = import('spessasynth_core').catch((err) => {
      libPromise = null; // don't cache the failure — a repaired install should work
      throw new EngineError(
        ErrorCodes.MUSIC_UNAVAILABLE,
        `the "node" music vendor needs the spessasynth_core package: ${err.message}. ` +
          'Run `npm install` in engine/, or switch the music vendor to "fluidsynth".',
        { vendor: 'node' },
      );
    });
  }
  return libPromise;
}

/* -------------------------------- the spec -------------------------------- */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

/**
 * Validate the note spec documented in docs/music-setup.md and return it
 * normalized (defaults filled in). Only the `node` vendor runs this — the
 * fluidsynth vendor keeps relying on the exe's own validation, so adding this
 * cannot change what that path accepts.
 *
 * @throws EngineError INVALID_MUSIC_SPEC with `detail.problems`
 */
export function validateMusicSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') {
    throw new EngineError(ErrorCodes.INVALID_MUSIC_SPEC, 'spec must be an object', { problems: ['spec: object required'] });
  }
  const bpm = spec.bpm ?? 120;
  if (!isNum(bpm) || bpm < 1 || bpm > 400) problems.push('bpm: number in 1..400 required');
  if (!Array.isArray(spec.tracks) || spec.tracks.length === 0) problems.push('tracks: non-empty array required');

  const tracks = [];
  let noteCount = 0;
  let melodic = 0;

  (Array.isArray(spec.tracks) ? spec.tracks : []).forEach((track, ti) => {
    const where = `tracks[${ti}]`;
    if (!track || typeof track !== 'object') { problems.push(`${where}: object required`); return; }
    const drums = track.drums === true;
    if (!drums) melodic++;
    const program = track.program ?? 0;
    if (!drums && (!isInt(program) || program < 0 || program > 127)) problems.push(`${where}.program: integer 0..127 required`);
    if (!Array.isArray(track.notes) || track.notes.length === 0) { problems.push(`${where}.notes: non-empty array required`); return; }

    const notes = [];
    track.notes.forEach((n, ni) => {
      const w = `${where}.notes[${ni}]`;
      if (!n || typeof n !== 'object') { problems.push(`${w}: object required`); return; }
      if (!isInt(n.pitch) || n.pitch < 0 || n.pitch > 127) problems.push(`${w}.pitch: integer 0..127 required`);
      if (!isNum(n.start) || n.start < 0) problems.push(`${w}.start: number >= 0 (beats) required`);
      if (!isNum(n.duration) || n.duration <= 0) problems.push(`${w}.duration: number > 0 (beats) required`);
      const velocity = n.velocity ?? 96;
      if (!isInt(velocity) || velocity < 1 || velocity > 127) problems.push(`${w}.velocity: integer 1..127 required`);
      notes.push({ pitch: n.pitch, start: n.start, duration: n.duration, velocity });
      noteCount++;
    });
    tracks.push({ drums, program: drums ? 0 : program, notes });
  });

  if (noteCount > MAX_NOTES) problems.push(`too many notes (${noteCount} > ${MAX_NOTES})`);
  if (melodic > MAX_MELODIC_TRACKS) {
    problems.push(`too many melodic tracks (${melodic} > ${MAX_MELODIC_TRACKS}; MIDI has 15 non-drum channels)`);
  }
  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_MUSIC_SPEC, `Invalid music spec: ${problems.slice(0, 6).join('; ')}`, { problems });
  }
  return { bpm, tracks, noteCount };
}

/**
 * Note spec → an in-memory MIDI file. Tracks take consecutive MIDI channels,
 * skipping channel 9 (GM percussion), which is where every `drums: true` track
 * goes — the same channel assignment the C# exe does, so a spec sounds like
 * itself whichever vendor renders it.
 */
export async function specToMidi(spec) {
  const { MIDIBuilder } = await lib();
  const { bpm, tracks, noteCount } = validateMusicSpec(spec);

  const midi = new MIDIBuilder({ timeDivision: PPQ, format: 1, initialTempo: bpm, name: 'motion-studio' });
  midi.setTempo(0, bpm);

  let nextChannel = 0;
  tracks.forEach((track, i) => {
    midi.addTrack(`track-${i + 1}`);
    const trackIndex = i + 1; // track 0 is the conductor/tempo track
    let channel;
    if (track.drums) {
      channel = 9;
    } else {
      if (nextChannel === 9) nextChannel++;
      channel = nextChannel++;
      midi.addEvent(0, trackIndex, 0xc0 | channel, [track.program]);
    }
    for (const n of track.notes) {
      const on = Math.round(n.start * PPQ);
      const off = Math.max(on + 1, Math.round((n.start + n.duration) * PPQ));
      midi.addEvent(on, trackIndex, 0x90 | channel, [n.pitch, n.velocity]);
      midi.addEvent(off, trackIndex, 0x80 | channel, [n.pitch, 0]);
    }
  });
  midi.flush();

  return { midi, bpm, tracks: tracks.length, notes: noteCount, musicalDurationSeconds: midi.duration };
}

/* ------------------------------- the render ------------------------------- */

/** Read a file as an ArrayBuffer that owns exactly its own bytes. */
async function readArrayBuffer(file) {
  const buf = await fsp.readFile(file);
  // Node pools small Buffers into a shared ArrayBuffer, so `.buffer` alone can
  // hand the parser a window onto unrelated memory. Slice to this file's bytes.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Largest absolute sample across all channels. */
export function peakOf(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

export const dbToAmp = (db) => 10 ** (db / 20);
export const ampToDb = (amp) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);

/**
 * Probe: is this vendor usable right now? Never throws.
 * @returns {{available: boolean, error?: string, config: object}}
 */
export async function checkNodeMusic({ soundfont } = {}) {
  const sf = resolveSoundFont(soundfont);
  const config = { soundfont: sf, library: 'spessasynth_core' };
  try {
    await lib();
  } catch (err) {
    return { available: false, error: err.message, config };
  }
  try {
    await fsp.access(sf);
  } catch {
    return {
      available: false,
      error: `SoundFont not found: ${sf}. Set MOTION_STUDIO_SOUNDFONT (or the soundfont path on the Studio's ` +
        'music page) to any General MIDI .sf2/.sf3 file.',
      config,
    };
  }
  return { available: true, config };
}

/**
 * Render `spec` to a PCM WAV at `outPath`.
 *
 * The WAV runs past the last note by TAIL_SECONDS so release and reverb are not
 * chopped — which is why `musicalDurationSeconds` (the notes) and the WAV's own
 * duration differ, exactly as with the fluidsynth vendor. Callers keep taking
 * the authoritative duration from the WAV header.
 *
 * @returns {{tracks, notes, bpm, musicalDurationSeconds, sampleRate, peakDb, gainAppliedDb, outPath}}
 */
export async function synthesizeNodeMusic({
  spec, outPath, soundfont, sampleRate = MUSIC_NODE_DEFAULTS.sampleRate,
  gain = MUSIC_NODE_DEFAULTS.gain, targetPeakDb = null,
}) {
  const { SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer, audioToWav } = await lib();
  const sf = resolveSoundFont(soundfont);

  const { midi, bpm, tracks, notes, musicalDurationSeconds } = await specToMidi(spec);

  let bank;
  try {
    bank = SoundBankLoader.fromArrayBuffer(await readArrayBuffer(sf));
  } catch (err) {
    throw new EngineError(
      ErrorCodes.MUSIC_UNAVAILABLE,
      `could not read the SoundFont "${sf}": ${err.message}`,
      { vendor: 'node', soundfont: sf },
    );
  }

  const synth = new SpessaSynthProcessor(sampleRate, { enableEventSystem: false });
  synth.soundBankManager.addSoundBank(bank, 'main');
  await synth.processorInitialized;
  synth.setSystemParameter('gain', gain);

  const sequencer = new SpessaSynthSequencer(synth);
  sequencer.loadNewSongList([midi]);
  sequencer.loop = false;
  sequencer.skipToFirstNoteOn = false; // a spec that starts on beat 2 keeps its rest
  sequencer.currentTime = 0;
  sequencer.play();

  const seconds = Math.ceil(musicalDurationSeconds) + TAIL_SECONDS;
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  try {
    for (let i = 0; i < frames; i += BLOCK) {
      const n = Math.min(BLOCK, frames - i);
      sequencer.processTick();
      synth.process(left, right, i, n);
    }
  } catch (err) {
    throw new EngineError(ErrorCodes.MUSIC_FAILED, `synthesis failed: ${err.message}`, { vendor: 'node' });
  }

  // Attenuate-only toward the target: a quiet arrangement stays quiet (the
  // agent asked for quiet), a hot one is brought down. Never a boost, so the
  // reported peak is always the truth about what was rendered.
  const rawPeak = peakOf([left, right]);
  let gainAppliedDb = 0;
  if (targetPeakDb !== null && rawPeak > 0) {
    const ceiling = dbToAmp(targetPeakDb);
    if (rawPeak > ceiling) {
      const scale = ceiling / rawPeak;
      for (let i = 0; i < frames; i++) { left[i] *= scale; right[i] *= scale; }
      gainAppliedDb = ampToDb(scale);
    }
  }

  const wav = audioToWav([left, right], sampleRate, { normalizeAudio: false });
  await fsp.writeFile(outPath, Buffer.from(wav));

  return {
    tracks,
    notes,
    bpm,
    musicalDurationSeconds,
    sampleRate,
    channels: 2,
    peakDb: Number(ampToDb(peakOf([left, right])).toFixed(2)),
    rawPeakDb: Number(ampToDb(rawPeak).toFixed(2)),
    gainAppliedDb: Number(gainAppliedDb.toFixed(2)),
    soundfont: sf,
    outPath,
  };
}
