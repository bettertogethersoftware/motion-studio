/**
 * JSON-line progress protocol (stdout, one JSON object per line).
 *
 * This is the single IPC contract between the render engine and both of its
 * consumers: any CLI consumer (parses the CLI's stdout), the MCP job
 * manager, and the Studio web UI (both tap the same stream in-process).
 *
 * Message types:
 *   {"type":"start",   "jobId","totalFrames","fps","width","height"}
 *   {"type":"progress","frame","totalFrames","framesDone","elapsedMs","renderFps","etaMs"}
 *   {"type":"phase",   "phase"}                 // "capturing" | "encoding" | "audio" | "concat"
 *   {"type":"log",     "level","message"}       // level: "info" | "warn"
 *   {"type":"done",    "outputPath","frames","elapsedMs"}
 *   {"type":"error",   "code","message","detail"?}
 *
 * Anything on stdout that is not a single-line JSON object is a protocol
 * violation; consumers treat unparseable lines as level="info" log noise.
 */

export class ProgressEmitter {
  /**
   * @param {NodeJS.WritableStream} stream  usually process.stdout
   * @param {(msg: object) => void} [onMessage] optional in-process tap (used by the MCP job manager)
   */
  constructor(stream = process.stdout, onMessage = undefined) {
    this.stream = stream;
    this.onMessage = onMessage;
  }

  emit(msg) {
    if (this.onMessage) this.onMessage(msg);
    if (this.stream) this.stream.write(JSON.stringify(msg) + '\n');
  }

  start({ jobId, totalFrames, fps, width, height }) {
    this.emit({ type: 'start', jobId, totalFrames, fps, width, height });
  }

  progress({ frame, totalFrames, framesDone, elapsedMs }) {
    const renderFps = elapsedMs > 0 ? +(framesDone / (elapsedMs / 1000)).toFixed(2) : 0;
    // ETA (v0.5): frames remaining at the observed capture rate. Null until
    // there is enough signal to be meaningful.
    const etaMs =
      renderFps > 0 && framesDone >= 3
        ? Math.round(((totalFrames - framesDone) / renderFps) * 1000)
        : null;
    this.emit({ type: 'progress', frame, totalFrames, framesDone, elapsedMs, renderFps, etaMs });
  }

  phase(phase) {
    this.emit({ type: 'phase', phase });
  }

  log(level, message) {
    this.emit({ type: 'log', level, message });
  }

  /** `audio` (v0.10) carries the measured mix level when the render had audio. */
  done({ outputPath, frames, elapsedMs, audio = undefined }) {
    this.emit({ type: 'done', outputPath, frames, elapsedMs, ...(audio ? { audio } : {}) });
  }

  error(engineError) {
    // Mark so multi-layer catch blocks (renderer → CLI) never double-emit.
    try { Object.defineProperty(engineError, '_emitted', { value: true, configurable: true }); } catch { /* frozen */ }
    this.emit({ type: 'error', ...engineError.toJSON() });
  }
}

/**
 * Parse one line of the protocol. Returns the message object, or a synthetic
 * {"type":"log"} wrapper for non-protocol lines so consumers never throw on
 * stray output (e.g. a dependency writing to stdout).
 */
export function parseProgressLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') return obj;
  } catch {
    /* fall through */
  }
  return { type: 'log', level: 'info', message: trimmed };
}

/**
 * Incremental line splitter for piped stdout chunks. Feed Buffers/strings,
 * receive complete parsed messages via callback.
 */
export class ProgressStreamParser {
  constructor(onMessage) {
    this.buffer = '';
    this.onMessage = onMessage;
  }

  feed(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const msg = parseProgressLine(line);
      if (msg) this.onMessage(msg);
    }
  }

  flush() {
    const msg = parseProgressLine(this.buffer);
    this.buffer = '';
    if (msg) this.onMessage(msg);
  }
}
