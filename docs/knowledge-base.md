# Motion Studio — Knowledge Base

Problems actually hit while making things with this engine, and what fixed them.
Written after a run that produced four videos (a 10-minute Opus 5 tutorial, a
10-minute children's Bible film, a 30-second news bulletin, a 15-second 3D space
jump) and the v0.11 / v0.12 engine work those films provoked.

Every entry is **symptom → root cause → fix → lesson**, because the symptom is
what you will recognise next time and the lesson is the only part that transfers.
Entries marked **FIXED IN ENGINE** became code; the rest are authoring traps.

Related: [architecture.md](architecture.md) for how the pieces fit,
[film-setup.md](film-setup.md) for long-form, [3d-libraries.md](3d-libraries.md)
for models, [sfx-setup.md](sfx-setup.md) for generated audio.

---

## 1. Silent failures — the expensive category

These share a shape: the pipeline reported success and the defect was invisible
until someone watched or listened to the result. They are why v0.11 exists.

### 1.1 Two renders quietly corrupting one project · **FIXED IN ENGINE**

**Symptom.** Nothing. No error, no warning. The only tell was an unexpected
number of `node.exe` / `chrome.exe` processes.

**Root cause.** A render was backgrounded with a shell `&`, which orphaned it
from the tool's lifecycle — no completion notification, output going to
`/dev/null`. Unable to tell whether it was alive, a second render was started.
Both then wrote the same project's frame files and both ran ffmpeg on the same
output path. The survivor is whichever finished last; any torn frame in between
is undetectable.

**Fix.** `core/lock.js`: a `.render.lock` dotfile holding the owning pid.
**Liveness, not age, decides staleness** — a render may legitimately run for
hours, so a timeout would eventually evict a healthy job, whereas a crashed
owner's pid stops existing at once. Creation is an atomic `open(…,'wx')` so two
racers cannot both think they won; same-pid acquisition is re-entrant; release
only fires if we still own the file. This finally *raises*
`RENDER_ALREADY_IN_PROGRESS`, a code that had sat reserved and unused since v0.5.

**Lesson.** Start long jobs with the tool's own background mechanism, never a
shell `&`. And when a resource can be written by two processes, the absence of an
error is not evidence of correctness — go look at the process table.

