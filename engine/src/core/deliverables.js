/**
 * Film deliverables (P0-3 Stage A).
 *
 * A film's scenes remain the one editorial source of truth. A deliverable is
 * a persisted instruction for turning that completed master into a platform
 * output: fixed target geometry, a crop centre per timeline segment, caption
 * style/safe regions, and an independent output base name.  It deliberately
 * does not invent a second scene layout; Stage B will do that by re-rendering
 * responsive compositions at target size.
 */

import { EngineError, ErrorCodes } from './errors.js';

export const MAX_FILM_DELIVERABLES = 12;
export const DELIVERABLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_REFRAME = Object.freeze({ xPct: 50, yPct: 50 });
const DEFAULT_CAPTION_STYLE = Object.freeze({ sizePct: 4.5, position: 'bottom' });

/** Insets define a rectangle, rather than an ambiguous "safe percentage". */
export const DEFAULT_SAFE_AREAS = Object.freeze({
  // Titles should live in the upper half, clear of platform chrome.
  title: Object.freeze({ leftPct: 7, rightPct: 7, topPct: 6, bottomPct: 50 }),
  // Captions have their own lower safe region, clear of social controls.
  caption: Object.freeze({ leftPct: 8, rightPct: 8, topPct: 55, bottomPct: 8 }),
});

/**
 * These are editable global presets, not an instruction to render all of them.
 * New films receive only the ids explicitly requested by an agent/user or the
 * workspace's new-film default ids.  An empty default means master-only.
 */
export const DEFAULT_DELIVERABLE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'youtube-16x9', label: 'YouTube 16:9', width: 1920, height: 1080,
    captionStyle: Object.freeze({ sizePct: 4.5, position: 'bottom' }),
    safeAreas: DEFAULT_SAFE_AREAS,
    reframe: Object.freeze({ default: DEFAULT_REFRAME, segments: Object.freeze({}) }),
  }),
  Object.freeze({
    id: 'shorts-9x16', label: 'Shorts / TikTok 9:16', width: 1080, height: 1920,
    captionStyle: Object.freeze({ sizePct: 6.5, position: 'bottom' }),
    safeAreas: DEFAULT_SAFE_AREAS,
    reframe: Object.freeze({ default: DEFAULT_REFRAME, segments: Object.freeze({}) }),
  }),
  Object.freeze({
    id: 'square-1x1', label: 'Square 1:1', width: 1080, height: 1080,
    captionStyle: Object.freeze({ sizePct: 5.5, position: 'bottom' }),
    safeAreas: DEFAULT_SAFE_AREAS,
    reframe: Object.freeze({ default: DEFAULT_REFRAME, segments: Object.freeze({}) }),
  }),
]);

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isPercent = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

export function sanitizeDeliverableBase(value) {
  const base = String(value ?? '').replace(/\.[a-z0-9]+$/i, '');
  if (!base.trim() || base.includes('/') || base.includes('\\') || base.includes('..')) return null;
  return base;
}

export function defaultDeliverableFilename(masterBase = 'film', id = 'deliverable') {
  const base = sanitizeDeliverableBase(masterBase) ?? 'film';
  return `${base}-${id}`;
}

function normalizeInsets(value, fallback) {
  return {
    leftPct: value?.leftPct ?? fallback.leftPct,
    rightPct: value?.rightPct ?? fallback.rightPct,
    topPct: value?.topPct ?? fallback.topPct,
    bottomPct: value?.bottomPct ?? fallback.bottomPct,
    ...Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !['leftPct', 'rightPct', 'topPct', 'bottomPct'].includes(key))),
  };
}

function normalizePoint(value, fallback = DEFAULT_REFRAME) {
  return {
    xPct: value?.xPct ?? fallback.xPct,
    yPct: value?.yPct ?? fallback.yPct,
    ...Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !['xPct', 'yPct'].includes(key))),
  };
}

