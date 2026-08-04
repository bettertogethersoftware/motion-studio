# Motion Studio — Changelog

## Unreleased

### Deployment restructure: generated entry files, MACHINE.md, and the generative boundary (v0.26)

Deploying Motion Studio onto a new machine (a customer install, a new dev box)
used to mean hand-copying a 900-line agent guide from
`SETUPME codex name this AGENTS claude name this CLAUDE put it above this dir.md`
to the tools root, renaming it per agent brand, and editing machine-specific
paths into it. On the reference machine that process had already produced all
three of its failure modes: an empty `CLAUDE.md`, a deployed guide that gained
a section never backported to the template, and a search/replace accident that
pointed eight helper examples at the wrong script. The monolith is gone,
replaced by layers picked by *what changes them*
(architecture.md §16):

- **`deploy/ENTRY.md`** — the generic agent guide. `deploy/provision.mjs`
  emits it to the tools root as **both** `AGENTS.md` and `CLAUDE.md` (no
  rename step to forget) and always overwrites them, so deployed guides can
  no longer drift from the repo. The guide contains zero machine-specific
  paths; it teaches agents to *discover* helper tools (does the directory
  exist? read its `README.md`) instead of enumerating them, so a customer
  machine with a different tool set runs the identical guide.
- **`MACHINE.md`** (from `deploy/MACHINE-template.md`) — the machine-owned
  manifest: hardware/GPU sizing, exact binary paths, Python/ComfyUI installs,
  model inventory, paid-service status (configured/not — never values), and
  the installed-helper table. Created once by `provision.mjs`, never
  overwritten by it.
- **`deploy/PROVISION.md`** — the agent-driven provisioning playbook
  (profiles `minimal`/`standard`/`gpu`): the human clones the repo and says
  "provision this machine"; the agent installs, runs every tool's own check
  command, emits the entry files, fills `MACHINE.md` with measured facts, and
  verifies with an end-to-end render.
- **[docs/production-lessons.md](production-lessons.md)** — the cross-machine
  production lessons that lived only in the deployed guide (the music-video
  order of operations, the measured traps, the track-layering rules, the
  MCP-restart-after-engine-edit rule) now live in the repo, so a lesson
  learned at one deployment reaches every other via `git pull`. Per-tool
  content moved to the tool READMEs it belongs to.
- **The generative boundary is now stated policy** (architecture.md §9.5, and
  in the entry guide): the engine owns deterministic, timing-coupled
  synthesis and measurement (`synthesize_speech`/`_music`/`_sfx`,
  `transcribe_asset`, `probe_asset`); generative models (ComfyUI image,
  music, video) stay agent-side tools whose outputs enter films as measured
  assets — they will not be added as engine vendors or MCP tools. The same
  rule triages customer-supplied APIs at install time (PROVISION.md):
  speech APIs become engine TTS vendors (keeping frame-accurate `timings`);
  music/image/video generation APIs become agent-side helpers.
- **PROVISION.md covers three deployment variations**: no-shell (Env A)
  customers — `minimal` profile without the agent-side shell tools,
  `SKILL.md` as the production agent's entire contract; remote-GPU
  deployments — ComfyUI served over HTTP from a separate GPU box, recorded
  in `MACHINE.md`; and the capability triage above. It also states Linux
  status honestly (not yet playbook-grade) and points at
  [docs/plans/linux-ready-plan.md](plans/linux-ready-plan.md), the
  staged plan (CI truth → engine parity → helpers → provisioning → one real
  end-to-end install) for making Linux a supported deployment.

No engine code changed; `deploy/provision.mjs` is new, standalone, and
side-effect-free beyond writing the three files (`--dry-run` to preview).

### The core-only install is a tested reality (v0.26)

The vendor-boundary plan's acceptance test 1 exists and passes: the engine
source is mirrored to a temp tree WITHOUT src/vendors/ (node_modules
junctioned in, templates/ carried — app data, not vendor code) and the
mirrored MCP server is spawned over real stdio. It initializes, answers
get_capabilities (with the tiers block reporting the vendor package's
absence), creates films and scenes, and refuses every audio tool with the
structured `*_unavailable` error. The test caught a real bug on its first
run: the MCP server still static-imported `tiers.js` from the vendors tree,
which killed a core-only server before initialize ever ran — tiers now
loads with the same dynamic, failure-tolerant pattern as the registry.

### The vendor boundary is physical: providers and catalogs live in vendors/default (v0.26)

Slice A Phase 2's file moves, done: eleven modules left core/ —
`tts.js`→`vendors/default/speech/system.js` (with its per-platform
backends), the five cloud/local speech providers, both music engines
(`music.js`→`music/fluidsynth.js`, `music-node.js`→`music/node.js`),
`transcribe-whisper.js`→`transcription/whisper-cpp.js`, and `tiers.js`
(inherently about the default vendors; both its consumers are entrypoints).
The three capability catalogs moved beside their providers
(`vendors/default/*/catalog.js`); the core dispatchers keep only generic
dispatch plus genuinely generic utilities (filterVoices, GM_PROGRAMS,
demoSpec, conformWavLevel — whose dB one-liners moved to `core/audio.js`
where they always belonged). The import-graph test now polices a real
boundary: core/ contains no vendor code and cannot import any. Tests bind
dispatches over the default catalogs exactly as the registry does.
Suite: 877 tests, 0 fail.

### Both entrypoints build their vendor runtime from the registry (v0.26)

Slice A-5/A-6: `engine/src/vendors/default/registry.js` is the composition
point — all three capability dispatches over their default catalogs, with
per-capability overrides (the §10.6 seam, tested by injecting a fake vendor
through the real dispatch). The MCP server and the Studio both construct
that runtime at startup, **dynamically and failure-tolerantly** (Phase 4's
hard rule): a core-only install with no vendors/default tree still
initializes MCP, renders video, serves every non-audio page and tool — the
audio surfaces return structured `*_unavailable` errors naming the cause
instead of the process dying with ERR_MODULE_NOT_FOUND. Both entrypoints
consume the SAME runtime shape so they cannot drift; the dispatch functions
keep their historical local names, so every tool handler and route is
unchanged. Vendor id lists import from settings.js; the Studio's display
constants (env hooks, format enums, GM programs) import from the provider
modules where they live until Phase 2 moves them. The real core-only
integration test lands with Phase 2's packaging split, where a genuine
core-only artifact exists to test.

### All three vendor dispatchers are catalog-driven (v0.26)

Slice A-4 complete: music (`createMusicDispatch`) and transcription
(`createTranscriptionDispatch`) received the same transform as speech —
every vendor-specific fact is a catalog entry, every dispatch function is
generic over the injected catalog, and the module-level exports are bound
to the default catalogs so no caller changed. A second transcription
vendor (the parked faster-whisper candidate, for instance) is now a
catalog entry rather than a code branch. Each rewrite landed
behavior-identical on the first suite run: 875 tests, 0 fail, three times
over. Next: the default registry (`vendors/default/registry.js`) and the
§10.6 constructor threading through the entrypoints.

### The speech dispatcher is catalog-driven (v0.26)

Slice A-4b: `tts-vendors.js` is now `createSpeechDispatch(catalog)` plus a
`defaultSpeechCatalog()`. Every vendor-specific fact — the info card, the
probe, the one-sentence fix, the synthesis call, and which requested
options the vendor cannot honour — is one catalog entry; the dispatch
functions (resolve/check/report/list-voices/synthesize/unavailable) are
generic over the catalog, and the option-warning policy is data (the
"deterministic is only supported by piper and elevenlabs" sentence is now
generated from the catalog rather than hardcoded). The module-level exports
are the same functions bound to the default catalog, so no caller changed;
Phase 4 constructs dispatches from the injected registry instead, and
Phase 2 moves the catalog to vendors/default/. Behavior-identical by test:
875 tests, 0 fail, first run.

### Settings validation stops importing vendors (v0.26)

Slice A-4a: `core/settings.js` no longer imports `tts-azure.js` /
`tts-elevenlabs.js` for their format enums. Vendor default values are
literals (drift-guarded by a test that tethers them to the vendor
constants), and `outputFormat` is validated structurally only — the vendor
refuses an unusable format at use time with a precise structured error,
which was already true, and a format written by a NEWER build now survives
an older build's `validateSettings` instead of being destroyed (the
forward-compatibility rule the vendor-boundary plan calls out). Two tests
that pinned the old settings-time enum refusal were updated to pin the new
contract instead.

### The vendor boundary is now enforced, not aspired to (v0.26)

`test/import-graph.test.js` (Phase 6's static check, stood up before the
migration it guards): nothing under `core/` may import from `vendors/` —
static, dynamic, or require — and the future `vendors/` tree may only be
imported from entrypoints. Both assertions pass trivially today; their job
is to make the Phase 2 file moves unable to regress the dependency
direction silently.

### Slice A begins: core/audio.js (v0.26)

