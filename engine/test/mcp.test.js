/**
 * MCP server integration tests: connect a real MCP client (official SDK) to
 * the server over stdio, exactly as Claude Desktop would, and drive the full
 * agent workflow: create project → write composition (incl. syntax-error
 * fast-fail and sandbox rejection) → capture preview frame → render → poll →
 * logs. Chromium is replaced via the env hook; ffmpeg is real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { startFakeAzure } from './helpers/fake-azure-speech.mjs';
import { writeTinySoundFont } from './helpers/tiny-soundfont.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/mcp/server.js');
const FAKE_BROWSER = path.resolve(__dirname, 'helpers/fake-browser-module.js');
const FAKE_TTS = path.resolve(__dirname, 'helpers/fake-tts.mjs');
const FAKE_MIDI = path.resolve(__dirname, 'helpers/fake-music.mjs');
const FAKE_FLUIDSYNTH = path.resolve(__dirname, 'helpers/fake-fluidsynth.mjs');
const FAKE_SOUNDFONT = path.resolve(__dirname, 'fixtures/fake.sf2');
const FAKE_WHISPER = path.resolve(__dirname, 'helpers/fake-whisper.mjs');

let haveFfmpeg = false;
let tmp, client, transport, fakeAzure, whisperModels;

before(async () => {
  try { await execFileP('ffmpeg', ['-version']); haveFfmpeg = true; } catch { /* skip below */ }
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-mcp-'));
  // The transcription vendor (v0.22) is a binary plus a model file; the stub
  // stands in for both, so the suite needs no 466 MB download.
  whisperModels = path.join(tmp, 'whisper-models');
  await fsp.mkdir(whisperModels, { recursive: true });
  await fsp.writeFile(path.join(whisperModels, 'ggml-small.en.bin'), Buffer.alloc(64, 1));
  // The Azure speech vendor (v0.17) is stubbed by a local HTTP server the child
  // process reaches through the same env hooks a user would set.
  fakeAzure = await startFakeAzure();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_TTS_EXE: FAKE_TTS,
      MOTION_STUDIO_MIDI_EXE: FAKE_MIDI,
      MOTION_STUDIO_FLUIDSYNTH: FAKE_FLUIDSYNTH,
      MOTION_STUDIO_SOUNDFONT: FAKE_SOUNDFONT,
      // Pinned, not inherited: the machine running the tests may have its own
      // vendors configured. The music vendor is pinned to the v0.8 exe chain
      // because these tests stub it; the `node` vendor gets its own server
      // below, with a real (tiny) SoundFont it can actually render.
      MOTION_STUDIO_TTS_VENDOR: 'system',
      MOTION_STUDIO_MUSIC_VENDOR: 'fluidsynth',
      MOTION_STUDIO_AZURE_SPEECH_KEY: 'test-key',
      MOTION_STUDIO_AZURE_SPEECH_ENDPOINT: fakeAzure.url,
      MOTION_STUDIO_WHISPER_BIN: FAKE_WHISPER,
      MOTION_STUDIO_WHISPER_MODELS: whisperModels,
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'ms-test-client', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
  await fakeAzure?.close();
});

const callJson = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { isError: !!res.isError, data: JSON.parse(text), content: res.content };
};

/**
 * v0.20: a scene lives inside a film, so the old one-call create_project is
 * now create_film + create_scene. Most tests just want "a scene with these
 * dimensions"; this gives them one, in a film of its own so their configs
 * cannot collide with another test's.
 *
 * @returns the create_scene result, whose `scene` field is the "<film>/<scene>" id
 */
let filmCounter = 0;
const makeScene = async (call, { name, ...dims }) => {
  const film = await call('create_film', { name: `${name} Film ${++filmCounter}`, ...dims });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  const scene = await call('create_scene', { film: film.data.film, name, ...dims });
  assert.equal(scene.isError, false, JSON.stringify(scene.data));
  return scene;
};
/** The same, on the shared client. */
const newScene = (opts) => makeScene((n, a) => callJson(n, a), opts);
/** create_scene's result id, for tools that take a target. */
const sceneOf = (res) => res.data.scene;

const schemaHasType = (schema, type) => {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type))) return true;
  return Object.values(schema).some((value) => {
    if (Array.isArray(value)) return value.some((item) => schemaHasType(item, type));
    return schemaHasType(value, type);
  });
};

test('mcp: nullable numeric fields publish numeric JSON schemas', async () => {
  const { tools } = await client.listTools();
  const tool = (name) => tools.find((candidate) => candidate.name === name);
  const property = (name, key) => tool(name)?.inputSchema?.properties?.[key];

  for (const [name, key] of [
    ['update_film', 'audioTargetPeakDb'],
    ['build_film', 'audioTargetPeakDb'],
  ]) {
    const schema = property(name, key);
    assert.ok(schemaHasType(schema, 'number'), `${name}.${key} must publish a numeric type`);
    assert.ok(schemaHasType(schema, 'null'), `${name}.${key} must permit null`);
  }

  const widthPct = tool('update_film')?.inputSchema?.properties?.overlays?.items?.properties?.widthPct;
  assert.ok(schemaHasType(widthPct, 'number'), 'update_film.overlays[].widthPct must publish a numeric type');
  assert.ok(schemaHasType(widthPct, 'null'), 'update_film.overlays[].widthPct must permit null');
});

test('mcp: exposes the full spec tool surface', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  for (const required of [
    // v0.20 storage model: workspace → film → scene
    'get_workspace', 'list_films', 'create_film', 'get_film', 'update_film', 'remove_film',
    'create_scene', 'get_scene', 'remove_scene', 'update_scene_config',
    'list_shared_assets', 'use_shared_asset',
    'read_composition_file',
    'write_composition_file', 'capture_preview_frame', 'render',
    'get_render_status', 'cancel_render', 'list_render_jobs', 'get_logs',
    // new in v0.5
    'render_still', 'write_asset_file',
    // new in v0.6 (text-to-speech)
    'synthesize_speech', 'list_voices',
    // new in v0.7 (3D libraries)
    'add_library',
    // new in v0.8 (music generation)
    'synthesize_music',
    // new in v0.9 (film assembly)
    'build_film',
    // new in v0.11 (shared-file sync)
    'sync_shared_files',
    // new in v0.12 (sound effects)
    'synthesize_sfx',
    // new in v0.10 (batched preview)
    'capture_preview_frames',
    // new in v0.14 (blocking wait)
    'wait_for_render',
    // new in v0.15 (asset management)
    'list_assets', 'delete_asset', 'rename_asset',
    // new in v0.17 (speech + music vendors)
    'list_vendors',
    // new in v0.19 (audio-only mixdown)
    'preview_audio',
    // new in v0.21 (media introspection)
    'probe_asset',
    // new in v0.22 (reading supplied speech)
    'transcribe_asset',
    // new in v0.22 (preparing media inside the tool surface)
    'transcode_asset',
    // new in v0.23 (reviewing the encoded deliverable)
    'inspect_render', 'measure_render',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
});

test('mcp: resources include frame-api reference', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes('motion-studio://reference/frame-api'), uris.join(','));
  const doc = await client.readResource({ uri: 'motion-studio://reference/frame-api' });
  assert.match(doc.contents[0].text, /registerComposition|setFrame/);
});

let sceneId;

test('mcp: create_film + create_scene scaffold, and the workspace lists them', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await callJson('create_film', {
    name: 'Agent Demo', fps: 30, width: 320, height: 240, durationInFrames: 20,
  });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  assert.equal(film.data.film, 'agent-demo', 'the film id is the slug of its name');
  assert.deepEqual(film.data.sceneDefaults, { fps: 30, width: 320, height: 240, durationInFrames: 20 });

  const { isError, data } = await callJson('create_scene', { film: film.data.film, name: 'Main' });
  assert.equal(isError, false, JSON.stringify(data));
  sceneId = data.scene;
  assert.equal(sceneId, 'agent-demo/main', 'scene ids are film/scene, workspace-local');
  // The film's sceneDefaults are inherited, which is what keeps scenes concatenable.
  assert.equal(data.config.width, 320);
  assert.equal(data.config.durationInFrames, 20);
  assert.ok(data.files.some((f) => f.path === 'composition.js'));
  assert.ok(fs.existsSync(path.join(data.path, 'frame-api.js')));

  const list = await callJson('list_films');
  assert.equal(list.data.films.length, 1);
  assert.equal(list.data.films[0].film, 'agent-demo');
  assert.equal(list.data.films[0].sceneLayout.length, 1);

  // The workspace is this server's own — every id above is relative to it.
  const ws = await callJson('get_workspace');
  assert.equal(ws.data.workspace, 'default');
  assert.equal(ws.data.films.length, 1);
});

test('mcp: write with syntax error fails fast with structured code', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('write_composition_file', {
    scene: sceneId, path: 'composition.js', content: 'function ( { nope',
  });
  assert.equal(isError, true);
  assert.equal(data.code, 'syntax_error');
  assert.match(data.message, /Syntax error/);
});

test('mcp: path traversal rejected with path_not_allowed', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('write_composition_file', {
    scene: sceneId, path: '../../evil.js', content: '1',
  });
  assert.equal(isError, true);
  assert.equal(data.code, 'path_not_allowed');
});

