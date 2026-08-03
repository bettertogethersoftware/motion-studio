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
- [ ] Transcription: document getting whisper.cpp on Linux (distro package
      or build), verify resolver and model paths, run `transcribe_asset`
      against a known fixture. *Blocked in the local WSL environment (no
      compiler, no sudo) — verify via CI or a full Linux box.*
- [ ] Rendering: verify Puppeteer headless Chromium on Linux for every output
      format (H.264, VP9/alpha, GIF, ProRes, PNG-seq), parallel workers, and
      cancellation. **Fonts are the determinism risk** — a Linux distro's
      font set differs from Windows, so the same composition renders
      different glyphs. Decide: bundle/pin a font pack, or record the font
      environment in render metadata and document the caveat. *Blocked in
      the local WSL environment (Chromium system libs need sudo) — a CI job
      with the Puppeteer download enabled is the natural vehicle.*
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

## L3 — Provisioning and entry files (1–2 days)

- [ ] `deploy/ENTRY.md`: the root-resolution block and examples are
      PowerShell. Decide: dual-shell examples in one file, or per-OS entry
      templates selected by `provision.mjs` at emit time (recommended — the
      guide stays short and each machine gets one shell, not two).
- [ ] `deploy/PROVISION.md`: add the Linux branch to each step (prereqs via
      distro packages, core tools per the L2 decision, env var via
      `~/.profile` or systemd user environment rather than
      `[Environment]::SetEnvironmentVariable`).
- [ ] `deploy/provision.mjs`: already plain Node — run it on Linux, confirm
      path handling, and add the per-OS template selection if L3's first
      decision goes that way.
- [ ] `deploy/MACHINE-template.md`: generalize Windows-flavored rows
      (Windows version → OS/kernel; `python.exe` → interpreter path).
- [ ] Update `docs/mcp-setup.md` and the vendor setup docs
      (`tts-setup.md`, `music-setup.md`, `transcribe-setup.md`) with the
      Linux paths and defaults decided in L1.

## L4 — Acceptance: one real Linux install, end to end (1 day)

The plan is complete only when all of these pass on a clean Linux machine
(container acceptable for CI, but run once on a real box):

1. Provision the `minimal` profile per the updated playbook, driven by an
   agent, with no undocumented manual step.
2. MCP over stdio: `initialize`, `get_capabilities`, `list_vendors` report
   the expected Linux vendors and availability.
3. End-to-end film: create film → scene → composition → `synthesize_speech`
   (Linux default vendor) → `synthesize_music` (`node` vendor) →
   `synthesize_sfx` → render → `build_film` → `transcribe_asset` on the
   result → measurements verified with ffprobe.
4. `standard` profile: `videoforge` and `musicforge` smoke runs succeed
   against distro FFmpeg/FluidSynth.
5. Flip the Linux status note in `deploy/PROVISION.md` from "not yet
   playbook-grade" to supported, recording the distro and versions tested.

## Explicitly out of scope

- macOS (separate, smaller effort after Linux proves the seams).
- ARM64 specifics (Windows-on-ARM or Linux-on-ARM Spark boxes) — revisit
  once x64 Linux passes L4; most of the work transfers.
- The vendor-pack/desktop packaging work — that is the vendor-boundary
  plan's scope.
- GPU/ComfyUI helpers on Linux beyond the FFmpeg resolution fixes: the
  remote-ComfyUI deployment variation in `deploy/PROVISION.md` already covers
  GPU customers without porting the helpers' host environment.
