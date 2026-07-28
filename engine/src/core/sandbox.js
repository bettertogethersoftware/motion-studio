/**
 * Path sandbox: every file-touching MCP tool resolves paths through here.
 *
 * Contract: a tool may only read/write inside the target's own folder — a
 * scene's, or a film's when the call targets a film's assets. Rejection
 * happens at the tool-handler level via a structured PATH_NOT_ALLOWED
 * error — never left to convention.
 *
 * This is the INNER boundary, and it only knows about one folder. The outer
 * one — "an agent may only address its own workspace" — is enforced a layer
 * up, where ids are parsed and qualified (core/store.js, mcp/server.js);
 * a valid slug cannot contain a separator, so an id can never widen what
 * reaches this function.
 *
 * Enforced properties:
 *   - relative paths only ("../", absolute, or drive-letter paths rejected)
 *   - resolved real path must remain under the target root (symlink-escape
 *     is checked against the deepest existing ancestor, so a symlinked
 *     subfolder pointing outside it is also rejected)
 *   - null bytes rejected (classic path-truncation vector)
 *   - writes additionally restricted to an allow-listed set of source
 *     extensions — the agent's write surface is composition source files,
 *     not executables/configs
 */

import path from 'node:path';
import fs from 'node:fs';
import { EngineError, ErrorCodes } from './errors.js';

export const WRITABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md',
]);

// Binary asset types accepted by write_asset_file (v0.5). Confined to the
// target's assets/ folder; see WorkspaceStore.writeAssetFile.
export const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac',
  '.woff', '.woff2', '.ttf', '.otf',
  '.json', '.txt',
  // Video assets (saved films): overlay stingers / lower-thirds — a
  // transparent .webm or .mov laid over the film by the finishing pass.
  '.mp4', '.webm', '.mov',
]);

// scene.json is managed through dedicated config tools, not raw file writes,
// so config invariants (fps > 0 etc.) can't be bypassed by writing the file
// directly. film.json and workspace.json get the same protection — they are
// documents with validated schemas, owned by WorkspaceStore.
const WRITE_DENYLIST = new Set(['scene.json', 'film.json', 'workspace.json']);

function reject(relPath, why) {
  throw new EngineError(
    ErrorCodes.PATH_NOT_ALLOWED,
    `Path "${relPath}" is not allowed: ${why}`,
    { path: relPath }
  );
}

/**
 * Resolve a target-relative path to an absolute path, throwing
 * PATH_NOT_ALLOWED on any escape attempt.
 *
 * @param {string} targetRoot absolute path to the scene (or film) folder
 * @param {string} relPath     path as supplied by the caller/agent
 * @param {{forWrite?: boolean}} [opts]
 * @returns {string} absolute, verified path
 */
export function resolveInTarget(targetRoot, relPath, { forWrite = false, asAsset = false } = {}) {
  if (typeof relPath !== 'string' || relPath.length === 0) reject(String(relPath), 'empty path');
  if (relPath.includes('\0')) reject(relPath, 'contains null byte');
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    reject(relPath, 'absolute paths are not accepted; use a path relative to the scene or film folder');
  }

  const root = fs.realpathSync(targetRoot);
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel === '' && forWrite) reject(relPath, 'refers to the target folder itself');
  if (rel.startsWith('..') || path.isAbsolute(rel)) reject(relPath, 'escapes the target folder');

  // Symlink escape: realpath the deepest existing ancestor and re-check.
  let probe = resolved;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== root && path.relative(root, realProbe).startsWith('..')) {
    reject(relPath, 'resolves through a symlink outside the target folder');
  }

  if (forWrite) {
    const base = path.basename(resolved);
    if (WRITE_DENYLIST.has(base)) {
      reject(relPath, `"${base}" is managed by dedicated tools and cannot be written directly`);
    }
    const ext = path.extname(resolved).toLowerCase();
    const allowed = asAsset ? ASSET_EXTENSIONS : WRITABLE_EXTENSIONS;
    if (!allowed.has(ext)) {
      reject(relPath, `extension "${ext || '(none)'}" is not writable; allowed: ${[...allowed].join(' ')}`);
    }
  }

  return resolved;
}
