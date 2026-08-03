# AI-only desktop runtime and vendor boundary plan

Status: proposed — revised 2026-08-03 after a line-by-line code review; the
factual claims in §2 were verified against the tree and the amendments below
were folded in (Slice 0 footprint work, injection-seam decision, lazy vendor
registry, import-graph test, re-estimated Slice A).

Scope: package Motion Studio as an AI-operated desktop runtime, keep vendor
defaults and vendor implementations outside the cross-platform core, and do
not ship the human Studio web UI as part of the desktop product.

Estimated effort: 12–19 engineer-days for a Windows-first implementation
(Slice 0 footprint work plus a re-estimated Slice A; see §8). Cross-platform
vendor packs, signed installers, and update support are additional work
described below.

## 1. Decision

The desktop product should not launch npm run studio. The Studio server is the
human-facing web application. The AI-facing entrypoint is the existing local
stdio MCP server:

    engine/src/mcp/server.js

The desktop layer should be a thin lifecycle and packaging host around a real
Node sidecar:

    AI client
      -> MCP over stdio
      -> real Node Motion Studio sidecar
      -> cross-platform render core
      -> optional default-vendor package and platform assets
      -> user data and workspaces

The desktop app may have a tray or diagnostic surface later, but it must not
depend on a browser-based human authoring workflow. The existing Studio source
should remain available for development and compatibility during the first
implementation; it is simply excluded from the shipped AI-only product.

## 2. Current baseline and why this is not only a folder move

The repository already stores runtime artifacts under vendor, but core
still owns the vendor boundary:

- core/tts.js resolves the bundled Windows speech executable.
- core/music.js resolves the bundled MIDI executable, FluidSynth, and SoundFont.
- core/transcribe-whisper.js resolves bundled Whisper models.
- core/tts-vendors.js, core/music-vendors.js, and
  core/transcribe-vendors.js import and dispatch the provider implementations.
- core/settings.js imports vendor-specific constants and hardcodes vendor lists
  and defaults.
- core/transcribe.js imports the transcription vendor dispatcher.
- core/tts.js also contains generic WAV parsing, concatenation, duration, and
  level utilities used by the renderer and transcription code.
- the Studio and MCP entrypoints import vendor modules directly.
- engine/package.json currently puts spessasynth_core, MCP SDK, Zod, and
  Puppeteer in one package.
- core/music-node.js already lazy-imports spessasynth_core and maps a failed
  import to a structured music_unavailable error — the exact pattern the rest
  of the vendor boundary should copy. Because of it, music is already almost
  core-clean; speech and transcription are the actual extraction work.
- core/renderer.js renderParallel already accepts a `nodeExecutable` option
  (defaulting to process.execPath); the desktop host must pass the bundled
  Node path through it explicitly.

The current test suite contains 834 tests. The existing working tree also has
an unrelated modified setup file; implementation work must preserve it and
inspect the baseline diff before attributing changes.

The local vendor tree is approximately 2.62 GB. Most of that is not a
runtime core requirement: roughly 1.79 GB is Piper voices and roughly 603 MB
is a download/cache tree. The desktop installer must not blindly package the
whole directory.

Measured download footprint beyond the vendor tree (2026-08-03): the Puppeteer
pin fetches BOTH full Chrome (~420 MB) and chrome-headless-shell (~272 MB) per
pinned version, while core/browser.js only ever launches headless; engine
node_modules is ~68 MB; the sibling FFmpeg full build is ~707 MB (a static
essentials build is ~80–120 MB per OS) and encoder.js/prereqs.js default to a
bare "ffmpeg" on PATH; each Whisper ggml-small model is ~488 MB; the
MuseScore_General.sf3 SoundFont is ~39 MB and is not committed, so the default
"node" music vendor cannot synthesize on a clean clone. Today a clean clone
plus npm install is ~1.4 GB and still cannot render a video (no FFmpeg). The
default speech vendor "system" resolves to the ~95 MB Windows-only
MotionStudioTts.exe, which is also not committed, so speech is broken out of
the box on every platform. Phases 1–5 fix dependency direction, not weight —
Phase 0.5 below is where the weight is addressed.

