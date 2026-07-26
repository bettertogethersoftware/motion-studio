/**
 * Stand-in for the Deepgram REST endpoint, so the Deepgram vendor can be
 * tested end-to-end with no account, no key, and no network. The engine
 * reaches Deepgram with `fetch` against a configurable base URL, so pointing
 * MOTION_STUDIO_DEEPGRAM_ENDPOINT (or the `endpoint` argument) at this server
 * exercises the real code path — headers, query params, chunking, WAV parsing
 * and all — against a local http server.
 *
 * Honors the two routes the vendor uses:
 *   GET  /v1/projects   → the probe (200 = the key works)
 *   POST /v1/speak      → a 1.0s PCM WAV at the requested sample_rate
 *
 * Both require the `Authorization` header to equal `Token <key>` — Token, NOT
 * Bearer, exactly as the real service demands (default key "test-key"),
 * answering 401 otherwise. An unknown `model` answers 400 and over-long text
 * answers 413, the same way the service does, so the engine's passthrough
 * voice pattern and its chunking are provable against realistic refusals.
 */
import http from 'node:http';
import { pcmWav } from './fake-azure-speech.mjs';

const INPUT_CHAR_LIMIT = 2000;

/** A small slice of the real Aura-2 catalogue — enough for picking tests. */
export const FAKE_DEEPGRAM_MODELS = [
  'aura-2-thalia-en',
  'aura-2-andromeda-en',
  'aura-2-orion-en',
  'aura-2-luna-en',
];

/**
 * Start the stub.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.key]        accepted API key
 * @param {string[]} [opts.models]     voice/model names the stub accepts
 * @param {number}   [opts.failStatus] force this status on POST /v1/speak (e.g. 429)
 * @param {string}   [opts.failBody]   body for the forced failure
 * @returns {Promise<{url, requests, close}>} `requests` records every call
 *          ({ method, path, headers, body }) so tests can assert on the JSON.
 */
export async function startFakeDeepgram({
  key = 'test-key', models = FAKE_DEEPGRAM_MODELS, failStatus = 0, failBody = '',
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      const url = new URL(req.url, 'http://localhost');

      if (req.headers.authorization !== `Token ${key}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: [{ project_id: 'p-0000', name: 'test project' }] }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/speak') {
        if (failStatus) {
          res.writeHead(failStatus, { 'Content-Type': 'application/json' });
          res.end(failBody || JSON.stringify({ err_code: 'ERROR', err_msg: 'forced failure' }));
          return;
        }
        const model = url.searchParams.get('model');
        if (!models.includes(model)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ err_code: 'INVALID_QUERY_PARAMETER', err_msg: `model ${model} is not a valid model` }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ err_code: 'BAD_REQUEST', err_msg: 'Invalid JSON body.' }));
          return;
        }
        if (typeof parsed.text !== 'string' || parsed.text.length > INPUT_CHAR_LIMIT) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ err_code: 'PAYLOAD_TOO_LARGE', err_msg: `Text length exceeds limit of ${INPUT_CHAR_LIMIT} characters.` }));
          return;
        }
        const wav = pcmWav({ sampleRate: Number(url.searchParams.get('sample_rate') ?? 24000) });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        res.end(wav);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ err_code: 'NOT_FOUND', err_msg: 'not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
