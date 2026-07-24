/**
 * Structured errors shared by the CLI and MCP entry points.
 *
 * Every failure that can cross a process/tool boundary is an EngineError with
 * a stable machine-readable `code`, so the WinForms shell and MCP agents can
 * branch on codes instead of parsing English prose. Codes are part of the
 * public contract (see docs/architecture.md §Error model) — add new ones,
 * never repurpose old ones.
 */

export const ErrorCodes = Object.freeze({
  PREREQS_MISSING: 'prereqs_missing',
  PROJECT_NOT_FOUND: 'project_not_found',
  PROJECT_ALREADY_EXISTS: 'project_already_exists',
  INVALID_CONFIG: 'invalid_config',
  PATH_OUTSIDE_PROJECT: 'path_outside_project',
  FILE_NOT_FOUND: 'file_not_found',
  SYNTAX_ERROR: 'syntax_error',
  RENDER_ALREADY_IN_PROGRESS: 'render_already_in_progress',
  JOB_NOT_FOUND: 'job_not_found',
  BROWSER_LAUNCH_FAILED: 'browser_launch_failed',
  COMPOSITION_ERROR: 'composition_error',
  FRAME_TIMEOUT: 'frame_timeout',
  FFMPEG_FAILED: 'ffmpeg_failed',
  CANCELLED: 'cancelled',
  DISK_ERROR: 'disk_error',
  INTERNAL: 'internal_error',
  // added in v0.5 — see docs/CHANGELOG.md
  UNSUPPORTED_FORMAT: 'unsupported_format',
  ASSET_TOO_LARGE: 'asset_too_large',
  QUEUE_FULL: 'queue_full',
});

export class EngineError extends Error {
  /**
   * @param {string} code    one of ErrorCodes
   * @param {string} message human-readable description
   * @param {object} [detail] extra structured context (safe to serialize)
   */
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/** Wrap an unknown thrown value into an EngineError without losing info. */
export function asEngineError(err, fallbackCode = ErrorCodes.INTERNAL) {
  if (err instanceof EngineError) return err;
  const message = err && err.message ? err.message : String(err);
  return new EngineError(fallbackCode, message);
}
