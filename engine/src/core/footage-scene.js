/**
 * Turning supplied footage into a scene (v0.28).
 *
 * A film's play order holds two kinds of segment. **Footage** is the human's
 * own file, joined as-is: nothing re-encodes it, nothing renders it, and
 * therefore nothing can change a single pixel of it. A **scene** is a
 * composition that the render browser draws frame by frame, which is where
 * every creative operation in this product lives — masks, transforms, speed,
 * colour, transitions, anything that has to be a function of the frame.
 *
 * So "the AI can't do that to my clip" has exactly one cure: put the clip
 * inside a composition. That is what this module does, and it is a real
 * conversion rather than a flag on the document:
 *
 *   1. The render browser CANNOT DECODE H.264 (see docs/frame-api.md §11).
 *      Timeline footage is whatever the film's delivery codec is — normally
 *      H.264 in .mp4 — so the clip is first transcoded to VP9 .webm with a
 *      short keyframe interval, which is what makes per-frame seeking cheap.
 *   2. A scene is scaffolded at the FILM's geometry, its length set to the
 *      segment's exact frame count, so the cut does not move by one frame.
 *   3. Its composition seeks one frame of the clip per frame of output —
 *      never `play()`, which would make the picture a function of wall-clock
 *      time and give each parallel render worker a different moment.
 *   4. Only then does the play order change, so a failed transcode leaves an
 *      unused scene folder rather than a film that no longer plays.
 *
 * The invariant that makes this safe to offer: **the new scene is a visual
 * no-op**. Full-bleed, same geometry, same frame count, same in-point — it
 * looks like the clip until somebody edits it. A conversion that changed what
 * you see would be a bug, not a feature.
 *
 * What it costs, stated plainly because it is not free: one extra encode into
 * VP9, one full frame-by-frame render, and the film's own encode at build. Two
 * generations of loss the raw clip did not have. The original file is left
 * untouched in the film's `assets/`, so the segment can be put back.
 *
 * What it BUYS beyond the one scene: once the clip is a seekable .webm, any
 * number of further scenes can seek their own ranges of it at no extra
 * transcode cost. That is the answer for a long recording — promote once,
 * then carve it into short scenes, which is the shape the engine wants anyway
 * (`create_scene` warns past ~90 seconds).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { EngineError, ErrorCodes } from './errors.js';
import { makeConfig, scaffoldSceneFiles, SCENE_CONFIG, slugify } from './scene.js';
import { checkSlug } from './store.js';
import { planFilm } from './films.js';
import { transcodeAsset } from './transcode.js';

/** The seekable intermediate. VP9 because the render browser can decode it. */
export const CLIP_FILENAME = 'clip.webm';
/**
 * Keyframe interval for the intermediate. A composition seeks to an arbitrary
 * frame on every single frame of output; with a default GOP (250+) each seek
 * decodes from a distant keyframe and the render crawls. Ten is the value
 * `transcode_asset` already recommends for exactly this use.
 */
export const CLIP_GOP = 10;
/** CRF for VP9. This file is an intermediate, so it is generous on purpose. */
export const CLIP_QUALITY = 28;

/**
 * The composition that reproduces a clip exactly.
 *
 * Deliberately the smallest thing that can be true: one `<video>`, one seek
 * per frame, `object-fit: cover` on a stage that is already the clip's own
 * geometry (so it is a no-op that survives someone later changing the scene's
 * size). Everything an author would want to add — a mask, a transform, a
 * grade, a title — is added around this, and the comments say where.
 */
