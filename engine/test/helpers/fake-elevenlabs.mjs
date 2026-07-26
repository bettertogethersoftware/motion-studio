/**
 * Stand-in for the ElevenLabs REST endpoint, so the ElevenLabs vendor can be
 * tested end-to-end with no account, no key, and no network. The engine
 * reaches ElevenLabs with `fetch` against a configurable base URL, so pointing
 * MOTION_STUDIO_ELEVENLABS_ENDPOINT (or the `endpoint` argument) at this
 * server exercises the real code path — headers, JSON body, pagination, WAV
 * parsing and all — against a local http server.
 *
 * Honors the two routes the vendor uses:
 *   GET  /v2/voices                      → one page of { voices, has_more,
 *                                          next_page_token } — the catalogue is
 *                                          deliberately served over TWO pages so
 *                                          the vendor's token walk is provable
 *   POST /v1/text-to-speech/{voice_id}   → a 1.0s PCM WAV (rate from the
 *                                          output_format query)
 *
 * Both require the `xi-api-key` header to equal `key` (default "test-key"),
 * answering 401 otherwise — the same way the service rejects a bad credential.
 */
import http from 'node:http';
import { pcmWav } from './fake-azure-speech.mjs';

export const FAKE_ELEVEN_PAGE_1 = [
  {
    voice_id: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Rachel',
    category: 'premade',
    labels: { gender: 'female', accent: 'american' },
    preview_url: 'https://example.invalid/rachel.mp3',
  },
  {
    voice_id: 'pNInz6obpgDQGcFmaJgB',
    name: 'Adam',
    category: 'premade',
    labels: { gender: 'male' },
    preview_url: null,
  },
];
export const FAKE_ELEVEN_PAGE_2 = [
  {
    voice_id: 'cLoneVo1ce0000000001',
    name: 'Studio Clone',
    category: 'cloned',
    labels: {},
    preview_url: null,
  },
];
export const FAKE_ELEVEN_VOICES = [...FAKE_ELEVEN_PAGE_1, ...FAKE_ELEVEN_PAGE_2];

/**
 * Start the stub.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.key]        accepted API key
 * @param {Array[]} [opts.pages]      voice catalogue, one array per page
 * @param {number}  [opts.failStatus] force this status on POST synthesis (e.g. 429)
 * @param {string}  [opts.failBody]   body for the forced failure
 * @returns {Promise<{url, requests, close}>} `requests` records every call
 *          ({ method, path, headers, body }) so tests can assert on the JSON.
 */
export async function startFakeElevenlabs({
  key = 'test-key', pages = [FAKE_ELEVEN_PAGE_1, FAKE_ELEVEN_PAGE_2], failStatus = 0, failBody = '',
} = {}) {
  const requests = [];
  const allVoices = pages.flat();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      const url = new URL(req.url, 'http://localhost');

      if (req.headers['xi-api-key'] !== key) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key.' } }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v2/voices') {
        const token = url.searchParams.get('next_page_token');
        const index = token ? Number(token.replace('page-', '')) : 0;
        const hasMore = index + 1 < pages.length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          voices: pages[index] ?? [],
          has_more: hasMore,
          next_page_token: hasMore ? `page-${index + 1}` : null,
        }));
        return;
      }
      const synth = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'POST' && synth) {
        if (failStatus) {
          res.writeHead(failStatus, { 'Content-Type': 'application/json' });
          res.end(failBody || JSON.stringify({ detail: { status: 'error', message: 'forced failure' } }));
          return;
        }
        // A voice_id the library doesn't have reaches the service only if the
        // engine skipped validation — answer the way ElevenLabs does.
        const voiceId = decodeURIComponent(synth[1]);
        if (!allVoices.some((v) => v.voice_id === voiceId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: { status: 'voice_not_found', message: `A voice with voice_id ${voiceId} was not found.` } }));
          return;
        }
        const sampleRate = Number(/^wav_(\d+)$/.exec(url.searchParams.get('output_format') ?? '')?.[1] ?? 24000);
        const wav = pcmWav({ sampleRate });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        res.end(wav);
        return;
      }
      res.writeHead(404).end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
