# `transcode_asset` — prepare media inside the tool surface

> **Status: SHIPPED (unreleased, v0.22) — the last of the four.** This file is the
> design record. For how to *use* it, read the `transcode_asset` row in
> [mcp-setup.md](../mcp-setup.md) and [architecture.md](../architecture.md) §9.4;
> for what shipped, see the [CHANGELOG](../CHANGELOG.md).
>
> **The open questions are answered, and five things changed:**
>
> 1. **Sync or job, and which queue** (open questions 1 and 2) — answered by
>    something that shipped after this plan was written: `jobs.startTask`'s second
>    lane. `transcode_asset` submits there, blocks up to `waitMs`, and hands back a
>    jobId past it. Nothing had to be designed.
> 2. **`frames` mode shipped** (open question 3 said to defer it), because it was
>    asked for. Its semantics needed a correction the plan could not have
>    anticipated: `-frames:v` counts *output* frames, so "12 frames, every 3rd"
>    read 36 source frames. `trim.durationInFrames` now means frames **of source**
>    in every mode — a trim describes the span being read — so that call yields 4
>    images.
> 3. **`video.gop` was kept**, against the plan's own reasoning. The plan retracts
>    the GOP cargo cult correctly *for concatenation* (measured again in plan 0: a
>    differing GOP stream-copies and decodes bit-identically), but a short GOP makes
>    per-frame `seekVideo()` inside a composition much faster, which
>    `frame-api.md` §11 already documented. Two different jobs, one flag.
> 4. **Addressing is `from` + `fromTarget`**, not the plan's `{ library } | { asset }`
>    object. `probe_asset` and `transcribe_asset` already share `locateMedia` with
>    "omit the target to mean the library", and a third convention in the same tool
>    family is exactly the trap that helper exists to prevent.
> 5. **`.gif` is refused** with an explanation. gif's own encode arguments *are* a
>    `-filter_complex`, so they cannot be combined with a crop/scale chain — a
>    collision nothing in the plan anticipated, and one that would have silently
>    dropped the caller's geometry (ffmpeg takes the last `-vf`).
>
> Open question 4 (a `vignette` knob) stays **unresolved and unshipped**, as the
> plan recommends: resist until a second case appears.
>
> The plumbing hole the plan describes turned out to be mostly not a hole — the
> 25 MB cap applies to the base64 ingest path, and engine-side writes into `assets/`
> were never capped.
>
> See [README.md](../todo_task/README.md) for the ship order and the two
> environments this was scoped against.
>
> An earlier draft had this shipping *first*, ahead of
> [`transcribe_asset`](../task_completed/transcribe-asset-plan.md). Two corrections since:
>
> - **`transcribe_asset` does not depend on this tool.** ffmpeg is already an
>   engine prerequisite, so it can demux internally.
> - **This tool is not the blocker.** [Plan 2](../task_completed/footage-segment-plan.md) is. A
>   perfectly prepared footage file has nowhere to go until the film timeline can
>   hold one, so plan 2 should define this tool's field list rather than the
>   reverse.
>
> Prototyped by hand — a 65 s film cut from a 94 s talk, ffmpeg + whisper.cpp +
> Motion Studio, 31 shell calls against 17 MCP calls. Findings from that run are
> marked **[measured]** below.

## What it does in each environment

