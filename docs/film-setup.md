# Motion Studio — Long-form Films (`build_film`)

Motion Studio renders **one composition per scene**. A composition is a single
`frame → state` function, which is the right size for a shot or a scene — not for
an hour of video. To build anything longer than a single composition, you create
one **film** and give it **many scenes** — a scene is what used to be its own
project — then stitch the rendered scenes together with the `build_film` tool
(added in v0.9).

```
film "my-film"
  scene "intro"  ─ render ─┐
  scene "body"   ─ render ─┤→  build_film  →  one continuous film (the film's out/)
  scene "outro"  ─ render ─┘   (+ optional master audio, on the film itself)
```

This is the same idea the parallel renderer already uses internally (it splits one
render into frame-range segments and concatenates them losslessly); `build_film`
applies it at the **scene** level, across a film.

## The scene model

- **One film, many scenes.** Create the film once —
  `create_film { name, fps?, width?, height?, durationInFrames?, deliverables? }` — then
  scaffold each scene inside it with the normal tools: `create_scene { film, name }`
  → `write_composition_file` → `capture_preview_frame` → `render`. Nothing new to
  learn per scene; authoring one is identical to authoring the old one-composition
  project.
- **The film is its own dedicated container — there's nothing extra to create.**
  Under the pre-v0.20 model you created a spare "output project" (often named
  `"<film> — Master"`) just to hold the assembled film and its master audio,
  because a project was the only thing with an `assets/`/`out/`. That workaround
  is gone: the **film folder itself** has `assets/` (master audio, overlays) and
  `out/` (the built deliverable). Put master-audio assets there by passing the
  **film id** as `target` to `synthesize_speech`/`synthesize_music`/`write_asset_file`.
  There is no `outputProjectId` to pass and nothing extra to remember to create.
- **`build_film` assembles; it never renders.** Every scene must already be
  rendered, or the call fails with `scene_not_rendered` naming the culprits —
  and it must be rendered *at the settings the scene still has*, or the call
  fails with `stale_render` (see below).
- Because compositions are pure functions of frame, you can **preview scenes at
  720p and final-render at 1080p/4K with zero code change** — resolution and fps
  live in each scene's config (inherited from the film's `sceneDefaults` unless a
  scene overrides them), not in the composition.
- **Sequences are the story layer (v0.23).** A scene is the atomic render
  unit; a **sequence** is the narrative grouping a human navigates by. Label
  segments in the play order (`scenes: [{ slug: "hook", sequence: "Intro" },
  { slug: "demo-1", sequence: "Demo" }]`) and optionally describe each label
  (`sequences: { Intro: { intent: "Hook the viewer in 5 seconds" } }`).
  Consecutive segments sharing a label form one band in the plan
  (`plan.sequences`), in the film page's tree and timeline, and as advice
  targets ("Sequence 2 drags"). Sequences are presentation only: they render
  nothing, own no files, and relabeling or regrouping never invalidates a
  render or moves a folder. Footage segments take labels too.
- **Reorder by carrying the segments through, not by rebuilding them (v0.27).**
  `update_film { scenes }` replaces the play order *and each entry replaces
  that segment*: a field you leave out is a field you erase. So a reorder
  written as `scenes: [{slug:"outro"}, {slug:"hook"}]` silently strips every
  `sequence` label while `film.sequences` stays behind describing bands that no
  longer exist. Read the film, reorder or filter the segment objects you got
  back, and spread them (`{...seg}`). Replacement is deliberate — it is exactly
  how you *ungroup*: send the segment without `sequence` and drop the now-unused
  key from `sequences` in the same patch — so the engine does not guess. What it
  does instead is **say what happened**: `update_film` returns a `warnings` array
  naming the labels a patch cleared and the metadata it stranded, and
  `plan.unreferencedSequences` lists any `sequences` key no segment carries
  (both omitted when the film is clean).
- **Footage clips carry a stable `id` (v0.23).** `normalizeSegment` stamps one
  on every footage segment and preserves it across saves. Keep it when you
  rewrite the play order: it is what human advice on that clip is bound to,
  and neither the path (the same plate can be cut in twice) nor the array
  index (every reorder changes it) can serve as identity. Scenes already have
  one — the slug.

## Stale renders: the sidecar (v0.21)

Existence of `out/output.mp4` used to be the whole of "is this scene rendered?".
It cannot answer the question that actually matters — *is it rendered at the
settings the scene has now?* Shorten a scene with `update_scene_config` after
rendering it and nothing notices: the plan still says `rendered: true`, reports
a `totalFrames` the concatenation cannot produce, and `build_film` stitches the
old file. Every master-audio offset past that scene then drifts against the
picture, silently, in the finished film.

So each render that is **the whole scene, at its current settings, to its real
destination** drops a small JSON sidecar beside its output:

```
scenes/<scene>/out/output.mp4
scenes/<scene>/out/output.mp4.render.json
  { frames, width, height, fps, format, pixFmt, transparent,
    colorPrimaries, colorTransfer, colorMatrix, colorRange,
    outputIdentity: { bytes, mtimeMs }, renderedAt }
```

Those are exactly the fields the concat signature is built from, plus the frame
count. The colour fields mean an older sidecar remains unverified on colour while
a fresh render made under a different colour contract becomes stale. `pixFmt` and `transparent` joined the list in v0.22 — they were always part
of the signature, so leaving them unrecorded meant a film-wide change to either
broke the concat contract with nothing reporting it. A sidecar written before that
release simply has less to say: it stays *unverified* on those two fields rather
than turning up stale.

