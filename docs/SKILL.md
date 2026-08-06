---
name: motion-studio-video
description: Use this skill whenever the user wants to create, edit, preview, render, or assemble a code-driven video with Motion Studio MCP, including motion graphics, GIFs, transparent overlays, generated audio, and supplied-media workflows that use probe_asset, transcribe_asset, transcode_asset, seekVideo, or signature-matched footage on a film timeline. Also use it when acting as the AI director in Motion Studio's production loop — checking or resolving human advice (check_human_advice, resolve_human_advice), working with scene revisions or archived deliveries (list_scene_revisions, use_scene_revision, list_deliveries), reporting production status, or responding to "the human left advice / prefers an older version" requests. Use the separate shell skill only for media operations the MCP schema cannot express.
---

# Motion Studio MCP production guide

Motion Studio authors deterministic HTML/CSS/JS compositions and renders them
through a workspace → film → scene model. The MCP tools are the production
interface: use them to create documents, ingest media, author compositions,
preview, render, inspect, and assemble the final film.

You are the **director** (v0.23): production runs unattended, every promoted
scene render is kept as an immutable revision, every build as an immutable
delivery, and the human watches in the Studio and leaves durable advice you
reconcile at checkpoints — see "The adviser loop" below.

This guide is procedural. The live MCP tool schema is the argument-level source
of truth. Before a call, use the tool name and fields actually exposed by the
client; never invent an argument from memory or substitute a similarly named
filesystem operation.

## Non-negotiable rules

1. **A film is always the container.** Even a five-second animation is one film
   with one scene. Film ids are bare slugs such as `launch-film`; scene ids are
   `<film>/<scene>` such as `launch-film/intro`.
2. **Use MCP document tools for Motion Studio state.** Do not hand-edit
   `film.json` or `scene.json`. Use `update_film` and `update_scene_config`.
3. **Animation is a pure function of frame.** Read the Frame API, register with
   `MotionStudio.registerComposition(fn)`, and never use wall-clock animation,
   `Date.now`, `setTimeout`, `setInterval`, `requestAnimationFrame`,
   `Math.random`, CSS animations/transitions, `THREE.Clock`, or library render
   loops.
4. **Treat returned warnings and plan problems as work, not commentary.** Fix
   every unexplained `warnings`, `structureWarnings`, `problems`,
   `encodingWarnings`, audio warning, and blocked delivery before proceeding.
5. **Preview the composition and inspect the encoded file.** A successful write,
   lint, or render does not prove that the requested subject is visible, text is
   correct, motion reads, audio covers the timeline, or the final encode is
   healthy.
6. **Keep renders hermetic.** Composition dependencies must be local under the
   scene or film `assets/`. Do not hotlink scripts, fonts, images, audio, or
   video.
7. **Never claim completion from submission.** Wait for every asynchronous job
   to reach a terminal state and confirm the output and review evidence.
8. **Honour the adviser loop.** Check human advice at your checkpoints, resolve
   every item with a recorded outcome, and never wait or poll for a human
   response — there is no approval gate anywhere in Motion Studio.

If Motion Studio tools such as `get_workspace`, `create_film`,
`write_composition_file`, and `render` are absent, say that Motion Studio is not
connected in this task. Do not imitate the MCP workflow with arbitrary file
writes. A shell-capable agent may instead load the separate
`motion-studio-video-shell` skill when the request needs operations outside the
MCP surface.

## Current MCP surface

Use this map to choose the right tool. Read the live schema before calling it.

- Workspace and documents: `get_workspace`, `get_capabilities`, `list_films`,
  `create_film`, `get_film`, `update_film`, `remove_film`, `create_scene`,
  `clone_scene`, `get_scene`, `update_scene_config`, `remove_scene`
- Composition authoring: `read_composition_file`, `write_composition_file`,
  `write_composition_bundle`, `sync_shared_files`, `add_library`
- Assets and supplied media: `write_asset_file`, `list_assets`, `probe_asset`,
  `transcribe_asset`, `transcode_asset`, `rename_asset`, `delete_asset`,
  `list_shared_assets`, `use_shared_asset`, `use_shared_asset_batch`
- Audio: `list_vendors`, `list_voices`, `synthesize_speech`,
  `synthesize_music`, `synthesize_sfx`, `preview_audio`
- Preview and delivery: `capture_preview_frame`, `capture_preview_frames`,
  `render`, `render_still`, `build_film`, `inspect_render`, `measure_render`,
  `review_render_grid`
