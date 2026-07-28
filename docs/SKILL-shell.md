---
name: motion-studio-video-shell
description: Use this skill when the user wants a video built around footage or audio they supplied — a talk, an interview, a screen recording, a piece of camera footage — AND you have shell access to ffmpeg/ffprobe (whisper.cpp optional) alongside Motion Studio's MCP tools. This is the skill for combining real footage with code-driven motion graphics: reading what a recording says, cutting it, interleaving it with rendered scenes, and assembling the result losslessly. Trigger it for "make a video from this recording", "cut this talk down", "add graphics to my footage", "caption/subtitle this", "turn this interview into a short", or any request where the deliverable contains video the user recorded rather than only animation generated from scratch. If the request is pure motion graphics with no supplied footage — a title card, a logo animation, an alpha overlay, an explainer built from nothing — use the motion-studio-video skill instead. If you have no shell, you cannot follow this skill; use motion-studio-video.
---

# Motion Studio + shell — films built around real footage

You have two things this skill assumes: Motion Studio's MCP tools, and a shell
with `ffmpeg`/`ffprobe` (and ideally `whisper.cpp`). That combination can build
something neither half can alone — a film where the user's own recording carries
the argument and rendered graphics carry the structure.

**Finish the job yourself.** Guidance written for shell-less agents says "hand this
ffmpeg command to the human" — here that is wrong. You can read the file, cut it,
and assemble it, so do.

## The workflow inverts

This is the single most important difference from pure motion-graphics work, and
getting it backwards wastes everything downstream.

| | Pure motion graphics | **A film built on a recording** |
|---|---|---|
| Starts from | a brief | **the recording** |
| Length is set by | the brief, or synthesized narration | **what the speaker actually says** |
| Graphics are | the whole film | **structure around the spine** |
| First action | `create_film` | **read the footage** |

Do not create a film, choose a duration, or write a composition until you know
what the recording says and where. Every one of those decisions is downstream of
the transcript, and a scene authored at a guessed duration gets re-timed later at
full cost.

## The five checks nothing else will do for you

None of these raise an error. The commands succeed, the render reports `done`, the
file plays.

1. **Does the cut say what you think it says?** Re-transcribe the *finished* file
   and read it. A splice that joins two spans mid-clause is obvious in text and
   nearly invisible in a waveform.
2. **Is the picture the shot you meant?** Contact-sheet the assembly. A wrong
   in-point produces a technically perfect film of the speaker looking away.
3. **Do the frame counts add up exactly?** `-frames:v N`, then verify with
   `ffprobe -count_frames`. One frame of drift shifts every subsequent scene,
   caption and cue, and the render still succeeds.
4. **Will the segments stream-copy?** Mismatched encode parameters force a silent
   re-encode or a broken concat. Ask the engine what its signature is; do not
   infer it — `get_film` reports `plan.signature`, and its `ffmpegArgs` is the
   flag list to paste.
5. **Is the speaker still audible under everything you added?** Music you mixed
   by eye is music mixed wrong. Measure the gap.

## Workflow

### 1. Read the footage before planning anything

```bash
ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames -show_entries format=duration -of default=nw=1 "$SRC"
```

Then **look at it** — a contact sheet is the only way to know what a clip
contains:

```bash
for t in 5 20 40 60 80; do ffmpeg -y -v error -ss $t -i "$SRC" -frames:v 1 -vf scale=480:-1 "$SP/s$t.png"; done
ffmpeg -y -v error -i "$SP/s%d.png" -vf tile=3x2 "$SP/sheet.png"
```

Sample **by time with `-ss`**, one file per invocation. `select=eq(n\,N)` in a
single pass is unreliable for sparse frame picks and silently writes fewer files
than you asked for — check the file count if you use it.

### 2. Transcribe, and treat the timings as the product

**Try `transcribe_asset { path }` first.** It does everything below and hands back
what you would otherwise derive by hand: sentences re-segmented on real sentence
boundaries with `startInFrames`/`durationInFrames`, a `words[]` array with per-word
frames, `speechRanges` for where you can cut, and per-sentence `minTokenP`. It
takes video directly, caches its results so asking again is free, and runs as a
job that does not block a render. Having a shell is not a reason to re-derive
sentence boundaries from millisecond offsets once per session — that derivation is
where the mid-clause splice comes from.

