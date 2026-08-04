/**
 * The pack manifest + bootstrap (Slice B): every entry structurally sound
 * and honestly pinned, the generic fetch path verified end to end against a
 * fake network, and the core-only tolerance contract — a missing manifest is
 * a structured answer, never a module crash.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { PACKS, PACKS_MANIFEST_VERSION } from '../src/vendors/default/packs.js';
import { loadPacks, listPacks, fetchPack } from '../src/cli/fetch-pack.js';

let tmp;
before(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-packs-')); });
after(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

test('manifest: every pack entry is structurally sound', () => {
  assert.equal(PACKS_MANIFEST_VERSION, 1);
  assert.ok(Object.keys(PACKS).length >= 2, 'more than the pilot');
  for (const [key, p] of Object.entries(PACKS)) {
    assert.equal(p.id, key, `${key}: id matches its key`);
    for (const field of ['title', 'summary', 'enables']) {
      assert.ok(typeof p[field] === 'string' && p[field].length, `${key}.${field}`);
    }
    assert.ok(p.license?.name && /^https:\/\//.test(p.license?.url), `${key}: license name + https url`);
    assert.ok(p.platforms === null || (Array.isArray(p.platforms) && p.platforms.length), `${key}.platforms`);
    assert.ok(Array.isArray(p.files) && p.files.length, `${key}: at least one file`);
    for (const f of p.files) {
      assert.match(f.path, /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/, `${key}: relative forward-slash path, no dot-segments`);
      assert.match(f.url, /^https:\/\//, `${key}: https url`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${key}: pinned sha256`);
      assert.ok(Number.isInteger(f.bytes) && f.bytes > 0, `${key}: byte size`);
    }
  }
});

test('manifest: whisper model packs land where the whisper vendor searches', () => {
  // defaultModelsDir() in vendors/default/transcription/whisper-cpp.js is
  // vendorDir()/whisper/models — a fetched model must be found with no env
  // var or setting, so the pack paths are tethered to that folder.
  for (const id of ['whisper-model-base-en', 'whisper-model-base']) {
    for (const f of PACKS[id].files) {
      assert.match(f.path, /^whisper\/models\//, `${id}: ${f.path}`);
    }
  }
});

test('manifest: the soundfont entry IS the Slice 0 pilot pin', () => {
  const [f] = PACKS.soundfont.files;
  assert.equal(f.sha256, '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3');
  assert.equal(f.path, 'soundfonts/MuseScore_General.sf3');
});

const fakeNet = (bodies) => async (url) => {
  if (!(url in bodies)) return { ok: false, status: 404 };
  return { ok: true, status: 200, body: ReadableStream.from([Buffer.from(bodies[url])]) };
};
const shaOf = (text) => createHash('sha256').update(text).digest('hex');

const TINY = Object.freeze({
  ok: true, manifestVersion: 1,
  packs: Object.freeze({
    tiny: {
      id: 'tiny', title: 'Tiny', summary: 't', enables: 't',
      license: { name: 'MIT', url: 'https://example.com' }, platforms: null,
      envOverride: 'MOTION_STUDIO_TEST_TINY_OVERRIDE',
      files: [
        { path: 'tiny/a.bin', url: 'https://x/a', sha256: shaOf('aaa'), bytes: 3 },
        { path: 'tiny/b.bin', url: 'https://x/b', sha256: shaOf('bbb'), bytes: 3 },
      ],
    },
    elsewhere: {
      id: 'elsewhere', title: 'E', summary: 'e', enables: 'e',
      license: { name: 'MIT', url: 'https://example.com' }, platforms: ['no-such-platform'],
      files: [{ path: 'e/e.bin', url: 'https://x/e', sha256: shaOf('e'), bytes: 1 }],
    },
  }),
});

test('fetchPack: fetches every file verified, resumes idempotently, and lists as installed', async () => {
  const root = path.join(tmp, 'root1');
  const net = fakeNet({ 'https://x/a': 'aaa', 'https://x/b': 'bbb' });

  const beforeList = await listPacks({ root, loaded: TINY });
  assert.equal(beforeList.ok, true);
  assert.equal(beforeList.packs.find((p) => p.id === 'tiny').installed, false);
  assert.ok(!beforeList.packs.some((p) => p.id === 'elsewhere'), 'wrong-platform packs are not offered');

  const first = await fetchPack('tiny', { root, fetchImpl: net, loaded: TINY });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fs.readFileSync(path.join(root, 'tiny', 'a.bin'), 'utf8'), 'aaa');
  assert.equal(first.files.every((f) => f.reused === false), true);

  const again = await fetchPack('tiny', { root, fetchImpl: net, loaded: TINY });
  assert.equal(again.files.every((f) => f.reused === true), true, 'verified files are reused, not re-downloaded');

  const afterList = await listPacks({ root, loaded: TINY });
  assert.equal(afterList.packs.find((p) => p.id === 'tiny').installed, true);
});

test('fetchPack: stops at the first failure and the pack stays honestly uninstalled', async () => {
  const root = path.join(tmp, 'root2');
  const net = fakeNet({ 'https://x/a': 'aaa' }); // b is a 404 → download_failed
  const result = await fetchPack('tiny', { root, fetchImpl: net, loaded: TINY });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'download_failed');
  assert.equal(fs.existsSync(path.join(root, 'tiny', 'a.bin')), true, 'the verified half stays');
  const list = await listPacks({ root, loaded: TINY });
  assert.equal(list.packs.find((p) => p.id === 'tiny').installed, false);
});

test('fetchPack: a tampered mirror is a hash_mismatch, never installed', async () => {
  const root = path.join(tmp, 'root3');
  const net = fakeNet({ 'https://x/a': 'TAMPERED', 'https://x/b': 'bbb' });
  const result = await fetchPack('tiny', { root, fetchImpl: net, loaded: TINY });
  assert.equal(result.code, 'hash_mismatch');
  assert.equal(fs.existsSync(path.join(root, 'tiny', 'a.bin')), false, 'mismatch is never renamed into place');
});

test('fetchPack: unknown id names the known packs; wrong platform is structural', async () => {
  const unknown = await fetchPack('nope', { root: tmp, loaded: TINY });
  assert.equal(unknown.code, 'unknown_pack');
  assert.match(unknown.message, /tiny/);
  const wrongPlatform = await fetchPack('elsewhere', { root: tmp, loaded: TINY });
  assert.equal(wrongPlatform.code, 'wrong_platform');
});

test('fetchPack: the envOverride note appears when the hook points elsewhere', async () => {
  const root = path.join(tmp, 'root4');
  const net = fakeNet({ 'https://x/a': 'aaa', 'https://x/b': 'bbb' });
  process.env.MOTION_STUDIO_TEST_TINY_OVERRIDE = path.join(tmp, 'somewhere-else.bin');
  try {
    const result = await fetchPack('tiny', { root, fetchImpl: net, loaded: TINY });
    assert.equal(result.ok, true);
    assert.match(result.note, /MOTION_STUDIO_TEST_TINY_OVERRIDE/);
  } finally {
    delete process.env.MOTION_STUDIO_TEST_TINY_OVERRIDE;
  }
});

test('core-only tolerance: a missing manifest is a structured packs_unavailable', async () => {
  const loaded = await loadPacks({ importImpl: () => { throw new Error('Cannot find module'); } });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'packs_unavailable');
  assert.match(loaded.message, /core-only/);
  const list = await listPacks({ root: tmp, loaded });
  assert.equal(list.code, 'packs_unavailable');
  const fetched = await fetchPack('soundfont', { root: tmp, loaded });
  assert.equal(fetched.code, 'packs_unavailable');
});

test('fetch-soundfont compat: the alias flattens the soundfont pack result to the Slice 0 shape', async () => {
  const { fetchSoundFont } = await import('../src/cli/fetch-soundfont.js');
  const prev = process.env.MOTION_STUDIO_VENDOR_DIR;
  process.env.MOTION_STUDIO_VENDOR_DIR = path.join(tmp, 'compat-vendor');
  try {
    // The fake serves wrong bytes: the compat shape must carry the same
    // hash_mismatch fields Slice 0 callers parse (ok, code, dest, part).
    const net = fakeNet({ [PACKS.soundfont.files[0].url]: 'not a soundfont' });
    const result = await fetchSoundFont({ fetchImpl: net });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'hash_mismatch');
    assert.ok(result.dest && result.part, 'flattened single-file fields');
  } finally {
    if (prev === undefined) delete process.env.MOTION_STUDIO_VENDOR_DIR;
    else process.env.MOTION_STUDIO_VENDOR_DIR = prev;
  }
});