The renderer starts parallel workers using Node's executable path. The desktop
host must therefore spawn a real Node runtime for the sidecar and worker
processes. Running the server inside Electron's main process would risk making
worker launches use Electron rather than node.

## 3. Goals

1. Keep render, store, scene, film, audio-mix, and transcript-derivation
   algorithms cross-platform and free of default vendor imports.
2. Move default provider implementations into an optional vendor package.
3. Move vendor binaries, models, voices, SoundFonts, and platform defaults into
   separately managed vendor packs.
4. Keep the AI MCP surface stable: workspace, film, scene, asset, audio,
   transcription, render, build, inspection, and production-status tools must
   continue to work.
5. Preserve existing settings and environment-variable precedence.
6. Allow video rendering without any speech, music, or transcription vendor
   installed.
7. Make an AI-only desktop install able to start, initialize MCP, render a
   deterministic smoke film, and report vendor availability without a human
   opening the Studio.
8. Keep credentials environment-only or in a future secure OS credential
   provider; never put secrets in settings.json or MCP logs.
9. Keep the vanilla download lightweight: headless Chromium only, a
   first-class FFmpeg/ffprobe resolution chain, zero-byte OS speech, and the
   small SoundFont; everything heavier is an optional pack.
10. Give every capability a tier (core render / free local / optional pack /
    bring-your-own-key) and report that tier from doctor and
    get_capabilities with exact per-OS fix instructions.

## 4. Non-goals

- No human Studio UI in the first desktop distribution.
- No deletion of the existing Studio server or its tests in this phase.
- No arbitrary shell tool exposed through MCP.
- No redesign of the film, scene, asset, render, or advice data model.
- No silent vendor substitution when an explicitly named vendor is unavailable.
- No requirement to package every Piper voice, every downloaded model, or every
  optional 3D asset.
- No automatic cloud-account provisioning or API-key collection UI.

## 5. Target source layout

Use a low-churn source split first; a larger npm workspace split can follow if
the package needs to be published independently.

    engine/src/core/
      audio.js                 generic WAV and level utilities
      vendors.js               generic selection and report contracts
      transcribe.js            extraction, cache, derivation, frame conversion
      renderer.js              deterministic browser/FFmpeg rendering
      settings.js              vendor-neutral persistence and path settings

    engine/src/vendors/default/
      registry.js              default catalog and runtime composition
      settings.js              default vendor schemas and defaults
      speech/
        system.js
        azure.js
        piper.js
        elevenlabs.js
        openai.js
        deepgram.js
      music/
        node.js
        fluidsynth.js
      transcription/
        whisper-cpp.js
      paths.js                 vendor-root and platform asset resolution

    engine/src/mcp/
      server.js                AI-facing stdio entrypoint

    desktop/
      launcher/                 thin app/sidecar lifecycle code
      resources/vendors/        selected platform vendor packs

The exact package names may change during implementation, but the dependency
direction must remain:

    core <- MCP adapter
    core <- default-vendor adapter
    default-vendor adapter -> optional binaries, models, and npm packages

Core must not import the default-vendor registry. The MCP entrypoint and any
legacy Studio adapter choose and inject the runtime.

## 6. Work phases

### Phase 0 — Baseline and contract freeze

Estimate: 0.5–1 day.

Tasks:

- Record the current git status and unrelated diff.
- Run npm run doctor and npm test from engine.
- Record the current 834-test baseline and the existing MCP smoke path.
- Capture representative settings.json files and a minimal film/scene fixture.
- Write the provider contract before moving implementations.
- Decide which vendor pack is the Windows default for new installs.
- Decide whether the desktop shell is a tray process or a fully hidden
  background process. Neither choice should add a human Studio UI.
