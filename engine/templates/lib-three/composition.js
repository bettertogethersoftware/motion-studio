/*
 * Three.js starter — __PROJECT_NAME__ (__DURATION__ frames @ __FPS__ fps).
 *
 * DETERMINISM (required by the frame-driven render): drive everything from the
 * injected `frame`. Do NOT use THREE.Clock/getDelta() or requestAnimationFrame.
 * The renderer uses preserveDrawingBuffer + a GL finish() each frame so the
 * headless screenshot captures it. Edit freely below.
 */
/* global THREE, MotionStudio, interpolate */

const W = __WIDTH__, H = __HEIGHT__, FPS = __FPS__, DURATION = __DURATION__;
const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputEncoding = THREE.sRGBEncoding;
const gl = renderer.getContext();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060f);

const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
camera.position.set(0, 0, 6);

scene.add(new THREE.AmbientLight(0x2a3a55, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 4, 5);
scene.add(key);

const mesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.7, 0),
  new THREE.MeshStandardMaterial({ color: 0x4da3ff, roughness: 0.35, metalness: 0.1, flatShading: true }),
);
scene.add(mesh);

// Compile shaders up front so the first captured frame isn't blank.
renderer.compile(scene, camera);

MotionStudio.registerComposition((frame) => {
  const t = frame / DURATION;
  mesh.rotation.y = frame * 0.03;
  mesh.rotation.x = Math.sin(frame * 0.02) * 0.5;
  camera.position.x = Math.sin(t * Math.PI * 2) * 1.5;
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
  gl.finish(); // flush so the screenshot captures this frame
});
