/**
 * Agent-economy proxies (token-efficient plan, P1-4), driven by a real MCP
 * client over stdio so the counter is measured where it actually runs: the
 * decorated tool registration inside a live server process.
 *
 * The report is PROXIES, not tokens — calls, response bytes, compact vs full
 * projections, and the per-scene calls a batch replaced. The canary at the end
 * is the part that must never regress: a telemetry file that quietly carried
 * file contents out of the workspace would be a leak, not a measurement.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '../src/mcp/server.js');
const FAKE_BROWSER = path.resolve(__dirname, 'helpers/fake-browser-module.js');

// A body no counter has any business carrying: if it appears in the report,
// something started recording arguments or file contents.
const LIBRARY_CANARY = 'ECONOMY-CANARY-PLATE-BYTES-6f2a1c';

let tmp, home, client, transport;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-econ-'));
  home = path.join(tmp, 'home');
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MOTION_STUDIO_HOME: home,
      MOTION_STUDIO_BROWSER_MODULE: FAKE_BROWSER,
      MOTION_STUDIO_WORKSPACE: 'econ',
      MOTION_STUDIO_AGENT: 'econ-agent',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'ms-econ-test', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
});

const callJson = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { isError: !!res.isError, data: JSON.parse(text) };
};

/** The flush is debounced and unref'd, so the file arrives shortly after. */
async function readReportWhen(file, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      last = { raw, report: JSON.parse(raw) };
      if (predicate(last.report)) return last;
    } catch { /* not written yet, or caught mid-rename */ }
    if (Date.now() > deadline) {
      throw new Error(`agent-economy.json never satisfied the predicate: ${last ? last.raw : '(no file)'}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('agent economy: per-tool calls/bytes, compact vs full, batch savings — and no contents', async () => {
  const film = await callJson('create_film', { name: 'Econ Film', fps: 30, width: 320, height: 240, durationInFrames: 8 });
  assert.equal(film.isError, false, JSON.stringify(film.data));
  const slug = film.data.film;
  const scene = await callJson('create_scene', { film: slug, name: 'Econ One', durationInFrames: 8 });
  assert.equal(scene.isError, false, JSON.stringify(scene.data));
  const sceneId = `${slug}/${scene.data.scene}`;

  // One compact read (detail absent → the tool's summary default) and one
  // explicit full read: the two must be attributed differently.
  const compact = await callJson('get_production_status', { film: slug });
  assert.equal(compact.isError, false, JSON.stringify(compact.data));
  const full = await callJson('get_production_status', { film: slug, detail: 'full' });
  assert.equal(full.isError, false, JSON.stringify(full.data));

  // A seeded library, then one batch call standing in for two per-scene ones.
  const ws = await callJson('get_workspace');
  const libDir = path.join(ws.data.path, 'library', 'econ');
  await fsp.mkdir(libDir, { recursive: true });
  await fsp.writeFile(path.join(libDir, 'a.txt'), `${LIBRARY_CANARY}-a`);
  await fsp.writeFile(path.join(libDir, 'b.txt'), `${LIBRARY_CANARY}-b`);
  const batch = await callJson('use_shared_asset_batch', {
    items: [
      { target: sceneId, path: 'econ/a.txt' },
      { target: sceneId, path: 'econ/b.txt' },
    ],
  });
  assert.equal(batch.isError, false, JSON.stringify(batch.data));
  assert.equal(batch.data.counts.items, 2);

  const file = path.join(home, 'agent-economy.json');
  const { raw, report } = await readReportWhen(file, (r) => r.batches?.itemsLinked === 2);

  assert.equal(report.schema, 'motion-studio.agent-economy/1');
  assert.equal(report.workspace, 'econ');
  assert.equal(report.agent, 'econ-agent');
  assert.ok(!Number.isNaN(Date.parse(report.startedAt)), report.startedAt);
  assert.ok(Date.parse(report.updatedAt) >= Date.parse(report.startedAt));
  assert.match(report.notes, /proxies only/);

  // Every tool that ran is counted, with the bytes it sent back.
  for (const name of ['create_film', 'create_scene', 'get_production_status', 'get_workspace', 'use_shared_asset_batch']) {
    const row = report.tools[name];
    assert.ok(row, `${name} was not counted: ${Object.keys(report.tools).join(', ')}`);
    assert.ok(row.calls > 0, `${name} calls`);
    assert.ok(row.bytes > 0, `${name} bytes`);
  }
  const status = report.tools.get_production_status;
  assert.equal(status.calls, 2);
  assert.equal(status.compact, 1, 'detail-absent is this tool\'s compact default');
  assert.equal(status.full, 1);
  // A tool with no projection `detail` claims neither.
  assert.equal(report.tools.use_shared_asset_batch.compact, 0);
  assert.equal(report.tools.use_shared_asset_batch.full, 0);

  // Batch savings: two per-scene use_shared_asset calls replaced by one.
  assert.deepEqual(report.batches, { itemsLinked: 2, bundleTargets: 0, groupScenes: 0 });

  // The canary: names and numbers only. No arguments, no file contents.
  assert.equal(raw.includes(LIBRARY_CANARY), false, 'the report must never carry library file contents');
  assert.equal(raw.includes('econ/a.txt'), false, 'the report must never carry call arguments');
  assert.deepEqual(
    Object.keys(report).sort(),
    ['agent', 'batches', 'notes', 'schema', 'startedAt', 'tools', 'updatedAt', 'workspace'],
  );
  for (const row of Object.values(report.tools)) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'calls', 'compact', 'full']);
  }
});
