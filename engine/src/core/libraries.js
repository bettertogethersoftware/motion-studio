/**
 * Optional 3D libraries an agent can attach to a project (v0.7).
 *
 * Motion Studio compositions are self-contained HTML/CSS/JS. A project can opt
 * in to a heavier rendering library (Three.js / Babylon.js) that gets vendored
 * *locally* into the project — never a CDN at render time, so renders stay
 * hermetic and reproducible. The big library builds live under the engine's
 * vendor dir (git-ignored, populated by scripts/fetch-libs.mjs); only the small
 * starter templates (engine/templates/lib-*) are committed source.
 *
 * This registry is the single source of truth for both `add_library` (the MCP
 * tool / ProjectStore.addLibrary) and scripts/fetch-libs.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the vendored library builds live. Overridable for tests. */
export function libsVendorDir() {
  return process.env.MOTION_STUDIO_LIBS_DIR || path.resolve(__dirname, '../../vendor/libs');
}

// Determinism rules the starter templates already follow — surfaced to the agent.
const COMMON_NOTES = [
  'Drive every animation from the injected frame — no requestAnimationFrame and no wall-clock time.',
  'The renderer uses preserveDrawingBuffer:true and each setFrame ends with a GL finish() so the headless screenshot captures the frame.',
  'Compile shaders BEFORE the first captured frame — libraries compile materials lazily and skip not-yet-ready meshes on the first render, so a single-frame capture (render_still / capture_preview_frame / frame 0) comes back blank. The starters warm up (Babylon: material.forceCompilationAsync; Three: renderer.compile) before registering the composition.',
];

export const LIBRARIES = {
  three: {
    id: 'three',
    name: 'Three.js',
    version: '0.134.0',
    global: 'THREE',
    approxKB: 601,
    files: [{
      vendor: 'three/three.min.js',
      dest: 'three.min.js',
      url: 'https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js',
    }],
    scripts: ['three.min.js'], // loaded before frame-api.js in composition.html
    template: 'lib-three',
    notes: [
      ...COMMON_NOTES,
      'Do not use THREE.Clock or getDelta(); compute rotations/positions from `frame`.',
      'Add-ons (OrbitControls, loaders, postprocessing) live in three/examples/jsm and are not bundled here.',
    ],
  },
  babylon: {
    id: 'babylon',
    name: 'Babylon.js',
    // Pinned, was 'stable'. The floating https://cdn.babylonjs.com/babylon.js is
    // whatever the CDN serves today, so two machines could vendor different code
    // with nothing recording which. Versioned paths need the `v` prefix
    // (/v9.18.0/… works, /9.18.0/… 404s). Core and addons must match versions.
    // NB the pinned build is NOT byte-identical to the floating one even at the
    // same version — hence the content hashes in engine/vendor.lock.json.
    version: '9.18.0',
    global: 'BABYLON',
    approxKB: 7990,
    files: [{
      vendor: 'babylon/babylon.js',
      dest: 'babylon.js',
      url: 'https://cdn.babylonjs.com/v9.18.0/babylon.js',
    }],
    scripts: ['babylon.js'],
    template: 'lib-babylon',
    // Optional addons loaded after the core (before frame-api.js). Attach with
    // add_library { library:"babylon", addons:["loaders"] }.
    addons: {
      loaders: {
        vendor: 'babylon/babylonjs.loaders.min.js',
        dest: 'babylonjs.loaders.min.js',
        url: 'https://cdn.babylonjs.com/v9.18.0/loaders/babylonjs.loaders.min.js',
        note: 'glTF/GLB import via BABYLON.SceneLoader.ImportMeshAsync. Loading a model needs MOTION_STUDIO_ALLOW_LOCAL_FETCH=1 (file:// fetch), an environment texture for PBR, and forceCompilationAsync on the imported meshes before the first frame.',
      },
    },
    notes: [
      ...COMMON_NOTES,
      'Do NOT call engine.runRenderLoop(); call scene.render() inside setFrame instead.',
      'Avoid ParticleSystem and scene.beginAnimation() — both are wall-clock based. Animate transforms from `frame`.',
      'If you use DefaultRenderingPipeline, set grain.animated = false (animated grain is time-based).',
    ],
  },
};

export function getLibrary(id) {
  return LIBRARIES[id] || null;
}

export const LIBRARY_IDS = Object.keys(LIBRARIES);
