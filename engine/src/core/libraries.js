/**
 * Optional 3D libraries an agent can attach to a scene (v0.7).
 *
 * Motion Studio compositions are self-contained HTML/CSS/JS. A scene can opt
 * in to a heavier rendering library (Three.js / Babylon.js) that gets vendored
 * *locally* into the scene — never a CDN at render time, so renders stay
 * hermetic and reproducible. The builds live in vendor/libs, which IS
 * committed (~9 MB, MIT / Apache-2.0), so add_library works on a fresh clone with
 * no setup step; vendor.lock.json records which upstream build each file
 * came from, and scripts/fetch-libs.mjs is an upgrade/repair tool rather than a
 * prerequisite. The rest of vendor (the two exes, FluidSynth, SoundFonts)
 * stays out of git — see .gitignore for why each one.
 *
 * This registry is the single source of truth for both `add_library` (the MCP
 * tool / WorkspaceStore.addLibrary) and scripts/fetch-libs.mjs.
 */
import path from 'node:path';
import { vendorDir } from './paths.js';

/** Where the vendored library builds live. Overridable for tests. */
export function libsVendorDir() {
  return process.env.MOTION_STUDIO_LIBS_DIR || path.join(vendorDir(), 'libs');
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
    // Optional addons (v0.19), vendored from three's examples/js UMD builds —
    // the global-script twins of examples/jsm, which existed through r147.
    // This is also why the core stays pinned ≤0.147: r148 removed examples/js
    // and r160 removed the UMD core build, and Motion Studio compositions are
    // plain <script> tags by design (hermetic, no bundler at render time).
    addons: {
      geometries: {
        files: [{
          vendor: 'three/examples/TeapotGeometry.js',
          dest: 'three.TeapotGeometry.js',
          url: 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/geometries/TeapotGeometry.js',
        }],
        note: 'THREE.TeapotGeometry(size, segments) — the canonical Utah teapot as a single geometry.',
      },
      loaders: {
        files: [{
          vendor: 'three/examples/GLTFLoader.js',
          dest: 'three.GLTFLoader.js',
          url: 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/loaders/GLTFLoader.js',
        }],
        note: 'glTF/GLB import via new THREE.GLTFLoader().load(...). Loading a model file needs MOTION_STUDIO_ALLOW_LOCAL_FETCH=1, and every loaded mesh must be warmed up (renderer.compile) before the first captured frame.',
      },
      postprocessing: {
        // Script order matters: shaders first, then Pass/ShaderPass/MaskPass,
        // then the composer and the passes that build on them.
        files: [
          ['CopyShader', 'shaders/CopyShader.js'],
          ['LuminosityHighPassShader', 'shaders/LuminosityHighPassShader.js'],
          ['Pass', 'postprocessing/Pass.js'],
          ['ShaderPass', 'postprocessing/ShaderPass.js'],
          ['MaskPass', 'postprocessing/MaskPass.js'],
          ['EffectComposer', 'postprocessing/EffectComposer.js'],
          ['RenderPass', 'postprocessing/RenderPass.js'],
          ['UnrealBloomPass', 'postprocessing/UnrealBloomPass.js'],
        ].map(([name, rel]) => ({
          vendor: `three/examples/${name}.js`,
          dest: `three.${name}.js`,
          url: `https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/${rel}`,
        })),
        note: 'THREE.EffectComposer + RenderPass + UnrealBloomPass (and ShaderPass for custom shaders). Compose in setFrame: composer.render() replaces renderer.render(). Call composer.setSize(W, H) once and keep bloom parameters frame-driven if animated.',
      },
    },
    notes: [
      ...COMMON_NOTES,
      'Do not use THREE.Clock or getDelta(); compute rotations/positions from `frame`.',
      'Optional addons: add_library { library:"three", addons:["geometries"|"loaders"|"postprocessing"] } — TeapotGeometry, GLTFLoader, EffectComposer/bloom. Other examples/jsm modules are not bundled.',
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
    // same version — hence the content hashes in vendor.lock.json.
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

/**
 * The file entries an addon contributes, in load order (v0.19). Addons come in
 * two shapes: single-file ({vendor, dest, url}, the original babylon form) and
 * multi-file ({files: [...]}); this normalizes both so addLibrary and
 * fetch-libs.mjs iterate one way.
 */
export function addonFiles(addon) {
  return addon.files ?? [addon];
}

/** Every addon id across every library — for tool schemas. */
export const ADDON_IDS = [...new Set(
  Object.values(LIBRARIES).flatMap((l) => Object.keys(l.addons || {})),
)];
