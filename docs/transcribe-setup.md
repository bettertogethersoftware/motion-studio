# Motion Studio — Transcription Setup (`transcribe_asset`)

Motion Studio can **write** speech and knows exactly where every word lands.
Since **v0.22** it can also **read** speech out of a recording a user supplies —
audio or video — and report the words *with timing*.

| vendor | what it is | needs | platform |
|---|---|---|---|
| `whisper-cpp` *(default, only)* | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running OpenAI's Whisper models locally | `MOTION_STUDIO_WHISPER_BIN` + one `ggml-*.bin` model | any |

**No account, no API key, no network.** The vendor is the same shape as the
[Piper speech vendor](tts-setup.md): one self-contained binary
plus one model file, found through `MOTION_STUDIO_*`, degrading to
`transcription_unavailable` when absent. Nothing here should ever teach an agent
to ask a user for a secret.

## Why it exists

`synthesize_speech` returns `timings` — each sentence's start and duration in
seconds *and frames* — and that single field is why generated narration is easy
to build against: captions, cue frames and visual beats all land on the word
because the engine reported where the word is.

For a user's own recording there was no equivalent, and the cost showed up as
guesswork. A session that built a promo around a 12.4 s clip of someone talking
had to *ask the user what they were saying*, and its four cut-in points (2.0 s,
5.0 s, 0.6 s, 4.6 s) encoded exactly one fact: the clip is 12.4 s long and the
scene must not run past its end. Not "cut in on the gesture". Just arithmetic.

With a transcript, the same primitives produce a different kind of film: choose
the *argument* (which spans of a talk are kept), splice on sentence boundaries so
the joins are inaudible, cue an on-screen label to the word being spoken, and
verify the finished cut by re-transcribing it.

## Install

Three steps, and the third is usually free.

**1. Get whisper.cpp.** Download a prebuilt release (Windows x64 builds ship a
`whisper-cli.exe` with its `ggml-*.dll` beside it) or build it:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cmake -B build -S whisper.cpp && cmake --build build --config Release
```

**2. Get a model.** One `.bin` from
[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp),
e.g. `ggml-small.en.bin`. Put it in a `models` folder **beside the binary** and
you are done — that is the layout every prebuilt release already has, and the
engine finds it without being told.

**3. Point one env var at the binary:**

```
setx MOTION_STUDIO_WHISPER_BIN "C:\tools\whisper\Release\whisper-cli.exe"
```

Then restart the Studio (and your MCP client): a new environment value only
reaches an already-running process on restart.

### The full set of hooks

| variable | what it sets | default |
|---|---|---|
| `MOTION_STUDIO_WHISPER_BIN` | the `whisper-cli` executable | `whisper-cli` on PATH |
| `MOTION_STUDIO_WHISPER_MODEL` | a `ggml-*.bin` path, **or** a bare name (`small.en`) | the preference order below |
| `MOTION_STUDIO_WHISPER_MODELS` | a folder holding several `ggml-*.bin` | `models` beside the binary, else `engine/vendor/whisper/models` |
| `MOTION_STUDIO_WHISPER_THREADS` | `-t` | whisper.cpp's own default (4) |
| `MOTION_STUDIO_TRANSCRIPTION_VENDOR` | which vendor transcribes | `whisper-cpp` |

Everything except the vendor choice also lives in `settings.json` under
`transcription.whisper` (`exe`, `model`, `modelsDir`, `threads`, `language`), and
the env var wins — the usual precedence:

```
explicit argument (transcribe_asset { model, language })
  > MOTION_STUDIO_WHISPER_*
  > settings.json transcription.whisper.*
