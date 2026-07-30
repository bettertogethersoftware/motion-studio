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
  // v0.20 storage model: a "scene" is what earlier releases called a project.
  // The codes were renamed with the concept — nothing had shipped, so there
  // are no legacy aliases to carry.
  SCENE_NOT_FOUND: 'scene_not_found',
  SCENE_ALREADY_EXISTS: 'scene_already_exists',
  INVALID_CONFIG: 'invalid_config',
  PATH_NOT_ALLOWED: 'path_not_allowed',
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
  // A fully encoded staging file failed an explicit producer review policy.
  // Distinct from SHORT_RENDER (which is a corrupt/incomplete encode): this
  // output can be technically valid, but a chosen delivery rule holds it back.
  PROMOTION_BLOCKED: 'promotion_blocked',
  // A requested Stage-A output id is not configured on the film.  This is
  // deliberately distinct from invalid_film: the document can be healthy,
  // but the caller asked for a variant it does not contain.
  UNKNOWN_DELIVERABLE: 'unknown_deliverable',
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
  // added in v0.14 (in-job capture recovery) — see docs/CHANGELOG.md.
  // A crash-shaped Chromium failure ("Target closed" et al.): transient, not a
  // bad composition. The capture loop relaunches and retries on this code; it
  // only surfaces to callers after the relaunch budget is spent.
  BROWSER_CRASHED: 'browser_crashed',
  // added in v0.19 (audio-only mixdown / preview_audio) — see docs/CHANGELOG.md
  NO_AUDIO_TRACKS: 'no_audio_tracks',
  // added with saved films (Studio film editor + save_film) — see docs/CHANGELOG.md
  FILM_NOT_FOUND: 'film_not_found',
  INVALID_FILM: 'invalid_film',
  // added in v0.20 (workspace → film → scene storage model) — see docs/CHANGELOG.md
  // added in v0.21 (render sidecar / stale-render detection) — see docs/CHANGELOG.md.
  // Distinct from SHORT_RENDER: that file is incomplete, this one is complete
  // but was rendered at settings the scene no longer has.
  STALE_RENDER: 'stale_render',
  WORKSPACE_NOT_FOUND: 'workspace_not_found',
  FILM_ALREADY_EXISTS: 'film_already_exists',
  INVALID_ID: 'invalid_id',
  MIGRATION_FAILED: 'migration_failed',
  // added in v0.22 (transcribe_asset / whisper.cpp) — see docs/CHANGELOG.md.
  // Same taxonomy the speech and music vendors follow: UNAVAILABLE is a setup
  // problem for the user to fix (no binary, no model) and must not be retried;
  // FAILED is the vendor running and not producing a transcript.
  TRANSCRIPTION_UNAVAILABLE: 'transcription_unavailable',
  TRANSCRIPTION_FAILED: 'transcription_failed',
  // The requested language cannot be decoded by the selected model. Distinct
  // from INVALID_CONFIG: both the model and language are valid individually,
  // but their combination would produce a plausible, wrong transcript.
  TRANSCRIPTION_LANGUAGE_UNSUPPORTED: 'transcription_language_unsupported',
  // Distinct from both: the file exists and the vendor is ready, but the input
  // could not be turned into the 16 kHz mono PCM whisper.cpp requires (not
  // media, an unsupported codec, no audio stream). Neither the user's setup nor
  // the vendor is broken — the *file* is the problem, so the fix is a different
  // file, and retrying this one will not help.
  TRANSCRIPTION_INPUT_UNSUPPORTED: 'transcription_input_unsupported',
  // added in v0.22 (footage segments on the film timeline) — see docs/CHANGELOG.md.
  // All three are plan-time problems as well as build-time errors, reported
  // beside scene_not_rendered and stale_render so a caller sees them before
  // paying for a build.
  FOOTAGE_MISSING: 'footage_missing',
  // The declared frame count disagrees with the file. Load-bearing: every
  // downstream offset derives from the declaration, so one wrong count silently
  // shifts every later scene, caption and cue while the render still succeeds.
  FOOTAGE_DURATION_MISMATCH: 'footage_duration_mismatch',
  // The footage does not match the film's encode signature, so it cannot be
  // stream-copied onto the timeline. Never silently re-encoded: a film that
  // quietly re-encodes one segment has stopped being losslessly assembled.
  FOOTAGE_SIGNATURE_MISMATCH: 'footage_signature_mismatch',
  // A prepared footage file still exists, but the source used to make it has
  // changed since its recorded transcode. The plan reports this before a build
  // so an old trim can never masquerade as a current source edit.
  FOOTAGE_SOURCE_CHANGED: 'footage_source_changed',
  // added in v0.22 (transcode_asset) — see docs/CHANGELOG.md.
  // ffmpeg ran and did not produce the asked-for file. Distinct from
  // UNSUPPORTED_FORMAT (the destination extension names no format this engine
  // writes) and from INVALID_CONFIG (a field failed validation before anything
  // was spawned).
  TRANSCODE_FAILED: 'transcode_failed',
  // added in v0.22 (configurable storage locations) — see docs/CHANGELOG.md.
  // The data dir cannot be moved out from under work that is already running.
  // Distinct from INVALID_CONFIG (the location itself was rejected): the
  // locations are fine, the timing is not, and the caller's fix is to wait or
  // cancel rather than to supply a different path.
  STORAGE_BUSY: 'storage_busy',
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
