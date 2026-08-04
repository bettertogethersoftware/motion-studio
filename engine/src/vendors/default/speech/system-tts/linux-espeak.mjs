/**
 * Linux backend for the `system` speech vendor (Slice 0, decided in the
 * vendor-boundary plan §10): espeak-ng driven through the SAME contract as
 * MotionStudioTts.exe, so core/tts.js needs no platform branches beyond
 * picking this file as the default "exe" —
 *
 *   linux-espeak.mjs --text-file <path> --out <abs .wav> [--voice v]
 *                    [--rate N] [--volume N]
 *   linux-espeak.mjs --list-voices
 *
 * stdout: ONE JSON line (array for --list-voices, {ok:...} otherwise).
 * Zero bytes downloaded, zero configuration: espeak-ng is a distro package
 * (`apt install espeak-ng`). Scratch-narration quality by design — the
 * documented upgrades are piper (local neural) or a cloud vendor.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const execFileP = promisify(execFile);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const fail = (code, error, exit = 1) => { out({ ok: false, code, error }); process.exit(exit); };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

async function espeak(argv) {
  for (const bin of ['espeak-ng', 'espeak']) {
    try {
      return { bin, ...(await execFileP(bin, argv, { maxBuffer: 4 * 1024 * 1024 })) };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }
  fail('backend_missing', 'espeak-ng is not installed. Install it from the distro (e.g. "sudo apt install espeak-ng") — or use the piper vendor for neural voices.', 2);
}

if (args.includes('--list-voices')) {
  // Column 2 of `espeak-ng --voices` is the language code `-v` accepts.
  const { stdout } = await espeak(['--voices']);
  const voices = stdout.split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  out([...new Set(voices)]);
  process.exit(0);
}

const textFile = opt('--text-file');
const outPath = opt('--out');
if (!textFile || !outPath) fail('bad_arguments', 'expected --text-file and --out (or --list-voices)');

const voice = opt('--voice');
// The contract's --rate is SAPI-style -10..10 around a normal speaking pace;
// espeak-ng takes words/minute (default 175).
const rate = opt('--rate');
const wpm = rate === undefined ? 175 : Math.max(80, Math.round(175 + Number(rate) * 15));
// --volume is 0..100; espeak-ng amplitude is 0..200.
const volume = opt('--volume');
const amplitude = volume === undefined ? 100 : Math.max(0, Math.min(200, Math.round(Number(volume) * 2)));

const argv = ['-w', outPath, '-s', String(wpm), '-a', String(amplitude), '-f', textFile];
if (voice) argv.push('-v', voice);

try {
  await espeak(argv);
} catch (err) {
  const text = `${err.stderr ?? ''}${err.message ?? ''}`;
  if (/unknown voice|voice not found/i.test(text)) fail('unsupported_voice', `espeak-ng does not know the voice "${voice}". Use a code from --list-voices (e.g. "en-us").`, 3);
  fail('synthesis_failed', text.trim() || 'espeak-ng failed', 1);
}
if (!fs.existsSync(outPath)) fail('synthesis_failed', 'espeak-ng exited 0 but wrote no file', 1);

const bytes = (await fsp.stat(outPath)).size;
out({ ok: true, voice: voice ?? 'default', outPath, bytes, engine: 'espeak-ng' });
