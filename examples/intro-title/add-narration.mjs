// Live demo of the v0.6 text-to-speech feature: the "synthesize_speech step".
//
// This does exactly what the synthesize_speech MCP tool does in `attach` mode,
// but as a standalone script so you can see it end to end:
//   1. synthesize narration to assets/narration.wav using the Windows TTS exe
//   2. read back the clip's duration in seconds AND frames
//   3. attach it to this project's audio tracks in project.json
//
// Run it from anywhere:  node examples/intro-title/add-narration.mjs
// Requires the TTS exe (see docs/tts-setup.md) — build it, or set
// MOTION_STUDIO_TTS_EXE. A later `render` folds the narration into the video.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveTtsExe, synthesizeSpeech, wavDurationSeconds, framesForDuration } from '../../engine/src/core/tts.js';
import { validateConfig } from '../../engine/src/core/project.js';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const assetRel = 'assets/narration.wav';
const narration = 'Motion Studio. Deterministic video, rendered entirely from code.';
const startInFrames = 24; // let the title settle for ~0.8s before the voice comes in

const ttsExe = resolveTtsExe();
const outAbs = path.join(projectDir, assetRel);
await fsp.mkdir(path.dirname(outAbs), { recursive: true });

console.log(`Synthesizing narration with ${path.basename(ttsExe)} …`);
const res = await synthesizeSpeech({ text: narration, outPath: outAbs, ttsExe });

// Duration is derived from the WAV header (what FFmpeg will actually mux).
const durationSeconds = await wavDurationSeconds(outAbs);

const cfgPath = path.join(projectDir, 'project.json');
const cfg = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
const durationInFrames = framesForDuration(durationSeconds, cfg.fps);

// Attach as an audio track (idempotent: replace any prior narration entry).
cfg.audio = [
  ...(cfg.audio ?? []).filter((t) => t.src !== assetRel),
  { src: assetRel, startInFrames },
];
validateConfig(cfg); // enforce the same invariants update_project_config would
await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

console.log(JSON.stringify({
  voice: res.voice,
  durationSeconds,
  durationInFrames,
  startInFrames,
  asset: assetRel,
  attachedTo: 'project.json → audio[]',
}, null, 2));

console.log(
  `\nNarration attached. Render to fold it into the video (needs Chromium + FFmpeg):\n` +
  `  cd engine && node src/cli/render.js --project ../examples/intro-title ` +
  `--output ../examples/intro-title/out/intro-title.mp4 --workers 3`,
);
