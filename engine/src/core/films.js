/**
 * Film documents — validation, planning, and builds.
 *
 * A film IS a folder (v0.20): `<workspace>/films/<film>/` holds `film.json`
 * (this module owns its schema), `assets/` (master audio and overlay files),
 * `out/` (built output) and `scenes/<scene>/` (the compositions, in
 * core/scene.js shape). WorkspaceStore (core/store.js) owns discovery and
 * persistence of the document; this module owns what the document *means*:
 *
 *   validateFilm     — every save goes through it; a broken film never persists
 *   normalizeFilm    — fill defaults, stamp editor ids on timeline items
 *   planFilm         — non-throwing resolution: layout, per-scene status and a
 *                      `problems` list the editor can render as warnings
 *   captionsToSrt/Ass — caption track → sidecar / burn-in subtitle documents
 *   buildOverlayGraph — pure -filter_complex builder for the finishing pass
 *   buildFilmArtifact — assembleFilm (lossless concat + master audio) plus the
 *                      optional finishing encode that burns overlays/captions
 *   submitFilmBuild  — the same build as a JobManager job, so the Studio and
 *                      MCP callers poll film builds exactly like renders
 *
 * Before v0.20 a film referenced scene projects by UUID and needed a separate
 * "output project" (the "— Master" convention) to hold master audio and
 * receive builds. Both are gone: scenes are referenced by slug within the
 * film folder, and the film folder itself is the output location. Audio and
 * overlay `src` paths are film-relative under `assets/`, identical in shape
 * to a scene's config.audio.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { EngineError, ErrorCodes } from './errors.js';
import { getFormat, encodingCompatibilityWarnings } from './formats.js';
import {
  sceneSignature, sceneOutputPath, sceneHasAudio, validateScenes, assembleFilm,
  readRenderMeta, renderStaleness, describeStaleness,
  probeSignature, engineFormatForProbe, isFootage, segmentFrames, segmentName,
} from './film.js';
import { buildVideoArgs, runFfmpeg, probeMedia, probeFrameCount } from './encoder.js';
import { resolveInTarget } from './sandbox.js';
import { resolveFfprobePath } from './settings.js';

/* ------------------------------------------------------------------ */
/* Limits — generous for real work, bounded against runaway callers.   */
/* ------------------------------------------------------------------ */

export const MAX_FILM_SCENES = 500;
export const MAX_FILM_AUDIO_TRACKS = 100;
export const MAX_FILM_OVERLAYS = 50;
export const MAX_FILM_CAPTIONS = 1000;
export const MAX_CAPTION_CHARS = 500;

/** Track fields the ffmpeg mixer understands — everything else on an audio
 *  track (id, label) is editor metadata and is stripped before the build. */
const MIXER_TRACK_FIELDS = ['src', 'startInFrames', 'gainDb', 'trimEndInFrames', 'fadeInFrames', 'fadeOutFrames', 'duck'];

/** Strip editor metadata from film audio tracks, keeping only mixer fields. */
export function toMixerTracks(tracks) {
  return (tracks ?? []).map((t) =>
    Object.fromEntries(MIXER_TRACK_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])));
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

const SCENE_SLUG_RE = /^[a-z0-9_][a-z0-9-_]*$/;

function checkTrack(t, i, problems) {
  const at = `audio[${i}]`;
  if (!t || typeof t !== 'object') { problems.push(`${at} must be an object`); return; }
  if (typeof t.src !== 'string' || !t.src.replace(/\\/g, '/').startsWith('assets/')) {
    problems.push(`${at}.src must be a film-relative path under assets/`);
  }
  if (t.startInFrames !== undefined && !isNonNegInt(t.startInFrames)) problems.push(`${at}.startInFrames must be a non-negative integer`);
  if (t.gainDb !== undefined && typeof t.gainDb !== 'number') problems.push(`${at}.gainDb must be a number`);
  if (t.trimEndInFrames !== undefined && !isPosInt(t.trimEndInFrames)) problems.push(`${at}.trimEndInFrames must be a positive integer`);
  if (t.fadeInFrames !== undefined && !isNonNegInt(t.fadeInFrames)) problems.push(`${at}.fadeInFrames must be a non-negative integer`);
  if (t.fadeOutFrames !== undefined && !isNonNegInt(t.fadeOutFrames)) problems.push(`${at}.fadeOutFrames must be a non-negative integer`);
  if (t.duck !== undefined && typeof t.duck !== 'boolean') problems.push(`${at}.duck must be a boolean`);
  if (t.label !== undefined && typeof t.label !== 'string') problems.push(`${at}.label must be a string`);
}

/**
 * A footage segment (v0.22): a piece of video that joins the timeline as-is,
 * beside the rendered scenes.
 *
 * `durationInFrames` is **declared here and verified at plan time** against the
 * file itself. Declaring it is what lets planFilm compute offsets without
 * probing every file on every call — the same reason scenes declare their
 * duration in config. But a declaration that is never checked is worse than
 * none, because every downstream offset derives from it: one wrong frame count
 * silently shifts every subsequent scene, caption and audio cue, and the render
 * still "succeeds". So planFilm probes, and refuses to build on a disagreement.
 */
function checkFootage(s, i, problems) {
  const at = `scenes[${i}]`;
  if (typeof s.footage !== 'string' || !s.footage.replace(/\\/g, '/').startsWith('assets/')) {
    problems.push(`${at}.footage must be a film-relative path under assets/`);
  }
  if (!isPosInt(s.durationInFrames)) {
    problems.push(`${at}.durationInFrames must be a positive integer — declare the footage's frame count ` +
      '(it is verified against the file, and every later offset depends on it)');
  }
  if (s.label !== undefined && typeof s.label !== 'string') problems.push(`${at}.label must be a string`);
}

