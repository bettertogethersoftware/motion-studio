# Motion Studio v0.5 — code-driven video renderer

Motion Studio renders videos from HTML/CSS/JS animations using a
deterministic, frame-driven model. Animations are authored as **pure
functions of a frame number**, captured frame-by-frame in headless Chromium
(Puppeteer), and encoded with FFmpeg — entirely locally, no cloud. It serves
two kinds of users through one shared render engine:

- **Humans**, through the cross-platform **Studio web UI** (`npm run studio`):
  live preview that drives your *actual* composition, scrub/play transport,
  hot reload, render queue with progress + ETA, output downloads.
- **AI agents**, through a local **MCP server** with a fixed, path-sandboxed
  tool surface (15 tools): author compositions, ingest assets, preview
  frames as images, render, poll, cancel. No shell, no arbitrary file access.

Output formats: **MP4** (H.264), **WebM** (VP9), **animated GIF**, **ProRes**
(.mov), and **PNG sequences** — including **true alpha-channel renders**
(transparent WebM/ProRes overlays that drop onto any timeline).

v0.5 evolves the v0.2 reference implementation into a commercial-ready,
cross-platform product; every deliberate change is recorded with rationale
in [docs/CHANGELOG.md](docs/CHANGELOG.md) (headline: the Windows-only
WinForms app is replaced by the Studio web UI).

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
set `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`.

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
│   │   └── errors.js              stable machine-readable error codes
│   ├── src/cli/render.js          CLI entry (also the parallel worker binary)
│   ├── src/mcp/server.js          MCP entry — stdio server for agents (15 tools)
│   ├── src/studio/                Studio web UI — zero-dependency node:http server
│   │   ├── server.js                localhost API: projects/preview/render/jobs/SSE
│   │   └── public/                  vanilla-JS single-page UI (no build step)
│   ├── src/runtime/frame-api.js   in-page helper library v1.1 (copied into projects)
│   ├── templates/default/         project scaffold (HTML/JS/CSS)
│   └── test/                      102 tests across 8 suites (see below)
├── examples/
│   ├── intro-title/               1080p title sequence (mp4) — REAL rendered output in out/
│   └── lower-third/               transparent WebM overlay (spring/Loop/interpolateColors)
│                                  — real alpha render + proof composite in out/
└── docs/
    ├── CHANGELOG.md               v0.2 → v0.5 decision log (read this first)
    ├── architecture.md            system design, formats, queue, sandboxing
    ├── user-guide.md              Studio UI, formats, transparency, audio, CLI
    ├── frame-api.md               the authoring contract (v1.1)
    ├── mcp-setup.md               agent setup + full tool reference
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

102 tests across 8 suites: core units, pipeline integration (real FFmpeg,
probe-verified outputs for every format incl. transparent WebM alpha and the
parallel GIF/PNG-sequence merge paths), CLI, MCP (official SDK client over
stdio), frame-api runtime (vm-hosted), v0.5 features, Studio HTTP server
(ephemeral port, sandbox 403s, SSE hot reload), and a gated real-Chromium
suite (capture determinism, genuine `omitBackground` alpha) that runs
wherever a browser is resolvable:

```bash
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm test
```

The shipped example outputs under `examples/*/out/` were rendered with real
headless Chromium + FFmpeg through the parallel path.

## License

MIT (see engine/package.json).
