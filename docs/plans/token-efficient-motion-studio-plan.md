# Token-efficient Motion Studio production loop

> **Status: PROPOSED.** Nothing in this document has shipped.
>
> This plan adds Motion Studio capabilities that reduce repetitive agent
> context, tool calls, and duplicated response payloads during plate staging,
> scene rendering, and film assembly. It does not reduce evidence or hide
> warnings. The engine remains the source of truth; the agent receives a
> smaller projection of that truth by default.

## Measured motivation

The completed 180-second NEON APEX run recorded 57,529,602 total agent tokens.
The two relevant production phases accounted for:

| phase | tokens | share |
|---|---:|---:|
| Krea2 plates and asset staging | 18,917,146 | 32.88% |
| Scene rendering and film assembly | 28,427,852 | 49.41% |

The large number was not caused by generating video pixels. It came from the
agent repeatedly carrying a long conversation context while doing repetitive
asset calls, scene status checks, render waits, build checks, and final review.
The response design should make the common path compact while leaving a full
diagnostic path available when something changes or fails.

## Design principles

1. **Summary by default.** Full film documents, prompt text, composition files,
   and raw logs are opt-in.
2. **Deltas by cursor.** A heartbeat returns only changes since the previous
   heartbeat, not the same ten scene states again.
3. **Batches over loops.** Asset linking, composition publishing, scene
   submission, and review should have aggregate operations with per-item errors.
4. **Files for large evidence.** Contact sheets, review JSON, logs, and
   delivery manifests are returned as paths; binary/image payloads are returned
   only when visual inspection is explicitly requested.
5. **One authoritative plan.** The server computes offsets, staleness,
   signatures, advice state, and delivery readiness once and projects the
   result in several compact views.
6. **Failure detail is local.** A successful ten-scene run returns counts and
   hashes; a failed scene returns the full error for that scene only.
7. **Verification is preserved.** Compact output must still prove terminal
   renders, promoted delivery, frame count, audio health, picture review, and
   final media facts.

## P0 — compact projections and cursors

### P0-1 — Add `detail` projections to existing read tools

Extend `get_film`, `list_films`, and `get_production_status` with a validated
`detail` enum:

```text
summary     readiness, revision, offsets, problems, active job, delivery id
scenes      summary plus one compact row per scene
full        current response shape, explicitly requested
```

The default for an agent-facing production loop should be `summary` or
`scenes`; Studio may continue requesting `full` for editing.

The `scenes` row should contain only:

```jsonc
{
  "slug": "s07-night-pursuit",
  "sequence": "Final Run",
  "frames": 900,
  "filmOffset": 3000,
  "state": "rendered",
  "renderVerified": true,
  "outputIdentity": { "bytes": 123, "mtimeMs": 456 }
}
```

Do not include composition HTML/CSS/JS, prompt text, repeated asset metadata,
or unchanged review JSON in this projection.

### P0-2 — Add a production cursor

Every compact production response returns an opaque `cursor` derived from the
film revision, job changes, advice changes, and delivery changes. Accept
`since` on subsequent reads:

```json
{
  "film": "neon-apex-rage-the-dream-mv",
  "detail": "summary",
  "since": "cursor-from-previous-call"
}
```

The response contains `changed`, `removed`, and `cursor`. If nothing changed,
return a small heartbeat with the current cursor and activity timestamp.

The cursor is a transport optimization, not a replacement for files or
sidecars. After a server restart or invalid cursor, return `cursorReset: true`
and a fresh summary.

### P0-3 — Add output-size limits and explicit expansion

Every MCP tool description should state its compact/default response. Large
fields require an explicit `detail: "full"`, `includeLogs: true`, or
`visual: true`. Do not truncate errors; store large errors in a log artifact and
return its path plus a concise structured summary.

Add tests that assert the compact response does not contain raw composition
files, prompt bodies, base64 image data, or repeated full film documents.

## P0 — batch authoring operations

### P0-4 — `use_shared_asset_batch`

Add one typed MCP tool for a list of asset links:

```jsonc
{
  "items": [
    {
      "target": "neon-apex-rage-the-dream-mv/s01-ignition",
      "path": "neon-apex-racing-mv/plates-krea2/s01-ignition.png",
      "as": "assets/plate.png"
    }
  ],
  "detail": "summary"
}
```

Return one row per item with `linked`, `reused`, or `error`, plus aggregate
counts. The operation must preserve the existing asset path sandbox and must
not edit film or scene JSON.

### P0-5 — `write_composition_bundle`

Add a batch authoring tool for shared composition files:

```jsonc
{
  "targets": [
    "film/s01-ignition",
    "film/s02-mountain-lights"
  ],
  "files": {
    "composition.js": "...",
    "styles.css": "...",
    "composition.html": "..."
  },
  "expectedRevisions": {},
  "detail": "summary"
}
```

Validate the bundle once, write each target atomically, and return file hashes
and per-scene results. A failed target must not make the whole operation appear
successful. The full file contents remain available through the existing
explicit read/write tools.

## P0 — render groups instead of per-scene polling

### P0-6 — `render_group`

Add an idempotent render-group tool:

```jsonc
{
  "film": "neon-apex-rage-the-dream-mv",
  "scenePolicy": "missing-or-stale",
  "sceneIds": [],
  "note": "Krea2 coastal racing plates",
  "workers": 1,
  "detail": "summary"
}
```

The server must:

1. compute `planFilm` once;
2. reject structural problems before submitting work;
3. skip current verified scenes;
4. submit only missing/stale scenes;
5. respect the configured one-at-a-time render queue and queue bound;
6. return `groupId`, job IDs, skipped scene IDs, and aggregate counts;
7. persist group intent and membership so a restart can recover from files.

The operation does not change the render engine's serial GPU policy. It removes
agent-side orchestration and duplicate status payloads.

### P0-7 — `wait_render_group`

Add a group wait operation with the existing 50,000 ms maximum:

```json
{
  "groupId": "...",
  "timeoutMs": 50000,
  "since": "cursor-from-previous-wait",
  "detail": "delta"
}
```

Return only scene state changes, terminal errors, and one aggregate progress
row. A timeout is a progress snapshot, never a failure. After a restart, the
tool re-resolves output files and render sidecars instead of pretending old
in-memory job IDs are authoritative.

Add `cancel_render_group` with the same per-job safety semantics as
`cancel_render`.

## P1 — one compact finishing operation

### P1-1 — `finish_film`

Add a director-facing composite operation with a dry-run mode:

```jsonc
{
  "film": "neon-apex-rage-the-dream-mv",
  "audioTargetPeakDb": -2,
  "renderPolicy": "missing-or-stale",
  "verify": true,
  "visualReview": false,
  "detail": "summary"
}
```

The server executes the existing steps, in order:

1. check adviser state;
2. resolve the film plan;
3. render missing/stale scenes through a render group;
4. wait for terminal scene states;
5. build the film;
6. wait for the delivery;
7. run encoded-picture measurement;
8. return delivery/review/contact paths, audio facts, picture findings, and
   production status.

`visualReview: true` may return a single contact sheet or requested cut/hold
frames. It must not silently omit visual review; it only makes the image
payload explicit.

The operation must stop on unresolved advice or blocking plan problems and
return their IDs. It must not create a shortcut around the adviser loop,
promotion policy, frame verification, or `measure_render`.

### P1-2 — `review_render_grid`

Add a single visual review operation for multiple scenes or a built film:

```json
{
  "film": "neon-apex-rage-the-dream-mv",
  "scope": "cuts-and-holds",
  "scenes": [],
  "maxWidth": 960,
  "includeMetadata": true
}
```

Return one contact-sheet image plus compact frame metadata. Keep the existing
`inspect_render` tool for exact frame requests and encoded-file truth. This
operation is only a transport reduction; it must not replace inspection.

## P1 — durable orchestration and telemetry

### P1-3 — durable run groups

Persist a run-group record under the film's job/evidence area containing:

- group ID and film revision;
- requested scene policy;
- scene/job membership;
- submission timestamps and terminal states;
- server/engine version;
- final delivery ID when built.

A restart should be able to answer “what remains?” from the group record plus
the current plan and output sidecars. This complements, rather than replaces,
the existing immutable scene revisions and deliveries.

### P1-4 — agent-economy report

Motion Studio cannot know the LLM provider's token billing, so it must not
claim to measure tokens. It can expose useful proxies in a local
`agent-economy.json`:

- MCP call count by tool;
- compact versus full response count;
- response bytes and binary blocks returned;
- duplicate payload bytes avoided by cursors;
- number of per-scene calls replaced by batch calls;
- wall time and GPU/render time from job records.

Codex or another agent can correlate this report with its own token log. The
report must contain no prompt secrets or API credentials.

## Token-efficient default workflow

After the initial plan, the intended common path is:

```text
get_production_status(summary)
use_shared_asset_batch
write_composition_bundle
render_group
wait_render_group(delta)
finish_film
review_render_grid (visualReview when needed)
```

The agent should not need to call `get_scene`, `get_render_status`, or
`read_composition_file` once per scene in the unchanged common path. Those
tools remain available for a failed scene, a specific revision, or an explicit
deep review.

## Acceptance criteria

Replay the ten-scene, 180-second coastal racing film with the current Motion
Studio render engine:

- compact responses contain no raw prompts, code, base64 images, or repeated
  full film documents;
- asset linking is one batch operation with per-item results;
- composition publication is one bundle operation with per-scene hashes;
- missing/stale scene rendering is one render group;
- waiting returns deltas and aggregate progress, not ten repeated full states;
- a server restart can resume from the persisted group and output sidecars;
- `finish_film` still returns terminal render states, promoted delivery, frame
  verification, audio measurements, review paths, and picture findings;
- `visualReview: true` produces enough encoded frames to inspect cuts and holds;
- no unresolved advice or blocking review finding is hidden;
- the replay's MCP call count and response bytes fall by at least 50% compared
  with the current per-scene orchestration, while final evidence remains equal
  or stronger.

The last criterion is intentionally measured by call/byte telemetry and the
agent's own token log, not guessed from a server-side token counter.

## Implementation order

1. P0 projections, cursors, and output-size tests.
2. P0 batch asset links and composition bundles.
3. P0 render groups, delta waits, and cancellation.
4. P1 `finish_film` dry-run and verified finishing path.
5. P1 review grid, durable groups, and agent-economy telemetry.
6. Replay the NEON APEX fixture, update the two skills and MCP docs, then move
   this plan to `completed.md` only after the acceptance evidence exists.

## Non-goals

- Suppressing warnings or human advice to reduce response size.
- Returning a green status before terminal renders and encoded verification.
- Removing exact-frame inspection or full diagnostics.
- Moving film authority into a shell manifest.
- Adding parallel GPU rendering that risks the local 10 GiB profile.
- Making one opaque “magic” tool that cannot resume or explain a failed item.