test('mcp: read/write round trip', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ok = await callJson('write_composition_file', {
    scene: sceneId, path: 'composition.js',
    content: 'MotionStudio.registerComposition(function (f) { /* agent edit */ });\n',
  });
  assert.equal(ok.isError, false);
  const read = await callJson('read_composition_file', { scene: sceneId, path: 'composition.js' });
  assert.match(read.data.content, /agent edit/);
});

test('mcp: capture_preview_frame returns an image content block', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await client.callTool({ name: 'capture_preview_frame', arguments: { scene: sceneId, frame: 3 } });
  assert.ok(!res.isError, JSON.stringify(res.content));
  const img = res.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  const bytes = Buffer.from(img.data, 'base64');
  assert.deepEqual([...bytes.subarray(1, 4)], [...Buffer.from('PNG')]);
});

test('mcp: out-of-range preview frame → invalid_config', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('capture_preview_frame', { scene: sceneId, frame: 999 });
  assert.equal(isError, true);
  assert.equal(data.code, 'invalid_config');
});

test('mcp: render → status poll → done → logs', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const start = await callJson('render', { scene: sceneId, frameRange: [0, 9] });
  assert.equal(start.isError, false, JSON.stringify(start.data));
  const { jobId, outputPath, totalFrames } = start.data;
  assert.equal(totalFrames, 10);

  let status;
  const deadline = Date.now() + 30_000;
  do {
    await new Promise((r) => setTimeout(r, 100));
    status = (await callJson('get_render_status', { jobId })).data;
  } while (status.state === 'running' && Date.now() < deadline);

  assert.equal(status.state, 'done', JSON.stringify(status));
  assert.equal(status.framesDone, 10);
  assert.ok(fs.existsSync(outputPath));

  const logs = (await callJson('get_logs', { jobId })).data.logs;
  assert.ok(logs.some((l) => /phase: encoding/.test(l.message)));

  const jobsList = (await callJson('list_render_jobs')).data.jobs;
  assert.equal(jobsList[0].jobId, jobId);
});

test('mcp: unknown scene → scene_not_found; a malformed id → invalid_id', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('get_scene', { scene: 'no-film/no-scene' });
  assert.equal(isError, true);
  assert.equal(data.code, 'scene_not_found');
  // A bare word is not a scene id at all — that is a different mistake.
  const malformed = await callJson('get_scene', { scene: 'nope' });
  assert.equal(malformed.data.code, 'invalid_id');
});

test('mcp: a server cannot address another workspace, even by guessing its slug', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // Ids are workspace-LOCAL: this server qualifies every one with its own
  // workspace before touching the store. A fully-qualified id from another
  // workspace therefore has one segment too many and is refused as malformed,
  // rather than resolving into someone else's tree. This is the isolation
  // guarantee that lets two agents work at once.
  const otherFilm = await callJson('get_film', { film: 'other-workspace/their-film' });
  assert.equal(otherFilm.isError, true);
  assert.equal(otherFilm.data.code, 'invalid_id');

  const otherScene = await callJson('get_scene', { scene: 'other-workspace/their-film/their-scene' });
  assert.equal(otherScene.isError, true);
  assert.equal(otherScene.data.code, 'invalid_id');

  // Traversal through an id is refused by the same slug rule.
  for (const bad of ['../escape', 'a/../../escape', 'C:/Windows']) {
    const res = await callJson('get_film', { film: bad });
    assert.equal(res.isError, true, `expected refusal for ${bad}`);
    assert.equal(res.data.code, 'invalid_id', `expected invalid_id for ${bad}`);
  }
});

/* ----------------------------- v0.5 tools ----------------------------- */

test('mcp: render returns state and queues concurrent submissions (v0.5)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const a = await callJson('render', { scene: sceneId });
  assert.equal(a.isError, false, JSON.stringify(a.data));
  assert.equal(a.data.state, 'running');
  const b = await callJson('render', { scene: sceneId });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  assert.equal(b.data.state, 'queued');
  assert.equal(b.data.queuePosition, 1);
  // Cancel the queued one, then wait for the first to finish.
  const cancelled = await callJson('cancel_render', { jobId: b.data.jobId });
  assert.equal(cancelled.data.state, 'cancelled');
  for (let i = 0; i < 200; i++) {
    const { data } = await callJson('get_render_status', { jobId: a.data.jobId });
    if (data.state !== 'running' && data.state !== 'queued') {
      assert.equal(data.state, 'done', JSON.stringify(data));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('mcp: render_still writes a PNG into out/ and rejects bad filenames', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ok1 = await callJson('render_still', { scene: sceneId, frame: 3 });
  assert.equal(ok1.isError, false, JSON.stringify(ok1.data));
  assert.ok(ok1.data.outputPath.endsWith('still-3.png'));
  assert.ok(fs.existsSync(ok1.data.outputPath));
  const bad = await callJson('render_still', { scene: sceneId, frame: 0, outputFilename: '../evil.png' });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'path_not_allowed');
});

test('mcp: write_asset_file round-trips base64 and enforces the sandbox', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const bytes = Buffer.from('{"brand":"#f9564f"}', 'utf8');
  const w = await callJson('write_asset_file', {
    target: sceneId, path: 'assets/brand.json', contentBase64: bytes.toString('base64'),
  });
  assert.equal(w.isError, false, JSON.stringify(w.data));
  assert.equal(w.data.written.bytes, bytes.length);
  const r = await callJson('read_composition_file', { scene: sceneId, path: 'assets/brand.json' });
  assert.equal(r.data.content, bytes.toString('utf8'));
  const outside = await callJson('write_asset_file', {
    target: sceneId, path: 'brand.json', contentBase64: bytes.toString('base64'),
  });
  assert.equal(outside.isError, true);
  assert.equal(outside.data.code, 'path_not_allowed');
});

test('mcp: list_assets reports kind and audio reference counts (v0.15)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const wav = Buffer.alloc(1024, 3).toString('base64');
  await callJson('write_asset_file', { target: sceneId, path: 'assets/bed.wav', contentBase64: wav });
  await callJson('write_asset_file', { target: sceneId, path: 'assets/spare.wav', contentBase64: wav });
  await callJson('update_scene_config', {
    scene: sceneId,
    patch: { audio: [{ src: 'assets/bed.wav', startInFrames: 0, gainDb: -4 }] },
  });

  const list = await callJson('list_assets', { target: sceneId });
  assert.equal(list.isError, false, JSON.stringify(list.data));
  const bed = list.data.files.find((f) => f.path === 'assets/bed.wav');
  const spare = list.data.files.find((f) => f.path === 'assets/spare.wav');
  assert.equal(bed.kind, 'audio');
  assert.equal(bed.audioRefs, 1, 'referenced file reports its usage');
  assert.equal(spare.audioRefs, 0, 'orphaned file is distinguishable');
  assert.equal(bed.bytes, 1024);
});

test('mcp: rename_asset repoints audio tracks and refuses to clobber (v0.15)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const renamed = await callJson('rename_asset', {
    target: sceneId, from: 'assets/bed.wav', to: 'assets/audio/bed.wav', updateAudio: true,
  });
  assert.equal(renamed.isError, false, JSON.stringify(renamed.data));
  assert.equal(renamed.data.audioRefs, 1);
  assert.equal(renamed.data.audioTracksUpdated, 1);
  assert.equal(renamed.data.audio[0].src, 'assets/audio/bed.wav');
  assert.equal(renamed.data.audio[0].gainDb, -4, 'track settings survive the move');

  const clobber = await callJson('rename_asset', {
    target: sceneId, from: 'assets/spare.wav', to: 'assets/audio/bed.wav',
  });
  assert.equal(clobber.isError, true);
  assert.equal(clobber.data.code, 'invalid_config');

  const escape = await callJson('rename_asset', {
    target: sceneId, from: 'assets/spare.wav', to: '../escaped.wav',
  });
  assert.equal(escape.isError, true);
  assert.equal(escape.data.code, 'path_not_allowed');
});

test('mcp: delete_asset reports references and only strips tracks when asked (v0.15)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // Without the flag the track survives — but the agent is told it now dangles.
  const kept = await callJson('delete_asset', { target: sceneId, path: 'assets/audio/bed.wav' });
  assert.equal(kept.isError, false, JSON.stringify(kept.data));
  assert.equal(kept.data.deleted, true);
  assert.equal(kept.data.audioRefs, 1);
  assert.equal(kept.data.audioTracksRemoved, 0);
  const still = await callJson('get_scene', { scene: sceneId });
  assert.equal(still.data.config.audio.length, 1, 'reference deliberately left in place');

  // Restore it and delete again, this time cleaning the timeline.
  await callJson('write_asset_file', {
    target: sceneId, path: 'assets/audio/bed.wav', contentBase64: Buffer.alloc(512, 9).toString('base64'),
  });
  const cleaned = await callJson('delete_asset', {
    target: sceneId, path: 'assets/audio/bed.wav', updateAudio: true,
  });
  assert.equal(cleaned.data.audioTracksRemoved, 1);
  assert.deepEqual(cleaned.data.audio, []);

  const missing = await callJson('delete_asset', { target: sceneId, path: 'assets/audio/bed.wav' });
  assert.equal(missing.isError, true);
  assert.equal(missing.data.code, 'file_not_found');

  const outside = await callJson('delete_asset', { target: sceneId, path: 'composition.js' });
  assert.equal(outside.isError, true);
  assert.equal(outside.data.code, 'path_not_allowed');
  const proj = await callJson('get_scene', { scene: sceneId });
  assert.ok(fs.existsSync(path.join(proj.data.path, 'composition.js')), 'sandbox kept the source file');
});

