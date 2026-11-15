# feat/voice-dictation — Dictation in the local TUI on the Mac (realtime-voice V1)

> **Status:** execution (S1 and S3 complete; S2's mic capture OPEN — see Execution and Review)
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

*— deepseek-v4 (executor), 2026-11-15*

### Load-bearing check: PASSED (do not skip this one)

`.tentacle/tmp/voice-dictation/micprobe.swift`, `swiftc -O`, run from a shell in
Apple Terminal:

```
tap_format=9ch @ 44100.0Hz          <- voice-processing tap, matches V0 e6-smoke.log
engine_running=true voice_processing=on
authorizationStatus=3               <- authorized
frames=30 mean_dbfs=-74.0 peak_dbfs=0.0
VERDICT=REAL_SIGNAL                 <- -74 dBFS ambient, not digital silence
```

A plain unbundled CLI child captures the mic from inside the user's terminal.
No app bundle needed; the design stands.

### S1 (spike) — measured, and it changed three plan claims

Recorded in full in `.tentacle/tmp/voice-dictation/S1-RESULTS.md`; the numbers
that matter:

**Apple `SpeechAnalyzer` (owner decision 3, the V1 default) — works from a bare CLI child,**
measured on all 30 V0 WAVs (`apple-bench.jsonl`):

| | Apple (measured here) | V0 Parakeet |
|---|---|---|
| corpus WER | **0.082** | 0.101 endpointed / 0.027 perfect-endpoint |
| STT p50 / p95 | **79 ms / 99 ms** | 50 ms / 65 ms |

Worst cases are technical English (`Refactor`→"We factor", `re-run`→"rear on")
and a truncated V0 file (`e05`). So Apple is a viable default: better WER than
V0's endpointed Parakeet, and 29 ms of extra p50 is invisible next to a manual
stop.

**The comma floor (the plan's provisional 1000 ms), swept with the Appendix's
`sweep.py` over the 30 files** — largest internal pause per utterance: e08 224 ms,
e04/e14/e15 192 ms, e03/e11/e12 160 ms, e06 96 ms.

```
min_sil  thr    | truncated  ids
200      none   | 4          e04,e08,e14,e15   <- V0's constants
200      0.95   | 2          e08,e15  (+9 never stop)
300      none   | 0          -
500      none   | 0          -   (margin over 224 ms)
```

- **A threshold cannot fix it** (200 ms + 0.95 still truncates e08/e15) — V0's
  finding reproduced independently.
- **Shipped floor: 500 ms** (`ENDPOINT_DEFAULTS.autoStopSilenceMs`), not the
  plan's provisional 1000: 300 is the smallest that truncates nothing here, 500
  has margin, and 1000 doubled the wait for no measured benefit. The schema
  REFUSES anything under 300 (T9), which is the guard that keeps the V0 bug out.

**Three plan claims did not survive S1 — all corrected in code:**

1. **"Apple's recogniser needs no download" is false for a non-English
   language.** `it_IT` is *supported* but *not installed* on this Mac by default;
   the asset took 8.3 s to install on first use, and a supported-but-uninstalled
   locale transcribes to an EMPTY string (silent). The helper checks
   `SpeechTranscriber.installedLocales` and reports `models_missing` naming the
   locale; `tentacle voice setup` installs it; `voice status` prints both lists.
2. **"`auto` lets the engine detect the language" is false for Apple.** It has no
   per-utterance language ID in this API: an Italian utterance on this English Mac
   came back as "Fai pasar el dipicate de voidimi cosa restaurant." `auto`
   therefore means "the Mac's own language", and `voice.language: it|en` forces
   one (verified: `trace --lang it` → "Fai passare il tipet e poi dimmi cosa
   resta rotto."). Documented in the key-docs entry and in `Transcribe.localeId`.
3. **`SpeechAnalyzer` needs macOS 26, not 14.** `Package.swift` targets
   `macOS("26.0")`; macOS 14 has no on-device recogniser of this kind.

**Apple also ships its own VAD** (`SpeechDetector`, with a sensitivity level), so
Silero ONNX + Smart Turn ONNX are NOT needed for the default engine — one fewer
dependency, one fewer licence to verify. The endpointing fold stayed in TypeScript
as the plan required (T3), which is where the comma regression lives and what V2
will reuse.

### S3 (TUI) — built, T1–T10 red→green

| Slice | Files |
|---|---|
| config | `config/src/schema.ts` (`voice` object, `.strict()`, `autoStopSilenceMs` ≥ 300), `resolve.ts`, `load.ts`, `key-docs.ts` (11 leaves), README table regenerated with `bun run docs:config` |
| protocol | `tui/src/voice-protocol.ts` — one JSON line each way, 64 KiB byte cap, `ready.v` handshake decided once, unknown fields dropped, every malformed input an error VALUE |
| endpointing | `tui/src/voice-endpoint.ts` — pure audio-time fold, 500 ms floor, Smart Turn gate, hard stop |
| reducer | `tui/src/voice-session.ts` — `idle→starting→listening→transcribing→idle` + `error`/`off`; commands are data (`spawn/send/insert/notice/kill`); `voiceAvailability`, `joinDictation`, `errorNotice` |
| view | `tui/src/voice-view.ts` + `components/VoiceStrip.tsx` (blank row as `" "`, §6 gotcha; `dimProps()`, not a bare `dimColor`) |
| layer | `keys/layer-voice.ts`, `layers.ts` (15 names / 14 pure), `contract.ts`, `snapshot.ts` (`voice()`, `voiceKey()`, both live getters), `effects.ts`, `execute.ts` |
| hook | `tui/src/useVoice.ts` (React) + `tui/src/voice-spawn.ts` (process edge, injectable `VoiceSpawner`) |
| wiring | `App.tsx` (hook above `frameLayout` so the strip's rows are in the row budget; 3 host effects; 2 snapshot fields), `AppView.tsx`, `app-layout.ts` (`voiceStrip`/`voiceRows` counted once, like the attach row), `app-types.ts`, `run.tsx` |
| CLI | `cli/src/voice-cmd.ts`, `flags.ts` (`CliMode`/`ARGS`/`USAGE`/model table), `main.ts` (dispatch + HELP), `tui/src/index.ts` exports |
| build | `native/voice-mac/` (SwiftPM, 4 sources + tests), `scripts/voice-build.ts`, `voice:build`/`voice:test` scripts |

`useVoice.ts` was split into the hook + `voice-spawn.ts` (drift from the plan's
one "hook" file): the process edge has no React in it and T8's spawn-option
assertions are cleaner against a module that is not a component boundary.

**Tests** (13 new files): T1 protocol, T2 reducer + T6 availability, T3 comma
regression, T4 view, T5 layer/`LAYER_ORDER`, T7 App end-to-end with a fake
helper, T8 spawn options, T9 config schema, T10 CLI dispatch, plus 13 Swift
tests. `key-snapshot.ts` was extracted from `keys-route.test.ts` so two suites
share one builder (Biome forbids exporting from a `*.test.ts`).

### Mutations (each shown RED, then reverted)

| # | Mutation | Result |
|---|---|---|
| M1 | `voice-protocol.ts`: drop the `ready.v` check | **RED** (version handshake) |
| M2 | `voice-endpoint.ts`: shipped floor 500 → 200 | **RED** ("shipped default ≥ comma-safe floor") |
| M3 | `voice-endpoint.ts`: drop the Smart Turn threshold gate | **RED** (e08/e15 still cut at thr 0.95) |
| M4 | `voice-session.ts`: Enter falls through while listening | **RED** ×2 |
| M5 | `voice-session.ts`: no `insert` on `final` | **RED** ×5 (incl. the F5 cap insert) |
| M6 | `keys/layers.ts`: move `voice` after `escAbort` | **RED** ×3 (incl. F7's Esc-vs-turn) |
| M7 | `voice-spawn.ts`: `stderr: "inherit"` | **RED** ×2 (F10) |
| M8 | `schema.ts`: drop `min(300)` on `autoStopSilenceMs` | **RED** ×2 |
| M9 | `schema.ts`: drop `.strict()` on `voice` | **RED** (unknown key accepted) |

Two of my own tests were **vacuous on the first pass** and were fixed before
being counted: T3 read the floor back from the constant under test (M2 passed —
now a literal `COMMA_SAFE_FLOOR_MS` plus a pinned V0-bug case), and T2's
"no submit" assertion is now a `@ts-expect-error` compile-time pin because
`VoiceCommand` has no `submit` member at all.

### S2 (the Swift helper) — `trace`/`setup`/`status` DONE; the mic path is PARTIAL

**Works and is verified:** `swift build -c release`; `bun run voice:test` (13
tests green); `tentacle-voice status` (45 supported locales, 11 installed,
microphone `granted`); `trace` transcribing V0 WAVs end to end —
`--lang it` → "A che punto sei?", "Aspetta un attimo, ci penso."; `--lang en` →
"Run the tie check and tell me what is still broken."; the protocol handshake and
full `start`→`listening`→`stop`→`final`→EOF-exit cycle against the real
microphone, with the helper exiting 0 on stdin EOF (F13).

**Three real bugs found and fixed on the way** (each caught by running it, not by
reading):

1. `AnalyzerInput.init(buffer:)` **traps** (SIGTRAP) unless the buffer is the
   analyzer's own `bestAvailableAudioFormat` — the first `trace` crashed. Fixed by
   asking for the format and converting into it.
2. Reusing one `SpeechTranscriber` across analyzers traps; a fresh one per
   transcription.
3. `AssetInventory.status(forModules:)` answers for locales RESERVED IN THIS
   PROCESS, so a healthy Mac reported "not installed". Now
   `SpeechTranscriber.installedLocales` is the check and `reserve` comes first in
   `setup`.

**OPEN — the mic path under-captures, and this is the one thing a live debugger
must finish.** With the protocol fix in place (below), a requested 3 s window
yields **300–1300 ms**, varying run to run. Every isolated probe delivers
95–105 % on the same Mac:

```
taprate.swift        main thread, Thread.sleep            100 %
taprate-async.swift  Task.detached, Task.sleep            100 %
bgread.swift         bg queue + blocked stdin read         95 %
restart.swift        engine restarted per take, x3         95 % each
bgthread.swift       engine on a background thread         95 %
audiothread3.swift   engine on a DEDICATED Thread + run loop,
                     16 pool-saturating tasks              105 %
pool2.swift          engine on a COOPERATIVE thread,
                     8 CPU-bound pool tasks                  0 %   <- the bug
```

So one true, proven bug was found and fixed: **an engine created on a cooperative
pool thread loses its tap entirely when the pool is busy** (0 frames of 88 200) —
which is exactly the helper's situation, because its transcription and asset
checks run on that pool. `Capture` now owns a dedicated `Thread` with a pumped
run loop, and the protocol loop moved off `Task.detached` onto a dedicated queue
with a `LineSource` background stdin reader (`main.swift`) — the blocking
`availableData` on the main thread was itself measured at 0 frames
(`blocked2.swift`).

The residual under-capture is NOT explained by any probe. The Thread/run-loop
variations tried (bounded `run(before:)`, `RunLoop.run()`, a keep-alive timer on
`.default`+`.common`, `CFRunLoopWakeUp` hops to start/stop on the audio thread)
each moved the number without fixing it. Per AGENTS §0 I stopped rather than keep
mutating, and **escalate**: the next step is an `lldb` session — breakpoint in
`Capture.consume`, watch the audio thread's state and the tap callback rate
during a real dictation — which this non-interactive session cannot drive.
Everything else in the helper is exercised and green; the capture depends on
nothing that is still unproven except this.

Consequence for the user-visible feature: the TUI side is complete and tested
against a fake helper, and `trace` proves transcription quality, but **a real
dictation currently loses roughly two thirds of its audio**, so live check L3
(ten dictations, nothing cut) cannot pass yet. L1/L2 (the permission prompt) and
L6 (mic dot off on quit) are reachable now; L3–L5, L7–L9 need the capture fix.

### Live checklist (S4) — not run

The owner is not in the loop in this session, so L1–L10 are **untouched**. L1/L2
are what S1's load-bearing check proves is possible; L3 onwards wait on the
capture fix.

### Fix round 1

*— deepseek-v4 (executor), 2026-11-15*

Fix round 1 of the Review below (6 HIGH/MEDIUM findings; the three LOW-ish
notes — the F7 layer order, the `VoiceCommand` schema, the `min(300)` floor —
found nothing and are untouched). Repros re-run first in
`.tentacle/tmp/voice-dictation/review/` (`dup.ts`, `race.ts`, `yes.ts`), then
each finding fixed test-first, with the mutation shown red.

**H1 (the duplicate field).** Root cause: `joinDictation` returns the WHOLE
field, and `App` fed it to `field.insert`, which inserts at the cursor. New pure
`dictationInsertion(before, text)` (`voice-session.ts`) returns only the appended
part (`" world"` / `"world"` / `""`), and `joinDictation` is now defined as
`field + dictationInsertion(field, text)` — one source of truth, so the two can
never drift (a test asserts that identity across nine cases).

**H2 (id always 1).** Root cause: `begin` computed the id from the nullable live
`id`, which `idle()` resets, so every dictation was id 1 and the stale guard was
skipped entirely while `id === null`. The model gained `issued` (a monotonic,
never-reset counter) and the guard now compares to the LIVE id unconditionally —
an idle model holds none, so "no id at all" is stale, never a wildcard. Both
review traces now hold: the cancelled dictation's late `final` is dropped, and a
stale `listening` leaves an idle TUI idle (ids now 1, 2, 3 across dictations).

**H3 (F4/F5/auto-stop unwired).** This was the largest gap — three of the
review's "dead" paths, all now live:
- `useVoice` emits `clock` on a 1 s interval (only while a dictation is live or a
  child is held) and no longer needs a separate `elapsed` timer: `vad` carries
  audio time, which is the clock `maxSeconds` counts. The reducer's `elapsed`
  path is kept and still tested.
- Swift: `Capture` now buffers one entry per tap window (its duration in AUDIO
  time, plus its dBFS) and `drainWindows()` hands them out; `runProtocolSync`
  pumps them on every loop pass into `vad` (with the cumulative `ms`) and a 10 Hz
  `level`. The `turn` command answers with a real `turnp`. Silero is still not
  wired (S2's open finding), so the probability comes from
  `windowSpeechProbability(dbfs)` — one function, documented as the placeholder.
- `voice.autoStop` / `voice.autoStopSilenceMs` are now READ: the reducer folds
  each `vad`/`turnp` through `voice-endpoint.ts` (which had no production
  caller), sending `turn` on a candidate and `stop` on a positive verdict. The
  comma regression is re-pinned at reducer level (a 224 ms pause under the
  500 ms floor never stops; auto-stop off never stops on silence).
- The two timers the plan promised: a hung `stop` gives up after
  `TRANSCRIBE_TIMEOUT_MS` (20 s) with a notice and a `kill`; an idle child is
  ended after `IDLE_EXIT_MS` (10 min), so a forgotten TUI holds no mic.

**H4 (the local TUI and `connect` ignored `voice`).** `runEngineTui` was the
only caller passing it. The local TUI now passes `voice` + `voiceConfigDir` (and
routes through the `io.startTui` seam, so the broker guard and the new voice
guard pin the same call site), and `connect` gained `connectVoice` — the same
shape as `connectTheme` beside it: read the config FILE, warn for nothing (the
palette read already warned), fall back to `VOICE_DEFAULTS`. A broken file still
never blocks a connection.

**M5 (F10 pinned on the spec, not the spawn).** Real cause: the production
spawner hardcoded `stdio` next to the spec, so the spec was decorative and
`stderr: "inherit"` there stayed green. `bunSpawnOptions(spec, logFd)` is now the
one thing the real spawner consumes (stdin/stdout from the spec, stderr the log
FILE's fd, or a pipe when there is no config dir), plus `bunSpawnProc` for the
Bun call itself; the log is opened in append mode and the child's stderr is
drained into it, so a full pipe cannot block the helper.

**M6 (T7 depended on the host).** `App` always read `process.platform`/`env`.
New `voiceHost` prop (`{platform, env}`, TEST-ONLY like `voiceSpawner`); the
suite pins `{platform: "darwin", env: {}}`, and a new case asserts that over SSH
no helper spawns and the notice says why.

**M7 (`setup --yes` dropped).** `parseArgs` puts it in `bools`; `voiceCommand`
read only `positional`. `VoiceCmdDeps` gained `yes?: boolean`, `main` passes
`parsed.bools.has("yes")`, and `voiceCommand` ORs it with a literal flag so a
direct caller still works. Pinned twice: through the real parser, and as a
text-guard on `main`'s call site (the only reachable pin — `voiceCommand` is
called with positionals alone, so no hand-driven test can see the wiring).

**M8 (dead settings + broken lookup).** `main.swift` gained `--input` and
`--no-voice-processing`, parsed into `CaptureOptions` and used by `Capture.start`
(no more hardcoded `true`/`"default"`); `useVoice` passes them from
`voice.input`/`voice.voiceProcessing`. The spawn now picks the first candidate
that EXISTS (`existsSync`) instead of `candidates[0]`, so the
`<configDir>/voice/bin` fallback is reachable; and `App` gained `voiceConfigDir`,
so the log path is no longer `/voice/helper.log` (no config dir → no file).

**M9 (an exit orphaning the next child).** `child.exited` nulled `childRef`
unconditionally. It now clears it only if it still holds THAT child, so a killed
child's late exit cannot orphan its successor. `VoiceModel` gained
`childAlive`/`lastActivityAt` — what the idle timer above reads.

**Drift from the Implementation.** (a) No separate `elapsed` dispatch: `vad`
already carries audio time, and a second timer would be a second clock to keep
in step. The reducer's `elapsed` path stays (tested) for a helper that sends
only `level`. (b) `dictationInsertion` was added rather than changing
`joinDictation`'s signature: the plan names `joinDictation(field, cursor, text)`,
but the review's fix is smaller and the identity test keeps the two in step.
(c) The local TUI's `startTui` now goes through `io.startTui` — a test seam it
did not use, needed to pin H4 at all (and it is the shape the review asked for).
(d) The review's three LOW-ish "found nothing" items are untouched by design.

**Not fixed / still open (unchanged from S2).** The mic path still
under-captures (300–1300 ms of a 3 s take); this round did not touch the
tap/run-loop shape, and the capture fix remains the `lldb` session the Execution
above asks for. Silero/Smart Turn are still placeholders on the Swift side, so
auto-stop's real quality is unmeasured; L1–L10 remain unrun. `defaultSpawner` is
exercised by `bunSpawnOptions`' tests, not end-to-end: no test starts a real
child (by design), so the `Bun.spawn` call itself is verified only by the
`tentacle-voice` manual runs recorded in S2.

**Mutations (each shown RED on the buggy code, then reverted).**

| # | Mutation | Red on |
|---|---|---|
| 1 | `App`: `field.insert(joinDictation(...))` (H1) | T7 appends → `❯ hellohello world` |
| 2 | `begin`: `id = (model.id ?? 0) + 1` (H2) | 3 reducer tests: fresh ids 1,2,3; the cancelled final; `issued` |
| 3 | stale guard: `model.id !== null && …` (H2) | race trace (B): a stale `listening` revives the TUI |
| 4 | fold: `autoStop: false` hardcoded (H3) | auto-stop ON asks Smart Turn and stops |
| 5 | `vad`: `audioMs = model.audioMs` (H3) | the `maxSeconds` cap; the auto-stop candidate |
| 6 | `transcribingAt` guard → `false` (H3) | a hung `stop` frees the phase |
| 7 | idle-exit guard → `false` (H3) | an idle child is ended after 10 min |
| 8 | `bunSpawnOptions`: `stderr: "inherit"` (M5) | both real-spawn tests (fd, no-fd) |
| 9 | `useVoice`: `candidates[0]` without `existsSync` (M8) | the `<configDir>/voice/bin` helper is spawned |
| 10 | `useVoice`: drop the `--input`/`--no-voice-processing` args (M8) | the same test's flag assertions |
| 11 | `useVoice`: unconditional `childRef.current = null` on exit (M9) | unmount still ends child 2 after child 1's late exit |
| 12 | `voiceCommand`: read only `rest.includes("--yes")` (M7) | the parser→deps test |
| 13 | `main`: drop `parsed.bools.has("yes")` (M7) | the call-site text guard |
| 14 | `main`: drop `voice`/`voiceConfigDir` from the local TUI (H4) | the local-TUI guard (scoped to the local block) |
| 15 | `connect`: drop `voice`/`voiceConfigDir` from `startTui` (H4) | the connect guard |
| 16 | `App`: read `process.platform`/`env` (M6) | over SSH no helper spawns |
| 17 | Swift: `windowSpeechProbability` → `0.5` (H3) | 4 `WindowTests` failures |

Two guards were rescued from vacuity while mutating: the local-TUI voice guard
first matched the `run`/`attach` call above it (now scoped to the local block,
which is what made #14 red), and the M9 test first resolved the killed child's
exit too early to interleave (#11 was green until the fake delayed it, as a real
SIGTERM's 500 ms grace does).

**Gate (fix round 1).** `bunx tsc --noEmit` green · `bun run lint` green (0
errors, 0 warnings; 7 formatting/import-order findings auto-fixed, tree clean
after) · `bun test` **10957 pass, 0 fail, 5 skip** (the same 5 opt-in skips; the
run count grew from 10927 by the 30 new tests) · `bun run voice:test` **17/17**
(was 13; `WindowTests` added). No protocol/schema change; the existing
`changelog.d/voice-dictation.added.md` still covers the user-visible impact (no
new fragment: these are corrections to an unreleased feature).

### Gate

`bun run typecheck` green · `bun run lint` green (0 errors, 0 warnings — the
baseline in AGENTS §6) · `bun test` **10927 pass, 0 fail, 5 skip** (the 5 are the
documented opt-in gates: live-k8s ×2, live-docker ×2, real-socket keepalive, plus
the root-only `test.skipIf(isRoot)` pair; `main` carries the same set).
`bun run voice:test` 13/13. No protocol/schema change (`packages/protocol` is
untouched, so no `protocol.d/` note and no `protocol.json` regeneration).
Biome's ignore list gained `native/voice-mac/.build` (SwiftPM products) and
`.gitignore` gained the same path.

## Review

*— claude-opus-5-5, 2026-11-15* (fresh context; a different model family from the executor, deepseek-v4. The plan's author was also Opus 5.5.)

**Verdict: REQUEST-CHANGES.** Scope: `git diff main...HEAD`. Gate run here: touched tests 207 pass / 0 fail across 13 files; `bun run lint` clean; `bun run typecheck` green. Repros are in `.tentacle/tmp/voice-dictation/review/` (`dup.ts`, `race.ts`, `yes.ts`). The tree was byte-identical after the mutation (`git status` empty).

**HIGH**

1. **The transcript duplicates the field** (`packages/tui/src/App.tsx:795`). `field.insert(joinDictation(field.value, text))` inserts the whole field plus the transcript at the cursor. Field `hello`, dictation `world` → `hellohello world` (`dup.ts`, real App, fake helper). T7 misses it: it types `r` first and only asserts `toContain` (`voice-app.test.tsx:128`).
2. **Every dictation has id 1, so the stale-message guard never works** (`voice-session.ts:245-259`, `:414`). `idle()` resets `id` to `null`, so `begin` always produces `1`, and the guard is skipped while `id === null`. Two traces from `race.ts`:
   - **(A)** Ctrl+R → stop → Esc during transcribing → Ctrl+R. The cancelled dictation's `final` is **inserted**, which breaks Esc = discard. The TUI then goes idle while the helper starts capturing for the new `start`: the mic is on behind an idle TUI.
   - **(B)** Esc while `starting`. The in-flight `listening` line arrives afterwards and moves the TUI to `listening` with `id: null`, although the helper has already stopped. The next Enter is eaten and comes back as a `bad_request` notice.
3. **F4, F5 and auto-stop are not wired at all.**
   - `useVoice.ts` dispatches no `elapsed` or `clock` event and has no timer (no `final` timeout, no 10-min idle exit).
   - The helper's loop never emits `vad` or `level` (`main.swift:166-273`), and `voice-endpoint.ts` has no production caller.
   - Effects: `maxSeconds` never stops a forgotten dictation (the mic stays on and the buffer grows). A hung `stop` stays `transcribing` forever. `voice.autoStop` and `autoStopSilenceMs` are dead settings. The strip's elapsed time and meter stay at zero.
   - M5's "F5 cap insert" is green only on an event that nothing produces.
4. **The local `tentacle` TUI ignores the voice config.** `voice` is passed only by `runEngineTui` (`cli/src/main.ts:1404`, i.e. run/attach). The local TUI's `startTui` (`main.ts:2246`) and `connect` (`connect.ts:241`) never pass it, so they get `VOICE_DEFAULTS`. `voice.enabled: false` does not disable the mic, and `key`, `language` and `engine` are ignored on the main path.

**MEDIUM**

5. **F10 is pinned on the spec, not on the real spawn.** `defaultSpawner` (`useVoice.ts:63-69`) hardcodes the stdio and ignores `spec.stdio` and `spec.logPath`. stderr is piped and never drained, and `helper.log` is never written, yet notices point the user to it.
   - Mutation `useVoice.ts:67` `stderr: "inherit"` → `voice-spawn.test.ts` and `voice-app.test.tsx` stay **GREEN**, so T8 is vacuous for the real path.
6. **T7 depends on the host.** App never passes `platform`/`env` to `useVoice` (`App.tsx:792`). Under SSH (`dup.ts ssh`: no `start` is sent) or on Linux CI, `voice-app.test.tsx` fails.
7. **`tentacle voice setup --yes` drops `--yes`.** `parseArgs` puts it in `bools`, and `voiceCommand` only reads `positional` (`main.ts:953`, `voice-cmd.ts:96`). `yes.ts` shows the helper args `["setup"]`. T10 bypasses the parser.
8. **More dead settings and a broken lookup.**
   - `main.swift:209` hardcodes `voiceProcessing: true` and `preferredInput: "default"`, so `voice.input` and `voice.voiceProcessing` do nothing (the plan says no dead setting).
   - `useVoice.ts:139-144` spawns `candidates[0]` without checking it exists, so the `<configDir>/voice/bin` fallback is never reached. App also passes no `configDir`, so the log path becomes `/voice/helper.log`.
9. **An exit can orphan the next child** (static, narrow). `useVoice.ts:225-227` sets `childRef` to null on every exit. If a protocol-error `kill` (`voice-session.ts:381`) is followed by a retry within the 500 ms grace, the old child's exit nulls the NEW child's ref. That child then holds the mic, untracked, until the TUI exits.

**Attacks that found nothing:**
- F7 order: `voice` sits before `escUpload`/`escAbort` in `LAYER_ORDER`, and idle Esc passes through.
- Enter never submits: `VoiceCommand` has no `submit`.
- The `.strict()` schema and its `min(300)` floor.
- No `protocol` or persistence file is touched.

**Still open (Execution says so too):** S2 mic capture under-captures audio, and none of L1–L10 was run.

**Executor:** honest about the open capture bug and its own two vacuous tests. But the mutation table (M5, M7) and "T1–T10 red→green" overstate coverage of paths that production never drives.

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

#### Owner decisions (2026-11-15 11:15)

1. **Ctrl+R** starts, Ctrl+R or Enter finishes (Enter never sends), Esc discards, rebindable — as recommended.
2. **No auto-stop by default** (the user ends with the key); auto-stop stays an option — as recommended.
3. **NOT as recommended: Apple's built-in on-device recogniser is the DEFAULT engine** (no download; language from settings/auto where Apple allows), with a **switch to Parakeet** (config, e.g. `voice.engine: apple|parakeet`). Measure Apple's latency/WER with the V0 harness and record it next to Parakeet's; the comma-safe endpointing applies to both.
4. **`tentacle voice setup`** downloads Parakeet only when the user switches to it (size, confirm, progress, offline afterwards); with Apple as default, no download is needed to start — as recommended for Parakeet.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
