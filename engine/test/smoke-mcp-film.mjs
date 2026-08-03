/**
 * Full-film MCP smoke against REAL vendors — the linux-ready-plan §L4
 * acceptance script, kept generic. Drives the stdio MCP server through a
 * complete film: piper speech (sentence timings) + node-vendor music + tone
 * SFX → render both scenes → build_film → transcribe the delivered MP4 back
 * with whisper.cpp and assert the narration survived. ffprobe-verifiable
 * output path is printed on success.
 *
 * Deliberately NOT part of `npm test` (the suite fakes the vendors). Run
 * from engine/ with the real-vendor env hooks set:
 *
 *   MOTION_STUDIO_PIPER_EXE or MOTION_STUDIO_PIPER_PYTHON
 *   MOTION_STUDIO_PIPER_VOICES
 *   MOTION_STUDIO_WHISPER_BIN, MOTION_STUDIO_WHISPER_MODEL
 *   MOTION_STUDIO_SOUNDFONT
 *
 * Optional: MOTION_STUDIO_SMOKE_WORKSPACE (default mcp-film-smoke). The
 * workspace's film from a previous run is removed first, so the smoke is
 * rerunnable. Exit 0 = every stage passed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const need = (name, alt) => {
  if (process.env[name]) return;
  if (alt && process.env[alt]) return;
  console.error(`FAIL: ${name}${alt ? ` (or ${alt})` : ''} must be set — this smoke needs real vendors`);
  process.exit(1);
};
need('MOTION_STUDIO_PIPER_EXE', 'MOTION_STUDIO_PIPER_PYTHON');
need('MOTION_STUDIO_PIPER_VOICES');
need('MOTION_STUDIO_WHISPER_BIN');
need('MOTION_STUDIO_WHISPER_MODEL');
need('MOTION_STUDIO_SOUNDFONT');

const WORKSPACE = process.env.MOTION_STUDIO_SMOKE_WORKSPACE || 'mcp-film-smoke';
const step = (m) => console.log(`>> ${m}`);
const die = (m, extra) => { console.error(`FAIL: ${m}`, extra ?? ''); process.exit(1); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js'],
  env: { ...process.env, MOTION_STUDIO_WORKSPACE: WORKSPACE, MOTION_STUDIO_TTS_VENDOR: 'piper' },
  stderr: 'pipe',
});
const client = new Client({ name: 'mcp-film-smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args = {}, { allowError = false } = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  const data = JSON.parse(text);
  if (res.isError && !allowError) die(`${name} errored`, JSON.stringify(data).slice(0, 800));
  return { ...data, isError: !!res.isError };
};

step('capabilities + vendors');
await call('get_capabilities');
for (const cap of ['speech', 'music', 'transcription']) {
  const v = await call('list_vendors', { capability: cap });
  if (!(v[cap]?.vendors ?? []).some((x) => x.available)) {
    die(`no available ${cap} vendor`, JSON.stringify(v).slice(0, 500));
  }
  console.log(`   ${cap}: available`);
}

step('create film + scenes (removing a previous smoke film if present)');
await call('remove_film', { film: 'l4-acceptance' }, { allowError: true });
await call('remove_film', { film: 'mcp-film-smoke' }, { allowError: true });
const dims = { fps: 30, width: 640, height: 360 };
const film = await call('create_film', { name: 'MCP Film Smoke', ...dims });
const intro = await call('create_scene', { film: film.film, name: 'intro', ...dims, durationInFrames: 240 });
const outro = await call('create_scene', { film: film.film, name: 'outro', ...dims, durationInFrames: 60 });

step('synthesize speech (piper, sentence timings)');
const speech = await call('synthesize_speech', {
  target: intro.scene, mode: 'attach', sentenceTimings: true,
  text: 'The quick brown fox jumps over the lazy dog. Motion Studio now runs on Linux.',
});
if (!speech.timings?.length) die('speech returned no timings', JSON.stringify(speech).slice(0, 500));
console.log(`   voice=${speech.voice} duration=${speech.durationSeconds}s sentences=${speech.timings.length}`);

step('synthesize music (node SoundFont vendor)');
const music = await call('synthesize_music', {
  target: outro.scene, mode: 'attach',
  spec: { bpm: 120, tracks: [{ program: 0, notes: [
    { pitch: 60, start: 0, duration: 0.5 }, { pitch: 64, start: 0.5, duration: 0.5 },
    { pitch: 67, start: 1, duration: 0.5 }, { pitch: 72, start: 1.5, duration: 0.5 },
  ] }] },
});
console.log(`   vendor=${music.vendor} peakDb=${music.peakDb}`);

step('synthesize sfx (tone)');
await call('synthesize_sfx', {
  target: outro.scene, mode: 'attach', gainDb: -12,
  spec: { cues: [{ atFrame: 0, type: 'tone', pitch: 72, gain: 0.3, decay: 0.4 }] },
});

const waitJobs = async (ids, what) => {
  for (let i = 0; i < 120; i++) {
    const w = await call('wait_for_render', { jobIds: ids, timeoutMs: 30000 });
    const bad = w.jobs.find((j) => j.state === 'error' || j.state === 'cancelled');
    if (bad) die(`${what} failed`, JSON.stringify(bad).slice(0, 900));
    if (!w.timedOut && w.jobs.every((j) => j.state === 'done')) return w.jobs;
  }
  die(`${what} timed out`);
};

step('render both scenes');
const jobIds = [];
for (const sc of [intro.scene, outro.scene]) {
  const r = await call('render', { scene: sc, preflight: false });
  jobIds.push(r.jobId);
}
await waitJobs(jobIds, 'scene renders');

step('build film');
const plan = await call('build_film', { film: film.film, plan: true });
if (plan.problems?.length) die('build plan has problems', JSON.stringify(plan.problems).slice(0, 800));
const build = await call('build_film', { film: film.film });
const [buildDone] = await waitJobs([build.jobId], 'build');
const outputPath = build.outputPath ?? buildDone.outputPath;
if (!outputPath || !fs.existsSync(outputPath)) die('build output missing', outputPath);
console.log(`   built: ${outputPath} promoted=${buildDone.promoted}`);

step('transcribe the delivered MP4 back (whisper.cpp)');
const ws = await call('get_workspace');
await fsp.copyFile(outputPath, path.join(ws.path, 'library', 'film-smoke-delivery.mp4'));
const transcript = await call('transcribe_asset', { path: 'film-smoke-delivery.mp4' });
const hay = JSON.stringify(transcript).toLowerCase();
const missing = ['quick', 'fox', 'lazy', 'linux'].filter((w) => !hay.includes(w));
if (missing.length) die(`transcript missing words: ${missing.join(',')}`, hay.slice(0, 1200));
console.log('   transcript ok — all expected words survived the deliverable');

console.log('MCP FILM SMOKE: PASS');
console.log(JSON.stringify({ output: outputPath, speechSeconds: speech.durationSeconds }));
process.exit(0);
