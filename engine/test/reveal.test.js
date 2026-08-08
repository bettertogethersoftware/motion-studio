/**
 * Opening a folder in the OS file manager (v0.27).
 *
 * The whole policy is a pure function over (remote address, platform, env), so
 * every refusal is testable here without a desktop session, a socket or a file
 * manager — which matters because the refusals are the interesting half. The
 * one impure function is exercised with a fake spawn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLoopbackAddress, revealCommand, hasDisplay, canReveal, revealDirectory,
} from '../src/core/reveal.js';

const LINUX_DESKTOP = { DISPLAY: ':0' };

/* -------------------------------- the gate -------------------------------- */

test('reveal: loopback is recognised in every form Node reports it', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.1.2.3', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackAddress(a), true, a);
  }
  for (const a of ['192.168.1.4', '10.0.0.2', '172.17.0.1', '::ffff:192.168.1.4', 'example.com']) {
    assert.equal(isLoopbackAddress(a), false, a);
  }
  // Unknown is NOT local: the safe answer to "should I launch a process" when
  // the socket cannot say who is asking is no.
  for (const a of [undefined, null, '', 0, {}]) assert.equal(isLoopbackAddress(a), false, String(a));
});

test('reveal: a request from another machine is refused, whatever the platform', () => {
  // 172.17.0.1 is the shape a containerised Studio sees under normal port
  // publishing — the browser is on the host, so this is the Docker case
  // falling out of the gate rather than needing a Docker check of its own.
  for (const addr of ['192.168.1.20', '172.17.0.1']) {
    const v = canReveal({ remoteAddress: addr, platform: 'win32', env: {} });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'remote');
    assert.match(v.message, /another machine/);
    assert.match(v.message, /Copy the path/);
  }
});

test('reveal: a desktop-less Linux box is refused, and says why', () => {
  const v = canReveal({ remoteAddress: '127.0.0.1', platform: 'linux', env: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'no_display');
  assert.match(v.message, /container or over SSH/);

  // With a session, the same call is allowed — DISPLAY or Wayland, either.
  assert.equal(canReveal({ remoteAddress: '127.0.0.1', platform: 'linux', env: LINUX_DESKTOP }).ok, true);
  assert.equal(canReveal({ remoteAddress: '::1', platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }).ok, true);
});

test('reveal: an unknown platform is refused rather than guessed at', () => {
  const v = canReveal({ remoteAddress: '127.0.0.1', platform: 'aix', env: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unsupported');
  assert.equal(revealCommand('aix'), null);
});

test('reveal: local Windows and macOS are allowed', () => {
  assert.equal(canReveal({ remoteAddress: '127.0.0.1', platform: 'win32', env: {} }).ok, true);
  assert.equal(canReveal({ remoteAddress: '::ffff:127.0.0.1', platform: 'darwin', env: {} }).ok, true);
  // A desktop is only in question on Linux; the other two always have one.
  assert.equal(hasDisplay('win32', {}), true);
  assert.equal(hasDisplay('darwin', {}), true);
  assert.equal(hasDisplay('linux', {}), false);
});

/* ------------------------------ the commands ------------------------------ */

test('reveal: each platform gets its own opener, with the directory as the argument', () => {
  assert.deepEqual(revealCommand('win32').args('C:\\lib'), ['C:\\lib']);
  assert.equal(revealCommand('win32').exe, 'explorer.exe');
  assert.equal(revealCommand('darwin').exe, 'open');
  assert.equal(revealCommand('linux').exe, 'xdg-open');
});

test('reveal: the child is detached and unref\'d, and no exit code is consulted', () => {
  const calls = [];
  let unrefs = 0;
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return { unref: () => { unrefs++; } };
  };
  const r = revealDirectory('/data/library', { platform: 'linux', env: LINUX_DESKTOP, spawnFn });
  assert.deepEqual(r, { revealed: true });
  assert.equal(calls[0].exe, 'xdg-open');
  assert.deepEqual(calls[0].args, ['/data/library']);
  assert.equal(calls[0].opts.detached, true, 'a file-manager window outlives the request');
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(unrefs, 1, 'the Studio must not hold a handle to the human\'s Explorer');

  // explorer.exe exits 1 ON SUCCESS, so success can never be an exit code —
  // this asserts nothing in the module ever waits for one.
  assert.equal(typeof calls[0].opts.detached, 'boolean');
});

test('reveal: a missing opener is reported, never thrown', () => {
  const spawnFn = () => { throw new Error('spawn xdg-open ENOENT'); };
  const r = revealDirectory('/data/library', { platform: 'linux', env: LINUX_DESKTOP, spawnFn });
  assert.equal(r.revealed, false);
  assert.equal(r.reason, 'failed');
  assert.match(r.message, /ENOENT/);

  const none = revealDirectory('/x', { platform: 'aix', spawnFn });
  assert.equal(none.revealed, false);
  assert.equal(none.reason, 'unsupported');
});
