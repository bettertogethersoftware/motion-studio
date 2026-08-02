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
import { getFormat, encodingCompatibilityWarnings, outputColorProfile } from './formats.js';
import {
  sceneSignature, sceneOutputPath, sceneHasAudio, validateScenes, assembleFilm,
  readRenderMeta, renderDeliveryStaleness, renderOutputIdentityMatches, describeStaleness,
  probeSignature, engineFormatForProbe, isFootage, segmentFrames, segmentName,
} from './film.js';
import { buildVideoArgs, runFfmpeg, probeMedia, probeFrameCount } from './encoder.js';
import {
  measureRenderedPicture, createDeliveryReview, assertReviewAllowsPromotion,
  resolveReviewPolicy, REVIEW_WARNING_CODES,
} from './render-review.js';
import { resolveInTarget } from './sandbox.js';
import { readSettings, resolveFfprobePath } from './settings.js';
import {
  stagingOutputPath, prepareStagingOutput, promoteStagingOutput, assertDeliveryWritable,
} from './delivery.js';
import {
  MAX_FILM_DELIVERABLES, normalizeDeliverable, validateDeliverable,
  sanitizeDeliverableBase, resolveFilmDeliverable, compileReframeFilter,
  captionSafeCapacity,
} from './deliverables.js';
import { readTranscodeMetaFile, transcodeIdentity } from './transcode.js';
import { archiveDelivery } from './deliveries.js';
import { currentAgentId } from './revisions.js';

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
  if (s.derivedFrom !== undefined) checkFootageDerivedFrom(s.derivedFrom, at, problems);
  checkSegmentSequence(s, at, problems);
  if (s.id !== undefined && !(typeof s.id === 'string' && s.id.trim())) {
    problems.push(`${at}.id must be a non-empty string`);
  }
}

/**
 * A segment may carry a narrative `sequence` label (v0.23) — the story
 * grouping a human navigates by ("Intro", "Demo", "Close"). Consecutive
 * segments sharing a label form one sequence band in the plan and the Studio.
 * It is presentation metadata: renaming or regrouping never moves a file,
 * changes an id, or invalidates a render.
 */
function checkSegmentSequence(s, at, problems) {
  if (!s || s.sequence === undefined) return;
  if (typeof s.sequence !== 'string' || !s.sequence.trim() || s.sequence.length > 80) {
    problems.push(`${at}.sequence must be a non-empty string of at most 80 characters`);
  }
}

/**
 * Provenance is deliberately a pointer, not a second transcode manifest. The
 * identity, trim and source stat snapshot remain in the `.transcode.json`
 * created by transcode_asset; the film only says which source and sidecar its
 * segment depends on.
 */
