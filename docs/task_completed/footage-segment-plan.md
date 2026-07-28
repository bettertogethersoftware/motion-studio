# Footage segments — real video on the film timeline

> **Status: SHIPPED (unreleased, v0.22).** This file is kept as the design record.
> For how to *use* it, read
> [film-setup.md](../film-setup.md#footage-on-the-timeline-v022); for what shipped,
> see the [CHANGELOG](../CHANGELOG.md).
>
> **Six corrections between this plan and the implementation.** The core claim held
> — this really is one new kind of entry in an ordered list, and `assembleFilm`'s
> body needed nothing — but the cost estimate was light in specific places:
>
> 1. **`normalizeFilm` was the real blocker, not the Studio drag.** The plan warns
>    that a drag in the visual editor rewrites `film.json`. True, but far too
>    narrow: `normalizeFilm` projected every entry to `{ slug }` on *every* save,
>    and `createScene`, `removeScene`, MCP `update_film` and the Studio's 700 ms
>    autosave all route through it. Footage would have validated, persisted once,
>    and vanished on the next unrelated edit. `update_film`'s zod schema stripped it
>    even earlier — it had to become a union, because a loose object shape silently
>    discards whichever half the caller sent.
> 2. **"Nothing else in `assembleFilm` should need to change" was one line
>    optimistic.** Four lines read `s.config`/`scenes[0].config`, and
>    `buildFilmArtifact` above it needs `sceneData[0].config.output` for the
>    finishing encode. Resolved by four segment accessors in `film.js` rather than
>    by touching each site — which is what keeps the design honest.
> 3. **Offsets were computed twice** — in `planFilm` and again in `filmLayout` —
>    so both had to learn footage or they would silently disagree.
> 4. **An all-footage film had no fps, format or signature**, because all three
>    were seeded from the first *scene*. The contract is now established by
>    whichever kind of segment resolves first, with `sceneDefaults` as the fallback.
> 5. **`mixed_scene_audio` fires; it does not stay quiet.** The plan claims silent
>    footage "keeps `mixed_scene_audio` from firing" — the opposite is true, and
>    correctly so: silent footage plus audio-carrying scenes with no master timeline
>    is a real `-c copy` failure. Such a film needs a master timeline, which is the
>    normal shape for it rather than a workaround.
> 6. **Deleting or renaming referenced footage was silent.** The
>    dangling-reference machinery was audio-only, so removing a clip a film plays
>    reported `audioRefs: 0` and succeeded, then the build failed on a missing
>    input. `footageRefs()` is its twin: a delete is refused, a rename repoints.
>
> Two measurements that shaped it: **mp4 reports `nb_frames` in its header but webm
> reports nothing**, so the declared-vs-actual check falls back to
> `probeFrameCount`'s packet scan — which costs ~46 ms even on a 30 s 1080p file, so
> per-plan-call probing needed no cache after all. And building the comparison
> required stating a mapping that did not exist: ffprobe reports a **codec name**
> (`h264`) and a container list (`mov,mp4,…`) where the engine names a **format**
> (`mp4`) whose encoder is `libx264`.

## Why

`film.scenes[]` can hold exactly one kind of thing: a rendered scene.

```jsonc
// film.json today
"scenes": [ { "slug": "title" }, { "slug": "lamb" }, … ]
```

So a film is *only* rendered graphics. There is no way to express "footage, then
a scene, then footage" — which is what almost every film built around a person's
own recording actually is.

The evidence is blunt: a session built a 65 s film interleaving four footage
segments with five rendered scenes, and **`build_film` was never called.** Not
because it failed — because it could not be asked. The assembly was a nine-part
`ffmpeg concat` and a separate audio mux, done in a shell, and the resulting
`film.json` still reads `"audio": []` with five scenes, describing a film that
was never built. The workspace has no record of the actual cut.

For Env B that was an inconvenience. For Env A it is a wall: no asset-preparation
tool gets over it, because the missing thing is not a prepared file — it is a
place to put one.

## The change is smaller than it looks

`assembleFilm()` already does exactly what the prototype did by hand:

```js
const segmentPaths = scenes.map((s) => sceneOutputPath(s.path, s.config));
await concatSegments({ segmentPaths, outputPath: silent, … });   // -c copy
await muxAudio({ videoPath: silent, audioTracks, … });           // master timeline over the whole length
```

Concat a list of signature-matched mp4s, then lay the master audio over the
result. The **only** reason footage cannot participate is that `segmentPaths`
can only be produced from a scene ref. Everything downstream — offsets,
`filmLayout`, overlays, captions, the audio mixer, `audioTargetPeakDb`
correction — is indifferent to where a segment came from.

So this is not new machinery. It is one new kind of entry in an ordered list.

### Correcting an earlier claim

An earlier draft of [transcode-asset-plan.md](../task_completed/transcode-asset-plan.md) said the
prototype's continuous audio spine was "a structure the current film timeline has
no way to describe." **That was wrong.** One `film.audio[]` track at
`startInFrames: 0` spanning the whole film is exactly expressible today, and the
mixer handles it. Only the *picture* order was inexpressible. Worth stating
plainly, because it narrows this plan considerably: **the audio side needs
nothing.**

## Design

A film's ordered list becomes heterogeneous — a **segment** is either a scene or
a piece of footage:

```jsonc
"scenes": [
  { "slug": "title" },                                       // scene, unchanged
  { "footage": "assets/f1.mp4", "durationInFrames": 231 },    // NEW
  { "slug": "lamb" },
  { "footage": "assets/f2.mp4", "durationInFrames": 320 },
  …
]
```

- **Key stays `scenes[]`.** A new `segments[]` would fork every reader (Studio UI,
  `planFilm`, `buildFilmArtifact`, the MCP surface, existing films on disk) for a
  cosmetic gain. An entry with `footage` and no `slug` is unambiguous, and old
  films remain valid without migration. `schemaVersion` stays 1.
- **`footage` is an `assets/`-relative path** under the film, validated exactly
  like `film.audio[]` sources are today (`planFilm`'s `checkAsset`). Same
  sandbox, same error, no new addressing concept.
- **Footage segments are silent.** Video stream only; all sound comes from the
  master audio timeline. This is discipline, not a limitation — it is what the
  prototype did, it keeps `mixed_scene_audio` from firing, and it makes the
  lip-sync contract honest (see below).

### `durationInFrames` is declared *and* verified

The caller states the frame count; the engine probes the file and refuses to
build if they disagree.

Declaring it means `planFilm` computes offsets without probing every file on
every plan call — the same reason scenes declare their duration in config. But a
declaration that is never checked is worse than none, because **every downstream
offset is derived from it**: one wrong frame count silently shifts every
subsequent scene, every caption, and every audio cue in the film, and the render
still "succeeds."

So `planFilm` gains a probe (via v0.21's `probeMedia`/`summarizeMedia`, and
`video.frames` is exactly the number needed) and two new problems:

| Code | When | Message names the fix |
|---|---|---|
| `footage_missing` | file absent or unreadable | the expected `assets/` path |
| `footage_duration_mismatch` | declared ≠ probed frame count | `declared 231 → actual 230` |
| `footage_signature_mismatch` | probed signature ≠ film signature | the `transcode_asset` call that conforms it |

That last message is the point where these four plans close a loop: a plan
problem should name the tool call that fixes it, so an agent can act without
guessing. `sceneSignature()` already produces the comparison string
(`1920x1080@30/mp4/opaque/yuv420p`), and `summarizeMedia` returns every field
needed to build the same string from a probed file.

### What the caller gets back

`planFilm`'s per-entry shape gains `kind: 'scene' | 'footage'` and, for footage,
the probed `codec`/`pixFmt`/`frames`. `filmLayout()` and the `sceneLayout`
returned by `assembleFilm` report footage entries alongside scenes with the same
`filmOffset`/`startSeconds` fields, so *"where does segment 6 start"* is answered
identically regardless of kind. An agent placing a caption or an audio cue should
not have to care.

## Rules it must obey

- **Never re-encode a footage segment.** If it does not match the film signature,
  that is an error naming the fix — not a silent transcode. A film that quietly
  re-encodes one segment has stopped being losslessly assembled, and the whole
  concat guarantee is why scenes share a signature in the first place.
- **Verify before building, not after.** All three problems above are plan-time,
  reported by `planFilm` alongside `scene_not_rendered` and `stale_render`, so a
  caller sees them before paying for a build.
- **The declared frame count is authoritative for layout, and must be true.**
  Same contract as the v0.21 render sidecar: declare, then verify, never trust.
- **Footage carries no audio.** Reject a footage file with an audio stream, with
  a message pointing at `transcode_asset`'s `audio` mode to extract it onto the
  master timeline. Silently dropping it would be worse: the user's voice would
  vanish from a film they can hear it in.
- **Bounded**: footage counts against `MAX_FILM_SCENES`.

## Lip sync is the caller's job, and should stay that way

When a footage segment's picture and the master audio timeline come from the same
source, sync holds only if the caller derives both from the same source offset.
The prototype did this deliberately: each picture segment and its audio span were
cut from identical in-points, so sync is exact *by construction* within a segment.

The engine cannot verify this and should not pretend to. What it can do is make
the arithmetic expressible — which is what plan 1's `words[]`/`sentences[]` frame
timings and plan 3's frame-based `trim` are for. Document the contract in
[film-setup.md](../film-setup.md); do not try to enforce it.

## TODO — all done

- [x] `normalizeFilm` / `validateFilm` — accept footage entries, reject an entry
      with both `slug` and `footage`, or neither.
- [x] `planFilm` — resolve footage paths, probe, emit the three new problems, add
      `kind` to every entry, keep offset math untouched.
- [x] `film.js` — `filmLayout` reports both kinds; `validateScenes` learns that a
      footage entry needs no render and no staleness check.
- [x] `assembleFilm` — `segmentPaths` resolves per entry kind. **Nothing else in
      this function should need to change**; if it does, the design is wrong.
- [x] `ErrorCodes` for the three problems.
- [x] MCP: `update_film` accepts footage entries; `get_film` reports them with
      probed detail. No new tool.
- [x] Studio UI: the film editor shows footage segments in the scene list —
      distinct enough to be obvious, draggable like scenes. **Note:** a drag in
      the visual editor rewrites `film.json`, so this must round-trip footage
      entries or it will silently delete them.
- [x] Tests: a footage entry participating in `filmLayout` offsets; a declared
      duration disagreeing with the probed count; a signature mismatch naming the
      fix; a footage file with an audio stream rejected; an all-footage film; a
      film alternating footage and scenes assembling with `-c copy` and measuring
      the expected total frame count; **an old `film.json` with only `slug`
      entries still loading unchanged.**
- [x] Docs: `film-setup.md` (the segment list, the sync contract),
      `architecture.md` (film model), `mcp-setup.md` (`update_film`),
      `docs/SKILL.md`, `CHANGELOG.md`.

## Deliberately out of scope

- **Trimming footage on the timeline** (`srcIn`/`srcOut` per entry). Tempting,
  and it is how a real NLE works — but it would make `-c copy` impossible at
  arbitrary in-points and drag frame-accurate seeking into the assembler. Prepare
  the file to length with plan 3; the timeline places it.
- **Transitions between segments** (dissolves, wipes). Every one requires
  re-encoding across a seam. A rendered scene between two footage segments is the
  supported answer, and it is a better one — the prototype hid all three of its
  audio splices that way.
- **Speed changes, reversal, freeze frames.** Asset preparation.
- **Nested films.** A film referencing another film is a different feature.
