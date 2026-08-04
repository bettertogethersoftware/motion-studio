# PlateForge and MotionForge — generated plates to verified film delivery

> **Status: PROPOSED.** Nothing in this document has shipped.
>
> This is an authoring-time shell-tool plan for the Windows machine profile. It
> covers the two expensive parts of the NEON APEX production run: Krea2 plate
> generation/asset staging and Motion Studio scene rendering/film assembly.
> Motion Studio remains the authority for film and scene state; these tools
> orchestrate it and produce compact, resumable evidence.

## Why this plan exists

The completed 180-second racing-anime film used ten local Krea2 plates, ten
scene-local asset links, ten asynchronous scene renders, one film build, and a
separate encoded-media review. The work was correct, but the agent had to
repeat the same checks, path construction, status polling, and JSON handling by
hand.

The token report for that run measured the following production buckets:

| bucket | recorded tokens |
|---|---:|
| Krea2 plates and asset staging | 18,917,146 |
| Scene rendering and film assembly | 28,427,852 |

The shell tools should reduce repetition without weakening the evidence
required to claim a finished film.

## Existing contracts to reuse

Do not rebuild these capabilities:

- `comfyui\generate_krea2.py` already supports `check`, `models`, and `image`
  with Turbo/Raw models, seeded batches, JSON stdout, measured PNG facts, and
  `<image>.png.gen.json` idempotency sidecars.
- Krea2 uses the newer local ComfyUI runtime and shared model store. The helper
  must remain the only owner of its graph and model-specific arguments.
- Motion Studio MCP owns `film.json`, scene documents, asset linking,
  revisions, deliveries, and the adviser loop. The shell tools must not hand
  edit film or scene JSON.
- `get_film` / `build_film { plan: true }` already resolve film offsets,
  render staleness, signatures, and problems.
- Scene and film delivery paths already use staging, frame-count checks,
  review JSON, and contact sheets before promotion.
- `render`, `wait_for_render`, `build_film`, `inspect_render`,
  `measure_render`, and `get_production_status` are the verification surface.

The proposed tools are therefore a manifest runner and an MCP client, not a
second renderer or a second film database.

## Location and process boundary

Install the tools beside Motion Studio, not inside the app checkout:

```text
<MotionStudioToolsRoot>\agent_tool\plateforge\
<MotionStudioToolsRoot>\agent_tool\motionforge\
```

Resolve paths in this order at runtime:

1. process `MotionStudioRoot`;
2. user-level `MotionStudioRoot`;
3. machine-level `MotionStudioRoot`;
4. reject the run if `engine\src\mcp\server.js` is not present.

Derive `MotionStudioToolsRoot` with `Split-Path -Parent`, then resolve the
Krea2 helper, Python, Node, FFmpeg, and FFprobe from the validated machine
inventory. Do not embed this PC's absolute paths in the implementation.

PowerShell should be a thin launcher only. The implementation should pass
argument arrays to Python/Node processes; it must never assemble a single
quoted command string from prompts, paths, or JSON.

## One manifest for one run

`plateforge` and `motionforge` share an authoring manifest. It is not a film
document and must never be copied over `film.json`.

```jsonc
{
  "schema": "motion-studio.plate-render/1",
  "workspace": "default",
  "film": "neon-apex-rage-the-dream-mv",
  "runId": "generated-or-explicit",
  "plateRoot": "data/temp/neon-apex-racing-mv/plates-krea2",
  "libraryRoot": "neon-apex-racing-mv/plates-krea2",
  "defaults": {
    "model": "turbo",
    "aspect": "16:9",
    "timeoutSeconds": 1800,
    "seedBase": 7300
  },
  "plates": [
    {
      "id": "s01-ignition",
      "scene": "s01-ignition",
      "filename": "s01-ignition.png",
      "promptFile": "prompts/s01-ignition.txt",
      "negativeFile": "prompts/common-negative.txt",
      "model": "turbo",
      "aspect": "16:9",
      "seed": 7300,
      "assetAs": "assets/plate.png"
    }
  ]
}
```

Prompts live in files so PowerShell quoting cannot corrupt them. The manifest
records the prompt-file identity, not a second copy of the prompt text. The
Krea2 `.gen.json` sidecar remains the canonical generation record.

Each run writes only authoring artefacts under a run directory:

```text
data/temp/<project>/runs/<runId>/
  manifest.json
  plan.json
  plates/
  review/contact.png
  review/review.json
  stage/stage.json
  render/render.json
  delivery/delivery.json
  logs/events.jsonl
```

