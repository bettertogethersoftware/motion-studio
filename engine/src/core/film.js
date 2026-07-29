/**
 * Film assembly (v0.9) — stitch already-rendered scenes into one film.
 *
 * Motion Studio renders one composition per scene. A long-form film is many
 * short scenes concatenated end to end. This module does the *assembly*
 * step (it renders nothing): validate that the scenes are compatible, then merge
 * their output files losslessly (`-c copy`, via the same encoder.concatSegments
 * the parallel renderer uses) and, optionally, mux one master-audio timeline
 * over the whole thing (encoder.muxAudio).
 *
 *   scenes (each already rendered)
 *     → validateScenes()  — same resolution/fps/format/pixfmt, all rendered
 *     → assembleFilm()    — concat outputs (+ optional master audio) → one file
 *
 * These are the primitives; core/films.js owns the film *document* that decides
 * which scenes, in what order, with what master audio. Rendering each scene
 * stays with the existing `render` tool: transparent, async, resumable.
 * See docs/film-setup.md.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';
import { getFormat, outputColorProfile } from './formats.js';
import { concatSegments, muxAudio, measureAudioLevels } from './encoder.js';

/** Peak (dBFS) at or above which the mix is reported as clipping. */
const CLIPPING_DBFS = -0.1;

/** How close to `audioTargetPeakDb` counts as "already there" — one pass only. */
const TARGET_TOLERANCE_DB = 0.2;

/**
 * A one-line fingerprint of everything that must match for a lossless `-c copy`
 * concat to succeed (codec-determining params). Scenes whose signatures differ
 * cannot be stream-copied together.
 */
export function sceneSignature(cfg) {
  const o = cfg.output ?? {};
  return `${cfg.width}x${cfg.height}@${cfg.fps}/${o.format ?? 'mp4'}/${o.transparent ? 'alpha' : 'opaque'}/${o.pixFmt ?? 'yuv420p'}`;
}

/**
 * The engine's format name for a probed file, or null when it is not one the
 * timeline can carry (v0.22).
 *
 * Needed because a probe and a scene config describe the same file in different
 * vocabularies: ffprobe reports a **codec name** (`h264`) and a comma-separated
 * container list (`mov,mp4,m4a,3gp,3g2,mj2`), while the engine names a **format**
 * (`mp4`) whose encoder is `libx264`. Comparing either field directly is a
 * guaranteed false mismatch, so the mapping is stated once, here.
 */
export function engineFormatForProbe(codec, container = '') {
  const c = String(codec ?? '').toLowerCase();
  const box = String(container ?? '').toLowerCase();
  if (c === 'h264' && /mp4|mov/.test(box)) return 'mp4';
  if ((c === 'vp9' || c === 'vp8') && /webm|matroska/.test(box)) return 'webm';
  if (c === 'prores' && /mov|mp4/.test(box)) return 'prores';
  return null;
}

/** Pixel formats that carry an alpha plane — the `alpha`/`opaque` signature segment. */
const ALPHA_PIX_FMTS = /^(yuva|argb|rgba|abgr|bgra|gbrap|ya)/;

/**
 * Build the same fingerprint `sceneSignature()` produces, but from a probed
 * file, so supplied footage can be compared against a film's contract.
 *
 * Returns null when the probe cannot answer — ffprobe is not a declared
 * prerequisite, and "unverified" is a legitimate third state (the same one
 * `renderVerified: null` represents for a render that predates the sidecar).
 * A caller must not read null as "matches".
 *
 * @param {object|null} media  summarizeMedia() output
 */
export function probeSignature(media) {
  const v = media?.video;
  if (!v || !v.width || !v.height || !v.fps) return null;
  const format = engineFormatForProbe(v.codec, media.container);
  if (!format) return null;
  const alpha = ALPHA_PIX_FMTS.test(String(v.pixFmt ?? '').toLowerCase());
  return `${v.width}x${v.height}@${v.fps}/${format}/${alpha ? 'alpha' : 'opaque'}/${v.pixFmt ?? 'yuv420p'}`;
}

/** Where a scene's rendered file lives (what `render` wrote). */
export function sceneOutputPath(scenePath, cfg) {
  const o = cfg.output ?? {};
  return path.join(scenePath, o.dir ?? 'out', o.filename ?? 'output.mp4');
}

