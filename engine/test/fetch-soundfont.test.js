/**
 * The pack-bootstrap contract (Slice 0), tested without any network: a
 * verified file is reused untouched; a good download only reaches the
 * destination name after its hash checks out; a bad mirror never installs;
 * an offline machine gets a structured failure, not a stack trace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchVerified, sha256Of } from '../src/cli/fetch-soundfont.js';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'ms-pack-'));

/** A fetch stand-in serving fixed bytes — the test's whole "network". */
const fakeFetch = (bytes, { status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  body: new Blob([bytes]).stream(),
});

test('pack: an existing verified file is reused without touching the network', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'pack.bin');
  const bytes = Buffer.from('verified pack content');
  await fsp.writeFile(dest, bytes);
  let networkTouched = false;
  const result = await fetchVerified({
    url: 'https://example.invalid/pack.bin',
    sha256: sha(bytes),
    dest,
    fetchImpl: async () => { networkTouched = true; throw new Error('must not be called'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(networkTouched, false);
});

test('pack: a good download verifies and lands atomically, and re-running reuses it', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'pack.bin');
  const bytes = Buffer.from('downloaded pack content');
  const result = await fetchVerified({
    url: 'https://example.invalid/pack.bin', sha256: sha(bytes), dest, fetchImpl: fakeFetch(bytes),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(await sha256Of(dest), sha(bytes));
  assert.equal(fs.existsSync(`${dest}.part`), false, 'no .part left behind on success');

  const again = await fetchVerified({
    url: 'https://example.invalid/pack.bin', sha256: sha(bytes), dest,
    fetchImpl: async () => { throw new Error('must not re-download'); },
  });
  assert.equal(again.reused, true);
});

test('pack: a hash mismatch never installs — the destination name never exists', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'pack.bin');
  const result = await fetchVerified({
    url: 'https://example.invalid/pack.bin',
    sha256: sha(Buffer.from('what the pin expects')),
    dest,
    fetchImpl: fakeFetch(Buffer.from('what the mirror actually served')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'hash_mismatch');
  assert.equal(fs.existsSync(dest), false, 'a mismatched download must never be renamed into place');
  assert.equal(fs.existsSync(`${dest}.part`), true, 'the partial is kept for diagnosis');
});

test('pack: offline is a structured failure after retries, not a stack trace', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'pack.bin');
  let attempts = 0;
  const result = await fetchVerified({
    url: 'https://example.invalid/pack.bin', sha256: '0'.repeat(64), dest, retries: 3,
    fetchImpl: async () => { attempts += 1; throw new Error('ENOTFOUND example.invalid'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'download_failed');
  assert.equal(attempts, 3);
  assert.match(result.message, /offline|another machine/i, 'names the manual fallback');
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false, 'failed attempts clean their partials');
});

test('pack: an HTTP error status retries and then fails structurally', async () => {
  const dir = await tmpDir();
  const dest = path.join(dir, 'pack.bin');
  const result = await fetchVerified({
    url: 'https://example.invalid/pack.bin', sha256: '0'.repeat(64), dest, retries: 2,
    fetchImpl: fakeFetch(Buffer.alloc(0), { status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'download_failed');
  assert.match(result.message, /HTTP 503/);
});
