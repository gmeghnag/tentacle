# feat/voice-conversation — Hands-free voice conversation in the local TUI on the Mac (realtime-voice V2)

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/voice-conversation`
> **Size:** L, split into five slices: C1 helper v2 (M) · C2 pure voice modules (M) · C3 voice-turn profile (M) · C4 TUI wiring (M) · C5 live test (S) · **Blast:** load-bearing (C3 adds a per-turn field to `session/prompt` and to `model/stream`'s request, and touches the agent loop's model call); C1/C2 contained; C4 cross-module. · **Suited:** owner assigns. L + load-bearing ⇒ a **mandatory fresh-context Review**. It must red-team §6.1 (who speaks an ask, F6/F7), "never write raw to the terminal" (F12), and C3's on-disk rule (nothing transient persisted, F10).
> **Changelog:** `changelog.d/voice-conversation.added.md`: "- **Hands-free voice conversation on the Mac.** Turn on voice mode, talk to tentacle, and hear the reply. Speak over it to interrupt it. Recognition and speech run on the Mac; no audio leaves it or is saved."

## Context

*— claude-opus-5-5, 2026-11-15*

**Why.** This is phase **V2** of the approved realtime-voice architecture (`docs/eval/realtime-media.md` §9 row `:507`; owner answers `:998-1010`). V2 is candidate **B** (`:301-319`): an edge cascade where the session answers directly. The user speaks, an end-of-turn detector closes the utterance, the transcript goes to the session as an ordinary prompt, and the reply comes back as on-device speech. Speaking over the reply stops it (barge-in). V2 is "useful alone" (`:518`). V3 (the B+ fast front) and V4 (the phone) reuse V2's seam and its pure modules (`:528-529`).

**Hard dependency: V1 is approved but NOT built.** `docs/feat/voice-dictation.md` was approved on 2026-11-15 (`:429-435`). Its owner decisions: Ctrl+R toggle, no default auto-stop, **Apple's on-device recogniser as the default engine with a Parakeet switch**, and `tentacle voice setup` only for Parakeet. But no voice code is in the tree:

```
$ rg -il "voice|dictat" packages --glob '!**/node_modules/**'
(no matches)        # 2026-11-15, feat/voice-conversation = main @ 2f6c1acc
```

V2 extends V1's helper (`tentacle-voice`), its JSON-lines protocol (`voice-dictation.md:108-122`), its pure endpoint fold (`:128-139`) and its reducer (`:147`). **This plan cites V1's approved design, not code.** Execution cannot start before `feat/voice-dictation` is merged (Owner Q1). When it lands, the V1 symbols cited here must be re-checked against the real code. If one drifted, the plan is fixed first (AGENTS §8).

**Binding decisions already taken (eval owner answers, `realtime-media.md:1000-1008`):**

- **Q4, asks:** the broker's exact text, through a deterministic template, spoken by local TTS and shown on screen. It never passes through a model. It is answered only by a key bound to that ask. **No voice approval.**
- **Q5, reasoning:** off or minimal for every spoken reply. Delegated real work keeps the session's setting, and its progress is narrated by templates.
- **Q6, topology:** laptop voice runs in a local terminal only, through the native Swift helper. Over SSH or a remote tmux it is off with a notice. Bluetooth headsets are supported, with the option of the Mac mic plus headphone output (this avoids the HFP drop).
- **Q8, persistence:** the verbatim transcript is the user message. Audio is never kept. `via: "voice"` was approved as an optional non-critical field, but **V1 put it out of scope** (`voice-dictation.md:17`). V2 re-asks it (Owner Q7).
- **TTS default:** Kokoro (`realtime-media.md:912`), decided **before** V1's owner chose Apple-default for STT. V2 re-asks it (Owner Q3).

**V0 facts this plan builds on** (synthetic audio, a loaded box; `realtime-media.md:639-649`):

| Fact | Value | Consequence for V2 |
|---|---|---|
| B delegated, end of speech → first audio, warm | 830 ms local Qwen / 1 528 ms DeepSeek p50; p95 ≈ 2–3 s (`:674-675`) | B alone meets the 2.0 s p50 budget. No p95 is claimed (`:932-934`). |
| Kokoro does not stream; TTFA grows with text length | 125 ms at 1 word … 1.35 s at 179 chars (`:705-712`) | **The first spoken chunk is ≤ 4 words** (`:698-700`), whichever engine is used. |
| Smart Turn cuts at commas | 5/30 cut; no threshold separates the cut halves (`voice-dictation.md:31-40`) | Hands-free auto-stop needs V1's comma-safe silence floor (S1-pinned), plus the V1 T3 regression. |
| AEC with voice processing | ≈ 74 dB on a tone, built-in speakers. Human speech, AirPods, false barge-in rate and stop latency are **not measured** (`:766-800`) | Barge-in is the least-proven part. It is C1's exit criterion. |

**What the code offers today (verified 2026-11-15):**

- `session/prompt` takes `{sessionId, turnId, content, skill?}` (`packages/protocol/src/session.ts:318-329`). It has **no per-turn model option**.
- `session/enqueue` (steering) exists (`session.ts:1128`), and so does `session/cancel` (`:375`).
- Reply text reaches the TUI as `agent_message_chunk` → `{type:"text", delta}` (`packages/client/src/mapping.ts:250-251`), inside a turn's `AsyncIterable<SessionEvent>` (`packages/tui/src/turn-feed.ts:15-22`, `state.ts:624`).
- The pending permission ask the TUI shows is `PermissionUiState.pending: PermissionRequest | null` (`packages/tui/src/permission-ui.ts:224-226`). It is fed by the single laptop `PermissionBroker` (`packages/core/src/permission.ts:211,246`).
- **There is no reasoning control anywhere:**
  - `ChatRequest` is `{messages, tools?, temperature?, maxTokens?, signal?, attachments?}` (`packages/core/src/model.ts:139-151`).
  - `WireChatRequestSchema` is the same, minus the non-serialisable fields (`packages/protocol/src/model.ts:35-40`).
  - `rg -i "reasoning_?effort|enable_thinking" packages` finds nothing.
  - The OpenAI provider adds only `temperature` beyond messages/tools (`packages/providers/src/openai-provider.ts:337-338`).
  - The Anthropic provider never *requests* thinking. It only parses `thinking_delta` (`anthropic-provider.ts:252-254`).
  - So "reasoning off" is a **new capability**, not a setting to flip (C3).

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**With the helper's own TTS playing through the same voice-processing `AVAudioEngine`, the VAD sees the user's speech and not the assistant's voice. False barge-ins stay under 1 per 5 min, and playback stops within 100 ms of real speech** (E6 pass criteria, `realtime-media.md:485`).

- **Proven:** 74 dB cancellation of a pure tone on built-in speakers (`:777-781`).
- **Not proven:** the same for speech (the canceller's hard case: speech-on-speech), for AirPods, and the stop latency.
- **C1's first step proves it**, with the owner at the Mac, before any TS slice starts. For the canceller to have a reference, TTS audio **must** be rendered by the helper and played through its engine's player node. A separate `say`/`afplay` process would be invisible to AEC. That is why TTS lives in the helper (Design §2).
- **If it fails** (false barge-ins ≥ 1 / 5 min): barge-in falls back to "raise the VAD threshold during playback" (`realtime-media.md:540-541`). If it still fails: **half-duplex**. The mic is gated while speaking, and the user interrupts with a key (Esc stops speech). The rest of the design does not change. The owner decides with the C1 numbers.

### Preconditions (verified, or V1-design-cited where marked **[V1]**)

- **One session path holds.** Voice produces only `session/prompt`, `session/enqueue` and `session/cancel`, through the TUI's existing `RemoteClient`. It consumes only the turn's `SessionEvent`s and the laptop broker's `pending`. So `worker`, `run`, `attach` and `connect` all work, and a pod never sees audio, the helper or a transcript other than the prompt itself (AGENTS §7 "TUI always over RPC", "model stays on the laptop").
- **Adding a field is free** (AGENTS §7 forward-compat): payloads are strip schemas, so an older daemon drops `PromptParams.voice` and an older laptop drops `WireChatRequest.reasoning`. Both degrade to "reasoning as configured", never to an error. **No `protocol.d/` note, no `PROTOCOL_VERSION` bump.** (Execution re-checks that both schemas are non-`.strict()`.)
- **The ask text comes from the laptop broker** (`permission-ui.ts:224`). In `run`/`attach` the `permission_request` update is pod-supplied, but the laptop broker builds the `PermissionRequest` the dialog renders, and that is what the voice template reads (§6.1 rule 1). A daemon-side string is never read for speech.
- **[V1]** Helper protocol v1 (JSON lines on stdin/stdout, a `ready.v` check, stderr to a log): `voice-dictation.md:108-122`. Pure endpoint fold `voice-endpoint.ts`: `:128-139`. Reducer `voice-session.ts` with `voiceAvailability`: `:147`. Layer `keys/layer-voice.ts` placed after `paste`, before `sessions`/`escAbort`: `:149`. Hook `useVoice.ts` with an injected spawner: `:150`.
- **Shared pure code for V4.** `apps/mobile` and `packages/tui` both depend on `@tentacle/core` (`apps/mobile/package.json:11`, `packages/tui/package.json:12`). So the speakable/chunk/template modules go in `packages/core/src/voice/`, which is React-free and Ink-free, and V4 imports them unchanged.

### Design

**1. The mode.** *Conversation mode* is a TUI-local toggle, layered on V1's dictation. It does not replace it.

| While | Input | Effect |
|---|---|---|
| idle, voice available | **`/voice`** or **`voice.conversationKey`** (Owner Q2) | conversation mode on: the helper listens continuously; the strip shows `◉ voice · listening` |
| listening | the user speaks, then the endpoint fold says `stop` (V1 fold, auto-stop **on** in this mode, comma-safe floor) | transcribe → **auto-send** (Owner Q4): `session/prompt` if idle, `session/enqueue` if a turn runs |
| assistant speaking | the user speaks (barge-in) | playback stops at once (helper-local); the utterance is captured and sent as above. **The turn is not cancelled** (Owner Q5). |
| any | **Esc** | stops speech if speaking; otherwise falls through unchanged (abort turn). V1's precedence: the voice layer is before `escAbort`. |
| any | the toggle again, or 10 min with no speech | mode off: helper capture stops, the mic indicator goes off |
| a permission ask is pending | the user speaks | **not sent**: the transcript lands in the field with a notice "answer the approval first" (F6) |

V1's Ctrl+R dictation stays as it is. While conversation mode is on, Ctrl+R is a no-op with a notice (a single owner of the mic).

**2. Helper protocol v2** (`ready.v: 2`; helper-local, unrelated to `PROTOCOL_VERSION`). V1's messages stay. Added:

| Direction | Message | Meaning |
|---|---|---|
| → | `{"t":"listen","mode":"continuous"}` / `{"t":"unlisten"}` | keep the engine running; emit `vad`/`turnp`/`level` and open a new buffer `id` at each speech onset (`utter{id}`) |
| → | `{"t":"speak","seq":n,"text":"…","lang":"it"\|"en"}` | synthesise and queue chunk `n` on the engine's player node |
| → | `{"t":"hush"}` | stop playback now and drop the queue (Esc, barge-in confirmation, mode off) |
| ← | `{"t":"utter","id":n}` | speech onset (a new buffer) |
| ← | `{"t":"speaking","seq":n}` / `{"t":"spoken","seq":n}` | chunk `n` started / finished playing |
| ← | `{"t":"bargein","seq":n,"ms":…}` | VAD speech during chunk `n`; **the helper has already stopped playback** (no TUI round trip in the < 100 ms path) |
| ← | `{"t":"error","code":"tts_failed"\|"voice_missing"\|…}` | new codes |

- **Barge-in in the helper.** While playing, the helper applies a raised VAD threshold (`voice.bargeInThreshold`, C1-pinned) and N consecutive speech windows (C1-pinned, starting at 3 = 96 ms). When both hold, it hushes itself and emits `bargein`. The TUI only updates state.
- **TTS engine** (Owner Q3):
  - **Default `system`:** `AVSpeechSynthesizer.write(_:toBufferCallback:)` renders PCM buffers into the player node. No download, it/en system voices, and it streams per utterance.
  - **`kokoro`:** opt-in, only if C1 proves a Swift/CoreML Kokoro path, including the phonemizer, with its license recorded here. Otherwise the option is not offered (no dead setting).
- **AirPods.** Output through AirPods + mic through AirPods forces HFP. `voice.input: "builtin"` (V1) keeps A2DP output. C1 measures both. The default follows macOS.

**3. Pure modules (`packages/core/src/voice/`, React-free, shared with V4).**

| Module | Input → output |
|---|---|
| `speakable.ts` | markdown text → speakable text. Code fences become "(code on screen)" / "(codice a schermo)". Inline code is kept as plain words. Links keep their label. Tables become "(table on screen)". Headings and list marks are dropped. Control characters are stripped. |
| `chunker.ts` | a streaming fold over text deltas → spoken chunks. **First chunk ≤ 4 words**, cut at a clause boundary if one comes first. Later chunks cut at sentence/clause ends, ≤ 200 chars. `flush()` at the end of the turn. Never splits inside a word or a number. |
| `narration.ts` | `tool_call` → one templated line from the **tool name only** ("running a shell command", "editing a file", "searching"). Throttled to ≤ 1 per 5 s, and never while a reply chunk is queued. A tool name it does not know → "working". **Never** a pod-supplied argument, path or output (no injection channel into speech). |
| `ask-speech.ts` | the laptop broker's `PermissionRequest` → the §6.1 template. "Approval needed: `<tool>` wants to run `<command verbatim>`." If the verbatim part is > 120 chars or multi-line → "A command needs approval, see the screen." Always ends with "press a key on screen to answer". |
| `voice-lang.ts` | spoken language = the last utterance's detected `lang` (V1 `final.lang`), else `voice.language`, else `en` |

**4. The conversation reducer (`packages/tui/src/voice-conversation.ts`, pure).** States: `off · listening · capturing · transcribing · sending · speaking · askPending`. Inputs: key intents, helper messages, turn events (`text` delta, `tool_call`, turn end/error), broker `pending` changes, helper exit. Outputs: commands (`send`, `prompt`, `enqueue`, `notice`, `fieldInsert`, `hush`, `speak`). It owns:

- send routing: idle → `prompt`, turn running → `enqueue` (the existing steer path; the TUI already binds steering to the latest turn, `packages/client/src/remote-session.ts:148-150`);
- the speech queue: reply chunks (from `chunker`) take priority over narration. An ask preempts both (`hush` + speak the ask);
- the ask gate (F6);
- turn end: flush the chunker. On error, speak a short template ("the turn failed, see the screen").

V1's `voice-session.ts` keeps owning dictation. A top-level `voice` selector picks which reducer gets helper messages (conversation mode on ⇔ the conversation reducer).

**5. Voice-turn profile (C3; Owner Q6).**

- `PromptParams.voice?: true` (additive). The TUI sets it on prompts sent by conversation mode. `session/enqueue` gets the same optional field, and an enqueued voice steer marks the rest of its turn as a voice turn.
- Daemon side, for a voice turn, the agent loop:
  - (a) sets `ChatRequest.reasoning = "off"` on that turn's model calls;
  - (b) appends one **transient** system line to that turn's model requests only: "The user is listening, not reading: answer in short spoken sentences, first sentence short, no code blocks unless asked." **It is never in the history, the log or `<uid>.jsonl`** (AGENTS §7: persist only the conversation).
- Q5's split ("delegated real work keeps the session's setting"): once a voice turn makes its **first tool call**, the *next* model rounds of that turn go back to the configured reasoning. Only the rounds that produce the spoken answer (no tool call yet) are reasoning-off. This is a deterministic rule in the loop, not a classifier.
- `ChatRequest.reasoning?: "off"` and `WireChatRequestSchema.reasoning?: "off"`, so a pod's voice turn reaches the laptop's provider through `model/stream`. Providers:
  - **OpenAI-compatible:** `reasoning_effort: "none"` plus `chat_template_kwargs: {enable_thinking: false}`. Per-model support is uneven, so a 400 on an unknown parameter → retry once without them, and remember that for the session's provider (F9).
  - **Anthropic:** a no-op (it never requests thinking today).
- **The one C3 assumption to prove first:** the agent loop has a single place where one turn's `ChatRequest` is built, so (a)/(b) can be added without touching history. If the code shows otherwise, STOP and fix this plan.

**6. Earcon.** At `stop` (end of the user's turn) the helper plays a ~80 ms tone through the player node, so that silence until the first chunk is never dead air (`realtime-media.md:314-315`). Config `voice.earcon: true`.

### Files (dependency order)

1. **C1 — `native/voice-mac/`** (on V1's package): `Sources/TentacleVoice/{Listen,Tts,BargeIn,Earcon}.swift`, protocol v2 in `Protocol.swift`, `trace` extended to replay a WAV **while** playing a TTS fixture (makes barge-in fixtures). Swift tests. `bun run voice:test` stays outside `bun run check` (V1 rule).
2. **C2 — `packages/core/src/voice/{speakable,chunker,narration,ask-speech,voice-lang}.ts`** + `index.ts` export; tests in `packages/core/test/voice/`.
3. **C3:**
   - `packages/protocol/src/session.ts` (`PromptParams.voice`, enqueue `voice`) and `packages/protocol/src/model.ts` (`reasoning`), then `bun run protocol:bump` at merge regenerates `protocol.json` (no note);
   - `packages/core/src/model.ts` (`ChatRequest.reasoning`);
   - the agent loop's request builder (path pinned in C3's first step) and the daemon's prompt/enqueue handlers passing `voice`;
   - `packages/providers/src/openai-provider.ts` (the mapping and the one-shot fallback);
   - the `ProxyModelProvider` wire mapping;
   - `packages/client` (`voice` on prompt/enqueue).
4. **C4:**
   - `packages/config/src/schema.ts`: `voice` gains `conversationKey`, `tts: "system"|"kokoro"`, `ttsVoice: {it?, en?}`, `ttsRate`, `bargeIn: boolean` (default true), `bargeInThreshold`, `earcon`, `conversationIdleMinutes` (default 10); `.strict()` stays;
   - `packages/tui/src/voice-conversation.ts` (reducer), `voice-protocol.ts` v2, `voice-view.ts` (strip states), `keys/layer-voice.ts` (Esc-hush, toggle), `useVoice.ts` (route helper messages, feed turn events and broker `pending`), `commands` (`/voice`), `components/VoiceStrip.tsx`.
5. **C5:** `changelog.d/voice-conversation.added.md`; README "Voice conversation" (keys, AirPods note, what is never stored).

### Failure modes

| # | Failure | Design / convergence |
|---|---|---|
| F1 | **False barge-in loop** (the assistant hears itself) | The helper uses a raised threshold + N windows while playing (C1-pinned). More than 3 barge-ins in 30 s with empty transcripts → barge-in auto-off for the session ("barge-in off: echo detected; Esc stops speech"). Half-duplex fallback per the load-bearing assumption. |
| F2 | **Comma pause ends the user's turn early** | V1's comma-safe floor applies (`voice-dictation.md:137`, T3). A cut utterance is sent as is. The user's next utterance is a steer (`enqueue`), so nothing is lost, only split. C5 counts splits. |
| F3 | **Utterance while a turn runs** | `session/enqueue` (steering), never a second prompt; the existing queue semantics hold. |
| F4 | **Network drop / daemon detach mid-reply** (connect, pods) | The turn feed ends with an error: hush, speak "connection lost", mode stays on but sends nothing until the client reconnects (the existing link status). The session continues daemon-side, detach not close (`realtime-media.md:544-545`). |
| F5 | **Long reply** | Speak at most `voice.maxSpokenChars` (default 1 200), then "the rest is on screen". The text is fully displayed as today. |
| F6 | **Spoken "yes" during a permission ask** | Never an approval. While `pending ≠ null` no utterance is sent: it goes to the field + notice. The ask is spoken from the laptop broker's request only, preempting any speech. When the answer arrives (key), speech resumes with the reply. |
| F7 | **Pod-supplied text in speech** | Reply text is model output, already displayed: it is spoken through `speakable` (control chars stripped, capped). Narration uses the tool **name** only. Asks are read from the laptop broker. No daemon-supplied string reaches speech through any other route (the reviewer red-teams this). |
| F8 | **TTS voice missing for the language / TTS error** | `voice_missing` → the system default voice + one notice. `tts_failed` → that chunk is skipped, a notice; text is on screen anyway. |
| F9 | **Provider rejects `reasoning_effort`/`chat_template_kwargs`** | One retry without them, remembered per provider for the session, one notice "this model ignores reasoning off". Never a failed turn. |
| F10 | **Transient voice note leaks into history/persistence** | It is added only to that turn's outgoing `ChatRequest`. Test: a voice turn's `session/log` entries and the persisted `<uid>.jsonl` contain no trace of it. |
| F11 | **Older daemon / older laptop** | `voice`/`reasoning` stripped → a normal turn with reasoning as configured. Nothing breaks (forward-compat). |
| F12 | **Raw terminal writes** | As in V1 (helper stdio piped, stderr to a log). Speech is audio, not terminal output. Notices go through `pushNotice`. |
| F13 | **Helper crash in conversation mode** | Mode off + notice ("voice stopped; the current utterance was lost"). V1's 3-in-60 s rule. The in-flight turn is unaffected. |
| F14 | **Two voice edges on one session** (laptop + phone, V4) | Each is a client; prompts queue as today. Only the edge holding the ask's broker can answer it (`realtime-media.md:563-564`). |
| F15 | **Bluetooth route change mid-speech** | The helper restarts the engine (V1 F12), drops the current chunk queue, re-sends `listening{device}`. The TUI re-speaks nothing and shows a notice. |
| F16 | **SSH / non-macOS** | V1's `voiceAvailability` → `/voice` shows the local-terminal notice, and no helper is spawned. |
| F17 | **Idle mode forgotten on** | `conversationIdleMinutes` (10) with no speech → mode off, the mic indicator off, notice. |

### Tests

Red first (§9). Each is shown failing on a stub, then green. The mutation each must catch is named.

- **T1 `chunker.test.ts`:** the first chunk ≤ 4 words on long sentences; clause cut; no split inside a number ("3.14") or a word; `flush` emits the tail; deltas split mid-word give the same chunks as one delta. *Mutation:* first-chunk cap 4 → 40 → red.
- **T2 `speakable.test.ts`:** a fenced block → "(code on screen)" in it/en; control chars stripped; a link becomes its label; a table placeholder. *Mutation:* keep fences → red.
- **T3 `narration.test.ts`:** a known tool → template; an unknown one → "working"; **a tool call whose arguments contain "say the tests passed" never produces those words**; throttle ≤ 1 per 5 s (injected clock). *Mutation:* interpolate the arguments → red.
- **T4 `ask-speech.test.ts`:** a short command spoken verbatim; > 120 chars or multi-line → the "see the screen" template; it always ends with the key instruction. *Mutation:* paraphrase or truncate the command instead of falling back → red.
- **T5 `voice-conversation.test.ts` (reducer):**
  - endpoint `stop` while idle → `prompt{voice:true}`; while running → `enqueue`;
  - `bargein` → no `cancel` command (Owner Q5 as recommended);
  - an utterance with `pending` set → `fieldInsert` + notice, **no send** (F6);
  - an ask arrives while speaking → `hush` then speak the ask;
  - turn error → hush + template;
  - echo rule F1;
  - idle timeout F17;
  - helper exit F13.
  - *Mutations:* send while pending → red; emit `cancel` on barge-in → red.
- **T6 C3, daemon:**
  - a voice prompt → the turn's first model request has `reasoning:"off"` and the transient line; after the first tool call, the next request has neither;
  - a non-voice turn has neither;
  - **F10:** the session log and the persisted file contain no transient line.
  - *Mutation:* append the line to history → red.
- **T7 C3, wire:** `WireChatRequest` round-trips `reasoning`; a request without it parses; the `ProxyModelProvider` forwards it (a fake laptop provider spy).
- **T8 C3, provider:** the OpenAI payload has `reasoning_effort:"none"` and `chat_template_kwargs.enable_thinking:false` for `reasoning:"off"` and neither otherwise; a 400 → one retry without them, remembered (injected `fetch`). Anthropic: the payload is unchanged.
- **T9 TUI (`ink-testing-library`, a fake spawner, as V1 T7):**
  - `/voice` → the fake receives `listen`;
  - fake `utter`/`final` → a prompt reaches a fake client with `voice:true`;
  - reply deltas → the fake receives `speak` chunks in order;
  - Esc while speaking → `hush`, and the turn is **not** aborted;
  - Esc while not speaking → the existing abort route.
- **T10 `route.test.ts`:** Esc precedence while speaking (voice before `escAbort`); the toggle key behind an open dialog → pass.
- **Swift (`voice:test`):** protocol v2 round trip; `hush` stops the player within one buffer; `trace` with a TTS fixture + speech WAV → a `bargein` at the expected window; TTS-only playback → **no** `bargein` (the fixture-level echo check).

### Slices

| Slice | Size · Blast | What | Exit criterion |
|---|---|---|---|
| **C1 helper v2** (starts with a spike in `.tentacle/tmp/voice-conversation/`) | M · contained | The load-bearing proof: TTS through the engine + VAD while playing, owner at the Mac, built-in speakers and AirPods, 5 min talking over the reply. Then protocol v2, system TTS, barge-in, earcon, Swift tests. Kokoro-in-Swift feasibility + license. | A table in Execution: false barge-ins / 5 min, stop latency p50/p95, TTS first-audio p50 (system vs Kokoro, if any), on both outputs. **Full- vs half-duplex decided with the owner.** |
| **C2 pure voice modules** | M · contained | §3 modules, T1–T4. | `bun test packages/core/test/voice` green; mutations logged. |
| **C3 voice-turn profile** | M · **load-bearing** | §5, T6–T8. | `bun run check` green; mutations logged; fresh-context Review of C3 against §7 (persistence, forward-compat, model-on-laptop). |
| **C4 TUI wiring** | M · cross-module | config, reducer, layer, hook, strip, `/voice`; T5, T9, T10. | `bun run check` green. |
| **C5 live** | S · contained | The owner's checklist below; README, changelog. | Every L-item ticked by the owner. |

**Latency targets** (end of user speech → first audible word; to re-take on an idle Mac in C1/C5):

| Path | p50 | p95 |
|---|---|---|
| Voice turn, local Qwen, warm | ≤ 1.2 s (V0 830 ms + the comma-safe floor delta) | reported, not gated |
| Voice turn, DeepSeek, warm | ≤ 2.0 s (V0 1 528 ms + floor delta) | reported, not gated |
| Barge-in: speech onset → playback stopped | ≤ 100 ms | ≤ 150 ms |
| Earcon after the end of the user's turn | ≤ 50 ms after `stop` | — |

**Live checklist (C5, owner at the Mac):**

- **L1** Ten turns in Italian and English with a local model, then with DeepSeek: the reply is heard, and the first word arrives within the targets.
- **L2** Talk over five replies: playback stops at once, and the new utterance is answered.
- **L3** Five minutes of the assistant talking with no one speaking: zero false barge-ins (built-in speakers, then AirPods, then Mac mic + AirPods output).
- **L4** A command that needs approval: it is spoken verbatim (or "see the screen"); saying "yes" does nothing; a key answers it.
- **L5** Esc while it speaks: speech stops, the turn continues. Esc again: the turn aborts.
- **L6** A `run` pod session: voice works, and the pod has no helper (`ps` in the pod).
- **L7** Wi-Fi off with a local model: everything works.
- **L8** After a session, `ls -R <configDir>/voice` has no audio file, and `<uid>.jsonl` has no "listening, not reading" line.
- **L9** Over `ssh localhost`: `/voice` shows the local-terminal notice.

### Owner questions

1. **Order: V2 only after V1 is merged?** V2 extends V1's helper, protocol and reducers, and none of them exist yet. *Recommendation: yes.* Execution starts when `feat/voice-dictation` is merged. The C1 spike (scratch only) may run earlier, because it also de-risks V1's helper.
2. **How to turn conversation mode on.** *Recommendation: a `/voice` command plus a rebindable key (`voice.conversationKey`, Ctrl+G if C1's key probe shows it is free and reaches the app). The mode stays on until toggled off or 10 min of silence.* V1's Ctrl+R dictation is unchanged.
3. **Voice engine for replies.** The eval chose Kokoro, but for listening you chose Apple's built-in engine as the default. *Recommendation: the macOS system voice by default* (no download, streams, plays through the helper so echo cancellation works). Kokoro becomes a switch only if C1 shows a working Swift path with a clean license.
4. **Send automatically when I stop talking?** V1 never auto-sends. Hands-free needs it. *Recommendation: yes, in conversation mode only.* Each utterance is sent at the end of your turn (comma-safe pause) and shown in the transcript. Dictation (Ctrl+R) keeps never auto-sending.
5. **What talking over the reply does.** *Recommendation: it stops the speech only. What you say is sent as a steer to the running turn, and the work is not cancelled.* Esc stops speech, a second Esc aborts the turn as today.
6. **Reasoning off for spoken replies (new plumbing).** No reasoning control exists today. This adds a per-turn `voice` flag, reasoning off until the turn's first tool call, and a short "speak, don't write" note that is never saved. It is additive, with no protocol bump. *Recommendation: yes, as slice C3, with a mandatory fresh-context review.*
7. **Mark voice messages (`via: "voice"`) in the saved session?** You approved it in the eval; V1 left it out. *Recommendation: still out.* The transcript is saved as an ordinary user message. It can be added later as an optional field without breaking anything.
8. **What is spoken besides the reply.** *Recommendation: the reply (code and tables become "on screen", long replies stop at ~1 200 characters), one generic line per tool ("running a shell command", tool name only, at most every 5 s), approvals verbatim, failures as one short line, and a short tone when you finish speaking.*

## Execution

*(empty — the plan is not yet approved)*

## Review

*(empty)*
