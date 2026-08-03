/**
 * Vanilla-footprint config (vendor-boundary plan, Phase 0.5 / Slice 0).
 *
 * core/browser.js only ever runs headless, so a vanilla install downloads
 * ONLY chrome-headless-shell (~130 MB unpacked) instead of both it and full
 * Chrome (~700 MB together). A machine that wants to render through a
 * specific full browser sets MOTION_STUDIO_CHROME (see core/browser.js) —
 * nothing extra is downloaded for it.
 *
 * PUPPETEER_SKIP_DOWNLOAD=1 still skips everything (CI's suite jobs use it;
 * the suite fakes the browser).
 */
module.exports = {
  chrome: { skipDownload: true },
  'chrome-headless-shell': { skipDownload: false },
};
