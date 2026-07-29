# Five MCP surface defects found building a real film

> **Status: COMPLETE.** All five defects are fixed and covered by core/MCP integration tests.
> `bp814-promo` — a 3:00 Env B film, 16 rendered scenes interleaved with 7
> conformed footage segments, 18 master audio tracks — against the engine at
> v0.22 (unreleased). Each one is reproduced, traced to a line, and has a fix
> proposed. None of them is speculative: the symptom column is what the tool
> actually returned.
>
> They are unrelated to each other except in how they were found, which is the
> point — a single real film of ordinary size walked into all five.

## The five

| # | Defect | Severity | Cost | Why it matters |
|---|---|---|---|---|
| 1 | [`.nullable()` erases the parameter type](#1-nullable-erases-the-parameter-type) | **P1** | trivial | `audioTargetPeakDb` is unreachable — the documented mastering path cannot be called at all |
| 2 | [`englishOnly` is measured but never enforced](#2-englishonly-is-measured-but-never-enforced) | **P1** | small | returns a confident wrong transcript — the exact failure this tool exists to prevent |
| 3 | [`assetPath` sub-directories are never created](#3-assetpath-sub-directories-are-never-created) | **FIXED** | trivial | nested asset directories are created before all three generators run |
| 4 | [One lost job id blinds the whole batch](#4-one-lost-job-id-blinds-the-whole-batch) | **FIXED** | trivial | expired ids return terminal `not_found` snapshots without hiding surviving jobs |
| 5 | [`preview_audio` is synchronous and can outlive the client](#5-preview_audio-is-synchronous-and-can-outlive-the-client) | **FIXED** | medium | mixdown runs as a cancellable task and returns its report through `wait_for_render` |

Defects 1 and 2 are P1 for different reasons. 1 makes a documented feature
impossible to invoke. 2 lets a tool return a plausible answer that is wrong —
worse than an error, and the failure mode `transcribe_asset`'s own documentation
warns callers about.

---

## 1. `.nullable()` erases the parameter type — FIXED

**Symptom.** Every call passing a negative `audioTargetPeakDb` is rejected before
reaching the engine:

```
build_film  { film: "bp814-promo", audioTargetPeakDb: -2 }
update_film { film: "bp814-promo", audioTargetPeakDb: -2 }
  → MCP -32602: Invalid arguments
    { code: "invalid_type", expected: "number", received: "string",
      path: ["audioTargetPeakDb"] }
```

In the same session, on the same client, `gainDb: -6` and `gainDb: -22` inside
`update_film`'s `audio[]` were accepted without complaint. So it is not "this
client cannot send negative numbers".

**Evidence.** Exactly three fields on the MCP surface use `.nullable()`:

| field | declaration | emitted JSON Schema |
|---|---|---|
| `update_film.audioTargetPeakDb` | `mcp/server.js:610` | `{}` |
| `build_film.audioTargetPeakDb` | `mcp/server.js:670` | `{}` |
| `update_film.overlays[].widthPct` | `mcp/server.js:553` | `{}` |
| *(every other number, e.g. `gainDb`)* | `z.number()…optional()` | `{"type":"number"}` |

All three are `z.number().min(…).max(…).nullable().optional()`. All three — and
only those three — arrive at the client as an **empty schema**. A client handed
`{}` has no type to coerce to, sends the value as a string, and the zod schema
then correctly rejects a string.

**Root cause.** The zod→JSON-Schema conversion in the MCP SDK does not represent
this nullable union and collapses it to `{}`. The zod schema itself is right; the
contract published to callers is not.

**Fix.** Done: stop expressing "or null" through `.nullable()` on the wire, using
an explicit number-or-null union and asserting the emitted schema in the MCP
integration test. The originally proposed shape was:

```js
// preferred — an explicit union the converter can represent
audioTargetPeakDb: z.union([z.number().min(-60).max(0), z.null()]).optional()

// or, if null must stay expressible without a union
audioTargetPeakDb: z.number().min(-60).max(0).optional()   // omit = unchanged
                                                            // and add an explicit
                                                            // `clearAudioTarget: z.boolean()`
```

Whichever is chosen, **assert the emitted schema in a test** — the defect is
invisible from the zod side and only shows up in what the client is handed:

```js
test('every numeric MCP parameter publishes a type', () => {
  for (const tool of listTools()) {
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(Object.keys(schema).length > 0, `${tool.name}.${name} published {}`);
    }
  }
});
```

That test would also have caught `widthPct`, which nobody has reported yet
because overlays are rarer than mastering.

**Workaround used.** None available — the film was built relying on
`output.audioLimiter` alone. The mix happened to land at −2.7 dB peak, which is
where `audioTargetPeakDb: -2` would have put it, so the deliverable is fine by
luck rather than by control.

---

## 2. `englishOnly` is measured but never enforced — FIXED

**Symptom.** The film's source footage is Japanese speech. Asking for it:

```
transcribe_asset { path: "product/…mp4", language: "ja" }
  → { language: "en", model: "small.en",
      text: "(speaking in foreign language)",
      sentences: [ { text: "(speaking in foreign language)",
                     startInFrames: 0, durationInFrames: 116,
                     minTokenP: 0.045694, meanTokenP: 0.568989 } ],
      speechRanges: [ { startInFrames: 0, endInFrames: 115 } ] }
```

`refresh: true` returns the same. No warning, no error. The requested `language`
is silently replaced by `en` in the response, and the caller is handed a
well-formed transcript object — sentences, frame timings, speech ranges — for a
19-second clip in which the model understood nothing.

**Why this is P1.** `transcribe_asset`'s own description tells callers that
*timing is reliable and spelling is not*, and hands them `minTokenP` to judge
confidence. That contract assumes the model at least attempted the right
language. Here the timings are fabricated too: `speechRanges` claims speech ends
at frame 115 of a clip with speech throughout. An agent following the documented
workflow — "transcribe before choosing durations" — would cut against those
ranges.

**Evidence.** The engine already knows:

- `transcribe-whisper.js:186` and `:213` compute
  `englishOnly: /\.en$/i.test(modelName)` per installed model.
- `list_vendors` reports it: `models: [{ name: "small.en", englishOnly: true }]`.
- `transcribe-whisper.js:438–450` resolves the model and the language
  independently, then spawns `whisper-cli … -l ja` against `ggml-small.en.bin`
  without ever comparing the two.

The data needed to refuse is already in hand at the call site. It is simply not
consulted.

**Fix.** Done in `transcribeWithWhisper`, immediately after resolving the model
and language. It raises `transcription_language_unsupported` with the selected
model, requested language, and installed multilingual alternatives. The original
guard was:

```js
if (resolved.modelEnglishOnly && lang !== 'auto' && lang !== 'en') {
  throw new EngineError(
    ErrorCodes.TRANSCRIPTION_LANGUAGE_UNSUPPORTED,
    `Model "${resolved.model}" is English-only; it cannot transcribe "${lang}". ` +
    `Install a multilingual ggml model (e.g. ggml-small.bin) and name it with { model }.`,
    { model: resolved.model, requestedLanguage: lang,
      models: resolved.available.filter((m) => !m.englishOnly) },
  );
}
```

Refusing is right rather than warning: a warning attached to a plausible-looking
transcript is the same trap one level down.

Worth pairing with a second, cheaper guard that catches the *auto* case too — if
the whole transcript is a single bracketed artefact (`(speaking in foreign
language)`, `[Music]`, `[BLANK_AUDIO]`) spanning one segment, that is not a
transcript. Today `[Music]` is also returned as a `sentence` with word timings;
it appeared as the final "sentence" of the finished film.

---

## 3. `assetPath` sub-directories are never created

**Symptom.**

```
synthesize_speech { target: "bp814-promo", assetPath: "assets/vo/01-open.wav", … }
  → { code: "tts_failed",
      message: "Piper exited with code 1:  File \"…\\wave.py\", line 449, in __init__
                f = builtins.open(f, 'wb')
                FileNotFoundError: [Errno 2] No such file or directory:
                '…\\films\\bp814-promo\\assets\\vo\\01-open.wav'" }
```

A Python traceback is the user-facing error. Nothing says "that directory does
not exist" or "assetPath must be flat".

**Evidence.** `mcp/server.js:1915` creates only the top-level directory:

```js
const assetsDir = path.join(t.path, 'assets');
await fsp.mkdir(assetsDir, { recursive: true });      // ← assets/ only
const relPath = assetPath ?? (await nextAssetWav(assetsDir, 'narration'));
```

`resolveInTarget(…, { forWrite: true })` validates the path but does not create
its parent, and the absolute path is then handed straight to the vendor. The same
shape is at `:2305` (`synthesize_music`) and `:2432` (`synthesize_sfx`);
measured only on speech + piper, but nothing in those two paths differs.

**Fix.** One line, at all three call sites:

```js
const abs = resolveInTarget(t.path, normalized, { forWrite: true, asAsset: true });
await fsp.mkdir(path.dirname(abs), { recursive: true });
```

`use_shared_asset` already writes into `assets/library/…`, so nested asset paths
are clearly intended to be legal — this is just the generators not honouring
them.

---

## 4. One lost job id blinds the whole batch

**Symptom.** Six scene renders were queued. The MCP server restarted. Then:

```
wait_for_render { jobIds: [ six ids ] }
  → { code: "job_not_found",
      message: "No render job with id \"32b9a7ae-…\"",
      detail: { jobId: "32b9a7ae-…" } }
```

The call fails outright, so the states of the other five are unobtainable from
it. Recovering meant falling back to `build_film { plan: true }` and reading
`problems[]` to discover that three scenes had been dropped and three had
survived.

**Evidence.** `core/jobs.js:383`:

```js
async waitFor(jobIds, { timeoutMs = 300_000, pollMs = 250 } = {}) {
  for (const id of jobIds) this._get(id);   // ← throws on the first unknown id
```

An up-front existence sweep, before any status is collected.

**Why it matters more than it looks.** Job ids living only in server memory is a
documented, defensible design — the skill even tells agents to verify by output
file. But that guidance assumes the *survivors* are still observable. A batch
wait is precisely the call an agent makes after a restart it did not notice, and
it is the call that hides the answer.

**Fix.** Report per-job rather than aborting, so a partially-lost batch stays
diagnosable in one round trip:

```js
const statuses = jobIds.map((id) => {
  try { return this.getStatus(id); }
  catch { return { jobId: id, state: 'not_found' }; }
});
```

Treat `not_found` as terminal for the "are we done" test, and document it as a
possible `state`. Keep `job_not_found` as a hard error for the single-id
`get_render_status`, where there is nothing else to report.

---

## 5. `preview_audio` is synchronous and can outlive the client

**Symptom.** On the finished 180 s film with 18 master tracks:

```
preview_audio { target: "bp814-promo" }
  → MCP -32001: Request timed out
preview_audio { target: "bp814-promo" }      # immediate retry
  → { durationSeconds: 180, mix: { peakDb: -2.62, … } }   # ~35 s
```

**Evidence.** `mcp/server.js:1257` — the handler mixes and measures inline and
returns the result; there is no job. Meanwhile `wait_for_render` caps `timeoutMs`
at 50 000 ms *specifically* to stay under the client's ~60 s ceiling
(`mcp/server.js:1152`, and the reasoning is in its own description). The engine
therefore already knows the ceiling exists — `preview_audio` is just not subject
to it.

**Why it matters.** SKILL.md tells agents to run `preview_audio` on **every**
render that carries audio, and it is the only way to see `balanceWarnings`,
`clipMeanDb` and `silentTailSeconds`. The longer the film, the more valuable the
check and the more likely it times out. A retry happening to work is not a fix —
it worked here because the mix was warm.

**Fix.** Give it the same shape as the other long operations: submit to the task
lane, return `{ jobId, state }`, and let `wait_for_render` carry it — exactly
what `transcribe_asset` already does when it exceeds `waitMs`:

```js
// mirror transcribe_asset: answer inline when it is quick, hand back a job when not
if (elapsed > waitMs) return ok({ stillRunning: true, jobId, hint: 'Poll with wait_for_render …' });
```

That also removes the need for callers to guess whether their film is "short
enough".

---

## What these have in common

Nothing, technically. But four of the five are **cases where the engine already
holds the information needed to behave correctly and does not consult it**:

- `englishOnly` is computed, reported, and ignored (#2).
- The 50 s client ceiling is known and enforced in one tool, not the other (#5).
- `jobs.getStatus` can describe every surviving job; the guard runs first (#4).
- The zod schema is correct; only its published form is wrong (#1).

The exception is #3, which is a missing `mkdir`.

That pattern suggests the cheapest guard against the next one of these is a test
that asserts the **published** contract rather than the internal one — the schema
test in #1 is the first instance, and an equivalent for "does every long-running
tool have a job path" would have caught #5.

## How they were found

One film, built end to end in Env B: `list_shared_assets` → `probe_asset` →
`transcribe_asset` (#2) → cut 7 footage segments to the film signature →
16 scenes → `synthesize_speech` ×18 (#3) → `synthesize_music` ×2 →
`preview_audio` (#5) → `render` ×16 across a server restart (#4) →
`build_film` (#1).

No defect required an unusual call. Every one sits on the shortest path through
the documented Env B workflow.