- Decide the runtime injection mechanism (§10 decision 6) before any code
  moves: it is the highest-churn choice in the plan, it is expensive to
  reverse, and Phase 1's estimate assumes it is already settled.
- Stand up macOS and Linux CI running the existing suite, so the
  cross-platform claim is tested from the first commit rather than asserted.

Output:

- A small baseline fixture set.
- A documented provider contract.
- A list of compatibility expectations for existing settings and environment
  variables.

### Phase 0.5 — Runtime footprint and vanilla preflight (Slice 0)

Estimate: 2–3 days. Mostly independent of the refactor; do it first because it
is what a new install actually feels, and it produces the probe/report
contracts Phase 1 formalizes.

Tasks:

- Configure Puppeteer to install only chrome-headless-shell — core/browser.js
  always launches headless:true and nothing else in engine/src launches
  headful — saving ~420 MB per install. Longer term, move to puppeteer-core
  and treat the pinned browser as a normal vendor pack, i.e. apply this
  plan's own pack model to the exception §3 (Phase 3) carves out for it.
- Expose browser.js's existing executablePath option as MOTION_STUDIO_CHROME
  plus a setting, with PUPPETEER_SKIP_DOWNLOAD for machines that already have
  Chrome or Edge. Trade-off to record: a system browser sacrifices pinned
  deterministic rendering (fonts, GPU/SwiftShader, emoji differ across
  machines), so the pinned pack stays the default and the actual browser
  build is written into render metadata.
- Give FFmpeg/ffprobe a first-class resolution chain: explicit argument →
  MOTION_STUDIO_FFMPEG → packaged pack → PATH, replacing the bare "ffmpeg"
  default in encoder.js/prereqs.js. Ship a static essentials build as a
  fetched pack (~80–120 MB per OS), never the 707 MB full build.
- Make the "system" speech vendor cross-platform at zero bytes: keep the
  vendor id and give it per-platform backends — bundled MotionStudioTts.exe
  when present (Windows back-compat) → PowerShell System.Speech (Windows) →
  say (macOS) → espeak-ng/spd-say (Linux). Every existing settings.json stays
  valid, the default finally works on all three OSes, nothing is downloaded,
  and the vendor is already flagged non-deterministic so quality expectations
  are set. Good voices stay an optional pack or a cloud key.
- Ship or auto-fetch a small permissively-licensed GM SoundFont so the
  default "node" music vendor works on a clean clone with zero setup;
  MuseScore_General.sf3 becomes the optional higher-quality pack.
- Whisper is NOT part of the vanilla install: transcription only matters when
  a film uses supplied speech, and one ggml-small model outweighs everything
  else in vanilla combined. Make it the flagship optional pack (ggml-base
  ~142 MB as the recommended fetch, small for multilingual).
- npm run doctor and get_capabilities report every capability by tier with
  exact per-OS fix instructions.

Target vanilla tiers:

| Tier | Contents | Adds | Capability |
|---|---|---:|---|
| 0 Core | Node ≥18, engine, headless shell, FFmpeg essentials | ~350 MB | deterministic render, supplied media, audio mix, film assembly, 3D |
| 1 Free local | node music + small SoundFont, SFX, OS speech | ~10–40 MB | score, effects, scratch narration; no downloads, no keys |
| 2 Optional packs | whisper+model, piper+voices, fluidsynth, MotionStudioTts.exe, MuseScore SoundFont | on demand | transcription, high-quality local voices |
| 3 Bring-your-own | Azure / ElevenLabs / OpenAI / Deepgram keys; external agent tooling per AGENTS.md | 0 | cloud voices and whatever the operating agent already has |

Tier 0+1 is the product: agents arrive with their own generation stack, and
Motion Studio's unique value is the deterministic frame renderer and the
film/scene/advice model, not bundled voices. Everything above tier 1 is a
probe, a report, and a setup hint.

### Phase 1 — Extract the cross-platform core contracts

