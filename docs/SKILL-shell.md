---
name: motion-studio-video-shell
description: Use this skill when the user wants a video built around footage or audio they supplied — a talk, an interview, a screen recording, a piece of camera footage — AND you have shell access to ffmpeg/ffprobe (whisper.cpp optional) alongside Motion Studio's MCP tools. This is the skill for combining real footage with code-driven motion graphics: reading what a recording says, cutting it, interleaving it with rendered scenes, and assembling the result losslessly. Trigger it for "make a video from this recording", "cut this talk down", "add graphics to my footage", "caption/subtitle this", "turn this interview into a short", or any request where the deliverable contains video the user recorded rather than only animation generated from scratch. If the request is pure motion graphics with no supplied footage — a title card, a logo animation, an alpha overlay, an explainer built from nothing — use the motion-studio-video skill instead. If you have no shell, you cannot follow this skill; use motion-studio-video.
---

# Motion Studio + shell — films built around real footage

You have two things this skill assumes: Motion Studio's MCP tools, and a shell
with `ffmpeg`/`ffprobe` (and ideally `whisper.cpp`). That combination can build
something neither half can alone — a film where the user's own recording carries
the argument and rendered graphics carry the structure.

**Do a one-time preflight before the first film.** From the engine folder, run
`npm run doctor`. If the MCP server launches with a narrow `PATH`, set
`MOTION_STUDIO_FFMPEG` to the full `ffmpeg` executable path. For transcription,
set `MOTION_STUDIO_WHISPER_BIN` to `whisper-cli` and
`MOTION_STUDIO_WHISPER_MODEL` to an installed `ggml-*.bin` model; then confirm
the choice with `list_vendors { capability: "transcription" }`. Do not discover
that a binary is missing after you have designed a cut around it. For generated
music, check `list_vendors { capability: "music" }` too; the Node music vendor
needs a SoundFont, configured with `MOTION_STUDIO_SOUNDFONT` when no project
default exists.

### Shell dialect

The command blocks below use **POSIX shell syntax** (`$VAR`, `for`, `printf`,
`jq`, `grep`, line-continuation backslashes). On Windows, run them in Git Bash
or WSL; do not paste them unchanged into PowerShell. If the available shell is
PowerShell, translate the commands first and invoke the bundled executables by
their full paths. The media decisions and verification steps are the contract,
not one shell's spelling.

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
- **Call `list_vendors` before making music.** A user's starred instruments in
  `favoritePrograms` are the default choice unless the brief names a sound.
  Normally use `synthesize_music` on the film's master timeline, then
  `preview_audio`, so the score is measured and mixed through the same graph as
  the final build. A custom Node DSP script writing a full-length WAV is an
  advanced alternative when the brief needs a sound the music vendor cannot
  produce; it avoids loop seams, but it still needs the same mix measurement.
  Keep music deliberately dull under speech — anything that draws attention is
  wrong.

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

### 6. Put conformed footage on the film timeline

Footage can now sit directly beside rendered scenes in a film. Do not hand-build
a concat as the normal workflow. Ask `get_film` for `plan.signature`, then let
`transcode_asset { matchFilm: "<film>" }` create a matching, silent timeline
asset — it applies the film's actual encoder arguments and colour profile instead
of asking the agent to retype either.

1. Pull a supplied clip from the workspace library into the **film** or transcode
   it directly into `assets/clip.mp4`. Use `audio: false`; the continuous audio
   spine stays on the master timeline.
2. Use `transcode_asset` with `target: "<film>"`, `to: "assets/clip.mp4"`,
   `matchFilm: "<film>"`, and a frame-based trim (`durationInFrames`). It reports
   the measured output and any colour assumptions.
3. Set the complete play order with `update_film { scenes: [...] }`, mixing
   rendered entries (`{ slug: "title" }`) and footage entries
   (`{ footage: "assets/clip.mp4", durationInFrames: N }`). The engine verifies
   the frame count and signature before it builds.
4. Put the continuous voice/music mix on the film's master `audio` timeline.
   Use `get_film` or `build_film { plan: true }` for the resolved offsets; do not
   accumulate scene durations by hand.

**`-frames:v N`, never `-t seconds`,** when preparing a manually cut source:
only the frame count is exact. Use `ffprobe -count_frames` as an independent
check. A light vignette may help raw footage sit beside dark rendered graphics,
but designed animation and text belong in a Motion Studio composition.

### 7. Build and verify the film

Render each graphics scene, run `preview_audio { target: "<film>" }`, then call
`build_film`. It losslessly stream-copies compatible scene and footage segments,
muxes the master audio, and writes the deliverable into the film's own `out/`.

Then **prove it**, because a successful build alone does not establish editorial
correctness:

- `inspect_render { target: "<film>", around: "cuts" }` and a contact sheet —
  is every segment the intended shot in the intended place?
- `measure_render { target: "<film>" }` and `ffprobe -count_frames` — does the
  finished picture have the expected motion and exact frame count?
- **Re-transcribe the finished film** and read it against the intended cut. This
  catches the class of error nothing else can: a technically clean spine that says
  the wrong thing.

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
- **Delivered-picture review** — `inspect_render` returns frames from the encoded
  file at known cuts or holds; `measure_render` scans its motion, static/black
  runs and expected cuts. Use these after a render/build, not as a substitute for
  composition previews before it.
- **Sentence-accurate transcription** — `transcribe_asset` runs the same
  whisper.cpp you would, and then does the derivation that actually bites:
  re-segmenting decode windows into sentences, merging sub-word tokens into words,
  converting milliseconds to frames, and collapsing it all into cuttable ranges.
  Running `whisper-cli` yourself gets you the same 40 KB of JSON and none of that.
- **A persistent, editable film document** the user can open in the Studio.

The bundled Windows FFmpeg build has no fontconfig support and can crash on the
`drawtext` filter. Render text with HTML/CSS/canvas inside Motion Studio instead.

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
- **Timeline footage must be silent and signature-compatible.** Put its sound on
  the master audio timeline, and use `transcode_asset { matchFilm }` instead of
  guessing codecs, frame rate, or colour tags.

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