The vendor-boundary plan's Phase 1 opener: the generic PCM WAV and
audio-measurement utilities — RIFF parsing, duration, frame conversion,
sentence splitting, concatenation with placed-segment timings, PCM→WAV
wrapping, level and envelope measurement — moved out of `core/tts.js` into
**`core/audio.js`**, exactly the §5 target layout. They were never
speech-specific: the renderer, SFX, music, transcription, and every speech
vendor consume them. All ten in-tree importers (both entrypoints, five cloud
vendors, renderer, transcribe, music-vendors) now import from `audio.js`
directly; `tts.js` keeps compatibility re-exports so external/test importers
are untouched, and shrinks from 450 lines to ~210 — what remains is actually
the `system` speech vendor. Error codes deliberately unchanged
(`TTS_FAILED` stays; renaming codes is not this extraction's job). Suite
green at both steps: after the split, and after the repointing.

### The last §10 decisions, whisper turns optional, and the Studio can bind beyond loopback (v0.26)

- **Vendor-boundary §10.2/6/7 decided** (recorded in the plan with
  rationale): the desktop shell is a **ComfyUI-style viewer host** — an
  Electron shell managing a local instance and displaying the Studio UI,
  which amends the earlier "no Studio in the desktop product" stance because
  the production loop makes the Studio page the human's advice surface;
  runtime injection is a **constructor parameter with a lazy
  failure-tolerant default registry** (option B — matches the browserFactory
  idiom and the construct-with-fakes test style); distribution is
  **npm-first via GitHub URL install** — tied to repository access, matching
  the install-on-customer-infrastructure model, with the engine-in-subfolder
  packaging wrinkle noted for Slice B.
- **Transcription is now saveable as "not on this machine".** The Studio's
  vendor page refused to save with nothing ticked — and with exactly one
  transcription vendor that made whisper effectively mandatory. Unticking
  now saves `vendors: null` (scalar stays `whisper-cpp` for old readers);
  the engine keeps reporting `transcription_unavailable` with the fix and
  picks whisper up the moment the paths point at it. Verified live against
  a running Studio: untick→save ✓, settings show `vendors: null`,
  re-tick→save restores exactly.
- **`MOTION_STUDIO_STUDIO_HOST`** (default `127.0.0.1`): opt-in network bind
  for the server-hosted deployment where the human views the Studio from
  another machine. The Studio has no authentication — the comment and
  PROVISION.md both say trusted network or authenticating reverse proxy
  only.
- **Product framing recorded** (PROVISION.md): the no-shell tier is for
  demos/first impressions; production audio/visuals come from agent-side
  tools; and using Motion Studio purely as a Remotion-like programmatic
  renderer (zero vendors) is a supported shape — goal 6 and the `tiers`
  block already carry it.

### Doctor and get_capabilities report capability tiers (v0.26)

Phase 0.5's goal 10, implemented as `core/tiers.js`: every capability
reports its tier — **core** (render, sfx), **free-local** (system speech,
node music), **pack** (whisper transcription), **byok** (cloud vendors) —
with `ready` computed from existence-level checks only (no process spawned;
the deep probes stay behind `list_vendors`) and, when not ready, the exact
per-OS fix command: `npm run fetch-soundfont` for a missing SoundFont, the
whisper.cpp build-or-download recipe per platform, the browser install
hint. `npm run doctor` and `get_capabilities` both carry the block; cloud
keys are reported as presence booleans only, with a test pinning that a key
*value* can never appear in the report.

### The `system` speech vendor works on every OS, at zero bytes (v0.26)

The decided §10 design, implemented: the vendor id stays `system` and the
"exe" it spawns is now chosen per platform — the bundled
`MotionStudioTts.exe` keeps priority on Windows when present (existing
installs keep their exact voices), otherwise a small Node backend drives the
OS's own synthesis through the **same CLI contract**: System.Speech via
PowerShell (values crossing via environment variables, never string
interpolation), `say` on macOS (written to Apple's documented flags, not yet
run on a real Mac — the file says so), `espeak-ng` on Linux. Nothing
downloads, every existing `settings.json` stays valid, and everything
downstream of the contract — timings, level measurement, the Studio's
audition button — is untouched because the backends are just more "exes" to
the resolver (`resolveTtsExeInfo` now reports source `os` for them).
Verified live: Windows System.Speech spoke 3.4 s through the backend
(9 voices listed), and Linux `synthesizeSpeech` with zero configuration
produced a 3.95 s WAV through espeak-ng. Quality is scratch-narration by
design; piper and the cloud vendors remain the documented upgrades
(tts-setup.md). Amusing test finding: "the foreign platform's tool is
reliably absent" is false — this dev machine has eSpeak NG *for Windows*
installed, so the contract tests skip-not-fail when a foreign tool turns out
to exist.

### `npm run fetch-soundfont` — the pack mechanism's pilot (v0.26)

The decided fetch-on-command policy, implemented: one command downloads the
MIT-licensed `MuseScore_General.sf3` (pinned URL + pinned SHA-256, verified
from two independent copies) into the engine's vendor dir — streamed to a
`.part` file, hash-verified **before** the destination name ever exists,
atomic rename, idempotent re-runs, structured offline failure naming the
manual fallback. `synthesize_music`'s `music_unavailable` hint now leads
with the command. `fetchVerified()` is deliberately the reusable shape the
vendor-boundary plan's Phase 3 pack mechanism needs — future packs consume
it rather than reinventing it. Five network-free tests pin the contract
(reuse-without-network, atomic install, mismatch-never-installs,
offline-is-structured, HTTP-error retry); verified live on Windows
(reuse path) and a clean Linux install (real 40 MB download, plus the
override note when `MOTION_STUDIO_SOUNDFONT` points elsewhere).

### Slice 0 begins: the vanilla install loses 420 MB of browser (v0.26)

- **Only `chrome-headless-shell` is downloaded** (`engine/.puppeteerrc.cjs`):
  `core/browser.js` only ever runs headless, so full Chrome was ~420 MB of
  dead weight per install — the vanilla footprint issue reproduced on every
  clean machine this week. The launch default is now the shell binary;
  `MOTION_STUDIO_CHROME` points at an installed Chrome/Edge instead (custom
  binaries run in the new headless mode, since current full builds no longer
  ship the old one). Verified: full suite + real-Chromium (3/3, zero skips)
  on Windows, real-Chromium + the whole render-format matrix on Linux — the
  determinism and alpha tests pass identically under the shell binary.
- **The render sidecar records the browser** (architecture §7.3): an
  `environment` block with resolution source, headless mode, and build
  string (e.g. `HeadlessChrome/131.0.6778.204`) — the font/browser
  provenance decision's first half, deliberately outside the staleness
  allowlist.
- **Found while validating on the engine's Node floor:** the test suite
  cannot run on Node 18 at all — `node --test` there rejects the glob and,
  given explicit file lists, spawns all 41 test files as concurrent
  children (no concurrency cap before Node 21) and dies. Policy recorded:
  **runtime floor stays Node ≥18** (the L4 install proved it end to end);
  **developing/testing needs Node ≥21**. CI runs 22.

### Three Slice-0 design decisions taken (v0.26)

Recorded in the vendor-boundary plan §10 with rationale, so they are not
re-litigated: the cross-platform default speech vendor is the **zero-byte
per-platform `system` backend** (espeak-ng on Linux; Piper stays the
documented one-command quality upgrade); the clean-clone SoundFont gap is
closed by **fetch-on-command with SHA-256** (MuseScore_General.sf3, MIT) as
the deliberate pilot of the pack-bootstrap mechanism — never committed to
git, never fetched silently at synthesis time; and font determinism is
handled by **recording the font environment in the render sidecar** plus
the policy that cross-machine visual consistency comes from
`@font-face` composition assets, with an optional font pack later. These
unblock Slice 0; the injection-seam and distribution-shape decisions
(§10.6–7) still gate Slice A.

### The render-format matrix runs in CI (v0.26)

`engine/test/smoke-render-formats.mjs` (new, outside `npm test` like the
other real-vendor smokes) renders one tiny scene through **every deliverable
format** with a real browser and real FFmpeg — mp4/H.264, webm with genuine
VP9 alpha, gif, ProRes 4444, png-sequence — plus a 2-worker parallel render
and a cancellation that ends in state `cancelled`, each output
ffprobe-verified. CI's `linux-render` job runs it after the gated Chromium
suite. Verified first on the L4 Linux install; three probe subtleties are
recorded in the script: ffprobe's native VP9 decoder hides the alpha plane
(`alpha_mode=1` container tag is the marker), ProRes 4444 decodes as
12-bit alpha (`yuva444p12le`) regardless of 10-bit encode input, and the
opaque scaffold composition legitimately yields `rgb24` PNG frames.

### Linux is supported: the L4 acceptance passed (v0.26)

On 2026-08-04 a **fresh Ubuntu 24.04.4 LTS install** (new WSL2 distro,
customer-like `motion` user with sudo — none of the earlier experiments'
environment reused) was provisioned agent-driven from
[deploy/PROVISION.md](../deploy/PROVISION.md) and passed the
[linux-ready plan](plans/linux-ready-plan.md)'s full §L4 acceptance: MCP
over stdio built a complete film — piper narration with sentence timings,
`node`-vendor SoundFont music, SFX, two Chromium renders, a promoted
H.264+AAC build (ffprobe-verified at exactly 30/1 fps) — and whisper.cpp
transcribed the *delivered MP4* back with every expected word intact. The
`standard`-profile smokes ran too: `shotfinder` scanned the built film and
`musicforge` rendered through **distro FluidSynth via its new PATH
fallback**. PROVISION.md's Linux status is now **supported** (bare-metal
confirmation beyond WSL2 optional; macOS untested). Provisioning findings
folded into the playbook: Ubuntu 24.04 packages ImageMagick 6
(`convert`/`identify`, no `magick`), the SoundFont must be fetched and
exported (`MOTION_STUDIO_SOUNDFONT`), and Puppeteer's ~700 MB double
browser download reproduces on every clean install (the vendor-boundary
plan's Phase 0.5 target). The acceptance script is kept as
`engine/test/smoke-mcp-film.mjs` — a rerunnable real-vendor smoke for any
machine with the `MOTION_STUDIO_*` hooks set. Node 18.19.1 — exactly the
engine's floor — ran everything, so the floor is real, not aspirational.

### Linux L0: CI on two platforms, and the first Linux bug (v0.26)

The linux-ready plan's L0 phase ran: the full suite executed on real Linux
for the first time (Ubuntu 26.04, Node 22, FFmpeg 7.0.2) and scored 852/858
with **two failures that were one real bug**:

- **`transcodeIdentity` no longer lowercases paths on POSIX**
  (`core/transcode.js`). The recorded absolute source path was lowercased for
  identity stability — correct on case-insensitive Windows, but on
  case-sensitive filesystems it turns any mixed-case source path into ENOENT
  at plan time, so every prepared-footage film failed `planFilm` with
  `footage_source_changed`/`source_missing`. Case normalization is now
  win32-only; sidecars written on Windows before the fix still match their
  recomputed identity, and the source==dest overwrite guard got the same
  treatment. After the fix both platforms are clean: Windows 855/858 pass
  (3 platform skips), Linux 854/858 (4 platform skips), zero failures.
- **`.github/workflows/ci.yml`** (new): `ubuntu-latest` and `windows-latest`
  jobs — Node 22, static/choco FFmpeg, `npm ci`, `npm run doctor`,
  `npm test` — with `PUPPETEER_SKIP_DOWNLOAD` set, since the suite fakes the
  browser and the gated real-Chromium file skips honestly. A third
  `linux-render` job downloads the pinned browser (cached) and runs
  `real-chromium.test.js` for real — the launch/screenshot/alpha seam fakes
  cannot cover. The cross-platform claim is now tested on every push instead
  of asserted. (Run #1's lesson is in the workflow comments: `apt-get` hung
  28+ minutes on the runner's apt lock; FFmpeg comes from a static build.)
- **Plan papers consolidated into `docs/plans/`.** The parallel
  `docs/todo_task/` and `docs/task_completed/` trees (21 files, ~6,200
  lines) collapsed into one folder: [TODO.md](plans/TODO.md) — the single
  live index; [completed.md](plans/completed.md) — a ledger summarizing
  every shipped plan (full design records remain in git history at
  `1f3f9fe`); [retired.md](plans/retired.md) — dropped plans, each with the
  reason so they are not re-proposed; plus the six still-active plan
  documents kept whole (linux-ready, vendor-boundary, the
  production-workflow backlog — renamed from its source-of-truth filename —
  and the three queued capability plans). Cross-references repo-wide were
  repointed.
- **Per-OS entry files (Linux L3).** `deploy/ENTRY.md` is now a single
  source with `<!-- os:windows -->` / `<!-- os:posix -->` blocks;
  `provision.mjs` filters them at emit time (auto-detected platform, `--os`
  to override) and stamps the header with the target OS, so a Windows
  machine gets PowerShell examples and a Linux machine gets bash — one
  template, no drift. PROVISION.md gained a **"Provisioning on Linux"**
  section with the verified per-step deltas (userspace fallbacks for no-sudo
  machines, the static-FFmpeg and whisper.cpp build recipes, pip-only Piper
  with the `PIPX_BIN_DIR` and pre-2024-binary traps, no ImageMagick wrapper
  on Linux), and MACHINE-template's rows are OS-neutral.
- **Linux L1 vendor verifications** (2026-08-04, real Linux): the `node`
  music vendor synthesized correctly against the production SoundFont, and
  `piper` speech ran end to end via pip `piper-tts` — with a trap now
  recorded in [tts-setup.md](tts-setup.md): the archived pre-2024 C++ piper
  release binaries ignore this engine's flags and exit 0 having written no
  audio; Linux installs must use pip (piper1-gpl). The FFmpeg resolution
  chain and a clean win32-assumption sweep were audited in the same pass;
  whisper and real-Chromium rendering verification move to CI
  (see [linux-ready-plan.md](plans/linux-ready-plan.md)).

### The vendor dir is configurable, and the settings page grew up (v0.25)

**Configurable vendor dir.** The root the engine resolves bundled runtime
assets from — the TTS/MIDI exes, FluidSynth, SoundFonts, Piper voices, Whisper
models and the committed 3D libs — is now a fourth configurable location in
`core/paths.js`, beside the v0.22 storage trio: `vendorDir` in `paths.json`,
`MOTION_STUDIO_VENDOR_DIR` in the environment, and a **vendor dir** field in
the Studio's ⚙ storage settings. Default: the `vendor` folder beside the app
(unchanged behavior). Precedence is the same as every other location — env →
`paths.json` → default — and every per-item hook (`MOTION_STUDIO_TTS_EXE`,
`_SOUNDFONT`, `_WHISPER_MODELS`, `_LIBS_DIR`, per-vendor paths in
`settings.json`) still wins over it: the vendor dir only moves the *default
root* those fall back to. The resolvers in `core/tts.js`, `core/tts-piper.js`,
`core/transcribe-whisper.js`, `core/music.js` and `core/libraries.js` now ask
`vendorDir()` instead of hardcoding a path relative to their own source file.
Changing it needs no reload and no relocation machinery — the next probe or
synthesis resolves against the new root (a connected MCP server picks up the
saved value too, since it reads the same `paths.json`; only the env var is
per-process).

**Settings page layout** (all Studio-only):

- **Save moved to the page header**, matching the tts/music/transcription
  vendor pages — it was at the bottom of a long form, below the fold.
- **Every section is a card** — bordered, amber accent bar on the left, wide
  variants for the path-heavy storage and environment blocks — so the page
  scans as blocks instead of one undifferentiated column.
- **The engine status strip moved into the settings page header** (version ·
  engine ready/missing · ffmpeg version). It cost permanent sidebar height and
  was only read when something was wrong; the red prereq banner still appears
  globally on failures.
- **The sidebar footer buttons fit the rail now** (`tts · music · trans · ⚙`):
  words abbreviated, and since icon+word together still overpainted the
  neighbouring button at 264px, the expanded rail shows the word alone and the
  collapsed rail the icon alone — settings is the gear in both. Full names
  remain in the tooltips.
- **The per-vendor facts and environment boxes span their card** on the tts,
  music and transcription pages (previously capped at 620px). Those rows are
  mostly absolute Windows paths, and the cap wrapped exactly the interesting
  tail on every one of them.

### `engine/vendor` moved to the repo root (v0.25)

The vendor tree (committed 3D libs plus the git-ignored exes, FluidSynth,
SoundFonts, Piper voices, Whisper models and the download cache) now lives at
`/vendor`, beside `engine/`, and `engine/vendor.lock.json` moved with it to
`/vendor.lock.json`. Rationale: the tree is runtime *assets*, not engine code,
and at ~2.5 GB it dominated `engine/` — the root is where the other local
toolchains (FFmpeg, ImageMagick) already sit.

Nothing observable changes for a fresh clone: `vendor/libs` is still committed
(git recorded the move as renames), every default path is resolved relative to
the engine's own source location (`core/*.js` now reach `../../../vendor`
instead of `../../vendor`), and all `MOTION_STUDIO_*` overrides
(`…_TTS_EXE`, `…_SOUNDFONT`, `…_PIPER_VOICES`, `…_WHISPER_MODELS`,
`…_LIBS_DIR`, `…_VENDOR_LOCK`, …) are untouched. Existing local checkouts move
their ignored binaries once (or re-follow docs/tts-setup.md and
docs/music-setup.md); the `.gitignore` contents-not-directory pattern
(`/vendor/*` + `!/vendor/libs/`) and the `-text` attribute on `vendor/libs/**`
moved with it. Setup docs, the Studio placeholder text, and the publish paths
in the exe READMEs were updated in the same pass.

### Audio mastering and delivery fixes (v0.24)

Five changes, each from a defect measured while producing a three-minute music
video end to end. Nothing here is speculative: every number below was observed.

- **The limiter now leaves codec headroom.** `alimiter`'s ceiling moves from
  −1 dBFS to **−1.5 dBFS** (`limit=0.891` → `0.841`). The limiter bounds *sample*
  peaks while the deliverable is AAC, and a lossy encoder reconstructs
  intersample peaks above the samples it was given — so a 21-track mix previewed
  at −1.0 dBFS as a WAV and encoded to **0.0 dBFS**, raising `audio_clipping` on
  a mix the limiter had already handled. That made `preview_audio` and
  `build_film` disagree about the one audio metric an agent cannot check by ear,
  which trains callers to ignore it. Costs half a decibel of loudness.
- **A held output file now fails before the render, not after it.**
  `assertDeliveryWritable()` write-opens an existing destination at the *start*
  of every staged delivery — before the render lock, before Chromium, before a
  build's assemble — and raises `disk_error` with `phase: "preflight"` if a
  reader holds it. Measured: two consecutive 600-frame renders each ran to 100%
  over ~3.5 minutes and then died at the promotion rename, roughly seven minutes
  spent to learn what one file handle reports instantly. The message names both
  ways out (close the holder, or change `output.filename`). Advisory by design —
  a holder can still appear before promotion, so this reduces wasted work rather
  than guaranteeing success; the existing backoff and rename-aside side-step are
  unchanged.
- **`probe_asset { audioPeak: true }` reports where a clip is loudest**, adding
  `peakDb`, `peakAtSeconds` and `windowSeconds`. This is the number you need
  before placing a one-shot on a beat, and it previously had no representation
  in the tool surface at all: a cue's transient is usually not at 0 s — measured
  across five generated cues, 0.00 / 0.09 / 0.87 / 3.22 / 4.31 s — so a riser
  started *on* the downbeat peaks four seconds late. Off by default because it
  decodes the whole file. Exact for a transient; for a broad swell the peak is a
  plateau, so it reads as the middle of the climax.
- **`update_film` can edit a saved audio timeline without restating it.**
  `audioGainOffsetDb: -2` shifts every track by one offset, preserving the
  balance — the documented fix when a build reports clipping — and
  `audioPatch: [{ id, gainDb }]` changes named tracks only. Array fields still
  replace wholesale otherwise; these two are the exception, because *mastering*
  a timeline is a different operation from *authoring* one. Previously a 2 dB
  master move meant re-transcribing all 21 tracks, twice, where one slip
  silently reverts a track. Neither can add or remove tracks, an unknown id is
  an error naming the real ids rather than a silent no-op, both are mutually
  exclusive with `audio`, and both resolve inside the read-modify-write that
  `expectedRevision` guards.
- **`probe_asset` no longer misreports the engine's own output.** `fps` came
  from `avg_frame_rate` (frames ÷ duration), so every film this engine builds
  probed as **30.001 fps** and collected a warning that seeking would not land
  on source frames — while its `r_frame_rate` was exactly 30/1. `pickFrameRate()`
  now prefers the base rate when the two agree to within 1%, which is true for
  CFR and false for the variable material the average exists to describe. Real
  fractional rates (29.97, 23.976) are untouched and still earn the note.
- **`transcribe_asset` no longer returns a whole song as one sentence.**
  Sentences closed only on punctuation, and sung lyrics have none: measured
  twice, an entire lyric came back as a single "sentence" (145 s in one film,
  174 s in another), leaving `rawSegments` — which the docs correctly say are
  not edit points — as the only usable structure. Sentences now also close on a
  **pause** (>= 700 ms, a real silence, so the boundary is cuttable by
  construction), on a **cap** (20 s), and, for material measurably lacking
  punctuation, on the vendor's own **phrase boundaries**. Each sentence reports
  which rule closed it in `boundary`. On the same song: 2 sentences → 48, longest
  174 s → 6.0 s, landing on lyric lines. Prose is unaffected (the phrase-boundary
  fallback only engages below ~1 full stop per 40 words), and `DERIVATION_VERSION`
  is bumped so cached transcripts are re-derived.
- **`MotionStudio.beatGrid()` (frame API v1.5)** — `pulse`/`barPulse`/
  `frameOfBeat`/`nearestDownbeat` from a measured grid. Two music videos
  hand-rolled these, and both had the same trap available: a beat is not an
  integer number of frames (140 BPM at 30 fps is 12.857), so anything stepped by
  a constant slides a whole beat every few seconds.
- Documented the ceiling change, the preflight, both new timeline operations,
  the frame-rate fix, the sentence boundaries and `beatGrid` in
  `architecture.md`, `mcp-setup.md`, `film-setup.md`, `frame-api.md`,
  `transcribe-setup.md` and `SKILL.md`.

`audioTargetPeakDb` needed no change: the string-flattening fix shipped in v0.23
(`nullableNumber`) already handles it.

### The production loop: AI directs, the human advises (v0.23)

Motion Studio's working model is now stated and implemented end to end: the
**AI is the director and operator** — it plans, produces, revises, and
assembles unattended — and the **human is an asynchronous adviser** who
watches the evolving film in the Studio and leaves plain-language advice.
There is no approval gate anywhere; production never waits.

Four durable mechanisms carry that loop:

- **Scene revisions.** Every promoted full-scene render is archived as an
  immutable revision beside the live output
  (`scenes/<scene>/revisions/<id>/`): the delivered video (hardlinked — the
  engine's rename-only promotion makes archives immutable for free), the
  render's contact sheet and review report, a snapshot of the composition
  source, and provenance (agent, note, linked advice, parent). A rework never
  destroys the previous take. `list_scene_revisions` reads the history;
  `use_scene_revision` repoints the live output at an archived take with the
  same staged-rename protocol a render uses, re-stamps the render sidecar so
  staleness checks agree, and never deletes newer history. It refuses with
  `revision_mismatch` when the scene's settings have changed since. The
  `render` tool takes an optional `note` and `adviceIds`; its finished job
  status reports the archived `revisionId`. Retention is explicit
  (`pruneRevisions`), and never touches the current revision or anything
  pinned by a delivery manifest or advice evidence.
- **Immutable deliveries.** Every successful `build_film` is archived under
  `deliveries/<id>/` with the delivered video and a frozen `manifest.json`
  mapping every film frame to the exact scene revision, sequence, caption,
  overlay, and audio item that produced it. The Studio's review player pins
  one delivery and resolves clicks through its manifest, so advice binds to
  what the human actually watched — even after production moves on. The
  finished build job reports its `deliveryId`; `list_deliveries` lists and
  returns manifests.
- **Human advice.** A per-film durable advice store
  (`advice/<id>/`): immutable `request.json` (wording, structural target,
  and the exact observed delivery/revision/frame), append-only
  `events.ndjson`, a replaceable `state.json` projection, terminal
  `resolution.json`, and best-effort before/after frame evidence that is
  captured *after* the request is durable and records its own failure rather
  than losing the request. The agent protocol is five MCP tools —
  `check_human_advice` (read-only, oldest first, never blocks),
  `acknowledge_human_advice`, `begin_advice_work` (renewable TTL lease so two
  agents cannot process one item; expiry is the crash recovery),
  `resolve_human_advice` (`applied` / `partially-applied` / `not-applied` /
  `superseded`, or non-terminal `needs-clarification` whose question the
  human answers with linked follow-up advice), and `list_human_advice`.
  Resolutions are immutable with idempotent retry via `requestId`, and an
  after-frame is captured automatically for scene-target advice.
- **Production events and status.** `report_agent_activity` writes expiring
  heartbeat files ("Creating scene demo-shot") and `get_production_status`
  projects readiness, unresolved advice, the current delivery, and whether
  newer work awaits a build. The Studio serves one reconnectable SSE stream
  (`GET /api/events`, `Last-Event-ID` replay from a ring buffer, `reset` on a
  gap) fed by its own writes *and* a recursive watcher on the workspaces
  root — which is how work done by an MCP server in another process appears
  live in the browser. `get_capabilities` gives a director the whole model in
  one call.

### Narrative sequences

Film segments may carry a `sequence` label, and the film document an optional
`sequences` metadata map (`{ Intro: { intent } }`). Consecutive segments
sharing a label form a story band in the plan (`plan.sequences`), the film
timeline, and advice targets ("Sequence 2"). Sequences are presentation: they
render nothing, own no files, and relabeling moves nothing.

### One film page: watch & advise, with advanced editing behind a toggle

The first cut of this shipped a second surface — `review.html` beside
`film.html` — and reading a film meant knowing which of two screens with
similar timelines and different rules you were on. That was the confusion, so
there is now **one page per film** and no review route at all.

`film.html` opens in **watch & advise**:

- The left rail is a `Film → Sequence → Scene/Footage` **tree**. Selecting a
  sequence highlights its band and moves the playhead to its start; selecting
  a segment selects the same timeline block. Scene folders the play order
  does not reference stay below as **unused scenes**.
- The timeline gains a **sequences** band row above the scenes row and an
  **advice** marker row below the tracks. Unresolved advice shows as a count
  badge on the tree row and the block itself.
- One prominent **Advise AI** button (`A`) opens a popup on whatever is
  selected — sequence, scene, footage clip, audio, caption, overlay, or the
  film at a moment. Press it with nothing selected and the next click on the
  tree, timeline, or picture becomes the target (`Esc` cancels). The popup
  carries the target label, the film time, one comment box, and — for a scene
  with history — the **previous result** and **ask AI to use this previous
  result**.
- The inspector shows the selection's facts, its **versions** (each archived
  take, previewable in the main player in place, with *ask AI to use this*),
  and the **advice** scoped to it, in the human vocabulary: *advice sent → AI
  received it → AI is working on it → updated*, or *AI reviewed it* with a
  reason, or *AI needs more information* with a question answered inline.
  Opening one shows the AI's explanation and the before/after frames.
- The player keeps the editor's honest scene-stitched preview and adds a
  **built film** source that pins one archived delivery; a newer build offers
  itself in a banner rather than switching beneath the playhead, and a build
  whose frame count no longer matches the cut says so.
- The header carries the live production line from agent heartbeats,
  degrading to "waiting for the next AI run".

**Advanced editing** is a header toggle (remembered per browser) that reveals
every production control unchanged — add/trim/reorder, render, build, undo,
sequence create/rename/ungroup and intent — plus the same advice and version
sections. Watch mode is genuinely read-only: block drags, the Delete key, the
name field and the undo stack are all inert, and lane `+` buttons are gone.

`GET /api/films/:fid/review` is now `GET /api/films/:fid/overview`, and
`review.html` / `review.js` / `review.css` are no longer served.

### A human watching a scene could fail the AI's re-render of it (v0.23.2)

Measured, repeatedly: while the Studio streams a scene's output to a `<video>`
— a human on the film page — Windows refuses `rename(staged → output.mp4)`
with `EPERM` for as long as that page is open, so **8 of 8 re-renders failed
while 6 of 6 brand-new scenes succeeded**. The bounded backoff added earlier
cannot help; the handle is held for minutes, not milliseconds. In an
AI-directed, human-advised product this is exactly backwards: watching must
never be able to break directing.

`promoteStagingOutput` now side-steps a held destination. Windows does allow
renaming the open file *itself*, so the old delivery is moved aside, the new
one takes the delivery name, and the aside copy is dropped. The reader keeps
streaming the bytes it already opened — its handle follows the inode — and
sees no corruption.

This is **not** the delete-then-rename fallback the module has always refused.
Nothing is deleted before the replacement is in place, and if the second
rename fails the old delivery is renamed straight back, so a failure still
leaves the previous delivery exactly where it was. Covered by tests that hold
a real `fs.createReadStream` open, because the bug is a platform rename
semantic a mocked rename cannot reproduce.

### The human can take advice back

Advice was one-way: a typo, a duplicate, or a note the human thought better of
stayed unresolved forever and was re-served to every later AI run. Two new
actions, both in the film page's advice section: **withdraw** on a single open
item, and **withdraw all N open across the film**.

Withdrawing is a resolution, not a delete — `withdrawAdvice` /
`withdrawAllAdvice` write a terminal `not-applied` resolution flagged
`withdrawnByHuman`, append a `withdrawn` event, and leave the original wording,
events and evidence on disk. "I asked for this and took it back" is part of the
record. `check_human_advice` stops offering it; the timeline marker turns
resolved rather than disappearing; the card reads *you withdrew this* rather
than crediting the AI with a decision it never made. Withdrawing is idempotent,
so clearing the board cannot race an agent that just resolved something, and it
never overwrites an existing resolution.

New routes: `POST /api/films/:fid/advice/:aid/withdraw` and
`POST /api/films/:fid/advice/withdraw-all`.

### One film surface, no mode switch

The watch & advise / advanced editing toggle is gone, and so is the header
**Advise AI** button. The mode only ever hid buttons, which made a reader work
out which mode they were in before they could trust the screen — the same
"which surface am I on?" tax the review page charged. The page is now always
the full editor.

Advising is driven from the inspector, beside whatever is selected, because
that panel already knows the target; with nothing selected it still arms one
targeting click (or press `A`). `+ seq` moved from the rail header down beside
`+ new scene`, so both "make something new in this film" actions sit together.

### The whisper.cpp setting accepts a folder

Pointing the transcription executable at the folder you unzipped — the obvious
reading of a "where is whisper.cpp" box — spawned the *directory* and reported
`whisper.cpp not found` while `whisper-cli.exe` sat inside it. It now resolves
a directory to the binary within, searching the folder itself and its
`Release`, `bin`, `build/bin/Release` and `build/bin` subfolders for
`whisper-cli` or the older `main`. Models are then located beside the
**resolved** binary, so pointing at `whisper-bin-x64` alone is a complete
setup. The Studio's `command` row reports what it resolved to and where it
looked; a folder holding no binary keeps the value the human typed and says
so specifically instead of the generic "not found".

### Filesystem paths are readable in the Studio

Every setup surface truncated the thing it existed to show. The vendor cards'
fact rows (`command`, `models folder`, `soundfont`) and the settings page's
resolved-path hints ellipsised mid-path; the path *inputs* sat in a 3-column
knob grid capped at 240px a column, cutting a Windows path off around
`C:\Users\name\so`. Fact rows and hints now wrap, path inputs get their own
full-width monospace stack (the shape the settings page's storage block
already used) while `threads`/`sample rate`/`model` stay compact, the settings
storage block opts out of the form's 720px reading measure, and every path box
carries its current value as a hover tooltip.

### Footage clips are advisable, by stable id

Footage segments are stamped with a persistent `id` (scenes already had one:
the slug). Identity cannot be the path, because the same plate may be cut in
twice, and it cannot be the array index, because every reorder would re-aim
yesterday's note at whatever now sits fourth. `footage` joins the advice
target types, addressed by that id; the plan and delivery manifests carry it;
`update_film` accepts and echoes it. Advice on a clip captures its before
frame from the film's own asset.

New error codes: `revision_not_found`, `revision_mismatch`,
`advice_not_found`, `invalid_advice`, `advice_lease_held`,
`advice_already_resolved`, `delivery_not_found`, `film_conflict`.
New environment:
`MOTION_STUDIO_AGENT` names the director identity stamped on revisions,
deliveries, advice events, and heartbeats (defaults to the workspace name).

### An open Studio tab can no longer silently revert the AI's edits

Film patches replace whole arrays — that is the right contract for a timeline
edit, and it is also a lost-update trap the moment two people hold the
document. A writer with a stale `scenes` snapshot does not merely lose its own
field; it reverts every segment change made in between, with no error and no
trace. Measured in production during this release: an agent reordered a
16-scene film, the human had the film page open in a browser from before that
edit, one later interaction autosaved the page's page-load-old array, and the
scene order was scrambled back. The built delivery was unaffected (its manifest
is frozen), which is exactly what made the loss quiet.

`getFilm` now returns a **`revision`** — a hash of the stored document,
derived, never written to disk — and `updateFilm` takes an optional
`expectedRevision`. A mismatch is `film_conflict` (HTTP 409, carrying both
revisions) instead of a write. It is deliberately optional: the internal
read-modify-write callers (`createScene`, `removeScene`, `renameAsset`) act
within a tick and would only be made noisier by it. The two writers that hold
a snapshot across human or agent think-time send it:

- **The Studio film page** sends its revision with every autosave. On a
  conflict it does not re-send and does not merge — there is no honest merge
  for whole-array replace — it drops the unsaved edit (at most one 700 ms
  debounce), reloads, clears undo history that now describes a document that
  no longer exists, and says plainly that the edit was not applied.
- **`update_film`** accepts `expectedRevision`, and `get_film` returns the
  `revision` to pass back.

The page also stopped drifting in the first place: `/overview` already carried
the current film document, so a clean tab now notices the revision moved and
catches up on its own instead of waiting to conflict. While the human has
unsaved work the page says "changed elsewhere" and leaves their edit alone.

Scalar-only patches (`build_film`'s `outputFilename` / `audioTargetPeakDb` /
`burnCaptions`) stay unguarded — they cannot revert anything, and requiring a
revision there would only make builds fail spuriously.

### Promotion rides out transient Windows locks

Staged-delivery promotion (`promoteStagingOutput`) now retries a rename that
fails with `EPERM`/`EACCES`/`EBUSY` on a bounded backoff (~1.5s total) before
surfacing `disk_error`. Measured in production: three consecutive re-renders
failed `EPERM` renaming over an existing delivery while no process held the
file (an immediate unlink succeeded) — the signature of an antivirus/indexer
briefly locking the destination during rename-over-existing. The promotion
primitive remains rename-only; there is still deliberately no
delete-then-rename fallback, and non-transient codes still fail immediately.

### Nullable numeric MCP arguments survive schema-flattening clients

`update_film`/`build_film` `audioTargetPeakDb` and overlay `widthPct` publish
as `anyOf [number, null]` — but a client that flattens `anyOf` to `{}` has no
type to coerce against and delivers the model's argument as a string, which
the plain union rejected (measured: `build_film { audioTargetPeakDb: -2 }`
arrived as `"-2"` and failed input validation). Those fields now coerce
numeric strings and `"null"`/`""` at runtime while publishing the same
schema; a non-numeric string still fails with the normal typed error.

### MCP render-tool discovery compatibility

`render.frameRange` now publishes as a homogeneous integer array constrained to
exactly two entries. Its previous Zod tuple emitted draft-07 `items: [...]`;
strict MCP tool importers rejected that schema and silently omitted the entire
`render` tool, even though the official MCP SDK accepted it. The runtime
`[startFrame, endFrame]` contract is unchanged, and the integration suite now
guards the advertised schema shape.

### Direct ComfyUI image, video, and music generators

The shell-capable authoring workflow now has dedicated helpers for local Qwen
Image 2512, local Ideogram 4, local Krea 2, paid Wan partner video generation,
and local ACE-Step 1.5 music. Every helper prints machine-readable JSON, performs
model/node readiness checks, supports reproducible seeds and idempotency
sidecars, and writes requested outputs under the caller's chosen path.

The Ideogram guide now makes structured JSON captions the primary workflow.
Plain text can trigger a false safety-filter placeholder even for a harmless
prompt; the verified JSON smoke test rendered the exact requested headline.
Wan remains cost-guarded and does not submit until the caller explicitly adds
`--confirm-cost`. ACE-Step documentation includes instrumental, English vocal,
and Mandarin metal-rock examples plus the handoff into Motion Studio's measured
audio-preview workflow.

### Safe staged delivery promotion

Scene renders and film builds now encode to a hidden `.staging/` file beside the
delivery, verify the staged frame count when ffprobe is available, then promote
it with one rename. A failed or cancelled retry no longer truncates or removes a
previous good delivery. The terminal job status reports `promoted: true` only
after that rename and reports `framesVerified: false` when the optional frame
probe was unavailable.

Canonical scene sidecars now record the promoted file's `bytes` and `mtimeMs`.
If the file is replaced after metadata is written, the plan reports it stale
even at identical settings; legacy sidecars remain explicitly unverified. The
Studio's output list hides the staging folder.

### Delivery review artefacts and policy gates

Every staged single-file scene delivery and film build now records a persistent
`<base>.review.json` plus `<base>.contact.png` from the encoded staging file
before promotion. The report contains frame/probe/audio/picture facts and
classified warnings; the contact sheet covers first/last frame, cuts, and
caption onsets with segment context. Default policy blocks only a verified
frame-count mismatch, while intentional dark/static/cut findings remain
warnings. Global `render.review` settings seed the policy and a film can
override either severity list. A block returns `promotion_blocked`, preserves
the previous delivery, and leaves staged evidence for diagnosis. The Studio
film build panel now displays the contact sheet with warning overlays.

### Stage-A platform deliverables: one film, several aspect ratios

Films can now save platform-delivery snapshots for YouTube 16:9, Shorts/TikTok
9:16, Square 1:1, or a configured custom target. An AI/API caller resolves them
at `create_film` time (`deliverables: ["youtube-16x9", "shorts-9x16"]`), before
any scene exists; the chosen snapshot carries target geometry, crop focus,
caption style, safe areas and an independent filename. No platform named means
master-only by default — the engine does not silently manufacture three versions.

`build_film { deliverable: "shorts-9x16" }` takes the approved master cut,
compiles a timeline-aware reframe from the scene layout, and makes one target-size
finishing encode. It never clones/rebuilds the timeline. Each delivery gets its
own output, SRT, review JSON and contact sheet; the sheet draws its safe guides.
Completed jobs expose the exact `deliverable` plus `reEncoded: true`. Studio now
has platform selection in **new film**, version/crop/caption controls in the film
inspector, and master/selected/all-version build choices.

### Prepared-footage source provenance

A footage segment may now carry `derivedFrom: { asset, transcodeMeta }`, a small
pointer to the `.transcode.json` record that made its prepared clip. The film does
not duplicate that record's trim, crop, or source identity. `transcode_asset`
returns a ready-to-insert `timelineSegment` with those pointers when it conforms
video for a film.

`planFilm` reads the sidecar and rechecks the recorded source before a build. A
source edit, replacement, missing source, or missing sidecar reports
`footage_source_changed` in the plan and blocks a direct build as well. Existing
footage with no provenance pointer keeps its previous behavior.

### Two P1 MCP safeguards: callable mastering and language-safe transcription

`audioTargetPeakDb` and overlay `widthPct` used Zod's `.nullable()` form, which
the MCP schema converter published as `{}`. Clients therefore could not coerce
numeric values such as `-2` for mastering. They now publish an explicit
number-or-null schema, with an integration test covering all three fields.

`transcribe_asset` now refuses an explicit non-English `language` when the
selected whisper.cpp model is English-only (`*.en`). Previously whisper.cpp
returned a plausible-looking English artefact and timing data for speech it did
not understand. The new `transcription_language_unsupported` error names the
model and reports installed multilingual alternatives; auto-detection is still
allowed.

### Where everything lives is a setting, and the default moved into the app

The Studio's Global Settings page listed the data dir, the workspaces root and
the settings file under **environment (read-only · set via env vars)**. They are
fields now. Alongside that the default data dir moved from `~/.motion-studio` to
**`<app>/data`** — the folder beside `engine/` — so a checkout carries its own
library and is one folder to copy, back up, or move to another drive.

**Why they were read-only, and what changed.** Not caution: there was nowhere to
write them. A setting's home is `settings.json`, and `settings.json` is one of
the three things being located. `core/paths.js` gives them a bootstrap file of
their own —

```
<app>/paths.json    { dataDir, workspacesRoot, settingsFile }   any may be null
```

— resolved per key as **env → `paths.json` → default**, with
`MOTION_STUDIO_WORKSPACES` and `MOTION_STUDIO_SETTINGS` joining the existing
`MOTION_STUDIO_HOME`. Env stays on top for the reason it already outranks
settings for the ffmpeg binary: an MCP server is spawned by its client with
whatever environment that client chose. A field the environment has decided is
shown **locked** rather than accepting an edit that would do nothing.

App-relative values are *stored* relatively (`{"dataDir": "data"}`), so moving
the folder moves the install intact.

**Your existing library does not move, and does not vanish.** When nothing is
configured, `<app>/data` does not exist yet and `~/.motion-studio` does, the old
directory wins — reported as source `legacy` — and both servers record it in
`paths.json` at startup so the answer stops depending on which folders happen to
exist. A fresh install never takes that branch. Switching afterwards is a field
edit; the Studio prints the path it settled on at startup either way.

**The running Studio follows without a restart.** `PATCH /api/settings` takes a
`paths` patch beside the usual `patch` and rebuilds the server's
`WorkspaceStore` in place, because "changed the data dir, saw no change" is
indistinguishable from a broken setting. Sending both in one request writes the
settings to the *new* file, not a parting write to the old one.

Three things it deliberately does not do:

- **Move any files.** Point the fields at a tree that already exists, or copy
  yours across first. A save that silently relocated gigabytes of renders is not
  a save.
- **Proceed while work is in flight** — `storage_busy` (HTTP 409) until the
  queue drains. A render holds absolute paths into the old tree and writes
  frames there for minutes; swapping underneath it produces a corrupted result
  rather than an error, and waiting is cheap.
- **Reach into other processes.** Connected MCP servers resolved their paths
  when their client spawned them, so they keep using the old location until
  restarted. The response says so (`relocated.restartAgents`) instead of
  pretending otherwise.

A configured override applies to the **configured** data dir only — name any
other directory and you get the conventional layout inside it. That is what
keeps a caller passing an explicit `dataDir` (a test over a temp dir, a CLI run
against a copy) from silently borrowing the machine's real workspaces.

`MOTION_STUDIO_PATHS_FILE` redirects the bootstrap file itself. It exists so the
suite can cover the write path without rewriting the developer's real
`paths.json` — a test that can repoint your film library is a test nobody runs.

New error code: **`storage_busy`**. Details in
[architecture.md §11.1](architecture.md).

### Stated film colour and footage conforming

Final colour-carrying renders now state BT.709 primaries and matrix, sRGB transfer
(`iec61966-2-1`), and TV range via the shared `setparams` filter. The same derived
profile is exposed in `signature.color`, recorded in render sidecars, and preserved
by the finishing pass. Legacy sidecars that lack colour fields remain unverified;
re-rendering under a different stated profile produces a normal `stale_render`
diagnostic instead of silently mixing old and new output.

`transcode_asset { matchFilm }` now performs a real `colorspace` conversion to the
signature's colour contract rather than merely relabelling footage. If input colour
metadata is incomplete, it assumes BT.709 and returns that in `assumptions.color`;
the same assumption is part of the transcode cache identity. GIF, PNG-sequence, and
the RGB GIF intermediate remain deliberately outside this YUV delivery contract.

### Deliverable review and picture telemetry

`inspect_render` returns downscaled PNGs from a scene's encoded output or a built
film — including concat seams, burned captions, and finishing overlays that a
composition preview cannot show. It samples known cuts or holds from the film plan,
distributed across longer films while staying within a 24-image response cap.

`measure_render` is the picture analogue of `preview_audio`: a cancellable task that
reports a motion envelope, static/black runs, solid frames, and measurements across
the cuts the engine already knows. Full scene render jobs expose `staticFrames` and
film builds expose a compact `picture` summary. These are advisory facts: a static
title card or intentional fade is not an engine failure.

### MCP resilience and branch-aware linting

Speech, music, and sound-effect generators now create nested `assetPath` parents;
`wait_for_render` returns expired ids as terminal `not_found` snapshots without
hiding the rest of a batch; and `preview_audio` runs as a cancellable task so a long
mix cannot outlive an MCP request.

The `sequence-gap` lint now skips coverage analysis when literal `Sequence()` calls
span mutually exclusive helper scopes. Its same-scope gap detection is unchanged,
so documented shared-engine branches no longer teach callers to ignore warnings.

### The read-only media tools can reach `out/`

`transcribe_asset`'s own description says re-transcribing a render is how you verify
a finished cut — and then the path guard refused `out/film.mp4`, because reading was
confined to `assets/` alongside writing. The documented workflow was impossible.

Found by building a real 30-second film end-to-end: everything up to the last check
worked, and the last check could not be expressed.

`probe_asset`, `transcribe_asset` and the Studio's `GET …/probe` now accept an
`out/`-relative path as well as an `assets/`-relative one (`store.resolveMediaFile`).
**Reading is all it grants**: writes, deletes and renames still go through
`_assetRelPath` and stay confined to `assets/`, so a deliverable cannot be
overwritten through the tool surface, and the sandbox escape checks apply to the new
prefix exactly as before. A missing file under `out/` says "render it first" instead
of pointing at `list_assets`.

### `transcode_asset` — preparing media inside the tool surface

`probe_asset` let an agent *read* a media file; `transcribe_asset` let it *hear*
one. Neither can **change** one, and every real job with supplied footage needs to.
An agent on the MCP surface stopped at exactly that line: it could report that a
clip's codec cannot be decoded by the render browser, and then had no way to act on
its own advice.

The evidence was a session where a user dropped a 7.7 MB OBS recording in the
library and asked for a promo built around it. It completed only because the agent
had a shell outside the MCP surface and used it seven times — H.264 → VP9, a PIP
crop, a logo removal, and an audio extraction that was simply never attempted
because it was unreachable. The user's voice was unusable, and that was forced by
tooling, not chosen for the film.

```
transcode_asset { target: 'my-film', from: 'talk.mp4', to: 'assets/segment.mp4',
                  mode: 'video', matchFilm: 'my-film',
                  trim: { startSeconds: 2.0, durationInFrames: 186 },
                  crop: { x: 384, y: 110, width: 1152, height: 648 },
                  scale: { width: 640 }, video: { gop: 10 } }
→ measured on the RESULT: { video: {codec,width,height,pixFmt}, frames, bytes, notes? }
```

**Three modes.** `video` conforms footage — trim to an exact frame count, crop,
scale, fps, codec from the `to` extension. `audio` cuts N `spans` out of one source
and **joins** them into a PCM WAV, because building a spine from a talk is *N*
trims joined, not one. `frames` writes a PNG sequence.

**One architectural rule: no arbitrary ffmpeg arguments.** Not `args`, not
`filter`, not an escape hatch. The premise of this surface is "no shell"; a
passthrough is a shell wearing a hat and it takes the path sandbox with it. Every
operation is a named, validated field, and the two functions that build the filter
graph are pure and unit-tested without ffmpeg — they are the entire surface that can
ever run, which makes the claim checkable rather than aspirational. A test asserts
that passing `args`/`filter` has no effect, because the schema strips them.

**`matchFilm` is the option that prevents the common disaster**, and it is where all
four v0.22 plans close a loop: it splices the film's own `signature.ffmpegArgs` into
the command, so the output agrees with the film by construction instead of by an
agent's arithmetic. The film *states* its contract, this *conforms* a file to it,
and the timeline *holds* the result — proved end to end by a test that takes a raw
640×480 H.264 clip from the library, conforms it, places it between two rendered
scenes, builds the film, and counts every frame in the output.

Four properties, each replacing a way a wrapper usually goes wrong:

- **Report by measuring, never by echoing.** The response is the `probe_asset`
  block on the *output*, including a `notes` warning if the result still is not
  browser-decodable. A caller who asked for 640×360 and got 640×358 (even
  dimensions, chroma subsampling) learns it here, not from a render three steps
  later.
- **Frames, not seconds.** `durationInFrames` maps to `-frames:v`, which guarantees
  the count; `-t seconds` does not, and one frame of drift breaks a concat seam.
  **Corrected during implementation:** `-frames:v` counts *output* frames, so
  "12 frames, every 3rd" originally read 36 source frames. `trim.durationInFrames`
  now means frames *of source* in every mode — a trim describes the span being read
  — so that call yields 4 images.
- **Idempotent and never destructive.** A `*.transcode.json` sidecar records the
  source identity and every parameter, so repeating an unchanged call returns
  `skipped: true` at zero cost. The destination may never equal the source.
- **Bounded**, with the refusal stated as a measurement rather than a silent
  40-minute encode.

Span-joining lives in an asset tool rather than on the audio timeline for a
measured reason: the mixer's fades are frame-quantized, and 12 ms at 30 fps is 0.36
frames — inexpressible there. A hard butt-join between two spans of speech **clicks
audibly**, so `crossfadeMs` defaults to 12 with a triangular shape. `acrossfade`
overlaps its inputs, so the joined length is `sum(spans) − (N−1) × crossfade`; the
fade consumes time, which is what makes it a crossfade rather than a gap, and the
tests assert that arithmetic against a real encode.

Two decisions worth recording. `gop` was **kept** despite the plan's own retraction
of the GOP-matching cargo cult — not because a concat needs it (it does not; that
was measured for the film signature) but because a short GOP makes the per-frame
`seekVideo()` seeking inside a composition much faster, which `frame-api.md` §11
already documented. And `.gif` is **refused** as a destination with a message
explaining why: gif's own encode arguments *are* a `-filter_complex`, which cannot
be combined with a crop/scale chain — render a gif scene instead.

Docs: the tool row in [mcp-setup.md](mcp-setup.md), a new
[architecture.md](architecture.md) §9.4, and the two that mattered most —
[frame-api.md](frame-api.md) §11 and [SKILL.md](SKILL.md) both told the agent to
have **the human** run ffmpeg for the H.264 trap. That instruction is now wrong, and
both say so.

### Footage on the film timeline — the thing that was inexpressible

`film.scenes[]` could hold exactly one kind of thing: a rendered scene. So a film
was *only* rendered graphics, and there was no way to say **"footage, then a scene,
then footage"** — which is what almost every film built around a person's own
recording actually is.

The evidence was blunt. A session built a 65 s film interleaving four footage
segments with five rendered scenes, and **`build_film` was never called.** Not
because it failed — because it could not be asked. The assembly was a nine-part
`ffmpeg concat` plus a separate audio mux, done in a shell, and the resulting
`film.json` still read `"audio": []` with five scenes, describing a film that was
never built. The workspace kept no record of the actual cut.

A film's play order is now **heterogeneous**:

```jsonc
"scenes": [
  { "slug": "title" },                                      // a rendered scene
  { "footage": "assets/f1.mp4", "durationInFrames": 231 },   // NEW
  { "slug": "lamb" },
  { "footage": "assets/f2.mp4", "durationInFrames": 320, "label": "B-roll" }
]
```

The key stays `scenes[]` and **`schemaVersion` stays 1**: an entry with `footage`
and no `slug` is unambiguous, so every film written before this release remains
valid with no migration.

**This is one new kind of entry in an ordered list, not new machinery.**
`assembleFilm` already concatenated a list of signature-matched files and laid the
master audio over the result; it could not take footage only because the file path
could only be produced from a scene ref. Four segment accessors (`isFootage`,
`segmentFrames`, `segmentPath`, `segmentName`) are now the only code that knows the
difference, so layout, validation and assembly read one vocabulary. The audio side
needed nothing at all — a single `film.audio[]` track at `startInFrames: 0` spanning
the whole film was always expressible, and the mixer always handled it. Only the
*picture* order was missing.

**Declared, then verified.** `durationInFrames` is stated in the document so
`planFilm` can compute offsets without probing every file on every call — the same
reason scenes declare theirs in config. But a declaration that is never checked is
worse than none, because every downstream offset derives from it: one wrong count
silently shifts every later scene, caption and cue while the render still
"succeeds". So `planFilm` probes and reports `footage_duration_mismatch`
(`declared 231 → actual 230`) at plan time, beside `scene_not_rendered` and
`stale_render`. **Measured:** an mp4 reports `nb_frames` in its header but a webm
reports nothing, so the count falls back to `probeFrameCount`'s packet scan — which
costs ~46 ms even on a 30 s 1080p file, cheap enough to always take. ffprobe is not
a declared prerequisite, so `framesVerified` has three states and `null` is **not**
"matches".

**Never re-encoded.** Footage that does not match the film's signature is
`footage_signature_mismatch` naming the fix — not a silent transcode. A film that
quietly re-encodes one segment has stopped being losslessly assembled, which is the
whole reason scenes share a signature. The comparison is possible because
`probeSignature()` rebuilds the same fingerprint `sceneSignature()` produces, which
required stating a mapping that did not exist: ffprobe reports a **codec name**
(`h264`) and a comma-separated container list (`mov,mp4,m4a,…`) where the engine
names a **format** (`mp4`) whose encoder is `libx264`.

**Footage is silent, by contract.** All sound comes from the master timeline, and a
footage file carrying an audio stream is refused with the fix. Silently dropping it
would be worse: the user's own voice would vanish from a film they can hear it in.
One consequence, corrected from the plan that proposed this: a film mixing footage
with audio-carrying scenes **does** trip `mixed_scene_audio` and needs a master
timeline. That is the normal shape for such a film, not a workaround.

Also in this change:

- **`normalizeFilm` was the real blocker**, more than the Studio drag the plan
  warned about. It projected every entry to `{slug}` on *every* save — and
  `createScene`, `removeScene`, `update_film` and the Studio's 700 ms autosave all
  route through it — so footage would have validated, persisted once, and then
  vanished on the next unrelated edit. `update_film`'s zod schema stripped it even
  earlier; it is now a union, because a loose object shape silently discards
  whichever half the caller sent.
- **A film can now open on footage.** `planFilm`, `validateScenes` and
  `buildFilmArtifact` all seeded fps/format/signature from the first *scene*, so an
  all-footage film had none. The contract is now established by whichever kind of
  segment resolves first, with `sceneDefaults` as the fallback.
- **Deleting or renaming referenced footage is no longer silent.** The
  dangling-reference machinery was audio-only, so deleting a clip a film plays
  reported `audioRefs: 0` and succeeded — then the build failed on a missing input.
  `footageRefs()` is the twin of `audioRefs()`: a delete is refused naming the
  segments, and a rename repoints them (unconditionally — there is no version of
  "keep the old path" a caller could want).
- **The Studio film editor** shows footage as a distinct block (warmer fill, ▣
  label, no render dot — it was never rendered and cannot be stale), gives it its
  own inspector (file, probed video properties, verified frame count, signature)
  instead of a scene panel with half its rows wrong, previews it from the film's
  asset route, and adds **+ footage**, which reads the frame count *from the file*
  rather than asking the user to type the one number everything else depends on.
  A new `GET /api/{films|scenes}/:tid/probe?path=` backs that.
- Tests: the accessors; interleaved `filmLayout` offsets; `validateScenes` skipping
  render/staleness for footage; an all-footage film; `probeSignature` round-tripping
  against `sceneSignature`; a real `-c copy` assembly of footage between two scenes
  measured by frame count and clean decode; declared-vs-actual mismatch; a file with
  an audio stream refused; a signature mismatch naming the fix; **an old
  `slug`-only `film.json` still loading unchanged**; and the end-to-end case — a
  film alternating footage and scenes built through `build_film`, with every frame
  measured in the output.

### The film signature — stating the encode contract instead of hiding it

Motion Studio's long-form guarantee is that scenes share an encode signature and
therefore concatenate losslessly. `sceneSignature()` computed it,
`validateScenes()` enforced it, `assembleFilm()` depended on it — and **nothing
told a caller what it was.**

That is fine while the engine renders every segment. The moment a file arrives
from outside — footage, a supplied clip, a transcode — the caller has to produce
something matching an invariant it cannot read, and it had two options, both bad:
guess, or render a file first and probe it to discover a constant that lives in a
hard-coded table.

A real session guessed. It pinned `-profile:v high -level 4.0` (libx264 selects
exactly those for 1080p30 anyway) and `-x264-params keyint=60:min-keyint=30` while
the engine uses libx264's default 250. The concat succeeded *despite* the
mismatch, because each segment is its own encode and therefore opens on a
keyframe, which is all `concat -c copy` requires. It worked, and the author could
not have told you why.

`get_film` — and every film tool that returns a plan — now carries it:

```jsonc
"signature": {
  "id": "1920x1080@30/mp4/opaque/yuv420p",
  "width": 1920, "height": 1080, "fps": 30,
  "format": "mp4", "container": "mp4", "pixFmt": "yuv420p", "transparent": false,
  "video": { "codec": "libx264", "crf": 18, "preset": "medium" },
  "audio": { "codec": "aac", "bitrate": "192k" },
  "ffmpegArgs": ["-c:v","libx264","-preset","medium","-crf","18",
                 "-pix_fmt","yuv420p","-movflags","+faststart"],
  "copyConcat": true,
  "mustMatch": ["codec","width","height","fps","pixFmt","container"],
  "neednotMatch": ["gopSize","profile","level","bitrate"],
  "warnings": []
}
```

**Derived, never duplicated.** `id` is `sceneSignature()`'s own output; the values
come from the first scene's `output` (the film's encode voice — what the finishing
pass already uses); `ffmpegArgs` is `buildVideoArgs()`, the *same call* that
finishing pass makes. `video`/`audio` are then read back out of those argument
arrays by flag lookup rather than restated, because the format registry holds
codec identity only inside the arrays — a declarative copy would be the second
table that drifts, and the *reported* one is the one that would be wrong. A test
asserts byte-identity against both the renderer's call and the finishing pass's
differently-spelled one.

