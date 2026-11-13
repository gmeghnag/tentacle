# eval/realtime-media — one media architecture: binary blobs, audio/video files, live streams, realtime voice

> **Status:** context · review (pending the owner's verdict)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** — · **Blast:** load-bearing (transport, protocol, §7 "model stays on the laptop" / "a pod is not trusted") · **Suited:** — (decision record; the recommended tasks are sized in §9)
> **Subsumes:** `TODO.md` `eval/binary-frames` and `eval/attachments-audio-video` (both stay open as the phase-1/phase-2 entries this eval sizes; their questions are answered here)

## Context

*— claude-opus-5-5, 2026-11-13*

### 1. The question

Owner, 2026-11-13: *"dobbiamo lavorare bene e con una visione fuori dagli schemi
per rendere il tutto più fluido possibile. Nella mia vision c'è anche la
possibilità di parlare realtime con tentacle, quindi le performances devono
essere altissime, latenza bassissima. Ciò richiede una visione architetturale
eccelsa."* and *"ogni efficientamento è da perseguire"*.

The exact questions this eval decides:

- **Q-A — Blobs.** How do bytes (images today; audio/video files next) travel on
  every hop — worker `MessagePort`, `connect` WebSocket, pod stdio over k8s exec /
  docker, the phone's Noise E2E channel through the relay — without base64 in
  JSON-RPC text?
- **Q-B — Where media goes.** Which process does each kind of media flow to:
  the daemon that runs the agent loop, or the process that holds the model
  connection? (Today these differ for pods.)
- **Q-C — Live media.** How does the model "watch" a camera/screen stream, and
  which models can?
- **Q-D — Realtime voice.** How do we reach sub-second voice turns with barge-in
  from the TUI/laptop and from the phone, across the four runtime paths, without
  breaking a §7 invariant?
- **Q-E — Order.** Which phases, each useful on its own, in which order, sized
  per §10, and which experiments must pass before each one is planned.

Docs only. No code before approval.

### 2. Today, verified against the code (2026-11-13)

| Fact | Source |
|---|---|
| A `DuplexChannel` moves **text frames only** (`send(data: string)`). Every transport (WS, stdio, `MessagePort`, Noise) implements this one interface. | `packages/transport/src/channel.ts:9-18` |
| Image upload is `attachment/put`: one **base64** chunk per JSON-RPC request, 256 KiB raw → **349 528 chars**, resumable via `have`. | `packages/protocol/src/attachment-upload.ts:26,29,40-51` |
| Image cap 15 MiB. | `packages/protocol/src/attachment.ts:37` |
| The stdio channel (what `serve --stdio` / k8s exec / docker pipe) is **newline-delimited JSON**; the whole buffer is a JS string. | `packages/transport/src/stream-channel.ts:41-55` |
| The k8s exec WebSocket is already **binary** underneath (`binaryType = "arraybuffer"`, `send(Uint8Array)`), it just carries text lines. | `packages/k8s/src/exec-channel.ts:38,87-93,188` |
| The Noise E2E channel frames each Noise message as text `t1:` + **base64** — so on the phone path an image chunk is base64 (JSON) of bytes, then UTF-8, then encrypted, then **base64 again**: 256 KiB raw → ≈ 466 000 chars on the wire = **1.78× the bytes**, plus two encode/decode passes in pure JS (Hermes has no `Buffer`/`btoa` for certain). | `packages/transport/src/noise-frame.ts:1-15,100`; `noise.ts:18` (65 535-byte Noise max) |
| Noise = `Noise_IK_25519_ChaChaPoly_SHA256`, `@noble/*` pure JS, **strictly sequential nonces** (no loss tolerance: needs an ordered, reliable carrier). | `packages/transport/src/noise.ts:1-18,110-140` |
| The RPC peer dispatches requests concurrently (`void this.handleRequest`) and parses every frame with `JSON.parse`; the WS server caps a frame at 8 MiB. | `packages/transport/src/peer.ts:281-290,322`; `packages/daemon/src/ws-server.ts:54` |
| Model-stream deltas are coalesced (30 ms window, 64 Ki chars/batch) to amortise per-frame cost on slow links. | `packages/client/src/remote-client.ts:658-668` |
| **Pods get image REFS, never bytes**: in `run`/`attach` the provider is the laptop's, each model call comes back as `model/stream*`, and the laptop resolves refs from its own scoped source. Owner Q2 (attachments-upload): *"no bytes in a pod"*. | `docs/feat/attachments-prompt.md:30-31,125-135`; `docs/feat/attachments-upload.md:406-411,660` |
| The `ModelProvider` contract is request/response streaming text+tools: `stream(ChatRequest): AsyncIterable<StreamEvent>`. No audio, no bidirectional session. | `packages/core/src/model.ts:162-175` |
| Phone path: app ↔ (Tailscale / LAN / cloudflared / **relay** `wss://<relay>/d/<daemon-id>`) ↔ `serve`, Noise inside, relay sees opaque bytes. | `docs/eval/mobile-app.md:60-82` |

**The precedent that shapes everything below:** the attachments work already
established that *bytes go to where the model connection is, not to where the
agent loop is*. For pods those are different processes, and the bytes never
enter the pod. This eval generalises that rule to every kind of media.

### 3. Constraints from AGENTS §7 (what any answer must keep)

1. **One session path over RPC.** Voice/video must not become a second agent
   loop or a second session code path. A voice UI is a *client* of the same
   session (`session/prompt`, `session/update`), like the TUI and the phone.
2. **Model stays on the laptop / key with the identity.** A pod never holds a
   provider credential. In `run`/`attach` the model connection is on the laptop,
   so **audio for the model must never transit the pod** (it would be a hairpin
   laptop→pod→laptop anyway).
3. **A pod is not trusted.** Any pod-originated request for a laptop effect
   (e.g. "grab a camera frame") is gated on the laptop (allowlist + broker
   prompt), never a lasting approval for pod input.
4. **Protocol versioned honestly; pre-public breaking changes allowed** with a
   `protocol.d/` note (no compat shims).
5. **Don't serialize the peer.** Media must never sit behind a long
   `session/prompt` handler, and a big upload must never stall audio. (TCP adds
   its own head-of-line blocking: §5.3.)
6. **Never write raw to the terminal while Ink owns it.** Audio I/O in the TUI
   lives in another process/thread; its diagnostics go through the notice paths.
7. **E2E on every phone path.** The relay sees opaque bytes only.

### 4. State of the art (web research, 2026-11-13)

Sources are mostly vendor docs and vendor/third-party blogs; numbers are
**directional** until our own experiments (§8) measure them.

**Speech-to-speech (S2S) realtime APIs.**
- **OpenAI Realtime** (`gpt-realtime-2` / `-2.1`, GA): WebRTC, WebSocket or SIP;
  server VAD or `semantic_vad` turn detection (`create_response` auto, or null
  for manual turns); on WebRTC/SIP an interruption truncates unplayed output
  server-side, on WebSocket the client must truncate; tools, remote MCP, image
  input. **Ephemeral client secrets** (`POST /v1/realtime/client_secrets` →
  `ek_…`, with `expires_at` and a pinned session config) let a client connect
  without the long-lived key; WebRTC sessions via `/v1/realtime/calls`.
  Price ≈ **$32 / $64 per 1 M audio tokens in/out** ($10/$20 mini); per minute
  ≈ $0.08 (heavy caching) to $0.24 (none) — previous audio is replayed into
  context each response. Measured first-audio claims vary: 220–400 ms WebRTC vs
  600 ms+ browser WebSocket (Fora, unmethodical); 1.12 s at minimal reasoning,
  2.33 s at high for `gpt-realtime-2` (HandyAI). Sources:
  [OpenAI client secrets ref](https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret),
  [Fora, Realtime pricing, Nov 2026](https://www.forasoft.com/blog/article/openai-realtime-api-pricing),
  [Fora, WebRTC/SIP/WS 2026](https://www.forasoft.com/blog/article/openai-realtime-api-webrtc-sip-websockets-integration),
  [Cekura pricing 2026](https://www.cekura.ai/blogs/openai-realtime-api-pricing),
  [HandyAI, gpt-realtime-2](https://handyai.substack.com/p/model-drop-gpt-realtime-2),
  [CallSphere WS vs WebRTC 2026](https://callsphere.ai/blog/vw1c-openai-realtime-websocket-vs-webrtc-tradeoffs-2026.md).
- **Gemini Live API**: WebSocket; input raw PCM16 16 kHz LE (other rates
  resampled), output PCM16 24 kHz; video **1 fps**; ephemeral tokens for
  clients; context 128 k (32 k default on some Vertex models); sessions ≈ 15 min
  audio-only, ≈ 2 min audio+video without context compression, extendable with
  compression + session resumption. One third-party benchmark (Stream) measured
  Gemini Live's first audio ≈ 3 s at 1 fps video, slower than OpenAI. Gemini
  token rates for files: **32 tokens/s audio, 263 tokens/s video**. Sources:
  [Firebase Live API limits](https://firebase.google.com/docs/ai-logic/live-api/limits-and-specs),
  [Gemini token counting](https://ai.google.dev/gemini-api/docs/tokens),
  [Stream, S2S APIs 2026](https://getstream.io/blog/speech-apis/),
  [Google Cloud Live API ref](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/live-api).
- **Anthropic**: no public realtime/audio-input API found. Claude's consumer
  voice mode is a cascade (STT → model → third-party TTS, reportedly
  ElevenLabs); Opus/Sonnet in voice mode since 2026-07-23. **Claude Code
  `/voice`** (2026-03-03): push-to-talk *dictation into the prompt*, input only,
  audio streamed to Anthropic. Sources:
  [TechCrunch 2026-03-03](https://techcrunch.com/2026/03/03/claude-code-rolls-out-a-voice-mode-capability/),
  [The Decoder, Claude voice on Opus/Sonnet](https://the-decoder.com/claudes-voice-mode-now-runs-on-anthropics-most-capable-models-across-all-platforms/),
  [The Decoder, ElevenLabs](https://the-decoder.com/anthropics-claude-uses-elevenlabs-technology-for-speech-features-rather-than-an-in-house-model/).
  Consequence: **the owner's main models (Claude, local Qwen) cannot be the
  voice in an S2S loop**. Either a cascade wraps them, or an S2S model fronts
  them.

**Cascaded STT → LLM → TTS.** Streaming cascades land in the same band as S2S
when every stage streams. Stage figures: STT partials 100–300 ms, LLM TTFT
200–600 ms, TTS first audio 75–300 ms (Cartesia Sonic 40–90 ms), total typically
600–1200 ms. Production systems are often 1.5–3 s. An independent live-call benchmark
(Coval, Oct 2026, reported by Cartesia) put S2S at 0.8–1.8 s end-of-speech →
first audio. Network between stages, not the stages, often dominates: co-locating
STT cut Deepgram TTFB 250 → 110 ms (Cerebrium). Sources:
[Cartesia, S2S vs cascaded](https://www.cartesia.ai/learn/speech-to-speech-vs-cascaded),
[Softcery latency budget](https://softcery.com/lab/voice-agent-latency-budget-microphone-to-speaker),
[Cerebrium buyer's guide](https://cerebrium.ai/resources/speech-to-speech-vs-cascaded-voice-agent-latency),
[FutureAGI 2026](https://futureagi.com/blog/cascaded-voice-ai-vs-speech-to-speech-2026/).

**Turn detection and barge-in, the biggest levers.** End-of-turn detection is
"the biggest hidden cost". Default endpointing waits 0.5 s of silence (LiveKit
community: most of a 600 ms delay). Smart Turn v3 (Daily/Pipecat) is an ~8 MB
int8 ONNX audio model, **~12 ms on CPU**, BSD-2. Deepgram Flux claims median
end-of-turn < 300 ms (p95 ~1.5 s). An *eager end-of-turn* starts the LLM early
and cancels on resume, at +50–70 % LLM spend. **Echo cancellation must run
before VAD/ASR** or the agent's own voice triggers barge-in (NVIDIA). WebRTC
AEC3, and a ~60 ms "stop speaking" target, are common guidance. Sources:
[Daily Smart Turn v3](https://www.plushcap.com/content/daily/blog/daily-announcing-smart-turn-v3-with-cpu-inference-in-just-12ms),
[LiveKit turn detection](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection),
[LiveKit community, latency](https://community.livekit.io/t/high-turn-detection-latency-issue/958),
[NVIDIA barge-in FAQ](https://perspectives.nvidia.com/nemotron-speech/task/faq/how-do-i-implement-barge-in-detection-so-a-user-can-interrupt-a-voice-agent-whil/),
[AssemblyAI endpointing](https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent).

**Voice + a smarter brain = the "chat-supervisor" pattern.** OpenAI's own
reference app has a realtime voice agent handle the conversation and delegate
tool use and hard reasoning to a text model through one tool
(`getNextResponseFromSupervisor`). That is exactly tentacle's shape: a fast
voice front with a small context, and the tentacle session as the supervisor.
Source: [openai/openai-realtime-agents](https://github.com/openai/openai-realtime-agents).

**Local/private voice (owner runs local Qwen).** The common local stack in 2026
is Silero VAD + streaming STT (Parakeet TDT on MLX, whisper.cpp/Metal) + local
LLM + Kokoro / Qwen3-TTS. Kyutai Moshi is the full-duplex local S2S option
(80 ms codec latency, ~200 ms practical on an L4; M-series figures
unpublished). One M3 Pro Kokoro pipeline reported 2.5–3 s end to end, so local
needs care. Sources:
[Moshi README notes 2026-05](https://jc-aiwiki.pages.dev/ai-voice/moshi-kyutai),
[local stack on Apple Silicon, 2026-03](https://dev.to/xadenai/building-a-local-voice-ai-stack-whisper-ollama-kokoro-tts-on-apple-silicon-eo0),
[HN: best local S2S](https://hn.nuxt.dev/item/46731068).

**Transports.** WebRTC gives UDP, Opus, a jitter buffer, and (on iOS/browsers)
the platform's echo cancellation. In Expo it needs a dev build with
`react-native-webrtc` + `@config-plugins/react-native-webrtc` (not Expo Go).
WebTransport is Baseline since **Safari 26.4** (2026-03), but React Native has
no WebTransport and we found **no evidence of a QUIC/HTTP3 server in Bun** we
could rely on. WebRTC in Bun is unproven too: `werift` is pure TS (no AEC);
`node-datachannel` under Bun is unverified. Sources:
[webrtc.ventures, WebTransport Baseline, 2026-04](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/),
[Expo react-native-webrtc plugin](https://npmjs.com/package/@config-plugins/react-native-webrtc),
[IETF WebTransport-H3 draft-16, 2026-07](https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/).
Consequence: **we should not build or host a UDP media plane**. Where UDP matters
(the phone on cellular), let the *provider's* WebRTC endpoint be the far end.

**Raw rates (arithmetic, ours).** PCM16 mono 16 kHz = 256 kbit/s (640 B per
20 ms frame); 24 kHz = 384 kbit/s; Opus voice 16–32 kbit/s (40–80 B per 20 ms).
The same PCM as base64-in-JSON ≈ 350 kbit/s + one JSON envelope per frame.
1 fps JPEG at 768 px ≈ 50–100 KB/frame ≈ 0.4–0.8 Mbit/s. Text deltas of a
spoken reply ≈ 15 chars/s, about 1000× smaller than audio.

### 5. Latency budgets (end of user speech → first audible reply)

Component estimates (§4 + our arithmetic). They are **targets to measure**
(§8 E4–E7), not measurements.

| Component | Range | Note |
|---|---|---|
| Capture + AEC/NS frame | 10–30 ms | 10–20 ms frames |
| Endpointing (end-of-turn) | 150–500 ms | smart-turn + ~150 ms min silence ≈ 200 ms; default 500 ms silence = the classic trap |
| Streaming STT final after endpoint | 50–300 ms | on-device Parakeet/Apple ≈ 50–150 ms |
| Brain first token (cloud, big coding context, cached prefix) | 400–1500 ms | the dominant term for a tentacle session (50–150 k tokens) |
| Brain first token (small front context) | 200–600 ms | S2S model or fast small model |
| TTS first audio | 50–300 ms | Apple on-device ≈ tens of ms; Kokoro local 100–300 ms; Sonic 40–90 ms |
| Playout / jitter buffer | 20–60 ms | |
| Barge-in stop (local) | < 60 ms | only if decided **on the device with the speaker** |

Path transport (one way, small frames; RTT = 2×):

| Path | One-way | Notes |
|---|---|---|
| Laptop local (in-process worker, `MessagePort`) | < 1 ms | |
| `connect` → `serve`, LAN / Tailscale direct | 1–10 ms | |
| `connect` → `serve`, WAN | 15–60 ms | TCP: a lost packet stalls everything behind it ≈ 1 RTO (≥ 200 ms) |
| Pod `run`/`attach` (laptop ↔ API server ↔ kubelet ↔ pod) | 10–60 ms | two proxies, HOL on every hop |
| Phone → relay (Hetzner) → `serve` | 30–90 ms | 4G/5G jitter; Noise in pure JS (CPU: E2) |
| Edge → provider directly (WebRTC/WS) | 15–50 ms | one hop to an anycast edge |

**Budgets per candidate (§6), p50 targets:**

| Path | A: audio over the session pipe to a daemon-held voice model | B: edge cascade, text-only wire, session as the brain | C: edge-direct S2S front + session as supervisor |
|---|---|---|---|
| Laptop local | 0.8–1.1 s (≈ C + one in-process hop) | 1.0–2.4 s (brain TTFT dominates) | **0.6–1.0 s** |
| `connect` → `serve` | 0.9–1.3 s, WAN loss spikes | 1.1–2.5 s | **0.6–1.0 s** (path not on the voice loop) |
| Pod `run`/`attach` | ✗ hairpin laptop→pod→laptop, or a pod holding a key (§7 ✗) | 1.0–2.4 s (text RTT only) | **0.6–1.0 s** (laptop holds the key) |
| Phone → relay → `serve` | 1.0–1.5 s, cellular TCP HOL spikes ≥ 200 ms | 1.1–2.6 s | **0.6–1.0 s** (phone → provider directly) |

For delegated work (the session actually *doing* something) every candidate
pays the brain's TTFT plus tool time, measured in seconds. What makes voice feel
realtime there is **what the front says while the brain works** (§6 C), not the
transport.

### 6. Candidate architectures

The common base for all three is the control plane: JSON-RPC stays exactly as
it is for every session, permission and model-stream message. The candidates
differ in **where audio/video bytes go** and **who talks**.

#### Candidate A — "Everything through the pipe": binary media lanes on the session channel, voice model held by the daemon

```
 mic/spk ─┐                                                     ┌─ provider S2S / cascade
          ▼                                                     │   (key on the daemon host)
 [TUI/phone] ══ DuplexChannel (WS | stdio | Noise) ══► [daemon] ┘
     JSON-RPC text frames  +  binary lanes: audio 20 ms frames, video frames, blob chunks
```

- Every byte crosses the existing channel as binary frames with a lane header.
  The daemon opens the realtime model session (or runs STT/TTS) and feeds the
  agent loop.
- **Latency:** + one path hop each way on the voice loop. Fine on LAN, poor on
  cellular through the relay (TCP head-of-line: one lost segment stalls audio
  ≥ 200 ms).
- **Throughput/CPU:** Opus 32 kbit/s is trivial. But on the phone every 20 ms
  frame goes through pure-JS ChaChaPoly + (today) base64 twice, at 50
  frames/s each way; and the app still needs a native Opus/AEC stack.
- **Security:** E2E inherited (Noise). **Pods ✗**: the daemon is in the pod but
  the key is on the laptop, so either audio hairpins pod → laptop `model/stream`
  (a bidirectional realtime session through `model/stream` does not exist, and
  would double the path), or the pod holds a key (§7 violation).
- **Complexity:** high. We would build jitter buffers, Opus, pacing and
  realtime scheduling over TCP in TS, the part WebRTC already solves.
- **Verdict:** right for **blobs** (files, frames on demand), wrong for the
  voice loop.

#### Candidate B — "Transduce at the edge": cascade on the device with the mic/speaker, only text crosses the wire, the session is the brain

```
 mic ─► AEC ─► VAD+smart-turn ─► STT ──text──┐                 ┌──────────────┐
                (on the device: laptop helper │  session/prompt │ tentacle     │
                 or iOS SpeechAnalyzer)       ╞═══ JSON-RPC ═══►│ session      │
 spk ◄─ TTS ◄── speakable text ◄──────────────╡ session/update  │ (any model)  │
   ▲  barge-in: local VAD stops playback      │  (text deltas)  └──────────────┘
   └──────────── at once, then session/cancel ┘
```

- **Voice is just another way to type and read.** STT turns speech into a
  `session/prompt` (or `session/enqueue` / steer while a turn runs). A pure
  `voice-view` module (the §7 "logic in pure modules" pattern) turns
  `session/update` into speakable text: a sentence-chunked stream of the reply,
  one-line narration of tool calls ("running the tests"), permission asks read
  aloud.
- **Latency:** the path carries only text (≈ 1 RTT, small frames), so
  **every runtime path is nearly equal**. The cost is the brain's TTFT on a big
  context. Mitigations, out of the box:
  1. **Warm on speech start.** When VAD sees speech begin, fire a no-output
     cache-warm request for the session prefix (prompt caching), so the real
     request's TTFT is a cached-prefix TTFT. It runs where the key is.
  2. **Eager end-of-turn.** Start the prompt at the first likely end (≈ 150 ms
     silence), cancel and re-prompt on resume. It costs tokens, so it is opt-in.
  3. **Voice-turn style.** A per-turn system note tells the model: "spoken
     reply: first sentence short, no code blocks". That gives a sooner first
     speakable sentence.
  4. **Instant local acknowledgement** (an earcon / "ok") at endpoint, so silence never
     exceeds ~300 ms even when the brain needs 1.5 s.
- **Throughput/CPU:** negligible on the wire. On-device STT/TTS costs
  CPU/ANE on the edge (laptop: MLX/Metal; phone: Apple's on-device
  `SpeechAnalyzer` (iOS 26) and the system TTS voices).
- **Security:** best of all. No audio leaves the device (with local
  STT/TTS); pods, relay and `serve` see text; nothing new to trust; works with
  **local models** (owner's Qwen) and Claude (no audio API needed).
- **Complexity:** medium. Platform audio I/O (a laptop helper, an iOS Expo
  module), a pure voice-view module, and **no protocol change** (text in, text
  out).
- **Weakness:** above 1 s on cloud brains with big contexts; turn-taking is
  half-duplex (no overlapping speech, no prosody understanding).

#### Candidate C — "Fast voice front, session as supervisor": the edge talks S2S to the provider directly; the session is a tool

```
                  ephemeral token (≤ 60 s to connect, pinned config)
           ┌────────────── minted by the KEY HOLDER ───────────────┐
           │  laptop (worker/run/attach): itself                   │
           │  phone / connect: `serve` over the E2E control plane  │
           ▼                                                       │
 mic/spk ◄═══ WebRTC (phone) / WS (laptop helper) ═══► provider S2S front
 [edge: TUI helper | phone]      Opus/PCM, AEC, VAD,     (gpt-realtime / Gemini Live)
           ▲                     barge-in server+local       │ tool calls
           │                                                 ▼
           └──── edge executes the front's tools as an ordinary CLIENT of the session ────┐
                 ask_tentacle(text) → session/prompt | enqueue                            │
                 status() → recent session/update digest                                  │
                 (permission asks → spoken, answered by key/tap: Q4)                      │
                                         JSON-RPC (unchanged path) ═══► tentacle session ─┘
```

- The S2S front holds a **small context**: a session digest (title, current
  task, the last few exchanges, running tools). It converses with full-duplex
  barge-in and sub-second replies. Everything substantive is delegated to the
  tentacle session via one tool, like OpenAI's chat-supervisor pattern. While
  the brain works, the front narrates what the session streams ("it's editing
  `peer.ts`… tests are running… 3 failures").
- **Latency:** 0.6–1.0 s for every path, because the voice loop does not depend
  on the tentacle path (§5). The relay, `serve` and pods are off the audio path
  entirely.
- **Throughput/CPU:** audio rides the platform's WebRTC/Opus stack on the phone
  (native, hardware AEC). On the laptop it is a native helper (§7 Q7). The
  tentacle wire carries text tool calls only.
- **Security:**
  - **The long-lived key never moves.** The edge gets a provider ephemeral
    token minted where the key lives, with its session config pinned
    (instructions, tools, model). A pod never mints and never receives one.
    In `run`/`attach` the laptop holds the key itself.
  - The provider sees the audio, as it sees every prompt today. The relay sees
    nothing, because audio does not go through it.
  - The front's tool calls enter the session as ordinary client requests, so
    the single broker and every permission rule apply unchanged. The front
    cannot approve anything.
  - Owner question: a paired phone holding a ≤ 60 s scoped token is a new kind
    of credential on a device (Q2).
- **Complexity:** medium–high. The edge code is per provider (OpenAI WebRTC/WS,
  Gemini WS), plus a token-mint method (a new RPC, additive) and the digest
  projection (pure module). Cost is ~$0.08–0.24/min of conversation (OpenAI).
- **Weakness:** only providers with realtime + ephemeral tokens (OpenAI, Google
  today). Not local. Not Claude as the voice.
- **Single session path?** Yes. The front is a *client* that types into the
  session. It runs no tools and no agent loop of its own, and its only tools
  are session RPCs.

### 7. Recommendation

*— claude-opus-5-5, 2026-11-13*

**Adopt "three planes, one session".**

1. **Control plane (unchanged).** JSON-RPC text, one session path, every
   permission and every effect.
2. **Blob plane (Candidate A, scoped to bytes, not live audio).** Binary frames
   on every `DuplexChannel`, for attachments (images → audio/video files) and
   frames-on-demand.
   - **Channel:** `sendBinary(bytes)` / `setOnBinary`, implemented natively per
     transport:
     - WS: binary frames.
     - `MessagePort`: a transferable `ArrayBuffer` (zero-copy).
     - stdio, k8s exec and docker: **self-delimiting framing**. A JSON line
       always starts with `{` (0x7B); a frame starting `0x00` is
       `[0x00][u32 len][bytes]`. Readers branch on the first byte, with no mode
       negotiation, and the line buffer becomes a byte buffer.
     - Noise: a `b1` framing that puts the Noise message in a WS binary frame,
       plus a plaintext type byte for "binary payload". This removes **both**
       base64 passes: 1.78× → ≈ 1.0003×.
   - **Binary frame header** (fixed, little-endian): `kind u8 · lane u8 ·
     stream u32 · offset u64`.
   - **Upload protocol:** `blob/open` (JSON, declares id/size/mime and returns a
     stream number). Binary `BLOB_CHUNK` frames follow. `blob/ack {have,
     complete}` stays JSON, so the resumable, idempotent `have` semantics of
     `attachment/put` survive unchanged.
   - **Transfer rules:** a window of N chunks. Chunks shrink to 16–32 KiB while
     any live lane is open (head-of-line bound: chunk / bandwidth, e.g. 256 KiB
     at 5 Mbit/s = 420 ms, but 16 KiB = 26 ms). Senders honour
     WS `bufferedAmount` / drain.
   - **Never via `RpcPeer` dispatch:** binary frames go to a `BlobMux` beside the
     peer, so no handler awaits them (§7 "don't serialize the peer").
   - **Locality rule (generalised from attachments Q2):** bytes go to the
     process holding the model connection, never into a pod.
   - **Protocol:** a breaking `protocol.d/` note, no negotiation (pre-public),
     with `attachment/put` replaced by `blob/*`.
3. **Live plane — at the edge, never through the session pipe.**
   - **Default voice = Candidate B** (edge cascade). It works on every path,
     with every model (Claude, local Qwen), offline and private, with no
     protocol change. Barge-in is local.
   - **Realtime voice = Candidate C** (S2S front + session as supervisor), opt-in
     per profile. It is the only design that is sub-second on *every* path,
     including the phone through the relay and pods, because the voice loop
     skips them. It keeps every §7 invariant: the long-lived key never moves,
     no pod involvement, and one session path.
   - B and C share one seam. A `VoiceFront` at the edge consumes audio and
     produces `session/prompt` / `enqueue` / `cancel`. It consumes
     `session/update` through the pure `voice-view` projection and produces
     audio. B is a local cascade behind it; C is a provider S2S session.
   - **Live video:**
     - **Pull by default.** The edge keeps a ring buffer of camera/screen
       frames (only while the user has toggled capture on, with a visible
       indicator). The session gets a `look` tool that asks the edge for the
       latest frame (or a change-detected burst), delivered over the blob plane
       as an image ref.
     - Over a pod, `look` is a pod→laptop effect, so it goes through the
       laptop's allowlist and broker.
     - **Push** (continuous frames) only to a realtime front that natively
       takes video (Gemini Live 1 fps, OpenAI image input), direct from the
       edge.
     - Rationale: a coding agent rarely needs 1 fps forever. Pull costs zero
       tokens until the model asks; push at 263 tokens/s (Gemini) is ≈ 950 k
       tokens/hour.

Candidate A for *live* audio stays rejected unless an experiment shows a need,
e.g. a local full-duplex model (Moshi) hosted on the `serve` box. That would
then be a lane on the blob plane, phase 6+.

Why not just C everywhere: it would make voice depend on two providers, cost
per minute, and exclude local models and Claude as the voice. B gives everyone
voice; C is the premium ultra-low-latency mode. Why not just B: B cannot
beat the brain's TTFT, and the owner's bar is "latenza bassissima".

### 8. Experiments (spikes in `.tentacle/tmp/eval-realtime-media/`, each with pass/fail)

| # | Spike | Measures | Pass | Gates |
|---|---|---|---|---|
| E1 | 15 MiB image, base64-JSON vs binary frames: Bun↔Bun WS, stdio pipe, Noise channel (today's `t1:` vs `b1`) | wire bytes, CPU ms both ends, wall time | binary ≥ 25 % fewer bytes on WS (≥ 40 % on Noise), ≥ 2× less CPU | P1 |
| E2 | On an iPhone (dev build): `@noble` ChaChaPoly + pure-JS base64 throughput in Hermes; RN `WebSocket` binary send cost (RN bridges binary as base64 internally — verify) | MB/s, ms per 256 KiB | encrypt ≥ 20 MB/s, else plan a native crypto/socket Expo module (CryptoKit ChaChaPoly) in P1 | P1 phone half |
| E3 | Head-of-line: 50 audio-sized frames/s on the same WS during a 15 MiB upload, link shaped 5 Mbit/s · 50 ms RTT · 1 % loss; chunk 256 KiB vs 16 KiB vs separate WS | per-frame p50/p99 delay | p99 < 100 ms with the chosen chunk policy (else blobs get their own connection) | P1 chunk policy, A rejection |
| E4 | Edge cascade on the owner's Mac: Silero + Smart Turn v3 + Parakeet-MLX (or whisper.cpp) → configured cloud model → Kokoro; 30 utterances, small and big (100 k) context, with/without warm-on-speech-start | end-of-speech → first audio p50/p95 | p50 < 1.2 s small context; warm-up cuts big-context p50 ≥ 30 % | P3/P4 |
| E5 | S2S direct from Italy: OpenAI `gpt-realtime` via WebRTC (phone/browser) and WS (laptop), Gemini Live via WS; ephemeral token minted by a Bun process | end-of-speech → first audio; token mint RTT | p50 < 0.8 s, p95 < 1.3 s | P5 |
| E6 | Laptop AEC: a 100-line Swift helper with `AVAudioEngine` voice processing on built-in speakers, TTS playing, user interrupts | false barge-ins / 5 min; stop latency | < 1 false trigger / 5 min; stop < 100 ms | laptop audio for P3–P5 |
| E7 | Phone → relay → `serve` small-frame RTT on 4G/5G (once the relay exists; else Tailscale) | p50/p95 RTT | p50 < 150 ms | B on the phone |
| E8 | Feasibility check: `react-native-webrtc` in our Expo dev build + an Expo module calling iOS 26 `SpeechAnalyzer` streaming | builds, runs, first-partial latency | both work on iOS 26 | P3 phone, P5 phone |

E1–E3 are cheap (an afternoon each, no device for E1/E3). E4–E6 need the
owner's Mac and an API key (≈ $1). E2/E7/E8 need the phone.

### 9. Phased roadmap (each phase useful alone; sized per §10)

| Phase | Task (slug) | Delivers alone | Size · Blast | Suited |
|---|---|---|---|---|
| P1a | `feat/binary-frames` — `sendBinary`/`setOnBinary` on every `DuplexChannel` (WS, port, stdio 0x00 framing, Noise `b1`), `BlobMux` beside `RpcPeer` | the substrate, measured by E1 | L · load-bearing (transport) | Opus plans, DeepSeek executes in slices, fresh-context Opus review |
| P1b | `feat/blob-upload` — `blob/open` + binary chunks + `blob/ack`, replacing `attachment/put` (`protocol.d/` note); TUI + phone use it | images 1.33–1.78× smaller and ≥ 2× cheaper on every hop | M · load-bearing (protocol) | same |
| P2a | `feat/media-attachments-core` — audio/video refs (mime, duration), caps (Q in P2 plan; Gemini 32 tok/s audio), durable store reuse | audio/video files attachable | M · load-bearing (protocol, persistence) | Opus plan |
| P2b | `feat/media-attachments-providers` — provider capability map (Gemini audio/video input, OpenAI `input_audio`), **transcription fallback at the key holder** for models without audio (Claude, local) | "send a voice memo / a screen recording" works with any model | M · cross-module | DeepSeek |
| P2c | `feat/media-attachments-ui` — TUI rows (duration, size), phone player | visible + playable | M · contained | DeepSeek |
| P3 | `feat/voice-dictation` — push-to-talk STT at the edge → prompt text (laptop helper; phone `SpeechAnalyzer`) | Claude-Code-`/voice` parity, private/local | M · cross-module (new helper binary, no protocol) | DeepSeek, after E4/E6/E8 |
| P4 | `feat/voice-conversation` — `VoiceFront` seam + pure `voice-view` + edge TTS + local barge-in + warm-on-speech-start (Candidate B complete) | hands-free conversation on every path, every model | L · cross-module → split in plan | Opus plan, mandatory fresh review |
| P5a | `feat/realtime-token` — `voice/token` RPC: key holder mints a provider ephemeral token with pinned config; refusal for pods; device-scoped | the security core of C, testable alone | M · load-bearing (§7 key/identity) | Opus plan + review |
| P5b | `feat/voice-realtime` — S2S `VoiceFront` (OpenAI first) on laptop helper + phone WebRTC, session-as-supervisor tools, session digest | sub-second voice everywhere | L · load-bearing → split per edge | Opus plan, mandatory fresh review |
| P6 | `feat/live-vision` — edge frame ring + `look` tool (pull) over the blob plane; push frames to a realtime front | "look at my screen / camera" | M · load-bearing (pod→laptop effect gate) | Opus plan |

P1 and P3 have disjoint file sets (transport/protocol vs a new helper + TUI
input), so they can run in parallel under the owner's two-task rule. P2 needs
P1b. P4 needs P3. P5 needs P4's seam. P6 needs P1b (and P5 only for push).

### 10. Failure modes the plans must design out (carried into each phase)

- **Blob plane:**
  - A binary frame for an unknown stream is counted and dropped, then the
    `have` probe resyncs.
  - A peer that sends binary before `initialize` is a protocol error and the
    channel closes.
  - Oversize length prefix → close. The cap is checked before allocation.
  - A pod lying in acks keeps today's bound (`3 × size + window × chunk`).
- **Edge voice:**
  - AEC failure → false barge-in loop. Mitigation: raise the VAD threshold
    during playback (E6).
  - Network drop mid-reply → speak "connection lost", and the session continues
    daemon-side (leaving detaches, never closes).
  - STT misrecognition of a command → never auto-approve (Q4).
- **Realtime front:**
  - Token expiry or the provider session cap (Gemini ~15 min) → transparent
    re-mint plus a digest re-seed.
  - The front hallucinates having done something → it may claim progress only
    from `session/update` (digest-grounded), and every action is a session
    RPC.
  - Two fronts on one session (laptop + phone) → each is just a client.
    Prompts queue as today.
- **Live vision:**
  - Capture left on → a visible indicator plus an auto-off timeout.
  - A pod asks `look` → laptop broker prompt, no lasting approval.

### Owner questions

1. **Realtime shape: a fast S2S voice front that delegates to the tentacle
   session (session = supervisor), rather than making the session's own model
   speak?** *Recommendation: yes.* It is the only shape that is sub-second on
   every path, and it keeps one session path. Claude and local models have no
   S2S API anyway.
2. **Direct-to-provider audio with ephemeral tokens.** The key holder (laptop,
   or `serve` for the phone/`connect`) mints a ≤ 60 s, config-pinned provider
   token for a paired edge device. Audio goes edge → provider and never through
   the relay/`serve`/pod. Pods never get one. *Recommendation: yes.* The
   long-lived key never moves, and the provider sees the audio anyway.
3. **Default voice mode.** Edge cascade (B: any model incl. local/Claude,
   private, ~1–2.5 s) by default, realtime S2S (C: ~0.6–1 s, ≈ $0.08–0.24/min,
   OpenAI/Google only) opt-in per profile, and which realtime provider first?
   *Recommendation: yes, B default, C opt-in; OpenAI `gpt-realtime` first*
   (WebRTC + ephemeral tokens + tools + server-side truncation on interrupt),
   Gemini Live second (WebSocket, video). Revisit after E4/E5.
4. **Permissions by voice.** *Recommendation: no in v1.* Asks are read aloud
   and answered by a key or tap. A spoken "approve" risks misrecognition and
   echo.
5. **What is persisted of a voice conversation?** *Recommendation: transcripts
   only.* The user's speech becomes a normal user message marked `via: voice`.
   The front's small talk stays display-only. Audio recordings are never kept.
   Audio/video *files* the user attaches are kept like images (durable store).
6. **Binary frames as a breaking protocol change** (a `protocol.d/` note, `attachment/put`
   replaced by `blob/*`, no negotiation)? *Recommendation: yes.* Pre-public, §7
   says pick the cleanest shape.
7. **Laptop audio via a small native helper** (Swift, macOS first, with
   `AVAudioEngine` voice processing for AEC; Linux/PipeWire later), shipped next to the
   `tentacle` binary and spoken to over stdio binary frames? *Recommendation:
   yes.* Bun has no audio I/O, and AEC is what makes barge-in work on laptop
   speakers.
8. **Live video = pull by default** (`look` tool, frames on demand, capture
   only while toggled on). Continuous push only to a realtime front?
   *Recommendation: yes.* Zero tokens until the model asks, versus ≈ 950 k
   tokens/hour of 1 fps push.
9. **Phase order** P1 → P2 → P3 → P4 → P5 → P6, with P3 (dictation) allowed to
   run in parallel with P1? *Recommendation: yes.* Dictation is useful at
   once and shares no files with the transport work.

## Implementation

*(empty until the eval is promoted — each phase above becomes its own `feat` with its own plan)*

## Execution

*(empty — eval)*

## Review

*(pending the owner's verdict on the questions above; a fresh-context Opus review of this eval is recommended before promotion, red-teaming §3 constraints 2–3 against Candidate C)*
