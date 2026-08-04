/**
 * Motion Studio desktop viewer host (vendor-boundary plan §10.2, Slice C).
 *
 * Modeled on ComfyUI's standalone desktop app: this Electron shell does NOT
 * reimplement anything — it launches the local Studio server as a child of a
 * REAL Node runtime, waits until it answers HTTP, and shows the Studio web
 * UI in a window for the human adviser (progress, film pages, advice). The
 * AI connects over MCP exactly as it would without the shell; the shell
 * owns only lifecycle: launch, readiness, diagnostics, and cleanup.
 *
 * Why a real Node and not Electron's own process: renderParallel spawns
 * worker processes from the Studio server's process.execPath. Spawning the
 * server from Electron would make every render worker an Electron app; a
 * real Node child makes process.execPath a real Node for free (the plan's
 * Phase 5 hard rule).
 *
 * Diagnostics go to a log file under the Electron user-data dir plus the
 * shell's own stderr — never to the child's protocol streams. The child is
 * killed as a TREE on exit (taskkill /T on Windows, process-group signal
 * elsewhere) so no Chromium/FFmpeg/render-worker descendant survives the
 * window closing.
 *
 * Smoke mode (MOTION_STUDIO_DESKTOP_SMOKE=1): quit with code 0 as soon as
 * the window has genuinely loaded the served Studio page, code 1 on any
 * failure — CI-runnable wherever Electron can open a (virtual) display.
 */

const { app, BrowserWindow, dialog } = require('electron');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SMOKE = process.env.MOTION_STUDIO_DESKTOP_SMOKE === '1';
const REPO_ROOT = path.resolve(__dirname, '..');
const STUDIO_SERVER = path.join(REPO_ROOT, 'engine', 'src', 'studio', 'server.js');

let child = null;
let quitting = false;
let logStream = null;

const log = (line) => {
  const stamped = `[desktop ${new Date().toISOString()}] ${line}\n`;
  process.stderr.write(stamped);
  logStream?.write(stamped);
};

const fail = (message) => {
  log(`FATAL: ${message}`);
  if (!SMOKE) dialog.showErrorBox('Motion Studio', message);
  quitting = true;
  killChildTree();
  app.exit(1);
};

/** A real Node runtime — never Electron's process (see header). */
function resolveNode() {
  const candidates = [process.env.MOTION_STUDIO_NODE, 'node'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
    if (probe.status === 0 && /^v\d+/.test(probe.stdout.trim())) return candidate;
  }
  return null;
}

/** The Studio has no PORT=0 mode, so probe a free port and pass it in. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killChildTree() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // TerminateProcess doesn't reach grandchildren; taskkill /T does.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (quitting || !child || child.exitCode !== null) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function start() {
  const logPath = path.join(app.getPath('userData'), 'studio.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  log(`log file: ${logPath}`);

  const node = resolveNode();
  if (!node) {
    return fail('No Node.js runtime found. Install Node ≥ 18 (or set MOTION_STUDIO_NODE to a node executable) — '
      + 'the Studio and its render workers run on real Node, never on Electron.');
  }
  if (!fs.existsSync(STUDIO_SERVER)) {
    return fail(`Studio server not found at ${STUDIO_SERVER} — run this from a Motion Studio checkout.`);
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  log(`starting Studio: ${node} ${STUDIO_SERVER} (port ${port})`);
  child = spawn(node, [STUDIO_SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // its own process group, so the tree kill reaches descendants
    shell: false,
  });
  child.stdout.on('data', (d) => logStream?.write(d));
  child.stderr.on('data', (d) => logStream?.write(d));
  child.on('exit', (code, signal) => {
    log(`Studio exited (code ${code}, signal ${signal})`);
    if (!quitting) fail(`The Studio server exited unexpectedly (code ${code}). See the log: ${logPath}`);
  });

  if (!(await waitForHttp(url))) {
    return fail(`The Studio did not answer at ${url} within 30 s. See the log: ${logPath}`);
  }
  log(`Studio ready at ${url}`);

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'Motion Studio',
    show: !SMOKE,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu?.();
  await win.loadURL(url);
  log('Studio UI loaded in the viewer window');

  if (SMOKE) {
    // Genuine load proof: the window rendered the page the child served.
    const title = await win.webContents.executeJavaScript('document.title').catch(() => '');
    log(`smoke: page title "${title}"`);
    console.log(JSON.stringify({ ok: true, url, title, logPath }));
    quitting = true;
    killChildTree();
    // Give taskkill a beat before the shell disappears with it.
    setTimeout(() => app.exit(0), 500);
  }
}

app.whenReady().then(() => start().catch((e) => fail(e.stack ?? String(e))));

app.on('window-all-closed', () => {
  quitting = true;
  killChildTree();
  app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  killChildTree();
});
