# `clone_scene` — copy a scene across (or within) films

> **Status: SHIPPED (code-complete, uncommitted) 2026-08-05.** Implemented as
> specified, targeted at v0.27 (CHANGELOG entry under Unreleased). Full engine
> suite: 927 tests, 923 pass, 0 fail, 4 pre-existing environmental skips.
> Delivered by delegation (architect: Fable 5; three Opus 5 workers: engine
> core, Studio, docs). Deviations accepted in review: clones mkdir `assets/`+
> `out/` for scaffold parity; failure cleanup only removes folders the call
> created; no `requirePrereqs()` (pure-filesystem, like `sync_shared_files`);
> `sceneSignatureWarnings` exported for Studio reuse. Studio endpoint takes
> `{toFilm?, name?}` (no `slug` — agent-side concern) and skips output
> seeding (a clone's settings are the source's). Follow-up for the human:
> commit, and re-copy `docs/SKILL.md` to installed client skill directories.
>
> **Validated in a real production 2026-08-05** — the `signal-path` music video
> (180.000 s, 24 scenes, `data/workspaces/default/films/signal-path`) was built
> by authoring 4 archetype scenes and cloning the other 20. All 20 clones
> succeeded with zero warnings. The 7 clones of the chorus archetype each
> carried its `emblem.png` — the case no other MCP tool can perform, since
> nothing else returns asset bytes. Copy-not-hardlink was confirmed on disk:
> 8 copies of the emblem, **8 distinct inodes, `links=1` each**, identical
> checksums; a hardlink would have aliased eight *live* scenes to one file.
> `clonedFrom` recorded `revisionId: null` throughout — correct, the sources
> were unrendered when cloned — and `agent: null`, correct for a direct store
> caller with no `MOTION_STUDIO_AGENT` set. The film built with 0 review
> findings at exactly 5400 frames.
>
> Design settled in session (architect: Fable 5; original proposal: Opus 5).
> Supersedes and retires the "block library" idea: curated reusable
> components were judged not worth the parameterization + curation cost.
> Evidence: `harmonia-mv` has ten bespoke `composition.js` files despite
> film-setup.md prescribing the shared-engine pattern — agents reuse by
> *copying*, so make copying safe and complete instead of building a
> curation shelf.

## Why

An agent can see every film in its workspace (`list_films`, and every
`"<film>/<scene>"`-addressed tool), but there is no copy operation:

- `sync_shared_files` copies *source files* — and already works cross-film
  (undocumented; `store.syncSharedFiles` never checks film identity) — but
  never touches `scene.json`, so the clone renders at the wrong
  duration/dimensions unless the agent remembers `update_scene_config`.
- **Binary assets have no MCP path at all.** Nothing returns asset bytes
  (`list_assets` is metadata; `write_asset_file` is base64 *in* only), so a
  scene that depends on `assets/` arrives with dead references. This is the
  core value of the tool: the engine can just copy the files.
- Vendored 3D libraries (`three.min.js` etc.) live per-scene and need
  re-attachment.

Today's working recipe is a four-step dance (`create_scene` →
`update_scene_config` → `sync_shared_files` → re-attach assets/libraries) and
steps 2 and 4 are the ones an agent forgets. `clone_scene` is that sequence as
one atomic engine operation.

## Decisions (settled — do not relitigate in implementation)

| decision | resolution |
|---|---|
| block library / param schemas / curation | **rejected** — verbatim clone only; clones diverge, which is correct for creative work |
| `revision:` param (clone an archived take) | **deferred** — `use_scene_revision` then `clone_scene` is the two-step workaround; add later if demanded |
| asset storage in the clone | **copy, never hardlink.** Revisions hardlink because revisions are immutable; clones are live scenes. Hardlinked assets would alias source and clone — an in-place asset mutation would silently change both. Disk cost is bounded by the 25 MB asset cap. |
| provenance | `clonedFrom` in the clone's `scene.json`, recording the source's *current revision id* when one exists — pointing at a scene that has since been rewritten answers less than it appears to |
| signature mismatch vs destination film | **warn, don't fail** — clone-then-reframe is legitimate; agent fixes with `update_scene_config` |
| same-film clone | allowed ("give me another one of these") |
| cross-workspace | out of scope — MCP `qualifyScene`/`qualifyFilm` keep ids workspace-bound; nothing to do |
| Studio duplicate button | **in scope** — hand-copied folders are what produces `unlisted` scenes (`listScenes` tolerance); a proper action removes a real footgun |

## Contract

### MCP tool

```
clone_scene {
  from:   "<film>/<scene>"        source, any film in the workspace
  toFilm: "<film>"                destination film (may equal source film)
  name?:  string                  default: source name + " (copy)"
  slug?:  string                  default: derived from name
}
→ ok {
  scene: "<toFilm>/<slug>", name, path, config,
  copied: { files: <count>, bytes: <total>, assets: <count> },
  warnings: [ ... ]               signature mismatch etc.; [] when clean
}
```

