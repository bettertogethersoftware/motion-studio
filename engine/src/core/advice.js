/**
 * Human advice (v0.23) — the durable channel from an asynchronous human
 * adviser to an unattended AI director.
 *
 * The product shape this implements (see docs/architecture.md §16):
 *
 *   - The AI is the director and operator; the human watches the evolving film
 *     in the Studio and leaves plain-language advice on what they can see —
 *     the film, a sequence, a scene, a timeline item, an exact moment.
 *   - Advice never blocks production. There is no approval gate; the AI
 *     discovers advice at its own checkpoints (check_human_advice) and decides
 *     what to do, recording the outcome either way.
 *   - Advice is evidence. The human's wording is immutable; what they were
 *     looking at (delivery, revision, frame) is recorded with it; the AI's
 *     response links the revisions and delivery it produced. Weeks later the
 *     record still answers: what I saw → what I said → what changed.
 *
 * Storage, per film:
 *
 *   <film>/advice/<advice-id>/
 *     request.json     immutable: wording, target, observation, provenance
 *     events.ndjson    append-only lifecycle: created, acknowledged, work
 *                      leases, clarification, resolution, evidence capture
 *     state.json       replaceable projection for fast reads
 *     resolution.json  terminal outcome + explanation + result links
 *     evidence/        before/after frame grabs + their metadata
 *
 * Events are appended BEFORE the state projection is replaced, so a crash
 * between the two loses a cached view, never history. All writes are atomic
 * (temp + rename); appends are whole single lines.
 *
 * Leases: begin_advice_work takes a TTL lease so two agents cannot process
 * one advice concurrently. Liveness is wall-clock expiry (an agent is a
 * remote process; a pid check cannot see it), renewable by the holder, and an
 * expired lease simply makes the advice actionable again — crash recovery is
 * "wait out the TTL", with no state to repair.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';

export const ADVICE_DIR = 'advice';

// `footage` is a supplied clip on the play order (v0.23.1). It is addressed by
// its stable segment id, not its path: the same plate may be cut in twice, and
// advice on the second one must not re-aim at the first.
export const ADVICE_TARGET_TYPES = ['film', 'sequence', 'scene', 'footage', 'audio', 'caption', 'overlay'];
export const ADVICE_STATUSES = ['open', 'acknowledged', 'working', 'needs-clarification', 'resolved'];
export const ADVICE_OUTCOMES = ['applied', 'partially-applied', 'not-applied', 'superseded', 'needs-clarification'];
export const SUGGESTED_ACTIONS = ['rework', 'prefer-revision', 'question', 'praise'];

export const MAX_ADVICE_MESSAGE_CHARS = 4000;
export const DEFAULT_LEASE_SECONDS = 900;

const SLUG_RE = /^[a-z0-9_][a-z0-9-_]*$/;

export function newAdviceId(now = Date.now()) {
  return `adv-${String(now).padStart(13, '0')}-${randomUUID().slice(0, 8)}`;
}

export function adviceRoot(filmPath) {
  return path.join(filmPath, ADVICE_DIR);
}

export function advicePath(filmPath, adviceId) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(adviceId ?? ''))) {
    throw new EngineError(ErrorCodes.ADVICE_NOT_FOUND, `No such advice "${adviceId}"`, { adviceId });
  }
  return path.join(adviceRoot(filmPath), String(adviceId));
}

async function writeJsonAtomic(abs, obj) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, abs);
}

async function readJson(abs) {
  try { return JSON.parse(await fsp.readFile(abs, 'utf8')); }
  catch { return null; }
}

async function appendEvent(dir, event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  await fsp.appendFile(path.join(dir, 'events.ndjson'), line + '\n', 'utf8');
  return line;
}

/**
 * Validate the structural half of an advice request. The human never fills
 * these fields by hand — the Studio derives them from the current selection —
 * but a direct API caller can, so the store still refuses nonsense.
 */