function checkOverlay(o, i, problems) {
  const at = `overlays[${i}]`;
  if (!o || typeof o !== 'object') { problems.push(`${at} must be an object`); return; }
  if (typeof o.src !== 'string' || !o.src.replace(/\\/g, '/').startsWith('assets/')) {
    problems.push(`${at}.src must be a film-relative path under assets/`);
  }
  if (!isNonNegInt(o.fromFrame)) problems.push(`${at}.fromFrame must be a non-negative integer`);
  if (!isPosInt(o.toFrame) || (isNonNegInt(o.fromFrame) && o.toFrame <= o.fromFrame)) {
    problems.push(`${at}.toFrame must be an integer greater than fromFrame`);
  }
  for (const k of ['xPct', 'yPct']) {
    if (o[k] !== undefined && !(typeof o[k] === 'number' && o[k] >= -100 && o[k] <= 200)) {
      problems.push(`${at}.${k} must be a number (percent of frame, -100..200)`);
    }
  }
  if (o.widthPct !== undefined && o.widthPct !== null && !(typeof o.widthPct === 'number' && o.widthPct > 0 && o.widthPct <= 400)) {
    problems.push(`${at}.widthPct must be a positive number (percent of frame width, ≤400) or null for natural size`);
  }
  if (o.opacity !== undefined && !(typeof o.opacity === 'number' && o.opacity >= 0 && o.opacity <= 1)) {
    problems.push(`${at}.opacity must be a number 0..1`);
  }
}

function checkCaption(c, i, problems) {
  const at = `captions[${i}]`;
  if (!c || typeof c !== 'object') { problems.push(`${at} must be an object`); return; }
  if (typeof c.text !== 'string' || !c.text.trim()) problems.push(`${at}.text must be a non-empty string`);
  else if (c.text.length > MAX_CAPTION_CHARS) problems.push(`${at}.text exceeds ${MAX_CAPTION_CHARS} characters`);
  if (!isNonNegInt(c.fromFrame)) problems.push(`${at}.fromFrame must be a non-negative integer`);
  if (!isPosInt(c.toFrame) || (isNonNegInt(c.fromFrame) && c.toFrame <= c.fromFrame)) {
    problems.push(`${at}.toFrame must be an integer greater than fromFrame`);
  }
}

/**
 * Validate a complete film document. Throws invalid_film carrying the FULL
 * problem list — an editor fixing a film wants every complaint at once, not
 * one per save attempt.
 */
export function validateFilm(film) {
  const problems = [];
  if (!film || typeof film !== 'object') {
    throw new EngineError(ErrorCodes.INVALID_FILM, 'film must be an object', { problems: ['film must be an object'] });
  }
  if (typeof film.name !== 'string' || !film.name.trim()) problems.push('name must be a non-empty string');

  if (!Array.isArray(film.scenes)) problems.push('scenes must be an array of { slug } or { footage, durationInFrames }');
  else {
    if (film.scenes.length > MAX_FILM_SCENES) problems.push(`scenes exceeds ${MAX_FILM_SCENES}`);
    const seen = new Set();
    film.scenes.forEach((s, i) => {
      // A segment is a scene OR a piece of footage (v0.22). One key decides
      // which, so an old film — every entry a bare { slug } — stays valid with
      // no migration, and schemaVersion stays 1.
      const hasSlug = !!s && s.slug !== undefined;
      const hasFootage = !!s && s.footage !== undefined;
      if (hasSlug && hasFootage) {
        problems.push(`scenes[${i}]: a segment is either a scene ({ slug }) or footage ({ footage }), not both`);
        return;
      }
      if (hasFootage) {
        checkFootage(s, i, problems);
        return;
      }
      if (!s || typeof s.slug !== 'string' || !SCENE_SLUG_RE.test(s.slug)) {
        problems.push(`scenes[${i}] must be a scene ({ slug }) or footage ({ footage, durationInFrames })`);
      } else if (seen.has(s.slug)) {
        problems.push(`scenes[${i}].slug "${s.slug}" appears more than once — a scene plays once; ` +
          'to reuse footage, render it into two scenes');
      } else {
        // Only scene slugs are deduped. A footage file may legitimately appear
        // more than once (the same plate as a recurring cutaway), and it costs
        // nothing: unlike a scene it has no per-instance render to collide with.
        seen.add(s.slug);
      }
    });
  }

  if (film.outputFilename !== undefined) {
    const base = String(film.outputFilename);
    if (base.includes('/') || base.includes('\\') || base.includes('..') || !base.trim()) {
      problems.push('outputFilename must be a bare filename');
    }
  }

  const sd = film.sceneDefaults;
  if (sd !== null && sd !== undefined) {
    if (typeof sd !== 'object' || Array.isArray(sd)) problems.push('sceneDefaults must be an object or null');
    else {
      if (sd.fps !== undefined && (!isPosInt(sd.fps) || sd.fps > 240)) problems.push('sceneDefaults.fps: integer in 1..240');
      if (sd.width !== undefined && (!isPosInt(sd.width) || sd.width > 7680)) problems.push('sceneDefaults.width: integer in 1..7680');
      if (sd.height !== undefined && (!isPosInt(sd.height) || sd.height > 4320)) problems.push('sceneDefaults.height: integer in 1..4320');
      if (sd.durationInFrames !== undefined && !isPosInt(sd.durationInFrames)) problems.push('sceneDefaults.durationInFrames: positive integer');
      for (const k of Object.keys(sd)) {
        if (!['fps', 'width', 'height', 'durationInFrames'].includes(k)) problems.push(`sceneDefaults.${k} is not a scene default`);
      }
    }
  }

  if (!Array.isArray(film.audio)) problems.push('audio must be an array');
  else {
    if (film.audio.length > MAX_FILM_AUDIO_TRACKS) problems.push(`audio exceeds ${MAX_FILM_AUDIO_TRACKS} tracks`);
    film.audio.forEach((t, i) => checkTrack(t, i, problems));
  }
  if (!Array.isArray(film.overlays)) problems.push('overlays must be an array');
  else {
    if (film.overlays.length > MAX_FILM_OVERLAYS) problems.push(`overlays exceeds ${MAX_FILM_OVERLAYS}`);
    film.overlays.forEach((o, i) => checkOverlay(o, i, problems));
  }
  if (!Array.isArray(film.captions)) problems.push('captions must be an array');
  else {
    if (film.captions.length > MAX_FILM_CAPTIONS) problems.push(`captions exceeds ${MAX_FILM_CAPTIONS}`);
    film.captions.forEach((c, i) => checkCaption(c, i, problems));
  }

  if (film.audioTargetPeakDb !== null && film.audioTargetPeakDb !== undefined
      && !(typeof film.audioTargetPeakDb === 'number' && film.audioTargetPeakDb >= -60 && film.audioTargetPeakDb <= 0)) {
    problems.push('audioTargetPeakDb must be a number between -60 and 0, or null');
  }
  if (film.burnCaptions !== undefined && typeof film.burnCaptions !== 'boolean') problems.push('burnCaptions must be a boolean');

  const cs = film.captionStyle;
  if (cs !== undefined && cs !== null) {
    if (typeof cs !== 'object') problems.push('captionStyle must be an object');
    else {
      if (cs.sizePct !== undefined && !(typeof cs.sizePct === 'number' && cs.sizePct >= 1 && cs.sizePct <= 20)) {
        problems.push('captionStyle.sizePct must be a number 1..20 (percent of frame height)');
      }
      if (cs.position !== undefined && !['bottom', 'top'].includes(cs.position)) {
        problems.push('captionStyle.position must be "bottom" or "top"');
      }
    }
  }

  if (problems.length) {
    throw new EngineError(ErrorCodes.INVALID_FILM, `Film definition is invalid: ${problems.join('; ')}`, { problems });
  }
  return film;
}

