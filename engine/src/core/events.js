/**
 * Production events (v0.23) — how the Studio stays live without polling.
 *
 * Two constraints shape this module:
 *
 *   1. Production truth is durable files, written by MORE THAN ONE PROCESS.
 *      The AI director works through its own MCP server process; the Studio
 *      server cannot see its in-process emissions. The only channel both
 *      share is the filesystem — so the Studio watches the workspaces root
 *      and translates interesting file changes into events.
 *   2. Events are notifications, never truth. Each event names an entity;
 *      clients refetch canonical state. Losing an event therefore costs a
 *      refetch, not correctness — which is what lets the ring buffer be
 *      small and the watcher be debounced and lossy.
 *
 * The SSE contract: every event has a monotonic id. A reconnecting client
 * sends Last-Event-ID; `since()` replays from the buffer when it can and
 * reports a gap when it cannot, and the server then tells the client to
 * refetch everything (a `reset` event) rather than pretending nothing
 * happened.
 */

import path from 'node:path';
import fs from 'node:fs';

/** In-process pub/sub with a replay ring buffer and monotonic ids. */
export class ProductionEvents {
  constructor({ bufferSize = 500 } = {}) {
    this.bufferSize = bufferSize;
    this.buffer = [];
    this.nextId = 1;
    this.listeners = new Set();
  }

  emit(type, data = {}) {
    const event = { id: this.nextId++, at: new Date().toISOString(), type, ...data };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* one bad listener must not break the rest */ }
    }
    return event;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Buffered events after `lastEventId`, or null when the id has fallen out
   * of the buffer (the caller should resynchronize with a full refetch).
   */
  since(lastEventId) {
    const id = Number(lastEventId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (id >= this.nextId - 1) return [];
    const oldest = this.buffer[0]?.id ?? this.nextId;
    if (id < oldest - 1) return null; // gap: events between id and the buffer were dropped
    return this.buffer.filter((e) => e.id > id);
  }
}

/** Path fragments that are never production truth. */
const IGNORED = /\.tmp-|\.staging|\.render\.lock/;

/**
 * Classify one changed path (relative to the workspaces root) into a
 * production event, or null when it is nobody's business. Pure — the watcher
 * calls it, tests exercise it directly.
 */
export function classifyChange(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/');
  if (!p || IGNORED.test(p)) return null;
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const ws = parts[0];

  if (parts[1] === 'activity') {
    return { type: 'activity', workspace: ws };
  }
  if (parts[1] !== 'films' || parts.length < 3) return null;
  const filmId = `${ws}/${parts[2]}`;
  const rest = parts.slice(3);
  if (!rest.length) return { type: 'film', filmId };

  switch (rest[0]) {
    case 'film.json':
      return { type: 'film', filmId };
    case 'advice':
      return rest[1] ? { type: 'advice', filmId, adviceId: rest[1] } : { type: 'advice', filmId };
    case 'deliveries':
      return rest[1] && rest[1] !== 'current.json'
        ? { type: 'delivery', filmId, deliveryId: rest[1] }
        : { type: 'delivery', filmId };
    case 'out':
      return { type: 'film-output', filmId };
    case 'scenes': {
      if (!rest[1]) return null;
      const sceneId = `${filmId}/${rest[1]}`;
      if (rest[2] === 'revisions') {
        return rest[3] && rest[3] !== 'current.json'
          ? { type: 'revision', filmId, sceneId, revisionId: rest[3] }
          : { type: 'revision', filmId, sceneId };
      }
      if (rest[2] === 'out') return { type: 'scene-output', filmId, sceneId };
      // Composition-source edits already have the per-scene hot-reload SSE;
      // repeating every keystroke on the production stream would drown it.
      return null;
    }
    default:
      return null;
  }
}

/**
 * Watch the workspaces root and emit production events for changes made by
 * ANY process — the Studio's own writes, an MCP server's, or a human moving
 * files by hand. Debounced and deduplicated per entity, because one logical
 * change (an advice folder appearing) is many fs notifications.
 *
 * Degrades to inactive where recursive fs.watch is unsupported; the Studio
 * then behaves like a plain polling UI (its own writes still emit in-process
 * events at the call sites).
 *
 * @returns {{ active: boolean, close(): void }}
 */
export function startWorkspaceWatcher({ root, events, debounceMs = 200 }) {
  let watcher = null;
  let timer = null;
  const pending = new Map(); // dedupe key → event data

  const flush = () => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const evt of batch) {
      const { type, ...data } = evt;
      events.emit(type, data);
    }
  };

  try {
    watcher = fs.watch(root, { recursive: true }, (_kind, filename) => {
      if (!filename) return;
      const classified = classifyChange(filename);
      if (!classified) return;
      const key = [classified.type, classified.filmId ?? classified.workspace ?? '',
        classified.sceneId ?? '', classified.adviceId ?? classified.deliveryId ?? classified.revisionId ?? ''].join('|');
      pending.set(key, classified);
      if (!timer) timer = setTimeout(flush, debounceMs);
      // Timer deliberately not unref'd per-event: one pending flush at a time.
    });
    watcher.on?.('error', () => { /* a dying watcher degrades to polling, never crashes the server */ });
  } catch {
    return { active: false, close() {} };
  }
  return {
    active: true,
    close() {
      clearTimeout(timer);
      timer = null;
      pending.clear();
      watcher?.close();
    },
  };
}

/** Serialize one event as an SSE frame. */
export function sseFrame(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