**`neednotMatch` is now measured, not inherited.** The plan asserted that GOP,
profile and level need not agree, but nothing had ever tested it — libx264 chose
the same profile for every segment, so they always happened to agree. A test now
encodes a segment at a deliberately different profile *and* GOP, concatenates, and
asserts the frames come back **bit-identical** across the seam. They do. That is
what makes the second list safe to publish, and it is what stops the next author
inheriting the cargo cult.

**It is a job for `get_film`, not a new tool.** "What must a file match to join
this film" is a property of the film, and the failure mode here is not knowing
something exists. One edit to `planSummary` covers `get_film`, `list_films`,
`update_film` and `build_film { plan: true }`; the Studio's `GET /api/films/:fid`
already returned the raw plan, so both surfaces came from one implementation.

Also in this change:

- **The render sidecar was blind on two of the signature's own fields.** It
  recorded `frames/width/height/fps/format` but not `pixFmt`/`transparent`, both of
  which *are* part of the concat contract — so a film-wide change to either broke
  that contract with nothing reporting it, and `build_film` would stitch files
  encoded at the old pixel format. Both are recorded and compared now. No
  migration: staleness only compares what a sidecar actually recorded, so renders
  from before this release stay *unverified* on the new fields rather than turning
  up stale.
- **`plan.signature` changed type**, from the bare comparison string to the block
  above; that string is now `signature.id`. Exactly one consumer existed — the
  Studio film editor's scene-rail compatibility check — and it got simpler: it
  compared by re-parsing the id as a string prefix, and now compares named fields,
  which also fixes a latent bug where an unreadable scene folder interpolated
  `"undefined"` into the prefix and reported a false incompatibility.