**Subtlety worth keeping:** parallel *workers* must **not** take the lock
(`lock: false`, set from the CLI's `--segment`). They target the same project by
design and the parent's lock covers them; a worker taking its own would deadlock
the fan-out against itself. `renderParallel` also delegates to
`renderComposition` for a single worker and lets the *delegate* lock, for the
same reason.

### 1.2 A truncated video that everything downstream accepted · **FIXED IN ENGINE**

**Symptom.** A finished film with a scene that just stops early.

**Root cause.** Nothing verified that the encoded file contained the frames that
were rendered. A worker killed mid-encode leaves a perfectly valid — just short —
video, `render` reported success, and `build_film` concatenated it happily.

**Fix.** Both render paths now probe the real frame count and fail with
`short_render` (`detail.expected` / `detail.actual`). `probeFrameCount` reads the
container's `nb_frames` first — muxers write it from frames actually written, so
truncation shows up for the cost of one metadata read — falling back to a full
`-count_frames` decode only when it is missing. ffprobe is not a declared
prerequisite, so an unmeasurable file reports `framesVerified: false` rather than
failing a good render.

**Lesson.** "The process exited 0" and "the artifact is complete" are different
claims. This one also unlocked something: *because* the count is now trustworthy,
"output exists and has the right length" became a valid resume condition for a
long batch.

### 1.3 The film's audio was the one thing nobody measured · **FIXED IN ENGINE**

**Symptom.** No symptom available — you cannot hear a render.

**Root cause.** An asymmetry introduced by v0.10 and missed: `render` measured
and reported the mixed level, but `assembleFilm` muxed the master timeline and
returned without ever looking at it. The artifact that actually ships was the one
with no measurement.

**Fix.** `build_film` returns `audio: { tracks, limiter, peakDb, meanDb,
clipping }` whenever a master timeline is present, plus `audioTargetPeakDb` which
measures, applies **one offset to every track** (preserving the caller's balance),
re-muxes, and *re-measures* rather than assuming the shift landed.

**Lesson.** When you add a check, enumerate every path that produces the same
class of artifact. A check on the intermediate and not the deliverable is worse
than none, because it reads as coverage.

### 1.4 `npm test` reporting success having run zero tests

**Symptom.** `npm test` → `# tests 0 # pass 0 # fail 0`, exit 0.

**Root cause.** The script is `node --test 'test/**/*.test.js'`. The quoted glob
is never expanded by this shell and Node does not expand it either, so the
pattern matches nothing — and a run with no tests is not a failure.

**Fix (workaround).** Invoke as `node --test test/*.test.js`.

**Lesson.** A green suite with a suspiciously round number is a red flag. Read
the test count, not just the exit code.

---

## 2. Audio levels — measure, never inherit

### 2.1 A master gain carried over from the previous film

**Symptom.** Would have been "the narration sounds slightly muddy" — never a
clip, never an error.

**Root cause.** The `speechnorm=e=9:r=0.0004:l=1,volume=-3dB` conditioning chain
lands different voices at very different peaks. The en-US tutorial film mixed
correctly at `MASTER_GAIN = 4`. The zh-TW OneCore voices (Yating / Zhiwei)
condition roughly **5 dB hotter** through the identical chain, so reusing 4 would
have put speech at **+1.4 dBFS**, forcing the limiter to act on every consonant.

**Fix.** Measure the *conditioned* narration, take the loudest clip, and solve
for a master peak near −2 dBFS. The correct value there was 2.5 (measured
−2.6 dBFS, limiter idle). Better still, let `build_film` do it:
`audioTargetPeakDb: -2`.

**Lesson.** Clipping is loud and gets caught. **A limiter quietly working on
speech transients is not** — it just sounds slightly dull, and nothing in the
pipeline reports it. Re-assembly costs ~7 s because the concat is a stream copy,
so measure-then-fix is always cheaper than guessing.

### 2.2 The right *relative* balance is not the right *absolute* level

**Symptom.** First Bible-film assembly: peak −4.5 dBFS. Safe, but ~2.5 dB
quieter than normal delivery.

**Fix.** Kept the balance, raised the master to land at −2.6 dBFS.

**Lesson.** Separate the two decisions. Set balance from measurement of the
parts; set absolute level once, at the end, from measurement of the whole. That
is exactly what `audioTargetPeakDb` encodes.

### 2.3 Normalizing a cue bed destroys the information you need

**Symptom.** Both hand-rolled SFX beds ended up attached at roughly
`gainDb: -20`, a number with no meaning.

**Root cause.** The beds normalized themselves to −1 dBFS peak, so the mix gain
existed only to undo that. The original `sfx-plan.md` design specified exactly
this behaviour.

**Fix.** `synthesize_sfx` defaults to `normalize: 'ceiling'` — attenuate **only
if** the mix exceeds the ceiling — and reports `rawPeakDb`, `peakDb`,
`appliedGainDb`. A quiet bed stays quiet, so its reported peak is real.
Vindicated immediately: regenerating the Bible bed reported `peakDb -3.56,
appliedGainDb 0` (left alone), while the Space Jump bed came back at
**+2.71 dBFS** — genuinely over full scale — and was pulled to −1 *and said so*.

**Lesson.** A reported number should be measured truth, not an artifact of an
automatic correction. Same principle as §1.2 and §1.3.

---

## 3. Narration-first timing

### 3.1 The 30-second video that was 34 seconds

**Symptom.** Four lines of copy plus lead/gap/tail summed to 1027 frames
(34.2 s) against a 30-second brief.

**Fix.** Tightened the copy and nudged the rate from 0 to +1 → 895 frames
(29.83 s). Two iterations, no re-render, because *nothing had been rendered yet*.

**Lesson.** Synthesize the voice **first** and let its measured length set
`durationInFrames`. Then picture is cut to voice rather than hoping voice fits
picture, and a timing problem costs a TTS call instead of a render. Both
ten-minute films landed every scene with exactly the intended tail frames and
zero overruns this way.

### 3.2 Assert the timing rather than eyeballing it

Before rendering the Bible film, a scripted check confirmed
`narrationStart + narrationFrames ≤ sceneStart + durationInFrames` for all 16
scenes — all showing exactly the 38-frame `TAIL`, zero overruns. Thirty seconds
of scripting against a 32-minute render.

---

## 4. Multi-scene films

### 4.1 A shared `composition.js` that isn't actually shared · **FIXED IN ENGINE**

**Symptom.** Fixed a drawing bug, re-previewed, and the bug was still there.

**Root cause.** `film-setup.md` recommends every scene project ship the *same*
`composition.js` and differ only in a small `scene.js` — but each project holds
its own **copy**, made at scaffold time. Editing the original reaches nothing.
On 16 scenes a one-line art fix is a sixteen-project chore.

**Fix.** `sync_shared_files` / `ProjectStore.syncSharedFiles`. All source files
are read before anything is written, so a bad path fails before it half-updates a
film. Measured: 15 projects, 2 files, **71 ms**.

**Two things it deliberately does not do:** touch `scene.js` unless you list it
(that is the per-scene data — syncing it would overwrite every scene with scene
1's), and invalidate rendered output. Re-render the affected scenes yourself.

**Lesson.** When a doc recommends a pattern, check the pattern has a maintenance
story, not just a creation story.

### 4.2 Editing shared files mid-render

Pushing a fixed `composition.js` while a render was in flight left one scene a
possible mix of old and new code — the workers reload the page per chunk. That
scene was re-rendered on suspicion.

**Lesson.** Propagate shared-file fixes **between** renders, then force a
re-render of everything affected by deleting its output.

### 4.3 Long renders die on their own · Chromium flakiness

**Symptom.** `Protocol error (Page.captureScreenshot): Target closed`, mid-render.

**Diagnosis that was wrong first.** Initially blamed memory pressure from raising
workers to 6. It then failed again at **4 workers with ~17.6 GB free**, on a
different scene. It is flaky, not exhaustion and not a bad scene.

**Fix.** Per-scene retry (4 attempts, backoff) with a frame-count check *inside*
the loop, and resume-by-frame-count so a restart skips completed scenes. Lowering
the fan-out only changes the odds; retrying is what recovers.

**Lesson.** A plausible cause that fits the first data point is not a diagnosis.
The second occurrence is what tells you whether you were right — and here it said
"no".

---

## 5. Things that are invisible in a still frame

### 5.1 Text struck through by artwork

Two scenes had dimension labels (`五百肘`, `40肘`, `20肘`) crossed out by the
diagram's own wall line. Cause: the `dim()` helper places its label 12 px above
the bar, and the bar sat only ~30 px below the wall, so the glyph tops landed on
the line.

**Lesson.** A layout helper's *anchor* is not its *extent*. When a helper draws
text at an offset, the collision budget is offset **plus** the font's ascent.

### 5.2 A "correct" scene that is dramatically dead

`ez-05-holyplace` rendered exactly as coded — and was an unlit black hole held
for 28 seconds, the opposite of what the scene was about. The scene passed
`intensity: 0.5`, halving an already-subtle gradient.

**Lesson.** "Renders without error" and "does its job" are different tests. For a
long hold, ask what the audience is looking at for the whole duration.

### 5.3 Verify before you "fix" — the false alarm

A rotated `20肘` label looked like colliding glyphs. Before changing anything, the
crop was rotated upright with `ffmpeg transpose=1`: it renders **perfectly**.
Rotated CJK simply reads oddly at a glance.

**Lesson.** Confirm a bug exists before fixing it. Earlier in this same run, a
`list_voices` "bug" was reported to the user and turned out to be unreproducible —
after the contradicting evidence had already been noticed and reported anyway.
Cheapest possible check: magnify the pixels.

### 5.4 Byte size is not a picture

An ~8 KB PNG is equally consistent with a blank frame and a flat-colour frame.
Always look at pixels; `signalstats` `YAVG` is a good numeric proxy (Y=16 is true
black in limited-range YUV, which is how the fade-to-black was verified).

### 5.5 Preview one frame per distinct scene *type*

Scenes sharing a `composition.js` share its bugs. Previewing one frame per
distinct scene type caught all three Bible-film art bugs in seconds, against a
32-minute render.

---

## 6. 3D models

Full detail in [3d-libraries.md](3d-libraries.md) §3. The two entries earned in
this round:

### 6.1 Normalization scale wiped by the frame function

**Symptom.** The model rendered *correctly* — correct materials, correct
lighting — but wildly too large and half out of frame.

**Root cause.** The load step normalized the model with
`root.scaling = s`, and the frame function then set `ship.scaling` for the jump
stretch — on the same node. Frame 0 wiped the normalization and the centimetre-scale
Sketchfab export filled the frame.

**Fix.** Three nested nodes: outer animated freely, middle holding the fixed
normalization scale, inner holding the centring offset. Plus
`getHierarchyBoundingVectors(true)` instead of a hand-rolled AABB loop.

**Lesson.** Never animate the node that carries a fixed transform. The symptom is
distinctive — a *good-looking* model at the wrong size, not a missing one.

### 6.2 "PBR is black without IBL" is overstated

The prior note said glTF metallic-roughness renders near-black without an
`environmentTexture`. The Space Jump render disproves it: the same
`super_starfury.glb` (11 PBR materials, metallic ≈0.68) rendered a clean lit grey
with **no IBL at all** — hemispheric 0.45 plus two directional lights (2.6 / 1.3).

**Lesson.** IBL buys reflections, not visibility. If metal looks black, raise a
directional light before building a procedural equirect. And when a doc states a
hard limit, an actual render is allowed to overrule it.

---

## 7. Signal-processing traps

### 7.1 A frequency sweep that sweeps twice as fast as it should

**Symptom.** Descending "thud" and whoosh-body cues sounded faster and more
clipped than the frequency curve implied.

**Root cause.** `sin(2π · f(t) · t)` is **not** a sweep from `f(0)` to `f(t)` —
the product means instantaneous frequency is `f(t) + t·f'(t)`, so for a decaying
`f` it overshoots badly. It was shipped by hand in two films before being noticed.

**Fix.** Accumulate phase: `phase += 2π·f/sr` each sample, then `sin(phase)`.

**Lesson.** Any time frequency varies with time, integrate phase. `sin(2π f t)`
is only correct for constant `f`.

### 7.2 An incomplete validator is worse than none · **FIXED IN ENGINE**

**Symptom.** `validateSfxSpec` returned happily on a spec that `renderCues` then
threw on.

**Root cause.** Per-type parameter checks (pitch/hz exclusivity, `wave`, shimmer
`pitches`) lived inside the generators' `render` functions. Anyone validating up
front — the entire point of exporting the validator — got the error at the worst
possible moment.

**Fix.** Split each generator into `resolve(cue,i) → params` (validates, applies
defaults, reports `lengthSeconds`) and `render(out,n,params,…)` which trusts them.
Validation now happens before a single sample is allocated, and a test asserts
that **every** spec `renderCues` rejects, `validateSfxSpec` rejects too.

**Lesson.** If you export a validator, its contract is "everything downstream
will accept this". Test that property directly rather than testing cases.

### 7.3 Determinism in JS has a ceiling — say so

Seeded PRNGs make noise reproducible, but ECMAScript does **not** pin
`Math.sin`/`Math.exp`, so byte-identical output is only guaranteed for a given
Node build. The plan had promised more than the language can give. Fixed-point
transcendental tables would close it and are not worth it for a sound bed.

**Lesson.** State the limit explicitly. An undocumented boundary reads as a bug
later; a documented one reads as a decision. (Frame-render determinism is
unaffected — that is a property of the composition, and audio is generated once
then read as a file.)

---

## 8. Environment and tooling

### 8.1 A wrong-path check that gave a plausible answer

`ls vendor/babylon/` printed "(babylon not vendored)". The real path is
`vendor/libs/babylon/`. The conclusion happened to be *correct* — Babylon really
wasn't vendored — which is what makes it dangerous: a broken check that agrees
with reality teaches you to trust it.

**Lesson.** When a check returns the answer you expected, it has told you
nothing. Prefer a check that would look *different* if the premise were wrong —
e.g. `find vendor -type f`, which would have shown `three.min.js` sitting under
`vendor/libs/` and revealed the path immediately.

### 8.2 glTF loading needs an opt-in flag

`MOTION_STUDIO_ALLOW_LOCAL_FETCH=1` adds Chromium's
`--allow-file-access-from-files`; without it a glTF/GLB loader's `file://` fetch
is CORS-blocked. `<img>`/`<audio>`/CSS assets never need it.

**FIXED IN ENGINE (partially):** the registry always carried this note on the
`loaders` addon, and `add_library`'s MCP description states it — but
`addLibrary`'s *return value* dropped addon notes entirely, so a core-level caller
never saw it. Addon notes are now appended to `notes`, attributed as
`[loaders] …`, with a test asserting the string survives.

### 8.3 A library pinned to "stable" is not pinned · **FIXED IN ENGINE**

**Symptom.** None available — a render simply could not be traced to the code
that produced it.

**Root cause.** `libraries.js` declared Babylon as `version: 'stable'` fetching
`https://cdn.babylonjs.com/babylon.js`, and all of `engine/vendor/` was
git-ignored. Two independent failures hid in that: **acquisition** (two machines
fetching at different times get different builds) and **provenance** (a project
cannot say what it rendered against, even on one machine).

**The measurement that settled the design.** A version pin fixes only the first —
and here, not even that. `/babylon.js` and `/v9.18.0/babylon.js` both self-report
`Version="9.18.0"` and are different code: 8,180,880 vs 8,180,848 bytes, diverging
at byte 2,317,477 where the floating build carries an extra `var t;`. So pinning
the version would have reported "9.18.0" and still handed over a different
artifact than the one that rendered the space-jump video.

**Fix.** Content addressing, in `core/vendor-lock.js` + a committed
`engine/vendor.lock.json` — the npm/cargo split of ignored artifacts and a tracked
lock. `fetch-libs.mjs` hashes every download, **refuses to overwrite on mismatch**
(so a failed run cannot half-upgrade the vendor dir), and `--update` is the only
way to change the lock. `--verify` checks disk against the lock and exits 1 on
drift. Both libraries are now pinned to versioned URLs, and `add_library` stamps
`config.libraryBuilds` (`{version, sha256, bytes}` per file) so the *project*
records its own build.

Because the pinned build is not the one that made the video, the swap was
confirmed by re-rendering a frame of the ship — identical. **Verify the
substitution, don't assume a same-version build is the same build.**

**Then the cheaper fix, chosen afterwards: commit the libraries.** Of the 215 MB
in `engine/vendor/`, only `libs/` was a sane candidate — ~9 MB of immutable
third-party JS (three.js MIT, Babylon Apache-2.0) with no build step. The rest
stays out: the two 94 MB / 65 MB exes are build artifacts of tracked C# source,
git keeps every version of a binary forever, and there is no LFS configured. With
`libs/` committed, **git became the integrity mechanism** and the lock kept only
the jobs git cannot do: recording *where* the bytes came from, and refusing to let
a `fetch-libs` run silently rewrite committed files.

A `.gitignore` trap worth knowing, verified in a scratch repo: `engine/vendor/`
(trailing slash) excludes the directory so git never descends into it, and a
following `!engine/vendor/libs/` does **nothing**. You must ignore the *contents* —
`engine/vendor/*` — for the negation to bite.

**Lesson.** *A version string is a claim; a hash is a fact.* For anything
git-ignored, record the checkable one — and reconsider whether it needs to be
git-ignored at all, since committing 9 MB removed a whole class of problem that no
amount of tooling would have. When a fix has two halves, name them separately:
pinning the URL and recording the hash solve different problems, and only one of
them makes a finished artifact traceable. Also worth saying plainly — the later,
simpler decision made part of my own earlier work redundant, and that is the right
outcome to report rather than defend.

Corollary found along the way: `detectVersion` returns **null** for three
(`REVISION` minifies to `const e="134"`, and `134` also appears in colour
constants) and for the Babylon loaders bundle (no banner). Refusing to guess is
correct — a wrong version is worse than no version.

---

## 9. The recurring lesson

Nearly every entry above is the same shape in different clothes: **the pipeline
said yes, and the artifact was wrong.** Silent frame corruption, a short video, an
unmeasured mix, a limiter dulling consonants, a struck-through label, a black hole
of a scene, a validator that passed a bad spec, a check that agreed with a wrong
premise, a test run of zero tests.

What reliably worked:

1. **Measure the artifact, not the intent.** `volumedetect` on the finished file,
   `signalstats` on the finished frame, `ffprobe -count_frames` on the finished
   video.
2. **Look at pixels.** Previews are cheap; renders are not.
3. **Verify before fixing** — and be willing to overturn your own earlier
   conclusion, whether it is a crash diagnosis, a reported bug, or a doc.
4. **Make the check fail differently from the way it passes**, or it isn't a check.