- `planFilm` / `build_film { plan: true }` compares it with the live config and
  reports a `stale_render` **problem** naming the fields that diverged
  (`frames 217 → 200`). Each scene in the layout also carries
  `renderVerified: true | false | null`.
- `build_film` **refuses** to assemble a stale scene, with `stale_render` and a
  `detail.stale[]` listing every offender. Re-render those scenes.
- Proxy renders, per-worker segments and partial `frameRange` renders do **not**
  write a sidecar — none of them is the scene's canonical output.
- A render made by an older build has no sidecar. That is *not* stale: it is
  reported as `renderVerified: null` (unknown) and builds normally. Re-render
  once and it becomes verifiable.
- The sidecar is advisory metadata. If it cannot be written the render still
  succeeds; deleting it only loses the check.

## Safe delivery promotion and output review

A file that is still encoding is not a delivery. Scene renders, proxies,
partial exports, and film builds now write their video and any audio re-mux to
`out/.staging/<base>-<jobId><ext>` first. Only after the file has finished and
its frame count has been checked does the engine rename it onto the visible
delivery name. A failed or cancelled job leaves its staging path in the job
error and leaves the previous delivery untouched.

`promoted: true` in a completed render/build status means that final rename
happened. `framesVerified` is separate: it is `false` when `ffprobe` could not
measure the file, rather than pretending the count was checked. FFprobe is not
a prerequisite, so an otherwise successful file can still promote with that
explicit unverified state.

A film's `.srt` is a derived caption sidecar, not the primary movie delivery.
If it cannot be promoted after the movie, the completed job reports
`captionSidecarWarning` instead of relabelling the already-promoted film as a
failed build.

For a canonical full-scene output, the video is promoted **before** its render
sidecar is written. The sidecar records the promoted file's `bytes` and
`mtimeMs`; if either later differs, the scene is `stale_render`, even when its
settings are unchanged. This is a cheap mismatch signal, not a cryptographic
content proof. Legacy sidecars without it remain unverified rather than stale.

The hidden staging folder is intentionally absent from the Studio output list.
PNG sequences are directory deliveries rather than a single encoded file, so
their atomic directory replacement remains separate from this file-promotion
contract.

### Review evidence is made before promotion

Every staged single-file delivery also produces two staged companions before
the movie can be promoted:

- `out/<base>.review.json` records expected/actual frame count, ffprobe facts,
  final audio measurements, the full encoded-picture measurement, the effective
  policy, and findings classified as `block`, `warn`, or `info`.
- `out/<base>.contact.png` is a contact sheet from the **encoded staging file**:
  first/last frame, each scene or footage boundary, and every caption onset.
  Each thumbnail in the JSON records its frame, caption onset (when relevant),
  and owning segment context.

This is deliberately a delivery check, not another composition preview. It can
catch a bad concat seam, burned caption, or output that differs from the live
editor. A contact-sheet extraction has a final-frame fallback for short MP4s
whose container seeks exactly to the end, so it does not turn an otherwise
valid delivery into a false failure.

`settings.json` has a global `render.review` policy with `block` and `warn`
lists of stable finding codes. The default blocks only `frame_count_mismatch`;
static, black, and cut findings remain warnings because title cards and fades
are often intentional. A film may save a partial `review` override in
`film.json` (for example `{ "block": ["black_run"] }`); its supplied list
wins while an omitted list inherits the global one. A block raises
`promotion_blocked`, leaves the previous delivery in place, and retains the
staged movie plus staged review paths in the job error for diagnosis.

For a film, **build film →** shows an **Output review** panel after success.
It reads these two files through the normal output endpoint — no special route
or transient browser-only report — and overlays the relevant findings on the
contact thumbnails.

## Footage on the timeline (v0.22)

A film's play order is **heterogeneous**: a segment is either a rendered scene or
a piece of **footage** — a video file that joins as-is.

```jsonc
"scenes": [
  { "slug": "title" },                                      // a rendered scene
  { "footage": "assets/f1.mp4", "durationInFrames": 231 },   // supplied video
  { "slug": "lamb" },
  { "footage": "assets/f2.mp4", "durationInFrames": 320, "label": "B-roll" }
]
```

This is what lets a film say *"footage, then a scene, then footage"* — the shape
almost every film built around someone's own recording actually is. Before it,
`film.scenes[]` could hold only rendered scenes, so a session that interleaved
four footage segments with five rendered scenes **never called `build_film`** —
not because it failed, but because it could not be asked. The assembly was a
nine-part `ffmpeg concat` in a shell, and the film document still described a film
that was never built.

The key stays `scenes[]` and `schemaVersion` stays 1: an entry with `footage` and
no `slug` is unambiguous, so **every film written before this release remains
valid with no migration**.

### The rules footage obeys

- **`assets/`-relative, under the film** — same path rule and same sandbox as
  `audio[]` and `overlays[]`. Put it there with `use_shared_asset` (for a library
  file) or `write_asset_file`.
