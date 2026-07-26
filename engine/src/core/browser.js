/**
 * Browser layer: drives headless Chromium via Puppeteer for frame capture.
 *
 * The renderer never imports puppeteer directly — it receives a
 * `browserFactory` returning this interface:
 *
 *   {
 *     openPage({ url, width, height, transparent?, contentScale? }): Promise<FramePage>
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

/**
 * Crash-shaped Chromium failures (v0.14). Headless Chromium dies intermittently
 * mid-capture on long runs; when it does, the CDP connection drops and every
 * in-flight Puppeteer call rejects with one of these message shapes — that
 * string is the only signal we get. Without classification these leaked out as
 * composition_error (evaluate), frame_timeout (waitForFunction), or
 * internal_error (screenshot), all of which read as "your composition is
 * broken" when the truth is "the browser fell over; retry".
 */
const CRASH_PATTERNS =
  /target closed|target crashed|session closed|connection closed|browser has disconnected|navigating frame was detached|protocol error/i;

/** True for errors that mean "Chromium died", regardless of where they surfaced. */
export function isBrowserCrash(err) {
  if (!err) return false;
  if (err.code === ErrorCodes.BROWSER_CRASHED) return true;
  return CRASH_PATTERNS.test(String(err?.message ?? err));
}

function asCrash(err, frame) {
  return new EngineError(
    ErrorCodes.BROWSER_CRASHED,
    `Chromium crashed while capturing frame ${frame}: ${err.message}`,
    { frame },
  );
}

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

    async openPage({ url, width, height, transparent = false, contentScale = null }) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });

      // Collect composition console errors/page crashes for diagnostics.
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
      });

      await page.goto(url, { waitUntil: 'load', timeout: COMPOSITION_READY_TIMEOUT_MS });

      // Proxy renders (v0.21): the viewport above is the SMALL proxy size —
      // shrinking the screenshot is the whole saving — while the composition
      // is authored at fixed pixel dimensions (the frame contract: a pure
      // function of frame that never reads window size). This visual-only
      // transform maps the fixed-px content onto the small viewport. It goes
      // on documentElement, not body: it is the one element compositions
      // never style themselves (their world starts at body/their root), so
      // an inline transform here cannot collide with author CSS, and scaling
      // at the outermost box scales body and everything in it uniformly.
      // Per-axis factors because even-floored proxy dims round each axis
      // independently. The non-proxy path passes no contentScale and is
      // untouched.
      if (contentScale) {
        await page.evaluate(({ x, y }) => {
          document.documentElement.style.transformOrigin = '0 0';
          document.documentElement.style.transform = `scale(${x}, ${y})`;
        }, contentScale);
      }

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
            if (isBrowserCrash(e)) throw asCrash(e, n);
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
          } catch (e) {
            if (isBrowserCrash(e)) throw asCrash(e, n);
            throw new EngineError(
              ErrorCodes.FRAME_TIMEOUT,
              `Frame ${n} never became ready within ${frameTimeoutMs}ms. ` +
                'Check that frameReady is set true after all async work (fonts/images) resolves.',
              { frame: n, pageErrors },
            );
          }

          let frameError;
          try {
            frameError = await page.evaluate('window.__frameError');
          } catch (e) {
            if (isBrowserCrash(e)) throw asCrash(e, n);
            throw e;
          }
          if (frameError) {
            throw new EngineError(ErrorCodes.COMPOSITION_ERROR, `Composition error at frame ${n}: ${frameError}`, {
              frame: n,
            });
          }

          try {
            return Buffer.from(await page.screenshot({ type: 'png', omitBackground: transparent }));
          } catch (e) {
            if (isBrowserCrash(e)) throw asCrash(e, n);
            throw e;
          }
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
