# feat/voice-conversation — Hands-free voice conversation on the Mac and the iPhone (realtime-voice V2, both edges)

> **Status:** implementation APPROVED by the owner (2026-11-15)
> **Branch:** `feat/voice-conversation`
> **Size:** L as a whole. It is one task doc because the owner asked for one, and it is **eleven slices, each S or M**, executed and reviewed slice by slice (table in *Slices*). Order: shared pure core → Mac edge ∥ phone edge → live. No slice is XL. · **Blast:** load-bearing. C3 adds a per-turn field to `session/prompt` / `session/enqueue` and to `model/stream`'s request, and touches the agent loop's model call. P2b puts the app in the background with the mic on. The other slices are contained or cross-module (per slice below). · **Suited:** owner assigns, per slice. L + load-bearing ⇒ a **mandatory fresh-context Review**. It must red-team: §6.1 (who speaks an ask, F6/F7), "never write raw to the terminal" (F12), C3's on-disk rule (nothing transient persisted, F10), the phone's single owner of `AVAudioSession`, and background compliance (P-F1…P-F12, App Review 2.5.4).
> **Changelog:** `changelog.d/voice-conversation.added.md`: "- **Hands-free voice conversation on the Mac and the iPhone.** Turn on voice mode, talk to tentacle, hear the reply, and speak over it to interrupt. On the iPhone it keeps going with the app in the background or the screen locked. Recognition and speech run on the device; only text reaches the session, and no audio is saved. Turning reasoning off for spoken replies is a setting on both."

## Context

*— claude-opus-5-5, 2026-11-15 (rev 2, 2026-11-15: phone edge added — owner: "anche con supporto mobile"; Mac/phone parity is an owner rule. Rev 3, 2026-11-15: owner answers Q1–Q7 applied — reasoning-off is a user setting on both edges (Q2); iPhone background + locked screen is in v1, "background subito" (Q6))*

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
- **Q6, topology:** Mac voice runs in a local terminal only (Swift helper); over SSH it is off with a notice. The phone is the voice edge for remote sessions. Only text goes over the E2E channel. The eval said "background/lock-screen audio to be verified by E10". **Superseded by this task's owner answer Q6 (batch 2): background + locked screen are IN v1.** E11 tunes the design; it cannot cancel it.
- **This task's own owner answers (end of doc, batches 1–2):**
  - Q1: code after V1 + mobile-voice merge; never a cloud recogniser.
  - Q2: reasoning-off is a **user setting** on both edges (Mac config + an iPhone Settings row), not hard-wired.
  - Q3: auto-send in conversation mode only.
  - Q4: barge-in = stop speech + steer, never cancel.
  - Q5: system voice on both edges, Kokoro Mac opt-in.
  - Q6: background now.
  - Q7: only the originating edge speaks.
  - Q8 (activation UI) is open, with mockups.
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
| **Interruptions** | `.began` only: abort + stop speaking (`SpeechCore.swift:304-309`). `.ended` is ignored. | the policy per interruption source (§5b): pause on began; resume on ended only when iOS says `shouldResume` and the source was not a phone call (P-F1) |
| **Route changes** | `.oldDeviceUnavailable` only, which aborts (`:311-316`) | re-configure on any route change (AirPods in/out, HFP), keep the mode alive |
| **Background / locked screen** | no `UIBackgroundModes` in `app.json` (`grep -i audio` finds only the mic permission string, `:32,39`). `AppState` background stops dictation (mobile-voice F6). The session is deactivated when idle (`SpeechCore.swift:299-302`). | **in v1 (owner Q6)**: the `audio` background mode, one session active for the whole mode, recognition kept alive across segments in the background, a lock-screen indication, and compliance with App Review 2.5.4 (§5b) |
| **Lock-screen indication** | none (the Live Activity task is approved but not started: `docs/feat/mobile-live-activity.md` on `main`, status "APPROVED", starts after `feat/mobile-notifications`) | Now Playing + remote commands now; a `voice` state in that task's Live Activity when it lands (§5b) |
| **Speakable text** | an AST walk over the phone's own markdown parser: `speakable(parsed, lang)` (`src/speakable.ts:132`), with `clean` (`:56`) and `splitLong` (`:96`, `MAX_UTTERANCE` 600 `:23`) | streaming: the reply arrives as deltas. The core chunker (§3) consumes text on both edges. `clean`/`splitLong` are lifted into core; the AST walk stays for the read-aloud button. |
| CarPlay, AirPods-specific gestures | none | **not required** (owner): out of scope |

## Implementation

*— claude-opus-5-5, 2026-11-15 (rev 2, 2026-11-15: phone edge, shared reducer and endpoint fold moved to core, slices re-sized. Rev 3, 2026-11-15: §4 reasoning-off becomes a per-edge user setting carried per turn; §5 split into §5a (engine) and §5b (background, locked screen, interruptions, lock-screen indication, battery, App Review 2.5.4); E11 is a tuning input; P2 split into P2a/P2b; failure modes and tests updated)*

### Load-bearing assumptions (one per edge; each is a spike's exit criterion)

**Mac (C1).** With the helper's TTS played through the same voice-processing `AVAudioEngine`, the VAD hears the user and not the assistant. Pass: < 1 false barge-in per 5 min, and playback stopped < 100 ms after real speech (E6 criteria, `realtime-media.md:485`). Proven so far only on a tone (74 dB, `:777-781`).