Estimate: 3–4 days. The hardest part is not the file moves but settings
validation — see the note at the end of this phase's task list.

Tasks:

- Split generic WAV and audio helpers out of core/tts.js into core/audio.js:
  RIFF parsing, duration, frame conversion, sentence splitting, PCM-to-WAV,
  concatenation, levels, and envelopes.
- Keep temporary compatibility re-exports where practical so renderer,
  SFX, music tests, and existing consumers do not change in one large step.
- Define one generic provider contract per capability:
  speech, music, and transcription.
- Standardize probe, synthesis, error, warning, and source metadata shapes.
- Make core vendor selection operate on an injected catalog rather than
  hardcoded provider modules.
- Change transcribe.js to receive a transcription provider/runtime while keeping
  sentence re-segmentation, confidence derivation, cache keys, and frame
  conversion in core.
- Remove core imports of provider-specific format constants and setup hints.
- Keep the existing error taxonomy and structured details unchanged.

Notes:

- The catalog work is a settings-validation redesign, not a move. settings.js
  validates vendor-specific option shapes inline today (the Azure and
  ElevenLabs WAV-format enums are imported at the top of the file).
  Catalog-driven validation must accept schemas from the injected registry,
  and must handle a settings.json that names a vendor whose pack is not
  installed without destroying that setting — the forward-compatibility
  concern already noted in core/vendors.js.
- Music already meets this phase's acceptance: music-node.js lazy-imports
  spessasynth_core and maps failure to music_unavailable. Speech and
  transcription are the actual work; copy that pattern.
- The runtime injection seam (§10 decision 6) must already be decided; do not
  discover it here. Threading the runtime through the MCP entrypoint (~15
  vendor symbols imported today) and the Studio entrypoint (which reaches as
  deep as maskKey from tts-azure.js and PIPER_ENV from tts-piper.js) is where
  the real churn in this slice lives.

Acceptance for this phase:

- Core modules can be imported without loading spessasynth_core or any native
  vendor adapter.
- A core-only render can run without the default vendor directory.
- The existing MCP behavior remains available through an injected default
  runtime.

### Phase 2 — Create the default-vendor package

Estimate: 3–4 days.

Tasks:

- Move the system, Azure, Piper, ElevenLabs, OpenAI, and Deepgram speech
  implementations out of core.
- Move the Node synthesizer and FluidSynth chain out of core.
- Move the Whisper executable/model adapter out of core.
- Move vendor-specific lists, setup hints, option validation, default values,
  and report descriptions into the default-vendor package.
- Keep generic level parity and WAV contracts in core.
- Move spessasynth_core to the default music package dependency.
- Add a default-vendor registry that exposes:
  catalog, settings schema, provider factories, probes, synthesis methods,
  transcription methods, and vendor asset provenance.
- Add a vendor-root setting/environment variable, for example
  MOTION_STUDIO_VENDOR_ROOT, without removing existing per-vendor variables.
- Resolve paths in this order:
  explicit call argument, existing vendor-specific environment variable,
  MOTION_STUDIO_VENDOR_ROOT, packaged vendor manifest, then PATH where the
  provider explicitly supports PATH resolution.
- Keep external binaries and models out of the core package.

Compatibility requirements:

- Preserve tts.vendor, tts.vendors, music.vendor, music.vendors,
  transcription.vendor, and transcription.vendors.
- Preserve existing environment variables such as
  MOTION_STUDIO_TTS_EXE, MOTION_STUDIO_SOUNDFONT,
  MOTION_STUDIO_WHISPER_BIN, and the cloud credential variables.
- Existing explicit vendor choices must never be redirected.
- Existing settings using the Windows system vendor remain valid on Windows.
  A non-Windows installation reports a structured unavailable result instead of
  silently changing an existing film's narrator.
- New-install defaults may be platform-specific, but that policy must live in
  the vendor manifest rather than core.

### Phase 3 — Separate package dependencies and vendor assets