- Render groups and finishing: `render_group`, `wait_render_group`,
  `cancel_render_group`, `finish_film`
- Jobs and diagnostics: `get_render_status`, `wait_for_render`,
  `list_render_jobs`, `get_logs`, `cancel_render`
- Human advice (the adviser loop — see the protocol below):
  `check_human_advice`, `acknowledge_human_advice`, `begin_advice_work`,
  `resolve_human_advice`, `list_human_advice`
- Revisions and deliveries: `list_scene_revisions`, `use_scene_revision`,
  `list_deliveries`
- Progress: `report_agent_activity`, `get_production_status`
- Reference resource: `motion-studio://reference/frame-api`

Deletion through `remove_film`, `remove_scene`, or `delete_asset` is destructive.
Get explicit user confirmation before deleting material.

## The adviser loop: you direct, the human advises

Motion Studio's production model (v0.23) makes **you the director**. The
human watches the evolving film on its one Studio page and leaves
plain-language advice on whatever they can see — the film, a sequence, a
scene, a supplied footage clip, an audio item, a caption, an overlay, an
exact moment. Advice is durable: it survives restarts and waits for you.
There is **no approval gate**; never wait or poll for a human response.

Advice arrives with the structural target already resolved (`type` +
`scene` slug, `sequence` label, or `itemId` for a footage/audio/caption/
overlay item), so you never have to guess what they meant by "the outro" —
and a `footage` target names a specific clip by its stable segment id, which
survives reordering the play order.

**Checkpoints.** Call `check_human_advice` (read-only, oldest first) at:

1. task start (before planning new work),
2. after publishing your scene/sequence plan,
3. before expensive generation,
4. after completing each scene revision,
5. before `build_film`,
6. before reporting completion.

No advice → continue immediately. When advice exists:

- `acknowledge_human_advice` what you received (the human then sees "AI
  received it" instead of silence).
- `begin_advice_work` before acting — a renewable TTL lease that stops a
  second agent duplicating the work; an expired lease is the crash recovery.
- Compare the advice's `observation` (the exact delivery/revision the human
  watched) with current state before acting; rebase compatible advice onto
  the current revision, or ask with outcome `needs-clarification`.
- `resolve_human_advice` every item with an outcome and a one-or-two-sentence
  explanation the human will read: `applied`, `partially-applied`,
  `not-applied` (you considered it and chose otherwise — say why),
  `superseded`, or `needs-clarification` (not terminal; the human answers
  with linked follow-up advice). Link the `revisionIds` you created or
  selected and the resulting `deliveryId`. Never silently ignore advice.
- One change may answer several compatible items — resolve each, listing the
  others in `combinedAdviceIds`. Conflicting advice is yours to judge as
  director; record the judgment per item.
- The human can **withdraw** an item from the Studio (v0.23.2). A withdrawn
  item is already terminally resolved with `withdrawnByHuman: true`, so it
  simply stops appearing in `check_human_advice` — do not act on it, and do
  not treat its disappearance between checkpoints as an error.

**Prefer-revision advice** (`suggestedAction: "prefer-revision"`) means the
human previewed an older take and asked for it back. Normally answer with
`use_scene_revision` (repoints the live output; regenerates nothing; keeps
newer history), then `build_film`, then resolve linking that revision. You
may instead derive a better take from it, or decline with a recorded reason.

**Keep the human's progress line honest.** `report_agent_activity` with a
short present-tense phrase ("Creating scene demo-shot", "Building film")
whenever your activity changes and every minute or two during long work.
Pass `note` on `render` calls — it becomes the version card the human reads.
`get_production_status` tells you whether anything is unresolved or unbuilt
before you report completion. It is compact by default and returns a
`cursor` (v0.26): when you check status repeatedly — waiting out a render,
re-checking after advice — pass the previous `cursor` back as `since` and an
unchanged film costs a two-line heartbeat instead of a full re-read;
`detail: "scenes"` adds one compact state row per segment when you need
per-scene readiness without the whole film document.

## The correct end-to-end workflow

### 1. Inspect the workspace and the brief

Start every task by discovering what already exists — and what the human said
while you were away:

```json
get_workspace {}
get_capabilities {}
check_human_advice {}
list_films {}
list_shared_assets {}
```

Unresolved advice comes first (see "The adviser loop" above). No advice means
continue immediately — never wait for a human.

Use `get_film` and `get_scene` before changing an existing project:

```json
get_film { "film": "launch-film" }
get_scene { "scene": "launch-film/intro" }
read_composition_file {
  "scene": "launch-film/intro",
  "path": "composition.js"
}
```

