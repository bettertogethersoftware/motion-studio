/**
 * Stand-in for the Azure AI Speech REST endpoint, so the Azure vendor can be
 * tested end-to-end with no subscription, no key, and no network. The engine
 * reaches Azure with `fetch` against a configurable base URL, so pointing
 * MOTION_STUDIO_AZURE_SPEECH_ENDPOINT (or the `endpoint` argument) at this
 * server exercises the real code path — headers, SSML body, WAV parsing and
 * all — against a local http server.
 *
 * Honors the two routes the vendor uses:
 *   GET  /cognitiveservices/voices/list  → JSON array of voice objects
 *   POST /cognitiveservices/v1           → a 1.0s PCM WAV (24 kHz mono 16-bit)
 *
 * Both require the `Ocp-Apim-Subscription-Key` header to equal `key`
 * (default "test-key"), answering 401 otherwise — the same way the service
 * rejects a bad credential.
 */
import http from 'node:http';

export const FAKE_VOICES = [
  {
    Name: 'Microsoft Server Speech Text to Speech Voice (en-US, AvaNeural)',
    ShortName: 'en-US-AvaNeural',
    DisplayName: 'Ava',
    LocalName: 'Ava',
    Locale: 'en-US',
    LocaleName: 'English (United States)',
    Gender: 'Female',
    VoiceType: 'Neural',
    SampleRateHertz: '24000',
    StyleList: ['cheerful', 'newscast'],
    Status: 'GA',
  },
  {
    Name: 'Microsoft Server Speech Text to Speech Voice (en-GB, RyanNeural)',
    ShortName: 'en-GB-RyanNeural',
    DisplayName: 'Ryan',
    LocalName: 'Ryan',
    Locale: 'en-GB',
    LocaleName: 'English (United Kingdom)',
    Gender: 'Male',
    VoiceType: 'Neural',
    SampleRateHertz: '24000',
    StyleList: [],
    Status: 'GA',
  },
  {
    Name: 'Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoChenNeural)',
    ShortName: 'zh-TW-HsiaoChenNeural',
    DisplayName: '曉臻',
    LocalName: '曉臻',
    Locale: 'zh-TW',
    LocaleName: 'Chinese (Taiwan)',
    Gender: 'Female',
    VoiceType: 'Neural',
    SampleRateHertz: '24000',
    Status: 'GA',
  },
];

/** 24 kHz mono 16-bit PCM WAV; 48000 data bytes = exactly 1.0s. */
export function pcmWav({ sampleRate = 24000, channels = 1, bitsPerSample = 16, seconds = 1 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataSize = byteRate * seconds;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/**
 * Start the stub.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.key]        accepted subscription key
 * @param {Array}   [opts.voices]     voice catalogue to serve
 * @param {number}  [opts.failStatus] force this status on POST /v1 (e.g. 429)
 * @param {string}  [opts.failBody]   body for the forced failure
 * @returns {Promise<{url, requests, close}>} `requests` records every call
 *          ({ method, path, headers, body }) so tests can assert on the SSML.
 */
export async function startFakeAzure({ key = 'test-key', voices = FAKE_VOICES, failStatus = 0, failBody = '' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });

      if (req.headers['ocp-apim-subscription-key'] !== key) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Access denied due to invalid subscription key.');
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/cognitiveservices/voices/list')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(voices));
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/cognitiveservices/v1')) {
        if (failStatus) {
          res.writeHead(failStatus, { 'Content-Type': 'text/plain' });
          res.end(failBody);
          return;
        }
        // A voice the catalogue doesn't have reaches the service only if the
        // engine skipped validation — answer the way Azure does.
        const requested = /<voice name="([^"]+)"/.exec(body)?.[1];
        if (requested && !voices.some((v) => v.ShortName === requested)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`The voice ${requested} is not supported.`);
          return;
        }
        const wav = pcmWav();
        res.writeHead(200, { 'Content-Type': 'audio/x-wav', 'Content-Length': wav.length });
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
