/**
 * Music vendors — dispatch for the note-spec → audio pipeline (v0.17;
 * catalog-driven since Slice A — see createMusicDispatch below).
 *
 *   node        core/music-node.js   spessasynth_core, in-process, any OS
 *   fluidsynth  core/music.js        the v0.8 chain: C# MIDI exe + fluidsynth.exe
 *
 * Both take the same spec (docs/music-setup.md) and the same SoundFont, and
 * both return a PCM WAV plus the same metadata, so `synthesize_music` needs no
 * per-vendor branching. `node` is the default: it is the only one that works
 * off Windows, needs no binaries a fresh clone has to build, and renders ~4×
 * faster. There is no silent fallback between them — see core/vendors.js.
 *
 * Level parity is enforced here rather than left to each engine. Every render
 * is measured, and `targetPeakDb` attenuates (never boosts) a hot one, which is
 * the rule core/sfx.js already uses. Together with the calibrated per-vendor
 * gain in core/music-node.js, that means swapping vendors does not re-balance a
 * film's music against its narration.
 */

import fsp from 'node:fs/promises';
import { readStoredSettings, readSettings, MUSIC_VENDORS } from './settings.js';
import { defaultDataDir } from './scene.js';
import { resolveVendorFrom, walkVendorChain, unavailableError, buildReport } from './vendors.js';
import { EngineError, ErrorCodes } from './errors.js';
import { parseWavHeader } from './audio.js'; // the engine's one WAV header reader
import {
  checkMusic, synthesizeMusic, resolveMidiExe, resolveFluidSynth, resolveSoundFont,
} from './music.js';
import {
  checkNodeMusic, synthesizeNodeMusic, validateMusicSpec, MUSIC_NODE_DEFAULTS, ampToDb, dbToAmp,
} from './music-node.js';

export { MUSIC_VENDORS };
export const DEFAULT_MUSIC_VENDOR = 'node';

export const MUSIC_VENDOR_INFO = Object.freeze({
  node: Object.freeze({
    id: 'node',
    label: 'Node synthesizer',
    summary: 'spessasynth_core rendering a General MIDI SoundFont in-process. Cross-platform, no binaries to build, ~45× realtime.',
    requires: 'a .sf2/.sf3 SoundFont (MOTION_STUDIO_SOUNDFONT, or the bundled default)',
    offline: true,
  }),
  fluidsynth: Object.freeze({
    id: 'fluidsynth',
    label: 'FluidSynth (external)',
    summary: 'The v0.8 chain: MotionStudioMidi.exe authors the MIDI, fluidsynth.exe renders it. Windows-only, ~74 MB of binaries.',
    requires: 'MOTION_STUDIO_MIDI_EXE + MOTION_STUDIO_FLUIDSYNTH + MOTION_STUDIO_SOUNDFONT',
    offline: true,
  }),
});

/**
 * General MIDI instrument names, indexed by `program`. Exposed so the Studio's
 * vendors page can offer a real instrument picker (and so anyone authoring a
 * spec can see what program 48 actually is) instead of asking people to
 * memorize a numbering from 1991.
 */
export const GM_PROGRAMS = Object.freeze([
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
]);

/**
 * The phrase the Studio's "listen" button renders: two bars of arpeggio over a
 * bass note, long enough to judge an instrument's attack and tail, short enough
 * that auditioning is instant. Kept here so the page, the tests, and anyone
 * debugging a vendor all hear the identical thing.
 */
export function demoSpec({ program = 0, drums = false, bpm = 100 } = {}) {
  const lead = [0, 4, 7, 12, 7, 4].map((semi, i) => ({
    pitch: (drums ? 36 : 60) + (drums ? [0, 6, 2, 6, 0, 6][i] : semi),
    start: i * 0.5,
    duration: drums ? 0.25 : 0.5,
    velocity: 100 - i * 4,
  }));
  const tail = drums ? [] : [{ pitch: 72, start: 3, duration: 1.5, velocity: 96 }];
  const tracks = [{ ...(drums ? { drums: true } : { program }), notes: [...lead, ...tail] }];
  if (!drums) tracks.push({ program: 32, notes: [{ pitch: 36, start: 0, duration: 3 }, { pitch: 41, start: 3, duration: 1.5 }] });
  return { bpm, tracks };
}

/**
 * The default music catalog: one entry per vendor. Same contract as the
 * speech catalog (core/tts-vendors.js): info card, probe, fix sentence,
 * synthesize — vendor knowledge lives only here, dispatch is generic, and
 * Phase 2 moves this to vendors/default/.
 */
