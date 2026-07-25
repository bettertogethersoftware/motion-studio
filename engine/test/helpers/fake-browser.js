/**
 * Test doubles: a dependency-free PNG encoder and a fake browser factory that
 * satisfies the browser interface (core/browser.js). This lets the test suite
 * run the FULL renderer → FFmpeg pipeline (real ffmpeg, real MP4 output) on
 * machines without Chromium.
 */

import zlib from 'node:zlib';

/**
 * Minimal valid PNG encoder (no filtering beyond type 0). pixelFn returns
 * [r,g,b] for truecolor or [r,g,b,a] for truecolor+alpha (pass alpha=true).
 */
export function encodePng(width, height, pixelFn, { alpha = false } = {}) {
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc(height * (1 + width * bpp));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = pixelFn(x, y);
      raw[o++] = px[0]; raw[o++] = px[1]; raw[o++] = px[2];
      if (alpha) raw[o++] = px[3] ?? 255;
    }
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;              // bit depth
  ihdr[9] = alpha ? 6 : 2;  // color type: truecolor(+alpha)
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Fake browser factory. Renders each frame as a moving gradient so encoded
 * output is visually verifiable and non-trivially compressible.
 *
 * @param {object} [hooks]
 * @param {(frame:number)=>void} [hooks.onCapture]
 * @param {number} [hooks.failAtFrame]     throw a composition error at this frame
 * @param {number} [hooks.captureDelayMs]  simulate slow frames (cancellation tests)
 * @param {number[]} [hooks.crashOnceAtFrames]  throw a crash-shaped raw error
 *   ("Protocol error … Target closed") the FIRST time each listed frame is
 *   captured — retries of the same frame then succeed, mimicking the transient
 *   Chromium flake the capture-recovery path (v0.14) exists for. The pending
 *   set lives OUTSIDE the factory on purpose: recovery relaunches the browser
 *   through the same factory, and the crash must not repeat after relaunch.
 * @param {()=>void} [hooks.onLaunch]      called per factory invocation (count relaunches)
 */
export function makeFakeBrowserFactory(hooks = {}) {
  const pendingCrashes = new Set(hooks.crashOnceAtFrames ?? []);
  return async function fakeBrowserFactory() {
    hooks.onLaunch?.();
    return {
      pid: null,
      async openPage({ width, height, transparent = false }) {
        return {
          async captureFrame(n) {
            if (hooks.captureDelayMs) await new Promise((r) => setTimeout(r, hooks.captureDelayMs));
            if (pendingCrashes.has(n)) {
              pendingCrashes.delete(n);
              throw new Error('Protocol error (Page.captureScreenshot): Target closed');
            }
            if (hooks.failAtFrame === n) {
              const { EngineError, ErrorCodes } = await import('../../src/core/errors.js');
              throw new EngineError(ErrorCodes.COMPOSITION_ERROR, `synthetic failure at frame ${n}`);
            }
            hooks.onCapture?.(n);
            // Transparent pages produce RGBA frames with a varying alpha
            // gradient, mirroring Puppeteer's omitBackground screenshots.
            return encodePng(
              width, height,
              (x, y) => [(x + n * 4) % 256, (y + n * 2) % 256, (x + y + n) % 256, transparent ? (x * 255 / width) | 0 : 255],
              { alpha: transparent },
            );
          },
          async close() {},
        };
      },
      async close() {},
    };
  };
}