function checkFootageDerivedFrom(value, at, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${at}.derivedFrom must be { asset, transcodeMeta }`);
    return;
  }
  if (typeof value.asset !== 'string' || !value.asset.trim()) {
    problems.push(`${at}.derivedFrom.asset must be a non-empty source asset reference`);
  }
  const meta = typeof value.transcodeMeta === 'string' ? value.transcodeMeta.replace(/\\/g, '/') : value.transcodeMeta;
  if (typeof meta !== 'string' || !meta.startsWith('assets/')) {
    problems.push(`${at}.derivedFrom.transcodeMeta must be a film-relative path under assets/`);
  } else if (!meta.endsWith('.transcode.json')) {
    problems.push(`${at}.derivedFrom.transcodeMeta must name a .transcode.json sidecar`);
  }
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
    const seenSegmentIds = new Set();
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
        // Footage ids address a CLIP, not a file: the same plate may appear
        // twice, so the id — not the path — is what advice and the tree bind
        // to. Two clips sharing one id would silently merge those bindings.
        if (typeof s.id === 'string' && s.id.trim()) {
          if (seenSegmentIds.has(s.id)) {
            problems.push(`scenes[${i}].id "${s.id}" appears more than once — each footage segment needs its own id`);
          } else {
            seenSegmentIds.add(s.id);
          }
        }
        return;
      }
      checkSegmentSequence(s, `scenes[${i}]`, problems);
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

  if (!Array.isArray(film.deliverables)) {
    problems.push('deliverables must be an array');
  } else {
    if (film.deliverables.length > MAX_FILM_DELIVERABLES) problems.push(`deliverables exceeds ${MAX_FILM_DELIVERABLES}`);
    const ids = new Set();
    const filenames = new Set();
    const masterFilename = sanitizeDeliverableBase(film.outputFilename ?? 'film');
    if (masterFilename) filenames.add(masterFilename);
    film.deliverables.forEach((deliverable, index) => {
      const at = `deliverables[${index}]`;
      validateDeliverable(deliverable, at, problems);
      if (typeof deliverable?.id === 'string') {
        if (ids.has(deliverable.id)) problems.push(`${at}.id "${deliverable.id}" is duplicated`);
        ids.add(deliverable.id);
      }
      const filename = sanitizeDeliverableBase(deliverable?.outputFilename);
      if (filename) {
        if (filenames.has(filename)) problems.push(`${at}.outputFilename "${filename}" duplicates the master or another deliverable`);
        filenames.add(filename);
      }
    });
  }

  // A film may inherit the machine policy (null) or override either severity
  // list. We preserve partial overrides so a producer can, for example, block
  // black runs without having to duplicate the global warning list.
  const review = film.review;
  if (review !== undefined && review !== null) {
    if (typeof review !== 'object' || Array.isArray(review)) {
      problems.push('review must be an object with optional block/warn arrays, or null');
    } else {
      for (const field of ['block', 'warn']) {
        if (review[field] === undefined) continue;
        if (!Array.isArray(review[field])) {
          problems.push(`review.${field}: array of review warning codes required`);
          continue;
        }
        const unknown = review[field].filter((code) => !REVIEW_WARNING_CODES.includes(code));
        if (unknown.length) problems.push(`review.${field}: unknown warning code(s) ${unknown.join(', ')}`);
        if (new Set(review[field]).size !== review[field].length) problems.push(`review.${field}: duplicate warning codes are not allowed`);
      }
      const overlap = (review.block ?? []).filter((code) => (review.warn ?? []).includes(code));
      if (overlap.length) problems.push(`review: a code cannot be both block and warn (${overlap.join(', ')})`);
      for (const key of Object.keys(review)) {
        if (!['block', 'warn'].includes(key)) problems.push(`review.${key} is not a review policy field`);
      }
    }
  }

  // Sequence metadata (v0.23): optional intent/notes per narrative label.
  // Keyed by the same string the segments carry, so regrouping is one edit.
  const seqs = film.sequences;
  if (seqs !== undefined && seqs !== null) {
    if (typeof seqs !== 'object' || Array.isArray(seqs)) {
      problems.push('sequences must be an object keyed by sequence label');
    } else {
      for (const [key, value] of Object.entries(seqs)) {
        if (!key.trim() || key.length > 80) problems.push(`sequences key "${key.slice(0, 20)}…" must be 1..80 characters`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          problems.push(`sequences["${key}"] must be an object`);
          continue;
        }
        if (value.intent !== undefined && (typeof value.intent !== 'string' || value.intent.length > 500)) {
          problems.push(`sequences["${key}"].intent must be a string of at most 500 characters`);
        }
        for (const k of Object.keys(value)) {
          if (!['intent'].includes(k)) problems.push(`sequences["${key}"].${k} is not a sequence field`);
        }
      }
    }
  }

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
    const derivedFrom = s.derivedFrom;
    return {
      // A footage clip's stable handle (v0.23). Scenes already have one — the
      // slug — so only footage needed stamping, and it is what advice, tree
      // rows and delivery manifests bind to. Without it the only address is
      // the array index, which every reorder invalidates: yesterday's note on
      // "the outro clip" would silently re-aim at whatever is 4th today.
      id: typeof s.id === 'string' && s.id.trim() ? s.id : `seg-${randomUUID().slice(0, 8)}`,
      footage: typeof s.footage === 'string' ? s.footage.replace(/\\/g, '/') : s.footage,
      durationInFrames: s.durationInFrames,
      ...(s.label !== undefined ? { label: s.label } : {}),
      ...(derivedFrom !== undefined
        ? {
          derivedFrom: derivedFrom && typeof derivedFrom === 'object' && !Array.isArray(derivedFrom)
            ? {
              ...(derivedFrom.asset !== undefined
                ? { asset: typeof derivedFrom.asset === 'string' ? derivedFrom.asset.replace(/\\/g, '/') : derivedFrom.asset }
                : {}),
              ...(derivedFrom.transcodeMeta !== undefined
                ? { transcodeMeta: typeof derivedFrom.transcodeMeta === 'string'
                  ? derivedFrom.transcodeMeta.replace(/\\/g, '/')
                  : derivedFrom.transcodeMeta }
                : {}),
            }
            : derivedFrom,
        }
        : {}),
      ...(s.sequence !== undefined ? { sequence: s.sequence } : {}),
      // A segment carrying BOTH keys is a confused caller, not a footage entry
      // with a stray field. Keeping the slug here is what lets validateFilm
      // refuse it: dropping it would silently pick footage and persist a
      // decision nobody made.
      ...(s.slug !== undefined ? { slug: s.slug } : {}),
    };
  }
  return {
    slug: s?.slug,
    ...(s?.sequence !== undefined ? { sequence: s.sequence } : {}),
  };
}

/** Fill defaults and stamp ids on timeline items so editors can address them. */
export function normalizeFilm(input = {}) {
  const stampIds = (arr) => (Array.isArray(arr) ? arr.map((x) => (x && typeof x === 'object' && !x.id ? { ...x, id: randomUUID() } : x)) : arr);
  const sd = input.sceneDefaults;
  const pickInts = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
  const outputFilename = input.outputFilename ?? 'film';
  return {
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    scenes: Array.isArray(input.scenes) ? input.scenes.map(normalizeSegment) : [],
    outputFilename,
    sceneDefaults: sd && typeof sd === 'object'
      ? pickInts(sd, ['fps', 'width', 'height', 'durationInFrames'])
      : null,
    audio: stampIds(input.audio ?? []),
    overlays: stampIds(input.overlays ?? []),
    captions: stampIds(input.captions ?? []),
    captionStyle: { sizePct: 4.5, position: 'bottom', ...(input.captionStyle ?? {}) },
    sequences: input.sequences ?? {},
    audioTargetPeakDb: input.audioTargetPeakDb ?? null,
    burnCaptions: input.burnCaptions ?? false,
    // A saved film stores full preset snapshots.  No build path reads global
    // settings to reinterpret a variant later, so changing a workspace preset
    // cannot silently change an existing production.
    deliverables: Array.isArray(input.deliverables)
      ? input.deliverables.map((deliverable) => normalizeDeliverable(deliverable, { baseFilename: outputFilename }))
      : (input.deliverables ?? []),
    review: input.review === null || input.review === undefined
      ? null
      : {
        ...(input.review?.block !== undefined ? { block: input.review.block } : {}),
        ...(input.review?.warn !== undefined ? { warn: input.review.warn } : {}),
        ...Object.fromEntries(Object.entries(input.review ?? {}).filter(([key]) => !['block', 'warn'].includes(key))),
      },
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
    // Derived from the very same output profile the renderer applies, so a
    // signature describes a decision rather than the accident of a probe.
    color: outputColorProfile(output),
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

const sameTranscodeIdentity = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);

function hasRecordedTranscodeIdentity(identity) {
  return !!identity
    && typeof identity === 'object'
    && typeof identity.source === 'string'
    && typeof identity.bytes === 'number'
    && typeof identity.mtimeMs === 'number'
    && identity.request && typeof identity.request === 'object';
}

/**
 * Verify the source behind a prepared footage file without copying its
 * transcode manifest into the film document. The sidecar is authoritative: it
 * names the exact source identity and transformation request that produced the
 * prepared clip. A film only keeps a pointer to that evidence.
 */
async function planFootageProvenance({ film, ref, index, rel, problems }) {
  const derived = ref.derivedFrom;
  if (!derived) return null;
  const base = {
    asset: derived.asset,
    transcodeMeta: derived.transcodeMeta,
    sourceVerified: null,
  };
  const addProblem = (reason, message, extra = {}) => {
    problems.push({
      code: ErrorCodes.FOOTAGE_SOURCE_CHANGED,
      segment: rel,
      sourceAsset: derived.asset,
      transcodeMeta: derived.transcodeMeta,
      reason,
      message,
      ...extra,
    });
    return { ...base, sourceVerified: false, reason };
  };

  let metaPath;
  try {
    metaPath = resolveInTarget(film.path, derived.transcodeMeta);
  } catch {
    return addProblem(
      'transcode_metadata_missing',
      `Footage ${index + 1}: "${rel}" records source "${derived.asset}", but its transcode metadata ` +
        `"${derived.transcodeMeta}" is not a valid film asset path. Re-run the transcode before building.`,
    );
  }
  const meta = readTranscodeMetaFile(metaPath);
  const recorded = meta?.identity;
  if (!hasRecordedTranscodeIdentity(recorded)) {
    return addProblem(
      'transcode_metadata_missing',
      `Footage ${index + 1}: "${rel}" was prepared from "${derived.asset}", but its transcode metadata ` +
        `"${derived.transcodeMeta}" is missing or unreadable. Re-run the transcode before building.`,
    );
  }

  const sourceStat = await fsp.stat(recorded.source).catch(() => null);
  if (!sourceStat?.isFile()) {
    return addProblem(
      'source_missing',
      `Footage ${index + 1}: the source "${derived.asset}" recorded for "${rel}" is no longer available. ` +
        'Re-run the transcode from the current source before building.',
      { recorded: { bytes: recorded.bytes, mtimeMs: recorded.mtimeMs } },
    );
  }

  const current = transcodeIdentity({
    sourceAbs: recorded.source,
    bytes: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
    request: recorded.request,
  });
  if (!sameTranscodeIdentity(recorded, current)) {
    return addProblem(
      'source_identity_changed',
      `Footage ${index + 1}: source "${derived.asset}" changed after "${rel}" was prepared. ` +
        'Re-run the transcode so this trim reflects the current source before building.',
      {
        recorded: { bytes: recorded.bytes, mtimeMs: recorded.mtimeMs },
        current: { bytes: current.bytes, mtimeMs: current.mtimeMs },
      },
    );
  }

  return { ...base, sourceVerified: true };
}

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
    ...(ref.id ? { id: ref.id } : {}),
    footage: rel,
    ...(ref.label ? { label: ref.label } : {}),
    ...(ref.sequence ? { sequence: ref.sequence } : {}),
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

  const derivedFrom = await planFootageProvenance({ film, ref, index, rel, problems });

  const media = await probeMedia({ filePath: abs, ffprobePath }).catch(() => null);
  if (!media) {
    // Unprobeable is not the same as missing: the file is there, but nothing can
    // be verified about it, and saying so beats inventing a verdict.
    return {
      ...base,
      missing: false,
      probed: false,
      framesVerified: null,
      signature: null,
      ...(derivedFrom ? { derivedFrom } : {}),
    };
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
    ...(derivedFrom ? { derivedFrom } : {}),
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
    const base = {
      kind: 'scene', sceneId, slug: ref.slug, index: i,
      ...(ref.sequence ? { sequence: ref.sequence } : {}),
    };
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
    const stale = rendered ? renderDeliveryStaleness(meta, config, outFile) : null;
    // A matching config is not enough after staged promotion: a crash can land
    // a replacement file before its sidecar.  New sidecars carry the cheap file
    // identity recorded at promotion; legacy sidecars stay deliberately
    // unverified rather than being trusted over an unknown file.
    const identityMatches = rendered && meta ? renderOutputIdentityMatches(meta, outFile) : null;
    const identityStale = stale?.changed?.includes('outputIdentity') ?? false;
    if (stale) {
      problems.push({
        code: 'stale_render',
        sceneId,
        message: identityStale
          ? `Scene "${config.name}" output changed after its render metadata was written — re-render it`
          : `Scene "${config.name}" was rendered at different settings (${describeStaleness(stale)}) — re-render it`,
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
      // false = rendered but stale; null = legacy/missing metadata that cannot
      // prove the file at this path is the file it describes.
      renderVerified: rendered ? (meta ? (stale ? false : (identityMatches === true ? true : null)) : null) : false,
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
  // This is intentionally a conservative estimate, not a gate.  Real line
  // breaking belongs to libass at build time; the deliverable contact sheet is
  // the authoritative visual check.  Still, an obviously long caption should
  // be visible in the plan before an expensive vertical build is started.
  const source = scenes.find((scene) => !scene.missing && scene.width && scene.height) ?? null;
  for (const deliverable of film.deliverables ?? []) {
    if (!deliverable?.width || !deliverable?.height) continue; // validateFilm names the schema fault on save.
    const capacity = captionSafeCapacity({
      width: deliverable.width,
      height: deliverable.height,
      captionStyle: { ...(film.captionStyle ?? {}), ...(deliverable.captionStyle ?? {}) },
      safeArea: deliverable.safeAreas?.caption,
    });
    for (const [index, caption] of (film.captions ?? []).entries()) {
      const text = String(caption?.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > capacity.maxChars) {
        problems.push({
          code: 'caption_may_overflow_safe_area',
          deliverable: deliverable.id,
          captionId: caption.id ?? null,
          message: `Caption ${index + 1} is ${text.length} characters; ${deliverable.id}'s caption-safe area is estimated for about ${capacity.maxChars}. Review its contact sheet after build.`,
          estimatedCapacity: capacity.maxChars,
          actualChars: text.length,
          ...(source ? { source: { width: source.width, height: source.height } } : {}),
        });
      }
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
    // Narrative bands (v0.23) — what the review UI draws above the timeline
    // and what a "Sequence 2" advice target resolves against.
    sequences: sequenceBands(scenes, film.sequences ?? {}),
    // The structured contract (v0.22). `signature.id` is the string this field
    // used to be, and the one every scene's own `signature` is compared against.
    signature: filmSignature(configs),
    problems,
  };
}