/** Normalize a persisted full deliverable without dropping invalid keys. */
export function normalizeDeliverable(input = {}, { baseFilename = 'film', fallback = null } = {}) {
  const source = input && typeof input === 'object' ? input : input;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const inherited = fallback && typeof fallback === 'object' ? fallback : {};
  const id = source.id ?? inherited.id;
  const base = sanitizeDeliverableBase(baseFilename) ?? 'film';
  const fallbackCaption = { ...DEFAULT_CAPTION_STYLE, ...(inherited.captionStyle ?? {}) };
  const fallbackAreas = { ...DEFAULT_SAFE_AREAS, ...(inherited.safeAreas ?? {}) };
  const fallbackReframe = inherited.reframe ?? {};
  const segmentOverrides = {
    ...(fallbackReframe.segments ?? {}),
    ...(source.reframe?.segments ?? {}),
  };
  return {
    ...inherited,
    ...source,
    id,
    label: source.label ?? inherited.label ?? (typeof id === 'string' ? id : undefined),
    width: source.width ?? inherited.width,
    height: source.height ?? inherited.height,
    outputFilename: source.outputFilename ?? inherited.outputFilename ?? defaultDeliverableFilename(base, id),
    captionStyle: {
      ...fallbackCaption,
      ...(source.captionStyle ?? {}),
    },
    safeAreas: {
      ...fallbackAreas,
      ...(source.safeAreas ?? {}),
      title: normalizeInsets(source.safeAreas?.title, fallbackAreas.title ?? DEFAULT_SAFE_AREAS.title),
      caption: normalizeInsets(source.safeAreas?.caption, fallbackAreas.caption ?? DEFAULT_SAFE_AREAS.caption),
    },
    reframe: {
      ...fallbackReframe,
      ...(source.reframe ?? {}),
      default: normalizePoint(source.reframe?.default, fallbackReframe.default ?? DEFAULT_REFRAME),
      segments: Object.fromEntries(Object.entries(segmentOverrides).map(([key, value]) => [
        key,
        normalizePoint(value, source.reframe?.default ?? fallbackReframe.default ?? DEFAULT_REFRAME),
      ])),
    },
  };
}

function validateInsets(value, at, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${at} must be an inset object`);
    return;
  }
  for (const key of ['leftPct', 'rightPct', 'topPct', 'bottomPct']) {
    if (!isPercent(value[key])) problems.push(`${at}.${key} must be a number in 0..100`);
  }
  if (isPercent(value.leftPct) && isPercent(value.rightPct) && value.leftPct + value.rightPct >= 100) {
    problems.push(`${at}: leftPct + rightPct must leave visible width`);
  }
  if (isPercent(value.topPct) && isPercent(value.bottomPct) && value.topPct + value.bottomPct >= 100) {
    problems.push(`${at}: topPct + bottomPct must leave visible height`);
  }
  for (const key of Object.keys(value)) {
    if (!['leftPct', 'rightPct', 'topPct', 'bottomPct'].includes(key)) problems.push(`${at}.${key} is not a safe-area inset`);
  }
}

function validatePoint(value, at, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${at} must be a reframe point`);
    return;
  }
  for (const key of ['xPct', 'yPct']) {
    if (!isPercent(value[key])) problems.push(`${at}.${key} must be a number in 0..100`);
  }
  for (const key of Object.keys(value)) {
    if (!['xPct', 'yPct'].includes(key)) problems.push(`${at}.${key} is not a reframe point field`);
  }
}

