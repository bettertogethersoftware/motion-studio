/**
 * Real-Chromium end-to-end test — the one seam the fake browser cannot cover
 * (Puppeteer launch, page lifecycle, screenshot, omitBackground alpha).
 *
 * Gated: runs only when a Chromium binary is resolvable, i.e.
 * PUPPETEER_EXECUTABLE_PATH is set or Puppeteer has a downloaded browser.
 * Everywhere else it skips (CI without a browser stays green and honest).
 *
 *   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node --test test/real-chromium.test.js
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { renderComposition, captureSingleFrame } from '../src/core/renderer.js';
import { makeConfig, validateConfig } from '../src/core/scene.js';

const execFileP = promisify(execFile);

let tmp, haveBrowser = false, haveFfmpeg = true;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-real-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.MOTION_STUDIO_CHROME) {
    haveBrowser = true;
  } else {
    try {
      const puppeteer = (await import('puppeteer')).default;
      // executablePath() returns a path even when nothing is installed there.
      // Vanilla installs only download chrome-headless-shell (Slice 0 —
      // .puppeteerrc.cjs), so check it first; a pre-Slice-0 cache still has
      // full Chrome, so accept that too.
      const exists = (p) => !!p && fsp.access(p).then(() => true, () => false);
      const shell = await exists((() => { try { return puppeteer.executablePath({ headless: 'shell' }); } catch { return null; } })());
      const chrome = await exists((() => { try { return puppeteer.executablePath(); } catch { return null; } })());
      haveBrowser = shell || chrome;
    } catch { haveBrowser = false; }
  }
});

async function writeProject(dir, { transparent = false } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(
    path.resolve('src/runtime/frame-api.js'),
    path.join(dir, 'frame-api.js'),
  );
  await fsp.writeFile(path.join(dir, 'composition.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:160px;height:120px;${transparent ? 'background:transparent;' : 'background:#102040;'}overflow:hidden}
  #box{position:absolute;top:40px;width:40px;height:40px;background:#ffb454}
</style></head><body>
<div id="box"></div>
<script src="frame-api.js"></script>
<script>
  MotionStudio.registerComposition((frame) => {
    document.getElementById('box').style.left = frame * 4 + 'px';
  });
</script>
</body></html>`);
  const config = validateConfig({
    ...makeConfig({ name: 'Real', fps: 30, width: 160, height: 120, durationInFrames: 10 }),
  });
  if (transparent) config.output = { ...config.output, format: 'webm', transparent: true, filename: 'output.webm' };
  return config;
}

test('real chromium: captureSingleFrame returns frame-dependent pixels', async (t) => {
  if (!haveBrowser) return t.skip('no Chromium available (set PUPPETEER_EXECUTABLE_PATH)');
  const dir = path.join(tmp, 'opaque');
  const config = await writeProject(dir);
  const f0 = await captureSingleFrame({ scenePath: dir, config, frame: 0 });
  const f9 = await captureSingleFrame({ scenePath: dir, config, frame: 9 });
  assert.equal(f0.slice(0, 4).toString('hex'), '89504e47', 'valid PNG magic');
  assert.notDeepEqual(f0, f9, 'different frames yield different pixels');
  // Determinism: same frame twice is byte-identical.
  const f0again = await captureSingleFrame({ scenePath: dir, config, frame: 0 });
  assert.ok(f0.equals(f0again), 'same frame is byte-identical across captures');
});

test('real chromium: serial mp4 render end-to-end', async (t) => {
  if (!haveBrowser || !haveFfmpeg) return t.skip('needs Chromium + ffmpeg');
  const dir = path.join(tmp, 'render');
  const config = await writeProject(dir);
  const out = path.join(dir, 'out', 'output.mp4');
  const res = await renderComposition({ scenePath: dir, config, outputPath: out });
  assert.equal(res.frames, 10);
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out]);
  const s = JSON.parse(stdout).streams[0];
  assert.equal(s.codec_name, 'h264');
  assert.equal(Number(s.nb_frames), 10);
});

/**
 * The authoring contract, proven where it can actually break (v0.27).
 *
 * A composition sized in vw/% and positioned from `--ms-safe-title-left` must
 * land in the same PROPORTIONAL place in a full render and in a quarter-scale
 * proxy draft. Before the viewport change, the proxy laid out against the
 * draft width, so 50vw was half of 40px and then scaled again — the draft and
 * the deliverable disagreed about the frame.
 */
