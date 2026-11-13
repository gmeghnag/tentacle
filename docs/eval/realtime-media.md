# eval/realtime-media — one media architecture: realtime voice first, then binary blobs, audio/video files, live vision

> **Status:** context · review round 2 (revised after a Fable design review that said REVISE; pending the owner's verdict)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** — · **Blast:** load-bearing (transport, protocol, §7 "model stays on the laptop" / "a pod is not trusted") · **Suited:** — (decision record; the recommended tasks are sized in §9)
> **Subsumes:** `TODO.md` `eval/binary-frames` and `eval/attachments-audio-video` (both stay open as the blob-track entries this eval sizes; their questions are answered here)

## Context

*— claude-opus-5-5, 2026-11-13 (round 1); revised 2026-11-13 (round 2, after the Fable review)*

### 1. The question

Owner, 2026-11-13: *"dobbiamo lavorare bene e con una visione fuori dagli schemi
per rendere il tutto più fluido possibile. Nella mia vision c'è anche la
possibilità di parlare realtime con tentacle, quindi le performances devono
essere altissime, latenza bassissima. Ciò richiede una visione architetturale
eccelsa."* and *"ogni efficientamento è da perseguire"*.

The exact questions this eval decides:

- **Q-D — Realtime voice (the owner's goal).** How do we reach sub-second voice
  turns with barge-in, from the laptop and from the phone, on the four runtime
  paths, without breaking a §7 invariant? This covers the fast reply and the
  *substantive* (delegated) reply.
- **Q-A — Blobs.** How do bytes (images today; audio/video files next) travel on
  the hops that carry them without base64 in JSON-RPC text?
- **Q-B — Where media goes.** Which process does each kind of media flow to?
- **Q-C — Live media.** How does the model "watch" a camera/screen stream?
- **Q-E — Order.** Which phases, in which order, each useful alone, sized per
  §10, and which experiments decide each one.

Docs only. No code before approval.

### 2. Today, verified against the code (2026-11-13)

| Fact | Source |
|---|---|
| A `DuplexChannel` moves **text frames only** (`send(data: string)`). Every transport (WS, stdio, `MessagePort`, Noise) implements this one interface. | `packages/transport/src/channel.ts:9-18` |
| Image upload is `attachment/put`: one **base64** chunk per JSON-RPC request, 256 KiB raw → **349 528 chars**, resumable via `have`. | `packages/protocol/src/attachment-upload.ts:26,29,36-47` |
| Image cap 15 MiB. | `packages/protocol/src/attachment.ts:37` |
| The stdio channel (`serve --stdio`, k8s exec, docker) is **newline-delimited JSON** on a JS string buffer. It is used **only** for pod/stdio daemons. The k8s side also sends **blank keepalive lines**. | `packages/transport/src/stream-channel.ts:28-55`; users `packages/cli/src/serve.ts:723`, `pod-resident.ts:304,552`; `packages/k8s/src/exec-channel.ts:84-85` |
| The k8s exec WebSocket is already **binary** underneath; it carries text lines. | `packages/k8s/src/exec-channel.ts:38,87-93,188` |
| The Noise E2E channel frames each Noise message as text `t1:` + **base64**. On the phone path an image chunk is base64 (JSON) of bytes, then UTF-8, then encrypted, then **base64 again**: 256 KiB raw → ≈ 466 000 chars = **1.78×**. Removing only the *outer* base64 gives 1.33×. The code uses its own pure-JS base64; its comment says Hermes lacks `btoa` "for certain". That is stale: Hermes has had native `atob`/`btoa` since RN 0.74 (the app is on RN 0.88, `apps/mobile/package.json:20`). | `packages/transport/src/noise-frame.ts:1-15,30,100`; `noise.ts:18`; [js-bson #827](https://github.com/mongodb/js-bson/pull/827/files) |
| Noise = `Noise_IK_25519_ChaChaPoly_SHA256`, `@noble/*` pure JS, **strictly sequential nonces** (needs an ordered, reliable carrier). | `packages/transport/src/noise.ts:1-18,110-140` |
| The RPC peer dispatches requests concurrently (`void this.handleRequest`) and `JSON.parse`s every frame. The WS server caps a frame at 8 MiB. | `packages/transport/src/peer.ts:280-290,322`; `packages/daemon/src/ws-server.ts:54` |
| Model-stream deltas are coalesced (30 ms window, 64 Ki chars/batch). | `packages/client/src/remote-client.ts:658-668` |
| Both providers stream **reasoning deltas before the answer** (`reasoning` events). So when reasoning is on, the first *speakable* token comes after the thinking stream. | `packages/providers/src/anthropic-provider.ts:252-254`; `openai-provider.ts:261-263` |
| **Pods get image REFS, never bytes** (`ProxyModelProvider` on the laptop). Owner Q2 (attachments-upload): *"no bytes in a pod"*. | `docs/feat/attachments-prompt.md:30-31,125-135`; `docs/feat/attachments-upload.md:406-411` |
| `ModelProvider` = `stream(ChatRequest): AsyncIterable<StreamEvent>`. No audio, no bidirectional session. | `packages/core/src/model.ts:162-175` |
| The mobile app is a **dev build** (`expo-dev-client` 58.0.14), so native WebRTC/audio modules are not blocked by Expo Go. | `apps/mobile/package.json:16,20` |
| Phone path: app ↔ (Tailscale / LAN / cloudflared / **relay**) ↔ `serve`, Noise inside, relay sees opaque bytes. | `docs/eval/mobile-app.md:60-82` |

**The precedent:** *bytes go to where the model connection is, not to where the
agent loop is*. For pods those are different processes, and bytes never enter
the pod.

### 3. Constraints from AGENTS §7 (what any answer must keep)

1. **One session path over RPC.** Voice must not become a second agent loop. A
   voice front is a *client* of the session (`session/prompt`, `enqueue`,
   `cancel`, `session/update`), like the TUI and the phone. Its only tools are
   session RPCs.
2. **Model stays on the laptop / key with the identity.** A pod never holds a
   provider credential. Audio for a model never transits a pod.
3. **A pod is not trusted.** Pod-supplied text (tool output, permission-ask
   text, anything in a digest) must never decide what the user *hears* about a
   laptop effect. A daemon-side check, and *a model's paraphrase*, are UX, never
   security.
4. **Protocol versioned honestly;** pre-public breaking changes allowed with a
   `protocol.d/` note.
5. **Don't serialize the peer;** a big upload must never stall the control plane.
6. **Never write raw to the terminal while Ink owns it.** Audio I/O lives in
   another process.
7. **E2E on every phone path.** The relay sees opaque bytes only.
8. **Persistence records only what the client validated.** A new field on a
   persisted entry is an on-disk format question (§7 on-disk versioning).

### 4. State of the art (web research, re-checked 2026-11-13)

Every number is tagged: **[S]** sourced (with who measured it), **[V]** vendor
self-reported, **[E]** our estimate, **[M]** only our experiment (§8) can tell.

**Speech-to-speech (S2S) realtime APIs.**
- **OpenAI Realtime** (`gpt-realtime-2`): WebRTC, WebSocket or SIP; server VAD /
  `semantic_vad`; on WebRTC/SIP an interruption truncates unplayed output
  server-side, on WebSocket the client must truncate. Time to first audio
  **1.12 s at minimal reasoning, 2.33 s at high** [V, OpenAI-reported via
  [The Batch](https://www.deeplearning.ai/the-batch/openai-challenges-speech-to-speech-leaders),
  [HandyAI](https://handyai.substack.com/p/model-drop-gpt-realtime-2)]. Price
  $32 / $64 per 1 M audio tokens in/out, cached input $0.40
  ([model page](https://developers.openai.com/api/docs/models/gpt-realtime-2)).
  Independent per-minute estimates **$0.15–0.30/min**
  [S, [rywalker](https://rywalker.com/research/openai-realtime-api),
  [chatforest](https://chatforest.com/reviews/openai-gpt-realtime-2-voice-intelligence-review/)];
  the round-1 "$0.08" floor assumed heavy caching and is withdrawn.
  - **Client credentials, what they really bound**
    ([client secrets ref](https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret)):
    the expiry (10 s – 7200 s, default 600 s) bounds only when a session may
    be **started**; "the session itself may continue after that time"; "a secret
    can be used to create multiple sessions until it expires"; the attached
    session options "can also be overridden by the client connection". A
    session lasts up to 60 min
    ([conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)).
    **So an `ek_…` pins nothing.**
  - **The unified interface needs no client credential at all**
    ([WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc)):
    the client sends its SDP offer to the developer's server; the server POSTs
    it with **its standard API key and the session config** to
    `/v1/realtime/calls` and returns the SDP answer. OpenAI recommends it
    ("simpler setup and faster connections"). The media then flows client ↔
    OpenAI directly. A **sideband** WebSocket (`wss://…/v1/realtime?call_id=…`,
    standard key) lets the server watch the session, re-send `session.update` and
    hang up
    ([server controls](https://developers.openai.com/api/docs/guides/realtime-server-controls)).
    Caveat: the client can still send `session.update` over its data channel
    (the server can only re-assert it), and a community report (2026-09) shows
    sideband 404s for calls created with an ephemeral key
    ([forum](https://community.openai.com/t/ephemeral-keys-trigger-realtime-sideband-404-errors/1396002)),
    which the unified interface avoids (the server creates the call).
- **Gemini Live API**: WebSocket, PCM16 in/out, video 1 fps, sessions ≈ 15 min
  audio-only. **Ephemeral tokens do pin**: 1 min to start, 30 min to send,
  `uses: 1`, and `liveConnectConstraints` locks model + config server-side
  ([Google docs](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)).
  First audio ≈ 3 s at 1 fps video [S, [Stream](https://getstream.io/blog/speech-apis/)].
  Files: 32 tokens/s audio, 263 tokens/s video
  ([token counting](https://ai.google.dev/gemini-api/docs/tokens)).
- **Anthropic**: no public realtime/audio-input API found. Claude's consumer
  voice is a cascade; Claude Code `/voice` is push-to-talk dictation
  ([TechCrunch 2026-03-03](https://techcrunch.com/2026/03/03/claude-code-rolls-out-a-voice-mode-capability/)).
  **Claude and local Qwen cannot be an S2S voice.** A cascade wraps them, or
  another provider's S2S model fronts them.
- **Independent S2S range**: 0.8–1.8 s end of speech → first audio [S, Coval
  live-call benchmark, Oct 2026, via
  [Cartesia](https://www.cartesia.ai/learn/speech-to-speech-vs-cascaded)].
  The only sub-0.8 s figure we found (220–400 ms, Fora) has no method and is
  **not used** in any budget below.

**Text-model time to first answer token (TTFAT), voice-shaped benchmark.**
Pipecat "voice readiness", Aug 2026: medium context, 30-turn scripted
conversations; separately streamed reasoning excluded; the first turn excluded
(so warm) [S, [Pipecat](https://www.pipecat.ai/benchmarks/voice-readiness)].
P50s: `gpt-oss-120b` on Groq **98 ms**; Qwen3.8-27B thinking off, local RTX 5090
**101 ms**; Gemma-4-31B **489 ms**; `gpt-4o-mini` 553; Gemini 3.5 Flash-Lite
(minimal) 591; **Claude Haiku 4.5 637**; Sonnet 4.6 850; Sonnet 5 1204;
**Claude Fable 5 (reasoning, low) 3535, default 3956**. Pipecat's rule of
thumb: "a model much above 700 ms TTFAT is too slow for most voice agents".
A Mumbai-region test found prompt caching of a long system prompt cuts TTFT
30–45 % [S, [caller.digital, Aug 2026](https://caller.digital/blog/llm-benchmark-indian-voice-agents-function-calling-latency-2026)].

**TTS time to first audio.** ElevenLabs v4 Turbo 69 ms, Cartesia Sonic 3.6
270 ms [S, [Cekura, 2026-11-10](https://www.cekura.ai/blogs/elevenlabs-vs-cartesia)];
ElevenLabs Flash v2.5 185 ms, Sonic 3.6 440 ms [S, Coval TTFA leaderboard, read
2026-09-08, [Coval](https://www.coval.ai/blog/time-to-first-audio-ttfa-benchmark/)];
Cartesia claims 40–90 ms [V]. Measure time to first *audio*, not first byte
(the first bytes are often a header). No 2026 figure for Kokoro or Apple's
on-device voices: [M].

**Turn detection and barge-in.** Default endpointing waits 0.5 s of silence
([LiveKit](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)).
Smart Turn v3: ~8 MB ONNX, ~12 ms CPU inference [V,
[Daily](https://www.plushcap.com/content/daily/blog/daily-announcing-smart-turn-v3-with-cpu-inference-in-just-12ms)].
Eager end-of-turn costs +50–70 % LLM spend. **AEC must run before VAD/ASR**
([NVIDIA](https://perspectives.nvidia.com/nemotron-speech/task/faq/how-do-i-implement-barge-in-detection-so-a-user-can-interrupt-a-voice-agent-whil/)).

**Output device.** AirPods Pro 2 ≈ 126 ms tap-to-sound
[S, [9to5mac 2022](https://9to5mac.com/2022/11/15/airpods-pro-2-latency-test/)];
`outputLatency` ≈ 155–160 ms reported for AirPods
[S, one developer, [Apple forums](https://developer.apple.com/forums/thread/679274)].
Bluetooth adds **≈ +100–160 ms** over a built-in speaker, and switches the mic
to the headset profile.

**Chat-supervisor pattern.** OpenAI's reference app delegates hard turns from a
realtime front to a text model through one tool
([openai-realtime-agents](https://github.com/openai/openai-realtime-agents)).
The pattern does **not** require an S2S front (see §6 B+).

**Local stack.** Silero VAD + Parakeet/whisper.cpp + local LLM + Kokoro is the
common 2026 local stack; one M3 Pro pipeline reported 2.5–3 s end to end
([dev.to, 2026-03](https://dev.to/xadenai/building-a-local-voice-ai-stack-whisper-ollama-kokoro-tts-on-apple-silicon-eo0)),
so local needs care. iOS 26 ships on-device `SpeechAnalyzer` and Apple's
on-device Foundation Models (latency on our phone: [M]).

**Transports.** WebRTC gives UDP, Opus, a jitter buffer and platform AEC.
WebTransport is Baseline in browsers since Safari 26.4, but React Native has none.
Bun has had **experimental** HTTP/3 (`Bun.serve({ http3: true })`) since
v1.3.14 (2026-05-13), marked "do not deploy to production"; it has no
WebTransport and no WebSocket over HTTP/3
([Bun v1.3.14](https://bun.com/blog/release-notes/bun-v1.3.14)). So we
**do not host a UDP media plane**, because Bun has no production-grade
WebTransport, not because it lacks QUIC. Where UDP matters, the provider's WebRTC
edge is the far end.

**Raw rates (ours).** PCM16 16 kHz = 256 kbit/s; Opus voice 16–32 kbit/s. Text
deltas of a spoken reply ≈ 15 chars/s, ~1000× smaller than audio.

### 5. Latency budgets, re-derived per hop (end of user speech → first audible word)

Two kinds of turn, budgeted separately:
- **Front-only**: chit-chat, acknowledgement, "what are you doing?" answered
  from a digest.
- **Delegated**: the session's real answer. In a coding agent most useful turns
  are delegated, so this is the row that decides "feels realtime".

**Components** (warm; built-in speaker unless noted):

| Hop | Range | Tag / source |
|---|---|---|
| Capture + AEC frame | 10–30 ms | [E] |
| Endpointing | 200–350 ms | Smart Turn 12 ms [V] + 150–300 ms min silence [E]. Default 500 ms silence [S] = the trap |
| STT final after endpoint, on-device | 50–150 ms | [E], [M] E4 |
| Small front TTFAT, small context, **reasoning off** | 100–650 ms | [S] Pipecat Aug 2026 (98 Groq … 637 Haiku 4.5); owner's Mac local small model [M] |
| Brain TTFAT, big coding context (50–150 k, cached prefix), **reasoning off** | 0.6–2.0 s | lower end [S] Pipecat medium context (Haiku 637, Sonnet 5 1204); upper end for 100 k+ [E] |
| Brain TTFAT, **reasoning on** | 3.5–4 s + | [S] Pipecat (Fable 5 low 3535 / default 3956) |
| First speakable clause after the first token | 100–400 ms | [E] 5–12 tokens at 30–100 tok/s, clause-chunked TTS |
| TTS first audio | 70–440 ms cloud; 50–300 ms on-device | cloud [S] Cekura/Coval; on-device [E], [M] |
| Playout, built-in speaker | 20–60 ms | [E] |
| Playout, Bluetooth (AirPods) | +100–160 ms | [S] 9to5mac, Apple forums |
| S2S front turn (incl. server VAD) | 0.8–1.8 s | [S] Coval; `gpt-realtime-2` 1.12 s minimal [V] |
| S2S generation from a tool result (no VAD) | 0.5–1.2 s | [E], [M] E5 |
| Barge-in stop, decided on the device with the speaker | < 100 ms | [E], [M] E6 |

Edge fixed cost (cascade, excluding model and network) = capture + endpoint +
STT + clause + TTS + playout = **0.43–1.29 s** [E], i.e. ≈ 0.6–0.8 s typical.

**Path round trips** (RTT; small text frames):

| Path | RTT | Notes |
|---|---|---|
| Laptop local (worker `MessagePort`) | < 2 ms | |
| `connect` → `serve`, LAN/Tailscale | 2–20 ms | |
| `connect` → `serve`, WAN | 30–120 ms | TCP loss stall ≥ 1 RTO (≥ 200 ms) |
| Pod `run`/`attach` | 20–120 ms | two proxies |
| Phone → relay → `serve` | 60–180 ms | 4G/5G jitter; [M] E7 |
| Edge → provider directly | 30–100 ms | |

All [E] except where §8 measures them.

**Budgets, warm turns, built-in speaker** (sum of the component ranges; add
+100–160 ms for Bluetooth):

| Path | B: cascade, session answers directly | B+: cascade + small text front | C: S2S front |
|---|---|---|---|
| **Front-only turn**, laptop local | n/a (no front: the brain answers; earcon at ≈ 0.25 s) | **0.55–1.9 s** | 0.8–1.8 s |
| front-only, `connect` | n/a | 0.55–2.0 s (front at the key holder: + RTT) | 0.8–1.8 s |
| front-only, pod | n/a | 0.55–1.9 s (front on the laptop; pod not on the path) | 0.8–1.8 s |
| front-only, phone | n/a | 0.6–2.1 s (front at `serve`); on-device front: [M] | 0.8–1.8 s (direct) |
| **Delegated turn**, laptop local | **1.0–3.3 s** | 1.0–3.3 s with speculative delegation; 1.1–3.9 s without | **2.0–5.4 s** (S2S decides + brain + 2nd S2S generation) |
| delegated, `connect` / pod / phone | + path RTT (≤ 0.2 s) | + path RTT | + path RTT |
| delegated, reasoning **on** | + ≈ 3 s | + ≈ 3 s | + ≈ 3 s |

How the rows are built:
- **B delegated** = edge fixed cost + RTT + brain TTFAT.
- **B+ front-only** = edge fixed cost + front TTFAT (+ RTT to the key holder if
  the front model is called there).
- **B+ delegated**: the front only *routes*. The user's **verbatim transcript**
  goes to the session, and the brain's own answer is spoken by local TTS (no
  second generation). With speculative delegation the brain request starts at
  endpoint, in parallel with routing, and is cancelled if the front keeps the
  turn. Cost: one cached-prefix prefill per cancelled turn. So B+ delegated = B.
- **C delegated** = S2S turn to the tool call (0.8–1.8) + RTT + brain TTFAT to a
  first complete sentence (0.7–2.4) + S2S generation from the tool result
  (0.5–1.2). The acknowledgement is audible at 0.8–1.8 s.

**Cold start** (once per voice session; all [E], [M] in E4/E5). Hide it by
connecting and loading at the voice-mode toggle, not at the first word:
- WebRTC SDP relay via the key holder (phone → relay → `serve` → OpenAI →
  back) + ICE/DTLS: 0.5–1.5 s.
- On-device model load (Smart Turn, Parakeet, Kokoro, small local LLM):
  0.5–3 s.
- iOS audio-session activation: 50–200 ms.
- Prefix-cache warm-up helps **only after an idle gap longer than the cache
  TTL** (Anthropic: 5 min default, 1 h optional). Within an active session the
  prefix is already cached. A local model keeps its own KV cache, so there is
  nothing to warm.

**What the numbers say.** The fast front makes the *acknowledgement* fast, in B+
or C alike. The *substantive* answer is bounded by the brain. C pays two extra
S2S hops on every delegated turn, so it is the slowest on the turn that matters
most. B+ is in C's front-only band (sourced front TTFATs of 100–650 ms) and
equal to B on delegated turns. The biggest single lever on delegated turns is
**reasoning off for spoken replies** (≈ 3 s, [S]); the next are endpointing
(150–300 ms) and clause-level TTS.

### 6. Candidate architectures

The control plane (JSON-RPC, every session/permission/model-stream message)
is unchanged in all of them. They differ in **where audio goes** and **who
talks**.

#### Candidate A — audio over the session pipe to a daemon-held voice model

- Every audio frame crosses the existing channel. The daemon opens the voice
  model session.
- **Latency:** + one path hop each way on the voice loop, plus TCP head-of-line
  on cellular (≥ 200 ms stalls).
- **Pods ✗**: audio hairpins pod → laptop, or the pod holds a key (§7 ✗).
- **Complexity:** high. Jitter buffers, Opus and pacing over TCP in TS.
- **Verdict:** wrong for live audio. Right for **blobs** (files, frames on demand).

#### Candidate B — edge cascade, the session answers directly

```
 mic ─► AEC ─► VAD+smart-turn ─► STT ──transcript──► session/prompt | enqueue ─► tentacle session
 spk ◄─ TTS ◄── voice-view (pure): sentence chunks, tool narration ◄── session/update (text deltas)
   ▲  barge-in: local VAD stops playback at once, then session/cancel
```

- Voice is another way to type and read. A pure `voice-view` module turns
  `session/update` into speakable text: clause-chunked reply, one-line
  **templated** narration of tool calls ("running the tests"), permission asks
  (§6.1).
- **Voice-turn profile:** reasoning off (or minimal) and a "spoken reply: short
  first sentence, no code blocks" note. An **earcon** at endpoint, so silence
  never exceeds ≈ 300 ms.
- **Security:** best. With on-device STT/TTS no audio leaves the device, and
  nothing reaches a new provider. Works with Claude and local Qwen.
- **Weakness:** every turn pays the brain's TTFAT (1.0–3.3 s), even "are you
  there?".

#### Candidate B+ — edge cascade + small fast text front with a session digest (new in round 2)

```
 mic ─► AEC ─► VAD+smart-turn ─► STT ─► transcript ─┬─► FRONT (small text model, reasoning off)
                                                    │     context: session digest (pure projection)
                                                    │     tools: route=answer | delegate, status()
                                                    │
                                                    └─(speculative, opt-in)─► session/prompt(transcript)
 front "answer" ─► TTS ─► spk          front "delegate" ─► keep/commit the session/prompt(VERBATIM transcript)
 session/update ─► voice-view (templates + the brain's own text) ─► TTS ─► spk
```

- **Who talks:**
  - The front speaks only conversational replies.
  - Everything about session *state* (progress, tool calls, asks) is spoken
    from deterministic `voice-view` templates over `session/update`, never from
    the front.
  - A delegated answer is the brain's own text, spoken verbatim by TTS.
- **Where the front runs:**
  - Default: **at the key holder, on the same provider as the session**, e.g.
    Haiku for a Claude session, or a small local model for a local-Qwen
    session.
  - On the laptop paths (worker, `run`/`attach`) the key holder is the laptop
    itself. For the phone and `connect`, it is `serve`, reached over the
    existing E2E control plane: + 1 RTT, no new credential.
  - Optional: an on-device front (MLX small model on the Mac, Apple Foundation
    Models on iOS) for zero network and zero new recipient.
  - A faster third-party front (e.g. Groq) is opt-in, because it is a new
    recipient of the transcript and the digest.
- **Single session path:** the front calls a model, which is new. But it runs
  no session tools and no agent loop. Its outputs are a route decision and
  spoken chit-chat. The session sees only `session/prompt|enqueue|cancel` from
  a client.
  - The front's model call is a narrow, key-holder-side method. It is not
    `model/stream` for pods, because no pod is involved.
- **Persistence:** the session receives the **user's verbatim transcript**, so
  the user message is the user's words. Front chit-chat is display-only.
- **Gains vs C:**
  - No per-minute audio price.
  - No client credential on any device.
  - No second provider by default.
  - No per-provider WebRTC edge code.
  - Works with Claude/local.
  - Verbatim control of everything spoken.
  - Delegated turns ≈ B (C: +1.3–3 s).
- **Loses vs C:** full-duplex prosody (overlapping speech, laughter, tone),
  server-side interruption handling and S2S's natural voice. Barge-in stays
  local, as in B.
- **Risk:** misrouting (the front answers what it should delegate, or invents
  state). Mitigations: a constrained route-first output; the digest excludes
  ask text and raw tool output; state talk is template-only. Measured by E9.

#### Candidate C — edge-direct S2S front, session as supervisor

```
 edge (phone WebRTC | laptop helper) ══ SDP via the key holder (unified interface) ══► provider S2S front
        ▲ audio both ways direct to the provider; server-side truncation on interrupt      │ tool calls
        └── edge executes the front's tools as an ordinary CLIENT of the session ◄─────────┘
            ask_tentacle(text) → session/prompt | enqueue · status() → digest
 key holder: creates the call with its own key + config, holds a sideband (re-assert config, hang up)
```

- **Credential (corrected):**
  - With OpenAI, use the **unified interface**. The edge's SDP offer goes over
    the E2E control plane to the key holder, which creates the call with its
    own key and session config and returns the SDP answer. **No token ever
    reaches a device.** The key holder keeps a sideband: it re-asserts the
    config, enforces a duration and spend cap, and hangs up on voice-off,
    detach or cap.
  - True residual bound: while the call is up, the edge can change
    instructions/tools over its data channel, until the sideband re-asserts or
    hangs up. Exposure = one call, ≤ the cap.
  - Gemini: `uses: 1` + `liveConnectConstraints` pin for real.
  - A pod never creates a call.
- **Second provider (corrected):** when the session runs on Claude or local
  Qwen, C makes OpenAI/Google a **new recipient** of the user's voice and the
  digest (task, file names, recent exchanges). That is C's main privacy cost.
- **Who talks:** the S2S model speaks. It cannot be forced to read text
  verbatim, and its digest is pod-supplied in `run`/`attach`. Therefore:
  - permission asks are never spoken by it (§6.1);
  - "digest-grounded progress" is **not enforceable** on an S2S model, only on
    B+ (templates).
- **Persistence:** what enters the session is `ask_tentacle(text)`, a
  **model-written paraphrase**, not the user's words. Persist it as an
  attributed entry (origin `voice-front`) with the provider's input transcript
  alongside. Never as the user's message.
- **Latency:** front-only 0.8–1.8 s on every path. Delegated 2.0–5.4 s (§5).
- **Cost:** $0.15–0.30/min [S].
- **Edge code:** per provider.
- **Strength:** full-duplex, the most natural conversation.

#### 6.1 Who speaks a permission ask (rule, all candidates)

1. The ask's text comes from the **broker** on the device that answers it, and
   is rendered by a deterministic `voice-view` template: the tool, the exact
   command/path, verbatim. Local TTS speaks it, and it is shown on screen.
2. It **never passes through a front model** (B+ or C). In C the edge ducks or
   truncates the S2S output while the ask plays. The digest says only "a
   permission ask is pending", with no details.
3. The answer is a key press or tap, bound to the broker's request id and to the
   rendering just shown and spoken. A voice "yes" is not accepted in v1
   (misrecognition, echo).
4. If the ask text is too long to speak, the spoken template says "a command
   needs approval, see the screen", and nothing is approved without the screen.

### 7. Recommendation

*— claude-opus-5-5, 2026-11-13 (round 2)*

**"Three planes, one session"** (unchanged), with the live plane re-decided and
voice first.

1. **Control plane (unchanged).** JSON-RPC text, one session path, every
   permission and every effect.
2. **Live plane, voice: B → B+, C only if measured worth it.**
   - **One seam:** a `VoiceFront` at the edge consumes audio and produces
     `session/prompt` / `enqueue` / `cancel`. It consumes `session/update`
     through the pure `voice-view` projection and produces audio. B, B+ and C
     are implementations behind it.
   - **B (the base)** gives hands-free conversation on every path and every
     model, with the voice-turn profile (reasoning off, earcon, clause-chunked
     TTS, smart-turn endpointing).
   - **B+ is the realtime mode.** It reaches C's front-only band, matches B on
     delegated turns, and keeps every §7 invariant with no new credential and,
     by default, no new provider.
   - **C** (OpenAI unified-interface WebRTC first, Gemini second) is built only
     if E4/E5 meet the decision rule in §8, and then as an opt-in for the
     full-duplex feel, behind a spend cap.
   - **Laptop voice runs where the mic is.** A small native helper (Swift
     `AVAudioEngine` voice processing for AEC; Linux later) is spawned by the
     TUI on the same machine. If the TUI runs over SSH or in a remote tmux,
     laptop voice is disabled with a notice, and the phone is the voice edge
     for remote sessions.
3. **Blob plane (scoped down, after voice).**
   - **Scope:** binary frames only where bytes actually travel. The `connect`
     WebSocket gets binary WS frames (33 % on uploads). The phone Noise path
     gets the outer base64 removed: 1.78× → 1.33×, a contained change to
     `noise-frame.ts`. Inner removal (→ ≈ 1.0×) comes with `blob/*`.
   - **Not in scope:** stdio/k8s/docker framing. No consumer: bytes never enter
     a pod, and the audio helper runs locally. If one is needed later, the
     reader has three first-byte cases (`{`, the binary tag, the blank
     keepalive line).
   - **Upload protocol:** `blob/open` → binary chunks → `blob/ack {have}`,
     replacing `attachment/put` with a `protocol.d/` note. Binary frames go to a
     `BlobMux` beside `RpcPeer`, never through dispatch. Locality rule: bytes go
     to the model-connection holder, never into a pod. Chunks shrink to
     16–32 KiB while a live lane is open.
   - **Gated on E1/E2**, with the baseline including native `atob`/`btoa`.
4. **Live vision: pull by default.** A `look` tool takes the latest edge frame
   (capture only while toggled on, with a visible indicator) over the blob plane
   as an image ref. Over a pod, `look` is a pod→laptop effect, so the laptop's
   broker gates it. Push (1 fps) goes only to a realtime front that takes video.

### 8. Experiments (spikes in `.tentacle/tmp/eval-realtime-media/`, each with pass/fail)

Voice experiments come first. Each measures end of speech → first audible word,
reported separately for **front-only** and **delegated** turns (delegated =
first word of the session's actual answer), warm and cold.

| # | Spike | Measures | Pass | Decides |
|---|---|---|---|---|
| E4 | **B and B+ on the owner's Mac.** Silero + Smart Turn v3 + Parakeet-MLX → (B) the session model direct, reasoning off; (B+) front candidates: same-provider small (Haiku), local small (MLX), Groq `gpt-oss`; TTS on-device (Kokoro/Apple) vs one cloud TTS. 30 scripted coding-session utterances, 100 k context; speculative delegation on/off; idle gap 0 and ≥ 6 min (cache-TTL test). | p50/p95 front-only and delegated; cold load time | B+ front-only p50 ≤ 1.0 s; B delegated p50 ≤ 2.0 s (reasoning off) | V2, V3 |
| E5 | **C on the same 30 utterances.** OpenAI `gpt-realtime-2` via the unified interface (SDP relayed by a Bun "key holder"), WebRTC from the phone and the Mac; sideband hang-up; barge-in stop. | p50/p95 front-only and delegated; cold connect; stop latency | — (feeds the rule below) | V5 |
| E9 | **Front routing accuracy.** The B+ front on 100 labelled utterances (answer vs delegate), digest seeded with pod-style injected text. | misroutes; injected-text obedience | ≥ 95 % correct routes; 0 state claims outside templates | V3 |
| E6 | **AEC/barge-in on the laptop.** Swift helper, `AVAudioEngine` voice processing, built-in speakers **and AirPods**; TUI in Terminal/iTerm (whose mic permission prompt appears) | false barge-ins / 5 min; stop latency | < 1 / 5 min; stop < 100 ms | V1 |
| E10 | **Phone audio.** iOS 26 `SpeechAnalyzer` streaming + system TTS (or Kokoro) on built-in speaker and AirPods; on-device Foundation Models as a front. | first partial; TTS first audio; front TTFAT | B+ on-device front-only p50 ≤ 1.2 s | V4 |
| E7 | Phone → relay → `serve` small-frame RTT on 4G/5G | p50/p95 | p50 < 150 ms | V4 |
| E8 | `react-native-webrtc` in our dev build | builds, connects to OpenAI | works on iOS 26 | V5 phone |
| E1 | 15 MiB image, base64-JSON vs binary: Bun↔Bun WS; Noise `t1:` vs outer-base64-removed vs full `blob/*` | wire bytes, CPU ms both ends | ≥ 25 % fewer bytes (WS), ≥ 2× less CPU | B1/B2 |
| E2 | iPhone: Hermes native `btoa`/`atob` vs our pure-JS base64; `@noble` ChaChaPoly MB/s; RN `WebSocket` binary send (base64 across the bridge or not) | MB/s, ms per 256 KiB | encrypt ≥ 20 MB/s, else a native crypto module | B1 phone |
| E3 | Head-of-line: control frames during a 15 MiB upload, 5 Mbit/s · 50 ms · 1 % loss; chunk 256 vs 16 KiB | p99 delay | p99 < 100 ms | B2 chunk policy |

**Decision rule, B+ vs C:** build C only if (a) C's front-only p50 beats B+'s by
≥ 300 ms **and** (b) C's delegated p50 is no more than 500 ms worse than B+'s,
**or** the owner, having heard both side by side, wants full-duplex enough to
pay for it. My expectation, unverified: B+ wins (b) by 1–3 s.

E4/E5/E9/E6 need the owner's Mac and API keys (≈ $2–5). E10/E7/E8/E2 need the
phone. E1/E3 need neither.

### 9. Phased roadmap (voice first; each phase useful alone; sized per §10)

| Phase | Task (slug) | Delivers alone | Size · Blast | Suited |
|---|---|---|---|---|
| V0 | E4, E5, E6, E9 (spikes, no code in tree) | the B/B+/C numbers and the decision | — | Opus + owner |
| V1 | `feat/voice-dictation` — laptop Swift helper (AEC, VAD, Smart Turn, on-device STT) → prompt text; local terminal only | push-to-talk dictation, private, any model | M · cross-module (new helper binary, no protocol) | DeepSeek after E6 |
| V2 | `feat/voice-conversation` — `VoiceFront` seam + pure `voice-view` (templates, clause chunking, §6.1 asks) + edge TTS + local barge-in + voice-turn profile (reasoning off, earcon) = **B** | hands-free conversation, every path, every model | L · cross-module → split in plan | Opus plan, mandatory fresh review |
| V3 | `feat/voice-fast-front` — B+ front: digest projection (pure), route-first front call at the key holder (same provider / local), verbatim-transcript delegation, opt-in speculative delegation | **realtime mode**: sub-second acknowledgements, delegated ≈ B | M · load-bearing (new key-holder model call; §6.1) | Opus plan + fresh review |
| V4 | `feat/voice-phone` — B/B+ on iOS (`SpeechAnalyzer`, TTS, AEC); front at `serve` or on-device | voice from the phone, also for remote sessions | M–L · cross-module | Opus plan after E10/E7 |
| V5 | `feat/voice-realtime-s2s` — **only if the §8 rule passes**: C via unified-interface WebRTC, key-holder sideband + spend/duration cap | full-duplex opt-in mode | L · load-bearing (§7 key/identity) → split per edge | Opus plan, mandatory fresh review |
| B1 | `feat/noise-binary` — Noise outer base64 removed (WS binary frame carrier) | phone uploads 1.78× → 1.33×, less CPU | S · cross-module (phone ↔ `serve` framing, `protocol.d/` note) | DeepSeek after E1/E2 |
| B2 | `feat/blob-upload` — binary WS frames on `connect` + `blob/*` replacing `attachment/put`, `BlobMux` | images ≈ 1.0× on WS and Noise | M–L · load-bearing (transport + protocol) | Opus plan, DeepSeek slices, fresh review |
| B3 | `feat/media-attachments` — audio/video refs, provider capability map, transcription fallback at the key holder | voice memos / screen recordings with any model | M · load-bearing (protocol, persistence) → split | Opus plan |
| B4 | `feat/live-vision` — edge frame ring + `look` (pull), broker-gated over pods | "look at my screen" | M · load-bearing (pod→laptop effect) | Opus plan |

Each phase is useful alone:
- V1 is dictation.
- V2 is conversation.
- V3 is the fast mode.
- V4 is the phone.
- V5 is optional.
- B1 makes phone uploads cheaper.
- B2 makes `connect` and the phone path cheaper.
- B3/B4 are features.

There is no "substrate-only" phase and no RPC without a caller. Dependencies:
- V2 needs V1's helper.
- V3 needs V2's seam.
- V4 reuses V2/V3's pure modules.
- V5 needs V2's seam (not V3).
- B2 subsumes nothing of B1 (B1 is the carrier, B2 the payload).
- B3/B4 need B2.

Per §10 code tasks run one at a time. I recommend V1 → V2 → V3 → V4, then
B1/B2 when the owner wants blobs. B1 is S and could slot in anywhere.

### 10. Failure modes the plans must design out

- **Edge voice (B/B+):**
  - AEC failure → false barge-in loop. Raise the VAD threshold during playback
    (E6).
  - Bluetooth route change mid-turn → re-open the audio session and re-measure
    latency.
  - Network drop mid-reply → speak "connection lost". The session continues
    daemon-side (detach, never close).
  - SSH/remote TUI → voice disabled with a notice, never a helper capturing the
    wrong machine.
- **Front (B+):**
  - Misroute → the user can always say "ask tentacle"; a forced delegate.
  - The front claims state → impossible by construction: state is spoken only
    from templates (E9 tests injected digest text).
  - Speculative delegation cancelled → `session/cancel` before any tool runs.
    If a tool already started, the turn is kept (never silently dropped).
  - Front model error/timeout → fall back to B for that turn (delegate).
- **S2S front (C):**
  - Call duration/spend cap hit → the sideband hangs up, and the edge says so.
  - Provider session cap (Gemini ~15 min) → re-create the call + re-seed the
    digest.
  - Data-channel `session.update` from the edge → the sideband re-asserts the
    config, or hangs up.
- **Permission asks:** §6.1. A pod-supplied ask text is spoken verbatim from
  the broker, never paraphrased, and answered only by key/tap.
- **Two voice edges on one session** (laptop + phone) → each is a client; prompts
  queue as today; only the edge holding the broker's ask may answer it.
- **Blob plane:**
  - Unknown stream → drop + `have` resync.
  - Binary before `initialize` → close.
  - Oversize length → close before allocation.
  - A pod lying in acks keeps today's bound.
- **Live vision:**
  - Capture left on → indicator + auto-off.
  - A pod asks `look` → laptop broker prompt, no lasting approval.

### Owner questions

Each is a separate decision.

1. **Supervisor split.** A fast front handles conversational turns; substantive
   turns go to the tentacle session as the user's **verbatim transcript**, and
   the brain's own answer is spoken. *Recommendation: yes.* It is the shape
   that gives sub-second acknowledgements while keeping one session path.
2. **Front modality: cascade (B+) or provider S2S (C)?** These are separate
   from Q1. *Recommendation: B+ is the realtime mode.* Build C only if E4/E5
   meet the §8 rule (or you prefer full-duplex after hearing both). Sourced
   numbers put B+ in C's front-only band (0.55–1.9 s vs 0.8–1.8 s), with
   delegated turns 1.3–3 s faster.
3. **Which model is the front, and who may see voice data?** *Recommendation:*
   the same provider as the session (Haiku for Claude, a small local model for
   local Qwen), called at the key holder, or on-device. A faster third-party
   front, or C's OpenAI/Google, is opt-in only, and the UI states that it
   receives your voice/transcript and the session digest.
4. **Who speaks a permission ask?** *Recommendation:* the broker's own text,
   rendered by a template and spoken by local TTS + shown on screen. It never
   passes through a front model. Answered only by key/tap bound to that
   rendering; no voice approval in v1.
5. **Reasoning for voice turns?** *Recommendation:* off (or minimal) for every
   spoken reply, front and brain alike. That saves ≈ 3 s [S]. A delegated task
   that does real work keeps the session's reasoning setting, with progress
   narrated by templates.
6. **Remote-terminal topology.** *Recommendation:* laptop voice v1 =
   local-terminal only, via a native Swift helper next to `tentacle` (Bun has no
   audio I/O; AEC is what makes barge-in work). Over SSH/remote tmux it is
   disabled with a notice, and the phone is the voice edge for remote sessions.
7. **If C is built: credential and spend cap.** *Recommendation:* OpenAI's
   unified interface, so no token ever reaches a device. The key holder creates
   each call with its own key and config, keeps a sideband, and hangs up at a
   per-call duration cap and a daily spend cap (default: 30 min per call,
   $3/day, configurable). True residual: during a call the edge can change the
   instructions until the sideband re-asserts them.
8. **What is persisted of a voice conversation?** *Recommendation:* the verbatim
   transcript as the user message. `via: "voice"` becomes an optional field on
   that entry, non-critical per the on-disk rules (an older build ignores it),
   to be confirmed in the V2 plan. Front chit-chat is display-only, audio is
   never kept, and in C the paraphrase is an attributed `voice-front` entry,
   never the user's message.
9. **Do binary blobs come before voice?** *Recommendation: no.* Voice needs no
   blob plane. Run V1→V4 first. The blob track is scoped to the hops that carry
   bytes (B1 Noise outer base64, S; B2 `connect` WS + `blob/*`, breaking with a
   `protocol.d/` note), gated on E1/E2. Live video stays pull-by-default
   (`look`) after B2.

## Implementation

*(empty until the eval is promoted — each phase above becomes its own `feat` with its own plan)*

## Execution

*(empty — eval)*

## Review

### Design reviews

#### Design review response (Fable REVISE)

*— claude-opus-5-5, 2026-11-13. Review: `claude-fable-5-2`, 2026-11-13, fresh context, verdict REVISE.*

Every code citation in the review was re-checked. All hold; one line has
drifted (`serve.ts:634` → `:723`). The web facts were re-checked on 2026-11-13.

| Finding | Verified? | Change / rebuttal |
|---|---|---|
| **H1** C's "0.6–1.0 s on every path" is unsourced and covers chit-chat only | Yes: the lower bound rested on Fora (no method); OpenAI itself reports 1.12 s minimal | §5 rebuilt: every hop tagged [S]/[V]/[E]/[M], separate front-only and delegated rows. C is now 0.8–1.8 s front-only and 2.0–5.4 s delegated (two extra S2S hops). E5 measures both kinds of turn. |
| **H2** missing B+ (cascade front) | Yes. Pipecat Aug 2026 gives sourced small-model TTFATs of 98–637 ms | §6 B+ added and compared head to head with C (§5 table, §6 gains/losses). **B+ is now the realtime mode**; C is gated by a §8 decision rule. One refinement over the review: B+ forwards the *verbatim transcript* and speaks the brain's own text, so delegated = B, not B + one hop. One partial rebuttal: B+ removes the second provider only when the front is same-provider/local/on-device, so that is made the default (Q3). |
| **H3** ephemeral token pins nothing (OpenAI) | Yes, quoted from the client-secrets reference (start-bound expiry, multi-session, client override) | §4/§6 C corrected. A stronger fix than the review's: OpenAI's **unified interface** needs **no device token at all** (the key holder relays the SDP), plus a sideband cap and hang-up. Gemini's real pinning is noted. P5a (token RPC) removed. Q7 states the true residual bound and a spend cap. |
| **H4** asks spoken by an S2S paraphrase of pod-supplied text | Yes, against §7 "a pod is not trusted" | §6.1 rule: broker text → template → local TTS + screen, never via a front; key/tap bound to that rendering; the digest omits ask details. "Digest-grounded progress" is declared unenforceable in C and enforced by templates in B+. Q4. |
| **M1** missing hops (first clause, reasoning, cold start, Bluetooth, C barge-in on WS, warm-up scope) | Yes; reasoning deltas confirmed in code; Pipecat reasoning rows sourced; AirPods latency sourced | All added to §5 (clause, reasoning ±3 s, BT +100–160 ms, cold start list, warm-up only after idle > cache TTL). C now uses WebRTC on the laptop too (server-side truncation). E4 gains idle-gap and AirPods cases; E6 covers AirPods. Q5 decides reasoning. |
| **M2** phase order vs goal; stdio framing has no consumer | Yes (`streamChannel` only in pod/stdio users; bytes never enter pods; k8s keepalive lines) | Voice first (V0–V4). Blob track scoped to WS + Noise, stdio framing dropped, gated on E1/E2. Q9. |
| **M3** phases not useful alone; "P5 needs P4" is a choice | Yes | No substrate-only phase or caller-less RPC. B1/B2 are user-visible savings. V5 depends on V2's seam only. |
| **M4** C adds a second provider | Yes | §6 C states it as C's main privacy cost; Q3 makes any new recipient opt-in and visible. |
| **M5** C persists a paraphrase as the user's words; `via` is an on-disk change | Yes | B+ persists the verbatim transcript. C's paraphrase is an attributed entry. `via` is flagged as an optional non-critical field for the V2 plan (§3.8, Q8). |
| **M6** "the edge" assumed local; macOS mic attribution | Yes | Local-terminal only in v1, disabled over SSH with a notice, phone for remote (§7, Q6). E6 checks which app gets the mic prompt. |
| **M7** stale facts: Bun QUIC, Hermes btoa, cost | Yes: Bun v1.3.14 http3 experimental; Hermes btoa since RN 0.74; $0.15–0.30/min | §4 corrected (the conclusion "no UDP plane" now rests on no WebTransport). §2 Hermes row fixed; E2 baseline includes native `btoa`. Cost updated. |
| Owner questions mis-framed | Yes | Rewritten as nine separate decisions, each with a recommendation. |

**Still unverified** (each with the experiment that settles it):
- Kokoro and Apple on-device TTS first audio, and on-device front TTFAT on the
  owner's Mac/iPhone (E4, E10).
- The RN 0.88 `WebSocket` binary path (E2).
- Whether OpenAI's sideband can re-assert config fast enough to bound a
  malicious edge (E5).
- Upper ranges marked [E] in §5.

*(pending the owner's verdict on the questions above)*
