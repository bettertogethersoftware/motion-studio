/**
 * Turning a still image into a scene (v0.28).
 *
 * A film's play order holds scenes and footage. A picture is neither — and the
 * tempting fix, a third kind of segment that just holds an image for N frames,
 * is the one this deliberately does not build. It would teach every "is this a
 * scene?" walk in the codebase a third answer (the omission that produced
 * BUG-2), and it would buy something strictly WEAKER than a scene: a still
 * segment could only sit there, while a scene can be pushed in on, have a title
 * laid over it, cross-fade its own contents — and can be opened and directed,
 * which is the whole shape of the product.
 *
 * So `+ image` scaffolds an ordinary scene, and the play order receives an
 * ordinary `{slug}` entry that nothing downstream can distinguish from any
 * other. See docs/plans/timeline-footage-and-stills-plan.md §2 and §4.
 *
 * **Lighter than [footage-scene.js](footage-scene.js), which is the model.**
 * That one must transcode video to VP9 because the render browser cannot
 * decode H.264, and because a composition seeks a clip once per frame. A still
 * needs no ffmpeg to become usable: the extensions the asset sandbox admits
 * (.png/.jpg/.jpeg/.gif/.webp/.svg) are exactly the ones Chromium draws. The
 * expensive, failure-prone half of the existing function is simply absent —
 * copy the file in, write a composition, register the scene.
 *
 * ffmpeg is used for ONE thing here and it is optional: measuring the picture
 * (`core/picture.js`), so that cover-vs-contain is a decision with a reason
 * rather than a guess. When the measurement is unavailable — no ffmpeg, or an
 * `.svg`, which ffmpeg cannot decode — the fit falls back to `contain`, which
 * can letterbox but can never crop or stretch, and the result says the choice
 * was unmeasured instead of implying it was measured.
 *
 * Two things are reported rather than resolved, on purpose:
 *
 *   - **Transparency.** A cutout PNG over the film's background is a legitimate
 *     look, and so is a matted one. The measurement says which is happening.
 *   - **An animated GIF.** An `<img>` plays it on the wall clock, so each
 *     parallel render worker would capture a different moment. Named loudly,
 *     with the fix, rather than silently converted.
 *
 * Nothing outside the new scene folder is written until the play order is
 * appended to, which is the last thing that happens.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { EngineError, ErrorCodes } from './errors.js';
import { makeConfig, scaffoldSceneFiles, SCENE_CONFIG, slugify } from './scene.js';
import { resolveInTarget } from './sandbox.js';
import { checkSlug } from './store.js';
import { planFilm } from './films.js';
import { probeMedia } from './encoder.js';
import { measurePictureFacts, isStillImage } from './picture.js';

/**
 * A still has no natural length, so the caller picks one; this is what it
 * falls back to when neither the caller nor the film's `sceneDefaults` says.
 * Three seconds at 30fps — long enough to read a picture, short enough that
 * nobody mistakes it for a considered choice.
 */
export const DEFAULT_STILL_FRAMES = 90;

/**
 * How much of the image `cover` may crop before `contain` is the honest fit.
 *
 * A fifth, because that is where the real cases fall either side of the line: a
 * 16:9 frame covers a 16:10 screenshot (10% lost) and a 3:2 photograph (15.6%,
 * the standard move with a camera's own aspect), and letterboxes a 4:3 (25%), a
 * square (44%) and anything portrait. It is the point at which an author stops
 * calling it full bleed and starts calling it "you cut my picture".
 */
export const MAX_COVER_CROP = 0.2;

/**
 * The image extensions this accepts. It is the intersection of two lists that
 * already exist and must not be widened independently of either: what the asset
 * sandbox admits into `assets/` (`ASSET_EXTENSIONS`), and what the render
 * browser can draw. They happen to coincide today, which is why a still needs
 * no conversion step at all.
 */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** ffmpeg cannot decode SVG, so it is drawable but not measurable. */
