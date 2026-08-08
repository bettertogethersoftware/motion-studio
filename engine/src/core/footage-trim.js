/**
 * Trimming a footage segment (v0.28).
 *
 * A footage segment joins the timeline as-is, so "which part of this clip
 * plays" has exactly one answer: **the prepared file itself**. Trimming
 * therefore produces a NEW file and repoints the segment at it. Nothing in
 * `film.json` describes the trim a second time, nothing is added to the
 * assemble path, and the frame-count rule that decides whether a delivery is
 * honest is untouched — the new file simply has the frames it claims.
 * (`docs/plans/timeline-footage-and-stills-plan.md` §3 and §4.)
 *
 * **The measurement that shaped this** (recorded in the plan, 2026-08-08): a
 * re-encode of the film's own signature costs `0.50 s + 0.69 s per second of
 * KEPT output` — ~105 s to nudge one second off a real 152 s segment, because
 * cost tracks what survives rather than what is cut. But footage the engine
 * prepared carries a ten-frame GOP, and `films.js` lists `gopSize` under
 * `neednotMatch`, so the same trim as a **stream copy** is 0.2–1.8 s,
 * frame-exact, and — proven by building a film and comparing decoded frames —
 * reaches the delivery pixel-identical.
 *
 * So this module's whole job is to take the cheap path whenever it is honest,
 * and to say plainly when it cannot:
 *
 *   - **Frame 0 is always a keyframe**, so a tail-only trim is always a copy.
 *   - **A head trim is a copy when its in-point lands on a keyframe.** Callers
 *     that can snap (the Studio's handle does) get the copy for free.
 *   - **Otherwise it re-encodes**, which is exact and slow, and is reported as
 *     the job it is.
 *
 * What it will not do is move the in-point silently. `ffmpeg -ss` before `-i`
 * snaps to the preceding keyframe without saying so — an in-point asked for at
 * frame 63 comes back as frame 60's, byte-identical. `snapToKeyframe` makes
 * that an explicit request, and the result always states where the cut
 * actually landed.
 *
 * The source is never overwritten: the previous file stays in `assets/`, which
 * is what makes the edit reversible and what lets the new file's provenance
 * verify. It also costs disk — a trimmed 1080p60 minute is tens of megabytes —
 * and that is the honest price of not mutating a file other segments may share.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { EngineError, ErrorCodes } from './errors.js';
import { resolveInTarget } from './sandbox.js';
import { planFilm } from './films.js';
import { buildVideoArgs, probeMedia, probeFrameCount, runFfmpeg, ffmpegCapture } from './encoder.js';
import { transcodeAsset, transcodeIdentity, transcodeMetaPath, TRANSCODE_VERSION } from './transcode.js';

/** How many keyframes `keyframeGrid` will report before it stops counting. */
export const MAX_GRID_KEYFRAMES = 4000;

/**
 * Above this many frames between keyframes, snapping is not an edit any more.
 * At 60fps a ten-frame GOP is a sixth of a second — finer than anyone drags;
 * an as-supplied recording's 200-frame GOP is three seconds, which is a
 * different clip. Measured across this machine's real footage: engine-prepared
 * 8, as-supplied 55–200.
 */
export const COARSE_GRID_FRAMES = 20;

/** `clip.trim2.mp4` → `clip`, so repeated trims do not stack suffixes. */
const stemOf = (file) => path.basename(file, path.extname(file)).replace(/\.trim\d+$/, '');

/**
 * Where a video's keyframes are, as frame indices.
 *
 * `-skip_frame nokey` makes this cheap — ffprobe reports keyframes without
 * decoding the frames between them. Frame indices rather than timestamps
 * because every edit-side number in this engine is a frame, and a caller
 * comparing a drag position to a pts would have to redo this arithmetic.
 *
 * @returns {Promise<{frames: number[], intervalFrames: number|null, count: number, truncated: boolean, coarse: boolean}>}
 */
export async function keyframeGrid({ filePath, fps, ffprobePath = 'ffprobe', max = MAX_GRID_KEYFRAMES, signal, onSpawn }) {
  if (!(fps > 0)) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'keyframeGrid needs the clip\'s fps');
  // ffprobe, driven through the same capture helper the picture measurements
  // use. Unknown is a value here, never an error: a grid that cannot be read
  // simply means no cheap path, and the trim re-encodes.
  const raw = await ffmpegCapture({
    ffmpegPath: ffprobePath,
    what: 'keyframe grid',
    signal,
    onSpawn,
    args: ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', filePath],
  }).catch(() => null);
  if (!raw) return { frames: [], intervalFrames: null, count: 0, truncated: false, coarse: true };
  const out = raw.toString('utf8');
  const frames = [];
  for (const line of String(out).split('\n')) {
    const t = Number.parseFloat(line);
    if (!Number.isFinite(t)) continue;
    frames.push(Math.round(t * fps));
    if (frames.length >= max) break;
  }
  frames.sort((a, b) => a - b);
  // The MEDIAN gap, not the mean: one long still section at the end of a clip
  // would drag a mean far past what the grid actually feels like to drag on.
  const gaps = frames.slice(1).map((f, i) => f - frames[i]).sort((a, b) => a - b);
  const intervalFrames = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  return {
    frames,
    intervalFrames,
    count: frames.length,
    truncated: frames.length >= max,
    coarse: intervalFrames === null || intervalFrames > COARSE_GRID_FRAMES,
  };
}