If the user says they supplied media, check `list_shared_assets` before asking
them to resend it. The workspace library is the MCP entry point for large user
files.

Probe media before designing around it:

```json
probe_asset { "path": "recordings/interview.mp4" }
```

When speech is present, transcribe before choosing durations or edit points:

```json
list_vendors { "capability": "transcription" }
transcribe_asset {
  "path": "recordings/interview.mp4",
  "language": "en",
  "words": true
}
```

Use `sentences` as edit blocks, `words` for word-synchronised graphics, and
`speechRanges` for safe cuts. `rawSegments` are decoder windows, not edit
points. Do not quote low-confidence transcription on screen without review. An
English-only model rejects an explicit non-English language; choose a
multilingual model or omit `language` for auto-detection.

### 2. Create the film before its scenes

Resolve the requested platform before creation. Save only the deliverables the
brief names:

```json
create_film {
  "name": "Launch Film",
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "durationInFrames": 150,
  "deliverables": ["youtube-16x9", "shorts-9x16"]
}
```

Omit `deliverables` when the user did not request a platform version. Omitted
fps, dimensions, duration, and worker counts use user settings; read the
response instead of assuming factory defaults. When dimensions are omitted and
deliverables are selected, the first selected deliverable supplies the master
canvas.

Create one short scene per shot or coherent visual section:

```json
create_scene {
  "film": "launch-film",
  "name": "Intro",
  "durationInFrames": 150
}
```

Scene dimensions and fps should normally inherit the film defaults. Diverging
them can make lossless film assembly impossible. If `create_scene` or
`update_scene_config` returns `structureWarnings` for a long scene, split it
before authoring.

**Label the story structure with sequences (v0.23).** Once the scene plan is
settled, put narrative labels on the play order and record each label's
intent — this is how the human navigates the film page's tree and timeline,
and how their advice can target "the Demo sequence" instead of guessing at
slugs:

```json
update_film {
  "film": "launch-film",
  "scenes": [
    { "slug": "intro", "sequence": "Intro" },
    { "slug": "feature-1", "sequence": "Demo" },
    { "slug": "feature-2", "sequence": "Demo" },
    { "slug": "outro", "sequence": "Close" }
  ],
  "sequences": {
    "Intro": { "intent": "Hook the viewer and land the name" },
    "Demo": { "intent": "Show the core workflow end to end" },
    "Close": { "intent": "Call to action" }
  }
}
```

Sequences are presentation only — they render nothing and own no files, so
relabeling is always safe. Consecutive segments sharing a label form one
band; footage segments take labels too. On the human's film page these
become the tree they navigate by and the band above the timeline, so a film
with sensible sequence names is a film they can give you precise advice on.

Choose scene output through validated config:

```json
update_scene_config {
  "scene": "launch-film/intro",
  "patch": {
    "output": {
      "format": "mp4"
    }
  }
}
```

For alpha, use `webm`, `prores`, or `png-sequence`, set
`output.transparent: true`, and leave the composition background transparent.
MP4 and GIF do not support transparent output here.

### 3. Ingest and prepare assets through MCP

Use `write_asset_file` for small base64 assets only. It writes beneath the
target's `assets/` and rejects decoded files above 25 MB.

Use the workspace library for large files:

```json
use_shared_asset {
  "target": "launch-film/intro",
  "path": "plates/city.png",
  "as": "assets/city.png"
}
```

Reference it from the scene as `assets/city.png`. Film master audio, overlays,
and timeline footage belong in the film's own assets; target the film id rather
than inventing a spare scene.

Linking one plate per scene across a whole film? One
`use_shared_asset_batch { items: [{target, path, as}, …] }` call replaces the
per-scene loop — items succeed or fail independently with per-item rows.
Likewise `write_composition_bundle { targets, files }` writes the same
composition files to many scenes in one validated call (v0.26).

`probe_asset` reads media. `transcribe_asset` hears it. `transcode_asset` changes
it. Do not ask the user to perform a conversion that the MCP schema supports.

#### Video inside a composition

H.264 and HEVC commonly cannot be decoded by the render browser. If
`probe_asset` warns about browser decoding, transcode to VP9/WebM and seek it by
frame:

```json
transcode_asset {
  "target": "launch-film/intro",
  "from": "recordings/interview.mp4",
  "to": "assets/interview.webm",
  "mode": "video",
  "audio": false,
  "video": { "gop": 10 }
}
```