test('mcp: remove_scene drops it from the film (files kept by default)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const made = await newScene({ name: 'Disposable', fps: 30, width: 320, height: 240, durationInFrames: 10 });
  const rm = await callJson('remove_scene', { scene: sceneOf(made) });
  assert.equal(rm.isError, false, JSON.stringify(rm.data));
  assert.equal(rm.data.removed, true);
  assert.equal(rm.data.filesDeleted, false);
  assert.ok(fs.existsSync(path.join(made.data.path, 'scene.json')), 'the folder stays');
  // It left the film's play order…
  const info = await callJson('get_film', { film: sceneOf(made).split('/')[0] });
  assert.deepEqual(info.data.scenes, [], 'dropped from the play order');
  // …but the folder is still readable, which is what "unlisted" means: nothing
  // an agent made disappears without an explicit deleteFiles.
  const still = await callJson('get_scene', { scene: sceneOf(made) });
  assert.equal(still.isError, false, JSON.stringify(still.data));

  const purged = await callJson('remove_scene', { scene: sceneOf(made), deleteFiles: true });
  assert.equal(purged.data.filesDeleted, true);
  const gone = await callJson('get_scene', { scene: sceneOf(made) });
  assert.equal(gone.isError, true);
  assert.equal(gone.data.code, 'scene_not_found');
});

test('mcp: update_scene_config switches format and fixes the filename extension (v0.5)', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('update_scene_config', {
    scene: sceneId, patch: { output: { format: 'webm', transparent: true } },
  });
  assert.equal(isError, false, JSON.stringify(data));
  assert.equal(data.config.output.format, 'webm');
  assert.equal(data.config.output.transparent, true);
  assert.ok(data.config.output.filename.endsWith('.webm'), data.config.output.filename);
  // transparent mp4 is rejected by validation
  const bad = await callJson('update_scene_config', {
    scene: sceneId, patch: { output: { format: 'mp4', transparent: true } },
  });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'invalid_config');
  // restore mp4 for any later tests
  await callJson('update_scene_config', { scene: sceneId, patch: { output: { format: 'mp4', transparent: false } } });
});

/* --------------------------- v0.6 text-to-speech --------------------------- */

test('mcp: synthesize_speech attach mode adds an audio track and reports frames', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('synthesize_speech', {
    target: sceneId, text: 'Welcome to Motion Studio.', voice: 'Microsoft David Desktop', mode: 'attach',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, true);
  assert.equal(res.data.mode, 'attach');
  assert.equal(res.data.assetPath, 'assets/narration-1.wav');
  // Stub clip is 1.0s; project fps is 30 → ceil(1.0 * 30) = 30 frames.
  assert.equal(res.data.durationInFrames, 30);
  assert.equal(res.data.fps, 30);

  const proj = await callJson('get_scene', { scene: sceneId });
  assert.ok(fs.existsSync(path.join(proj.data.path, 'assets', 'narration-1.wav')));
  assert.ok(
    (proj.data.config.audio ?? []).some((tk) => tk.src === 'assets/narration-1.wav'),
    JSON.stringify(proj.data.config.audio),
  );
});

test('mcp: preview_audio is a cancellable job and returns its mix report through wait_for_render', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('preview_audio', { target: sceneId, waitMs: 0 });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.ok(res.data.jobId, JSON.stringify(res.data));

  const job = res.data.stillRunning
    ? (await callJson('wait_for_render', { jobIds: [res.data.jobId], timeoutMs: 20_000 })).data.jobs[0]
    : { state: 'done', kind: 'audio-preview', result: res.data };
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.equal(job.kind, 'audio-preview');
  assert.ok(job.result.mix, JSON.stringify(job.result));
});

test('mcp: synthesize_speech creates nested asset directories', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('synthesize_speech', {
    target: sceneId, text: 'Nested speech.', voice: 'Microsoft David Desktop',
    mode: 'asset-only', assetPath: 'assets/generated/narration.wav',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  const scene = await callJson('get_scene', { scene: sceneId });
  assert.ok(fs.existsSync(path.join(scene.data.path, 'assets', 'generated', 'narration.wav')));
});

test('mcp: synthesize_speech asset-only mode writes a WAV but leaves config.audio unchanged', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const before = await callJson('get_scene', { scene: sceneId });
  const beforeCount = (before.data.config.audio ?? []).length;

  const res = await callJson('synthesize_speech', {
    target: sceneId, text: 'Second clip, not attached.', voice: 'Microsoft Zira Desktop', mode: 'asset-only',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, false);
  assert.match(res.data.hint, /update_scene_config/);
  assert.ok(Number.isInteger(res.data.durationInFrames));

  const proj = await callJson('get_scene', { scene: sceneId });
  assert.ok(fs.existsSync(path.join(proj.data.path, ...res.data.assetPath.split('/'))));
  assert.equal((proj.data.config.audio ?? []).length, beforeCount);
});

test('mcp: sentenceTimings gap replaces vendor pacing and duration math adds up', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // Stub clips are exactly 1.0s each. Three sentences + two 0.5s gaps must
  // measure 4.0s — if the vendor's own trailing pad leaked in (the pre-v0.20
  // additive-gap bug), the clip would come out longer than clips + gaps.
  const res = await callJson('synthesize_speech', {
    target: sceneId, text: 'One. Two. Three.', voice: 'Microsoft David Desktop',
    mode: 'asset-only', sentenceTimings: true, sentenceGapSeconds: 0.5,
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.timings.length, 3);
  assert.deepEqual(res.data.timings.map((s) => s.text), ['One.', 'Two.', 'Three.']);
  assert.ok(Math.abs(res.data.durationSeconds - 4.0) < 0.05, `duration ${res.data.durationSeconds}`);
  assert.ok(Math.abs(res.data.timings[1].startSeconds - 1.5) < 0.05, JSON.stringify(res.data.timings[1]));
  assert.ok(Math.abs(res.data.timings[2].startSeconds - 3.0) < 0.05, JSON.stringify(res.data.timings[2]));
  // reportedDurationSeconds is the vendor's summed self-report + gaps — before
  // v0.20 it leaked the LAST sentence's duration (would be ~1.0 here).
  assert.ok(Math.abs(res.data.reportedDurationSeconds - 4.0) < 0.05,
    `reportedDurationSeconds ${res.data.reportedDurationSeconds}`);
});

test('mcp: deterministic flag is warned about, not dropped, on an unsupporting vendor', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('synthesize_speech', {
    target: sceneId, text: 'Pinned take.', voice: 'Microsoft David Desktop',
    mode: 'asset-only', deterministic: true,
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  // The warning names the vendors that DO support the flag (piper, elevenlabs).
  assert.ok(
    (res.data.warnings ?? []).some((w) => /deterministic.*piper and elevenlabs/i.test(w)),
    JSON.stringify(res.data.warnings),
  );
});

test('mcp: synthesize_speech rejects an assetPath outside assets/', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('synthesize_speech', {
    target: sceneId, text: 'x', voice: 'Microsoft David Desktop', assetPath: '../evil.wav',
  });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'path_not_allowed');
});

/* ---------------------------- v0.17 speech vendors -------------------------- */

test('mcp: list_vendors reports both capabilities and which vendor each will use', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('list_vendors');
  assert.equal(isError, false, JSON.stringify(data));

  assert.equal(data.speech.active, 'system');
  assert.equal(data.speech.activeSource, 'env'); // MOTION_STUDIO_TTS_VENDOR, pinned above
  const speech = Object.fromEntries(data.speech.vendors.map((v) => [v.id, v]));
  assert.equal(speech.system.available, true);
  assert.equal(speech.azure.available, true);
  assert.equal(speech.azure.voiceCount, 3);
  assert.equal(speech.system.offline, true);

  assert.equal(data.music.active, 'fluidsynth');
  const music = Object.fromEntries(data.music.vendors.map((v) => [v.id, v]));
  assert.equal(music.fluidsynth.available, true);
  assert.deepEqual(data.music.allVendors, ['node', 'fluidsynth']);

  // The preference chain must actually reach the agent: a fallback nobody can
  // see is the failure mode chains exist to avoid, and the tool description
  // has always promised these fields (they were dropped in projection until
  // v0.20). One-entry chains are the common case and must still report.
  for (const cap of [data.speech, data.music]) {
    assert.ok(Array.isArray(cap.chain), `chain missing: ${JSON.stringify(cap)}`);
    assert.equal(cap.preferred, cap.chain[0]);
    assert.equal(cap.fellBack, cap.active !== cap.preferred);
    // priority is the 1-based rank in the chain, or null outside it.
    for (const v of cap.vendors) {
      const expected = cap.chain.includes(v.id) ? cap.chain.indexOf(v.id) + 1 : null;
      assert.equal(v.priority, expected, `priority wrong for ${v.id}`);
    }
  }

  // Credentials are never echoed to an agent.
  assert.equal(JSON.stringify(data).includes('test-key'), false);
});

test('mcp: list_vendors can report one capability at a time', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { data } = await callJson('list_vendors', { capability: 'music', probe: false });
  assert.ok(data.music);
  assert.equal(data.speech, undefined);
  assert.equal(data.music.vendors[0].available, null); // probe: false
});

test('mcp: list_voices defaults to the active vendor and returns plain names for it', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { data } = await callJson('list_voices');
  assert.equal(data.vendor, 'system');
  assert.ok(data.voices.includes('Microsoft David Desktop'), JSON.stringify(data.voices));
});