Estimate: 1–2 days.

Tasks:

- Make the default-vendor package own spessasynth_core.
- Move MCP SDK and Zod to the MCP application/package if the core artifact is
  published independently.
- Keep Puppeteer with render-core because browser capture is a core render
  prerequisite, although it remains a substantial cross-platform dependency.
- Add a versioned vendor manifest containing:
  vendor id, package version, platform, executable/model relative paths,
  optional assets, license metadata, and SHA-256 hashes.
- Define the pack bootstrap mechanism the manifest depends on: download,
  SHA-256 verification, resume/retry, offline behavior (a missing pack is a
  structured unavailable result, never a hang or a stack trace), and where
  fetched packs live under the vendor root. Without this the manifest is
  metadata with no consumer, and the whole optional-pack model rests on it.
- Extend or complement vendor.lock.json for runtime provider assets without
  conflating them with the committed 3D library assets.
- Exclude vendor/download caches from all distributions.
- Define minimal packs:
  - Windows: selected speech provider, SoundFont, Node music provider, and
    Whisper assets needed for the default AI workflow.
  - Other platforms: only providers with validated binaries/runtime behavior;
    Windows system speech and the current FluidSynth executable chain remain
    optional platform providers.
- Make large models and Piper voices optional packs with explicit installation
  and availability reporting.

### Phase 4 — Rewire the AI MCP runtime

Estimate: 1–2 days.

Tasks:

- Change engine/src/mcp/server.js to construct the default vendor runtime at
  startup and inject it into audio and transcription operations.
- The default-vendor registry import in server.js MUST be dynamic and
  failure-tolerant: a static import makes a core-only install (acceptance
  test 1) die with ERR_MODULE_NOT_FOUND before initialize ever runs. Convert
  a missing registry into the structured-unavailable path, copying the
  music-node.js lazy-import pattern.
- Keep stdout exclusively for MCP protocol data. Send diagnostics to stderr and
  app log files.
- Extend get_capabilities and list_vendors output to report:
  active vendor, source, vendor-root, pack version, platform, availability,
  missing assets, and actionable setup information.
- Preserve current MCP schemas and result fields, including vendor,
  vendorSource, vendorChain, warnings, and unavailable error codes.
- Add a headless doctor/preflight path that can validate core, vendor manifest,
  binaries, models, SoundFont, FFmpeg, and writable data directories.
- Ensure a missing vendor package does not prevent non-audio MCP operations or
  ordinary video rendering.
- Keep workspace isolation through MOTION_STUDIO_WORKSPACE.
- Keep MOTION_STUDIO_HOME, MOTION_STUDIO_WORKSPACES, and
  MOTION_STUDIO_SETTINGS compatible with the existing path resolution rules.

The Studio server should be updated only as a compatibility consumer of the
same injected runtime. It is not part of the AI-only desktop launch path.

### Phase 5 — Add the AI-only desktop host

Estimate: 2–4 days for Windows-first packaging.

Tasks:

- Add a thin desktop launcher, preferably Electron only for process lifecycle,
  installation, tray/diagnostic behavior, and resource discovery.
- Spawn a real bundled Node executable for the MCP sidecar.
- Do not load the Studio web server or open a human authoring window.
- Set sidecar environment explicitly:
  vendor root, writable data root, workspace name, FFmpeg path, agent name,
  and optional local provider paths.
- Store mutable data under the platform user-data directory, not beside a
  read-only installed executable.
- Migrate or discover existing data, settings.json, paths.json, workspaces,
  films, and scenes without rewriting film documents.
- Handle startup, sidecar exit, cancellation, update shutdown, and descendant
  Chromium/FFmpeg cleanup.
- Keep MCP protocol transport separate from desktop diagnostics.
- Provide a packaged command/configuration path for external MCP clients as
  well as the desktop-owned sidecar path.

