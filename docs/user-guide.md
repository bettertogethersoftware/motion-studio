# Motion Studio — User Guide (v0.20)

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

## Workspaces, films and scenes

Motion Studio's storage mirrors what you're actually making. A **workspace**
is one tree of work — each connected AI agent is bound to its own via
`MOTION_STUDIO_WORKSPACE` (default `"default"`, created on first use), and
the Studio shows *every* workspace, since the human browses them all. A
**film** is the video you're building: an ordered list of scenes plus a
master audio timeline, captions and overlays, with its own `assets/` (master
audio, overlay files) and `out/` (the built film). A **scene** is one
composition inside a film — same folder contents as ever (`scene.json`,
`composition.html`, `composition.js`, `styles.css`, a copy of `frame-api.js`,
`assets/`, `out/`), same preview/render behaviour; only its location changed.
There's no standalone scene outside a film — even a single short clip is a
film with one scene.

The sidebar is **one tree** instead of the old projects/films tabs: each
workspace row expands to its films (hovering reveals a **+ film** button;
an empty workspace shows a clickable **+ first film** row instead), each
film row — name, scene count, a ✕ to delete — expands to its scenes plus a
**+ scene** row, and a **⧉ library** row sits below a workspace's films (see
[Shared library](#shared-library) below). **+ workspace** at the very bottom
starts a new tree.

**+ film** opens the **new film** dialog: a name plus width/height/fps/
duration and optional **platform versions** (YouTube 16:9, Shorts/TikTok 9:16,
Square 1:1). The first selected platform supplies the master canvas; every
selected version is saved before any scene exists, so it shares one edit rather
than becoming a second film later. Leave them unticked for a master-only film.
Those dimensions become the film's *scene defaults* — every scene created
inside it inherits them, which is what keeps a film's scenes losslessly
concatenable — and the visual [film editor](#the-film-editor) opens next.
**+ scene** opens the **new scene** dialog: just a name and an
optional duration (0 = the film's default); width/height/fps always come
from the film, so diverging them is left to the scene's own config tab
rather than offered up front. Scenes and films created or edited by an agent
over MCP (`create_scene`, `create_film`, `update_film`, …) appear in the
same tree, because it's the same thing on disk — presence of `film.json` or
`scene.json` is what makes a folder a film or a scene, so there's no
separate registry to fall out of sync. Data lives under
`<dataDir>/workspaces/<workspace>/films/<film>/scenes/<scene>/`, where
`<dataDir>` is the `data` folder beside the app by default — change it in
the ⚙ global-settings page, or override it for one process with `MOTION_STUDIO_HOME`. If you
used Motion Studio before v0.22 your existing `~/.motion-studio` keeps being
used, and the settings page shows it.

Clicking a film's row opens its [film page](#watching-and-advising-the-film-page-v023)
— player, tree, timeline and [editor](#the-film-editor) on one surface;
clicking a scene opens the workbench below. The film row's ✕ deletes it — a confirm
asks whether to also delete its scenes, assets and output, or just the film
definition (the folder then stays on disk, listed as `broken` until cleaned
up).

The **config** tab (in the scene workbench) is a complete view of
`scene.json`: the composition fields (name/fps/size/duration), the whole
`output` block (format, dir, filename, crf, preset, pix fmt, transparent,
audio limiter), read-only **scene facts** (entry file, schema version,
attached 3D libraries and the exact build each scene vendored), and a
**raw scene.json** disclosure at the bottom. Settings a given format
doesn't use are greyed out rather than hidden — mp4 has no alpha, GIF
ignores crf, and so on — with a note explaining why. Clearing an optional
field (preset, pix fmt, crf) removes it so the format's own default applies
again.

The tab also shows the scene's absolute folder location with a copy button,
and **delete scene…** removes it: unchecked, the scene only leaves its
film's play order (the folder stays on disk, listed as *unlisted* in the
[film editor](#the-film-editor)'s scenes rail); tick *also delete files on
disk* to remove the folder too.

Edit `composition.js` in your editor of choice against the Frame API
([frame-api.md](frame-api.md) — read it before writing your first
composition; the one-paragraph version: everything must be a pure function
of the frame number, no clocks, no CSS transitions, register your function
with `MotionStudio.registerComposition`).

## Assets (v0.15)

The **assets** tab lists everything under the scene's `assets/` folder —
image thumbnails, in-place audio audition, size — and manages it: upload via
the **+ upload** button or by dropping files onto the panel (25 MB per file;
images, audio, fonts, JSON/TXT), rename/move within `assets/`, delete, and
download. **copy** puts the *scene-relative* path (`assets/…`) on your
clipboard — exactly the string a composition or an `audio` track references.
A **♫ n** badge marks files the scene's audio timeline uses; deleting one
asks whether to remove those tracks too (and renaming offers to repoint
them), so a stale reference can't quietly turn into an ffmpeg error mid-render.
The folder's absolute path is shown in the tab header (copy button next to
it) if you'd rather drop large files in with your file manager; anything you
put there shows up on the next refresh. A film has its own `assets/` the
same way — master audio and overlay files, managed from the
[film editor](#the-film-editor) instead of this tab.

## Shared library

Each workspace also has a **⧉ library**: shared assets the human manages
once, that workspace's agent can then pull into any scene or film. It's a
row in the tree below a workspace's films rather than a tab on a scene,
since it belongs to the whole workspace, not to whichever scene happens to
be open.

The library page **uploads** (optionally into a subfolder you type, handy
once it grows past a handful of files), **downloads**, and **deletes**.
Unlike scene and film assets there's no 25 MB cap — the library exists
specifically for the files too big for that channel (a licensed soundtrack,
a folder of location photos, a multi-gigabyte video plate). An agent lists
the library with `list_shared_assets` and pulls a file into a scene's or
film's own `assets/` with `use_shared_asset` — hardlinked where the
filesystem allows, so a large asset costs no extra disk and the scene or
film still renders from a normal, self-contained `assets/` folder. Deleting
a library file doesn't touch copies a scene or film already pulled in.

## Global settings (v0.15)

The **⚙** button in the sidebar footer opens the global configuration (since
v0.25 the footer shows compact labels — `tts · music · trans · ⚙` — so all
four buttons fit the rail; full names live in the tooltips) — since v0.22 an
inline stage page like the
tts/music vendor pages (it replaces the workbench while open; close restores
it), no longer a popup dialog. Since v0.25 the **save** button sits in the
page header like the vendor pages, each section is drawn as its own
accent-barred card, and the header carries the engine status strip
(version · engine · ffmpeg) that used to occupy the sidebar:

- **new-scene defaults** — the fps/dimensions/duration the **new film** and
  **new scene** dialogs are pre-filled with, and what any new film or scene
  gets when its creator didn't specify — including one an agent makes over
  MCP (`create_film`/`create_scene`). Newly created films/scenes only;
  existing ones keep their own.
- **new-film platform defaults** — optional platform versions preselected in
  Studio's **new film** dialog. Leave all clear for master-only by default.
  An AI request that explicitly names YouTube, TikTok/Shorts, or Square always
  wins and is saved as that film's own snapshot; changing this setting never
  alters a film already created.
- **default workers** — the render tab's initial workers selection, and the
  worker count for any render that doesn't name one.
- **delivery review** — comma-separated finding codes to **block** or record
  as a **warning** after an encoded file is staged. The default blocks only a
  frame-count mismatch; dark/static/cut findings stay warnings because they can
  be intentional. A block preserves the prior delivery and leaves staged
  evidence for diagnosis. A film can save a more specific policy through its
  document (for example an agent can use `update_film { review: … }`).
- **ffmpeg** — a binary path override (leave empty to use `ffmpeg` on PATH;
  the dialog live-probes the effective binary and shows its version or a
  ✗ if it can't be run — the engine status strip in the page header updates
  too) and default
  crf/preset values that seed *newly created* scenes' output config.
  The path override applies to every render — the Studio's, the CLI's, and an
  agent's. `MOTION_STUDIO_FFMPEG` overrides it for a single process, and the
  CLI's `--ffmpeg <path>` overrides both (`render.js --doctor` prints which
  binary it settled on and where that came from).
- **storage** (v0.22): where the **data dir**, the **workspaces root** and the
  **settings file** live — editable, not just reported. Leave a box empty for
  its default (shown greyed inside it); a relative path is taken from the
  Motion Studio folder, so `data` keeps the install portable. Under each box is
  the resolved path and where it came from. Folders are created on save and
  **nothing is moved** — point these at a tree that already exists, or copy
  your files across yourself first. The Studio switches over immediately (it
  reloads); connected agents keep using the old location until their MCP server
  is restarted. A field that `MOTION_STUDIO_HOME` / `_WORKSPACES` / `_SETTINGS`
  / `_VENDOR_DIR` already sets is shown locked, because editing it here would
  change nothing. Moving is refused while a render or build is running
  (`storage_busy`) — let it finish first.
  The fourth box, **vendor dir** (v0.25), is where the bundled speech/music
  exes, FluidSynth, SoundFonts, Piper voices, Whisper models and the 3D libs
  are looked up — default: the app's own `vendor` folder. A per-item override
  (an exe path on a vendor card, or an env var such as
  `MOTION_STUDIO_SOUNDFONT`) still beats it; changing it needs no reload —
  the next probe simply resolves against the new root.
- a read-only **environment** report: the bootstrap file that records the
  locations above, plus the current values of the `MOTION_STUDIO_*` env hooks
  (including which **workspace** each connected agent is bound to),
  `PUPPETEER_EXECUTABLE_PATH`, and the speech-vendor variables (API keys shown
  masked, never in full).

Narration and music vendors each live on their own page — **🗣 tts** and
**♫ music** in the sidebar footer, next to ✎ trans and the ⚙ settings button; see
[Generated narration](#generated-narration-text-to-speech) below.

Settings persist in `<dataDir>/settings.json` and are genuinely global:
the Studio, the CLI, and agents working over MCP all honour them. They fill in
what a new scene or render didn't specify — an explicit choice always wins,
so an agent told to make a 4K vertical video still gets one — and they apply
only at creation where they seed a scene. The worker and delivery-review
settings are runtime defaults, so they apply to the next render but do not
rewrite any scene. One thing that file never holds is a credential: API keys
are read from the environment only.

The sidebar collapses to a slim strip with the **«** button, and each
workspace's and film's expanded/collapsed state persists the same way — both
remembered per browser.

The workbench is a fixed half preview, half panel, so switching tabs never
resizes the preview; long tabs scroll inside their half. The **▾** button at
the right of the tab bar collapses the panel when you want the full height
for scrubbing, and clicking any tab brings it back.

## Preview and scrubbing

Selecting a scene loads its *actual entry HTML* into the preview iframe —
the same file headless Chromium renders — and the transport drives it
through the same `window.setFrame(n)` contract. Scrubbing exercises your
real animation logic. Space plays/pauses at the scene's fps; arrow keys
step single frames. Transparent scenes preview over a checkerboard.

Saving any scene file hot-reloads the preview automatically (debounced, so
editor save bursts don't thrash), holding your current frame. If an AI agent
edits the scene over MCP while you have it open, you'll see the change
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
capture across Chromium processes (1, 2, 3, 4, 6, 8, or 10); segments are
merged losslessly at the end. Expect near-linear speedup to about 4 workers,
then diminishing returns beyond that as Chromium instances compete for memory
— watch RAM usage at 6+ workers, since paging (not CPU) is usually the real
ceiling.

**Proxy/motion preview (v0.21):** when you want to check *motion* — pacing,
easing, a camera move — before paying for the real thing, render a proxy: a
half-resolution, every-2nd-frame draft that takes roughly 1/8 the time and
keeps wall-clock duration (it encodes at `fps/frameStep`, so playback speed is
true). Proxies skip audio and the pre-flight probe, always render serially,
and write to `output.proxy.mp4` so they never overwrite your deliverable.
Available via the `render` MCP tool's `proxy` option and the CLI's
`--proxy [scale] --frame-step N` flags; they work with whatever output format
the scene is configured for (scaled dimensions are floored to even numbers
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

The **config** tab (or `scene.json`'s `output` block) selects the
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

**Do not set mp4 `crf` to 0 for "maximum quality."** CRF 0 makes x264 encode
*lossless* H.264, which the spec forces into the High 4:4:4 Predictive
profile — a profile most players (Windows Movies & TV, phones, TVs,
browsers) cannot decode. The symptom is black video with working audio, and
it looks exactly like a broken render even though every frame is in the
file. The render still succeeds but logs a `[warn]` and reports
`encodingWarnings` in the job status. Use `crf` 18 (the default) for
visually-lossless mp4 that plays everywhere; if you truly need lossless,
use `prores` or `png-sequence` instead.

**Transparency**: tick *transparent (alpha)* (webm, prores, or png-sequence
only), give your composition a transparent background (no `background` on
`html/body`), and everything unpainted renders as alpha 0. The result drops
onto any timeline as an overlay — see `examples/lower-third`, which ships a
real transparent `lower-third.webm` and a proof composite over green.

## Audio

Use the **audio** tab, or add tracks to `scene.json` directly:

```json
"audio": [
  { "src": "assets/music.mp3", "gainDb": -6, "fadeOutFrames": 30, "duck": true },
  { "src": "assets/voiceover.wav", "startInFrames": 45 }
]
```

The tab edits exactly this list: **+ add track** appends a row, `src`
autocompletes from the scene's audio assets, the start frame shows its
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

The `preview_audio` MCP tool mixes a **scene's or a film's** audio timeline
to `out/audio-preview.wav` using the exact filter graph the render (or film
build) will use — delays, gains, trims, fades, ducking, limiter — with no
video pass. It reports
the mixed `peakDb`/`meanDb`, a `clipping` flag, and each source clip's own
level, so a bad balance names the track that caused it. Seconds instead of a
full render.

The `mix` block also carries `envelopeDb` — the mix's RMS level per second,
with `null` marking digital silence — and `silentTailSeconds`, the length of
the dead run at the end. Whole-file peak/mean can look perfectly healthy while
the last seconds are silent; the envelope makes a mix that dies early visible
in the tool result instead of only in the rendered film.

The result's `balanceWarnings` list flags the opposite of clipping: a track
whose effective level (its own measured mean plus its `gainDb`) sits 8 dB or
more below a louder track playing at the same time. Such a track is almost
certainly inaudible in the mix, yet the render succeeds and nothing clips —
the mix only got quieter — so without this check the only symptom is "I can't
hear one of my tracks". Gains should compensate each file's measured level,
not apply a fixed template. Mark an intentional background layer `duck: true`
and it is exempt. The final render runs the same check: warnings appear as
`[warn]` lines in the job log and in the completion status's `audio` block.

### Generated narration (text-to-speech)

You can synthesize a voiceover instead of supplying an audio file. An agent
calls the `synthesize_speech` MCP tool (see [tts-setup.md](tts-setup.md))
targeting a scene or a film: it speaks your text to
`assets/narration-<n>.wav` in that target's own `assets/`, reports the
clip's length in frames, and — in the default `attach` mode — adds it to the
`audio` list above (a scene's own list, or a film's master timeline) for
you. The synthesized WAV mixes through the exact audio path described above.

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

Since v0.22 the page shows **one vendor at a time behind tabs** (six cards made
it a long scroll); the tab strip opens on whichever vendor would actually run.
Each card shows the vendor's live status, what it is missing if it is
unavailable, its voice catalogue (filterable by locale), and a **▶ test** button
that speaks a line so you can hear a voice before committing a render to it.
The music page uses the same tabs.
Whichever vendor you save is used by the Studio *and* by every agent connected
over MCP; a tool call can still name a vendor explicitly for one clip. If the
selected vendor isn't configured, the speech tools return `tts_unavailable` and
the rest of Motion Studio is unaffected.

**Starring voices for agents (v0.22).** The **☆** next to each vendor's voice
picker stars the selected voice; starred voices show as chips at the top of
the page (click to remove) and save as `tts.favoriteVoices`, keyed by vendor.
Connected agents see them in `list_vendors` and are instructed to prefer a
starred voice when a request doesn't name one — the speech twin of the music
page's starred instruments. An explicit voice in your request still wins.

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

**Starring instruments for agents (v0.22).** Next to the audition picker, the
**☆ favorite** button stars the selected instrument; starred programs show as
chips (click one to remove it) and save with the music settings as
`music.favoritePrograms`. Connected agents see the list in `list_vendors` and
are instructed to prefer starred programs when composing — so auditioning
sounds you like directly steers what generated music uses, instead of every
piece defaulting to piano and strings. An explicit instrument in your request
still wins.

### Reading a recording you supplied (transcription, v0.22)

The two pages above make audio. The **✎ trans** (transcription) page in the sidebar footer
configures the one thing that *reads* it: `transcribe_asset` turns a recording you
supplied — audio or video — into text with per-sentence and per-word timing, which
is what lets an agent cut your talk on sentence boundaries and land a caption on
the word being spoken.

It runs **whisper.cpp** entirely on this machine: one binary plus one model file,
no account, no API key, no network. Point the page's **executable** box (or
`MOTION_STUDIO_WHISPER_BIN`) at `whisper-cli` — **or at the folder holding it**,
including the root you unzipped; the engine looks inside for the binary and
tells you where it found it. Keep a `ggml-*.bin` model in a `models` folder
beside it (the layout every prebuilt release already has, and the page finds it
automatically), and restart. Until then the page says exactly what is missing
and every transcription call fails with `transcription_unavailable` rather than
half-working.

The page's test is the inverse of the tts page's: instead of typing a line and
hearing it, you **choose a recording and read what came back**. It shows the
re-segmented sentences with the `start` and `frames` numbers an agent would place a
caption at, the confidence of the least certain word in each (low values in red —
those are the captions that would be wrong on screen), and how many times realtime
*this* machine reads speech. That last number is the one worth knowing before you
build a film around a long recording. See
[transcribe-setup.md](transcribe-setup.md).

Transcriptions run in their own job lane, so one never waits behind a render — and
results are cached, so an agent asking the same question twice costs nothing.

### Footage a connected agent can prepare and place (v0.22)

Two things an agent could not do before this release, both about video *you*
supplied rather than animation it wrote:

- **Put your footage on the film timeline.** A film's play order can now hold
  footage segments beside rendered scenes, so a film can be "your clip, then a
  graphic, then your clip". The film editor shows them as distinct blocks (▣, a
  warmer fill, no render dot — they were never rendered), and **+ footage** puts one
  on the timeline, reading its frame count from the file rather than asking anyone
  to type it. Footage joins without re-encoding, so it has to match the film's
  resolution/fps/format and must be silent — its sound belongs on the master audio
  timeline.
- **Conform a clip so it can.** `transcode_asset` trims to an exact frame count,
  crops, scales, and re-encodes to the film's own settings; it also extracts and
  joins spans of audio into a single WAV. It has no ffmpeg-argument passthrough by
  design — every operation is a named field — and it never overwrites your source.

Together these mean a film built around your own recording no longer needs anyone
to run ffmpeg by hand. See [film-setup.md](film-setup.md#footage-on-the-timeline-v022).

## Watching and advising: the film page (v0.23)

Clicking a film opens **its one page**. It exists for the workflow Motion
Studio is built around: an AI directs production unattended, and you return
whenever you like, watch what it made, and tell it what you think. Nothing
here asks for approval, and nothing waits for you.

Everything is on one surface — player, tree, timeline, and the full editor.
There is no separate review screen and no mode to pick: one film, one
timeline, one set of rules.

### Watch & advise

- **The tree is the film.** The left rail reads `Film → Sequence →
  Scene/Footage`. Click a sequence and the playhead jumps to its start and
  its band lights up; click a scene or clip and the matching timeline block
  selects. Scene folders the film does not play sit below as **unused
  scenes**. The timeline gains a **sequences** band above the scenes row and
  an **advice** row of markers below the tracks.
- **Click to aim, then say it.** Select anything — a sequence, a scene, a
  supplied clip, an audio item, a caption, an overlay, or just the film at
  this moment — and press **✎ advise AI** (or `A`). A small popup opens on
  exactly that thing, showing what it is and where you are in the film, with
  one comment box. Press advise with nothing selected and the next click on
  the tree, timeline or picture becomes the target; `Esc` cancels.
- **Nothing to fill in.** The target, the frame, and what you were watching
  are captured from your selection, and a frame grab of that exact moment is
  stored with your words. Close the browser whenever — advice is on disk and
  the AI finds it at its next checkpoint. Statuses are the human ones:
  *advice sent → AI received it → AI is working on it → updated* (or *AI
  reviewed it* with a short reason, or *AI needs more information* with a
  question you answer inline). Opening one shows the AI's explanation and
  the before/after frames.
- **You can take it back.** Every still-open item has a **withdraw** button,
  and the section foot has **withdraw all N open across the film**. Use it for
  a typo, a duplicate, or a note you thought better of — otherwise it is
  re-served to every later AI run. Withdrawing *closes* rather than deletes:
  your wording, the event log and the evidence stay on record, the timeline
  marker turns resolved instead of vanishing, and the card reads *you withdrew
  this* rather than crediting the AI with a decision it never made.
- **Every version is kept.** Select a scene and the inspector lists its
  **versions** — each completed render, archived with its date, author and
  the AI's one-line note. Click a take to watch it *in place* in the film;
  previewing changes nothing. If an older one was better, **ask AI to use
  this** (also offered right in the advice popup as *previous result*). That
  sends high-priority advice naming the exact take; the AI normally switches
  to it (no re-rendering — it is archived), may derive something better from
  it, or explains why not. The page never changes production itself.
- **Preview or the real thing.** The player normally stitches the scenes as
  they stand right now. Switch it to **built film** to watch the last film
  the AI actually assembled, with its real mix, overlays and burned
  captions; that player pins one archived build and never switches beneath
  you. A newer build offers itself in a banner, and a build whose length no
  longer matches the cut says so rather than pretending.
- **Honest progress.** The header shows what the AI reports it is doing
  ("Creating scene demo-shot"), live; when its heartbeat goes stale you see
  *waiting for the next AI run* — completed work and your advice are
  unaffected.
- **No film built yet?** Everything above still works against the scene
  preview: the tree, the timeline, and advice on any scene, clip or track
  item.

### The production controls

They are always available: the add row (`+
scene`, `+ narration`, `+ audio`, `+ caption`, `+ footage`, `+ overlay`),
snap, drag-to-reorder and edge-trim, the full property inspector, undo/redo,
per-scene render and **build film**. Sequences gain `+ seq` (group the
selected segment onward), plus rename, ungroup, and an **intent** note the AI
reads. The advice and version sections stay visible in this mode too, so the
conversation is never a mode away.

In watch mode none of that can fire: dragging a block only selects it, and
Delete does nothing.

## Long-form films (multiple scenes)

A single composition is the right size for a shot, not for minutes of video.
For anything longer, start a **film** and give it several **scenes** — each
one inherits the film's width/height/fps, so they're concat-compatible by
construction — render each, and let the film's assembly stitch them
together. Assembly concatenates the rendered scenes **losslessly** (`-c
copy`, no re-encode) into one continuous video, so each scene stays a short,
independent, resumable render — fix one scene, re-render only it, re-stitch
in seconds.

### The film editor

The editor *is* the film page — the same surface you watch and advise on (see
[Watching and advising](#watching-and-advising-the-film-page-v023)).

Creating a film (**+ film** in a workspace, or `create_film` over MCP) opens
it right away — there's no separate save step and no more dedicated "…—
Master" project: the film folder itself holds the assets and output. The info
bar shows the film's **workspace** and name. The left rail is the `Film →
Sequence → Scene/Footage` tree — the play order, read top to bottom — with
any scene folder the film does *not* play listed below it as an **unused
scene** (made by an agent, or copied in by hand) ready to drag in. The right
panel is the context inspector — and the **build panel** docks there too, so
assembling never covers the timeline. The timeline holds a sequence band row,
scene/footage blocks, audio, caption and overlay tracks, and an advice row:

- **sequences** — the narrative band above the cut. Consecutive segments
  sharing a label are one sequence; there is nothing else to it, which is why
  regrouping never moves a file or invalidates a render. **+ seq** groups the
  selected segment and everything after it; the inspector renames, ungroups,
  and holds an **intent** note the AI reads. A scene dropped inside a
  sequence joins it rather than splitting the band in three.
- **scenes and footage** — **drag a scene from the unused list onto the
  timeline** to place it (an insert marker shows where it lands), or hit the
  row's **+** to append it; drag blocks to reorder. **+ new scene** at the
  foot of the rail scaffolds a fresh scene folder directly into the film.
  Incompatible/unrendered scenes and footage with a mismatched signature or
  frame count are flagged before a build. Prepared footage can retain the
  source record returned by `transcode_asset`; its inspector status is
  **source verified** until the original file changes. A changed or missing
  source stops the build and needs a fresh preparation pass. Scene and footage
  blocks are butt-joined — a film has no gaps — so order is the only thing to
  drag.
- **audio** — a master timeline laid over the whole film (it replaces
  per-scene audio, same rule as `build_film`). “+ audio” places an asset at
  the playhead; “+ narration” synthesizes speech through your configured
  vendor right into the film, and can drop a **synced caption per sentence**
  and duck the music bed under the voice in the same click. Tracks show
  decoded waveforms; drag to move, drag the right edge to trim, and set
  gain / fades / **duck** in the inspector. Overlapping tracks auto-pack
  into lanes.
- **captions** — text blocks with frame-accurate in/out. A `.srt` sidecar is
  always written next to the built film; tick **burn captions** to also
  render them into the picture (size/position under the film inspector).
- **overlay** — images (logo, watermark) or videos (a transparent `.webm`
  stinger keeps its alpha) composited over the film: position/width in % of
  frame, opacity, frame-accurate window.
- **advice** — a marker per piece of human advice, wherever on the film it
  was left. Clicking one selects what it was about and opens it. Blocks and
  tree rows carry a small count badge while advice on them is unresolved.

The **preview plays your real rendered scenes** back to back with overlays
and captions drawn in place. With a master timeline, pressing play builds the
mix through **the exact ffmpeg graph the final film uses** (gains, fades,
ducking, limiter) — what you hear is what ships. Snap, zoom, undo/redo and
autosave behave the way you'd expect from an NLE; Space plays, arrows step,
Del removes the selected block.

**You and the AI share this document, so the page watches for its edits.**
When the AI changes the film while you have the page open, a page with nothing
unsaved quietly catches up on its next refresh. If you *are* mid-edit, the save
indicator reads **changed elsewhere** and your work is left alone. Should you
save anyway, the save is refused rather than applied: an edit here is a
statement about the *whole* scene order, so letting it through would wipe out
whatever the AI just did. The page then reloads and tells you that last change
was not saved — make it again on top of the new version. Losing one edit is
the point; the alternative is silently losing the AI's.

The empty right-side inspector also contains **platform versions**. It shows the
versions the AI or new-film dialog chose, lets you add/remove a saved preset,
choose its output name and caption style, and set a default or per-scene crop
focus. These controls change only that delivery version; timing, cuts, master
audio and captions remain the one shared film edit. Its contact sheet later
draws the version's caption-safe guide so the final portrait crop can be judged
from the actual encoded picture.

**build film →** opens the build panel in the right-side column (the
timeline stays visible and editable) and assembles: lossless concat,
master-audio mux with optional **master-to-peak** (measure the mix, shift
every track by one offset, re-mux once — your balance survives), then — only
if the film uses overlays or burned captions — a single finishing encode.
The panel shows live progress (the header button carries the percent even if
you switch back to editing) and, when it lands, the measured
`peak/mean dBFS` of the mix, a download link, and an **Output review** contact
sheet. Its badges point to the encoded film's black/static/cut findings and
caption/cut frames; the list below it records the exact policy severity. The
same `<base>.review.json` and `<base>.contact.png` live beside the movie in
`out/`, so the review survives a reload and is available to agents too. Choose
**master** or a saved platform version in the panel; a platform version is a
target-size reframe of the approved master, with its own output/SRT/review files.
**build master + all versions** runs every saved delivery in sequence with separate
staged output names — it does not rebuild the edit by hand.

Films are shared with the agent whose workspace they live in: `update_film`
and `build_film` over MCP edit and build this same `film.json`, so a film you
re-cut here is the one the agent rebuilds, and vice versa. See
[film-setup.md](film-setup.md) for the underlying model, the quality
pipeline, and how it scales to arbitrary length.

## The CLI

Everything the Studio does is scriptable. `<folder>` is any scene folder —
for example one under
`<dataDir>/workspaces/<workspace>/films/<film>/scenes/<scene>/`, or a
standalone composition folder like the ones under `examples/`:

```bash
node src/cli/render.js --scene <folder> --output out/clip.mp4 --workers 4
node src/cli/render.js --scene <folder> --frame-range 0 59 --output out/pace-check.mp4
node src/cli/render.js --scene <folder> --proxy 0.5 --frame-step 2 --output out/clip.mp4   # → out/clip.proxy.mp4
node src/cli/render.js --scene <folder> --capture-frame 42 --capture-out check.png
node src/cli/render.js --doctor
```

Progress streams to stdout as JSON lines (see
[architecture.md §4](architecture.md)); exit codes: 0 ok, 2 bad args,
3 prereqs missing, 4 cancelled, 1 render error.

## Connecting an AI agent

See [mcp-setup.md](mcp-setup.md). An agent works inside its own
**workspace** (`MOTION_STUDIO_WORKSPACE`) — the Studio shows every
workspace, but a given agent only ever sees its own — and can create films
and scenes, author compositions, supply assets, pull files from the
workspace's shared library, and render on your behalf. Every agent is
sandboxed to its workspace's scene and film folders: no arbitrary file
access, no shell.
