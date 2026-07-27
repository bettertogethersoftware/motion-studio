/**
 * Saved films — a persistent film definition the Studio film editor and the
 * MCP tools share.
 *
 * `build_film` (core/film.js) is a one-shot verb: hand it scenes + a master
 * audio list and it assembles once, remembering nothing. That is the right
 * shape for an agent driving a scripted build, and the wrong shape for a
 * human iterating in an editor — a film you are still cutting needs to be a
 * *document*: reopenable, patchable a track at a time, buildable many times.
 *
 * This module is that document layer:
 *
 *   FilmStore        — films.json registry in the data dir (same pattern as
 *                      ProjectStore's projects.json; the definitions are small
 *                      and belong beside the project registry, not inside any
 *                      one project folder)
 *   validateFilm     — every save goes through it; a broken film never persists
 *   planFilm         — non-throwing resolution: layout, per-scene status and a
 *                      `problems` list the editor can render as warnings
 *   captionsToSrt/Ass — caption track → sidecar / burn-in subtitle documents
 *   buildOverlayGraph — pure -filter_complex builder for the finishing pass
 *   buildFilmArtifact — assembleFilm (lossless concat + master audio) plus the
 *                      optional finishing encode that burns overlays/captions
 *   submitFilmBuild  — the same build as a JobManager job, so the Studio and
 *                      MCP callers poll film builds exactly like renders
 *
 * A film references two kinds of projects: SCENE projects (rendered video, in
 * play order) and one OUTPUT project whose assets/ holds the master audio and
 * overlay files and whose out/ receives the built film. Audio/overlay `src`
 * paths are project-relative under the output project's assets/, identical to
 * config.audio and build_film's master timeline.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { EngineError, ErrorCodes } from './errors.js';
import { defaultDataDir } from './project.js';
import { getFormat } from './formats.js';
import {
  sceneSignature, sceneOutputPath, sceneHasAudio, validateScenes, assembleFilm,
} from './film.js';
import { buildVideoArgs, runFfmpeg } from './encoder.js';
import { resolveInProject } from './sandbox.js';

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

function checkTrack(t, i, problems) {
  const at = `audio[${i}]`;
  if (!t || typeof t !== 'object') { problems.push(`${at} must be an object`); return; }
  if (typeof t.src !== 'string' || !t.src.replace(/\\/g, '/').startsWith('assets/')) {
    problems.push(`${at}.src must be a project-relative path under assets/`);
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
    problems.push(`${at}.src must be a project-relative path under assets/`);
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

  if (!Array.isArray(film.scenes)) problems.push('scenes must be an array of { projectId }');
  else {
    if (film.scenes.length > MAX_FILM_SCENES) problems.push(`scenes exceeds ${MAX_FILM_SCENES}`);
    film.scenes.forEach((s, i) => {
      if (!s || typeof s.projectId !== 'string' || !s.projectId) problems.push(`scenes[${i}].projectId must be a string`);
    });
  }

  if (film.outputProjectId !== null && film.outputProjectId !== undefined && typeof film.outputProjectId !== 'string') {
    problems.push('outputProjectId must be a project id string or null');
  }
  if (film.outputFilename !== undefined) {
    const base = String(film.outputFilename);
    if (base.includes('/') || base.includes('\\') || base.includes('..') || !base.trim()) {
      problems.push('outputFilename must be a bare filename');
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
  return {
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    scenes: Array.isArray(input.scenes) ? input.scenes.map((s) => ({ projectId: s?.projectId })) : [],
    outputProjectId: input.outputProjectId ?? null,
    outputFilename: input.outputFilename ?? 'film',
    audio: stampIds(input.audio ?? []),
    overlays: stampIds(input.overlays ?? []),
    captions: stampIds(input.captions ?? []),
    captionStyle: { sizePct: 4.5, position: 'bottom', ...(input.captionStyle ?? {}) },
    audioTargetPeakDb: input.audioTargetPeakDb ?? null,
    burnCaptions: input.burnCaptions ?? false,
  };
}

/* ------------------------------------------------------------------ */
/* FilmStore — films.json beside projects.json                         */
/* ------------------------------------------------------------------ */