test('mcp: list_voices filters the azure catalogue and carries styles', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { data } = await callJson('list_voices', { vendor: 'azure', locale: 'en' });
  assert.equal(data.vendor, 'azure');
  assert.equal(data.total, 2);
  const ava = data.voices.find((v) => v.name === 'en-US-AvaNeural');
  assert.deepEqual(ava.styles, ['cheerful', 'newscast']);

  const paged = await callJson('list_voices', { vendor: 'azure', limit: 1 });
  assert.equal(paged.data.returned, 1);
  assert.equal(paged.data.truncated, true);
  assert.match(paged.data.hint, /locale/);
});

test('mcp: synthesize_speech can name the azure vendor per call', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('synthesize_speech', {
    target: sceneId, text: 'The empire, in one breath.', vendor: 'azure', voice: 'en-US-AvaNeural',
    style: 'newscast', mode: 'asset-only',
  });
  assert.equal(isError, false, JSON.stringify(data));
  assert.equal(data.vendor, 'azure');
  assert.equal(data.vendorSource, 'argument');
  assert.equal(data.voice, 'en-US-AvaNeural');
  assert.equal(data.style, 'newscast');
  assert.equal(data.sampleRate, 24000);
  assert.equal(data.durationInFrames, 30); // 1.0s stub clip at 30fps
});

test('mcp: an unknown azure voice fails with unsupported_voice and suggestions', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { isError, data } = await callJson('synthesize_speech', {
    target: sceneId, text: 'x', vendor: 'azure', voice: 'en-US-NotAVoice', mode: 'asset-only',
  });
  assert.equal(isError, true);
  assert.equal(data.code, 'unsupported_voice');
  assert.ok(data.detail.suggestions.length > 0);
});

test('mcp: the system vendor reports the Azure-only options it ignored', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const { data } = await callJson('synthesize_speech', {
    target: sceneId, text: 'plain', vendor: 'system', style: 'cheerful', mode: 'asset-only',
  });
  assert.equal(data.vendor, 'system');
  assert.match((data.warnings ?? []).join(' '), /Azure-only/);
});

test('mcp: list_voices / synthesize_speech return tts_unavailable when the exe is missing', async () => {
  // A second server pointed at a nonexistent exe — no ffmpeg needed (TTS tools do not gate on prereqs).
  const badTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home-no-tts'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_TTS_EXE: path.join(tmp, 'no-such-tts.exe'),
      MOTION_STUDIO_TTS_VENDOR: 'system',
    },
    stderr: 'pipe',
  });
  const badClient = new Client({ name: 'ms-test-client-no-tts', version: '0.0.1' });
  await badClient.connect(badTransport);
  try {
    const res = await badClient.callTool({ name: 'list_voices', arguments: {} });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    assert.equal(!!res.isError, true);
    assert.equal(JSON.parse(text).code, 'tts_unavailable');
  } finally {
    await badClient.close().catch(() => {});
  }
});

/* ------------------------- ffmpeg binary resolution ------------------------- */
// The MCP server used to probe a bare "ffmpeg" on PATH regardless of the Studio's
// configured binary, so a machine with ffmpeg installed somewhere else worked in
// the web UI and returned prereqs_missing for every agent call. These drive the
// FAILURE path deliberately (a binary that cannot exist), so they need no real
// ffmpeg and run everywhere.

/** Connect a throwaway server with its own data dir + env, run `fn`, tear it down. */
async function withServer({ home, settings, env = {} }, fn) {
  const homeDir = path.join(tmp, home);
  if (settings) {
    await fsp.mkdir(homeDir, { recursive: true });
    await fsp.writeFile(path.join(homeDir, 'settings.json'), JSON.stringify(settings, null, 2));
  }
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, MOTION_STUDIO_HOME: homeDir, MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER, ...env },
    stderr: 'pipe',
  });
  const c = new Client({ name: `ms-test-${home}`, version: '0.0.1' });
  await c.connect(t);
  try {
    return await fn(async (name, args = {}) => {
      const res = await c.callTool({ name, arguments: args });
      const text = res.content.find((x) => x.type === 'text')?.text ?? '{}';
      return { isError: !!res.isError, data: JSON.parse(text) };
    });
  } finally {
    await c.close().catch(() => {});
  }
}

const BOGUS_FFMPEG = path.join(os.tmpdir(), 'motion-studio-no-such-ffmpeg-xyz');

test('mcp: prereq check honours settings.json ffmpeg.path', async () => {
  await withServer(
    { home: 'home-ffmpeg-settings', settings: { ffmpeg: { path: BOGUS_FFMPEG } } },
    async (call) => {
      const res = await call('get_workspace');
      // If settings were ignored we would probe PATH instead — which on a machine
      // WITH ffmpeg installed would succeed and make this assertion fail.
      assert.equal(res.isError, true);
      assert.equal(res.data.code, 'prereqs_missing');
      assert.equal(res.data.detail.ffmpeg.effectivePath, BOGUS_FFMPEG);
      assert.equal(res.data.detail.ffmpeg.source, 'settings');
      assert.equal(res.data.detail.ffmpeg.found, false);
      assert.match(res.data.message, /could not be run/);
    },
  );
});

test('mcp: MOTION_STUDIO_FFMPEG overrides settings.json', async () => {
  const envPath = BOGUS_FFMPEG + '-from-env';
  await withServer(
    {
      home: 'home-ffmpeg-env',
      settings: { ffmpeg: { path: BOGUS_FFMPEG } },
      env: { MOTION_STUDIO_FFMPEG: envPath },
    },
    async (call) => {
      const res = await call('get_workspace');
      assert.equal(res.data.code, 'prereqs_missing');
      assert.equal(res.data.detail.ffmpeg.effectivePath, envPath);
      assert.equal(res.data.detail.ffmpeg.source, 'env');
    },
  );
});

test('mcp: with no override the probe reports PATH as the source', async (t) => {
  if (haveFfmpeg) return t.skip('needs a machine without ffmpeg on PATH');
  await withServer({ home: 'home-ffmpeg-path' }, async (call) => {
    const res = await call('get_workspace');
    assert.equal(res.data.code, 'prereqs_missing');
    assert.equal(res.data.detail.ffmpeg.source, 'PATH');
    assert.match(res.data.message, /on PATH/);
  });
});

/* ------------------------ global settings reach the agent ------------------------ */
// "Global Settings" in the Studio means global: a film an agent creates without
// naming dimensions gets the user's defaults (as its sceneDefaults, which its
// scenes then inherit), and a render that doesn't name a worker count gets
// theirs. An explicit argument still wins.

test('mcp: create_film/create_scene and render honour the user\'s global settings', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withServer(
    {
      home: 'home-globals',
      settings: {
        newSceneDefaults: { fps: 24, width: 1280, height: 720, durationInFrames: 48 },
        render: { defaultWorkers: 2 },
        ffmpeg: { defaultCrf: 18, defaultPreset: 'slow' },
      },
    },
    async (call) => {
      // A film created with no dimensions takes the globals as its defaults…
      const film = await call('create_film', { name: 'globals' });
      assert.equal(film.isError, false, JSON.stringify(film.data));
      assert.deepEqual(film.data.sceneDefaults, { fps: 24, width: 1280, height: 720, durationInFrames: 48 });

      // …and its scenes inherit them.
      const made = await call('create_scene', { film: film.data.film, name: 'globals' });
      assert.equal(made.isError, false, JSON.stringify(made.data));
      assert.equal(made.data.config.fps, 24);
      assert.equal(made.data.config.width, 1280);
      assert.equal(made.data.config.height, 720);
      assert.equal(made.data.config.durationInFrames, 48);
      // Encode defaults seed the scaffold too — previously Studio-only.
      assert.equal(made.data.config.output.crf, 18);
      assert.equal(made.data.config.output.preset, 'slow');

      // An explicit argument beats the inherited default; the rest still fill in.
      const explicit = await call('create_scene', { film: film.data.film, name: 'globals-explicit', fps: 60, width: 1920 });
      assert.equal(explicit.data.config.fps, 60);
      assert.equal(explicit.data.config.width, 1920);
      assert.equal(explicit.data.config.height, 720);

      // render reports the worker count it actually used.
      const started = await call('render', { scene: made.data.scene, frameRange: [0, 1], preflight: false });
      assert.equal(started.data.workers, 2);
      const named = await call('render', { scene: made.data.scene, frameRange: [0, 1], workers: 1, preflight: false });
      assert.equal(named.data.workers, 1);
    },
  );
});

test('mcp: with no settings file the factory defaults still apply', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withServer({ home: 'home-no-settings' }, async (call) => {
    const made = await makeScene(call, { name: 'factory' });
    assert.equal(made.data.config.fps, 30);
    assert.equal(made.data.config.width, 1920);
    assert.equal(made.data.config.durationInFrames, 150);
    const started = await call('render', { scene: made.data.scene, frameRange: [0, 1], preflight: false });
    assert.equal(started.data.workers, 1);
  });
});

/* ---------------------------- v0.8 music generation ---------------------------- */
// The music toolchain (MIDI exe + fluidsynth + soundfont) is stubbed via env in the
// shared server. These need no ffmpeg — synthesize_music does not gate on prereqs.

const MUSIC_SPEC = {
  bpm: 96,
  tracks: [
    { program: 0, notes: [{ pitch: 72, start: 0, duration: 1 }, { pitch: 76, start: 1, duration: 1 }] },
    { program: 32, notes: [{ pitch: 48, start: 0, duration: 2 }] },
  ],
};

