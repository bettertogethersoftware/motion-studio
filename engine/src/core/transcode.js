/**
 * `transcode_asset` — preparing media inside the tool surface (v0.22).
 *
 * `probe_asset` let an agent *read* a media file and `transcribe_asset` let it
 * *hear* one. Neither can **change** one, and every real job with supplied
 * footage needs to: the render browser cannot decode H.264, a PIP needs a tighter
 * crop, a spine needs four spans of someone's voice joined, and a footage segment
 * needs an exact frame count to sit on the film timeline.
 *
 * ## The one rule that shapes everything here
 *
 * **No arbitrary ffmpeg arguments — ever.** Not `args`, not `filter`, not an
 * "escape hatch". The premise of this whole tool surface is "no shell"; a
 * passthrough is a shell wearing a hat, and it takes the path sandbox with it.
 * Every operation is a named, validated field, and the filter graph is built from
 * those fields only. If a job needs something absent from the list, that is a
 * request for a new field — not for a way around the list.
 *
 * That rule is why `buildVideoFilter` and `buildSpanGraph` are pure functions
 * returning strings: they are the entire attack surface, and they are unit-tested
 * without ffmpeg (the same shape as `buildOverlayGraph` in core/films.js).
 *
 * ## Report by measuring, never by echoing
 *
 * The response describes the file that now exists — `summarizeMedia` on the
 * output — rather than repeating the request. An agent that asked for 640×360 and
 * got 640×358 (even dimensions, chroma subsampling) needs to learn that from the
 * tool, not from a render three steps later.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { EngineError, ErrorCodes } from './errors.js';
import { getFormat } from './formats.js';
import { runFfmpeg, probeMedia, probeFrameCount, buildVideoArgs } from './encoder.js';

/**
 * Bounds. A wrapper that will happily start a 40-minute encode is a wrapper that
 * looks broken; these make the refusal a measurement instead.
 */
export const MAX_SOURCE_SECONDS = 3600;
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_SPANS = 64;
export const MAX_CROSSFADE_MS = 200;
export const MAX_FRAMES_OUT = 10_000;

/** Bumped when the graph builders change shape, so a stale sidecar is not trusted. */
export const TRANSCODE_VERSION = 1;

/**
 * Destination extension → the engine's format name.
 *
 * The reverse of `getFormat(f).ext`, which does not exist elsewhere because
 * nothing else picks a format from a filename. Note it is not an identity map:
 * prores writes `.mov`.
 */