function validateTarget(target) {
  const t = target ?? { type: 'film' };
  if (typeof t !== 'object' || Array.isArray(t)) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE, 'target must be an object', { target });
  }
  if (!ADVICE_TARGET_TYPES.includes(t.type)) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE,
      `target.type must be one of: ${ADVICE_TARGET_TYPES.join(', ')}`, { target: t });
  }
  if (t.type === 'scene' && !(typeof t.scene === 'string' && SLUG_RE.test(t.scene))) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE, 'a scene target needs target.scene (the scene slug)', { target: t });
  }
  if (t.type === 'sequence' && !(typeof t.sequence === 'string' && t.sequence.trim())) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE, 'a sequence target needs target.sequence (its name)', { target: t });
  }
  if (['footage', 'audio', 'caption', 'overlay'].includes(t.type) && !(typeof t.itemId === 'string' && t.itemId.trim())) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE,
      `a ${t.type} target needs target.itemId (the timeline item's id)`, { target: t });
  }
  for (const k of ['filmFrame', 'sceneFrame']) {
    if (t[k] !== undefined && !(Number.isInteger(t[k]) && t[k] >= 0)) {
      throw new EngineError(ErrorCodes.INVALID_ADVICE, `target.${k} must be a non-negative integer`, { target: t });
    }
  }
  const clean = {
    type: t.type,
    ...(t.scene !== undefined ? { scene: t.scene } : {}),
    ...(t.sequence !== undefined ? { sequence: String(t.sequence) } : {}),
    ...(t.itemId !== undefined ? { itemId: String(t.itemId) } : {}),
    ...(t.filmFrame !== undefined ? { filmFrame: t.filmFrame } : {}),
    ...(t.sceneFrame !== undefined ? { sceneFrame: t.sceneFrame } : {}),
    ...(typeof t.label === 'string' && t.label.trim() ? { label: t.label.trim().slice(0, 200) } : {}),
  };
  return clean;
}

/**
 * Persist a new advice request. The request is committed durably FIRST;
 * optional evidence capture happens after (and elsewhere), so an evidence
 * failure can never lose the human's words.
 *
 * @param {object} opts
 * @param {string} opts.filmPath  absolute film folder
 * @param {string} opts.filmId
 * @param {string} opts.message   the human's wording (immutable)
 * @param {object} [opts.target]  what was selected (defaults to the film)
 * @param {object} [opts.observation]  what was visible: { source: 'delivery'|
 *   'scene-preview'|'revision-preview'|'none', deliveryId?, revisionId?,
 *   filmFrame?, sceneFrame?, timeSeconds? }
 * @param {string} [opts.suggestedAction]  rework | prefer-revision | question | praise
 * @param {string} [opts.preferredRevisionId]  for prefer-revision advice
 * @param {string} [opts.from]    who is speaking (default "human")
 * @param {string} [opts.followUpOf]  advice id this continues
 * @param {string} [opts.requestId]   idempotency key: retrying the same id
 *   returns the original receipt instead of creating a duplicate
 * @returns {{ id, createdAt, status, path, deduplicated? }}
 */
export async function createAdvice({
  filmPath, filmId, message, target = { type: 'film' }, observation = { source: 'none' },
  suggestedAction = 'rework', preferredRevisionId = null, from = 'human',
  followUpOf = null, requestId = null,
}) {
  const text = String(message ?? '').trim();
  if (!text) throw new EngineError(ErrorCodes.INVALID_ADVICE, 'advice needs a message');
  if (text.length > MAX_ADVICE_MESSAGE_CHARS) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE,
      `advice message is limited to ${MAX_ADVICE_MESSAGE_CHARS} characters (got ${text.length})`,
      { maxChars: MAX_ADVICE_MESSAGE_CHARS });
  }
  if (!SUGGESTED_ACTIONS.includes(suggestedAction)) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE,
      `suggestedAction must be one of: ${SUGGESTED_ACTIONS.join(', ')}`, { suggestedAction });
  }
  const cleanTarget = validateTarget(target);
  if (followUpOf) {
    // A follow-up must reference a real thread, or "linked" is a lie.
    await getAdvice({ filmPath, adviceId: followUpOf });
  }

  if (requestId) {
    const existing = await findByRequestId(filmPath, requestId);
    if (existing) {
      return {
        id: existing.request.id, createdAt: existing.request.createdAt,
        status: existing.state?.status ?? 'open', path: existing.path, deduplicated: true,
      };
    }
  }

  const id = newAdviceId();
  const createdAt = new Date().toISOString();
  const dir = advicePath(filmPath, id);
  const stage = dir + '.tmp-' + process.pid;
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });

  const request = {
    schema: 'motion-studio.advice/1',
    id,
    filmId,
    from,
    message: text,
    target: cleanTarget,
    observation: {
      source: observation?.source ?? 'none',
      ...(observation?.deliveryId ? { deliveryId: observation.deliveryId } : {}),
      ...(observation?.revisionId ? { revisionId: observation.revisionId } : {}),
      // What production considered current when the human spoke — the other
      // half of a prefer-revision comparison.
      ...(observation?.currentRevisionId ? { currentRevisionId: observation.currentRevisionId } : {}),
      ...(observation?.filmFrame !== undefined ? { filmFrame: observation.filmFrame } : {}),
      ...(observation?.sceneFrame !== undefined ? { sceneFrame: observation.sceneFrame } : {}),
      ...(observation?.timeSeconds !== undefined ? { timeSeconds: observation.timeSeconds } : {}),
    },
    suggestedAction,
    ...(preferredRevisionId ? { preferredRevisionId } : {}),
    ...(followUpOf ? { followUpOf } : {}),
    ...(requestId ? { requestId } : {}),
    createdAt,
  };
  await writeJsonAtomic(path.join(stage, 'request.json'), request);
  await appendEvent(stage, { type: 'created', from });
  await writeJsonAtomic(path.join(stage, 'state.json'), { id, status: 'open', updatedAt: createdAt });
  // One rename makes the whole advice appear; a crash mid-write leaves only
  // an ignorable .tmp- folder, never a half-advice.
  await fsp.rename(stage, dir);
  return { id, createdAt, status: 'open', path: dir };
}

