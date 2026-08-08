/**
 * Putting a still on the timeline (v0.28).
 *
 * The claim is that a picture becomes an ORDINARY scene: the play order gains
 * one `{slug}` entry, nothing downstream can tell it apart, and the film still
 * plans clean. So that is what is asserted here — the play order's shape, the
 * scene's signature against the film's, and the plan's problem list — rather
 * than that the call returned an object.
 *
 * The one claim a structural test cannot make is the visual one: that a
 * portrait plate in a landscape film LETTERBOXES instead of stretching. That is
 * measured on a real rendered frame, gated on a Chromium being resolvable, at
 * the foot of the file.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { makeStore, TEST_WS } from './helpers/workspace.mjs';
import {
  sceneFromImage, imageCompositionFiles, chooseFit, DEFAULT_STILL_FRAMES,
} from '../src/core/image-scene.js';
import { planFilm } from '../src/core/films.js';
import { measureRgbaSample } from '../src/core/picture.js';
import { captureSingleFrame } from '../src/core/renderer.js';

const execFileP = promisify(execFile);
let tmp, wide, tall, alpha, haveFfmpeg = true, haveBrowser = false;

const FPS = 30;
const WIDTH = 320;
const HEIGHT = 180;

/** One PNG of the given size, from ffmpeg's own pattern generator. */
const makePng = async (file, size, extra = []) => {
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-frames:v', '1', ...extra, file]);
  return file;
};

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-image-scene-'));
  try { await execFileP('ffmpeg', ['-version']); } catch { haveFfmpeg = false; }
  if (haveFfmpeg) {
    wide = await makePng(path.join(tmp, 'wide.png'), `${WIDTH}x${HEIGHT}`);
    tall = await makePng(path.join(tmp, 'tall.png'), `${HEIGHT}x${WIDTH}`);
    // Half transparent, so `isTransparent` is MEASURED true rather than merely
    // declared by the pixel format.
    alpha = path.join(tmp, 'alpha.png');
    await execFileP('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=red:size=${WIDTH}x${HEIGHT}`,
      '-vf', 'format=rgba,colorchannelmixer=aa=0.5', '-frames:v', '1', '-pix_fmt', 'rgba', alpha]);
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.MOTION_STUDIO_CHROME) {
    haveBrowser = true;
  } else {
    try {
      const puppeteer = (await import('puppeteer')).default;
      const exists = (p) => !!p && fsp.access(p).then(() => true, () => false);
      const shell = await exists((() => { try { return puppeteer.executablePath({ headless: 'shell' }); } catch { return null; } })());
      const chrome = await exists((() => { try { return puppeteer.executablePath(); } catch { return null; } })());
      haveBrowser = shell || chrome;
    } catch { haveBrowser = false; }
  }
});
after(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));

/** A landscape film with one rendered-shape scene already establishing its signature. */
async function landscapeFilm(dataDir, { sceneDefaults = { fps: FPS, width: WIDTH, height: HEIGHT } } = {}) {
  const store = await makeStore(dataDir);
  const film = await store.createFilm(TEST_WS, { name: 'Still Film', sceneDefaults });
  return { store, film: await store.getFilm(film.id) };
}