Errors: `scene_not_found` (source), `film_not_found` (destination),
`scene_already_exists` (explicit `slug` already taken), `invalid_id`.

### Store method

`store.cloneScene(sourceSceneId, targetFilmId, { name?, slug? })`

1. Read source scene + config; read destination film.
2. Resolve slug: explicit `slug` (taken → `SCENE_ALREADY_EXISTS`), else
   slugify(name) auto-deduped with `-2`, `-3`, … suffixes.
3. Copy the source tree into the new scene folder using the shared walker
   (below): everything except `out/` (per the source config's `output.dir`),
   `revisions/`, `.staging`, `node_modules`, dotfiles, `.tmp-` files — and
   except `scene.json`, which is written separately in step 4. This brings
   composition files, `frame-api.js`, `assets/`, and any vendored library
   builds in one pass; `libraries`/`libraryBuilds` in the copied config stay
   truthful because the referenced files came along.
4. Write the clone's `scene.json`: the source config wholesale (all fields —
   fps/dimensions/duration/audio/output/libraries/libraryBuilds), with `name`
   replaced and `clonedFrom` added:
   `{ scene: sourceSceneId, revisionId: <current revision id or null>, at: <ISO>, agent: currentAgentId() }`.
   Atomic write, same as `updateConfig`.
5. Append `{ slug }` to the destination film's play order (skip if a
   folder-only scene with that slug was already listed — same tolerance as
   `createScene`). This goes through `updateFilm`, so Studio SSE events fire
   for free.
6. Compute warnings: fps/width/height differing from the destination film's
   `sceneDefaults` (concat-compatibility), in the spirit of
   `structureWarnings`.

On any failure before step 5, remove the partially-written clone folder —
never leave a half-scene that would surface as `unlisted`.

### Shared tree-copy (revisions.js)

Refactor, don't duplicate: extract `snapshotSource`'s walk/filter into an
exported `copySceneTree(srcPath, destDir, { outDirName, excludeFiles?, linkThreshold })`
where `linkThreshold: Infinity` means always copy.
`snapshotSource` calls it with the existing `LINK_THRESHOLD`; `cloneScene`
calls it with `Infinity` and `excludeFiles: ['scene.json']`. Behavior of
revision snapshots must be byte-identical to before.

### Config schema (scene.js)

`validateConfig` gains a permissive optional check for `clonedFrom`
(object with string `scene`, `revisionId` string|null — reject garbage,
tolerate absence). `updateConfig`'s ALLOWED set does **not** include
`clonedFrom` (provenance is engine-stamped, not agent-editable).

### Studio

- `POST /api/films/:fid/scenes/:slug/clone  { toFilm?, name? }` → same store
  method; `toFilm` defaults to `:fid`.
- Film page: a "duplicate" action on the scene row (beside where revisions
  surface), same-film by default. Minimal UI — name prompt is enough.

## Tests (`engine/test/clone-scene.test.js`)

Within-film clone; cross-film clone; config fidelity (duration/fps/audio/
output survive exactly); assets copied byte-equal; **no aliasing** (mutate a
source asset after cloning — the clone's bytes must not change); `out/` and
`revisions/` excluded; play-order append + SSE-visible film update; slug
auto-dedupe; explicit-slug conflict errors; signature-mismatch warning;
three.js scene clones renderable (vendored build + `libraryBuilds` intact);
`clonedFrom` recorded with the source's current revision id when revisions
exist and `null` when not; cleanup on failure (no half-scene left);
source-not-found and destination-film-not-found. Plus: revisions suite still
green after the `copySceneTree` refactor. Studio endpoint test in the studio
suite. MCP registration smoke in `mcp.test.js` if that is where other tools
assert registration.

## Docs (same change, per project rule)

- `docs/mcp-setup.md` — tool reference entry.
- `docs/film-setup.md` — a short "reusing an existing scene" section:
  `clone_scene` first, and the note that `sync_shared_files` works
  cross-film (it always did; now it's documented).
- `docs/user-guide.md` — the duplicate button.
- `docs/architecture.md` — one paragraph where scene lifecycle is described.
- `docs/CHANGELOG.md` — entry following the file's existing convention.
- `docs/SKILL.md` / `docs/SKILL-shell.md` — only if they enumerate tools;
  flag that client skill copies need re-copying.
- `README.md` — only if the tool list there warrants it.

## Non-goals

No block store, no parameter schemas, no manifests, no human curation
gate, no shared-engine indirection, no cross-workspace reach, no
`revision:` param (yet), no film-level clone (a film clone is N scene
clones plus a film.json copy — separate decision, not taken).

## Verification note

The running MCP server loads committed code at startup; a new tool will not
appear on the live connection until restart. Verify via direct `node` engine
calls and the test suite, not the MCP session.
