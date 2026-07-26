/**
 * Stand-in for the OpenAI speech REST endpoint, so the OpenAI vendor can be
 * tested end-to-end with no account, no key, and no network. The engine
 * reaches OpenAI with `fetch` against a configurable base URL, so pointing
 * MOTION_STUDIO_OPENAI_ENDPOINT (or the `endpoint` argument) at this server
 * exercises the real code path — headers, JSON body, chunking, WAV parsing
 * and all — against a local http server.
 *
 * Honors the two routes the vendor uses:
 *   GET  /v1/models/gpt-4o-mini-tts   → the probe (200 = the key works)
 *   POST /v1/audio/speech             → a 1.0s PCM WAV (24 kHz mono 16-bit)
 *
 * Both require the `Authorization` header to equal `Bearer <key>` (default
 * key "test-key"), answering 401 otherwise — the same way the service rejects
 * a bad credential. Over-long `input` answers 400 like the real service, so a
 * chunking bug in the engine fails the test instead of passing silently.
 */
import http from 'node:http';
import { pcmWav } from './fake-azure-speech.mjs';

const INPUT_CHAR_LIMIT = 4096;

/**
 * Start the stub.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.key]        accepted API key
 * @param {number}  [opts.failStatus] force this status on POST synthesis (e.g. 429)
 * @param {string}  [opts.failBody]   body for the forced failure
 * @returns {Promise<{url, requests, close}>} `requests` records every call
 *          ({ method, path, headers, body }) so tests can assert on the JSON.
 */
export async function startFakeOpenai({ key = 'test-key', failStatus = 0, failBody = '' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      const url = new URL(req.url, 'http://localhost');

      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models/gpt-4o-mini-tts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'gpt-4o-mini-tts', object: 'model', owned_by: 'system' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
        if (failStatus) {
          res.writeHead(failStatus, { 'Content-Type': 'application/json' });
          res.end(failBody || JSON.stringify({ error: { message: 'forced failure' } }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON body.' } }));
          return;
        }
        if (typeof parsed.input !== 'string' || parsed.input.length > INPUT_CHAR_LIMIT) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `input must be a string of at most ${INPUT_CHAR_LIMIT} characters.` } }));
          return;
        }
        const wav = pcmWav({ sampleRate: 24000 });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        res.end(wav);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