/** Put a file into the workspace library at `rel`. */
async function intoLibrary(store, rel, src) {
  const abs = path.join(store.libraryPath(TEST_WS), rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.copyFile(src, abs);
  return rel;
}

/* ------------------------------------------------------------------ */
/* The fit decision, without paying for a decode                       */
/* ------------------------------------------------------------------ */

test('the fit is a measurement: cover when it barely crops, contain when it would cost the picture', () => {
  // 3:2 photograph in a 16:9 frame — a sixth off the top and bottom, which is
  // what everyone does with a camera's own aspect.
  const close = chooseFit({ width: 1920, height: 1080, picture: { width: 3000, height: 2000 } });
  assert.equal(close.mode, 'cover');
  assert.equal(close.measured, true);
  assert.ok(close.cropFraction < 0.2);

  // Portrait plate in a landscape film: the acceptance case. Two thirds of the
  // picture would be outside the frame, so it letterboxes.
  const portrait = chooseFit({ width: 1920, height: 1080, picture: { width: 1080, height: 1920 } });
  assert.equal(portrait.mode, 'contain');
  assert.ok(portrait.cropFraction > 0.6);
  assert.match(portrait.reason, /crop 68% of the picture/);

  // 4:3 in 16:9 is the near-miss that must NOT be treated as full bleed.
  assert.equal(chooseFit({ width: 1920, height: 1080, picture: { width: 1600, height: 1200 } }).mode, 'contain');

  // Symmetric: a landscape plate in a portrait film is the same decision.
  assert.equal(chooseFit({ width: 1080, height: 1920, picture: { width: 1920, height: 1080 } }).mode, 'contain');
});

test('an unmeasured image gets the fit that cannot crop or stretch, and SAYS it was not measured', () => {
  const guessed = chooseFit({ width: 1920, height: 1080, picture: null });
  assert.equal(guessed.mode, 'contain');
  assert.equal(guessed.measured, false);
  assert.equal(guessed.cropFraction, null);
  assert.match(guessed.reason, /could not be measured/);
});

/* ------------------------------------------------------------------ */
/* The generated composition                                           */
/* ------------------------------------------------------------------ */

test('the generated composition is one img, one rule, and a comment naming the fit', () => {
  const fit = chooseFit({ width: 1920, height: 1080, picture: { width: 1080, height: 1920 } });
  const files = imageCompositionFiles({
    name: 'Rome Forum', fps: 30, width: 1920, height: 1080, durationInFrames: 90,
    imageFile: 'rome-forum.png', fit,
  });

  // Exactly one image, and it is the scene's own asset — never a remote URL,
  // which works in a preview and makes parallel renders unreliable.
  assert.equal((files['composition.html'].match(/<img/g) ?? []).length, 1);
  assert.ok(files['composition.html'].includes('src="assets/rome-forum.png"'));

  // The fit and the reason are IN the stylesheet, so flipping it is a one-word
  // edit by someone who can see why it was chosen.
  assert.ok(files['styles.css'].includes('object-fit: contain;'));
  assert.match(files['styles.css'], /`contain`: the image is 1080x1920/);
  assert.ok(files['styles.css'].includes('width: 1920px'));

  // A still does not move, but the picture must be decoded before the engine
  // screenshots it — and the frame function is where an author starts.
  assert.ok(files['composition.js'].includes('MotionStudio.registerComposition'));
  assert.ok(files['composition.js'].includes('still.decode()'));
  assert.ok(files['composition.js'].includes('const DURATION = 90;'));
  assert.ok(!/\bsetTimeout\b|\bDate\.now\b/.test(files['composition.js']), 'nothing wall-clock driven');
});

test('a name with markup cannot escape the generated html, or the css comment', () => {
  const fit = chooseFit({ width: 100, height: 100, picture: { width: 100, height: 100 } });
  const files = imageCompositionFiles({
    name: '<script>x</script> */ body{}', fps: 30, width: 100, height: 100,
    durationInFrames: 10, imageFile: 'x.png', fit,
  });
  assert.ok(!files['composition.html'].includes('<script>x</script>'));
  assert.ok(files['composition.html'].includes('&lt;script&gt;'));
  // A `*/` in the name would otherwise end the stylesheet's header comment and
  // leave the rest of the sentence as broken CSS.
  assert.ok(!files['styles.css'].split('html, body')[0].includes('*/ body{}'));
});

test('transparency is stated in the file the author reads, not resolved for them', () => {
  const fit = chooseFit({ width: 100, height: 100, picture: { width: 100, height: 100 } });
  const opaque = imageCompositionFiles({
    name: 'A', fps: 30, width: 100, height: 100, durationInFrames: 10, imageFile: 'a.png', fit,
  });
  const cutout = imageCompositionFiles({
    name: 'A', fps: 30, width: 100, height: 100, durationInFrames: 10, imageFile: 'a.png', fit,
    transparent: true,
  });
  assert.ok(!opaque['styles.css'].includes('TRANSPARENCY'));
  assert.match(cutout['styles.css'], /TRANSPARENCY/);
  // Both keep the same background rule: the transparency is REPORTED, and the
  // composition is not silently rewritten around it.
  assert.ok(cutout['styles.css'].includes('background: #000;'));
});

/* ------------------------------------------------------------------ */
/* The scaffolder                                                      */
/* ------------------------------------------------------------------ */

test('a library image becomes a scene in one call, and the play order gains ONE {slug}',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'plates/rome-forum.png', wide);

    const res = await sceneFromImage({ store, filmId: film.id, image: 'plates/rome-forum.png' });

    // The film's geometry, not the image's.
    assert.equal(res.config.fps, FPS);
    assert.equal(res.config.width, WIDTH);
    assert.equal(res.config.height, HEIGHT);
    assert.equal(res.name, 'rome-forum', 'the filename names the scene');

    // A real scene folder, with the runtime beside it.
    for (const f of ['scene.json', 'composition.html', 'composition.js', 'styles.css', 'frame-api.js']) {
      assert.ok(fs.existsSync(path.join(res.path, f)), `${f} exists`);
    }
    assert.ok(fs.existsSync(path.join(res.path, 'assets', 'rome-forum.png')));
    assert.equal(res.image.file, 'assets/rome-forum.png');
    assert.equal(res.image.source, 'library');

    // An ORDINARY segment — a bare {slug}, with no new field for a walk to miss.
    const after = await store.getFilm(film.id);
    assert.equal(after.scenes.length, 1);
    assert.deepEqual(Object.keys(after.scenes[0]), ['slug']);
    assert.equal(after.scenes[0].slug, res.scene.split('/').pop());
  });

