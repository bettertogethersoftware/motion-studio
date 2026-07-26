# Motion Studio — Changelog

## Unreleased

### Three more cloud speech vendors: ElevenLabs, OpenAI, Deepgram

`synthesize_speech` now speaks through six vendors. The new three follow the
Azure vendor's contract exactly — plain `fetch`, no SDK, PCM WAV whose header
is the authoritative duration, and **API keys read from the environment only**
(a key written into `settings.json` is refused with `invalid_config`, same as
Azure's):

- **`elevenlabs`** — the quality pick. Your account's voice library (voice_id
  or unique display name; premade preferred by default), `wav_*` output
  validated like Azure's formats (default `wav_24000` — 44.1k+ WAV is
  Pro-gated), model selectable (`eleven_multilingual_v2` default).
  `deterministic: true` now also works here, as a fixed request seed. Free
  tier: 10,000 credits/month, API included, attribution required. Needs
  `ELEVENLABS_API_KEY`.
- **`openai`** — `gpt-4o-mini-tts` (13 fixed voices, `marin` default; four are
  mini-only and model-gated). `style` becomes a natural-language instruction.
  Text past the 4,096-char cap is chunked at sentence seams and joined
  gaplessly (`chunked: N` reported). No free tier (~$0.015/min). Needs
  `OPENAI_API_KEY`.
- **`deepgram`** — the best free cloud tier: $200 signup credit, no card, no
  expiry (≈6.6M characters). Forty Aura-2 English voices (`aura-2-thalia-en`
  default), with an `aura-2-<speaker>-<lang>` passthrough for voices Deepgram
  ships without notice. 2,000-char cap, chunked like OpenAI. Needs
  `DEEPGRAM_API_KEY`.