**Phone (P1).** On the owner's iPhone 12 Pro, iOS 18.3.1, three things must hold:
1. `SFSpeechRecognizer` runs **on device** for it-IT and en-US.
2. With voice processing on the engine's input and `AVSpeechSynthesizer.write(_:toBufferCallback:)` buffers played through **that engine's** player node, speech from the **loudspeaker** does not trigger the recogniser's or the level gate's speech detection. Same pass numbers as the Mac.
3. ~~The audio session survives what the mode must survive~~. **Rev 3:** background is in v1 by owner decision, so this is no longer a pass/fail gate. E11 measures *how* the session behaves (which interruptions resume by themselves, whether recording can restart from the background, battery per hour). It tunes §5b's policies within the convergent states P-F1…P-F12. It cannot remove background from the slice.

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
| off | the activation in **Owner Q8** (open; mockups) | the activation in **Owner Q8** (open; mockups) | mode on: listening continuously, with the indicator chosen in Q8 |
| listening | user speaks, the fold says `stop` | same | transcribe → **auto-send** (Owner Q3): `prompt{voice:{reasoning}}` if idle, `enqueue{voice:{reasoning}}` if a turn runs (`reasoning` from the edge's own setting, §4) |
| speaking | user speaks (barge-in) | same | playback stops at once, edge-local; the utterance is sent as above. **The turn is not cancelled** (Owner Q4). |
| speaking | Esc | tap the capsule | stop speech. A second Esc / the stop button aborts the turn, as today. |
| ask pending | user speaks | same | **not sent**: the text goes to the field with "answer the approval first" (F6) |
| any | toggle again, or 10 min with no speech | same, or the Now Playing / Live Activity stop control. **Leaving the session screen, backgrounding the app or locking the screen does NOT end it** (Q6). | mode off: mic released, indicator off |

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

**4. Voice-turn profile (C3; Owner Q2 answered: a user-settable switch on both edges) — the same for Mac- and phone-originated turns.**

- **The switch is per edge, owned by the person, and carried per turn.**
  - **Mac:** config `voice.reasoningOff: boolean`, default `true`, also listed in the TUI's `/settings`.
  - **iPhone:** a Settings row "Reasoning off for spoken replies", default on, stored in `voice-settings-store.ts` (the mobile-voice store) next to the speaking rate.
  - Each edge reads its own value **at send time** and puts it on the turn.
  - The daemon stores nothing and has no switch of its own. So a phone talking to `serve` on the Mac (laptop-as-host), or to a `serve` elsewhere, gets exactly what the phone's row says, and a TUI on the same session keeps its own. No settings sync, no new RPC.
- **The fields:** `PromptParams.voice?: { reasoning: "off" | "keep" }` and `EnqueueParams.voice?` (the same shape, additive). Present = a voice turn, which always gets the spoken-style line (b). `reasoning` decides (a). An enqueued voice steer marks the rest of its turn as a voice turn, with the steer's `reasoning`.
- **The client API:** `RemoteClient.prompt/enqueue` take the option (`packages/client/src/remote-session.ts:1025-1041,1320`).
- **The phone carries it** on its outbox item (`apps/mobile/src/outbox.ts:83-94` → `outbox-driver.ts:250`) and on `compose-handle.ts:42`. A retried outbox item keeps the value chosen at compose time.
- **Daemon side, for a voice turn** (any daemon: the worker, a pod, `serve` — including `serve` on the laptop that the phone reaches):
  - (a) when `reasoning: "off"`: `ChatRequest.reasoning = "off"` on that turn's rounds **until its first tool call**; after it, the configured reasoning (Q5's split, a deterministic rule). With `"keep"`, the configured reasoning throughout;
  - (b) one **transient** system line on those rounds only: "The user is listening, not reading: short spoken sentences, a short first sentence, no code blocks unless asked." It is **never** in the history, `session/log`, `<uid>.jsonl` or the `serve` daemon's store (AGENTS §7).
- `WireChatRequestSchema.reasoning?: "off"`, for pods (`run`/`attach`) whose model call comes back to the laptop's provider. The phone never needs it, because `serve` holds the provider.
- **Providers:**
  - **OpenAI-compatible:** `reasoning_effort:"none"` + `chat_template_kwargs:{enable_thinking:false}`. A 400 → one retry without them, remembered per provider for the session (F9).
  - **Anthropic:** a no-op.
- **The C3 assumption to prove first:** the agent loop builds one turn's `ChatRequest` in one place, so (a)/(b) need no history change. If not, STOP and fix this plan.

