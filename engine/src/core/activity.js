/**
 * Agent activity and production status (v0.23).
 *
 * The human watching the Studio needs one honest sentence: what is the AI
 * doing right now? The AI answers by heartbeat — report_agent_activity
 * writes a small mutable file per agent — and the Studio derives everything
 * else from durable state, so a dead agent degrades to "waiting for the next
 * AI run" rather than to a stuck claim.
 *
 *   <workspace>/activity/<agent>.json   { agent, activity, filmId?, sceneId?,
 *                                         detail?, updatedAt }
 *
 * Heartbeats are LIVE state, not truth: they expire by wall clock (an agent
 * is a remote process; nothing here can probe it), they are replaceable, and
 * losing every one of them loses no production data. That is the same
 * durable-vs-live split the job queue already lives by.
 *
 * `productionStatus` is the read side: current plan readiness, unresolved
 * advice, the current delivery, whether promoted work is newer than that
 * delivery, and who is active. Facts only — the Studio turns them into
 * sentences, the AI reads them raw.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { EngineError, ErrorCodes } from './errors.js';
import { planFilm } from './films.js';
import { adviceSummary } from './advice.js';
import { listDeliveries, currentDeliveryId, getDeliveryManifest } from './deliveries.js';
import { listRevisions } from './revisions.js';

export const ACTIVITY_DIR = 'activity';

/** Heartbeats older than this are stale: the agent is presumed gone. */
export const ACTIVITY_STALE_SECONDS = 180;

const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Record what an agent is doing. Cheap, mutable, last-write-wins per agent —
 * a heartbeat, not an event log.
 */
export async function reportActivity({ workspacePath, agent, activity, filmId = null, sceneId = null, detail = null }) {
  const id = String(agent ?? '').trim();
  if (!AGENT_RE.test(id)) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      'agent must be 1..64 characters of letters, digits, ".", "_", or "-"', { agent });
  }
  const text = String(activity ?? '').trim();
  if (!text || text.length > 120) {
    throw new EngineError(ErrorCodes.INVALID_CONFIG,
      'activity must be a short present-tense phrase (1..120 characters), e.g. "Creating scene demo-shot"',
      { activity });
  }
  const dir = path.join(workspacePath, ACTIVITY_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const body = {
    agent: id,
    activity: text,
    ...(filmId ? { filmId } : {}),
    ...(sceneId ? { sceneId } : {}),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    updatedAt: new Date().toISOString(),
  };
  const abs = path.join(dir, `${id}.json`);
  const tmp = abs + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(body, null, 2));
  await fsp.rename(tmp, abs);
  return body;
}

/** Every agent's latest heartbeat, freshest first, with staleness computed. */
export async function listActivity(workspacePath, { staleSeconds = ACTIVITY_STALE_SECONDS, now = Date.now() } = {}) {
  const dir = path.join(workspacePath, ACTIVITY_DIR);
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isFile() || !d.name.endsWith('.json') || d.name.includes('.tmp-')) continue;
    try {
      const body = JSON.parse(await fsp.readFile(path.join(dir, d.name), 'utf8'));
      const ageSeconds = Math.max(0, Math.round((now - Date.parse(body.updatedAt)) / 1000));
      out.push({ ...body, ageSeconds, stale: !(ageSeconds < staleSeconds) });
    } catch { /* a torn heartbeat is skipped, not fatal */ }
  }
  out.sort((a, b) => a.ageSeconds - b.ageSeconds);
  return out;
}

/**
 * One production-status snapshot for a film: everything the review header
 * and get_production_status need, derived from durable state plus live
 * heartbeats.
 */
export async function productionStatus({ store, film, plan = null }) {
  const resolved = plan ?? await planFilm({ film, store });
  const segments = resolved.scenes ?? [];
  const sceneSegments = segments.filter((s) => s.kind === 'scene');
  const readiness = {
    total: segments.length,
    rendered: sceneSegments.filter((s) => s.rendered).length + segments.filter((s) => s.kind === 'footage' && !s.missing).length,
    stale: sceneSegments.filter((s) => s.staleRender).length,
    missing: segments.filter((s) => s.missing).length,
    problems: resolved.problems.length,
  };

  const advice = await adviceSummary(film.path);

  const deliveryId = await currentDeliveryId(film.path);
  let currentDelivery = null;
  let newerWorkThanDelivery = false;
  if (deliveryId) {
    try {
      const manifest = await getDeliveryManifest(film.path, deliveryId);
      currentDelivery = {
        id: manifest.id,
        createdAt: manifest.createdAt,
        totalFrames: manifest.totalFrames,
        fps: manifest.fps,
        durationSeconds: manifest.durationSeconds,
        agent: manifest.agent ?? null,
      };
      // Newer work: any scene whose CURRENT revision post-dates the delivery,
      // or a document edit after it. Coarse by design — it answers "is the
      // played film behind production?", not "what exactly changed".
      const builtAt = manifest.createdAt;
      if ((film.updatedAt ?? '') > builtAt) newerWorkThanDelivery = true;
      if (!newerWorkThanDelivery) {
        for (const seg of sceneSegments) {
          const revs = await listRevisions(store.scenePath(seg.sceneId)).catch(() => []);
          const current = revs.find((r) => r.current);
          if (current && current.createdAt > builtAt) { newerWorkThanDelivery = true; break; }
        }
      }
    } catch { /* pointer to a pruned delivery reads as none */ }
  }

  const workspacePath = store.workspacePath(film.workspace ?? film.id.split('/')[0]);
  const allActivity = await listActivity(workspacePath);
  const activity = allActivity.filter((a) => !a.filmId || a.filmId === film.id || a.filmId === film.id.split('/')[1]);

  return {
    filmId: film.id,
    name: film.name,
    totalFrames: resolved.totalFrames,
    fps: resolved.fps,
    durationSeconds: resolved.durationSeconds,
    sequences: resolved.sequences ?? [],
    readiness,
    advice,
    deliveries: (await listDeliveries(film.path)).length,
    currentDelivery,
    newerWorkThanDelivery,
    activity,
    generatedAt: new Date().toISOString(),
  };
}
