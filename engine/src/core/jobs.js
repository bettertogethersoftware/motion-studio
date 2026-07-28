/**
 * Job manager — owns job lifecycle, progress snapshots for
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
 *
 * ## Two lanes (v0.22)
 *
 * The render lane is deliberately one-at-a-time, because a render saturates the
 * machine. `transcribe_asset` is the first job that is *not* a render, and it
 * must not sit behind one: transcription is what you do **while** deciding what
 * to render, and a 10-second read of a clip stuck behind a 12-minute render is
 * the opposite of that.
 *
 * So `startTask` submits into a **second lane** with its own small concurrency
 * limit and its own bounded queue, sharing everything an agent already knows how
 * to use — the id space, `get_render_status`, `wait_for_render`, `get_logs`,
 * `cancel_render`. The only visible difference is `kind`, and that a finished
 * task carries its `result` in the status (a render's result is the file it
 * wrote; a task's result IS the answer).
 *
 * The two lanes never borrow each other's slots. A queue that quietly lets
 * transcriptions consume the render slot would reintroduce exactly the
 * head-of-line blocking the split exists to remove.
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

/** The render lane, and everything else. See the module header. */
export const RENDER_LANE = 'render';
export const TASK_LANE = 'task';

export class JobManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxConcurrent=1]
   * @param {number} [opts.maxQueued=10]
   * @param {number} [opts.maxJobsPerSession=Infinity]  optional agent resource cap
   * @param {number} [opts.maxConcurrentTasks=2]  the non-render lane (v0.22)
   * @param {number} [opts.maxQueuedTasks=20]
   */
  constructor({
    maxConcurrent = 1, maxQueued = 10, maxJobsPerSession = Infinity,
    maxConcurrentTasks = 2, maxQueuedTasks = 20,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.maxJobsPerSession = maxJobsPerSession;
    // Two is not arbitrary: one transcription saturates the CPU it was given
    // threads for, and a second waiting to start is the common authoring shape
    // (read the interview, then read the b-roll). More would just thrash.
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.maxQueuedTasks = maxQueuedTasks;
    this.jobs = new Map(); // jobId -> job record
    this.queue = []; // render lane, jobIds in FIFO order
    this.taskQueue = []; // task lane, jobIds in FIFO order
    this.totalStarted = 0;
  }

  /** Running jobs in one lane (default: the render lane). */
  runningCount(lane = RENDER_LANE) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.state === JobState.RUNNING && j.lane === lane) n++;
    return n;
  }

  queuedCount(lane = RENDER_LANE) {
    return (lane === TASK_LANE ? this.taskQueue : this.queue).length;
  }

  _laneQueue(lane) {
    return lane === TASK_LANE ? this.taskQueue : this.queue;
  }

  _laneLimit(lane) {
    return lane === TASK_LANE ? this.maxConcurrentTasks : this.maxConcurrent;
  }

  /**
   * Submit a render job. Runs immediately if a slot is free, otherwise
   * queues (FIFO). Throws queue_full when the bounded queue is at capacity.
   *
   * @returns {{jobId: string, state: 'running'|'queued', queuePosition?: number}}
   */
  startRender({ targetId, scenePath, config, outputPath, frameRange, workers, renderFn, preflight, ffmpegPath }) {
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
      kind: 'render',
      lane: RENDER_LANE,
      // What this job is for: a scene id for a render, a film id for a build.
      targetId,
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
      _run: { scenePath, config, outputPath, frameRange, workers, renderFn, preflight, ffmpegPath },
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

  /**
   * Submit a non-render job into the task lane (v0.22).
   *
   * `run` is handed `{ signal, onPhase, log }` and returns the job's result,
   * which the status reports verbatim once the job is done — for a transcription
   * that result *is* the answer, so there is nothing else to fetch.
   *
   * The session render cap (MOTION_STUDIO_MAX_RENDERS) deliberately does not
   * apply: it exists to bound an unattended agent's *renders*, and reading a file
   * it was handed is not one.
   *
   * @param {object} opts
   * @param {string} opts.kind       what this is, e.g. "transcribe" (shown in status)
   * @param {string} [opts.targetId] what it is about (a path, a scene id) — for the UI
   * @param {(ctx: {signal: AbortSignal, onPhase: Function, log: Function}) => Promise<any>} opts.run
   * @returns {{jobId: string, state: 'running'|'queued', queuePosition?: number}}
   */
  startTask({ kind = 'task', targetId, run }) {
    if (typeof run !== 'function') {
      throw new EngineError(ErrorCodes.INTERNAL, 'startTask requires a run() function');
    }
    if (this.runningCount(TASK_LANE) >= this.maxConcurrentTasks && this.taskQueue.length >= this.maxQueuedTasks) {
      throw new EngineError(
        ErrorCodes.QUEUE_FULL,
        `The ${kind} queue is full (${this.maxQueuedTasks} queued, ${this.maxConcurrentTasks} running). ` +
          'Wait for one to finish, or cancel_render one of them first.',
        { queuedJobIds: [...this.taskQueue] },
      );
    }
    const jobId = randomUUID();
    const job = {
      jobId,
      kind,
      lane: TASK_LANE,
      targetId,
      outputPath: null,
      state: JobState.QUEUED,
      phase: 'queued',
      // A task has no frames. Reported as 0 rather than omitted so one status
      // shape serves both lanes and `percent` stays a number.
      frame: 0,
      framesDone: 0,
      totalFrames: 0,
      renderFps: 0,
      etaMs: null,
      submittedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      logs: [],
      controller: new AbortController(),
      childPids: new Set(),
      _task: run,
    };
    this.jobs.set(jobId, job);
    this._trimOldJobs();

    if (this.runningCount(TASK_LANE) < this.maxConcurrentTasks) {
      this._launchTask(job);
      return { jobId, state: JobState.RUNNING };
    }
    this.taskQueue.push(jobId);
    return { jobId, state: JobState.QUEUED, queuePosition: this.taskQueue.length };
  }

  _pushLogger(job) {
    const pushLog = (level, message) => {
      job.logs.push({ t: new Date().toISOString(), level, message });
      if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    };
    job._pushLog = pushLog;
    return pushLog;
  }

  _finish(job, err) {
    job.finishedAt = new Date().toISOString();
    if (!err) {
      job.state = JobState.DONE;
      job.phase = 'done';
      return;
    }
    const e = err instanceof EngineError ? err : new EngineError(ErrorCodes.INTERNAL, String(err?.message ?? err));
    job.state = e.code === ErrorCodes.CANCELLED ? JobState.CANCELLED : JobState.ERROR;
    job.phase = job.state;
    job.error = e.toJSON();
    job._pushLog?.('error', e.message);
  }

  _launchTask(job) {
    job.state = JobState.RUNNING;
    job.phase = 'starting';
    job.startedAt = new Date().toISOString();
    const pushLog = this._pushLogger(job);

    Promise.resolve()
      .then(() => job._task({
        signal: job.controller.signal,
        onPhase: (phase) => { job.phase = phase; pushLog('info', `phase: ${phase}`); },
        log: (message, level = 'info') => pushLog(level, message),
        onChildPid: (pid) => job.childPids.add(pid),
      }))
      .then((result) => {
        job.result = result;
        this._finish(job, null);
      })
      .catch((err) => this._finish(job, err))
      .finally(() => this._pump());
  }

  _launch(job) {
    job.state = JobState.RUNNING;
    job.phase = 'starting';
    job.startedAt = new Date().toISOString();

    const pushLog = this._pushLogger(job);

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

    const { scenePath, config, outputPath, frameRange, workers, renderFn, preflight, ffmpegPath } = job._run;
    const doRender = renderFn ?? (workers && workers > 1 ? renderParallel : renderComposition);
    doRender({
      scenePath, config, outputPath, frameRange, workers,
      ...(ffmpegPath ? { ffmpegPath } : {}),
      ...(preflight === undefined ? {} : { preflight }),
      signal: job.controller.signal,
      progress,
      jobId: job.jobId,
      onChildPid: (pid) => job.childPids.add(pid),
    })
      .then((result) => {
        job.result = result;
        this._finish(job, null);
      })
      .catch((err) => this._finish(job, err))
      .finally(() => this._pump());
  }

  /** Start the next queued job in each lane, if that lane has a slot free. */
  _pump() {
    for (const lane of [RENDER_LANE, TASK_LANE]) {
      const queue = this._laneQueue(lane);
      const launch = lane === TASK_LANE ? (j) => this._launchTask(j) : (j) => this._launch(j);
      while (this.runningCount(lane) < this._laneLimit(lane) && queue.length > 0) {
        const nextId = queue.shift();
        const job = this.jobs.get(nextId);
        if (job && job.state === JobState.QUEUED) launch(job);
      }
    }
  }

  getStatus(jobId) {
    const job = this._get(jobId);
    const queuePosition = job.state === JobState.QUEUED
      ? this._laneQueue(job.lane).indexOf(jobId) + 1
      : undefined;
    return {
      jobId: job.jobId,
      // "render" for a render or a film build; the task name otherwise (v0.22).
      kind: job.kind ?? 'render',
      targetId: job.targetId,
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
      // Player-compatibility advisories (v0.22, e.g. mp4 crf 0 → Hi444PP) —
      // the caller cannot try the file in a consumer player either.
      ...(job.result?.encodingWarnings ? { encodingWarnings: job.result.encodingWarnings } : {}),
      // A task-lane job's result IS its answer (a transcript, not a file), so it
      // rides along once the job is done. A render's result is deliberately not
      // spread here: the file it wrote is already `outputPath`, and the rest is
      // internal bookkeeping no caller has ever needed.
      ...(job.lane === TASK_LANE && job.state === JobState.DONE && job.result !== undefined
        ? { result: job.result }
        : {}),
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
   * Cancel a job, in either lane. Queued jobs are dequeued and marked cancelled
   * immediately; running jobs get their work aborted through the same
   * AbortSignal (for a render that kills the FFmpeg sink, Chromium and any
   * parallel workers; for a task, whatever it spawned), then any pid the job
   * reported that is still alive is hard-killed — belt and braces against
   * orphans.
   */
  cancel(jobId) {
    const job = this._get(jobId);
    if (job.state === JobState.QUEUED) {
      const queue = this._laneQueue(job.lane);
      const idx = queue.indexOf(jobId);
      if (idx >= 0) queue.splice(idx, 1);
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
