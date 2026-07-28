# Agent environments — Env A and Env B

> **Audience: whoever maintains or deploys Motion Studio.** This is design
> vocabulary, not agent-facing guidance. **The skills deliberately do not use these
> terms** — an agent does not need a taxonomy, it needs the workflow for the setup
> it is in, and a human decides which skill gets copied where. If "Env A" or
> "Env B" ever appears inside a skill file, delete it.

Motion Studio is driven by an agent, and there are two materially different
environments an agent can be in. Nearly every design question about the tool
surface — and which of the two skills to install — turns on which one applies.

| | Capability | Bottleneck | Therefore needs |
|---|---|---|---|
| **Env A** | Motion Studio MCP tools **only**. No shell. | **Capability** — whole classes of film are impossible | *breadth*: more operations in the tool surface |
| **Env B** | MCP **+** a shell with `ffmpeg` / `ffprobe` / `whisper.cpp` | **Correctness** — everything is possible, subtle things go silently wrong | *knowledge*: engine invariants stated as data |

Env A is the default and the one to assume when nothing says otherwise: an MCP
client with no shell, which is how most agents reach a local server. Env B is
Claude Code and similar harnesses, where the agent can run binaries directly.

## Why the distinction earns a name

The two environments fail in opposite directions, so advice that is right in one
is wrong in the other.

In **Env A**, the tool surface *is* the entire capability. When `probe_asset`
reports that a file's codec cannot be decoded by the render browser, nothing can
act on that: the correct response is to tell the user, and the film either changes
shape or waits. Guidance for Env A must therefore say "hand this command to the
human" — and the SKILL.md for Env A does, in several places.

In **Env B**, that same guidance is actively harmful: it stops work the agent
could have finished, and it asks the user to do something on the agent's behalf.
Env B's problems are the ones nothing reports — an encode that will not
stream-copy, a frame count off by one, an audio splice landing mid-clause.

## The rule that falls out of it

> **Tools that only report lose to the shell. Tools that report what only the
> engine knows do not.**

The evidence: `probe_asset` shipped in v0.21, and in the Env B session that
motivated this document it was used **zero times**. Not because it was bad —
because it reported only what `ffprobe` already reports, and once the *action*
lived in a shell the *inspection* migrated there too. Staying in one language is
cheaper than marshalling between two.

So when designing anything on the MCP surface, ask which kind it is:

- **Capability** (`trim`, `crop`, `scale`, transcode): Env A needs it. Env B will
  keep using ffmpeg, and that is fine — do not fight it.
- **Knowledge** (the film's encode signature — shipped in v0.22 as
  `get_film`'s `plan.signature`, including the `ffmpegArgs` its own encoder uses —
  `sceneDefaults`, a scene's
  `filmOffset` layout, measured audio levels): **both** need it, and Env B needs it
  *more*, because Env B is the one hand-writing commands against invariants it
  cannot see.

## The two skills

The workflow differs enough that there are two skill documents. **A human picks
which one to copy into a given agent's skill directory** — the agent is never asked
to detect its own environment, and neither skill mentions the other's environment.

| Environment | Skill | Shape of the work |
|---|---|---|
| **Env A** | [SKILL.md](SKILL.md) (`motion-studio-video`) | Author animation from HTML/CSS/JS. Footage participates only as a `<video>` inside a composition, and only if already in a browser-decodable codec. |
| **Env B** | [SKILL-shell.md](SKILL-shell.md) (`motion-studio-video-shell`) | The recording is usually the *spine*. Read it, cut it, and author graphics against it. |

**Install one, not both.** They overlap on the authoring contract and would
otherwise compete for the same requests. (If both are installed anyway, the
frontmatter `description` on each is what disambiguates — that is the only place
either skill refers to the other.)

### Rules for editing them

- **Each skill must be self-contained.** An install directory receives only
  `SKILL.md` and `references/frame-api.md`, so a link to any other repo document —
  including this one — is broken the moment it ships. State the fact; do not link
  to where it is explained.
- **Keep the shared parts in sync.** The two overlap on exactly four things; when
  one changes, check the other:
  1. the frame-driven authoring contract and the visibility rule — both defer to
     [frame-api.md](frame-api.md), so change **that** first and let both inherit it;
  2. the film → scene model, `sceneDefaults`, and `sync_shared_files`;
  3. audio measurement discipline (`preview_audio`, measured `gainDb`);
  4. the no-fabricated-claims rule.

  Everything else is disjoint by design. If a fifth item shows up, prefer moving it
  into `frame-api.md` over duplicating it.

## What is planned to narrow the gap

The [plans in `todo_task/`](todo_task/README.md) are scoped against exactly this
distinction — most of them exist to bring Env A closer to what Env B can already
do by hand, with the acceptance test *"Env A can reproduce the prototype film."*

Related: [SKILL.md](SKILL.md), [SKILL-shell.md](SKILL-shell.md),
[frame-api.md](frame-api.md) (the authoring contract, identical in both),
[todo_task/README.md](todo_task/README.md).