async function findByRequestId(filmPath, requestId) {
  const root = adviceRoot(filmPath);
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return null; }
  for (const d of entries) {
    if (!d.isDirectory() || d.name.includes('.tmp-')) continue;
    const request = await readJson(path.join(root, d.name, 'request.json'));
    if (request?.requestId === requestId) {
      return { request, state: await readJson(path.join(root, d.name, 'state.json')), path: path.join(root, d.name) };
    }
  }
  return null;
}

/** Is this lease live right now? */
export function leaseActive(lease, now = Date.now()) {
  return !!lease?.expiresAt && Date.parse(lease.expiresAt) > now;
}

/**
 * The status a caller should act on: a `working` item whose lease expired is
 * effectively back to acknowledged — its agent is gone, and hiding it would
 * abandon the advice with no one to notice.
 */
function effectiveStatus(state, now = Date.now()) {
  if (!state) return 'open';
  if (state.status === 'working' && !leaseActive(state.lease, now)) return 'acknowledged';
  return state.status;
}

/** One advice, fully hydrated: request + state + events + resolution. */
export async function getAdvice({ filmPath, adviceId }) {
  const dir = advicePath(filmPath, adviceId);
  const request = await readJson(path.join(dir, 'request.json'));
  if (!request) {
    throw new EngineError(ErrorCodes.ADVICE_NOT_FOUND, `No such advice "${adviceId}"`, { adviceId });
  }
  const state = await readJson(path.join(dir, 'state.json'));
  const resolution = await readJson(path.join(dir, 'resolution.json'));
  let events = [];
  try {
    events = (await fsp.readFile(path.join(dir, 'events.ndjson'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { /* no events file — still a valid advice */ }
  const evidence = {};
  for (const which of ['before', 'after']) {
    const png = path.join(dir, 'evidence', `${which}.png`);
    const meta = await readJson(path.join(dir, 'evidence', `${which}.json`));
    if (fs.existsSync(png) || meta) {
      evidence[which] = { ...(meta ?? {}), image: fs.existsSync(png) };
    }
  }
  return {
    request,
    state: { ...(state ?? { id: adviceId, status: 'open' }), status: effectiveStatus(state) },
    events,
    resolution,
    evidence,
    path: dir,
  };
}

/**
 * List a film's advice.
 *
 * @param {object} opts
 * @param {string} opts.filmPath
 * @param {'unresolved'|'resolved'|'all'} [opts.status='all']
 * @param {'oldest'|'newest'} [opts.order]  default: oldest for unresolved (the
 *   reconciliation order), newest otherwise (the history order)
 * @param {object} [opts.target]  filter: { type?, scene?, sequence?, itemId? }
 * @param {number} [opts.limit]
 */
export async function listAdvice({ filmPath, status = 'all', order = null, target = null, limit = 0 }) {
  const root = adviceRoot(filmPath);
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.name.includes('.tmp-')) continue;
    const dir = path.join(root, d.name);
    const request = await readJson(path.join(dir, 'request.json'));
    if (!request) continue;
    const state = await readJson(path.join(dir, 'state.json'));
    const st = effectiveStatus(state);
    if (status === 'unresolved' && st === 'resolved') continue;
    if (status === 'resolved' && st !== 'resolved') continue;
    if (target) {
      if (target.type && request.target?.type !== target.type) continue;
      if (target.scene && request.target?.scene !== target.scene) continue;
      if (target.sequence && request.target?.sequence !== target.sequence) continue;
      if (target.itemId && request.target?.itemId !== target.itemId) continue;
    }
    const resolution = st === 'resolved' ? await readJson(path.join(dir, 'resolution.json')) : null;
    out.push({
      ...request,
      status: st,
      ...(state?.lease && leaseActive(state.lease) ? { lease: state.lease } : {}),
      ...(state?.clarification ? { clarification: state.clarification } : {}),
      ...(resolution ? { resolution } : {}),
      updatedAt: state?.updatedAt ?? request.createdAt,
    });
  }
  const dir = order ?? (status === 'unresolved' ? 'oldest' : 'newest');
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  if (dir === 'newest') out.reverse();
  return limit > 0 ? out.slice(0, limit) : out;
}

/** Fast counts for status projections. */
export async function adviceSummary(filmPath) {
  const all = await listAdvice({ filmPath });
  const unresolved = all.filter((a) => a.status !== 'resolved');
  return {
    total: all.length,
    unresolved: unresolved.length,
    needsClarification: unresolved.filter((a) => a.status === 'needs-clarification').length,
    oldestUnresolvedAt: unresolved.length
      ? unresolved.reduce((m, a) => (a.createdAt < m ? a.createdAt : m), unresolved[0].createdAt)
      : null,
  };
}

async function loadForTransition(filmPath, adviceId) {
  const dir = advicePath(filmPath, adviceId);
  const request = await readJson(path.join(dir, 'request.json'));
  if (!request) {
    throw new EngineError(ErrorCodes.ADVICE_NOT_FOUND, `No such advice "${adviceId}"`, { adviceId });
  }
  const state = (await readJson(path.join(dir, 'state.json'))) ?? { id: adviceId, status: 'open' };
  const resolution = await readJson(path.join(dir, 'resolution.json'));
  return { dir, request, state, resolution };
}

/**
 * Record receipt. Idempotent: acknowledging twice is a cheap no-op, and a
 * resolved item reports that instead of erroring — the agent's next read
 * tells it everything.
 */
export async function acknowledgeAdvice({ filmPath, adviceId, agent }) {
  const { dir, state, resolution } = await loadForTransition(filmPath, adviceId);
  if (resolution) {
    return { id: adviceId, status: 'resolved', alreadyResolved: true };
  }
  if (state.acknowledged) {
    return { id: adviceId, status: effectiveStatus(state), alreadyAcknowledged: true, acknowledged: state.acknowledged };
  }
  const at = new Date().toISOString();
  await appendEvent(dir, { type: 'acknowledged', agent });
  const next = {
    ...state,
    status: state.status === 'open' ? 'acknowledged' : state.status,
    acknowledged: { agent: agent ?? null, at },
    updatedAt: at,
  };
  await writeJsonAtomic(path.join(dir, 'state.json'), next);
  return { id: adviceId, status: effectiveStatus(next), acknowledged: next.acknowledged };
}

/**
 * Take (or renew) the work lease. Refuses while another agent's lease is
 * live; an expired lease is taken over silently — that IS the crash recovery.
 */
export async function beginAdviceWork({ filmPath, adviceId, agent, ttlSeconds = DEFAULT_LEASE_SECONDS }) {
  if (!agent || !String(agent).trim()) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE, 'begin_advice_work needs an agent identity');
  }
  const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_LEASE_SECONDS, 30), 24 * 3600);
  const { dir, state, resolution } = await loadForTransition(filmPath, adviceId);
  if (resolution) {
    throw new EngineError(ErrorCodes.ADVICE_ALREADY_RESOLVED,
      `Advice "${adviceId}" is already resolved (${resolution.outcome})`, { adviceId, outcome: resolution.outcome });
  }
  if (leaseActive(state.lease) && state.lease.agent !== agent) {
    throw new EngineError(ErrorCodes.ADVICE_LEASE_HELD,
      `Advice "${adviceId}" is being worked on by "${state.lease.agent}" (lease expires ${state.lease.expiresAt})`,
      { adviceId, holder: state.lease.agent, expiresAt: state.lease.expiresAt });
  }
  const at = new Date().toISOString();
  const renewed = leaseActive(state.lease) && state.lease.agent === agent;
  const lease = {
    agent,
    startedAt: renewed ? state.lease.startedAt : at,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
  await appendEvent(dir, { type: renewed ? 'lease-renewed' : 'work-started', agent, expiresAt: lease.expiresAt });
  const next = {
    ...state,
    status: 'working',
    lease,
    // Working implies received, even when the agent skipped the explicit ack.
    acknowledged: state.acknowledged ?? { agent, at },
    updatedAt: at,
  };
  await writeJsonAtomic(path.join(dir, 'state.json'), next);
  return { id: adviceId, status: 'working', lease, renewed };
}