export class FilmStore {
  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
    this.registryPath = path.join(dataDir, 'films.json');
  }

  async _load() {
    try {
      const reg = JSON.parse(await fsp.readFile(this.registryPath, 'utf8'));
      return Array.isArray(reg.films) ? reg : { films: [] };
    } catch {
      return { films: [] };
    }
  }

  async _save(reg) {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const tmp = this.registryPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(reg, null, 2));
    await fsp.rename(tmp, this.registryPath); // atomic on same volume
  }

  async listFilms() {
    return (await this._load()).films;
  }

  async getFilm(filmId) {
    const film = (await this._load()).films.find((f) => f.id === filmId);
    if (!film) throw new EngineError(ErrorCodes.FILM_NOT_FOUND, `No film with id "${filmId}"`, { filmId });
    return film;
  }

  async createFilm(input) {
    const film = validateFilm({ ...normalizeFilm(input), id: randomUUID() });
    const now = new Date().toISOString();
    film.createdAt = now;
    film.updatedAt = now;
    const reg = await this._load();
    reg.films.push(film);
    await this._save(reg);
    return film;
  }

  /**
   * Merge a patch into an existing film. Only film fields are accepted, and
   * array fields REPLACE (a timeline edit is a statement of the whole track —
   * merging item-by-item would need addressing semantics no caller wants).
   */
  async updateFilm(filmId, patch) {
    const ALLOWED = new Set(['name', 'scenes', 'outputProjectId', 'outputFilename',
      'audio', 'overlays', 'captions', 'captionStyle', 'audioTargetPeakDb', 'burnCaptions']);
    for (const k of Object.keys(patch ?? {})) {
      if (!ALLOWED.has(k)) throw new EngineError(ErrorCodes.INVALID_FILM, `Film field "${k}" cannot be updated`, { field: k });
    }
    const reg = await this._load();
    const idx = reg.films.findIndex((f) => f.id === filmId);
    if (idx < 0) throw new EngineError(ErrorCodes.FILM_NOT_FOUND, `No film with id "${filmId}"`, { filmId });
    const cur = reg.films[idx];
    const merged = validateFilm({
      ...normalizeFilm({ ...cur, ...patch }),
      id: cur.id, createdAt: cur.createdAt,
    });
    merged.updatedAt = new Date().toISOString();
    reg.films[idx] = merged;
    await this._save(reg);
    return merged;
  }

  async removeFilm(filmId) {
    const reg = await this._load();
    const idx = reg.films.findIndex((f) => f.id === filmId);
    if (idx < 0) throw new EngineError(ErrorCodes.FILM_NOT_FOUND, `No film with id "${filmId}"`, { filmId });
    const [removed] = reg.films.splice(idx, 1);
    await this._save(reg);
    return { removed: removed.id, name: removed.name };
  }
}

/* ------------------------------------------------------------------ */
/* Planning — resolve a film against reality without throwing          */
/* ------------------------------------------------------------------ */

/**
 * Resolve every reference in a film and report, rather than throw. The editor
 * shows `problems` as a validation chip; a film with problems can still be
 * edited (that is the point of an editor), it just cannot BUILD.
 *
 * @returns {{ scenes, totalFrames, durationSeconds, fps, format, signature,
 *             outputProject, problems }}
 */
