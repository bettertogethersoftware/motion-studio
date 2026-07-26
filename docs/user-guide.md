# Motion Studio — User Guide (v0.18)

## Installation and first run

Motion Studio needs two things installed and on PATH: **Node.js 18 or
newer** and **FFmpeg 5 or newer**. Neither is bundled. Then, from the
repository root:

```bash
cd engine
npm install          # downloads Puppeteer's Chromium build (~150–300 MB, once)
npm run doctor       # prints the prerequisite check as JSON (exit 0 = ready)
npm run studio       # → http://127.0.0.1:7345
```

Open `http://127.0.0.1:7345` in any browser. Engine status sits at the top
of the sidebar, under the brand;
if a prerequisite is missing a banner names it, and every render also
re-verifies prerequisites and reports a structured `prereqs_missing` error
rather than failing mysteriously. Set `PORT` to change the port. The Studio
binds to `127.0.0.1` only — it is a local tool, not a web service.

If Puppeteer's Chromium download is blocked on your network, install any
Chrome/Chromium yourself and point the engine at it:
`PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm run studio`.

## Working with projects

A project is a plain folder: `project.json` (settings), `composition.html`
(entry), `composition.js` (your animation), `styles.css`, a copy of
`frame-api.js`, an `assets/` folder, and `out/` for renders. **+ new** in
the sidebar asks for a name, fps, even dimensions, and duration in frames,
then scaffolds a working animated template you can render immediately.
Projects live under `~/.motion-studio/projects/` by default and are listed
from a shared registry — projects created by an AI agent through MCP appear
in the same list, because they are the same thing on disk.

The **config** tab is a complete view of `project.json`: the composition
fields (name/fps/size/duration), the whole `output` block (format, dir,
filename, crf, preset, pix fmt, transparent, audio limiter), read-only
**project facts** (entry file, schema version, attached 3D libraries and the
exact build each project vendored), and a **raw project.json** disclosure at
the bottom. Settings a given format doesn't use are greyed out rather than
hidden — mp4 has no alpha, GIF ignores crf, and so on — with a note
explaining why. Clearing an optional field (preset, pix fmt, crf) removes it
so the format's own default applies again.

The tab also shows the project's absolute folder location with a copy button,
and **delete project…** removes it: by default the project is only
unregistered from the list (the folder stays); tick *also delete files on
disk* to remove the folder too. Folders outside the managed projects root
are never deleted from disk, no matter what you tick.

Edit `composition.js` in your editor of choice against the Frame API
([frame-api.md](frame-api.md) — read it before writing your first
composition; the one-paragraph version: everything must be a pure function
of the frame number, no clocks, no CSS transitions, register your function
with `MotionStudio.registerComposition`).

## Assets (v0.15)

The **assets** tab lists everything under the project's `assets/` folder —
image thumbnails, in-place audio audition, size — and manages it: upload via
the **+ upload** button or by dropping files onto the panel (25 MB per file;
images, audio, fonts, JSON/TXT), rename/move within `assets/`, delete, and
download. **copy** puts the *project-relative* path (`assets/…`) on your
clipboard — exactly the string a composition or an `audio` track references.
A **♫ n** badge marks files the project's audio timeline uses; deleting one
asks whether to remove those tracks too (and renaming offers to repoint
them), so a stale reference can't quietly turn into an ffmpeg error mid-render.
The folder's absolute path is shown in the tab header (copy button next to
it) if you'd rather drop large files in with your file manager; anything you
put there shows up on the next refresh.

## Global settings (v0.15)

**⚙ settings** in the sidebar footer opens the global configuration:

- **new-project defaults** — the fps/dimensions/duration the *+ new* dialog
  is pre-filled with, and what any new project gets when its creator didn't
  specify — including one an agent makes over MCP.
- **default workers** — the render tab's initial workers selection, and the
  worker count for any render that doesn't name one.
- **ffmpeg** — a binary path override (leave empty to use `ffmpeg` on PATH;
  the dialog live-probes the effective binary and shows its version or a
  ✗ if it can't be run — the footer status updates too) and default
  crf/preset values that seed *newly created* projects' output config.
  The path override applies to every render — the Studio's, the CLI's, and an
  agent's. `MOTION_STUDIO_FFMPEG` overrides it for a single process, and the
  CLI's `--ffmpeg <path>` overrides both (`render.js --doctor` prints which
  binary it settled on and where that came from).