test('the film plans clean afterwards — the only problem is that it has not been rendered yet',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'card.png', wide);
    // A scene FIRST, so the film has an established signature the still has to
    // match — the case where a wrong geometry would actually surface.
    await store.createScene(film.id, { name: 'Head', fps: FPS, width: WIDTH, height: HEIGHT, durationInFrames: 30 });
    const res = await sceneFromImage({ store, filmId: (await store.getFilm(film.id)).id, image: 'card.png' });

    const after = await store.getFilm(film.id);
    const plan = await planFilm({ film: after, store });
    // `scene_not_rendered` is true of every brand-new scene, including the one
    // create_scene makes; everything else must be absent — no signature clash,
    // no missing asset, no unknown segment.
    assert.deepEqual(
      plan.problems.filter((p) => p.code !== 'scene_not_rendered').map((p) => p.code),
      [],
      JSON.stringify(plan.problems),
    );
    const planned = plan.scenes.find((s) => s.slug === res.scene.split('/').pop());
    assert.equal(planned.kind, 'scene', 'nothing downstream sees a third kind of segment');
    assert.equal(planned.signature, plan.scenes[0].signature, 'it concatenates with what is already there');
    assert.equal(planned.durationInFrames, res.config.durationInFrames);
  });

test('duration is the caller\'s, then the film\'s sceneDefaults, then a stated default',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir, {
      sceneDefaults: { fps: FPS, width: WIDTH, height: HEIGHT, durationInFrames: 210 },
    });
    await intoLibrary(store, 'card.png', wide);

    const asked = await sceneFromImage({
      store, filmId: film.id, image: 'card.png', slug: 'asked', durationInFrames: 45,
    });
    assert.equal(asked.config.durationInFrames, 45);

    const defaulted = await sceneFromImage({ store, filmId: film.id, image: 'card.png', slug: 'defaulted' });
    assert.equal(defaulted.config.durationInFrames, 210, 'the film\'s own preference');

    // A film with no stated preference falls back to the named constant rather
    // than to a length invented on the spot.
    const bare = await landscapeFilm(await fsp.mkdtemp(path.join(tmp, 'ws-')));
    await intoLibrary(bare.store, 'card.png', wide);
    const fallback = await sceneFromImage({ store: bare.store, filmId: bare.film.id, image: 'card.png' });
    assert.equal(fallback.config.durationInFrames, DEFAULT_STILL_FRAMES);
  });