export function footageCompositionFiles({ name, fps, width, height, durationInFrames, clipFile = CLIP_FILENAME }) {
  const safeName = String(name ?? 'Clip');
  return {
    'composition.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(safeName)}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <!--
    ${escapeHtml(safeName)} — a supplied clip, made editable.

    This scene started life as a footage segment on the film timeline. It is
    the same picture: ${width}x${height} @ ${fps}fps, ${durationInFrames} frames,
    playing from the clip's first frame. Everything you add goes on top of
    (or instead of) #clip, and the scene renders like any other.

    The file is VP9 .webm, not the original .mp4, because the render browser
    cannot decode H.264. Keep it that way if you replace it.
  -->
  <div id="stage">
    <video id="clip" src="assets/${clipFile}" muted preload="auto" playsinline></video>
    <!-- Add layers here. They draw over the clip. -->
  </div>

  <script src="frame-api.js"></script>
  <script src="composition.js"></script>
</body>
</html>
`,
    'styles.css': `/* ${safeName} — a supplied clip, made editable.
 *
 * Same rules as any composition: the stage is exactly the render resolution,
 * and no CSS transition/animation with a real-time duration — motion is set
 * per frame from composition.js.
 */

html, body {
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #000;
}

#stage {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
}

/* Full-bleed, so this scene is the clip until you make it something else.
   \`cover\` rather than a bare width/height: if the scene is ever resized, a
   letterbox is a better failure than a stretch. */
#clip {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  will-change: opacity, transform;
}
`,
    'composition.js': `/*
 * ${safeName} — a supplied clip, made editable.
 *
 * The clip is driven by seekVideo(), never play(): one frame of footage per
 * frame of output. play() would make the picture a function of wall-clock
 * time, and under parallel rendering each worker would capture a different
 * moment. See docs/frame-api.md §11.
 */

/* global MotionStudio, seekVideo, interpolate, Sequence */

const FPS = ${fps};
const DURATION = ${durationInFrames}; // total frames
/* Where this scene starts inside the clip, in seconds. 0 reproduces the
 * segment exactly; raise it to use a later part of the same file — no
 * re-transcode needed, and another scene can seek a different range of it. */
const IN_POINT = 0;

const clip = document.getElementById('clip');

