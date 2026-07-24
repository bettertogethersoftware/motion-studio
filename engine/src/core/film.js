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
import { concatSegments, muxAudio } from './encoder.js';

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
 * Validate a scene list. `scenes` = [{ projectId, path, config }] in play order.
 * Throws EngineError on any problem; returns { format, fps, signature } on success.
 */
export function validateScenes(scenes, { hasMasterAudio = false } = {}) {
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

  const unrendered = scenes.filter((s) => !fs.existsSync(sceneOutputPath(s.path, s.config)));
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
 * @returns {{ scenes, totalFrames, durationSeconds, fps, format, hasAudio, outputPath }}
 */
export async function assembleFilm({ scenes, format, outputPath, audioTracks, projectRoot, ffmpegPath = 'ffmpeg', onSpawn }) {
  const fps = scenes[0].config.fps;
  const segmentPaths = scenes.map((s) => sceneOutputPath(s.path, s.config));
  const totalFrames = scenes.reduce((sum, s) => sum + s.config.durationInFrames, 0);
  const videoDurationSec = totalFrames / fps;
  const output = { format };

  if (audioTracks && audioTracks.length) {
    // Concat the video, then lay the master audio over the full length.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-film-'));
    const silent = path.join(tmp, `video${getFormat(format).ext}`);
    try {
      await concatSegments({ segmentPaths, outputPath: silent, ffmpegPath, onSpawn });
      await muxAudio({ videoPath: silent, audioTracks, outputPath, fps, projectRoot, output, ffmpegPath, onSpawn, videoDurationSec });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    await concatSegments({ segmentPaths, outputPath, ffmpegPath, onSpawn });
  }

  return {
    scenes: scenes.length,
    totalFrames,
    durationSeconds: Number(videoDurationSec.toFixed(3)),
    fps,
    format,
    hasAudio: !!(audioTracks && audioTracks.length) || sceneHasAudio(scenes[0].config),
    outputPath,
  };
}