/** The keyframe at or before `frame`, from a sorted grid. Null when the grid is empty. */
export function keyframeAtOrBefore(grid, frame) {
  let best = null;
  for (const f of grid) {
    if (f > frame) break;
    best = f;
  }
  return best;
}

/**
 * The encode contract a re-encoded trim must hit.
 *
 * The film's ESTABLISHED signature when it has one — that is what every other
 * segment concatenates with. **A footage-only film has none** (no scene config
 * to read an encoder from), which §3 did not cover and which is two of the
 * three footage-bearing films on this machine; there the segment's own probed
 * properties are the contract, because matching the file you are cutting is
 * exactly what keeps it joinable to itself.
 */
export function trimSignature({ planSignature, media, file }) {
  if (planSignature?.ffmpegArgs) return { signature: planSignature, source: 'film' };
  const v = media?.video;
  if (!(v?.width > 0 && v?.height > 0)) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      `Cannot tell what to encode "${file}" as: the film has no signature (it has no rendered scene) and the `
      + 'clip could not be probed. Add a scene to the film, or trim on a keyframe so the clip can be copied '
      + 'rather than re-encoded.',
      { file });
  }
  const pixFmt = v.pixFmt ?? 'yuv420p';
  return {
    source: 'segment',
    signature: {
      id: `${v.width}x${v.height}@${Math.round(v.fps)}/mp4/opaque/${pixFmt}`,
      width: v.width,
      height: v.height,
      ffmpegArgs: buildVideoArgs({ format: 'mp4', crf: 18, preset: 'medium', pixFmt }),
      color: null,
    },
  };
}

/**
 * Trim one footage segment to a window of itself.
 *
 * `startInFrames`/`durationInFrames` index the SEGMENT'S CURRENT FILE, not the
 * original source — the prepared file is the trim, so each trim composes on
 * the last one, which is the same rule a second `transcode_asset` would follow.
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.filmId
 * @param {string} opts.segmentId          the footage segment's stable `id`
 * @param {number} [opts.startInFrames]    in-point within the current file (default 0)
 * @param {number} [opts.durationInFrames] frames to keep (default: to the end)
 * @param {boolean} [opts.snapToKeyframe]  accept the preceding keyframe to get the cheap path
 * @param {boolean} [opts.dryRun]          report the plan and cost, change nothing
 * @returns {Promise<object>}
 */