test('a portrait plate in a landscape film is fitted `contain`, and says why',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'tall.png', tall);
    const res = await sceneFromImage({ store, filmId: film.id, image: 'tall.png' });

    assert.equal(res.fit.mode, 'contain');
    assert.equal(res.fit.measured, true);
    assert.equal(res.picture.width, HEIGHT);
    assert.equal(res.picture.height, WIDTH);
    const css = await fsp.readFile(path.join(res.path, 'styles.css'), 'utf8');
    assert.ok(css.includes('object-fit: contain;'));
    assert.ok(!css.includes('object-fit: fill'), 'stretching is never one of the options');
  });

test('an image whose aspect matches the film fills the frame',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'wide.png', wide);
    const res = await sceneFromImage({ store, filmId: film.id, image: 'wide.png' });
    assert.equal(res.fit.mode, 'cover');
    assert.deepEqual(res.warnings, []);
  });

test('transparency is reported, and neither the fit nor the background is decided by it',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'cutout.png', alpha);
    const res = await sceneFromImage({ store, filmId: film.id, image: 'cutout.png' });

    assert.equal(res.picture.hasAlpha, true, 'the pixel format declares it');
    assert.equal(res.picture.isTransparent, true, 'and the decode measures it');
    assert.ok(res.warnings.some((w) => /transparency/i.test(w)), res.warnings.join(' | '));
    // Reported, not resolved: the composition is the same one an opaque image
    // would have got, with the fact stated in it.
    const css = await fsp.readFile(path.join(res.path, 'styles.css'), 'utf8');
    assert.ok(css.includes('background: #000;'));
    assert.match(css, /TRANSPARENCY/);
  });

test('the film\'s own assets/ is the second source, and it is copied rather than aliased',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await fsp.mkdir(path.join(film.path, 'assets'), { recursive: true });
    await fsp.copyFile(wide, path.join(film.path, 'assets', 'plate.png'));

    const res = await sceneFromImage({
      store, filmId: film.id, image: 'assets/plate.png', imageFrom: 'film',
    });
    assert.equal(res.image.source, 'film');
    assert.equal(res.image.linked, false, 'a live scene\'s asset must not share an inode with the film\'s');
    const scenePng = path.join(res.path, 'assets', 'plate.png');
    assert.ok(fs.existsSync(scenePng));
    assert.deepEqual(await fsp.readFile(scenePng), await fsp.readFile(path.join(film.path, 'assets', 'plate.png')));
  });

test('an animated GIF is named as the determinism hazard it is, rather than converted',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    const gif = path.join(tmp, 'moving.gif');
    await execFileP('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=10:duration=1`, gif]);
    await intoLibrary(store, 'moving.gif', gif);

    const res = await sceneFromImage({ store, filmId: film.id, image: 'moving.gif' });
    assert.ok(res.warnings.some((w) => /wall clock/.test(w)), res.warnings.join(' | '));
    assert.ok(res.warnings.some((w) => /seekVideo|make_scene_from_footage/.test(w)));
    // Still built — the caller may genuinely want an arbitrary frame of it.
    assert.ok(fs.existsSync(path.join(res.path, 'assets', 'moving.gif')));
  });

test('placing the same still twice dedupes the slug; an explicit collision is an error',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'card.png', wide);
    const first = await sceneFromImage({ store, filmId: film.id, image: 'card.png' });
    const second = await sceneFromImage({ store, filmId: film.id, image: 'card.png' });
    assert.notEqual(first.scene, second.scene);
    assert.match(second.scene, /-2$/);
    // A title card at the head and the tail is a normal ask, so both are in the
    // play order, in order.
    const after = await store.getFilm(film.id);
    assert.deepEqual(after.scenes.map((s) => s.slug), ['card', 'card-2']);

    await sceneFromImage({ store, filmId: film.id, image: 'card.png', slug: 'taken' });
    await assert.rejects(
      () => sceneFromImage({ store, filmId: film.id, image: 'card.png', slug: 'taken' }),
      (e) => e.code === 'scene_already_exists',
    );
  });