/**
 * Record the terminal outcome — or ask for clarification, which is NOT
 * terminal (the human's follow-up advice reopens the conversation).
 *
 * A terminal resolution is immutable: a second resolve throws unless it is an
 * idempotent retry (same requestId), which returns the original.
 */
export async function resolveAdvice({
  filmPath, adviceId, agent, outcome, explanation,
  revisionIds = [], deliveryId = null, combinedAdviceIds = [], requestId = null,
}) {
  if (!ADVICE_OUTCOMES.includes(outcome)) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE,
      `outcome must be one of: ${ADVICE_OUTCOMES.join(', ')}`, { outcome });
  }
  const text = String(explanation ?? '').trim();
  if (!text) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE,
      outcome === 'needs-clarification'
        ? 'needs-clarification requires the question you want answered'
        : 'a resolution requires a short explanation of what was done (or why not)');
  }
  const { dir, state, resolution } = await loadForTransition(filmPath, adviceId);
  if (resolution) {
    if (requestId && resolution.requestId === requestId) {
      return { id: adviceId, status: 'resolved', resolution, deduplicated: true };
    }
    throw new EngineError(ErrorCodes.ADVICE_ALREADY_RESOLVED,
      `Advice "${adviceId}" is already resolved (${resolution.outcome})`, { adviceId, outcome: resolution.outcome });
  }
  const at = new Date().toISOString();

  if (outcome === 'needs-clarification') {
    await appendEvent(dir, { type: 'clarification-requested', agent, question: text });
    const next = {
      ...state,
      status: 'needs-clarification',
      clarification: { question: text, agent: agent ?? null, at },
      lease: undefined,
      updatedAt: at,
    };
    delete next.lease;
    await writeJsonAtomic(path.join(dir, 'state.json'), next);
    return { id: adviceId, status: 'needs-clarification', question: text };
  }

  const body = {
    outcome,
    explanation: text,
    agent: agent ?? null,
    resolvedAt: at,
    ...(revisionIds.length ? { revisionIds } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(combinedAdviceIds.length ? { combinedAdviceIds } : {}),
    ...(requestId ? { requestId } : {}),
  };
  await appendEvent(dir, { type: 'resolved', agent, outcome });
  await writeJsonAtomic(path.join(dir, 'resolution.json'), body);
  const next = { ...state, status: 'resolved', resolution: { outcome, at, agent: agent ?? null }, updatedAt: at };
  delete next.lease;
  await writeJsonAtomic(path.join(dir, 'state.json'), next);
  return { id: adviceId, status: 'resolved', resolution: body };
}

