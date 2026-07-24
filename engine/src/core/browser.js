/**
 * Browser layer: drives headless Chromium via Puppeteer for frame capture.
 *
 * The renderer never imports puppeteer directly — it receives a
 * `browserFactory` returning this interface:
 *
 *   {
 *     openPage({ url, width, height }): Promise<FramePage>
 *     close(): Promise<void>
 *     pid: number | null            // Chromium pid, for process-tree cleanup
 *   }
 *   FramePage: {
 *     captureFrame(n): Promise<Buffer>   // PNG bytes for frame n
 *     close(): Promise<void>
 *   }
 *
 * This keeps the fragile Puppeteer lifecycle in one place and lets the test
 * suite exercise the full renderer/encoder pipeline with a fake browser on
 * machines without Chromium.
 */

import { EngineError, ErrorCodes } from './errors.js';

export const DEFAULT_FRAME_TIMEOUT_MS = 15_000;
export const COMPOSITION_READY_TIMEOUT_MS = 30_000;

export async function createPuppeteerBrowser({
  headless = true,
  executablePath = undefined,
  frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
} = {}) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch (e) {
    throw new EngineError(ErrorCodes.BROWSER_LAUNCH_FAILED, `puppeteer is not installed: ${e.message}`);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless,
      executablePath,
      args: [
        '--no-sandbox',                    // required in many locked-down/user-profile installs
        '--disable-dev-shm-usage',
        '--force-color-profile=srgb',      // deterministic color across machines
        '--disable-lcd-text',              // subpixel AA varies per display; grayscale AA is stable
        '--hide-scrollbars',
        '--font-render-hinting=none',
        // Opt-in (v0.7): let a composition fetch its own project assets over
        // file:// — e.g. glTF/GLB models via a loader, or JSON data. Off by
        // default (file:// XHR is CORS-blocked); enable per render with
        // MOTION_STUDIO_ALLOW_LOCAL_FETCH=1. <img>/<audio>/CSS assets never need it.
        ...(process.env.MOTION_STUDIO_ALLOW_LOCAL_FETCH ? ['--allow-file-access-from-files'] : []),
      ],
    });
  } catch (e) {
    throw new EngineError(
      ErrorCodes.BROWSER_LAUNCH_FAILED,
      `Failed to launch Chromium via Puppeteer: ${e.message}. ` +
        `If this is a fresh install, run "npm install" in the engine folder so Puppeteer downloads its browser.`,
    );
  }

  return {
    pid: browser.process()?.pid ?? null,

    async openPage({ url, width, height, transparent = false }) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });

      // Collect composition console errors/page crashes for diagnostics.
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
      });

      await page.goto(url, { waitUntil: 'load', timeout: COMPOSITION_READY_TIMEOUT_MS });

      // The composition must expose window.setFrame (usually via
      // MotionStudio.registerComposition) before capture can begin.
      try {
        await page.waitForFunction('typeof window.setFrame === "function"', {
          timeout: COMPOSITION_READY_TIMEOUT_MS,
        });
      } catch {
        throw new EngineError(
          ErrorCodes.COMPOSITION_ERROR,
          'Composition never defined window.setFrame. Make sure composition.js calls ' +
            'MotionStudio.registerComposition(fn) (or assigns window.setFrame) and that frame-api.js loads first.' +
            (pageErrors.length ? `\nPage errors:\n${pageErrors.join('\n')}` : ''),
        );
      }

      return {
        async captureFrame(n) {
          // Reset readiness, invoke setFrame(n); the call itself may reject
          // if the composition throws synchronously or asynchronously.
          try {
            await page.evaluate((frame) => {
              window.frameReady = false;
              window.__frameError = undefined;
              return window.setFrame(frame);
            }, n);
          } catch (e) {
            throw new EngineError(ErrorCodes.COMPOSITION_ERROR, `setFrame(${n}) threw: ${e.message}`, {
              frame: n,
              pageErrors,
            });
          }

          try {
            await page.waitForFunction('window.frameReady === true || window.__frameError !== undefined', {
              timeout: frameTimeoutMs,
              polling: 16,
            });
          } catch {
            throw new EngineError(
              ErrorCodes.FRAME_TIMEOUT,
              `Frame ${n} never became ready within ${frameTimeoutMs}ms. ` +
                'Check that frameReady is set true after all async work (fonts/images) resolves.',
              { frame: n, pageErrors },
            );
          }

          const frameError = await page.evaluate('window.__frameError');
          if (frameError) {
            throw new EngineError(ErrorCodes.COMPOSITION_ERROR, `Composition error at frame ${n}: ${frameError}`, {
              frame: n,
            });
          }

          return Buffer.from(await page.screenshot({ type: 'png', omitBackground: transparent }));
        },

        async close() {
          await page.close().catch(() => {});
        },
      };
    },

    async close() {
      await browser.close().catch(() => {});
    },
  };
}
