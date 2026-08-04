/**
 * Capability tiers (Slice 0 — vendor-boundary plan Phase 0.5, goal 10):
 * every capability reports which tier it belongs to and, when it is not
 * ready, the exact per-OS command that fixes it.
 *
 *   core       — rendering itself; without it there is no product
 *   free-local — works offline with zero accounts (may need one fetch/apt)
 *   pack       — an optional download this repo can fetch or build
 *   byok       — bring-your-own-key cloud vendors
 *
 * Existence-level checks only — no process is spawned, so this is safe to
 * call from get_capabilities on every task start. `checkTts`/`checkNodeMusic`
 * etc. remain the deep probes behind list_vendors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { vendorDir } from '../../core/paths.js';
import { resolveTtsExeInfo } from './speech/system.js';
import { resolveSoundFont } from './music/fluidsynth.js';
import { resolveWhisper } from './transcription/whisper-cpp.js';
import { describeBrowserResolution } from '../../core/browser.js';

const linux = () => process.platform === 'linux';
const mac = () => process.platform === 'darwin';

async function browserTier() {
  const resolution = describeBrowserResolution();
  let executable = resolution.executablePath;
  if (!executable) {
    try {
      const puppeteer = (await import('puppeteer')).default;
      try { executable = puppeteer.executablePath({ headless: 'shell' }); } catch { /* fall through */ }
      if (!executable || !fs.existsSync(executable)) {
        try { const full = puppeteer.executablePath(); if (full && fs.existsSync(full)) executable = full; } catch { /* keep shell answer */ }
      }
    } catch { executable = null; }
  }
  const ready = !!executable && fs.existsSync(executable);
  return {
    tier: 'core', ready, ...resolution,
    ...(ready ? { resolvedPath: executable } : {
      fix: 'Run "npm install" in engine/ so Puppeteer downloads chrome-headless-shell, or point MOTION_STUDIO_CHROME at an installed Chrome/Edge.',
    }),
  };
}

export async function capabilityTiers({ ffmpegReady = null } = {}) {
  const speech = resolveTtsExeInfo();
  const speechReady = fs.existsSync(speech.path);
  const soundfont = resolveSoundFont();
  const soundfontReady = fs.existsSync(soundfont);
  const whisper = resolveWhisper({});
  // A bare command name means "on PATH" — check the PATH entries ourselves
  // rather than spawning anything.
  const onPath = (name) => (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    const base = path.join(dir, name);
    return fs.existsSync(base) || (process.platform === 'win32' && fs.existsSync(`${base}.exe`));
  });
  const whisperBinReady = path.isAbsolute(whisper.command) || whisper.command.includes(path.sep)
    ? fs.existsSync(whisper.command)
    : onPath(whisper.command);
  const whisperModelReady = whisper.model
    ? fs.existsSync(whisper.model)
    : (!!whisper.modelsDir && fs.existsSync(whisper.modelsDir)
        && fs.readdirSync(whisper.modelsDir).some((f) => /^ggml-.*\.bin$/.test(f)));

  const keys = {
    azure: !!(process.env.MOTION_STUDIO_AZURE_SPEECH_KEY || process.env.AZURE_SPEECH_KEY || process.env.SPEECH_KEY),
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    pexels: !!process.env.PEXELS_API_KEY,
  };

  return {
    render: {
      tier: 'core',
      // ffmpeg readiness is the caller's (doctor's) measured answer when it
      // has one; existence of a browser is checked here either way.
      browser: await browserTier(),
      ...(ffmpegReady === null ? {} : { ffmpegReady }),
    },
    speech: {
      tier: 'free-local',
      ready: speechReady,
      vendor: 'system',
      source: speech.source,
      path: speech.path,
      note: 'zero-byte OS voices; scratch-narration quality — piper (pack) or a cloud key (byok) are the upgrades',
      ...(speechReady && speech.source === 'os' && linux()
        ? { requires: 'espeak-ng on PATH — "sudo apt install espeak-ng" if list_voices reports it missing' } : {}),
      ...(speechReady ? {} : {
        fix: 'The configured speech exe does not exist. Unset MOTION_STUDIO_TTS_EXE to use the per-platform OS backend.',
      }),
    },
    music: {
      tier: 'free-local',
      ready: soundfontReady,
      vendor: 'node',
      soundfont,
      ...(soundfontReady ? {} : {
        fix: 'Run "npm run fetch-soundfont" in engine/ — one verified download of the MIT-licensed MuseScore_General.sf3.',
      }),
    },
    sfx: { tier: 'core', ready: true },
    transcription: {
      tier: 'pack',
      ready: whisperBinReady && whisperModelReady,
      binReady: whisperBinReady,
      modelReady: whisperModelReady,
      ...(whisperBinReady && whisperModelReady ? {} : {
        fix: linux() || mac()
          ? 'Build whisper.cpp (cmake -DBUILD_SHARED_LIBS=OFF, target whisper-cli), fetch a ggml-*.bin model from huggingface.co/ggerganov/whisper.cpp, and set MOTION_STUDIO_WHISPER_BIN / MOTION_STUDIO_WHISPER_MODEL.'
          : `Download a whisper.cpp Windows release and a ggml-*.bin model, then set MOTION_STUDIO_WHISPER_BIN and MOTION_STUDIO_WHISPER_MODEL (or place them under ${path.join(vendorDir(), 'whisper')}).`,
      }),
    },
    cloud: {
      tier: 'byok',
      keysPresent: keys,
      note: 'presence only — values are never read into reports',
    },
  };
}