MotionStudio.registerComposition(async (frame) => {
  // The MIDDLE of frame n, not its edge. A frame occupies [n/fps, (n+1)/fps),
  // and the container stores its timestamp rounded (WebM to a millisecond) —
  // so seeking to the edge can land a fraction on the wrong side of it. Half a
  // frame in is unambiguous however the rounding went.
  await seekVideo(clip, IN_POINT + (frame + 0.5) / FPS, { fps: FPS });

  // Everything below is yours. A fade at the head, for example:
  //   clip.style.opacity = interpolate(frame, [0, FPS], [0, 1]);
  // or a slow push in:
  //   const k = interpolate(frame, [0, DURATION - 1], [1, 1.08]);
  //   clip.style.transform = \`scale(\${k})\`;
});
`,
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Convert one footage segment into a scene that plays it.
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.filmId          qualified film id
 * @param {string} opts.segmentId       the footage segment's stable `id`
 * @param {string} [opts.name]          scene display name (default: the clip's label/filename)
 * @param {string} [opts.slug]          explicit slug; taken → scene_already_exists
 * @param {string} opts.ffmpegPath
 * @param {string} opts.ffprobePath
 * @param {boolean} [opts.keepFootage]  leave the play order alone (default false)
 * @param {AbortSignal} [opts.signal]
 * @param {(phase: string) => void} [opts.onPhase]
 * @param {(pid: number) => void} [opts.onSpawn]
 * @returns {Promise<{scene, name, path, config, clip, replaced, warnings}>}
 */
export async function sceneFromFootage({
  store, filmId, segmentId, name = undefined, slug = undefined,
  durationInFrames: wantFrames = undefined,
  ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe',
  keepFootage = false, signal, onPhase = () => {}, onSpawn,
}) {
  const film = await store.getFilm(filmId);
  const index = (film.scenes ?? []).findIndex((s) => s?.footage !== undefined && s.id === segmentId);
  if (index < 0) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      `No footage segment with id "${segmentId}" in ${filmId}. get_film lists each clip's id.`,
      { film: filmId, segmentId });
  }
  const ref = film.scenes[index];

  onPhase('planning');
  const plan = await planFilm({ film, store, ffprobePath });
  const planned = plan.scenes.find((s) => s.kind === 'footage' && s.id === segmentId) ?? {};
  if (planned.missing) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
      `The clip for segment "${segmentId}" is missing from the film's assets/ — nothing to convert`,
      { film: filmId, segmentId, footage: ref.footage });
  }

  /*
   * The scene must match the film's ESTABLISHED signature — what its first
   * resolved segment sets, which is what every other segment has to concat
   * with — not `sceneDefaults`, which is only the film's declared preference
   * for brand-new scenes.
   *
   * They differ exactly where it matters. A film whose first segment IS a
   * 60fps clip runs its whole timeline at 60: building this scene from a
   * `sceneDefaults.fps` of 30 would make the one segment that does not fit.
   * `planFilm` already falls back to `sceneDefaults` when nothing has
   * established a rate, so this is the complete rule rather than the first
   * half of one.
   */
  const anchor = plan.scenes.find((s) => !s.missing && s.width > 0) ?? {};
  const width = anchor.width ?? film.sceneDefaults?.width ?? planned.width;
  const height = anchor.height ?? film.sceneDefaults?.height ?? planned.height;
  const fps = plan.fps ?? film.sceneDefaults?.fps ?? planned.fps;
  const durationInFrames = Number.isInteger(wantFrames) && wantFrames > 0 ? wantFrames : ref.durationInFrames;
  if (!(width > 0 && height > 0 && fps > 0 && durationInFrames > 0)) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      'Cannot tell the film\'s geometry — it needs a probed clip or sceneDefaults before a clip can become a scene',
      { film: filmId, width, height, fps, durationInFrames });
  }

  /*
   * Is there enough film in the file to fill the scene? Asked BEFORE the
   * transcode, because the answer is already known and the transcode is the
   * expensive part.
   *
   * A footage segment states its length as a frame COUNT, which `planFilm`
   * verifies against the file — and then the timeline reads that count at the
   * FILM's rate. Those are the same number only while the clip's rate and the
   * film's agree. A 60fps clip of 2924 frames is 48.73s of file and 97.47s of
   * a 30fps film, so a scene built to the declared count has half its length
   * with nothing to show, and freezes on the last frame.
   *
   * That segment was already unbuildable — it is what `footage_signature_
   * mismatch` means — so this refuses rather than producing the freeze, and
   * names both ways out: convert it at its real length (and accept that the
   * film gets shorter), or conform the clip to the film first and keep the cut.
   */
  const clipFps = planned.fps ?? fps;
  const clipSeconds = (planned.actualFrames ?? ref.durationInFrames) / clipFps;
  const sceneSeconds = durationInFrames / fps;
  if (clipSeconds + 1 / fps < sceneSeconds) {
    const fits = Math.max(1, Math.floor(clipSeconds * fps));
    throw new EngineError(ErrorCodes.INVALID_FILM,
      `This clip cannot fill a ${durationInFrames}-frame scene: it is ${clipSeconds.toFixed(2)}s of video and the `
      + `scene would be ${sceneSeconds.toFixed(2)}s, so ${(sceneSeconds - clipSeconds).toFixed(2)}s of it would `
      + `freeze on the last frame.`
      + (clipFps !== fps
        ? ` The clip is ${clipFps}fps and the film is ${fps}fps, which is why the same ${ref.durationInFrames} `
          + 'frames mean different lengths to each of them — the segment is already a footage_signature_mismatch '
          + 'and would refuse to build.'
        : '')
      + ` Either convert it at its real length (durationInFrames: ${fits}, which shortens the film by `
      + `${(sceneSeconds - clipSeconds).toFixed(2)}s), or conform the clip with transcode_asset { matchFilm } first `
      + 'and keep the cut as it is.',
      {
        film: filmId, segmentId, clipFps, filmFps: fps,
        clipSeconds: Number(clipSeconds.toFixed(3)),
        sceneSeconds: Number(sceneSeconds.toFixed(3)),
        durationInFramesThatFits: fits,
      });
  }

  const sceneName = (typeof name === 'string' && name.trim())
    ? name.trim()
    : (ref.label ?? path.basename(String(ref.footage)).replace(/\.[a-z0-9]+$/i, '') ?? 'Clip');

  const taken = (candidate) => fs.existsSync(path.join(store.scenePath(`${film.id}/${candidate}`), SCENE_CONFIG));
  let sceneSlug;
  if (slug !== undefined && slug !== null && String(slug).trim() !== '') {
    sceneSlug = checkSlug(String(slug).trim(), 'scene');
    if (taken(sceneSlug)) {
      throw new EngineError(ErrorCodes.SCENE_ALREADY_EXISTS,
        `A scene already exists at ${film.id}/${sceneSlug}`, { sceneId: `${film.id}/${sceneSlug}` });
    }
  } else {
    // A derived slug dedupes rather than failing: converting the same plate
    // twice is a normal ask, and the second one is not a mistake.
    const base = checkSlug(slugify(sceneName) || 'clip', 'scene');
    sceneSlug = base;
    for (let n = 2; taken(sceneSlug); n += 1) sceneSlug = checkSlug(`${base}-${n}`, 'scene');
  }

  const sceneId = `${film.id}/${sceneSlug}`;
  const scenePath = store.scenePath(sceneId);
  const preexisting = fs.existsSync(scenePath);
  const config = makeConfig({ name: sceneName, fps, width, height, durationInFrames });

  const warnings = [];
  let clipResult = null;
  try {
    onPhase('scaffolding');
    // Scaffolded directly rather than through store.createScene, because that
    // appends to the play order — and nothing may touch the play order until
    // the expensive step below has actually produced a file.
    await scaffoldSceneFiles(scenePath, config);
    for (const [file, content] of Object.entries(footageCompositionFiles({
      name: sceneName, fps, width, height, durationInFrames,
    }))) {
      await fsp.writeFile(path.join(scenePath, file), content, 'utf8');
    }

    onPhase('transcoding');
    clipResult = await transcodeAsset({
      sourceAbs: path.join(store.filmPath(film.id), String(ref.footage).replace(/\\/g, '/')),
      outPath: path.join(scenePath, 'assets', CLIP_FILENAME),
      mode: 'video',
      scale: { width, height },
      fps,
      // Silent by construction: footage on a timeline is already required to
      // be, and a composition has no use for an audio track it cannot mix.
      audio: false,
      video: { quality: CLIP_QUALITY, gop: CLIP_GOP },
      fpsForFrames: fps,
      ffmpegPath, ffprobePath, signal, onSpawn, onPhase,
    });
  } catch (err) {
    // Only a folder this call created is ours to remove.
    if (!preexisting) await fsp.rm(scenePath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // The clip must cover the range the scene will seek, or the tail freezes on
  // the last decodable frame. On a film whose signature the clip already
  // matches this cannot happen; it is the MISMATCHED clip that lands here, so
  // the warning names the cause rather than only the symptom.
  const needSeconds = durationInFrames / fps;
  if (Number.isFinite(clipResult?.durationSeconds) && clipResult.durationSeconds + 1 / fps < needSeconds) {
    const cause = planned.fps && planned.fps !== fps
      ? ` The clip is ${planned.fps}fps and the film is ${fps}fps, which is why: `
        + `${durationInFrames} frames is ${(durationInFrames / planned.fps).toFixed(2)}s of the file but `
        + `${needSeconds.toFixed(2)}s of this film.`
      : '';
    warnings.push(`The converted clip is ${clipResult.durationSeconds.toFixed(2)}s but the scene is `
      + `${needSeconds.toFixed(2)}s — the tail will hold on its last frame.${cause}`
      + ' Shorten the scene to match, or conform the clip with transcode_asset first.');
  }

  let replaced = false;
  if (!keepFootage) {
    onPhase('swapping');
    // The scene takes the clip's PLACE, carrying its sequence label across —
    // otherwise converting a clip silently drops it out of its narrative band.
    const scenes = film.scenes.map((s, i) => (i === index
      ? { slug: sceneSlug, ...(ref.sequence ? { sequence: ref.sequence } : {}) }
      : s));
    await store.updateFilm(film.id, { scenes });
    replaced = true;
  }

  return {
    scene: sceneId,
    name: sceneName,
    path: scenePath,
    config,
    clip: {
      file: `assets/${CLIP_FILENAME}`,
      from: ref.footage,
      bytes: clipResult?.bytes ?? null,
      frames: clipResult?.frames ?? null,
      durationSeconds: clipResult?.durationSeconds ?? null,
    },
    replaced,
    warnings,
  };
}