export function formatForExtension(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase();
  return ({ '.mp4': 'mp4', '.webm': 'webm', '.mov': 'prores' })[ext] ?? null;
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function bad(message, detail) {
  return new EngineError(ErrorCodes.INVALID_CONFIG, message, detail);
}

/* ------------------------------------------------------------------ */
/* Pure graph builders — the whole validated surface                   */
/* ------------------------------------------------------------------ */

/**
 * The `-vf` chain for the named geometry fields, or null when none apply.
 *
 * Order is deliberate and not the caller's choice: **crop, then scale, then
 * fps**. Cropping after scaling would make the crop rectangle mean something
 * different from what the caller measured on the source, and changing frame rate
 * before scaling would resample more pixels than necessary.
 *
 * Dimensions are floored to even numbers for the chroma-subsampled formats,
 * because an odd width is an encoder error rather than a rounding detail — and
 * the caller learns the real numbers from the measured response.
 */
export function buildVideoFilter({ crop, scale, fps, evenDims = true } = {}) {
  const parts = [];
  const even = (n) => (evenDims ? Math.max(2, Math.floor(n / 2) * 2) : Math.max(1, Math.round(n)));
  if (crop) {
    parts.push(`crop=${even(crop.width)}:${even(crop.height)}:${Math.max(0, Math.round(crop.x ?? 0))}:${Math.max(0, Math.round(crop.y ?? 0))}`);
  }
  if (scale) {
    // A single dimension keeps the aspect ratio: -2 is "derive, and stay even".
    const w = scale.width ? even(scale.width) : -2;
    const h = scale.height ? even(scale.height) : -2;
    parts.push(`scale=${w}:${h}`);
  }
  if (fps) parts.push(`fps=${fps}`);
  return parts.length ? parts.join(',') : null;
}

/**
 * The `-filter_complex` that cuts N spans out of one source and joins them.
 *
 * **Why this lives in an asset tool and not on the film's audio timeline:** the
 * mixer's fades are frame-quantized, and 12 ms at 30 fps is 0.36 frames —
 * inexpressible there. Four overlapping tracks with 1-frame (33 ms) fades is a
 * different, worse edit. Joining spans produces one WAV, and that WAV goes on the
 * timeline as a single track at `startInFrames: 0`.
 *
 * A hard butt-join between two spans of speech **clicks audibly**; the measured
 * fix was a ~12 ms triangular crossfade. `acrossfade` overlaps its inputs, so the
 * joined length is `sum(spans) − (N−1) × crossfade` — the fade consumes time,
 * which is what makes it a crossfade rather than a gap.
 *
 * @returns {{ filterComplex: string, outLabel: string }}
 */
export function buildSpanGraph(spans, { crossfadeMs = 0, sampleRate = 48000, channels = 2 } = {}) {
  if (!spans.length) throw bad('spans must contain at least one span');
  const chain = [];
  // Every span is normalized to one sample format up front: acrossfade requires
  // matching inputs, and a source whose streams differ would otherwise fail deep
  // inside ffmpeg with a message about nothing the caller wrote.
  const fmt = `aformat=sample_rates=${sampleRate}:channel_layouts=${channels === 1 ? 'mono' : 'stereo'}`;
  spans.forEach((s, i) => {
    const trim = s.durationSeconds !== undefined
      ? `atrim=start=${s.startSeconds}:duration=${s.durationSeconds}`
      : `atrim=start=${s.startSeconds}`;
    // asetpts resets each span's timestamps to zero; without it the concat/fade
    // sees gaps where the source offsets were.
    chain.push(`[0:a]${trim},asetpts=N/SR/TB,${fmt}[a${i}]`);
  });

  if (spans.length === 1) return { filterComplex: chain.join(';'), outLabel: 'a0' };

  if (!crossfadeMs) {
    // A hard join, which the caller asked for explicitly by passing 0.
    const inputs = spans.map((_, i) => `[a${i}]`).join('');
    chain.push(`${inputs}concat=n=${spans.length}:v=0:a=1[out]`);
    return { filterComplex: chain.join(';'), outLabel: 'out' };
  }

  const d = (crossfadeMs / 1000).toFixed(4);
  let prev = 'a0';
  for (let i = 1; i < spans.length; i++) {
    const out = i === spans.length - 1 ? 'out' : `x${i}`;
    chain.push(`[${prev}][a${i}]acrossfade=d=${d}:c1=tri:c2=tri[${out}]`);
    prev = out;
  }
  return { filterComplex: chain.join(';'), outLabel: 'out' };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reject everything shell-shaped before any of it reaches a process.
 *
 * Collected rather than thrown one at a time, mirroring validateFilm: an agent
 * fixing a call wants every complaint at once.
 */
export function validateTranscode({
  mode = 'video', to, trim, crop, scale, fps, video, spans, crossfadeMs, sampleRate, channels, frames,
}) {
  const problems = [];
  if (!['video', 'audio', 'frames'].includes(mode)) problems.push(`mode must be video, audio or frames (got "${mode}")`);
  if (typeof to !== 'string' || !to.trim()) problems.push('to must be a path under assets/');

  // Geometry is checked whenever it is PRESENT rather than gated on mode: a
  // malformed `crop` is malformed regardless, and gating would let one bad field
  // (an unknown mode, say) hide every other complaint — which is the opposite of
  // what collecting them is for.
  {
    if (crop) {
      if (!isPosInt(crop.width) || !isPosInt(crop.height)) problems.push('crop.width/height must be positive integers');
      for (const k of ['x', 'y']) {
        if (crop[k] !== undefined && !(Number.isInteger(crop[k]) && crop[k] >= 0)) problems.push(`crop.${k} must be a non-negative integer`);
      }
    }
    if (scale) {
      if (scale.width === undefined && scale.height === undefined) problems.push('scale needs width, height, or both');
      for (const k of ['width', 'height']) {
        if (scale[k] !== undefined && !isPosInt(scale[k])) problems.push(`scale.${k} must be a positive integer`);
      }
    }
    if (fps !== undefined && !(typeof fps === 'number' && fps > 0 && fps <= 240)) problems.push('fps must be a number in 1..240');
    if (video) {
      if (video.quality !== undefined && !(Number.isInteger(video.quality) && video.quality >= 0 && video.quality <= 63)) {
        problems.push('video.quality must be an integer 0..63 (a CRF)');
      }
      if (video.gop !== undefined && !isPosInt(video.gop)) problems.push('video.gop must be a positive integer');
    }
  }

  if (trim) {
    if (trim.startSeconds !== undefined && !isNonNegNum(trim.startSeconds)) problems.push('trim.startSeconds must be a non-negative number');
    if (trim.startInFrames !== undefined && !(Number.isInteger(trim.startInFrames) && trim.startInFrames >= 0)) {
      problems.push('trim.startInFrames must be a non-negative integer');
    }
    if (trim.startSeconds !== undefined && trim.startInFrames !== undefined) {
      problems.push('trim: pass startSeconds OR startInFrames, not both');
    }
    if (trim.durationInFrames !== undefined && !isPosInt(trim.durationInFrames)) problems.push('trim.durationInFrames must be a positive integer');
    if (trim.durationSeconds !== undefined && !(typeof trim.durationSeconds === 'number' && trim.durationSeconds > 0)) {
      problems.push('trim.durationSeconds must be a positive number');
    }
    if (trim.durationInFrames !== undefined && trim.durationSeconds !== undefined) {
      problems.push('trim: pass durationInFrames OR durationSeconds, not both');
    }
    if (isPosInt(trim.durationInFrames) && trim.durationInFrames > MAX_FRAMES_OUT) {
      problems.push(`trim.durationInFrames exceeds ${MAX_FRAMES_OUT}`);
    }
  }

  if (mode === 'audio') {
    if (!Array.isArray(spans) || !spans.length) {
      problems.push('audio mode needs spans: [{ startSeconds, durationInFrames|durationSeconds }]');
    } else {
      if (spans.length > MAX_SPANS) problems.push(`spans exceeds ${MAX_SPANS}`);
      spans.forEach((s, i) => {
        if (!s || typeof s !== 'object') { problems.push(`spans[${i}] must be an object`); return; }
        if (!isNonNegNum(s.startSeconds)) problems.push(`spans[${i}].startSeconds must be a non-negative number`);
        const hasFrames = s.durationInFrames !== undefined;
        const hasSeconds = s.durationSeconds !== undefined;
        if (hasFrames && hasSeconds) problems.push(`spans[${i}]: pass durationInFrames OR durationSeconds, not both`);
        if (hasFrames && !isPosInt(s.durationInFrames)) problems.push(`spans[${i}].durationInFrames must be a positive integer`);
        if (hasSeconds && !(typeof s.durationSeconds === 'number' && s.durationSeconds > 0)) {
          problems.push(`spans[${i}].durationSeconds must be a positive number`);
        }
      });
    }
    if (crossfadeMs !== undefined && !(typeof crossfadeMs === 'number' && crossfadeMs >= 0 && crossfadeMs <= MAX_CROSSFADE_MS)) {
      problems.push(`crossfadeMs must be a number 0..${MAX_CROSSFADE_MS}`);
    }
    if (sampleRate !== undefined && ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) {
      problems.push('sampleRate must be one of 8000, 16000, 22050, 24000, 32000, 44100, 48000');
    }
    if (channels !== undefined && ![1, 2].includes(channels)) problems.push('channels must be 1 or 2');
  } else if (spans !== undefined) {
    problems.push('spans is an audio-mode field');
  }

  if (mode === 'frames' && frames !== undefined) {
    if (frames.every !== undefined && !isPosInt(frames.every)) problems.push('frames.every must be a positive integer');
  }

  if (problems.length) {
    throw bad(`Invalid transcode request: ${problems.join('; ')}`, { problems });
  }
}

/* ------------------------------------------------------------------ */
/* The sidecar — skip work that has already been done                  */
/* ------------------------------------------------------------------ */

/**
 * What produced an output, recorded beside it (the `*.render.json` pattern from
 * v0.21). Re-pulling an unchanged clip should be free, and during authoring the
 * same call gets repeated a lot.
 *
 * Named `.transcode.json` and deliberately visible to `list_assets` — a file in
 * `assets/` that nothing can explain is worse than one extra row.
 */
export const transcodeMetaPath = (outPath) => `${outPath}.transcode.json`;

/** Read a transcode sidecar by its literal `.transcode.json` file path. */
export function readTranscodeMetaFile(metaPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/** Read the sidecar that belongs beside a transcoded output file. */
export function readTranscodeMeta(outPath) {
  return readTranscodeMetaFile(transcodeMetaPath(outPath));
}

/**
 * Case normalization is Windows-only: the recorded path is stat()ed again at
 * plan time, and POSIX filesystems are case-sensitive — lowercasing there
 * turns a real source into ENOENT. Windows keeps lowercasing so sidecars
 * written before this distinction still match their recomputed identity.
 */
const normalizePathForIdentity = (p) => {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Identity of a transcode: the source as it was, plus every parameter. */
export function transcodeIdentity({ sourceAbs, bytes, mtimeMs, request }) {
  return {
    version: TRANSCODE_VERSION,
    source: normalizePathForIdentity(sourceAbs),
    bytes,
    mtimeMs: Math.round(mtimeMs),
    request,
  };
}

const sameIdentity = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Prepare one media file into `outPath`.
 *
 * @param {object} opts
 * @param {string} opts.sourceAbs   absolute path to the source (already located + sandboxed)
 * @param {string} opts.outPath     absolute destination (already sandboxed under assets/)
 * @param {string} [opts.mode]      'video' | 'audio' | 'frames'
 * @param {object} [opts.signature] a film signature to conform to (from filmSignature())
 * @param {number} [opts.fpsForFrames]  rate used to convert frame counts to seconds
 * @returns {Promise<object>} what was applied, plus the MEASURED result
 */
export async function transcodeAsset({
  sourceAbs, outPath, mode = 'video',
  trim, crop, scale, fps, video = {}, audio,
  spans, crossfadeMs = 0, sampleRate, channels,
  frames,
  signature = null, fpsForFrames = 30,
  ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe',
  refresh = false, signal, onSpawn, onPhase = () => {},
  maxSourceSeconds = MAX_SOURCE_SECONDS, maxSourceBytes = MAX_SOURCE_BYTES,
}) {
  const st = await fsp.stat(sourceAbs).catch(() => null);
  if (!st || !st.isFile()) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `No such source file: ${sourceAbs}`, { path: sourceAbs });
  }
  if (st.size > maxSourceBytes) {
    throw new EngineError(
      ErrorCodes.ASSET_TOO_LARGE,
      `Source is ${(st.size / 1e9).toFixed(2)} GB, over the ${(maxSourceBytes / 1e9).toFixed(2)} GB limit`,
      { bytes: st.size, maxBytes: maxSourceBytes },
    );
  }
  // Never overwrite the source — a destructive in-place transcode is not a thing
  // this surface should be able to express by accident.
  if (normalizePathForIdentity(sourceAbs) === normalizePathForIdentity(outPath)) {
    throw bad('to must differ from the source — this tool never overwrites its input', { path: outPath });
  }

  onPhase('probing');
  const source = await probeMedia({ filePath: sourceAbs, ffprobePath }).catch(() => null);
  if (source?.durationSeconds && source.durationSeconds > maxSourceSeconds) {
    throw new EngineError(
      ErrorCodes.ASSET_TOO_LARGE,
      `Source is ${Math.round(source.durationSeconds)}s, over the ${maxSourceSeconds}s limit — trim it first`,
      { durationSeconds: source.durationSeconds, maxSeconds: maxSourceSeconds },
    );
  }
  if (mode === 'audio' && source && !source.hasAudio) {
    throw new EngineError(
      ErrorCodes.INVALID_CONFIG,
      'audio mode needs a source with an audio stream; this file has none',
      { path: sourceAbs },
    );
  }

  // A stated film contract is an instruction to *convert* footage, never to
  // relabel it. colorspace needs known input metadata; HD material that leaves
  // it unstated is treated as bt709 and the response records that assumption.
  const targetColor = signature?.color?.stated ? signature.color : null;
  const inputColor = source?.video?.color;
  const colorAssumption = targetColor && (!inputColor?.primaries || !inputColor?.transfer || !inputColor?.matrix)
    ? { inputColor: 'bt709', reason: 'source did not state complete colour metadata' }
    : null;

  // The effective request, after matchFilm — this is what the sidecar keys on, so
  // a signature change invalidates a cached output exactly like a parameter change.
  const effective = {
    mode,
    ...(trim ? { trim } : {}),
    ...(crop ? { crop } : {}),
    ...(scale ? { scale } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(Object.keys(video).length ? { video } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(spans ? { spans, crossfadeMs, sampleRate, channels } : {}),
    ...(frames ? { frames } : {}),
    ...(signature ? { signature: signature.id, args: signature.ffmpegArgs, color: signature.color } : {}),
    ...(colorAssumption ? { colorAssumption } : {}),
  };
  const identity = transcodeIdentity({ sourceAbs, bytes: st.size, mtimeMs: st.mtimeMs, request: effective });

  if (!refresh && fs.existsSync(outPath) && sameIdentity(readTranscodeMeta(outPath)?.identity, identity)) {
    const measured = await probeMedia({ filePath: outPath, ffprobePath }).catch(() => null);
    return {
      path: outPath,
      bytes: (await fsp.stat(outPath)).size,
      applied: effective,
      skipped: true,
      elapsedMs: 0,
      probed: measured !== null,
      ...(colorAssumption ? { assumptions: { color: colorAssumption } } : {}),
      ...(measured ?? {}),
    };
  }

  const started = Date.now();
  // For a frames sequence the destination IS a directory (ffmpeg's image2 muxer
  // will not create it); for a single file it is the parent that must exist.
  await fsp.mkdir(mode === 'frames' ? outPath : path.dirname(outPath), { recursive: true });
  onPhase('encoding');

  const args = mode === 'audio'
    ? buildAudioArgs({ sourceAbs, outPath, spans, crossfadeMs, sampleRate, channels, fpsForFrames })
    : buildPictureArgs({
      sourceAbs, outPath, mode, trim, crop, scale, fps, video, audio, frames, signature, fpsForFrames, colorAssumption,
    });

  try {
    await runFfmpeg({ args, ffmpegPath, what: `transcode:${mode}`, signal, onSpawn });
  } catch (err) {
    if (err?.code === ErrorCodes.CANCELLED) throw err;
    throw new EngineError(
      ErrorCodes.TRANSCODE_FAILED,
      `Transcode failed: ${err?.message ?? err}. The source may use a codec this ffmpeg cannot decode, or the ` +
        'requested geometry may be larger than the source frame.',
      { stderrTail: err?.detail?.stderrTail ?? null, mode },
    );
  }

  onPhase('measuring');
  // Report what EXISTS, never what was asked for.
  const measured = mode === 'frames' ? null : await probeMedia({ filePath: outPath, ffprobePath }).catch(() => null);
  const outStat = mode === 'frames' ? null : await fsp.stat(outPath).catch(() => null);
  let frameCount = null;
  if (mode === 'video' && measured) {
    frameCount = measured.video?.frames ?? await probeFrameCount({ filePath: outPath, ffprobePath }).catch(() => null);
  }

  const result = {
    path: outPath,
    bytes: outStat?.size ?? null,
    applied: effective,
    skipped: false,
    elapsedMs: Date.now() - started,
    probed: measured !== null,
    ...(colorAssumption ? { assumptions: { color: colorAssumption } } : {}),
    ...(measured ?? {}),
    ...(frameCount ? { frames: frameCount } : {}),
  };

  // Best-effort: a sidecar that cannot be written must not fail work that
  // succeeded. Only for single-file outputs — a frames directory has no "beside".
  if (mode !== 'frames') {
    try {
      await fsp.writeFile(transcodeMetaPath(outPath), JSON.stringify({
        identity, transcodedAt: new Date().toISOString(),
      }, null, 2) + '\n');
    } catch { /* non-fatal by design */ }
  }
  return result;
}

/** Seconds for a trim/span duration expressed either way. */
const durationSeconds = (o, fps) => (o?.durationInFrames !== undefined
  ? o.durationInFrames / fps
  : o?.durationSeconds);

/** `video` and `frames` modes: one input, a named filter chain, one output. */
function buildPictureArgs({
  sourceAbs, outPath, mode, trim, crop, scale, fps, video, audio, frames, signature, fpsForFrames, colorAssumption,
}) {
  const format = mode === 'frames' ? null : formatForExtension(outPath);
  if (mode === 'video' && !format) {
    throw new EngineError(
      ErrorCodes.UNSUPPORTED_FORMAT,
      `Cannot tell the output format from "${path.basename(outPath)}" — use .mp4, .webm or .mov. ` +
        '(.gif is a deliverable format, not an asset-preparation one: its palette filter cannot be combined ' +
        'with crop/scale here — render a gif scene instead.)',
      { path: outPath },
    );
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  // `-ss` BEFORE `-i` seeks by keyframe index and is orders of magnitude faster on
  // a long source; modern ffmpeg then decodes to the exact requested position, so
  // it is accurate too. Frame-exactness of the OUTPUT comes from `-frames:v`.
  const startSeconds = trim?.startInFrames !== undefined ? trim.startInFrames / fpsForFrames : trim?.startSeconds;
  if (startSeconds) args.push('-ss', String(startSeconds));
  args.push('-i', sourceAbs);

  // A frame COUNT, not a duration: `-t seconds` does not guarantee the count, and
  // an off-by-one frame breaks a concat seam and shifts every later cue. This is
  // what makes an output safe as a footage segment.
  //
  // `-frames:v` counts OUTPUT frames, so decimation has to be folded in:
  // `trim.durationInFrames` always means "this many frames OF SOURCE" — a trim
  // describes the span being read, consistently with every other mode — and
  // `frames.every: 3` over 12 of them yields 4 images, not 12 taken from 36.
  const every = mode === 'frames' ? (frames?.every ?? 1) : 1;
  if (trim?.durationInFrames !== undefined) {
    args.push('-frames:v', String(Math.max(1, Math.ceil(trim.durationInFrames / every))));
  } else if (trim?.durationSeconds !== undefined) args.push('-t', String(trim.durationSeconds));

  const fmt = format ? getFormat(format) : null;
  // PNG frames carry no chroma subsampling, so odd dimensions are legal there —
  // and rounding a sequence the caller sized deliberately would be worse.
  const vf = buildVideoFilter({ crop, scale, fps, evenDims: mode === 'frames' ? false : (fmt?.requiresEvenDims ?? true) });
  // Frame decimation joins the SAME chain: a second `-vf` would win outright and
  // silently discard the crop/scale the caller asked for.
  const color = signature?.color?.stated
    ? `colorspace=all=bt709:trc=srgb${colorAssumption ? ':iall=bt709' : ''}`
    : null;
  const chain = [
    vf,
    color,
    ...(mode === 'frames' && frames?.every ? [`select=not(mod(n\\,${frames.every}))`] : []),
  ].filter(Boolean).join(',') || null;
  if (chain) args.push('-vf', chain);
  if (mode === 'frames' && frames?.every) args.push('-vsync', '0');

  // Footage is silent by contract on the film timeline, and a PIP inside a
  // composition has no use for an audio track either — so dropping it is the
  // default, and keeping it is opt-in.
  if (mode === 'frames' || audio !== true) args.push('-an');

  if (mode === 'frames') {
    args.push(path.join(outPath, 'frame-%06d.png'));
    return args;
  }

  // Conform to a film's contract by using ITS OWN encoder arguments, verbatim —
  // never by re-deriving the encode table here. That is the whole point of the
  // film signature: one copy of the truth.
  if (signature?.ffmpegArgs) args.push(...signature.ffmpegArgs);
  else {
    args.push(...buildVideoArgs({
      format,
      ...(video.quality !== undefined ? { crf: video.quality } : {}),
    }));
  }
  // A short GOP makes per-frame seeking inside a composition much faster
  // (frame-api.md §11). It is NOT needed to concatenate — each segment is its own
  // encode and opens on a keyframe regardless.
  if (video.gop) args.push('-g', String(video.gop));
  if (fps) args.push('-r', String(fps));
  args.push(outPath);
  return args;
}

/** `audio` mode: N spans out of one source, joined, as a PCM WAV. */
function buildAudioArgs({ sourceAbs, outPath, spans, crossfadeMs, sampleRate = 48000, channels = 2, fpsForFrames }) {
  const resolved = spans.map((s) => ({
    startSeconds: s.startSeconds,
    ...(durationSeconds(s, fpsForFrames) !== undefined ? { durationSeconds: Number(durationSeconds(s, fpsForFrames).toFixed(6)) } : {}),
  }));
  const { filterComplex, outLabel } = buildSpanGraph(resolved, { crossfadeMs, sampleRate, channels });
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourceAbs,
    '-filter_complex', filterComplex,
    '-map', `[${outLabel}]`,
    // PCM, because every consumer downstream (the mixer, measureAudioLevels,
    // whisper.cpp) reads a WAV header for its duration and a lossy container
    // would make that a guess.
    '-c:a', 'pcm_s16le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    outPath,
  ];
}
