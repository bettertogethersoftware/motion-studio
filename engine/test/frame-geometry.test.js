/**
 * The frame-geometry authoring contract (v0.27, P0-3 Stage B prerequisite).
 *
 * A composition is only variant-capable if it can ask how big its frame is
 * and where the safe rectangles are, and get the SAME answer in every path
 * that opens it: preview, still, proxy draft, full render. Three things are
 * under test here:
 *
 *   1. the numbers — safeAreaVariables() against known geometry, landscape
 *      and portrait, and against a deliverable's own insets;
 *   2. the plumbing — every openPage call site carries them, and the layout
 *      viewport is the AUTHORED size even under a proxy (the bug that made
 *      relative units dishonest before this change);
 *   3. the runtime — MotionStudio.safeArea() reads the variables, and falls
 *      back to the documented defaults when a host does not inject them.
 *
 * Real-Chromium proof that a relative-unit composition survives a proxy lives
 * in real-chromium.test.js, which is where the browser-gated tests are.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { safeAreaVariables, DEFAULT_SAFE_AREAS, normalizeDeliverable } from '../src/core/deliverables.js';
import { compositionVariables, captureFrames, renderStill, renderComposition } from '../src/core/renderer.js';
import { makeConfig } from '../src/core/scene.js';
import { RUNTIME_FRAME_API } from '../src/core/scene.js';
import { makeFakeBrowserFactory } from './helpers/fake-browser.js';

/* ------------------------------------------------------- the numbers ----- */

test('safeAreaVariables: pixels derived from the target, landscape', () => {
  const vars = safeAreaVariables({ width: 1920, height: 1080 });
  assert.equal(vars['--ms-width'], '1920px');
  assert.equal(vars['--ms-height'], '1080px');
  // title: 7% left/right of 1920, 6% top / 50% bottom of 1080
  assert.equal(vars['--ms-safe-title-left'], '134px');
  assert.equal(vars['--ms-safe-title-right'], '134px');
  assert.equal(vars['--ms-safe-title-top'], '65px');
  assert.equal(vars['--ms-safe-title-bottom'], '540px');
  assert.equal(vars['--ms-safe-title-width'], '1652px');   // 1920 − 134 − 134
  assert.equal(vars['--ms-safe-title-height'], '475px');   // 1080 − 65 − 540
  // caption: 8% left/right, 55% top / 8% bottom
  assert.equal(vars['--ms-safe-caption-left'], '154px');
  assert.equal(vars['--ms-safe-caption-height'], '400px'); // 1080 − 594 − 86
});

test('safeAreaVariables: the SAME stylesheet gets portrait numbers at 9:16', () => {
  const vars = safeAreaVariables({ width: 1080, height: 1920 });
  assert.equal(vars['--ms-width'], '1080px');
  assert.equal(vars['--ms-safe-title-left'], '76px');      // 7% of 1080
  assert.equal(vars['--ms-safe-title-width'], '928px');
  assert.equal(vars['--ms-safe-title-top'], '115px');      // 6% of 1920
  // The point of the contract: the safe box is a different SHAPE, which is
  // exactly what a hard-coded 1652px title bar cannot become.
  assert.notEqual(vars['--ms-safe-title-width'], safeAreaVariables({ width: 1920, height: 1080 })['--ms-safe-title-width']);
});

test('safeAreaVariables: a deliverable overrides the defaults it names, only', () => {
  const deliverable = normalizeDeliverable(
    { id: 'shorts-9x16', width: 1080, height: 1920, safeAreas: { title: { leftPct: 10, rightPct: 10, topPct: 6, bottomPct: 50 } } },
    { baseFilename: 'film' },
  );
  const vars = safeAreaVariables({ width: 1080, height: 1920, safeAreas: deliverable.safeAreas });
  assert.equal(vars['--ms-safe-title-left'], '108px');     // 10%, not the default 7%
  assert.equal(vars['--ms-safe-caption-left'], '86px');    // untouched default 8%
});

test('safeAreaVariables: rejects geometry it cannot compute against', () => {
  assert.throws(() => safeAreaVariables({ width: 0, height: 1080 }), /positive integer/);
  assert.throws(() => safeAreaVariables({ width: 1920 }), /positive integer/);
});

test('compositionVariables: scene config in, contract out; config.safeAreas wins', () => {
  const config = makeConfig({ name: 'geo', width: 1920, height: 1080 });
  assert.equal(compositionVariables(config)['--ms-safe-title-left'], '134px');
  assert.equal(
    compositionVariables({ ...config, safeAreas: { ...DEFAULT_SAFE_AREAS, title: { leftPct: 25, rightPct: 25, topPct: 6, bottomPct: 50 } } })['--ms-safe-title-left'],
    '480px',
  );
});

/* ------------------------------------------------------- the plumbing ---- */

/** Record every openPage argument object the renderer builds. */
function spyingFactory(seen, hooks = {}) {
  const inner = makeFakeBrowserFactory(hooks);
  return async () => {
    const browser = await inner();
    const openPage = browser.openPage.bind(browser);
    browser.openPage = async (opts) => { seen.push(opts); return openPage(opts); };
    return browser;
  };
}