Each is stubbed by a local HTTP fake (including ElevenLabs pagination and
Deepgram's Token-not-Bearer auth), so all six vendors are tested with zero
network. The "deterministic is Piper-only" warning now names the vendors that
do support it.

The Studio's speech page scales with them: the three new cards are **generated
from a descriptor table** (`CLOUD_VENDOR_CARDS` in `app.js`) rather than
hand-written — env-only key, voice pick, per-vendor knobs, ▶ test, and chain
checkbox/rank all come from the shared card grammar, so vendor #7 is a table
row, not fifty lines of markup. The settings dialog's environment report now
masks and lists the new key variables.

### Compose music from a chord progression — no more hand-written MIDI notes

`synthesize_music`'s `spec` now takes a **progression form** as an alternative
to writing notes by hand:
`{ bpm: 96, progression: ['D','A','Bm','G'], style: 'pad-ballad', bars: 8 }`.
A new pure compiler (`engine/src/core/music-theory.js`) expands chord symbols —
letters (`C`, `F#m`, `Bb7`, `Dmaj7`, `Esus4`, `C/E`) or roman numerals (`I`,
`vi`, `V7`, `bVII`) with `key` — across `bars`, voiced into styled layers
(`pad`, `pad-ballad`, `arp`, `drive`, `lullaby`), and emits the exact note spec
both vendors already accept, so neither renderer changed. Chords are
voice-led, registers are fixed per role (bass 36..50, arps 60..84), velocities
leave mix headroom, and every piece ends on a held tonic bar. Output is fully
deterministic; an optional integer `seed` varies the take via the same
mulberry32 PRNG the Frame API uses. Optional `beatsPerBar`, `layers` (subset)
and `key` refine the result; exactly one of `tracks`/`progression` is allowed,
and unknown chords/styles/layers fail as `invalid_music_spec` naming the
offender. The tool response gains `compiled: { style, bars, chords, notes }`.
See docs/music-setup.md §Composing without writing notes.

### Proxy/motion preview — check motion in ~1/8 the time

Preview stills answer "does frame 40 look right?"; they cannot answer "does
the move *read*?". The render tool's new `proxy: { scale?, frameStep? }`
option (CLI: `--proxy [scale] --frame-step N`) renders a cheap draft for
exactly that question: the Puppeteer viewport shrinks to `width×scale`
(default 0.5, floored to EVEN dims — mp4/webm/prores reject odd ones) with
the fixed-pixel composition mapped onto it by an inline
`transform: scale(sx, sy)` on `documentElement` (safe under the frame
contract: compositions never read window dimensions), and every
`frameStep`-th frame (default 2) is captured and encoded at the rational rate
`fps/frameStep` (`"30/2"` straight to `-framerate`), so wall-clock duration —
the thing being judged — is preserved exactly.

Deliberate constraints, all documented: proxies are serial (`workers` is
ignored — a proxy is already cheap, and a Chromium fan-out would cost more in
launches than it saves), skip pre-flight (the proxy IS the pre-flight), skip
the audio mux (it's a motion check; audio would dominate the time saved), and
the renderer itself inserts `.proxy` before the extension
(`output.proxy.mp4`), so a draft can never overwrite the deliverable.
`get_render_status` carries `proxy: { scale, frameStep }` so the Studio and
agents can tell a draft from the real thing. Works with every configured
format (gif/png-sequence/prores included); bad values fail up front with
`invalid_config` naming the offending field.

### Sentence timings no longer change the narration's pacing

`sentenceTimings: true` existed to *measure* a clip, but it was also silently
*lengthening* it: each per-sentence Piper run kept Piper's own ~0.2 s trailing
`--sentence-silence`, and `sentenceGapSeconds` was stacked on top — so the same
text came out ~(N−1)×0.2 s longer with timings than without, and cue frames
computed against one didn't fit the other. Root cause: `synthesizePiperSpeech`
already accepted `sentenceSilence`, but the vendor dispatcher never forwarded
it. The dispatcher now forwards it and the timings path passes
`sentenceSilence: 0`, so the engine-placed gap *replaces* the vendor's pacing,
which is what the docs always claimed.

Two adjacent fixes in the same handler:

- **`reportedDurationSeconds` was the last sentence's duration** in the
  timings path (`result` leaked out of the per-sentence loop) — a 28 s clip
  could report "1.17 s". It is now the vendor's summed self-report (sentences
  + gaps), kept distinct from the authoritative header-measured
  `durationSeconds`.
- **`deterministic: true` (Piper)** pins phoneme durations with
  `--noise-scale 0 --noise-w 0`. Piper's stochastic duration predictor moves
  clip length ±2% between identical runs — harmless for one-shot narration,
  poison for anything that computes cue frames from the clip and synthesizes
  again. Piper has no seed flag; zeroing both noise sources is its only
  determinism lever. Other vendors report the flag in `warnings` rather than
  silently dropping it, following the Azure-only options precedent.

### Studio: readable errors, honest statuses

- **`alert()` is gone.** Every error in the Studio UI now lands as a
  bottom-right toast: non-blocking, error code as a badge, and the full
  engine message — which already carries the fix and the available
  alternative vendors — stays until dismissed instead of being flattened
  into a modal one-liner. Info toasts fade on their own.
- **The music vendor codes joined `STATUS_FOR_CODE`.** A music preview
  against an unconfigured vendor returned a generic 500 where the identical
  speech case returned 503; `music_unavailable`/`invalid_music_spec`/
  `music_failed` now map like their speech twins, and
  `render_already_in_progress` / `project_already_exists` map to 409 so the
  UI can distinguish "try again later" from "pick another name".
- **Parallel renders honour the injected browser factory.** The Studio's
  `renderFn` handed `browserFactory` only to serial renders; a fake-browser
  test asking for `workers > 1` would have reached for real Chromium in the
  parent's preflight page. Same rule as the MCP server's
  `renderParallelInjected` now.

### Hygiene: one version, one license, no drift

- The MCP server advertised `0.15.0` while the engine was `0.19.0`; it now
  reads `package.json` at startup. The Frame API resource title said v1.1
  while the runtime was v1.3; the runtime file's own header said v1.2. All
  say v1.3, including `docs/frame-api.md` and both examples (whose bundled
  `frame-api.js` copies were two revisions stale and lacked `particles()`).
- `engine/package.json` said MIT while `LICENSE.txt` is the Unlicense; the
  package now agrees with the license file.
- The speech/music/addon enums in the MCP tool schemas are derived from
  `TTS_VENDORS` / `MUSIC_VENDORS` / `ADDON_IDS` instead of hand-copied
  string lists (`ADDON_IDS` existed "for tool schemas" and was never wired).
  Dead export `VENDOR_ENV` removed.
- README no longer promises committed example renders (`out/` has always
  been git-ignored) and no longer points at the nonexistent
  `docs/references/` path.

### The mixer no longer eats the end of the film

Three audio-mux bugs, one root pattern: the filter graph trusted ffmpeg's
defaults across streams of different lengths and formats.

- **`duck: true` silenced the bed from the last narration clip onward.**
  `sidechaincompress` stops producing output at its *first* input EOF, so the
  moment the (short) narration sidechain ended, the (long) music bed went with
  it — every ducked mix lost its tail, and any configured `fadeOutFrames` on
  the bed looked broken when it was actually never reached. Both compressor
  inputs are now silence-padded (`apad=whole_dur`) to the composition length
  so they reach EOF together. The asymmetric twin — a bed ending *before* the
  sidechain stalls the graph forever, burning CPU with no progress — is
  unreachable for the same reason. Repro'd with synthetic tones, fixed,
  and regression-tested at the graph level.
- **One 16 kHz mono narration WAV downsampled the whole mix to 16 kHz.**
  ffmpeg negotiates a common format across `amix` inputs, and Piper's native
  16 kHz output won that negotiation — the music bed lost everything above
  8 kHz. Every track chain now ends in `aformat` pinning 44.1 kHz stereo, so
  the negotiated format is fixed no matter what the sources are.
- **The muxer's trailing `apad` is now bounded (`whole_dur`).** With the duck
  branches ending at exactly the composition length, an unbounded pad feeding
  `atrim` busy-spins forever on some builds. No infinite generators anywhere
  in the graph: it terminates by construction.
- **`preview_audio` reports `mix.envelopeDb` + `mix.silentTailSeconds`** —
  per-second RMS of the mixdown (`null` = digital silence) and the length of
  the dead tail. Whole-file peak/mean reported healthy numbers on a mix whose
  last three seconds were silence, which is how the duck bug survived its own
  preview; the envelope makes that class of failure visible in the tool
  result. Backed by `measureWavEnvelope` in `core/tts.js`.

### Vendor preference chains — the tts/music pages take checkboxes, not radios

Both vendor pages picked exactly one vendor, and `core/vendors.js` argued against
ever trying another: a machine that quietly swapped synthesizers mid-film would
produce a soundtrack that changes character between scenes. That reasoning is
intact — what changed is that "one vendor" and "never fall back" turned out to be
separable. A capability can now hold an **ordered preference chain** and use the
highest-ranked vendor that is actually *set up*, which is the case the old rule
was over-serving: a missing Azure key is not a mid-film event.

- **`tts.vendors` / `music.vendors`** (settings): an ordered array of distinct
  vendors, or `null` for "just use the scalar `vendor`" — which is what every
  file written before now says, so nothing changes on upgrade. The scalar is
  still written as the chain's head, so anything reading it sees a coherent
  single choice.
- **`MOTION_STUDIO_TTS_VENDOR` / `..._MUSIC_VENDOR` accept a comma-separated
  list** (`piper,system`) for the same purpose. A single value is a chain of one.
- **The guarantees the narrow design keeps**, all tested:
  - *A named vendor is never redirected.* An explicit argument or single-valued
    env var resolves to a chain of exactly itself, so an agent asking for `azure`
    either gets Azure or gets `tts_unavailable` — never Piper instead.
  - *Only unavailability is fallen back past, never failure.* The walk skips a
    vendor whose probe says it is not configured. One that probes fine and then
    fails during synthesis is still a hard error.
  - *A one-entry chain probes nothing*, so single-vendor machines keep the old
    behaviour **and the old cost** — no extra exe spawns at resolution time.
  - *Falling back is always reported* — `skipped` in the engine, `vendorNote` +
    `vendorChain` on the MCP results, a warning line on the vendor pages.
  - *An exhausted chain reports its head*, so the error names the vendor the user
    actually asked for rather than whichever came last.
- **The honest caveat, stated in the module and the docs:** with a chain of two or
  more the choice is made per call, so a vendor that becomes unavailable *between*
  two narration calls in one film changes the voice of everything after it. A
  one-entry chain declines to pay that price, and is still the default.
- **`list_vendors` reports** `chain`, `preferred` (its head), `fellBack`, and a
  1-based `priority` per vendor. `active` keeps meaning *the vendor that will
  run* — with a chain that is the effective one, not merely the top preference.
- **Studio pages**: each card's radio became a checkbox with a `#1/#2/#3` rank
  badge and ▲▼ reorder buttons (hidden entirely for a chain of one), plus a
  summary line naming the vendor that will actually be used, what was skipped,
  and — new — whether an env var is overriding the page. Saving an empty chain is
  refused rather than silently defaulted.
- **Removed** the per-card `in use: yes (from settings)` fact row. It was painted
  from the server's report, so it contradicted the card highlight the moment a box
  was ticked; the rank badge, highlight, and summary line all follow the edit, and
  the "from settings/env" provenance moved to the summary, where it belongs — it
  is a property of the chain, not of each vendor.
- Internals: `resolveVendorFrom` returns the candidate `chain`;
  `walkVendorChain` + `chainFallbackNote` + `normalizeVendorChain` are new in
  `core/vendors.js`; `synthesizeWithVendor` / `synthesizeMusicWithVendor` accept a
  pre-resolved decision so the vendor that was probed is the vendor that runs
  (with live availability in play, resolving twice could legitimately disagree).

## v0.19 (2026-07-26)

Hear the mix before you render, know when narration lands, and stop hand-rolling
the same three things in every 3D composition.

### Audio you can check without rendering

- **`synthesize_speech` measures what it wrote.** The response now carries
  `peakDb`/`meanDb` of the narration clip (direct PCM read, no ffmpeg pass) —
  the same level report `synthesize_music` and `synthesize_sfx` already gave.
  Balancing a bed against narration no longer requires a full render to learn
  the mix was wrong.
- **`preview_audio` (new tool).** Mixes the project's `config.audio` timeline to
  a standalone WAV in `out/` using the *exact* filter graph the final render
  will use (delay, gain, trim/fades, ducking, limiter) minus the video. Returns
  mixed `peakDb`/`meanDb`, a `clipping` flag, and each source clip's own level
  so a bad balance points at the track that caused it. Fails with the new
  `no_audio_tracks` code on a project with no audio.

### Audio tracks grew edit controls (`config.audio`)

- **`trimEndInFrames` / `fadeInFrames` / `fadeOutFrames`** — all clip-relative,
  all in frames. `fadeOutFrames` ends at `trimEndInFrames` when set, otherwise
  at the composition end: the "7.5 s music bed under a 5 s video" case now
  resolves musically instead of hard-cutting at the last frame.
- **`duck: true`** — sidechain auto-ducking. A track marked `duck` is
  compressed by the mix of all non-ducked tracks (threshold ≈ −34 dBFS, ratio
  8, 50/400 ms), so the bed dips under narration and recovers in the gaps.
  Engages only when ducked and non-ducked tracks both exist. Also settable at
  attach time via `synthesize_music { duck: true }`.

### Narration timings (`synthesize_speech { sentenceTimings: true }`)

- Synthesizes per sentence, concatenates the clips locally
  (`sentenceGapSeconds` of silence between them, default 0.3), and returns
  `timings`: each sentence's start/duration in seconds AND frames. Captions and
  cues can be placed exactly instead of eyeballed. Works with every vendor —
  it needs no alignment support from the engine, which is also its honest
  limitation: word-level timing is NOT available (Piper's CLI cannot emit it,
  and Azure word boundaries would require the websocket Speech SDK, a heavy
  dependency this repo deliberately avoids).

### Three.js addons (`add_library`)

- **`geometries`** (THREE.TeapotGeometry), **`loaders`** (THREE.GLTFLoader),
  and **`postprocessing`** (EffectComposer / RenderPass / UnrealBloomPass /
  ShaderPass + their shader dependencies, vendored in load order) — from
  three's `examples/js` UMD builds at the pinned 0.134.0. The registry now
  supports multi-file addons; `lib-three`'s template gained the same
  `<!--__ADDONS__-->` injection point `lib-babylon` had. Why the core stays
  ≤0.147: r148 removed `examples/js` and r160 removed the UMD build, and
  compositions are plain `<script>` tags by design.

### Frame API v1.3

- **`MotionStudio.particles(frame, {count, lifeFrames, seed, speed})`** — a
  deterministic looping particle emitter (also exported bare as `particles`).
  Returns per-particle `{phase, cycle, u[4]}` states that are pure functions of
  frame; the four `u` randoms are stable per particle per cycle, so spawn
  jitter/size/drift never flicker between frames. Real particle systems are
  wall-clock based and banned by the frame contract; every composition was
  hand-rolling this exact loop.

### Smaller

- **`vendorNote` on explicit vendor overrides.** When `synthesize_speech` /
  `synthesize_music` is called with an explicit `vendor` that differs from the
  machine's configured default, the response says so — no more silently
  discovering that vendor-less calls use something else.
- **Docs/guidance: films get a dedicated output project.** `build_film`'s
  `outputProjectId` default (the first scene) meant agents assembling
  multi-scene films dumped the film and its master-audio assets into scene 1's
  folder. The tool description, `docs/SKILL.md`, and `docs/film-setup.md` now
  instruct agents to create a dedicated film project and pass it as
  `outputProjectId`. Code behavior is unchanged.

### Deferred

- ~~Proxy/motion preview~~ — shipped in this release (see "Proxy/motion
  preview" above).

## v0.18 (2026-07-26)

A third speech vendor, and the vendors page stops mixing the two capabilities up.

### `piper` — local neural narration (`core/tts-piper.js`)

[Piper](https://github.com/OHF-Voice/piper1-gpl) sits exactly where the other
two vendors left a gap: neural voice quality like Azure, running on your own
machine like the Windows exe. No account, no per-character billing, no network,
and it works on any OS.

- **Spawned, never bundled.** Piper is GPLv3; Motion Studio runs it as a
  separate program behind `MOTION_STUDIO_PIPER_EXE` (or
  `MOTION_STUDIO_PIPER_PYTHON` for the `python -m piper` form, or `piper` on
  PATH) — the same arm's-length arrangement it already has with FFmpeg and
  FluidSynth. It ships as a Python wheel rather than a standalone binary, so
  `pip install piper-tts` is the setup step, and the engine does not do it for
  you.
- **A bare `pip install piper-tts` works with zero configuration.** pip on
  Windows usually drops `piper.exe` into a Scripts folder that is not on PATH
  (it prints a warning saying so, and everyone ignores it). When nothing is
  configured and `piper` cannot be found, the engine falls back to
  `python -m piper`, then `py -m piper`; the probe reports which command
  actually answered. An explicitly configured path never falls back — a user
  who named a binary meant it.
- **Voices are files you download** — an `.onnx` and its `.onnx.json`, from
  huggingface.co/rhasspy/piper-voices, dropped in `MOTION_STUDIO_PIPER_VOICES`.
  Every model with its config becomes a voice; a model whose config is missing
  is skipped rather than offered, because Piper cannot load it. The
  `{locale}-{speaker}-{quality}` naming gives the catalogue its locale and
  quality without inventing metadata. Nothing is auto-downloaded: the engine
  has never fetched from the internet and this was not the place to start.
- **`--no-normalize` is always passed.** Piper otherwise normalizes every clip
  to full scale — the same trap `audioToWav` set on the music side — which
  would quietly overwrite the balance between narration and music. Verified
  against the real CLI: default output peaks at −0.0 dBFS, `--no-normalize` at
  −3 to −4.
- **`rate` maps to `--length-scale`** on the same scale the Azure vendor uses
  (each step is 10% of default speed), clamped to 0.4–3×, so switching vendors
  does not mean re-timing every line. `volume` becomes Piper's multiplier;
  Azure-only options are reported in `warnings` rather than dropped. Narration
  text goes through `--input-file`, never argv.
- Unlike the other generators, Piper's inference is stochastic — the same line
  does not render byte-identically twice. Documented rather than papered over;
  audio is generated once and thereafter read as a file.

### The Studio separates tts from music, and the status moves up

One 🗣 vendors page held both capabilities, with a single shared environment
block at the foot of it — so the speech variables (`MOTION_STUDIO_TTS_EXE`,
`AZURE_SPEECH_KEY`, …) rendered underneath the *music* cards and read as if
they belonged to them. There are now two pages, **🗣 tts** and **♫ music**,
each behind its own footer button, each holding only its own vendor cards,
audition controls and environment block (the Piper variables joined the speech
one; `MOTION_STUDIO_MUSIC_VENDOR` was missing from the environment report
entirely and is now included). **Saving a page writes only that page's
settings** — the tts page cannot rewrite music config it is not showing, and
vice versa. The engine status that shared the footer with the buttons moved to
the top of the sidebar, under the brand, so the footer is purely navigation:
🗣 tts · ♫ music · ⚙ settings.

### Tests

`test/helpers/fake-piper.mjs` honours the real CLI (verified against piper
1.6.0) and records the argv it was handed, so the tests can assert the two
things that are invisible afterwards: that `--no-normalize` is always sent, and
that `rate` arrives as a length scale. 17 new tests (374 total, 0 failures).

## v0.17 (2026-07-26)

Both audio generators get a second implementation, and one place to choose
between them. Until now "speech" meant spawn `MotionStudioTts.exe` and "music"
meant spawn a C# exe *and* `fluidsynth.exe` — which made both features
Windows-only, dependent on ~150 MB of binaries a fresh clone had to build, and
invisible in the UI. v0.17 adds **Azure AI Speech** and an **in-process Node
synthesizer**, a **vendors page** in the Studio, and a shared vendor mechanism
under both.

### Two capabilities, one mechanism (`core/vendors.js`)

```
speech  →  system (Windows exe)  |  azure (Azure AI Speech)
music   →  node   (spessasynth)  |  fluidsynth (C# exe + fluidsynth.exe)
```

`core/vendors.js` owns what the two axes share: the selection rule, the env
hooks, the shape of a status report, and the sentence a caller sees when a
vendor cannot be used. `core/tts-vendors.js` and `core/music-vendors.js` supply
the providers. Selection is layered and explicit —

```
argument  >  MOTION_STUDIO_<TTS|MUSIC>_VENDOR  >  settings.json  >  default
```

— with **no silent fallback anywhere**. A machine that quietly swapped
synthesizers mid-film would produce a soundtrack that changes character between
scenes, which is far worse than a clear failure naming what to install. What a
failure *does* do is name the other vendor if it happens to be ready.

The "active" vendor is read from settings **as stored**, not as merged, so the
UI can distinguish "the user picked this" from "this is what ships" — the two
read identically once defaults are applied.

### The Azure vendor (`core/tts-azure.js`)

- Plain Node against the documented REST API — `fetch` and nothing else. No
  SDK, no npm dependency, no binary to build, and it works on any OS. Two
  calls carry the feature: `GET /cognitiveservices/voices/list` and
  `POST /cognitiveservices/v1` (SSML in, RIFF PCM WAV out).
- Output is requested as `riff-*-pcm` because the rest of the engine already
  speaks PCM WAV: the duration is re-derived from the RIFF header by the same
  `parseWavHeader`, and FFmpeg re-encodes at mux time exactly as before. A
  non-RIFF format is refused before the request rather than breaking the
  duration contract downstream.
- Narration text is **escaped into SSML**, never interpolated: an ampersand in
  a script would otherwise be an HTTP 400, and a `<` would be an injection.
  `rate` keeps the exe vendor's −10..10 scale (each step = 10% of default
  speed) so a project can switch vendors without re-tuning every call.
- Expressive **styles** are supported (`newscast`, `cheerful`, …) and validated
  against the voice's own style list, so the failure names the voice and lists
  what it does support instead of relaying a bare 400.
- An unknown voice is `unsupported_voice` **with suggestions**, checked against
  the catalogue before any audio is requested — the same no-silent-substitution
  rule the exe vendor follows. A film whose narrator quietly changed between
  takes would be worse than a failed call.
- Error mapping splits *setup* from *failure*: a missing/rejected key, a wrong
  region, or an unreachable service is `tts_unavailable` (stop, tell the user);
  a rate limit, a 5xx, or a bad style is `tts_failed`.

### Credentials live in the environment, never in settings

`AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (also accepted:
`MOTION_STUDIO_AZURE_SPEECH_*`, `SPEECH_KEY`/`SPEECH_REGION`), matching how
`MOTION_STUDIO_FFMPEG` and the music toolchain already work. `settings.json`
holds only the non-secret half — region, default voice, output format, style —
and a patch carrying a `key` is rejected with `invalid_config` instead of being
quietly honoured. Every surface that reports the key reports `••••1234` plus
the variable it came from: the Studio page renders in a browser, and a key that
reaches the DOM is a key in every screenshot.

### One dispatch point (`core/tts-vendors.js`)

The alternative to two parallel speech paths. It owns the vendor list, the
"which vendor speaks" rule, and the probe/synthesize/list calls; both providers
return the same payload and probe shapes, so nothing downstream branches on
vendor. Selection follows the same precedence as every other setting:

```
synthesize_speech { vendor }  >  MOTION_STUDIO_TTS_VENDOR
                              >  settings.json tts.vendor  >  "system"
```

The default stays `system` deliberately — adding a cloud vendor must not start
billing an existing project's narration to someone's Azure subscription.
Options a vendor doesn't have are reported rather than dropped: `style` on the
system vendor succeeds and returns a `warnings` entry saying it was ignored.

### The Node music vendor (`core/music-node.js`)

- The whole music pipeline in-process: `spessasynth_core` (Apache-2.0, **no
  transitive dependencies**, ~2.5 MB) writes the MIDI *and* renders it against
  the same General MIDI SoundFont the exe chain uses. Music now works on macOS
  and Linux, and a fresh clone needs `npm install` rather than a .NET publish
  plus a FluidSynth download — ~74 MB of binaries stop being mandatory.
- **Faster by a wide margin**: 60 seconds of 4-track music renders in ~1.4 s
  (about 45× realtime) against ~5.3 s for the two-process chain on the same
  spec, with no process spawns. The same spec renders byte-identically twice.
- The library is imported *dynamically*, so an incomplete `npm install`
  degrades to `music_unavailable` like every other optional piece instead of
  taking the engine down at import time.
- Spec validation moved into JS (`validateMusicSpec`) and now runs for **both**
  vendors, so a bad spec fails the same way whichever renders it — and reports
  *every* bad field, not just the first one the exe happened to hit.

### Music levels stop depending on which vendor rendered

Two synthesizers do not agree on what a master gain means. Rendering one
identical spec through both, FluidSynth at its `-g 0.7` peaks at −9.1 dBFS while
spessasynth at 0.7 peaks at −16.1 dBFS — 7 dB quieter, which would silently
re-balance a film's music against its narration on a vendor switch. Two things
fix that:

- The Node vendor's default gain is **calibrated, not guessed**: gain is exactly
  linear there (0.7 → −16.14, 1.0 → −13.04, 1.575 → −9.10), so `1.575` is the
  value that lands a bed at the same loudness as the exe chain. Measured
  end-to-end afterwards: the same phrase peaks at −11.48 dBFS through `node` and
  −11.18 dBFS through `fluidsynth`.
- New `music.targetPeakDb` (default −3 dBFS) applies to **both** vendors and
  **only ever attenuates** — the rule `core/sfx.js` already used. A quiet
  arrangement stays quiet, because an agent that asked for quiet meant it.
  `synthesize_music` now reports the measured `peakDb` of what was actually
  written, plus `attenuatedDb` when the target pulled it down; an agent cannot
  hear the mix, so a measured number is the only signal it gets.

`spessasynth_core`'s `audioToWav` normalizes to full scale unless told not to,
which would have made every one of those numbers a fiction. It is called with
`normalizeAudio: false`.

### The Studio's vendors page (🗣 in the sidebar footer)

A full stage page, not another dialog — it holds four vendors' configuration,
several hundred voices, 128 instruments, and an audition player. It is split
into a **speech** section and a **music** section; each card shows live status,
where every value came from (`region: eastus ← AZURE_SPEECH_REGION`), and what
is missing if the vendor is unavailable.

- Speech: the Azure card filters the catalogue by locale/search, tracks the
  selected voice's styles, and **▶ test** speaks a line so you can hear a voice
  before committing a render to it (capped at 400 characters — an audition, not
  a render). A region supplied by the environment outranks the field, so the
  field is shown disabled with the variable that won, rather than accepting a
  value that would never be used.
- Music: SoundFont path, sample rate, synth gain and target peak, plus **▶
  listen** — a short phrase rendered on any of the 128 General MIDI instruments
  through the selected vendor. "Does this SoundFont have decent strings" is now
  answerable in two clicks instead of after a render.

New endpoints: `GET /api/vendors` (both capabilities),
`GET /api/vendors/speech/:id/voices`, `POST /api/vendors/speech/:id/preview`,
`POST /api/vendors/music/:id/preview` (both stream `audio/wav`), and `tts` /
`music` are now patchable through `PATCH /api/settings`.

### Agent surface

- `synthesize_speech` gains `vendor` and `style`, and reports the `vendor` /
  `vendorSource` / `warnings` it actually used.
- `list_voices` gains `vendor`, `locale`, `search`, `limit`, `offset` — Azure
  ships hundreds of voices, so paging is the default rather than an
  afterthought, and the response reports the true `total`. Azure voices carry
  `locale`/`gender`/`styles`; the system vendor still returns plain names.
- `synthesize_music` gains `vendor` and reports the `vendor` / `vendorSource` /
  `peakDb` it actually used.
- **New tool `list_vendors`** (28 tools): both capabilities in one answer —
  which vendor each will use and why, whether each is available, and exactly
  what the user must configure if not. The answer to a `tts_unavailable` /
  `music_unavailable` that an agent should not retry blindly. Takes an optional
  `capability` filter.
- Both tools pass the caller's `vendor` through *as given* rather than the
  resolved id, so `vendorSource` reports where the choice really came from
  instead of labelling every call an explicit argument.

### Tests

Both new vendors are stubbed rather than mocked, so the real code paths run:

- `test/helpers/fake-azure-speech.mjs` stands in for the service the same way
  `fake-tts.mjs` stands in for the exe — reached through the endpoint override,
  so headers, SSML body, WAV parsing and error mapping all execute against a
  local HTTP server with no subscription and no network.
- `test/helpers/tiny-soundfont.mjs` writes out the 890-byte soundbank
  `spessasynth_core` ships, so the music tests render **real audio through the
  real synth** without a 39 MB SoundFont or a committed binary fixture. The
  previous `fake.sf2` was 82 bytes of nothing, which only worked because the
  synthesizer itself was stubbed.

79 new tests across `tts-azure.test.js`, `vendors.test.js`,
`music-vendors.test.js` and the MCP suite (357 total, green on Windows).

## v0.16 (2026-07-26)

Global settings become actually global. v0.15 shipped the ⚙ settings dialog
under the heading "Global Settings" but scoped it to the Studio UI; agents
working over MCP ignored every value in it. The headline symptom: a machine
with FFmpeg installed somewhere other than PATH could be configured in the
dialog, render happily from the UI, and still fail *every* MCP tool call with
`prereqs_missing` telling the user to put FFmpeg on PATH — the exact thing
they had just configured their way around.

### ffmpeg.path reaches every entry point (the bug)

- One resolution rule, `core/settings.js` `resolveFfmpegPath()`, shared by the
  Studio, the MCP server, and the CLI: explicit override (CLI `--ffmpeg`) →
  `MOTION_STUDIO_FFMPEG` → `settings.json` `ffmpeg.path` → `ffmpeg` on PATH.
  The resolved binary feeds the prereq probe *and* the encode, so the check can
  no longer pass on one binary while the render reaches for another.
- The MCP server previously resolved a bare `ffmpeg` for both, ignoring
  `settings.json` entirely; it now feeds the resolved binary to the probe,
  `render`, and `build_film`. The CLI previously accepted only `--ffmpeg`, so a
  configured machine still needed the flag on every invocation; `--doctor` now
  also reports `effectivePath`/`source`, making it diagnose the binary a real
  render would use.
- New `MOTION_STUDIO_FFMPEG` env var. MCP servers are spawned by their client
  and routinely inherit a narrower PATH than the user's shell, so the env hook
  is the escape hatch that needs no Studio visit. It beats `ffmpeg.path` and
  is reported in the Studio's read-only environment panel.
- `renderParallel` now forwards `--ffmpeg` to its workers **always**, including
  the literal `"ffmpeg"`. It previously skipped forwarding that value as a
  no-op, which was safe only while the worker CLI had no defaults of its own —
  the moment it gained them, a parent meaning "use PATH" could have fanned out
  to workers resolving something else from the environment. Covered by a test
  that fails against the old forwarding.
- `prereqs_missing` now reports `ffmpeg.effectivePath` and `ffmpeg.source`
  (`env`/`settings`/`PATH`), matching the Studio's `/api/prereqs`, and the
  message no longer tells you to fix your PATH when you configured a path
  deliberately. The probe re-runs when the effective binary changes, so
  editing settings.json doesn't need a server restart.

### The rest of the settings follow

- `create_project` over MCP fills unset fps/width/height/durationInFrames from
  `newProjectDefaults`, and seeds `crf`/`preset` from the ffmpeg encode
  defaults exactly as the Studio does. Its dimension fields changed from zod
  `.default()` to `.optional()` — a `.default()` is indistinguishable from a
  caller who meant that value, which would have made "explicit wins"
  unenforceable.
- `render` over MCP uses `render.defaultWorkers` when `workers` is omitted,
  and the response now reports the `workers` it actually used.
- The Studio's `POST /api/projects/:id/render` gained the same server-side
  fallback (the UI already seeded its form), so a direct API caller behaves
  like every other path.
- Both front ends now merge through `withNewProjectDefaults` /
  `outputSeedFromSettings` in `core/settings.js` instead of doing it locally,
  so the Studio and MCP cannot drift on what a default means.

### Invariants (unchanged, now written down)

- **Explicit wins.** Globals fill gaps only; an agent told to render 4K
  vertical still gets 4K vertical.
- **Creation-time only.** No existing `project.json` is ever rewritten because
  a global changed — a project renders tomorrow the way it renders today.
  This is what keeps the reproducibility argument for the old scoping intact.

## v0.15 (2026-07-25)

Studio management surface: the web UI can now fully manage projects, assets,
and a small set of global preferences — previously create/configure was the
only lifecycle the UI offered (delete existed in the API but had no button),
assets could only arrive via MCP or a file manager, and there was no global
configuration anywhere.

### Projects: complete the CRUD loop in the UI

- **delete project…** (config tab) opens a confirm dialog wired to the
  existing `DELETE /api/projects/:id`. "Also delete files on disk" maps to
  `?deleteFiles=1`; as before, folders outside the managed projects root are
  never deleted from disk, and the dialog says so.
- **location** row in the config tab shows the project's absolute folder path
  with a copy button — the "where is this actually?" answer the UI never gave.
- The new-project dialog is pre-filled from the user's saved defaults (below).

### Assets: first-class CRUD (new *assets* tab)

- `GET /api/projects/:id/assets` — recursive listing of `assets/` with size,
  mtime, and a coarse kind (image/audio/font/data). Backed by the new
  `ProjectStore.listAssets`.
- `PUT /api/projects/:id/asset?path=assets/…` — **raw-body** upload (no
  base64 detour, so the browser can stream a `File` directly); shares the
  25 MB cap, extension allow-list, and assets/-confinement with the MCP
  `write_asset_file` tool via the extracted `ProjectStore.writeAssetBuffer`
  (the base64 tool now decodes and delegates — one enforcement point).
- `GET /api/projects/:id/asset?path=…&download=1`, `DELETE …/asset?path=…`,
  and `POST …/asset/rename {from,to}` (rename refuses to clobber an existing
  destination). All go through the same path sandbox; escapes are 403s.
- The tab shows image thumbnails (served through the existing sandboxed
  `/preview/:id/` route), in-place audio audition, upload via button or
  drag-and-drop, per-asset copy-relative-path (the string you paste into a
  composition), download, rename, and delete. The assets folder's absolute
  path is shown with a copy button.

### Global configuration (new ⚙ settings dialog + `core/settings.js`)

- `<dataDir>/settings.json` — user preferences with a validated schema:
  `newProjectDefaults` (fps/width/height/durationInFrames) and
  `render.defaultWorkers`. Read/patched via `GET`/`PATCH /api/settings`;
  writes are atomic (temp + rename), unknown keys are rejected, and a
  corrupted file degrades to defaults instead of bricking the UI.
- Scope is deliberate: settings seed the Studio's forms only. They never
  override a project's `project.json` and are not consulted by the CLI or the
  MCP server — agents stay explicit. Machine-level knobs stay env vars.
  *(Reversed in v0.16: the MCP server honours them too.)*
- The dialog also reports the environment read-only: data dir, projects
  root, registry/settings paths, and the `MOTION_STUDIO_*` /
  `PUPPETEER_EXECUTABLE_PATH` hooks with their current values.

### The viewport stops jumping when you switch tabs

The workbench grid was `1fr auto`, so the bottom panel was sized by whatever
tab was open and the preview resized under you on every tab switch — the one
thing a scrubbing surface must never do. It is now a fixed **50/50 split**
(`1fr 1fr`) with each tab body scrolling inside its own half, so the viewport
height is identical on render/config/audio/assets/outputs.

A **▾ toggle** at the right end of the tab bar collapses the panel to just its
tabs, giving the preview the full height (measured: 356 px → 774 px on a
900 px window); ▴ brings it back, as does clicking any tab while collapsed.
The state persists per browser and the preview re-fits on each change.

### Project list: sorting + collapsible sidebar

- Sort toggle in the sidebar header: **a–z** (case-insensitive by name) or
  **date** (last modified, newest first — the date is shown per row in this
  mode). Choice persists per browser (localStorage).
- The sidebar collapses to a 46 px strip (« / » button, persisted); the
  preview re-fits to the reclaimed width.

### ffmpeg: global binary path + encode defaults

`settings.json` gains an `ffmpeg` block, editable from the settings dialog:

- **`ffmpeg.path`** — binary override (null = `ffmpeg` on PATH). Honored by
  `/api/prereqs`, every Studio render job (threaded through
  `JobManager.startRender`), and — new `--ffmpeg <path>` CLI flag — by
  `render.js`, including `--doctor`. `renderParallel` forwards the flag to its
  worker processes, since each worker encodes its own segment and a parent /
  worker binary split would be silent. The settings dialog live-probes the
  effective binary and shows `✓ <version> via PATH|settings` or `✗ not found`;
  a bad path is saved (it may not exist *yet*) but the footer/banner reflect
  it immediately. The MCP server intentionally keeps using PATH — its
  environment is the agent host's concern.
- **`ffmpeg.defaultCrf` / `ffmpeg.defaultPreset`** — seed *newly created*
  projects' `output` config (null = the engine's per-format defaults).
  Existing projects keep their own values, per the settings-seed-only rule.

### Every project.json field is visible (and mostly editable)

The config tab showed 8 of the ~15 fields a project actually carries; the rest
could only be inspected by opening `project.json` in an editor. Now:

- **Full output block** — `dir`, `filename`, `preset`, `pixFmt` and
  `audioLimiter` join format/crf/transparent. Fields a format doesn't consume
  are shown **disabled rather than hidden** (with a per-format note saying
  why), so the tab is a complete picture rather than a curated subset.
- **`null` clears a field.** The config PATCH merge means an omitted key keeps
  its current value, so there was no way to remove one; the handler now drops
  null-valued `output` keys, which is how the UI un-sets e.g. an x264 preset.
- **Project facts** (read-only): `entry`, `schemaVersion`, track count,
  attached `libraries`, and each `libraryBuilds` entry's version, short
  sha256 and size — the render provenance recorded in v0.13 had never been
  visible anywhere.
- **Raw `project.json`** in a disclosure at the bottom, so nothing is hidden
  by construction.

### Audio timeline editor (new *audio* tab)

`config.audio` — the one genuinely structured part of a project — was
invisible in the UI; seeing a film's timeline meant reading JSON. The new tab
edits tracks directly: `src` (autocompleted from the project's audio assets),
`startInFrames` (with the frame→seconds conversion shown live), `gainDb`,
plus per-row audition and remove. Edits stage in memory and commit with one
PATCH, so a half-typed path never reaches disk. For formats that can't carry
audio (gif, png-sequence) the tab says so rather than silently ignoring the
tracks at render time.

### One audition player, and ▶ actually stops

The assets and audio tabs each grew their own preview-playback code, and the
audio tab's could start a clip but never stop it — clicking ▶ again just
layered another copy on top. Both now call a single `toggleAudition`:

- ▶ ⇄ ⏸ on the same button; starting a clip stops whatever was playing.
- Buttons fall back to ▶ when playback **ends, errors, or is superseded**, so
  a mistyped path can't strand a ⏸ that no longer stops anything.
- The state is synced across tabs by path, so a clip started from the assets
  tab shows its stop control on the matching audio-track row too.
- A track row with no path yet has its button disabled, and switching
  projects stops playback — previously the clip kept playing while its stop
  button was removed from the DOM with the old project's rows.

### Asset management reaches the agent surface (3 new MCP tools)

The v0.15 asset work initially landed in the core and the Studio only, leaving
agents able to *write* an asset but never list, rename, or remove one — so a
project accumulated every failed narration take with no way to clean up. Tool
count 24 → 27:

- **`list_assets { projectId }`** — everything under `assets/` with `path`,
  `bytes`, `mtime`, `kind`, and `audioRefs`. `get_project` lists files too,
  but undifferentiated and without reference counts; this is what separates a
  load-bearing asset from an orphan.
- **`delete_asset { projectId, path, updateAudio? }`** and
  **`rename_asset { projectId, from, to, updateAudio? }`** — thin wrappers over
  the same `ProjectStore` methods the Studio uses, so there is one
  implementation of the sandbox, the clobber refusal, and the track rewrite.

`audioRefs` is reported unconditionally on all three. The flag matters more
for agents than for humans: a person gets a dialog listing the affected
tracks, whereas an agent that deletes a referenced file would otherwise learn
about it as an ffmpeg mux failure minutes into the next render.

### Deleting an asset no longer silently breaks the audio timeline

Removing (or renaming) a file that `config.audio` references used to succeed
quietly and fail much later, as an ffmpeg mux error minutes into the next
render. Now the reference is tracked end to end:

- `listAssets` reports **`audioRefs`** per file, and the assets tab shows a
  **♫ n** badge — the consequence is visible before the click, not only in
  the confirm dialog.
- **`deleteAsset(id, path, {updateAudio})`** and
  **`renameAsset(id, from, to, {updateAudio})`** report `audioRefs` always,
  and when asked, drop or rewrite exactly the matching tracks in one
  `updateConfig` (other track fields — start frame, gain — survive a rename).
  Exposed as `?updateAudio=1` on the DELETE and `updateAudio` in the rename
  body; the response carries the new config so the UI stays in step.
- The delete dialog lists the offending tracks and offers "also remove those
  audio tracks", checked by default. Declining is allowed and leaves the
  reference dangling on purpose — the point is that it is never silent.
  Matching is lenient (slashes, leading `./`, case) so a reference is caught
  rather than missed.

### Fixed: "Prerequisites missing:" with nothing after it

The banner built its text from `p.problems`, a field `checkPrerequisites()`
has never returned (it reports `node`/`ffmpeg` blocks) — the `|| []` swallowed
it, so the banner rendered a bare label. Latent since v0.5 and near
unreachable, but the new ffmpeg path override made a typo enough to trigger
it. The text is now derived from the actual response, and `/api/prereqs`
additionally reports `ffmpeg.effectivePath`, `ffmpeg.source` and the version
`minimums`, so the banner reads e.g. *"ffmpeg not found at C:/wrong/ffmpeg.exe
(path from settings — clear it to use PATH)"*.

### Tests

`test/studio.test.js` grows from 10 to 19 cases: settings defaults/patch/
validation/persistence, new-project default inheritance (explicit fields still
win), the full asset upload→list→download→rename→delete loop, sandbox
enforcement on every asset endpoint, the ffmpeg block (probe report, path
override reflected in `/api/prereqs`, crf/preset seeding), prereq path
attribution, whole-output-block patching including null-clearing, and audio
track round-tripping with validation.

`cli: SIGTERM mid-render cancels with exit code 4` now **skips on Windows**
instead of failing there permanently. Windows has no signal mechanism, so
`child.kill('SIGTERM')` falls back to `TerminateProcess()` — the process dies
before any handler runs and `close` reports `null` instead of the CLI's exit
code 4. The assertion is POSIX-only and was never fixable in the engine;
cancellation on Windows goes through `JobManager.cancel`'s in-process abort,
which is covered on every platform. A permanently-red case teaches you to
skim past failures, so the Windows suite is now green at 259 passed /
0 failed / 2 skipped.

## v0.14 (2026-07-25)

Hardening from the first full dogfood run (an 8-scene, five-minute narrated
film): every item below is a defect or friction that run surfaced.

### Capture crashes self-heal in-job (`browser_crashed`)

Headless Chromium dies intermittently mid-screenshot on long renders
(`Protocol error (Page.captureScreenshot): Target closed`) — flaky, not
load-dependent (docs/knowledge-base.md §4.3). Previously one flake failed the
whole job: an 86%-done scene lost all its captured frames and re-rendered from
zero, and the error surfaced as `internal_error` (or worse, `composition_error`
when the crash landed inside `page.evaluate`, blaming the user's composition
for a browser fault).

- **`browser_crashed`** — new error code. `core/browser.js` classifies every
  crash-shaped rejection (`Target closed` / `Target crashed` / `Session
  closed` / `Connection closed` / detached frame / generic `Protocol error`)
  at all four capture touchpoints (`evaluate`, `waitForFunction`, the
  `__frameError` read, `screenshot`), and exports `isBrowserCrash()`.
- **In-job recovery** — the serial capture loop (which is also what every
  parallel worker runs) relaunches the browser and retries the *same frame*,
  up to `CRASH_RELAUNCH_LIMIT` (3) relaunches per render with 500 ms·n
  backoff. Frames already piped to the FFmpeg sink are kept, so a flake now
  costs ~a second instead of the scene. Each relaunch is logged (`get_logs`)
  and reported via `onChildPid` for process-tree cleanup.
- A render that spends the whole budget fails with `browser_crashed` and
  `detail.relaunches` — the code now genuinely means "this machine keeps
  crashing", which is an actionable signal instead of noise. Aborts inside a
  crash window keep their `cancelled` semantics.

### `wait_for_render` — block instead of poll

Agents watched the render queue with per-job `get_render_status` polling loops
(or, worse, file watchers that are structurally blind to failed jobs — silence
looks identical to "still rendering"). New tool:

- `wait_for_render { jobIds: [1..16], timeoutMs?: 1s..10min (default 5min) }`
  blocks until **every** listed job is `done`/`error`/`cancelled`, or the
  timeout elapses. Returns `{ timedOut, jobs }`, each entry in the
  `get_render_status` shape (structured `error`, measured `audio` block).
- A timeout is **not** an error: the jobs keep running and the caller gets
  current snapshots with `timedOut: true`. Unknown ids fail up front with
  `job_not_found`. Backed by `JobManager.waitFor()` (250 ms internal poll).

### SFX: clamped cues are named

`synthesize_sfx` reported `clamped: 1` — *something* was truncated, no way to
tell what, or whether it mattered. `renderCues` now also returns
**`clampedCues: [{ cue, type, atSeconds, lostSeconds }]`** (index into
`spec.cues`, and how much tail ran past the end of the bed); the MCP response
includes it whenever `clamped > 0`. A finale chime losing 2 s of decay is
taste; a whoosh losing its fall is a timing bug — now distinguishable without
listening.

### Docs

- **film-setup.md**: two techniques the dogfood film proved out — *tiling a
  short music loop* as repeated master-timeline entries stepped by
  `musicalDurationSeconds × fps` (the reverb tail becomes a free crossfade at
  each seam), and *multi-clip / multi-voice narration offsets* chained from
  measured clip durations with a 15–20-frame breath gap. Long-batch guidance
  updated for in-job recovery, `wait_for_render`, and skipping redundant
  pre-flights after `capture_preview_frames`.
- **SKILL.md / mcp-setup.md**: wait-don't-poll flow, `browser_crashed`
  handling, sharper `preflight: false` guidance.
- **knowledge-base.md §4.3** marked FIXED IN ENGINE; **architecture.md** error
  model updated.

## v0.13 (2026-07-25)

### Vendored 3D builds are pinned and content-locked

`libraries.js` declared Babylon as `version: 'stable'` against
`https://cdn.babylonjs.com/babylon.js`, and `engine/vendor/` is git-ignored. Two
independent problems hid in that: **acquisition** (two machines fetching at
different times vendor different builds) and **provenance** (a project could not
say what it rendered against, even on one machine).

A version pin alone fixes only the first — and, measurably, not even that.
`/babylon.js` and `/v9.18.0/babylon.js` both self-report `Version="9.18.0"` and
are **different code**: 8,180,880 vs 8,180,848 bytes, diverging around byte
2,317,477 where the floating build carries an extra `var t;`. A version string is
a claim; a hash is a fact. So the fix is content-addressed.

- **`engine/vendor.lock.json`** — committed, unlike the artifacts it describes.
  Records `{ version, sha256, bytes, url }` per vendored build, keys sorted for a
  stable diff. Deliberately *not* inside `engine/vendor/`, which is ignored
  wholesale — the same split npm and cargo use.
- **`core/vendor-lock.js`** — hashing, self-reported version detection, and
  verification. `detectVersion` reads what the **bytes** say rather than trusting
  the URL, and returns `null` rather than guessing: three's `REVISION` minifies to
  `const e="134"` (and `134` also appears in colour constants) and the Babylon
  loaders bundle has no banner at all. The hash is the identity; the version is a
  courtesy label.
- **`fetch-libs.mjs`** hashes every download and **refuses to overwrite on
  mismatch**, so a failed run cannot half-upgrade the vendor dir. `--update` is
  the only way to change the lock; `--verify` checks disk against it and exits 1
  on drift, printing both hashes.
- **Both libraries pinned to versioned URLs.** Babylon → `/v9.18.0/babylon.js`
  and `/v9.18.0/loaders/babylonjs.loaders.min.js` (versioned paths need the `v`
  prefix — `/9.18.0/…` 404s). Three was already pinned; Babylon was the outlier.
- **`config.libraryBuilds`** — `add_library` now stamps `{ version, sha256,
  bytes }` per copied file into the project, and each `copied` entry carries its
  `sha256`. This is the half a URL pin cannot give: a finished render is traceable
  to exact bytes despite the vendor dir being ignored.

Because the pinned build is *not* the one that produced the 15-second space-jump
video, the swap was verified by re-rendering a frame of the ship — identical, so
the `var t;` difference is immaterial here. Only checking established that.

### `engine/vendor/libs` is now committed

Decided after the above, and it changes what the lock is *for*. Of the 215 MB in
`engine/vendor/`, only `libs/` is a sane thing to track: ~9 MB of immutable
third-party JS (three.js MIT, Babylon Apache-2.0), no build step. Everything else
stays ignored — the 94 MB and 65 MB exes are build artifacts of tracked C# source,
git keeps every version of a binary forever, and no LFS is configured here (at
94 MB the TTS exe is close to GitHub's 100 MB hard limit).

So `add_library` now works on a **fresh clone with no setup and no network**, and
`scripts/fetch-libs.mjs` is an upgrade/repair tool rather than a prerequisite.

With the builds committed, **git is the integrity mechanism** and
`vendor.lock.json` keeps only the jobs git cannot do:

- **origin** — git records content, never where it came from. The lock pairs each
  committed file with the exact upstream URL, version and hash.
- **drift** — `fetch-libs.mjs` can overwrite committed files, so hash-checking on
  download turns an accidental dependency bump into a refusal rather than an
  unreviewed diff in someone's next commit.

`config.libraryBuilds` is likewise **not** redundant: git says what the repo holds
*now*, `libraryBuilds` says what a project copied *then*, and those diverge the
moment the libraries are upgraded — the second is what a finished render was made
from.

`.gitignore` gotcha, verified in a scratch repo: the rule had to become
`engine/vendor/*` + `!engine/vendor/libs/`. With `engine/vendor/` (trailing slash)
git never descends into the directory and the negation silently does nothing.

Docs: `3d-libraries.md` §3.5 rewritten with the pinning/locking workflow, and its
old "jsdelivr renders nothing" warning narrowed — that described a 6.8 MB
artifact, whereas at 9.18.0 jsdelivr and the versioned `cdn.babylonjs.com` path
serve the same 8,180,848 bytes. Its intro no longer claims glTF loading is "not yet
working" (§3 has said RESOLVED since v0.12). `knowledge-base.md` §8.3 upgraded from
"deliberately not fixed" to the measurement that drove the design, plus the
commit-the-libraries decision that superseded half of it.

Tests: +10 (`vendor-lock.test.js`), including a check that the **real** committed
lock is internally consistent and version-pinned, so a hand-edit fails here rather
than at someone else's clone. 241 total.

## v0.12.1 (2026-07-25)

Two bugs found by reviewing v0.12 against a real 3D render, plus the knowledge
base that round produced.

- **`validateSfxSpec` was incomplete.** Per-type parameter checks (pitch/hz
  exclusivity, `wave`, shimmer `pitches`, negative `decay`/`dur`) lived inside the
  generators' `render` functions, so the exported validator returned happily on a
  spec that `renderCues` then threw on — defeating the point of validating up
  front. Each generator is now split into `resolve(cue,i) → params` (validates,
  applies defaults, reports `lengthSeconds`) and `render(out,n,params,…)` which
  trusts them; validation completes before a single sample is allocated. `seed` is
  validated too. A new test asserts the *property* rather than cases: every spec
  `renderCues` rejects, `validateSfxSpec` must also reject.
- **`addLibrary` dropped addon notes.** The registry has always carried them — the
  `loaders` addon's note documents that loading a model needs
  `MOTION_STUDIO_ALLOW_LOCAL_FETCH=1`, the single most common way a glTF render
  fails — but only `spec.notes` was returned, so a core-level caller never saw it.
  Addon notes are now appended to `notes`, attributed as `[loaders] …`, with a test
  asserting the string survives. `addons` deliberately stays a plain id array: an
  existing test caught that changing its shape would break the public result.

Docs: new **[knowledge-base.md](knowledge-base.md)** — every problem hit while
making four videos in one run, as symptom → root cause → fix → lesson.
`3d-libraries.md` §3.2 gains the normalization-scale trap (never animate the node
carrying a fixed transform) and **corrects** its own "PBR renders black without
IBL" note: the 15-second space-jump render lit the same 11-material,
metallic-≈0.68 GLB to a clean grey with no `environmentTexture` at all, so IBL buys
reflections rather than visibility.

## v0.12 (2026-07-25)

### `synthesize_sfx` — sound effects, with nothing to install

The gap this closes: `synthesize_speech` makes a voice, `synthesize_music` makes
pitched notes, and neither can make a **noise**. Three films needed whooshes on
cuts, chimes between scenes, a thud on an impact and a shimmer under a reveal, and
each one hand-rolled ~100 lines of DSP plus a raw RIFF writer to get them —
outside the engine, outside its tests, reinvented every time. `synthesize_music`
was never the answer: a filtered-noise riser has no MIDI note number, and
requiring FluidSynth and a SoundFont to produce a 400 ms whoosh is the wrong
dependency shape.

- **`core/sfx.js` — pure JS, no toolchain.** Unlike speech (Windows TTS exe) and
  music (MIDI exe + FluidSynth + SoundFont), this has no external dependency at
  all, so there is deliberately **no `sfx_unavailable`** twin to
  `music_unavailable` — it can always run, on every OS. Split into a pure
  `renderCues(spec) → Float32Array` and a thin `synthesizeSfx({spec, outPath})`,
  so nearly every test inspects samples directly with no ffmpeg and no subprocess.
- **Five generators**, each lifted from code already validated on screen rather
  than invented fresh: `chime` (inharmonic bell partials 1/2/2.76/4.16/5.43, upper
  ones decaying faster, 4 ms attack), `whoosh` (seeded noise through a sweeping
  one-pole LP + HP, quartic rise landing exactly on the cue), `shimmer`
  (micro-detuned sine stack, per-voice tremolo, filtered air beneath), `thud`
  (descending sine + octave, 90 ms attack so it settles rather than clicks), and
  `tone` (oscillator + AR envelope) as the escape hatch. Descending-pitch cues
  accumulate phase instead of evaluating `sin(2π·f(t)·t)`, which sweeps about
  twice as fast as its own frequency curve claims — a bug shipped by hand twice
  before it got written down.
- **Time is in frames.** `atFrame` is primary because every other audio placement
  in the engine speaks frames (`config.audio.startInFrames`, `build_film`'s
  timeline, a scene's `filmOffset`), which turns "a chime on every scene cut" into
  a map over scene offsets instead of a hand-computed division that hides
  off-by-ones. `at` in seconds is accepted; exactly one of the two, since silently
  preferring one would let a typo look like it worked.
- **`gain` is a peak amplitude, not dB.** Each cue is scaled so its peak equals
  its `gain`, which is what makes `0.4` mean the same thing for a bell, a noise
  sweep and a sub thud — instead of `gain` being a per-generator fudge factor.
  Passing a dB value is rejected.
- **It leaves a quiet bed quiet.** `normalize` defaults to `'ceiling'`:
  attenuate *only if* the mix exceeds `ceilingDb` (−1 dBFS), reporting
  `rawPeakDb`, `peakDb` and `appliedGainDb`. `'peak'` and `'none'` are available.
  The earlier design sketch called for always normalizing to −1; that was wrong
  and contradicted v0.11 — a bed normalized to the ceiling reports a peak that
  tells the caller nothing and then has to be undone with a large negative
  `gainDb` at mix time (both hand-rolled beds sat near −20 purely to cancel their
  own normalization). Same principle as `audioTargetPeakDb`: a reported number
  should be measured truth, not an artifact of an automatic correction.
- **Bounded determinism, stated rather than implied.** Noise comes from a seeded
  PRNG (per-cue seeds, so two identical cues are not copies), and a spec
  re-renders byte-identically on a given Node build — asserted in the tests. It is
  **not** guaranteed across Node/V8 versions, because ECMAScript does not pin
  `Math.sin`/`Math.exp`. Pinning that would mean fixed-point transcendental
  tables, which is not worth it for a sound-effects bed. Frame-render determinism
  is untouched: that is a property of the composition, and audio is generated once
  and thereafter read as a file.
- **Budgets and honest edges.** 512 cues, 30 s per cue, `sampleRate` ∈
  22050/44100/48000. A cue *overhanging* the end is clamped and counted in
  `clamped`; a cue starting *past* the end is an error — overhang is a taste
  decision, placement outside the piece is a bug. Bad specs fail with the new
  **`invalid_sfx_spec`**, carrying the offending cue index in `detail`.
- **MCP tool `synthesize_sfx`** mirrors `synthesize_music` field for field
  (`projectId`, `spec`, `mode: attach | asset-only`, `assetPath?`,
  `startInFrames?`, `gainDb?`), and inherits `fps` **and** the default bed length
  from the project so a bed spans the composition by default. It writes
  server-side, which matters: a 10-minute 44.1 kHz mono bed is ~53 MB, over
  `write_asset_file`'s 25 MB cap. `sampleRate: 22050` halves it.

Verified against the real thing: regenerating the 9.8-minute Bible film's bed (18
cues) through the engine took 891 ms and matched the hand-rolled version's mean
level exactly (−28.8 dBFS both). The peak differs by design — −3.6 instead of
−0.9 — because the engine leaves the quiet bed at its natural level instead of
normalizing it, which is the point.

Docs: new [sfx-setup.md](sfx-setup.md); `architecture.md` §9.1 compares the three
generated-audio sources by dependency; rows/sections added to `mcp-setup.md`,
`SKILL.md` and `film-setup.md` §Levels. `sfx-plan.md` is retained as the design
record, now marked implemented with its deviations noted.

## v0.11 (2026-07-25)

### Long-form integrity: film levels, short-render detection, a render lock, shared-file sync

Four changes, all found building two ten-minute multi-scene films (a tutorial and
a children's Bible film) end to end. The theme is that v0.10 made a single
*render* hard to get silently wrong, and these extend the same guarantee to a
whole *film*.

- **`build_film` now measures the film's audio — and can hit a target level.**
  `render` has reported the mixed level since v0.10, but the one artifact that
  actually ships did not: `assembleFilm` muxed the master timeline and returned
  without ever looking at it. It now returns
  `audio: { tracks, limiter, peakDb, meanDb, clipping, … }` whenever a master
  timeline was supplied. New **`audioTargetPeakDb`** (−60..0) measures the mix,
  applies a single offset to *every* track — so the caller's relative balance is
  preserved exactly — re-muxes once, and re-measures rather than assuming the
  shift landed. Motivating case: the same master gain that was correct for an
  en-US narration film would have put zh-TW narration at **+1.4 dBFS**, forcing
  the limiter onto every consonant. That failure is inaudible-as-broken and
  unreported — it just sounds muddy — which is precisely why it needs measuring
  rather than taste. `build_film` also now honours the output project's
  `output.audioLimiter` instead of always defaulting it on.
- **Short renders are detected instead of shipped.** Nothing verified that the
  encoded file contained the frames that were rendered, so a worker killed
  mid-encode left a valid-but-truncated video that `build_film` happily
  concatenated into a film with a scene that just stops. Both render paths now
  probe the real frame count and fail with the new **`short_render`** code
  (`detail.expected` / `detail.actual`); results carry `framesVerified`. New
  `encoder.probeFrameCount` reads the container's `nb_frames` first (muxers write
  it from frames actually written, so truncation shows up for one metadata read)
  and only falls back to a full `-count_frames` decode when that is missing.
  ffprobe is not a declared prerequisite, so an unmeasurable file reports
  `framesVerified: false` — never a failed render. This makes "output exists and
  is the right length" a trustworthy resume condition for a long batch.
- **A cross-process render lock.** Job queueing serialises renders within one
  process and said nothing about a second one; two renders on a project is silent
  corruption, not a loud failure — both write the same frames, both run FFmpeg on
  the same output, and any torn frame in between is invisible. Observed for real
  when an orphaned background render raced a foreground one through the same
  scene. `core/lock.js` adds a `.render.lock` dotfile holding the owning pid;
  **liveness, not age, decides staleness** (a render may legitimately run for
  hours), creation is an atomic `open(…,'wx')`, same-pid acquisition is
  re-entrant, and release only fires if we still own it — so an unreleased lock
  self-heals via the next acquirer. Parallel *workers* deliberately skip it
  (`lock: false` from the CLI's `--segment`): they target the same project by
  design and the parent's lock covers them. This finally *raises*
  **`render_already_in_progress`**, a code reserved but unused since v0.5 — now
  meaning a foreign process, not in-process concurrency, which still queues.
- **`sync_shared_files` — the maintenance half of the scene-as-data pattern.**
  `docs/film-setup.md` recommends every scene project ship the same
  `composition.js` and differ only in a small `scene.js`, but each project holds
  its own *copy*, so editing the original reached nothing already scaffolded —
  making a one-line art fix a sixteen-project chore on a sixteen-scene film. The
  new tool (and `ProjectStore.syncSharedFiles`) copies named files from a source
  project into many targets, with the same syntax check and determinism lint per
  target. Every source file is read before anything is written, so a bad path
  fails before it half-updates a film; the source is skipped if listed among the
  targets; `project.json` stays deny-listed. It does **not** invalidate rendered
  output — re-render the affected scenes.

Docs: `film-setup.md` gains a **Levels** section (measure, never inherit a master
gain) and a **narration-first timing** section (let TTS length set
`durationInFrames`, so picture cannot drift from voice); `architecture.md` gains
§7.1 (render lock) and §7.2 (frame-count verification). `docs/sfx-plan.md` is a
new **design/TODO document, not an implementation**, for a future
`synthesize_sfx`: both films had to hand-roll ~100 lines of DSP and a raw WAV
writer for chimes, whooshes and thuds, because `synthesize_music` is a MIDI
pipeline needing FluidSynth and a SoundFont and has no vocabulary for unpitched
noise.

## v0.10 (2026-07-25)

### Authoring-loop fixes: batch preview, render pre-flight, determinism lint, audio safety

Five changes aimed at the agent authoring loop, all found while building a
10-second 3D driving demo end to end.

- **`capture_preview_frames` — N frames, one page load.** Every
  `capture_preview_frame` call launched Chromium, loaded the page, and re-ran the
  composition's one-time setup (canvas textures, geometry merging) to produce a
  single screenshot; checking five frames paid that five times. The new tool takes
  explicit `frames` or just a `count` of evenly-spaced frames (first and last
  always included) and returns them all as images, capped at 24 per call.
  `captureSingleFrame` now delegates to the same `captureFrames` core.
- **Render pre-flight.** A composition that throws only at frame 90 used to take
  the render down after ~90 frames of work — and, in parallel mode, after spawning
  every worker. Both paths now probe evenly-spaced frames (including both
  endpoints) before committing, and fail with the real `composition_error` /
  `frame_timeout`, plus `detail.phase = "preflight"`. The serial path reuses the
  page it already opened, so it costs a handful of frame renders; the parallel path
  pays one browser launch to avoid wasting N. Skipped under 30 frames; disable with
  `render { preflight: false }` or the CLI's `--no-preflight`. No new error codes —
  the point is to surface the *existing* failure sooner.
- **Determinism lint on write.** `write_composition_file` already rejected bad
  syntax before touching disk; it now also scans JS/CSS for frame-driven contract
  violations (`Date.now`, `performance.now`, `setTimeout`/`setInterval`,
  `requestAnimationFrame`, `Math.random`, `THREE.Clock`/`getDelta`,
  `runRenderLoop`, `beginAnimation`, real-time CSS `transition`/`animation`) and
  returns them as a `warnings` array. **Advisory only — the file is still
  written**, since a loader outside the frame function may legitimately use a
  timer. Comments and string literals are blanked before scanning, without which
  the lint would fire on the scaffold's own header comment. Regex-based on purpose:
  the engine keeps its dependency list short and `vm.Script` yields no AST.
- **Audio can no longer clip silently.** `amix` runs with `normalize=0`, so track
  gains sum straight through and nothing stood between a three-track mix and
  distortion. `output.audioLimiter` (**new, defaults to `true`**) appends
  `alimiter=limit=0.891:level=0` — a brick wall at −1 dBFS, a no-op below it, with
  alimiter's auto-levelling pinned off so it never *boosts* a quiet mix. Set it
  `false` to pass the summed mix through untouched. **This changes the default
  audio path**; renders whose mix already peaked under −1 dBFS are unaffected.
- **Measured levels reported.** Renders that carry audio now decode the result and
  report `audio: { tracks, limiter, peakDb, meanDb, clipping }` in the render
  result and in `get_render_status` — the one audio failure an agent has no way to
  notice on its own. Measurement failure is never fatal.
- **Better `interpolate` errors** (Frame API v1.2). A bad range now names the
  offending pair and prints the whole array, because a descending range typically
  throws only at the one frame that first reaches the call. **Existing projects keep
  their copy of `frame-api.js`** — it is copied in at scaffold time, so only new
  projects pick this up automatically; overwrite the file to upgrade in place.

## v0.9 (2026-07-25)

### Long-form films — assemble scenes with `build_film`

**Build videos longer than a single composition** by authoring each scene as its
own project and stitching the rendered scenes together with the new `build_film`
MCP tool (`engine/src/core/film.js`, `engine/src/mcp/server.js`). This is the
answer to "can it do an hour?": not as one monolithic 108k-frame composition, but
as many short, independent, resumable scene renders concatenated losslessly.

- **Lossless assembly.** Scene outputs are concatenated with `ffmpeg -c copy`
  (no re-encode) — reusing the very `encoder.concatSegments` the parallel renderer
  already uses to merge frame-range segments, now applied across projects. Assembly
  is near-instant regardless of film length.
- **Consistency invariant.** Scenes must share resolution/fps/format/pixel-format
  (mp4/webm/prores only — gif/png-sequence can't be stream-copied). A mismatch
  fails with the new `inconsistent_scenes`; an unrendered scene with
  `scene_not_rendered` (the tool assembles, it never renders — rendering stays with
  the existing async `render` tool).
- **Audio, two ways.** With no `audio`, each scene's own audio is preserved (all
  scenes must be consistently audio or silent). Pass an `audio` master timeline
  (`{ src, startInFrames?, gainDb? }`, like `config.audio`) to lay one score +
  narration over the *whole* film via `encoder.muxAudio` — the clean path for
  long-form.
- **Quality.** The concat is lossless, so quality is set by scene render settings
  (`output.crf`/`preset`, or ProRes/PNG intermediates) and one final delivery
  encode of the master. See [film-setup.md](film-setup.md).
- New error codes: `inconsistent_scenes`, `scene_not_rendered`, `film_failed`.
  Additive only — no existing tool or workflow changes; short single-composition
  videos work exactly as before. Tool count 19 → 20.

## v0.8 (2026-07-25)

### Music generation (MIDI → FluidSynth)

**Compose a music bed from a note spec** with the new `synthesize_music` MCP
tool (`engine/src/core/music.js`, `engine/src/mcp/server.js`). The agent authors
a small JSON spec (bpm + tracks of notes); the engine renders it to a Standard
MIDI File, then to audio, and — like `synthesize_speech` — attaches it as a
normal `config.audio` track so the next render mixes it in. This closes the
last "can play but can't generate" gap: v0.6 generated *speech*, v0.8 generates
*music*, and both flow through the audio mux the engine already had.

- **Two-stage, spawn-based pipeline** mirroring the TTS design (no new npm deps,
  no synthesis in Node):
  `note spec → MotionStudioMidi.exe (DryWetMIDI) → song.mid → FluidSynth + a
  General MIDI SoundFont → WAV → config.audio track`.
  The MIDI-authoring half is a self-contained C# console exe
  (`music/MotionStudioMidi`, DryWetMIDI 7.2.0) built the same way as the TTS exe;
  FluidSynth is the provided `fluidsynth.exe`; the SoundFont is any `.sf2`/`.sf3`.
- **Spec** (all authored by the agent): `bpm`, plus `tracks`, each with a General
  MIDI `program` (0..127; 0 piano, 32 acoustic bass, 40 violin, 48 strings, 56
  trumpet, 73 flute…) or `drums:true` (routes to GM percussion, channel 10), and
  `notes` of `{ pitch 0..127 (60 = middle C), start, duration (both in beats),
  velocity? }`.
- **Windows-only, optional.** Three external pieces, each resolvable by env var
  with a git-ignored vendored default under `engine/vendor/`:
  `MOTION_STUDIO_MIDI_EXE`, `MOTION_STUDIO_FLUIDSYNTH`, `MOTION_STUDIO_SOUNDFONT`.
  Any missing piece → the new `music_unavailable` code (named in the error), and
  the rest of the engine is unaffected. New codes: `music_unavailable`,
  `music_failed`, `invalid_music_spec`. See [music-setup.md](music-setup.md).
- **Durations.** Returns `musicalDurationSeconds` (the note content) *and*
  `durationSeconds`/`durationInFrames` — the latter re-derived from the WAV
  header (via `tts.js`'s `wavDurationSeconds`), which is longer because FluidSynth
  adds a reverb/release tail; the WAV is what FFmpeg actually muxes. Use
  `durationInFrames` to size the video, and `startInFrames`/`gainDb` to place and
  balance the bed under narration (e.g. `gainDb: -8`).
- `mode:"attach"` (default) writes `assets/music-<n>.wav` and appends the track;
  `mode:"asset-only"` writes + reports only. Tool count 18 → 19.

## v0.7 (2026-07-25)

### Optional 3D libraries (Three.js / Babylon.js)

**Attach a 3D rendering library to a project** with the new `add_library` MCP
tool (`store.addLibrary`, `engine/src/core/libraries.js`). It copies a pinned
library build **locally** into the project — never a CDN at render time, so
renders stay hermetic and reproducible — and scaffolds a frame-driven starter
composition (`engine/templates/lib-three`, `engine/templates/lib-babylon`).

- `library: "three"` — Three.js (~600 KB, lightweight) or `"babylon"` —
  Babylon.js (~8 MB, built-in glow/bloom/postprocessing). `scaffold` (default
  true) swaps in the starter; the attached library is recorded in the new
  optional `config.libraries` array.
- The big builds are **git-ignored** under `engine/vendor/libs/` and fetched with
  `node scripts/fetch-libs.mjs` (URLs live in the registry). A missing build
  returns the new `library_unavailable` error code; `MOTION_STUDIO_LIBS_DIR`
  overrides the vendor location (used by tests).
- **Determinism contract** (returned to the agent as `notes`, and baked into the
  starters): drive all animation from the injected `frame` — no
  `requestAnimationFrame`, no `THREE.Clock` / Babylon `runRenderLoop` / particle
  systems (all wall-clock based); starters set `preserveDrawingBuffer` and call a
  GL `finish()` each frame so the headless screenshot captures it. Confirmed
  WebGL renders in the headless path (SwiftShader/GPU); both starters render end
  to end through Chromium + FFmpeg.
- Neither library is in the base scaffold — 2D projects carry nothing extra.
- **glTF/GLB models**: the babylon `loaders` addon (`add_library { library:
  "babylon", addons: ["loaders"] }`) vendors `babylonjs.loaders.min.js` and
  injects it, for `SceneLoader.ImportMeshAsync`. Loading a model over `file://`
  needs the opt-in **`MOTION_STUDIO_ALLOW_LOCAL_FETCH`** env (adds Chromium
  `--allow-file-access-from-files`; off by default — `fetch`/XHR to `file://` is
  otherwise CORS-blocked). Verified end to end on a 13.5 MB model. See
  [3d-libraries.md](3d-libraries.md).
- **Shader warm-up in the starters**: Babylon/Three compile materials lazily and
  skip not-ready meshes on the *first* render, so a single-frame capture
  (render_still / capture_preview_frame / frame 0) came back blank. The starters
  now compile up front (`material.forceCompilationAsync` / `renderer.compile`)
  before registering the composition.

## v0.6 (2026-07-24)

### Text-to-speech narration

**Generate a voiceover from text** via two new MCP tools, `synthesize_speech`
and `list_voices` (`engine/src/core/tts.js`, `engine/src/mcp/server.js`).
Narration is synthesized by an external, self-contained Windows console
executable that the engine spawns the same way it spawns FFmpeg; its path is
supplied through the new `MOTION_STUDIO_TTS_EXE` environment variable. See
[tts-setup.md](tts-setup.md) for the CLI contract and build steps.

*Rationale / scope.* Motion Studio already muxed pre-supplied audio tracks
(`config.audio`, `core/encoder.js`); the only missing piece was *generating*
speech. The renderer and the audio mux are untouched — `synthesize_speech`
writes a WAV into `assets/` and, in the default `attach` mode, appends a normal
`{ src, startInFrames?, gainDb? }` track, so a synthesized voiceover flows
through the exact path a hand-supplied one already did. The tool also returns
the clip length as `durationInFrames`, letting an agent size a `Sequence()` to
the narration; `mode: "asset-only"` synthesizes and reports the duration
without modifying `config.audio`.

- Duration is derived authoritatively from the WAV RIFF header on the Node side
  (exactly what FFmpeg later muxes), not from the exe's self-report.
- New stable error codes (`core/errors.js`): `tts_unavailable` (engine not
  configured — the feature is Windows-only and optional), `unsupported_voice`,
  and `tts_failed`. The TTS tools do **not** gate on the render prerequisites,
  so a machine with no speech engine still renders everything else normally.
- The reference exe (`tts/MotionStudioTts/`) ships two backends: **WinRT**
  (`Windows.Media.SpeechSynthesis`, default — the OneCore "mobile" voices,
  more voices including male) with automatic fallback to **SAPI5** COM
  automation (`--engine sapi`). Either way it emits the same CLI-contract WAV +
  JSON that `list_voices`/`synthesize_speech` consume.
- This deliberately reintroduces an optional, Windows-only native dependency —
  narrowly, only for speech synthesis — without disturbing the cross-platform
  engine established in v0.5.

## v0.5 (2026-07-08)

v0.5 evolves the v0.2 implementation into a commercial-ready, cross-platform
product. The upload accompanying this release contained the complete v0.2
implementation as the reference spec (there was no separate v0.5 spec
document), with license to change anything for a better solution. Every
deliberate departure from v0.2 is recorded here with its rationale.

### Headline changes

**1. The Windows-only C# WinForms app is replaced by a cross-platform Studio
web UI** (`engine/src/studio/`, `npm run studio`).

*Rationale.* The engine has always been Node.js; the WinForms shell restricted
the human path to Windows, required a second toolchain (.NET 8 + WebView2),
and could not be built or tested on the Linux/macOS machines most motion work
happens on. The Studio server is a zero-dependency `node:http` process bound
to `127.0.0.1` that serves a vanilla-JS single-page UI. Nothing was lost in
the translation that mattered:

- Preview fidelity is *better*: the preview iframe loads the project's actual
  entry HTML from `/preview/:id/` and is driven through the identical
  `window.setFrame(n)` contract the headless renderer uses. WebView2 preview
  approximated the render; this *is* the render path minus Chromium headless.
- Scrubbing, play/pause at project fps, hot reload (SSE + `fs.watch`),
  render orchestration with progress/ETA/cancel, logs, and output download
  all carry over.
- The Job-Object process-tree-kill duty the WinForms orchestrator performed
  is owned by the engine's `JobManager` (which the Studio server, the MCP
  server, and the CLI all share), so cancellation still leaves no orphaned
  Chromium or FFmpeg on any OS.
- The JSON-line stdout protocol the WinForms app consumed is unchanged, so
  any external orchestrator that spoke it still works.

**2. Output formats** (`core/formats.js`): `mp4` (H.264, default), `webm`
(VP9), `gif` (two-pass palette), `prores` (.mov, 422 HQ / 4444), and
`png-sequence` (a folder of frames, no encode). `output.format` in
`project.json`; the output filename's extension is kept in lockstep with the
format automatically.

**3. Alpha-channel renders**: `output.transparent: true` captures with
Chromium's `omitBackground` and encodes alpha-capable formats (`webm` →
yuva420p with alt-ref disabled, `prores` → 4444, `png-sequence` → RGBA).
Validation rejects `transparent` on formats that cannot carry alpha.

**4. Parallel merge strategy is now format-aware.** mp4/webm/prores opaque
segments are copy-concatenated exactly as in v0.2 (fast path, no re-encode).
GIF — whose per-segment palettes cannot be concatenated — and *any*
transparent render go through a lossless FFV1/RGBA intermediate per worker,
one copy-concat, and a single final encode pass, so the parallel result is
bit-equivalent to the serial one.

**5. Render queue replaces fail-fast concurrency** (`core/jobs.js`).
Submitting a render while one is running used to fail with
`render_already_in_progress`, forcing agents into poll-then-submit races.
Jobs now queue FIFO (`queued → running → done|error|cancelled`, still one
render at a time by default). The queue is bounded (10) so an unattended
agent loop cannot fan out unbounded work — a full queue fails with the new
`queue_full` code. Cancelling a queued job dequeues it without starting.

**6. Progress now carries `etaMs`** (null until at least 3 frames of signal),
in the stdout protocol, job status, the Studio UI, and MCP polling.

**7. Still export**: `renderStill()` in the core, `render_still` MCP tool,
`--capture-frame` CLI flag (unchanged), and a "still ⤓" button in the Studio.

**8. Binary asset ingestion**: `write_asset_file` MCP tool accepts base64
content, confined to the project's `assets/` folder, with an extension
allowlist (images/audio/fonts/json/txt) and a 25 MB decoded-size cap
(`asset_too_large`). This closes the v0.2 gap where agents could author
compositions but not supply a logo or a music bed.

**9. Project removal**: `remove_project` MCP tool / `DELETE /api/projects/:id`.
Unregisters; deletes files only when explicitly requested *and* the folder
lives under the managed projects root — projects registered at user-chosen
paths are never deleted from disk.

**10. Frame API v1.1** (`src/runtime/frame-api.js`), all pure functions of
frame and therefore safe under parallel/out-of-order rendering:
- `spring(frame, {fps, stiffness, damping, mass})` — closed-form damped
  spring from 0→1 (no simulation state).
- `interpolateColors(frame, inputRange, colors)` — piecewise color
  interpolation over hex/rgb()/rgba() stops, returns an `rgba()` string.
- `Loop(durationInFrames, fn)` — repeats a sub-animation with
  `(localFrame, cycleIndex)`.

**11. Config schema v2.** `output.format` + `output.transparent` added.
v1 configs are migrated on read, non-destructively; `crf` range widened to
0–63 (VP9). Even-dimension enforcement now applies only to formats whose
pixel formats require it (gif and png-sequence accept odd sizes).

**12. New error codes** (additive): `unsupported_format`, `asset_too_large`,
`queue_full`. All v0.2 codes are unchanged; `render_already_in_progress` is
retired from the render path (superseded by queueing) but the code remains
reserved.

**13. CLI**: `--intermediate` (internal, used by parallel workers for the
FFV1 path) and `--doctor` (prints the prerequisite check as JSON, exit 0/3).

### Testing

- 102 automated tests across 8 suites (v0.2 shipped 62): core, pipeline,
  CLI, MCP (real SDK client over stdio), frame-api (vm-hosted runtime),
  v0.5 features, Studio HTTP server, and a gated real-Chromium suite.
- All FFmpeg encodes in tests are real and probe-verified (codec, pixel
  format, frame counts), including transparent WebM alpha and the parallel
  GIF/png-sequence merge paths across true process boundaries.
- The real-Chromium suite (capture determinism, serial mp4, genuine alpha in
  `omitBackground` captures) runs wherever a browser is resolvable and skips
  honestly elsewhere.
- The shipped example outputs (`examples/*/out/`) were rendered with real
  headless Chromium + FFmpeg through the parallel path, including the
  transparent `lower-third.webm` (probe: `alpha_mode=1`; decoded frame 60:
  85% fully-transparent pixels with partial-alpha shadow edges).

### Compatibility

- v0.2 `project.json` files load unchanged (schema migration on read).
- The CLI flags, JSON-line progress protocol, error-code set, and all twelve
  v0.2 MCP tools are preserved; v0.5 adds three tools and queue semantics.
- `render` responses now include `state` (`running` | `queued`) and, when
  queued, `queuePosition` — additive fields.

## v0.2

Initial reference implementation: deterministic frame-driven render pipeline
(Puppeteer capture → FFmpeg stdin pipe), project system with path sandbox,
JSON-line progress protocol, parallel rendering with copy-concat, audio
mixing, MCP server with twelve tools, C# WinForms desktop app (Windows), and
a 62-test suite. See `docs/spec-changes.md` for the v0.2-era decision log.