let musicSceneId;

test('mcp: synthesize_music attach mode writes a WAV and adds an audio track', async () => {
  const proj = await newScene({ name: 'Music MCP', fps: 30, width: 320, height: 240, durationInFrames: 30 });
  musicSceneId = sceneOf(proj);

  const res = await callJson('synthesize_music', { target: musicSceneId, spec: MUSIC_SPEC, mode: 'attach', gainDb: -8 });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, true);
  assert.equal(res.data.mode, 'attach');
  assert.equal(res.data.assetPath, 'assets/music-1.wav');
  assert.equal(res.data.bpm, 96);
  assert.equal(res.data.tracks, 2);
  assert.equal(res.data.notes, 3);
  assert.ok(res.data.bytes > 0);
  // Stub fluidsynth emits 0.25s; fps 30 → ceil(0.25 * 30) = 8 frames.
  assert.equal(res.data.durationInFrames, 8);
  assert.equal(res.data.fps, 30);

  const after = await callJson('get_scene', { scene: musicSceneId });
  assert.ok(fs.existsSync(path.join(after.data.path, 'assets', 'music-1.wav')));
  const track = (after.data.config.audio ?? []).find((tk) => tk.src === 'assets/music-1.wav');
  assert.ok(track, JSON.stringify(after.data.config.audio));
  assert.equal(track.gainDb, -8);
});

test('mcp: synthesize_music asset-only mode writes a WAV but leaves config.audio unchanged', async () => {
  const before = await callJson('get_scene', { scene: musicSceneId });
  const beforeCount = (before.data.config.audio ?? []).length;

  const res = await callJson('synthesize_music', { target: musicSceneId, spec: MUSIC_SPEC, mode: 'asset-only' });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, false);
  assert.match(res.data.hint, /update_scene_config/);
  assert.equal(res.data.assetPath, 'assets/music-2.wav');

  const after = await callJson('get_scene', { scene: musicSceneId });
  assert.ok(fs.existsSync(path.join(after.data.path, ...res.data.assetPath.split('/'))));
  assert.equal((after.data.config.audio ?? []).length, beforeCount);
});

test('mcp: synthesize_music creates nested asset directories', async () => {
  const res = await callJson('synthesize_music', {
    target: musicSceneId, spec: MUSIC_SPEC, mode: 'asset-only', assetPath: 'assets/generated/music.wav',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  const scene = await callJson('get_scene', { scene: musicSceneId });
  assert.ok(fs.existsSync(path.join(scene.data.path, 'assets', 'generated', 'music.wav')));
});

test('mcp: synthesize_music rejects an assetPath outside assets/', async () => {
  const res = await callJson('synthesize_music', { target: musicSceneId, spec: MUSIC_SPEC, assetPath: '../evil.wav' });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'path_not_allowed');
});

test('mcp: the node music vendor renders end-to-end with no exe at all', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // A second server with the cross-platform vendor and a real (tiny) SoundFont:
  // no MIDI exe, no fluidsynth, nothing to build.
  const soundfont = await writeTinySoundFont(tmp);
  const nodeTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home-node-music'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_MUSIC_VENDOR: 'node',
      MOTION_STUDIO_SOUNDFONT: soundfont,
      MOTION_STUDIO_MIDI_EXE: path.join(tmp, 'no-such-midi.exe'),
      MOTION_STUDIO_FLUIDSYNTH: path.join(tmp, 'no-such-fs.exe'),
    },
    stderr: 'pipe',
  });
  const nodeClient = new Client({ name: 'ms-test-client-node-music', version: '0.0.1' });
  await nodeClient.connect(nodeTransport);
  const call = async (name, args) => {
    const res = await nodeClient.callTool({ name, arguments: args });
    return { isError: !!res.isError, data: JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}') };
  };
  try {
    const vendors = await call('list_vendors', { capability: 'music' });
    const byId = Object.fromEntries(vendors.data.music.vendors.map((v) => [v.id, v]));
    assert.equal(vendors.data.music.active, 'node');
    assert.equal(byId.node.available, true, byId.node.error);
    assert.equal(byId.fluidsynth.available, false, 'the exe chain is deliberately absent here');

    const proj = await makeScene(call, { name: 'Node Music', fps: 30, width: 320, height: 240, durationInFrames: 20 });
    const music = await call('synthesize_music', { target: proj.data.scene, spec: MUSIC_SPEC, mode: 'attach' });
    assert.equal(music.isError, false, JSON.stringify(music.data));
    assert.equal(music.data.vendor, 'node');
    assert.equal(music.data.vendorSource, 'env');
    assert.equal(music.data.attached, true);
    assert.ok(music.data.durationInFrames > 0);
    assert.ok(typeof music.data.peakDb === 'number', 'the measured level is reported');
    assert.ok(fs.existsSync(path.join(proj.data.path, ...music.data.assetPath.split('/'))));
  } finally {
    await nodeClient.close().catch(() => {});
  }
});

test('mcp: synthesize_music returns music_unavailable when the toolchain is missing', async () => {
  const badTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: path.join(tmp, 'home-no-music'),
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_TTS_EXE: FAKE_TTS,
      MOTION_STUDIO_MUSIC_VENDOR: 'fluidsynth',
      MOTION_STUDIO_MIDI_EXE: path.join(tmp, 'no-such-midi.exe'),
      MOTION_STUDIO_FLUIDSYNTH: path.join(tmp, 'no-such-fs.exe'),
      MOTION_STUDIO_SOUNDFONT: path.join(tmp, 'no-such.sf2'),
    },
    stderr: 'pipe',
  });
  const badClient = new Client({ name: 'ms-test-client-no-music', version: '0.0.1' });
  await badClient.connect(badTransport);
  try {
    const badCall = async (name, args) => {
      const r = await badClient.callTool({ name, arguments: args });
      return { isError: !!r.isError, data: JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}') };
    };
    const scene = await makeScene(badCall, { name: 'No Music', fps: 30 });
    const res = await badClient.callTool({ name: 'synthesize_music', arguments: { target: sceneOf(scene), spec: MUSIC_SPEC } });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    assert.equal(!!res.isError, true);
    assert.equal(JSON.parse(text).code, 'music_unavailable');
  } finally {
    await badClient.close().catch(() => {});
  }
});

test('mcp: synthesize_music compiles a progression spec before dispatch (v0.20)', async () => {
  // Self-contained: its own scene, the shared (stubbed-fluidsynth) server.
  // The compile step runs in the MCP server before any vendor work, so the
  // stub receives — and echoes — the already-compiled note spec.
  const proj = await newScene({ name: 'Progression MCP', fps: 30, width: 320, height: 240, durationInFrames: 30 });
  const res = await callJson('synthesize_music', {
    target: sceneOf(proj),
    spec: { bpm: 96, progression: ['D', 'A', 'Bm', 'G'], style: 'pad-ballad', bars: 8, key: 'D' },
    mode: 'asset-only',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.compiled.style, 'pad-ballad');
  assert.equal(res.data.compiled.bars, 8);
  assert.equal(res.data.compiled.chords, 9, '8 bars of progression + the held close');
  assert.ok(res.data.compiled.notes > 0);
  assert.equal(res.data.bpm, 96);
  assert.equal(res.data.notes, res.data.compiled.notes, 'the vendor rendered exactly the compiled notes');

  // A bad chord fails as invalid_music_spec, naming the chord — before any vendor runs.
  const bad = await callJson('synthesize_music', { target: sceneOf(proj), spec: { progression: ['H7'] } });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'invalid_music_spec');
  assert.match(bad.data.message, /H7/);

  // tracks + progression together is refused (whether by schema or compiler).
  const both = await client.callTool({
    name: 'synthesize_music',
    arguments: {
      target: sceneOf(proj),
      spec: { progression: ['C'], tracks: [{ program: 0, notes: [{ pitch: 60, start: 0, duration: 1 }] }] },
    },
  }).then((r) => !!r.isError, () => true);
  assert.equal(both, true, 'tracks and progression together must be refused');
});

/* ---------------------------- v0.12 sound effects ----------------------------- */
// No stub env at all: core/sfx.js is pure JS, which is the point — there is no
// toolchain to be missing and therefore no *_unavailable path to test.

const SFX_SPEC = {
  cues: [
    { atFrame: 0, type: 'chime', pitch: 82, gain: 0.4, decay: 0.5 },
    { atFrame: 15, type: 'whoosh', rise: 0.2, fall: 0.2, gain: 0.5 },
  ],
};

let sfxSceneId;

test('mcp: synthesize_sfx attach mode writes a WAV and adds an audio track', async () => {
  const proj = await newScene({ name: 'Sfx MCP', fps: 30, width: 320, height: 240, durationInFrames: 60 });
  sfxSceneId = sceneOf(proj);

  const res = await callJson('synthesize_sfx', { target: sfxSceneId, spec: SFX_SPEC, mode: 'attach', gainDb: -12 });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, true);
  assert.equal(res.data.assetPath, 'assets/sfx-1.wav');
  assert.equal(res.data.cues, 2);
  assert.equal(res.data.channels, 1);
  assert.equal(res.data.sampleRate, 44100);
  assert.equal(res.data.normalize, 'ceiling');
  // fps AND the bed length are inherited from the project, so the bed spans the
  // composition without the caller restating either.
  assert.equal(res.data.fps, 30);
  assert.equal(res.data.durationInFrames, 60);
  assert.equal(res.data.durationSeconds, 2);
  assert.ok(res.data.bytes > 0);

  const after = await callJson('get_scene', { scene: sfxSceneId });
  assert.ok(fs.existsSync(path.join(after.data.path, 'assets', 'sfx-1.wav')));
  const track = (after.data.config.audio ?? []).find((tk) => tk.src === 'assets/sfx-1.wav');
  assert.ok(track, JSON.stringify(after.data.config.audio));
  assert.equal(track.gainDb, -12);
});