async function scene(name, overrides = {}) {
  const scenePath = await fsp.mkdtemp(path.join(os.tmpdir(), `ms-geo-${name}-`));
  return { scenePath, config: makeConfig({ name, width: 1920, height: 1080, durationInFrames: 4, ...overrides }) };
}

test('captureFrames (the preview path) opens the page with the frame geometry', async () => {
  const { scenePath, config } = await scene('preview');
  const seen = [];
  await captureFrames({ scenePath, config, frames: [0, 1], browserFactory: spyingFactory(seen) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cssVariables['--ms-safe-title-left'], '134px');
  assert.equal(seen[0].width, 1920, 'preview lays out at the authored size');
});

test('renderStill opens the page with the same geometry as the render', async () => {
  const { scenePath, config } = await scene('still');
  const seen = [];
  await renderStill({
    scenePath, config, frame: 0,
    outputPath: path.join(scenePath, 'still.png'),
    browserFactory: spyingFactory(seen),
  });
  assert.deepEqual(seen[0].cssVariables, compositionVariables(config));
});

test('a full render carries the geometry and lays out at the authored size', async () => {
  const { scenePath, config } = await scene('full');
  config.output = { ...config.output, format: 'png-sequence', filename: 'frames' };
  const seen = [];
  await renderComposition({
    scenePath, config, outputPath: path.join(scenePath, 'out', 'frames'),
    browserFactory: spyingFactory(seen),
  });
  assert.equal(seen[0].width, 1920);
  assert.equal(seen[0].height, 1080);
  assert.equal(seen[0].capture.width, 1920, 'no proxy: capture IS the frame');
  assert.equal(seen[0].cssVariables['--ms-height'], '1080px');
});

test('a proxy render shrinks the CAPTURE, never the layout viewport', async () => {
  const { scenePath, config } = await scene('proxy');
  config.output = { ...config.output, format: 'png-sequence', filename: 'frames' };
  const seen = [];
  await renderComposition({
    scenePath, config, outputPath: path.join(scenePath, 'out', 'frames'),
    proxy: { scale: 0.25, frameStep: 1 },
    browserFactory: spyingFactory(seen),
  });
  // The regression this guards: with a shrunken viewport, 100vw would have
  // been 480px and then scaled again — a relative-unit composition would
  // render differently in the draft than in the deliverable.
  assert.equal(seen[0].width, 1920);
  assert.equal(seen[0].height, 1080);
  assert.deepEqual(seen[0].capture, { width: 480, height: 270 });
  assert.equal(seen[0].cssVariables['--ms-width'], '1920px', 'the frame is still 1920 wide, whatever the raster is');
});

/* -------------------------------------------------------- the runtime ---- */

/**
 * Load the real runtime into a VM with a minimal DOM double: the contract is
 * "read these custom properties", so a getPropertyValue stub is the whole
 * environment the geometry helpers need.
 */
async function loadRuntime({ vars = {}, innerWidth = 1920, innerHeight = 1080 } = {}) {
  const source = await fsp.readFile(RUNTIME_FRAME_API, 'utf8');
  const documentElement = { style: { setProperty() {} } };
  const sandbox = {
    window: { innerWidth, innerHeight },
    document: { documentElement },
    getComputedStyle: () => ({ getPropertyValue: (name) => vars[name] ?? '' }),
    console,
  };
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.MotionStudio ?? sandbox.MotionStudio;
}

test('MotionStudio.frameSize/safeArea read the injected variables', async () => {
  const api = await loadRuntime({ vars: safeAreaVariables({ width: 1080, height: 1920 }) });
  assert.equal(api.version, 1.6);
  // Spread first: objects built inside the VM realm are never reference-equal
  // to host literals, however identical their contents.
  assert.deepEqual({ ...api.frameSize() }, { width: 1080, height: 1920 });
  const title = api.safeArea('title');
  assert.equal(title.left, 76);
  assert.equal(title.width, 928);
  const caption = api.safeArea('caption');
  assert.equal(caption.top, 1056);            // 55% of 1920
  assert.equal(caption.height, 710);          // 1920 − 1056 − 154
  assert.deepEqual({ ...api.safeArea('nonsense') }, { ...title }, 'an unknown kind falls back to title, never to the frame edge');
});

test('MotionStudio.safeArea: a host that injects nothing still gets the documented defaults', async () => {
  const api = await loadRuntime({ vars: {} });
  // Falls back to window geometry and the same percentages the engine uses,
  // so a composition opened directly in a browser is not laid out edge-to-edge.
  assert.deepEqual({ ...api.frameSize() }, { width: 1920, height: 1080 });
  const title = api.safeArea('title');
  assert.equal(title.left, 1920 * 0.07);
  assert.equal(title.top, 1080 * 0.06);
  const engine = safeAreaVariables({ width: 1920, height: 1080 });
  assert.equal(`${Math.round(title.left)}px`, engine['--ms-safe-title-left'], 'the fallback must agree with the engine');
});
