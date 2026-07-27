/**
 * Path sandbox: every file-touching MCP tool resolves paths through here.
 *
 * Contract (spec §5.8 / §11): a tool may only read/write inside the target
 * project's own folder. Rejection happens at the tool-handler level via a
 * structured PATH_OUTSIDE_PROJECT error — never left to convention.
 *
 * Enforced properties:
 *   - relative paths only ("../", absolute, or drive-letter paths rejected)
 *   - resolved real path must remain under the project root (symlink-escape
 *     is checked against the deepest existing ancestor, so a symlinked
 *     subfolder pointing outside the project is also rejected)
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
// project's assets/ folder; see ProjectStore.writeAssetFile.
export const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac',
  '.woff', '.woff2', '.ttf', '.otf',
  '.json', '.txt',
  // Video assets (saved films): overlay stingers / lower-thirds — a
  // transparent .webm or .mov laid over the film by the finishing pass.
  '.mp4', '.webm', '.mov',
]);

// project.json is managed through dedicated config tools, not raw file writes,
// so config invariants (fps > 0 etc.) can't be bypassed by writing the file directly.
const WRITE_DENYLIST = new Set(['project.json']);

function reject(relPath, why) {
  throw new EngineError(
    ErrorCodes.PATH_OUTSIDE_PROJECT,
    `Path "${relPath}" is not allowed: ${why}`,
    { path: relPath }
  );
}

/**
 * Resolve a project-relative path to an absolute path, throwing
 * PATH_OUTSIDE_PROJECT on any escape attempt.
 *
 * @param {string} projectRoot absolute path to the project folder
 * @param {string} relPath     path as supplied by the caller/agent
 * @param {{forWrite?: boolean}} [opts]
 * @returns {string} absolute, verified path
 */
export function resolveInProject(projectRoot, relPath, { forWrite = false, asAsset = false } = {}) {
  if (typeof relPath !== 'string' || relPath.length === 0) reject(String(relPath), 'empty path');
  if (relPath.includes('\0')) reject(relPath, 'contains null byte');
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    reject(relPath, 'absolute paths are not accepted; use a project-relative path');
  }

  const root = fs.realpathSync(projectRoot);
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel === '' && forWrite) reject(relPath, 'refers to the project root itself');
  if (rel.startsWith('..') || path.isAbsolute(rel)) reject(relPath, 'escapes the project folder');

  // Symlink escape: realpath the deepest existing ancestor and re-check.
  let probe = resolved;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== root && path.relative(root, realProbe).startsWith('..')) {
    reject(relPath, 'resolves through a symlink outside the project folder');
  }

  if (forWrite) {
    const base = path.basename(resolved);
    if (WRITE_DENYLIST.has(base)) {
      reject(relPath, `"${base}" is managed by project tools and cannot be written directly`);
    }
    const ext = path.extname(resolved).toLowerCase();
    const allowed = asAsset ? ASSET_EXTENSIONS : WRITABLE_EXTENSIONS;
    if (!allowed.has(ext)) {
      reject(relPath, `extension "${ext || '(none)'}" is not writable; allowed: ${[...allowed].join(' ')}`);
    }
  }

  return resolved;
}