- **It must match the film signature.** Footage is never re-encoded — a film that
  quietly re-encoded one segment would have stopped being losslessly assembled, so
  a mismatch is `footage_signature_mismatch` naming the fix. Read the target from
  [`get_film`'s `signature`](#reading-the-contract-get_films-signature-v022) and
  conform the file to it.
- **It must be silent.** All sound comes from the master audio timeline. Dropping
  an audio stream silently would be worse than refusing it: the user's own voice
  would vanish from a film they can hear it in. Extract it to a WAV and put it on
  `film.audio` instead — which also means **a film mixing footage with
  audio-carrying scenes needs a master timeline**, because footage counts as a
  silent segment and `-c copy` cannot join a mix of the two.
- **`durationInFrames` is declared *and* verified.** You state the frame count so
  `planFilm` can compute offsets without probing every file on every call — but
  every downstream offset derives from it, so one wrong number would silently shift
  every later scene, caption and cue while the render still succeeded. The engine
  probes and reports `footage_duration_mismatch` (`declared 231 → actual 230`)
  before a build is paid for. Same contract as the render sidecar: declare, then
  verify, never trust. Each segment reports `framesVerified` — `true`, `false`, or
  `null` when ffprobe could not say, which is **not** "matches".
- **Footage may repeat**; a scene may not. A scene plays once because it has one
  rendered output; the same plate can be a recurring cutaway.

### Source provenance for prepared footage

`transcode_asset` writes a `.transcode.json` sidecar beside every prepared video.
When you put that video on a film timeline, use the returned `timelineSegment`
instead of reconstructing a bare `{ footage, durationInFrames }` entry:

```jsonc
{
  "footage": "assets/host-trim.mp4",
  "durationInFrames": 231,
  "derivedFrom": {
    "asset": "library:raw-interview.mp4",
    "transcodeMeta": "assets/host-trim.mp4.transcode.json"
  }
}
```

`derivedFrom` is optional and is deliberately only a pointer. The sidecar remains
the one record of the original source identity and transcode request; the film
does not duplicate its trim, crop, or source-stat snapshot. On every plan, Motion
Studio reads that sidecar and recomputes the identity of the recorded source on
disk. If the source was edited, replaced, or is no longer available, the plan
emits `footage_source_changed` before a build. A segment without `derivedFrom`
continues to behave exactly as older films did.

### What you get back

`get_film`'s plan reports every segment with `kind` (`"scene"` | `"footage"`) and
the same `filmOffset` / `durationInFrames` / `startSeconds` fields either way, so
*"where does segment 6 start"* is one question regardless of what segment 6 is.
Footage additionally carries what the probe measured — `width`, `height`, `fps`,
`codec`, `pixFmt`, `signature`, `actualFrames`, `hasAudio`, and `color`
(`{ primaries, transfer, matrix, range }`, each `null` when the file does not say).
Prepared footage also reports its `derivedFrom.sourceVerified` state when it has
provenance: `true` means the current source matches the sidecar; `false` names a
reason and appears in the plan problems; `null` means no provenance was supplied.
`color` is reported so you can see the source properties. `transcode_asset {
matchFilm: "<film>" }` now converts a footage segment to the stated film colour
contract; when source colour metadata is incomplete it records the bt709 input
assumption in its response instead of hiding it.

### Lip sync is yours, and should stay that way

When a footage segment's picture and the master audio come from the same source,
sync holds only if you derive both from the **same source offset**. Cut the picture
and its audio span from identical in-points and sync is exact by construction
within a segment. The engine cannot verify this and does not pretend to; what it
does is make the arithmetic expressible — `transcribe_asset`'s sentence and word
frames are how you find those in-points.

### Deliberately not supported

- **Trimming footage on the timeline** (`srcIn`/`srcOut` per segment). It would
  make `-c copy` impossible at arbitrary in-points. Prepare the file to length,
  then place it.
- **Transitions between segments.** Every dissolve re-encodes across a seam. A
  rendered scene between two footage segments is the supported answer — and a
  better one: it is how the prototype hid all three of its audio splices.
- **Speed changes, reversal, freeze frames.** Asset preparation, not timeline work.

## The consistency invariant

Scenes are concatenated **losslessly** (`ffmpeg -c copy`, no re-encode, no quality
loss, near-instant even for a long film). For a stream copy to succeed, every scene
must share the codec-determining parameters:

- **resolution** (`width`×`height`), **fps**, **format**, and **pixel format**.
- **format ∈ mp4 | webm | prores.** `gif` (global palette) and `png-sequence`
  cannot be concatenated — a mismatch or a bad format fails with
  `inconsistent_scenes`.

Set these once, on `create_film` — they become the film's **`sceneDefaults`** and
every `create_scene` inherits them unless you explicitly override per scene, so
scenes are consistent by construction instead of something you have to remember to
repeat. (`crf`/`preset` may differ between scenes — set per scene with
`update_scene_config`; they affect encoding, not stream compatibility.)

### Reading the contract: `get_film`'s `signature` (v0.22)

The engine computes and enforces the invariant above. Since v0.22 it also **states**
it, as `plan.signature` on every film tool that returns a plan:

```jsonc
{ "id": "1920x1080@30/mp4/opaque/yuv420p",
  "width": 1920, "height": 1080, "fps": 30, "format": "mp4", "container": "mp4",
  "pixFmt": "yuv420p", "transparent": false,
  "video": { "codec": "libx264", "crf": 18, "preset": "medium" },
  "audio": { "codec": "aac", "bitrate": "192k" },
  "ffmpegArgs": ["-c:v","libx264","-preset","medium","-crf","18",
                 "-pix_fmt","yuv420p","-movflags","+faststart"],
  "copyConcat": true,
  "color": { "stated": true, "primaries": "bt709", "transfer": "iec61966-2-1",
              "matrix": "bt709", "range": "tv" },
  "mustMatch": ["codec","width","height","fps","pixFmt","container"],
  "neednotMatch": ["gopSize","profile","level","bitrate"],
  "matchForLooks": ["crf","preset","colorPrimaries","colorTransfer",
                    "colorMatrix","colorRange"],
  "warnings": [] }
```

Everything in it is derived at call time from the code that already computes it —
`sceneSignature()` for `id`, the first scene's `output` for the values, and
`buildVideoArgs()` for `ffmpegArgs`, which is the *same call* the finishing encode
makes. There is no second copy of the encode table to drift.

Why it exists: while the engine renders every segment, nobody needs to know this.
The moment a file arrives from outside — supplied footage, a clip, a transcode — a
caller has to produce something matching an invariant it cannot read, and its only
options were to guess or to render a file first and probe it. Guessing is what
actually happened: a real session pinned `-profile:v high -level 4.0` (which
libx264 selects for 1080p30 anyway) and a custom GOP that disagreed with the
engine's, and the concat succeeded *despite* it.

- **Scene 1 is the film's encode voice.** `crf`/`preset` are reported from it,
  because that is what the finishing pass uses; when scenes disagree, `warnings`
  says so rather than letting the block read as uniform.
- **`neednotMatch` is measured, not assumed.** A segment encoded at a deliberately
  different profile and GOP concatenates and decodes back bit-identically — each
  segment is its own encode and therefore opens on a keyframe, which is all
  `concat -c copy` requires.
- **`video.codec` is the encoder id** (`libx264`); `probe_asset` reports the codec
  name (`h264`). They are not comparable directly.
- **`signature: null`** for a film with no resolvable scenes — nothing is enforced
  yet, so nothing is claimed.
- **Three lists, not two.** `mustMatch` breaks the join; `neednotMatch` is the
  cargo cult that does not; **`matchForLooks`** is the third answer, for
  parameters that do not affect the join at all but where the joined file keeps
  only segment 1's — so a mismatch is a look difference rather than an error.
  `crf`/`preset` live there (the category the bullet above described in prose and
  had nowhere to put), and so do the colour tags.
- **Colour is stated at the render encode.** Final colour-carrying outputs use
  BT.709 primaries and matrix, sRGB transfer (`iec61966-2-1`), and TV range.
  `signature.color` is derived from the same `setparams` decision and reports
  `stated: true`; GIF and PNG-sequence correctly remain unstated because they do
  not carry this YUV delivery contract.
- **`matchFilm` converts colour; it does not just relabel footage.** The filter
  chain it owns adds `colorspace=all=bt709:trc=srgb` to the film's encode
  contract. An input that lacks complete colour metadata is assumed to be BT.709
  and that decision returns as `assumptions.color`, including on a cached call.
  The assumption is visible because it is not a measurement.
- **Colour participates in render staleness.** Current sidecars record
  `colorPrimaries`, `colorTransfer`, `colorMatrix`, and `colorRange`; a changed
  value is a `stale_render` problem. Older sidecars that predate these fields are
  unverified rather than falsely declared compatible. See
  [plans/completed.md](plans/completed.md) (design record in git history) for the design
  record and historical measurements that led to this choice.

**Do not confuse this with the render-browser codec rule.** Video played *inside a
composition* must be VP8/VP9/AV1 in `.webm`, because the render browser is
Chromium without proprietary codecs ([frame-api.md](frame-api.md) §11). Video
*concatenated onto the film timeline* must match this signature, which for a
default film means H.264/mp4. Same source file, two destinations, opposite codec
requirements.

## Audio: two modes

- **Per-scene audio (default).** With no master `audio` on the film, each scene's
  own audio is preserved through the concat. All scenes must be **consistently
  audio or all silent** (mixing the two breaks a stream copy → `inconsistent_scenes`).
- **Master audio timeline.** Set it on the film with
  `update_film { film, audio: [{ src, startInFrames?, gainDb?, trimEndInFrames?, fadeInFrames?, fadeOutFrames?, duck? }, …] }`
  — or let `synthesize_speech` / `synthesize_music` / `synthesize_sfx` append to
  it automatically by passing the **film id** as `target`. `src` is relative to
  the **film's own** `assets/`. This lays **one** music-bed-plus-narration
  timeline over the *entire* film, replacing per-scene audio — the clean choice
  for long-form: a score that spans scene cuts, VO placed by absolute frame
  across the whole film.

  It is the same shape as a scene's `config.audio` — trims, fades and `duck` all
  reach the mixer — so a bed you tuned and measured with `preview_audio`
  reproduces exactly at build time. If you are following the "audition, then
  assemble" loop below, attach (or set) the **same track objects** both places.

### Tiling a music loop across the film

The score does not need to be as long as the film. Compose one short piece
(32–64 beats is plenty) targeting the film, then list the **same `src`** several
times at stepped `startInFrames`:

```
update_film {
  film: "my-film",
  audio: [
    { src: "assets/theme.wav", startInFrames: 0,    gainDb: -13 },
    { src: "assets/theme.wav", startInFrames: 1440, gainDb: -13 },
    { src: "assets/theme.wav", startInFrames: 2880, gainDb: -13 },
    …
  ]
}
```

Step by the piece's **`musicalDurationSeconds` × fps**, not by its WAV length:
`synthesize_music` reports both, and the WAV is longer because it carries the
reverb tail. Stepped on the musical grid, each repeat starts in time while the
previous tail decays underneath it — a free crossfade at every seam. (A 48 s
theme at 30 fps tiles every 1440 frames; seven placements cover a five-minute
film.)

### Placing multi-clip narration (and a second voice)

A scene that chains clips — narrator, a quotation in a second voice, narrator
again — derives every offset from the **measured** clip lengths, never from the
text.

**Get `filmOffset` from the tool, never by adding up durations yourself**:
`get_film { film }`, or `build_film { film, plan: true }`, returns the resolved
`plan` — its `sceneLayout` carries every scene's `filmOffset`, `durationInFrames`
and `startSeconds` — and `plan: true` assembles nothing and does **not** require
the scenes to be rendered, so you can call it as soon as the scenes exist in the
film and their durations are set. That is exactly when you need the numbers,
because narration and cue frames are derived from them. Accumulating the offsets
by hand works right up until one slip silently desyncs audio from picture, and
nothing downstream checks it.

For a scene starting at `filmOffset`:

```
a = filmOffset + LEAD                  # narr-a starts after the scene lead-in
q = a + narrA.durationInFrames + GAP   # the quote voice
b = q + quote.durationInFrames + GAP   # narr-a's voice resumes

update_film { film: "my-film", audio: [
  { src: "assets/narr-a.wav", startInFrames: a },
  { src: "assets/quote.wav",  startInFrames: q },
  { src: "assets/narr-b.wav", startInFrames: b }, …
] }
```

`GAP` of 15–20 frames reads as a natural breath. Scene-local visuals (subtitle
cues, beat-synced effects) use the same numbers minus `filmOffset`, so
re-synthesizing any clip means re-measuring once and updating both places — and
the "size the scene to the voice" assertion below generalizes to the chain:
the *last* clip must still end inside the scene.

## Levels: measure, never inherit

When the film has a master `audio` timeline, `build_film`'s finished job status
carries an `audio` block with the **measured** peak/mean dBFS of the finished
film and a `clipping` flag — read it via `get_render_status`/`wait_for_render`
once the build job completes. A bad mix is the one defect you cannot see in a
preview frame, and the render path has reported these numbers since v0.10 —
`build_film` does too.

**Do not copy a master gain from a previous film.** Levels are a property of the
*voices and beds you actually used*, not of your taste. A worked example: an
en-US narration film mixed correctly at a +4 dB master lift; the zh-TW OneCore
voices in the next film conditioned about 5 dB hotter through the same
`speechnorm` chain, and that same +4 would have put speech at **+1.4 dBFS** —
forcing the limiter to act on every consonant. That is the failure mode to fear,
because unlike clipping it is not reported and does not sound broken; it just
sounds slightly muddy, which is fatal for a children's narration.

The reliable procedure:

1. Condition each narration clip (`speechnorm=e=9:r=0.0004:l=1,volume=-3dB` is a
   good starting chain) and **measure the loudest one**.
2. Set your *relative* balance from that — bed mean ~30 dB under the voice,
   transition cues peaking ~20 dB under it.
3. Let `build_film` place the absolute level: pass **`audioTargetPeakDb: -2`**
   (or persist it first with `update_film { film, audioTargetPeakDb: -2 }`).
   It measures the assembled mix, applies one offset to *every* track (so your
   balance is preserved exactly), re-muxes, and re-measures. The returned
   `audio.appliedOffsetDb` tells you what it moved.

Re-assembly is cheap — the concat is a stream copy, so a level correction on a
ten-minute film costs seconds. Measure and fix; never ship a guess.

**To move the whole mix by hand, use `audioGainOffsetDb`** (v0.24) rather than
rewriting the timeline: `update_film { film, audioGainOffsetDb: -2 }` shifts
every saved track by the same amount, so the balance you verified survives — the
same arithmetic `audioTargetPeakDb` performs automatically, for when you want to
state the offset yourself. Before it existed, "lower everything 2 dB" meant
re-sending every track in full because array fields replace wholesale; on a
21-track timeline that is a few kilobytes of JSON re-transcribed to change one
number each, and a transcription slip silently reverts a track. Use
`audioPatch: [{ id, gainDb }]` for individual tracks the same way.

`output.audioLimiter` (default true, set per scene via `update_scene_config`; the
build reads it from the **first scene's** output config when mixing the master
audio) still brick-walls the result — at **−1.5 dBFS** since v0.24, half a
decibel below full-scale-minus-one so that AAC's intersample overshoot cannot
push the encoded deliverable back to 0 dBFS. Treat it as a seatbelt, not a
mixing tool: if the limiter is doing work, the mix is already wrong.

**The SFX bed is calibrated the same way.** `synthesize_sfx` (v0.12) renders a
whole cue list — chimes on cuts, a shimmer under a reveal, a thud on an impact —
into one track, and by default it *leaves a quiet bed quiet* rather than
normalizing it, so the `peakDb` it reports is a real level you can balance
against. Attach it (target the film for the master bed) with a `gainDb` derived
from that number, not from a previous film. See [sfx-setup.md](sfx-setup.md).

## Highest quality

The concat itself is lossless, so quality is set by how you **render the
scenes** — and, only if the film needs one, an automatic **finishing pass**:

1. Render scenes at a **high-quality setting** — either a low `output.crf` (14–16)
   or, best, `output.format: "prores"` (422 HQ, 10-bit) / `png-sequence` as lossless
   intermediates. Set these via `update_scene_config`'s `output` object.
2. `build_film` to stitch (`-c copy`, lossless, near-instant).
3. **Only if the film has overlays or burns captions**, `build_film` itself runs
   **one** finishing encode of the picture right after the concat, using the
   crf/preset from the **first scene's** `output` config — still a single
   generation of lossy video encoding, not one per scene. A film with only a
   master audio timeline (no overlays, no burned captions) never re-encodes the
   picture at all — the lossless concat *is* the delivery file's video, with the
   master audio mixed onto it in the same pass.

Pick resolution/fps deliberately: 1920×1080@30 is the sweet spot; 4K is ~4× the
render cost; 60fps doubles frames. Even dimensions are required for mp4/webm/prores.

## Platform versions: one edit, several deliveries (Stage A)

`film.json` can save named **deliverables** beside the one shared timeline. The
built-in presets are `youtube-16x9` (1920×1080), `shorts-9x16` (1080×1920), and
`square-1x1` (1080×1080). An agent resolves platform words in the brief *when it
creates the film*:

```js
create_film {
  name: "Car promo",
  deliverables: ["youtube-16x9", "shorts-9x16"]
}
```

The result saves full snapshots — output name, target geometry, caption style,
title/caption safe insets, a default crop focus and optional per-segment crop
focus. Changing a global preset later never changes an existing film. When the
call does not state width/height, the first requested version supplies the master
scene canvas; the other version is produced later from that same approved cut.
If the brief names no platform, the normal default is **master only** rather than
three speculative deliveries.

Build the master normally, or select a saved version:

```js
build_film { film: "car-promo" }
build_film { film: "car-promo", deliverable: "shorts-9x16" }
```

Stage A concatenates the rendered master losslessly, then re-encodes the selected
variant once at its target geometry with a timeline-aware crop. It does not
re-render the scenes and does not create a second edit. Each version has an
independent output filename, `.srt` sidecar, `<base>.review.json`, and
`<base>.contact.png`; the contact sheet draws the saved safe areas. The completed
job reports the exact `deliverable` and `reEncoded: true`.

This is deliberately not a responsive scene renderer. Text built into a landscape
scene can crop badly in a portrait reframe. Use the per-scene crop controls in the
Studio film inspector, review the safe guides, and reserve a future responsive
scene rerender for compositions that need a genuinely different layout.

## Tool contract

`build_film` is an **async job**: it validates and returns
`{ jobId, state, queuePosition?, outputPath, totalFrames, filmId, hint }` immediately,
before anything is assembled — poll with `get_render_status { jobId }` or block
with `wait_for_render { jobIds: [jobId] }` until it reaches `done`. Master audio,
overlays and captions are **not** arguments here — they live on the film document
itself, set with `update_film`; `build_film` just builds whatever the film
currently has.

| arg | meaning |
|---|---|
| `film` (req) | the film id (slug) to build. Its `scenes` array (`update_film { scenes: [{slug}, …] }`) is the play order — every scene in it must already be rendered |
| `plan` | return the resolved layout + `problems` **without building**, and without requiring the scenes to be rendered — nothing is assembled or written |
| `outputFilename` | override + persist the film's output filename (bare; extension is forced to the scenes' format; default `film.<ext>`) |
| `audioTargetPeakDb` | −60..0 or `null`. Override + persist the mastering target — measure the mixed film and re-mux **once** so it peaks here (e.g. `-2`), shifting every track by the same offset so the balance is preserved |
| `burnCaptions` | override + persist caption burn-in (a `.srt` sidecar is written whenever the film has captions, whether or not this is set) |
| `deliverable` | saved platform version id to build (for example `shorts-9x16`). Omit for the master. Do not combine it with `outputFilename`; edit the saved version's filename instead. |

