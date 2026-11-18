# fix/voice-live-volatile — Live dictation shows no partials while speaking

> **Status:** execution
> **Branch:** `fix/voice-live-volatile`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** strong model + standard Review
> **Changelog:** `changelog.d/voice-live-volatile.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

Owner: live dictation (`docs/feat/voice-live-transcript.md`, merged today)
"non sembra funzionare" — the ghost text does not follow the voice. Owner's
config: `voice.language "it"`.

**Repro** (sample: 5.3 s of Italian speech, `.tentacle/tmp/voice-live-volatile/it-sample.wav`, 2026-11-18, `main` build):

```
$ dist/tentacle-voice trace --live --lang it it-sample.wav
final	audioMs=5345	sttMs=180	lang=it	Ciao, questa è una prova della trascrizione in tempo reale. Vediamo se arrivano i parziali.
$ dist/tentacle-voice trace --live --lang auto it-sample.wav
partial	4100	Ch cuesta una provva de la transcriptionion int temporeale video
final	audioMs=5345	sttMs=216	lang=en	Chalo, cuesta una prova de la transcriptione intemporeale, vidiamo se arriva nui partiali.
```

With the owner's language: **zero** partials. The suspected cause
(`Transcribe.makeTranscriber`'s `reportingOptions: []`) is not it — the live
path never used that factory; it already opens its own transcriber with
`[.volatileResults]` (`Live.swift:178` on `main`). Logging every raw result
(a temporary stderr probe in the collector) showed the real behaviour:

```
# [.volatileResults] (main): every volatile result arrives AFTER the last chunk
RAW t=26797 final=false range=0.0+5.345 Ciao
… 22 more volatile results, t=26799…26842 (all within 45 ms) …
RAW t=26918 final=true  range=0.0+5.345 Ciao, questa è … i parziali.
# [.volatileResults, .fastResults]: one batch per ~1 s of audio, while fed
RAW t=28069 final=false range=0.0+1.1 Ciao
RAW t=29002 final=false range=0.0+2.0 Ciao, questa
RAW t=30054 final=false range=0.0+3.0 Ciao, questa è una prova della tra
…
RAW t=32702 final=true  range=0.0+5.345 … arrivano i parziali        ← lost its "."
```

Root cause: without `.fastResults` Apple's recogniser emits no volatile result
until end-of-input on a short take (the feat doc's "≈ 1 per 3–4 s" came from
English takes where segments finalize mid-take; on this one nothing does). But
`.fastResults` cannot simply be turned on: Fix round 1 of the feat proved it
changes the FINAL (the nonce-word test, 5/5), and here it drops the final ".".

**`voice.language auto`** maps to the Mac's locale, not to the speech
(`Transcriber.localeId(for: .auto)`, `Transcribe.swift:70`): this Mac is
`AppleLocale = en_US@rg=itzzzz`, so `auto` ⇒ `en_US` and Italian speech is
transcribed as English (the `lang=en` above). That is by design (S1: the API has
no language identification, documented on `localeId`), not part of this bug; a
user who dictates Italian on an English-locale Mac sets `voice.language it`.
The configured language does reach the live path: `voice.*` →
`{ ...VOICE_DEFAULTS, ...config.voice }` (`cli/main.ts:1418`) → `start{lang:
model.config.language}` (`tui/src/voice-session.ts:325`) →
`LiveTranscription.open(language: lang)` (`main.swift:281`). `trace` already
takes `--lang auto|it|en` (`main.swift:568`).

## Implementation

*— claude-opus-5-5, 2026-11-18*

**Load-bearing assumption:** two SEPARATE `SpeechAnalyzer`s, each with its own
transcriber, fed the same buffers, do not disturb each other — so the accurate
one's final stays the batch answer. (The feat's rejected variant (a) was two
modules in ONE analyzer, final matched batch 1/3.) Proven by the nonce-word
batch-equality test 5/5 and the Italian sample 3/3 (Execution).

**Design** (`native/voice-mac/Sources/TentacleVoice/Live.swift` only):
- `LiveLane` — one transcriber + analyzer + input stream + `TranscriptAccumulator`
  (the old `LiveTranscription` body, extracted).
- `LiveTranscription` owns two lanes and ONE `StreamResampler`:
  the **final** lane (`finalReportingOptions = [.volatileResults]`, unchanged)
  whose transcript `finish()` returns; the **partial** lane
  (`partialReportingOptions = [.volatileResults, .fastResults]`) whose text is
  `current` (the preview). The public API (`open/current/feed/finish/cancel`,
  `lang`) is unchanged, so `LiveFeed`, `replayLive`, the protocol loop and the
  TUI are untouched. The batch path (`Transcriber.makeTranscriber`) is unchanged.

**Failure modes:** partial lane fails to open → the final lane is cancelled
and `open` throws (caller falls back to batch at stop, as for any live failure);
lanes want different sample rates → same; partial lane errors mid-take → its
preview stops, the final is unaffected (only the final lane's failure is
thrown); `finish` cancels the partial lane (its tail is never shown) while the
final lane finalizes; `cancel` cancels both.

**Tests** (`LiveTests.swift`): the option pin now pins `finalReportingOptions`
(no `.fastResults` on the final lane); `testARecordedTakeYieldsPartialsWhileFedThenTheFinal`
asserts on a ≥ 5 s take: first partial < 1500 ms of audio and ≥ 3 partials more
than 1 s before the end.

## Execution

*— claude-opus-5-5, 2026-11-18*

As planned; no drift. `bun run voice:build`, then the same sample:

```
# before (main)                                  # after (this branch), 3/3 runs identical
$ trace --live --lang it it-sample.wav           partial	1200	Ciao,
final … Ciao, questa è … i parziali.             partial	2100	Ciao, questa è una prova della
                                                 partial	3100	Ciao, questa è una prova della trascrizione in
  partials: 0                                    partial	4100	… in tempo reale. Ve
                                                 partial	5000	… Vediamo se arrivano i
                                                 final … sttMs=95–136 … Ciao, questa è una prova della trascrizione in tempo reale. Vediamo se arrivano i parziali.
$ trace --lang it it-sample.wav   (batch)  →  … Vediamo se arrivano i parziali.   (= live final, byte for byte)
```

Partials 0 → 5, first-partial latency none → 1200 ms of audio; final unchanged
and equal to batch; stop latency (`sttMs`) unchanged (95–136 ms vs 180 before).

**Red → green** (`swift test --package-path native/voice-mac --filter LiveTests`):
- M-red: partial lane opened with `finalReportingOptions` (= the `main`
  behaviour): `LiveTests.swift:217 XCTAssertLessThan failed: ("4100") is not less than ("1500") - first partial at 4100 ms of audio`. Fix restored: `Executed 12 tests, with 0 failures`.
- M2: `finish()` returns the partial lane's text: `LiveTests.swift:162 … ("Zorblack's quaintively fram is the Bunderblist…") is not equal to ("Zorblack squintively fram is the Bunderblist…") - the live final is not the batch transcript`. Restored.
- Stability of the load-bearing assumption: the batch-equality test, 5 runs: 5/5 pass.

Gate: `bunx tsc --noEmit` clean · `bun run lint` (`biome check .`, 2088 files, no fixes) ·
`bun test` 15369 pass / 5 skip / 0 fail (no TS touched: the skips are the opt-in ones) ·
`swift test --package-path native/voice-mac` 29 tests, 0 failures.
