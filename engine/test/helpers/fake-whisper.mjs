/**
 * Stand-in for whisper.cpp's whisper-cli, loadable through the
 * MOTION_STUDIO_WHISPER_BIN env hook — core/transcribe-whisper.js spawns a
 * `.mjs` target through the node binary, the same trick fake-piper.mjs uses.
 *
 * It exists so the suite never needs the real thing: `ggml-small.en.bin` is
 * 466 MB, and downloading half a gigabyte to assert a sentence split is not a
 * test, it is a network dependency.
 *
 * Honors the real flags, verified against whisper-cli (whisper.cpp, 2026-07):
 *
 *   --help                                 -> usage text, exit 0
 *   -m MODEL -f WAV -l LANG -ojf -of PREFIX [-t N] [-np]
 *                                          -> writes PREFIX.json, exit 0
 *
 * The JSON it writes is the **verbatim shape of a real `-ojf` document**,
 * including the two things the parser has to survive: decode windows whose
 * `text` crosses sentence boundaries, and special tokens (`[_BEG_]`,
 * `[_TT_n]`) with zero-width offsets.
 *
 * It records its argv so tests can assert the two things that are easy to get
 * wrong and impossible to see afterwards: that the engine passed `-ojf` (plain
 * `-oj` omits the tokens that per-word timing comes from) and that threads
 * reached `-t`. It writes them twice — to `<prefix>.args.json` for a human
 * poking at a temp dir, and to `FAKE_WHISPER_ARGS_OUT` if set, because the
 * engine deletes its temp dir on the way out.
 *
 * Fixture selection, so one stub covers every case:
 *   FAKE_WHISPER_FIXTURE=plan     the sample from the transcribe-asset design record (git history)
 *                                 (default) — one window, three sentences
 *   FAKE_WHISPER_FIXTURE=gap      two windows separated by 4 s of silence
 *   FAKE_WHISPER_FIXTURE=empty    a file with no speech in it
 *   FAKE_WHISPER_FAIL=<msg>       exit 1 with <msg> on stderr
 *   FAKE_WHISPER_NO_JSON=1        exit 0 and write nothing (an -oj-only build)
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (...names) => {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
  }
  return undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('usage: whisper-cli [options] file0 file1 ...\n  -m FNAME, --model FNAME\n  -ojf, --output-json-full\n');
  process.exit(0);
}

if (process.env.FAKE_WHISPER_FAIL) {
  process.stderr.write(`fake whisper failure: ${process.env.FAKE_WHISPER_FAIL}\n`);
  process.exit(1);
}

const model = opt('-m', '--model');
if (!model || !fs.existsSync(model)) {
  process.stderr.write(`error: failed to initialize whisper context (no such model: ${model})\n`);
  process.exit(1);
}
const input = opt('-f', '--file');
if (!input || !fs.existsSync(input)) {
  process.stderr.write(`error: failed to open '${input}' as WAV file\n`);
  process.exit(1);
}

const prefix = opt('-of', '--output-file');
if (!prefix) {
  process.stderr.write('error: this stub requires -of\n');
  process.exit(1);
}
fs.writeFileSync(`${prefix}.args.json`, JSON.stringify(args));
if (process.env.FAKE_WHISPER_ARGS_OUT) fs.writeFileSync(process.env.FAKE_WHISPER_ARGS_OUT, JSON.stringify(args));
if (process.env.FAKE_WHISPER_NO_JSON) process.exit(0);

const ms = (n) => {
  const h = String(Math.floor(n / 3600000)).padStart(2, '0');
  const m = String(Math.floor((n % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((n % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(n % 1000).padStart(3, '0')}`;
};
const tok = (text, from, to, p = 0.99) => ({
  text, timestamps: { from: ms(from), to: ms(to) }, offsets: { from, to }, id: 1000, p, t_dtw: -1,
});
const special = (text, at) => ({ ...tok(text, at, at, 0.999991), id: 50363 });
const window_ = (text, from, to, tokens) => ({
  timestamps: { from: ms(from), to: ms(to) }, offsets: { from, to }, text, tokens,
});

/**
 * The plan's sample, token-for-token: ONE decode window whose text starts
 * mid-sentence and crosses three sentence boundaries. Re-segmenting this
 * correctly is the single most load-bearing derivation in the tool, so it is the
 * default fixture.
 */
const PLAN = [
  window_(
    ' the salvation and the redemption of the entire world. Jordan death. Jesus Christ',
    8560, 16040,
    [
      special('[_BEG_]', 8560),
      tok(' the', 8600, 8860, 0.981),
      tok(' salvation', 8860, 9760, 0.994888),
      tok(' and', 9760, 10020, 0.97),
      tok(' the', 10020, 10240, 0.96),
      tok(' redemption', 10240, 11000, 0.988),
      tok(' of', 11000, 11180, 0.99),
      tok(' the', 11180, 11340, 0.99),
      tok(' entire', 11340, 11800, 0.97),
      tok(' world', 11800, 12400, 0.99),
      tok('.', 12400, 12400, 0.88),
      tok(' Jordan', 12900, 13400, 0.41),
      tok(' death', 13400, 13900, 0.35),
      tok('.', 13900, 13900, 0.71),
      tok(' Jesus', 14400, 14900, 0.96),
      // A zero-width token: whisper emits from === to when it has no better
      // estimate, and a word left an instant wide is a cue frame decided by
      // rounding.
      tok(' Christ', 15400, 15400, 0.93),
      special('[_TT_280]', 16040),
    ],
  ),
];

/** Two windows with a 4 s hole: speechRanges must report two spans. */
const GAP = [
  window_(' First span here.', 1000, 3000, [
    special('[_BEG_]', 1000),
    tok(' First', 1000, 1500, 0.99),
    tok(' span', 1500, 2000, 0.98),
    tok(' here', 2000, 2800, 0.97),
    tok('.', 2800, 2800, 0.9),
  ]),
  window_(' Second span, after a pause.', 7000, 9500, [
    tok(' Second', 7000, 7500, 0.99),
    tok(' span', 7500, 8000, 0.98),
    tok(',', 8000, 8000, 0.9),
    tok(' after', 8000, 8400, 0.97),
    tok(' a', 8400, 8600, 0.97),
    tok(' pause', 8600, 9300, 0.96),
    tok('.', 9300, 9300, 0.9),
  ]),
];

const FIXTURES = { plan: PLAN, gap: GAP, empty: [] };
const transcription = FIXTURES[process.env.FAKE_WHISPER_FIXTURE ?? 'plan'] ?? PLAN;
const language = (opt('-l', '--language') ?? 'en') === 'auto' ? 'en' : opt('-l', '--language');

fs.writeFileSync(`${prefix}.json`, JSON.stringify({
  systeminfo: 'fake | AVX = 1 |',
  model: { type: 'small', multilingual: false, vocab: 51864, mels: 80, ftype: 1 },
  params: { model, language, translate: false },
  result: { language },
  transcription,
}, null, 1));
process.exit(0);
