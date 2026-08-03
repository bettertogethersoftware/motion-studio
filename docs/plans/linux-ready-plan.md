# Linux-ready plan

Status: proposed 2026-08-04. Scope: make a Linux machine with a shell a
supported Motion Studio deployment — engine, vendors, helper tools, and the
provisioning playbook — ending with the acceptance test in §L4, which is what
"Linux-ready" means. Until that test passes once,
`deploy/PROVISION.md` carries a "not yet playbook-grade" warning for Linux;
flipping that warning is the last step of this plan.

Relationship to the
[AI-only desktop vendor boundary plan](ai-only-desktop-vendor-boundary-plan.md)
(draft): that plan restructures *where vendors live*; this one gets *today's
layout* running on Linux. They overlap on the FFmpeg resolution chain, the
cross-platform speech decision, the SoundFont fetch, and Linux CI — if the
vendor-boundary plan's Slice 0 / Phase 0 land first, most of §L1 here becomes
free. Do not implement those items twice: whichever plan starts first owns
them.

Verified starting points (2026-08-04):

- The engine anticipated Linux in places: `prereqs.js` defaults FFmpeg to
  `ffmpeg` on PATH and parses Ubuntu-style version strings;
  `transcribe-whisper.js` orders executable extensions per platform; the test
  suite already contains POSIX-only cases that skip on Windows.
- Every capability has a cross-platform vendor today: `piper`/cloud for
  speech, `node` (spessasynth) for music, `whisper-cpp` for transcription.
  Windows-only: the `system` TTS exe and the vendored FluidSynth/MIDI chain.
- Only `vendor/libs` (3D libraries) is committed; the SoundFont, FluidSynth,
  Piper voices, and TTS exe are gitignored — a clean clone on *any* OS cannot
  synthesize music or speech until assets are fetched.
- The `videoforge` helpers resolve FFmpeg platform-aware as of 2026-08-04
  (env var → any sibling `ffmpeg-*` build → PATH); `verticalforge` and
  `comfyui_music` already resolved acceptably.

## L0 — Make the cross-platform claim testable (0.5–1 day) — DONE 2026-08-04

- [x] Baseline measured on real Linux (WSL Ubuntu 26.04, Node 22.16, static
      FFmpeg 7.0.2, `PUPPETEER_SKIP_DOWNLOAD=1`): **858 tests, 852 pass,
      2 fail, 4 skipped** on the first-ever Linux run. `npm run doctor`
      passed unmodified.
- [x] Triaged both failures to one real bug, not test gaps:
      `transcodeIdentity` lowercased the recorded absolute source path
      (`transcode.js`), which is harmless on case-insensitive Windows but
      turns a mixed-case `mkdtemp` path into ENOENT on POSIX →
      `footage_source_changed`/`source_missing` at plan time. Fixed by making
      case normalization win32-only (Windows sidecars written before the fix
      still match); the source==dest overwrite guard had the same bug and got
      the same fix. After the fix: 858 tests, 854 pass, 0 fail, 4 skipped.
- [x] `.github/workflows/ci.yml`: `ubuntu-latest` + `windows-latest` jobs
      (Node 22, distro/choco FFmpeg, `npm ci`, doctor, test). macOS deferred.

## L1 — Engine capability parity on Linux (2–4 days standalone; mostly free if vendor-boundary Slice 0 lands first)

- [x] FFmpeg resolution audited (2026-08-04): `settings.js` already
      implements the chain (explicit `--ffmpeg` → `MOTION_STUDIO_FFMPEG` →
      `ffmpeg.path` setting → PATH) and the MCP server threads
      `resolveFfmpegPath` through every call site; `encoder.js` only ever
      receives the resolved path. FFmpeg 7.0.2 static passed the doctor
      version floor on Linux. The fetched-pack chain remains the
      vendor-boundary plan's item.