- **`crf`/`preset` are in neither match list.** They are not required for the
  concat (they affect quality, not stream compatibility) but footage ignoring them
  looks different from the scenes beside it; using `ffmpegArgs` verbatim gets them
  right for free, and a `warnings` entry appears when a film's own scenes disagree.
- **`video.codec` is the ffmpeg encoder id** (`libx264`) while `probe_asset`
  reports the codec *name* (`h264`) — documented, because comparing them directly
  is a guaranteed false mismatch for anything checking footage against a film.
- An end-to-end test proves **sufficiency**, not just correctness: it encodes an
  outside clip from the reported block alone — no guessed flags — then asserts the
  engine's own `validateScenes` accepts it, `concat -c copy` joins it with a real
  rendered scene, the result decodes with an empty stderr, the frame count is
  exactly the sum of the parts, and the external segment's pixels survive the seam.
- Docs: `mcp-setup.md` (the block, field by field), `film-setup.md` (a new section
  under the consistency invariant, plus the sidecar's field list and the
  don't-confuse-this-with-the-render-browser-codec-rule warning),
  `architecture.md` §13, `agent-environments.md`, `SKILL.md`, and
  **`SKILL-shell.md`** — which told agents "**Ask, do not infer** — `get_film`
  reports the film's `sceneDefaults`" while hard-coding the flag list, because
  `get_film` did not in fact report it. That instruction is now true, and the
  hard-coded copy of the encode table is gone.

### `transcribe_asset` — reading the speech in supplied media (whisper.cpp)

The engine could always **write** speech and knew exactly where every word
landed. It could not **read** speech, so everything about a recording a user
supplied was a guess. That asymmetry decided how good a film built around a
recording could be, and it is now closed.

`synthesize_speech` returns `timings` — each sentence's start and duration in
seconds *and frames* — and that one field is why generated narration is easy to
build against. A user's own recording had no equivalent, and the cost was visible
in real sessions: one had to **stop and ask the user what was in their own clip**,
and its four cut-in points (2.0 s, 5.0 s, 0.6 s, 4.6 s) encoded exactly one fact —
the clip is 12.4 s long and the scene must not run past its end. Not "cut in on
the gesture". Arithmetic.

```
transcribe_asset { path: "takes/interview.mp4", fps: 30 }        # a library file
transcribe_asset { target: "my-film/intro", path: "assets/vo.wav" }
→ { text, sentences[], words[], speechRanges[], leadingSilenceFrames,
    trailingSilenceFrames, rawSegments[], durationInFrames, fps,
    vendor, model, language, cached, elapsedMs }
```

Addressed exactly like `probe_asset`, because the two answer the two questions you
have about a file you did not make: *what is it* and *what does it say*.

**Four derivations are the product, not conveniences.**

- **Sentences are rebuilt.** whisper.cpp's `transcription[]` entries are *decode
  windows* — ~7.5 s chunks bounded by the model's context — and nothing about them
  respects grammar. A real one: `[00:00:27.120 → 00:00:32.720] " Why choose our
  device? Unmatched accuracy at 98 percent."` — one segment, two sentences, and in
  the general case a window starts mid-clause. Splicing audio there is the audible
  mid-word cut this tool exists to prevent, so the engine re-segments from token
  offsets. `rawSegments` is returned for debugging and is explicitly **not** an
  edit point.
- **`sentences[]` mirrors `timings[]` field-for-field** (`text`, `startSeconds`,
  `startInFrames`, `durationSeconds`, `durationInFrames`), so recorded and
  generated narration are one code path. Vendor offsets are integer milliseconds,
  converted once, in the engine — everything that places anything in this engine
  speaks frames, and a tool that returns only seconds forces a hand division at
  exactly the spot where an off-by-one hides.
- **`words[]` is what makes graphics land on speech.** Four on-screen labels cued
  to four spoken names, all inside *one* sentence, is not something sentence-level
  timing can do. `wordsMatching: "acme"` returns just the words you are hunting.
- **`speechRanges` + leading/trailing silence answer a different question.** The
  text says what was said; these say *where you can cut* — trim the dead head, cut
  on a pause instead of a syllable, find the gap for a cutaway.

**Confidence is derived and always reported.** whisper.cpp emits no
`no_speech_prob` (an earlier draft of the plan promised to pass one through; the
vendor does not have one), so `minTokenP`/`meanTokenP` per sentence and `p` per
word are computed from token probabilities. Two measured misreads from real runs:
`small.en` rendered "cutting-edge OLED" as **"cutting, HOLED"** and "24/7" as
**"20/47"**, both flagged by a low `minTokenP`. A caption generated blind from
either would have been wrong on screen. **Timing is far more reliable than
spelling** — which is fortunate, because timing is the part the engine consumes.

**Vendor: whisper.cpp, and no API keys.** A single self-contained binary plus one
`ggml-*.bin` model — the same shape as the Piper speech vendor, so it costs nothing
new to document, install or reason about. faster-whisper was considered and
rejected: Python + pip + a CTranslate2 wheel is three moving parts on a user's
machine to read a WAV. Configuration is environment-only
(`MOTION_STUDIO_WHISPER_BIN` / `_MODEL` / `_MODELS` / `_THREADS`) plus a
`transcription` section in `settings.json`; there is nothing secret to withhold,
because there is no account. **Models sitting in a `models` folder beside the
binary are found automatically**, which is the layout every prebuilt release ships
— pointing one env var at the exe is a complete setup. Measured: `ggml-small.en`,
8 CPU threads, no GPU → **6.5–7.7× realtime**, which is what makes it cheap enough
to read a clip on ingest *and* re-read the finished render to check it.

**It is a job, in a second lane.** Transcription is what you do *while* deciding
what to render, so `core/jobs.js` grew a **task lane** with its own concurrency
limit (2) and queue, sharing the id space and every polling tool
(`get_render_status`, `wait_for_render`, `get_logs`, `cancel_render`). Jobs report
`kind`, have no frames (watch `phase`), and carry their whole answer in `result` —
because a transcription's result *is* the answer, where a render's is the file it
wrote. The lanes never borrow each other's slots, and `MOTION_STUDIO_MAX_RENDERS`
does not apply to tasks: it bounds an agent's *renders*. The call itself blocks up
to `waitMs` (default 45 s, inside a client's request timeout) and returns the
transcript inline when it finishes, which at ~7× realtime covers anything under
about five minutes of audio.

**Cached, so asking twice is free.** Keyed on (file identity, model, language) with
a derivation version, in `~/.motion-studio/cache/transcripts/`. The cache stores
*seconds*, so one entry serves a 24 fps film and a 30 fps one. Not beside the file
on purpose: a sidecar in the workspace library is debris in a folder the human
curates, and one in `assets/` invites someone to put it on a timeline. This is
what makes the verification loop — build the cut, then re-transcribe the render —
cheap enough to actually run.

Also in this change:

- **A third capability in the vendor kit.** `core/vendors.js` gains
  `transcription` beside `speech` and `music`, with one vendor today and the same
  selection rule, chain walk, report shape and "not configured" sentence. A
  capability with one provider costs nothing extra to run through the kit; a
  second near-identical resolution path is what the kit exists to prevent.
  `list_vendors { capability: "transcription" }` reports availability, the fix,
  and which `models` are installed.
- **Its own Studio page.** **✎ transcribe** in the sidebar footer, with the same
  grammar as the tts and music pages and one inversion: instead of typing a line
  and hearing it, you hand it a recording and **read what came back** — the
  re-segmented sentences with the frame numbers an agent would place a caption at,
  the least-confident token in each (low values in red), and how many times
  realtime *this* machine reads speech.
- **Three new error codes**: `transcription_unavailable` (a setup problem — do not
  retry), `transcription_failed`, and `transcription_input_unsupported` — a third
  category the generators never needed: the vendor is fine and the setup is fine,
  but the *file* has no readable speech. The fix is a different file, so conflating
  it with either of the others would send the caller to the wrong place. Bounds (60
  minutes, 2 GB) report `asset_too_large` with the measurement rather than becoming
  a twenty-minute silent job.
- **`probe_asset` now reports a workspace-local target id** (`"my-film/intro"`),
  not the internal workspace-qualified one. Every other tool in the surface speaks
  workspace-local ids; this one leaked the prefix.
- Tests run against a **fake whisper-cli** (`helpers/fake-whisper.mjs`) serving the
  verbatim `-ojf` sample from the plan, so the suite never downloads a 466 MB
  model. The load-bearing case has its own test: a decode window spanning three
  sentences must re-segment.
- Docs: **[transcribe-setup.md](transcribe-setup.md)** (new), rows in
  [mcp-setup.md](mcp-setup.md), [architecture.md](architecture.md) §5 (two lanes),
  §6 (error model) and a new §9.3, the Studio page in
  [user-guide.md](user-guide.md), and both skills — [SKILL.md](SKILL.md) gains
  "transcribe before choosing durations", and [SKILL-shell.md](SKILL-shell.md) now
  says to prefer the tool over hand-rolling `whisper-cli`, because the derivation
  is the part that bites.

**What it does not solve**, stated so it is not oversold: it gives text and
timing, not judgement (choosing which four spans of a 94 s talk make an argument
is still the agent's work); it does not answer intent (whether the user wants that
audio kept, replaced or muted stays their question); and accuracy is not free —
anything quoted verbatim on screen needs a human read. Diarization, translation,
cloud ASR vendors and `-dtw` alignment are deliberately out of scope.

### Two agent environments, two skills

**Docs and guidance only; no engine behaviour changed.**

A session built a 65 s film from a 94 s talk using `ffmpeg` + `whisper.cpp` +
Motion Studio, and the accounting was instructive: **31 shell calls against 17
MCP calls**, `probe_asset` (shipped in v0.21) used **zero times**, and
`build_film` never called at all — the film model cannot express "footage, then a
scene, then footage", so the assembly was an ffmpeg concat.

That produced a distinction worth naming, because advice that is right in one
environment is wrong in the other:

- **[agent-environments.md](agent-environments.md)** (new) — **maintainer-facing
  design vocabulary.** **Env A** is MCP tools only; **Env B** adds a shell. Env A's
  bottleneck is *capability* (whole classes of film are impossible); Env B's is
  *correctness* (everything is possible, subtle things go silently wrong). The rule
  that falls out: **tools that only report lose to the shell; tools that report
  what only the engine knows do not.** Also records the rules for editing the two
  skills — self-contained, and the four things they share.
- **[SKILL-shell.md](SKILL-shell.md)** (new) — a second drop-in skill,
  `motion-studio-video-shell`, for an agent that has a shell. The workflow inverts:
  the recording is the spine, so you read it before choosing a single duration.
- **[SKILL.md](SKILL.md)** — states plainly that it has no shell, so its "hand the
  command to the user" guidance reads as required rather than optional.

  **Neither skill uses the Env A / Env B terms.** An agent needs the workflow for
  the setup it is in, not a taxonomy; a human decides which skill to copy where.
  Both skills are also now free of markdown links, since an install directory
  receives only `SKILL.md` + `references/frame-api.md` and any other link breaks on
  install.
- **todo_task/** (new; since consolidated into [plans/](plans/TODO.md)) — four plans scoped against the two
  environments, in ship order, with the acceptance test *"Env A can reproduce the
  prototype film."* An audit against that test found the blocker is **not** asset
  tooling but the film timeline: [footage segments on the film
  timeline](plans/completed.md) was filed as "out of scope" in an
  earlier draft and is in fact the prerequisite for everything else.

## v0.21 — Seeing the media, and catching a stale render

Three fixes for failures that were invisible from the tool surface: an agent
could not read a media file's properties at all, a scene rendered at settings
that later changed still counted as rendered, and a composition referencing a
missing asset died naming nothing.

### `probe_asset` — read a media file's properties

`list_assets` / `list_shared_assets` report bytes, mtime and a coarse `kind`.
Nothing answered **how long is this clip, what size is it, does it have
audio** — the first three questions you ask before building a scene around
footage. Every answer meant shelling out to `ffprobe`, which the tool surface
deliberately does not offer.

```
probe_asset { path: "clip.mp4" }                              # a library file
probe_asset { target: "my-film/intro", path: "assets/b.webm" } # a scene asset
→ { container, durationSeconds, bitRate, streams,
    video: { codec, width, height, fps, frames, pixFmt, durationSeconds },
    audio: { codec, channels, sampleRate, durationSeconds },
    hasAudio, notes? }
```

`notes` calls out properties that bite at render time — above all that
**H.264/HEVC cannot be decoded by the render browser**, so a `<video>` using
such a file fails at render time even though the page's own `canPlayType()`
answers `"probably"`. That single line is the difference between transcoding
to VP9 up front and discovering it hundreds of frames into a render.

ffprobe is not a declared prerequisite, so an unavailable probe returns
`probed: false` rather than failing. ffprobe is now resolved as a **sibling of
whatever `ffmpeg` resolved to** (`resolveFfprobePath`), not as a bare name on
`PATH` — otherwise `probe_asset` would be unusable in exactly the case
`MOTION_STUDIO_FFMPEG` exists for: an MCP server with a minimal `PATH`.

### Stale-render detection — the render sidecar

A scene's output file existing was the whole of "is this scene rendered?". It
cannot answer *is it rendered at the settings the scene has now?* Shorten a
scene with `update_scene_config` after rendering it and nothing noticed: the
plan still reported `rendered: true` with a `totalFrames` the concatenation
cannot produce, and `build_film` cheerfully stitched the old file — after
which every master-audio offset past that scene drifts against the picture,
silently, in the finished film.

Each render that is the **whole scene, at its current settings, to its real
destination** now writes `out/output.mp4.render.json`
(`{ frames, width, height, fps, format, renderedAt }`):

- `planFilm` compares it with the live config and adds a `stale_render`
  problem naming the fields that diverged (`frames 217 → 200`); each scene
  gains `renderVerified: true | false | null`.
- `validateScenes` (so `build_film`) **refuses** to assemble, throwing the new
  `stale_render` error code with a `detail.stale[]` of every offender.
  Distinct from `short_render`: that file is incomplete, this one is complete
  but no longer describes the scene.
- Proxies, per-worker segments and partial `frameRange` renders write no
  sidecar — none of them is the scene's canonical output.
- A render from an older build has no sidecar, and that is **not** stale:
  `renderVerified: null`, builds normally. Writing the sidecar is best-effort
  and never fails a render that already succeeded.

### Frame API v1.4 — `seekVideo()` / `videoReady()`

frame-api.md documented images and fonts and said nothing about **video**,
yet footage in a composition is both common and the easiest thing in the
system to get catastrophically wrong. A `<video>` cannot be played — that
makes the picture a function of wall-clock time, and under parallel rendering
each worker captures a different moment — so a composition seeks one frame of
footage per output frame. Every composition doing that was hand-rolling the
same helper, and the version you write first is the one that hangs:

```js
await seekVideo(host, 2.0 + frame / 30, { fps: 30 });
```

`seekVideo` folds in the three guards the hand-rolled version omits:

- **It never awaits `seeked` on an unusable element.** A `<video>` whose src
  is missing or undecodable never fires the event, so `currentTime = t; await
  seeked` deadlocks the frame — and then every frame after it. Now it checks
  `duration > 0 && readyState >= 1` and bails, turning an unexplained render
  hang into a missing picture (with the failed request named, per below).
- **It clamps to `duration - 1/fps`**, so a scene longer than its footage does
  not stall or freeze at the tail.
- **It skips a seek already satisfied.**

Deliberately no internal timeout: a genuinely stuck seek must fail loudly as a
frame timeout rather than silently capture the wrong frame. `videoReady(video)`
awaits `loadeddata` for setup and resolves on `error` too, so a missing file
cannot deadlock there either. Both are also bare globals.

`docs/frame-api.md` gains **§11** on driving footage (codec, length, in-points,
and when a film overlay track is the cheaper answer), `video.play()` joins the
"never use" list in §1, and the pre-render checklist covers footage and
reading the whole timeout message. Scenes copy the runtime at creation, so new
scenes get v1.4; existing scenes keep the copy they were scaffolded with.

### Failed asset loads are named in the error

A `<video>` whose `src` does not exist never fires `seeked`, so the frame
promise never settles and the render dies on a frame timeout — naming
nothing. A failed request is neither a page error nor a console error, so the
existing diagnostics could not see it.

The page now also collects `requestfailed` and `HTTP >= 400` responses, and
every composition/timeout error renders them into the **message** (not just
`detail`, which a caller whose tool call timed out at the transport may never
see):

```
Frame 0 never became ready within 15000ms. Check that frameReady is set true
after all async work (fonts/images/video seeks) resolves.
1 asset failed to load — a missing <video>/<img>/<script> is the usual cause
of a frame that never becomes ready:
  assets/host-pip.webm (net::ERR_FILE_NOT_FOUND)
```

Paths are reported relative to the composition, so they read like the `src`
that produced them rather than a 200-character `file://` URL. Deduped and
capped at 10.

## v0.20 — Workspaces, films and scenes: the storage model matches the work

Motion Studio stored a flat list of "projects". Nobody was making projects.
They were making **films**, each cut from many **scenes**, and the gap between
those two facts had been papered over with conventions for four releases:

- A project was really a scene. Every long-form doc said so; the storage did
  not, so the relationship lived in prose and in whichever transcript made the
  last `build_film` call.
- A film needed a by-convention `"<name> — Master"` project to hold its master
  audio and receive the build — a film wearing a project's clothes,
  indistinguishable in the UI from a real scene, and rendererable by mistake.
- Every agent created scenes in the same shared folder, so a fresh film from
  one AI appeared amid another's work. Nothing scoped anything.
- Two shared registry files (`projects.json`, `films.json`) were a
  read-modify-write lost-update hazard whenever two writers were live.

v0.20 replaces all of it with a hierarchy that says what people actually
build, and makes the filesystem the registry:

```
<dataDir>/workspaces/<workspace>/     one per AI; the human sees them all
  library/                            shared assets the human provides
  films/<film>/
    film.json  assets/  out/          the film owns its audio and its output
    scenes/<scene>/                   a composition folder — the render unit
```

- **Ids are slug paths.** A film is `"<film>"`, a scene `"<film>/<scene>"`,
  workspace-local to whichever server is asking. Presence of `film.json` makes
  a film, `scene.json` makes a scene — there are no registries to fall out
  of sync and no UUIDs to resolve. Copying a film folder into another
  workspace *is* moving the film. Slug validation doubles as path safety.
- **`project.json` → `scene.json`, and `--project` → `--scene`.** The config
  file is named for the thing it configures. Nothing has shipped, so there is
  no compatibility argument for keeping the old name — the one place it is
  still *read* is the migration, which renames each folder's config as it
  moves it.
- **The word "project" is gone from the codebase.** Not just the storage model:
  the module `core/project.js` is now `core/scene.js`; the internal
  `projectPath` option is `scenePath` and `projectRoot` is `assetRoot` (or
  `targetRoot` in the sandbox); `resolveInProject` is `resolveInTarget`; the
  template placeholder `__PROJECT_NAME__` is `__SCENE_NAME__`. Three of these
  were user- or agent-visible and changed with them: the error code
  `path_outside_project` → **`path_not_allowed`** (it never only meant
  "project", and now it guards scenes, films and the library alike), the
  settings key `newProjectDefaults` → **`newSceneDefaults`**, and a job's
  `projectId` → **`targetId`** (a job targets a scene when rendering and a film
  when building — one field, two kinds of id, so neither old name was true).
  The sole survivor is `core/migrate.js`, which must still recognise the old
  world in order to convert it.
- **A workspace per agent.** Each MCP server binds one via
  `MOTION_STUDIO_WORKSPACE` (default `default`) and cannot name another's
  films; the Studio browses every workspace, because the human owns the
  machine. Give each connected AI its own name in its client config.
- **The film owns its assets and output.** `assets/` holds master audio and
  overlays, `out/` receives the build. The "— Master" project convention is
  gone rather than documented. Master narration, score and sfx beds are made
  by pointing the synth tools' `target` at the **film** instead of a scene.
- **Scene defaults.** A film records `sceneDefaults` at creation and every
  scene inherits them, so the rule that scenes must share resolution/fps/format
  to concatenate losslessly is now the default path instead of discipline —
  diverging takes a deliberate override, and `planFilm` still reports it.
- **A shared-asset library.** The 25 MB base64 cap kept large media out of the
  MCP channel and left "the user gave me a 500 MB plate" with no answer. Each
  workspace now has a `library/` the human fills through the Studio; agents
  read it with `list_shared_assets` and pull files in with `use_shared_asset`,
  which **hardlinks** where the filesystem allows — a huge asset costs no extra
  disk and the scene still renders hermetically from its own `assets/`.

**Tool surface.** `create_film` / `get_film` / `update_film` / `remove_film` /
`list_films`, `create_scene` / `get_scene` / `remove_scene` /
`update_scene_config`, `get_workspace`, `list_shared_assets` /
`use_shared_asset`. `build_film` now takes a film id and runs as an **async
job** like a render (`plan: true` still answers "where does each scene land?"
before anything is rendered). Asset and synth tools take a `target` that
accepts either a scene or a film. Gone: `create_project`, `get_project`,
`list_projects`, `update_project_config`, `remove_project`, `save_film`,
`build_saved_film`. New codes: `scene_not_found`, `scene_already_exists`,
`workspace_not_found`, `film_already_exists`, `invalid_id`, `migration_failed`.

**The Studio.** The rail is one tree — workspace → films → scenes — with a
library page per workspace and a scene workbench that is otherwise unchanged
(preview, config, audio, assets, outputs all behave exactly as before; only
the ids moved). The film editor's rail lists the film's own scenes instead of
a global project pool, and everything that pointed at the output project now
points at the film.

**Migration is automatic and non-destructive.** On first start, saved films
become film folders (scenes moved in, the old master project's `assets/` and
`out/` folded into the film), loose projects become single-scene films, and
`projects.json` / `films.json` move to `<dataDir>/legacy-v019/` beside a
`migration-report.json` mapping every old UUID to its new id. Nothing is
deleted; a crash mid-way resumes on the next start.

Nothing had shipped, so there are no compatibility aliases — the old names are
simply gone. See [architecture.md §11](architecture.md) for the full model.

### Also in v0.20: films become documents, not one-shot calls

> Shipped together with the storage model above. Where that entry describes
> *where* a film lives, this one describes *what a film is* — the document and
> the editor, both of which v0.20 then moved into the film's own folder.
>
> **Read it as history, not as the current contract.** It was written before
> the storage rework landed, so the names below are the pre-rework ones:
> `save_film` / `build_saved_film` are now `update_film` / `build_film`,
> `projectId` in a `sceneLayout` entry is now `scene` + `slug`, `FilmStore` is
> now the film's own `film.json`, and the "output project" it refers to no
> longer exists. The section above is authoritative wherever the two differ.

Long-form work always had the right *engine* shape — one project per scene,
`build_film` to stitch — and the wrong *authoring* shape for a human: the film
itself existed only as the argument list of the last `build_film` call. Change
one gain and the whole definition lived in whoever's head (or transcript)
made that call. This release makes the film a **persistent document** and
gives it a **visual editor**.

- **Saved films (`core/films.js`).** A film — ordered scene list, master
  audio timeline, caption track, overlay track, mastering options — persists
  in `films.json` beside the project registry (`FilmStore`). Every save
  validates (`invalid_film` carries the full problem list); `planFilm`
  resolves a film against reality *without throwing* — per-scene rendered
  state, signature mismatches, missing assets — because an editor must open
  broken documents to let you fix them. Films build through the existing
  `JobManager`, so progress/logs/cancel work exactly like renders.
- **The Studio film editor** (`/film.html?id=…`; the rail gained a
  **films tab** beside projects — one list at a time instead of two stacked
  sections). A timeline NLE over the document: a projects panel on the left
  to **drag projects onto the timeline** as scenes (insert marker shows the
  drop position; the row's + appends), a scene track (drag to reorder,
  per-scene render buttons, mismatch/unrendered flags), auto-packing audio
  lanes with decoded waveforms (drag to move, edge-drag to trim, fades and
  sidechain duck per track), caption and overlay lanes with edge-resizable
  blocks, a context inspector, zoom/snap, undo/redo, autosave. The **build
  panel docks into the same right-side column** (not a modal), so the
  timeline stays visible and editable while a build runs — the header button
  carries the live percent. The preview plays the
  scenes' **real rendered outputs** back to back (double-buffered `<video>`,
  byte-range serving added for seeking) with overlays and captions drawn
  geometrically as the finishing pass will burn them — and master audio
  auditions through **the build's exact ffmpeg mix graph** (new
  `POST /api/films/:id/preview-audio` runs `mixAudioOnly`), because a
  WebAudio approximation would lie about ducking and the limiter.
- **Overlays and captions (finishing pass).** A film can composite image or
  video overlays (percent-of-frame geometry, opacity; transparent `.webm`
  keeps alpha via the libvpx decoder) and burn captions (generated `.ass`,
  resolution-relative styling) in **one** finishing encode after the lossless
  concat — a single extra generation, only when the film actually uses these
  tracks, with real frame progress (`-progress` parsing in
  `encoder.runFfmpeg`). Captions always also write a `.srt` **sidecar**,
  burned or not. Video asset extensions (`.mp4/.webm/.mov`) joined the asset
  sandbox allow-list for overlay sources.
- **Narration inside the editor.** `POST /api/projects/:id/tts` synthesizes
  through the configured vendor chain straight into `assets/` and returns
  measured duration/levels — and with `sentenceTimings` the editor's
  "+ narration" turns one take into a placed audio track **plus a synced
  caption block per sentence**, with music beds optionally marked
  `duck: true` in the same action.
- **MCP parity: `save_film` / `list_films` / `remove_film` /
  `build_saved_film`.** Agents edit the same documents the human sees in the
  editor. `build_saved_film` submits the assembly as an **async job**
  (poll with `get_render_status` / `wait_for_render`) because a finishing
  encode on a long film can outlive an MCP request timeout — the same
  reasoning that capped `wait_for_render`.
- New error codes: `film_not_found`, `invalid_film`. New Studio API:
  `GET/POST /api/films`, `GET/PATCH/DELETE /api/films/:id`,
  `POST /api/films/:id/build`, `POST /api/films/:id/preview-audio`,
  `POST /api/projects/:id/tts`; media endpoints honour HTTP `Range`.

### Film assembly: the mix you audition is the mix you ship, and offsets come back

Four fixes found by building a real nine-scene film end-to-end over MCP.

- **`build_film` master audio takes the full track shape.** `trimEndInFrames`,
  `fadeInFrames`, `fadeOutFrames` and `duck` always worked in the mixer —
  `film.js` hands tracks straight to `encoder.muxAudio`/`buildAudioFilter` —
  but the MCP schema listed only `src`/`startInFrames`/`gainDb` and the
  handler rebuilt each track from those three fields. So a mix tuned and
  measured with `preview_audio` (ducked bed, fades) could not be reproduced by
  the film, and the caller had to guess a compensating gain. Both the schema
  and the pass-through now carry every field.
- **`sceneLayout` is returned.** Every doc and the `synthesize_sfx` description
  referred to a scene's `filmOffset` — "a chime on every scene cut is a plain
  map over your scene offsets" — but nothing ever returned it: `assembleFilm`
  computed the cumulative offsets internally and reported only a scene *count*.
  `build_film` now returns `sceneLayout: [{ projectId, name, filmOffset,
  durationInFrames, startSeconds }]`, and **`plan: true`** returns that layout
  (validating scene consistency, skipping the rendered-output requirement)
  without assembling anything — offsets are needed *before* the render, to
  place narration and cues.
- **`wait_for_render` no longer advertises timeouts the transport cannot
  survive.** The cap was 600 s with a 300 s default, but a wait longer than the
  MCP client's ~60 s request timeout returns a transport error instead of the
  documented `timedOut: true` snapshot — so the default itself was unusable.
  Now capped at 50 s, default 30 s, with the call-again pattern and the
  in-memory lifetime of job ids spelled out.
- **`canvas-save-restore` lint.** A named function calling `ctx.save()` more
  often than `ctx.restore()` leaves the transform/clip/style stack mutated for
  every later draw call in the frame — in the real film it silently relocated
  the title, letterbox and vignette and broke an entire scene, while remaining
  perfectly valid JavaScript that still rendered. Same class as
  `classlist-mutation`: state that outlives the drawing it belonged to.

The rule is scoped per function *body* — declarations, function expressions
and arrow functions alike, since `.forEach((p) => { ctx.save(); … })` is as
common a drawing helper as a named one — and only the innermost unbalanced
scope is reported, so a nested offender does not also indict every function
enclosing it.

Docs corrected alongside. SKILL.md now states the canvas save/restore rule,
lists all three structural lint rules (`classlist-mutation`, `sequence-gap`,
`canvas-save-restore`) among the warnings to treat as bugs, drops the advice to
"assemble, then do one final encode" (the concat is `-c copy` and no MCP tool
re-encodes — the scenes' own crf is what ships), and warns that job ids die
with the server. The `write_composition_file` tool description names the canvas
check.
`film-setup.md` documents the widened master-timeline shape and points
"Placing multi-clip narration" at `plan: true` for its `filmOffset`s instead of
hand arithmetic; `sfx-setup.md`'s "chime on every scene cut" example now maps
over a real `sceneLayout` rather than a `plan` object that never existed.

### Scene-structure guardrails: the "every scene visible at once" failure is now machine-caught

A real 161-second film shipped with all nine scenes stacked on screen for its
entire length — visibility managed by `classList.add` inside each `Sequence`
plus a reset loop selecting that runtime-added class, so nothing was ever
hidden until its own scene had already played. Every existing check passed.
Three new advisories close the holes that let it through:

- **`classlist-mutation` lint** (`write_composition_file`): `classList.add`/
  `remove` in composition code accumulates DOM state across frames and never
  exists for a worker starting mid-film; `classList.toggle(name, bool)` is
  exempt (absolute per-frame state).
- **`sequence-gap` lint**: literal `Sequence(start, duration)` calls are
  statically checked against the project duration — coverage holes and
  uncovered tails are named with frame ranges (the real case had a 298-frame
  hole from a retimed duration). Dynamic arguments and single sequences are
  left alone.
- **`structureWarnings`** from `create_project` / `update_project_config`
  when the duration exceeds ~90 seconds: long videos belong in one project
  per scene stitched with `build_film`, and the advisory fires at the moment
  restructuring is still free.

`docs/frame-api.md` (and the MCP resource) gains the scene-visibility recipe
(§3) and two checklist items; SKILL.md states the recipe and tells agents to
treat `structureWarnings` as a stop-and-restructure signal. All advisory,
never write/render rejections — same contract as the determinism lint.

### SKILL.md: the guidance that was present but never fired

An agent session made three videos with the skill loaded and reproduced, in
new forms, most of the failures the skill already warns about. The guidance
was not missing — it was *unreachable*: written as reference prose in topic
sections, while the agent worked from the numbered Workflow and never came
back. The revision moves the load-bearing rules to where a working agent is
actually looking.

- **Audio gets a workflow step.** The workflow was picture-only (author →
  check → render); narration, music and sfx lived in three topic sections
  that read as optional extras, and `preview_audio` was skipped in all three
  videos. New step 3 "wire the audio, then audition it" makes the order
  explicit — narration length *determines* scene length — states the
  arithmetic that must agree (scene duration vs speech tracks vs bed
  coverage), and makes `preview_audio` unconditional. The 90-second promo
  had a 44-second bed and 17 seconds of dead tail; `mix.silentTailSeconds`
  reports exactly that, in seconds, and was never called.
- **`list_vendors` becomes a step-1 precondition, not advice.**
  `favoriteVoices`/`favoritePrograms` shipped in v0.20 and were documented in
  the narration and music sections — and never read, because nothing in the
  workflow said to look before synthesizing. Step 1 now calls it once per
  film, and both sections state a numbered precedence (request → starred →
  vendor default) instead of "check first".
- **Preview acceptance criteria.** "Look at the returned images" verified
  that the code ran, not that the picture was right: a product promo shipped
  with the product at `opacity: 0` in every captured frame. Step 4 now lists
  what to check — is the subject on screen, is anything on screen that
  shouldn't be, do the values read correctly, did the frames change, are the
  claims the user's rather than invented.
- **The visibility rule is stated in both directions.** §3 covered turning a
  section *on*; nothing covered an element left visible in CSS that no
  `Sequence` owns, which is on screen for the whole video and looks
  deliberate in any single frame. `frame-api.md` §3 gains the ownership test
  ("name the `Sequence` that turns this on") and the symmetry note, plus two
  checklist items.
- **"A clean lint is not a passing grade."** New paragraph naming what the
  scanner structurally cannot see: a composition with *no* `Sequence` calls
  (nothing for `sequence-gap` to compare), elements never turned on or off,
  canvas state like `shadowBlur`/`globalAlpha` set once and never reset
  (save/restore stays balanced), and values that are simply wrong.
- **External assets are called out.** A hotlinked CDN `<script src>` previews
  fine and is a coin-flip across parallel workers; no lint rule covers URLs.
  Vendor into `assets/`.
- **Numbers instead of gestures.** `wait_for_render` documented its cap as
  "deliberately under the MCP client's request timeout"; the actual limits
  (`timeoutMs` max 50000, default 30000, up to 16 job ids) are now stated, so
  the first call isn't a validation error.
- **No fabricated claims.** Promotional copy takes its statistics from the
  user's own assets or makes none — the session invented accuracy figures and
  user counts for a medical device.

Opens with a five-item summary of the failures that produce a broken
deliverable while every automated check passes. Docs only; no behaviour
change.

### Favorite voices, vendor tabs, and an inline settings page

Three Studio UI changes in one pass:

- **Favorite voices** — the speech twin of favorite instruments. A **☆** next
  to every vendor's voice picker stars the selected voice; starred voices
  render as chips at the top of the tts page and save as `tts.favoriteVoices`
  (vendor → distinct voice names, validated against the vendor list, `null`
  when unused). They flow through the speech vendor report to `list_vendors`,
  and the `synthesize_speech`/`list_vendors` descriptions (plus SKILL.md)
  tell agents to prefer a starred voice when the request doesn't name one.
- **Vendor tabs** — six speech cards had made the tts page a long scroll.
  Both vendor pages now show one card at a time behind a tab strip (same tab
  grammar as the workbench panel); the strip opens on the vendor that would
  actually run, and enable/priority controls stay on each card.
- **Global settings is a stage page, not a popup** — ⚙ settings now opens an
  inline page styled like the vendor pages (replaces the project view while
  open; close restores it), instead of a modal dialog. Same fields, same
  save; the `#settings-dialog` modal is gone.

### Favorite instruments: auditioning now steers what agents compose

The Studio's audition-instrument picker was for your ears only — an agent
composing via `synthesize_music` never knew what you liked and defaulted to
piano and strings. A **☆ favorite** button next to the picker now stars
General MIDI programs; they render as removable chips, save with the music
settings (`music.favoritePrograms`, validated 0..127, no duplicates, `null`
when unused), and flow through the music vendor report to `list_vendors`.
The `synthesize_music` and `list_vendors` tool descriptions (and SKILL.md)
tell agents to prefer starred programs when the brief doesn't name
instruments — an explicit instrument in the request still wins.

### Encoding-compatibility warnings: mp4 crf 0 no longer fails silently at playback

`crf: 0` on mp4 reads as "maximum quality" but means **lossless** to libx264,
and the H.264 spec puts lossless bitstreams in the High 4:4:4 Predictive
profile — which most consumer decoders (Windows Movies & TV, phones, TVs,
browsers) cannot play. The result is black video with working audio on a
render that passed every check (real case: 900 verified frames, healthy
size, correct audio — and nothing visible in the player).

`encodingCompatibilityWarnings()` (core/formats.js — the registry that
already owns all codec decisions) flags the combination at render start, in
both the serial and parallel paths (workers stay quiet; the parent warns
once). Surfaced as `[warn]` job-log lines, `encodingWarnings` on the render
result and `get_render_status`, and a "do not set crf 0" note in the MCP
render tool description. Never fatal — crf 0 stays legal for an intentional
lossless master; the warning names `prores`/`png-sequence` as the formats
actually meant for that.

### Audio balance warnings: a buried track is now reported, not just audible

A track sitting far below a louder overlapping track was the one mix failure
nothing reported: the render succeeds, nothing clips (the mix only got
*quieter*), and every check passes — but a layer is missing to the ear. Seen
in practice when track gains are assigned as a template ("lead −2, layers
−6/−10") against source files whose own levels already differ by more than
the template assumes.

`computeBalanceWarnings()` (core/encoder.js, pure and unit-tested) compares
each track's effective mean level (`clipMeanDb + gainDb`) against louder
tracks overlapping at least half of its play window, and warns at a ≥8 dB gap
(the motivating case had a layer 9.3 dB down that the user reported as
inaudible). Tracks marked `duck: true` are declared background and never warn
as the quiet side. Surfaced in both places an agent looks:

- **`preview_audio`** now returns `balanceWarnings` (plus each clip's
  `clipDurationSec` for WAVs) alongside the existing per-clip levels.
- **The render report** (`audio.balanceWarnings` on the `done` status, and
  `[warn]` lines in the job log) runs the same check by measuring each source
  clip — so the warning reaches even a caller that skipped the preview.

Never fatal: unmeasurable clips are skipped and a measurement failure cannot
fail an otherwise good render, same contract as the existing clipping check.

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
