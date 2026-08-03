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

/** Keep diagnostics bounded — a broken composition can log in a loop. */
const MAX_DIAGNOSTICS = 10;

/**
 * Render page diagnostics into the error MESSAGE (v0.21).
 *
 * These were already collected into `detail`, but the thing that actually
 * reaches a human or an agent first is the message — and a caller whose tool
 * call timed out at the transport may never see `detail` at all. The
 * motivating failure: a <video> whose src does not exist never fires
 * `seeked`, so the frame promise never settles and the render dies on a
 * frame timeout naming nothing. A failed request is not an error event and
 * was invisible; now it is the first thing the message says.
 */
export function formatPageDiagnostics({ pageErrors = [], failedRequests = [] } = {}) {
  const parts = [];
  if (failedRequests.length) {
    const list = failedRequests.slice(0, MAX_DIAGNOSTICS)
      .map((r) => `  ${r.url} (${r.error})`).join('\n');
    const more = failedRequests.length > MAX_DIAGNOSTICS ? `\n  …and ${failedRequests.length - MAX_DIAGNOSTICS} more` : '';
    parts.push(
      `${failedRequests.length} asset${failedRequests.length === 1 ? '' : 's'} failed to load — ` +
      'a missing <video>/<img>/<script> is the usual cause of a frame that never becomes ready:\n' +
      list + more,
    );
  }
  if (pageErrors.length) {
    parts.push('Page errors:\n' + pageErrors.slice(0, MAX_DIAGNOSTICS).map((e) => `  ${e}`).join('\n'));
  }
  return parts.length ? '\n' + parts.join('\n') : '';
}

/**
 * How the browser binary is chosen (Slice 0): explicit argument →
 * MOTION_STUDIO_CHROME → the bundled chrome-headless-shell, which is the only
 * browser a vanilla install downloads (.puppeteerrc.cjs skips full Chrome).
 * A custom binary is a full Chrome/Edge and runs in the new headless mode —
 * current full builds no longer ship the old headless the shell implements.
 * Pure and synchronous so the parallel-render parent can record the same
 * facts in the sidecar without launching anything.
 */
export function describeBrowserResolution({ executablePath = undefined, env = process.env } = {}) {
  const custom = executablePath ?? env.MOTION_STUDIO_CHROME ?? undefined;
  return {
    executablePath: custom ?? null, // null = puppeteer's bundled headless shell
    source: executablePath ? 'argument' : (env.MOTION_STUDIO_CHROME ? 'MOTION_STUDIO_CHROME' : 'bundled'),
    headlessMode: custom ? 'new' : 'shell',
  };
}

/**
 * The build string of the most recently launched browser in THIS process
 * ("HeadlessChrome/131.0.6778.204"). Best-effort sidecar enrichment: the
 * parallel-render parent never launches a browser, so it stays null there
 * and the sidecar records the resolution facts without a build string.
 */
let lastLaunchedBuild = null;
export const lastBrowserBuild = () => lastLaunchedBuild;

export async function createPuppeteerBrowser({
  headless = undefined,
  executablePath = undefined,
  frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
} = {}) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch (e) {
    throw new EngineError(ErrorCodes.BROWSER_LAUNCH_FAILED, `puppeteer is not installed: ${e.message}`);
  }

  const resolution = describeBrowserResolution({ executablePath });
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: headless ?? (resolution.headlessMode === 'shell' ? 'shell' : true),
      executablePath: resolution.executablePath ?? undefined,
      args: [
        '--no-sandbox',                    // required in many locked-down/user-profile installs
        '--disable-dev-shm-usage',
        '--force-color-profile=srgb',      // deterministic color across machines
        '--disable-lcd-text',              // subpixel AA varies per display; grayscale AA is stable
        '--hide-scrollbars',
        '--font-render-hinting=none',
        // Opt-in (v0.7): let a composition fetch its own scene assets over
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
        'If this is a fresh install, run "npm install" in the engine folder so Puppeteer downloads ' +
        'chrome-headless-shell — or point MOTION_STUDIO_CHROME at an installed Chrome/Edge binary.',
    );
  }

  lastLaunchedBuild = await browser.version().catch(() => null);

  return {
    pid: browser.process()?.pid ?? null,
    buildInfo: { ...resolution, build: lastLaunchedBuild },

    async openPage({ url, width, height, transparent = false, contentScale = null }) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });

      // Collect composition console errors/page crashes for diagnostics.
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
      });

      // Assets that never arrived (v0.21). A 404 is not a page error and not a
      // console error, so without this listener a composition referencing a
      // missing file fails with no clue as to which file. Paths are reported
      // relative to the composition so they read like the src that produced
      // them ("assets/host.webm"), not a 200-character file:// URL.
      const baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
      const failedRequests = [];
      const seenFailures = new Set();
      const noteFailure = (reqUrl, error) => {
        const short = reqUrl.startsWith(baseUrl) ? decodeURIComponent(reqUrl.slice(baseUrl.length)) : reqUrl;
        if (seenFailures.has(short)) return;
        seenFailures.add(short);
        failedRequests.push({ url: short, error });
      };
      page.on('requestfailed', (req) => {
        noteFailure(req.url(), req.failure()?.errorText ?? 'request failed');
      });
      page.on('response', (res) => {
        if (res.status() >= 400) noteFailure(res.url(), `HTTP ${res.status()}`);
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
            formatPageDiagnostics({ pageErrors, failedRequests }),
          { pageErrors, failedRequests },
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
            throw new EngineError(
              ErrorCodes.COMPOSITION_ERROR,
              `setFrame(${n}) threw: ${e.message}` + formatPageDiagnostics({ pageErrors, failedRequests }),
              { frame: n, pageErrors, failedRequests },
            );
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
                'Check that frameReady is set true after all async work (fonts/images/video seeks) resolves.' +
                formatPageDiagnostics({ pageErrors, failedRequests }),
              { frame: n, pageErrors, failedRequests },
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
            throw new EngineError(
              ErrorCodes.COMPOSITION_ERROR,
              `Composition error at frame ${n}: ${frameError}` + formatPageDiagnostics({ pageErrors, failedRequests }),
              { frame: n, pageErrors, failedRequests },
            );
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
