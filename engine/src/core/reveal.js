/**
 * Open a directory in the operating system's file manager (v0.27).
 *
 * The platform switch is the easy half. The half worth being careful about is
 * **whose machine the window opens on**: the Studio is a web server, so this
 * runs on the SERVER, and that is only what the human wants when the server and
 * the browser are the same box. Three shipped shapes where they are not —
 * `MOTION_STUDIO_STUDIO_HOST` viewing from another machine, the container in
 * docker-support-plan.md, and the server-hosted tier — and in every one of them
 * a file manager on the server is useless at best. In a container it is worse
 * than useless: `/data/workspaces/...` is not a path the host would recognise,
 * so even a working opener would reveal the wrong place.
 *
 * So the request must come from loopback, and that gate is doing two jobs at
 * once:
 *
 * 1. **Usefulness** — loopback is exactly "the file manager I open is the one
 *    you are looking at".
 * 2. **Safety**, which is the more important one. The Studio has no
 *    authentication of its own (see studio/server.js's bind comment), and an
 *    unauthenticated endpoint that SPAWNS A PROCESS with a path argument is a
 *    different risk class from one that serves files. The caller therefore
 *    names a *target* and the server resolves the directory itself; a path from
 *    the client is never opened.
 *
 * Deliberately NOT a Docker check. `/.dockerenv` sniffing tests the wrong axis:
 * the question is "can I open a window this human will see", which is equally
 * false on headless Linux, over SSH, and in a bare WSL shell. Ask the real
 * question, and let the failure be honest.
 */

import { spawn } from 'node:child_process';

/**
 * Is this remote address the same machine? Node reports IPv4-mapped IPv6 for a
 * v4 client on a dual-stack socket, so `::ffff:127.0.0.1` is loopback too.
 *
 * A missing address is NOT treated as local: it means the socket is gone or the
 * transport is one this check does not understand, and the safe answer to
 * "should I launch a process" under uncertainty is no.
 */
export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || !addr) return false;
  const a = addr.trim().toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || a === '127.0.0.1' || /^127\./.test(a);
}

/**
 * The file-manager command for a platform, or null where there is none.
 *
 * Windows note that costs an hour if you meet it fresh: **`explorer.exe` exits
 * 1 on success.** Its exit code cannot be the success test, which is why
 * `revealDirectory` does not wait on one anywhere.
 */
export function revealCommand(platform = process.platform) {
  switch (platform) {
    case 'win32': return { exe: 'explorer.exe', args: (dir) => [dir] };
    case 'darwin': return { exe: 'open', args: (dir) => [dir] };
    case 'linux': return { exe: 'xdg-open', args: (dir) => [dir] };
    default: return null;
  }
}

/**
 * Can this process show a window at all? On Linux a desktop session is not
 * implied by the platform — a headless server, a container, an SSH session and
 * WSL without an X server all run `xdg-open` and reveal nothing to anybody.
 */
export function hasDisplay(platform = process.platform, env = process.env) {
  if (platform !== 'linux') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Decide, without doing anything. Separated from the spawn so the whole policy
 * is a pure function over (address, platform, env) and can be tested without a
 * file manager, a socket, or a desktop.
 *
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
export function canReveal({ remoteAddress, platform = process.platform, env = process.env } = {}) {
  if (!isLoopbackAddress(remoteAddress)) {
    return {
      ok: false,
      reason: 'remote',
      message: 'This Studio is being viewed from another machine, so opening a file manager would open it '
        + 'on the server rather than here. Copy the path instead — or download the file you want.',
    };
  }
  if (!revealCommand(platform)) {
    return { ok: false, reason: 'unsupported', message: `No file manager is known for platform "${platform}". Copy the path instead.` };
  }
  if (!hasDisplay(platform, env)) {
    return {
      ok: false,
      reason: 'no_display',
      message: 'There is no desktop session on the machine running the Studio (no DISPLAY), so there is no '
        + 'file manager to open — this is the usual answer in a container or over SSH. Copy the path instead.',
    };
  }
  return { ok: true };
}

/**
 * Open `dir` in the file manager. The caller has already decided the directory
 * — this never resolves one from user input.
 *
 * Detached and unref'd: a file-manager window outlives the request that asked
 * for it, and the Studio must not hold a handle to the human's Explorer. stdio
 * is ignored for the same reason.
 *
 * @returns {{revealed: boolean, reason?: string, message?: string}}
 */
export function revealDirectory(dir, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  const cmd = revealCommand(platform);
  if (!cmd) return { revealed: false, reason: 'unsupported', message: `No file manager is known for platform "${platform}".` };
  try {
    const child = spawnFn(cmd.exe, cmd.args(dir), { detached: true, stdio: 'ignore', env });
    child.unref?.();
    // No exit code is consulted, on purpose: explorer.exe reports 1 on success,
    // and every opener here returns as soon as it has handed off to the desktop
    // — so "did it spawn" is the only honest thing to report synchronously.
    return { revealed: true };
  } catch (err) {
    return { revealed: false, reason: 'failed', message: `Could not start ${cmd.exe}: ${err.message}` };
  }
}