`plan: true`'s response is `{ film, plan: true, totalFrames, durationSeconds, fps, format, sceneLayout, problems }` — no `jobId`, since nothing was submitted.

The **finished** job's status (from `get_render_status`/`wait_for_render`) carries
`{ outputPath, filmId, promoted, framesVerified, … }`, plus — whenever the film has a master timeline —
**`audio: { tracks, limiter, peakDb, meanDb, clipping, targetPeakDb?, appliedOffsetDb? }`**.
Errors from the initial call (before a job is even created): `scene_not_rendered`, `stale_render`,
`inconsistent_scenes`, `invalid_film` (a malformed `audioTargetPeakDb`,
`outputFilename` or other film field — `detail.problems` lists every one),
`path_not_allowed`, `file_not_found` (a master-audio or overlay asset the
film references is missing), `film_not_found`, `invalid_id` (malformed film id),
plus `prereqs_missing`/`ffmpeg_failed` from the encoder once the job is running.

## Worked example

```
# one film; every scene inherits its sceneDefaults automatically
create_film  { name: "My Film", slug: "my-film", width: 1920, height: 1080, fps: 30 }
  → film: "my-film"
create_scene { film: "my-film", slug: "title", name: "Scene 1 — Title", durationInFrames: 150 }
create_scene { film: "my-film", slug: "body",  name: "Scene 2 — Body",  durationInFrames: 600 }
create_scene { film: "my-film", slug: "outro", name: "Scene 3 — Outro", durationInFrames: 150 }
  → each create_scene appends itself to the film's play order automatically

# author + render each scene (render nothing here that build_film will redo)
write_composition_file { scene: "my-film/title", path: "composition.js", content: … }
render { scene: "my-film/title" } ; poll get_render_status → done
… repeat for "my-film/body" and "my-film/outro" …

# a master score, written straight into the film's own assets/
synthesize_music { target: "my-film", mode: "asset-only" }   → assets/music-1.wav

# put it on the film's master timeline
update_film { film: "my-film", audio: [{ src: "assets/music-1.wav", gainDb: -8 }] }

# stitch — an async job
build_film { film: "my-film", outputFilename: "my-film" }
  → { jobId, state: "running", outputPath: "…/films/my-film/out/my-film.mp4", totalFrames: 900 }
wait_for_render { jobIds: [jobId] }
  → done — …/films/my-film/out/my-film.mp4  (900 frames, 30s, one continuous film)
```