Inside an async registered composition, use:

```js
await seekVideo(videoElement, sourceStartSeconds + frame / fps, { fps });
```

Never call `video.play()`. Playback is wall-clock based and breaks parallel
rendering.

#### Supplied footage on the film timeline

Footage shares the play order with scenes but **is not a scene**: it has no
slug, no folder and no config, so it never appears in a scene listing.
`get_workspace` counts it separately (`scenes` and `footage`), and the workspace
manifest resource lists scenes only. To see the whole play order — scenes and
clips in cut order — read `get_film`. Before v0.27 the scene listings described
footage anyway and produced one `<film>/undefined` row per clip; if you are
holding a cached listing from an older engine, ignore rows with no name.

For footage that should sit beside rendered scenes, conform it to the film's
actual encode signature:

```json
transcode_asset {
  "target": "launch-film",
  "from": "recordings/interview.mp4",
  "to": "assets/interview-prepared.mp4",
  "mode": "video",
  "matchFilm": "launch-film",
  "audio": false
}
```

Insert the returned `timelineSegment` into the complete `scenes` array without
rewriting it:

```json
update_film {
  "film": "launch-film",
  "scenes": [
    { "slug": "intro" },
    {
      "footage": "assets/interview-prepared.mp4",
      "durationInFrames": 231,
      "derivedFrom": {
        "asset": "library:recordings/interview.mp4",
        "transcodeMeta": "assets/interview-prepared.mp4.transcode.json"
      }
    },
    { "slug": "outro" }
  ]
}
```

The example values illustrate the response shape; use the exact returned
object. The `derivedFrom` link lets the planner detect replaced or changed
source media. Before building, `get_film` or `build_film { "plan": true }` must
show `derivedFrom.sourceVerified: true`. A `footage_source_changed` problem
requires re-transcoding the source.

Timeline footage must be silent. Extract wanted speech/music separately with
`transcode_asset` in `audio` mode, then place the resulting WAV on the film
master audio timeline. Prefer exact frame trims. `trim.durationInFrames` means
source frames; it is safer than a seconds duration when later offsets depend on
an exact frame count.

### 4. Author against the Frame API

Read the Frame API before writing the first composition, in this order:

1. `references/frame-api.md` when installed beside this skill
2. MCP resource `motion-studio://reference/frame-api`
3. `read_composition_file` for the scaffolded `frame-api.js`

Every scene scaffold loads `frame-api.js` before `composition.js`. Keep that
ordering.

Use `write_composition_file` for scene-relative HTML, CSS, and JavaScript:

```json
write_composition_file {
  "scene": "launch-film/intro",
  "path": "composition.js",
  "content": "MotionStudio.registerComposition((frame) => { /* frame-driven state */ });"
}
```

The authoring contract:

- Register exactly through `MotionStudio.registerComposition(fn)`. Make the
  function `async` and await image, font, or video readiness when needed.
- Use `interpolate`, `interpolateColors`, `spring`, `Sequence`, `Loop`,
  `particles`, and `MotionStudio.random(seed)` from the supplied Frame API.
- Reset all mutable DOM/canvas state from the frame value on every call.
- Hide section containers by default. Let the owning `Sequence` make them
  visible. Do not use `classList.add/remove` inside the frame function.
- Pair every `ctx.save()` with `ctx.restore()` and reset canvas styles that
  could leak into later drawing.
- Preload local images and fonts before registering the composition.
- Size layout against the frame, not against a remembered number: `vw`/`vh`/`%`,
  `var(--ms-width)`, and the `--ms-safe-title-*` / `--ms-safe-caption-*`
  rectangles the engine sets on every page (`MotionStudio.safeArea()` in JS).
  Keep titles and captions inside their safe rectangles — those are the same
  guides the review contact sheet draws. A composition welded to 1920×1080 can
  only ever be delivered by cropping.
- Never load a CDN dependency. Use assets or `add_library`.
- Fix every returned lint warning. A successful write still writes files when
  warnings are present.

Lint is not visual review. It cannot detect a missing product, incorrect copy,
an always-visible layer, a hidden element, bad crop, or mathematically wrong
chart.

For 3D, vendor the supported library instead of using a CDN:

```json
add_library {
  "scene": "launch-film/intro",
  "library": "three",
  "addons": ["loaders", "postprocessing"],
  "scaffold": true
}
```

The generated starter is frame-driven. Do not reintroduce
`requestAnimationFrame`, clocks, or wall-clock particle systems. Model loaders
also require the server's local-fetch setting, as reported by the tool.