/**
 * Derive narrative sequence bands from planned segments (v0.23). Pure.
 *
 * Consecutive segments sharing a `sequence` label form one band; unlabeled
 * segments form anonymous bands (`sequence: null`) so the film timeline is
 * always fully covered — a partially labeled film still navigates sensibly.
 * A label that appears again later (out of order) is a separate band on
 * purpose: bands describe the timeline as it plays, not a grouping ideal.
 *
 * @param {Array} scenes  planFilm's segments, offsets already assigned
 * @param {object} meta   film.sequences — { [label]: { intent? } }
 */
export function sequenceBands(scenes, meta = {}) {
  const bands = [];
  for (const s of scenes ?? []) {
    const label = s.sequence ?? null;
    const last = bands[bands.length - 1];
    if (last && last.sequence === label) {
      last.toIndex = s.index;
      last.durationInFrames += s.durationInFrames ?? 0;
      last.segments += 1;
      continue;
    }
    bands.push({
      sequence: label,
      ...(label && meta[label]?.intent ? { intent: meta[label].intent } : {}),
      fromIndex: s.index,
      toIndex: s.index,
      segments: 1,
      filmOffset: s.filmOffset ?? 0,
      startSeconds: s.startSeconds ?? 0,
      durationInFrames: s.durationInFrames ?? 0,
    });
  }
  return bands;
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
 * @param {object} opts      { width, height, fps, subtitlesFile?, baseFilter? }
 * @returns {{ filterComplex: string, outLabel: string }}
 */
export function buildOverlayGraph(overlays, { width, height, fps, subtitlesFile = null, baseFilter = null } = {}) {
  const chains = [];
  let prev = '0:v';
  // Stage-A deliverables compile their crop against the resolved film layout,
  // then hand that transformed base into the ordinary overlay/subtitle pass.
  // Keeping this here means overlays are positioned in the target geometry,
  // never accidentally in the landscape master and cropped afterward.
  if (baseFilter) {
    chains.push(`[0:v]${baseFilter}[base]`);
    prev = 'base';
  }
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
    chains.push(`[${prev}]subtitles=${subtitlesFile}[${out}]`);
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
async function resolveFilmForBuild({ film, store, requireRendered = true, deliverableId = null }) {
  if (!(film.scenes ?? []).length) {
    throw new EngineError(ErrorCodes.INVALID_FILM, 'a film needs at least one scene before it can build', { problems: ['scenes is empty'] });
  }
  // A provenance pointer is explicitly a production-safety contract: the plan
  // found an outdated trim before a build was submitted, and a direct API call
  // must not be able to bypass that warning. Old films with no pointer keep the
  // existing fast path and are not probed here.
  if (film.scenes.some((segment) => segment?.derivedFrom !== undefined)) {
    const provenancePlan = await planFilm({ film, store });
    const changedSources = provenancePlan.problems.filter((problem) => problem.code === ErrorCodes.FOOTAGE_SOURCE_CHANGED);
    if (changedSources.length) {
      throw new EngineError(
        ErrorCodes.FOOTAGE_SOURCE_CHANGED,
        'One or more prepared footage sources changed after their transcodes. Re-run the affected transcode before building.',
        { filmId: film.id, problems: changedSources },
      );
    }
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
        ...(s.id ? { id: s.id } : {}),
        footage: rel,
        segmentPath: abs,
        durationInFrames: s.durationInFrames,
        name: s.label ?? rel.split('/').pop(),
        ...(s.sequence ? { sequence: s.sequence } : {}),
      });
      continue;
    }
    const sceneId = `${film.id}/${s.slug}`;
    const entry = await store.getScene(sceneId);
    const config = await store.readConfig(sceneId);
    sceneData.push({
      kind: 'scene', sceneId, slug: s.slug, path: entry.path, config,
      ...(s.sequence ? { sequence: s.sequence } : {}),
    });
  }
  const hasMasterAudio = !!(film.audio ?? []).length;
  const info = validateScenes(sceneData, { hasMasterAudio, requireRendered });

  const deliverable = resolveFilmDeliverable(film, deliverableId);
  const base = sanitizeBase(deliverable?.outputFilename ?? film.outputFilename);
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

  const firstScene = sceneData.find((s) => !isFootage(s));
  const sourceWidth = firstScene?.config.width ?? film.sceneDefaults?.width ?? null;
  const sourceHeight = firstScene?.config.height ?? film.sceneDefaults?.height ?? null;
  if (deliverable && (!sourceWidth || !sourceHeight)) {
    throw new EngineError(ErrorCodes.INVALID_FILM,
      `Cannot build deliverable "${deliverable.id}" without source dimensions. Set the film's sceneDefaults.`, {
        deliverable: deliverable.id,
      });
  }
  const totalFrames = sceneData.reduce((n, s) => n + segmentFrames(s), 0);
  return {
    sceneData, info, outDir, outputPath, base, ext, audioTracks, overlays, totalFrames,
    deliverable, sourceWidth, sourceHeight,
  };
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
export async function buildFilmArtifact({
  film, store, ffmpegPath = 'ffmpeg', onSpawn, progress, signal, jobId = null, reviewPolicy = null,
  deliverableId = null, agent = currentAgentId(),
}) {
  const checkCancel = () => {
    if (signal?.aborted) throw new EngineError(ErrorCodes.CANCELLED, 'film build cancelled');
  };
  const r = await resolveFilmForBuild({ film, store, deliverableId });
  const {
    sceneData, info, outDir, outputPath, base, ext, audioTracks, overlays, totalFrames,
    deliverable, sourceWidth, sourceHeight,
  } = r;
  await fsp.mkdir(outDir, { recursive: true });
  // The build never writes an in-progress concat, finishing encode, or mastering
  // re-mux to the caller-visible delivery name.  A failed job leaves this file
  // available for diagnosis while the prior delivery remains untouched.
  const stageId = jobId == null || jobId === '' ? randomUUID() : jobId;
  const stagedOutputPath = stagingOutputPath(outputPath, { jobId: stageId });
  const effectiveReviewPolicy = reviewPolicy ?? resolveReviewPolicy({ filmPolicy: film.review });

  const fps = info.fps ?? film.sceneDefaults?.fps ?? null;
  const captions = film.captions ?? [];
  const burn = !!film.burnCaptions && captions.length > 0;
  // A Stage-A variant always needs one target-size encode, even without
  // overlays/captions. The master path retains the existing lossless concat
  // fast path whenever no finishing work is requested.
  const finishing = overlays.length > 0 || burn || !!deliverable;
  // Scene 1 is the film's encode voice — but an all-footage film has no scene
  // config, so the geometry the finishing pass needs comes from the first
  // segment that can supply it, falling back to sceneDefaults.
  const firstScene = sceneData.find((s) => !isFootage(s));
  const firstOutput = firstScene?.config.output ?? {};
  const width = deliverable?.width ?? sourceWidth;
  const height = deliverable?.height ?? sourceHeight;
  const captionStyle = { ...(film.captionStyle ?? {}), ...(deliverable?.captionStyle ?? {}) };

  progress?.phase('assembling');
  checkCancel();

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-filmbuild-'));
  const stagedSrtPath = captions.length
    ? stagedOutputPath.slice(0, -ext.length) + '.srt'
    : null;
  let result;
  let reframe = null;
  try {
    // A held deliverable cannot be promoted however long the assemble takes,
    // and on a captions/overlays build that assemble is a full re-encode.
    await assertDeliveryWritable({ outputPath });
    await prepareStagingOutput(outputPath, { jobId: stageId });
    const assembleTarget = finishing ? path.join(tmp, `master${ext}`) : stagedOutputPath;
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
      await fsp.writeFile(stagedSrtPath, captionsToSrt(captions, fps), 'utf8');
    }

    if (finishing) {
      progress?.phase(deliverable ? 'reframing-deliverable' : 'finishing');
      let subtitlesFile = null;
      if (burn) {
        subtitlesFile = 'captions.ass';
        await fsp.writeFile(path.join(tmp, subtitlesFile), captionsToAss(captions, fps, { width, height, style: captionStyle }), 'utf8');
      }
      reframe = deliverable
        ? compileReframeFilter({
          reframe: deliverable.reframe,
          sceneLayout: result.sceneLayout,
          sourceWidth,
          sourceHeight,
          targetWidth: width,
          targetHeight: height,
          fps,
        })
        : null;
      const { filterComplex, outLabel } = buildOverlayGraph(overlays, {
        width, height, fps, subtitlesFile,
        baseFilter: reframe?.filter ?? null,
      });
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
        // A finishing/reframe pass may otherwise duplicate the terminal frame
        // while reconciling timestamps. The resolved timeline is authoritative.
        '-frames:v', String(totalFrames),
        stagedOutputPath,
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

    // Picture review is advisory in the same sense as audio balance warnings:
    // it measures the completed deliverable but never turns a valid build into
    // a failure because a diagnostic pass was unavailable.
    let picture;
    let pictureReport = null;
    let pictureError = null;
    try {
      progress?.phase('measuring-picture');
      const measured = await measureRenderedPicture({
        filePath: stagedOutputPath, fps, totalFrames, sceneLayout: result.sceneLayout,
        ffmpegPath, signal, onSpawn,
      });
      pictureReport = measured;
      picture = measured.summary;
    } catch (err) {
      if (signal?.aborted) throw err;
      pictureError = err?.message ?? 'Picture measurement was unavailable';
      picture = { unavailable: true, message: pictureError };
    }

    // Same policy as a scene render: ffprobe absence is surfaced as unverified,
    // not misrepresented as a frame-count match.  A measured mismatch blocks
    // promotion and leaves the previous delivery intact.
    const actualFrames = await probeFrameCount({ filePath: stagedOutputPath, onSpawn, signal }).catch(() => null);
    if (actualFrames !== null && actualFrames !== totalFrames) {
      // Do not throw before the review is persisted.  A staged delivery gets
      // the same evidence and policy treatment as a scene render; the default
      // policy blocks its promotion, while an explicit per-film policy may
      // deliberately downgrade it to a warning.
      progress?.log(
        'warn',
        `film output has ${actualFrames} frames but the plan requires ${totalFrames}; review policy will decide promotion`,
      );
    }

    // Build the artefacts from the staged MP4, never the existing delivery.
    // A policy block leaves the old output in place while retaining the staged
    // movie plus its JSON/contact evidence for diagnosis.
    progress?.phase('creating-review');
    const review = await createDeliveryReview({
      stagedOutputPath,
      deliveryPath: outputPath,
      fps,
      totalFrames,
      sceneLayout: result.sceneLayout,
      captions,
      audio: result.audio ?? null,
      picture: pictureReport,
      pictureError,
      frameCheck: { expected: totalFrames, actual: actualFrames, verified: actualFrames !== null },
      policy: effectiveReviewPolicy,
      safeAreas: deliverable?.safeAreas ?? null,
      ffmpegPath,
      signal,
      onSpawn,
    });
    assertReviewAllowsPromotion(review, { stagingPath: stagedOutputPath });

    checkCancel();
    progress?.phase('promoting');
    await promoteStagingOutput({ stagedPath: stagedOutputPath, outputPath });
    let reviewArtifactWarning = null;
    try {
      // JSON is promoted last: a consumer that sees it can rely on the contact
      // sheet already being beside the freshly promoted movie.
      await promoteStagingOutput({ stagedPath: review.stagedPaths.contactPath, outputPath: review.paths.contactPath });
      await promoteStagingOutput({ stagedPath: review.stagedPaths.reviewPath, outputPath: review.paths.reviewPath });
    } catch (err) {
      reviewArtifactWarning = err?.message ?? 'Review artefacts could not be promoted';
      progress?.log('warn', reviewArtifactWarning);
    }
    let captionSidecarWarning = null;
    if (stagedSrtPath) {
      const finalSrtPath = path.join(outDir, `${base}.srt`);
      try {
        await promoteStagingOutput({ stagedPath: stagedSrtPath, outputPath: finalSrtPath });
        srtPath = finalSrtPath;
      } catch (err) {
        // The movie is the primary delivery and is already safely promoted.
        // A derived caption sidecar must not recast that success as a failed
        // build after the fact; surface the issue in the terminal result.
        captionSidecarWarning = err?.message ?? 'Caption sidecar could not be promoted';
        progress?.log('warn', captionSidecarWarning);
      }
    }

    const built = {
      ...result,
      filmId: film.id,
      outputPath,
      deliverable: deliverable
        ? {
          id: deliverable.id,
          label: deliverable.label,
          width: deliverable.width,
          height: deliverable.height,
          outputFilename: deliverable.outputFilename,
          safeAreas: deliverable.safeAreas,
          reframe: reframe ? { sourceWidth, sourceHeight, ...reframe } : null,
        }
        : { id: 'master', width: sourceWidth, height: sourceHeight, outputFilename: film.outputFilename },
      overlaysApplied: overlays.length,
      captions: captions.length,
      captionsBurned: burn,
      ...(srtPath ? { srtPath } : {}),
      reEncoded: finishing,
      framesVerified: actualFrames !== null,
      promoted: true,
      review: {
        reviewPath: review.paths.reviewPath,
        contactPath: review.paths.contactPath,
        warnings: review.report.warnings,
      },
      ...(reviewArtifactWarning ? { reviewArtifactWarning } : {}),
      ...(captionSidecarWarning ? { captionSidecarWarning } : {}),
      picture,
    };

    // Freeze this build as an immutable delivery (v0.23) — the record human
    // review pins to. Best-effort by the sidecar rule: the promoted film is
    // already the delivery of record, and history-keeping must not fail it.
    try {
      progress?.phase('archiving-delivery');
      const archived = await archiveDelivery({ store, film, result: built, agent, jobId });
      built.deliveryId = archived.id;
    } catch (err) {
      built.deliveryArchiveWarning = err?.message ?? 'delivery archive failed';
      progress?.log('warn', `delivery archive failed (the built film is unaffected): ${built.deliveryArchiveWarning}`);
    }
    return built;
  } catch (err) {
    const e = err instanceof EngineError ? err : new EngineError(ErrorCodes.INTERNAL, String(err?.message ?? err));
    e.detail = { ...(e.detail ?? {}), stagingPath: stagedOutputPath };
    throw e;
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
export async function submitFilmBuild({
  film, store, jobs, ffmpegPath = 'ffmpeg', reviewPolicy = null, deliverableId = null,
  agent = currentAgentId(),
}) {
  const r = await resolveFilmForBuild({ film, store, deliverableId });
  const settings = reviewPolicy === null
    ? await readSettings(store.dataDir).catch(() => null)
    : null;
  const effectiveReviewPolicy = reviewPolicy ?? resolveReviewPolicy({
    globalPolicy: settings?.render?.review,
    filmPolicy: film.review,
  });
  const submitted = jobs.startRender({
    targetId: film.id,
    scenePath: film.path,
    // An all-footage film has no scene config to read a rate from.
    config: { durationInFrames: r.totalFrames, fps: r.info.fps ?? film.sceneDefaults?.fps ?? 30 },
    outputPath: r.outputPath,
    renderFn: (o) => buildFilmArtifact({
      film, store, ffmpegPath,
      reviewPolicy: effectiveReviewPolicy,
      deliverableId,
      agent,
      jobId: o.jobId,
      onSpawn: o.onChildPid,
      progress: o.progress,
      signal: o.signal,
    }),
  });
  return {
    ...submitted,
    outputPath: r.outputPath,
    totalFrames: r.totalFrames,
    filmId: film.id,
    deliverable: r.deliverable
      ? { id: r.deliverable.id, label: r.deliverable.label, width: r.deliverable.width, height: r.deliverable.height }
      : { id: 'master', width: r.sourceWidth, height: r.sourceHeight },
  };
}