- [x] Speech verified on Linux (2026-08-04): `piper` end to end through
      `synthesizePiperSpeech` — pip `piper-tts` (piper1-gpl) via
      `MOTION_STUDIO_PIPER_PYTHON=python3`, voices dir env, probe, synthesis,
      valid WAV (5.12 s, 22050 Hz mono). **Trap recorded in tts-setup.md:**
      the old rhasspy C++ release binary ignores the engine's flags and exits
      0 with no audio — Linux installs must use pip. Still open: the
      *default*-vendor decision (zero-byte `system` espeak backend is the
      vendor-boundary plan's recommendation).
- [x] Music `node` vendor verified on Linux (2026-08-04):
      `synthesizeNodeMusic` with the real MuseScore_General.sf3 → correct
      PCM WAV, measured peak −16.87 dBFS. Still open: SoundFont on a clean
      clone (fetch/ship — vendor-boundary Phase 0.5), and pointing the
      `fluidsynth` vendor at a distro binary via settings.
- [x] Transcription: verified in CI **run #6, commit `1f3f9fe`, 2026-08-04**
      (runs #4/#5 failed on CI plumbing first — a mirror flake, then the
      runner's preset `PIPX_BIN_DIR` breaking a hardcoded piper path). The
      `linux-speech` job builds whisper.cpp statically (cached), fetches
      `ggml-base.en.bin`, and runs
      `engine/test/smoke-speech-roundtrip.mjs` — piper speaks a known
      sentence, `extractSpeechWav` conforms it to 16 kHz, real whisper.cpp
      transcribes it, and every expected word must survive (measured: 3 s of
      real work in the green run). The smoke is deliberately outside
      `npm test` (the suite fakes both vendors); it also runs on any machine
      with the `MOTION_STUDIO_PIPER_*`/`_WHISPER_*` env hooks set.
      Incidental extra: run #1's re-run proved distro (apt) FFmpeg 6.x also
      passes the full suite, alongside the static 7.0.2.
- [ ] Rendering: verify Puppeteer headless Chromium on Linux for every output
      format (H.264, VP9/alpha, GIF, ProRes, PNG-seq), parallel workers, and
      cancellation. **Fonts are the determinism risk** — a Linux distro's
      font set differs from Windows, so the same composition renders
      different glyphs. Decide: bundle/pin a font pack, or record the font
      environment in render metadata and document the caveat. *Covered
      except the font decision (2026-08-04): CI's `linux-render` job runs
      the gated `real-chromium.test.js` (launch, screenshot determinism,
      real alpha) with a skips-are-failures guard, then
      `smoke-render-formats.mjs` — every deliverable format (mp4, webm with
      VP9 alpha via the alpha_mode tag, gif, prores 4444 12-bit alpha,
      png-sequence), a 2-worker parallel render, and a cancellation, each
      ffprobe-verified. The font-determinism decision moves to the Slice-0
      set in [TODO.md](TODO.md).*
- [x] win32-assumption sweep (2026-08-04): clean. Every `.exe` grep hit
      outside the documented Windows-only vendor modules is a regex
      `.exec(` false positive; the one `process.platform` gate
      (whisper exe-extension ordering) is correct.

## L2 — Helper tools on Linux (1–2 days)

- [x] `videoforge` FFmpeg resolution (done 2026-08-04).
- [x] `comfyui/generate_video_wan.py` (+ missing env override),
      `comfyui_video/generate_video.py`, and both `comfyui_music` helpers:
      globs are now platform-aware (done 2026-08-04; PATH fallbacks already
      existed). Verified resolving on both Windows and Linux.
- [x] `verticalforge`: `MOTION_STUDIO_FFMPEG`/`FFPROBE` env override added to
      `_common.py` and `register.mjs`; version-pinned "preferred" dir dropped
      in favor of the newest-first glob (done 2026-08-04).
- [x] `musicforge/compose.py`: FluidSynth resolves env override → vendored
      Windows exe → `fluidsynth` on PATH; SoundFont honors
      `MOTION_STUDIO_SOUNDFONT` (done 2026-08-04).
- [ ] Audit all helpers for `os.startfile`, backslash literals, `.exe`
      assumptions, and Windows-only subprocess conventions — the resolution
      fixes above touched only FFmpeg/FluidSynth discovery, not each
      helper's full command construction.
- [ ] Decide the Linux story for each core tool in provisioning terms:
      FFmpeg/ImageMagick via distro packages (no `magick-portable.ps1` on
      Linux — packaged installs find their own coders), auto-editor via pip,
      whisper.cpp built or packaged; each records its path in `MACHINE.md`.

## L3 — Provisioning and entry files (1–2 days) — DONE 2026-08-04 (except the doc item below)

- [x] `deploy/ENTRY.md` is a single source with
      `<!-- os:windows -->`/`<!-- os:posix -->` blocks; `provision.mjs`
      filters at emit time (platform auto-detected, `--os` to override,
      nesting/unclosed-marker validation) and stamps the header with the
      target OS. Verified: Windows emit (4 PowerShell blocks, 0 bash), Linux
      emit (4 bash, 0 PowerShell, zero leftover markers), WSL auto-detect.
- [x] `deploy/PROVISION.md` gained the "Provisioning on Linux" section:
      per-step deltas incl. userspace no-sudo fallbacks, both FFmpeg routes,
      the whisper.cpp static build recipe, pip-only Piper with the
      `PIPX_BIN_DIR` and pre-2024-binary traps, no ImageMagick wrapper on
      Linux, and the round-trip smoke as a verification step.
- [x] `deploy/provision.mjs` verified on Linux (WSL): path handling and
      per-OS emit both correct.
- [x] `deploy/MACHINE-template.md` rows are OS-neutral (operating system,
      interpreter path, per-OS MAGICK note, new PIPER row).
- [ ] Update `docs/mcp-setup.md` and the vendor setup docs
      (`music-setup.md`, `transcribe-setup.md`) with the Linux paths and
      defaults once the L1 *default-vendor* decisions are made
      (tts-setup.md already carries the pip-only Piper warning).

## L4 — Acceptance: one real Linux install, end to end — **PASSED 2026-08-04**

Executed on a **fresh Ubuntu 24.04.4 LTS WSL2 distro** (created for this
test; the tainted L1 environment was not reused), as user `motion` with
passwordless sudo — customer-like, not root:

1. [x] `minimal`-profile provisioning, agent-driven per the playbook: apt
       prereqs, GitHub clone, engine `npm install` + doctor (Node 18.19.1 —
       exactly the floor — and distro FFmpeg 6.1.1 both pass), whisper.cpp
       static build, pipx piper + voice, SoundFont fetch, `provision.mjs`
       (auto-emitted bash-flavored guides), measured `MACHINE.md`.
       Findings folded back into PROVISION.md: Ubuntu 24.04 packages
       ImageMagick **6** (`convert`/`identify`, no `magick`); the SoundFont
       must be fetched and exported as `MOTION_STUDIO_SOUNDFONT`; Puppeteer's
       ~700 MB double browser download reproduced on a clean install.
2. [x] MCP over stdio: initialize, `get_capabilities`, `list_vendors` —
       piper/node/whisper-cpp all available.
3. [x] End-to-end film (`engine/test/smoke-mcp-film.mjs`): piper speech with
       sentence timings (5.4 s, 2 sentences), `node`-vendor music
       (peak −16.1 dB), `tone` SFX, both scenes rendered through the freshly
       downloaded Chromium, `build_film` promoted, and the delivered MP4
       (H.264 640×360 at exactly 30/1 + AAC, 10.02 s, ffprobe-verified)
       transcribed back by whisper.cpp with every expected word intact.
4. [x] `standard` profile: `shotfinder` scanned the built film;
       `compose.py` rendered through **distro FluidSynth via the PATH
       fallback** (fresh raw WAV measured −18.6 dB mean / −0.8 dB max, full
       accent map) — which also proved the 2026-08-04 resolution fixes on
       the platform they were written for. First attempt was caught reading
       *stale copied artifacts* as success; the honest re-run rendered
       fresh.
5. [x] PROVISION.md's Linux status flipped to **supported**, recording the
       distro and versions tested.

Remaining honest caveats: the machine was WSL2, not bare metal (optional
follow-up); the render-format matrix beyond H.264 and the three Slice-0
design decisions live on in [TODO.md](TODO.md).

## Explicitly out of scope

- macOS (separate, smaller effort after Linux proves the seams).
- ARM64 specifics (Windows-on-ARM or Linux-on-ARM Spark boxes) — revisit
  once x64 Linux passes L4; most of the work transfers.
- The vendor-pack/desktop packaging work — that is the vendor-boundary
  plan's scope.
- GPU/ComfyUI helpers on Linux beyond the FFmpeg resolution fixes: the
  remote-ComfyUI deployment variation in `deploy/PROVISION.md` already covers
  GPU customers without porting the helpers' host environment.