For repeated scene structures, keep one shared `composition.js` and small
per-scene data files. After fixing the shared code, propagate it:

```json
sync_shared_files {
  "sourceScene": "launch-film/intro",
  "targetScenes": ["launch-film/body", "launch-film/outro"],
  "files": ["composition.js"]
}
```

Then re-render every affected scene. Synchronising source does not invalidate
or refresh old renders automatically. Targets may be in another film; this
works across films.

To start a *new* scene from one that already works, use `clone_scene { from,
toFilm }` rather than scaffolding and re-authoring. It is the only operation
that copies binary `assets/` between scenes, and it carries the composition
files, vendored 3D library builds and the whole `scene.json` with it. Rendered
output and revisions are not copied, so render the clone; check the returned
`warnings` for an fps/size mismatch against the destination film and resolve it
with `update_scene_config` before building.

### 5. Visually verify the composition before rendering

Use one plural capture call for representative frames and every sequence
boundary:

```json
capture_preview_frames {
  "scene": "launch-film/intro",
  "frames": [0, 29, 30, 89, 90, 149]
}
```

Use `count: 5` only when uniform coverage is enough. The maximum is 24 frames.
Do not call `capture_preview_frame` repeatedly; each call launches and prepares
a new browser.

Actually inspect the returned images. Check:

- the subject requested by the user is visible, correctly cropped, and
  recognisable;
- elements appear only in their intended section;
- titles, captions, numbers, and claims are correct;
- first/last frames and sequence boundaries are intentional;
- nearby frames change in the intended way;
- supplied and generated images have passed human visual review.

Never invent product statistics, ratings, certifications, or user counts.

**Exporting a still is a different job from inspecting one.** `render_still {
scene, frame }` runs the same single-frame render path but *writes* a PNG into
the scene's `out/` dir and returns `{ outputPath, bytes, frame }` — no image
comes back inline, so it proves a file exists, not that the picture is right.
Use it when the still itself is wanted output (a thumbnail, a poster frame, key
art); use `capture_preview_frame`/`capture_preview_frames` when you need to look
at the image. `outputFilename` must be a bare `.png` name inside `out/`
(default `still-<frame>.png`); a path separator or any other extension is
`path_not_allowed`. It takes a scene, never a film, and it archives no revision
— rendering a still is not rendering the scene.

### 6. Build and audition audio before picture rendering

Call `list_vendors` before speech, music, or transcription. Prefer the user's
explicit request, then their starred `favoriteVoices` or `favoritePrograms`,
then the configured default. Omit `vendor` to use the configured available
preference chain; if the response says it fell back, report that.

For narration, synthesize before finalising timing:

```json
synthesize_speech {
  "target": "launch-film",
  "text": "Welcome to the launch.",
  "sentenceTimings": true,
  "mode": "attach",
  "startInFrames": 0
}
```

Use the returned `durationInFrames` and sentence timings. Film targets place
audio on the absolute master timeline; scene targets place audio in that
scene's config. When cue frames depend on repeatable clip timing, pass
`deterministic: true` only to a vendor that reports support for it (currently
Piper or ElevenLabs); other vendors return a warning rather than pretending to
honour it.

When a film has a master audio timeline, `build_film` uses it in place of
per-scene audio; it does not sum both timelines. Put the authoritative long-form
mix on the film and preview that target.

For generated music, pass either a note `tracks` spec or a `progression` spec,
never both:

```json
synthesize_music {
  "target": "launch-film",
  "spec": {
    "bpm": 96,
    "progression": ["D", "A", "Bm", "G"],
    "style": "pad-ballad",
    "bars": 8
  },
  "mode": "attach",
  "gainDb": -10,
  "duck": true
}
```

The returned WAV duration includes its reverb tail;
`musicalDurationSeconds` is the note length. When repeating a short score, step
new instances by musical duration so one tail can decay under the next entry.

Repository policy: although the current `synthesize_sfx` schema exposes
`chime`, `whoosh`, `shimmer`, `thud`, and `tone`, agents must not use the first
four cue types. Use `tone` only, or ingest an approved sound asset.

Audition every real audio timeline:

```json
preview_audio { "target": "launch-film" }
```

If it returns `stillRunning`, wait on its `jobId`. Fix:

- `clipping: true`;
- non-empty `balanceWarnings`;
- unintended `mix.silentTailSeconds`;
- digital-silence entries (`null`) in `mix.envelopeDb`;
- speech/music coverage that does not match the picture.

