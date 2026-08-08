/**
 * Picture facts for a still image (v0.27) — the questions a composition can
 * never ask about an asset it is about to place, answered before a render
 * instead of by rendering and squinting.
 *
 * This is the surviving half of the retired `prepare_image` plan
 * ([docs/plans/retired.md]). That plan died because its picture *operations*
 * needed a Python/Pillow dependency the generative boundary forbids. The
 * measurement half needs nothing new: ffprobe already reports width, height
 * and pixel format for a still (ffprobe reads a PNG as a one-frame video
 * stream), and everything else here is one raw-frame decode plus arithmetic
 * over a Uint8Array — the same shape `render-review.js` already uses to
 * measure a delivered file, and the same shape `audio-cues.js` uses for sound.
 *
 * It is kept deliberately small, and it is worth saying where the line is:
 * **this module reads pictures and never changes one.** The moment it grows a
 * crop, a key or an encode it is the retired plan again, dependency and all.
 * A composition can already style an image in CSS at render time; what it
 * cannot do is ask a question about one first.
 */

import { EngineError, ErrorCodes } from './errors.js';
import { ffmpegCapture } from './encoder.js';

/** Longest edge of the analysis sample. Precision of the reported box is one part in this. */
export const SAMPLE_MAX_EDGE = 256;

/** Extensions ffmpeg reads as a single picture rather than a moving one. */
const STILL_EXTENSIONS = /\.(png|jpe?g|webp|bmp|tiff?|gif|avif|heic)$/i;

/**
 * Is this asset a STILL? Extension first, then the probe as the arbiter: a
 * `.gif` is a still by name and an animation by content, and an animated one
 * must not be described by whichever frame ffmpeg happened to decode first.
 *
 * Deliberately conservative — an unknown shape is not a still. The cost of a
 * false yes is a confident measurement of one arbitrary frame; the cost of a
 * false no is an absent field that `measure_render` already covers.
 */
export function isStillImage(filePath, media) {
  if (!STILL_EXTENSIONS.test(String(filePath ?? ''))) return false;
  if (!media?.video) return false;
  if (media.hasAudio) return false;
  const frames = media.video.frames;
  return frames === null || frames === undefined || frames <= 1;
}

/** A pixel counts as content when it differs from the background by more than this (0..255). */
export const CONTENT_THRESHOLD = 12;

/** Alpha at or below this is transparent, for images that carry an alpha channel. */
export const ALPHA_THRESHOLD = 16;

/**
 * Does this pixel format DECLARE alpha? Anchored at the start of the name and
 * spelled out, because the tempting compact pattern is wrong in a way that
 * passes review: `a?rgba?` also matches plain `rgb24`, and every RGB still on
 * the machine would report a transparency it does not have.
 *
 * This is the *declared* answer. `isTransparent` in the sample below is the
 * *measured* one, and where they disagree the measurement wins — a `pal8` PNG
 * carries its transparency in the palette and is reported here as no alpha,
 * while the decode sees it correctly.
 */
export function alphaFromPixFmt(pixFmt) {
  if (!pixFmt || typeof pixFmt !== 'string') return null; // unknown, never a guess
  return /^(rgba|bgra|argb|abgr|ayuv|yuva|gbrap|ya\d)/.test(pixFmt.toLowerCase());
}

