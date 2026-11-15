# feat/voice-conversation — Hands-free voice conversation on the Mac and the iPhone (realtime-voice V2, both edges)

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/voice-conversation`
> **Size:** L as a whole. It is one task doc because the owner asked for one, and it is **ten slices, each S or M**, executed and reviewed slice by slice (table in *Slices*). Order: shared pure core → Mac edge ∥ phone edge → live. No slice is XL. · **Blast:** load-bearing. C3 adds a per-turn field to `session/prompt` / `session/enqueue` and to `model/stream`'s request, and touches the agent loop's model call. The other slices are contained or cross-module (per slice below). · **Suited:** owner assigns, per slice. L + load-bearing ⇒ a **mandatory fresh-context Review**. It must red-team: §6.1 (who speaks an ask, F6/F7), "never write raw to the terminal" (F12), C3's on-disk rule (nothing transient persisted, F10), and the phone's single owner of `AVAudioSession` (P-F1…P-F6).
> **Changelog:** `changelog.d/voice-conversation.added.md`: "- **Hands-free voice conversation on the Mac and the iPhone.** Turn on voice mode, talk to tentacle, hear the reply, and speak over it to interrupt. Recognition and speech run on the device; only text reaches the session, and no audio is saved."

## Context

*— claude-opus-5-5, 2026-11-15 (rev 2, 2026-11-15: phone edge added — owner: "anche con supporto mobile"; Mac/phone parity is an owner rule)*

**Why.** This is phase **V2** of the approved realtime-voice architecture (`docs/eval/realtime-media.md` §9 row `:507`; owner answers `:998-1010`). V2 is candidate **B** (`:301-319`): an edge cascade where the session answers directly. The user speaks, an end-of-turn detector closes the utterance, the transcript goes to the session as an ordinary prompt, and the reply comes back as on-device speech. Speaking over the reply stops it (barge-in).

The eval put the phone in V4 (`:509`). **The owner has now asked for hands-free on mobile too, with parity.** So the phone edge moves into this task as first-class slices, built on the same pure core. What stays in V4 is only what B does not need: the B+ fast front on the phone, and an on-device Foundation Models front.

**Two edges, one seam, one session path.** Each edge is a client of the existing session path:
- The **Mac edge** is the TUI plus V1's Swift helper.
- The **phone edge** is the iPhone app plus `feat/mobile-voice`'s native module, reaching `serve` over the E2E relay.

Both feed the **same pure core** (`packages/core/src/voice/`): endpoint fold, conversation reducer, chunker, speakable text, narration, ask speech. Each edge adds only audio I/O and wiring. Only **text** crosses any wire (eval Q6 answer, `:1005`).

**Hard dependencies: neither edge's base is merged.**

| Base | State (2026-11-15) | What V2 takes from it |
|---|---|---|
| `feat/voice-dictation` (V1, Mac) | plan approved (`docs/feat/voice-dictation.md:429-435`: Ctrl+R toggle, no default auto-stop, **Apple recogniser default + Parakeet switch**, `voice setup` only for Parakeet). **No code**: `rg -il "voice\|dictat" packages` → no match on `main` @ `2f6c1acc`. | the helper `tentacle-voice`, its JSON-lines protocol (`voice-dictation.md:108-122`), the endpoint fold (`:128-139`), the reducer and `voiceAvailability` (`:147`), the key layer (`:149`) |
| `feat/mobile-voice` (phone) | **executed and in review**: `2dca65b3` exec, `fcd8e32f` review round 1, `86691927` fix round 1. Not merged; its header still reads "NOT approved". Its Step 0 (a), whether on-device recognition exists for `it-IT`/`en-US` on the owner's iOS 18.3.1 phone, is **still unverified** (`mobile-voice.md`@branch `:84-90`, `:388`). | the `tentacle-speech` module (two STT engines, `AVSpeechSynthesizer`, the single `AVAudioSession` owner), `speakable.ts`, `speech-language.ts`, the voice settings, the mic UI |

This plan cites V1's **approved design** and mobile-voice's **branch code** (`feat/mobile-voice` @ `86691927`). When each one merges, its cited symbols are re-checked. If one drifted, the plan is fixed first (AGENTS §8).

**Binding decisions already taken (eval owner answers, `realtime-media.md:1000-1008`):**

- **Q4, asks:** the answering device's own ask text, through a deterministic template, spoken by local TTS and shown on screen. Never through a model. Answered only by a key/tap bound to that ask. **No voice approval.**
- **Q5, reasoning:** off or minimal for every spoken reply. Delegated real work keeps the session's setting, and its progress is narrated by templates.
- **Q6, topology:** Mac voice runs in a local terminal only (Swift helper); over SSH it is off with a notice. The phone is the voice edge for remote sessions. Only text goes over the E2E channel. "Background/lock-screen audio to be verified by E10."
- **Q8, persistence:** the verbatim transcript is the user message, and audio is never kept. `via: "voice"` was approved as optional, but V1 left it out (`voice-dictation.md:17`), and mobile-voice deferred it (`mobile-voice.md`@branch P8). **V2 keeps it out**: it can be added later as a non-critical field, nothing to decide now.
- **TTS:** Kokoro was the eval default on the laptop (`:912`); the phone uses the system voice (mobile-voice owner brief). V2 asks for parity (Owner Q5).

**V0 facts (Mac, synthetic audio, a loaded box; `realtime-media.md:639-649`):**

| Fact | Value | Consequence |
|---|---|---|
| B delegated, end of speech → first audio, warm | 830 ms local Qwen / 1 528 ms DeepSeek p50 (`:674-675`) | B meets the 2.0 s p50 budget on the Mac. No p95 is claimed (`:932-934`). The phone adds the relay RTT (E7). |
| Non-streaming TTS: TTFA grows with text length | 125 ms at 1 word … 1.35 s at 179 chars (`:705-712`) | **The first spoken chunk is ≤ 4 words** on both edges. |
| Smart Turn cuts at commas | 5/30 cut; no threshold separates the cut halves (`voice-dictation.md:31-40`) | Auto-send needs a comma-safe silence floor on both edges. |
| AEC (Mac, tone, built-in speakers) | ≈ 74 dB. Speech, AirPods, false barge-ins and stop latency **not measured** (`:766-800`) | Barge-in is the least-proven part on both edges. Spikes C1 and P1 gate it. |

**What the session path offers today (verified 2026-11-15, `main` @ `2f6c1acc`):**

- `session/prompt` is `{sessionId, turnId, content, skill?}` (`packages/protocol/src/session.ts:318-329`). It has **no per-turn model option**.
- `session/enqueue` (steering) exists (`:1128`), and so does `session/cancel` (`:375`).
- Reply text arrives as `agent_message_chunk` → `{type:"text", delta}` (`packages/client/src/mapping.ts:250-251`). The phone uses the same `@tentacle/client` (`apps/mobile/package.json:10`).
- **Phone send path:**
  - a prompt goes through the persistent outbox: `session.prompt(text, turnId, refs)` (`apps/mobile/src/outbox-driver.ts:250`), with the item shape at `apps/mobile/src/outbox.ts:83-94`;
  - a steer goes through `client.enqueue(sessionId, id, turnId, text)` (`apps/mobile/src/compose-handle.ts:42`).
- **The phone talks only to `serve`.** Only a `serve` on the user's host has a device route (`docs/feat/mobile-relay.md:133`). That covers the laptop-as-host case (`serve` on the owner's Mac) and a `serve` on another host. Either way the **`serve` daemon holds the provider**, so a phone voice turn's model call is made daemon-side, never through `model/stream`.
- **There is no reasoning control anywhere:**
  - `ChatRequest` is `{messages, tools?, temperature?, maxTokens?, signal?, attachments?}` (`packages/core/src/model.ts:139-151`), and `WireChatRequestSchema` is the same (`packages/protocol/src/model.ts:35-40`);
  - `rg -i "reasoning_?effort|enable_thinking" packages` finds nothing;
  - the OpenAI provider adds only `temperature` beyond messages/tools (`packages/providers/src/openai-provider.ts:337-338`);
  - the Anthropic provider never requests thinking, it only parses `thinking_delta` (`anthropic-provider.ts:252-254`).

**What `feat/mobile-voice` has, and what it lacks for a hands-free loop** (all citations are `feat/mobile-voice` @ `86691927`):

| Need | mobile-voice today | Gap V2 closes |
|---|---|---|
| **STT on the owner's phone** | iOS 18 = `SFSpeechRecognizer`, on device only. It refuses unless `supportsOnDeviceRecognition` (`ios/RecognizerEngine.swift:41`), sets `requiresOnDeviceRecognition` and `addsPunctuation` (`:81-83`), and rolls a new request every 50 s (`:74`). iOS 26 = `SpeechAnalyzer` (`ios/AnalyzerEngine.swift`; `SpeechCore.swift:173-176` guards `iOS 26`). | **On iOS 18.3.1 there is no `SpeechAnalyzer`.** The phone loop runs on `SFSpeechRecognizer`, whose on-device availability is unproven (Step 0 (a)) → P1. The 50 s rollover already makes continuous listening possible. |
| **Continuous listening** | push-to-talk: a tap starts a dictation; 20 s of silence stops it (`src/dictation.ts:21`); 10 min cap (`:23`) | a `listen` mode that stays on across utterances and segments each one |
| **Endpointing / auto-send** | none. A send happens only on a press or Return (`dictation.ts:116,139`, `after: "send"` `:331-332`) | the shared endpoint fold (§3) fed by phone signals, plus auto-send |
| **Voice processing (AEC) + barge-in** | dictation sets `.playAndRecord`, mode **`.default`** (`SpeechCore.swift:182-184`), with no voice processing. Speaking switches to `.playback/.spokenAudio` (`:243`). The two exclude each other: `speak` stops the engine (`:238`), `startDictation` stops speech (`:167`). **Half-duplex by construction.** | one session config for the whole mode (`.playAndRecord`, voice processing on the input node), TTS rendered **into the same engine** (so AEC has the reference), barge-in |
| **Interruptions** | `.began` only: abort + stop speaking (`SpeechCore.swift:304-309`). `.ended` is ignored. | pause on began; on ended, **no** automatic mic resume (P-F1) |
| **Route changes** | `.oldDeviceUnavailable` only, which aborts (`:311-316`) | re-configure on any route change (AirPods in/out, HFP), keep the mode alive |
| **Foreground vs background/lock** | no `UIBackgroundModes` in `app.json` (`grep -i audio` finds only the mic permission string, `:32,39`). `AppState` background stops dictation (mobile-voice F6). | decided by E11 + Owner Q6. v1 default: foreground only, screen kept awake while the mode is on |
| **Speakable text** | an AST walk over the phone's own markdown parser: `speakable(parsed, lang)` (`src/speakable.ts:132`), with `clean` (`:56`) and `splitLong` (`:96`, `MAX_UTTERANCE` 600 `:23`) | streaming: the reply arrives as deltas. The core chunker (§3) consumes text on both edges. `clean`/`splitLong` are lifted into core; the AST walk stays for the read-aloud button. |
| CarPlay, AirPods-specific gestures | none | **not required** (owner): out of scope |

## Implementation

*— claude-opus-5-5, 2026-11-15 (rev 2, 2026-11-15: phone edge, shared reducer and endpoint fold moved to core, slices re-sized)*

### Load-bearing assumptions (one per edge; each is a spike's exit criterion)

**Mac (C1).** With the helper's TTS played through the same voice-processing `AVAudioEngine`, the VAD hears the user and not the assistant. Pass: < 1 false barge-in per 5 min, and playback stopped < 100 ms after real speech (E6 criteria, `realtime-media.md:485`). Proven so far only on a tone (74 dB, `:777-781`).

**Phone (P1).** On the owner's iPhone 12 Pro, iOS 18.3.1, three things must hold:
1. `SFSpeechRecognizer` runs **on device** for it-IT and en-US.
2. With voice processing on the engine's input and `AVSpeechSynthesizer.write(_:toBufferCallback:)` buffers played through **that engine's** player node, speech from the **loudspeaker** does not trigger the recogniser's or the level gate's speech detection. Same pass numbers as the Mac.
3. The audio session survives what the mode must survive (Owner Q6).

**Why TTS must play inside the engine on both edges.** A separate synthesiser output (`say`, or `AVSpeechSynthesizer.speak` as mobile-voice does at `SpeechCore.swift:265`) is not the canceller's reference signal, so AEC cannot remove it.

**If an edge fails its spike:**
1. First fallback: a raised speech threshold while playing (`realtime-media.md:540-541`).
2. Then **half-duplex** on that edge: the mic is gated while speaking, and the user interrupts with Esc (Mac) or a tap (phone).
3. The rest of the design is unchanged. The owner decides with the numbers.
4. If phone point 1 fails, the phone loop slice (P3) does not start, and Owner Q1's fallback applies.

### Preconditions (verified, or cited from a base design/branch where marked)

- **One session path holds.** Each edge produces only `session/prompt`, `session/enqueue` and `session/cancel` through its existing client. It consumes only turn events and its own pending ask (AGENTS §7 "TUI always over RPC"). The phone already reaches `serve` this way. No new method, no audio on any wire, no new transport.
- **Adding a field is free** (AGENTS §7 forward-compat): payloads are strip schemas. An older daemon drops `voice` and an older laptop drops `reasoning`, and both degrade to "reasoning as configured". **No `protocol.d/` note.** Execution re-checks that the three schemas are non-`.strict()`.
- **The phone's outbox is persisted.** `outbox-store.ts:209` parses it on load. Execution checks that an optional `voice` on `OutboxItem` survives a reload. If the loader drops unknown fields, a retried voice prompt loses only the reasoning-off hint (harmless), and the field is added to the loader's shape.
- **Ask text comes from the answering device.**
  - Mac: the laptop broker's `PermissionRequest`, the one the dialog renders (`packages/tui/src/permission-ui.ts:224-226`; broker `packages/core/src/permission.ts:211,246`).
  - Phone: the permission sheet's request from `serve` (a trusted daemon on the user's host).
  - Never a daemon-side string read for speech on the Mac in `run`/`attach` (§7 "a pod is not trusted").
- **Shared code lives in `@tentacle/core`.** `apps/mobile` and `packages/tui` both depend on it (`apps/mobile/package.json:11`, `packages/tui/package.json:12`), and it is React-, Ink- and RN-free.
- **[V1 design] change of placement:** V1 puts `voice-endpoint.ts` in `packages/tui` (`voice-dictation.md:211`). V2 needs it on the phone, so V2's C2 **moves it to `packages/core/src/voice/endpoint.ts`** behind an edge-neutral input (below). If V1 has not been executed yet when this plan is approved, V1's executor should put it in core directly (a one-line note to V1's Execution).

### Design

**1. The mode (both edges, same semantics).**

| While | Mac | Phone | Effect |
|---|---|---|---|
| off | `/voice` or `voice.conversationKey` | a **waveform** button in the composer, next to the mic (render only, `Icon.tsx` gains `waveform`, already planned by mobile-voice) | mode on: listening continuously. Mac strip `◉ voice · listening`; phone capsule "Listening". |
| listening | user speaks, the fold says `stop` | same | transcribe → **auto-send** (Owner Q3): `prompt{voice:true}` if idle, `enqueue{voice:true}` if a turn runs |
| speaking | user speaks (barge-in) | same | playback stops at once, edge-local; the utterance is sent as above. **The turn is not cancelled** (Owner Q4). |
| speaking | Esc | tap the capsule | stop speech. A second Esc / the stop button aborts the turn, as today. |
| ask pending | user speaks | same | **not sent**: the text goes to the field with "answer the approval first" (F6) |
| any | toggle again, or 10 min with no speech | same, or the screen leaves the session | mode off: mic released, indicator off |

- **Mac:** V1's Ctrl+R dictation is a no-op while the mode is on (a single owner of the mic).
- **Phone:** the mic (push-to-talk) button is hidden while the mode is on, for the same reason.

**2. Mac edge: helper protocol v2** (`ready.v: 2`, helper-local, unrelated to `PROTOCOL_VERSION`). V1's messages stay. Added:

- → `listen{mode:"continuous"}` / `unlisten`
- → `speak{seq,text,lang}`, `hush`
- ← `utter{id}`, `speaking{seq}`, `spoken{seq}`, `bargein{seq,ms}` (the helper has already stopped playback), and the new `error` codes `tts_failed` / `voice_missing`
- **Barge-in in the helper:** while playing, a raised VAD threshold plus N consecutive speech windows (C1-pinned; start at 3 = 96 ms) → hush itself, then emit `bargein`.
- **TTS:** the system voice by default, through `AVSpeechSynthesizer.write` into the engine's player node. Kokoro only if C1 proves a Swift path with a clean license (Owner Q5).
- **Earcon:** ~80 ms tone at `stop` (`realtime-media.md:314-315`).

**3. Shared pure core (`packages/core/src/voice/`, React/Ink/RN-free; used unchanged by both edges).**

| Module | Input → output |
|---|---|
| `endpoint.ts` | **edge-neutral** fold over `{audioMs, speech: boolean, turnP?: number, textGrew?: boolean}` windows → `none \| askTurn \| stop`. A candidate needs silence ≥ floor. `turnP ≥ threshold` (Mac, Smart Turn) **or** no new recognised text for the floor (phone, where `SFSpeechRecognizer` exposes no turn model) → `stop`. A hard stop follows 3 s of continuous silence. Defaults are per edge (the Mac floor is S1-pinned in V1; the phone floor is P1-pinned). |
| `speakable.ts` | markdown text → speakable text. Lifts mobile-voice's `clean` and `splitLong` (`src/speakable.ts:56,96`). Code fences become "(code on screen)" / "(codice a schermo)", tables a placeholder, links their label; control characters are stripped. |
| `chunker.ts` | streaming fold over text deltas → spoken chunks. **First chunk ≤ 4 words** (clause cut if earlier); then sentence/clause ends, ≤ 200 chars; `flush()` at turn end; never split inside a word or a number. |
| `narration.ts` | `tool_call` → one templated line from the **tool name only**. ≤ 1 per 5 s, never while a reply chunk is queued; an unknown tool → "working". Never an argument, path or output. |
| `ask-speech.ts` | an ask `{tool, title/command}` from the answering device → §6.1 template, verbatim if ≤ 120 chars and single-line, else "a command needs approval, see the screen"; always ends with "answer on screen". |
| `conversation.ts` | **the conversation reducer**, moved here from the TUI (rev 1 had it in `packages/tui`) so both edges share one loop. States `off · listening · capturing · transcribing · speaking · askPending · paused`. Inputs: intents, edge audio events (normalised: `utter`, `final{text,lang}`, `bargein`, `speaking/spoken`, `interrupted`, `resumable`, `route`), turn events, ask pending/cleared, link up/down. Outputs: `prompt`, `enqueue`, `fieldInsert`, `notice`, `speak`, `hush`, `listen`, `unlisten`. **It speaks only turns this client started or steered in voice mode** (F14). |
| `voice-lang.ts` | spoken language = the last utterance's detected/selected language, else the setting, else `en` |

**4. Voice-turn profile (C3; Owner Q2) — the same for Mac- and phone-originated turns.**

- **The fields:** `PromptParams.voice?: true` and `EnqueueParams.voice?: true` (additive). An enqueued voice steer marks the rest of its turn as a voice turn.
- **The client API:** `RemoteClient.prompt/enqueue` take the flag (`packages/client/src/remote-session.ts:1025-1041,1320`).
- **The phone carries it** on its outbox item (`apps/mobile/src/outbox.ts:83-94` → `outbox-driver.ts:250`) and on `compose-handle.ts:42`.
- **Daemon side, for a voice turn** (any daemon: the worker, a pod, `serve` — including `serve` on the laptop that the phone reaches):
  - (a) `ChatRequest.reasoning = "off"` on that turn's rounds **until its first tool call**; after it, the configured reasoning (Q5's split, a deterministic rule);
  - (b) one **transient** system line on those rounds only: "The user is listening, not reading: short spoken sentences, a short first sentence, no code blocks unless asked." It is **never** in the history, `session/log`, `<uid>.jsonl` or the `serve` daemon's store (AGENTS §7).
- `WireChatRequestSchema.reasoning?: "off"`, for pods (`run`/`attach`) whose model call comes back to the laptop's provider. The phone never needs it, because `serve` holds the provider.
- **Providers:**
  - **OpenAI-compatible:** `reasoning_effort:"none"` + `chat_template_kwargs:{enable_thinking:false}`. A 400 → one retry without them, remembered per provider for the session (F9).
  - **Anthropic:** a no-op.
- **The C3 assumption to prove first:** the agent loop builds one turn's `ChatRequest` in one place, so (a)/(b) need no history change. If not, STOP and fix this plan.

**5. Phone edge: native module additions (`apps/mobile/modules/tentacle-speech/ios/`, on mobile-voice's module).**

- **The session for the whole mode:** `.playAndRecord`, mode `.voiceChat` (or `.default` + `inputNode.setVoiceProcessingEnabled(true)` — P1 picks the one that cancels better). Options `.defaultToSpeaker` and `.allowBluetoothHFP`, plus `.allowBluetoothA2DP` if P1 shows HFP-free output with the phone mic. **No category switch** between listening and speaking, unlike `SpeechCore.swift:182-184` vs `:243`.
- **`ConversationEngine.swift`:**
  - one `AVAudioEngine`, kept running while the mode is on;
  - the input tap feeds a level meter (RMS → speech yes/no, with a raised threshold while playing) and the `SFSpeechRecognizer` request, reusing `RecognizerEngine`'s on-device guard (`:41`, `:81`) and its 50 s rollover (`:74`);
  - an utterance = a new recognition segment, opened at speech onset and closed by the core fold's `stop` (sent down as `endUtterance`);
  - TTS = `AVSpeechSynthesizer.write` → `AVAudioPlayerNode` on the same engine;
  - barge-in = N speech windows while playing → stop the player node, emit `bargein`.
  - iOS 26 devices may use `SpeechAnalyzer` the same way. It is not required: the owner's phone is 18.3.1.
- **Events to TS** (`speech-native.ts` gains them): `utter`, `level{speech}`, `textGrew`, `final{text, lang}`, `speaking/spoken{seq}`, `bargein`, `interrupted{began|ended, shouldResume}`, `route{reason, output}`, `error{code}`.
- **Interruptions:** `.began` → stop the engine and the player, emit `interrupted{began}`. `.ended` → emit `interrupted{ended, shouldResume}` and **do not** restart the mic by itself (P-F1).
- **Route changes:** any reason → rebuild the engine on the new route (input/output format) and keep the mode on, with a notice. A failure → mode off + notice.
- **Background/lock (Owner Q6, gated by E11):**
  - v1 default **foreground-only**: `AppState` `background` → mode `paused` (mic released). The screen is kept awake while the mode is on (an idle-timer toggle in the module; no new dependency).
  - If the owner chooses background: `UIBackgroundModes: ["audio"]` written by `app.plugin.js` (the same single-writer rule mobile-voice uses for plist keys), and the engine kept running when the app is backgrounded or the screen locks. The orange mic indicator stays visible (an iOS rule).
- **Mobile-voice coexistence:** the read-aloud button and push-to-talk dictation keep their current code path. The `SpeechCore` arbiter gains the rule "conversation mode owns the session": starting it stops both, and they are disabled while it is on.

**6. Phone edge: wiring (TS).**
- `apps/mobile/src/conversation-controller.ts`: like `voice-controller.ts` (`createVoiceController`, `:86`), one per mounted session screen. It feeds the core reducer from native events + the session's turn events + the permission sheet's pending ask + link status, and executes effects: `prompt`/`enqueue` through the outbox/compose handle with `voice:true`, and `speak`/`hush` to native.
- Render only: `SessionScreen.tsx` (controller lifetime), `Composer.tsx` (waveform button), the existing capsule (states), `SettingsScreen.tsx` (voice-mode section: barge-in on/off, speaking rate already exists).

### Files (dependency order)

1. **C2 — core:** `packages/core/src/voice/{endpoint,speakable,chunker,narration,ask-speech,conversation,voice-lang}.ts` + export; tests in `packages/core/test/voice/`. The mobile `speakable.ts` then imports `clean`/`splitLong` from core (no behaviour change; its tests stay green).
2. **C3 — profile:**
   - `packages/protocol/src/session.ts` (`voice` on prompt + enqueue) and `packages/protocol/src/model.ts` (`reasoning`); the merge's `protocol:bump` regenerates `protocol.json` (no note);
   - `packages/core/src/model.ts`;
   - the agent loop's request builder (path pinned in C3 step 1);
   - the daemon prompt/enqueue handlers;
   - `packages/providers/src/openai-provider.ts`;
   - the `ProxyModelProvider` wire mapping;
   - `packages/client/src/remote-session.ts`.
3. **C1 — Mac helper v2:** `native/voice-mac/Sources/TentacleVoice/{Listen,Tts,BargeIn,Earcon}.swift`, protocol v2, `trace` with TTS playback; Swift tests (`voice:test`, outside `bun run check`).
4. **C4 — TUI:** `packages/config/src/schema.ts` (`voice.conversationKey`, `tts`, `ttsVoice`, `ttsRate`, `bargeIn`, `bargeInThreshold`, `earcon`, `conversationIdleMinutes`); `packages/tui/src/{voice-protocol,voice-view,useVoice}.ts` (adapter to the core reducer), `keys/layer-voice.ts`, `commands` (`/voice`), `components/VoiceStrip.tsx`.
5. **P2 — phone native:** `apps/mobile/modules/tentacle-speech/ios/ConversationEngine.swift`, `SpeechCore.swift` (arbiter + session config + interruption/route), `TentacleSpeechModule.swift` (functions/events), `app.plugin.js` (only if Q6 = background); `src/speech-native.ts`, `src/speech-native-expo.ts`.
6. **P3 — phone wiring:** `apps/mobile/src/conversation-controller.ts`; `src/outbox.ts` + `outbox-driver.ts` + `compose-handle.ts` (`voice`); `screens/SessionScreen.tsx`, `ui/Composer.tsx`, `ui/Icon.tsx`, `screens/SettingsScreen.tsx`, `voice-settings-store.ts`; tests in `apps/mobile/test/`.
7. **C5/P4:** `changelog.d/voice-conversation.added.md`; README "Voice conversation" (Mac + iPhone); `modules/tentacle-speech/README.md` real-device checklist.

### Failure modes

**Both edges / session**

| # | Failure | Design / convergence |
|---|---|---|
| F1 | **False barge-in loop** (hears itself) | Raised threshold + N windows while playing (spike-pinned per edge). More than 3 barge-ins in 30 s with empty transcripts → barge-in auto-off for this mode, with a notice ("echo detected; Esc / tap stops speech"). Half-duplex fallback per the load-bearing assumptions. |
| F2 | **Comma pause ends the turn early** | Comma-safe floor per edge, plus the V1 T3 regression in core. A cut utterance is sent; the rest follows as a steer (split, never lost). |
| F3 | **Utterance while a turn runs** | `session/enqueue{voice}` (steering), never a second prompt. |
| F4 | **Link drop mid-reply** (Mac `connect`/pods; phone relay) | The turn feed errors or the link goes down → hush, speak "connection lost", mode → `paused` (no sends). On reconnect: "reconnected", mode back to listening. **The missed remainder is not re-spoken**: it is on screen after the existing resync. The session continues daemon-side (detach, not close). A phone voice prompt sent while down stays in the outbox (existing retry) and is spoken when its turn streams. |
| F5 | **Long reply** | Speak ≤ `maxSpokenChars` (1 200), then "the rest is on screen". |
| F6 | **Spoken "yes" during an ask** | Never an approval. While an ask is pending nothing is sent (field + notice). The ask is spoken from the answering device's own request, preempting other speech, and answered by key/tap only. |
| F7 | **Pod-supplied text in speech** (Mac `run`/`attach`) | Reply text goes through `speakable` (stripped, capped), the same as what is displayed. Narration uses tool names only. Asks come from the laptop broker. No other daemon string reaches speech. |
| F8 | **TTS voice missing / error** | System default voice + one notice; a failed chunk is skipped (it is on screen). |
| F9 | **Provider rejects the reasoning parameters** | One retry without them, remembered, one notice. Never a failed turn. |
| F10 | **Transient voice line leaks into persistence** | It is added only to the outgoing `ChatRequest`. Tests on the laptop file **and** the `serve` store (T6). |
| F11 | **Version skew** | `voice`/`reasoning` stripped by an older peer → a normal turn. A phone app older than `serve`, or the reverse: the same. |
| F12 | **Raw terminal writes** (Mac) | As V1: helper stdio piped, stderr to a log, notices through `pushNotice`. |
| F13 | **Edge audio engine dies** (helper crash / native error) | Mode off + notice; the in-flight turn is unaffected. Mac: V1's 3-in-60 s rule. |
| F14 | **Phone and Mac in voice mode on the same session** | Each is a client; utterances queue as prompts/steers in arrival order (existing semantics). **Only the edge that started (or voice-steered) a turn speaks it.** The other edge shows it and stays silent, so two devices in one room never talk over each other. An ask is spoken by the edge that originated the turn and answerable on any device that shows it (existing broker rules). Owner Q7. |
| F15 | **Idle mode left on** | 10 min with no speech → mode off. |

**Phone-specific**

| # | Failure | Design / convergence |
|---|---|---|
| P-F1 | **Phone call / Siri / another app takes the audio** | `interrupted{began}` → engine and player stopped, mode `paused` with "voice paused (call)". On `ended`, the mic is **not** restarted by itself (a call may end in a pocket): a tap resumes. Nothing in flight is lost (the turn continues daemon-side; its text is on screen). |
| P-F2 | **Route change: AirPods/Bluetooth in or out, HFP switch** | The engine is rebuilt on the new route (the formats change with HFP), with the same mode and a notice "audio: AirPods". If AirPods are pulled out mid-speech, speech stops (an iOS convention) and listening continues on the built-in mic. A rebuild failure → mode off + notice. E8 measures barge-in on each route. |
| P-F3 | **App backgrounded** | Foreground-only (default): mode `paused`, mic released, and a return shows "tap to resume" (never a silent auto-resume). Background (if Q6): the engine keeps running under `UIBackgroundModes: audio`. If iOS still suspends it (E11), the reducer gets `interrupted` and converges as P-F1. |
| P-F4 | **Screen lock** | Foreground-only: the screen is kept awake while the mode is on; a manual lock = backgrounded (P-F3). Background mode: per E11's result. |
| P-F5 | **Relay drop mid-reply** | F4. The relay sees only ciphertext of text frames; no audio exists to resend. |
| P-F6 | **On-device recognition missing** (Step 0 (a) false for a language) | `unavailable` card (mobile-voice F1 wording). **Never a network recogniser** (the TS and Swift refusals of mobile-voice are reused). Voice mode for that language is disabled; the other language may still work. |
| P-F7 | **Push-to-talk / read-aloud collide with the mode** | The arbiter: the mode owns the session; the mic and speaker buttons are disabled while it is on. |
| P-F8 | **Screen unmount mid-mode** | The controller's `dispose` emits `unlisten` + `hush` first, then removes its listener (the mobile-voice pattern, `voice-controller.ts:7`). |

### Spikes (owner-assisted; results pasted into Execution with device, OS, date)

**C1 — Mac (gates C4):** E6 live per `realtime-media.md:791-800`. Built-in speakers, AirPods, and Mac mic + AirPods output: false barge-ins over 5 min of the assistant speaking, stop latency p50/p95 (log timestamps), system-voice first audio. Plus Kokoro-in-Swift feasibility and license.

**P1 — iPhone 12 Pro, iOS 18.3.1 (gates P2 and P3).** Scratch only (`.tentacle/tmp/voice-conversation/`), a dev build with a throwaway screen; nothing lands in the tree.

| # | Spike | Measures | Pass |
|---|---|---|---|
| **E10** | **On-device STT and TTS.** `supportsOnDeviceRecognition` for it-IT and en-US (mobile-voice Step 0 (a)); 20 owner utterances per language (comma pauses, technical words: "typecheck", "parser", "branch"), read live; 5 min continuous across the 50 s rollover. `AVSpeechSynthesizer.write` first buffer for a ≤ 4-word chunk, it/en. | on-device yes/no per language; first partial and final latency after end of speech (p50/p95); WER per language; rollover gaps/duplicates; TTS first-buffer p50 | on-device for both; final ≤ 500 ms p50 after end of speech; WER it ≤ 0.10, en ≤ 0.07 (owner's ear also decides); no rollover loss; TTS first buffer ≤ 300 ms |
| **E8** (re-scoped) | **AEC + barge-in on the loudspeaker.** The eval's E8 (`react-native-webrtc`) belongs to candidate C/V5 and is not needed for B, so the slot is reused. Voice processing on, TTS through the engine; the assistant speaks for 5 min with nobody talking; then 10 barge-ins; repeat on AirPods and on wired/none. The speech-detection source (level gate vs recogniser activity) and the floor are also pinned here. | false barge-ins / 5 min; stop latency p50/p95 (log timestamps); the comma-pause lengths in the owner's speech | < 1 / 5 min; stop < 100 ms p50; floor ≥ 2× the longest comma pause |
| **E7** | **Relay round trip on cellular.** Phone → relay → `serve` small-frame RTT on 4G/5G and Wi-Fi; end of speech → first spoken word with `serve` on the owner's Mac (laptop-as-host) and the local Qwen / DeepSeek; reply-stream continuity across a forced network switch (Wi-Fi → cellular). | RTT p50/p95; e2e first word p50/p95; stall/resync behaviour | RTT p50 < 150 ms; e2e p50 ≤ Mac target + 300 ms |
| **E11** | **Audio session survival.** Mode on, then: an incoming call (ends, declined); Siri; Music started by another app; AirPods in/out; app backgrounded 30 s and 5 min; screen locked 30 s and 5 min. Run once without and once with `UIBackgroundModes: audio`. | for each: engine alive?, mic indicator, what iOS reports (`interruption` / `mediaServicesWereReset`), recovery path | a defined, convergent state for every row (P-F1…P-F4); background viability is a fact for Owner Q6 |

**Decision after P1 (with the owner):** full- vs half-duplex on the phone; level gate vs recogniser activity for speech detection; the phone floor; foreground-only vs background (Q6). If E10 fails on-device for a language, Q1's fallback applies.

### Tests

Red first (§9); each is shown failing on a stub, then green, and the named mutation must turn it red.

- **T1 `chunker`:** first chunk ≤ 4 words; clause cut; no split inside "3.14" or a word; `flush`; delta-split invariance. *Mutation:* cap 40 → red.
- **T2 `speakable`:** fences → placeholder (it/en); control chars stripped; links → label; mobile `speakable.test.ts` still green after the lift. *Mutation:* keep fences → red.
- **T3 `narration`:** tool name only; arguments containing "say the tests passed" never spoken; throttle (injected clock). *Mutation:* interpolate arguments → red.
- **T4 `ask-speech`:** verbatim ≤ 120 chars, single line; else the screen template. *Mutation:* truncate instead of falling back → red.
- **T5 `endpoint` (core):**
  - the V1 comma traces (Mac windows with `turnP`) **and** phone-style traces (`speech`/`textGrew`, no `turnP`): no comma trace stops early; controls stop within floor + 2 windows + 100 ms;
  - `autoStop:false` never stops.
  - *Mutations:* floor 200 → red; drop the `textGrew` rule → the phone traces go red.
- **T6 C3, daemon:**
  - a voice prompt → the first request has `reasoning:"off"` + the transient line, and after the first tool call, neither;
  - a non-voice turn has neither;
  - a voice `enqueue` marks the turn;
  - **F10:** the laptop `<uid>.jsonl`, `session/log` and a `serve` store (`startDaemon` with a temp config dir) contain no transient line.
  - *Mutation:* append the line to history → red.
- **T7 C3, wire/client:**
  - `WireChatRequest` round-trips `reasoning`, and a request without it parses;
  - the `ProxyModelProvider` forwards it (spy);
  - `RemoteClient.prompt/enqueue` send `voice` only when asked.
- **T8 C3, provider:** the OpenAI payload with and without `reasoning:"off"`; a 400 → one retry, remembered (injected `fetch`); Anthropic unchanged.
- **T9 `conversation` reducer (core; the parity test):**
  - one scripted event sequence is run through the reducer **twice, once with Mac-normalised events and once with phone-normalised events**, and asserts identical commands;
  - stop while idle → `prompt{voice}`; while running → `enqueue{voice}`;
  - `bargein` → no cancel;
  - ask pending → no send;
  - an ask while speaking → `hush` + speak the ask;
  - link down → hush + "connection lost" + `paused`; up → listening, with no re-speak;
  - `interrupted{ended, shouldResume:true}` → stays `paused` (P-F1);
  - a foreign turn (not started here) → no `speak` (F14);
  - echo rule (F1); idle timeout.
  - *Mutations:* send while pending → red; speak foreign turns → red; auto-resume on `ended` → red.
- **T10 TUI** (`ink-testing-library`, fake spawner): `/voice` → `listen`; `utter`/`final` → a prompt with `voice:true`; deltas → ordered `speak`; Esc while speaking → `hush`, no abort; Esc otherwise → abort. **`route.test.ts`**: Esc precedence; the toggle behind a dialog → pass.
- **T11 phone controller** (`bun test`, fake native port, the mobile-voice `voice-controller.test.ts` pattern):
  - waveform → `listen`; native `final` → an outbox item with `voice:true`; a steer → `compose-handle` enqueue with `voice:true`;
  - `AppState background` → `unlisten` + `paused` (foreground-only);
  - `dispose` → `unlisten` + `hush` before the listener is removed;
  - the arbiter disables the mic/speaker buttons.
  - *Mutation:* forget `voice` on the outbox item → red.
- **T12 phone outbox:** an item with `voice` survives a store reload (`outbox-store.ts`), and an old item without it loads.
- **Swift:**
  - Mac (`voice:test`): protocol v2; `hush` stops within one buffer; `trace` with TTS + speech → `bargein`; TTS only → none.
  - Phone: a unit-testable `BargeInGate` (windows → decision) and the route/interruption mapping as pure Swift functions, tested in the module's test target if mobile-voice set one up. Otherwise they are covered by P4's checklist, and that is stated in Execution.
- **Maestro:** the waveform button appears, toggles state, and is hidden when on-device recognition is unavailable (no audio assertions; Maestro cannot speak).

### Slices

| Slice | Size · Blast | Suited | What | Gate / exit |
|---|---|---|---|---|
| **C2 shared core** | M · contained | owner assigns; standard review | §3 modules; T1–T5, T9 | `bun test packages/core/test/voice` green; mutations logged |
| **C3 voice-turn profile** | M · **load-bearing** | owner assigns; **fresh-context review** (§7 persistence, forward-compat, model-on-laptop) | §4; T6–T8 | `bun run check` green |
| **C1 Mac spike** | S · contained (scratch) | owner at the Mac | E6 live, TTS-in-engine, Kokoro feasibility | numbers in Execution; Mac full/half-duplex decided |
| **C1b Mac helper v2** | M · contained | owner assigns | §2; Swift tests | `voice:test` green; `trace` matches C1 |
| **C4 Mac TUI wiring** | M · cross-module | owner assigns; standard review | config, adapter, layer, `/voice`, strip; T10 | `bun run check` green |
| **P1 phone spike** | S · contained (scratch) | owner with the iPhone 12 Pro | E10, E8, E7, E11 | numbers in Execution; phone decisions taken (above). **Gates P2/P3.** |
| **P2 phone native** | M · cross-module (the app-wide `AVAudioSession`) | owner assigns; **fresh-context review** of the audio session owner (P-F1…P-F8) | §5; Swift pure-function tests | builds on iOS 18/26 simulators; E8/E11 behaviour reproduced on the phone |
| **P3 phone wiring** | M · cross-module | owner assigns; standard review | §6; T11, T12, Maestro | `bun run check` + `bun run e2e:mobile` (18 and 26) green |
| **C5 Mac live** | S · contained | owner at the Mac | L1–L9 below | every item ticked |
| **P4 phone live** | S · contained | owner with the iPhone | PL1–PL10 below | every item ticked |

**Order:** C2 → C3 → (C1 → C1b → C4 → C5) ∥ (P1 → P2 → P3 → P4). The two spikes may run as soon as the plan is approved, even before V1/mobile-voice merge (scratch only). Code slices wait for their base (Owner Q1).

**Latency targets** (end of user speech → first audible word; re-taken in the spikes):

| Path | p50 | p95 |
|---|---|---|
| Mac, local Qwen, warm | ≤ 1.2 s | reported |
| Mac, DeepSeek, warm | ≤ 2.0 s | reported |
| Phone → `serve` on the Mac, local Qwen, Wi-Fi | ≤ 1.5 s | reported |
| Phone → `serve`, DeepSeek, cellular | ≤ 2.3 s | reported |
| Barge-in stop, either edge | ≤ 100 ms | ≤ 150 ms |

**Mac live checklist (C5):**
- **L1** ten it/en turns, local model and DeepSeek;
- **L2** five barge-ins;
- **L3** 5 min with no false barge-in on speakers, AirPods, and Mac mic + AirPods output;
- **L4** an ask spoken verbatim, a spoken "yes" ignored, a key answers;
- **L5** Esc stops speech, a second Esc aborts;
- **L6** a `run` pod session works, with no helper in the pod;
- **L7** offline with a local model;
- **L8** no audio file, and no transient line in `<uid>.jsonl`;
- **L9** `ssh localhost` → notice.

**Phone live checklist (P4, iPhone 12 Pro, iOS 18.3.1):**
- **PL1** ten it/en turns to `serve` on the Mac over Wi-Fi, then five over cellular;
- **PL2** five barge-ins on the loudspeaker, then on AirPods;
- **PL3** 5 min of the assistant speaking with no false barge-in;
- **PL4** an incoming call mid-reply: paused, and no auto-resume after it;
- **PL5** AirPods in and out mid-mode;
- **PL6** background and lock behave per Q6;
- **PL7** Wi-Fi → cellular mid-reply: "connection lost" → "reconnected", text complete on screen;
- **PL8** an ask spoken, a "yes" ignored, a tap answers;
- **PL9** phone and Mac both in voice mode on one session: only the originating device speaks each reply;
- **PL10** after a session, `serve`'s store has no transient line, and the app has no audio file in its container.

### Owner questions

1. **Order and fallback.** V2's code slices start only after `feat/voice-dictation` and `feat/mobile-voice` are merged; both spikes (Mac C1, phone P1) may run right after approval. If the iPhone has no on-device recognition for a language (E10), that language gets no phone voice mode (never a cloud recogniser). *Recommendation: yes to both.*
2. **Reasoning off for spoken replies (new plumbing, slice C3).** A per-turn `voice` flag, sent by both edges; reasoning off until the turn's first tool call; a short "speak, don't write" note that is never saved. It is additive, with no protocol bump, and the same for the TUI and for phone prompts to `serve` (including `serve` on your Mac). *Recommendation: yes, with a mandatory fresh-context review.*
3. **Send automatically when you stop talking (conversation mode only, both edges).** Push-to-talk dictation keeps never auto-sending. *Recommendation: yes*, with a comma-safe pause measured on your own voice in each spike.
4. **What talking over a reply does.** *Recommendation: it stops the speech only; what you say goes to the running turn as a steer, and nothing is cancelled.* Esc / the stop button stops speech; a second press aborts, as today.
5. **Reply voice: the system voice on both Mac and iPhone** (parity, no download, plays inside the audio engine so echo cancellation works). Kokoro becomes a Mac option only if the spike shows a working Swift path with a clean license. *Recommendation: yes.*
6. **iPhone background and lock screen.** *Recommendation: v1 is foreground-only, with the screen kept awake while voice mode is on;* background/lock-screen audio (`UIBackgroundModes: audio`, a visible mic indicator) only if E11 proves it survives calls, locks and route changes and you want it.
7. **Phone and Mac in voice mode on the same session.** *Recommendation: only the device that started or voice-steered a turn speaks its reply;* the other shows it silently, and an approval can be answered on whichever device shows it.
8. **How to turn the mode on.** *Recommendation: Mac — `/voice` plus a rebindable key (Ctrl+G if the spike shows it free); iPhone — a waveform button next to the mic.* On both, it stays on until toggled off, 10 min of silence, or (phone) leaving the session screen.

## Execution

*(empty — the plan is not yet approved)*

## Review

*(empty)*
