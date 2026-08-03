/**
 * Render-format matrix smoke against a REAL browser (linux-ready follow-up:
 * "extend linux-render beyond real-chromium.test.js"). Renders one tiny
 * scaffolded scene through every deliverable format — mp4, webm (with real
 * VP9 alpha), gif, prores (4444 alpha), png-sequence — plus a parallel
 * 2-worker render and a cancellation, verifying each output with ffprobe.
 *
 * Deliberately NOT part of `npm test` (needs a resolvable Chromium and real
 * FFmpeg). CI's linux-render job runs it after the gated suite; it also runs
 * on any dev machine (`node test/smoke-render-formats.mjs` from engine/).
 * Exit 0 = every format verified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileP = promisify(execFile);
const WORKSPACE = process.env.MOTION_STUDIO_SMOKE_WORKSPACE || 'render-format-smoke';
const FFPROBE = process.env.MOTION_STUDIO_FFPROBE || 'ffprobe';
const step = (m) => console.log(`>> ${m}`);
const die = (m, extra) => { console.error(`FAIL: ${m}`, extra ?? ''); process.exit(1); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js'],
  env: { ...process.env, MOTION_STUDIO_WORKSPACE: WORKSPACE },
  stderr: 'pipe',
});
const client = new Client({ name: 'render-format-smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args = {}, { allowError = false } = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  const data = JSON.parse(text);
  if (res.isError && !allowError) die(`${name} errored`, JSON.stringify(data).slice(0, 800));
  return data;
};

const probe = async (file) => {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height',
    '-show_entries', 'stream_tags=alpha_mode',
    '-show_entries', 'format=duration', '-of', 'json', file,
  ]);
  return JSON.parse(stdout);
};

const waitJobs = async (ids, what) => {
  for (let i = 0; i < 60; i++) {
    const w = await call('wait_for_render', { jobIds: ids, timeoutMs: 30000 });
    const bad = w.jobs.find((j) => j.state === 'error');
    if (bad) die(`${what} failed`, JSON.stringify(bad).slice(0, 900));
    if (!w.timedOut && w.jobs.every((j) => ['done', 'cancelled'].includes(j.state))) return w.jobs;
  }
  die(`${what} timed out`);
};

step('create film + scene');
await call('remove_film', { film: 'render-format-smoke' }, { allowError: true });
const dims = { fps: 30, width: 160, height: 120 };
const film = await call('create_film', { name: 'Render Format Smoke', ...dims });
const scene = await call('create_scene', { film: film.film, name: 'matrix', ...dims, durationInFrames: 12 });

const MATRIX = [
  { format: 'mp4', transparent: false, codec: 'h264', pixFmt: 'yuv420p' },
  { format: 'webm', transparent: true, codec: 'vp9', pixFmt: 'yuva420p' },
  { format: 'gif', transparent: false, codec: 'gif', pixFmt: null },
  // prores_ks encodes 4444 from yuva444p10le input, but ProRes 4444 carries
  // 12-bit alpha and ffprobe reports the decoded yuva444p12le — accept both.
  { format: 'prores', transparent: true, codec: 'prores', pixFmt: /^yuva444p1[02]le$/ },
];

for (const m of MATRIX) {
  step(`render ${m.format}${m.transparent ? ' (transparent)' : ''}`);
  await call('update_scene_config', {
    scene: scene.scene, patch: { output: { format: m.format, transparent: m.transparent } },
  });
  const r = await call('render', { scene: scene.scene, preflight: false });
  const [done] = await waitJobs([r.jobId], m.format);
  const out = done.outputPath ?? r.outputPath;
  if (!out || !fs.existsSync(out)) die(`${m.format}: output missing`, out);
  const info = await probe(out);
  const v = info.streams?.find((s) => s.codec_name);
  if (v?.codec_name !== m.codec) die(`${m.format}: codec ${v?.codec_name} != ${m.codec}`, JSON.stringify(info));
  // VP9 alpha lives in a second plane: ffprobe's native decoder reports
  // yuv420p and tags the container with alpha_mode=1 instead (the engine's
  // own tests accept either marker — see test/v05.test.js).
  const alphaTagged = v?.tags?.alpha_mode === '1';
  const pixOk = !m.pixFmt
    || (m.pixFmt instanceof RegExp ? m.pixFmt.test(v?.pix_fmt ?? '') : v?.pix_fmt === m.pixFmt);
  if (!pixOk && !(m.transparent && alphaTagged)) {
    die(`${m.format}: pix_fmt ${v?.pix_fmt} != ${m.pixFmt} and no alpha_mode tag`, JSON.stringify(info));
  }
  if (v?.width !== 160 || v?.height !== 120) die(`${m.format}: dims ${v?.width}x${v?.height}`, JSON.stringify(info));
  console.log(`   ${m.format}: ${v.codec_name}/${v.pix_fmt ?? '-'} ok`);
}

step('render png-sequence');
await call('update_scene_config', {
  scene: scene.scene, patch: { output: { format: 'png-sequence', transparent: true } },
});
const seq = await call('render', { scene: scene.scene, preflight: false });
const [seqDone] = await waitJobs([seq.jobId], 'png-sequence');
const seqOut = seqDone.outputPath ?? seq.outputPath;
const frames = fs.readdirSync(seqOut).filter((f) => f.endsWith('.png'));
if (frames.length !== 12) die(`png-sequence: expected 12 frames, got ${frames.length}`, seqOut);
const png = await probe(path.join(seqOut, frames[0]));
const pv = png.streams?.[0];
// The scaffold composition paints an opaque background, so the frames may
// legitimately be rgb24 — genuine alpha capture is real-chromium.test.js's
// job. Here we assert the sequence is complete, decodable, and sized right.
if (pv?.codec_name !== 'png') die(`png-sequence: first frame codec ${pv?.codec_name}`, JSON.stringify(png));
if (pv?.width !== 160 || pv?.height !== 120) die(`png-sequence: dims ${pv?.width}x${pv?.height}`, JSON.stringify(png));
console.log(`   png-sequence: ${frames.length} frames, ${pv.pix_fmt} ok`);

step('parallel workers (2)');
await call('update_scene_config', {
  scene: scene.scene, patch: { output: { format: 'mp4', transparent: false } },
});
const par = await call('render', { scene: scene.scene, preflight: false, workers: 2 });
await waitJobs([par.jobId], 'parallel render');
console.log('   parallel ok');

step('cancellation');
const big = await call('create_scene', { film: film.film, name: 'cancel-me', ...dims, durationInFrames: 600 });
const job = await call('render', { scene: big.scene, preflight: false });
const cancelled = await call('cancel_render', { jobId: job.jobId });
if (!['cancelled', 'cancelling', 'done'].includes(cancelled.state)) {
  die(`cancel_render state ${cancelled.state}`, JSON.stringify(cancelled));
}
const [after] = await waitJobs([job.jobId], 'cancelled job');
if (after.state !== 'cancelled' && after.state !== 'done') die(`post-cancel state ${after.state}`);
console.log(`   cancellation ok (final state: ${after.state})`);

console.log('RENDER FORMAT MATRIX: PASS');
process.exit(0);
