# Render review — let the agent see what it actually made

> **Status: PLANNED.** Nothing here is built. It is the largest capability gap
> found by building two complete films through the MCP surface (a 3:00 product
> ad, a 5:00 tool review), and it is the one place where a competitor is
> straightforwardly ahead: with the community plugin stack, a Remotion agent
> renders, feeds the file to a video-understanding model, and iterates on the
> critique.
>
> **Stated carefully** (an earlier draft of this banner overstated it): an Env A
> agent cannot see the deliverable at all, because no MCP tool returns a frame
> from `out/`. An Env B agent *can* — with a shell it extracts frames itself, and
> that is how three of the four defects below were actually found. What neither
> can do is perceive **motion**, or afford to look at more than a fraction of a
> percent of the frames. See
> [the objection](#but-a-shell-agent-can-already-just-look-at-the-mp4), which is
> the right question to ask of this plan and sharpens what it should build.
>
> The fix is much cheaper than it sounds, and it does **not** require shipping a
> model.

## Read this first: the engine does not need to understand video

The obvious shape — "add a vendor that watches the film and describes it" — is
the wrong first move, for two reasons.

1. **The agent is already a multimodal model.** `capture_preview_frames` returns
   images, and the agent looks at them; that is the entire existing picture
   feedback loop and it works. What is missing is not perception. It is that
   **every image-returning tool points at the composition, never at the
   deliverable.**
2. **A cloud vendor would cost the product one of its three differentiators.**
   Running with the wire cut — local speech, local music, local transcription,
   no keys — is a genuine advantage over the assembled alternative. A review
   loop that requires an API key by default trades that away to match a
   competitor on their ground.

So: **hand back frames of the rendered file, and measure the picture the way the
mixer already measures the audio.** Both are ffmpeg work the engine is already
doing for other reasons. A model vendor is filed here as the *last* part,
optional and off by default, for the people who want the Superpowers loop.

## Why — the asymmetry, stated plainly

Audio is thoroughly instrumented. Picture is not instrumented at all.

| | audio | picture |
|---|---|---|
| pre-render check | `preview_audio` — full mix, real filter graph | `capture_preview_frames` — stills of the **composition** |
| per-source measurement | `clipMeanDb` per clip | — |
| "is anything wrong" | `balanceWarnings` | — |
| time-series | `mix.envelopeDb`, per second | — |
| dead-content check | `mix.silentTailSeconds` | — |
| **on the finished file** | `audio: {peakDb, meanDb, clipping}` | **nothing** |

The last row is the defect. `build_film` reports the assembled film's audio and
says nothing whatsoever about its picture — not even that it is not black.

`core/encoder.js` already exports `measureAudioLevels()`, `computeBalanceWarnings()`
and `mixAudioOnly()`. There is no `measurePictureMotion()`, and nothing that
reads a frame out of `out/`.

### What this cost, in two real films

Every one of these was caught by hand-rolling `ffmpeg` contact sheets in Env B.
**In Env A none of them are findable.**

| Defect | How it was actually found |
|---|---|
| A mirrored reflection rendered as a hard-edged glass slab across the product's front face | the human looked at the delivered file and sent back a screenshot |
| Keyed-out backdrop left a grey smear beside the product on two dark scenes | same — the human, from the delivered file |
| Three `terms` scenes overlapped their two-line values once every row had animated in | a hand-built contact sheet of the built film |
| Burned-in captions landing correctly in the letterbox bar | a hand-built contact sheet of the built film |

The first two are the point. They are **not visible in a single preview frame**
of the composition — the slab only reads as wrong once you see the product
whole, and the smear only reads as wrong against the finished background. Both
shipped. Both were found by a person.

## "But a shell agent can already just look at the mp4"

Correct, and worth answering properly, because it is the strongest objection to
this plan and it changes what the plan should build.

**Yes: in Env B I extracted frames from the delivered files with `ffmpeg` and
looked at them, without any new tool.** That is how the overlapping `terms` rows
and the caption placement were both caught. Nothing here is blocked on access
for a shell agent. Three things remain true anyway:

**1. Env A is genuinely blocked, not merely inconvenienced.** No MCP tool returns
a frame from `out/`. `capture_preview_frames` re-runs the *composition* in a
browser — it never opens the encoded file — so it cannot show a concat seam, a
burned-in caption, a muxed overlay, or anything that only exists after assembly.
For an MCP-only agent the deliverable is write-only.

**2. Sampling does not scale, in either environment.** A 5:00 film is 9,000
frames. Practical budgets:

| approach | frames seen | cost | what it misses |
|---|---|---|---|
| full-res stills | ~20–30 | large context per image | 99.7% of the film |
| tiled contact sheet (what I did) | ~26 at 384×216 | one image, cheap | fine detail — a 2px misalignment is invisible at that scale |
| every frame | 9,000 | impossible | — |

Either way you inspect roughly **0.3%** of the picture and hope the defect is in
the part you chose. The two defects a *human* caught in the ad — a reflection
rendering as a hard-edged slab across the product, and a grey keying smear beside
it — were both present in hundreds of consecutive frames, and I still missed them,
because neither was in my sample and both were subtle at contact-sheet scale.

**3. Stills are not motion.** Frame extraction shows composition, never timing.
Nothing in a contact sheet distinguishes an easing curve that stutters from one
that does not, a `Sequence` that fires two frames late, or a `<video>` layer that
froze. The review film says "I never saw a single frame of it move," and that
sentence is exactly true: I saw frames, not movement.

### What this changes about the plan

It moves the weight from R§1 to R§2, and it re-describes what R§1 is *for*.

- **R§1's value in Env B is not access — it is the sampling policy.** The shell
  can extract any frame; it cannot know that frame 4,692 is the first frame of
  `f7-close.mp4`, or that 23 cuts exist at particular offsets. Sampling at
  `filmOffset ± n` for every block is engine knowledge applied on the agent's
  behalf. In Env A it is also the access.
- **R§2 is the part that actually beats "just look at it,"** and should be
  treated as the centre of the plan rather than the follow-on. `freezedetect`
  scanned all 9,000 frames of the review film in one pass and returned four
  lines. That is the trade this plan is really making:

  > **Measurement compresses the whole film into something an agent can afford to
  > read. Sampling never will.**

  A tool that reports "the picture did not change between frames 4,700 and 4,727"
  has examined 100% of the film for a few hundred bytes of output. Thirty stills
  examine 0.3% for far more.

The honest summary: this plan is less about letting the agent *see* and more
about letting it **check** — and the reason it still matters for Env B is the
budget, not the permission.

## Two measurements that shaped the design

Both run against the delivered `motion-studio-review.mp4` with the bundled
ffmpeg 8.1.2. `freezedetect`, `blackdetect`, `blackframe`, `scdet` and
`signalstats` are all present in that build.

**1. Freeze detection works, and immediately says something true.**

```
ffmpeg -i film.mp4 -vf freezedetect=n=-55dB:d=0.6 -f null -
  → freeze_start 4.700  freeze_duration 0.900
    freeze_start 12.567  freeze_duration 0.933
    freeze_start 15.767  freeze_duration 1.367
    freeze_start 20.433  …
```

Those are real static holds in a real film. Most are intentional — a title card
resting. That is exactly why this is **reported, never errored**: "the picture
did not change for 1.4 seconds" is a fact the author should see, not a verdict.

**2. Generic cut detection does NOT work on this material — and that inverts the design.**

```
ffmpeg -i film.mp4 -vf select='gt(scene,0.25)',metadata=print -f null -
  → one detection, at 30.0s
```

One of five known cuts in the first sixty seconds. The reason is structural: a
designed film cuts between compositions that **share a background, a palette and
a layout grid**, so consecutive frames across a cut are far more similar than
consecutive frames across a camera cut. Scene detection is tuned for the
opposite case.

So the plan does not try to *discover* cuts. It does the opposite: **the engine
already knows every cut frame from `plan.sceneLayout`, and samples and measures
there.** That is knowledge the shell does not have, which is precisely the test
[the README](README.md#the-rule-this-implies) sets for whether a tool earns its
place:

> Tools that only report lose to the shell. Tools that report what only the
> engine knows do not.

An Env B agent can run `freezedetect` today. It cannot know that the freeze at
20.4s sits four frames after a scene boundary, or that the frame at 4692 is
supposed to be the first frame of `f7-close.mp4`.

## Design — four parts

`R§1` and `R§2` are the plan. `R§3` is small and makes the other two land in the
right place. `R§4` is optional, off by default, and ships last.

### R§1. `inspect_render` — frames of the DELIVERABLE, returned as images

The single highest-value addition. Mirrors `capture_preview_frames`, but reads
the encoded file instead of the composition.

```
inspect_render { target, path?, frames? | count?, around? }
  target  "<film>"  or "<film>/<scene>"
  path    defaults to the target's built output; any out/-relative file
  → images, plus for each: frame number, filmOffset context, and which
    scene or footage block that frame falls inside
```

Three sampling modes, because the useful frames are not evenly spaced:

- **`around: "cuts"` (the default for a film)** — the frames that matter most.
  For every entry in `plan.sceneLayout`, sample `filmOffset - 1`, `filmOffset`,
  and `filmOffset + 2`. A blank frame at a cut, a scene that starts before its
  content animates in, a footage block that begins on the wrong in-point: all of
  them live in that triple and nowhere else. The SKILL already warns that "a
  wipe that starts off-screen leaves frame 0 blank, and a blank frame at every
  cut is invisible in any single capture" — this is the tool that makes that
  warning checkable.
- **`around: "holds"`** — the midpoint of every block, which is where a scene is
  fully assembled and layout collisions are visible.
- **explicit `frames: []`** — for following up a specific measurement.

Extract one frame per invocation with `-ss <t> -i <file> -frames:v 1`. Do **not**
batch with `select=eq(n\,N)`: [SKILL-shell.md §1](../SKILL-shell.md) already
records that it silently writes fewer files than asked for on sparse picks.

Cap the count the way `capture_preview_frames` does (24), and downscale before
returning — a 1920×1080 PNG per frame is a lot of tokens for a shape the agent
only needs to recognise, not read.

### R§2. `measure_render` — the picture analogue of `preview_audio`

Numbers, not vibes, in the house style. One pass, no new dependency.

```
measure_render { target, path? }
  → {
      frames, fps, durationSeconds,
      motionEnvelope: [ … ],      // per-second mean frame-to-frame difference
      staticRuns:  [ { startFrame, durationFrames, scene } ],
      blackRuns:   [ { startFrame, durationFrames } ],
      solidFrames: [ { frame, colour } ],
      cutCheck:    [ { expectedFrame, scene, deltaAtCut, verdict } ],
      warnings:    [ … ]
    }
```

`motionEnvelope` is deliberately the twin of `mix.envelopeDb` — same shape, same
purpose, read the same way. A scene whose motion envelope is flat zero for its
whole length never animated.

`cutCheck` is the part only the engine can do. For each known cut frame it
measures the frame-to-frame difference *across* that boundary and reports it:

- difference ≈ 0 at an expected cut → **the two blocks look identical there**;
  either a scene was concatenated twice or a footage block did not advance.
- a large difference *not* at any expected cut → something changed abruptly
  mid-scene. Usually fine, occasionally a `classList` bug of the kind the linter
  cannot see.

`warnings` should stay conservative and name the scene, following
`balanceWarnings`' precedent — a long static run in a title card is normal, and a
tool that cries wolf about it will be ignored when it reports a dead scene.

Mechanisms, all stock and all verified present in the bundled build:
`freezedetect` for `staticRuns`, `blackdetect`/`blackframe` for `blackRuns`,
`signalstats` for per-frame statistics, and a `tblend=all_mode=difference`
chain for the envelope and the cut deltas.

### R§3. `build_film` reports its picture

`build_film`'s finished status already carries `audio: { peakDb, meanDb, clipping }`.
Give it `picture: { staticRuns, blackRuns, cutsChecked, cutsSuspect }` — the
summary counts only, with the detail available from `measure_render`.

This is the change that makes the other two get used. An agent that has just
built a film reads that status object; if the picture summary is sitting next to
the audio summary, a suspect cut gets noticed. If it is behind a tool the agent
has to remember to call, it will not be.

Same for a scene `render`: a single number, `staticFrames`, is enough to catch
the most common composition bug there is — a `Sequence` that never turns
anything on.

### R§4. An optional review vendor — last, and off by default

Only after R§1–R§3. Model this exactly on the existing capability pattern:
`list_vendors { capability: "review" }`, an unconfigured vendor returning
`review_unavailable` naming what to set, and the key in the environment rather
than in settings.

```
review_render { target, prompt?, frames? }
```

Default with nothing configured: **no vendor, and R§1–R§3 still work.** That is
the whole point of the ordering. The hermetic path stays the product's default
behaviour, and the cloud loop is something a user opts into, rather than a
dependency the tool acquires in order to match a competitor.

## What this does not solve

State it plainly, because the gap is not fully closable by measurement:

- **Taste.** Nothing here can tell an agent that the typography is ugly, the
  pacing drags, or the sound effects are unpleasant. On the last one there is a
  measured precedent from the ad: the SFX generator produced cues the client
  called "extremely unpleasant", and no number in the system was wrong. Only R§4,
  or a person, catches that class.
- **Whether the film says the right thing.** `transcribe_asset` on `out/` already
  covers the narration, and is the existing answer.
- **Motion quality.** `motionEnvelope` shows that something moved and roughly how
  much. It cannot tell an easing curve that stutters from one that does not.

The honest framing for the docs: after this lands, an agent can verify its film
is **structurally sound and not broken**. It still cannot verify it is *good*.

## Env A / Env B

| | before | after R§1–R§3 |
|---|---|---|
| **Env A** (MCP only) | cannot see the deliverable at all | can look at every cut and read the picture measurements |
| **Env B** (MCP + shell) | can build contact sheets by hand, does not know where to look | gets the cut list applied for it, and `cutCheck`, which the shell cannot compute |

Env B's gain is smaller but real, and it is the same gain `plan.signature` gave:
the engine stating something the shell would otherwise have to guess.

## Acceptance test

> Re-run the two films that produced this document, and have the tool find the
> defects that a human found.

Concretely, against `bp814-promo` as it was first delivered:

1. `inspect_render { film: "bp814-promo", around: "holds" }` returns the Product
   Reveal mid-frame, in which the reflection slab is plainly visible.
2. `measure_render` reports the three `terms` scenes' rows as overlapping — or,
   more honestly, does *not*, and that is worth knowing before shipping the
   feature, because it bounds what the measurement half can do and tells you how
   much weight R§4 has to carry.

Test 2 failing is an acceptable outcome. Test 1 failing means R§1 was built
wrong.

## Cost and order

| | part | cost | value |
|---|---|---|---|
| 1 | **R§1 `inspect_render`** | small — frame extraction plus the sampling policy | all of the Env A gap; the sampling policy in Env B |
| 2 | **R§2 `measure_render`** | medium — one ffmpeg pass, four filters, the cut arithmetic | **the part a shell cannot replace** — 100% coverage, bounded output |
| 3 | **R§3 report it in `build_film`** | trivial | makes 1 and 2 actually get used |
| 4 | R§4 review vendor | medium, plus a dependency | parity with the alternative, for those who want it |

R§1 alone is worth shipping on its own — it is a day of work and it turns "an
MCP-only agent never sees the deliverable" into "the agent looks at every cut
before it reports done."

But if only one of the two ships, **ship R§2**. R§1 makes a shell agent faster;
R§2 makes both environments able to check the whole film instead of a sample of
it, and that is the difference the plan exists for.
