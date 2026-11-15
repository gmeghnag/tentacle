# feat/voice-dictation — Dictation in the local TUI on the Mac (realtime-voice V1)

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/voice-dictation`
> **Size:** L, split into four slices: S1 spike (S) · S2 helper (M) · S3 TUI integration (M) · S4 polish + live test (S) · **Blast:** cross-module (a new native helper binary, a new `voice` config key, one new key layer, a new `tentacle voice` subcommand). No protocol, daemon, persistence or relay change. · **Suited:** S1 by Opus with the owner at the Mac (it needs a real mic and ears); S2–S4 by DeepSeek. L ⇒ one **fresh-context Review** over S2+S3 (grouped, per the owner's fewer-reviews rule), and it must red-team the key-layer precedence (F7) and the never-write-raw-to-the-terminal rule (F10).
> **Changelog:** `changelog.d/voice-dictation.added.md`: "- **Voice dictation on the Mac.** Press Ctrl+R in the TUI, speak, press it again: the text lands in the input field for you to edit and send. Speech is recognised on the Mac; no audio leaves it or is saved."

## Context

*— claude-opus-5-5, 2026-11-15*

**Why.** This is phase **V1** of the approved realtime-voice architecture (`docs/eval/realtime-media.md`; roadmap row `:506`; owner answers `:998-1010`; V0 results `:622-952`). V1 is push-to-talk **dictation** in the local TUI: a laptop helper captures the mic, recognises speech on device, and the transcript lands in the TUI's input field as **editable text, never auto-sent**. Each V phase is meant to be useful alone (`:516-524`). V2 (hands-free conversation) reuses this helper and its endpointing (`:527`).

**Binding decisions already taken:**

- **Local terminal on the Mac only.** The helper is a native Swift binary next to `tentacle`, because Bun has no audio I/O. Over SSH or a remote tmux, voice is off with a notice (Q6, `:1005`; failure mode `:545`).
- **Persist only text.** Audio is never kept. The `via: "voice"` marker (Q8, `:1007`) is **out of scope** (owner): the transcript is ordinary field text, sent by the user like any typed text.
- **No cloud, no key.** The owner has no OpenAI key (`:628-633`). STT runs on device.
- **TTS is out of V1.** Kokoro is the decided default for later phases (`:912`).
- AGENTS §7 holds: no raw terminal writes while Ink owns it; logic in pure modules; no second session path.

**Evidence the plan builds on (V0, synthetic `say` audio on a loaded box — optimistic for WER and endpointing, pessimistic for latency, `:639-649`):**

| Stage | V0 measurement | Source |
|---|---|---|
| Endpointing, Silero + Smart Turn v3.2, 200 ms min silence | 192 ms p50 | `:655` |
| Smart Turn inference per call | ≈ 41 ms | `logs/stt_parakeet.jsonl` `smartturn_ms_p50` |
| STT, Parakeet-TDT-0.6b-v3 (MLX, in memory) | **50 ms p50 / 65 ms p95**; cold load 0.84 s | `:656` |
| STT, whisper-large-v3-turbo-q4 | 543 ms p50 | `:657` |
| WER, Parakeet: endpointed vs perfect endpoint | 0.101 vs **0.027** | `:726` |
| Mic capture from a plain CLI child, voice processing on | works; the tap format is **9 channels at 44.1 kHz** | `logs/e6-smoke.log` |
| AEC suppression | ≈ 74 dB | `:780` |

**The comma finding, re-read for this plan.** V0 found that 5/30 utterances lost their second clause at a comma (`:718-735`). The V0 STT bench endpointed with **VAD silence alone** (`bench_stt_pk.py:51`, `detect_speech_end`) and only *recorded* Smart Turn's verdict on the cut segment. That verdict is the important new fact:

| id | text (cut at `\|`) | Smart Turn p on the cut segment |
|---|---|---|
| e04 | "Aspetta un attimo, \| ci penso." | 0.878 |
| e08 | "Va bene, \| fermati per ora." | 0.977 |
| e14 | "Okay, \| go ahead." | 0.860 |
| e15 | "Never mind, \| stop for now." | 0.984 |
| *e17 (complete, control)* | "Fai passare il typecheck e poi dimmi cosa resta rotto." | 0.987 |
| *e25 (complete, control)* | "Run the typecheck and tell me what is still broken." | 0.977 |

(`logs/stt_parakeet.jsonl` lines 5, 9, 15, 16, 18, 26.)

Smart Turn rates the cut halves as complete as whole sentences (0.86–0.98 vs 0.977–0.987). **No Smart Turn threshold separates them.** So V0's two candidate mitigations (`:733-735`) collapse to one: a **minimum-silence floor above the comma pause**. And in dictation the cleanest fix is structural: **the user ends the dictation with a key**, so a pause can never end it. Endpointing then only matters for an optional auto-stop (Owner Q2).

**Repro (the capability is missing), 2026-11-15, on `feat/voice-dictation` = `main` @ `b97ff97b`:**

```
$ rg -i "voice|dictat|microphone" packages --glob '!**/node_modules/**'
(no matches)
```

The threshold sweep that S1 runs is pasted in the Appendix (`sweep.py`). It could not be run while planning: executing Python needs an approval this non-interactive session could not get. **No sweep number is claimed here.**

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**A plain CLI child process spawned by `tentacle` can capture the mic from inside the user's terminal, under that terminal's microphone permission, with no app bundle.**

- **Proven once:** V0's `aecsmoke` (an unbundled `swiftc` binary) captured a real signal: −63…−79 dBFS ambient. A denied mic yields digital silence, not −63 dBFS (`logs/e6-smoke.log`, `e6-tone-noaec.log`).
- **Not proven:** which app macOS names in the prompt, or that VS Code's terminal (whose host app must declare mic usage) gets one at all. **S1 proves this in Terminal, iTerm2 and VS Code before S2 starts.** If VS Code cannot get the mic, V1 ships for Terminal/iTerm, and VS Code shows the `mic_denied` notice with instructions (F1). The design does not change.

### Preconditions (verified)

- **A new binding is one layer module plus one line.** `PURE_LAYERS` is the ordered precedence list (`packages/tui/src/keys/layers.ts:41-55`); `LAYER_ORDER` is pinned by `route.test.ts` (`layers.ts:57-77`). A layer is a pure `(KeySnapshot) => LayerStep` (`keys/contract.ts:77-81`).
- **The effects V1 needs already exist:** `fieldInsert{text}` and `pushNotice{text}` (`keys/effects.ts:84`, `:80`). Insertion goes through the pure `insert` (`editor.ts:68`). Inserted text is sanitised with `sanitizePasted` (`paste.ts:43`), which strips control characters before anything reaches the render.
- **Esc is already taken twice:** `escUpload` and `escAbort` sit at positions 10–11 (`layers.ts:51-52`). A voice layer placed **before** them owns Esc while dictating, so Esc cancels the dictation and never aborts the agent's turn (F7).
- **Taken Ctrl keys:** C, V, A, E, W, T, O, X (and the X→S chord) (`input-actions.ts:74-130`, `layer-dock.ts:50,91`, `chord.ts:29-37`, `layer-dialog.ts:92`). **Ctrl+R is free.**
- **Spawn precedent:** `clipboard.ts:34,54` already `Bun.spawn`s a helper with stdout piped and stderr ignored. V1 follows it, but pipes stderr to a log file (F10).
- **Config dir:** `configDirFromEnv` (`packages/config/src/load.ts:501`) gives `~/.config/tentacle` by default. The test env guard repoints `HOME` (AGENTS §6), so no test touches real models.
- **Build:** `bun run compile` builds and ad-hoc signs `dist/tentacle` (`scripts/build.ts:34,56`). The helper is built the same way, next to it.
- **No invariant is touched:**
  - Voice is a **local input device**. The transcript enters the field and leaves through the existing send path, so `run`/`attach`/`connect` all work unchanged and a pod never sees audio or the helper (§7 "TUI always over RPC", "model stays on the laptop").
  - No protocol, persistence or daemon file changes.

### Design

**1. Key and mode: toggle, not hold.** Terminals send key *presses* (with auto-repeat), never key *releases*, to an app reading stdin. Only the kitty keyboard protocol's opt-in release events would, and Terminal.app and VS Code do not offer them. True hold-to-talk is therefore not implementable. V1 is a toggle (Owner Q1):

| While | Key | Effect |
|---|---|---|
| idle, input focused, no dialog/panel | **Ctrl+R** (configurable `voice.key`) | start dictating |
| listening | Ctrl+R **or Enter** | finish: transcribe and insert. Enter here **never sends** (F6). |
| listening or transcribing | **Esc** | cancel and discard; nothing is inserted |
| listening | typing | allowed; the transcript is inserted at the cursor when it arrives |

While dictating, the field shows a one-line voice strip: `● listening 0:07 ▁▃▅ [it]` → `… transcribing`, plus the partial preview dimmed. Rendering it is presentation only (`voice-view.ts` computes it).

**2. Helper: `tentacle-voice`, one Swift binary** (`native/voice-mac/`, SwiftPM), macOS 14+, Apple Silicon:

- **Capture.** `AVAudioEngine` with voice processing on (AEC, noise suppression, AGC) by default; `voice.voiceProcessing: false` turns it off. Other-audio ducking is set to minimum. The engine runs **only between `start` and `final`/`cancel`**, so the orange mic indicator is honest. Mic channel 0 is taken (the voice-processing tap is 9-channel, `e6-smoke.log`) and resampled to 16 kHz mono with `AVAudioConverter`.
- **VAD.** Silero v5 ONNX, 512-sample (32 ms) windows; the exact V0 model, so V0's behaviour transfers (`vad_turn.py:19-36`).
- **Smart Turn.** v3.2 ONNX, run on request, over the last ≤ 8 s of the turn (`vad_turn.py:78-93`). It needs Whisper-style log-mel features, reimplemented in Swift with Accelerate. S1 proves parity with Python.
- **STT.** Parakeet-TDT-0.6b-v3 as **CoreML through FluidAudio** (Swift package; the `FluidInference/parakeet-tdt-0.6b-v3-coreml` weights). It auto-detects 25 European languages, so it covers it/en with no setting. Apple's on-device `SpeechAnalyzer` is the fallback engine if S1 rules Parakeet out (Owner Q3).
  - **Why not the alternatives:** a Python/MLX sidecar means a ~770 MB venv plus a Python runtime on every Mac (the V0 `env/venv`). MLX-Swift has no Parakeet port, so that would be a model port, not a dependency. FluidAudio is one SwiftPM dependency and runs on the ANE.
  - **To verify in S1:** the licenses (FluidAudio SDK; Parakeet upstream is stated as CC-BY-4.0 by NVIDIA, attribution required; Silero; Smart Turn). Sources disagree, and no weights ship until they are written into this doc.
- **ONNX runtime.** `onnxruntime` Swift package, for Silero + Smart Turn only. S1 may swap in FluidAudio's own Silero, if S1 shows the same probabilities (max |Δp| ≤ 0.02 on the 30 V0 files).
- **Cold start never loses speech.** On the first `start` the helper starts the engine first (≤ 300 ms) and buffers audio while the models load in the background. Parakeet MLX loaded in 0.84 s; a CoreML first compile can be much slower, and S1 measures it. The `final` waits for the load. The strip says `loading model…` meanwhile.
- **Transcription.** On finish, the **whole buffer** (from first speech minus 200 ms, to stop) is transcribed **once**. Clauses across a comma are punctuated together, and no segmentation choice can cut text. **Partials** for the preview: each closed VAD segment (pause ≥ 300 ms) is transcribed once, and the results are concatenated, dimmed. A partial is never inserted.
- **No network at run time.** The helper loads models only from `--models-dir`. FluidAudio's auto-download is never called outside `setup`. Missing models → `models_missing`.

**3. Helper protocol v1: JSON lines over the child's stdin/stdout.** Not a socket: the TUI owns the child's lifetime, stdin EOF ⇒ the helper exits, so no orphan can hold the mic, and there is no port or path to secure. Lines are one JSON object each and capped at 64 KiB (a longer line is a protocol error). stderr goes to `<configDir>/voice/helper.log` (rotated at 1 MiB), never the terminal.

| Direction | Message | Meaning |
|---|---|---|
| → | `{"t":"start","id":n,"lang":"auto"\|"it"\|"en"}` | open the engine, capture into buffer `n` |
| → | `{"t":"turn","id":n}` | run Smart Turn on buffer `n` so far (auto-stop only) |
| → | `{"t":"stop","id":n}` / `{"t":"cancel","id":n}` | finish (transcribe) / discard |
| ← | `{"t":"ready","v":1,"engine":"parakeet-v3","device":"MacBook Pro Microphone"}` | first line; `v` must equal the TUI's or the TUI refuses the helper |
| ← | `{"t":"listening","id":n,"device":"…"}` | engine running (also re-sent after a route change) |
| ← | `{"t":"vad","id":n,"ms":1024,"p":0.93}` | one per 32 ms window, in **audio time**, not wall time |
| ← | `{"t":"level","id":n,"dbfs":-31}` | 10 Hz, for the meter |
| ← | `{"t":"turnp","id":n,"p":0.97}` | the Smart Turn answer |
| ← | `{"t":"partial","id":n,"text":"…"}` | preview only |
| ← | `{"t":"final","id":n,"text":"…","lang":"it","audioMs":7040,"sttMs":61}` | the transcript; the engine is already stopped |
| ← | `{"t":"error","id":n?,"code":"…","message":"…"}` | codes: `mic_denied` `no_input` `models_missing` `model_load_failed` `stt_failed` `route_lost` `bad_request` |

The helper also has two non-protocol modes:
- `setup [--yes]` downloads the models (below).
- `trace <wav>` replays a WAV file instead of the mic and prints the same `vad`/`turnp` lines. That makes fixture traces and makes S2's tests run without a mic.

**4. Endpointing (auto-stop) is a pure TS fold, not Swift.** `voice-endpoint.ts` folds the helper's `vad`/`turnp` lines (audio time) into `{state, action: none | askTurn | stop}`, with the same semantics as `endpoint.py:22-75`: silence ≥ floor makes a *candidate*; `turnp ≥ threshold` stops; otherwise listening continues.

Why TS:
- It runs in the repo's gate (`bun test`), where the comma regression lives.
- It is deterministic (audio time, no clocks).
- V2's hands-free loop and V4's phone app (RN/TS) can reuse it as is.

Defaults:
- **Auto-stop off** (Owner Q2).
- When on: `autoStopSilenceMs: 1000` (provisional — S1 pins it at ≥ 2× the longest comma pause it measures in the owner's own speech) and threshold 0.5.
- A hard stop after 3 s of continuous silence, so a forgotten dictation ends.
- `maxSeconds: 300` (F5).

**5. The TUI side (pure modules + one hook).**

| Module | Kind | Owns |
|---|---|---|
| `voice-protocol.ts` | pure | parse/encode lines; version check; line cap |
| `voice-endpoint.ts` | pure | the auto-stop fold above |
| `voice-session.ts` | pure reducer | `idle → starting → listening → transcribing → idle`; `error`, `unavailable`. Input: key intents, helper messages, helper exit. Output: state + commands (`spawn`, `send`, `insert`, `notice`, `kill`). Includes `joinDictation(field, cursor, text)` (one separating space, no double spaces, nothing inserted for blank text) and `voiceAvailability({platform, env, config})` (darwin + local tty + enabled + no `SSH_CONNECTION`/`SSH_TTY`). |
| `voice-view.ts` | pure | the strip's view-model (state, elapsed, meter bars, partial, language) |
| `keys/layer-voice.ts` | pure layer | key → `voiceToggle` / `voiceFinish` / `voiceCancel` effects. Placed **after `paste`, before `sessions`** (so before `escUpload`/`escAbort`). It passes everything when idle and not the voice key. |
| `useVoice.ts` | hook | spawns the helper through an **injected spawner** (default `Bun.spawn`, stdio all piped), splits lines, feeds the reducer, executes commands. Kills the helper on unmount (stdin end, then SIGTERM after 500 ms). Lazily spawned on first use; exits after 10 min idle. |
| `components/VoiceStrip.tsx` | render | maps `voice-view` to `<Text>` (blank rows as `" "`, §6 gotcha) |

`App.tsx` gains only:
- the hook call;
- three effect cases in `keys/execute.ts`;
- the `voice` snapshot field.

**6. Models: location, first run, offline.**

- **Location:** `<configDir>/voice/models/<name>@<revision>/` (overridable with `voice.modelsDir`), with a manifest compiled into the helper: HF repo, **pinned revision**, file list, sha256.
- **Size:** about 0.5–0.6 GB for Parakeet CoreML plus ≈ 10 MB for Silero + Smart Turn. S1 writes the exact figure here.
- **Setup command:** `tentacle voice setup` (Owner Q4) runs **outside Ink**, so plain printing is fine:
  1. prints the size and the destination, then asks y/N;
  2. downloads with a progress line, resumable (`.partial` files), checks each sha256, and renames atomically;
  3. runs a 1 s self-test (`trace` on an embedded `say` clip) and prints `ok`.
- `tentacle voice status` prints whether the helper is found, its version, the models and their sizes, and the mic permission state.
- **In the TUI**, pressing Ctrl+R with models missing never downloads. It shows a notice: `voice models not installed (≈ 0.6 GB) — run: tentacle voice setup`.
- **Afterwards: fully offline** (live check L8).

**7. Where the helper comes from.** `bun run voice:build` runs `swift build -c release` in `native/voice-mac` and copies the result to `dist/tentacle-voice`, ad-hoc signed like `dist/tentacle`.

Runtime lookup order:
1. `voice.helperPath`;
2. a sibling of `process.execPath` (the owner's `~/bin/`);
3. `<configDir>/voice/bin/tentacle-voice`.

Not found → a notice naming the build command. A signed and notarised download is a release-time concern, out of V1 (pre-public).

**8. Languages.**
- `voice.language: "auto"` (default) lets Parakeet detect the language per dictation; the strip shows the detected `[it]`/`[en]`.
- `it`/`en` force it, if S1 shows Parakeet accepts a language hint; otherwise the option is not offered (no dead setting).
- Mixed Italian with English technical words ("typecheck" came out as "tipekett", `stt_parakeet.jsonl:18`) is measured in S1 on the owner's voice. It is a known limit, not a V1 goal; the text is editable before sending.

**9. Bluetooth / AirPods.**
- The input follows the macOS input setting; `voice.input: "default" | "builtin"` can override it.
- With voice processing on, an AirPods mic forces the HFP call profile, so other audio drops to call quality while dictating. `builtin` avoids that and is documented, not defaulted (no playback exists in V1).
- A route change mid-dictation (`AVAudioEngineConfigurationChange`): the helper restarts the engine on the new device, keeps the same buffer `id`, and re-sends `listening{device}`. The TUI notices `mic switched to <device>`.

### Files (dependency order)

1. `packages/config/src/schema.ts` — the `voice` object:

   ```ts
   voice: {
     enabled?: boolean;          // default true on darwin
     key?: "ctrl+r" | …;
     language?: "auto" | "it" | "en";
     autoStop?: boolean;         // default false
     autoStopSilenceMs?: number; // default 1000
     maxSeconds?: number;        // default 300
     input?: "default" | "builtin";
     voiceProcessing?: boolean;  // default true
     modelsDir?: string;
     helperPath?: string;
   }
   ```

   The object is `.strict()`, like `sessions` (`schema.ts:436`). Also its docs entries in `key-docs.ts` / `config-keys.ts`.
2. `native/voice-mac/` — `Package.swift`; `Sources/TentacleVoice/{main,Protocol,Capture,Resample,Vad,SmartTurn,LogMel,Stt,Models,Trace}.swift`; `Tests/TentacleVoiceTests/`. Biome and `tsc` ignore it.
3. `scripts/voice-build.ts`, plus `package.json` scripts `voice:build` and `voice:test` (`swift test`, macOS only, **outside** `bun run check`: the gate must stay green on Linux CI).
4. `packages/tui/src/voice-protocol.ts`, `voice-endpoint.ts`, `voice-session.ts`, `voice-view.ts`.
5. `packages/tui/src/keys/layer-voice.ts`; `keys/layers.ts` (+1 entry in each list); `keys/contract.ts` (`"voice"` name); `keys/snapshot.ts` (the `voice` field); `keys/effects.ts` (3 kinds); `keys/execute.ts`.
6. `packages/tui/src/useVoice.ts`, `components/VoiceStrip.tsx`, `App.tsx`/`AppView.tsx` (wiring only).
7. `packages/cli/src/main.ts` — the `voice setup|status` dispatch, a thin wrapper that execs the helper with inherited stdio, which is allowed because Ink is not mounted.
8. Tests (below); fixtures `packages/tui/test/fixtures/voice/*.json`.
9. `changelog.d/voice-dictation.added.md`; a README "Voice dictation" section (mic permission per terminal, setup, keys, AirPods note).

### Failure modes

| # | Failure | Design / convergence |
|---|---|---|
| F1 | **Mic permission denied / never granted / VS Code can't prompt** | Before `start` the helper checks `AVCaptureDevice.authorizationStatus(.audio)`: `notDetermined` → request (macOS prompts, naming the terminal); `denied`/`restricted` → `error mic_denied`. The TUI notice names the app: "Microphone blocked for <TERM_PROGRAM> — System Settings › Privacy & Security › Microphone". State → idle; the next press retries. Never a silent no-op. |
| F2 | **Models missing / corrupt** | `models_missing` → setup notice (§6). A sha256 mismatch at load → `model_load_failed` and the notice says re-run setup. The helper never downloads at run time. |
| F3 | **Helper not found / version skew** | Not found → build notice. `ready.v ≠ 1` → "voice helper is version X, rebuild it" and the helper is killed. No half-working pairing. |
| F4 | **Helper crash or hang** | Exit while listening/transcribing → error state and a notice "voice helper stopped (code N); this dictation was lost — see <configDir>/voice/helper.log". Honest: the audio lived in the helper. No `final` within `10 s + audioMs/10` of `stop` → kill, same notice. Respawned on the next press; 3 crashes within 60 s → voice off for this TUI session, with a notice. |
| F5 | **Long dictation** | `maxSeconds` (300) → automatic finish; the transcript **is inserted**, with a notice "stopped at 5:00". Memory: 5 min × 16 kHz float ≈ 19 MB. S1 measures STT time for 5 min of audio. Never dropped. |
| F6 | **Enter during dictation** | Consumed by the voice layer as *finish*; it never sends, because the field would go out without the dictation and the transcript would land in an emptied field. The user presses Enter again to send (never auto-sent, owner rule). |
| F7 | **Esc during a running agent turn** | The voice layer precedes `escUpload`/`escAbort`. While listening/transcribing, Esc cancels the dictation only; the turn keeps running. Idle Esc passes through unchanged. |
| F8 | **Background noise / nothing said** | Voice processing suppresses steady noise. No VAD-positive window → `final` with empty text → a notice "didn't catch anything", nothing inserted. S1 checks Parakeet on 10 s of room noise (expect empty, no hallucination). |
| F9 | **Comma pauses cut the dictation** | Impossible with manual stop: one transcription of the whole buffer. With auto-stop on: the silence floor (S1-pinned) plus the regression test T3. |
| F10 | **Raw terminal writes** (§7) | Every helper stream is piped; stderr goes to a log file; notices go through `pushNotice`; transcript text goes through `sanitizePasted`. `voice setup`/`status` run without Ink. Test T8 asserts the spawn options. |
| F11 | **SSH / remote tmux / non-macOS** | `voiceAvailability` → `unavailable`; the key shows "voice works in a local terminal on the Mac" once; the helper is never spawned (no capture on the wrong machine, `realtime-media.md:545`). |
| F12 | **Bluetooth route change / device removed** | The engine restarts on the new device with the same buffer. If the restart fails → finish with the audio so far (inserted) plus `route_lost` notice. |
| F13 | **TUI exit / crash while listening** | The helper sees stdin EOF and exits, which stops the engine; the mic indicator goes off. Unmount also SIGTERMs. No orphan holds the mic (Swift test + live check L6). |
| F14 | **A key pressed during `starting`** (helper still spawning or loading) | Intents queue in the reducer. Stop before `listening` → `cancel` (nothing captured). Audio is buffered from engine start, so a slow model load loses nothing. |
| F15 | **Persistence** | Nothing new. The transcript is field text; audio is never written (the helper has no file-write path besides `setup` and its log). L9 checks the voice dir after a dictation. |

### Tests

Red first (§9). Each test runs first against a stub or the old constant and is **shown failing**, then green. The mutation each test must catch is named.

- **T1 `voice-protocol.test.ts`:** round-trip of every message; a 64 KiB+1 line → protocol error; `ready.v` mismatch → refused; malformed JSON → error, not a throw. *Mutation:* drop the version check → T1 red.
- **T2 `voice-session.test.ts`** (the reducer):
  - toggle start/finish/cancel;
  - Enter while listening → finish, **no** send effect (F6);
  - `final` → one `insert` at the cursor with `joinDictation` spacing; blank `final` → notice, no insert;
  - helper exit mid-listening → error + notice (F4); 3 exits/60 s → off;
  - `maxSeconds` → finish **and** insert (F5);
  - key during `starting` (F14).
  - *Mutations:* make Enter fall through → red; drop the insert on auto-finish → red.
- **T3 `voice-endpoint.test.ts`, the comma regression.**
  - Fixtures: `comma-traces.json`, produced in S2 by `tentacle-voice trace` from V0 `utterances/{e04,e08,e14,e15}.pad.wav`, plus complete controls `e03`, `e17`, `e25`: per-window `p`, and the Smart Turn `p` for each candidate segment.
  - Asserts:
    - **(a)** with the shipped defaults, no comma trace stops before its true end (the last VAD-positive window);
    - **(b)** every control stops within `floor + 2 windows + 100 ms` of its true end;
    - **(c)** with `autoStop: false` the fold **never** emits `stop` on any trace.
  - *Red:* written first against the V0 constants (200 ms floor, threshold 0.5), where (a) fails on all four.
  - *Mutation:* lower the floor back to 200 → red. Raise the threshold to 0.99 with a 200 ms floor → **still red**. That pins the finding that a threshold cannot fix it.
- **T4 `voice-view.test.ts`:** strip states, elapsed format, meter bucketing, partial truncation to the field width.
- **T5 `keys/route.test.ts` (extended):**
  - `LAYER_ORDER` includes `voice` between `paste` and `sessions`;
  - Esc while listening during a running turn → `voiceCancel`, **not** `abortTurn` (F7);
  - idle Ctrl+R → `voiceToggle`; idle Esc → unchanged route;
  - voice key behind an open panel/dialog → pass.
  - *Mutation:* move `voice` after `escAbort` → red.
- **T6 `voice-availability` (in T2's file):** darwin+local → available; `SSH_CONNECTION` set → unavailable; linux → unavailable; `enabled:false` → unavailable.
- **T7 `useVoice` with a fake spawner** (pattern: `ink-testing-library` as in `packages/tui/test/app.test.tsx`):
  - press Ctrl+R → the fake receives `start`;
  - the fake replies `listening`/`final` → the frame shows the text in the field and the strip clears;
  - unmount → the fake's stdin ended.
- **T8 spawn options:** the spawner receives `stdin/stdout/stderr` all `"pipe"` or a file, **never `"inherit"`** (F10). *Mutation:* `stderr:"inherit"` → red.
- **T9 config schema:** `voice` accepted with defaults; unknown key rejected (`.strict()`); `autoStopSilenceMs < 300` rejected (too low to be comma-safe).
- **T10 cli dispatch:** `tentacle voice setup|status` reaches the helper wrapper; an unknown subcommand gives usage.
- **Swift (`bun run voice:test`, macOS only):**
  - protocol encode/decode;
  - log-mel parity with the Python features on 3 V0 files (max abs diff ≤ 1e-3) and Smart Turn p within 0.02 of `stt_parakeet.jsonl`;
  - `trace` determinism (same WAV → same lines);
  - stdin EOF → exit within 500 ms;
  - `start` with models missing → `models_missing`, and no network call (a `URLProtocol` stub that fails the test on any request).

### Slices

| Slice | Size · Blast | What | Exit criterion |
|---|---|---|---|
| **S1 spike** (scratch only, `.tentacle/tmp/voice-dictation/`) | S · contained | Swift prototype: FluidAudio Parakeet CoreML vs Apple `SpeechAnalyzer` vs the V0 MLX numbers, on the 30 V0 files **plus 20 owner recordings** (it/en, comma pauses, technical words, one 5-min read, 10 s of room noise). Silero/Smart Turn ONNX in Swift plus log-mel parity. `sweep.py` (Appendix) plus the comma-pause lengths in the owner's speech. Key probe (does Ctrl+R reach the app) and mic prompt in Terminal / iTerm2 / VS Code. AirPods input route with voice processing on. Licenses. | A numbers table appended to Execution: STT p50/p95 warm/cold, WER, RSS, model size, floor value, a terminal × {key, mic} matrix. **Engine and floor decided with the owner** before S2. |
| **S2 helper** | M · contained | `native/voice-mac` per §2/§3/§6; `trace`, `setup`, `status`; Swift tests; `voice:build`. Produces the T3 fixtures. | `voice:test` green; `trace` matches the S1 numbers; manual `start/stop` from a shell prints a correct `final`. |
| **S3 TUI** | M · cross-module | Config, pure modules, layer, hook, strip, cli dispatch; T1–T10 red→green. | `bun run check` green; mutation checks done and logged. |
| **S4 polish + live** | S · contained | Notice wording, meter, idle exit, README, changelog, the live checklist with the owner. | Every L-item below ticked by the owner. |

**Latency targets** (from V0; to be re-taken on an idle Mac in S1, `:948`):

| Path | p50 | p95 |
|---|---|---|
| Ctrl+R → `listening`, warm | ≤ 300 ms | — |
| Stop → text in the field, ≤ 10 s utterance | ≤ 150 ms (V0 STT 50 ms + CoreML/pipe margin) | ≤ 300 ms |
| Auto-stop wait after the last word | floor + ≤ 64 ms + ≈ 41 ms Smart Turn | — |
| WER on the V0 set, manual stop | ≤ 0.04 (V0 perfect-endpoint floor 0.027) | — |

**Live checklist (S4, owner at the Mac):**

- **L1** First Ctrl+R in **Terminal**: the macOS prompt names Terminal; after Allow, the dictation works.
- **L2** Same in **iTerm2** and in **VS Code's terminal** (or the F1 notice, if VS Code cannot).
- **L3** Ten dictations, five it / five en, each with a comma pause: none is cut; the text is editable; nothing is sent until Enter is pressed twice.
- **L4** Esc while the agent is working: the dictation is discarded and the turn keeps running.
- **L5** **AirPods** on: dictate with the AirPods mic, then with `voice.input: builtin`; music quality during each.
- **L6** Quit the TUI mid-dictation: the orange mic dot goes off within 1 s.
- **L7** A 5-minute read: auto-finishes at the cap, and the text is inserted.
- **L8** Wi-Fi off: dictation still works.
- **L9** After a dictation, `ls -R <configDir>/voice` shows no audio file.
- **L10** Over `ssh localhost`: Ctrl+R shows the local-terminal notice.

### Owner questions

1. **Key and mode.** Terminals cannot tell when a key is *held*, so true hold-to-talk is impossible. Proposal: **Ctrl+R** starts, Ctrl+R or Enter finishes (Enter never sends), Esc throws it away, and the key can be changed in settings. *Recommendation: yes, Ctrl+R toggle* (it is free today; S1 checks it reaches the app in Terminal, iTerm2 and VS Code).
2. **Stop automatically when I stop talking?** *Recommendation: off by default.* You finish with the key, so a pause after a comma can never cut you off (V0 showed the turn detector rates "Okay," as complete as a whole sentence). Auto-stop stays available as a setting, with a ~1 s pause floor set from your own speech in S1, and it becomes the default in the hands-free V2.
3. **Speech engine.** Parakeet (measured best: 50 ms, Italian/English detected automatically, a one-time ~0.6 GB download) or Apple's built-in recogniser (no download, but you pick the language, and it is unmeasured). *Recommendation: Parakeet*, confirmed by S1 on your own voice; Apple's stays the fallback if S1 shows Parakeet is worse inside the Swift helper.
4. **First-time download.** *Recommendation: a `tentacle voice setup` command* that shows the size, asks, shows progress, and works offline afterwards; inside the TUI, Ctrl+R only tells you to run it (no surprise 0.6 GB download from a keypress).

## Execution

*(empty — the plan is not yet approved)*

## Review

*(empty)*

## Appendix — `sweep.py` (S1 runs it; written 2026-11-15, not yet run)

Run with the V0 venv: `.tentacle/tmp/eval-realtime-media/v0/env/venv/bin/python .tentacle/tmp/voice-dictation/sweep.py`. It replays Silero probabilities once per file, then sweeps the silence floor {200…800 ms} × Smart Turn threshold {none, 0.5…0.95} × hard stop {none, 2 s}. It reports, per cell, the truncated utterances, the files that never stopped, and the endpoint wait p50/p95, plus the longest internal pause per utterance (the comma pause).

<details><summary>sweep.py</summary>

```python
import json, os, sys
os.chdir("/Users/gmeghnag/tentacle/.tentacle/tmp/eval-realtime-media/v0")
import numpy as np
import soundfile as sf

sys.path.insert(0, ".")
from vad_turn import Silero, SmartTurn, SR

WIN = 512
WIN_MS = WIN / SR * 1000  # 32 ms
utts = json.load(open("utterances.json"))["utterances"]
vad = Silero("models/silero_vad.onnx")
st = SmartTurn("models/smart-turn-v3.2-cpu.onnx")

data = []
for u in utts:
    x, sr = sf.read(f"utterances/{u['id']}.pad.wav", dtype="float32")
    assert sr == SR
    vad.reset()
    probs = [vad.prob(x[i * WIN:(i + 1) * WIN]) for i in range(len(x) // WIN)]
    pos = [i for i, p in enumerate(probs) if p >= vad.thresh]
    true_end = (pos[-1] + 1) * WIN if pos else 0
    gaps = [(b - a - 1) * WIN_MS for a, b in zip(pos, pos[1:]) if b - a > 1]
    data.append({"u": u, "x": x, "probs": probs, "true_end": true_end,
                 "max_gap_ms": max(gaps) if gaps else 0.0})

cache = {}


def st_prob(k, a, b):
    key = (k, a, b)
    if key not in cache:
        cache[key] = st.prob(data[k]["x"][a:b])
    return cache[key]


def run(k, min_sil, thr, hard_ms):
    d = data[k]
    need = max(1, int(round(min_sil / WIN_MS)))
    hard = max(1, int(round(hard_ms / WIN_MS))) if hard_ms else None
    sp = last = None
    silent = total_sil = 0
    for i, p in enumerate(d["probs"]):
        if p >= vad.thresh:
            sp = i * WIN if sp is None else sp
            last = (i + 1) * WIN
            silent = total_sil = 0
            continue
        if sp is None:
            continue
        silent += 1
        total_sil += 1
        if hard and total_sil >= hard:
            return (i + 1) * WIN, last
        if silent < need:
            continue
        if thr is None or st_prob(k, sp, last) >= thr:
            return (i + 1) * WIN, last
        silent = 0
    return None, last


rows = []
for min_sil in (200, 300, 400, 500, 600, 800):
    for thr in (None, 0.5, 0.7, 0.8, 0.9, 0.95):
        for hard in (None, 2000):
            trunc, waits, ids, never = 0, [], [], 0
            for k, d in enumerate(data):
                dec, last = run(k, min_sil, thr, hard)
                if dec is None:
                    never += 1
                    continue
                if last < d["true_end"]:
                    trunc += 1
                    ids.append(d["u"]["id"])
                else:
                    waits.append((dec - d["true_end"]) / SR * 1000)
            rows.append({"min_sil": min_sil, "st_thr": thr, "hard_ms": hard,
                         "truncated": trunc, "trunc_ids": ids, "no_stop": never,
                         "wait_p50": round(float(np.median(waits)), 0) if waits else None,
                         "wait_p95": round(float(np.percentile(waits, 95)), 0) if waits else None})

gaps = sorted(((d["u"]["id"], round(d["max_gap_ms"]), d["u"]["text"]) for d in data),
              key=lambda r: -r[1])
json.dump({"rows": rows, "gaps": gaps}, open("../../voice-dictation/sweep.json", "w"), indent=1)
print("largest internal pauses (ms):")
for g in gaps[:10]:
    print(" ", g)
for r in rows:
    print(r["min_sil"], r["st_thr"], r["hard_ms"], r["truncated"], r["no_stop"],
          r["wait_p50"], r["wait_p95"], ",".join(r["trunc_ids"]))
```

</details>
