# Motion Studio — code-driven video renderer

Motion Studio renders videos from HTML/CSS/JS animations using a
deterministic, frame-driven model. Animations are authored as **pure
functions of a frame number**, captured frame-by-frame in headless Chromium
(Puppeteer), and encoded with FFmpeg — entirely locally, no cloud. It serves
two kinds of users through one shared render engine:

- **Humans**, through the cross-platform **Studio web UI** (`npm run studio`):
  one tree of every **workspace → film → scene** on the machine, live preview
  that drives your *actual* composition, scrub/play transport, hot reload,
  render queue with progress + ETA, and full scene management — create,
  configure and delete scenes, manage `assets/` (upload, audition, rename,
  delete), edit the audio timeline, pick and audition the **speech, music and
  transcription vendors** (one, or an ordered fallback chain), and set global
  preferences including an FFmpeg binary override. The **film editor** cuts a film on a
  visual timeline — drag-to-reorder scenes, multi-lane master audio with
  waveforms, fades and auto-ducking, captions (burn-in and/or `.srt`
  sidecar), **footage segments** on the timeline beside rendered scenes,
  image and transparent-video overlays, in-editor narration with
  auto-synced captions, a preview that plays the real rendered scenes with
  the build's exact audio mix, and one-click assembly with measured
  mastering. A delivery is staged, validated, reviewed from the encoded file,
  and only then promoted over its visible output, so a failed revision never
  destroys the previous good movie. A film can also save **platform versions**
  (YouTube 16:9, Shorts/TikTok 9:16, Square 1:1) that share one edit and audio
  timeline rather than becoming hand-maintained copies. Each workspace also has
  a **shared-asset library** for the large files you want an agent to use
  without pushing them through the tool channel.