This is the most **capability**-shaped plan of the four, which is exactly why it
ships last — see [README.md](../todo_task/README.md#the-two-environments).

| | Value |
|---|---|
| **Env A** (MCP only) | **Essential.** Without it, supplied footage cannot be conformed, trimmed, or demuxed at all, and the H.264 trap is a hard wall: `probe_asset` reports that a file cannot be decoded by the render browser and nothing can act on it. |
| **Env B** (+ shell) | **Mostly redundant.** ffmpeg is a better ffmpeg than any wrapper. Env B wants exactly two things from it: the conform-to-signature operation (knowledge, now [plan 0](../task_completed/film-signature-plan.md)) and frame-exact trims. |

Scope accordingly. Every field beyond what Env A needs to reproduce the
[acceptance-test film](../todo_task/README.md#acceptance-test) is a field to defer — the
alternative is the wrapper treadmill, where each real job needs one more option
and the honest end state is an `args` passthrough this plan forbids on purpose.

## Why

`probe_asset` (v0.21) let an agent finally *read* a media file. It still cannot
**change** one, and every real job with user-supplied footage needs to.

The evidence is one session. A user dropped a 7.7 MB OBS recording in the
library and asked for a promo built around it. The job completed — but only
because the agent had a shell outside the MCP surface, and used it seven times:

| What was needed | What was used | MCP equivalent |
|---|---|---|
| Length / fps / codec of the clip | `ffprobe` | `probe_asset` (v0.21) ✔ |
| See what is in the clip | `ffmpeg` contact sheet | still none |
| H.264 → VP9/WebM (the render browser cannot decode H.264) | `ffmpeg` | **none** |
| Crop a tighter PIP framing | `ffmpeg` | **none** |
| Remove a baked-in logo from a product photo | `ffmpeg` | **none** |
| Extract the speaker's audio | (never done — unreachable) | **none** |

An agent driving Motion Studio through MCP alone stops at row three. That is the
gap: the surface can *describe* footage and *display* footage, but cannot
*prepare* it, so the one asset type users most want to bring is the one the
product handles worst.

A second session — the prototype — took the shell and used it far harder, and
every one of these was an `ffmpeg` invocation with no MCP equivalent:

| What was needed | **[measured]** |
|---|---|
| 16 kHz mono PCM for whisper.cpp | hard vendor requirement; `-ac 1 -ar 16000 -c:a pcm_s16le` |
| Four speech spans cut and joined with 12 ms crossfades | `acrossfade` chain; a hard butt-join clicks |
| Voice normalised, limited, padded to an exact frame count | `volume` / `alimiter` / `apad` + `atrim` |
| Voice mixed with a synthesized bed at a measured offset | `amix` with `volume=-11dB` |
| Four picture segments cut to **exact frame counts** | `-frames:v N`, matched to the graphics encode |
| Nine-part lossless assembly | `concat` + `-c copy` |

Note that **`probe_asset` — shipped in v0.21 — went unused in that session.**
Every media question was answered with `ffprobe` in a shell instead, because the
answer had to feed a shell command anyway. A read-only tool inside a surface that
cannot act gets bypassed; this tool is what makes `probe_asset` worth calling.

Three concrete consequences, all from that session:

- **The H.264 trap is only warned about, never fixed.** `probe_asset` says "this
  cannot be decoded by the render browser". The agent then has no way to act on
  its own advice. Transcoding on ingest means the trap cannot occur.
- **Footage got used as wallpaper, not as an edit.** One full-frame transcode and
  one PIP crop, reused across nine scenes. The PIP in-points — 2.0 s, 5.0 s,
  0.6 s, 4.6 s — were chosen for exactly one reason: to avoid running past the
  end of a 12.4 s clip. That is a constraint being satisfied, not a cut being
  made. The dead air at the head was never trimmed; a second usable shot in the
  tail of the source was never touched, because it needed its own crop.
- **The user's voice was unreachable.** With no audio extraction, the only
  option was to mute the footage and lay synthetic narration over it. That
  decision was forced by tooling, not chosen for the film.

There is also a plumbing hole: the library is read-only from MCP and
`write_asset_file` caps at 25 MB, so the 12 MB WebM the scene actually needed
could not have been produced *or* delivered through the tool surface at all.

## Design sketch

One tool, several output modes, because the alternative is four tools that
share all their validation, sandboxing and ffmpeg plumbing.

```js
transcode_asset({
  target: 'my-film/intro',              // scene or film — where the OUTPUT lands
  from:   { library: 'host.mp4' },      // or { asset: 'assets/host.mp4' }
  to:     'assets/host-pip.webm',       // under the target's assets/

  mode:  'video',                       // 'video' | 'audio' | 'frames'

  // seconds OR frames, in the SOURCE timeline. Prefer frames: `durationInFrames`
  // maps to ffmpeg's `-frames:v`, which GUARANTEES the count. A seconds-based
  // `-t` does not, and an off-by-one frame breaks a concat seam. [measured]
  trim:  { startSeconds: 2.0, durationInFrames: 186 },

  crop:  { x: 384, y: 110, width: 1152, height: 648 },
  scale: { width: 640, height: 360 },   // or { width: 640 } to keep aspect
  fps:   30,
  video: { quality: 32, gop: 10 },      // codec chosen by the `to` extension
  audio: false,                         // drop audio (default for 'video')
})
→ {
    path: 'assets/host-pip.webm', bytes: 827641, source: 'library:host.mp4',
    applied: { trim, crop, scale, fps, codec: 'vp9' },
    elapsedMs: 7400,
    // the same block probe_asset returns, measured on the RESULT:
    container, durationSeconds, video: {...}, audio: null, hasAudio: false, notes: []
  }
```

### The three modes

| `mode` | Produces | Why it exists |
|---|---|---|
| `video` | A video file under `assets/` | The core case: make footage the render browser can actually decode, cropped and trimmed to what the scene needs. |
| `audio` | A WAV under `assets/` | Unlocks the user's own voice: put it on the film's master timeline and measure it with `preview_audio`. **Needs explicit `sampleRate` / `channels`**, and a **`join`** of several spans — see below. |
| `frames` | An image sequence under `assets/<dir>/` | Falls out of the same plumbing. **Not a reason to build this** — the claim that `<img>`-per-frame beats video seeking is still unmeasured (see "Open questions"). |

### `audio` mode needs to join spans, not just extract one

**[measured]** Building a spine from a talk is not one trim — it is *N* trims
joined. The prototype cut four spans and joined them with 12 ms `acrossfade`
triangles, because a hard butt-join clicks audibly:

```js
transcode_asset({
  target: 'my-film', from: { library: 'talk.mp4' }, to: 'assets/spine.wav',
  mode: 'audio',
  sampleRate: 48000, channels: 2,
  spans: [                                     // in SOURCE order, concatenated
    { startSeconds: 1.95,  durationInFrames: 341 },
    { startSeconds: 14.91, durationInFrames: 589 },
    { startSeconds: 58.45, durationInFrames: 622 },
    { startSeconds: 80.64, durationInFrames: 396 },
  ],
  crossfadeMs: 12,                             // 0 for a hard join
})
```

Why this belongs here rather than on the film's audio timeline: the mixer's fades
are **frame-quantized**, and 12 ms at 30 fps is 0.36 frames — inexpressible. Four
overlapping tracks with 1-frame (33 ms) fades is a different, worse edit. Joining
spans is asset preparation, it produces one WAV, and that WAV goes on the timeline
as a single track at `startInFrames: 0`.

Keep `crossfadeMs` a bounded scalar (say 0–200 ms, triangular), not a filter
spec. The named-field discipline holds: this is one operation with one knob.

### `matchFilm` — the option that prevents the common disaster

```js
transcode_asset({ target: 'my-film', from: {...}, to: 'assets/clip.mp4',
                  matchFilm: 'my-film' })
```

Resolves `width`/`height`/`fps`/`format`/`pixFmt` from the film's
`sceneDefaults` so the output is **concat-compatible by construction**.

This matters more than it looks. Motion Studio's whole long-form guarantee is
that scenes share a signature and therefore concatenate losslessly, and
`validateScenes` enforces it. The moment an agent hand-computes encoder
parameters to match a film, that guarantee moves from the engine into the
agent's arithmetic — and the failure is `inconsistent_scenes` after a long
render, or worse, a silent A/V drift at a seam. `matchFilm` keeps the invariant
where it already lives.

**[measured]** The prototype interleaved four footage segments with five
rendered scenes and concatenated all nine with `-c copy`, no re-encode. It worked
because the footage was encoded to agree with Motion Studio's own output on the
parameters that a stream copy cannot reconcile — codec, resolution, fps, pixel
format, and closely enough on rate control:

```
libx264 · yuv420p · 1920×1080 · 30 fps · -crf 18 -preset medium
```

That set is not guessable from outside the engine. It lives in
`formats.js`'s registry (`mp4.videoArgs` → `-c:v libx264 -preset medium -crf 18
-pix_fmt yuv420p -movflags +faststart`), and an agent working from a shell cannot
see it — it can only probe a rendered file and infer, which requires having
rendered one first.

That argument turned out to justify its own plan, shipping well before this one:
**[film-signature-plan.md](../task_completed/film-signature-plan.md)** simply *states* the contract
on `get_film`, which is hours of work and serves both environments. `matchFilm`
then becomes a thin consumer of it rather than the only way to reach it — and Env
B, which will keep using ffmpeg regardless, gets the one thing it actually needed
without waiting for this plan at all.

Two honest corrections to an earlier draft of this section, both worth keeping
because they mark the boundary of what actually has to match:

- The prototype also passed `-profile:v high -level 4.0`. Those were redundant —
  libx264 selects exactly those for 1080p30 anyway. Harmless, but it was
  cargo-cult, not matching.
- It passed `-x264-params keyint=60:min-keyint=30` while Motion Studio uses
  libx264's default (250). **The concat succeeded despite that mismatch**, because
  every segment is a separate encode and therefore opens on a keyframe, which is
  all `concat -c copy` requires. GOP length does not need to agree, and a tool
  should not pretend it does.

### Addressing

Source is `{ library: '<library-relative>' }` or `{ asset: 'assets/…' }`.
Accepting the library directly is deliberate: the alternative forces a
`use_shared_asset` hardlink of a 500 MB source you are about to reduce to 3 MB.
Destination is always `assets/`-relative under `target`, sandboxed exactly like
`write_asset_file`, and **may never equal the source**.

## Rules it must obey

- **No arbitrary ffmpeg arguments — ever.** Not `args`, not `filter`, not an
  "escape hatch". The entire premise of this tool surface is "no shell"; a
  passthrough is a shell wearing a hat, and it takes the sandbox with it. Every
  operation is a named, validated field. If a job needs something not in the
  list, that is a request for a new field, not for an escape hatch.
- **Report the result by measuring it**, never by echoing the request. Reuse
  `summarizeMedia` on the output so the caller learns what they actually got —
  including a `notes` warning if the result *still* is not browser-decodable.
- **Never overwrite the source**, and never write outside `assets/`.
- **Must not block the render queue.** See "Open questions".
- **Bounded**: max source duration, max output bytes, one operation per call.
- **Idempotent enough to be cheap.** Record the source identity + parameters in
  a sidecar beside the output (the `*.render.json` pattern from v0.21) and skip
  the work when nothing changed. Re-pulling an unchanged clip should be free.

## TODO — all done

- [x] `engine/src/core/transcode.js` — parameter validation, filter-graph
      construction from the named fields only, ffmpeg invocation via the
      existing `runFfmpeg`, result probing via `summarizeMedia`.
- [x] `matchFilm` / `matchScene` resolving from
      [plan 0](../task_completed/film-signature-plan.md)'s `filmSignature()` — **not** a second
      derivation of the encode table.
- [x] `audio` mode: `spans[]` + bounded `crossfadeMs`, `sampleRate`, `channels`.
- [x] Frame-based `trim` (`durationInFrames` → `-frames:v`), which is what makes
      a segment safe for [plan 2](../task_completed/footage-segment-plan.md)'s declared-and-verified
      frame count.
- [x] Sidecar-based skip-if-unchanged.
- [x] `ErrorCodes.TRANSCODE_FAILED`, plus reuse of `path_not_allowed`,
      `file_not_found`, `unsupported_format`, `asset_too_large`.
- [x] MCP tool `transcode_asset`; decide sync-vs-job (below) before writing it.
- [x] Studio HTTP endpoint so the UI can use the same path (the engine rule:
      agents, CLI and Studio share one implementation).
- [x] Tests: parameter validation and rejection of anything shell-shaped;
      trim/crop/scale/fps correctness measured with `probe_asset` on the output;
      `matchFilm` producing a signature `validateScenes` accepts; audio mode
      producing a WAV the mixer accepts; skip-if-unchanged; source ≠ destination.
- [x] Docs: `docs/mcp-setup.md` tool row, `docs/architecture.md`, a section in
      `docs/user-guide.md`, and — the one that matters for agents —
      `docs/SKILL.md` plus `docs/frame-api.md` §11, which currently tells authors
      to have *the human* run ffmpeg.

## Open questions — decide before implementing

1. **Synchronous call or JobManager job?** A 6-second trim is ~1 s of work; a
   12-minute 1080p VP9 transcode is minutes, which blows past the MCP client's
   request timeout. Renders solved this with jobs, and `wait_for_render` already
   blocks on them in one round trip. Recommendation: **make it a job**, for
   consistency and because it composes with the existing polling.
2. **…but which queue?** The render queue is deliberately one-at-a-time because
   renders are heavy. A 2-second trim stuck behind a 12-minute render is a bad
   experience, and transcodes are the thing you do *while* deciding what to
   render. Recommendation: a **separate lane** with its own small concurrency
   limit, sharing the JobManager's id space and status shape.
3. **Does `frames` mode earn its place in v1?** It is nearly free to add, but the
   performance argument for it was never measured. Suggestion: ship `video` and
   `audio` first; add `frames` only if a measured comparison justifies it.
4. **Does footage need one grading knob to sit beside rendered scenes?**
   Grading is out of scope below, and should stay there — but **[measured]** the
   prototype applied `vignette` to all four footage segments, because raw camera
   footage cut directly against dark rendered graphics reads as a different film.
   The need is real and narrow: not colour correction, just "make this belong".
   Resist until a second case appears, then consider a named `vignette` field
   rather than a general filter — the distinction that keeps the no-shell
   premise intact.

## Deliberately out of scope

- **Arbitrary filter graphs, LUTs, colour grading, denoise, stabilisation.**
  Preparing an asset, not finishing a film.
- **Chroma/luma keying.** Tried in the session that motivated this plan: keying
  the white studio background off a product shot destroyed the product, because
  the product is also white. It is a footgun that looks like a feature.
- **Cutting between clips / assembling a timeline.** That is what a *film* is.
  An asset tool prepares one file; `build_film` arranges them.
- **Footage on the film timeline.** No longer out of scope, and no longer a
  follow-on: it is **[plan 2](../task_completed/footage-segment-plan.md)**, and it ships *before*
  this one. A perfectly conformed footage file has nowhere to go until
  `film.scenes[]` can hold one, which is why **`build_film` was never called** in
  a session that produced a film.

  One claim from an earlier draft of this section needs retracting. It said the
  prototype's continuous 65 s audio spine was "a structure the current film
  timeline has no way to describe." **That is wrong** — a single `film.audio[]`
  track at `startInFrames: 0` spanning the whole film is exactly expressible
  today, and the mixer handles it. Only the *picture* order was inexpressible.
  The distinction matters because it makes plan 2 considerably smaller than that
  draft implied: the audio side needs nothing.
