/*!
 * Motion Studio Frame API runtime — v1.4
 *
 * Loaded as a classic <script> before composition code. Provides the four
 * primitives of the frame-driven contract (docs/frame-api.md):
 *
 *   MotionStudio.interpolate(frame, inputRange, outputRange, options?)
 *   MotionStudio.Sequence(from, durationInFrames, fn)
 *   MotionStudio.registerComposition(setFrameFn)   // installs window.setFrame + readiness handshake
 *   MotionStudio.random(seed)                      // deterministic PRNG, frame-safe
 *   MotionStudio.easings                           // named easing functions
 *
 * v1.1 additions (all pure functions of frame — see docs/frame-api.md):
 *   MotionStudio.spring(frame, options?)           // physical spring 0→1, closed form
 *   MotionStudio.interpolateColors(frame, inputRange, colors)
 *   MotionStudio.Loop(durationInFrames, fn)        // repeat a sub-animation
 *
 * v1.2: argument errors now name the offending values. A bad interpolate()
 * range often throws only at the frame that first reaches the call, so the
 * message has to carry enough context to identify the call site on its own.
 *
 * v1.3: MotionStudio.particles(frame, options?) — deterministic looping
 * particle emitter. Real particle systems (THREE.Points animations, Babylon
 * ParticleSystem, requestAnimationFrame loops) are wall-clock based and banned
 * by the frame contract, so every composition was hand-rolling the same
 * seeded loop; this is that loop, done once.
 *
 * v1.4: MotionStudio.seekVideo(video, seconds, {fps}) + videoReady(video) —
 * the deterministic way to use FOOTAGE. A <video> cannot be played (that
 * would make the picture a function of wall-clock time), so compositions
 * seek per frame; every one of them was hand-rolling the same guards, and
 * the one that matters most — never awaiting `seeked` on an element that
 * failed to load — hangs the whole render when omitted.
 *
 * Also exported as bare globals (interpolate, Sequence, ...) for terse
 * composition code. Runs in both the render Chromium (Puppeteer) and the
 * WebView2 human preview — it has no environment-specific dependencies.
 *
 * Design notes:
 *  - No wall-clock reads anywhere. Determinism is the entire point.
 *  - registerComposition wraps the user's setFrame so `window.frameReady`
 *    handling is automatic and correct-by-default for async work: the flag is
 *    reset to false before the user function runs, and set to true only after
 *    the (possibly async) function resolves. Compositions can still manage
 *    frameReady manually by assigning window.setFrame directly, but the
 *    wrapper removes the most common mistake (frame-api.md §4).
 */