## The pattern that scales: one engine, scenes as data

For a film of more than a couple of scenes, don't write a bespoke composition per
scene. Write **one** `composition.js` that reads a per-scene config object, and give
each scene its own tiny config file:

```html
<script src="frame-api.js"></script>
<script src="scene.js"></script>        <!-- window.SCENE = { … } — differs per scene -->
<script src="composition.js"></script>  <!-- the shared engine — identical everywhere -->
```

The engine turns `window.SCENE` (background, sprites with positions/entrances, a
library of named effects, camera keyframes, dialogue timing, titles) into per-frame
draws. Every scene ships the **same** `composition.js`; only `scene.js`
changes. This keeps the "one film, many scenes" model cheap to author — a
new scene is a data file, not new code — and it's how a 7-scene, five-minute
cutscene was built.

**Iterate one scene at a time.** Because each scene is its own composition inside
the film, fix a single scene's config, re-render *only that scene*, and call
`build_film` again — the other scenes' rendered outputs are reused untouched and
the whole film re-stitches in seconds. That render-one / reassemble loop is what
makes a long film tractable.

**Fixing the shared engine: use `sync_shared_files`.** Each scene owns its own
*copy* of `composition.js`, so editing the one you authored first reaches nothing
already scaffolded. On a 16-scene film a one-line art fix otherwise means sixteen
`write_composition_file` calls. Instead:

```
sync_shared_files {
  sourceScene: "my-film/title",
  targetScenes: ["my-film/body", "my-film/outro", …],
  files: ["composition.js", "styles.css"]
}
```

Every target gets the same syntax check and determinism lint as a normal write,
and all source files are read before anything is written, so a bad path fails
before it half-updates the film. Note what it does **not** do: it will not touch
`scene.js` unless you list it (that is the per-scene data, and listing it would
overwrite every scene with scene 1's), and already-rendered output is not
invalidated — **re-render the affected scenes yourself**. The target scenes do
not have to live in the source's film — `sync_shared_files` has always worked
across films, so an engine fix can be pushed to every film that borrowed it.

### Reusing an existing scene: `clone_scene`

The pattern above is how a film's scenes stay consistent while it is being
built. The other half of reuse is starting a *new* scene from one that already
works — a title card restyled, a second take of a shot, a proven layout carried
into another film. Do not re-author it from the template: **clone it.**

```
clone_scene { from: "my-film/title", toFilm: "other-film" }
  → { scene: "other-film/title-copy", copied: { files: 7, bytes: 812004, assets: 2 }, warnings: [] }
```

One call brings across everything an author wrote: the composition files,
`frame-api.js`, every file under `assets/`, any vendored 3D library build, and
the whole `scene.json` — fps, dimensions, duration, audio tracks, output
settings — with only `name` replaced. That last part is what the hand-built
recipe (`create_scene` → `update_scene_config` → `sync_shared_files` →
re-attach assets and libraries) keeps losing, and the asset step is not even
expressible through the tool surface: nothing else returns asset *bytes*, so a
hand-copied scene arrives with dead references and the wrong duration.

What does **not** come across is what a render derived: no `out/`, no
`revisions/`. The clone starts unrendered, so render it before `build_film`.
The assets are real copies rather than links, which is the point — the clone is
a live scene, and editing it, its files, or its assets never reaches back into
the source. Cloning into the source's own film is fine ("give me another one of
these"); the slug is derived from the name and auto-deduped (`-2`, `-3`, …),
while an explicit `slug` that is already taken is an error rather than a
surprise. The clone lands at the end of the destination film's play order.

Then read `warnings` before moving on. Cloning across films is exactly where
the consistency invariant bites: a 1920×1080/30 scene dropped into a 1080×1920
film is reported as a signature mismatch rather than refused, because
clone-then-reframe is legitimate work. Fix it with `update_scene_config`, or
keep it deliberately — but decide, rather than discovering it at `build_film`.

The clone also remembers where it came from. `config.clonedFrom` records
`{ scene, revisionId, at, agent }`, with `revisionId` pinned to the source's
current revision when it has one and `null` when the source has never been
rendered — naming a scene that has since been rewritten would answer less than
it appears to. It is engine-stamped provenance, not a setting:
`update_scene_config` will not write it.

## Narration-first timing

For anything voice-led, synthesize the narration **before** you size the scene,
and let the audio decide `durationInFrames`:

```
synthesize_speech(...)            → durationInFrames for the clip
durationInFrames = LEAD + <narration frames> + TAIL     // e.g. LEAD 24, TAIL 38
update_scene_config { scene, patch: { durationInFrames } }
```

Then the visuals cannot drift out of sync with the voice, because the picture is
cut to the voice rather than the other way round. Sizing the scene first and
hoping the VO fits is what produces either dead air at the end of a scene or a
line still talking over the next cut. Two ten-minute films built this way landed
every one of their scenes with exactly the intended tail frames and zero
overruns; the check is worth automating — assert
`narrationStart + narrationFrames <= sceneStart + durationInFrames` for every
scene before you render anything.

## Using external assets: images, footage, and the workspace library

Backgrounds, sprites, and other images live under the target's `assets/` — a
scene's for scene-local art, the film's for master-timeline overlays — and are
referenced as `assets/<name>`. Ingest smaller files directly with
`write_asset_file { target, path, contentBase64 }` (base64, capped at 25 MB).

**For anything large or already provided by the human** — background plates, a
shot's raw footage, a soundtrack, a whole photo set — reach for the **workspace
library** instead of pushing bytes through a tool call:

- The human drops files into `<workspace>/library` directly (or uses the
  Studio's upload panel); `list_shared_assets` enumerates what's there — `path`,
  `bytes`, `mtime`, `kind` — per file.
- `use_shared_asset { target, path, as? }` links one into a scene's or film's
  `assets/` (default destination `assets/library/<path>`) — hardlinked when the
  filesystem allows (a 500 MB plate costs no extra disk), copied otherwise.
  Pulling the same file again refreshes it, so an updated library asset
  propagates on request.
- This is exactly what `write_asset_file` points you at when a file trips its
  25 MB cap (`asset_too_large`).

A few determinism rules learned the hard way, whichever way the file arrived:

- **Load images before you register.** Preload every image (`new Image()` +
  `Promise.all`) and only then call `registerComposition`, so `setFrame` isn't defined
  until the assets are ready — the renderer waits for that handshake, guaranteeing each
  captured frame has its images. Drawing local images onto a `<canvas>` is fine: the
  render screenshots the *page*, not the canvas buffer, so cross-origin tainting never
  matters.
- **GIFs animate on the wall clock — don't use them live.** An animated `<img>` GIF
  advances by real time, which breaks frame determinism. Convert to a **still**
  (`ffmpeg -i bg.gif -frames:v 1 bg.png`) and drive any motion yourself from `frame`.
- **Pixel art:** set `image-rendering: pixelated` on the canvas/element and
  `ctx.imageSmoothingEnabled = false`, then scale up — crisp big pixels instead of blur.
- **Transparency:** PNGs with alpha composite directly. For a sprite on a solid colour
  (e.g. a ripped sheet), key it out first — and add `format=rgba`, or ffmpeg may drop
  palette/keyed alpha when cropping:
  `ffmpeg -i sheet.png -vf "crop=W:H:X:Y,colorkey=0xRRGGBB:0.2:0.05,format=rgba" sprite.png`

## Scaling to an hour (and why this is the way)

- **Render time scales linearly**, but each scene is a **short, independent,
  resumable** job — render them in parallel across the machine, or overnight, and
  re-render just the scene you changed. A single 108,000-frame monolith would be one
  fragile long job and one unmaintainable timeline function.
- **Assembly is cheap** — a stream copy of N files is near-instant regardless of
  total length.
- **Authoring is the real cost.** For long-form, favor **templated / data-driven
  scenes** (generate many similar scenes from a manifest) and **asset
  compositing** (images/video as the base, code for motion/text/transitions) over
  hand-building every frame.
- **Drive a long batch by frame count, and retry.** Chromium dies intermittently
  mid-screenshot (`Protocol error (Page.captureScreenshot): Target closed`) on
  long runs — observed at both 4 and 6 workers, on different scenes each time,
  with plenty of RAM free. It is flaky, not a bad scene and not memory pressure,
  so lowering the fan-out only changes the odds. **Since v0.14 the capture loop
  self-heals**: a crash-shaped failure relaunches Chromium (up to 3 per render,
  with backoff) and retries the *same frame* in place, so the frames already
  encoded are kept and a flake costs about a second instead of a scene. A job
  that spends the whole budget fails with `browser_crashed` — at that point the
  machine is crashing, not flaking. Scene-level retry remains the backstop, and
  the resume condition is unchanged: skip a scene whose output already has
  exactly `durationInFrames` frames. Since v0.11 the renderer verifies that
  count itself and fails with `short_render` rather than returning a truncated
  file, so "the output exists and is the right length" is a trustworthy resume
  condition.
- **Wait, don't poll.** For a queued batch, `wait_for_render` (v0.14) with the
  whole list of jobIds replaces a `get_render_status` polling loop; it returns
  when every scene is terminal (or on timeout, with the current snapshots).
  Check each returned state — one failed scene does not stop the others.
- **Skip redundant pre-flights.** If you have just verified every scene with
  `capture_preview_frames`, pass `preflight: false` to `render` — the probe
  would re-check what you just looked at, at one Chromium launch per scene.

## The Studio film editor

A film is a **persistent document from the moment you `create_film` it** —
reopenable, editable a track at a time, buildable many times — shared between the
Studio's **visual film editor** and these MCP tools; both edit the exact same
`film.json`.

- **In the Studio:** the rail's **films** section (+ new → the editor at
  `/film.html?id=…`; `get_film`'s response includes this `editorUrl` directly).
  Timeline tracks for scenes (drag to reorder, per-scene render buttons,
  compatibility flags), master audio (waveforms, drag/trim, gain/fades/duck),
  captions and overlays; a preview that plays the real rendered scenes with the
  build's exact ffmpeg mix; a build panel with live job progress and measured
  levels. See the walkthrough in [user-guide.md](user-guide.md#the-film-editor).
- **Over MCP:** `get_film` / `update_film` / `list_films` / `remove_film` read
  and edit the same document; `build_film` assembles it as an async job (poll
  like a render). See [mcp-setup.md](mcp-setup.md) for the full tool reference.

Two capabilities are applied only by a **finishing pass** — one extra encode
after the lossless concat, run only when used:

- **Overlays** — images (logo, watermark, lower-third) or videos (a
  transparent `.webm` stinger keeps its alpha) composited over the film with
  percent-of-frame geometry, opacity, and a frame-accurate window
  (`update_film { overlays: [...] }`). Overlay assets live in the film's own
  `assets/` (video extensions are accepted there for this purpose).
- **Captions** — text cues with frame-accurate in/out (`update_film { captions: [...] }`).
  A **`.srt` sidecar is always written** next to the built film; `burnCaptions`
  additionally renders them into the picture via a generated `.ass` (font size
  and position are resolution-relative, set in `captionStyle`).

The finishing pass takes its encode settings (crf/preset) from the **first
scene's** `output` config — so the "one final delivery encode" from the quality
pipeline above and the finishing pass can be the same single generation of loss.

## Current limits

- **No built-in transitions.** Cuts only. For crossfades, bake the transition into
  adjacent scene tails/heads, or run a separate `xfade` pass on the master (that
  step re-encodes at the boundary).
- **Whole-scene only.** `build_film` uses each scene's full rendered output; it does
  not sub-range a scene (render the scene to the length you want instead).
- Mixed audio/silent scenes require a master `audio` timeline (see above).
