/**
 * macOS backend for the `system` speech vendor (Slice 0): the built-in `say`
 * command, same contract as the other backends (see linux-espeak.mjs).
 *
 * Written to Apple's documented flags but NOT yet exercised on a real Mac —
 * macOS is explicitly out of the linux-ready plan's scope. First macOS
 * deployment: run `node system-tts/macos-say.mjs --list-voices` and one
 * synthesis before trusting it, then delete this caveat.
 *
 * `say` has no volume flag; --volume is accepted and ignored (the film mixer
 * owns levels anyway — gainDb on the audio track is the supported control).
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

async function say(argv) {
  try {
    return await execFileP('say', argv, { maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    if (err.code === 'ENOENT') fail('backend_missing', '`say` not found — is this actually macOS?', 2);
    throw err;
  }
}

if (args.includes('--list-voices')) {
  const { stdout } = await say(['-v', '?']);
  const voices = stdout.split('\n')
    .map((line) => line.match(/^(\S(?:.*?\S)?)\s{2,}/)?.[1])
    .filter(Boolean);
  out(voices);
  process.exit(0);
}

const textFile = opt('--text-file');
const outPath = opt('--out');
if (!textFile || !outPath) fail('bad_arguments', 'expected --text-file and --out (or --list-voices)');
const voice = opt('--voice');
const rate = opt('--rate'); // contract: SAPI-style -10..10; say takes words/minute
const wpm = rate === undefined ? 175 : Math.max(80, Math.round(175 + Number(rate) * 15));

const argv = ['-o', outPath, '--data-format=LEI16@22050', '-r', String(wpm), '-f', textFile];
if (voice) argv.push('-v', voice);

try {
  await say(argv);
} catch (err) {
  const text = `${err.stderr ?? ''}${err.message ?? ''}`;
  if (/voice.*not found|unknown voice/i.test(text)) fail('unsupported_voice', `macOS has no voice named "${voice}". Use a name from --list-voices.`, 3);
  fail('synthesis_failed', text.trim() || '`say` failed', 1);
}
if (!fs.existsSync(outPath)) fail('synthesis_failed', '`say` exited 0 but wrote no file', 1);

const bytes = (await fsp.stat(outPath)).size;
out({ ok: true, voice: voice ?? 'default', outPath, bytes, engine: 'say' });
