# Completed plans — the ledger

One entry per finished plan: what it was, what actually shipped, and the
corrections reality forced on the plan (those are the transferable part).
Living documentation for every feature is in the setup docs and
[CHANGELOG.md](../CHANGELOG.md); the **full original design records** are in
git history — every file summarized here exists verbatim at commit `1f3f9fe`
and earlier, under `docs/task_completed/` and `docs/todo_task/`.

Newest first.

## v0.26.0 (2026-08-04) — the vendor-boundary program: Slices 0, A, B, C-1, released

The [vendor-boundary plan](ai-only-desktop-vendor-boundary-plan.md) delivered
end to end in one day, all seven §10 decisions plus §10.3/§10.4 made along
the way; the plan document stays for its two open remainders (browser/FFmpeg
as packs; C-2 packaging, deprioritized by §10.7's "no installer channel").
What shipped, in slice order:

- **Slice 0** — headless-shell-only browser (−420 MB), `fetch-soundfont`
  (the pack pilot), the zero-byte per-platform `system` speech backend,
  capability tiers in doctor/`get_capabilities`.
- **Slice A** — the physical core/vendors boundary: catalog-driven
  dispatchers, the default registry, both entrypoints on a dynamic
  failure-tolerant runtime, eleven modules moved under `vendors/default/`,
  the import-graph and core-only integration tests, settings-schema
  injection (`VENDOR_SETTINGS_FIELDS` fallback, drift-guarded). The
  core-only test caught a real static-import bug on its first run.
- **Slice B** — the pack mechanism (`core/fetch-verified.js` transport +
  versioned manifest + `npm run fetch-pack`, whisper model packs landing
  where the vendor already searches, pins confirmed by real downloads) and
  the §10.7 GitHub-URL install (root package.json wrapper, drift-guarded,
  verified by installing the tarball and driving its MCP server over
  stdio); `get_capabilities` reports the packs.
- **Slice C-1** — the ComfyUI-style desktop viewer host: `desktop/`
  Electron shell spawning the Studio on a real Node, kill-the-tree
  cleanup, smoke-proven.
- **Release discipline** — versions aligned at 0.26.0 (both package files +
  lockfile, drift-guarded), the changelog's Unreleased block rolled into
  the v0.26 release, [release-checklist.md](../release-checklist.md)
  created, tag `v0.26.0` pushed.

Corrections reality forced: npm's install-scripts policy silently skips
puppeteer/electron postinstalls (documented in desktop/README.md); the
whisper pack paths had to match `defaultModelsDir()` exactly
(`vendor/whisper/models/`, tethered by test); `npm ci` compares the
lockfile's recorded root version, so a version bump is three files, not
two. Details: CHANGELOG v0.26.

## v0.26 (2026-08-03/04) — deployment restructure + Linux L0–L3

Replaced the hand-copied 900-line SETUPME agent guide with layered `deploy/`
machinery (generated per-OS `AGENTS.md`/`CLAUDE.md`, machine-owned
`MACHINE.md`, agent-driven [PROVISION.md](../../deploy/PROVISION.md)), stated
the generative boundary as policy (architecture §9.5/§16), and executed the
[linux-ready plan](linux-ready-plan.md)'s L0–L3: two-platform CI plus
real-Chromium and speech→transcribe round-trip jobs, the 858-test suite green
on real Linux, vendor verifications, and per-OS entry emit. Corrections
reality forced: `transcodeIdentity` lowercased paths (fatal on POSIX);
`musicforge/compose.py` still pointed at the pre-v0.25 `engine/vendor` tree;
the archived pre-2024 piper C++ binaries exit 0 writing no audio; GitHub
runners preset `PIPX_BIN_DIR`; apt and the static-FFmpeg mirror both flake in
CI (cache + retry everything). Details: CHANGELOG v0.26 section.

## v0.23 / v0.23.1 (2026-08-01/02) — the production loop: AI directs, the human advises

Two plans, one outcome. The V2 "AI-first direction, atomic shots, advice,
evidence" architecture (`motion-studio-shot-advice-plan.md`, 1138 lines) was
deliberately **not** built as designed; its rework
(`rework-motion-studio-shot-advice-plan.md`) shipped the MVP instead: extend
the existing Film editor and Scene model with sequences and human advice —
`check_human_advice` / `resolve_human_advice` / advice lifecycle tools, scene
revisions, delivery archives — rather than a new Film→Narrative-Scene→Shot
model. The load-bearing decision: the redesigned runtime owes old documents
nothing except not deleting them. `film.html` became the only film surface.
Living docs: user-guide, mcp-setup, architecture §14.

## v0.22 (unreleased) — the real-footage program: plans 0–5 plus defect follow-ons

One program, found by one method — build a real film through the MCP surface,
read the result back — and ordered by one rule (from
[agent-environments.md](../agent-environments.md)): *tools that only report
lose to the shell; tools that report what only the engine knows do not.* The
acceptance test (an MCP-only agent reproduces a 65 s talk-spine film built in
Env B with 31 shell calls) is **met**. In ship order:

- **Film signature** (`film-signature-plan.md`) — `get_film`'s
  `plan.signature` states the encode contract including the engine's own
  `ffmpegArgs`. Pure knowledge, led because it was the cheapest correctness
  win; both later plans consume it.
- **`transcribe_asset`** (`transcribe-asset-plan.md`) — whisper.cpp vendor,
  word/sentence timings in seconds *and* frames, second job lane. Landed
  first (no dependencies, high value in both environments).
- **Footage segments** (`footage-segment-plan.md`) — real video as a
  first-class timeline entry beside rendered scenes; the wall Env A could not
  route around (`build_film` previously only assembled scenes). Six
  plan-vs-implementation corrections recorded in the design record.
- **`transcode_asset`** (`transcode-asset-plan.md`) — conform media inside
  the tool surface; `matchFilm` consumes the signature; idempotent
  `.transcode.json` sidecars; never overwrites its source.
- **Film colour** (`film-colour-plan.md`) — final encodes state
  BT.709/sRGB/tv and `matchFilm` converts to that contract, recording an
  assumption for untagged inputs. The only plan that changes rendered pixels;
  render sidecars mark pre-colour output unverified/stale.
- **Render review** (`render-review-plan.md`) — `inspect_render` (encoded
  frames back) and `measure_render` (motion/static/black/cut facts) close the
  agent's local review loop. The optional cloud review vendor (R§4) is
  explicitly out of scope, by design.
- **Five MCP defects** (`mcp-defects-plan.md`) — found at feature length on a
  3:00 film (16 scenes, 7 footage segments, 18 audio tracks); all fixed with
  integration tests.
- **`sequence-gap` branch blindness** (`lint-branch-awareness-plan.md`) —
  the lint no longer false-positives on the recommended shared-engine film
  pattern; same-scope gaps still warn.

## v0.12 (2026-07-25) — `synthesize_sfx`

Pure-JS procedural sound effects (`sfx-plan.md`): cue list in frames, seeded
PRNG determinism, ceiling-only normalization. Exists because neither speech
nor note-spec music can make an unpitched noise. Four plan-vs-implementation
corrections are in the design record; living doc: sfx-setup.md.
