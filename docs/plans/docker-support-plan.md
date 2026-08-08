# Docker support — the containerized third distribution tier

> **Status: PROPOSED** (2026-08-04). Estimate: 1–2 days. Prerequisites are
> already met: Linux is supported (linux-ready plan, L4 passed), the browser
> launcher already carries the two classic container flags, and everything
> heavy is a fetchable pack. **Blocked** on Docker not being installed on the
> dev machine — the slice cannot be honestly verified without it.
>
> **Audience re-checked 2026-08-08.** §1 names the demo/first-impression tier
> first, and §1 also calls this "the cleanest possible version of the no-shell
> demo tier" — which is the tier [TODO.md](TODO.md)'s standing rule says to
> size the effort for. At 1–2 days plus an install this is not in
> cheap-Env-A-win territory *on the demo argument alone*. It stays scheduled
> because the other two run modes pay for it independently and are not Env A
> at all: the **server-hosted Studio** (mode 1) serves the *human* adviser
> across machines, the case `MOTION_STUDIO_STUDIO_HOST` was built for, and the
> **MCP sidecar** (mode 2) is install convenience for any agent, shell or not.
> Schedule it on those; treat demo-in-a-box as the bonus, not the reason.

## 1. Decision

Ship an official Docker image and compose file as the **third distribution
tier**, complementing — not competing with — the decided §10.7 npm-first
story:

| tier | audience | command |
|---|---|---|
| git clone + provision | dev machines, full tools-root deployments | `deploy/PROVISION.md` |
| npm GitHub-URL install | projects embedding the engine | `npm install github:bettertogethersoftware/motion-studio` |
| **Docker image** | **demo/first-impression tier; server-hosted Studio; MCP-in-a-box** | `docker compose up` / `docker run -i` |

This is the cleanest possible version of the no-shell demo tier: one command,
no Node/FFmpeg/browser situation on the host can break it, and it gives
Windows hosts a clean Linux runtime without WSL ceremony. It also matches the
server-hosted scenario (Motion Studio on one box, the Studio viewed from
another) that `MOTION_STUDIO_STUDIO_HOST` (v0.26) was built for.

## 2. Why this is cheap now

- The runtime recipe **is CI's linux-render recipe**: Node 22 + static FFmpeg
  + `npm ci` + chrome-headless-shell renders real video on ubuntu-latest
  every push. The Dockerfile is largely a transcription of that job.
- `core/browser.js` already launches with `--no-sandbox` and
  `--disable-dev-shm-usage` — the two classic Chromium-in-Docker killers.
- The pack mechanism (Slice B) keeps the image lean: SoundFont and whisper
  models are `fetch-pack` downloads into a mounted vendor volume, not image
  layers — rebuilds don't re-fetch, and the image ships no third-party
  license-encumbered assets.
- The generative boundary keeps GPU stacks out: no CUDA, no Python, no
  ComfyUI in the engine image, ever. GPU helpers are agent-side and belong
  to the host (or their own containers, out of scope here).

## 3. Deliverables

```text
docker/Dockerfile          multi-stage, node:22-slim base
docker/compose.yaml        studio service + volumes, MCP usage in comments
docker/README.md           run modes, volume/env matrix, security notes
docs/ (this plan + docker section in README.md, mcp-setup.md)
```

### The image

- Base `node:22-slim`; apt: `ffmpeg` (or the static build if the distro
  version regresses below the ≥5 floor), `fontconfig` + a real font set
  (`fonts-liberation`, `fonts-noto-core`, `fonts-noto-cjk` — text rendering
  is core product; the render sidecar already records the font
  environment), `espeak-ng` (the zero-byte `system` speech backend's Linux
  chain, proven in L4), `ca-certificates`, `tini` (PID 1, zombie reaping —
  Chromium is a serial zombie producer).
- `npm ci` in `engine/` with the committed `.puppeteerrc.cjs`, so only
  chrome-headless-shell downloads (the −420 MB Slice 0 decision applies to
  the image too).
- Non-root user; `MOTION_STUDIO_HOME=/data`, vendor dir `/vendor` —
  both declared volumes.
- **No SoundFont, no whisper model, no piper voice baked in.** The
  entrypoint (or the user) runs `npm run fetch-pack -- soundfont` into the
  `/vendor` volume; `get_capabilities`' tiers/packs blocks report exactly
  what is and is not installed, same as everywhere else.
- Whisper: **not in the base image** (the "point to it, tolerant if
  absent" decision). A later `-full` variant may add a whisper.cpp build
  stage if a customer needs transcription-in-a-box.

### Run modes

1. **Studio server**: `docker compose up` → `MOTION_STUDIO_STUDIO_HOST=0.0.0.0`
   *inside* the container, port published to the host's loopback by default
   (`127.0.0.1:7345:7345`). The compose file's comments carry the same
   warning as mcp-setup: the Studio has no auth; publishing beyond loopback
   belongs behind a trusted network or authenticating proxy.
2. **MCP sidecar**: `docker run -i --rm -v msdata:/data -v msvendor:/vendor
   motion-studio node engine/src/mcp/server.js` — stdio MCP works through
   `docker run -i`, so an MCP client config's `command` is simply `docker`.
   Document the exact client config block in mcp-setup.md.
3. **One-shot CLI**: `docker run --rm … motion-studio-render --scene …` for
   rendering a mounted scene folder.

## 4. Verification (the honest proof)

- Build the image, then run the existing `engine/test/smoke-mcp-film.mjs`
  acceptance against the containerized MCP server over stdio: film + scenes
  + speech (espeak chain) + music (fetched SoundFont) + SFX + real Chromium
  renders + promoted build. That script is already the L4 acceptance; the
  container is just its next machine.
- `docker compose up` → HTTP 200 from the Studio on the published port.
- Image-size budget: fail the build script if the image exceeds ~1.6 GB
  (silent size creep is the known risk).
- CI: one `docker-build` job on ubuntu-latest (build + the stdio smoke;
  runners have Docker preinstalled). Gate behind the same
  skips-are-failures policy as linux-render.

## 5. Risks and controls

| risk | control |
|---|---|
| Chromium sandbox/`/dev/shm` in containers | already handled in browser.js; `tini` reaps zombies |
| Fonts differ from the Windows reference machine | cross-machine pixel identity was never the contract; sidecar records the font environment (§10 fonts decision) |
| Image size creep | packs-as-volumes, headless-shell-only, size budget in the build script |
| Studio exposed unauthenticated | loopback publish by default; the §14/mcp-setup warning repeated in compose comments |
| The library page's `browse` button | already handled, and worth checking stays that way: `core/reveal.js` refuses any request that is not from loopback, and under normal port publishing a containerised Studio sees the bridge gateway instead — so the button degrades to "copy path" in the image without a Docker check existing anywhere |
| distro ffmpeg regresses | doctor's ≥5 floor check runs at build time; fall back to the static build used by CI |

## 6. Non-goals

- GPU/CUDA/ComfyUI in the engine image (generative boundary).
- Replacing the npm-first distribution decision (§10.7) — Docker follows.
- Windows containers, ARM images (revisit with the macOS/ARM64 backlog item).
- An orchestration/helm story — one image, one compose file.