/**
 * One segment of the play order, normalized to exactly the keys its kind owns.
 *
 * This projection runs on EVERY save — createFilm, updateFilm, createScene's
 * auto-append, removeScene, and the Studio's debounced autosave all pass through
 * it — so it is the single place a footage entry can be silently destroyed.
 * Before v0.22 it returned `{ slug: s?.slug }` unconditionally, which is why
 * footage had to be understood here first: without this, an entry would survive
 * validation and then vanish on the next unrelated edit.
 */
function normalizeSegment(s) {
  if (s && s.footage !== undefined) {
    return {
      footage: typeof s.footage === 'string' ? s.footage.replace(/\\/g, '/') : s.footage,
      durationInFrames: s.durationInFrames,
      ...(s.label !== undefined ? { label: s.label } : {}),
      // A segment carrying BOTH keys is a confused caller, not a footage entry
      // with a stray field. Keeping the slug here is what lets validateFilm
      // refuse it: dropping it would silently pick footage and persist a
      // decision nobody made.
      ...(s.slug !== undefined ? { slug: s.slug } : {}),
    };
  }
  return { slug: s?.slug };
}

/** Fill defaults and stamp ids on timeline items so editors can address them. */
export function normalizeFilm(input = {}) {
  const stampIds = (arr) => (Array.isArray(arr) ? arr.map((x) => (x && typeof x === 'object' && !x.id ? { ...x, id: randomUUID() } : x)) : arr);
  const sd = input.sceneDefaults;
  const pickInts = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
  return {
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    scenes: Array.isArray(input.scenes) ? input.scenes.map(normalizeSegment) : [],
    outputFilename: input.outputFilename ?? 'film',
    sceneDefaults: sd && typeof sd === 'object'
      ? pickInts(sd, ['fps', 'width', 'height', 'durationInFrames'])
      : null,
    audio: stampIds(input.audio ?? []),
    overlays: stampIds(input.overlays ?? []),
    captions: stampIds(input.captions ?? []),
    captionStyle: { sizePct: 4.5, position: 'bottom', ...(input.captionStyle ?? {}) },
    audioTargetPeakDb: input.audioTargetPeakDb ?? null,
    burnCaptions: input.burnCaptions ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * The film signature (v0.22) — the encode contract, stated as data.
 *
 * The long-form guarantee is that scenes share an encode signature and
 * therefore concatenate losslessly: sceneSignature() computes it,
 * validateScenes() enforces it, assembleFilm() depends on it — and until now
 * nothing told a caller what it *is*.
 *
 * That is fine while the engine renders every segment. The moment a file
 * arrives from outside (footage, a supplied clip, a transcode) the caller has
 * to produce something matching an invariant it cannot read, and it has two
 * bad options: guess, or render a file first and probe it to discover a
 * constant that lives in a hard-coded table. A real session guessed, and two
 * of its three guesses were cargo-cult — it pinned `-profile:v high -level
 * 4.0` (libx264 picks exactly those for 1080p30 anyway) and `-x264-params
 * keyint=60` while the engine uses libx264's default 250. The concat succeeded
 * *despite* the mismatch, because each segment is its own encode and therefore
 * opens on a keyframe, which is all `concat -c copy` requires.
 *
 * So `neednotMatch` is as load-bearing as `mustMatch`: stating what is NOT
 * required is what stops the next author inheriting that cargo cult.
 *
 * ## The third list (v0.22)
 *
 * Two lists could not classify everything, and the leftovers were the ones a
 * caller actually gets wrong. `crf`/`preset` are not required for the concat but
 * footage ignoring them looks different from the scenes beside it; colour tags
 * are the same shape of fact. Calling either `neednotMatch` would be false —
 * they are not *needed*, but a caller who skips them gets a visibly worse film —
 * and calling them `mustMatch` would be false too, because nothing fails.
 *
 * `matchForLooks` is that third answer: **it does not affect the join, and the
 * joined file keeps only segment 1's, so a mismatch is a look difference rather
 * than an error.** The category is not new; docs/film-setup.md already described
 * crf/preset exactly this way in prose, with nowhere to put them.
 * ------------------------------------------------------------------ */

/** First value after `flag` in an argument list, or null. */
function argValue(args, flag) {
  const i = (args ?? []).indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/**
 * What a file must look like to join this film, derived from the code that
 * already computes it — never from a second copy of the encode table. A
 * duplicated table would diverge, and the *reported* one would be the wrong
 * one, which is worse than reporting nothing.
 *
 * `ffmpegArgs` is literally `buildVideoArgs(output)`, the same call the
 * finishing encode makes, so the reported args and the args the renderer
 * passes cannot drift. Everything in `video`/`audio` is then read back out of
 * those arrays by flag lookup rather than restated.
 *
 * Two fields answer different questions and can legitimately disagree:
 * `id` is `sceneSignature()`'s comparison key — the exact string
 * `validateScenes` enforces — while `pixFmt` is the pixel format the encoder
 * actually emits. For mp4/webm they agree; for prores the profile decides the
 * pixel format (`yuv422p10le`) regardless of `output.pixFmt`, and the honest
 * answer to "what will my file have to be" is the encoder's.
 *
 * NEVER THROWS. A caller asking what the contract is must not be handed an
 * exception because the film's format has no encode step.
 *
 * @param {object[]} configs  resolved scene configs, in film order
 * @returns {object|null} null when no scene resolved — an empty film enforces
 *   nothing, and a plausible guess from sceneDefaults alone would produce a
 *   file that fails to concat much later.
 */
export function filmSignature(configs) {
  const resolved = (configs ?? []).filter(Boolean);
  if (!resolved.length) return null;

  const first = resolved[0];
  const output = first.output ?? {};
  const format = output.format ?? 'mp4';
  // An unknown format cannot reach here through validateConfig, but this
  // function is a reporter and must survive a hand-edited scene.json.
  let fmt = null;
  try { fmt = getFormat(format); } catch { /* reported as nulls below */ }

  // The advisory that matters exactly here: someone reading this block is
  // deciding what to encode, and mp4+crf 0 is the lossless-H.264 black-video
  // trap. Carried rather than re-derived.
  const warnings = [...encodingCompatibilityWarnings(output)];

  let ffmpegArgs = null;
  if (fmt?.videoArgs) {
    try { ffmpegArgs = buildVideoArgs(output); } catch { /* below */ }
  }
  if (!ffmpegArgs) {
    // The whole story for this format; the copyConcat line below would only
    // restate it, so the two are deliberately exclusive.
    warnings.push(
      `Format "${format}" has no encode step, so this film has no encoder arguments to match — ` +
      'nothing can be conformed to join it.',
    );
  } else if (fmt && !fmt.copyConcat) {
    warnings.push(
      `Format "${format}" cannot be stream-copied, so its scenes are re-encoded from a lossless ` +
      'intermediate rather than concatenated — matching these arguments does not make a file joinable.',
    );
  }
  // crf/preset are deliberately NOT part of the signature: docs/film-setup.md
  // states they may differ between scenes because they affect encoding, not
  // stream compatibility. Scene 1 is the film's encode voice (buildFilmArtifact
  // uses its output for the finishing pass), so that is what is reported — and
  // when the scenes disagree, say so rather than let the report read as uniform.
  const rateControl = new Set(resolved.map((c) => `${c.output?.crf ?? ''}/${c.output?.preset ?? ''}`));
  if (rateControl.size > 1) {
    warnings.push(
      'Scenes disagree on crf/preset. The reported values are scene 1\'s — the film\'s encode voice, and what ' +
      'the finishing pass uses. They are not part of the signature (they affect quality, not stream ' +
      'compatibility), so a mismatch is legal; match them anyway if new footage should not look different — ' +
      'which is exactly what matchForLooks lists them for.',
    );
  }

  const audioArgs = fmt?.audioArgs ? fmt.audioArgs() : null;
  const crf = argValue(ffmpegArgs, '-crf');

  return {
    // The comparison key validateScenes enforces, computed by the same
    // function it uses — not reassembled from the fields below.
    id: sceneSignature(first),
    width: first.width,
    height: first.height,
    fps: first.fps,
    format,
    // prores writes .mov, so the container is not a synonym for the format.
    container: fmt?.ext ? fmt.ext.replace(/^\./, '') : null,
    pixFmt: argValue(ffmpegArgs, '-pix_fmt') ?? output.pixFmt ?? null,
    transparent: output.transparent ?? false,
    video: {
      // gif's videoArgs is a -filter_complex with no -c:v, so codec is null
      // there — honestly, rather than by inventing one.
      codec: argValue(ffmpegArgs, '-c:v'),
      crf: crf === null ? null : Number(crf),
      preset: argValue(ffmpegArgs, '-preset'),
    },
    audio: audioArgs
      ? { codec: argValue(audioArgs, '-c:a'), bitrate: argValue(audioArgs, '-b:a') }
      : null,
    ffmpegArgs,
    copyConcat: fmt?.copyConcat ?? null,
    /**
     * Colour is deliberately reported as UNSTATED rather than as a value
     * (v0.22), and that is the honest answer, not a gap.
     *
     * The engine passes no colour arguments at all, so a scene's tags are
     * whatever Chromium's PNGs and ffmpeg's default conversion happen to
     * produce. Measured on a real render: `primaries=bt709,
     * transfer=iec61966-2-1, matrix=unset`, and the pixels are converted with
     * the **bt601** matrix (a render forced to `smpte170m` is byte-identical),
     * so the file does not even agree with itself — every player that assumes
     * bt709 for HD decodes it with the wrong matrix.
     *
     * Naming a value here would therefore require probing a rendered file: a
     * second copy of the truth, obtainable only after a render, and describing
     * an accident of the installed Chromium/ffmpeg pair rather than a decision.
     * Conforming footage to it would faithfully replicate that accident and
     * bake it into a `.transcode.json` identity that survives the next upgrade.
     *
     * Two further measurements are why `matchFilm` carries no colour arguments:
     * `-color_primaries`/`-color_trc` are **silently ignored** on this pipeline
     * (frame properties from the decoder win), so emitting them would report a
     * conform that did not happen; and the one flag that does take,
     * `-colorspace`, re-matrixes the picture — a pixel change, not a tag.
     *
     * `stated: false` is the field a caller reads. It must never be treated as
     * "no colour metadata exists" — the files carry tags; the engine just does
     * not choose them.
     */
    color: { stated: false, primaries: null, transfer: null, matrix: null, range: null },
    // What a stream copy cannot reconcile, what it does not care about, and
    // what it copies through untouched from segment 1. The second and third
    // lists exist to prevent over-matching and under-matching respectively;
    // see the header.
    mustMatch: ['codec', 'width', 'height', 'fps', 'pixFmt', 'container'],
    neednotMatch: ['gopSize', 'profile', 'level', 'bitrate'],
    matchForLooks: ['crf', 'preset', 'colorPrimaries', 'colorTransfer', 'colorMatrix', 'colorRange'],
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Planning — resolve a film against reality without throwing          */
/* ------------------------------------------------------------------ */

/**
 * Resolve one footage segment: locate it, probe it, and verify the two things a
 * declaration cannot be trusted on (v0.22).
 *
 * **Declared, then verified.** The frame count comes from the document so offsets
 * can be computed without probing on every call, exactly as scenes declare theirs
 * in config — but every downstream offset derives from it, so one wrong count
 * would silently shift every later scene, caption and cue while the render still
 * succeeded. Same contract as the render sidecar: declare, then verify, never
 * trust.
 *
 * `frames` is read from the container header when it is there and counted from
 * packets when it is not — **measured: mp4 reports `nb_frames`, webm reports
 * nothing**, and a packet count costs ~46 ms even on a 30 s 1080p file, so the
 * fallback is cheap enough to always take.
 *
 * ffprobe is not a declared prerequisite, so "unverified" is a legitimate third
 * state (`framesVerified: null`), mirroring `renderVerified` for a render that
 * predates the sidecar. It must never be read as "matches".
 */
async function planFootage({ film, ref, index, problems, ffprobePath }) {
  const rel = String(ref.footage ?? '').replace(/\\/g, '/');
  const declared = ref.durationInFrames;
  const base = {
    kind: 'footage',
    index,
    footage: rel,
    ...(ref.label ? { label: ref.label } : {}),
    name: ref.label ?? rel.split('/').pop(),
    durationInFrames: isPosInt(declared) ? declared : 0,
  };

  let abs = null;
  try {
    abs = resolveInTarget(film.path, rel);
  } catch {
    problems.push({
      code: ErrorCodes.FOOTAGE_MISSING,
      segment: rel,
      message: `Footage ${index + 1}: "${rel}" is not a valid path under the film's assets/`,
    });
    return { ...base, missing: true, durationInFrames: 0 };
  }
  if (!fs.existsSync(abs)) {
    problems.push({
      code: ErrorCodes.FOOTAGE_MISSING,
      segment: rel,
      message: `Footage ${index + 1}: "${rel}" does not exist in the film's assets/ folder`,
    });
    return { ...base, missing: true, durationInFrames: 0 };
  }

  const media = await probeMedia({ filePath: abs, ffprobePath }).catch(() => null);
  if (!media) {
    // Unprobeable is not the same as missing: the file is there, but nothing can
    // be verified about it, and saying so beats inventing a verdict.
    return { ...base, missing: false, probed: false, framesVerified: null, signature: null };
  }

  let frames = media.video?.frames ?? null;
  if (!frames) {
    const counted = await probeFrameCount({ filePath: abs, ffprobePath }).catch(() => null);
    if (counted) frames = counted;
  }
  if (frames && isPosInt(declared) && frames !== declared) {
    problems.push({
      code: ErrorCodes.FOOTAGE_DURATION_MISMATCH,
      segment: rel,
      message: `Footage "${rel}" declares ${declared} frames but the file has ${frames} — ` +
        `declared ${declared} → actual ${frames}. Every offset after this segment derives from the ` +
        'declaration, so fix it before building.',
      declared,
      actual: frames,
    });
  }
  // Footage is silent by contract: all sound comes from the master timeline.
  // Dropping an audio stream silently would be worse than refusing it — the
  // user's own voice would vanish from a film they can hear it in.
  if (media.hasAudio) {
    problems.push({
      code: ErrorCodes.FOOTAGE_MISSING,
      segment: rel,
      message: `Footage "${rel}" carries an audio stream. Footage segments must be silent — extract the audio ` +
        'to a WAV, put it on the film\'s master audio timeline (update_film { audio: [...] }), and supply a ' +
        'video-only file here. Otherwise the concat mixes audio-carrying and silent segments, which is exactly ' +
        'what mixed_scene_audio refuses.',
    });
  }

  return {
    ...base,
    missing: false,
    probed: true,
    width: media.video?.width ?? null,
    height: media.video?.height ?? null,
    fps: media.video?.fps ?? null,
    codec: media.video?.codec ?? null,
    pixFmt: media.video?.pixFmt ?? null,
    // Measured, and reported even though nothing enforces it (v0.22): footage
    // whose colour tags differ from the scenes' is a look difference at the cut,
    // never a broken concat, and this is the only place a caller can see it.
    // The scenes have no counterpart here on purpose — the engine does not state
    // its colour (see filmSignature's `color`), so there is nothing to compare
    // against that would not be an accident of the installed encoder.
    color: media.video?.color ?? null,
    format: engineFormatForProbe(media.video?.codec, media.container),
    hasAudio: media.hasAudio,
    actualFrames: frames ?? null,
    framesVerified: frames ? frames === declared : null,
    signature: probeSignature(media),
  };
}

/**
 * Resolve every reference in a film and report, rather than throw. The editor
 * shows `problems` as a validation chip; a film with problems can still be
 * edited (that is the point of an editor), it just cannot BUILD.
 *
 * @param {object} opts
 * @param {object} opts.film   a film from WorkspaceStore.getFilm (id + path + doc)
 * @param {object} opts.store  the WorkspaceStore
 * @returns {{ scenes, totalFrames, durationSeconds, fps, format, signature, problems }}
 *   `signature` is the structured contract from filmSignature() (null for a film
 *   with no resolvable scenes); `signature.id` is the string every scene's own
 *   `signature` is compared against.
 */
export async function planFilm({ film, store, ffprobePath = null }) {
  const problems = [];
  const scenes = [];
  // Resolved lazily and once: only a film with footage needs ffprobe, so a
  // scene-only film pays nothing, and no caller has to remember to pass it.
  // (Bare "ffprobe" would miss the sibling-of-ffmpeg resolution that exists
  // precisely for an MCP server with a minimal PATH — see core/settings.js.)
  let probeBin = ffprobePath;
  const resolveProbe = async () => {
    if (probeBin === null) {
      probeBin = (await resolveFfprobePath({ dataDir: store?.dataDir }).catch(() => null))?.path ?? 'ffprobe';
    }
    return probeBin;
  };
  // The resolved configs, kept only so filmSignature() can state the encode
  // contract without re-reading them. They are already in memory.
  const configs = [];
  let signature = null, fps = null, format = null;

  for (const [i, ref] of (film.scenes ?? []).entries()) {
    // Footage segments (v0.22): a piece of video that joins the timeline as-is.
    // Resolved, probed and verified here — before a build is paid for. The
    // signature seeding below is shared with scenes on purpose: whichever KIND of
    // segment resolves first establishes the film's contract, so a film that
    // opens on footage is not left without one.
    if (ref?.footage !== undefined) {
      const seg = await planFootage({ film, ref, index: i, problems, ffprobePath: await resolveProbe() });
      if (signature === null && seg.signature) {
        signature = seg.signature;
        fps = seg.fps ?? film.sceneDefaults?.fps ?? null;
        format = seg.format ?? null;
      } else if (seg.signature && signature !== null && seg.signature !== signature) {
        problems.push({
          code: ErrorCodes.FOOTAGE_SIGNATURE_MISMATCH,
          segment: seg.footage,
          message: `Footage "${seg.footage}" is ${seg.signature} — the film is ${signature}. It cannot be ` +
            'stream-copied onto the timeline. Re-encode it to match the film signature ' +
            '(get_film reports it, including the exact ffmpegArgs) — the engine will not silently re-encode it, ' +
            'because a film that quietly re-encodes one segment has stopped being losslessly assembled.',
        });
      }
      scenes.push(seg);
      continue;
    }
    const sceneId = `${film.id}/${ref.slug}`;
    // `kind` is on every entry (v0.22) so "where does segment 6 start" is
    // answered identically regardless of what the segment is.
    const base = { kind: 'scene', sceneId, slug: ref.slug, index: i };
    let entry = null, config = null;
    try {
      entry = await store.getScene(sceneId);
      config = await store.readConfig(sceneId);
    } catch {
      problems.push({ code: 'scene_missing', sceneId, message: `Scene ${i + 1}: "${ref.slug}" is missing or unreadable` });
      scenes.push({ ...base, missing: true, durationInFrames: 0 });
      continue;
    }
    configs.push(config);
    const sig = sceneSignature(config);
    if (signature === null) { signature = sig; fps = config.fps; format = config.output?.format ?? 'mp4'; }
    else if (sig !== signature) {
      problems.push({ code: 'signature_mismatch', sceneId, message: `Scene "${config.name}" is ${sig} — the film is ${signature}. Scenes must share resolution/fps/format to concatenate losslessly.` });
    }
    const outFile = sceneOutputPath(entry.path, config);
    const rendered = fs.existsSync(outFile);
    if (!rendered) {
      problems.push({ code: 'scene_not_rendered', sceneId, message: `Scene "${config.name}" has no rendered output yet` });
    }
    // Rendered, but at settings that have since changed (v0.21). Reported
    // here so the caller sees it while planning, not after a build produced a
    // film whose length disagrees with this very plan.
    const meta = rendered ? readRenderMeta(entry.path, config) : null;
    const stale = rendered ? renderStaleness(meta, config) : null;
    if (stale) {
      problems.push({
        code: 'stale_render',
        sceneId,
        message: `Scene "${config.name}" was rendered at different settings (${describeStaleness(stale)}) — re-render it`,
        changed: stale.changed,
      });
    }
    scenes.push({
      ...base,
      missing: false,
      name: config.name,
      width: config.width,
      height: config.height,
      fps: config.fps,
      durationInFrames: config.durationInFrames,
      format: config.output?.format ?? 'mp4',
      signature: sig,
      rendered,
      // false = rendered but stale; null = rendered by a build that predates
      // the sidecar, so it cannot be checked either way.
      renderVerified: rendered ? (meta ? !stale : null) : false,
      ...(stale ? { staleRender: { changed: stale.changed, recorded: stale.recorded, current: stale.current } } : {}),
      hasAudio: sceneHasAudio(config),
      outputFile: config.output?.filename ?? 'output.mp4',
    });
  }

  if (format && !getFormat(format).copyConcat) {
    problems.push({ code: 'format_not_concatenatable', message: `Format "${format}" cannot be losslessly concatenated — scenes must be mp4, webm, or prores` });
  }
  if (!(film.audio ?? []).length) {
    // Unprobed footage contributes no opinion: `hasAudio` is undefined there, and
    // counting it would report a mix that may not exist.
    const states = new Set(scenes.filter((s) => !s.missing && s.hasAudio !== undefined).map((s) => s.hasAudio));
    if (states.size > 1) {
      problems.push({
        code: 'mixed_scene_audio',
        message: 'Segments mix audio and silence — add a master audio timeline, or make them consistent. ' +
          '(Footage is silent by contract, so a film mixing footage with audio-carrying scenes needs a master ' +
          'timeline; that is the normal shape, not a workaround.)',
      });
    }
  }

  // A film that opens on footage has no scene config to take an fps from, and
  // an unprobeable file cannot supply one — fall back to what new scenes would
  // inherit, so offsets and startSeconds stay meaningful either way.
  if (fps === null) fps = film.sceneDefaults?.fps ?? null;

  // Running offsets, missing segments contributing zero frames.
  let offset = 0;
  for (const s of scenes) {
    s.filmOffset = offset;
    s.startSeconds = fps ? Number((offset / fps).toFixed(3)) : 0;
    offset += s.durationInFrames ?? 0;
  }
  const totalFrames = offset;

  // Master audio / overlay assets live in the film's own assets/ folder.
  const checkAsset = (src, what) => {
    const rel = String(src ?? '').replace(/\\/g, '/');
    let ok = rel.startsWith('assets/');
    if (ok) {
      try { ok = fs.existsSync(resolveInTarget(film.path, rel)); } catch { ok = false; }
    }
    if (!ok) problems.push({ code: 'asset_missing', message: `${what} references ${src}, which does not exist in the film's assets` });
  };
  (film.audio ?? []).forEach((t, i) => checkAsset(t.src, t.label ? `Audio "${t.label}"` : `Audio track ${i + 1}`));
  (film.overlays ?? []).forEach((o, i) => checkAsset(o.src, `Overlay ${i + 1}`));

  for (const [i, c] of (film.captions ?? []).entries()) {
    if (totalFrames && c.fromFrame >= totalFrames) {
      problems.push({ code: 'caption_out_of_range', message: `Caption ${i + 1} ("${String(c.text).slice(0, 24)}…") starts after the film ends` });
    }
  }
  for (const [i, o] of (film.overlays ?? []).entries()) {
    if (totalFrames && o.fromFrame >= totalFrames) {
      problems.push({ code: 'overlay_out_of_range', message: `Overlay ${i + 1} starts after the film ends` });
    }
  }

  return {
    scenes,
    totalFrames,
    durationSeconds: fps ? Number((totalFrames / fps).toFixed(3)) : 0,
    fps,
    format,
    // The structured contract (v0.22). `signature.id` is the string this field
    // used to be, and the one every scene's own `signature` is compared against.
    signature: filmSignature(configs),
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* Captions → SRT / ASS                                                */
/* ------------------------------------------------------------------ */

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Caption track → SubRip document (sidecar written next to every build). */
export function captionsToSrt(captions, fps) {
  const sorted = [...captions].sort((a, b) => a.fromFrame - b.fromFrame);
  return sorted.map((c, i) =>
    `${i + 1}\n${srtTime(c.fromFrame / fps)} --> ${srtTime(c.toFrame / fps)}\n${String(c.text).trim()}\n`,
  ).join('\n');
}

function assTime(seconds) {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Caption track → ASS document for burn-in (libass via the subtitles filter).
 * ASS rather than SRT because it pins the resolution-relative font size and
 * margin — SRT burn-in sizing is a player heuristic.
 */
export function captionsToAss(captions, fps, { width, height, style = {} } = {}) {
  const sizePct = style.sizePct ?? 4.5;
  const position = style.position ?? 'bottom';
  const fontSize = Math.max(8, Math.round((height * sizePct) / 100));
  const marginV = Math.round(height * 0.045);
  const alignment = position === 'top' ? 8 : 2; // ASS numpad: 8 top-center, 2 bottom-center
  // Braces open ASS override blocks and backslashes start escapes; both are
  // typography no caption needs, so neutralise rather than reject.
  const esc = (text) => String(text).trim()
    .replace(/[{}]/g, (ch) => (ch === '{' ? '(' : ')'))
    .replace(/\\/g, '/')
    .replace(/\r?\n/g, '\\N');
  const events = [...captions]
    .sort((a, b) => a.fromFrame - b.fromFrame)
    .map((c) => `Dialogue: 0,${assTime(c.fromFrame / fps)},${assTime(c.toFrame / fps)},Caption,,0,0,0,,${esc(c.text)}`);
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(fontSize / 18))},1,${alignment},40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Finishing pass — overlays + caption burn-in                         */
/* ------------------------------------------------------------------ */

/**
 * Build the -filter_complex graph for the finishing pass. Pure: overlays are
 * referenced by input index (input 0 is the assembled film; overlay i is
 * input i+1), so it unit-tests without files or ffmpeg.
 *
 * Geometry is percent-of-frame: xPct/yPct place the overlay's TOP-LEFT corner
 * (default 0,0), widthPct scales it against the film width keeping aspect
 * (null = natural size). Time windows are frames, converted here.
 *
 * @param {Array}  overlays  film.overlays, with `isVideo` flagged per entry
 * @param {object} opts      { width, height, fps, subtitlesFile? }
 * @returns {{ filterComplex: string, outLabel: string }}
 */
export function buildOverlayGraph(overlays, { width, height, fps, subtitlesFile = null } = {}) {
  const chains = [];
  let prev = '0:v';
  overlays.forEach((o, i) => {
    const from = (o.fromFrame / fps).toFixed(3);
    const to = (o.toFrame / fps).toFixed(3);
    const steps = ['format=rgba'];
    if (o.widthPct != null) steps.push(`scale=${Math.max(2, Math.round((width * o.widthPct) / 100))}:-1`);
    if (o.opacity != null && o.opacity < 1) steps.push(`colorchannelmixer=aa=${o.opacity.toFixed(3)}`);
    // A video overlay's own clock starts at 0; shift it to its window so its
    // first frame lands on fromFrame. Static images are single-frame inputs
    // that overlay's default eof_action=repeat holds for the whole window.
    if (o.isVideo) steps.push(`setpts=PTS-STARTPTS+${from}/TB`);
    chains.push(`[${i + 1}:v]${steps.join(',')}[ov${i}]`);
    const x = Math.round((width * (o.xPct ?? 0)) / 100);
    const y = Math.round((height * (o.yPct ?? 0)) / 100);
    const out = `v${i}`;
    chains.push(`[${prev}][ov${i}]overlay=x=${x}:y=${y}:enable='between(t,${from},${to})'[${out}]`);
    prev = out;
  });
  if (subtitlesFile) {
    const out = 'vsub';
    chains.push(overlays.length
      ? `[${prev}]subtitles=${subtitlesFile}[${out}]`
      : `[0:v]subtitles=${subtitlesFile}[${out}]`);
    prev = out;
  }
  return { filterComplex: chains.join(';'), outLabel: prev };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

function sanitizeBase(outputFilename) {
  const base = String(outputFilename ?? 'film').replace(/\.[a-z0-9]+$/i, '');
  if (base.includes('/') || base.includes('\\') || base.includes('..') || !base.trim()) {
    throw new EngineError(ErrorCodes.PATH_NOT_ALLOWED, 'outputFilename must be a bare filename');
  }
  return base;
}

/**
 * Resolve a film to everything the build needs, throwing on hard errors.
 * Shared by submitFilmBuild (pre-flight, so the API can 4xx before creating a
 * job) and buildFilmArtifact (the job body — state may have changed since).
 */
async function resolveFilmForBuild({ film, store, requireRendered = true }) {
  if (!(film.scenes ?? []).length) {
    throw new EngineError(ErrorCodes.INVALID_FILM, 'a film needs at least one scene before it can build', { problems: ['scenes is empty'] });
  }
  // The play order is heterogeneous (v0.22): a segment is a scene (which the
  // engine rendered, and whose config is the source of truth) or footage (a file
  // that joins as-is, whose truth is the file). Everything downstream —
  // validateScenes, assembleFilm, filmLayout — reads `kind`.
  const sceneData = [];
  for (const s of film.scenes) {
    if (s.footage !== undefined) {
      const rel = String(s.footage).replace(/\\/g, '/');
      const abs = resolveInTarget(film.path, rel, { asAsset: true });
      if (!fs.existsSync(abs)) {
        throw new EngineError(ErrorCodes.FOOTAGE_MISSING, `footage not found: ${rel} in film ${film.id}`, { path: rel });
      }
      sceneData.push({
        kind: 'footage',
        footage: rel,
        segmentPath: abs,
        durationInFrames: s.durationInFrames,
        name: s.label ?? rel.split('/').pop(),
      });
      continue;
    }
    const sceneId = `${film.id}/${s.slug}`;
    const entry = await store.getScene(sceneId);
    const config = await store.readConfig(sceneId);
    sceneData.push({ kind: 'scene', sceneId, slug: s.slug, path: entry.path, config });
  }
  const hasMasterAudio = !!(film.audio ?? []).length;
  const info = validateScenes(sceneData, { hasMasterAudio, requireRendered });

  const base = sanitizeBase(film.outputFilename);
  const ext = getFormat(info.format).ext;
  const outDir = path.join(film.path, 'out');
  const outputPath = path.join(outDir, base + ext);

  let audioTracks;
  if (hasMasterAudio) {
    audioTracks = [];
    for (const t of film.audio) {
      const rel = t.src.replace(/\\/g, '/');
      const abs = resolveInTarget(film.path, rel, { asAsset: true });
      if (!fs.existsSync(abs)) {
        throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `master audio not found: ${rel} in film ${film.id}`, { path: rel });
      }
      audioTracks.push({ ...toMixerTracks([t])[0], src: abs });
    }
  }

  const overlays = [];
  for (const o of film.overlays ?? []) {
    const rel = o.src.replace(/\\/g, '/');
    const abs = resolveInTarget(film.path, rel, { asAsset: true });
    if (!fs.existsSync(abs)) {
      throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `overlay not found: ${rel} in film ${film.id}`, { path: rel });
    }
    const ext2 = path.extname(abs).toLowerCase();
    overlays.push({ ...o, abs, isVideo: ['.mp4', '.webm', '.mov'].includes(ext2), isWebm: ext2 === '.webm' });
  }

  const totalFrames = sceneData.reduce((n, s) => n + segmentFrames(s), 0);
  return { sceneData, info, outDir, outputPath, base, ext, audioTracks, overlays, totalFrames };
}

/**
 * Build a saved film to its output file: lossless concat + master audio via
 * assembleFilm, then — only when the film has overlays or burns captions —
 * ONE finishing encode that composites them. Captions always also produce a
 * .srt sidecar next to the output, burned or not: players and platforms take
 * sidecars, and the sidecar survives a re-cut without re-encoding.
 *
 * The finishing encode's crf/preset (and the limiter default) come from the
 * FIRST scene's output config: scenes already share the codec-determining
 * parameters (validateScenes enforces it), so scene 1 is the film's encode
 * voice — and the film document needs no duplicate encode block to drift.
 */
export async function buildFilmArtifact({ film, store, ffmpegPath = 'ffmpeg', onSpawn, progress, signal }) {
  const checkCancel = () => {
    if (signal?.aborted) throw new EngineError(ErrorCodes.CANCELLED, 'film build cancelled');
  };
  const r = await resolveFilmForBuild({ film, store });
  const { sceneData, info, outDir, outputPath, base, ext, audioTracks, overlays, totalFrames } = r;
  await fsp.mkdir(outDir, { recursive: true });

  const fps = info.fps ?? film.sceneDefaults?.fps ?? null;
  const captions = film.captions ?? [];
  const burn = !!film.burnCaptions && captions.length > 0;
  const finishing = overlays.length > 0 || burn;
  // Scene 1 is the film's encode voice — but an all-footage film has no scene
  // config, so the geometry the finishing pass needs comes from the first
  // segment that can supply it, falling back to sceneDefaults.
  const firstScene = sceneData.find((s) => !isFootage(s));
  const firstOutput = firstScene?.config.output ?? {};
  const width = firstScene?.config.width ?? film.sceneDefaults?.width ?? null;
  const height = firstScene?.config.height ?? film.sceneDefaults?.height ?? null;

  progress?.phase('assembling');
  checkCancel();

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-filmbuild-'));
  let result;
  try {
    const assembleTarget = finishing ? path.join(tmp, `master${ext}`) : outputPath;
    result = await assembleFilm({
      scenes: sceneData,
      format: info.format,
      outputPath: assembleTarget,
      audioTracks,
      assetRoot: film.path,
      audioLimiter: firstOutput.audioLimiter !== false,
      audioTargetPeakDb: film.audioTargetPeakDb ?? undefined,
      fps,
      ffmpegPath,
      onSpawn,
    });
    checkCancel();

    let srtPath = null;
    if (captions.length) {
      srtPath = path.join(outDir, `${base}.srt`);
      await fsp.writeFile(srtPath, captionsToSrt(captions, fps), 'utf8');
    }

    if (finishing) {
      progress?.phase('finishing');
      let subtitlesFile = null;
      if (burn) {
        subtitlesFile = 'captions.ass';
        await fsp.writeFile(path.join(tmp, subtitlesFile), captionsToAss(captions, fps, { width, height, style: film.captionStyle }), 'utf8');
      }
      const { filterComplex, outLabel } = buildOverlayGraph(overlays, { width, height, fps, subtitlesFile });
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', assembleTarget];
      for (const o of overlays) {
        // VP9-in-webm alpha only survives the libvpx decoder — ffmpeg's native
        // vp9 decoder silently drops the alpha plane.
        if (o.isWebm) args.push('-c:v', 'libvpx-vp9');
        args.push('-i', o.abs);
      }
      args.push(
        '-filter_complex', filterComplex,
        '-map', `[${outLabel}]`, '-map', '0:a?', '-c:a', 'copy',
        ...buildVideoArgs({ ...firstOutput, format: info.format, transparent: firstOutput.transparent }),
        '-r', String(fps),
        outputPath,
      );
      const started = Date.now();
      await runFfmpeg({
        args,
        ffmpegPath,
        onSpawn,
        signal,
        what: 'film-finishing',
        cwd: tmp, // subtitles= resolves relative to here; absolute Windows paths need un-typeable escaping
        onProgressFrame: (frame) => progress?.progress({
          frame, totalFrames, framesDone: Math.min(frame, totalFrames), elapsedMs: Date.now() - started,
        }),
      });
    }

    return {
      ...result,
      filmId: film.id,
      outputPath,
      overlaysApplied: overlays.length,
      captions: captions.length,
      captionsBurned: burn,
      ...(srtPath ? { srtPath } : {}),
      reEncoded: finishing,
    };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run a film build as a JobManager job, so callers poll it exactly like a
 * render (same status shape, same logs, same cancel). Resolution runs once
 * up front so bad films fail the SUBMIT call with a structured error instead
 * of a job that dies a second later.
 *
 * @returns {{ jobId, state, queuePosition?, outputPath, totalFrames, filmId }}
 */
export async function submitFilmBuild({ film, store, jobs, ffmpegPath = 'ffmpeg' }) {
  const r = await resolveFilmForBuild({ film, store });
  const submitted = jobs.startRender({
    targetId: film.id,
    scenePath: film.path,
    // An all-footage film has no scene config to read a rate from.
    config: { durationInFrames: r.totalFrames, fps: r.info.fps ?? film.sceneDefaults?.fps ?? 30 },
    outputPath: r.outputPath,
    renderFn: (o) => buildFilmArtifact({
      film, store, ffmpegPath,
      onSpawn: o.onChildPid,
      progress: o.progress,
      signal: o.signal,
    }),
  });
  return { ...submitted, outputPath: r.outputPath, totalFrames: r.totalFrames, filmId: film.id };
}