## Tool A — `plateforge`

Implement `plateforge.py` with JSON-only stdout. Human-readable progress may go
to stderr; stdout must remain one JSON object per line so a later agent can
consume it without scraping prose.

### `plateforge doctor`

Check, without generating anything:

- resolved Motion Studio and tools roots;
- Python and the Krea2 helper;
- ComfyUI reachability and helper-specific `check` / `models` results;
- Turbo and Raw readiness, required CLIP/VAE, and available aspects;
- FFmpeg/FFprobe and Node availability;
- write access to the chosen temp and workspace-library locations.

Return versions, paths, and `billing: "none"`, but never return environment
secrets or full process command lines.

### `plateforge plan --manifest <file>`

Validate without touching the GPU:

- schema, required IDs, unique filenames, seed ranges, and aspect values;
- prompt and negative-prompt file existence and identities;
- path containment under the approved temp/library roots;
- no duplicate scene targets or destination collisions;
- selected model readiness;
- expected output count and an elapsed-time estimate from prior sidecars;
- whether each plate is `missing`, `reusable`, `stale`, or `force`.

The output is a compact plan. Do not echo every prompt in the result.

### `plateforge generate --manifest <file>`

For each `missing` or `stale` plate:

1. read the prompt files;
2. invoke the existing `generate_krea2.py image` helper with an argument array;
3. preserve the helper's JSON result and `.gen.json` sidecar;
4. measure and record width, height, bytes, seed, elapsed time, and identity;
5. write an event to `events.jsonl`.

Default to one GPU generation at a time on the RTX 3080 profile. A batch is
allowed only for same-prompt seed variations; different scene prompts remain
individually addressable so one rejected plate can be regenerated alone.

Rerunning the command must reuse matching sidecars without touching the GPU.
`--force` is explicit and must be recorded in the run manifest.

### `plateforge review --manifest <file>`

Create one contact sheet from an explicit list of generated PNGs and write a
machine-readable review record containing:

- plate ID and file path;
- generation identity, seed, model, dimensions, and elapsed time;
- missing/stale/sidecar mismatch findings;
- a selected/rejected/pending state.

The command must not silently select the first image. Selection is either an
explicit manifest decision or a separate `plateforge select` command. A human
or agent can inspect the single contact sheet instead of opening ten files.

### `plateforge stage --manifest <file>`

Stage only selected, verified plates into the workspace library:

```text
data/workspaces/<workspace>/library/<libraryRoot>/<filename>
data/workspaces/<workspace>/library/<libraryRoot>/<filename>.gen.json
```

The operation must:

- refuse a destination outside the workspace library;
- preserve the PNG and its generation sidecar together;
- compare bytes/dimensions/identity before declaring reuse;
- write `stage/stage.json` with source and destination identities;
- never edit `film.json` or scene JSON.

Asset linking remains a Motion Studio operation. The stage result provides the
library-relative paths and target `assets/plate.png` values for `motionforge`
or the MCP `use_shared_asset` calls.

### `plateforge verify-assets --manifest <file>`

Confirm every staged plate exists, its sidecar identity matches, its image is
decodable, and its target asset path is contained under the intended scene or
film assets directory. Emit one compact summary plus per-plate errors.

## Tool B — `motionforge`

Implement `motionforge.mjs` as a long-lived Node MCP client using the same
`engine/src/mcp/server.js` and workspace environment as Motion Studio. It must
call typed MCP tools rather than editing files directly. A small
`motionforge.ps1` launcher may resolve the environment and forward arguments.

### `motionforge doctor`

Call `get_workspace`, `get_capabilities`, and `check_human_advice` once. Report:

- bound workspace and film existence;
- engine/browser/FFmpeg readiness;
- render queue limits;
- unresolved advice count;
- required scene and asset counts.

### `motionforge link --manifest <file>`

Use the staged library paths to call `use_shared_asset` for the film audio and
scene plates. Keep a local mapping of each MCP call and result. If a future
batch MCP operation exists, use it; otherwise issue calls through one
long-lived MCP connection and emit one aggregate result rather than forwarding
ten full responses to the agent.

The command must be idempotent. A matching existing hardlink/asset is `reused`;
it is not an error and must not cause a re-render.

### `motionforge render --film <film>`

The default policy is `missing-or-stale`:

1. call `get_film` or `build_film { plan: true }` once;
2. fail before rendering if the plan has structural problems or missing assets;
3. identify only missing/stale scenes;
4. submit those scenes with `render` and retain job IDs locally;
5. wait on the group with `wait_for_render` in bounded calls of at most
   50,000 ms;
6. write compact progress deltas to `render/render.json`;
7. on restart, discard lost in-memory job IDs and recompute truth from output
   files, sidecars, and the film plan.

Never poll ten scenes with ten independent full-status responses. The wrapper
should aggregate `queued`, `running`, `done`, `error`, and `cancelled` counts
and include detailed output only for changed or failed scenes.

### `motionforge build --film <film>`

Before building:

- check the adviser loop and stop with advice IDs if unresolved work needs
  director action;
- call `build_film { plan: true }` and print the exact remaining problems;
- require every scene to be rendered and signature-compatible.

Then submit `build_film` with the requested mastering settings, wait for its
terminal state, and save the delivery ID, promoted path, frame verification,
review path, and contact-sheet path.

### `motionforge verify --film <film>`

Run the final evidence pass:

- Motion Studio `get_production_status`;
- `measure_render` on the encoded delivery;
- `inspect_render` at cuts and representative holds only when visual review
  is requested;
- external FFprobe for duration, frame rate, dimensions, codecs, sample rate,
  channels, and file size;
- verify no black/static/suspect-cut or clipping findings are unexplained.

Write `delivery/delivery.json` containing the exact output path, delivery ID,
measured media facts, review findings, sidecar identities, and tool versions.
Do not report success from `build_film` submission alone.

### `motionforge run --manifest <file>`

The resumable convenience command is:

```text
doctor → plateforge plan/generate/review/stage → link → render → build → verify
```

It must stop at the first blocking finding and support:

```text
--plan-only
--resume
--force-plate <id>
--visual-review
--no-build
```

The default output is a final compact JSON summary. Full logs, prompts, raw MCP
responses, and images are available by explicit path or `--verbose`.

## Safety and failure handling

- No destructive deletion or overwrite of user assets.
- No direct writes to `film.json`, `scene.json`, or render sidecars.
- No shell command string built from user prompt text.
- Failed Krea2 work keeps its JSON error and does not mark a plate selected.
- Failed renders leave Motion Studio's staging evidence intact and preserve the
  last promoted delivery.
- A lost job ID is a recoverable state, not evidence of failure or success.
- Warnings are classified and preserved; the wrapper cannot hide them to obtain
  a zero exit code.

## Tests and acceptance

### Unit tests

- manifest schema, path containment, seed validation, and prompt-file hashing;
- Krea2 sidecar reuse, stale-sidecar detection, and explicit `--force`;
- JSONL output shape and redaction of environment values;
- stage copy/link identity and partial-failure recovery;
- render-group state reduction and resume from a lost job ID.

### Integration tests

- fake Krea2 helper that records argument arrays and returns measured JSON;
- fake MCP server or fixture workspace for `get_film`, `render`,
  `wait_for_render`, `build_film`, and review results;
- a small two-scene film that exercises one reused plate, one regenerated
  plate, one failed render, and one successful build;
- Windows PowerShell launcher tests with spaces, non-ASCII paths, multiline
  prompt files, and empty negative prompts.

### Acceptance run

Re-run the ten-scene coastal racing manifest in a clean run directory:

1. identical plates are reused from sidecars;
2. one selected plate can be regenerated without touching the other nine;
3. all selected plates stage and link to scene-local `assets/plate.png`;
4. only missing/stale scenes render;
5. an interrupted run resumes without duplicating GPU work;
6. the film builds and the final delivery passes Motion Studio review,
   `measure_render`, and FFprobe;
7. `delivery.json` is sufficient for another agent to understand the result
   without reading the entire event log.

## Delivery order

1. **P0:** manifest, doctor, path validation, Krea2 sidecar reuse, JSONL logs.
2. **P0:** contact-sheet review, explicit selection, safe library staging.
3. **P0:** long-lived MCP client, link operation, missing/stale render group.
4. **P1:** resumable build/verify and delivery manifest.
5. **P1:** fixture tests, Windows quoting tests, README, and `AGENTS.md`
   cross-reference if the helper becomes a supported repository tool.

## Explicit non-goals

- Replacing Krea2's ComfyUI graph.
- Generating diffusion frames for every video frame.
- Replacing Motion Studio's renderer, film plan, delivery promotion, or review
  policy.
- Automatically judging artistic quality from a contact sheet.
- Uploading or publishing the final film.