```

There are no credentials to store, so unlike the cloud speech vendors nothing is
withheld from `settings.json`.

## Models: size, speed, and which one you get

| model | file | English-only twin | notes |
|---|---|---|---|
| `tiny` | ~75 MB | `tiny.en` | fast and wrong often enough to matter |
| `base` | ~142 MB | `base.en` | usable for rough "what is in this file" |
| `small` | ~466 MB | `small.en` | **the recommended default** |
| `medium` | ~1.5 GB | `medium.en` | noticeably better on names and jargon |
| `large-v3` | ~3.1 GB | — | best; multilingual only |

**Measured** on this repo's reference machine — `ggml-small.en`, 8 CPU threads,
no GPU:

| audio | wall clock | ratio |
|---|---|---|
| 72.8 s of narration | 9.5 s | **7.7× realtime** |
| 94.1 s of talk | 14.4 s | **6.5× realtime** |

That is the number that matters, because it decides whether transcription is
something you do *casually*. At ~7× realtime you can read a clip on ingest **and**
re-read the finished render to check it — which is the difference between a
transcript being documentation and being a verification step.

An `.en` model beats the multilingual model of the same size on English, and
costs the same. Use one unless the recording is not in English. When a call
names a non-English `language`, Motion Studio refuses an `.en` model instead of
returning a plausible but wrong transcript; install and select its multilingual
twin (for example, `small` rather than `small.en`). Auto-detect remains allowed.

**Which model runs when nobody names one:** the first of
`small.en, small, base.en, base, medium.en, medium, large-v3-turbo, large-v3,
large-v2, large, tiny.en, tiny` that is installed — ordered by the speed/accuracy
balance above, not by size, so a machine holding both `tiny` and `large-v3` gets
neither extreme by accident. Every response reports the model that actually ran,
and `transcribe_asset { model: "large-v3" }` overrides per call. An unknown model
name is an error listing what *is* installed — never a silent substitution.

## Using it

```js
transcribe_asset({ path: 'takes/interview.mp4', fps: 30 })   // a library file
transcribe_asset({ target: 'my-film/intro', path: 'assets/vo.wav', fps: 30 })
transcribe_asset({ target: 'my-film', path: 'out/film.mp4', fps: 30 })  // the finished cut
```

Addressed exactly like [`probe_asset`](mcp-setup.md#tools), because the two answer
the two questions you have about a file you did not make: *what is it* and *what
does it say*.

The third line is the **verification** case, and the reason `out/` is readable at
all: re-transcribing the built film is how you check that the words that came out
are the words that went in, and on which frames. Reading is all it grants —
writes, deletes and renames are still confined to `assets/`, so a deliverable
cannot be overwritten through the tool surface.

Video is accepted directly. whisper.cpp requires 16 kHz mono PCM, and the engine
produces it internally with the ffmpeg it already requires for every render — the
extracted WAV is a **temp file, not an asset**, because nobody asked for it and
16 kHz mono debris in `assets/` invites someone to put it on a timeline.

### What comes back

```jsonc
{
  "text": "Introducing the future of personal health monitoring. …",
  "language": "en", "model": "small.en", "vendor": "whisper-cpp",
  "durationSeconds": 72.77, "durationInFrames": 2184, "fps": 30,

  // RE-SEGMENTED to sentences, mirroring synthesize_speech's `timings`
  // field-for-field so recorded and generated narration are one code path:
  "sentences": [
    { "text": "Introducing the future of personal health monitoring.",
      "startSeconds": 0.11, "startInFrames": 3,
      "durationSeconds": 3.89, "durationInFrames": 117,
      "endSeconds": 4.0, "endInFrames": 120,
      "minTokenP": 0.49, "meanTokenP": 0.80, "words": 7 }
  ],

  // the reason -ojf exists: cue a graphic to a word INSIDE a sentence
  "words": [
    { "text": "salvation", "startSeconds": 8.86, "startInFrames": 266,
      "endSeconds": 9.76, "endInFrames": 293, "p": 0.994888 }
  ],

  "speechRanges": [{ "startInFrames": 3, "endInFrames": 338 }, …],
  "leadingSilenceFrames": 3, "trailingSilenceFrames": 23,

  "cached": false, "elapsedMs": 9833,
  "rawSegments": [ … ]   // the vendor's own decode windows — debugging only
}
```

Five things about that shape are deliberate.

**1. Timings are in frames, and they are the product.** Everything that places
anything in this engine speaks frames; a tool that returns seconds forces a hand
division at exactly the spot where an off-by-one hides. `sentences[]` carries the
same five fields `timings[]` does, in the same units, so an agent treats
"narration I generated" and "narration the user recorded" identically. Seconds are
reported alongside, never alone.

**2. Sentences are rebuilt, and `rawSegments` are not edit points.** whisper's
`transcription[]` entries are *decode windows* — ~7.5 s chunks bounded by the
model's context — and nothing about them respects grammar. A real one:

```
[00:00:27.120 → 00:00:32.720]  " Why choose our device? Unmatched accuracy at 98 percent."
```

One segment, two sentences, and in the general case a window starts mid-clause.
Splicing audio there produces the audible mid-word cut this tool exists to
prevent, so the engine re-segments from token offsets and hands back sentences
whose spans end where the full stop is. `rawSegments` is kept for when a derived
sentence looks wrong — never as a timeline.

**3. `words[]` is what makes graphics land on speech.** Four on-screen labels cued
to four spoken names, at frames 1451 / 1478 / 1497 / 1520, all inside *one*
sentence: no sentence-level timing could have placed them. Words are on by
default; `wordsMatching: "salvation"` returns just the ones you are looking for,
which is usually all you wanted.

**4. `speechRanges` and `leadingSilenceFrames` answer a different question.** The
text answers "what does it say"; these answer "where can I cut" — trim the head,
cut on a pause instead of mid-word, find the gap for a cutaway. `pauseSeconds`
(default 1) is what counts as a pause: a continuous talk collapses to **one**
range, which is the useful answer.

**5. Confidence is reported, never hidden.** whisper.cpp emits no
`no_speech_prob`, so confidence is *derived*: `minTokenP` / `meanTokenP` per
sentence and `p` per word. `minTokenP` is the least confident token in the
sentence, because a sentence is only as trustworthy as its worst word. Two
measured examples from real runs — `small.en` rendered "cutting-edge OLED" as
**"cutting, HOLED"** and "24/7" as **"20/47"**, both flagged by a low
`minTokenP`. A caption generated blind from either would have been wrong on
screen.

### It is a job, in its own lane

Transcription is what you do *while* deciding what to render, so it must never
wait behind a render. `transcribe_asset` submits into a **second job lane** with
its own concurrency limit, sharing everything an agent already knows:
`get_render_status`, `wait_for_render`, `get_logs`, `cancel_render`. Jobs report
`kind: "transcribe"`, have no frames (watch `phase`: `extracting` →
`transcribing` → `deriving`), and carry the whole transcript in `result` when
done.

The call itself blocks up to `waitMs` (default 45 s, comfortably inside an MCP
client's request timeout) and returns the transcript if it finished. Past that you
get a `jobId` and `stillRunning: true` — poll it. At ~7× realtime, anything under
about five minutes of audio comes back inline.

### The cache

Results are cached per **(file identity, model, language)** in
`<dataDir>/cache/transcripts/`, so asking again is free. That is what
makes the verification loop — render, then re-transcribe the render — cheap
enough to actually do. Editing the file invalidates its entry (size + mtime are
part of the key), `refresh: true` forces a re-run, and the cache stores
**seconds**, so one entry serves a 24 fps film and a 30 fps one.

It is not stored beside the file on purpose: a transcript dropped into the
workspace library would be debris in a folder the human curates, and one dropped
into `assets/` invites someone to put it on a timeline. Deleting the folder costs
nothing but the next call's inference.

### Bounds

| bound | value | why |
|---|---|---|
| audio duration | 60 minutes | at ~7× realtime that is ~9 min of CPU — the most that can plausibly be waited out |
| file size | 2 GB | matches the library upload guard |
| Studio page test | 3 minutes / 256 MB | a page test, not the tool |

Over either bound is `asset_too_large` naming the measurement, rather than a
twenty-minute silent job. Cut the span you care about first.

## In the Studio

`npm run studio` → **✎ transcribe** in the sidebar footer. The page has the same
grammar as the tts and music vendor pages — live status, what is missing, the
model picker, `save` — with one inversion: instead of typing a line and hearing
it, you **hand it a recording and read what came back**.

The read-back is the audition. It shows the re-segmented sentences with the
`start` and `frames` numbers an agent would actually place a caption with, the
`min p` of each (low values in red — those are the captions that would be wrong
on screen), and how many times realtime *this* machine reads speech. Answering
"is this model good enough for my film, and how long will it take here" before a
film is built on it is the whole point.

The choice is global: it lives in `settings.json` and applies to the Studio *and*
to every agent connected over MCP.

## Errors

| code | means | what to do |
|---|---|---|
| `transcription_unavailable` | no binary, or no model | **a setup problem for the user** — install it; do not retry |
| `transcription_input_unsupported` | the file has no readable speech (not media, no audio stream, unsupported codec) | a different file; `probe_asset` reports whether one has audio |
| `transcription_language_unsupported` | an English-only `.en` model was asked to transcribe a named non-English language | install/select a multilingual model of the requested size (for example, `small`, not `small.en`) |
| `transcription_failed` | whisper ran and did not produce a transcript (crash, timeout, a build with no `--output-json-full`) | read the message; it carries the stderr tail |
| `asset_too_large` | over the duration or size bound | cut the span first |
| `invalid_config` | an unknown model name or vendor | the message lists what is installed |

The same three-way split every vendor follows (see
[architecture.md §6](architecture.md#6-error-model)): setup problems, caller
mistakes, and upstream failures are different codes on purpose, because only one
of them is worth retrying and only one of them is the user's to fix.

## What it does not solve

Worth stating so the tool is not oversold.

- **It gives text and timing, not judgement.** It will not say whether a take is
  good, whether the framing works, or whether the delivery lands. Choosing which
  four spans of a 94 s talk make an argument is the agent's work; the transcript
  only made it possible.
- **It does not answer intent.** Knowing the words are about AI coding still does
  not say whether the user wants that audio kept, replaced or muted. That question
  stays with the user; this only removes the *other* question.
- **Accuracy is not free.** Accented speech, proper nouns and technical terms come
  back wrong often enough that a transcript quoted verbatim on screen needs a
  human read. **Timing is far more reliable than spelling** — which is fortunate,
  because timing is the part the engine actually consumes.

## Deliberately out of scope

- **Diarization** (who spoke). Real value for interviews; a separate feature.
- **Translation.** whisper can (`-tr`); this does not. A promo shipping a machine
  translation under the user's name is a bigger claim than a transcript.
- **Cloud ASR vendors.** The point is local and offline. The vendor-chain shape is
  there if a cloud option is ever wanted, but nothing should require a key to read
  the user's own file.
- **`-dtw` token-level alignment.** Whether it measurably improves token
  boundaries here is untested, and an unmeasured default that adds work is not an
  improvement.
- **Choosing the cuts.** The tool reports where the words are. Deciding which ones
  survive is the agent's job, and then the user's.

## Related

- [tts-setup.md](tts-setup.md) — the other direction: generating narration, and
  the `timings` field this one mirrors.
- [mcp-setup.md](mcp-setup.md) — the tool surface.
- [architecture.md §9.2](architecture.md#92-vendors-v017) — how the three
  capabilities share one selection rule.
- [film-setup.md](film-setup.md) — placing what you found on a film timeline.
