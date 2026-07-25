# Motion Studio v0.17 — code-driven video renderer

Motion Studio renders videos from HTML/CSS/JS animations using a
deterministic, frame-driven model. Animations are authored as **pure
functions of a frame number**, captured frame-by-frame in headless Chromium
(Puppeteer), and encoded with FFmpeg — entirely locally, no cloud. It serves
two kinds of users through one shared render engine:

- **Humans**, through the cross-platform **Studio web UI** (`npm run studio`):
  live preview that drives your *actual* composition, scrub/play transport,
  hot reload, render queue with progress + ETA, and full project management —
  create/configure/delete projects, manage `assets/` (upload, audition,
  rename, delete), edit the audio timeline, pick and audition the **speech and
  music vendors**, and set global preferences including an FFmpeg binary
  override.
- **AI agents**, through a local **MCP server** with a fixed, path-sandboxed
  tool surface (28 tools): author compositions, manage assets, synthesize
  narration (local Windows voices or Azure AI Speech), music beds (an
  in-process SoundFont synth or FluidSynth) and sound effects, attach 3D
  libraries (Three.js/Babylon.js), preview frames as images, render, poll,
  cancel, and assemble multi-scene films. No shell, no arbitrary file access.

Output formats: **MP4** (H.264), **WebM** (VP9), **animated GIF**, **ProRes**
(.mov), and **PNG sequences** — including **true alpha-channel renders**
(transparent WebM/ProRes overlays that drop onto any timeline).

Every deliberate change since the v0.2 reference implementation is recorded
with its rationale in [docs/CHANGELOG.md](docs/CHANGELOG.md) — read it first.
Headlines: the Windows-only WinForms app became the Studio web UI (v0.5),
long-form film assembly (v0.9), vendored-build provenance (v0.13), in-job
crash recovery (v0.14), the full Studio management surface (v0.15), settings
that reach every entry point (v0.16), and second implementations of both audio
generators — Azure AI Speech, and an in-process SoundFont synth that finally
makes music cross-platform — behind one vendors page (v0.17).

## Quick start

Prerequisites: **Node.js ≥ 18** and **FFmpeg ≥ 5** on PATH.

```bash
cd engine
npm install            # also downloads Puppeteer's Chromium (~150–300 MB, once)
npm run doctor         # verify prerequisites (JSON report, exit 0 = ready)
npm run studio         # Studio UI → http://127.0.0.1:7345
```

Create a project in the Studio (or via MCP), scrub the scaffolded template,
hit **render**. To render from the command line:

```bash
node src/cli/render.js --project ../examples/intro-title \
  --output ../examples/intro-title/out/intro-title.mp4 --workers 4
```

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
      "args": ["/absolute/path/to/motion-studio/engine/src/mcp/server.js"]
    }
  }
}
```

Full walkthrough and tool reference: [docs/mcp-setup.md](docs/mcp-setup.md).
A ready-to-use agent skill is in [docs/SKILL.md](docs/SKILL.md) (pair it
with `docs/references/frame-api.md`).

## Repository layout

```
motion-studio/
├── engine/                      Node.js — the whole product
│   ├── src/core/                Render Engine Core (single implementation)
│   │   ├── renderer.js            capture loop, parallel workers, stills
│   │   ├── browser.js             Puppeteer lifecycle (injectable for tests)
│   │   ├── encoder.js             FFmpeg: stdin pipe, sequence, concat, transcode, audio
│   │   ├── formats.js             output-format registry (mp4/webm/gif/prores/png-seq)
│   │   ├── project.js             config schema v2 + migration, registry, scaffolding, assets
│   │   ├── jobs.js                render job queue (status / logs / cancel / ETA)
│   │   ├── sandbox.js             path sandbox for all file-touching surfaces
│   │   ├── progress.js            JSON-line stdout protocol (emitter + parser)
│   │   ├── prereqs.js             Node/FFmpeg detection, version floors
│   │   ├── settings.js            global user preferences + ffmpeg/vendor config (v0.15)
│   │   ├── tts.js                 speech vendor "system": spawn Windows exe, WAV duration (v0.6)
│   │   ├── tts-azure.js           speech vendor "azure": Azure AI Speech over REST (v0.17)
│   │   ├── tts-vendors.js         speech vendor registry, selection and dispatch (v0.17)
│   │   ├── vendors.js             shared vendor kit: selection, status, errors (v0.17)
│   │   ├── libraries.js           optional 3D library registry (three/babylon) (v0.7)
│   │   ├── music.js               music vendor "fluidsynth": MIDI exe → FluidSynth → WAV (v0.8)
│   │   ├── music-node.js          music vendor "node": note spec → SoundFont, in-process (v0.17)
│   │   ├── music-vendors.js       music vendor registry, dispatch and level control (v0.17)
│   │   ├── sfx.js                 sound effects: pure-JS cue synthesis (v0.12)
│   │   ├── film.js                film: stitch rendered scene projects into one film (v0.9)
│   │   ├── lock.js                cross-process render lock (v0.11)
│   │   ├── vendor-lock.js         vendored 3D build provenance: version + sha256 (v0.13)
│   │   └── errors.js              stable machine-readable error codes
│   ├── src/cli/render.js          CLI entry (also the parallel worker binary)
│   ├── src/mcp/server.js          MCP entry — stdio server for agents (28 tools)
│   ├── src/studio/                Studio web UI — zero-dependency node:http server
│   │   ├── server.js                localhost API: projects/assets/settings/render/jobs/SSE
│   │   └── public/                  vanilla-JS single-page UI (no build step)
│   ├── src/runtime/frame-api.js   in-page helper library v1.1 (copied into projects)
│   ├── templates/default/         project scaffold (HTML/JS/CSS)
│   └── test/                      357 tests across 20 suites (see below)
├── examples/
│   ├── intro-title/               1080p title sequence (mp4) — REAL rendered output in out/
│   └── lower-third/               transparent WebM overlay (spring/Loop/interpolateColors)
│                                  — real alpha render + proof composite in out/
└── docs/
    ├── CHANGELOG.md               v0.2 → v0.17 decision log (read this first)
    ├── architecture.md            system design, formats, queue, sandboxing
    ├── user-guide.md              Studio UI, projects, assets, audio, settings, CLI
    ├── frame-api.md               the authoring contract (v1.1)
    ├── mcp-setup.md               agent setup + full tool reference
    ├── knowledge-base.md          field notes: failure modes seen in real productions
    ├── tts-setup.md               speech vendors: Azure setup (v0.17), exe contract + build (v0.6)
    ├── 3d-libraries.md            three/babylon add_library + glTF/GLB models (v0.7)
    ├── music-setup.md             music vendors: in-process synth (v0.17) + FluidSynth (v0.8)
    ├── sfx-setup.md               sound effects: cue spec + synthesis (v0.12)
    ├── film-setup.md              long-form: build_film scene assembly (v0.9)
    ├── SKILL.md                   drop-in agent skill
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

357 tests across 20 suites: core units, pipeline integration (real FFmpeg,
probe-verified outputs for every format incl. transparent WebM alpha and the
parallel GIF/PNG-sequence merge paths), CLI, MCP (official SDK client over
stdio), speech vendors (WAV parsing, stubbed exe contract, stubbed Azure REST
endpoint), music vendors (the real in-process synth against a tiny generated
SoundFont, plus the two-stage MIDI→FluidSynth pipeline against stubs), sound
effects, film
assembly (scene validation + real concat/master-audio mux), 3D libraries
(add_library vendoring + scaffold), vendored-build provenance, frame-api
runtime (vm-hosted), Studio HTTP server (ephemeral port, sandbox 403s, SSE hot
reload, settings, asset CRUD, speech-vendor API), and a gated real-Chromium suite (capture
determinism, genuine `omitBackground` alpha) that runs wherever a browser is
resolvable:

```bash
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm test
```

A clean run is **0 failures**. Two tests skip by design: the gated
real-Chromium suite where no browser is resolvable, and — on Windows only —
`cli: SIGTERM mid-render cancels with exit code 4`, because Windows has no
signal mechanism (`TerminateProcess` kills before any handler runs).
Cancellation itself is covered on every platform through `JobManager.cancel`.

The shipped example outputs under `examples/*/out/` were rendered with real
headless Chromium + FFmpeg through the parallel path.

## License

Unlicense — see [LICENSE.txt](LICENSE.txt).
