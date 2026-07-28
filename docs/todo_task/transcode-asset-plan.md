# `transcode_asset` — prepare media inside the tool surface

> **Status: PLANNED.** Companion plan:
> [transcribe-asset-plan.md](transcribe-asset-plan.md) (`transcribe_asset`),
> which depends on this tool's audio-extraction mode. Ships first of the two:
> a transcript tells you *where* to cut, and without this you still cannot cut
> there.

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
  trim:  { start: 2.0, duration: 6.2 }, // seconds, in the SOURCE timeline
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
| `audio` | A WAV under `assets/` | Unlocks the user's own voice: put it on the film's master timeline, measure it with `preview_audio`, and feed `transcribe_asset`. |
| `frames` | An image sequence under `assets/<dir>/` | Falls out of the same plumbing. **Not a reason to build this** — the claim that `<img>`-per-frame beats video seeking is still unmeasured (see "Open questions"). |

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

## TODO

- [ ] `engine/src/core/transcode.js` — parameter validation, filter-graph
      construction from the named fields only, ffmpeg invocation via the
      existing `runFfmpeg`, result probing via `summarizeMedia`.
- [ ] `matchFilm` / `matchScene` resolution against `sceneDefaults`.
- [ ] Sidecar-based skip-if-unchanged.
- [ ] `ErrorCodes.TRANSCODE_FAILED`, plus reuse of `path_not_allowed`,
      `file_not_found`, `unsupported_format`, `asset_too_large`.
- [ ] MCP tool `transcode_asset`; decide sync-vs-job (below) before writing it.
- [ ] Studio HTTP endpoint so the UI can use the same path (the engine rule:
      agents, CLI and Studio share one implementation).
- [ ] Tests: parameter validation and rejection of anything shell-shaped;
      trim/crop/scale/fps correctness measured with `probe_asset` on the output;
      `matchFilm` producing a signature `validateScenes` accepts; audio mode
      producing a WAV the mixer accepts; skip-if-unchanged; source ≠ destination.
- [ ] Docs: `docs/mcp-setup.md` tool row, `docs/architecture.md`, a section in
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

## Deliberately out of scope

- **Arbitrary filter graphs, LUTs, colour grading, denoise, stabilisation.**
  Preparing an asset, not finishing a film.
- **Chroma/luma keying.** Tried in the session that motivated this plan: keying
  the white studio background off a product shot destroyed the product, because
  the product is also white. It is a footgun that looks like a feature.
- **Cutting between clips / assembling a timeline.** That is what a *film* is.
  An asset tool prepares one file; `build_film` arranges them.
- **A "footage scene" type.** Real appetite exists for interleaving full-frame
  footage segments with rendered scenes, and `matchFilm` is designed with it in
  mind — but it is a change to the film/scene model and belongs in its own plan,
  after this ships.