- **AI agents**, through a local **MCP server** with a fixed, path-sandboxed
  tool surface, **bound to one workspace** so two agents never land in each
  other's films: create films and the scenes inside them, author
  compositions, manage assets, synthesize narration through **six speech
  vendors** (local Windows voices, local neural Piper, or Azure / ElevenLabs
  / OpenAI / Deepgram in the cloud — with measured levels, per-sentence
  timings, and a `deterministic` option), music beds **composed from a chord
  progression** (`['D','A','Bm','G']` + a style) or from raw notes
  (in-process SoundFont synth or FluidSynth) and sound effects, audition the
   audio mix without a render (`preview_audio`), inspect and measure the
   **encoded deliverable** (`inspect_render` / `measure_render` — frames at known
   cuts plus static/black/cut checks), pull in the human's
  library files (`use_shared_asset`), read a media file's duration /
  dimensions / codecs (`probe_asset`) **and the speech inside it**
  (`transcribe_asset` — local whisper.cpp, sentence *and* word timing in
  frames, and a guard against using an English-only model for named non-English
  speech), **prepare it** (`transcode_asset` — conform footage to a film's
   encode and colour signature, trim to an exact frame count, crop/scale, or cut and join
  spans of someone's voice into one WAV; named fields only, never a shell),
  receive a ready-to-insert footage segment that retains its source-transcode
  record, and stop a build when that original source later changes,
  attach 3D libraries
  (Three.js/Babylon.js, with teapot/glTF/bloom addons), preview frames as
  images, render — including cheap **proxy motion drafts**
  (`proxy: { scale, frameStep }`) — poll, cancel, and assemble the film
  (`build_film`, async, with master audio, captions and overlays) — whose
  timeline now holds **real footage beside the rendered scenes** (v0.22), so a
  film can be "footage, then a scene, then footage". Builds preserve the prior
  delivery on failure and write a review JSON/contact sheet before promotion.
  No shell,
  no arbitrary file access.

### The model: workspace → film → scene

```
<dataDir>/workspaces/<workspace>/            one per AI; the human sees them all
  library/                                   shared assets the human provides
  films/<film>/
    film.json  assets/  out/                 the film owns its audio and output
    scenes/<scene>/                          one composition — the render unit
```

A **scene** is one composition (the thing that renders). A **film** is an
ordered list of scenes plus the master audio, captions and overlays laid over
them; it owns its own `assets/` and receives its build in its own `out/`.
Scenes concatenate **losslessly**, so a long video is many short scenes and
re-cutting costs seconds. Ids are just the slug path — `"my-film"`,
`"my-film/opening"` — and the filesystem is the registry. Data from before
v0.20 migrates automatically on first start (old registries are kept under
`legacy-v019/`; nothing is deleted).

`<dataDir>` is the `data` folder beside the app by default (v0.22), and it,
the workspaces root and the settings file are all editable in the Studio's
**Global Settings** — or per process via `MOTION_STUDIO_HOME`,
`MOTION_STUDIO_WORKSPACES` and `MOTION_STUDIO_SETTINGS`. An install from
before v0.22 keeps using its existing `~/.motion-studio` until you change it.

Output formats: **MP4** (H.264), **WebM** (VP9), **animated GIF**, **ProRes**
(.mov), and **PNG sequences** — including **true alpha-channel renders**
(transparent WebM/ProRes overlays that drop onto any timeline).

Every deliberate change since the v0.2 reference implementation is recorded
with its rationale in [docs/CHANGELOG.md](docs/CHANGELOG.md) — read it first.
Current production work adds safe staged promotion, encoded-delivery review
artefacts, Stage-A platform versions, and prepared-footage source provenance.
Earlier headlines: the Windows-only WinForms app became the Studio web UI (v0.5),
long-form film assembly (v0.9), vendored-build provenance (v0.13), in-job
crash recovery (v0.14), the full Studio management surface (v0.15), settings
that reach every entry point (v0.16), second implementations of both audio
generators — Azure AI Speech, and an in-process SoundFont synth that finally
makes music cross-platform — behind one vendors page (v0.17), local neural
narration through Piper (v0.18), an audio timeline you can hear and
measure before rendering — track fades/trim, sidechain auto-ducking,
`preview_audio`, narration levels + sentence timings, plus Three.js addons
and a deterministic particle emitter (v0.19), and the **workspace → film →
scene** storage model that replaced a flat project list, retired the
"— Master" output-project convention, gave each agent its own tree and the
human a shared-asset library (v0.20).

## Quick start

Prerequisites: **Node.js ≥ 18** and **FFmpeg ≥ 5** on PATH.

```bash
cd engine
npm install            # also downloads Puppeteer's Chromium (~150–300 MB, once)
npm run doctor         # verify prerequisites (JSON report, exit 0 = ready)
npm run studio         # Studio UI → http://127.0.0.1:7345
```

In the Studio, create a **film**, add a **scene** to it, scrub the scaffolded
template, hit **render** — then build the film when its scenes are rendered.
(A one-scene film is the right shape for a short single clip; there is no
separate "project" concept.) To render a scene folder from the command line:

```bash
node src/cli/render.js --scene ../examples/intro-title \
  --output ../examples/intro-title/out/intro-title.mp4 --workers 4
```

A scene folder is self-contained — `scene.json` plus the composition — so the
CLI needs nothing but the folder, and the `examples/` scenes render straight
from a checkout without a workspace.

If Puppeteer's Chromium download is blocked, install any Chrome/Chromium and
set `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`. If FFmpeg is not on PATH,
point at it with `--ffmpeg /path/to/ffmpeg` (CLI) or the **ffmpeg → binary
path** field in the Studio's ⚙ settings dialog, which applies to every
Studio render and the prerequisite check.

### Connect an AI agent (MCP)

Point any MCP client at the stdio server — for Claude Desktop:

```json
{
  "mcpServers": {
    "motionStudio": {
      "command": "node",
      "args": ["/absolute/path/to/motion-studio/engine/src/mcp/server.js"],
      "env": { "MOTION_STUDIO_WORKSPACE": "claude-desktop" }
    }
  }
}
```

`MOTION_STUDIO_WORKSPACE` names the tree this agent works in (created on
first use; default `default`). **Give each connected agent its own name** —
that is what keeps two of them from creating films in the same folder, and
what lets you tell in the Studio who made what. The workspace's `library/`
folder is where you drop large files for that agent to use.

Full walkthrough and tool reference: [docs/mcp-setup.md](docs/mcp-setup.md).

**There are two ready-to-use agent skills — install the one that matches how the
agent is deployed**, and pair either with `docs/frame-api.md`, which both expect
as `references/frame-api.md` when installed:

| Agent has | Install | For |
|---|---|---|
| MCP tools only, no shell | [docs/SKILL.md](docs/SKILL.md) | Motion graphics authored from HTML/CSS/JS |
| MCP **+** a shell with ffmpeg | [docs/SKILL-shell.md](docs/SKILL-shell.md) | Films built around footage the user recorded |

Why the split, and which design questions turn on it:
[docs/agent-environments.md](docs/agent-environments.md).

## Repository layout

```
motion-studio/
├── engine/                      Node.js — the whole product
│   ├── src/core/                Render Engine Core (single implementation)
│   │   ├── renderer.js            capture loop, parallel workers, stills
│   │   ├── browser.js             Puppeteer lifecycle (injectable for tests)
│   │   ├── encoder.js             FFmpeg: stdin pipe, sequence, concat, transcode, audio
│   │   ├── formats.js             output-format registry (mp4/webm/gif/prores/png-seq)
│   │   ├── store.js               workspace → film → scene storage; assets + library (v0.20)
│   │   ├── migrate.js             one-shot pre-v0.20 layout migration (v0.20)
│   │   ├── project.js             scene config schema v2 + migration, scaffolding, source lints
│   │   ├── jobs.js                render job queue (status / logs / cancel / ETA)
│   │   ├── sandbox.js             path sandbox for all file-touching surfaces
│   │   ├── progress.js            JSON-line stdout protocol (emitter + parser)
│   │   ├── prereqs.js             Node/FFmpeg detection, version floors
│   │   ├── settings.js            global user preferences + ffmpeg/vendor config (v0.15)
│   │   ├── tts.js                 speech vendor "system": spawn Windows exe, WAV duration (v0.6)
│   │   ├── tts-azure.js           speech vendor "azure": Azure AI Speech over REST (v0.17)
│   │   ├── tts-piper.js           speech vendor "piper": local neural voices, spawned (v0.18)
│   │   ├── tts-vendors.js         speech vendor registry, selection and dispatch (v0.17)
│   │   ├── vendors.js             shared vendor kit: selection, preference chains, status, errors (v0.17)
│   │   ├── libraries.js           optional 3D library registry (three/babylon) (v0.7)
│   │   ├── music.js               music vendor "fluidsynth": MIDI exe → FluidSynth → WAV (v0.8)
│   │   ├── music-node.js          music vendor "node": note spec → SoundFont, in-process (v0.17)
│   │   ├── music-vendors.js       music vendor registry, dispatch and level control (v0.17)
│   │   ├── sfx.js                 sound effects: pure-JS cue synthesis (v0.12)
│   │   ├── film.js                scene assembly primitives: validation, lossless concat (v0.9)
│   │   ├── delivery.js            staged delivery promotion + persistent review evidence
│   │   ├── deliverables.js        saved Stage-A platform versions + reframe contracts
│   │   ├── films.js               film document: planning, provenance checks, finishing + reframe pass
│   │   ├── lock.js                cross-process render lock (v0.11)
│   │   ├── vendor-lock.js         vendored 3D build provenance: version + sha256 (v0.13)
│   │   └── errors.js              stable machine-readable error codes
│   ├── src/cli/render.js          CLI entry (also the parallel worker binary)
│   ├── src/mcp/server.js          MCP entry — stdio server for agents, bound to one workspace
│   ├── src/studio/                Studio web UI — zero-dependency node:http server
│   │   ├── server.js                localhost API: workspaces/films/scenes/library/settings/render/jobs/SSE
│   │   └── public/                  vanilla-JS UI (no build step): index/app + the film editor (film.html/js/css)
│   ├── src/runtime/frame-api.js   in-page helper library v1.4 (copied into every scene)
│   ├── templates/default/         scene scaffold (HTML/JS/CSS)
│   └── test/                      535 tests across 27 suites (see below)
├── examples/
│   ├── intro-title/               1080p title sequence (mp4)
│   └── lower-third/               transparent WebM overlay (spring/Loop/interpolateColors)
├── comfyui/                       direct local image + paid Wan video generators
│   └── README.md                  Qwen, Ideogram 4, Krea 2, Wan, editing, setup + CLI
├── comfyui_music/
│   └── README.md                  local ACE-Step 1.5 instrumental + vocal generation
└── docs/
    ├── CHANGELOG.md               decision log + current release notes (read this first)
    ├── architecture.md            system design, formats, queue, sandboxing
    ├── user-guide.md              Studio UI: workspaces/films/scenes, library, assets, audio, settings, CLI
    ├── frame-api.md               the authoring contract (v1.4)
    ├── mcp-setup.md               agent setup + full tool reference
    ├── knowledge-base.md          field notes: failure modes seen in real productions
    ├── tts-setup.md               speech vendors: Piper (v0.18), Azure (v0.17), exe contract (v0.6)
    ├── 3d-libraries.md            three/babylon add_library + glTF/GLB models (v0.7)
    ├── music-setup.md             music vendors: in-process synth (v0.17) + FluidSynth (v0.8)
    ├── sfx-setup.md               sound effects: cue spec + synthesis (v0.12)
    ├── transcribe-setup.md        reading supplied speech: whisper.cpp, sentence + word timing (v0.22)
    ├── film-setup.md              long-form: films, scenes, master audio, the film editor
    ├── agent-environments.md      Env A / Env B: what an agent can reach, and why it matters
    ├── competitive-position.md    where this wins, what to stop trying to win, and in what order
    ├── SKILL.md                   drop-in agent skill — MCP only (Env A)
    ├── SKILL-shell.md             drop-in agent skill — MCP + ffmpeg/whisper.cpp (Env B)
    ├── todo_task/                 planned work, scoped against the two environments
    └── spec-changes.md            historical v0.2-era decision log
```

## The frame model in 20 seconds

```js
// composition.js — everything is a pure function of `frame`
MotionStudio.registerComposition((frame) => {
  const s = spring(frame, { fps: 30 });                    // physical pop, closed form
  logo.style.transform = `scale(${0.5 + 0.5 * s})`;
  bg.style.background = interpolateColors(frame, [0, 90],  // color drift
                                          ['#0b1026', '#274690']);
  Sequence(30, 60, (f) => {                                // time-offset section
    title.style.opacity = interpolate(f, [0, 15], [0, 1], { easing: 'easeOut' });
  });
});
```

No clocks, no CSS transitions, no `Math.random()` — which is why frames can
be rendered in any order, split across worker processes, and merged
losslessly. Full contract: [docs/frame-api.md](docs/frame-api.md).

## Testing

```bash
cd engine && npm test
```

547 tests across 28 suites: core units (incl. the workspace/film/scene store,
the workspace library, and the pre-v0.20 migration), pipeline integration
(real FFmpeg, probe-verified outputs for every format incl. transparent WebM
alpha and the parallel GIF/PNG-sequence merge paths), CLI, MCP (official SDK
client over stdio — including that a server cannot address another agent's
workspace), speech vendors (WAV parsing, stubbed exe contract, stubbed Azure
REST endpoint), music vendors (the real in-process synth against a tiny
generated SoundFont, plus the two-stage MIDI→FluidSynth pipeline against
stubs), sound effects, film assembly (scene validation + real
concat/master-audio mux), film documents (validation, planning,
caption/overlay builders, and the Studio films API driven end to end through
render → build → finishing pass), 3D libraries (add_library vendoring +
scaffold), vendored-build provenance, frame-api runtime (vm-hosted), Studio
HTTP server (ephemeral port, sandbox 403s, SSE hot reload, settings, asset
CRUD, speech-vendor API), and a gated real-Chromium suite (capture
determinism, genuine `omitBackground` alpha) that runs wherever a browser is
resolvable:

```bash
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm test
```

A clean run is **0 failures**. A few tests skip by design, depending on the
machine: the gated real-Chromium suite where no browser is resolvable; on
Windows, `cli: SIGTERM mid-render cancels with exit code 4`, because Windows
has no signal mechanism (`TerminateProcess` kills before any handler runs);
the symlink-escape sandbox test where the shell may not create symlinks; and
the ffmpeg-source probe, which needs a machine *without* ffmpeg on PATH.
Cancellation itself is covered on every platform through `JobManager.cancel`.

Rendered example output is not committed (`out/` is git-ignored); re-render an
example locally with the CLI one-liner in "Quick start" — it runs the real
headless-Chromium + FFmpeg parallel path.

## License

Unlicense — see [LICENSE.txt](LICENSE.txt).
