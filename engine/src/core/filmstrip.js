/**
 * Filmstrips for timeline blocks (v0.28).
 *
 * A timeline block used to say `▣ 2026-08-02 04-24-09.trim12.mp4 · 206f`, which
 * names a file and shows nothing. Every other editor draws frames from the clip
 * along the block, and it is the difference between reading your timeline and
 * decoding it — the same complaint that produced the live scene preview: it is
 * hard to tell what a thing is without opening it.
 *
 * So: one horizontal contact strip per segment, N evenly-spaced frames wide,
 * which the block stretches across itself. Because the tiles are evenly spaced
 * IN TIME and a block is a linear map of that same span, tile boundaries land
 * where those frames actually are — the strip is a picture of the clip's
 * timing, not decoration.
 *
 * It is generated on demand and never written into a film. A filmstrip is a
 * view of a file, not a fact about the production, and a cache the human finds
 * in `assets/` is a file they have to wonder about. The cost is one bounded
 * ffmpeg run per segment per session; the client caches the result and asks for
 * more tiles only when a block is wide enough to need them.
 */

import { EngineError, ErrorCodes } from './errors.js';
import { ffmpegCapture } from './encoder.js';

/** Tile height in pixels. Timeline rows are ~45px; this survives a little zoom. */
export const STRIP_HEIGHT = 56;

/** Bounds on how many frames a strip may hold. */
export const MIN_TILES = 2;
export const MAX_TILES = 40;

/** Clamp a caller's tile count to something a timeline can use and ffmpeg can tile. */
export function clampTiles(n, fallback = 12) {
  const v = Number.isFinite(Number(n)) ? Math.round(Number(n)) : fallback;
  return Math.max(MIN_TILES, Math.min(MAX_TILES, v));
}

/**
 * Every `step`-th frame, so `tiles` of them span the whole clip.
 *
 * Deliberately a frame STRIDE rather than an fps filter: `fps=N/duration`
 * resamples against a rate ffmpeg has to infer, and on a variable or
 * mis-declared clip it silently returns a different number of pictures than
 * asked for — which would tile short and leave a black gap at the end of the
 * strip. A stride over frame index is exact whatever the container claims.
 */
export function stripFilter({ frames, tiles, height = STRIP_HEIGHT }) {
  const step = Math.max(1, Math.floor(frames / tiles));
  return `select='not(mod(n\\,${step}))',scale=-1:${height},tile=${tiles}x1`;
}

/**
 * Render one strip. Returns a JPEG buffer, or null when the file cannot be
 * read — unknown is a value here, exactly as it is for every other measurement
 * in this engine. A timeline that cannot draw a strip draws its label instead;
 * it must never fail to draw the block.
 *
 * @param {object} opts
 * @param {string} opts.filePath   the video to sample
 * @param {number} opts.frames     how many frames it holds (from the plan)
 * @param {number} [opts.tiles]
 * @returns {Promise<Buffer|null>}
 */
export async function filmstrip({
  filePath, frames, tiles = 12, height = STRIP_HEIGHT, ffmpegPath = 'ffmpeg', signal, onSpawn,
}) {
  if (!(frames > 0)) return null;
  const n = clampTiles(tiles);
  // A clip with fewer frames than tiles cannot fill the strip; ask for what it
  // has rather than tiling short and ending on black.
  const want = Math.max(MIN_TILES, Math.min(n, frames));
  const buf = await ffmpegCapture({
    ffmpegPath,
    what: 'filmstrip',
    signal,
    onSpawn,
    maxBytes: 8 * 1024 * 1024,
    args: [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-vf', stripFilter({ frames, tiles: want, height }),
      '-frames:v', '1', '-vsync', '0',
      '-q:v', '6', '-f', 'mjpeg', 'pipe:1',
    ],
  }).catch(() => null);
  return buf && buf.length ? buf : null;
}

/** The same, but throwing the engine's own error when there is nothing to sample. */
export async function filmstripOrThrow(opts) {
  const buf = await filmstrip(opts);
  if (!buf) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      'Could not read frames from this segment to build a filmstrip',
      { path: opts.filePath });
  }
  return buf;
}