**5a. Phone edge: the engine (`apps/mobile/modules/tentacle-speech/ios/`, on mobile-voice's module).**

- **`ConversationEngine.swift`:**
  - one `AVAudioEngine`, kept running for the whole mode, in the foreground and the background alike;
  - the input tap feeds a level meter (RMS → speech yes/no, with a raised threshold while playing) and a **500 ms pre-roll ring buffer**;
  - **at speech onset** a new `SFSpeechAudioBufferRecognitionRequest` opens, is fed the pre-roll and then live buffers, and closes at the core fold's `stop` (sent down as `endUtterance`) or at the 50 s rollover (`RecognizerEngine.swift:74`). It reuses the on-device guard (`:41`, `:81`). **Between utterances no recognition task runs** (battery, and fewer long-lived tasks for iOS to kill in the background);
  - TTS = `AVSpeechSynthesizer.write` → `AVAudioPlayerNode` on the same engine;
  - barge-in = N speech windows while playing → stop the player node, emit `bargein`;
  - iOS 26 devices may use `SpeechAnalyzer` the same way. It is not required: the owner's phone is 18.3.1.
- **Events to TS** (`speech-native.ts` gains them): `utter`, `level{speech}`, `textGrew`, `final{text, lang}`, `speaking/spoken{seq}`, `bargein`, `interrupted{began|ended, source, shouldResume}`, `route{reason, output}`, `resumeFailed{code}`, `mediaReset`, `thermal{state}`, `remote{command}`, `error{code}`.
- **Mobile-voice coexistence:** the read-aloud button and push-to-talk dictation keep their current code path. The `SpeechCore` arbiter gains the rule "conversation mode owns the session": starting it stops both, and they are disabled while it is on. Its idle deactivation (`SpeechCore.swift:299-302`) is skipped while the mode is on.

**5b. Phone edge: background, locked screen, interruptions (owner Q6: in v1).**

*Facts this section rests on* (Apple documentation and long-standing platform behaviour, cited by name; **not yet observed on the owner's phone**, so E11 records each one):
- (i) With `UIBackgroundModes` containing `audio`, an app whose audio session is active and whose engine is recording or playing keeps running in the background and on the locked screen. The system shows the microphone indicator while it records.
- (ii) An app generally cannot **start** recording from the background after it was suspended. Resuming from the background after an interruption ends is allowed for apps with the audio mode, but for recording iOS may refuse it (`AVAudioSession.ErrorCode.cannotStartRecording` / `insufficientPriority`).
- (iii) `SFSpeechRecognizer` on device has no documented per-request duration limit. The historical ~1 min limit applied to server recognition. Long tasks can still end with an error, hence the 50 s rollover already in mobile-voice.
- (iv) A phone call, Siri or another app's non-mixable audio interrupts the session (`interruptionNotification`). A media-services reset (`mediaServicesWereResetNotification`) invalidates every audio object.

*Design:*

| Concern | Decision |
|---|---|
| **Background mode** | `UIBackgroundModes: ["audio"]` written by `app.plugin.js` (the single plist writer, the same rule mobile-voice uses for its plist keys; the `Info.plist` grep after prebuild is pasted into Execution). |
| **Purpose strings** | `NSMicrophoneUsageDescription` is reworded once, with the plugin and `app.json` agreeing: "tentacle uses the microphone while you dictate, and while voice mode is on, also with the screen locked. Audio stays on this iPhone." `NSSpeechRecognitionUsageDescription` gets the same "on this iPhone" wording. |
| **Session category, mode, options** | `.playAndRecord`, mode `.voiceChat` (voice processing; P1 may pick `.default` + `setVoiceProcessingEnabled(true)` if that cancels better), options `[.defaultToSpeaker, .allowBluetoothHFP, .duckOthers]`. **Not** `.mixWithOthers`: a mixable session cannot be the Now Playing app, and ducking keeps the reply audible over music. E11 may add `.allowBluetoothA2DP` (phone mic + A2DP output) if it measures better. |
| **Session lifetime** | `setActive(true)` when the mode turns on, in the foreground (fact ii). **Kept active for the whole mode**, including between utterances and while the reply is generated, so the app is never suspended mid-mode. `setActive(false, .notifyOthersOnDeactivation)` only when the mode turns off. No silent-audio keep-alive is ever played: the live recording is what keeps the app running (2.5.4, below). |
| **Recognition in the background** | Per-utterance requests (§5a), 50 s rollover. **Restart policy:** a task that ends with an error opens a new request on the next speech onset. 5 failures in 60 s → `paused` with "speech recognition stopped", plus the lock-screen state. `mediaReset` → rebuild engine, recogniser and synthesiser once; a second reset within 60 s → `paused`. |
| **Interruptions, by source** | began → engine and player stop, mode `paused{source}`. ended: **phone call / FaceTime** (detected via `CXCallObserver`: a call was active during the interruption) → stay `paused`, never reopen the mic after a call by itself. **Siri, alarms, another app's audio** with `shouldResume` → resume listening. If the resume fails (fact ii) → `paused` with "tap to resume". No `shouldResume` → `paused`. |
| **Route changes** | any reason → rebuild the engine on the new route and keep the mode. `oldDeviceUnavailable` while speaking → stop speech (iOS convention), keep listening on the built-in mic. A rebuild failure in the background → `paused`. |
| **Lock-screen indication** | (1) The system mic indicator (always, fact i). (2) **Now Playing** (`MPNowPlayingInfoCenter`): title "tentacle · voice", subtitle the session title, and the state ("Listening", "Thinking", "Speaking", "Paused — tap to resume"). `MPRemoteCommandCenter`: `togglePlayPause` and `pause` = pause/resume the mode (also the AirPods stem press), `stop` = mode off. (3) **Live Activity:** the in-flight `feat/mobile-live-activity` (approved, not started) is the one widget. V2 does **not** build a second one. When that task has landed, P2b adds a `voice` field (`listening \| thinking \| speaking \| paused`) to its `ContentState`, updated **locally** by the running app (`Activity.update` from the app process, no push needed while the app runs), with the same stop/resume intents. If it has not landed when P2b runs, Now Playing alone ships, and the hook is recorded in that task's doc. |
| **Resume from the lock screen** | A remote command or Live Activity intent → `remote{resume}` → the reducer asks native to restart. If iOS refuses recording from the background (fact ii) → the state reads "Open tentacle to resume". The intent then opens the app (`openAppWhenRun`); the resume runs in the foreground. E11 records which path the owner's phone allows. Either way it converges. |
| **Battery & heat** | No recognition between utterances; the meter runs on the tap that the engine already delivers. **Idle off**: 10 min with no speech → mode off (F15), the same in the background. `ProcessInfo.thermalState` `.serious` → notice; `.critical` → `paused`. Low Power Mode → one notice, no change. E11 measures battery % per 30 min (foreground and locked) and pastes it; the README states it. |
| **The link in the background** | The app keeps running, so the relay WebSocket and the outbox keep working, and replies stream and are spoken with the screen locked. When the mode is `paused` in the background, the app may be suspended. The link then drops, and the existing reconnect + resync applies on resume (F4). |
| **Asks with the screen locked** | Spoken by the §6.1 template as usual. The answer needs a tap: the existing permission sheet after unlock, or the Live Activity's Approve/Deny once that task lands (its own Face ID gate). Never by voice. |

*App Review guideline 2.5.4 — how the design stays compliant.* 2.5.4 allows background services only for their intended purposes, and audio is one of them. The `audio` mode is documented for apps that play **or record** audible content in the background. The design keeps to that:
1. The background audio is always a **live, user-started voice conversation**: mic capture and spoken replies, never silence or a keep-alive trick.
2. It runs only while the person has turned voice mode on, with the system mic indicator plus Now Playing (and later the Live Activity) visible on the lock screen.
3. It turns itself off after 10 min with no speech.
4. No background networking happens outside an active voice mode: the session link stays up only as a consequence of the active audio session.
5. The purpose strings say "also with the screen locked".
6. The App Review notes (a release-time item, recorded in the README) explain the feature in one paragraph with steps to try it.

**Residual risk:** a reviewer may still question continuous background recording. The fallback is a review response citing the above, not a design change. The app is pre-public, so this matters at the first App Store submission, not for TestFlight/dev builds.

**6. Phone edge: wiring (TS).**
- `apps/mobile/src/conversation-controller.ts`: **app-scoped**, not per screen (the mode outlives the session screen and the foreground, Q6). It feeds the core reducer from:
  - native events;
  - the session's turn events (the session the mode was started on; that session stays subscribed while the mode is on);
  - the permission sheet's pending ask;
  - link status;
  - `AppState`, which is informational only and no longer pauses.

  It executes effects: `prompt`/`enqueue` through the outbox/compose handle with `voice:{reasoning}` taken from the Settings row, `speak`/`hush` to native, and Now Playing / Live Activity state.
- Render only: `SessionScreen.tsx` (shows the mode when on its session; a banner on other screens), `Composer.tsx` (the Q8 activation), the existing capsule (states), `SettingsScreen.tsx` (voice-mode section: **reasoning off for spoken replies** (default on), barge-in on/off, auto-off after 10 min, and the existing speaking rate).

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
4. **C4 — TUI:** `packages/config/src/schema.ts` (`voice.reasoningOff` (default true), `voice.conversationKey`, `tts`, `ttsVoice`, `ttsRate`, `bargeIn`, `bargeInThreshold`, `earcon`, `conversationIdleMinutes`); `packages/tui/src/{voice-protocol,voice-view,useVoice}.ts` (adapter to the core reducer), `keys/layer-voice.ts`, `commands` (`/voice`), `components/VoiceStrip.tsx`.
5. **P2a — phone engine:** `apps/mobile/modules/tentacle-speech/ios/ConversationEngine.swift` (engine, pre-roll, per-utterance requests, TTS in engine, barge-in), `SpeechCore.swift` (arbiter, mode session), `TentacleSpeechModule.swift` (functions/events); `src/speech-native.ts`, `src/speech-native-expo.ts`.
6. **P2b — phone background:** `ios/BackgroundAudio.swift` (session lifetime, the interruption policy with `CXCallObserver`, route rebuild, media reset, thermal), `ios/NowPlaying.swift` (`MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`), `app.plugin.js` (`UIBackgroundModes: audio`, purpose strings), `app.json` (the same purpose strings, agreeing); the Live Activity `voice` field only if `feat/mobile-live-activity` has landed (else a note in that doc).
7. **P3 — phone wiring:** `apps/mobile/src/conversation-controller.ts` (app-scoped); `src/outbox.ts` + `outbox-driver.ts` + `compose-handle.ts` (`voice:{reasoning}`); `screens/SessionScreen.tsx`, `ui/Composer.tsx`, `ui/Icon.tsx`, `screens/SettingsScreen.tsx`, `voice-settings-store.ts` (`reasoningOff`, `bargeIn`); tests in `apps/mobile/test/`.
8. **C5/P4:** `changelog.d/voice-conversation.added.md`; README "Voice conversation" (Mac + iPhone, battery figure, background behaviour, App Review notes paragraph); `modules/tentacle-speech/README.md` real-device checklist.

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
| P-F1 | **Phone call / FaceTime** (foreground or locked) | `interrupted{began}` → engine and player stop, mode `paused{call}`, Now Playing "Paused — call". On `ended`, the mic is **never** reopened by itself after a call (it may end in a pocket); a tap (app, Now Playing, Live Activity) resumes. The turn continues daemon-side, and its text is on screen. |
| P-F1b | **Siri / alarm / another app's audio** | began → `paused{other}`. ended with `shouldResume` → resume listening. If the resume fails in the background (fact ii) → `paused` "tap to resume". Another app that keeps playing (no ended) → stays paused until a tap. |
| P-F2 | **Route change: AirPods/Bluetooth in or out, HFP switch** (also while locked) | The engine is rebuilt on the new route (the formats change with HFP), with the same mode and a notice "audio: AirPods". AirPods pulled out mid-speech → speech stops (an iOS convention), listening continues on the built-in mic. A rebuild failure → `paused` (background) or mode off + notice (foreground). E8 measures barge-in on each route. |
| P-F3 | **App backgrounded** | The mode keeps running (Q6): the session stays active, the engine records, replies are spoken. Indication: the mic indicator + Now Playing. If iOS suspends the app anyway (E11 finds a case) → on return, the controller sees a dead engine and converges to `paused` "tap to resume" (never silently off, never a silent auto-restart). |
| P-F4 | **Screen locked** | Same as P-F3. The lock screen shows Now Playing (and later the Live Activity voice state), with pause/resume/stop. Asks need an unlock or the Live Activity buttons, never a voice "yes" (F6). |
| P-F5 | **Relay drop mid-reply** (incl. while locked) | F4: hush, "connection lost", `paused` for sends; the existing reconnect runs in the background because the app is running; on reconnect, "reconnected". The relay sees only ciphertext of text frames; no audio exists to resend. |
| P-F9 | **Recognition task dies in the background** | Restart on the next onset; 5 failures in 60 s → `paused` "speech recognition stopped" on the lock screen. `mediaReset` → one rebuild; a second within 60 s → `paused`. |
| P-F10 | **Resume refused from the background** (fact ii) | `resumeFailed` → the state reads "Open tentacle to resume"; the intent opens the app and resumes in the foreground. |
| P-F11 | **Battery / heat** | Idle off after 10 min with no speech (also locked); thermal `.serious` → notice, `.critical` → `paused`; E11's battery figure in the README. |
| P-F12 | **Mode left on while the person forgets it** (privacy) | The mic indicator and Now Playing are always visible; idle off (P-F11); the mode never starts from the background or by itself after a call. |
| P-F6 | **On-device recognition missing** (Step 0 (a) false for a language) | `unavailable` card (mobile-voice F1 wording). **Never a network recogniser** (the TS and Swift refusals of mobile-voice are reused). Voice mode for that language is disabled; the other language may still work. |
| P-F7 | **Push-to-talk / read-aloud collide with the mode** | The arbiter: the mode owns the session; the mic and speaker buttons are disabled while it is on. |
| P-F8 | **Screen unmount mid-mode / app terminated** | Unmount does **not** end the mode (the controller is app-scoped). App termination (swipe-away, a crash) ends the process and so the capture. On the next launch the mode is off (it is never restored by itself). Disposing the controller (sign-out, pairing removed) emits `unlisten` + `hush` first, then removes its listener (the mobile-voice pattern, `voice-controller.ts:7`). |

### Spikes (owner-assisted; results pasted into Execution with device, OS, date)

**C1 — Mac (gates C4):** E6 live per `realtime-media.md:791-800`. Built-in speakers, AirPods, and Mac mic + AirPods output: false barge-ins over 5 min of the assistant speaking, stop latency p50/p95 (log timestamps), system-voice first audio. Plus Kokoro-in-Swift feasibility and license.

**P1 — iPhone 12 Pro, iOS 18.3.1 (E10/E8/E7 gate P2a and P3; E11 only tunes P2b).** Scratch only (`.tentacle/tmp/voice-conversation/`), a dev build with a throwaway screen; nothing lands in the tree.

| # | Spike | Measures | Pass |
|---|---|---|---|
| **E10** | **On-device STT and TTS.** `supportsOnDeviceRecognition` for it-IT and en-US (mobile-voice Step 0 (a)); 20 owner utterances per language (comma pauses, technical words: "typecheck", "parser", "branch"), read live; 5 min continuous across the 50 s rollover. `AVSpeechSynthesizer.write` first buffer for a ≤ 4-word chunk, it/en. | on-device yes/no per language; first partial and final latency after end of speech (p50/p95); WER per language; rollover gaps/duplicates; TTS first-buffer p50 | on-device for both; final ≤ 500 ms p50 after end of speech; WER it ≤ 0.10, en ≤ 0.07 (owner's ear also decides); no rollover loss; TTS first buffer ≤ 300 ms |
| **E8** (re-scoped) | **AEC + barge-in on the loudspeaker.** The eval's E8 (`react-native-webrtc`) belongs to candidate C/V5 and is not needed for B, so the slot is reused. Voice processing on, TTS through the engine; the assistant speaks for 5 min with nobody talking; then 10 barge-ins; repeat on AirPods and on wired/none. The speech-detection source (level gate vs recogniser activity) and the floor are also pinned here. | false barge-ins / 5 min; stop latency p50/p95 (log timestamps); the comma-pause lengths in the owner's speech | < 1 / 5 min; stop < 100 ms p50; floor ≥ 2× the longest comma pause |
| **E7** | **Relay round trip on cellular.** Phone → relay → `serve` small-frame RTT on 4G/5G and Wi-Fi; end of speech → first spoken word with `serve` on the owner's Mac (laptop-as-host) and the local Qwen / DeepSeek; reply-stream continuity across a forced network switch (Wi-Fi → cellular). | RTT p50/p95; e2e first word p50/p95; stall/resync behaviour | RTT p50 < 150 ms; e2e p50 ≤ Mac target + 300 ms |
| **E11** (rev 3: **tuning input, not a gate**) | **Background and locked-screen behaviour**, with `UIBackgroundModes: audio` and the §5b session. Mode on, app backgrounded and screen locked, for 30 s, 5 min and 30 min, with a reply spoken while locked. Then, while locked: an incoming call (answered, declined); Siri; Music started from Control Center; an alarm; AirPods in/out; a relay drop (Wi-Fi off). Then a remote-command resume while locked, after each. | per row: engine alive?, recognition alive across rollovers?, mic indicator, Now Playing shown?, what iOS reports (`interruption` source + `shouldResume`, `mediaServicesWereReset`, `cannotStartRecording`), whether a background resume works or needs the app opened; battery % per 30 min (foreground, locked); thermal state | **No pass/fail on background itself.** The results set §5b's tunables: the options (A2DP), which sources auto-resume, the resume path (in place vs open the app), the restart thresholds, and the idle-off minutes. Every row must land in a defined state of P-F1…P-F12; a row that does not is a design bug to fix in P2b, not a reason to drop background. |

**Decisions after P1 (with the owner):** full- vs half-duplex on the phone; level gate vs recogniser activity for speech detection; the phone floor; §5b's tunables from E11. If E10 fails on-device for a language, Q1's fallback applies. Background stays in scope regardless (Q6).

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
  - a voice prompt with `reasoning:"off"` → the first request has `reasoning:"off"` + the transient line, and after the first tool call, neither;
  - a voice prompt with `reasoning:"keep"` → the transient line but **no** `reasoning` field (the switch is honoured; mutation: ignore `keep` → red);
  - a non-voice turn has neither;
  - a voice `enqueue` marks the turn, with its own `reasoning`;
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
  - `interrupted{ended, source:"call", shouldResume:true}` → stays `paused` (P-F1); `source:"other", shouldResume:true` → `listen` (P-F1b); `resumeFailed` → `paused` "open tentacle to resume" (P-F10);
  - `remote{pause|resume|stop}` → paused / listen / off; 5 recognition failures in 60 s → `paused` (P-F9); thermal critical → `paused`;
  - a foreign turn (not started here) → no `speak` (F14);
  - echo rule (F1); idle timeout.
  - *Mutations:* send while pending → red; speak foreign turns → red; auto-resume after a call → red.
- **T10 TUI** (`ink-testing-library`, fake spawner): `/voice` → `listen`; `utter`/`final` → a prompt with `voice:{reasoning:"off"}` (and `"keep"` with `voice.reasoningOff:false`); deltas → ordered `speak`; Esc while speaking → `hush`, no abort; Esc otherwise → abort. **`route.test.ts`**: Esc precedence; the toggle behind a dialog → pass.
- **T11 phone controller** (`bun test`, fake native port, the mobile-voice `voice-controller.test.ts` pattern):
  - activation → `listen`; native `final` → an outbox item with `voice:{reasoning:"off"}`; with the Settings row off → `voice:{reasoning:"keep"}`; a steer → `compose-handle` enqueue with the same;
  - **`AppState background` → no `unlisten`, mode still `listening`** (Q6); unmounting the session screen → mode still on (app-scoped);
  - Now Playing state updates on each reducer state; remote commands map to intents;
  - `dispose` → `unlisten` + `hush` before the listener is removed;
  - the arbiter disables the mic/speaker buttons.
  - *Mutations:* forget `voice` on the outbox item → red; pause on background → red; ignore the Settings row → red.
- **T12 phone outbox:** an item with `voice` survives a store reload (`outbox-store.ts`), and an old item without it loads.
- **T13 phone config:** after `expo prebuild`, a test (the mobile-voice guard-test pattern) asserts that `Info.plist` has `UIBackgroundModes` ⊇ `audio` and the reworded purpose strings, and that `app.json` and `app.plugin.js` agree. *Mutation:* drop `audio` from the plugin → red.
- **Swift:**
  - Mac (`voice:test`): protocol v2; `hush` stops within one buffer; `trace` with TTS + speech → `bargein`; TTS only → none.
  - Phone: a unit-testable `BargeInGate` (windows → decision), the interruption policy (`source × shouldResume × callActive → action`) and the route/restart mapping as pure Swift functions, tested in the module's test target if mobile-voice set one up. Otherwise they are covered by P4's checklist, and that is stated in Execution.
- **Maestro:** the waveform button appears, toggles state, and is hidden when on-device recognition is unavailable (no audio assertions; Maestro cannot speak).

### Slices

| Slice | Size · Blast | Suited | What | Gate / exit |
|---|---|---|---|---|
| **C2 shared core** | M · contained | owner assigns; standard review | §3 modules; T1–T5, T9 | `bun test packages/core/test/voice` green; mutations logged |
| **C3 voice-turn profile** | M · **load-bearing** | owner assigns; **fresh-context review** (§7 persistence, forward-compat, model-on-laptop) | §4 (incl. the per-turn `reasoning` switch); T6–T8 | `bun run check` green |
| **C1 Mac spike** | S · contained (scratch) | owner at the Mac | E6 live, TTS-in-engine, Kokoro feasibility | numbers in Execution; Mac full/half-duplex decided |
| **C1b Mac helper v2** | M · contained | owner assigns | §2; Swift tests | `voice:test` green; `trace` matches C1 |
| **C4 Mac TUI wiring** | M · cross-module | owner assigns; standard review | config, adapter, layer, `/voice`, strip; T10 | `bun run check` green |
| **P1 phone spike** | S · contained (scratch) | owner with the iPhone 12 Pro | E10, E8, E7, E11 | numbers in Execution; phone decisions taken (above). **E10/E8/E7 gate P2a/P3; E11 only tunes P2b.** |
| **P2a phone engine** | M · cross-module (the app-wide `AVAudioSession`) | owner assigns; **fresh-context review** of the audio session owner | §5a; `BargeInGate` Swift tests | builds on iOS 18/26 simulators; E8 behaviour reproduced on the phone (foreground) |
| **P2b phone background** | M · **load-bearing** (the app runs with the mic on and the screen locked; App Review 2.5.4; purpose strings) | owner assigns; **fresh-context review** red-teaming P-F1…P-F12 and the 2.5.4 list | §5b; interruption-policy Swift tests; T13 | E11's rows reproduced on the phone, each landing in its defined state |
| **P3 phone wiring** | M · cross-module | owner assigns; standard review | §6 (app-scoped controller, Settings rows incl. reasoning off); T11, T12, Maestro | `bun run check` + `bun run e2e:mobile` (18 and 26) green |
| **C5 Mac live** | S · contained | owner at the Mac | L1–L9 below | every item ticked |
| **P4 phone live** | S · contained | owner with the iPhone | PL1–PL10 below | every item ticked |

**Order:** C2 → C3 → (C1 → C1b → C4 → C5) ∥ (P1 → P2a → P2b → P3 → P4). The two spikes may run as soon as the plan is approved, even before V1/mobile-voice merge (scratch only). Code slices wait for their base (Owner Q1).

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
- **PL4** an incoming call mid-reply, screen locked: paused, and no auto-resume after it; resume from Now Playing;
- **PL5** AirPods in and out mid-mode, screen locked;
- **PL6** app backgrounded, then screen locked for 10 min: three turns spoken and answered while locked, Now Playing shows the state, the mic indicator is on; the idle-off fires after 10 min of silence;
- **PL6b** the iPhone Settings row "reasoning off" switched off → a voice turn reasons (visible in the transcript's reasoning row); switched on → it does not;
- **PL7** Wi-Fi → cellular mid-reply: "connection lost" → "reconnected", text complete on screen;
- **PL8** an ask spoken, a "yes" ignored, a tap answers;
- **PL9** phone and Mac both in voice mode on one session: only the originating device speaks each reply;
- **PL10** after a session, `serve`'s store has no transient line, and the app has no audio file in its container.

### Owner questions

*Rev 3 — claude-opus-5-5, 2026-11-15. Q1–Q7 are answered (answers at the end of this doc), and the plan above applies them. Only Q8 is open.*

1. ~~Order and fallback~~ — **answered (batch 1):** code after V1 + mobile-voice merge; spikes now; never cloud.
2. ~~Reasoning off for spoken replies~~ — **answered (batch 1):** a user setting on both edges (Mac `voice.reasoningOff`, iPhone Settings row), carried per turn (§4).
3. ~~Auto-send~~ — **answered (batch 1):** conversation mode only.
4. ~~Barge-in~~ — **answered (batch 2):** stop speech + steer, never cancel.
5. ~~Reply voice~~ — **answered (batch 2):** system voice on both edges; Kokoro a Mac opt-in if proven.
6. ~~iPhone background / lock~~ — **answered (batch 2), against the recommendation:** in v1 ("background subito"); §5b, P2b.
7. ~~Two edges on one session~~ — **answered (batch 2):** only the originating edge speaks.
8. **How to turn the mode on, and how it shows (OPEN — decide from the mockups** at `.tentacle/tmp/voice-conversation/mockups/index.html`, gitignored scratch):
   - **Mac A:** `/voice` + Ctrl+G; a status-line chip (`◉ voice · listening`) on the right of the last line; the input row stays a text field.
   - **Mac B:** `/voice` + **Ctrl+R pressed twice** (one voice key: once = dictation, twice = conversation); the input row itself becomes the voice bar (state, meter, hints) while the mode is on.
   - **iPhone A:** a separate round **voice-mode button** between the field and Send; the capsule above the composer shows the state.
   - **iPhone B:** **the Send button becomes the voice-mode button when the field is empty** (no new button; typing turns it back into Send); the state shows in a full-width voice bar in place of the composer.
   - *Recommendation:* **Mac B** (no new key to learn, and the state sits where the eyes already are; Ctrl+G stays free) and **iPhone B** (the familiar pattern of voice assistants; no crowding of a 390-pt composer that already holds photo + field + mic + send).

## Execution

### C2 — shared core (§3 modules) · *— deepseek-v4.1-flash (tentacle), 2026-11-15*

**Scope.** Slice C2 only. Nothing of C3 (protocol/daemon/provider), C1/C1b/C4/C5
(Mac helper + TUI) or P1–P4 (phone) was touched.

**Load-bearing check (run FIRST, per the brief).** C2's precondition is
"shared code lives in `@tentacle/core`", which both edges depend on, React-/
Ink-/RN-free. Re-run on this branch
(`.tentacle/tmp/voice-conversation/c2-load-bearing.txt`): `rg 'from
"(react|ink|react-native)' packages/core/src` → no match;
`@tentacle/core` is a dependency of both `apps/mobile/package.json:11` and
`packages/tui/package.json:12`; core's deps are `@tentacle/protocol` + `zod`
only. **PASSED** — the slice proceeded.

**Capability missing, shown before the code (feat repro).** `packages/core/src/voice/`
did not exist (`ls` → no such file); `rg -n 'export (function|const|type|interface)
(clean|splitLong|speakable|narration|chunker|askSpeech|voiceLang|conversation)'
packages/core/src packages/protocol/src` → no match. V1's endpoint fold exists on
`feat/voice-dictation` (`packages/tui/src/voice-endpoint.ts`, merged into `main`)
and mobile-voice's `speakable.ts` on `feat/mobile-voice` only (both verified with
`git ls-tree`).

**As built, in the plan's dependency order.** All under
`packages/core/src/voice/` (+ `export *` at `packages/core/src/index.ts:28`),
tests under `packages/core/test/voice/` (7 files, 115 tests):

| Module | What the plan asked for (verified against §3, not memory) |
|---|---|
| `voice-lang.ts:42` | utterance → setting → `en`; an unspoken tag is `null`, never a guess (P-F6). |
| `speakable.ts:316` | `clean`/`splitLong` lifted from mobile-voice **verbatim** (same `MAX_UTTERANCE` 600, same sentence/space rules) + a streaming fold: fences → `(code on screen)`/`(codice a schermo)`, tables → placeholder, links → label, bare URL → `link`, control chars stripped. |
| `chunker.ts:301` | ≤ `firstWords`(4) for the FIRST chunk, then sentence/clause ends, cap `maxChars`(200), `flush()`, never inside a word or a number, delta-split invariant. |
| `narration.ts:113` | tool name only (labels localized), ≤ 1 line per 5 s, silent while a reply chunk is queued; unknown tool → "working"/"Sto lavorando". |
| `ask-speech.ts:66` | verbatim when ≤ 120 chars **and** one line, else the screen template; always ends "answer on screen"; never a truncation; `explanation` accepted and ignored (F7). |
| `endpoint.ts:172` | edge-neutral fold, per-edge defaults: Mac `turnModel:true` (asks Smart Turn), phone `turnModel:false` (the `textGrew` rule); floor 500 ms, hard stop 3 s, `autoStop:true` for conversation mode. |
| `conversation.ts:762` | the reducer: 7 states, the normalised event vocabulary, and the 8 commands (`prompt`/`enqueue`/`fieldInsert`/`notice`/`speak`/`hush`/`listen`/`unlisten`) as DATA. |

**Drift from the Implementation (and why).** Three, all inside C2's own files:

1. **`ask-speech` is its own file, not a section of `narration.ts`** — the plan's
   Files list names it separately (§3 row 5) and the two have different inputs;
   no change to behaviour.
2. **`speakable` exposes a streaming fold (`speakableFilter`) alongside the
   one-shot `speakableText`.** §3 says `speakable.ts` is a markdown→text
   transform, which is what `speakableText` is; but §3 also says the reply
   arrives as deltas and that the CHUNKER consumes them. Both are needed: the
   reducer runs `speakableFilter` first (so a fence's body is dropped before the
   chunker ever sees it), then `chunkFilter`. A fence straddling a delta boundary
   is the reason the fold exists, and T2 tests it at every split point.
3. **`conversation.ts` also applies `narration`'s throttle** (it owns
   `narratedAtMs` in its model, and `toolCall` events go through `narrate`), so
   the throttle has ONE clock owner rather than two. `narration.ts` stays
   independently testable (T3), exactly as the plan describes it.

**The plan's step that the code contradicted, and how it was fixed.** The
"mutations" line of T5 says "floor 200 → red". On the V1 fixtures that is
**false**: the four comma pauses are 192/224/192/192 ms, so at a 32 ms window a
200 ms floor never reaches them and the traces stay green
(`runMac(..., {floorMs: 200})` → 0 cuts). The tests now pin the true
reproduction instead: a 0 ms floor ("cut on silence", how V1 reproduced V0) cuts
all four traces, and a floor of exactly 192 ms cuts e04 — both red-to-green
properties, both in `endpoint.test.ts`. The 500 ms shipped floor's own guard
(`>= COMMA_SAFE_FLOOR_MS`, read as a literal) is unchanged.

**Mutations (plan targets; all applied to the real files, the test run, the
original bytes written back — never `git checkout`).** Script + output:
`.tentacle/tmp/voice-conversation/mutations.ts`.

```
MUTATION T1 chunker maxChars 200 -> 40: RED (2 fail) — test is non-vacuous
MUTATION T2 speakable keeps fences (body into the placeholder slot): RED (3 fail)
MUTATION T3 narration interpolates the arguments: RED (6 fail)
MUTATION T4 ask-speech truncates instead of falling back: RED (2 fail)
MUTATION T5 endpoint floor 500 -> 200 (both edges): RED (1 fail)
MUTATION T5 endpoint drops the textGrew rule: RED (1 fail)
MUTATION T9 send while an ask is pending: RED (1 fail)
MUTATION T9 speak foreign turns: RED (1 fail)
MUTATION T9 auto-resume after a phone call: RED (1 fail)
----
ALL MUTATIONS APPLIED AND RED (every target test is non-vacuous)
```

Two of these were **green on the first attempt** and the tests were sharpened,
not the code: "speak foreign turns" needed the mutation to be
`return turnId !== ""` (my first attempt only guarded a null id, which no test
path reaches), and the T5 floor mutation had to become the reproduction above.
The plan's T9 parity test was checked for non-vacuity by asserting that the
scripted sequence really emits all six of `prompt`/`enqueue`/`speak`/`listen`/
`unlisten`/`hush` — an all-empty pair would otherwise compare equal.

**Failure modes covered by this slice** (§ *Failure modes*, the ones C2 owns):
F1 (echo rule, >3 empty barge-ins/30 s → barge-in off + notice), F2 (comma floor
on both edges, plus the V1 regression), F3 (a steer, never a second prompt), F4
(hush + "connection lost" + `paused`; reconnect listens and re-speaks nothing),
F6 (ask pending blocks every send, text → field), F7 (fence bodies, hrefs, tool
arguments and ask explanations never reach speech), F14 (foreign turns are not
spoken; a voice-steered one is), F15 (10-min idle off), P-F1 (`source:"call"`
never auto-resumes), P-F1b (`other` + `shouldResume` → listen), P-F9 (5
recognition failures in 60 s → paused), P-F10 (`resumeFailed` → "Open tentacle to
resume"), P-F11 (thermal critical → paused, serious → notice).

**Gate (run on this branch, in this order).**

- `bunx tsc --noEmit` → clean (exit 0, no output).
- `bun run lint` → `Checked 1595 files … No fixes applied.` (0 errors, 0
  warnings — the §6 clean baseline, unchanged).
- `bun test` → **11417 pass, 5 skip, 0 fail** across 822 files; the 5 skips are
  the documented opt-in ones (live k8s ×2, live docker ×2, the slow keepalive),
  no new skip. C2's own file: `bun test packages/core/test/voice` → 115 pass,
  0 fail.
- `packages/protocol/schema/protocol.json`: **not regenerated — no schema
  changed.** C2 touches no protocol file (`git status --short packages/protocol`
  is empty); `voice`/`reasoning` on the wire is C3's.
- Changelog: `changelog.d/voice-conversation.changed.md` (one bullet; scoped to
  the core, since nothing is user-visible until the edges are wired). The plan's
  Files list gives C5/P4 the `voice-conversation.added.md` bullet — that stays
  theirs, because the feature is not yet reachable from either edge.
  `CHANGELOG.md` untouched; the fragment guard is green.
- `TODO.md` not touched, per the brief.

**Not done here, by design:** the mobile `speakable.ts` import swap (Files step
1's second clause). `apps/mobile/src/speakable.ts` does not exist on this branch
(`feat/mobile-voice` is unmerged), so there is nothing to re-point; it is a
dependency-order item for whoever lands mobile-voice, recorded here rather than
done blind. Verified: `ls apps/mobile/src/speakable.ts` → No such file.

**Unverified (one line each, with how to check):** the phone/P1-pinned floor is
still V1's 500 ms base — the spike E10/E8 must confirm it on the device
(`ENDPOINT_EDGE_DEFAULTS.phone.floorMs`, `endpoint.ts`); and the reducer's
`speak` ordering is only as good as the edge reporting `spoken{seq}`
deterministically (C4/P3's job to wire, T10/T11 to prove).

## Review

*(empty)*

#### Owner answers (2026-11-15, batch 1)

- Q1 order: **yes** — spike now, code after V1 (`feat/voice-dictation`) and `feat/mobile-voice` merge; a language with no on-device recognizer has no voice mode, never cloud.
- Q2 reasoning off for voice turns: **yes, as a user-settable switch, also settable from the mobile app** (not hard-wired) — C3 + a settings row on both edges; mandatory fresh-context review.
- Q3 auto-send at end of utterance: **yes, conversation mode only** (Ctrl+R dictation never auto-sends).

#### Owner answers (2026-11-15, batch 2)

- Q4 barge-in: **stop the speech + steer**, never cancel; Esc stops speech, a second Esc aborts the turn.
- Q5 TTS: **system voice on Mac and iPhone**; Kokoro an opt-in on the Mac only if the spike proves it.
- Q6 iPhone background / screen locked: **in v1 scope — "background subito"** (overrides the recommendation): the phone loop must keep listening and speaking with the app backgrounded and the screen locked. The plan must be revised: background audio mode, AVAudioSession lifetime, interruptions, App Review risk, and E11 becomes a design input, not a gate.
- Q7 two edges on one session: **only the edge that started the turn speaks**; the other shows text.

#### Owner answers (2026-11-15, batch 3 — on the mockups)

- Q8 activation, Mac: **B** — `/voice` or Ctrl+R pressed twice (once stays dictation); in conversation the input row becomes the voice bar.
- Q8 activation, iPhone: **B** — with the field empty, Send becomes the voice button; in conversation a voice bar replaces the composer.

**Implementation APPROVED by the owner (2026-11-15).** Code slices start after `feat/voice-dictation` and `feat/mobile-voice` merge; the spikes (Mac C1, iPhone P1 — owner-assisted on the device) may run now.
