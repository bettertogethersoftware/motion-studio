# Motion Studio desktop viewer host

The ComfyUI-style desktop shell (vendor-boundary plan §10.2, Slice C): an
Electron window that **launches the local Studio server and views it** — it
reimplements nothing. The AI connects over MCP exactly as it would without
the shell; the human adviser gets the Studio pages (progress, films, advice)
in an app window instead of a browser tab.

## What it actually does

1. Resolves a **real Node runtime** (`MOTION_STUDIO_NODE`, else `node` on
   PATH) — never Electron's own process, because the Studio spawns render
   workers from its `process.execPath` and those must be Node.
2. Probes a free port and spawns `engine/src/studio/server.js` with it.
3. Waits for HTTP readiness (30 s), then opens the Studio UI in the window.
4. Logs the child's output to `studio.log` under Electron's user-data dir;
   diagnostics never touch protocol streams.
5. On close, kills the child **as a tree** (`taskkill /T` on Windows, a
   process-group signal elsewhere) so no Chromium/FFmpeg/render-worker
   descendant survives.

All Motion Studio environment hooks (`MOTION_STUDIO_HOME`,
`MOTION_STUDIO_VENDOR_DIR`, `PEXELS_API_KEY`, …) pass through to the child
unchanged.

## Run

```powershell
cd desktop
npm install
# If your npm blocks install scripts, fetch the Electron binary explicitly:
node node_modules/electron/install.js
npm start
```

## Smoke

`npm run smoke` launches the shell with `MOTION_STUDIO_DESKTOP_SMOKE=1`
(hidden window), requires a JSON proof that the served Studio page really
loaded, then verifies the child tree is gone (the port must stop answering).
Needs a display (or xvfb); it is not part of the headless CI suite.

## Boundaries

- `desktop/` is **private**: not in the npm install artifact (the root
  package.json `files` whitelist), Electron is a devDependency here only.
- Packaging/installer (electron-builder, bundled Node) is Slice C-2 — this
  increment is the unpackaged host for a repo checkout.