export async function planFilm({ film, store }) {
  const problems = [];
  const scenes = [];
  let signature = null, fps = null, format = null;

  for (const [i, ref] of (film.scenes ?? []).entries()) {
    const base = { projectId: ref.projectId, index: i };
    let entry = null, config = null;
    try {
      entry = await store.getProjectEntry(ref.projectId);
      config = await store.readConfig(ref.projectId);
    } catch {
      problems.push({ code: 'scene_missing', projectId: ref.projectId, message: `Scene ${i + 1}: project ${ref.projectId} is missing or unreadable` });
      scenes.push({ ...base, missing: true, durationInFrames: 0 });
      continue;
    }
    const sig = sceneSignature(config);
    if (signature === null) { signature = sig; fps = config.fps; format = config.output?.format ?? 'mp4'; }
    else if (sig !== signature) {
      problems.push({ code: 'signature_mismatch', projectId: ref.projectId, message: `Scene "${config.name}" is ${sig} — the film is ${signature}. Scenes must share resolution/fps/format to concatenate losslessly.` });
    }
    const outFile = sceneOutputPath(entry.path, config);
    const rendered = fs.existsSync(outFile);
    if (!rendered) {
      problems.push({ code: 'scene_not_rendered', projectId: ref.projectId, message: `Scene "${config.name}" has no rendered output yet` });
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

  // Output project + asset references.
  let outputProject = null;
  if (film.outputProjectId) {
    try {
      const entry = await store.getProjectEntry(film.outputProjectId);
      outputProject = { id: entry.id, name: entry.name, path: entry.path, missing: false };
      const checkAsset = (src, what) => {
        const rel = String(src ?? '').replace(/\\/g, '/');
        let ok = rel.startsWith('assets/');
        if (ok) {
          try { ok = fs.existsSync(resolveInProject(entry.path, rel)); } catch { ok = false; }
        }
        if (!ok) problems.push({ code: 'asset_missing', message: `${what} references ${src}, which does not exist in ${entry.name}'s assets` });
      };
      (film.audio ?? []).forEach((t, i) => checkAsset(t.src, t.label ? `Audio "${t.label}"` : `Audio track ${i + 1}`));
      (film.overlays ?? []).forEach((o, i) => checkAsset(o.src, `Overlay ${i + 1}`));
    } catch {
      outputProject = { id: film.outputProjectId, missing: true };
      problems.push({ code: 'output_project_missing', message: 'The film\'s output project is missing — master audio and overlays have nowhere to live' });
    }
  } else if ((film.audio ?? []).length || (film.overlays ?? []).length) {
    problems.push({ code: 'no_output_project', message: 'Master audio / overlays need an output project to hold their assets' });
  }

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
    outputProject,
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
    throw new EngineError(ErrorCodes.PATH_OUTSIDE_PROJECT, 'outputFilename must be a bare filename');
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
    const entry = await store.getProjectEntry(s.projectId);
    const config = await store.readConfig(s.projectId);
    sceneData.push({ projectId: s.projectId, path: entry.path, config });
  }
  const hasMasterAudio = !!(film.audio ?? []).length;
  const info = validateScenes(sceneData, { hasMasterAudio, requireRendered });

  const outId = film.outputProjectId ?? film.scenes[0].projectId;
  const outEntry = await store.getProjectEntry(outId);
  const outCfg = await store.readConfig(outId);
  const base = sanitizeBase(film.outputFilename);
  const ext = getFormat(info.format).ext;
  const outDir = path.join(outEntry.path, outCfg.output?.dir ?? 'out');
  const outputPath = path.join(outDir, base + ext);

  let audioTracks;
  if (hasMasterAudio) {
    audioTracks = [];
    for (const t of film.audio) {
      const rel = t.src.replace(/\\/g, '/');
      const abs = resolveInProject(outEntry.path, rel, { asAsset: true });
      if (!fs.existsSync(abs)) {
        throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `master audio not found: ${rel} in project ${outId}`, { path: rel });
      }
      audioTracks.push({ ...toMixerTracks([t])[0], src: abs });
    }
  }

  const overlays = [];
  for (const o of film.overlays ?? []) {
    const rel = o.src.replace(/\\/g, '/');
    const abs = resolveInProject(outEntry.path, rel, { asAsset: true });
    if (!fs.existsSync(abs)) {
      throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `overlay not found: ${rel} in project ${outId}`, { path: rel });
    }
    const ext2 = path.extname(abs).toLowerCase();
    overlays.push({ ...o, abs, isVideo: ['.mp4', '.webm', '.mov'].includes(ext2), isWebm: ext2 === '.webm' });
  }

  const totalFrames = sceneData.reduce((n, s) => n + s.config.durationInFrames, 0);
  return { sceneData, info, outEntry, outCfg, outDir, outputPath, base, ext, audioTracks, overlays, totalFrames };
}

/**
 * Build a saved film to its output file: lossless concat + master audio via
 * assembleFilm, then — only when the film has overlays or burns captions —
 * ONE finishing encode that composites them. Captions always also produce a
 * .srt sidecar next to the output, burned or not: players and platforms take
 * sidecars, and the sidecar survives a re-cut without re-encoding.
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
      projectRoot: r.outEntry.path,
      audioLimiter: r.outCfg.output?.audioLimiter !== false,
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
        ...buildVideoArgs({ ...r.outCfg.output, format: info.format, transparent: sceneData[0].config.output?.transparent }),
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
 * @returns {{ jobId, state, queuePosition?, outputPath, totalFrames }}
 */
export async function submitFilmBuild({ film, store, jobs, ffmpegPath = 'ffmpeg' }) {
  const r = await resolveFilmForBuild({ film, store });
  const submitted = jobs.startRender({
    projectId: film.outputProjectId ?? film.scenes[0].projectId,
    projectPath: r.outEntry.path,
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