async function writeRelativeProject(dir) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(path.resolve('src/runtime/frame-api.js'), path.join(dir, 'frame-api.js'));
  await fsp.writeFile(path.join(dir, 'composition.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}
  /* Every number here is relative: half the frame wide, a fifth tall, its left
     edge on the title safe line the engine states. */
  #bar{position:absolute;top:0;height:20vh;width:50vw;left:var(--ms-safe-title-left,0px);background:#ffffff}
</style></head><body>
<div id="bar"></div>
<script src="frame-api.js"></script>
<script>
  MotionStudio.registerComposition(() => {
    // Publish what the runtime measured so the test can assert on the numbers
    // the COMPOSITION saw, not only on pixels.
    const safe = MotionStudio.safeArea('title');
    window.__geometry = { frame: MotionStudio.frameSize(), safeLeft: safe.left, barWidth: document.getElementById('bar').getBoundingClientRect().width };
  });
</script>
</body></html>`);
  return validateConfig(makeConfig({ name: 'Relative', fps: 30, width: 800, height: 600, durationInFrames: 4 }));
}

/** Decode a PNG to RGBA rows with ffmpeg (no image dependency in this repo). */
async function decodeRgba(png, file) {
  await fsp.writeFile(file, png);
  const { stdout } = await execFileP(
    'ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

test('real chromium: a relative-unit composition lands identically in a proxy draft', async (t) => {
  if (!haveBrowser || !haveFfmpeg) return t.skip('needs Chromium + ffmpeg');
  const dir = path.join(tmp, 'relative');
  const config = await writeRelativeProject(dir);

  // Full size: the white bar starts at the title safe line (7% of 800 = 56px)
  // and is 400px wide (50vw), i.e. columns 56..455 of 800.
  const full = await decodeRgba(
    await captureSingleFrame({ scenePath: dir, config, frame: 0 }),
    path.join(tmp, 'relative-full.png'),
  );
  const whiteRun = (rgba, width, row) => {
    let first = -1, last = -1;
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 4;
      if (rgba[i] > 200 && rgba[i + 1] > 200 && rgba[i + 2] > 200) { if (first < 0) first = x; last = x; }
    }
    return { first, last };
  };
  const fullRun = whiteRun(full, 800, 10);
  assert.equal(fullRun.first, 56, 'left edge sits on --ms-safe-title-left (7% of 800)');
  assert.equal(fullRun.last, 455, 'the bar is 50vw = 400px wide');

  // Quarter-scale proxy: a 200×150 raster of the SAME layout. The bar must be
  // at the same FRACTIONS of the frame — 56/800 and 456/800.
  const outDir = path.join(dir, 'out');
  const res = await renderComposition({
    scenePath: dir,
    // A PNG sequence so the assertion is on the captured raster itself, with
    // no encoder colour conversion between the browser and the pixels.
    config: { ...config, output: { ...config.output, format: 'png-sequence', filename: 'frames' } },
    outputPath: path.join(outDir, 'frames'),
    proxy: { scale: 0.25, frameStep: 1 },
  });
  const frames = (await fsp.readdir(res.outputPath)).sort();
  const proxyPng = await fsp.readFile(path.join(res.outputPath, frames[0]));
  const proxy = await decodeRgba(proxyPng, path.join(tmp, 'relative-proxy.png'));
  const proxyRun = whiteRun(proxy, 200, 2);
  // ±1 px of tolerance: the transform lands the edge on a fractional pixel.
  assert.ok(Math.abs(proxyRun.first - 14) <= 1, `proxy left edge ${proxyRun.first}, expected ~14 (56 × 0.25)`);
  assert.ok(Math.abs(proxyRun.last - 113) <= 1, `proxy right edge ${proxyRun.last}, expected ~113 (455 × 0.25)`);
});

test('real chromium: the composition itself reads the frame geometry, proxy or not', async (t) => {
  if (!haveBrowser) return t.skip('no Chromium available');
  const dir = path.join(tmp, 'geometry-readback');
  const config = await writeRelativeProject(dir);
  const seen = [];
  // captureSingleFrame drives the same openPage path the render uses; the
  // composition publishes what IT measured on window.__geometry.
  const { createPuppeteerBrowser } = await import('../src/core/browser.js');
  const factory = async (opts) => {
    const browser = await createPuppeteerBrowser(opts);
    const openPage = browser.openPage.bind(browser);
    browser.openPage = async (args) => { seen.push(args); return openPage(args); };
    return browser;
  };
  await captureSingleFrame({ scenePath: dir, config, frame: 0, browserFactory: factory });
  assert.equal(seen[0].cssVariables['--ms-width'], '800px');
  assert.equal(seen[0].cssVariables['--ms-safe-title-left'], '56px');
});

test('real chromium: omitBackground produces genuine alpha in transparent captures', async (t) => {
  if (!haveBrowser) return t.skip('no Chromium available');
  const dir = path.join(tmp, 'alpha');
  const config = await writeProject(dir, { transparent: true });
  const png = await captureSingleFrame({ scenePath: dir, config, frame: 5 });
  // Decode with ffmpeg to raw RGBA and check the alpha plane has both
  // transparent background pixels and the opaque box.
  const probe = path.join(tmp, 'alpha-frame.png');
  await fsp.writeFile(probe, png);
  const { stdout } = await execFileP(
    'ffmpeg',
    ['-v', 'error', '-i', probe, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  let alpha0 = 0, alpha255 = 0;
  for (let i = 3; i < stdout.length; i += 4) {
    if (stdout[i] === 0) alpha0++;
    else if (stdout[i] === 255) alpha255++;
  }
  assert.ok(alpha0 > 1000, `expected transparent background pixels, got ${alpha0}`);
  assert.ok(alpha255 > 500, `expected opaque box pixels, got ${alpha255}`);
});
