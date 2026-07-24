/*
 * Babylon.js starter — __PROJECT_NAME__ (__DURATION__ frames @ __FPS__ fps).
 *
 * DETERMINISM (required by the frame-driven render):
 *   - No engine.runRenderLoop(); call scene.render() inside setFrame.
 *   - No ParticleSystem / scene.beginAnimation() — both are wall-clock based.
 *     Drive transforms from the injected `frame`.
 *   - preserveDrawingBuffer + a GL finish() each frame let the headless
 *     screenshot capture it. (If you add a DefaultRenderingPipeline, set
 *     grain.animated = false so film grain stays deterministic.)
 *   - Compile shaders BEFORE the first frame (the async block below). Babylon
 *     compiles materials lazily and skips not-ready meshes on the first render,
 *     so a single-frame capture (still / preview / frame 0) would come back
 *     blank. Call forceCompilationAsync on every mesh material first.
 * Edit freely below.
 */
/* global BABYLON, MotionStudio, interpolate */

const W = __WIDTH__, H = __HEIGHT__, FPS = __FPS__, DURATION = __DURATION__;
const canvas = document.getElementById('gl');

const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }, false);
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.02, 0.025, 0.05, 1);

const camera = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, 1.2, -6), scene);
camera.setTarget(BABYLON.Vector3.Zero());
camera.fov = 0.8;

const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0.3, 1, 0.2), scene);
hemi.intensity = 0.7;
const key = new BABYLON.DirectionalLight('key', new BABYLON.Vector3(-1, -1, 1), scene);
key.intensity = 1.6;

const glow = new BABYLON.GlowLayer('glow', scene);
glow.intensity = 0.8;

const box = BABYLON.MeshBuilder.CreateBox('box', { size: 2 }, scene);
const mat = new BABYLON.StandardMaterial('mat', scene);
mat.diffuseColor = new BABYLON.Color3(0.28, 0.6, 1.0);
mat.emissiveColor = new BABYLON.Color3(0.03, 0.08, 0.18); // subtle self-glow (GlowLayer picks it up)
mat.specularColor = new BABYLON.Color3(0.2, 0.3, 0.4);
box.material = mat;

(async () => {
  // Warm up shader compilation before the first captured frame (see header).
  await Promise.all(scene.meshes.filter((m) => m.material).map((m) => m.material.forceCompilationAsync(m).catch(() => {})));

  MotionStudio.registerComposition((frame) => {
    box.rotation.y = frame * 0.03;
    box.rotation.x = Math.sin(frame * 0.02) * 0.5;

    scene.render();
    if (gl) gl.finish(); // flush so the screenshot captures this frame
  });
})();
