/**
 * Render job manager — owns job lifecycle, progress snapshots for
 * `get_render_status` polling, log capture for `get_logs`, and scheduling.
 *
 * v0.5 change: submitting a render while another is running no longer fails
 * with render_already_in_progress — the job is QUEUED and starts
 * automatically when a slot frees (FIFO). The old fail-fast behavior forced
 * agents into poll-then-submit races; a visible queue is both friendlier and
 * race-free. The queue is bounded (default 10) so an unattended agent loop
 * still cannot fan out unbounded work; a full queue fails with queue_full.
 *
 * States: queued → running → done | error | cancelled
 * (cancel on a queued job goes straight to cancelled).
 */

import { randomUUID } from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';
import { ProgressEmitter } from './progress.js';
import { renderComposition, renderParallel } from './renderer.js';

export const JobState = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

const MAX_RECENT_JOBS = 20;
const MAX_LOG_LINES = 500;

export class JobManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxConcurrent=1]
   * @param {number} [opts.maxQueued=10]
   * @param {number} [opts.maxJobsPerSession=Infinity]  optional agent resource cap
   */
  constructor({ maxConcurrent = 1, maxQueued = 10, maxJobsPerSession = Infinity } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.maxJobsPerSession = maxJobsPerSession;
    this.jobs = new Map(); // jobId -> job record
    this.queue = []; // jobIds in FIFO order
    this.totalStarted = 0;
  }

  runningCount() {
    let n = 0;
    for (const j of this.jobs.values()) if (j.state === JobState.RUNNING) n++;
    return n;
  }

  queuedCount() {
    return this.queue.length;
  }

  /**
   * Submit a render job. Runs immediately if a slot is free, otherwise
   * queues (FIFO). Throws queue_full when the bounded queue is at capacity.
   *
   * @returns {{jobId: string, state: 'running'|'queued', queuePosition?: number}}
   */
  startRender({ projectId, projectPath, config, outputPath, frameRange, workers, renderFn, preflight, ffmpegPath }) {
    if (this.totalStarted >= this.maxJobsPerSession) {
      throw new EngineError(
        ErrorCodes.QUEUE_FULL,
        `Session render cap reached (${this.maxJobsPerSession}). Restart the MCP server to reset.`,
      );
    }
    if (this.runningCount() >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
      throw new EngineError(
        ErrorCodes.QUEUE_FULL,
        `Render queue is full (${this.maxQueued} queued, ${this.maxConcurrent} running). ` +
          'Wait for jobs to finish or cancel_render one first.',
        { queuedJobIds: [...this.queue] },
      );
    }

    const jobId = randomUUID();
    const job = {
      jobId,
      projectId,
      outputPath,
      state: JobState.QUEUED,
      phase: 'queued',
      frame: 0,
      framesDone: 0,
      totalFrames: frameRange ? frameRange[1] - frameRange[0] + 1 : config.durationInFrames,
      renderFps: 0,
      etaMs: null,
      submittedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      logs: [],
      controller: new AbortController(),
      childPids: new Set(),
      _run: { projectPath, config, outputPath, frameRange, workers, renderFn, preflight, ffmpegPath },
    };
    this.jobs.set(jobId, job);
    this.totalStarted++;
    this._trimOldJobs();

    if (this.runningCount() < this.maxConcurrent) {
      this._launch(job);
      return { jobId, state: JobState.RUNNING };
    }
    this.queue.push(jobId);
    return { jobId, state: JobState.QUEUED, queuePosition: this.queue.length };
  }

  _launch(job) {
    job.state = JobState.RUNNING;
    job.phase = 'starting';
    job.startedAt = new Date().toISOString();

    const pushLog = (level, message) => {
      job.logs.push({ t: new Date().toISOString(), level, message });
      if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    };
    job._pushLog = pushLog;

    const progress = new ProgressEmitter(null, (msg) => {
      switch (msg.type) {
        case 'progress':
          job.frame = msg.frame;
          job.framesDone = msg.framesDone;
          job.renderFps = msg.renderFps;
          job.etaMs = msg.etaMs ?? null;
          break;
        case 'phase':
          job.phase = msg.phase;
          pushLog('info', `phase: ${msg.phase}`);
          break;
        case 'log':
          pushLog(msg.level, msg.message);
          break;
        case 'error':
          pushLog('error', `${msg.code}: ${msg.message}`);
          break;
        default:
          break;
      }
    });

    const { projectPath, config, outputPath, frameRange, workers, renderFn, preflight, ffmpegPath } = job._run;
    const doRender = renderFn ?? (workers && workers > 1 ? renderParallel : renderComposition);
    doRender({
      projectPath, config, outputPath, frameRange, workers,
      ...(ffmpegPath ? { ffmpegPath } : {}),
      ...(preflight === undefined ? {} : { preflight }),
      signal: job.controller.signal,
      progress,
      jobId: job.jobId,
      onChildPid: (pid) => job.childPids.add(pid),
    })
      .then((result) => {
        job.state = JobState.DONE;
        job.phase = 'done';
        job.finishedAt = new Date().toISOString();
        job.result = result;
      })
      .catch((err) => {
        const e = err instanceof EngineError ? err : new EngineError(ErrorCodes.INTERNAL, String(err?.message ?? err));
        job.state = e.code === ErrorCodes.CANCELLED ? JobState.CANCELLED : JobState.ERROR;
        job.phase = job.state;
        job.finishedAt = new Date().toISOString();
        job.error = e.toJSON();
        pushLog('error', e.message);
      })
      .finally(() => this._pump());
  }

  /** Start the next queued job if a slot is free. */
  _pump() {
    while (this.runningCount() < this.maxConcurrent && this.queue.length > 0) {
      const nextId = this.queue.shift();
      const job = this.jobs.get(nextId);
      if (job && job.state === JobState.QUEUED) this._launch(job);
    }
  }

  getStatus(jobId) {
    const job = this._get(jobId);
    const queuePosition = job.state === JobState.QUEUED ? this.queue.indexOf(jobId) + 1 : undefined;
    return {
      jobId: job.jobId,
      projectId: job.projectId,
      state: job.state,
      phase: job.phase,
      frame: job.frame,
      framesDone: job.framesDone,
      totalFrames: job.totalFrames,
      renderFps: job.renderFps,
      etaMs: job.etaMs,
      percent: job.totalFrames ? Math.round((job.framesDone / job.totalFrames) * 100) : 0,
      outputPath: job.outputPath,
      submittedAt: job.submittedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      // Measured level of the muxed mix (v0.10) — the caller cannot hear it.
      ...(job.result?.audio ? { audio: job.result.audio } : {}),
      ...(queuePosition ? { queuePosition } : {}),
    };
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
      .map((j) => this.getStatus(j.jobId));
  }

  /**
   * Wait until every listed job reaches a terminal state (done | error |
   * cancelled), or the timeout elapses (v0.14). Backs `wait_for_render`: one
   * blocking call instead of a get_render_status round trip per poll. Unknown
   * ids fail up front with job_not_found, not halfway through the wait. A
   * timeout is NOT an error — the caller gets the current snapshots plus
   * `timedOut: true` and decides what to do; the jobs keep running.
   */
  async waitFor(jobIds, { timeoutMs = 300_000, pollMs = 250 } = {}) {
    for (const id of jobIds) this._get(id);
    const terminal = new Set([JobState.DONE, JobState.ERROR, JobState.CANCELLED]);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const statuses = jobIds.map((id) => this.getStatus(id));
      if (statuses.every((s) => terminal.has(s.state))) return { timedOut: false, jobs: statuses };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { timedOut: true, jobs: statuses };
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
    }
  }

  getLogs(jobId, { tail = 100 } = {}) {
    const job = this._get(jobId);
    return job.logs.slice(-tail);
  }

  /**
   * Cancel a job. Queued jobs are dequeued and marked cancelled immediately;
   * running jobs get their render aborted (which kills the FFmpeg sink,
   * Chromium, and any parallel workers), then any pid the renderer reported
   * that is still alive is hard-killed — belt and braces against orphans.
   */
  cancel(jobId) {
    const job = this._get(jobId);
    if (job.state === JobState.QUEUED) {
      const idx = this.queue.indexOf(jobId);
      if (idx >= 0) this.queue.splice(idx, 1);
      job.state = JobState.CANCELLED;
      job.phase = 'cancelled';
      job.finishedAt = new Date().toISOString();
      return { jobId, state: JobState.CANCELLED, note: 'dequeued before starting' };
    }
    if (job.state !== JobState.RUNNING) {
      return { jobId, state: job.state, note: 'job was not running' };
    }
    job.controller.abort();
    setTimeout(() => {
      for (const pid of job.childPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }, 2000).unref();
    return { jobId, state: 'cancelling' };
  }

  _get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new EngineError(ErrorCodes.JOB_NOT_FOUND, `No render job with id "${jobId}"`, { jobId });
    return job;
  }

  _trimOldJobs() {
    const finished = [...this.jobs.values()].filter(
      (j) => j.state !== JobState.RUNNING && j.state !== JobState.QUEUED,
    );
    while (finished.length > MAX_RECENT_JOBS) {
      const oldest = finished.shift();
      this.jobs.delete(oldest.jobId);
    }
  }
}
