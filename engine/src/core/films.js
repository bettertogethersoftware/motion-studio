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
import { getFormat } from './formats.js';
import {
  sceneSignature, sceneOutputPath, sceneHasAudio, validateScenes, assembleFilm,
  readRenderMeta, renderStaleness, describeStaleness,
} from './film.js';
import { buildVideoArgs, runFfmpeg } from './encoder.js';
import { resolveInTarget } from './sandbox.js';

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

  if (!Array.isArray(film.scenes)) problems.push('scenes must be an array of { slug }');
  else {
    if (film.scenes.length > MAX_FILM_SCENES) problems.push(`scenes exceeds ${MAX_FILM_SCENES}`);
    const seen = new Set();
    film.scenes.forEach((s, i) => {
      if (!s || typeof s.slug !== 'string' || !SCENE_SLUG_RE.test(s.slug)) {
        problems.push(`scenes[${i}].slug must be a scene slug (lowercase a-z, 0-9, "-", "_")`);
      } else if (seen.has(s.slug)) {
        problems.push(`scenes[${i}].slug "${s.slug}" appears more than once — a scene plays once; ` +
          'to reuse footage, render it into two scenes');
      } else {
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

/** Fill defaults and stamp ids on timeline items so editors can address them. */
export function normalizeFilm(input = {}) {
  const stampIds = (arr) => (Array.isArray(arr) ? arr.map((x) => (x && typeof x === 'object' && !x.id ? { ...x, id: randomUUID() } : x)) : arr);
  const sd = input.sceneDefaults;
  const pickInts = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
  return {
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    scenes: Array.isArray(input.scenes) ? input.scenes.map((s) => ({ slug: s?.slug })) : [],
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

/* ------------------------------------------------------------------ */
/* Planning — resolve a film against reality without throwing          */
/* ------------------------------------------------------------------ */

/**
 * Resolve every reference in a film and report, rather than throw. The editor
 * shows `problems` as a validation chip; a film with problems can still be
 * edited (that is the point of an editor), it just cannot BUILD.
 *
 * @param {object} opts
 * @param {object} opts.film   a film from WorkspaceStore.getFilm (id + path + doc)
 * @param {object} opts.store  the WorkspaceStore
 * @returns {{ scenes, totalFrames, durationSeconds, fps, format, signature, problems }}
 */
export async function planFilm({ film, store }) {
  const problems = [];
  const scenes = [];
  let signature = null, fps = null, format = null;

  for (const [i, ref] of (film.scenes ?? []).entries()) {
    const sceneId = `${film.id}/${ref.slug}`;
    const base = { sceneId, slug: ref.slug, index: i };
    let entry = null, config = null;
    try {
      entry = await store.getScene(sceneId);
      config = await store.readConfig(sceneId);
    } catch {
      problems.push({ code: 'scene_missing', sceneId, message: `Scene ${i + 1}: "${ref.slug}" is missing or unreadable` });
      scenes.push({ ...base, missing: true, durationInFrames: 0 });
      continue;
    }
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
    const states = new Set(scenes.filter((s) => !s.missing).map((s) => s.hasAudio));
    if (states.size > 1) {
      problems.push({ code: 'mixed_scene_audio', message: 'Scenes mix audio and silence — add a master audio timeline, or render the scenes consistently' });
    }
  }

  // Running offsets, missing scenes contributing zero frames.
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
    signature,
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
  const sceneData = [];
  for (const s of film.scenes) {
    const sceneId = `${film.id}/${s.slug}`;
    const entry = await store.getScene(sceneId);
    const config = await store.readConfig(sceneId);
    sceneData.push({ sceneId, slug: s.slug, path: entry.path, config });
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

  const totalFrames = sceneData.reduce((n, s) => n + s.config.durationInFrames, 0);
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

  const fps = info.fps;
  const captions = film.captions ?? [];
  const burn = !!film.burnCaptions && captions.length > 0;
  const finishing = overlays.length > 0 || burn;
  const firstOutput = sceneData[0].config.output ?? {};
  const width = sceneData[0].config.width;
  const height = sceneData[0].config.height;

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
    config: { durationInFrames: r.totalFrames, fps: r.info.fps },
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
