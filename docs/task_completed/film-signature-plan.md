# Film signature — state the encode contract instead of hiding it

> **Status: SHIPPED (unreleased, v0.22).** This file is kept as the design
> record. For how to *use* it, read
> [film-setup.md](../film-setup.md#reading-the-contract-get_films-signature-v022)
> and the `get_film` row in [mcp-setup.md](../mcp-setup.md); for what shipped, see
> the [CHANGELOG](../CHANGELOG.md).
>
> It led because it was the cheapest correctness win available and every later
> plan consumes it: [footage-segment-plan.md](../task_completed/footage-segment-plan.md)
> compares against it, [transcode-asset-plan.md](../task_completed/transcode-asset-plan.md)'s
> `matchFilm` resolves from it.
>
> **Five corrections between this plan and the implementation**, each because the
> plan was wrong or under-specified about its own codebase:
>
> 1. **`sceneDefaults.output` does not exist.** `validateFilm` rejects any
>    `sceneDefaults` key outside `fps/width/height/durationInFrames`, and the MCP
>    schema forbids it. The rule "report the film's effective values, including any
>    `sceneDefaults.output` overrides" targeted a non-existent field. The real
>    source is **the first scene's `config.output`** — already how the finishing
>    encode picks its values.
> 2. **`planFilm` already computed and returned the signature string; `planSummary`
>    dropped it.** So "nothing tells a caller what it is" was true of MCP but
>    overstated overall — the Studio front end had been consuming it all along.
>    Propagation was therefore nearly free, and the type change had exactly one
>    consumer.
> 3. **`buildVideoArgs` is exported from `encoder.js`, not `formats.js`** (and was
>    already imported by `films.js`). `filmSignature()` landed in `films.js`, where
>    `planFilm` aggregates the resolved configs.
> 4. **`video`/`audio` cannot be read from a field.** The format registry holds
>    codec identity only inside the returned argument arrays, and `audioArgs()` is
>    nullary — so those sub-blocks are extracted from the arrays by flag lookup.
>    Adding declarative fields to the registry would have created exactly the
>    second copy of the encode table this plan forbids.
> 5. **`neednotMatch` was unverified.** The plan asserted GOP/profile/level need not
>    match, but the prototype never exercised it: libx264 picked the same profile
>    for every segment, so they always agreed. Now measured — a segment at a
>    deliberately different profile *and* GOP concatenates and decodes back
>    bit-identically. The claim is true; it just wasn't proven.
>
> Also beyond the plan: `copyConcat` in the block (a `gif`/`png-sequence` film can
> join nothing, and the block should say so rather than read as an invitation);
> `warnings` when scenes disagree on crf/preset, so the reported `video` block is
> never quietly untrue of scenes 2..n; `filmSignature()` never throwing for a
> format with no encode step; and the **render sidecar's `pixFmt`/`transparent`
> hole** — both are part of the signature and neither was staleness-checked, which
> made this plan's contract one the engine did not fully enforce.

## Why

Motion Studio's long-form guarantee is that scenes share an encode signature and
therefore concatenate losslessly. `sceneSignature()` computes it,
`validateScenes()` enforces it, and `assembleFilm()` depends on it.

**Nothing tells a caller what it is.**

That is fine while the engine renders every segment. The moment anything arrives
from outside — footage, a supplied clip, a transcode — the caller has to produce a
file that matches an invariant it cannot read. It has two options, and both are
bad:

1. **Guess.** The prototype did. It passed `-profile:v high -level 4.0` (redundant
   — libx264 picks exactly those for 1080p30) and `-x264-params
   keyint=60:min-keyint=30` (Motion Studio uses the default 250; the concat
   succeeded *despite* the mismatch, because each segment opens on a keyframe and
   that is all `concat -c copy` requires). Two out of three guesses were
   cargo-cult. It worked, and the author could not have told you why.
2. **Render something first, then probe it.** Correct, and absurd: pay for a
   render to discover a constant that lives in a hard-coded table.

Here is the actual contract, from `formats.js`:

```js
mp4.videoArgs = ({ crf = 18, preset = 'medium', pixFmt = 'yuv420p' }) =>
  ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
   '-pix_fmt', pixFmt, '-movflags', '+faststart']
mp4.audioArgs = () => ['-c:a', 'aac', '-b:a', '192k']
```

Combined with `sceneDefaults` (`1920×1080`, `30` fps) that is everything needed to
produce a conforming file. It is already computed, already authoritative, and
already invisible.

## This is the `probe_asset` lesson, applied

`probe_asset` shipped in v0.21 and was used **zero times** in the session that
motivated these plans — every media question got answered with `ffprobe` instead.
Not because it was wrong, but because it reported only what a shell could already
report. See [README.md](../todo_task/README.md#the-rule-this-implies):

> Tools that only report lose to the shell. Tools that report what only the
> engine knows do not.

The film signature is the purest available example of the second kind. No amount
of `ffprobe` recovers it from a workspace; the engine holds it and simply never
says it. And unlike plans 1–3, it needs no vendor, no job queue, no sandboxing
decision, and no new tool.

## Design

Add a `signature` block to what `get_film` already returns.

```jsonc
{
  "id": "jordan-four-rivers", "name": "Jordan Four Rivers",
  …
  "signature": {
    // the fingerprint validateScenes() enforces
    "id": "1920x1080@30/mp4/opaque/yuv420p",
    "width": 1920, "height": 1080, "fps": 30,
    "format": "mp4", "container": "mp4", "pixFmt": "yuv420p",
    "transparent": false,

    // what the engine's own encoder emits for this film — the part
    // that is currently unknowable from outside
    "video": { "codec": "libx264", "crf": 18, "preset": "medium" },
    "audio": { "codec": "aac", "bitrate": "192k" },

    // ready to use, so nobody has to reassemble the above in the right order
    "ffmpegArgs": ["-c:v","libx264","-preset","medium","-crf","18",
                   "-pix_fmt","yuv420p","-movflags","+faststart"],

    // what actually has to agree for `concat -c copy`, and what does not
    "mustMatch": ["codec","width","height","fps","pixFmt","container"],
    "neednotMatch": ["gopSize","profile","level","bitrate"]
  }
}
```

### The three decisions

**1. `ffmpegArgs` verbatim, not a description.** A shell-using agent needs to
*run* something. Handing back a prose description and letting it rebuild the flag
list is exactly the reassembly step where the prototype went wrong. Derive it from
`buildVideoArgs(output)` — already exported — so the reported args and the args
the renderer actually uses cannot drift.

**2. `neednotMatch` is as valuable as `mustMatch`.** The prototype's wasted
effort was entirely in over-matching: GOP, profile and level were pinned for no
reason, and a reader of the resulting command would reasonably conclude all three
were load-bearing. Stating what is *not* required prevents the next author from
inheriting the cargo cult — and prevents a future `matchFilm` from pinning
parameters it does not need to.

**3. It goes on `get_film`, not a new tool.** "What must a file match to join this
film" is a property of the film. A separate `get_film_signature` would be one more
call to know to make, and the whole failure mode here is not knowing something
exists.

## Rules it must obey

- **Derive, never duplicate.** Every value comes from `sceneSignature()`,
  `sceneDefaults` and `buildVideoArgs()` at call time. A second hard-coded copy of
  the encode table would be a bug factory: the two would diverge and the *reported*
  one would be wrong, which is worse than reporting nothing.
- **Report the film's effective values**, including any `sceneDefaults.output`
  overrides — not the format registry's bare defaults.
- **Say when there is no signature yet.** An empty film has no scenes and
  therefore nothing enforced; return `signature: null` rather than a plausible
  guess from `sceneDefaults` alone. A confident wrong answer here produces a file
  that fails to concat much later.
- **Carry the existing advisories.** `encodingCompatibilityWarnings()` already
  knows the crf-0 trap (lossless H.264 lands in High 4:4:4 Predictive, which most
  consumer decoders play as black video). If it fires for this film's output, it
  belongs in this block — this is the moment someone is deciding what to encode.

## TODO — all done

- [x] `engine/src/core/films.js` — `filmSignature(configs)` deriving the block
      above from `sceneSignature()` / the first scene's `output` / `buildVideoArgs()`.
      (Not `sceneDefaults`, per correction 1; not `(film, scenes)`, because the film
      document contributes nothing to the encode contract.)
- [x] `get_film` (MCP) and `GET /api/films/:id` (Studio) both return it — one
      implementation. One edit to `planSummary`; the Studio route needed none,
      because it already passed the raw plan through.
- [x] Included in `build_film { plan: true }` too — there is no `plan_film` tool,
      and it shares `planSummary`, so this came for free along with `list_films`
      and `update_film`.
- [x] Tests: byte-identity against both the renderer's call **and** the finishing
      pass's differently-spelled one; the first scene's `output` reflected; an empty
      film returns `null`; webm reports VP9; prores reports container `mov` and the
      profile's real pixel format; `png-sequence` returns `ffmpegArgs: null` without
      throwing; gif has filter args but no codec; a crf-0 film carries the
      compatibility warning; scenes disagreeing on crf warn.
- [x] **Beyond the plan — an end-to-end sufficiency proof**: encode an outside clip
      from the reported block alone, then assert `validateScenes` accepts it,
      `concat -c copy` joins it with a real rendered scene, the result decodes with
      an empty stderr, the frame count equals the sum of the parts, and the external
      segment's pixels survive the seam bit-exactly. Plus the `neednotMatch`
      measurement (correction 5).
- [x] Docs: `mcp-setup.md` (`get_film` + a field-by-field section), `film-setup.md`
      (a new section under the consistency invariant, the sidecar's field list, and
      the do-not-confuse-with-the-render-browser-codec-rule warning),
      `architecture.md` §13, `agent-environments.md`, `SKILL.md`, `CHANGELOG.md` —
      and `SKILL-shell.md`, which is the one that mattered.

### Do not conflate this with the render-browser codec rule

`frame-api.md` §11 already handles a *different* requirement correctly: video
played **inside a composition** must be VP8/VP9/AV1 in `.webm`, because the render
browser is Chromium without proprietary codecs, and it points authors at
`probe_asset` to detect an H.264 file before they write any code.

This plan is about the other target: video **concatenated onto the film timeline**
as a [footage segment](../task_completed/footage-segment-plan.md), which must be H.264/mp4 matching
the film signature. Same source file, two incompatible destinations, opposite
codec requirements.

So `filmSignature()` must be clearly scoped to the timeline case, and neither doc
should imply the other's answer. If anything, this is an argument for naming the
field `signature` (the film's concat contract) rather than anything as generic as
`encoding`.

## Deliberately out of scope

- **Enforcing it on anything new.** This plan only *states* the contract.
  Comparing footage against it is [plan 2](../task_completed/footage-segment-plan.md); producing a
  conforming file is [plan 3](../task_completed/transcode-asset-plan.md).
- **Changing any default.** Not the moment to revisit crf 18 or preset medium.
  Making the current values visible is the entire deliverable.
- **A cross-film compatibility checker.** "Can film A's scenes be reused in film
  B" is a real question and a different feature; two signature strings from this
  block already answer it by string comparison.