/** Does a scene's rendered file carry an audio stream? (config.audio + audio-capable format) */
export function sceneHasAudio(cfg) {
  const fmt = getFormat(cfg.output?.format ?? 'mp4');
  return (cfg.audio?.length ?? 0) > 0 && !!fmt.audioArgs;
}

/* ------------------------------------------------------------------ *
 * Render sidecar (v0.21) — what the output on disk actually contains.
 *
 * Existence of the output file was the only "is this scene rendered?"
 * signal, and it cannot answer "is it rendered AT THE CURRENT SETTINGS?".
 * Change durationInFrames after rendering and the plan still says
 * rendered:true with a totalFrames the concat cannot produce; build_film
 * then stitches the stale file and every master-audio offset past that
 * scene silently drifts against the picture.
 *
 * So each completed full-scene render drops a small JSON sidecar beside
 * its output recording what was actually written. The plan compares it
 * with the live config; validateScenes refuses to build on a mismatch.
 * A missing sidecar (rendered by an older build) is NOT a problem — it is
 * reported as unverified, exactly like an unverifiable frame count.
 * ------------------------------------------------------------------ */

/** Sidecar path for a scene's rendered output. */
export function renderMetaPath(scenePath, cfg) {
  return sceneOutputPath(scenePath, cfg) + '.render.json';
}

/**
 * The fields that make a rendered file match (or not) the current config.
 *
 * These are exactly the fields sceneSignature() encodes, plus the frame count.
 * `pixFmt` and `transparent` were missing until v0.22, which left a hole: both
 * are part of the concat contract, so changing either after a render broke that
 * contract with nothing reporting it — the output was still counted as rendered
 * and build_film would stitch a file that could not stream-copy.
 */
function metaFromConfig(cfg, frames) {
  const color = outputColorProfile(cfg.output);
  return {
    frames,
    width: cfg.width,
    height: cfg.height,
    fps: cfg.fps,
    format: cfg.output?.format ?? 'mp4',
    pixFmt: cfg.output?.pixFmt ?? 'yuv420p',
    transparent: cfg.output?.transparent ?? false,
    colorPrimaries: color.primaries,
    colorTransfer: color.transfer,
    colorMatrix: color.matrix,
    colorRange: color.range,
  };
}

/**
 * Record what a completed render wrote. Best-effort: a sidecar that cannot
 * be written must never fail a render that already succeeded.
 */
export async function writeRenderMeta({ scenePath, config, frames }) {
  const body = {
    ...metaFromConfig(config, frames),
    renderedAt: new Date().toISOString(),
  };
  try {
    await fsp.writeFile(renderMetaPath(scenePath, config), JSON.stringify(body, null, 2) + '\n');
  } catch { /* non-fatal by design */ }
  return body;
}