`balanceWarnings` compares clip MEANS, which is the wrong statistic for a
one-shot: a transient's mean is dragged down by its own decay. Measured on a
real film, it flagged a cue that was clearly audible and stayed silent about one
that was not. Before acting on it for a short cue, measure the cue's actual
contribution — peak the song alone and the mix in the same window at the cue and
subtract the song's gain (>= 2 dB = audible). Fix what that condemns, not what
the warning lists.

Track gains add; they are not averaged. Measure source levels and balance with
`gainDb`, fades, trims, and `duck`. Do not reuse a gain template from another
film. If the MCP client cannot play the returned WAV, use the measurements as
the minimum check and give the user the returned `outputPath` for a listening
review before a long render.

To correct levels after auditioning, edit the saved timeline in place instead of
restating it:

```json
update_film { "film": "launch-film", "audioGainOffsetDb": -2 }
update_film { "film": "launch-film", "audioPatch": [{ "id": "hit-c1", "gainDb": -4.5 }] }
```

`audioGainOffsetDb` shifts every track at once, so a balance you already
verified survives — that is the fix when a build reports clipping. `audioPatch`
changes named tracks only. Both beat re-sending `audio` wholesale, which on a
long timeline is where a silent transcription slip reverts a track.

**Syncing picture to music:** build `MotionStudio.beatGrid({bpm, phase, fps,
startSeconds})` from a MEASURED grid and read `pulse`/`barPulse`/`frameOfBeat`
off it. Never step by a constant number of frames — a beat is only an integer
by coincidence (140 BPM at 30fps is 12.857), and never trust a requested tempo
(a loop asked for 140 BPM measured 105).

**Placing a one-shot (an impact, riser, downlifter, stab) on a beat:** probe it
first with `probe_asset { path, audioPeak: true }` and place it by
`peakAtSeconds`, not by its start. A cue's transient is usually not at 0 s —
measured across five generated cues it ranged from 0.00 s to 4.31 s — so start
the track `peakAtSeconds * fps` frames **early** and the hit lands on the beat.
Independently generated material also never phase-locks to an existing song, so
layer sustained beds and placed one-shots; a second rhythmic groove will flam.

### 7. Render scenes and wait correctly

For a cheap motion draft:

```json
render {
  "scene": "launch-film/intro",
  "proxy": { "scale": 0.5, "frameStep": 2 }
}
```

A proxy is serial, silent, skips preflight, preserves pacing, and writes a
separate `.proxy` output. It is not the deliverable.

For the full scene, pass a one-line `note` — it becomes the version card the
human reads in the film page's version list — and link any advice this
render answers:

```json
render {
  "scene": "launch-film/intro",
  "note": "slower title fade per advice",
  "adviceIds": ["adv-…"]
}
```

Normally omit `workers` so the user's setting applies. Use `frameRange` for a
deliberate partial test, not as a finished scene. Preflight is enabled for
eligible full renders; disable it only when an immediately preceding preview
already covered the same frames.

Wait on submitted jobs:

```json
wait_for_render {
  "jobIds": ["<job-id>"],
  "timeoutMs": 50000
}
```

`timeoutMs` is capped at 50,000 ms. `timedOut: true` is a progress snapshot, not
a failure; call `wait_for_render` again. Check each job independently. A server
restart can turn an in-memory job id into `not_found`, so confirm work by the
output and document plan rather than trusting an old id.

**Rendering many scenes of one film? Use the group operation instead of a
per-scene loop** (v0.26): `render_group { film }` submits exactly the
missing/stale scenes in one call and returns a `groupId`;
`wait_render_group { groupId, since }` aggregates progress (pass the previous
`cursor` as `since` for heartbeat/delta responses), reports full detail only
for failed scenes, and its `done` is computed from output files — it survives
server restarts. Re-running `render_group` after a partial submission is the
designed resume. `cancel_render_group` aborts the lot. The group's record
under `<film>/render-groups/` completes itself as the run ends (how each
member finished, when the group did, and the `deliveryId` once a build
succeeds) — read it for run history, never for whether work remains: that is
always the current plan's answer.

On `error`, call `get_logs` and read the structured error. On `done`, inspect:

- `outputPath`;
- `revisionId` — the immutable archive of this take (v0.23); keep it for
  advice resolutions and note it when reporting;
- `encodingWarnings`;
- final `audio.clipping` and `audio.balanceWarnings`;
- `review.reviewPath`, `review.contactPath`, and review warnings;
- `reviewArtifactWarning`, if present.

