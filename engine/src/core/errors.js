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
  // added in v0.6 (text-to-speech / narration) — see docs/CHANGELOG.md
  TTS_UNAVAILABLE: 'tts_unavailable',
  TTS_FAILED: 'tts_failed',
  UNSUPPORTED_VOICE: 'unsupported_voice',
  // added in v0.7 (optional 3D libraries) — see docs/CHANGELOG.md
  LIBRARY_UNAVAILABLE: 'library_unavailable',
  // added in v0.8 (music generation) — see docs/CHANGELOG.md
  MUSIC_UNAVAILABLE: 'music_unavailable',
  MUSIC_FAILED: 'music_failed',
  INVALID_MUSIC_SPEC: 'invalid_music_spec',
  // added in v0.9 (film assembly / build_film) — see docs/CHANGELOG.md
  INCONSISTENT_SCENES: 'inconsistent_scenes',
  SCENE_NOT_RENDERED: 'scene_not_rendered',
  FILM_FAILED: 'film_failed',
  // added in v0.11 (short-render detection) — see docs/CHANGELOG.md.
  // RENDER_ALREADY_IN_PROGRESS (above) is also first *raised* in v0.11, by the
  // cross-process render lock in core/lock.js.
  SHORT_RENDER: 'short_render',
  // added in v0.12 (sound-effects generator) — see docs/CHANGELOG.md.
  // No `sfx_unavailable` twin to MUSIC_UNAVAILABLE: core/sfx.js is pure JS with
  // no external toolchain, so it can never be missing.
  INVALID_SFX_SPEC: 'invalid_sfx_spec',
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