Do it by hand only when the tool reports `transcription_unavailable` (whisper.cpp
is not configured for the engine). Then: whisper.cpp needs **16 kHz mono PCM** —
this is a requirement, not a preference:

```bash
ffmpeg -y -v error -i "$SRC" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$SP/16k.wav"
whisper-cli.exe -m models/ggml-small.en.bin -f "$SP/16k.wav" -l en -ojf -of "$SP/t" -t 8 -np
```

- **`-ojf`, not `-oj`.** Plain `-oj` omits the `tokens` array, and the tokens are
  where per-word timing lives. `small.en` runs ~6.5× realtime on 8 CPU threads.
- **`transcription[]` entries are decode windows, not sentences.** A single entry
  routinely starts mid-clause and crosses several sentence ends. **Never splice
  audio on a segment boundary** — re-segment on sentence-final punctuation using
  token `offsets` (integer **milliseconds**) first.
- **Token offsets → film frames is how graphics land on speech.**
  `frame = round(ms / 1000 * fps)`. This is what lets a label appear exactly as its
  word is spoken, which sentence-level timing cannot do when four names sit inside
  one sentence.
- Timing is reliable; **spelling is not.** Accented speech and proper nouns come
  back wrong often enough that anything quoted on screen needs your eyes on it.
  Per-token `p` is the confidence signal (there is no `no_speech_prob`).

### 3. Cut the argument, not the clip

Read the transcript and decide what the film *says*. This is editorial judgement
and the transcript does not make it for you — it only makes it possible.

Write the decision to a JSON cut list before touching a single file: source
in-points, frame counts, film offsets, and the word cues you will time graphics
to. Every later step reads from it, and it is what makes a re-cut cheap.

**Two rules that make a cut feel deliberate rather than assembled:**

- **Hide every audio splice under a graphics scene.** If the picture cuts to a
  title card at the same frame the audio joins two spans, the join is neither
  visible nor audible. This is ordinary editing practice and it is why the
  graphics exist where they do.
- **Derive picture and audio from the same source offsets.** Lip sync then holds
  *by construction* inside every footage segment, with nothing to verify.

### 4. Build the audio spine

Audio is one continuous track for the whole film; picture alternates over it.
**Total film length = total audio length.**

```bash
ffmpeg -y -v error \
 -ss 1.95 -t 11.36667 -i "$SRC"  -ss 14.91 -t 19.63333 -i "$SRC" \
 -filter_complex "\
   [0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];\
   [1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];\
   [a0][a1]acrossfade=d=0.012:c1=tri:c2=tri[j];\
   [j]volume=10dB,alimiter=limit=0.84:level=disabled,\
      apad,atrim=0:64.933333,aformat=sample_fmts=s16[out]" \
 -map "[out]" -c:a pcm_s16le "$SP/voice.wav"
```

- **Crossfade the joins (~12 ms, triangular).** A hard butt-join clicks.
- **`apad` + `atrim` to the exact film length.** Not approximately — the number of
  frames is a decision, and audio must match it.
- **Measure, do not guess.** `-af volumedetect` for mean/max, and per-second RMS to
  find dead spots the ear would catch and a waveform thumbnail would not:

```bash
ffmpeg -v error -i "$SP/mix.wav" -af "astats=metadata=1:reset=48000,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" -f null - 2>&1 | grep -o "RMS_level=[-0-9.]*"
```

- **A bed under speech needs a real gap** — aim for ~18–20 dB between the bed's
  mean and the voice's, and verify it rather than trusting a dB figure that worked
  on a different film. Voices condition to very different levels.
- For music, a **Node DSP script writing a WAV at full film length** beats a short
  loop tiled: no seams, and you can shape it to the film's arc. Keep it
  deliberately dull under speech — anything that draws attention is wrong.

### 5. Author the graphics in Motion Studio

Now, and only now, create the film and its scenes at the frame counts your cut
list specifies. This half is unchanged from ordinary Motion Studio work:

