# Motion Studio

## Git workflow

Always work directly on `master`. Do not create feature branches.

- Commit straight to `master` — no `git checkout -b`, no PRs for routine work.
- This overrides the usual "branch first when on the default branch" default.
- Still only commit or push when explicitly asked.

## Documentation

Always update the docs as part of the change — never leave them for a follow-up.

- Keep `README.md`, `docs/architecture.md`, and `docs/CHANGELOG.md` in sync with
  behavior changes, new features, and version bumps.
- Touching an area with its own doc (`docs/mcp-setup.md`, `docs/user-guide.md`,
  `docs/frame-api.md`, `docs/tts-setup.md`, `docs/music-setup.md`,
  `docs/sfx-setup.md`, `docs/film-setup.md`, `docs/SKILL.md`, …) means updating
  that doc in the same change.
- New or changed MCP tools, config options, or CLI flags must be documented where
  they are already listed — not only in the code.
