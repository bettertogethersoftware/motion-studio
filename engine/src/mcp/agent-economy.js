/**
 * Agent-economy proxies (token-efficient plan, P1-4).
 *
 * Motion Studio cannot see the LLM provider's token ledger and must never
 * pretend otherwise. What it CAN count is what it did and what it sent back:
 * calls per tool, the response bytes those calls returned, how often a
 * compact projection was served instead of the full one, and how many
 * per-scene calls a batch operation replaced. An agent correlates these
 * proxies with its own token log; the file itself says so in `notes`.
 *
 * The counter is per SESSION: a new server run replaces the file (its
 * `startedAt` names the run). Everything here is best effort — telemetry that
 * can fail a tool call, block a response, or keep the event loop alive would
 * cost more than it measures, so writes are fire-and-forget, the debounce
 * timer is unref'd, and every failure is one stderr line.
 *
 * It records NAMES AND NUMBERS ONLY: no arguments, no prompts, no file
 * contents, no credentials. The canary test in test/agent-economy.test.js
 * holds that line.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const AGENT_ECONOMY_FILE = 'agent-economy.json';
export const AGENT_ECONOMY_SCHEMA = 'motion-studio.agent-economy/1';

const NOTES = 'proxies only — token billing is the LLM provider\'s ledger';

/**
 * Which tools take a PROJECTION `detail`, and what the handler falls back to
 * when the argument is absent (report_agent_activity's free-text `detail` is
 * not a projection and is deliberately not listed). Anything but "full" is a
 * compact response. Add a row when a new projection tool ships — an unlisted
 * tool simply reports 0/0 rather than guessing.
 */
const DETAIL_DEFAULTS = {
  list_films: 'summary',
  get_film: 'full',
  get_production_status: 'summary',
  write_composition_bundle: 'summary',
};

/** The batch counters, fixed so the shape is stable even in a quiet session. */
const emptyBatches = () => ({ itemsLinked: 0, bundleTargets: 0, groupScenes: 0 });

/** Response bytes = the UTF-8 length of the text blocks the server hands back. */
function responseBytes(result) {
  let bytes = 0;
  for (const block of result?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') bytes += Buffer.byteLength(block.text, 'utf8');
  }
  return bytes;
}

/**
 * Create the session counter.
 *
 * @param {object}  o
 * @param {string}  o.dataDir      storage root; the report lands at its top level
 * @param {string}  o.workspace    the workspace this server serves
 * @param {string}  o.agent        the director identity stamped on evidence
 * @param {number} [o.flushEvery]  hard flush cadence, in calls
 * @param {number} [o.debounceMs]  idle flush delay, so a short session lands too
 */
export function createAgentEconomy({ dataDir, workspace, agent, flushEvery = 20, debounceMs = 250 }) {
  const file = path.join(dataDir, AGENT_ECONOMY_FILE);
  const report = {
    schema: AGENT_ECONOMY_SCHEMA,
    workspace,
    agent,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tools: {},
    batches: emptyBatches(),
    notes: NOTES,
  };

  let sinceFlush = 0;
  let dirty = false;
  let writing = false;
  let timer = null;
  let warned = false;

  const warn = (err) => {
    if (warned) return;
    warned = true;
    process.stderr.write(`[motion-studio-mcp] agent-economy report not written (${err.message}); telemetry is optional\n`);
  };

  const snapshot = () => JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2);

  /** Fire-and-forget write; never awaited by a response path. */
  async function flush() {
    if (writing || !dirty) return;
    writing = true;
    dirty = false;
    sinceFlush = 0;
    const tmp = file + '.tmp-' + process.pid;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, snapshot());
      await fsp.rename(tmp, file); // atomic on the same volume
    } catch (err) {
      warn(err);
    } finally {
      writing = false;
    }
  }

  /** Exit path: the same write, synchronously, because there is no later. */
  function flushSync() {
    if (!dirty) return;
    dirty = false;
    // A distinct temp name: an async flush may still hold the other one open.
    const tmp = file + '.tmp-' + process.pid + '-exit';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, snapshot());
      fs.renameSync(tmp, file);
    } catch (err) {
      warn(err);
    }
  }

  function schedule() {
    if (sinceFlush >= flushEvery) {
      if (timer) { clearTimeout(timer); timer = null; }
      void flush();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, debounceMs);
    timer.unref?.(); // telemetry never holds the process open
  }

  return {
    file,

    /** Count one completed tool call. Never throws. */
    record(name, args, result) {
      const row = report.tools[name] ?? (report.tools[name] = { calls: 0, bytes: 0, compact: 0, full: 0 });
      row.calls += 1;
      row.bytes += responseBytes(result);
      const fallback = DETAIL_DEFAULTS[name];
      if (fallback !== undefined) {
        const detail = args?.detail ?? fallback;
        if (detail === 'full') row.full += 1;
        else row.compact += 1;
      }
      dirty = true;
      sinceFlush += 1;
      schedule();
    },

    /** Count the per-scene calls a batch operation replaced. */
    addBatch(key, n) {
      if (!(key in report.batches) || !Number.isFinite(n)) return;
      report.batches[key] += n;
      dirty = true;
      schedule();
    },

    /** Install the exit flush. Idempotent per server run. */
    installExitFlush() {
      process.on('exit', flushSync);
    },

    /** Testing/diagnostics: the in-memory report and an awaited write. */
    snapshot: () => JSON.parse(snapshot()),
    flushNow: () => { dirty = true; return flush(); },
  };
}