- **The frame-driven contract is identical.** Read `references/frame-api.md`
  (or `read_composition_file { scene, path: "frame-api.js" }`) and follow it
  exactly — no wall-clock time, no `Math.random()`, no CSS transitions,
  `MotionStudio.registerComposition`, `interpolate`, `Sequence`, `spring`.
- **The visibility rule still bites hardest.** Section containers hidden by
  default in CSS, exactly one `Sequence` owning each element, never
  `classList.add/remove` inside the frame function. If you cannot name the
  `Sequence` that owns an element, that element is a bug.
- **One shared `composition.js` reading a per-scene `window.SCENE`**, pushed with
  `sync_shared_files` — a scene becomes data, not code.
- **`capture_preview_frames` (plural) is your eyes.** Check the first frame of
  every scene: a wipe or reveal that starts off-screen leaves frame 0 blank, and
  a blank frame at every cut is invisible in any single capture.
- Treat `write_composition_file`'s `warnings` as real bugs, and an empty
  `warnings` array as no evidence of anything.

### 6. Cut picture, and match the film's signature

Footage segments must agree with Motion Studio's own output on the parameters a
stream copy cannot reconcile. **Ask, do not infer** — `get_film` reports
`plan.signature`, the film's encode contract, and `signature.ffmpegArgs` is the
exact flag list its own encoder uses:

```bash
# read it once, use it verbatim — do not retype the flags
SIG=$(…get_film…)                       # plan.signature
ARGS=$(jq -r '.ffmpegArgs | join(" ")' <<<"$SIG")   # e.g. -c:v libx264 -preset medium …

ffmpeg -y -v error -ss "$IN" -i "$SRC" -an -frames:v "$FRAMES" \
  -vf "fps=$(jq -r .fps <<<"$SIG"),vignette=angle=PI/6:mode=forward" \
  $ARGS "$SP/seg/f1.mp4"
```

- **`-frames:v N`, never `-t seconds`.** Only the frame count is exact, and the
  frame count is what your offsets depend on. Verify:
  `ffprobe -count_frames -show_entries stream=nb_read_frames`.
- **`signature.mustMatch` / `signature.neednotMatch` say which parameters are
  load-bearing** — read them from the block rather than from memory. The reason
  the second list exists: each segment is its own encode and therefore opens on a
  keyframe, which is all `concat -c copy` requires, so pinning `-x264-params
  keyint` or `-profile:v` is wasted effort. **Measured** — a segment encoded at a
  deliberately different profile and GOP concatenates and decodes back
  bit-identically.