/** Read a scene's render sidecar, or null when absent/unreadable. */
export function readRenderMeta(scenePath, cfg) {
  try {
    const raw = fs.readFileSync(renderMetaPath(scenePath, cfg), 'utf8');
    const meta = JSON.parse(raw);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/**
 * Compare a sidecar with the live config.
 *
 * @returns {null | {changed: string[], recorded: object, current: object}}
 *   null when it matches, or when there is no sidecar to compare against.
 */
export function renderStaleness(meta, cfg) {
  if (!meta) return null;
  const current = metaFromConfig(cfg, cfg.durationInFrames);
  const changed = [];
  for (const k of [
    'frames', 'width', 'height', 'fps', 'format', 'pixFmt', 'transparent',
    'colorPrimaries', 'colorTransfer', 'colorMatrix', 'colorRange',
  ]) {
    // An older/partial sidecar simply has less to say — only compare what it
    // recorded. That is also the whole backward-compatibility story for the two
    // fields added in v0.22: a pre-v0.22 sidecar has no pixFmt/transparent, so
    // those renders stay *unverified* on them rather than turning up *stale*.
    if (meta[k] !== undefined && meta[k] !== current[k]) changed.push(k);
  }
  if (!changed.length) return null;
  return {
    changed,
    recorded: Object.fromEntries(changed.map((k) => [k, meta[k]])),
    current: Object.fromEntries(changed.map((k) => [k, current[k]])),
  };
}

/** One-line human summary of a staleness result, e.g. "frames 217 → 200". */
export function describeStaleness(st) {
  return st.changed.map((k) => `${k} ${st.recorded[k]} → ${st.current[k]}`).join(', ');
}

/* ------------------------------------------------------------------ *
 * Segment accessors (v0.22).
 *
 * A film's play order holds two kinds of segment: a **scene**, which the engine
 * rendered and whose `config` is the source of truth, and **footage**, a file
 * that joins as-is and whose truth is the file itself. These four functions are
 * the only places that know the difference, so everything below them — layout,
 * validation, assembly — reads one vocabulary.
 *
 * `isFootage` keys on the tagged `kind` rather than on the presence of a field,
 * because a mis-tagged segment should fail loudly here rather than be silently
 * treated as a scene with no config.
 * ------------------------------------------------------------------ */

export const isFootage = (s) => s?.kind === 'footage';

/** Frames a segment occupies: a scene's configured duration, or footage's declared one. */
export function segmentFrames(s) {
  return (isFootage(s) ? s.durationInFrames : s.config?.durationInFrames) ?? 0;
}

/** The file a segment contributes to the concat. */
export function segmentPath(s) {
  return isFootage(s) ? s.segmentPath : sceneOutputPath(s.path, s.config);
}

/** A human label for a segment. */
export function segmentName(s) {
  return (isFootage(s) ? s.name ?? s.footage : s.config?.name) ?? null;
}

/**
 * Where each segment lands on the film timeline (v0.22).
 *
 * Every doc and the synthesize_sfx tool description call this a scene's
 * `filmOffset` — "a chime on every scene cut is a plain map over your scene
 * offsets" — but until now nothing returned it, so callers had to accumulate
 * durations by hand and a single slip silently desynced narration from
 * picture. The numbers were always here; this just hands them back.
 *
 * Footage entries report the same `filmOffset`/`startSeconds` fields as scenes,
 * so "where does segment 6 start" is answered identically regardless of kind —
 * an agent placing a caption or an audio cue should not have to care.
 *
 * @param {Array} scenes [{ kind, sceneId|footage, config?, durationInFrames? }] in play order
 * @param {number} [fps] rate for startSeconds; defaults to the first scene's
 */
export function filmLayout(scenes, fps = null) {
  const rate = fps ?? scenes.find((s) => !isFootage(s))?.config?.fps ?? null;
  let filmOffset = 0;
  return scenes.map((s) => {
    const durationInFrames = segmentFrames(s);
    const entry = {
      kind: s.kind ?? 'scene',
      ...(isFootage(s) ? { footage: s.footage } : { sceneId: s.sceneId }),
      ...(s.slug ? { slug: s.slug } : {}),
      name: segmentName(s),
      filmOffset,
      durationInFrames,
      startSeconds: rate ? Number((filmOffset / rate).toFixed(3)) : 0,
    };
    filmOffset += durationInFrames;
    return entry;
  });
}

/**
 * Validate a scene list. `scenes` = [{ sceneId, path, config }] in play order.
 * Throws EngineError on any problem; returns { format, fps, signature } on success.
 *
 * `requireRendered: false` skips the "already rendered" check — used by the
 * planning path, which answers "where will each scene land?" BEFORE the
 * scenes exist, which is exactly when you need the offsets to place audio.
 */
export function validateScenes(scenes, { hasMasterAudio = false, requireRendered = true } = {}) {
  if (!scenes.length) throw new EngineError(ErrorCodes.INCONSISTENT_SCENES, 'a film needs at least one segment');

  // The encode contract comes from the first SCENE, because only a scene carries
  // a config the engine authored. A film made entirely of footage has no such
  // voice: its segments are files, already encoded, and the only honest check is
  // that they exist — planFilm's footage_signature_mismatch is where a probed
  // disagreement is reported, from measurements this function does not have.
  const firstScene = scenes.find((s) => !isFootage(s));
  const format = firstScene?.config.output?.format ?? 'mp4';
  const fmt = getFormat(format);
  if (!fmt.copyConcat) {
    throw new EngineError(ErrorCodes.INCONSISTENT_SCENES,
      `format "${format}" cannot be losslessly concatenated — render scenes as mp4, webm, or prores`, { format });
  }

  const signature = firstScene ? sceneSignature(firstScene.config) : null;
  const mismatched = signature
    ? scenes.filter((s) => !isFootage(s) && sceneSignature(s.config) !== signature)
    : [];
  if (mismatched.length) {
    throw new EngineError(ErrorCodes.INCONSISTENT_SCENES,
      `all scenes must share resolution/fps/format/pixfmt (expected ${signature})`,
      { expected: signature, mismatched: mismatched.map((s) => ({ sceneId: s.sceneId, signature: sceneSignature(s.config) })) });
  }

  // Footage is never "rendered" and has no sidecar — it is a file the user
  // supplied, so there is nothing to re-render and nothing to go stale.
  const renderable = scenes.filter((s) => !isFootage(s));
  const unrendered = requireRendered
    ? renderable.filter((s) => !fs.existsSync(sceneOutputPath(s.path, s.config)))
    : [];
  if (unrendered.length) {
    throw new EngineError(ErrorCodes.SCENE_NOT_RENDERED,
      'render these scenes before assembling the film — nothing found at the expected output path ' +
        '(if you rendered with a custom outputFilename, re-render with the default): ' +
        unrendered.map((s) => `${s.sceneId} → ${path.relative(s.path, sceneOutputPath(s.path, s.config))}`).join(', '),
      {
        unrendered: unrendered.map((s) => s.sceneId),
        expected: Object.fromEntries(unrendered.map((s) => [s.sceneId, sceneOutputPath(s.path, s.config)])),
      });
  }

  // A file rendered at settings that have since changed is worse than a
  // missing one: it exists, so every existence check passes, and the film
  // assembles at a length its own plan disagrees with.
  const stale = requireRendered
    ? renderable
      .map((s) => ({ s, st: renderStaleness(readRenderMeta(s.path, s.config), s.config) }))
      .filter((x) => x.st)
    : [];
  if (stale.length) {
    throw new EngineError(ErrorCodes.STALE_RENDER,
      're-render these scenes: their output was rendered at settings that have since changed — ' +
        stale.map(({ s, st }) => `${s.sceneId} (${describeStaleness(st)})`).join('; '),
      {
        stale: stale.map(({ s, st }) => ({
          sceneId: s.sceneId, changed: st.changed, recorded: st.recorded, current: st.current,
        })),
      });
  }

  // Concatenating a mix of with-audio and silent segments with `-c copy` fails.
  // Footage is silent by contract, so it counts as a silent segment — which is
  // why a film mixing footage with audio-carrying scenes needs a master timeline.
  // That is the normal shape for such a film, not a workaround.
  if (!hasMasterAudio) {
    const withAudio = renderable.filter((s) => sceneHasAudio(s.config));
    const states = new Set([
      ...renderable.map((s) => sceneHasAudio(s.config)),
      ...(scenes.length > renderable.length ? [false] : []),
    ]);
    if (states.size > 1) {
      throw new EngineError(ErrorCodes.INCONSISTENT_SCENES,
        'segments mix audio and silence — render the scenes consistently, or pass a master `audio` timeline to lay ' +
        'over the whole film (footage is always silent, so a film combining footage with audio-carrying scenes ' +
        'needs one)',
        { withAudio: withAudio.map((s) => s.sceneId) });
    }
  } else if (!fmt.audioArgs) {
    throw new EngineError(ErrorCodes.INCONSISTENT_SCENES, `format "${format}" cannot carry audio`, { format });
  }

  return { format, fps: firstScene?.config.fps ?? null, signature };
}

/**
 * Assemble validated segments into `outputPath`.
 *
 * This function is indifferent to where a segment came from: it concatenates a
 * list of signature-matched files and lays the master audio over the result.
 * That is why footage on the timeline needed no new machinery — only a second
 * kind of entry in an ordered list, and the accessors above to read it.
 *
 * @param {object}  opts
 * @param {Array}   opts.scenes         validated segments, scenes and/or footage
 * @param {number}  [opts.fps]          rate; defaults to the first scene's config
 * @param {string}  opts.format         shared output format
 * @param {string}  opts.outputPath     absolute destination
 * @param {Array}   [opts.audioTracks]  master audio: [{ src(abs), startInFrames?, gainDb? }]
 * @param {string}  [opts.assetRoot]  root the audio srcs resolve against
 * @param {boolean} [opts.audioLimiter=true]  brick-wall the mix at -1 dBFS
 * @param {number}  [opts.audioTargetPeakDb]  measure the mix and re-mux once so it
 *   peaks here (e.g. -2). Preserves the relative balance between tracks — every
 *   gain moves by the same offset.
 * @returns {{ scenes, totalFrames, durationSeconds, fps, format, hasAudio, outputPath, audio? }}
 */
export async function assembleFilm({
  scenes, format, outputPath, audioTracks, assetRoot,
  audioLimiter = true, audioTargetPeakDb, fps: fpsOverride = null,
  ffmpegPath = 'ffmpeg', onSpawn,
}) {
  // An all-footage film has no scene config to read a rate from, so the caller
  // passes one (resolveFilmForBuild takes it from sceneDefaults).
  const fps = fpsOverride ?? scenes.find((s) => !isFootage(s))?.config?.fps ?? null;
  const segmentPaths = scenes.map(segmentPath);
  const totalFrames = scenes.reduce((sum, s) => sum + segmentFrames(s), 0);
  const videoDurationSec = totalFrames / fps;
  const output = { format, audioLimiter };
  let audio;

  if (audioTracks && audioTracks.length) {
    if (audioTargetPeakDb != null && !(audioTargetPeakDb >= -60 && audioTargetPeakDb <= 0)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG,
        `audioTargetPeakDb must be between -60 and 0 (got ${audioTargetPeakDb})`, { audioTargetPeakDb });
    }

    // Concat the video, then lay the master audio over the full length. The
    // silent concat is kept until we are done: a target-peak correction re-muxes
    // from it, which costs seconds, where redoing the concat would not.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-film-'));
    const silent = path.join(tmp, `video${getFormat(format).ext}`);
    try {
      await concatSegments({ segmentPaths, outputPath: silent, ffmpegPath, onSpawn });
      const mux = (tracks) => muxAudio({
        videoPath: silent, audioTracks: tracks, outputPath, fps, assetRoot,
        output, ffmpegPath, onSpawn, videoDurationSec,
      });

      await mux(audioTracks);
      let levels = await measureAudioLevels({ filePath: outputPath, ffmpegPath, onSpawn }).catch(() => null);

      // One correction pass. Shifting every track by the same offset keeps the
      // balance the caller chose; re-measuring proves the result rather than
      // assuming the shift landed (the limiter may still be in the way).
      let appliedOffsetDb;
      if (audioTargetPeakDb != null && levels?.peakDb != null
          && Math.abs(audioTargetPeakDb - levels.peakDb) > TARGET_TOLERANCE_DB) {
        appliedOffsetDb = Number((audioTargetPeakDb - levels.peakDb).toFixed(2));
        await mux(audioTracks.map((t) => ({ ...t, gainDb: (t.gainDb ?? 0) + appliedOffsetDb })));
        levels = await measureAudioLevels({ filePath: outputPath, ffmpegPath, onSpawn }).catch(() => null);
      }

      audio = {
        tracks: audioTracks.length,
        limiter: audioLimiter,
        ...(levels ?? {}),
        ...(levels?.peakDb != null ? { clipping: levels.peakDb >= CLIPPING_DBFS } : {}),
        ...(appliedOffsetDb != null ? { appliedOffsetDb } : {}),
        ...(audioTargetPeakDb != null ? { targetPeakDb: audioTargetPeakDb } : {}),
      };
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    await concatSegments({ segmentPaths, outputPath, ffmpegPath, onSpawn });
  }

  return {
    scenes: scenes.length,
    // Where each segment landed — the `filmOffset` the docs reference. Returned
    // so a caller never has to re-derive what this function already knows, and
    // reported identically for footage and scenes.
    sceneLayout: filmLayout(scenes, fps),
    totalFrames,
    durationSeconds: Number(videoDurationSec.toFixed(3)),
    fps,
    format,
    // Footage is silent, so it can only contribute audio via the master timeline.
    hasAudio: !!(audioTracks && audioTracks.length)
      || sceneHasAudio(scenes.find((s) => !isFootage(s))?.config ?? {}),
    outputPath,
    ...(audio ? { audio } : {}),
  };
}
