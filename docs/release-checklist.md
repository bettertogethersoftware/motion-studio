# Release checklist

The one list that keeps a Motion Studio release coherent. It exists because
package.json sat at 0.21.0 while the docs described v0.26 — five milestones
of drift, caught only when the GitHub-URL install started reporting a
version nobody recognized. Every item is either mechanically tethered by a
test (noted) or must be walked by hand here.

Run through it top to bottom when cutting a release:

1. **Version, twice.** Bump `engine/package.json` AND the root
   `package.json` to the same value — `engine/test/root-package.test.js`
   fails the suite if they disagree, and `get_capabilities`/the Studio
   report whatever engine/package.json says (there is no hardcoded copy).
2. **Changelog.** Move the `## Unreleased` content under a
   `## vX.Y (date) — headline` header and leave a fresh empty Unreleased.
   Every behavior change in the release must already be there — the
   project rule is docs-in-the-same-commit, so this is a check, not a
   writing session.
3. **Docs sweep for the new version tag.** Feature docs tag additions
   inline (`(v0.26)`); confirm the tags in `README.md`,
   `docs/architecture.md`, and the capability docs match the release being
   cut, and that nothing still says "planned" for something that shipped.
4. **MCP tool descriptions.** New or changed tools, config options, and
   CLI flags are documented where they are listed (`docs/mcp-setup.md`,
   `docs/user-guide.md`) — not only in code.
5. **Skills are copies.** If `docs/SKILL.md`, `docs/SKILL-shell.md`, or
   `docs/frame-api.md` changed, re-copy them to every client skill
   directory on the machines you control, and note the requirement in the
   release notes for machines you do not (the deployed `AGENTS.md` carries
   the instruction).
6. **Deployed entry files.** If `deploy/ENTRY.md` changed, re-run
   `deploy/provision.mjs` on each machine (or note it in the release
   notes) so tools-root `AGENTS.md`/`CLAUDE.md` stop drifting.
7. **Migration notes.** If storage layout, settings shape, or env-var
   semantics changed, the changelog entry must say what happens to
   existing data on first run (the code must already handle it — see
   `core/migrate.js`, `core/paths.js`).
8. **Suite + smokes.** `npm test` green from `engine/` (the suite includes
   the package-drift, import-graph, core-only, and pack-manifest guards);
   CI green on both platforms; `desktop/npm run smoke` if the desktop
   host changed; `npm pack --dry-run` at the root shows no machine state.
9. **Tag after push.** The user pushes; tag `vX.Y.Z` on the pushed commit
   if a tag is wanted — GitHub-URL installs can then pin
   `github:bettertogethersoftware/motion-studio#vX.Y.Z`.
