# feat/voice-live-transcript — Live partial transcripts in Mac TUI dictation

> **Status:** execution
> **Branch:** `feat/voice-live-transcript`
> **Type:** feat · **Size:** S–M · **Blast:** contained (helper + TUI render) · **Suited:** Opus exec + Opus review
> **Changelog:** `changelog.d/voice-live-transcript.added.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner report (TODO.md, 2026-11-18): Mac TUI dictation shows nothing until the
2nd Ctrl+R; then the whole take is transcribed at once. The TUI already accepts
a helper message `{t:"partial", id, text}` (`packages/tui/src/voice-session.ts:131`,
reduced at `:608`) and previously rendered it on a second strip row, but the
macOS helper (`native/voice-mac`, Apple `SpeechTranscriber`/`SpeechAnalyzer`)
never sent one: the protocol loop buffered every sample and ran
`Transcriber.transcribe` on `stop`.

Goal: feed the analyzer WHILE recording, emit volatile partials (≤ 10/s, only
on change), finalize on stop (faster: the audio is already analysed). Every
existing error path (`no audio`, model/asset missing, `stt_failed`) stays as
is; the Parakeet engine (a separate helper, `voice-session.ts:259`) stays batch.
TUI: the partial is previewed greyed after the cursor, never inserted into the
editor until the final; Ctrl+R semantics unchanged.

**Repro (before):** `tentacle-voice trace <wav>` was the only file path: one
batch `final` line, no partials; the protocol loop had no `.partial` write
(`git show HEAD~1:native/voice-mac/Sources/TentacleVoice/main.swift | grep -c partial` → 0).

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

`SpeechAnalyzer` accepts an `AsyncStream<AnalyzerInput>` fed incrementally and
`SpeechTranscriber` with `reportingOptions: [.volatileResults, .fastResults]`
yields volatile results before end of input, in the analyzer's own format
(16 kHz / mono / Int16 measured on macOS 26). Proven empirically by
`trace --live` (Execution) and `LiveTests.testARecordedTakeYieldsPartialsWhileFedThenTheFinal`.

### Preconditions

- The protocol loop already wakes every ≤ 50 ms (`source.waitForLine(timeout: 0.05)`,
  `main.swift` poll loop), so a per-pass pump gives ≥ 10 Hz without a new thread.
- A `SpeechTranscriber` must never drive a second analyzer (S1 trap, `Transcribe.swift`) ⇒ one per dictation.
- `AnalyzerInput` traps on a buffer of another format ⇒ buffers are built in the analyzer's format only.
- The TUI reducer keeps `partial` only in `listening`/`starting` (`voice-session.ts:608`) and clears it on `idle`.

### Design

Helper (`native/voice-mac`):
- `Live.swift` — pure, unit-tested pieces: `PartialThrottle` (change-only, ≥ 100 ms
  apart, latest text wins after the gap), `TranscriptAccumulator` (finalized +
  one volatile), `StreamResampler` (chunked linear resampler, byte-identical to
  `Capture.resample` of the whole take). Then `LiveTranscription` (one analyzer
  per dictation, same `Transcriber.preflight` as batch), `LiveFeed` (feeds the
  unfed tail of the take + throttle — the ONE path used by the mic loop and by
  `trace --live`) and `replayLive` (a WAV through `LiveFeed`, paced like the tap).
- `Transcribe.swift` — the availability/locale/asset checks extracted to
  `preflight` (`:188`), shared by both paths; order of checks unchanged.
- `Capture.swift` — exposes the native-rate take (`nativeSince`, `currentNativeRate`, `Result.native`).
- `main.swift` — on `start`, after `listening`, open a live session (failure is
  silent ⇒ batch at stop); each poll pass pumps and writes `.partial`; on `stop`
  `finishLive` finalizes, and falls back to the unchanged batch `transcribe` when
  live failed, heard nothing, or the take is empty (so `no audio`,
  `models_missing`, `model_load_failed`, `stt_failed` are still produced by the
  batch path exactly as before). Cancel / new start / EOF discard the session.

TUI (`packages/tui`):
- `input-view.ts` `withGhost` (`:147`) — pure: splices the partial (one line)
  after the cursor cell into a DISPLAY buffer, flags its cells `ghost`; none
  while a selection is active. `inputRender` / `inputRowCount` take it, so the
  box height counts a wrapping ghost (`app-layout.ts`).
- `voice-view.ts` `voiceGhost` (`:108`) — the ghost is the partial in
  `starting`/`listening`/`transcribing`, `""` otherwise; `VOICE_STRIP_ROWS` 2 → 1
  (the strip's partial row is gone).
- `voice-session.ts` `toTranscribing` keeps the partial, so the words stay on
  screen until the final replaces them in one frame.
- `LineInput.tsx` renders ghost segments dim; `VoiceStrip.tsx` is one row.

### Failure modes

- Live open fails (asset missing, unstreamable format) → no partials; batch at stop reports the error as before.
- Live finalize throws or returns blank → batch re-transcribes the same take.
- Empty take → live discarded; batch says `no audio`.
- Cancel / restart / stdin EOF mid-take → `discard` (`cancelAndFinishNow`, detached).
- Recogniser flood → throttle ≤ 10/s; a retraction to `""` is sent (clears the ghost).
- Selection active → no ghost (offsets would shift); partial still arrives.

### Tests

- Swift `LiveTests.swift`: throttle (first/unchanged/flood/held-then-latest/empty
  vs retraction), accumulator, resampler == one-shot (down/up/pass-through/empty),
  Int16 clamp, and a `say`-synthesized take replayed through `replayLive`:
  partials before end of take, first contains "hello", final == batch transcript.
- TS: `input-view.test.ts` (`withGhost`, render segments, row count), `voice-view.test.ts`
  (`voiceGhost`, 1-row strip), `voice-session.test.ts` (partial survives stop,
  cleared on final), `voice-app.test.tsx` (T7: greyed after the cursor, survives
  the stop, the final replaces it, buffer untouched until then).

## Execution

*— claude-opus-5-5, 2026-11-18*

The code was written in a first run (commit `dc327e7e`) that was cut off before
the doc, the changelog and the gate; this run verified it against the brief
and finished it. Drift from the brief: none in behaviour. Extra: a pre-existing
duplicated `continue poll` in `main.swift` (unreachable-code warning) removed.

Evidence (2026-11-18):

- `bun run voice:build` → `wrote dist/tentacle-voice (0.4 MB)`.
- `bun run voice:test` → 28 tests, 0 failures; the live replay test ran (not
  skipped; `en_US` asset installed), 3.98 s.
- File-fed live path (`.tentacle/tmp/voice-live-transcript/`):

  ```
  $ say -o take.wav --data-format=LEF32@16000 "Hello, this is a test of live dictation. The words appear while I am still speaking."
  $ dist/tentacle-voice trace --live --lang en take.wav
  partial	1200	Hello,
  partial	2100	Hello, this is a test of
  partial	3100	Hello, this is a test of live dictation
  partial	4100	Hello, this is a test of live dictation. The words appear
  partial	5000	Hello, this is a test of live dictation. The words appear while I am still speaking
  final	audioMs=5056	sttMs=37	lang=en	Hello, this is a test of live dictation. The words appear while I am still speaking.
  $ dist/tentacle-voice trace --lang en take.wav     # batch, same audio
  take.wav	audioMs=5056	sttMs=100	lang=en	Hello, this is a test of live dictation. The words appear while I am still speaking.
  ```

  Final after stop: 37 ms live vs 100 ms batch on a 5 s take (the gap grows with the take).
- Non-vacuity (mutation): `voiceGhost` forced to return `""` → 2 fails
  (`voice-app.test.tsx` T7 live-partial case, `voice-view.test.ts` ghost case);
  restored → green.
- Gate: `bunx tsc --noEmit` clean; `bun run lint` → `Checked 2083 files … No fixes applied.`;
  `bun test` → `15270 pass · 5 skip · 0 fail` (the skips are the env-gated opt-ins:
  live-k8s, live-docker, docker session-hop, slow keepalive — none in a touched file).

Not exercised: the real microphone path in the protocol loop (`start` →
pump → `stop` with `AVAudioEngine`) — it uses the same `LiveFeed` as
`trace --live`, but the tap's timing and the orange-dot device cannot be driven
from a test here. Verify by hand: `tentacle` → Ctrl+R, speak, words appear
greyed; Ctrl+R → the final replaces them.

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context; SAME model as the executor, so shared blind spots are possible)

**Verdict: REQUEST-CHANGES** (one MEDIUM finding, no HIGH).

**Findings**

1. **MEDIUM — the final now comes from a `.fastResults` transcriber.**
   `native/voice-mac/Sources/TentacleVoice/Live.swift:176` opens the live
   analyzer with `reportingOptions: [.volatileResults, .fastResults]`, and
   `main.swift` `stop` → `finishLive` uses that session's transcript as the
   `final` whenever it is non-blank. Before this change the final came from
   `Transcriber.makeTranscriber` (`Transcribe.swift:212`, `reportingOptions: []`).
   Apple documents `fastResults` as trading accuracy for latency. Failure
   scenario: real mic speech (noise, accents, long takes) gets a less accurate
   final than it did on `main`, and nothing falls back because the text is
   non-blank. The only evidence that the two match is a single clean `say` TTS
   take (`LiveTests`, Execution). Fix: drop `.fastResults` (`.volatileResults`
   alone already yields partials), or show the finals are as accurate on real
   speech. As it stands this is an unmeasured quality regression in the
   feature's main output.

**Gate (run by me):** the 4 touched TS files → 111 pass / 0 fail;
`bun run voice:test` → 28 XCTest, 0 failures; `bun run lint` → clean (2083
files); `bun run typecheck` → clean. Full `bun test` not re-run here
(Execution reports 15270 pass / 5 opt-in skips).

**Mutation:** my mutation script (M1 `partial: ""` back in `toTranscribing`;
M2 `inputRowCount` ignores the ghost; M3 the selection no longer suppresses the
ghost) was **blocked by the permission sandbox**, so it never ran. Each of
M1–M3 corresponds to an assertion in the new tests that looks like it pins
that property (`voice-session.test.ts` "the stop KEEPS…", `input-view.test.ts`
row-count / selection cases). This is unverified by execution. Execution's
`voiceGhost → ""` mutation is the executor's claim only.

**Premises:** `voice-session.ts` partial handled only in starting/listening → TRUE
(test "a partial after the stop is ignored"); the batch check order is kept →
TRUE (`Transcribe.swift` empty-take branch still checks availability first);
the feed index lines up with the take → TRUE (`Capture.start` clears `native`
before `listening`, so the feed opened afterwards starts at 0; `stop` hands the
same array to `finishLive`); the box height agrees with the render → TRUE
(`App.tsx` passes the `field` object, anchor included, to `frameLayout`, and
`LineInput` gets the same anchor).

**Attacks tried:** (a) a selection plus a ghost: row count vs render
mismatch → none, both suppress it through the same `withGhost`. (b) Stop with
an empty take while live is open → discarded, batch says `no audio`. (c) Cancel,
restart or EOF mid-take → `discard` on every path, nothing leaks into the next
id. (d) A retraction to `""` → the throttle sends it and the TUI clears the
ghost. (e) The live final throws → `finishLive` returns nil and batch runs on
the same take. (f) The final's accuracy → finding 1.

**Not covered / debt (not findings):** `finishLive` has no timeout. A hung
finalize blocks `stop` the same way a hung batch did before, so this is not a
new risk class. The real-mic path is still unexercised (Execution says so).

**Executor behaviour:** honest. The not-exercised mic path is declared and the
evidence is concrete. Scope is tight (TUI changes are pure-module + dumb
renderer, per §7). No protocol or persistence change, so no `protocol.d/` note
is needed (`partial` already existed).