test('mcp: synthesize_sfx asset-only mode writes a WAV but leaves config.audio unchanged', async () => {
  const before = await callJson('get_scene', { scene: sfxSceneId });
  const beforeCount = (before.data.config.audio ?? []).length;

  const res = await callJson('synthesize_sfx', { target: sfxSceneId, spec: SFX_SPEC, mode: 'asset-only' });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.attached, false);
  assert.match(res.data.hint, /update_scene_config/);
  assert.equal(res.data.assetPath, 'assets/sfx-2.wav');

  const after = await callJson('get_scene', { scene: sfxSceneId });
  assert.equal((after.data.config.audio ?? []).length, beforeCount);
});

test('mcp: synthesize_sfx creates nested asset directories', async () => {
  const res = await callJson('synthesize_sfx', {
    target: sfxSceneId, spec: SFX_SPEC, mode: 'asset-only', assetPath: 'assets/generated/sfx.wav',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  const scene = await callJson('get_scene', { scene: sfxSceneId });
  assert.ok(fs.existsSync(path.join(scene.data.path, 'assets', 'generated', 'sfx.wav')));
});

test('mcp: synthesize_sfx reports the real level and leaves a quiet bed quiet', async () => {
  const res = await callJson('synthesize_sfx', {
    target: sfxSceneId, mode: 'asset-only',
    spec: { cues: [{ atFrame: 0, type: 'chime', gain: 0.25, decay: 0.4 }] },
  });
  assert.equal(res.data.appliedGainDb, 0, 'a quiet bed must not be normalized up');
  assert.equal(res.data.peakDb, res.data.rawPeakDb, 'the reported peak must be the real one');
  assert.ok(res.data.peakDb < -10, `expected a quiet bed, got ${res.data.peakDb} dBFS`);
});

test('mcp: synthesize_sfx surfaces a bad spec as invalid_sfx_spec', async () => {
  const res = await callJson('synthesize_sfx', {
    target: sfxSceneId, mode: 'asset-only',
    // Placement outside the bed is a bug, not something to clamp silently.
    spec: { durationInFrames: 30, cues: [{ atFrame: 900, type: 'chime' }] },
  });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'invalid_sfx_spec');
});

test('mcp: synthesize_sfx rejects an assetPath outside assets/', async () => {
  const res = await callJson('synthesize_sfx', { target: sfxSceneId, spec: SFX_SPEC, assetPath: '../evil.wav' });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'path_not_allowed');
});

/* ------------------------------ film assembly ------------------------------ */
// v0.20: a film IS the container, so build_film takes a film id (not a scene
// list) and runs as an async JOB — the same poll/wait surface as a render.

const renderToDone = async (scene) => {
  const start = await callJson('render', { scene });
  assert.equal(start.isError, false, JSON.stringify(start.data));
  return waitJobDone(start.data.jobId);
};

const waitJobDone = async (jobId) => {
  let status; const deadline = Date.now() + 60_000;
  do {
    await new Promise((r) => setTimeout(r, 100));
    status = (await callJson('get_render_status', { jobId })).data;
  } while (['running', 'queued'].includes(status.state) && Date.now() < deadline);
  assert.equal(status.state, 'done', JSON.stringify(status));
  return status;
};

/** A film with N scenes of the given size, each rendered. */
async function filmWithRenderedScenes(name, scenes) {
  const film = await callJson('create_film', { name, fps: 30, width: 320, height: 240, durationInFrames: 6 });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  for (const s of scenes) {
    const made = await callJson('create_scene', { film: film.data.film, ...s });
    assert.equal(made.isError, false, JSON.stringify(made.data));
    if (s.render !== false) await renderToDone(made.data.scene);
  }
  return film.data.film;
}

test('mcp: build_film concatenates a film\'s rendered scenes', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Concat Film', [{ name: 'Scene A' }, { name: 'Scene B' }]);

  // plan mode answers the layout question without assembling anything — this
  // is what an agent places narration against BEFORE rendering.
  const plan = await callJson('build_film', { film, plan: true });
  assert.equal(plan.isError, false, JSON.stringify(plan.data));
  assert.equal(plan.data.totalFrames, 12);
  assert.deepEqual(plan.data.sceneLayout.map((s) => s.filmOffset), [0, 6]);
  assert.deepEqual(plan.data.problems, []);

  const res = await callJson('build_film', { film });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.totalFrames, 12);
  const done = await waitJobDone(res.data.jobId);
  assert.ok(fs.existsSync(res.data.outputPath), done.outputPath);
  assert.ok(done.picture, JSON.stringify(done));
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', res.data.outputPath]);
  assert.ok(Math.abs(parseFloat(stdout) - 0.4) < 0.2, `film ~0.4s, got ${stdout.trim()}`);

  const inspected = await callJson('inspect_render', { target: film, around: 'cuts' });
  assert.equal(inspected.isError, false, JSON.stringify(inspected.data));
  assert.ok(inspected.content.some((block) => block.type === 'image'));
  assert.ok(inspected.data.frames.some((frame) => frame.frame === 6), JSON.stringify(inspected.data));

  const measured = await callJson('measure_render', { target: film, waitMs: 0 });
  assert.equal(measured.isError, false, JSON.stringify(measured.data));
  const report = measured.data.stillRunning
    ? (await callJson('wait_for_render', { jobIds: [measured.data.jobId], timeoutMs: 20_000 })).data.jobs[0].result
    : measured.data;
  assert.ok(report.motionEnvelope, JSON.stringify(report));
  assert.equal(report.cutsChecked, undefined, 'the detailed report keeps cut data inside cutCheck');
  assert.ok(Array.isArray(report.cutCheck), JSON.stringify(report));
});

test('mcp: build_film reports scene_not_rendered when a scene has no output', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Unrendered Film', [{ name: 'Ghost', render: false }]);
  const res = await callJson('build_film', { film });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'scene_not_rendered');
  // plan mode still works on an unrendered film — that is its whole point.
  const plan = await callJson('build_film', { film, plan: true });
  assert.equal(plan.isError, false, JSON.stringify(plan.data));
  assert.ok(plan.data.problems.some((p) => p.code === 'scene_not_rendered'));
});

test('mcp: build_film rejects scenes with mismatched dimensions', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // The film's sceneDefaults keep scenes consistent, so a mismatch now takes a
  // deliberate override — which is exactly when the check has to fire.
  const film = await filmWithRenderedScenes('Mismatch Film', [
    { name: 'Wide' },
    { name: 'Tall', width: 640, height: 480 },
  ]);
  const res = await callJson('build_film', { film });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'inconsistent_scenes');
  // get_film's plan names the offender rather than just failing.
  const info = await callJson('get_film', { film });
  assert.ok(info.data.plan.problems.some((p) => p.code === 'signature_mismatch'), JSON.stringify(info.data.plan.problems));
});

test('mcp: get_film states the encode contract a file must match to join the film', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Signature Film', [{ name: 'One' }, { name: 'Two' }]);

  const info = await callJson('get_film', { film });
  assert.equal(info.isError, false, JSON.stringify(info.data));
  const sig = info.data.plan.signature;
  assert.ok(sig, 'get_film reports the signature (v0.22) — previously computed and dropped');

  // The parameters a stream copy cannot reconcile…
  assert.equal(sig.video.codec, 'libx264');
  assert.equal(sig.container, 'mp4');
  assert.equal(sig.pixFmt, 'yuv420p');
  assert.equal(sig.transparent, false);
  assert.equal(sig.copyConcat, true);
  // …handed over ready to run, so nobody has to reassemble them in the right
  // order — which is the step the prototype got wrong.
  assert.ok(sig.ffmpegArgs.join(' ').includes('-c:v libx264'));
  assert.ok(sig.ffmpegArgs.includes('-pix_fmt'));
  // Stating what need NOT match is what stops the next author pinning
  // profile/level/GOP for no reason.
  assert.ok(sig.neednotMatch.includes('gopSize'));
  assert.ok(sig.neednotMatch.includes('profile'));
  assert.equal(sig.id, `${sig.width}x${sig.height}@${sig.fps}/mp4/opaque/yuv420p`);

  // One projection serves every film tool, so the plan form carries it too.
  const planned = await callJson('build_film', { film, plan: true });
  assert.deepEqual(planned.data.signature, sig);
});

test('mcp: films carry their own master audio and assets (no "master project")', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Master Audio Film', [{ name: 'Only' }]);

  // A bed written straight into the FILM's assets, then laid over the timeline.
  const sfx = await callJson('synthesize_sfx', {
    target: film, mode: 'asset-only',
    spec: { durationInFrames: 6, cues: [{ atFrame: 0, type: 'chime', gain: 0.3 }] },
  });
  assert.equal(sfx.isError, false, JSON.stringify(sfx.data));
  assert.equal(sfx.data.assetPath, 'assets/sfx-1.wav');

  const updated = await callJson('update_film', {
    film, audio: [{ src: sfx.data.assetPath, gainDb: -6 }],
  });
  assert.equal(updated.isError, false, JSON.stringify(updated.data));

  const built = await callJson('build_film', { film, outputFilename: 'with-audio' });
  assert.equal(built.isError, false, JSON.stringify(built.data));
  const done = await waitJobDone(built.data.jobId);
  assert.ok(fs.existsSync(built.data.outputPath));
  assert.ok(done.audio, 'a master timeline reports its measured levels');
  assert.ok(built.data.outputPath.endsWith('with-audio.mp4'));
});