/** The sample grid for an image, preserving aspect and never enlarging. */
export function sampleSizeFor(width, height, maxEdge = SAMPLE_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Rec.709 luminance of an 8-bit RGB triple, 0..1 — the weighting the eye uses. */
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Everything derivable from one RGBA sample. Pure: bytes in, facts out, no
 * ffmpeg — so the interesting cases (a transparent overlay, a photo on white,
 * a flat card) are unit-testable with a hand-built buffer.
 *
 * Two content rules, chosen by what the image actually carries:
 *
 * - **Alpha, when the image has any.** For a transparent overlay "where is the
 *   content" has an exact answer and no threshold guessing is needed. This is
 *   the common Motion Studio case — alpha overlays are a first-class output.
 * - **Distance from the border colour otherwise.** The background of a supplier
 *   photo is whatever its edges are, which is white far more often than it is
 *   black; assuming either would put the box around the whole frame.
 *
 * @returns {{meanLuminance, isBlank, contentBox, hasAlpha, isTransparent}}
 */
export function measureRgbaSample(bytes, { width, height, threshold = CONTENT_THRESHOLD } = {}) {
  const px = width * height;
  if (!px || bytes.length < px * 4) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      `measureRgbaSample: expected ${px * 4} bytes for ${width}x${height}, got ${bytes.length}`);
  }

  let sum = 0;
  let sumSquares = 0;
  let minAlpha = 255;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const y = luma(bytes[o], bytes[o + 1], bytes[o + 2]);
    sum += y;
    sumSquares += y * y;
    if (bytes[o + 3] < minAlpha) minAlpha = bytes[o + 3];
  }
  const mean = sum / px;
  // Population standard deviation of luminance. Clamped at 0: floating-point
  // can make a perfectly flat image come out at -1e-17 under the root.
  const variance = Math.max(0, sumSquares / px - mean * mean);
  const stdDev = Math.sqrt(variance);

  const isTransparent = minAlpha < 255;
  const isContent = isTransparent
    ? (o) => bytes[o + 3] > ALPHA_THRESHOLD
    : (() => {
      // Border median, not a corner pixel and not an average: one dark corner
      // or a stray edge artefact must not become "the background".
      const edge = [];
      for (let x = 0; x < width; x++) {
        edge.push(bytes[(x) * 4], bytes[((height - 1) * width + x) * 4]);
      }
      for (let y = 0; y < height; y++) {
        edge.push(bytes[(y * width) * 4], bytes[(y * width + width - 1) * 4]);
      }
      edge.sort((a, b) => a - b);
      const bg = edge[Math.floor(edge.length / 2)];
      return (o) => Math.abs(bytes[o] - bg) > threshold
        || Math.abs(bytes[o + 1] - bg) > threshold
        || Math.abs(bytes[o + 2] - bg) > threshold;
    })();

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isContent((y * width + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return {
    meanLuminance: Number(mean.toFixed(4)),
    stdDev: Number(stdDev.toFixed(4)),
    // Flat in COLOUR, not merely in luminance: the sample is RGBA precisely so
    // that red-on-green at matching luminance is not reported as a blank card.
    isBlank: stdDev < 0.004 && !isTransparent,
    isTransparent,
    contentBox: maxX < 0
      ? null // nothing but background — a genuinely empty picture has no box
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/** Scale a sample-space box back to real pixels, clamped to the frame. */
export function scaleBox(box, { from, to }) {
  if (!box) return null;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const x = Math.max(0, Math.floor(box.x * sx));
  const y = Math.max(0, Math.floor(box.y * sy));
  return {
    x,
    y,
    width: Math.min(to.width - x, Math.max(1, Math.round(box.width * sx))),
    height: Math.min(to.height - y, Math.max(1, Math.round(box.height * sy))),
  };
}

/**
 * Measure a still image: one decode, bounded output, no temp file.
 *
 * `width`/`height` come from the caller's existing probe rather than being
 * re-read here — `probe_asset` has already run ffprobe by the time it asks —
 * and they are what makes the decode parseable: the sample grid is computed,
 * not discovered, so the raw buffer's length is known exactly.
 *
 * Returns null when the decode produces nothing usable, mirroring
 * `probeMedia` and the audio measurements: unknown is a value, never an error.
 * A picture measurement must not fail a probe that otherwise worked.
 */
export async function measurePictureFacts({
  filePath, width, height, pixFmt, ffmpegPath = 'ffmpeg', maxEdge = SAMPLE_MAX_EDGE, signal, onSpawn,
}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const sample = sampleSizeFor(width, height, maxEdge);
  const expected = sample.width * sample.height * 4;

  // rgba, not gray: alpha is the exact answer to "where is the content" for an
  // overlay, and colour is what keeps isBlank honest. It costs 4 bytes a pixel
  // over a 256-edge sample — a quarter of a megabyte at the very most.
  const raw = await ffmpegCapture({
    ffmpegPath,
    what: 'probe-asset picture facts',
    signal,
    onSpawn,
    maxBytes: expected * 2,
    args: [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-frames:v', '1', '-vf', `scale=${sample.width}:${sample.height},format=rgba`,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
    ],
  }).catch(() => null);
  if (!raw || raw.length < expected) return null;

  const m = measureRgbaSample(raw.subarray(0, expected), sample);
  return {
    width,
    height,
    hasAlpha: alphaFromPixFmt(pixFmt),
    meanLuminance: m.meanLuminance,
    isBlank: m.isBlank,
    isTransparent: m.isTransparent,
    contentBox: scaleBox(m.contentBox, { from: sample, to: { width, height } }),
    // State the grid the box was found on, because it bounds the answer's
    // precision: report by measuring, and say what the measurement could see.
    sampledAt: sample,
  };
}
