/**
 * Film assembly (v0.9) — stitch already-rendered scene projects into one film.
 *
 * Motion Studio renders one composition per project. A long-form film is many
 * short scene projects concatenated end to end. This module does the *assembly*
 * step (it renders nothing): validate that the scenes are compatible, then merge
 * their output files losslessly (`-c copy`, via the same encoder.concatSegments
 * the parallel renderer uses) and, optionally, mux one master-audio timeline
 * over the whole thing (encoder.muxAudio).
 *
 *   scene projects (each already rendered)
 *     → validateScenes()  — same resolution/fps/format/pixfmt, all rendered
 *     → assembleFilm()    — concat outputs (+ optional master audio) → one file
 *
 * Rendering each scene stays with the existing `render` tool: transparent,
 * async, resumable. See docs/film-setup.md.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';
import { getFormat } from './formats.js';
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

/** Where a scene project's rendered file lives (what `render` wrote). */
export function sceneOutputPath(projectPath, cfg) {
  const o = cfg.output ?? {};
  return path.join(projectPath, o.dir ?? 'out', o.filename ?? 'output.mp4');
}

/** Does a scene's rendered file carry an audio stream? (config.audio + audio-capable format) */
export function sceneHasAudio(cfg) {
  const fmt = getFormat(cfg.output?.format ?? 'mp4');
  return (cfg.audio?.length ?? 0) > 0 && !!fmt.audioArgs;
}

/**
 * Where each scene lands on the film timeline (v0.22).
 *
 * Every doc and the synthesize_sfx tool description call this a scene's
 * `filmOffset` — "a chime on every scene cut is a plain map over your scene
 * offsets" — but until now nothing returned it, so callers had to accumulate
 * durations by hand and a single slip silently desynced narration from
 * picture. The numbers were always here; this just hands them back.
 *
 * @param {Array} scenes [{ projectId, config }] in play order
 */
export function filmLayout(scenes) {
  let filmOffset = 0;
  return scenes.map((s) => {
    const durationInFrames = s.config.durationInFrames;
    const entry = {
      projectId: s.projectId,
      name: s.config.name,
      filmOffset,
      durationInFrames,
      startSeconds: Number((filmOffset / s.config.fps).toFixed(3)),
    };
    filmOffset += durationInFrames;
    return entry;
  });
}

/**
 * Validate a scene list. `scenes` = [{ projectId, path, config }] in play order.
 * Throws EngineError on any problem; returns { format, fps, signature } on success.
 *
 * `requireRendered: false` skips the "already rendered" check — used by the
 * planning path, which answers "where will each scene land?" BEFORE the
 * scenes exist, which is exactly when you need the offsets to place audio.
 */
export function validateScenes(scenes, { hasMasterAudio = false, requireRendered = true } = {}) {
  if (!scenes.length) throw new EngineError(ErrorCodes.INCONSISTENT_SCENES, 'a film needs at least one scene');

  const format = scenes[0].config.output?.format ?? 'mp4';
  const fmt = getFormat(format);
  if (!fmt.copyConcat) {
    throw new EngineError(ErrorCodes.INCONSISTENT_SCENES,
      `format "${format}" cannot be losslessly concatenated — render scenes as mp4, webm, or prores`, { format });
  }

  const signature = sceneSignature(scenes[0].config);
  const mismatched = scenes.filter((s) => sceneSignature(s.config) !== signature);
  if (mismatched.length) {
    throw new EngineError(ErrorCodes.INCONSISTENT_SCENES,
      `all scenes must share resolution/fps/format/pixfmt (expected ${signature})`,
      { expected: signature, mismatched: mismatched.map((s) => ({ projectId: s.projectId, signature: sceneSignature(s.config) })) });
  }

  const unrendered = requireRendered
    ? scenes.filter((s) => !fs.existsSync(sceneOutputPath(s.path, s.config)))
    : [];
  if (unrendered.length) {
    throw new EngineError(ErrorCodes.SCENE_NOT_RENDERED,
      'render these scenes before assembling the film — nothing found at the expected output path ' +
        '(if you rendered with a custom outputFilename, re-render with the default): ' +
        unrendered.map((s) => `${s.projectId} → ${path.relative(s.path, sceneOutputPath(s.path, s.config))}`).join(', '),
      {
        unrendered: unrendered.map((s) => s.projectId),
        expected: Object.fromEntries(unrendered.map((s) => [s.projectId, sceneOutputPath(s.path, s.config)])),
      });
  }

  // Concatenating a mix of with-audio and silent scenes with `-c copy` fails.
  if (!hasMasterAudio) {
    const states = new Set(scenes.map((s) => sceneHasAudio(s.config)));
    if (states.size > 1) {
      throw new EngineError(ErrorCodes.INCONSISTENT_SCENES,
        'scenes mix audio and silence — render them consistently, or pass a master `audio` timeline to lay over the whole film',
        { withAudio: scenes.filter((s) => sceneHasAudio(s.config)).map((s) => s.projectId) });
    }
  } else if (!fmt.audioArgs) {
    throw new EngineError(ErrorCodes.INCONSISTENT_SCENES, `format "${format}" cannot carry audio`, { format });
  }

  return { format, fps: scenes[0].config.fps, signature };
}

/**
 * Assemble validated scenes into `outputPath`.
 * @param {object}  opts
 * @param {Array}   opts.scenes         [{ projectId, path, config }] (validated)
 * @param {string}  opts.format         shared output format
 * @param {string}  opts.outputPath     absolute destination
 * @param {Array}   [opts.audioTracks]  master audio: [{ src(abs), startInFrames?, gainDb? }]
 * @param {string}  [opts.projectRoot]  root the audio srcs resolve against
 * @param {boolean} [opts.audioLimiter=true]  brick-wall the mix at -1 dBFS
 * @param {number}  [opts.audioTargetPeakDb]  measure the mix and re-mux once so it
 *   peaks here (e.g. -2). Preserves the relative balance between tracks — every
 *   gain moves by the same offset.
 * @returns {{ scenes, totalFrames, durationSeconds, fps, format, hasAudio, outputPath, audio? }}
 */
export async function assembleFilm({
  scenes, format, outputPath, audioTracks, projectRoot,
  audioLimiter = true, audioTargetPeakDb,
  ffmpegPath = 'ffmpeg', onSpawn,
}) {
  const fps = scenes[0].config.fps;
  const segmentPaths = scenes.map((s) => sceneOutputPath(s.path, s.config));
  const totalFrames = scenes.reduce((sum, s) => sum + s.config.durationInFrames, 0);
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
        videoPath: silent, audioTracks: tracks, outputPath, fps, projectRoot,
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
    // Where each scene landed — the `filmOffset` the docs reference. Returned
    // so a caller never has to re-derive what this function already knows.
    sceneLayout: filmLayout(scenes),
    totalFrames,
    durationSeconds: Number(videoDurationSec.toFixed(3)),
    fps,
    format,
    hasAudio: !!(audioTracks && audioTracks.length) || sceneHasAudio(scenes[0].config),
    outputPath,
    ...(audio ? { audio } : {}),
  };
}