/**
 * The human takes a piece of advice back (v0.23.1).
 *
 * Sending advice used to be one-way: a typo, a duplicate, or a note the human
 * changed their mind about stayed unresolved forever and was re-served to
 * every later AI run. Withdrawing closes it terminally so `check_human_advice`
 * stops offering it.
 *
 * It is a resolution, not a delete: the request text, the events and the
 * evidence all stay on disk. "I asked for this and then took it back" is part
 * of the record the next director may need, and nothing in this store has ever
 * destroyed what the human said.
 *
 * @returns {{ id, status, alreadyClosed? }}
 */
export async function withdrawAdvice({ filmPath, adviceId, reason = null }) {
  const { dir, state, resolution } = await loadForTransition(filmPath, adviceId);
  // Idempotent on purpose: "clear all" runs over a list that may already have
  // been partly closed by an agent, and that must not be an error.
  if (resolution) return { id: adviceId, status: 'resolved', alreadyClosed: true };
  const at = new Date().toISOString();
  const explanation = String(reason ?? '').trim() || 'Withdrawn by the human in the Studio.';
  const body = {
    outcome: 'not-applied',
    explanation,
    withdrawnByHuman: true,
    agent: null,
    resolvedAt: at,
  };
  await appendEvent(dir, { type: 'withdrawn', from: 'human' });
  await writeJsonAtomic(path.join(dir, 'resolution.json'), body);
  const next = {
    ...state,
    status: 'resolved',
    resolution: { outcome: 'not-applied', at, agent: null, withdrawnByHuman: true },
    updatedAt: at,
  };
  delete next.lease;
  await writeJsonAtomic(path.join(dir, 'state.json'), next);
  return { id: adviceId, status: 'resolved' };
}

