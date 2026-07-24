# Motion Studio — MCP Setup and Tool Reference

Motion Studio's agent interface is a local MCP server speaking stdio: `engine/src/mcp/server.js`. It exposes a fixed set of tools for project management, composition authoring, asset ingestion, previewing, and rendering — the same render engine and the same on-disk projects the Studio web UI uses. It has no network listener and no shell or arbitrary-file tools; every file operation is sandboxed to the target project's folder.

## Connecting a client

For Claude Desktop, add to your config file (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS; create it if needed) and restart Claude Desktop:

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

For Claude Code: `claude mcp add motionStudio -- node /absolute/path/to/engine/src/mcp/server.js`. Any MCP-capable client works the same way — point it at `node <path>/server.js` over stdio.

Requirements are the same as the Studio's: Node ≥ 18 and FFmpeg ≥ 5 on PATH, and `npm install` completed in the engine folder (`npm run doctor` verifies). If prerequisites are missing, every tool responds with a structured `prereqs_missing` error naming what's absent.

Two optional environment variables can be set in the server config's `env` block: `MOTION_STUDIO_HOME` relocates the data directory (registry + default project location; default `~/.motion-studio`, and it must match what the Studio uses if you want the two to share projects), and `MOTION_STUDIO_MAX_RENDERS` caps the number of renders a single server session will start (unset = unlimited) as a safety valve for unattended agent loops.

## Resources

| URI | Content |
|---|---|
| `motion-studio://reference/frame-api` | The Frame API authoring contract (markdown). Agents should read this before writing composition code. |
| `motion-studio://project/{id}/manifest` | A project's config plus file listing. |

## Tools

All tools return JSON text content; failures set `isError` with a body of `{ code, message, detail? }` using the stable codes listed in [architecture.md](architecture.md) §4. Paths passed to file tools are always **project-relative**; absolute paths and `..` escapes are rejected with `path_outside_project`.

### Projects

| tool | arguments | returns / notes |
|---|---|---|
| `list_projects` | — | `{ projects: [{ id, name, path, createdAt }] }` from the shared registry (same list the Studio shows). |
| `create_project` | `name` (req), `fps` = 30, `width` = 1920, `height` = 1080, `durationInFrames` = 150 | Scaffolds a working template project, registers it, returns `{ id, name, path, config, files }`. Width/height must be even. Errors: `project_already_exists`, `invalid_config`. |
| `get_project` | `projectId` | Config + recursive file listing (sizes, mtimes). Error: `project_not_found`. |
| `update_project_config` | `projectId`, plus any of `name`, `fps`, `width`, `height`, `durationInFrames`, `entry`, `output` (object), `audio` (array) | Validated config update — the only way to change `project.json`. `output.format` ∈ `mp4 webm gif prores png-sequence`; `output.transparent` keeps alpha (webm/prores/png-sequence only); the output filename's extension follows the format automatically. Returns the full updated config. Error: `invalid_config` with the failing field. |
| `remove_project` **(v0.5)** | `projectId`, `deleteFiles?` = false | Unregisters the project. Files are deleted only when `deleteFiles` is true **and** the folder lives under the managed projects root; user-chosen locations are never deleted. Irreversible — confirm with the user first. |

### Composition files

| tool | arguments | returns / notes |
|---|---|---|
| `read_composition_file` | `projectId`, `path` | `{ path, content, size }`. Errors: `file_not_found`, `path_outside_project`. |
| `write_composition_file` | `projectId`, `path`, `content` | Atomic write (temp + rename). `.js`/`.mjs` content is syntax-checked first and rejected with `syntax_error` (line/column in `detail`) **before touching disk** — the previous file version survives a rejected write. Allowed extensions: `.html .css .js .mjs .json .svg .txt .md`; `project.json` is deny-listed (use `update_project_config`). |
| `write_asset_file` **(v0.5)** | `projectId`, `path` (under `assets/`), `contentBase64` | Writes a binary asset (image/audio/font) from base64. Confined to `assets/`; extension allow-list (`png jpg jpeg gif webp svg mp3 wav ogg m4a flac woff woff2 ttf otf json txt`); 25 MB decoded cap → `asset_too_large`. Reference from the composition as `assets/<name>`. |

### Preview

| tool | arguments | returns / notes |
|---|---|---|
| `capture_preview_frame` | `projectId`, `frame` = 0 | Renders exactly one frame through the real render path (Puppeteer Chromium — identical pixels to the final render) and returns it as an MCP **image** content block (PNG). Errors: `invalid_config` (frame out of range), `composition_error`, `frame_timeout`, `browser_launch_failed`. |
| `render_still` **(v0.5)** | `projectId`, `frame`, `outputFilename?` = `still-<frame>.png` | Same single-frame render, but written to a `.png` inside the project's `out/` dir — for poster frames and thumbnails. Returns `{ outputPath, bytes, frame }`. |

### Rendering

| tool | arguments | returns / notes |
|---|---|---|
| `render` | `projectId`, `frameRange?` = `[start, end]` inclusive, `workers?` = 1, `outputFilename?` | Starts an async job for the configured output format; returns `{ jobId, state, queuePosition?, outputPath, totalFrames }` immediately. One render runs at a time; further submissions **queue FIFO (v0.5)** and start automatically. A full queue (10) fails with `queue_full`. `workers` > 1 splits capture across parallel Chromium processes. |
| `get_render_status` | `jobId` | `{ state: queued\|running\|done\|error\|cancelled, framesDone, totalFrames, percent, renderFps, etaMs, queuePosition?, outputPath?, error? }`. Poll until terminal. Error: `job_not_found`. |
| `cancel_render` | `jobId` | Aborts a running job and kills every child process (Chromium workers, FFmpeg); dequeues a queued job without starting it. Idempotent on finished jobs. |
| `list_render_jobs` | — | All jobs this session, newest first, with status snapshots. |
| `get_logs` | `jobId`, `tail?` = 200 | The job's log lines (engine phases, warnings, FFmpeg stderr on failure) — read this before diagnosing a failed render. |

## Typical agent session

```
list_projects                                   → empty
create_project { name: "Product Intro", durationInFrames: 300 }
(read resource motion-studio://reference/frame-api)
write_composition_file { path: "composition.js", content: … }   → syntax_error → fix → ok
capture_preview_frame { frame: 0 }              → inspect image
capture_preview_frame { frame: 150 }            → inspect image
render { frameRange: [0, 59] }                  → confirm pacing on 2s
get_render_status …                             → done
render { workers: 4 }                           → full render
get_render_status … (poll)                      → etaMs while running → done, outputPath
render_still { frame: 150 }                     → poster frame for the thumbnail
```

To deliver a transparent overlay instead of an mp4:
`update_project_config { output: { format: "webm", transparent: true } }`,
give the composition a transparent background, and render — the output drops
onto any timeline as an alpha overlay.

The updated agent skill in [SKILL.md](SKILL.md) encodes this workflow, the authoring contract, and error handling for direct use as a Claude skill (pair it with `frame-api.md` as `references/frame-api.md`).