(function (global) {
  'use strict';

  /* ------------------------------ easings ------------------------------ */

  const easings = {
    linear: (t) => t,
    easeIn: (t) => t * t * t,
    easeOut: (t) => 1 - Math.pow(1 - t, 3),
    easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    easeInQuad: (t) => t * t,
    easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
    // Slight overshoot past 1 then settle — good for pop-in effects.
    easeOutBack: (t) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    // Springy settle. Deterministic (pure function of t).
    easeOutElastic: (t) => {
      if (t === 0 || t === 1) return t;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
  };

  /* ---------------------------- interpolate ---------------------------- */

  /**
   * Map `frame` through piecewise-linear segments defined by inputRange →
   * outputRange, with optional easing applied per segment.
   *
   * @param {number} frame
   * @param {number[]} inputRange   strictly monotonically increasing, length >= 2
   * @param {number[]} outputRange  same length as inputRange
   * @param {{easing?: string|function, extrapolate?: 'clamp'|'extend'}} [options]
   */
  function interpolate(frame, inputRange, outputRange, options) {
    options = options || {};
    if (!Array.isArray(inputRange) || !Array.isArray(outputRange)) {
      throw new TypeError('interpolate: inputRange and outputRange must be arrays');
    }
    if (inputRange.length < 2 || inputRange.length !== outputRange.length) {
      throw new RangeError(
        'interpolate: ranges must have equal length >= 2 (inputRange has ' + inputRange.length +
        ', outputRange has ' + outputRange.length + ')');
    }
    for (let i = 1; i < inputRange.length; i++) {
      if (!(inputRange[i] > inputRange[i - 1])) {
        // Naming the offending pair matters: the usual cause is a descending
        // range built from a negative quantity, and it can sit unnoticed until
        // the one frame that reaches this call.
        throw new RangeError(
          'interpolate: inputRange must be strictly increasing, but index ' + i + ' (' + inputRange[i] +
          ') is not greater than index ' + (i - 1) + ' (' + inputRange[i - 1] + '). inputRange=[' +
          inputRange.join(', ') + ']');
      }
    }
    const easing =
      typeof options.easing === 'function'
        ? options.easing
        : easings[options.easing || 'linear'] ||
          (() => { throw new RangeError('interpolate: unknown easing "' + options.easing + '"'); })();
    const extrapolate = options.extrapolate || 'clamp';

    const last = inputRange.length - 1;
    if (frame <= inputRange[0]) {
      if (extrapolate === 'clamp') return outputRange[0];
      // extend: continue first segment's line
      return extendSegment(frame, inputRange[0], inputRange[1], outputRange[0], outputRange[1]);
    }
    if (frame >= inputRange[last]) {
      if (extrapolate === 'clamp') return outputRange[last];
      return extendSegment(frame, inputRange[last - 1], inputRange[last], outputRange[last - 1], outputRange[last]);
    }
    let i = 1;
    while (inputRange[i] < frame) i++;
    const t = (frame - inputRange[i - 1]) / (inputRange[i] - inputRange[i - 1]);
    return outputRange[i - 1] + (outputRange[i] - outputRange[i - 1]) * easing(t);
  }

  function extendSegment(x, x0, x1, y0, y1) {
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }

  /* ------------------------------ Sequence ----------------------------- */

  /**
   * Time-offset a piece of the composition. Inside the current setFrame call
   * (frame is taken from the active frame context), `fn(localFrame)` runs
   * only while `from <= frame < from + durationInFrames`, with
   * `localFrame = frame - from`. Returns true if the sequence was active —
   * callers typically show/hide the sequence's DOM based on this.
   *
   *   Sequence(0, 60, (f) => renderTitle(f));
   *   Sequence(45, 90, (f) => renderLowerThird(f));   // overlap = crossfade
   */
  let _currentFrame = 0;

  function Sequence(from, durationInFrames, fn) {
    if (typeof fn !== 'function') throw new TypeError('Sequence: third argument must be a function');
    const frame = _currentFrame;
    if (frame >= from && frame < from + durationInFrames) {
      fn(frame - from);
      return true;
    }
    return false;
  }

  /* --------------------------- deterministic RNG ------------------------ */

  /**
   * Deterministic PRNG (mulberry32). Same seed → same sequence, so a
   * composition can have "randomness" that is still a pure function of frame:
   *   const rng = random(frame); const jitter = rng() * 4;
   */
  function random(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* -------------------------------- spring ----------------------------- */

  /**
   * Physically-based spring from 0 to 1, evaluated in closed form so it is a
   * pure function of frame (no simulation state, safe under parallel and
   * out-of-order rendering).
   *
   *   const s = spring(frame, { fps: 30 });                    // default feel
   *   const s = spring(frame - 40, { damping: 8 });            // start at frame 40, bouncier
   *   el.style.transform = `scale(${0.5 + 0.5 * s})`;
   *
   * @param {number} frame       frames since the spring started (negative → 0)
   * @param {object} [options]
   * @param {number} [options.fps=30]
   * @param {number} [options.stiffness=100]
   * @param {number} [options.damping=10]
   * @param {number} [options.mass=1]
   */
  function spring(frame, options) {
    options = options || {};
    var fps = options.fps || 30;
    var stiffness = options.stiffness != null ? options.stiffness : 100;
    var damping = options.damping != null ? options.damping : 10;
    var mass = options.mass != null ? options.mass : 1;
    if (frame <= 0) return 0;
    var t = frame / fps;
    var w0 = Math.sqrt(stiffness / mass);       // undamped angular frequency
    var zeta = damping / (2 * Math.sqrt(stiffness * mass)); // damping ratio
    var x;
    if (zeta < 1) {
      var wd = w0 * Math.sqrt(1 - zeta * zeta);
      x = Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    } else if (zeta === 1) {
      x = Math.exp(-w0 * t) * (1 + w0 * t);
    } else {
      var wo = w0 * Math.sqrt(zeta * zeta - 1);
      var r1 = -zeta * w0 + wo, r2 = -zeta * w0 - wo;
      x = (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
    }
    return 1 - x; // displacement from rest → progress toward 1
  }

  /* --------------------------- interpolateColors ------------------------ */

  function parseColor(c) {
    if (typeof c !== 'string') throw new TypeError('interpolateColors: colors must be strings');
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    var rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c.trim());
    if (rgba) return [+rgba[1], +rgba[2], +rgba[3], rgba[4] != null ? +rgba[4] : 1];
    throw new RangeError('interpolateColors: unsupported color "' + c + '" (use #rgb/#rrggbb/#rrggbbaa or rgb()/rgba())');
  }

  /**
   * Interpolate through a list of colors, mirroring interpolate()'s
   * piecewise-linear ranges. Returns an "rgba(r, g, b, a)" string.
   *
   *   bg.style.background = interpolateColors(frame, [0, 60, 120], ['#0b1026', '#274690', '#f9564f']);
   */
  function interpolateColors(frame, inputRange, colors) {
    if (!Array.isArray(colors) || colors.length !== inputRange.length) {
      throw new RangeError(
        'interpolateColors: colors must match inputRange length (inputRange has ' +
        (Array.isArray(inputRange) ? inputRange.length : typeof inputRange) + ', colors has ' +
        (Array.isArray(colors) ? colors.length : typeof colors) + ')');
    }
    var parsed = colors.map(parseColor);
    var channel = function (i) {
      return interpolate(frame, inputRange, parsed.map(function (p) { return p[i]; }));
    };
    var r = Math.round(channel(0)), g = Math.round(channel(1)), b = Math.round(channel(2));
    var a = +channel(3).toFixed(4);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  }

  /* -------------------------------- Loop -------------------------------- */

  /**
   * Repeat a sub-animation: runs `fn(frame % durationInFrames, cycleIndex)`
   * against the current frame context. Combines with Sequence:
   *
   *   Sequence(30, 120, function () { Loop(20, drawPulse); });
   */
  function Loop(durationInFrames, fn) {
    if (!(durationInFrames > 0)) throw new RangeError('Loop: durationInFrames must be > 0');
    if (typeof fn !== 'function') throw new TypeError('Loop: second argument must be a function');
    var frame = _currentFrame;
    fn(frame % durationInFrames, Math.floor(frame / durationInFrames));
  }

  /* ------------------------------ particles ----------------------------- */

  /**
   * Deterministic looping particle emitter (v1.3): a pure function of frame,
   * safe under parallel and out-of-order rendering. Returns one state per
   * particle; the composition maps states onto DOM nodes / canvas / 3D meshes.
   *
   *   phase  0..1 through the particle's life (uniformly staggered by index)
   *   cycle  which rebirth this is — the per-particle randoms re-roll each cycle
   *   u      four stable random values for this (particle, cycle): use them for
   *          spawn jitter, size, drift, hue — anything that must not flicker
   *          between frames
   *
   *   // steam rising from a spout:
   *   particles(frame, { count: 14, lifeFrames: 90, seed: 7 }).forEach(p => {
   *     const m = puffs[p.index];
   *     m.position.set(x0 + (p.u[0] - 0.5) * 0.6 * p.phase, y0 + p.phase * 2.3,
   *                    (p.u[1] - 0.5) * 0.4 * p.phase);
   *     m.material.opacity = 0.3 * Math.sin(p.phase * Math.PI);
   *     const s = 0.6 + p.phase * (1 + p.u[2]);
   *     m.scale.set(s, s, s);
   *   });
   *
   * @param {number} frame
   * @param {object} [options]
   * @param {number} [options.count=20]      particles alive at any moment
   * @param {number} [options.lifeFrames=60] frames from birth to death
   * @param {number} [options.seed=1]        vary for independent emitters
   * @param {number} [options.speed=1]       time multiplier
   * @returns {Array<{index: number, phase: number, cycle: number, u: number[]}>}
   */
  function particles(frame, options) {
    options = options || {};
    var count = options.count != null ? options.count : 20;
    var lifeFrames = options.lifeFrames != null ? options.lifeFrames : 60;
    var seed = options.seed != null ? options.seed : 1;
    var speed = options.speed != null ? options.speed : 1;
    if (!(count > 0)) throw new RangeError('particles: count must be > 0 (got ' + count + ')');
    if (!(lifeFrames > 0)) throw new RangeError('particles: lifeFrames must be > 0 (got ' + lifeFrames + ')');
    var out = [];
    for (var i = 0; i < count; i++) {
      var progress = (frame * speed) / lifeFrames + i / count;
      var phase = progress - Math.floor(progress);
      var cycle = Math.floor(progress);
      // Large odd primes keep the streams of neighbouring particles/cycles
      // uncorrelated; mulberry32 does the rest.
      var rng = random(((seed * 1000003 + i * 7919 + cycle * 104729) >>> 0) || 1);
      out.push({ index: i, phase: phase, cycle: cycle, u: [rng(), rng(), rng(), rng()] });
    }
    return out;
  }

  /* ------------------------- composition harness ----------------------- */

  /**
   * Install the render-engine handshake around a user-supplied per-frame
   * function. The engine drives:
   *     window.setFrame(n)  ->  window.frameReady === true  ->  screenshot
   *
   * registerComposition guarantees:
   *   - frameReady is false while the user function runs
   *   - async user functions are awaited before frameReady flips true
   *   - document.fonts.ready is awaited once up front (fonts settle before
   *     the first captured frame)
   *   - the current frame is exposed to Sequence()
   */
  function registerComposition(userSetFrame) {
    if (typeof userSetFrame !== 'function') {
      throw new TypeError('registerComposition: expected a function(frame)');
    }
    const fontsReady =
      typeof document !== 'undefined' && document.fonts && document.fonts.ready
        ? document.fonts.ready.catch(function () {})
        : Promise.resolve();

    global.frameReady = false;
    global.setFrame = function (frame) {
      global.frameReady = false;
      _currentFrame = frame;
      return Promise.resolve(fontsReady)
        .then(function () { return userSetFrame(frame); })
        .then(function () { global.frameReady = true; })
        .catch(function (err) {
          // Surface composition errors to the capture loop instead of hanging
          // until the frame timeout: the engine checks window.__frameError.
          global.__frameError = (err && err.stack) || String(err);
          throw err;
        });
    };
    global.__motionStudioRegistered = true;
  }

  /* -------------------------------- video ------------------------------ */

  /**
   * Wait until a <video> can be seeked — resolving on failure too (v1.4).
   *
   * `loadeddata` never fires for a file that is missing or undecodable, so
   * awaiting it alone deadlocks the frame. This resolves on `error` as well;
   * seekVideo() then sees an unusable element and no-ops rather than hanging.
   */
  function videoReady(video) {
    return new Promise(function (resolve) {
      if (!video) { resolve(false); return; }
      if (video.readyState >= 2) { resolve(true); return; }
      var done = function (ok) {
        video.removeEventListener('loadeddata', onLoad);
        video.removeEventListener('error', onErr);
        resolve(ok);
      };
      var onLoad = function () { done(true); };
      var onErr = function () { done(false); };
      video.addEventListener('loadeddata', onLoad);
      video.addEventListener('error', onErr);
    });
  }

  /**
   * Show the frame of `video` at `seconds` — the deterministic way to use
   * footage in a composition (v1.4).
   *
   * Video is the one asset type that cannot simply be drawn: it has a
   * playhead, and playing it would make the picture a function of wall-clock
   * time, which the frame contract forbids. So a composition SEEKS instead —
   *
   *     await seekVideo(host, from + frame / fps, { fps });
   *
   * — and every composition that does this needs the same three guards, each
   * of which fails silently or catastrophically when omitted:
   *
   *  1. **Never wait on an unusable element.** A <video> whose src 404s never
   *     fires `seeked`, so a bare `currentTime = t; await seeked` deadlocks
   *     the frame until the render times out — historically with no clue as
   *     to which file. Bailing out here turns that into a missing picture,
   *     and the engine names the failed request in the error.
   *  2. **Clamp to the last real frame.** Seeking past the end never
   *     completes on some builds; pass `fps` and the target is clamped to
   *     duration - 1/fps.
   *  3. **Skip a seek that is already satisfied**, or a scene whose footage
   *     is shorter than the scene pays a pointless round trip per frame.
   *
   * Deliberately has NO internal timeout: a genuinely stuck seek must fail
   * loudly as a frame timeout, not silently capture the wrong frame.
   *
   * @param {HTMLVideoElement} video
   * @param {number} seconds            target time in the video's own timeline
   * @param {{fps?: number}} [options]  scene fps, used to clamp to the last frame
   * @returns {Promise<boolean>}        true if the element is showing that time
   */
  function seekVideo(video, seconds, options) {
    options = options || {};
    return new Promise(function (resolve) {
      if (!video) { resolve(false); return; }
      var duration = video.duration;
      var usable = typeof duration === 'number' && isFinite(duration) && duration > 0 && video.readyState >= 1;
      if (!usable) { resolve(false); return; }

      var last = options.fps > 0 ? duration - 1 / options.fps : duration - 1e-3;
      var t = Math.min(Math.max(0, Number(seconds) || 0), Math.max(0, last));
      if (Math.abs(video.currentTime - t) < 1e-4) { resolve(true); return; }

      var onSeeked = function () {
        video.removeEventListener('seeked', onSeeked);
        resolve(true);
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
    });
  }

  /* ------------------------------- export ------------------------------ */

  const api = {
    interpolate, Sequence, Loop, spring, interpolateColors, random, particles, easings,
    registerComposition, videoReady, seekVideo, version: 1.4,
  };
  global.MotionStudio = api;
  // Bare-name conveniences for terse composition code.
  global.interpolate = interpolate;
  global.Sequence = Sequence;
  global.Loop = Loop;
  global.spring = spring;
  global.interpolateColors = interpolateColors;
  global.particles = particles;
  global.seekVideo = seekVideo;
  global.videoReady = videoReady;

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // for engine unit tests
})(typeof window !== 'undefined' ? window : globalThis);