/** Append every document-level deliverable schema problem to `problems`. */
export function validateDeliverable(value, at, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${at} must be a deliverable object`);
    return;
  }
  if (typeof value.id !== 'string' || !DELIVERABLE_ID_RE.test(value.id)) {
    problems.push(`${at}.id must be a lowercase slug (a-z, 0-9, -)`);
  }
  if (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim())) {
    problems.push(`${at}.label must be a non-empty string`);
  }
  for (const key of ['width', 'height']) {
    if (!isPosInt(value[key]) || value[key] > (key === 'width' ? 7680 : 4320) || value[key] % 2 !== 0) {
      problems.push(`${at}.${key} must be an even integer in 2..${key === 'width' ? 7680 : 4320}`);
    }
  }
  if (!sanitizeDeliverableBase(value.outputFilename)) problems.push(`${at}.outputFilename must be a bare filename`);

  const style = value.captionStyle;
  if (!style || typeof style !== 'object' || Array.isArray(style)) problems.push(`${at}.captionStyle must be an object`);
  else {
    if (!(typeof style.sizePct === 'number' && style.sizePct >= 1 && style.sizePct <= 20)) {
      problems.push(`${at}.captionStyle.sizePct must be a number 1..20`);
    }
    if (!['bottom', 'top'].includes(style.position)) problems.push(`${at}.captionStyle.position must be "bottom" or "top"`);
    for (const key of Object.keys(style)) {
      if (!['sizePct', 'position'].includes(key)) problems.push(`${at}.captionStyle.${key} is not a caption style field`);
    }
  }

  const safe = value.safeAreas;
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) problems.push(`${at}.safeAreas must be an object`);
  else {
    validateInsets(safe.title, `${at}.safeAreas.title`, problems);
    validateInsets(safe.caption, `${at}.safeAreas.caption`, problems);
    for (const key of Object.keys(safe)) {
      if (!['title', 'caption'].includes(key)) problems.push(`${at}.safeAreas.${key} is not a safe-area kind`);
    }
  }

  const reframe = value.reframe;
  if (!reframe || typeof reframe !== 'object' || Array.isArray(reframe)) problems.push(`${at}.reframe must be an object`);
  else {
    validatePoint(reframe.default, `${at}.reframe.default`, problems);
    if (!reframe.segments || typeof reframe.segments !== 'object' || Array.isArray(reframe.segments)) {
      problems.push(`${at}.reframe.segments must be an object keyed by segment slug`);
    } else {
      for (const [key, point] of Object.entries(reframe.segments)) {
        if (!key.trim()) problems.push(`${at}.reframe.segments has an empty segment key`);
        validatePoint(point, `${at}.reframe.segments.${key}`, problems);
      }
    }
    for (const key of Object.keys(reframe)) {
      if (!['default', 'segments'].includes(key)) problems.push(`${at}.reframe.${key} is not a reframe field`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!['id', 'label', 'width', 'height', 'outputFilename', 'captionStyle', 'safeAreas', 'reframe'].includes(key)) {
      problems.push(`${at}.${key} is not a deliverable field`);
    }
  }
}

/** Validate global preset data (same shape, but output names are derived per film). */
export function validateDeliverablePreset(value, at, problems) {
  const normalized = normalizeDeliverable(value, { baseFilename: 'film' });
  validateDeliverable(normalized, at, problems);
}

/**
 * Resolve preset ids or explicit deliverable objects into immutable film data.
 * A custom id is allowed only with its full geometry; an id-only object must
 * resolve to a configured preset, otherwise a caller could silently create a
 * broken variant with undefined dimensions.
 */
export function resolveDeliverableSelections({
  presets = DEFAULT_DELIVERABLE_PRESETS,
  requested = undefined,
  defaultIds = [],
  baseFilename = 'film',
} = {}) {
  const entries = requested === undefined ? defaultIds : requested;
  if (!Array.isArray(entries)) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'deliverables must be an array of preset ids or deliverable objects');
  }
  const byId = new Map((presets ?? []).filter((item) => item && typeof item === 'object').map((item) => [item.id, item]));
  const resolved = entries.map((entry) => {
    const partial = typeof entry === 'string' ? { id: entry } : entry;
    if (!partial || typeof partial !== 'object' || Array.isArray(partial) || typeof partial.id !== 'string') {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, 'each deliverable must be a preset id or object with an id');
    }
    const preset = byId.get(partial.id);
    if (!preset && (partial.width === undefined || partial.height === undefined)) {
      throw new EngineError(ErrorCodes.UNKNOWN_DELIVERABLE,
        `Unknown deliverable "${partial.id}". Configure it as a global preset or provide its full geometry.`, { deliverable: partial.id });
    }
    return normalizeDeliverable(partial, { baseFilename, fallback: preset });
  });
  const ids = new Set();
  const names = new Set();
  for (const item of resolved) {
    if (ids.has(item.id)) throw new EngineError(ErrorCodes.INVALID_CONFIG, `deliverables contains duplicate id "${item.id}"`);
    ids.add(item.id);
    const filename = sanitizeDeliverableBase(item.outputFilename);
    if (filename && names.has(filename)) {
      throw new EngineError(ErrorCodes.INVALID_CONFIG, `deliverables contains duplicate outputFilename "${filename}"`);
    }
    if (filename) names.add(filename);
  }
  return resolved;
}

/** Look up a saved film variant and fail with a useful stable code. */
export function resolveFilmDeliverable(film, deliverableId) {
  if (deliverableId === undefined || deliverableId === null || deliverableId === '') return null;
  const found = (film.deliverables ?? []).find((item) => item.id === deliverableId);
  if (!found) {
    throw new EngineError(ErrorCodes.UNKNOWN_DELIVERABLE,
      `Film "${film.slug ?? film.id ?? 'film'}" has no deliverable "${deliverableId}".`, {
        deliverable: deliverableId,
        available: (film.deliverables ?? []).map((item) => item.id),
      });
  }
  return found;
}

/** The rectangle retained from a source master before it is scaled to target. */
export function reframeGeometry({ sourceWidth, sourceHeight, targetWidth, targetHeight }) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every(isPosInt)) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'reframe geometry needs positive integer source and target dimensions');
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  let cropWidth, cropHeight;
  if (targetAspect < sourceAspect) {
    cropHeight = sourceHeight;
    cropWidth = Math.max(2, Math.floor((sourceHeight * targetAspect) / 2) * 2);
  } else {
    cropWidth = sourceWidth;
    cropHeight = Math.max(2, Math.floor((sourceWidth / targetAspect) / 2) * 2);
  }
  if (cropWidth > sourceWidth || cropHeight > sourceHeight) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG, 'reframe target exceeds source geometry', {
      sourceWidth, sourceHeight, targetWidth, targetHeight,
    });
  }
  return { cropWidth, cropHeight, maxX: sourceWidth - cropWidth, maxY: sourceHeight - cropHeight };
}

function segmentOverride(reframe, entry) {
  const overrides = reframe?.segments ?? {};
  const keys = [entry.slug, entry.name, entry.footage, entry.sceneId]
    .filter((value) => typeof value === 'string' && value);
  return keys.map((key) => overrides[key]).find(Boolean) ?? reframe?.default ?? DEFAULT_REFRAME;
}

const clampInt = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));

/** Resolve every timeline segment to a concrete crop origin. */
export function resolveReframeCenters({ reframe, sceneLayout = [], sourceWidth, sourceHeight, targetWidth, targetHeight }) {
  const geometry = reframeGeometry({ sourceWidth, sourceHeight, targetWidth, targetHeight });
  const entries = sceneLayout.length ? sceneLayout : [{ filmOffset: 0, durationInFrames: 1 }];
  return entries.map((entry) => {
    const point = segmentOverride(reframe, entry);
    return {
      fromFrame: entry.filmOffset ?? 0,
      toFrame: (entry.filmOffset ?? 0) + (entry.durationInFrames ?? 0),
      x: clampInt(geometry.maxX * ((point.xPct ?? 50) / 100), 0, geometry.maxX),
      y: clampInt(geometry.maxY * ((point.yPct ?? 50) / 100), 0, geometry.maxY),
      ...(entry.slug ? { segment: entry.slug } : {}),
      ...(entry.name ? { name: entry.name } : {}),
    };
  });
}

function cropExpression(centers, field, fps) {
  if (centers.length === 1) return String(centers[0][field]);
  let expression = String(centers[centers.length - 1][field]);
  for (let index = centers.length - 2; index >= 0; index -= 1) {
    const boundary = (centers[index + 1].fromFrame / fps).toFixed(6);
    expression = `if(lt(t\\,${boundary})\\,${centers[index][field]}\\,${expression})`;
  }
  return expression;
}

/**
 * Compile a constant-geometry, per-segment crop into one ffmpeg filter string.
 * The escaped commas are intentional: they survive ffmpeg's outer filter
 * parser and reach the `if()` expression itself.
 */
export function compileReframeFilter({ reframe, sceneLayout, sourceWidth, sourceHeight, targetWidth, targetHeight, fps }) {
  if (!isPosInt(fps)) throw new EngineError(ErrorCodes.INVALID_CONFIG, 'reframe fps must be a positive integer');
  const geometry = reframeGeometry({ sourceWidth, sourceHeight, targetWidth, targetHeight });
  const centers = resolveReframeCenters({
    reframe, sceneLayout, sourceWidth, sourceHeight, targetWidth, targetHeight,
  });
  const x = cropExpression(centers, 'x', fps);
  const y = cropExpression(centers, 'y', fps);
  return {
    filter: `crop=${geometry.cropWidth}:${geometry.cropHeight}:${x}:${y},scale=${targetWidth}:${targetHeight}:flags=lanczos,setsar=1`,
    geometry,
    centers,
  };
}

/** Convert inset data into a rectangle in percentages for a contact-sheet guide. */
export function safeAreaRect(insets) {
  return {
    xPct: insets.leftPct,
    yPct: insets.topPct,
    widthPct: 100 - insets.leftPct - insets.rightPct,
    heightPct: 100 - insets.topPct - insets.bottomPct,
  };
}

/** Conservative, font-agnostic caption capacity for plan-time warnings only. */
export function captionSafeCapacity({ width, height, captionStyle, safeArea }) {
  const rect = safeAreaRect(safeArea);
  const fontPx = Math.max(8, (height * (captionStyle?.sizePct ?? DEFAULT_CAPTION_STYLE.sizePct)) / 100);
  const charsPerLine = Math.max(1, Math.floor((width * rect.widthPct / 100) / (fontPx * 0.55)));
  const lines = Math.max(1, Math.floor((height * rect.heightPct / 100) / (fontPx * 1.35)));
  return { charsPerLine, lines, maxChars: charsPerLine * lines, rect };
}