export function defaultMusicCatalog() {
  return Object.freeze({
    node: {
      id: 'node',
      info: MUSIC_VENDOR_INFO.node,
      async probe({ section = {} } = {}) {
        const probe = await checkNodeMusic({ soundfont: section.node?.soundfont ?? undefined });
        return {
          available: probe.available,
          error: probe.error,
          config: {
            ...probe.config,
            sampleRate: section.node?.sampleRate ?? MUSIC_NODE_DEFAULTS.sampleRate,
            gain: section.node?.gain ?? MUSIC_NODE_DEFAULTS.gain,
          },
        };
      },
      fix: () => 'Run "npm run fetch-soundfont" in engine/ (or point MOTION_STUDIO_SOUNDFONT at a General MIDI ' +
        ".sf2/.sf3 file, or set it on the Studio's music page), and make sure `npm install` has run in engine/.",
      async synthesize({ spec, outPath, sampleRate, gain }, { section, target }) {
        const result = await synthesizeNodeMusic({
          spec,
          outPath,
          soundfont: section.node?.soundfont ?? undefined,
          sampleRate: sampleRate ?? section.node?.sampleRate ?? MUSIC_NODE_DEFAULTS.sampleRate,
          gain: gain ?? section.node?.gain ?? MUSIC_NODE_DEFAULTS.gain,
          targetPeakDb: target,
        });
        return { ...result, vendor: 'node' };
      },
    },
    fluidsynth: {
      id: 'fluidsynth',
      info: MUSIC_VENDOR_INFO.fluidsynth,
      async probe({ section = {} } = {}) {
        const probe = await checkMusic({ soundfont: section.node?.soundfont ?? undefined });
        return {
          available: probe.available,
          error: probe.error,
          config: {
            midiExe: resolveMidiExe(),
            fluidsynth: resolveFluidSynth(),
            soundfont: resolveSoundFont(section.node?.soundfont ?? undefined),
          },
        };
      },
      fix: () => 'Build MotionStudioMidi.exe and install fluidsynth.exe + a SoundFont (see docs/music-setup.md), ' +
        'or switch the music vendor to "node".',
      async synthesize({ spec, outPath, sampleRate, timeoutMs }, { section, target }) {
        // The exe chain validates the spec itself, but running the shared
        // validator first means both vendors reject the same bad spec with
        // the same message instead of one failing at a process boundary.
        validateMusicSpec(spec);
        const result = await synthesizeMusic({
          spec,
          outPath,
          soundfont: section.node?.soundfont ?? undefined,
          ...(sampleRate ? { sampleRate } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        const level = await conformWavLevel(outPath, target);
        return {
          ...result,
          ...level,
          channels: 2,
          soundfont: resolveSoundFont(section.node?.soundfont ?? undefined),
          vendor: 'fluidsynth',
        };
      },
    },
  });
}

/** Build the music dispatch surface over a catalog (Slice A; the §10.6 seam). */
export function createMusicDispatch(catalog) {
  const ids = Object.freeze(Object.keys(catalog));
  const entry = (v) => catalog[v];

  /** settings.music, tolerating a missing/older settings file. */
  async function musicSettings(dataDir, settings) {
    if (settings) return settings.music ?? {};
    const s = await readSettings(dataDir ?? defaultDataDir()).catch(() => null);
    return s?.music ?? {};
  }

  async function resolveMusicVendor({ vendor, dataDir, settings, probe = false } = {}) {
    const stored = settings
      ? settings.music
      : (await readStoredSettings(dataDir ?? defaultDataDir()).catch(() => null))?.music;
    const resolved = resolveVendorFrom('music', {
      vendor,
      storedVendor: stored?.vendor,
      storedVendors: stored?.vendors,
      allowed: ids,
      fallback: DEFAULT_MUSIC_VENDOR,
    });
    if (!probe) return resolved;
    return walkVendorChain(resolved, (id) => checkMusicVendor(id, { dataDir, settings }));
  }

  async function checkMusicVendor(vendor, { dataDir, settings } = {}) {
    if (!ids.includes(vendor)) {
      throw new EngineError(
        ErrorCodes.INVALID_CONFIG,
        `Unknown music vendor "${vendor}" — expected one of: ${ids.join(', ')}`,
        { vendor, allowed: ids },
      );
    }
    const section = await musicSettings(dataDir, settings);
    const status = await entry(vendor).probe({ section });
    return { vendor, ...status };
  }

  /** The vendors that *are* usable, so a failure can point somewhere useful. */
  async function availableAlternatives(failing, opts) {
    const others = [];
    for (const id of ids) {
      if (id === failing) continue;
      const probe = await checkMusicVendor(id, opts).catch(() => null);
      if (probe?.available) others.push(id);
    }
    return others;
  }

  function musicUnavailable(vendor, status, alternatives = []) {
    return unavailableError('music', vendor, status, { fix: entry(vendor).fix(status), alternatives });
  }

  async function musicUnavailableWithAlternatives(vendor, status, opts = {}) {
    return musicUnavailable(vendor, status, await availableAlternatives(vendor, opts));
  }

  /** Full status of every music vendor — backs the Studio page and list_vendors. */
  async function musicVendorReport({ dataDir, settings, probe = true } = {}) {
    const music = await musicSettings(dataDir, settings);
    // No probe on resolution: every vendor is probed below for its card, and
    // the chain walk is done from those results rather than paying twice.
    const resolved = await resolveMusicVendor({ dataDir, settings });
    const chain = resolved.chain;
    const vendors = [];
    for (const id of ids) {
      const info = entry(id).info;
      const priority = chain.includes(id) ? chain.indexOf(id) + 1 : null;
      if (!probe) {
        vendors.push({ ...info, active: id === resolved.vendor, priority, available: null });
        continue;
      }
      const status = await checkMusicVendor(id, { dataDir, settings });
      vendors.push({
        ...info,
        priority,
        available: status.available,
        error: status.error ?? null,
        config: status.config,
      });
    }
    const usable = probe ? chain.find((id) => vendors.find((v) => v.id === id)?.available) : null;
    const active = usable ?? resolved.vendor;
    for (const v of vendors) v.active = v.id === active;
    return buildReport({ capability: 'music', active, activeSource: resolved.source, chain, settings: music, vendors });
  }

  async function synthesizeMusicWithVendor({
    vendor, spec, outPath, dataDir, settings, sampleRate, gain, targetPeakDb, timeoutMs,
    resolved: preResolved,
  }) {
    const resolved = preResolved ?? await resolveMusicVendor({ vendor, dataDir, settings, probe: true });
    const section = await musicSettings(dataDir, settings);
    const target = targetPeakDb === undefined ? (section.targetPeakDb ?? null) : targetPeakDb;

    const status = resolved.status ?? await checkMusicVendor(resolved.vendor, { dataDir, settings });
    if (!status.available) throw await musicUnavailableWithAlternatives(resolved.vendor, status, { dataDir, settings });

    const result = await entry(resolved.vendor).synthesize(
      { spec, outPath, sampleRate, gain, timeoutMs },
      { section, target },
    );
    return { ...result, vendorSource: resolved.source, targetPeakDb: target };
  }

  return {
    ids, catalog,
    resolveMusicVendor, checkMusicVendor, musicVendorReport,
    musicUnavailable, musicUnavailableWithAlternatives, synthesizeMusicWithVendor,
  };
}

/* ------------------------------------------------------------------ */
/* Default-bound surface — the public API, unchanged for callers.      */
/* Phase 4 constructs dispatches from the injected registry instead.   */
/* ------------------------------------------------------------------ */

const defaultDispatch = createMusicDispatch(defaultMusicCatalog());
export const resolveMusicVendor = defaultDispatch.resolveMusicVendor;
export const checkMusicVendor = defaultDispatch.checkMusicVendor;
export const musicVendorReport = defaultDispatch.musicVendorReport;
export const musicUnavailable = defaultDispatch.musicUnavailable;
export const musicUnavailableWithAlternatives = defaultDispatch.musicUnavailableWithAlternatives;
export const synthesizeMusicWithVendor = defaultDispatch.synthesizeMusicWithVendor;

/* ------------------------------ level control ----------------------------- */

/**
 * Measure a 16-bit PCM WAV's peak and, if it exceeds the target, scale the file
 * down in place. Used for the fluidsynth vendor, whose renderer writes the file
 * itself; the node vendor does the same arithmetic on its float buffers before
 * writing. Attenuate-only, so the number reported is always the truth about
 * what is on disk.
 *
 * @returns {{peakDb: number|null, rawPeakDb: number|null, gainAppliedDb: number}}
 */
export async function conformWavLevel(file, targetPeakDb) {
  const buf = await fsp.readFile(file);
  const info = parseWavHeader(buf, file);
  if (info.bitsPerSample !== 16 || info.dataOffset === undefined) {
    // Not something we can rescale safely — report nothing rather than guess.
    return { peakDb: null, rawPeakDb: null, gainAppliedDb: 0 };
  }
  const start = info.dataOffset;
  const end = start + info.dataSize - (info.dataSize % 2);

  let peak = 0;
  for (let i = start; i + 1 < end; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  const rawPeak = peak / 32768;
  const rawPeakDb = Number(ampToDb(rawPeak).toFixed(2));
  if (targetPeakDb === null || targetPeakDb === undefined || rawPeak === 0) {
    return { peakDb: rawPeakDb, rawPeakDb, gainAppliedDb: 0 };
  }
  const ceiling = dbToAmp(targetPeakDb);
  if (rawPeak <= ceiling) return { peakDb: rawPeakDb, rawPeakDb, gainAppliedDb: 0 };

  const scale = ceiling / rawPeak;
  for (let i = start; i + 1 < end; i += 2) {
    // Round toward zero and clamp: a scaled-down sample can never overflow, but
    // rounding it into 32768 would wrap to full-scale negative.
    const v = Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * scale)));
    buf.writeInt16LE(v, i);
  }
  await fsp.writeFile(file, buf);
  return {
    peakDb: Number(ampToDb(rawPeak * scale).toFixed(2)),
    rawPeakDb,
    gainAppliedDb: Number(ampToDb(scale).toFixed(2)),
  };
}