test('mcp: the workspace library is listed and links into a scene', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // The human drops files in <workspace>/library on disk; the agent sees them
  // read-only and pulls them into a scene.
  const ws = await callJson('get_workspace');
  const libDir = path.join(ws.data.path, 'library', 'plates');
  await fsp.mkdir(libDir, { recursive: true });
  await fsp.writeFile(path.join(libDir, 'bg.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

  const list = await callJson('list_shared_assets');
  assert.equal(list.isError, false, JSON.stringify(list.data));
  assert.ok(list.data.files.some((f) => f.path === 'plates/bg.png'), JSON.stringify(list.data.files));

  const used = await callJson('use_shared_asset', { target: sceneId, path: 'plates/bg.png' });
  assert.equal(used.isError, false, JSON.stringify(used.data));
  assert.equal(used.data.path, 'assets/library/plates/bg.png');
  const scene = await callJson('get_scene', { scene: sceneId });
  assert.ok(fs.existsSync(path.join(scene.data.path, ...used.data.path.split('/'))));

  const missing = await callJson('use_shared_asset', { target: sceneId, path: 'nope.png' });
  assert.equal(missing.isError, true);
  assert.equal(missing.data.code, 'file_not_found');
});

/* ------------------------------------------------------------------ */
/* v0.22 — transcribe_asset: reading the speech in supplied media      */
/* ------------------------------------------------------------------ */

/** A real WAV for ffmpeg to resample; the stub decides what "speech" it holds. */
function toneWav({ seconds = 20, sampleRate = 48000, channels = 2 } = {}) {
  const bytes = sampleRate * channels * 2 * seconds;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 30)), 44 + i);
  return buf;
}

test('mcp: list_vendors reports the transcription capability and its models', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('list_vendors', { capability: 'transcription' });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  const tr = res.data.transcription;
  assert.equal(tr.active, 'whisper-cpp');
  assert.deepEqual(tr.allVendors, ['whisper-cpp']);
  assert.equal(tr.vendors[0].available, true);
  assert.equal(tr.vendors[0].offline, true);
  assert.equal(tr.vendors[0].activeModel, 'small.en');
  assert.deepEqual(tr.vendors[0].models.map((m) => m.name), ['small.en']);
  // The other two capabilities are untouched by asking for this one.
  assert.equal(res.data.speech, undefined);
});

test('mcp: transcribe_asset reads a library recording into sentences and words', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ws = await callJson('get_workspace');
  const libDir = path.join(ws.data.path, 'library', 'takes');
  await fsp.mkdir(libDir, { recursive: true });
  await fsp.writeFile(path.join(libDir, 'interview.wav'), toneWav());

  const res = await callJson('transcribe_asset', { path: 'takes/interview.wav', fps: 30 });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  const d = res.data;
  assert.equal(d.source, 'library');
  assert.equal(d.vendor, 'whisper-cpp');
  assert.equal(d.model, 'small.en');
  assert.equal(d.language, 'en');
  assert.equal(d.cached, false);
  // The fixture is the plan's sample: ONE decode window, THREE sentences.
  assert.equal(d.sentences.length, 3);
  assert.equal(d.rawSegments.length, 1, 'the vendor reported one window');
  // sentences[] mirrors synthesize_speech's timings field-for-field.
  for (const key of ['text', 'startSeconds', 'startInFrames', 'durationSeconds', 'durationInFrames']) {
    assert.ok(key in d.sentences[0], `missing ${key}`);
  }
  assert.equal(d.sentences[0].startInFrames, 258);
  assert.ok(d.words.length >= 12);
  assert.equal(d.words.find((w) => w.text === 'salvation').startInFrames, 266);
  assert.ok(d.speechRanges.length >= 1);
  assert.equal(d.leadingSilenceFrames, 258);
  // Confidence is reported, not hidden: the sample's middle sentence is a guess.
  assert.ok(d.sentences[1].minTokenP < 0.5);

  // Second call is served from the sidecar — this is what makes re-transcribing
  // a finished cut to verify it cheap enough to actually do.
  const again = await callJson('transcribe_asset', { path: 'takes/interview.wav', fps: 30 });
  assert.equal(again.data.cached, true);
  assert.deepEqual(again.data.sentences, d.sentences);

  // A different fps re-derives frames from the same cached seconds.
  const at24 = await callJson('transcribe_asset', { path: 'takes/interview.wav', fps: 24 });
  assert.equal(at24.data.cached, true);
  assert.equal(at24.data.sentences[0].startInFrames, 206);
});

test('mcp: transcribe_asset refuses a named non-English language on an English-only model', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ws = await callJson('get_workspace');
  const libDir = path.join(ws.data.path, 'library', 'language-guard');
  await fsp.mkdir(libDir, { recursive: true });
  await fsp.writeFile(path.join(libDir, 'take.wav'), toneWav({ seconds: 1 }));

  const res = await callJson('transcribe_asset', {
    path: 'language-guard/take.wav', language: 'ja', refresh: true,
  });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'transcription_language_unsupported');
  assert.equal(res.data.detail.model, 'small.en');
  assert.equal(res.data.detail.requestedLanguage, 'ja');
});

test('mcp: transcribe_asset finds the frame a word is spoken on, and bounds the word list', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const res = await callJson('transcribe_asset', {
    path: 'takes/interview.wav', fps: 30, wordsMatching: 'salvation',
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.matchedWords, 1);
  assert.equal(res.data.words.length, 1);
  assert.equal(res.data.words[0].startInFrames, 266);

  const capped = await callJson('transcribe_asset', { path: 'takes/interview.wav', maxWords: 2 });
  assert.equal(capped.data.words.length, 2);
  assert.equal(capped.data.wordsTruncated, true);
  assert.ok(capped.data.wordCount > 2);

  const noWords = await callJson('transcribe_asset', { path: 'takes/interview.wav', words: false });
  assert.equal(noWords.data.words, undefined);
  assert.ok(noWords.data.sentences.length, 'sentences are still there');
});

test('mcp: transcribe_asset refuses a non-media file by name, before any work', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const ws = await callJson('get_workspace');
  await fsp.writeFile(path.join(ws.data.path, 'library', 'notes.json'), '{}');
  const res = await callJson('transcribe_asset', { path: 'notes.json' });
  assert.equal(res.isError, true);
  assert.equal(res.data.code, 'transcription_input_unsupported');

  const missing = await callJson('transcribe_asset', { path: 'takes/nope.wav' });
  assert.equal(missing.isError, true);
  assert.equal(missing.data.code, 'file_not_found');
});

test('mcp: the read-only media tools reach out/, so a finished cut can be verified', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // Both tools promise this: "re-transcribe the render" is how a cut is checked,
  // and the render lands in out/, not assets/. Confining the READ to assets/ made
  // the documented workflow impossible while protecting nothing — the file is one
  // the engine itself wrote.
  const film = await callJson('create_film', { name: `Out Read Film ${++filmCounter}` });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  const outDir = path.join(film.data.path, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, 'film.wav'), toneWav({ seconds: 3 }));

  const heard = await callJson('transcribe_asset', { target: film.data.film, path: 'out/film.wav', fps: 30 });
  assert.equal(heard.isError, false, JSON.stringify(heard.data));
  assert.equal(heard.data.path, 'out/film.wav');
  assert.ok(heard.data.text.length > 0);

  const probed = await callJson('probe_asset', { target: film.data.film, path: 'out/film.wav' });
  assert.equal(probed.isError, false, JSON.stringify(probed.data));
  assert.equal(probed.data.path, 'out/film.wav');

  // A missing rendered file says so in the render's own terms.
  const missing = await callJson('probe_asset', { target: film.data.film, path: 'out/nope.mp4' });
  assert.equal(missing.isError, true);
  assert.equal(missing.data.code, 'file_not_found');
  assert.match(missing.data.message, /render it first/);

  // Reading out/ does not make it writable: a deliverable cannot be overwritten
  // or deleted through the tool surface.
  const write = await callJson('write_asset_file', {
    target: film.data.film, path: 'out/film.wav', contentBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(write.isError, true);
  assert.equal(write.data.code, 'path_not_allowed');
  const del = await callJson('delete_asset', { target: film.data.film, path: 'out/film.wav' });
  assert.equal(del.isError, true);
  assert.equal(del.data.code, 'path_not_allowed');

  // And the escape checks still apply to the new prefix.
  const escape = await callJson('probe_asset', { target: film.data.film, path: 'out/../../../evil.wav' });
  assert.equal(escape.isError, true);
  assert.equal(escape.data.code, 'path_not_allowed');
});

