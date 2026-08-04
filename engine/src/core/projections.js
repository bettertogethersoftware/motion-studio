/**
 * Token-efficient projections and cursors (token-efficient plan, P0-1/P0-2).
 *
 * A real 180 s production spent ~49% of 57.5 M agent tokens carrying repeated
 * full film documents and unchanged per-scene states. These are the compact
 * views the read tools serve by default: the server computes the plan once
 * and projects it small; `detail: "full"` remains the explicit road to the
 * complete shape. Compactness must never hide failure — problems and errors
 * stay complete in every projection (principle 6/7 of the plan).
 *
 * The cursor is a TRANSPORT optimization, not server state: it encodes the
 * per-segment row hashes inside an opaque token, so "what changed since my
 * last look" is answered statelessly — same rows → same cursor → heartbeat;
 * changed rows → a delta listing exactly those rows. A cursor that fails to
 * parse (old build, truncation) answers `cursorReset: true` plus the full
 * projection, never an error. Timestamps and live-activity heartbeats are
 * deliberately EXCLUDED from the hash — a cursor that churns on every clock
 * tick can never say "unchanged".
 */

import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * One compact row per plan segment — the plan's P0-1 `scenes` shape. Key
 * order is fixed (rows are hashed for the cursor). `state` folds the four
 * booleans agents currently re-derive: missing > stale > rendered >
 * unrendered for scenes; missing/present for footage.
 */
export function segmentRows(plan, localId = (id) => id) {
  return (plan.scenes ?? []).map((s) => (s.kind === 'footage'
    ? {
      kind: 'footage',
      footage: s.footage,
      ...(s.name ? { name: s.name } : {}),
      ...(s.sequence ? { sequence: s.sequence } : {}),
      frames: s.durationInFrames,
      filmOffset: s.filmOffset,
      state: s.missing ? 'missing' : 'present',
      framesVerified: s.framesVerified ?? null,
    }
    : {
      kind: 'scene',
      scene: localId(s.sceneId),
      slug: s.slug,
      ...(s.sequence ? { sequence: s.sequence } : {}),
      frames: s.durationInFrames,
      filmOffset: s.filmOffset,
      state: s.missing ? 'missing' : (s.staleRender ? 'stale' : (s.rendered ? 'rendered' : 'unrendered')),
      renderVerified: s.renderVerified ?? null,
    }));
}

const rowKey = (row) => (row.kind === 'footage' ? `f:${row.footage}` : `s:${row.slug}`);

/**
 * Opaque production cursor. `marks` is everything summary-visible that is
 * not a segment row (revision, advice counts, delivery id, …); rows are
 * hashed individually so diffs can name exactly what changed.
 */
export function computeCursor({ film, rows, marks }) {
  const rowHashes = {};
  for (const row of rows) rowHashes[rowKey(row)] = hash(row).slice(0, 12);
  const overall = hash([marks, rowHashes]).slice(0, 16);
  const payload = { v: 1, film, o: overall, r: rowHashes };
  return `c1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

/** null on anything that is not a well-formed v1 cursor — never a throw. */
export function parseCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith('c1.')) return null;
  try {
    const payload = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'));
    if (payload?.v !== 1 || typeof payload.o !== 'string' || typeof payload.r !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The stateless delta: rows that are new or changed since the parsed
 * cursor, and keys the cursor knew that no longer exist.
 */
export function diffRows(parsed, rows) {
  const currentKeys = new Set(rows.map(rowKey));
  const changed = rows.filter((row) => parsed.r[rowKey(row)] !== hash(row).slice(0, 12));
  const removed = Object.keys(parsed.r).filter((key) => !currentKeys.has(key));
  return { changed, removed };
}
