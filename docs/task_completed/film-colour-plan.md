# Film colour — state it at the render encode instead of inheriting it

> **Status: IMPLEMENTED.** Final colour-carrying encodes state
> `bt709` / `iec61966-2-1` / `bt709` / `tv`; `matchFilm` converts footage to
> that contract and reports an untagged-input assumption. Render sidecars make
> old output unverified and changed colour settings stale. The implementation is
> covered by real ffmpeg tests; rebuilding the named historical promotion remains
> an optional artefact-level verification outside this checkout.

## Read this first: three options, and what this document is

Three ways to settle the film's colour. They are named once, here, and referred to
by letter everywhere below:

| | | status |
|---|---|---|
| **A** | Convert and tag `bt709`. The film states its colour; footage conforms to it. | **what this plan specifies** |
| **B** | Tag `smpte170m` — write down what the encoder already does, move no pixels. | the alternative, weighed at the end |
| **C** | Report only: say colour is unstated and let the caller see the difference. | **shipped** (v0.22), the baseline |

**Everything under [Design](#design--option-a-in-four-parts) is option A.** Its
four parts are numbered `A§1`…`A§4` to keep them visibly distinct from the option
letters: they are *steps of A*, not further options. `A§1` makes the film have a
stated colour, `A§2` makes footage match it, `A§3` stops a half-re-rendered film
from mixing two matrices invisibly, `A§4` is the one value left open inside A.
They ship together or not at all — `A§1` without `A§3` is worse than doing nothing.

B appears only in [The alternative](#the-alternative-and-why-it-is-not-the-plan).
C needs no section — it is already in the codebase.

## Why

Found by reading a real build back (`motion-studio-promo`, ffmpeg 8.1.1): the
film's scenes and its footage segment carry different colour tags, the joined file
advertises only segment 1's, and `ffmpeg -i film.mp4 -f null -` logs a filter
reconfiguration at the cut.

| | primaries | transfer | matrix | range |
|---|---|---|---|---|
| scene render | `bt709` | `iec61966-2-1` (sRGB) | *unset* | `tv` |
| camera footage | `bt709` | `bt709` | `bt709` | `tv` |

Both are `yuv420p`, so they stream-copy and every frame decodes. It is a look
difference, never a broken concat — which is exactly why nothing catches it.

**The engine states no colour at all.** A scene's tags are whatever Chromium's
PNGs and ffmpeg's default conversion happen to produce. That is not a gap in the
reporting; it is a gap in the *encode*, and it has a sharper consequence than the
footage mismatch:

> A render forced to `setparams=colorspace=smpte170m` is **byte-identical** to
> today's output.

So the engine converts RGB→YUV with the **bt601** matrix while tagging the result
`bt709`/sRGB with the matrix left unset. The file does not agree with itself, and
every player that assumes bt709 for HD — the normal assumption — already decodes
Motion Studio's own scenes with the wrong matrix. The footage seam is the symptom
that made it visible; this is the defect.

## Why this cannot be done in `transcode_asset`

The obvious shape — have `matchFilm` pass colour flags derived from a probe of the
film's first rendered scene — fails three ways, all measured:

1. **`-color_primaries` and `-color_trc` are silently ignored** on this pipeline.
   Re-encoding `bt709` footage with `-color_trc iec61966-2-1` yields a file still
   tagged `transfer=bt709`: frame properties from the decoder win over the output
   option. The tool would report a conform it did not perform.
2. **`-colorspace`, the one flag that takes, changes pixels** — it re-matrixes the
   picture (measured: different `framemd5`, +2.6% file size, no change in encode
   time). A re-encode of the image, not a tag.
3. **There is no coherent target to conform to.** Probing scene 1 reports an
   accident of the installed Chromium/ffmpeg pair, obtainable only after a render,
   and — per the byte-identity above — an accident that disagrees with itself.
   Conforming footage to it would replicate the defect and freeze it into a
   `.transcode.json` identity that survives the next ffmpeg upgrade.

Hence: **state it at the render encode.** Stated there it becomes config-derived,
so `filmSignature()` reports it under the same derived-at-call-time rule as
everything else, and `matchFilm` inherits it without a probe.

## Design — option A, in four parts

All four are option A. None of them is an alternative to another.

### A§1. The render encode states colour, via `setparams`

Measured: `setparams` is the only mechanism that sets all four properties. The
values, for every colour-carrying format:

```
setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709
```

`range` stays `tv` (libx264's default, already what the files carry). `gif`
(palette) and `png-sequence` (RGB frames) get no colour step; `INTERMEDIATE`
(ffv1, rgb24) does not either — tagging happens at the final transcode out of it.

**It must NOT go inside `buildVideoArgs()`.** That returns a flat argument list to
callers who already own a `-vf` (`transcode.js`'s crop/scale/fps chain) or a
`-filter_complex` (`gif`'s palette graph, `buildFilmArtifact`'s finishing pass). A
second `-vf` wins outright and silently discards the first — the identical trap
`buildPictureArgs` already documents for frame decimation. Export the filter
*string* from `formats.js` and let each caller fold it into the chain it owns.

### A§2. `matchFilm` converts footage; it does not relabel it

Relabelling would make the footage claim a transfer its pixels do not have — the
same class of lie the current renders tell. The built-in `colorspace` filter does
the real conversion and needs no new prerequisite (verified: `bt709` footage →
`transfer=iec61966-2-1`, primaries and matrix preserved, pixels changed):

```
colorspace=all=bt709:trc=srgb
```

**Untagged footage fails hard** — measured: `Unsupported input primaries 2
(unknown)`, and the whole filter graph errors. A source that says nothing about
its own colour cannot be converted without an assumption, so `matchFilm` must
either supply `iall=bt709` (the HD convention) **and report the assumption in the
response**, or refuse with a message naming the fix. Reporting is the better fit
for a tool whose contract is *report by measuring, never by echoing* — but an
assumption applied silently would break that contract outright.

### A§3. Colour goes in the render sidecar

This is the part that is easy to skip and expensive to omit. Colour is not in
`sceneSignature()`'s id, and `validateScenes` does not compare it — so a film
re-rendered **scene by scene** after this ships would mix 601-converted and
709-converted scenes with nothing detecting it. That is a worse failure than the
one this plan fixes, because it is invisible *within* the rendered scenes rather
than at a footage seam.

`readRenderMeta` / `renderStaleness` / `describeStaleness` already exist for
exactly this (they gained `pixFmt`/`transparent` in v0.22 for the same reason).
Reuse the established pattern: an older sidecar with no colour field stays
**unverified** rather than turning up stale.

### A§4. Sub-decision: which transfer to state

Left open deliberately, because it is the one value with a real trade-off:

- **`iec61966-2-1` (sRGB)** — *recommended to start.* Truthful and free: Chromium
  draws in sRGB and nothing in the pipeline converts it, so this states what the
  scene pixels already are. Footage converts to match (one filter, above).
- **`bt709`** — the delivery convention, and the most robust against players that
  ignore transfer tags entirely. But it means converting the *scenes'* transfer
  too, so the pixel change to every render is slightly larger.

Both are self-consistent. Start with sRGB; revisit if a delivery target
demonstrably mishandles it.

## Rules it must obey

- **Derive, never duplicate.** Same rule as
  [film-signature-plan.md](film-signature-plan.md): once stated,
  `signature.color` reads back from the same place the encode gets it, never from
  a second table. `stated: false` becomes `stated: true` with real values, and no
  probe appears anywhere in `filmSignature()`.
- **Never relabel what you have not converted.** A tag that disagrees with the
  pixels is the defect being fixed, not a shortcut for fixing it.
- **Say what was assumed.** Untagged footage forces an assumption; it goes in the
  response, not in silence.
- **Do not let a mixed-matrix film pass as consistent.** If the sidecar work is
  cut, cut the whole plan — the render change without staleness detection is a net
  loss.
- **Say when nothing is stated.** A film whose format carries no colour (`gif`,
  `png-sequence`) keeps `stated: false`. Do not invent tags for a palette.

## TODO

- [x] `engine/src/core/formats.js` — export the colour filter string per format
      (null for `gif`/`png-sequence`/`INTERMEDIATE`). One definition, no second copy.
- [x] `engine/src/core/encoder.js` — fold it into `FfmpegFrameSink`'s args,
      `encodePngSequence` and `transcode()`. None of the three has a `-vf` today,
      so each gains one.
- [x] `engine/src/core/films.js` — `buildFilmArtifact`'s finishing pass. **Verified
      unnecessary as a first cut**: a `-filter_complex` re-encode of a tagged input
      preserves all three tags. Assert it in a test rather than trusting it, since
      the overlay graph is what would break it.
- [x] `engine/src/core/film.js` — colour into the render sidecar;
      `renderStaleness` reports it; `describeStaleness` renders it
      (`colorMatrix bt601 → bt709`); an older sidecar stays unverified, not stale.
- [x] `engine/src/core/films.js` — `filmSignature().color` becomes
      `stated: true` with the real values, still derived at call time. Colour moves
      out of `matchForLooks`… **or does it?** It still cannot break a concat, so it
      probably stays there with `stated: true` beside it. Decide when implementing;
      the two fields answer different questions.
- [x] `engine/src/core/transcode.js` — `matchFilm` folds the `colorspace`
      conversion into `buildPictureArgs`'s existing `-vf` chain (after crop/scale,
      before/with `fps`), and handles untagged input per A§2. The signature's
      `ffmpegArgs` stay usable verbatim; the conversion is a filter, not an arg.
- [x] Tests: the filter string appears exactly once per encode path; a
      round-trip render reports the stated tags; `matchFilm` output matches the
      film on all four properties; untagged footage reports its assumption;
      a scene rendered before the change reads as **stale**, and one with no colour
      in its sidecar reads as **unverified**; the finishing pass preserves tags.
- [ ] **Historical artefact proof (optional):** rebuild `motion-studio-promo`, assert
      rebuild `motion-studio-promo`, assert `film.mp4` and the footage segment
      agree on all four properties, and that `ffmpeg -i film.mp4 -f null -` logs
      **no** filter reconfiguration at the seam.
- [x] Docs: `film-setup.md` (rewrite the colour bullet — it currently documents the
      unstated state and links here), `mcp-setup.md`, `architecture.md` §13,
      `SKILL.md`, `SKILL-shell.md`, `CHANGELOG.md`, and this file's status block.

## Ranked: token cost, quality, performance

Three options, including the one already shipped. **A** = this plan (convert and
tag `bt709`); **B** = tag `smpte170m`, what the encoder already does; **C** =
report only, no encode change — shipped in v0.22 and the baseline the other two
build on.

Measured first, so the performance column is not an opinion — 30 frames of 1080p,
`-preset medium -crf 18`, best of 3 runs:

| variant | file size | encode time |
|---|---|---|
| today (no colour stated) | 1,175,095 B | 397 ms |
| **A** — convert + tag `bt709` | 1,205,745 B (**+2.6%**) | 378 ms |
| **B** — tag `smpte170m` | 1,175,117 B (+0.002%) | 398 ms |

Encode time is identical within noise for all three: swscale runs the conversion
either way and merely uses different coefficients, and `setparams` is pure
metadata. The only runtime difference is A's slightly larger file (synthetic test
pattern — real content will vary).

| | token cost (to build) | quality (result) | performance (runtime) |
|---|---|---|---|
| **A** — this plan | 3rd — heaviest | **1st** | 3rd — +2.6% size, same speed |
| **B** — tag `smpte170m` | 2nd — light | 2nd | **1st** (tied) — free |
| **C** — report only *(shipped)* | **1st** — done | 3rd | **1st** (tied) — free |

**Token cost.** C is zero, it is built. B is a small delta: the filter in the two
render encode paths, the signature reporting real values instead of nulls,
`matchFilm` carrying them, tests and docs. A is roughly 2–3× B, and the extra is
entirely the consequence of moving pixels — the render sidecar and
`renderStaleness` work (A§3), plus a real conversion in `matchFilm` rather than a
relabel (A§2). Neither of those is optional *for A* and neither is needed *for B*.

**Quality.** A is the only option where the scenes and `bt709` footage agree on
the matrix, leaving one property to reconcile and reconciling it *upward* rather
than degrading the user's own material. B is self-consistent but tags HD as SD.
C leaves the file disagreeing with itself.

**Performance.** B and C are free; A's +2.6% is small and not slower. The real
cost of A is not in either table: making an *existing* film internally consistent
means re-rendering it, and a 16-scene film is a ~30-minute render. That number,
not the 2.6%, is the one that should decide it.

## The alternative, and why it is not the plan

**Tag what already happens (`colorspace=smpte170m`).** It wins two of the three
columns above, and the win is real: byte-identical output, every existing render
stays valid, files become self-consistent, nothing to re-render.

It loses on the question that started this:

- `matchFilm` would convert real `bt709` camera footage **down** to 601 to join a
  601 film — a lossy, backwards conversion of the user's own material. It makes
  the footage side worse than doing nothing.
- 601 on 1080p is unconventional, and playback paths that derive the matrix from
  resolution rather than the tag would ignore it — leaving the original wrong
  colours in place. (General behaviour, not measured here.)
- It writes swscale's legacy default into the contract permanently, as though
  someone had chosen it.

Take it only if bit-stability with existing rendered output outranks correctness —
finished deliverables that cannot be re-rendered.

## Deliberately out of scope

- **Grading, LUTs, or any look control.** This is colour *metadata* and the one
  conversion needed to make it true. `vignette`-style treatment belongs to the
  composition, not the encode.
- **HDR, wide gamut, 10-bit.** `bt2020`/PQ/HLG is a different feature with a
  different pixel format and its own concat consequences.
- **Per-scene colour overrides.** The film has one contract; a per-scene override
  would be a per-scene way to break it.
- **Re-rendering anyone's existing films.** The staleness flag tells the user; the
  decision stays theirs.
