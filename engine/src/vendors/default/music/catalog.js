/**
 * The default music catalog (Slice A Phase 2) — see speech/catalog.js for
 * the pattern. conformWavLevel stays in core (generic level arithmetic);
 * the providers live beside this file.
 */

import {
  checkMusic, synthesizeMusic, resolveMidiExe, resolveFluidSynth, resolveSoundFont,
} from './fluidsynth.js';
import {
  checkNodeMusic, synthesizeNodeMusic, validateMusicSpec, MUSIC_NODE_DEFAULTS, ampToDb, dbToAmp,
} from './node.js';

import { conformWavLevel } from '../../../core/music-vendors.js';

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