Do not call a render complete while any of those indicates unresolved work.
A full-scene render automatically archives a revision and makes it current;
partial `frameRange` renders and proxies deliberately do not.

### 8. Inspect the encoded scene

Preview captures re-run the composition; they do not inspect the file FFmpeg
wrote. After a full render:

```json
inspect_render {
  "target": "launch-film/intro",
  "count": 5
}
measure_render {
  "target": "launch-film/intro"
}
```

If `measure_render` returns a running task, wait for its result. Static, black,
or solid runs are facts to inspect, not automatic defects.

Successful single-file deliveries are encoded in `out/.staging`, reviewed, and
then promoted. The final output receives a `.review.json` report and
`.contact.png` contact sheet. A policy block returns `promotion_blocked`, keeps
the previous promoted movie intact, and leaves staged evidence for diagnosis.
Do not disable review policy just to make a build pass.

### 9. Plan and assemble the film

Never calculate scene offsets yourself. Ask the planner before placing master
timeline material and again before building:

```json
build_film {
  "film": "launch-film",
  "plan": true
}
```

Use returned `sceneLayout[].filmOffset`. Resolve every `problems` entry. In
particular:

- each rendered scene must exist and still match its current config;
- scene and footage signatures must match the film;
- timeline footage frame counts must verify;
- provenance-linked footage must show `sourceVerified: true`;
- master audio, overlays, and captions must reference existing film assets.

This is also a checkpoint: run `check_human_advice` before building, so a
note the human left mid-production is folded in rather than shipped around.

Render every scene, then assemble:

```json
build_film {
  "film": "launch-film",
  "audioTargetPeakDb": -2
}
```

`build_film` is asynchronous. Wait for its `jobId`, inspect the terminal status,
and review the returned audio and delivery evidence. The finished status also
carries `deliveryId` — the immutable archived build the human's review player
pins to; link it when resolving the advice this build answers.

For a saved platform version:

```json
build_film {
  "film": "launch-film",
  "deliverable": "shorts-9x16"
}
```

Do not combine `deliverable` with `outputFilename`; a version owns its output
name. A platform version re-encodes the same edit to its target geometry and
creates independent captions, review JSON, and a contact sheet. Inspect the
safe-area guides. Stage-A reframe is a crop/scale of the master; text-heavy
work may require a genuinely responsive composition instead.

After building:

```json
inspect_render {
  "target": "launch-film",
  "around": "cuts"
}
measure_render {
  "target": "launch-film"
}
```

Inspect before/at/after scene and footage boundaries. Re-transcribe a finished
speech-led cut when practical to confirm that intended words survived the edit.

To eyeball a whole film at once, ask for the grid first and inspect what it
flags:

```json
review_render_grid {
  "film": "launch-film"
}
```

One contact sheet plus one metadata row per cell (cut and hold of every
segment, with frame, film offset, and timestamp) replaces a per-scene stream of
full-width images. It reads the same encoded files — the built film when it
exists, otherwise the individual scene renders — so it is where to look, not
what to conclude: `inspect_render` still returns the exact frames and
`measure_render` still measures the picture.

## Update semantics agents commonly get wrong

- `update_film` is a patch, but array fields such as `scenes`, `audio`,
  `overlays`, `captions`, and `deliverables` replace the whole saved array.
  Read the film, preserve wanted entries, and submit the complete new array.
- **Because arrays replace, pass `expectedRevision`.** The human edits the same
  document in the Studio while you work. A `scenes` array written against a
  read they have since edited past does not just lose your field — it reverts
  their change, silently. Take `revision` from `get_film` and pass it as
  `expectedRevision`; a stale one fails with `film_conflict` carrying the
  current revision, and the fix is always re-read → re-apply → retry. Omit it
  only for a scalar field nobody else touches.
- `update_scene_config.patch` changes only provided fields.
- A film can save with plan `problems`; it cannot build successfully until
  those problems are resolved.
- `create_scene` appends the scene to the film order. Use `update_film.scenes`
  to reorder or mix scene and footage segments.
- **Each `scenes` entry replaces THAT SEGMENT**, so a field you leave out is a
  field you erase — including a `sequence` label and a footage segment's stable
  `id`. Never hand-build `scenes: [{slug:"outro"}, {slug:"hook"}]` to reorder:
  it reorders and unlabels the film in one move, leaving `sequences` metadata
  describing bands that no longer exist. Read the film, reorder or filter the
  segment objects you got back, and spread them (`{...seg}`). Clearing a label
  on purpose is how you *ungroup* — send the segment without `sequence` and drop
  the unused key from the `sequences` map in the same patch. `update_film`
  returns a `warnings` array whenever a patch cleared labels, and
  `plan.unreferencedSequences` lists metadata keys no segment carries; read
  both. The `sequences` metadata map is patched as one object.
