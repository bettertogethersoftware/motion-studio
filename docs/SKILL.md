---
name: motion-studio-video
description: Use this skill whenever the user wants to create, edit, or render a code-driven animated video, motion graphic, GIF, or transparent overlay using Motion Studio — a local renderer that exposes project/composition/asset/render tools over MCP. Trigger this any time the user mentions "Motion Studio," asks for an animated video, motion graphic, title sequence, lower third, explainer animation, animated GIF, alpha overlay, or programmatic/HTML-based video generation, even if they don't name the app directly, as long as Motion Studio's MCP tools (list_projects, create_project, write_composition_file, capture_preview_frame, render, etc.) are available in this session. Do not use this skill for editing existing video footage (trimming, cutting, color grading) — Motion Studio only authors animations from HTML/CSS/JS, it does not edit pre-recorded video.
---

# Motion Studio — authoring and rendering videos via MCP

Motion Studio renders videos (MP4/WebM/GIF/ProRes/PNG-sequence, including true alpha-channel overlays) from HTML/CSS/JS animations using a deterministic, frame-driven model (similar to Remotion). As an agent, you author the animation as code, then use the MCP tools to preview and render it — you do not need a human to drive the Studio UI.

## When this skill applies

Use it when the user asks for something like:
- "Make me a 10-second animated intro with our logo scaling in"
- "Create a title card animation that fades text in over a gradient"
- "Render a short explainer animation showing X"
- "Make a transparent lower-third / alpha overlay for my stream" (webm + transparent)
- "Turn this idea into a short looping GIF"
- Any request for a motion-graphics-style video built from scratch, where code-driven animation (not editing existing footage) is the right tool

Don't use it for: editing/trimming existing video files, live-action footage, or anything that isn't composed from HTML/CSS/JS elements.

## Before you start: check what's available

