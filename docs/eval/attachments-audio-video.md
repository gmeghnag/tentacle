# eval/attachments-audio-video — audio and video files in a session (app + TUI)

> **Status:** context + recommendation (pending the owner's verdict on §Owner questions)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Draft lives in `.tentacle/tmp/attachments-av/eval.md`; to land it, `cp` to `docs/eval/attachments-audio-video.md` on the owner's OK.
> **Type:** eval · **Size:** — · **Blast:** load-bearing (protocol, persistence) for the native-media phase; the recommended v1 is cross-module · **Suited:** Opus
> **Answers:** `TODO.md` `eval/attachments-audio-video` (~:502). Sizes the `B3` row of `docs/eval/realtime-media.md:513` and **revises** it (see §6 "Drift from realtime-media B3"). Live video streams are already decided there (`look`, pull, B4, after B2) and are only cross-referenced here (§7).

## Riassunto per l'owner (italiano semplice)

1. Oggi nessun modello che usiamo davvero "ascolta" o "guarda" un file: Claude non accetta né audio né video; DeepSeek nemmeno; solo alcuni modelli OpenAI-compatibili (gpt-audio, Qwen-Omni/Voxtral su llama-server) accettano audio, e il video nativo lo fa solo Gemini, che non è un nostro provider.
2. Quindi la v1 non manda i byte audio/video al modello: li **trasforma sul dispositivo** dove c'è il file (iPhone o Mac).
3. **Audio** → trascrizione on-device (lo stesso STT della dettatura vocale: SpeechAnalyzer su iPhone, Parakeet/helper Swift sul Mac). Al modello arriva testo.
4. **Video** → un "foglio provini" (una griglia di 9 fotogrammi in UNA immagine JPEG) + la trascrizione della traccia audio. Usa il percorso immagini che esiste già.
5. Vantaggi: funziona con **qualsiasi** modello (anche Qwen locale), nessun byte audio/video lascia il dispositivo, niente nei pod, nessun bump di protocollo, nessuna dipendenza dai binary frames.
6. Costo: ~200 token/minuto di audio (testo) contro ~1 900 token/minuto in audio nativo (Gemini) e ~16 000/minuto in video nativo — e la cronologia viene rimandata a ogni giro.
7. Limiti v1 proposti: audio ≤ 60 min, video ≤ 10 min; il file originale resta sul dispositivo e non viene salvato su `serve`.
8. Ordine: S1 schema+render (piccolo) → S2 audio su iPhone (dopo la dettatura di mobile-voice) → S3 video su iPhone → S4 TUI sul Mac (dopo l'helper V1).
9. L'audio "vero" al modello (capisce tono, musica, rumori) è una fase dopo, opzionale: cambia una entry critica del log → la decidi tu, e conviene dopo i binary frames (B2).
10. Ti servono 7 risposte (§Owner questions); per ognuna c'è la mia raccomandazione.

## Context

*— claude-opus-5-5, 2026-11-15*

### 1. The question

Owner, 2026-11-13 (`TODO.md` ~:502): the app must support photo attachments
(done: mobile compose) **and audio/video files**. The exact questions:

- **Q-1** How do the app and the TUI send an audio or a video file to a session?
- **Q-2** What can the model do with it — which providers/models take audio or
  video input today, and what is the fallback for the ones that do not
  (transcription for audio, frames/summary for video)?
- **Q-3** Size limits, chunking, storage (durable like `attachments-durable`),
  and how the TUI and the phone show it.
- **Q-4** How it fits AGENTS §7 (model on the laptop, pod not trusted,
  persistence) and whether it needs `eval/binary-frames` first.

### 2. Today, verified against the code (`main` @ b97ff97b)

| Fact | Source |
|---|---|
| A message carries **refs, never bytes**; a ref's `mimeType` is regex-bound to **`^image/…`**. An `audio/*` or `video/*` ref does not parse today. | `packages/protocol/src/attachment.ts:1-13,49-56` |
| Refs ride the **critical** log entries `media_message`/`media_replace`; an older build refuses a log whose critical entry it cannot parse. Widening the ref regex therefore changes what a critical entry may contain. Adding/changing a critical type is decided with the owner and bumps `PROTOCOL_VERSION`. | `packages/protocol/src/session-log.ts:15-23,161,278`; AGENTS §7 on-disk rule; memory "critical entries: owner decides" |
| `MAX_ATTACHMENTS_PER_MESSAGE = 5` (schema `.max(5)` on the critical entry); `MAX_IMAGE_BYTES = 15 MiB`. | `attachment.ts:29,37,77-81` |
| `attachment/put` is **type-agnostic**: the store keys bytes by sha256, no `mimeType`; only `size ≤ MAX_IMAGE_BYTES` is bound. 256 KiB raw per chunk, base64 (349 528 chars), resumable via `have`. | `packages/protocol/src/attachment-upload.ts:1-47` |
| Daemon store caps: 100 MiB per session, 256 MiB per daemon process. | `packages/daemon/src/attachment-store.ts:35,38` |
| Provider capability is ONE place, `imageLimits(provider, {images, maxImageBytes})`; the daemon's `agentCapabilities.images` derives from it. Only **two** provider kinds exist: `anthropic` and `openai` (OpenAI-compatible: OpenAI, DeepSeek, llama-server, …). No `audio` capability, no Gemini provider. | `packages/providers/src/images.ts:122-150`; `packages/providers/src/` listing |
| Provider image caps: Anthropic 3 932 160 B, OpenAI 5 MiB; newest `MAX_INLINE_IMAGES = 5` distinct refs inlined, older ones become placeholders. | `images.ts:26,38,45,83-108` |
| `AttachmentSource.read(ref)` gives bytes only on the trusted side; a pod sends refs, the laptop resolves them (`ProxyModelProvider`). **No bytes in a pod** (owner Q2, attachments-upload). | `packages/core/src/model.ts:145-162`; `docs/feat/attachments-upload.md:406-411`; `docs/eval/realtime-media.md:49` |
| Durable bytes: `<dir>/<uid>.attachments/<sha256>`, self-verifying, no header — type-agnostic too. `serve` persists its own; the laptop persists what it attached; worker/pod daemons nothing. | `docs/feat/attachments-durable.md:198-240` |
| Phone photo path: `photo-source.ts` (the only module importing `expo-image-picker`/`-manipulator`/`-file-system`), decisions in pure `photo-input.ts` (`nextPhotoStep`: sniff → HEIC→JPEG → downscale once → ready/refuse). Picker is called with `mediaTypes: ["images"]`. | `apps/mobile/src/photo-source.ts:1-21,168-192` |
| The app has **no** `expo-video`, `expo-av`/`expo-audio`, `expo-document-picker` or thumbnail module today. | `apps/mobile/package.json` (grep) |
| TUI attach path: drag-paste/`/attach <path>` → `attach-candidates.ts` → `attach-files.ts` probe → `useAttachments`. | `packages/tui/src/attach-*.ts` |
| On-device STT is **approved** for voice: laptop = Swift helper (V1, not built yet; V0 measured Parakeet-TDT-0.6b-v3 MLX at 50 ms p50), phone = iOS `SpeechAnalyzer` (26) / on-device `SFSpeechRecognizer` (18) in `feat/mobile-voice` (plan written 2026-11-15, not approved). Owner Q8: the transcript is the user message, optional non-critical `via: "voice"`, **audio never kept**. `via` is not on the schema yet. | `docs/eval/realtime-media.md:506,656,1005-1007`; `docs/feat/mobile-voice.md:1-14,67-74`; `packages/protocol/src/session.ts` (no `via`) |
| Phone wire cost: Noise `t1:` + base64 of a base64 JSON chunk = **1.78×** raw bytes. | `docs/eval/realtime-media.md:44` |

### 3. Which models take audio / video today (web, re-checked 2026-11-15)

Tags: **[S]** sourced, **[V]** vendor docs, **[?]** thin evidence — verify before a plan relies on it.

| Provider / model | Audio in | Video in | Reachable through our providers? |
|---|---|---|---|
| **Anthropic Claude** (all) | **no** — open feature requests in 2026, transcribe first [S, [anthropic-sdk issue tracker / claudeissues](https://claudeissues.com/issue/73566-feature-allow-claude-to-hear-and-process-audio)]; Messages API content = text, image, document [V, [Messages API](https://platform.claude.com/docs/en/api/beta/messages/create)] | **no** (frames as images only) | `anthropic` — images only |
| **OpenAI** `gpt-audio`, `gpt-audio-1.5`, `gpt-4o-audio-preview` | **yes**, Chat Completions `input_audio` (base64 + `format`: wav/mp3 [?]); `gpt-audio-1.5`: Chat Completions only, no Responses [V, [audio guide](https://developers.openai.com/api/docs/guides/audio.md), [gpt-audio-1.5](https://developers.openai.com/api/docs/models/gpt-audio-1.5.md), [gpt-4o-audio](https://developers.openai.com/api/docs/models/gpt-4o-audio-preview.md)] | no native video file input found | `openai` — would need an `input_audio` content part |
| OpenAI `gpt-realtime-2` | yes, realtime session | 1 fps-style frames only | not a file path (realtime-media C) |
| **Google Gemini** (native API) | yes, 32 tokens/s | **yes**, 263 tokens/s; inline ≤ 20 MB (docs also say < 100 MB — conflicting), Files API up to 2 GB free / 20 GB paid, ≤ 10 videos/request on 2.5+ [V, [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding?hl=en), [tokens](https://ai.google.dev/gemini-api/docs/tokens)] | **no Gemini provider**; its OpenAI-compat endpoint with `input_audio` [?] |
| **llama-server** (local) with Qwen2.5/Qwen3-Omni, Voxtral | **yes**, `/v1/chat/completions` `input_audio` (base64 + `format`) via `libmtmd` [V, [llama.cpp multimodal.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)] | docs mention video [?] | `openai` — same `input_audio` mapping |
| DeepSeek API | no (text only) | no | `openai` |
| Owner's local Qwen3.8 (llama-server) | no (not an Omni model) | no | — |

**Conclusion of §3:** of the models the owner actually runs (Claude, DeepSeek,
local Qwen3.8), **none** takes audio or video. Native audio reaches only an
OpenAI-compatible audio model the owner would have to configure on purpose;
native video needs a provider we do not have. A fallback is not an edge case —
it is the main path.

### 4. Size and token arithmetic ([E] = our estimate)

| Media | Bytes | As text/frames to the model | Native to the model |
|---|---|---|---|
| Voice memo, AAC 64 kbit/s | ~0.5 MB/min | transcript ≈ 150 words ≈ **200 tok/min** [E] | Gemini 1 920 tok/min [V]; WAV 16 kHz mono for `input_audio` = 1.92 MB/min → 15 MiB cap ≈ 8 min |
| iPhone video, HEVC 1080p | ~60–130 MB/min [E] | 1 contact sheet 1536×864 ≈ **1.8 k tok** (Anthropic w·h/750) + audio transcript | Gemini 15 780 tok/min [V]; 10 min ≈ 158 k tok — a whole context window |

History is **resent every round** (§2: inline window of 5): a native 5-minute
memo kept inline costs ~10 k tokens per round; its transcript ~1 k.

## Options

*— claude-opus-5-5, 2026-11-15*

Each option is scored on AGENTS §7 (model on the laptop / key with identity;
pod not trusted; persistence; protocol honesty) and on its binary-frames
dependency.

### A — Edge-derived media (transcript + keyframes), bytes stay on the device

The device that holds the file derives model-ready content **before** sending:

- **Audio** → on-device STT → text. Phone: the `mobile-voice` native module,
  file input instead of the mic (`SpeechAnalyzer` takes an audio file input
  [?, verify in the mobile-voice spike]; `SFSpeechURLRecognitionRequest` on 18).
  Mac: the V1 Swift helper (Parakeet-MLX; or macOS 26 `SpeechAnalyzer`) with a
  `transcribe <file>` mode.
- **Video** → a **contact sheet**: N evenly spaced keyframes (default 9, plus
  scene-change picks later) tiled into ONE JPEG ≤ 1568 px long side, captioned
  with timestamps; plus the audio track's transcript. Phone: `AVAssetImageGenerator`
  through a thumbnail module (`expo-video-thumbnails` or the same native
  module) + `expo-image-manipulator` to tile; Mac: the helper (AVFoundation).
- What is sent: the user's text + a **delimited file block** in the message
  content (transcript marked as file content, i.e. untrusted data, not the
  user's instruction) + the contact sheet as an ordinary **image ref** through
  the existing `attachment/put` + `media_message` path. An optional
  **non-critical** field on the message (`media: [{kind:"audio"|"video", name,
  durationMs, derived:"transcript"|"frames+transcript"}]`, same pattern as
  owner Q8's `via`) lets the TUI and the app draw a chip; an older build strips
  it (strip schema) and still shows the text.

| Axis | Fit |
|---|---|
| Model on the laptop | ✓ no new credential, no new model call; STT is on-device (already approved for voice) |
| Pod not trusted | ✓ a pod gets text + an image ref — exactly today's image path; no audio/video bytes ever reach the daemon, let alone a pod |
| Persistence | ✓ transcript = message text (durable for free in both logs); contact sheet = image, durable via `attachments-durable` D1; original file **not kept** anywhere but the device (Q8 "audio never kept") |
| Protocol | additive: one optional non-critical field; **no** `PROTOCOL_VERSION` bump, no critical-type change |
| Binary frames | **none needed** — the only bytes on the wire are one JPEG (≤ 1–2 MB) |
| Models served | **every** model with vision for video, every model for audio (Qwen3.8 text-only still gets the transcript; a no-vision model gets the transcript + the image placeholder) |
| Cost | Mac side waits for the V1 helper; phone side reuses mobile-voice's module; ffmpeg is never assumed |
| Loses | tone, music, non-speech sound, fine motion between frames |

### B — Key-holder transcription (upload audio, transcribe where the key is)

The edge uploads the audio blob (`attachment/put` is already type-agnostic) to
the key holder (laptop for worker/pods, `serve` for the phone), which calls an
OpenAI-compatible `/v1/audio/transcriptions` (OpenAI Whisper/gpt-transcribe, or
a local whisper server) and substitutes text. This is the realtime-media B3 shape.

| Axis | Fit |
|---|---|
| Model on the laptop | ✓ (the call runs at the key holder) — but it is a **new model call** with its own config/credential |
| Pod not trusted | ✓ bytes go to the key holder, never the pod (same rule as images) |
| Persistence | the transcript is produced daemon-side ⇒ the laptop must persist a text it did not author; ok for `serve` (trusted), needs care for pod sessions (must happen at the laptop, not in the pod daemon) |
| Protocol | the ref regex must accept `audio/*` (critical-entry change → owner + bump) **or** a new transient upload kind |
| Binary frames | audio ≤ 15 MiB works today at 1.78× on the phone; B1/B2 help |
| Loses | privacy (cloud STT, unless a local server is configured), on-device rule of mobile-voice ("never cloud") |

Useful only as an **opt-in** for a TUI user before V1 exists, or for a Linux
laptop with no helper. Not the default.

### C — Native audio refs to audio-capable models

Widen `AttachmentRef.mimeType` to `audio/*`, add a per-model `audio` capability
next to `images` in `imageLimits` (renamed `mediaLimits`), map refs to
`input_audio` in `openai-provider.ts`, keep the **transcript always** alongside
as the fallback for a model without audio, for refs outside the inline window,
and for a resume onto a different model.

| Axis | Fit |
|---|---|
| Model on the laptop | ✓ bytes at the key holder via `AttachmentSource`, as images |
| Pod not trusted | ✓ refs only in the pod |
| Persistence | ✗→ owner: an `audio/*` ref inside the **critical** `media_message` makes every older build refuse that log ⇒ `PROTOCOL_VERSION` bump via `protocol.d/` + the owner decides (critical entries rule) |
| Binary frames | wants B2 on the phone (15 MiB × 1.78× = 27 MB on the wire); daemon store caps (100/256 MiB) bound a session to ~6 memos in memory |
| Format | iPhone records AAC/m4a; `input_audio` accepts wav/mp3 [?] ⇒ transcode at the edge (WAV 1.92 MB/min → ~8 min under 15 MiB; no native MP3 encoder on iOS) |
| Gains | tone, music, speaker cues — for the few models that can hear |

### D — Native video (Gemini) and raw video upload

Needs a **new Gemini provider** (native API; Files API for > 20 MB), video refs,
raw uploads of 60–130 MB/min (far over every cap; impractical before B2 and a
streaming disk store), and costs ~16 k tokens per minute resent each round.
**Not recommended** now; revisit only if the owner adopts Gemini as a session model.

### Cost summary

| Option | Size · Blast | Protocol | Needs B1/B2 | Models it serves |
|---|---|---|---|---|
| **A** edge-derived | M total, split S + M + M + M · cross-module | optional non-critical field | no | all |
| B key-holder STT | M · load-bearing (new key-holder call) | ref widen or transient kind | helps | all (text) |
| C native audio | M · load-bearing (critical entry, provider map) | **breaking** (`protocol.d/`) | yes (phone) | gpt-audio, Qwen-Omni, Voxtral |
| D native video | L · load-bearing (new provider) | breaking | yes | Gemini only |

## Recommendation

*— claude-opus-5-5, 2026-11-15*

**Build A as v1. Keep C as an optional later phase. Do not build B by default, nor D.**

Why A: none of the owner's models can hear or watch (§3); A works with all of
them, keeps every §7 invariant by construction (no audio/video bytes leave the
device, a pod sees only text + one image ref), reuses two already-approved
seams (on-device STT for voice; the image attachment path), needs no protocol
bump and no binary frames, and is ~10× cheaper per round than native media (§4).

### 5. Minimal v1 (what "done" means)

- **Phone:** the `+` sheet gains "Audio file" (Files) and "Video" (library /
  camera, `mediaTypes: ["videos"]`). Audio → on-device transcript; video →
  contact sheet + audio-track transcript. A chip in compose shows name +
  duration + "transcribing…/ready"; the transcript is previewable and editable
  before send (the user sees exactly what the model will read).
- **TUI (Mac):** `/attach` and drag-paste accept `.m4a .mp3 .wav .aac .mov .mp4`
  and route them to the helper's `transcribe`/`frames` modes; same chip.
- **Model sees:** `<file name="memo.m4a" kind="audio" duration="2:31"
  source="on-device transcript">…</file>` in the message text (+ the contact
  sheet ref for video). The system prompt says file blocks are content, not
  instructions.
- **Limits (proposal, Q4):** audio ≤ 60 min (≈ 12 k tokens of transcript);
  video ≤ 10 min; 1 contact sheet per video counts as 1 of the 5 attachments;
  transcript capped at e.g. 64 KiB of text with a visible "truncated" marker.
- **Storage:** transcript in the log; contact sheet via the durable image
  store; the original file **never uploaded, never kept** (phone outbox copy
  deleted after send, like photos).
- **Failure modes the plans must design out:** STT locale missing / model not
  downloaded (refuse with a reason, never a silent empty transcript); empty
  transcript (music, silence → say "no speech detected", still send frames);
  very long file (progress + cancel; refuse over the cap before work); app
  backgrounded mid-transcription (resume or restart, never send half a
  transcript as whole); DRM/iCloud-only asset (refuse); a transcript that
  carries injected instructions (it is data — §7 "a pod is not trusted"
  applies equally to third-party audio); Linux TUI (no helper → clear notice, B
  as the opt-in).

### 6. Slices (one code task at a time, §10)

| # | Task (slug) | Delivers alone | Size · Blast | Depends on | Suited |
|---|---|---|---|---|---|
| S1 | `feat/media-derived-core` — optional non-critical `media` field on the message (protocol + both logs, older build strips it), pure `media-block.ts` (file block format, caps, truncation), TUI + app chip rendering | the format, tested; any client can send a transcript block | S–M · cross-module | — | DeepSeek exec, standard review |
| S2 | `feat/mobile-audio-file` — Files picker + `transcribeFile` in the mobile-voice native module, pure `audio-input.ts` (sniff, duration cap, refusals) | voice memos from the phone, any model | M · cross-module | S1, `feat/mobile-voice` dictation slice | Opus plan (native), DeepSeek slices |
| S3 | `feat/mobile-video-file` — video pick/record, keyframes + contact sheet, audio-track transcript | screen recordings / clips from the phone | M · cross-module | S2 | same |
| S4 | `feat/tui-media-file` — helper `transcribe`/`frames` modes, `/attach` + drag for audio/video | the same on the Mac TUI | M · cross-module | S1, V1 `feat/voice-dictation` helper | DeepSeek exec |
| later | `feat/media-native-audio` (option C) | audio models hear tone/music | M · load-bearing → fresh review | B2, owner's critical-entry decision | Opus plan |

Phone first because the request came from the app (`TODO.md` ~:502) and the
phone's STT module is closest (mobile-voice plan exists); S4 follows V1. Per
"phone/mac parity", S4 is not optional — it is ordered, not dropped.

**Drift from realtime-media B3** (`docs/eval/realtime-media.md:513`): B3 put
"transcription fallback at the key holder". This eval moves it to **the edge**
(where the file is): the owner already approved on-device STT and "audio never
kept" (Q6/Q8), so uploading audio only to turn it into text at the key holder
adds bytes on the wire, a new key-holder model call and a cloud-privacy question
for no gain. B3's "audio refs + capability map" survives as the optional later
phase (C). If approved, update B3's row there.

### 7. Live video streams (owner bonus question)

Already decided in `docs/eval/realtime-media.md:469-472,514` (owner-approved
architecture, 2026-11-14): **pull, not push** — a `look` tool takes the latest
edge frame (camera/screen, captured only while toggled on, visible indicator)
as an image ref; over a pod it is a pod→laptop effect gated by the laptop's
broker; push at 1 fps only to a realtime front that takes video (Gemini Live /
OpenAI realtime). It depends on B2 (`feat/blob-upload`). This eval adds one
thing: the contact-sheet builder from S3 is the same code a `look --span 10s`
would use to show motion in one image — build it once, in a pure module.

### 8. Binary-frames dependency

- **v1 (A): none.** One JPEG per video and text otherwise; today's base64 path
  is fine.
- **C (native audio):** B1 (`feat/noise-binary`, S) cuts the phone's 1.78× to
  1.33× and is worth doing first; B2 is needed for anything above the 15 MiB cap.
- **D / raw video:** needs B2 + a streaming disk store; out of scope.
- So `eval/binary-frames` stays gated on its own experiments (E1/E2), not on
  this feature.

## Owner questions (one decision each; recommendation first)

1. **v1 shape:** (a) edge-derived only — transcript + contact sheet, no audio/video bytes leave the device **[rec]**; (b) also upload the audio for native-audio models now (C in v1).
2. **What the model reads:** (a) a delimited `<file …>` block in the message text, marked as content not instructions, + the optional non-critical `media` chip field **[rec]**; (b) plain text only, no field (no chip).
3. **Video representation:** (a) one 3×3 contact sheet with timestamps + audio transcript **[rec]**; (b) up to 4 separate frames (uses 4 of 5 attachment slots, ~4× the tokens).
4. **Limits:** (a) audio ≤ 60 min, video ≤ 10 min, transcript ≤ 64 KiB **[rec]**; (b) other numbers.
5. **Original file:** (a) never uploaded, never kept outside the device (phone copy deleted after send) **[rec]**; (b) keep it in the session's durable store for a later native-audio model.
6. **Transcript review:** (a) previewable + editable before send **[rec]**; (b) sent as-is.
7. **Native audio (C) and cloud STT (B):** (a) later, opt-in, C only after B2 and with your decision on the critical entry; B only as an explicit opt-in for Linux/no-helper **[rec]**; (b) never; (c) now.

## Review

**Owner verdict (2026-11-15 11:20): GO for AUDIO only — NO video for now.**
1 (a) edge-derived only · 2 (a) delimited `<file …>` block + media chip · 3 **no video in v1** · 4 (a) audio ≤ 60 min, transcript ≤ 64 KiB · 5 (a) the original never leaves the device (phone copy deleted after send) · 6 (a) transcript previewable + editable before send · 7 (a) native audio and cloud STT later, opt-in.
Order: after `feat/mobile-voice` (phone STT) and `feat/voice-dictation` (Mac helper), since audio reuses their recognisers; to be promoted to `feat/attachments-audio` then.
*— claude-opus-5-5 (orchestrator), 2026-11-15*