- Footage segments carry a stable `id`. A whole-array rewrite that drops it
  gets a fresh one, which orphans any human advice aimed at that clip —
  echo it back, exactly like `sequence`.
- `use_scene_revision` changes only which archived take is live; the film
  still plays the old bytes until you `build_film` again.
- Scene source changes do not refresh old rendered output. Re-render the
  affected scene.
- Asset paths are target-relative and must remain under `assets/`; inspection
  paths must begin with `out/` or `assets/`.
- `rename_asset` and `delete_asset` report audio references. When changing a
  referenced asset, use the tool's `updateAudio` option so timelines do not
  retain dangling paths.
- The workspace library is read-only over MCP. The user adds files; agents list,
  probe, transcode, or link them.
- Job ids live only in server memory. Persistent documents and output files are
  the durable record.

## Error handling

Read the structured `code`, `message`, and `detail`; do not blind-retry.

- `syntax_error`: the JavaScript write was rejected and the prior file remains.
- `composition_error` / `frame_timeout`: inspect the named frame and missing
  assets; await asynchronous setup inside the registered composition.
- `path_not_allowed`: use target-relative composition paths or paths under
  `assets/`/`out/` as required by the tool.
- `asset_too_large`: use the workspace library, then `use_shared_asset` or
  direct `transcode_asset`.
- `queue_full`: wait or cancel stale jobs instead of resubmitting.
- `render_already_in_progress`: another process owns the scene render; do not
  start a competing writer.
- `short_render`: re-render; never assemble an output with fewer encoded frames
  than expected.
- `scene_not_rendered`, `stale_render`, `inconsistent_scenes`: use the film plan,
  re-render only named scenes, and restore a common signature.
- `footage_source_changed`: re-transcode from the current source and replace the
  timeline entry with the new returned `timelineSegment`.
- `promotion_blocked`: inspect its staged review/contact evidence, fix the
  finding, and render/build again. The prior promoted delivery is preserved.
- `disk_error` with `detail.phase: "preflight"`: another process holds the
  output file open, so this render could never be delivered — raised before any
  frames are captured. Retrying unchanged fails the same way. Either the holder
  closes it (the Studio scene page is the usual one) or you give the target a
  different name with `update_scene_config { patch: { output: { filename } } }`.
- `revision_mismatch`: the archived take no longer matches the scene's current
  settings (duration/resolution/fps/format changed since). Either restore the
  settings or render a new revision; do not force the old bytes in.
- `advice_lease_held`: another agent is working that advice — leave it to them
  and move on; the lease names the holder and expiry, and expiry recovers it.
- `advice_already_resolved`: resolutions are immutable. Read the existing
  resolution; a genuinely new thought becomes new advice or a new revision,
  not a rewrite.
- `tts_unavailable`, `music_unavailable`, `transcription_unavailable`: call
  `list_vendors`, report the missing configuration, and never ask the user to
  paste a credential into chat.
- `browser_crashed`: one job-level retry is reasonable; repeated crashes require
  `get_logs` and machine-level diagnosis.
- `prereqs_missing`: report the missing Node/FFmpeg prerequisite. Retrying the
  same call cannot install it.

## Final delivery checklist

Before saying the work is complete, verify all of the following:

- the film and intended scene ids are correct;
- no unexplained write warnings, structure warnings, or plan problems remain;
- representative source frames were visually checked;
- every audio timeline passed `preview_audio`;
- every render/build job reached `done`;
- final audio has no unintended clipping, buried track, or silent tail;
- encoded output was checked with `inspect_render` and `measure_render`;
- for a single-file delivery, the review report and contact sheet were produced
  and inspected;
- no `promotion_blocked`, `reviewArtifactWarning`, or encoding warning remains
  unresolved;
- supplied-footage provenance is verified;
- `check_human_advice` returns nothing unresolved (every item acknowledged
  and resolved with an outcome, or explicitly awaiting the human's answer to
  your `needs-clarification` question);
- `get_production_status` shows the current delivery includes your latest
  promoted work (`newerWorkThanDelivery: false`, or you built again);
- the user receives the exact final output path and a clear statement of what
  was rendered.