const UNMEASURABLE = new Set(['.svg']);

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Neutralize a comment terminator, so a scene name cannot break the stylesheet it titles. */
const commentSafe = (s) => String(s).replace(/\*\//g, '* /');

/**
 * Choose how the image sits in the frame, and say why.
 *
 * Pure — bytes-free, ffmpeg-free — so every interesting case (a matching
 * aspect, a portrait plate in a landscape film, an image nothing could measure)
 * is a unit test rather than an encode.
 *
 * `cover` fills the frame and crops the overflow; `contain` fits the whole
 * picture and leaves background either side. Stretching is not one of the
 * options: `object-fit: fill` is the only way to make a still lie about its
 * subject, and no measurement should ever select it.
 *
 * @param {object} opts
 * @param {number} opts.width          the film's frame width
 * @param {number} opts.height         the film's frame height
 * @param {{width: number, height: number}|null} [opts.picture]  measured image size, or null
 * @returns {{mode: 'cover'|'contain', measured: boolean, cropFraction: number|null, reason: string}}
 */
export function chooseFit({ width, height, picture = null, maxCrop = MAX_COVER_CROP } = {}) {
  const iw = picture?.width;
  const ih = picture?.height;
  if (!(iw > 0 && ih > 0 && width > 0 && height > 0)) {
    return {
      mode: 'contain',
      measured: false,
      cropFraction: null,
      reason: 'the image could not be measured, so this is the fit that can never crop or stretch it — '
        + 'change it to `cover` if it should fill the frame',
    };
  }
  const frameAspect = width / height;
  const imageAspect = iw / ih;
  // The fraction of the image `cover` would push outside the frame, along
  // whichever axis loses. Symmetric by construction: it does not matter which
  // of the two is the wider shape.
  const cropFraction = 1 - Math.min(imageAspect, frameAspect) / Math.max(imageAspect, frameAspect);
  const pct = (n) => `${Math.round(n * 100)}%`;
  return cropFraction <= maxCrop
    ? {
      mode: 'cover',
      measured: true,
      cropFraction,
      reason: `the image is ${iw}x${ih} and the frame is ${width}x${height}, so filling the frame costs `
        + `${pct(cropFraction)} of the picture — change it to \`contain\` to keep every edge and letterbox instead`,
    }
    : {
      mode: 'contain',
      measured: true,
      cropFraction,
      reason: `the image is ${iw}x${ih} and the frame is ${width}x${height}, so \`cover\` would crop `
        + `${pct(cropFraction)} of the picture — it letterboxes on the stage background instead. Change it to `
        + '`cover` to fill the frame and lose the edges',
    };
}

/**
 * The composition that shows a still.
 *
 * **Deliberately plain, and that is the feature.** The reason to make a scene
 * rather than a segment is that the author can direct it afterwards, and nobody
 * directs a wall of generated cleverness. One `<img>`, one rule, one comment
 * saying which fit was chosen and how to flip it.
 */
export function imageCompositionFiles({
  name, fps, width, height, durationInFrames, imageFile, fit, source = null, transparent = false,
}) {
  const safeName = String(name ?? 'Still');
  const title = escapeHtml(safeName);
  const cssName = commentSafe(safeName);
  const origin = source ? `\n    The picture came from ${escapeHtml(source)}; the copy in assets/ is the one it draws.` : '';
  // Transparency is REPORTED, never resolved: a cutout over the film's
  // background and a matted one are both legitimate, and only the author knows
  // which was meant.
  const alphaNote = transparent
    ? '\n *\n * This image carries TRANSPARENCY, so the stage background set below is what shows through it.\n'
      + ' * Change that background to matte it against something else, or set output.transparent in scene.json\n'
      + ' * to carry the alpha all the way out of the render.'
    : '';
  return {
    'composition.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <!--
    ${title} — a still, held for ${durationInFrames} frames.

    ${width}x${height} @ ${fps}fps, like every other segment of this film.${origin}
    How it is fitted, and why, is the one rule in styles.css. Everything you
    add goes on top of (or instead of) #still, and the scene renders like any
    other — it is a scene precisely so that it can become more than a picture.
  -->
  <div id="stage">
    <img id="still" src="assets/${imageFile}" alt="" />
    <!-- Add layers here. They draw over the still. -->
  </div>

  <script src="frame-api.js"></script>
  <script src="composition.js"></script>
</body>
</html>
`,
    'styles.css': `/* ${cssName} — a still, held for ${durationInFrames} frames.
 *
 * Same rules as any composition: the stage is exactly the render resolution,
 * and no CSS transition/animation with a real-time duration — motion is set
 * per frame from composition.js.${alphaNote}
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

/* \`${fit.mode}\`: ${commentSafe(fit.reason)}. */
#still {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: ${fit.mode};
  will-change: opacity, transform;
}
`,
    'composition.js': `/*
 * ${commentSafe(safeName)} — a still, held for ${durationInFrames} frames.
 *
 * A still has nothing to compute per frame, so the frame function does the one
 * thing it must: make sure the picture is decoded before the engine screenshots
 * it. An undecoded image is a blank frame, and only the first frame of a render
 * is slow enough to catch it.
 *
 * This is where the scene stops being a picture. Move it, mask it, lay type
 * over it — the frame number is the only input any of that needs.
 */

/* global MotionStudio, interpolate, Sequence */

const FPS = ${fps};
const DURATION = ${durationInFrames}; // total frames

const still = document.getElementById('still');

MotionStudio.registerComposition(async (frame) => {
  // Resolved before the first capture; already resolved on every frame after it.
  await still.decode();

  // Everything below is yours. A slow push in, for example:
  //   const k = interpolate(frame, [0, DURATION - 1], [1, 1.08]);
  //   still.style.transform = \`scale(\${k})\`;
  // or a fade at the head:
  //   still.style.opacity = interpolate(frame, [0, FPS], [0, 1]);
});
`,
  };
}

/**
 * Scaffold a scene that displays a still, and append it to the film's play
 * order as an ordinary `{slug}` segment.
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.filmId            qualified film id
 * @param {string} opts.image             library-relative path, or "assets/…" when `imageFrom` is "film"
 * @param {'library'|'film'} [opts.imageFrom]  where to read it (default "library")
 * @param {string} [opts.name]            scene display name (default: the image's filename)
 * @param {string} [opts.slug]            explicit slug; taken → scene_already_exists
 * @param {number} [opts.durationInFrames]  scene length (default: the film's sceneDefaults, else 90)
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.ffprobePath]
 * @param {AbortSignal} [opts.signal]
 * @param {(pid: number) => void} [opts.onSpawn]
 * @returns {Promise<{scene, name, path, config, image, fit, picture, warnings}>}
 */
export async function sceneFromImage({
  store, filmId, image, imageFrom = 'library',
  name = undefined, slug = undefined, durationInFrames: wantFrames = undefined,
  ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', signal, onSpawn,
}) {
  const film = await store.getFilm(filmId);
  if (typeof image !== 'string' || !image.trim()) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      'An image path is required — a workspace-library path (list_shared_assets) or the film\'s own "assets/…" path',
      { film: filmId });
  }
  if (imageFrom !== 'library' && imageFrom !== 'film') {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      `imageFrom must be "library" or "film", got "${imageFrom}"`, { film: filmId, imageFrom });
  }

  /*
   * Resolved BEFORE anything is created, so a wrong path costs nothing and
   * leaves nothing behind. The library is the default because it is where a
   * human's pictures actually live; the film's own assets/ is the second case
   * (a plate that arrived with the film, or one an agent just wrote).
   */
  const wanted = String(image).trim().replace(/\\/g, '/');
  let sourceAbs, sourceRel;
  if (imageFrom === 'library') {
    const ws = String(film.id).split('/')[0];
    sourceAbs = store.libraryFilePath(ws, wanted);
    const st = await fsp.stat(sourceAbs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new EngineError(ErrorCodes.FILE_NOT_FOUND,
        `No such library file "${wanted}" (list_shared_assets shows what the library holds; pass `
        + 'imageFrom: "film" to use the film\'s own assets/ instead)',
        { path: wanted, workspace: ws });
    }
    sourceRel = wanted;
  } else {
    const located = await store.resolveMediaFile(film.id, wanted);
    sourceAbs = located.abs;
    sourceRel = located.path;
  }

  const ext = path.extname(sourceRel).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      `"${sourceRel}" is not an image this can place: ${ext || '(no extension)'} is not one of `
      + `${[...IMAGE_EXTENSIONS].join(' ')}. Those are the extensions the render browser draws directly; `
      + 'convert the file first, or use make_scene_from_footage if it is really video.',
      { path: sourceRel, extension: ext });
  }

  /*
   * The measurement, and the whole reason cover-vs-contain is a decision rather
   * than a guess. Optional by construction: probeMedia and measurePictureFacts
   * both answer null rather than throwing, an .svg is drawable but not
   * decodable by ffmpeg, and a machine without ffmpeg must still be able to put
   * a picture on a timeline. What changes without it is that the result SAYS
   * the fit was unmeasured.
   */
  const measurable = !UNMEASURABLE.has(ext);
  const media = measurable
    ? await probeMedia({ filePath: sourceAbs, ffprobePath, signal, onSpawn }).catch(() => null)
    : null;
  const picture = media?.video
    ? await measurePictureFacts({
      filePath: sourceAbs,
      width: media.video.width,
      height: media.video.height,
      pixFmt: media.video.pixFmt,
      ffmpegPath, signal, onSpawn,
    }).catch(() => null)
    : null;

  /*
   * The scene must match the film's ESTABLISHED signature — what its first
   * resolved segment sets, which is what every other segment has to concat
   * with — not `sceneDefaults`, which is only the film's declared preference
   * for brand-new scenes. Same rule, and the same reason, as
   * sceneFromFootage: a film whose timeline already runs at 60fps must not
   * receive a 30fps scene because a stale default said so.
   */
  const plan = await planFilm({ film, store, ffprobePath });
  const anchor = plan.scenes.find((s) => !s.missing && s.width > 0) ?? {};
  const width = anchor.width ?? film.sceneDefaults?.width;
  const height = anchor.height ?? film.sceneDefaults?.height;
  const fps = plan.fps ?? film.sceneDefaults?.fps;
  // A still has no length of its own, so the caller's number wins, then the
  // film's stated preference, then a default that is named rather than invented
  // on the spot.
  const durationInFrames = Number.isInteger(wantFrames) && wantFrames > 0
    ? wantFrames
    : (film.sceneDefaults?.durationInFrames ?? DEFAULT_STILL_FRAMES);
  if (!(width > 0 && height > 0 && fps > 0)) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      'Cannot tell the film\'s geometry — it needs a resolved segment or sceneDefaults before an image can '
      + 'become a scene',
      { film: filmId, width, height, fps });
  }

  const fit = chooseFit({ width, height, picture });

  const warnings = [];
  // An animated GIF in an <img> plays on the WALL CLOCK, which is the one thing
  // a composition may never do: under parallel rendering each worker captures a
  // different moment of it. Reported rather than converted — the fix is a real
  // decision about what the segment is.
  if (media && !isStillImage(sourceRel, media) && (media.video?.frames ?? 0) > 1) {
    warnings.push(`"${sourceRel}" has ${media.video.frames} frames — it is animated, and an <img> plays it on `
      + 'the wall clock, so parallel render workers would each capture a different moment of it. Either accept an '
      + 'arbitrary frame, or convert it with transcode_asset and drive it with seekVideo() the way '
      + 'make_scene_from_footage does.');
  }
  if (picture?.isTransparent) {
    warnings.push('The image carries transparency. It is composited over the scene\'s background (black, in '
      + 'styles.css) — change that background to matte it differently, or set output.transparent in scene.json '
      + 'to carry the alpha out of the render. This is reported, not decided: both are legitimate.');
  }
  if (!fit.measured) {
    warnings.push(`The image could not be measured${measurable ? '' : ` (ffmpeg cannot decode ${ext})`}, so the `
      + 'fit is `contain` — it letterboxes rather than cropping or stretching. Set it to `cover` in styles.css if '
      + 'it should fill the frame.');
  }

  const sceneName = (typeof name === 'string' && name.trim())
    ? name.trim()
    : (path.basename(sourceRel).replace(/\.[a-z0-9]+$/i, '') || 'Still');

  const taken = (candidate) => fs.existsSync(path.join(store.scenePath(`${film.id}/${candidate}`), SCENE_CONFIG));
  let sceneSlug;
  if (slug !== undefined && slug !== null && String(slug).trim() !== '') {
    sceneSlug = checkSlug(String(slug).trim(), 'scene');
    if (taken(sceneSlug)) {
      throw new EngineError(ErrorCodes.SCENE_ALREADY_EXISTS,
        `A scene already exists at ${film.id}/${sceneSlug}`, { sceneId: `${film.id}/${sceneSlug}` });
    }
  } else {
    // A derived slug dedupes rather than failing: placing the same still twice
    // — a title card at the head and the tail, say — is a normal ask.
    const base = checkSlug(slugify(sceneName) || 'still', 'scene');
    sceneSlug = base;
    for (let n = 2; taken(sceneSlug); n += 1) sceneSlug = checkSlug(`${base}-${n}`, 'scene');
  }

  const sceneId = `${film.id}/${sceneSlug}`;
  const scenePath = store.scenePath(sceneId);
  const preexisting = fs.existsSync(scenePath);
  const config = makeConfig({ name: sceneName, fps, width, height, durationInFrames });

  // One image in a brand-new folder, so its own filename cannot collide with
  // anything; the characters are narrowed because the name ends up in an HTML
  // attribute and a URL.
  const imageFile = path.basename(sourceRel).replace(/[^A-Za-z0-9._-]+/g, '-');
  let linked = false;
  let bytes = null;
  try {
    await scaffoldSceneFiles(scenePath, config);
    for (const [file, content] of Object.entries(imageCompositionFiles({
      name: sceneName, fps, width, height, durationInFrames,
      imageFile, fit, source: `${imageFrom === 'library' ? 'the workspace library' : 'the film\'s assets'}, `
        + `as ${sourceRel}`,
      transparent: picture?.isTransparent === true,
    }))) {
      await fsp.writeFile(path.join(scenePath, file), content, 'utf8');
    }

    if (imageFrom === 'library') {
      // The library's own hardlink-on-use path: a 200 MB plate costs no second
      // copy where the filesystem allows it, and the scene still renders
      // hermetically from its own assets/.
      const used = await store.useLibraryAsset(sceneId, sourceRel, { as: `assets/${imageFile}` });
      linked = used.linked;
      bytes = used.bytes;
    } else {
      // Copied, not linked, for cloneScene's reason: this is a LIVE scene whose
      // asset an author may edit in place, and an aliased inode would rewrite
      // the film's copy at the same time.
      const destAbs = resolveInTarget(scenePath, `assets/${imageFile}`, { forWrite: true, asAsset: true });
      await fsp.copyFile(sourceAbs, destAbs);
      bytes = (await fsp.stat(destAbs)).size;
    }
  } catch (err) {
    // Only a folder this call created is ours to remove.
    if (!preexisting) await fsp.rm(scenePath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // Last, so a failure above leaves an unused folder rather than a film that
  // no longer plays.
  await store.updateFilm(film.id, { scenes: [...(film.scenes ?? []), { slug: sceneSlug }] });

  return {
    scene: sceneId,
    name: sceneName,
    path: scenePath,
    config,
    image: { file: `assets/${imageFile}`, from: sourceRel, source: imageFrom, bytes, linked },
    fit,
    picture,
    warnings,
  };
}