- **`signature.matchForLooks` is the third list**: parameters that do not affect
  the join, but where the joined file keeps only segment 1's — `crf`/`preset` and
  the colour tags. Match them so your footage does not look different from the
  scenes beside it; nothing fails if you do not. **Do not try to pin colour with
  `-color_primaries`/`-color_trc`** — measured, they are silently ignored (the
  decoder's frame properties win), so the file you get back is not the file you
  think you made. Verify any colour claim by reading it back with
  `ffprobe -show_entries stream=color_primaries,color_transfer,color_space`.
- **`signature.video.codec` is the ffmpeg encoder id** (`libx264`), while
  `probe_asset`/`ffprobe` report the codec name (`h264`). Comparing the two
  directly is a guaranteed false mismatch.
- **Check `signature.copyConcat`** before planning a concat at all: a `gif` or
  `png-sequence` film cannot be stream-copied, so nothing can be joined to it.
- **A light `vignette` helps raw footage sit beside dark rendered graphics.**
  Grading is not this skill's job, but cutting untreated camera footage against
  designed scenes reads as two different films.
- **Strip audio from picture segments** (`-an`). All sound comes from the spine.

### 7. Assemble losslessly, then verify by reading it back

```bash
printf "file '%s'\n" "$SC/title/out/output.mp4" "$SP/seg/f1.mp4" … > "$SP/concat.txt"
ffmpeg -y -v error -f concat -safe 0 -i "$SP/concat.txt" -c copy "$SP/picture.mp4"
ffmpeg -y -v error -i "$SP/picture.mp4" -i "$SP/mix.wav" \
  -c:v copy -c:a aac -b:a 192k -ac 2 -ar 48000 -shortest -movflags +faststart "$OUT/film.mp4"
```

Then **prove it**, because nothing above would have told you if it were wrong:

- `ffprobe -count_frames` — does the total match your cut list exactly?
- A contact sheet, one frame per segment, in order — is every segment the shot you
  intended, in the right place?
- **Re-transcribe the finished film** and read it against your intent. This catches
  the class of error nothing else can: a spine that is technically clean and says
  the wrong thing.

Write the deliverable into the film's own `out/` so the workspace holds it.

## What only Motion Studio can do — do not reach for ffmpeg

Having a shell makes it tempting to do everything in it. These are strictly worse
in ffmpeg, and reaching for `drawtext` or `overlay` for them is a mistake:

- **Designed, deterministic motion.** Typography, easing, staged reveals, SVG path
  drawing, canvas/WebGL, 3D. A frame-driven composition is repeatable and
  reviewable one frame at a time; a filter chain is neither.
- **True alpha overlays**, and compositing that needs layout.
- **Audio measurement with intent** — `preview_audio` reports `balanceWarnings`,
  `clipMeanDb`, `mix.envelopeDb` and `mix.silentTailSeconds` against the actual
  render graph. Use it when the audio is on a film's timeline.
- **Sentence-accurate transcription** — `transcribe_asset` runs the same
  whisper.cpp you would, and then does the derivation that actually bites:
  re-segmenting decode windows into sentences, merging sub-word tokens into words,
  converting milliseconds to frames, and collapsing it all into cuttable ranges.
  Running `whisper-cli` yourself gets you the same 40 KB of JSON and none of that.
- **A persistent, editable film document** the user can open in the Studio.

Conversely, do not ask the user to run ffmpeg for you, and do not tell them a
codec problem is unfixable. You have the shell; use it.

## Failure modes specific to driving this from a shell

- **Heredocs and backslashes.** `node -e '…split("\\")…'` inside a shell heredoc
  loses a backslash and fails as a `SyntaxError`. Write a real `.mjs`/`.py` file
  and run it.
- **Long renders die intermittently** with Chromium "Target closed", regardless of
  worker count. Retry per scene and validate by frame count, not by exit status.
- **Background renders need the harness's background mechanism**, not a shell `&`
  — a backgrounded shell orphans the render and silently races the next one.
- **A `<video>` in a composition that fails to load never fires `seeked`**, so the
  frame hangs until timeout rather than erroring. Guard on
  `duration > 0 && readyState >= 1`, and note the render browser **cannot decode
  H.264** — in-composition video must be VP8/VP9/AV1 in `.webm`. This is the
  opposite requirement from timeline footage, which must be H.264/mp4.
- **`build_film` cannot express footage interleaved with scenes.** `film.scenes[]`
  holds only rendered scenes, so the assembly in step 7 is an ffmpeg concat, and
  the film document will describe only the graphics scenes — not the actual cut.
  **Say so when you report**, so the user knows the workspace is not a complete
  record of the deliverable.

## What not to do

- Don't choose a duration, create a film, or author a composition before you have
  read the transcript — everything downstream depends on it.
- Don't splice audio on a whisper segment boundary; re-segment on sentence
  punctuation using token offsets first.
- Don't use `-t seconds` where a frame count matters, and don't skip the
  `-count_frames` verification.
- Don't pin encoder parameters that need not match; don't guess the ones that do.
- Don't re-encode picture at assembly time — if a segment will not stream-copy,
  fix the segment.
- Don't put the user's recorded audio under music you mixed by eye. Measure the
  gap.
- Don't quote a machine transcript verbatim on screen without reading it. Timing is
  reliable; spelling is not.
- Don't claim the film is verified until you have re-read its audio and looked at
  its picture. "The render said done" is not verification.
- Don't do designed motion in ffmpeg filters.
- Don't invent statistics, ratings or certifications for a promotional video — take
  claims from the user's own material or make none.
- Don't edit a person's recorded words into a claim they did not make. Cutting for
  length is normal; reordering clauses to change the meaning is not, and if you
  complete a truncated sentence on screen, use their own words from elsewhere in
  the recording and say that you did.
- Don't delete a film or scene (`remove_film`/`remove_scene` with
  `deleteFiles: true`) without explicit confirmation.
