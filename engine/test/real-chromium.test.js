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
import { makeConfig, validateConfig } from '../src/core/project.js';

const execFileP = promisify(execFile);

let tmp, haveBrowser = false, haveFfmpeg = true;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-real-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    haveBrowser = true;
  } else {
    try {
      const puppeteer = (await import('puppeteer')).default;
      // executablePath() returns a path even when nothing is installed there.
      const p = puppeteer.executablePath();
      haveBrowser = !!p && (await fsp.access(p).then(() => true, () => false));
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
  const f0 = await captureSingleFrame({ projectPath: dir, config, frame: 0 });
  const f9 = await captureSingleFrame({ projectPath: dir, config, frame: 9 });
  assert.equal(f0.slice(0, 4).toString('hex'), '89504e47', 'valid PNG magic');
  assert.notDeepEqual(f0, f9, 'different frames yield different pixels');
  // Determinism: same frame twice is byte-identical.
  const f0again = await captureSingleFrame({ projectPath: dir, config, frame: 0 });
  assert.ok(f0.equals(f0again), 'same frame is byte-identical across captures');
});

test('real chromium: serial mp4 render end-to-end', async (t) => {
  if (!haveBrowser || !haveFfmpeg) return t.skip('needs Chromium + ffmpeg');
  const dir = path.join(tmp, 'render');
  const config = await writeProject(dir);
  const out = path.join(dir, 'out', 'output.mp4');
  const res = await renderComposition({ projectPath: dir, config, outputPath: out });
  assert.equal(res.frames, 10);
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out]);
  const s = JSON.parse(stdout).streams[0];
  assert.equal(s.codec_name, 'h264');
  assert.equal(Number(s.nb_frames), 10);
});

test('real chromium: omitBackground produces genuine alpha in transparent captures', async (t) => {
  if (!haveBrowser) return t.skip('no Chromium available');
  const dir = path.join(tmp, 'alpha');
  const config = await writeProject(dir, { transparent: true });
  const png = await captureSingleFrame({ projectPath: dir, config, frame: 5 });
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