/**
 * Withdraw every still-open item on a film. Returns what it closed so the
 * caller can report a number rather than a shrug.
 */
export async function withdrawAllAdvice({ filmPath, reason = null }) {
  const open = await listAdvice({ filmPath, status: 'unresolved' });
  const withdrawn = [];
  for (const a of open) {
    const r = await withdrawAdvice({ filmPath, adviceId: a.id, reason });
    if (!r.alreadyClosed) withdrawn.push(a.id);
  }
  return { withdrawn, count: withdrawn.length };
}

/* ------------------------------------------------------------------ */
/* Evidence — best-effort, never load-bearing                          */
/* ------------------------------------------------------------------ */

/**
 * Attach a captured frame (or metadata alone) as before/after evidence.
 * Callers capture asynchronously AFTER the request/resolution is durable;
 * failure is recorded, not thrown upward.
 */
export async function writeAdviceEvidence({ filmPath, adviceId, which, png = null, meta = {} }) {
  if (!['before', 'after'].includes(which)) {
    throw new EngineError(ErrorCodes.INVALID_ADVICE, 'evidence is "before" or "after"', { which });
  }
  const dir = advicePath(filmPath, adviceId);
  if (!fs.existsSync(path.join(dir, 'request.json'))) {
    throw new EngineError(ErrorCodes.ADVICE_NOT_FOUND, `No such advice "${adviceId}"`, { adviceId });
  }
  const evDir = path.join(dir, 'evidence');
  await fsp.mkdir(evDir, { recursive: true });
  if (png) {
    const tmp = path.join(evDir, `${which}.png.tmp-${process.pid}`);
    await fsp.writeFile(tmp, png);
    await fsp.rename(tmp, path.join(evDir, `${which}.png`));
  }
  await writeJsonAtomic(path.join(evDir, `${which}.json`), {
    capturedAt: new Date().toISOString(),
    image: !!png,
    ...meta,
  });
  await appendEvent(dir, { type: 'evidence-captured', which, image: !!png });
  return { adviceId, which, image: !!png };
}

/** Record that evidence capture was attempted and failed — never lose why. */
export async function recordEvidenceFailure({ filmPath, adviceId, which, reason }) {
  const dir = advicePath(filmPath, adviceId);
  if (!fs.existsSync(path.join(dir, 'request.json'))) return null;
  await fsp.mkdir(path.join(dir, 'evidence'), { recursive: true });
  await writeJsonAtomic(path.join(dir, 'evidence', `${which}.json`), {
    capturedAt: new Date().toISOString(),
    image: false,
    warning: String(reason ?? 'evidence capture failed'),
  });
  await appendEvent(dir, { type: 'evidence-failed', which, reason: String(reason ?? '') });
  return { adviceId, which, warning: String(reason ?? '') };
}

/** Absolute path of an evidence image, existence-checked (for serving). */
export function adviceEvidencePath(filmPath, adviceId, which) {
  if (!['before', 'after'].includes(which)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, 'evidence is "before" or "after"', { which });
  }
  const abs = path.join(advicePath(filmPath, adviceId), 'evidence', `${which}.png`);
  if (!fs.existsSync(abs)) {
    throw new EngineError(ErrorCodes.FILE_NOT_FOUND, `Advice "${adviceId}" has no ${which} image`, { adviceId, which });
  }
  return abs;
}

/**
 * Revision ids advice evidence pins (observations, preferences, resolutions).
 * Retention must never delete these — they are what "what I saw" reopens.
 */
export async function advicePinnedRevisionIds(filmPath) {
  const pinned = new Set();
  for (const a of await listAdvice({ filmPath })) {
    if (a.observation?.revisionId) pinned.add(a.observation.revisionId);
    if (a.preferredRevisionId) pinned.add(a.preferredRevisionId);
    for (const id of a.resolution?.revisionIds ?? []) pinned.add(id);
  }
  return pinned;
}