Confirm the Motion Studio MCP tools are present in your tool list before proceeding (they'll be named things like `list_projects`, `create_project`, `write_composition_file`, `capture_preview_frame`, `capture_preview_frames`, `render`, `get_render_status`). If they aren't available, tell the user Motion Studio doesn't appear to be connected in this session rather than trying to fake the workflow with generic file tools.

## The frame-driven authoring contract

Every composition you write must read animation state from an injected frame number, never from wall-clock time (`Date.now()`, `setInterval`, CSS `animation`/`transition` with real-time durations, etc.). This is what makes rendering deterministic and parallelizable — the render engine calls your composition's frame function once per frame, in any order, possibly across multiple worker processes.

**Read `references/frame-api.md` before writing your first composition** — the same document is also served as the MCP resource `motion-studio://reference/frame-api` if your client supports resources. It documents the primitives you'll use in every project. Do not guess at this API from general Remotion knowledge; Motion Studio's helper signatures differ. The essentials:

- Register your frame function with `MotionStudio.registerComposition(fn)` — the harness owns the `frameReady` handshake, including for `async` frame functions (make the function async and await image/font loading inside it). Do not hand-roll `window.setFrame`/`window.frameReady` unless you have a specific reason; the harness also converts thrown errors into structured `composition_error`s instead of frame timeouts.
- Animate values with `interpolate(frame, inputRange, outputRange, { easing, extrapolate })` — multi-segment ranges and named easings (`easeOutBack`, `easeOutElastic`, etc.) are supported.
- Time-offset sections with `Sequence(from, durationInFrames, fn)`; hide/reset elements at the top of every frame so each frame is fully self-determined.
- Never use `Math.random()` — use `MotionStudio.random(seed)` seeded from `frame` or a constant.
- For physical motion use `spring(frame, { fps, stiffness, damping })` (closed-form, 0→1 — no simulation state); for color blends `interpolateColors(frame, inputRange, colors)`; for repeating sub-animations `Loop(durationInFrames, fn)`. All are pure functions of frame — never accumulate per-frame physics state yourself.
- Every project scaffold already includes `frame-api.js` and loads it before `composition.js`; keep that ordering if you rewrite the HTML.

## Workflow

1. **Find or create the project.**
   Call `list_projects`. If the user is iterating on an existing project, use `get_project` to see its current config and files. Otherwise call `create_project` with sensible fps/dimensions/duration for the request (e.g. 30fps, 1920×1080, and a duration in frames matching the requested length in seconds × fps) — state the assumption to the user rather than asking, unless the request is genuinely ambiguous about length or aspect ratio. Dimensions must be even numbers for mp4/webm/prores.

   Pass whatever the video actually needs — an explicit argument always wins. Anything you leave out falls back to the user's global settings rather than a fixed 1920×1080/30fps, so **read `config` in the response instead of assuming what you got**: someone who works in 4K or 24fps has set that once and expects it to hold. Duration is the field to think hardest about, since it's the one a global default is least likely to be right about.

   **Pick the output format for the deliverable** via `update_project_config`: `mp4` (default) for general video, `webm` for smaller files, `gif` for short loops, `prores` for editorial hand-off, `png-sequence` for compositing. For a transparent overlay set `output: { format: "webm", transparent: true }` (or prores/png-sequence) and give the composition a transparent background — no `background` on `html`/`body`; everything unpainted becomes alpha 0. The output filename's extension follows the format automatically.

2. **Author the composition.**
   Use `write_composition_file` to write the HTML entry point and any JS/CSS it needs, built against the Frame API reference. The write result may include a **`warnings`** array flagging frame-driven contract violations (`Date.now`, `setInterval`, `Math.random`, `requestAnimationFrame`, `THREE.Clock`, real-time CSS transitions…). The file is written either way, but treat each warning as a real bug unless you are certain the code runs outside the frame function — these are exactly the mistakes that look fine in a single-frame capture and only break under parallel rendering. Keep the composition's visual logic as pure functions of `frame` — no external state, no randomness unseeded by frame number. To change fps, duration, dimensions, or audio/output settings, use `update_project_config` — raw writes to `project.json` are rejected by design so config invariants stay validated. If the user supplies a logo, music bed, or font, ingest it with `write_asset_file` (base64, lands under `assets/`, 25 MB cap) and reference it as `assets/<name>` from the composition. To see what a project already holds, `list_assets` returns every file under `assets/` with its `kind` and **`audioRefs`** — the number of `config.audio` tracks using it — which is how you tell a load-bearing file from an abandoned take. Clean up with `rename_asset` / `delete_asset`; both report `audioRefs`, and **pass `updateAudio: true` whenever it is non-zero** so the timeline is fixed in the same call. Deleting a referenced file without it does not fail — it leaves a dangling `src` that surfaces much later as an ffmpeg mux error on the next render, which is far harder to diagnose than it was to prevent.

3. **Check your work before rendering.**
   This is the step that matters most for an agent working without eyes on a live preview: call **`capture_preview_frames`** with a `count` (5 is a good default) or an explicit `frames` list covering the first frame, midpoints, the last frame, and any frame where a `Sequence` starts/ends — then look at the returned images. Use the plural tool whenever you want more than one frame: each single `capture_preview_frame` launches Chromium, loads the page, and re-runs the composition's one-time setup, so five separate captures pay that cost five times. Don't skip straight to a full render on a composition you haven't visually checked — a layout mistake found via a full render wastes far more time than one found via a capture. If something looks wrong, fix the composition file and re-capture before moving on.

4. **Render.**
   Call `render` with the project id; optionally pass `frameRange: [start, end]` for a partial pass and `workers` (2–4) to parallelize long renders. For a first pass on a longer composition, render a short `frameRange` first to confirm pacing before committing to the full length. If a job is already running your submission is **queued** (the response says `state: "queued"` with a `queuePosition`) and starts automatically — you don't need to poll-then-submit. Then **wait with `wait_for_render`** (pass every jobId you submitted; it blocks until all are `done`/`error`/`cancelled`, or returns current snapshots with `timedOut: true`) instead of a `get_render_status` polling loop — keep `get_render_status` for one-off progress checks (`framesDone`, `percent`, `renderFps`, `etaMs`) you can relay to the user mid-render. Don't assume completion; wait for the terminal state, and check each job's state in the result — one failed scene doesn't stop the others. For a poster frame or thumbnail, `render_still` writes a single frame as a PNG into `out/`. Transient Chromium crashes mid-capture self-heal (v0.14): the engine relaunches and retries the same frame, so a `browser_crashed` error means the machine kept crashing through the retry budget — worth telling the user, not blind-retrying forever (though one scene-level retry is reasonable).

   Renders of 30+ frames **pre-flight** first: a few evenly-spaced frames (both endpoints included) are probed before the render commits, so a composition that only throws at frame 90 fails in seconds rather than after 90 frames of work. A pre-flight failure is a normal `composition_error`/`frame_timeout` with `detail.phase: "preflight"` — fix the composition and re-render. It is on by default; pass `preflight: false` when you have *just* checked the composition with `capture_preview_frames` — the probe would re-verify what you looked at seconds ago, at one Chromium launch per queued scene.

5. **Handle errors explicitly.** Errors come back as structured JSON with a stable `code`:
   - `syntax_error` from `write_composition_file`: the write was rejected before touching disk (the previous file version is intact) — fix the JS and rewrite.
   - `queue_full`: ten jobs are already queued — wait for jobs to finish or `cancel_render` stale ones; don't keep submitting.
   - `asset_too_large` from `write_asset_file`: the decoded asset exceeds 25 MB — ask the user to place it in the project's `assets/` folder manually instead.
   - `prereqs_missing`: tell the user Node.js/FFmpeg aren't detected on their system rather than retrying — this isn't fixable from inside the MCP session.
   - `composition_error` / `frame_timeout` from a render or capture: your composition threw at a specific frame, or never signalled ready — for timeouts the near-universal cause is unawaited async work; use an async `registerComposition` function. `detail.phase: "preflight"` means it was caught by the pre-render probe; the named frame is where to look.
   - `path_outside_project`: you attempted a path outside the project folder; use project-relative paths only.
   - `render_already_in_progress`: a **different process** is already rendering that project (the pid is in `detail`). Two renders writing one project corrupt each other's frames, so this is a refusal, not a queue — wait for it, or cancel it. If you're certain that process is gone, the stale `.render.lock` in the project folder can be deleted.
   - `short_render`: the encoded file has fewer frames than were rendered, so the encode did not complete (`detail` has `expected`/`actual`). Re-render that project; do **not** assemble the file into a film.
   - `browser_crashed` (v0.14): Chromium crashed during capture *and* the engine's own relaunch-and-retry budget (3 relaunches, same-frame resume) was already spent before this surfaced. One scene-level re-render is a reasonable retry; if it recurs, the machine is genuinely unstable (memory, GPU/driver) — read `get_logs` and tell the user rather than looping.
   - `tts_unavailable` from `synthesize_speech`/`list_voices`: the selected speech vendor isn't configured on this machine — tell the user rather than retrying. Call `list_vendors` first: it names what is missing, and another vendor may already be usable (the Windows exe needs `MOTION_STUDIO_TTS_EXE`; Azure needs `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`). Never ask the user for the key itself — it goes in their environment, not into a tool call.
   - `music_unavailable` from `synthesize_music`: the selected music vendor isn't usable — the user sets it up, don't retry. Call `list_vendors`: the default `node` vendor only needs a SoundFont (`MOTION_STUDIO_SOUNDFONT`), while `fluidsynth` needs its two Windows executables, and the error names any vendor that *is* ready. `invalid_music_spec` means the note spec was empty/malformed — `detail.problems` lists every bad field; fix the spec.
   - `invalid_sfx_spec` from `synthesize_sfx`: the cue list is malformed — `detail.cue` gives the index. Common causes: setting both `atFrame` and `at` (or neither), passing a dB value to `gain` (it's an amplitude 0..1), setting both `pitch` and `hz`, or a cue placed past the end of the bed. There is no `sfx_unavailable` — this generator has no dependencies and always runs.
   - If `get_render_status` reports `error`, call `get_logs` for the job and read the actual output before guessing at a fix — Chromium launch failures and FFmpeg encoding errors look different and need different fixes.

6. **Report back concretely.**
   Tell the user the output file path (returned by `render` and confirmed in the `done` status) and roughly what the render contains, rather than just "done." If you rendered a short preview range first, say so and offer to render the full length.

   If the render carried audio, the `done` status includes `audio: { tracks, limiter, peakDb, meanDb, clipping }`. **Check it** — you cannot hear the output, and this is the only signal that the mix is distorted. `clipping: true` means peaks hit full scale: lower the offending track's `gainDb` (or re-enable `output.audioLimiter`) and re-render.

## Adding narration (text-to-speech)

If the video needs a spoken voiceover, synthesize it with `synthesize_speech` rather than asking the user for an audio file. Speech comes from a **vendor**: the Windows speech exe (`system`, offline) or Azure AI Speech (`azure`, cloud neural voices, any OS). If the active vendor isn't configured the tool returns `tts_unavailable` (the user configures it — don't retry blindly).

- Call `list_vendors` if you don't know what this machine has: it reports the active vendor, whether each is available, and what to fix. Omit `vendor` on the tools to use the configured default; pass it only when the user asks for a specific one.
- Call `list_voices` to see the voices, then pass one as `voice` (omit for the vendor default). For `azure`, filter with `locale` (e.g. `"en-US"`) — the catalogue is several hundred voices — and check a voice's `styles` before passing `style`. Azure voice names are ShortNames like `en-US-AvaNeural`.
- `synthesize_speech { projectId, text, voice }` writes a WAV into `assets/` and returns the clip length as both `durationSeconds` and `durationInFrames`. **Use `durationInFrames` to size the `Sequence()` the narration plays under — and often the project's own `durationInFrames` — so the on-screen animation lasts exactly as long as the voiceover.** Synthesizing before you finalize timing is the whole point: it's how you sync visuals to speech.
- `mode` (default `attach`) also appends the clip to the project's audio tracks, so the next `render` mixes it in automatically; pass `startInFrames` to offset it and `gainDb` to balance it against a music bed. Use `mode: "asset-only"` to inspect the duration first and wire the track yourself later via `update_project_config`.
- Audio is muxed at the final render only — `capture_preview_frame` is silent. mp4/webm/prores carry audio; gif and png-sequence do not.

## Adding a music bed (generated music)

If the video wants music, compose a short piece with `synthesize_music` instead of asking for an audio file — **you author the notes**. Like speech it has vendors: `node` (default, in-process, any OS, needs only a SoundFont) and `fluidsynth` (the Windows exe chain). An unusable vendor returns `music_unavailable` (the user sets it up — don't retry blindly); `list_vendors` says which is active and what to fix. The result reports the measured `peakDb` — check it against your narration level rather than assuming.

- Author a `spec`: `{ bpm, tracks: [ { program, notes: [ { pitch, start, duration, velocity? } ] } ] }`. `program` is a General MIDI instrument `0..127` (0 piano, 32 acoustic bass, 40 violin, 48 strings, 56 trumpet, 73 flute…); `drums:true` routes a track to percussion. `pitch` is a MIDI note (60 = middle C); `start`/`duration` are in **beats** (quarter notes). Keep it simple and diatonic — a melody track plus a bass/chord track reads as "music" far more than one dense track.
- `synthesize_music { projectId, spec, mode, gainDb }` writes a WAV into `assets/` and returns `durationInFrames` — but note it reflects the **rendered** length including a reverb tail, which is longer than the notes (`musicalDurationSeconds`). Loop or extend the spec to fill the video rather than expecting the bed to land on an exact beat.
- As a **background bed under narration**, attach it at a low `gainDb` (e.g. `-8` to `-14`) so speech stays intelligible, and use `startInFrames` to place it. `mode` works exactly as for speech (`attach` vs `asset-only`).
- **Track gains sum.** The mixer runs with `normalize=0`, so three tracks at `gainDb: 0` add up rather than averaging. `output.audioLimiter` (default on) brick-walls the result at −1 dBFS so it cannot distort, but a limiter working hard still sounds squashed — set deliberate levels (one foreground element, everything else below it) and confirm with the `audio.peakDb` reported when the render finishes.

## Adding sound effects

For the noises that are neither speech nor music — a whoosh on a cut, a chime between scenes, a thud on an impact, a shimmer under a reveal — use `synthesize_sfx`. Unlike speech and music it is **pure JS with nothing to install**, works on every OS, and has no "unavailable" error, so there is no reason to skip it or ask the user to configure anything.

- **One call makes the whole bed.** Pass a list of `cues` and you get a single audio track holding all of them at their absolute times — that's what you want for a film's master timeline, rather than one track per cue.
- **Time is in frames.** `atFrame` matches `startInFrames` and a scene's `filmOffset`, so "a chime on every scene cut" is a plain map over your scene offsets. (`at` in seconds is accepted instead — set exactly one.) `fps` and the default bed length come from the project.
- **`gain` is a peak amplitude 0..1, not dB.** Every cue is scaled so its peak equals its `gain`, so `0.4` means the same thing for a bell, a noise sweep, or a sub thud. Track-level dB still goes on `gainDb` when attaching.
- Types: `chime`, `whoosh`, `shimmer`, `thud`, `tone`. Pitched cues take `pitch` (MIDI, same as `synthesize_music`) **or** `hz`, never both. Keep chime pitches in the key of your music bed and the cues stop sounding bolted on.
- **Levels:** by default a quiet bed is *left quiet* — only a mix hotter than `ceilingDb` gets pulled down — so the returned `peakDb` is a real number you can balance against. Read `peakDb`/`appliedGainDb` and set `gainDb` from them; don't reuse a number from a previous video.
- A 10-minute 44.1 kHz bed is ~53 MB; pass `sampleRate: 22050` for long beds. Bad specs fail with `invalid_sfx_spec` naming the offending cue index. See [sfx-setup.md](sfx-setup.md).

## Long-form: multi-scene films

A composition is one `frame → state` function — right for a shot or a scene, not for minutes of video. To build anything longer than a single composition, author **each scene as its own project** and stitch the rendered scenes with `build_film`. Don't try to cram a whole film into one giant timeline.

- Give every scene project the **same** `width`, `height`, `fps`, and `output.format` (mp4/webm/prores) — `build_film` concatenates losslessly (`-c copy`) and rejects mismatches with `inconsistent_scenes`.
- **Render each scene first** (`render` → poll to `done`). `build_film` assembles only; an unrendered scene fails with `scene_not_rendered`.
- `build_film { scenes: [{projectId}, …] }` in play order → one continuous film. For a score/narration that spans the whole film, pass a master `audio: [{ src, startInFrames?, gainDb? }]` (in the output project's `assets/`); it replaces per-scene audio. Otherwise keep per-scene audio consistent (all scenes audio, or all silent).
- **Always give the film its own output project.** Before assembling, `create_project` a dedicated project (name it after the film, e.g. `"My Film — Master"`) and pass it as **`outputProjectId`**; put master-audio assets (`synthesize_music` / `synthesize_speech` with `mode: "asset-only"`, or `write_asset_file`) in *that* project's `assets/`. If you omit `outputProjectId`, the film and its audio land inside the **first scene's** folder, mixed in with that scene's own render — messy and confusing to iterate on. The output project is never rendered itself, so its scaffolded composition can be ignored.
- **Set the film's level by measurement, not by guessing.** With a master timeline, `build_film` returns `audio: { peakDb, meanDb, clipping, … }` for the assembled film — check it exactly as you check a render's. Better, pass **`audioTargetPeakDb: -2`**: it measures the mix, shifts every track by one offset (so your balance survives), re-muxes and re-measures. Never carry a master gain over from a previous film — different voices condition to very different peaks, and a gain that was right for one can push speech past full scale in the next, where the limiter quietly dulls every consonant.
- **Preview one frame per distinct scene *type* before rendering the film.** Scenes sharing a `composition.js` share its bugs, so a single bad drawing helper corrupts every scene that uses it. A 16-scene film is a ~30-minute render; a text label colliding with artwork is a few seconds to spot in `capture_preview_frames` and very expensive to discover afterwards.
- Quality: render scenes at low `output.crf` or as ProRes, assemble, then do one final encode — see [film-setup.md](film-setup.md). Because compositions are pure functions of frame, preview scenes at a low resolution and final-render at full res with no code change.
- **Don't hand-write a composition per scene.** Write **one** shared `composition.js` that reads a per-scene `window.SCENE` config (loaded from a small `scene.js`), so every scene project ships the same engine and a scene is just data. Then iterate one scene at a time: fix its config, re-render *only that project*, and call `build_film` again — the other scenes' outputs are reused and it re-stitches in seconds.
- **Fixing that shared engine: use `sync_shared_files`.** Every project holds its own *copy*, so editing the one you wrote first reaches nothing already created. `sync_shared_files { sourceProjectId, targetProjectIds, files: ["composition.js"] }` pushes it to all of them with the same syntax check and lint as a normal write. It deliberately does **not** touch `scene.js` (that's the per-scene data) and does **not** invalidate rendered output — re-render the affected scenes yourself.
- **Working with image assets (backgrounds/sprites):** put files under `assets/` and reference `assets/<name>`; **preload every image and only then call `registerComposition`** (so `setFrame` waits for them). **Never use an animated GIF live** — it advances on the wall clock and breaks determinism; convert it to a still (`ffmpeg -i x.gif -frames:v 1 x.png`) and animate from `frame`. For pixel art set `image-rendering: pixelated` + `ctx.imageSmoothingEnabled=false`; for a sprite on a solid colour, key it out with ffmpeg `colorkey=…,format=rgba` before use.

## Iterating on an existing project

If the user asks to change something about a video they already made ("make the title fade in slower"), use `get_project` and `read_composition_file` to see the current code before editing — don't rewrite from scratch and don't assume you remember the prior version's exact structure from earlier in the conversation. Note the human may have the same project open in the Studio web UI; your writes hot-reload their preview live. Re-check with `capture_preview_frame` after the edit, same as initial authoring.

## What not to do

- Don't use wall-clock time, `setTimeout`, `Math.random()`, or CSS real-time transitions anywhere in composition code — see the Frame API reference for why and what to use instead.
- Don't write composition files outside the project folder returned by `create_project`/`get_project` — the tool sandboxing will reject it anyway, but don't attempt path tricks to work around it.
- Don't write `project.json` directly — use `update_project_config`.
- Don't kick off a full render without a `capture_preview_frames` check first, except for trivial single-static-frame compositions.
- Don't call `capture_preview_frame` in a loop to inspect several frames — that pays a Chromium launch and a full page setup per frame. Use `capture_preview_frames` once.
- Don't ignore the `warnings` from `write_composition_file` or the `audio.clipping` flag on a finished render; both report problems that are invisible in a still frame.
- Don't fire renders in a loop without polling — one render runs at a time and further submissions queue (bounded at 10, then `queue_full`); check `list_render_jobs` if you lose track of a jobId.
- Don't request `transparent` output on `mp4` or `gif` — validation rejects it; use `webm`, `prores`, or `png-sequence`.
- Don't delete a project (`remove_project`, especially with `deleteFiles: true`) without explicit user confirmation — it's irreversible.