The first desktop smoke test should use a real Node sidecar, not Electron's
process executable, because renderParallel launches worker processes from the
configured Node executable — its existing `nodeExecutable` option, which
defaults to process.execPath. The desktop host must pass the bundled Node
path through that option explicitly rather than relying on the default.

### Phase 6 — Verification and documentation

Estimate: 2–3 days.

Tests:

- Static import-graph test: no module under core/ imports from
  vendors/default/, statically or dynamically. Note: a package.json
  dependency check ("core dependencies contain no spessasynth_core or
  MCP-only packages") is only meaningful after the optional npm-workspace
  split of §10 decision 4 — under §5's low-churn single-package layout there
  is one package.json and that check can never pass. State it as the
  import-graph test until the split happens; do not weaken it silently.
- CI runs the suite on Windows, macOS, and Linux.
- Unit tests for provider catalog injection, selection precedence, vendor-root
  resolution, missing-pack behavior, manifest hashes, and settings migration.
- Move existing provider tests and fake providers to the default-vendor test
  area without reducing coverage.
- MCP integration test: initialize over stdio, call get_capabilities,
  list_vendors, create a film, create a scene, render, inspect, and measure.
- Core-only test with no vendor pack: render succeeds; audio calls return
  structured unavailable results.
- Default-pack test: speech, music, and transcription complete and identify
  the selected vendor and pack source.
- Existing settings regression test: old settings and explicit environment
  overrides produce the same effective vendors and error codes.
- Desktop smoke test: start packaged app, initialize MCP, render a deterministic
  short scene, verify output, terminate cleanly, and confirm no orphaned
  processes.
- Run npm run doctor, npm test, package-install tests, git diff --check, and
  exact output/manifest checks.

Documentation:

- README.md: AI-only desktop install and MCP connection path.
- docs/architecture.md: new core/vendor dependency direction and package
  boundaries.
- docs/mcp-setup.md: desktop sidecar, stdio behavior, vendor-root configuration,
  data-root behavior, and no-human-UI workflow.
- docs/tts-setup.md, docs/music-setup.md, and docs/transcribe-setup.md:
  vendor-pack installation, platform availability, optional models, and
  environment precedence.
- docs/SKILL.md: clarify that the shipped AI-only runtime does not require the
  human Studio; retain production verification and adviser APIs where they
  remain part of the MCP contract.
- docs/CHANGELOG.md: record the package boundary, migration behavior, and
  distribution changes.
- Remove or correct obsolete wording that says all default providers live in
  core or that the desktop app launches npm run studio.

## 7. AI-only acceptance test

The implementation is complete only when all of these pass:

1. A clean core installation without the default vendor pack starts the MCP
   sidecar and completes initialize, get_capabilities, workspace operations,
   scene authoring, deterministic render, inspect, and measure.
2. The desktop package starts the same sidecar using a real Node runtime,
   communicates over stdio, and writes no diagnostic text to MCP stdout.
3. With the selected default vendor pack installed, list_vendors reports the
   pack source and all expected local capabilities.
4. synthesize_speech, synthesize_music, and transcribe_asset complete through
   the pack and report the actual vendor used.
5. Removing one optional vendor asset leaves unrelated video and MCP
   operations functional and returns a precise unavailable error for only the
   affected capability.
6. Existing settings, films, scenes, explicit vendor arguments, and
   MOTION_STUDIO_* overrides continue to work.
7. No human Studio page, browser authoring surface, or manual settings page is
   needed for the AI workflow.
8. The desktop package excludes the vendor download cache and does not include
   every optional voice/model by accident.
9. Sidecar shutdown leaves no MCP, Chromium, FFmpeg, or render-worker process.
10. The full test suite remains green and documentation contains no contradictory
    default-path or launch instructions.
11. A vanilla install fetches only the headless Chromium build and no Whisper
    model, and doctor/get_capabilities report each capability's tier with
    per-OS fix instructions.

## 8. Estimates and delivery slices

Recommended delivery slices:

| Slice | Scope | Estimate |
|---|---|---:|
| 0 | Runtime footprint and vanilla preflight (Phase 0.5) | 2–3 days |
| A | Core contract extraction plus default-vendor registry | 6–8 days |
| B | Package/asset split plus MCP rewiring | 2–4 days |
| C | AI-only Windows desktop sidecar and smoke installer | 2–4 days |
|  | **Windows-first total** | **12–19 days** |

Slice A was re-estimated upward from 4–6 days: threading the injected runtime
through the MCP and Studio entrypoints (~15 vendor symbols each) and the
settings-validation redesign in Phase 1 dominate it, not the file moves.

Additional estimates:

- Validated macOS/Linux vendor packs: 3–6 days, depending on which local
  speech, music, and transcription providers are supported.
- Signed Windows installer and update channel: 3–5 days.
- Multi-platform installers, signing, and update testing: 5–10 days.
- A full monorepo/public npm package restructuring beyond the low-churn split:
  2–5 additional days.

## 9. Risks and controls

| Risk | Control |
|---|---|
| Core still imports a provider indirectly | Add a static import-boundary test and inspect the dependency graph. |
| Existing settings reset or lose vendor options | Preserve the JSON shape and add migration fixtures before changing defaults. |
| Electron launches workers incorrectly | Always spawn the bundled real Node executable and pass it through renderParallel's existing `nodeExecutable` option. |
| Installer becomes multi-gigabyte | Use explicit vendor manifests and optional model/voice packs. |
| AI calls fail because the sidecar receives a narrow PATH | Pass absolute FFmpeg/vendor paths from the desktop launcher and report their source. |
| Cloud credentials leak into logs or settings | Keep environment/secure-store input separate from persisted settings and mask diagnostics. |
| Studio and MCP drift apart | Keep both adapters on the same injected runtime until the Studio is formally retired. |
| A missing optional vendor blocks all rendering | Load providers lazily and keep unavailable capabilities data-driven. |
| Vanilla install downloads two Chromium builds (~700 MB) | Install only chrome-headless-shell; treat the pinned browser as a pack (Phase 0.5). |
| MCP server crashes at import time when the vendor package is absent | Dynamic, failure-tolerant registry import; structured unavailable instead of ERR_MODULE_NOT_FOUND (Phase 4). |
| System-browser rendering breaks determinism | Pinned browser pack stays the default; system Chrome is opt-in and the actual browser build is recorded in render metadata. |

## 10. Decisions to make before implementation

1. Windows default speech provider for new installations: preserve system
   speech for compatibility, ship one cross-platform local voice pack, or —
   recommended — keep the vendor id "system" and give it zero-byte
   per-platform OS backends (bundled exe → System.Speech → say → espeak-ng),
   so existing settings stay valid and the default works on every OS with
   nothing downloaded (Phase 0.5).
2. Whether the first desktop shell is a hidden process or a tray app.
3. Which local vendor assets belong in the first default pack, versus optional
   downloads.
4. Whether to make the core/default-vendor split a publishable npm workspace in
   the first release or first implement the runtime boundary inside engine.
5. Whether the existing human Studio remains a supported developer tool after
   the AI-only desktop release.
6. The runtime injection mechanism: a runtime object threaded through the
   tool handlers, a constructor parameter on the stores/servers, or a
   module-level setRuntime(). Decide in Phase 0 — it is the plan's
   highest-churn choice and the one that is expensive to reverse.
7. Distribution shape: npm/npx-first (works on all three OSes with no
   signing or installers, matching the cross-platform + lightweight goals),
   with the Electron desktop host of Phase 5 following rather than leading —
   or installer-first. Today "download Motion Studio" means a git clone;
   this decision is what changes that.

The recommended implementation order is 0, A, B, then C. Slice 0 is what a
new install actually feels and needs no refactor; A–C keep the core boundary
testable before desktop packaging and avoid making the installer the place
where architectural problems are discovered.