test('mcp: a transcription is a job in its own lane, pollable like a render', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // waitMs: 0 hands the jobId straight back, which is the shape a long
  // recording produces — and proves the transcript arrives as the job's result.
  const res = await callJson('transcribe_asset', { path: 'takes/interview.wav', waitMs: 0, refresh: true });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.ok(res.data.jobId, JSON.stringify(res.data));
  if (res.data.stillRunning) {
    const waited = await callJson('wait_for_render', { jobIds: [res.data.jobId], timeoutMs: 20000 });
    const job = waited.data.jobs[0];
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.kind, 'transcribe');
    assert.equal(job.result.sentences.length, 3, 'a task job carries its answer in result');
  }
  const listed = await callJson('list_render_jobs');
  assert.ok(listed.data.jobs.some((j) => j.kind === 'transcribe'), 'both lanes appear in the job list');
});

test('mcp: an unconfigured transcription vendor fails with the fix, not a crash', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  await withServer({
    home: 'home-no-whisper',
    env: {
      MOTION_STUDIO_WHISPER_BIN: path.join(tmp, 'no-such-whisper-cli'),
      MOTION_STUDIO_WHISPER_MODELS: whisperModels,
    },
  }, async (call) => {
    const vendors = await call('list_vendors', { capability: 'transcription' });
    assert.equal(vendors.data.transcription.vendors[0].available, false);
    assert.match(vendors.data.transcription.vendors[0].error, /not found|ENOENT|Could not start/i);

    const ws = await call('get_workspace');
    const libDir = path.join(ws.data.path, 'library');
    await fsp.mkdir(libDir, { recursive: true });
    await fsp.writeFile(path.join(libDir, 'take.wav'), toneWav({ seconds: 1 }));
    const res = await call('transcribe_asset', { path: 'take.wav' });
    assert.equal(res.isError, true);
    assert.equal(res.data.code, 'transcription_unavailable');
    assert.match(res.data.message, /do not retry blindly/);
    assert.match(res.data.message, /MOTION_STUDIO_WHISPER_BIN/);
  });
});

/* ------------------------------------------------------------------ */
/* v0.22 — transcode_asset, and the loop all four plans close          */
/* ------------------------------------------------------------------ */

test('mcp: transcode_asset conforms a library clip to a film and puts it on the timeline', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  // THE acceptance case, end to end through the tool surface only — no shell.
  // A film with two rendered scenes, a raw clip in the library, and the four
  // plans doing their jobs: the film STATES its encode contract (plan 0),
  // transcode_asset conforms the clip to it (plan 3), and the result goes on the
  // timeline as a footage segment (plan 2) that build_film assembles.
  const film = await filmWithRenderedScenes('Loop Closer', [{ name: 'Open' }, { name: 'Close' }]);
  const ws = await callJson('get_workspace');

  // The human drops a raw H.264 clip in the library — 640x480, wrong size and
  // wrong length for this film, with an audio track footage may not have.
  const libDir = path.join(ws.data.path, 'library');
  await fsp.mkdir(libDir, { recursive: true });
  const raw = path.join(libDir, 'raw-talk.mp4');
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', raw]);

  // What must this file look like to join the film? The film says so.
  const sig = (await callJson('get_film', { film })).data.plan.signature;
  assert.ok(sig?.ffmpegArgs, 'plan 0: the contract is stated');

  const conformed = await callJson('transcode_asset', {
    target: film, from: 'raw-talk.mp4', to: 'assets/segment.mp4',
    mode: 'video', matchFilm: film,
    trim: { startSeconds: 0.5, durationInFrames: 24 },
    scale: { width: sig.width, height: sig.height },
    fps: sig.fps,
  });
  assert.equal(conformed.isError, false, JSON.stringify(conformed.data));
  const c = conformed.data;
  assert.equal(c.matchedFilm, film);
  assert.equal(c.signature, sig.id);
  assert.equal(c.frames, 24, 'frame-exact, which is what the timeline will declare');
  assert.equal(c.video.width, sig.width);
  assert.equal(c.video.height, sig.height);
  assert.equal(c.hasAudio, false, 'footage must be silent, and audio is dropped by default');
  assert.match(c.hint, /update_film/);

  // Plan 2: it goes on the timeline between the two scenes.
  const patched = await callJson('update_film', {
    film,
    scenes: [{ slug: 'open' }, { footage: 'assets/segment.mp4', durationInFrames: 24 }, { slug: 'close' }],
  });
  assert.equal(patched.isError, false, JSON.stringify(patched.data));
  const layout = patched.data.plan.sceneLayout;
  assert.deepEqual(layout.map((s) => s.kind), ['scene', 'footage', 'scene']);
  // Nothing disagrees: the conformed file matches, and its declared count is true.
  assert.ok(!patched.data.plan.problems.some((p) => String(p.code).startsWith('footage_')),
    JSON.stringify(patched.data.plan.problems));
  assert.equal(layout[1].framesVerified, true);

  // And the film builds, losslessly, with every frame present.
  const built = await callJson('build_film', { film });
  assert.equal(built.isError, false, JSON.stringify(built.data));
  const done = await waitJobDone(built.data.jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error ?? {}));
  const total = layout.reduce((n, s) => n + s.durationInFrames, 0);
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', built.data.outputPath]);
  assert.equal(Number(stdout.trim()), total, 'the built film holds every frame of all three segments');
});

test('mcp: transcode_asset extracts a voice spine from a talk', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Spine Film', [{ name: 'Only' }]);
  const ws = await callJson('get_workspace');
  const raw = path.join(ws.data.path, 'library', 'talk.mp4');
  await fsp.mkdir(path.dirname(raw), { recursive: true });
  await execFileP('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', raw]);

  // Four spans of someone's voice, joined — the thing a film built around a talk
  // actually needs, and the reason this belongs in an asset tool: the mixer's
  // fades are frame-quantized, and 12 ms at 30 fps is 0.36 frames.
  const res = await callJson('transcode_asset', {
    target: film, from: 'talk.mp4', to: 'assets/spine.wav', mode: 'audio',
    spans: [
      { startSeconds: 0.2, durationInFrames: 30 },
      { startSeconds: 2.0, durationInFrames: 30 },
      { startSeconds: 4.0, durationInFrames: 30 },
    ],
    crossfadeMs: 12, sampleRate: 48000, channels: 2,
  });
  assert.equal(res.isError, false, JSON.stringify(res.data));
  assert.equal(res.data.audio.codec, 'pcm_s16le');
  assert.equal(res.data.audio.sampleRate, 48000);
  // Three 1s spans minus two 12ms crossfades — the fade consumes time.
  assert.ok(Math.abs(res.data.durationSeconds - 2.976) < 0.02, `got ${res.data.durationSeconds}`);
  assert.match(res.data.hint, /preview_audio/);

  // It goes on the master timeline as one track, which is the whole point.
  const upd = await callJson('update_film', { film, audio: [{ src: 'assets/spine.wav' }] });
  assert.equal(upd.isError, false, JSON.stringify(upd.data));
});

test('mcp: transcode_asset refuses anything shell-shaped, and never overwrites its source', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Guarded', [{ name: 'One' }]);
  const ws = await callJson('get_workspace');
  const raw = path.join(ws.data.path, 'library', 'guard.mp4');
  await fsp.mkdir(path.dirname(raw), { recursive: true });
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=160x120:rate=30:duration=1', '-pix_fmt', 'yuv420p', raw]);

  // Writing outside assets/ is refused by the same guard write_asset_file uses.
  const escape = await callJson('transcode_asset', { target: film, from: 'guard.mp4', to: '../escape.mp4' });
  assert.equal(escape.isError, true);
  assert.equal(escape.data.code, 'path_not_allowed');

  // A destination extension that names no format this engine writes.
  const gif = await callJson('transcode_asset', { target: film, from: 'guard.mp4', to: 'assets/out.gif' });
  assert.equal(gif.isError, true);
  assert.equal(gif.data.code, 'unsupported_format');

  // Malformed fields come back with EVERY complaint, before anything is spawned.
  const bad = await callJson('transcode_asset', {
    target: film, from: 'guard.mp4', to: 'assets/o.mp4',
    trim: { startSeconds: 1, startInFrames: 30 },
  });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, 'invalid_config');
  assert.match(bad.data.message, /not both/);

  // There is no `args`/`filter` field to smuggle anything through: zod strips
  // unknown keys, so this call is simply the same as one without them.
  const sneaky = await callJson('transcode_asset', {
    target: film, from: 'guard.mp4', to: 'assets/ok.mp4', trim: { durationInFrames: 5 },
    args: ['-vf', 'crop=1:1:0:0'], filter: 'anything',
  });
  assert.equal(sneaky.isError, false, JSON.stringify(sneaky.data));
  assert.equal(sneaky.data.video.width, 160, 'the smuggled crop had no effect');
});

test('mcp: transcode_asset is idempotent and reports it', async (t) => {
  if (!haveFfmpeg) return t.skip('ffmpeg missing');
  const film = await filmWithRenderedScenes('Idem', [{ name: 'One' }]);
  const ws = await callJson('get_workspace');
  const raw = path.join(ws.data.path, 'library', 'idem.mp4');
  await fsp.mkdir(path.dirname(raw), { recursive: true });
  await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p', raw]);

  const req = { target: film, from: 'idem.mp4', to: 'assets/small.webm', trim: { durationInFrames: 10 }, scale: { width: 160 } };
  const first = await callJson('transcode_asset', req);
  assert.equal(first.data.skipped, false);
  const second = await callJson('transcode_asset', req);
  assert.equal(second.data.skipped, true, 're-pulling an unchanged clip should be free');
  assert.equal(second.data.elapsedMs, 0);
  const forced = await callJson('transcode_asset', { ...req, refresh: true });
  assert.equal(forced.data.skipped, false);
});