export async function trimFootage({
  store, filmId, segmentId,
  startInFrames = 0, durationInFrames = undefined,
  snapToKeyframe = false, dryRun = false,
  ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe',
  signal, onSpawn, onPhase = () => {},
}) {
  const film = await store.getFilm(filmId);
  const index = (film.scenes ?? []).findIndex((s) => s?.footage !== undefined && s.id === segmentId);
  if (index < 0) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      `No footage segment with id "${segmentId}" in ${filmId}. get_film lists each clip's id.`,
      { film: filmId, segmentId });
  }
  const ref = film.scenes[index];
  const rel = String(ref.footage).replace(/\\/g, '/');
  const filmPath = store.filmPath(film.id);
  const sourceAbs = resolveInTarget(filmPath, rel);
  if (!fs.existsSync(sourceAbs)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `The clip for segment "${segmentId}" is missing from the film's assets/ — nothing to trim`,
      { film: filmId, segmentId, footage: rel });
  }

  onPhase('planning');
  const plan = await planFilm({ film, store, ffprobePath });
  const planned = plan.scenes.find((s) => s.kind === 'footage' && s.id === segmentId) ?? {};
  const media = await probeMedia({ filePath: sourceAbs, ffprobePath, signal, onSpawn });
  const fps = planned.fps ?? media?.video?.fps ?? plan.fps ?? film.sceneDefaults?.fps;
  if (!(fps > 0)) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      `Cannot tell the frame rate of "${rel}" — it must be probeable before it can be trimmed`,
      { film: filmId, segmentId, footage: rel });
  }
  // What the FILE holds, not what the segment claims. Trimming against a
  // declared count that the file does not have would produce a segment that is
  // wrong in a new way.
  const available = planned.actualFrames
    ?? media?.video?.frames
    ?? await probeFrameCount({ filePath: sourceAbs, ffprobePath }).catch(() => null)
    ?? ref.durationInFrames;

  /* ---- the requested window, checked against the file ------------------ */
  const start = Number.isInteger(startInFrames) ? startInFrames : 0;
  const keep = durationInFrames === undefined || durationInFrames === null
    ? available - start
    : durationInFrames;
  if (!Number.isInteger(start) || start < 0) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'startInFrames must be a non-negative integer', { startInFrames });
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'durationInFrames must be a positive integer', { durationInFrames });
  }
  if (start + keep > available) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      `The clip has ${available} frames, so frames ${start}..${start + keep} are not all there. `
      + `Keep at most ${available - start} frames from ${start}.`,
      { available, startInFrames: start, durationInFrames: keep });
  }
  if (start === 0 && keep === available) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      `That is the whole clip (${available} frames) — nothing would be trimmed.`,
      { available });
  }

  /* ---- copy or re-encode? --------------------------------------------- */
  onPhase('probing');
  const grid = await keyframeGrid({ filePath: sourceAbs, fps, ffprobePath, signal, onSpawn });
  const onKeyframe = start === 0 || grid.frames.includes(start);
  const snapTo = onKeyframe ? start : keyframeAtOrBefore(grid.frames, start);
  // The OUT-point is what the user fixed by dragging the head; snapping the
  // in-point earlier therefore lengthens the window rather than sliding it.
  const outPoint = start + keep;
  /*
   * Snapping is only offered on a grid that IS an edit grid. On a coarse one
   * the nearest keyframe is seconds away, and taking it would not be a cheaper
   * version of the requested cut — it would be a different cut.
   *
   * The case that made this a rule rather than a nicety: repeated copy-trims of
   * a coarse clip converge on a file whose ONLY keyframe is frame 0 (measured
   * in a real film: 623 frames/3 keyframes → 163/1 → 77/1 → 32/1). Snapping
   * there lands every head trim back on 0 — that is, silently refuses to trim
   * the head while reporting success. A re-encode is the honest answer, and on
   * a clip that has been trimmed down it is also a cheap one: cost is the
   * frames KEPT, so a half-second segment re-encodes in well under a second.
   */
  const canSnap = snapToKeyframe && !grid.coarse && snapTo !== null && snapTo < start;
  const method = onKeyframe || canSnap ? 'copy' : 'reencode';
  const actualStart = method === 'copy' ? (onKeyframe ? start : snapTo) : start;
  const actualKeep = outPoint - actualStart;

  const warnings = [];
  if (method === 'copy' && actualStart !== start) {
    warnings.push(`The in-point moved from frame ${start} to ${actualStart} — the nearest keyframe at or before it. `
      + `That is ${start - actualStart} frame(s) earlier (${((start - actualStart) / fps).toFixed(3)}s), and it is `
      + 'what makes this a copy instead of a re-encode. Pass snapToKeyframe: false for the exact frame.');
  }
  if (method === 'reencode' && grid.coarse) {
    warnings.push(grid.count <= 1
      ? 'This clip has only one keyframe (its first frame), which is what repeated copy-trims of a coarse clip '
        + 'converge on — so there is nothing to snap to and no cheap head trim left. It is being re-encoded, which '
        + `is exact, and cheap here because cost is the ${actualKeep} frames KEPT. Preparing it once with `
        + 'transcode_asset { video: { gop: 10 } } would restore a usable grid.'
      : `This clip's keyframes are ~${grid.intervalFrames} frames apart, so snapping would move the in-point too `
        + 'far to be an edit. It is being re-encoded, which is exact. Preparing the clip once with '
        + 'transcode_asset { video: { gop: 10 } } would make every later trim a copy.');
  }

  const est = method === 'copy' ? null : Math.round(498 + 11.51 * actualKeep);
  const outName = (() => {
    const stem = stemOf(rel);
    const dir = path.posix.dirname(rel) === '.' ? 'assets' : path.posix.dirname(rel);
    const ext = path.extname(rel) || '.mp4';
    for (let n = 1; n < 1000; n += 1) {
      const candidate = `${dir}/${stem}.trim${n}${ext}`;
      if (!fs.existsSync(path.join(filmPath, candidate))) return candidate;
    }
    throw new EngineError(ErrorCodes.INVALID_CONFIG, `Too many trims of ${rel}`, { footage: rel });
  })();

  const preview = {
    segmentId,
    from: rel,
    file: outName,
    method,
    requestedStartFrame: start,
    startFrame: actualStart,
    snappedByFrames: start - actualStart,
    durationInFrames: actualKeep,
    availableFrames: available,
    fps,
    keyframes: { intervalFrames: grid.intervalFrames, count: grid.count, coarse: grid.coarse },
    ...(est !== null ? { estimatedMs: est } : {}),
    warnings,
  };
  if (dryRun) return { ...preview, dryRun: true };

  /* ---- produce the new file -------------------------------------------- */
  const outAbs = resolveInTarget(filmPath, outName, { forWrite: true, asAsset: true });
  await fsp.mkdir(path.dirname(outAbs), { recursive: true });
  const started = Date.now();
  let sigUsed = null;
  try {
    if (method === 'copy') {
      onPhase('copying');
      // `-ss` before `-i` seeks by keyframe index; `-frames:v` counts OUTPUT
      // frames, which is what makes the result safe as a footage segment.
      // `-an` because footage on a timeline is silent by contract.
      await runFfmpeg({
        args: ['-hide_banner', '-loglevel', 'error', '-y',
          ...(actualStart > 0 ? ['-ss', String(actualStart / fps)] : []),
          '-i', sourceAbs, '-frames:v', String(actualKeep), '-c', 'copy', '-an', outAbs],
        ffmpegPath, what: 'trim:copy', signal, onSpawn,
      });
    } else {
      onPhase('encoding');
      const { signature, source } = trimSignature({ planSignature: plan.signature, media, file: rel });
      sigUsed = { id: signature.id, from: source };
      await transcodeAsset({
        sourceAbs, outPath: outAbs, mode: 'video',
        trim: { startInFrames: actualStart, durationInFrames: actualKeep },
        scale: { width: signature.width, height: signature.height },
        fps, audio: false, signature, fpsForFrames: fps,
        ffmpegPath, ffprobePath, signal, onSpawn, onPhase, refresh: true,
      });
    }
  } catch (err) {
    await fsp.rm(outAbs, { force: true }).catch(() => {});
    await fsp.rm(transcodeMetaPath(outAbs), { force: true }).catch(() => {});
    throw err;
  }

  /* ---- verify what EXISTS, never what was asked for --------------------- */
  onPhase('verifying');
  const outMedia = await probeMedia({ filePath: outAbs, ffprobePath, signal, onSpawn });
  const outFrames = outMedia?.video?.frames
    ?? await probeFrameCount({ filePath: outAbs, ffprobePath }).catch(() => null);
  if (outFrames !== null && outFrames !== actualKeep) {
    await fsp.rm(outAbs, { force: true }).catch(() => {});
    await fsp.rm(transcodeMetaPath(outAbs), { force: true }).catch(() => {});
    throw new EngineError(ErrorCodes.TRANSCODE_FAILED,
      `The trimmed file has ${outFrames} frames but ${actualKeep} were asked for — refusing to put a segment on the `
      + 'timeline whose declared length its file does not have. Nothing was changed.',
      { expected: actualKeep, actual: outFrames, file: outName });
  }

  // A sidecar in `transcode_asset`'s own shape, so `derivedFrom` means the same
  // thing however the file was made and planFilm can verify it. The COPY path
  // writes its own because it never went through transcodeAsset.
  if (method === 'copy') {
    const st = await fsp.stat(sourceAbs);
    await fsp.writeFile(transcodeMetaPath(outAbs), JSON.stringify({
      identity: transcodeIdentity({
        sourceAbs, bytes: st.size, mtimeMs: st.mtimeMs,
        request: {
          mode: 'video',
          trim: { startInFrames: actualStart, durationInFrames: actualKeep },
          copy: true,
          version: TRANSCODE_VERSION,
        },
      }),
      transcodedAt: new Date().toISOString(),
    }, null, 2) + '\n').catch(() => {});
  }

  /* ---- repoint the segment, and nothing else ---------------------------- */
  onPhase('swapping');
  const scenes = film.scenes.map((s, i) => (i === index
    ? {
      ...s,
      footage: outName,
      durationInFrames: actualKeep,
      // The provenance pointer moves with the segment — the file it was cut
      // from stays in assets/, which is what makes this verifiable and what
      // makes the edit reversible.
      derivedFrom: { asset: `film:${rel}`, transcodeMeta: `${outName}.transcode.json` },
    }
    : s));
  const saved = await store.updateFilm(film.id, { scenes });

  const outStat = await fsp.stat(outAbs).catch(() => null);
  return {
    ...preview,
    dryRun: false,
    elapsedMs: Date.now() - started,
    frames: outFrames,
    framesVerified: outFrames === actualKeep,
    bytes: outStat?.size ?? null,
    ...(sigUsed ? { conformedTo: sigUsed } : {}),
    segment: saved.scenes[index],
    keptOnDisk: rel,
  };
}
