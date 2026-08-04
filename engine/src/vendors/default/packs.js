/**
 * The default-vendor pack manifest (vendor-boundary plan, Phase 3 / Slice B).
 *
 * A "pack" is a set of large runtime assets that never belong in git: each
 * file carries a pinned URL, a pinned SHA-256, and its byte size, and is
 * fetched ON COMMAND ONLY (`npm run fetch-pack -- <id>`) through
 * core/fetch-verified.js — synthesis and transcription never download
 * anything on their own; they return the structured `*_unavailable` naming
 * the command. Fetched files land under vendorDir() at each file's relative
 * `path` and are excluded from every distribution (they are re-fetchable by
 * pin, which is the point).
 *
 * Adding a pack is adding an entry here — the CLI, verification, listing,
 * and offline behavior are all generic. Keep pins honest: record the date
 * and how the hash was obtained beside each entry.
 */

export const PACKS_MANIFEST_VERSION = 1;

export const PACKS = Object.freeze({
  soundfont: Object.freeze({
    id: 'soundfont',
    title: 'MuseScore General SoundFont',
    summary: 'General MIDI SoundFont for the default `node` music vendor — the one download between a clean clone and synthesize_music.',
    enables: 'synthesize_music (node vendor)',
    license: Object.freeze({ name: 'MIT', url: 'https://github.com/musescore/MuseScore/blob/master/share/sound/COPYING.md' }),
    platforms: null, // all
    // The per-item env hook that overrides the fetched file if set.
    envOverride: 'MOTION_STUDIO_SOUNDFONT',
    files: Object.freeze([Object.freeze({
      path: 'soundfonts/MuseScore_General.sf3',
      // MuseScore's canonical mirror. Pinned 2026-08-04 from two
      // independently fetched copies (Slice 0's fetch-soundfont pilot).
      url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3',
      sha256: '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3',
      bytes: 39900972,
    })]),
  }),
  'whisper-model-base-en': Object.freeze({
    id: 'whisper-model-base-en',
    title: 'Whisper base.en model (English-only)',
    summary: 'The model half of transcription — whisper.cpp (whisper-cli) must be installed separately; this fetches ggml-base.en.bin beside it.',
    enables: 'transcribe_asset (whisper vendor, with whisper-cli installed)',
    license: Object.freeze({ name: 'MIT', url: 'https://huggingface.co/ggerganov/whisper.cpp' }),
    platforms: null,
    envOverride: 'MOTION_STUDIO_WHISPER_MODEL',
    files: Object.freeze([Object.freeze({
      // Under whisper/models/ — the exact folder the whisper vendor's
      // defaultModelsDir() searches, so a fetched model is found with no
      // env var or setting.
      path: 'whisper/models/ggml-base.en.bin',
      // Pinned 2026-08-04 from the Hugging Face LFS oid (which IS the
      // sha256), then confirmed by a verified download through fetch-pack.
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
      sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
      bytes: 147964211,
    })]),
  }),
  'whisper-model-base': Object.freeze({
    id: 'whisper-model-base',
    title: 'Whisper base model (multilingual)',
    summary: 'Multilingual sibling of base.en — Mandarin, Japanese, mixed-language speech with the appropriate -l set.',
    enables: 'transcribe_asset (whisper vendor, with whisper-cli installed)',
    license: Object.freeze({ name: 'MIT', url: 'https://huggingface.co/ggerganov/whisper.cpp' }),
    platforms: null,
    envOverride: 'MOTION_STUDIO_WHISPER_MODEL',
    files: Object.freeze([Object.freeze({
      path: 'whisper/models/ggml-base.bin',
      // Pinned 2026-08-04 from the Hugging Face LFS oid (the sha256).
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
      bytes: 147951465,
    })]),
  }),
});
