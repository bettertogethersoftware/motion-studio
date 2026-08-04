/**
 * Windows fallback backend for the `system` speech vendor (Slice 0): drives
 * System.Speech through PowerShell when the bundled MotionStudioTts.exe is
 * absent (a fresh clone — the ~95 MB exe is not committed). Same contract as
 * the exe; see linux-espeak.mjs for the shape. Values cross into PowerShell
 * via environment variables, never string interpolation, so voice names and
 * paths cannot break quoting.
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

async function powershell(script, env) {
  try {
    return await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    if (err.code === 'ENOENT') fail('backend_missing', 'powershell.exe not found on PATH — is this actually Windows?', 2);
    throw err;
  }
}

if (args.includes('--list-voices')) {
  const { stdout } = await powershell(
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    '$names = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }); ' +
    '$s.Dispose(); ConvertTo-Json -InputObject $names -Compress',
  );
  const parsed = JSON.parse(stdout.trim() || '[]');
  out(Array.isArray(parsed) ? parsed : [parsed]);
  process.exit(0);
}

const textFile = opt('--text-file');
const outPath = opt('--out');
if (!textFile || !outPath) fail('bad_arguments', 'expected --text-file and --out (or --list-voices)');
const voice = opt('--voice');
const rate = opt('--rate');    // SAPI-native: -10..10
const volume = opt('--volume'); // 0..100

try {
  await powershell(
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    'if ($env:MS_TTS_VOICE) { try { $s.SelectVoice($env:MS_TTS_VOICE) } catch { $s.Dispose(); Write-Error "UNSUPPORTED_VOICE"; exit 3 } } ' +
    'if ($env:MS_TTS_RATE) { $s.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$env:MS_TTS_RATE)) } ' +
    'if ($env:MS_TTS_VOLUME) { $s.Volume = [Math]::Max(0, [Math]::Min(100, [int]$env:MS_TTS_VOLUME)) } ' +
    '$text = [IO.File]::ReadAllText($env:MS_TTS_TEXTFILE, [Text.Encoding]::UTF8); ' +
    '$s.SetOutputToWaveFile($env:MS_TTS_OUT); $s.Speak($text); $s.Dispose()',
    {
      MS_TTS_TEXTFILE: textFile,
      MS_TTS_OUT: outPath,
      ...(voice ? { MS_TTS_VOICE: voice } : {}),
      ...(rate !== undefined ? { MS_TTS_RATE: String(Math.round(Number(rate))) } : {}),
      ...(volume !== undefined ? { MS_TTS_VOLUME: String(Math.round(Number(volume))) } : {}),
    },
  );
} catch (err) {
  const text = `${err.stderr ?? ''}${err.message ?? ''}`;
  if (/UNSUPPORTED_VOICE/.test(text)) fail('unsupported_voice', `Windows has no installed voice named "${voice}". Use a name from --list-voices.`, 3);
  fail('synthesis_failed', text.trim() || 'System.Speech synthesis failed', 1);
}
if (!fs.existsSync(outPath)) fail('synthesis_failed', 'System.Speech exited cleanly but wrote no file', 1);

const bytes = (await fsp.stat(outPath)).size;
out({ ok: true, voice: voice ?? 'default', outPath, bytes, engine: 'system.speech' });
