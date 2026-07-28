/**
 * Test scaffolding for the v0.20 storage model (workspace → film → scene).
 *
 * Most suites just need "a scene to render/edit" the way they used to need
 * "a project"; these helpers keep that a one-liner. The default workspace
 * slug is "t" so test ids read "t/<film>/<scene>".
 */
import { WorkspaceStore } from '../../src/core/store.js';

export const TEST_WS = 't';

/** A ready store with the test workspace ensured. */
export async function makeStore(dataDir) {
  const store = new WorkspaceStore(dataDir);
  await store.ensureWorkspace(TEST_WS);
  return store;
}

/**
 * Create a film (if needed) and a scene inside it.
 * @returns {{ store, film, scene: {id, name, path, config} }}
 */
export async function makeScene(store, {
  name = 'Scene 1',
  film = 'Test Film',
  fps, width, height, durationInFrames,
} = {}) {
  const filmSlug = film.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const filmId = `${TEST_WS}/${filmSlug}`;
  let filmDoc;
  try {
    filmDoc = await store.getFilm(filmId);
  } catch {
    filmDoc = await store.createFilm(TEST_WS, { name: film });
  }
  const scene = await store.createScene(filmDoc.id, { name, fps, width, height, durationInFrames });
  return { store, film: filmDoc, scene };
}

/** One-call version: fresh store + film + scene in `dataDir`. */
export async function makeSceneIn(dataDir, opts = {}) {
  const store = await makeStore(dataDir);
  return makeScene(store, opts);
}
