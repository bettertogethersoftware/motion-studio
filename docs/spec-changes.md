# Spec Decisions and Changes (implementation vs. spec v0.2)

> **Historical document (v0.2 era).** This is the decision log from the v0.2
> implementation, preserved unchanged. All v0.2 → v0.5 decisions — including
> the replacement of the WinForms app with the Studio web UI — are recorded
> in [CHANGELOG.md](CHANGELOG.md).

Per spec §12, the spec is a living document and the implementation may improve on it provided changes are recorded. This file records every resolved open question, every addition beyond the spec's letter, and the small deviations — with reasoning.

## Open questions from the spec, resolved

**Frame transport: PNG files vs. pipe.** Frames are streamed to FFmpeg over stdin (`image2pipe`) by default — no intermediate files, no disk churn on long renders, and backpressure from the encoder naturally pacing capture. A `--frames-dir` CLI flag (and `framesDir` engine option) switches to a numbered PNG sequence on disk for debugging individual frames; both modes are integration-tested.

**Minimum tool versions.** Node ≥ 18 (first LTS with stable `node:test`, fetch, and the V8 features the engine uses) and FFmpeg ≥ 5 (consistent `-filter_complex` audio behavior). Enforced identically in `engine/src/core/prereqs.js` and the C# `PrereqChecker`; FFmpeg git builds with unparseable versions are allowed through with a warning rather than blocking.

**Parallel worker default.** `min(CPU cores, 4)`. Empirically, Chromium instances beyond ~4 trade memory pressure for little wall-clock gain on desktop hardware; both the UI dropdown and the MCP `workers` argument override. Independently, the MCP server caps concurrent render *jobs* at 1 (spec §5.5's "one render at a time" reading), so agent parallelism is within a job, never across jobs.

**Audio length semantics.** The mixed audio is padded/trimmed to exactly the video duration (`apad` + `atrim`), rather than using `-shortest`. A 5-second music bed under a 0.8-second clip yields a 0.8-second file — test-verified. `amix normalize=0` so adding a quiet track doesn't duck existing ones.

**Human/agent concurrent edits.** Last-write-wins on disk for v0.2, deliberately: an mtime-conflict check adds a failure mode agents must handle for a race that is rare in practice, and the desktop app's file watcher already makes agent writes visible to the human within ~250 ms. Revisit if real usage shows edit collisions; the natural upgrade is an optional `expectedMtime` argument on `write_composition_file` returning a `conflict` error.

**Agent resource ceilings (spec §10).** Opt-in rather than default: `MOTION_STUDIO_MAX_RENDERS=<n>` caps renders per MCP session. A hard default would strand legitimate long sessions; the cap exists for users running unattended agent loops.

## Additions beyond the spec's letter

**`registerComposition(fn)` harness (frame API).** The draft frame API made compositions hand-assign `window.setFrame` and manage `frameReady` manually; the async-readiness mistake (setting ready before fonts/images resolve) was singled out by the spec itself as the most likely authoring bug. The shipped runtime adds `MotionStudio.registerComposition(fn)`, which owns the handshake (including async frame functions and `document.fonts.ready`) and converts thrown errors into structured `composition_error`s instead of frame timeouts. Manual `setFrame` remains fully supported. `MotionStudio.random(seed)` (deterministic PRNG) and an easing library were added for the same reason: make the deterministic path the easy path. `docs/frame-api.md` §changelog notes the delta.

**`update_project_config` tool (12th MCP tool).** The spec's tool list has no way for an agent to change fps/duration/dimensions after `create_project` short of raw-writing `project.json` — which would bypass validation (even dimensions, positive duration, output invariants). Raw writes to `project.json` are therefore deny-listed and a validated `update_project_config` tool added.

**Atomic, syntax-gated writes.** Spec asks for syntax errors to fail fast; the implementation additionally makes all writes atomic (temp file + rename) so a rejected or interrupted write can never corrupt the previous file version.

**Deterministic-rendering browser flags.** `--force-color-profile=srgb`, `--disable-lcd-text`, `--font-render-hinting=none` pin pixel output across machines/displays — required for the parallel path (segments from different workers must be visually seamless) and not called out in the spec.

**CLI exit-code contract.** `0` ok / `2` bad args or config / `3` prereqs missing / `4` cancelled / `1` render error, so the C# orchestrator can distinguish cancellation from failure even if the protocol stream was cut off. Exactly one protocol `error` line is guaranteed per failed run (emit-once tracking across layers).

**Test injection hook.** `MOTION_STUDIO_BROWSER_MODULE=<path>` loads an alternative browser factory in the CLI and MCP server. This exists for the test suite (it enables real multi-process parallel and MCP integration tests on machines without Chromium) and is documented as such; it is inert unless explicitly set in the environment.

## Deviations

**None functional.** All eleven spec milestones and the full MCP tool surface are implemented as specified. The only textual deviation is the frame API reference itself, superseded by `docs/frame-api.md` v1 as described above — the underlying engine contract (`setFrame`/`frameReady`/screenshot polling) is unchanged, so hand-written manual-mode compositions from the draft doc still render correctly.
