/**
 * Output format registry (new in v0.5).
 *
 * One place that knows, per deliverable format:
 *   - the container extension
 *   - the FFmpeg encode arguments
 *   - whether an alpha channel survives (`supportsAlpha`)
 *   - whether the parallel renderer can concat segments losslessly with
 *     `-c copy` (`copyConcat`), or must go through a lossless FFV1
 *     intermediate + one final encode pass instead
 *
 * The rest of the engine never spells out codec flags; it asks this registry.
 * Adding a format = adding an entry here + a line in docs/architecture.md.
 */

import { EngineError, ErrorCodes } from './errors.js';

export const FORMATS = Object.freeze({
  mp4: {
    ext: '.mp4',
    label: 'MP4 (H.264)',
    supportsAlpha: false,
    copyConcat: true,
    requiresEvenDims: true,
    videoArgs({ crf = 18, preset = 'medium', pixFmt = 'yuv420p' }) {
      return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', pixFmt, '-movflags', '+faststart'];
    },
    audioArgs: () => ['-c:a', 'aac', '-b:a', '192k'],
  },

  webm: {
    ext: '.webm',
    label: 'WebM (VP9)',
    supportsAlpha: true,
    copyConcat: true,
    requiresEvenDims: true,
    videoArgs({ crf = 32, transparent = false }) {
      const args = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-row-mt', '1'];
      // Alpha in VP9 requires yuva420p and disabling alt-ref frames.
      args.push('-pix_fmt', transparent ? 'yuva420p' : 'yuv420p');
      if (transparent) args.push('-auto-alt-ref', '0');
      return args;
    },
    audioArgs: () => ['-c:a', 'libopus', '-b:a', '160k'],
  },

  gif: {
    ext: '.gif',
    label: 'Animated GIF',
    supportsAlpha: false, // 1-bit GIF transparency is not what "transparent" means here
    copyConcat: false, // palette differs per segment; must re-encode from lossless intermediate
    requiresEvenDims: false,
    videoArgs() {
      // Two-pass palette in a single command: palettegen buffers the input,
      // paletteuse maps it. Memory-proportional to clip length; fine for the
      // short clips GIF is for (docs/user-guide.md notes the trade-off).
      return [
        '-filter_complex',
        '[0:v]split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4',
      ];
    },
    audioArgs: null, // GIF has no audio; audio config is ignored with a warning
  },

  prores: {
    ext: '.mov',
    label: 'ProRes (QuickTime)',
    supportsAlpha: true,
    copyConcat: true,
    requiresEvenDims: true,
    videoArgs({ transparent = false }) {
      // 4444 (profile 4) when alpha is needed, otherwise 422 HQ (profile 3).
      return transparent
        ? ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0']
        : ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'];
    },
    audioArgs: () => ['-c:a', 'pcm_s16le'],
  },

  'png-sequence': {
    ext: '', // output is a directory of frame-%06d.png
    label: 'PNG sequence (folder of frames)',
    supportsAlpha: true,
    copyConcat: false,
    requiresEvenDims: false,
    videoArgs: null, // no encode step
    audioArgs: null,
  },
});

/**
 * Player-compatibility warnings for an output config (v0.22).
 *
 * mp4 + crf 0 is the known trap: libx264's CRF 0 means LOSSLESS, and the
 * H.264 spec puts lossless bitstreams in the "High 4:4:4 Predictive" profile
 * even at yuv420p. Most consumer decoders (Windows Movies & TV, phone/TV/GPU
 * hardware paths, browsers) cannot decode that profile — the file plays as
 * black video with working audio, which reads as "the render produced no
 * visuals" when the frames are all there. Happened with a real video;
 * ffmpeg/VLC decode it fine, which makes the confusion worse.
 *
 * Never fatal — crf 0 stays legal (the file is valid, and a lossless master
 * can be intentional). Same advisory contract as computeBalanceWarnings.
 */
export function encodingCompatibilityWarnings(output = {}) {
  const warnings = [];
  if ((output.format ?? 'mp4') === 'mp4' && output.crf === 0) {
    warnings.push(
      'mp4 with crf 0 encodes lossless H.264 ("High 4:4:4 Predictive" profile), which most players ' +
        '(Windows Movies & TV, phones, TVs, browsers) cannot decode — the file shows BLACK VIDEO with ' +
        'working audio. Use crf 18 for visually near-lossless mp4 that plays everywhere, or prores / ' +
        'png-sequence if you truly need lossless.',
    );
  }
  return warnings;
}

export function getFormat(name = 'mp4') {
  const fmt = FORMATS[name];
  if (!fmt) {
    throw new EngineError(
      ErrorCodes.UNSUPPORTED_FORMAT,
      `Unknown output format "${name}". Supported: ${Object.keys(FORMATS).join(', ')}`,
      { format: name, supported: Object.keys(FORMATS) },
    );
  }
  return fmt;
}

/**
 * Given an output config, return the filename with the extension the format
 * demands (replacing a mismatched one, e.g. legacy "output.mp4" + webm).
 */
export function normalizeOutputFilename(output) {
  const fmt = getFormat(output.format ?? 'mp4');
  const name = output.filename ?? 'output';
  if (output.format === 'png-sequence') {
    // Directory name: strip any extension.
    return name.replace(/\.[a-z0-9]+$/i, '') || 'frames';
  }
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  return base + fmt.ext;
}

/** Lossless intermediate used by the parallel path for non-copyConcat formats
 *  and for alpha-preserving segment storage. FFV1 in Matroska keeps RGBA. */
export const INTERMEDIATE = Object.freeze({
  ext: '.mkv',
  videoArgs: ({ transparent = false }) => [
    '-c:v', 'ffv1', '-level', '3',
    '-pix_fmt', transparent ? 'rgba' : 'rgb24',
  ],
});