test('a missing image, a non-image and a geometry-less film all fail before anything is created',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);

    await assert.rejects(
      () => sceneFromImage({ store, filmId: film.id, image: 'nope.png' }),
      (e) => e.code === 'file_not_found',
    );
    // A video is the mistake worth naming: it is a still-shaped ask with a
    // different answer (make_scene_from_footage).
    await intoLibrary(store, 'clip.mp4', wide);
    await assert.rejects(
      () => sceneFromImage({ store, filmId: film.id, image: 'clip.mp4' }),
      (e) => e.code === 'invalid_config' && /make_scene_from_footage/.test(e.message),
    );

    const bare = await makeStore(await fsp.mkdtemp(path.join(tmp, 'ws-')));
    const noGeometry = await bare.createFilm(TEST_WS, { name: 'Undecided' });
    await intoLibrary(bare, 'card.png', wide);
    await assert.rejects(
      () => sceneFromImage({ store: bare, filmId: noGeometry.id, image: 'card.png' }),
      (e) => e.code === 'invalid_film',
    );

    // Nothing was created by any of the three, and the film still plays.
    const scenesDir = path.join(film.path, 'scenes');
    assert.deepEqual(fs.existsSync(scenesDir) ? await fsp.readdir(scenesDir) : [], []);
    assert.deepEqual((await store.getFilm(film.id)).scenes, []);
  });

test('nothing is written outside the new scene folder',
  { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
    const { store, film } = await landscapeFilm(dir);
    await intoLibrary(store, 'plates/card.png', wide);

    const libraryBefore = await store.listLibrary(TEST_WS);
    const res = await sceneFromImage({ store, filmId: film.id, image: 'plates/card.png' });

    // The film's own assets/ is untouched — the picture went into the SCENE.
    const filmAssets = path.join(film.path, 'assets');
    assert.deepEqual(fs.existsSync(filmAssets) ? await fsp.readdir(filmAssets) : [], []);
    // The library is a human's folder and is read-only to this operation.
    assert.deepEqual(await store.listLibrary(TEST_WS), libraryBefore);
    // Only the new scene exists.
    assert.deepEqual(await fsp.readdir(path.join(film.path, 'scenes')), [res.scene.split('/').pop()]);
  });

/* ------------------------------------------------------------------ */
/* The visual claim, on a real frame                                   */
/* ------------------------------------------------------------------ */

/**
 * The one assertion structure cannot make: a portrait plate in a landscape film
 * LETTERBOXES rather than stretching. Rendered through the real browser and
 * measured, because "object-fit: contain is in the stylesheet" is a statement
 * about a file, not about a picture.
 */
test('a rendered frame shows the picture letterboxed, not stretched', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg not installed');
  if (!haveBrowser) return t.skip('no Chromium available');

  const dir = await fsp.mkdtemp(path.join(tmp, 'ws-'));
  const { store, film } = await landscapeFilm(dir);
  await intoLibrary(store, 'tall.png', tall);
  const res = await sceneFromImage({ store, filmId: film.id, image: 'tall.png', durationInFrames: 2 });

  const png = await captureSingleFrame({ scenePath: res.path, config: res.config, frame: 0 });
  const raw = await new Promise((resolve, reject) => {
    const proc = execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    proc.stdin.end(png);
  });

  const shown = measureRgbaSample(raw.subarray(0, WIDTH * HEIGHT * 4), { width: WIDTH, height: HEIGHT });
  // `contain` scales a 180x320 plate to the 180px height of a 320x180 frame,
  // which is 101px wide and centred. A stretch would fill all 320.
  const expected = Math.round(HEIGHT * (HEIGHT / WIDTH));
  assert.ok(Math.abs(shown.contentBox.width - expected) <= 3,
    `picture is ${shown.contentBox.width}px wide, expected about ${expected}px (a stretch would be ${WIDTH})`);
  assert.equal(shown.contentBox.height, HEIGHT, 'and it fills the frame vertically');
  assert.ok(shown.contentBox.x > 0 && shown.contentBox.x + shown.contentBox.width < WIDTH,
    'with background either side of it');
});