- a read-only **environment** report: where the data dir, projects root, and
  registry live, plus the current values of the `MOTION_STUDIO_*` env hooks,
  `PUPPETEER_EXECUTABLE_PATH`, and the speech-vendor variables (API keys shown
  masked, never in full).

Narration and music vendors each live on their own page — **🗣 tts** and
**♫ music** in the sidebar footer, next to ⚙ settings; see
[Generated narration](#generated-narration-text-to-speech) below.

Settings persist in `~/.motion-studio/settings.json` and are genuinely global:
the Studio, the CLI, and agents working over MCP all honour them. They fill in
what a new project or render didn't specify — an explicit choice always wins,
so an agent told to make a 4K vertical video still gets one — and they apply
only at creation. A project already on disk is never rewritten because you
changed a global, so it keeps rendering the way it did. One thing that file
never holds is a credential: API keys are read from the environment only.

The project sidebar sorts by **a–z** or **date** (last modified, newest
first) via the toggle next to *+ new*, and collapses to a slim strip with the
**«** button — both choices are remembered per browser.

The workbench is a fixed half preview, half panel, so switching tabs never
resizes the preview; long tabs scroll inside their half. The **▾** button at
the right of the tab bar collapses the panel when you want the full height
for scrubbing, and clicking any tab brings it back.

## Preview and scrubbing

Selecting a project loads its *actual entry HTML* into the preview iframe —
the same file headless Chromium renders — and the transport drives it
through the same `window.setFrame(n)` contract. Scrubbing exercises your
real animation logic. Space plays/pauses at the project's fps; arrow keys
step single frames. Transparent projects preview over a checkerboard.

Saving any project file hot-reloads the preview automatically (debounced, so
editor save bursts don't thrash), holding your current frame. If an AI agent
edits the project over MCP while you have it open, you'll see the change
land live — the amber dot in the preview header flashes on each reload.

The preview runs in *your* browser while the final render runs in
Puppeteer's Chromium; these are close relatives but not guaranteed to be the
identical binary, so subtle font-hinting/color differences are possible. The
render path is the source of truth — use the **still ⤓** button (or the CLI's
`--capture-frame`) for a pixel-exact check of any frame without a full
render.

## Rendering

The **render** tab starts a job for the full composition (or a `start-end`
frame range for a cheap pacing check). The workers selector parallelizes
capture across 1–4 Chromium processes; segments are merged losslessly at the
end. Expect near-linear speedup to about 4 workers, then diminishing returns
as Chromium instances compete for memory.

**Proxy/motion preview (v0.21):** when you want to check *motion* — pacing,
easing, a camera move — before paying for the real thing, render a proxy: a
half-resolution, every-2nd-frame draft that takes roughly 1/8 the time and
keeps wall-clock duration (it encodes at `fps/frameStep`, so playback speed is
true). Proxies skip audio and the pre-flight probe, always render serially,
and write to `output.proxy.mp4` so they never overwrite your deliverable.
Available via the `render` MCP tool's `proxy` option and the CLI's
`--proxy [scale] --frame-step N` flags; they work with whatever output format
the project is configured for (scaled dimensions are floored to even numbers
where the encoder demands it).

While a job runs you get a progress bar, effective render fps, an **ETA**,
and live logs. Starting another render while one is running **queues** it
(you'll see `queued #1`); it starts automatically when the slot frees.
**cancel** stops a running job and kills its entire process tree — Node,
every Chromium worker, FFmpeg — or silently drops a queued job. When a job
finishes, a download link appears and the output shows in the **outputs**
tab.

Common failures and what they mean: `composition_error` names the frame
where your JS threw (the message includes the page error);
`frame_timeout` means `frameReady` never flipped true within 15 s — almost
always async work (fonts/images) not awaited, use `registerComposition` with
an async function; `browser_launch_failed` usually means `npm install`
never completed its Chromium download (or set `PUPPETEER_EXECUTABLE_PATH`);
`ffmpeg_failed` includes the tail of FFmpeg's stderr.

Errors surface as **toasts** in the bottom-right corner (v0.20), not
blocking dialogs: the error code appears as a badge, the message — which
already contains the fix and any available alternative vendors — stays until
you dismiss it, and the page remains usable underneath. An unconfigured
music vendor now reports "not configured" (503) on the vendors page the
same way speech vendors always did, instead of a generic server error.

## Output formats (v0.5)

The **config** tab (or `project.json`'s `output` block) selects the
deliverable:

| format | you get | typical use |
|---|---|---|
| `mp4` | H.264 .mp4, `crf` 18 default | the default; plays everywhere |
| `webm` | VP9 .webm, `crf` ~32 | smaller files, alpha support |
| `gif` | animated GIF (two-pass palette) | short loops; keep it brief — GIF palettes are memory-hungry to build and files get large fast |
| `prores` | ProRes 422 HQ .mov (4444 when transparent) | editorial hand-off / NLE ingest |
| `png-sequence` | a folder of `frame-%06d.png` | compositing pipelines; maximum fidelity |

Switching format automatically fixes the output filename's extension.
`crf` = quality (lower is better/bigger; 0–63). Dimensions must be even for
mp4/webm/prores (chroma subsampling); gif and png-sequence take any size.

**Transparency**: tick *transparent (alpha)* (webm, prores, or png-sequence
only), give your composition a transparent background (no `background` on
`html/body`), and everything unpainted renders as alpha 0. The result drops
onto any timeline as an overlay — see `examples/lower-third`, which ships a
real transparent `lower-third.webm` and a proof composite over green.

## Audio

Use the **audio** tab, or add tracks to `project.json` directly:

```json
"audio": [
  { "src": "assets/music.mp3", "gainDb": -6, "fadeOutFrames": 30, "duck": true },
  { "src": "assets/voiceover.wav", "startInFrames": 45 }
]
```

The tab edits exactly this list: **+ add track** appends a row, `src`
autocompletes from the project's audio assets, the start frame shows its
equivalent in seconds as you type, and ▶ auditions the file. Edits are staged
until you press **save tracks**, so a half-typed path never reaches disk.

Each track can start at a frame offset and carry a gain in dB; multiple
tracks are mixed without normalization (so adding a quiet track doesn't duck
the others) and the result is trimmed/padded to exactly the video's length.
Drop the files in `assets/` and re-render. mp4 muxes AAC, webm muxes Opus,
prores muxes PCM; gif and png-sequence cannot carry audio (tracks are
skipped with a warning in the logs).

Since v0.19 a track also takes (all optional, all in frames, all
clip-relative):

- **`trimEndInFrames`** — keep only the clip's first N frames.
- **`fadeInFrames`** — fade up from silence at the clip start.
- **`fadeOutFrames`** — fade to silence ending at `trimEndInFrames` if set,
  otherwise at the composition end. A music bed longer than the video now
  resolves instead of cutting off at the last frame.
- **`duck: true`** — sidechain auto-ducking: this track is compressed by the
  mix of all *non*-ducked tracks, so a bed dips while narration speaks and
  recovers in the gaps. Engages only when ducked and non-ducked tracks both
  exist.

### Hearing the mix before a render (`preview_audio`, v0.19)

The `preview_audio` MCP tool mixes the audio timeline to
`out/audio-preview.wav` using the exact filter graph the render will use —
delays, gains, trims, fades, ducking, limiter — with no video pass. It reports
the mixed `peakDb`/`meanDb`, a `clipping` flag, and each source clip's own
level, so a bad balance names the track that caused it. Seconds instead of a
full render.

The `mix` block also carries `envelopeDb` — the mix's RMS level per second,
with `null` marking digital silence — and `silentTailSeconds`, the length of
the dead run at the end. Whole-file peak/mean can look perfectly healthy while
the last seconds are silent; the envelope makes a mix that dies early visible
in the tool result instead of only in the rendered film.

### Generated narration (text-to-speech)

You can synthesize a voiceover instead of supplying an audio file. An agent
calls the `synthesize_speech` MCP tool (see [tts-setup.md](tts-setup.md)): it
speaks your text to `assets/narration-<n>.wav`, reports the clip's length in
frames, and — in the default `attach` mode — adds it to the `audio` list above
for you. The synthesized WAV mixes through the exact audio path described above.

Since v0.17 the voice comes from one of several **speech vendors**, chosen on the
**🗣 tts** page in the sidebar footer.

- **system** — the local Windows speech executable
  (`MOTION_STUDIO_TTS_EXE`). Offline and free, but Windows-only and limited to
  the voices installed on the machine.
- **azure** — Azure AI Speech: several hundred neural voices across ~140
  locales, with expressive styles, on any OS. Needs an Azure Speech resource;
  set `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in your Windows environment
  (`setx AZURE_SPEECH_KEY "<key>"`, then restart the Studio). Keys are read from
  the environment only and are never written into `settings.json`.
- **piper** *(v0.18)* — [Piper](https://github.com/OHF-Voice/piper1-gpl) neural
  voices running on this machine: no account, no billing, no network, any OS.
  Install it yourself (`pip install piper-tts`, GPLv3) and download the voices
  you want — two files each, an `.onnx` and its `.onnx.json`, from
  huggingface.co/rhasspy/piper-voices — into the folder named by
  `MOTION_STUDIO_PIPER_VOICES`. Everything in that folder shows up in the
  picker.

The page shows each vendor's live status, what it is missing if it is
unavailable, its voice catalogue (filterable by locale), and a **▶ test** button
that speaks a line so you can hear a voice before committing a render to it.
Whichever vendor you save is used by the Studio *and* by every agent connected
over MCP; a tool call can still name a vendor explicitly for one clip. If the
selected vendor isn't configured, the speech tools return `tts_unavailable` and
the rest of Motion Studio is unaffected.

#### Ticking more than one vendor (preference chain)

The vendor boxes are checkboxes, not radio buttons: tick **several** and the
highest-ranked one that is actually set up gets used. Rank them with the ▲▼
buttons — the badge on each card shows `#1`, `#2`, … and the line above the cards
always says which vendor will really be used, plus anything it skipped.

The point is resilience, not variety: with `azure → piper`, narration uses the
good cloud voices while the key is valid and keeps working offline the moment it
isn't. Three things it will *not* do — a vendor you name explicitly in a tool call
is never swapped for another; only vendors that are **unconfigured** are skipped
(one that fails partway through a clip is still an error); and it never happens
silently, so expect a warning line here and a `vendorNote` on the tool result.

One caveat: the choice is made per clip. Across a long film, a vendor that stops
being available halfway through changes the voice from that point on. If a film's
narration has to be one voice no matter what, tick exactly one vendor — that is
still the default — and let it fail loudly instead.

### Generated music (note specs)

Music works the same way: an agent authors a short note spec and
`synthesize_music` renders it against a General MIDI SoundFont into `assets/`,
adding it to the audio timeline. The **♫ music** page in the sidebar footer
picks who renders it:

- **node** *(default)* — renders the SoundFont in-process. Works on any OS,
  needs nothing installed beyond the SoundFont that already ships, and is about
  four times faster than the external chain.
- **fluidsynth** — the original v0.8 pair of executables
  (`MotionStudioMidi.exe` + `fluidsynth.exe`). Windows-only, and you build or
  download them yourself.

Both read the same SoundFont and sound the same; **▶ listen** renders a short
phrase on any of the 128 General MIDI instruments through whichever vendor would
actually be used, so you can audition a SoundFont before committing a film to it.
Ticking both makes a preference chain, exactly as on the tts page above. The
**target peak** control (default −3 dBFS) applies to both vendors and only ever
attenuates, which is what keeps a bed at the same loudness against your
narration when you switch. See [music-setup.md](music-setup.md).

## Long-form films (multiple scenes)

One composition is the right size for a shot or a scene, not for minutes of
video. To build something longer, make **each scene its own project** (same
width/height/fps/format), render each, and stitch the results with the
`build_film` MCP tool — it concatenates the rendered scenes **losslessly**
(`-c copy`, no re-encode) into one continuous film, optionally laying a single
master audio track over the whole thing. Each scene stays a short, independent,
resumable render, so you can fix one scene and re-stitch in seconds. See
[film-setup.md](film-setup.md) for the pattern, the quality pipeline, and how it
scales to arbitrary length.

## The CLI

Everything the Studio does is scriptable:

```bash
node src/cli/render.js --project <folder> --output out/clip.mp4 --workers 4
node src/cli/render.js --project <folder> --frame-range 0 59 --output out/pace-check.mp4
node src/cli/render.js --project <folder> --proxy 0.5 --frame-step 2 --output out/clip.mp4   # → out/clip.proxy.mp4
node src/cli/render.js --project <folder> --capture-frame 42 --capture-out check.png
node src/cli/render.js --doctor
```

Progress streams to stdout as JSON lines (see
[architecture.md §4](architecture.md)); exit codes: 0 ok, 2 bad args,
3 prereqs missing, 4 cancelled, 1 render error.

## Connecting an AI agent

See [mcp-setup.md](mcp-setup.md). Agents see the same project list you do,
can author compositions, supply assets, and render on your behalf — and are
sandboxed to project folders: no arbitrary file access, no shell.
