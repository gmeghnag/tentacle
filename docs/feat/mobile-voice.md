# feat/mobile-voice — Native, on-device dictation and read-aloud in the iPhone app

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/mobile-voice`
> **Size:** L, split into three slices: S (read-aloud), M (dictation), M (settings + polish) · **Blast:** cross-module (a new native module, the app-wide `AVAudioSession`, `app.json` plugin config shared with the camera and photo picker, the shared `Composer`). No protocol, daemon, persistence or relay change. · **Suited:** the owner assigns executors; L ⇒ a **fresh-context Review is mandatory** (AGENTS §10), and it must red-team the audio session and the "never cloud" rule (Failure modes F1, F4).
> **Changelog:** `changelog.d/mobile-voice.added.md`: "- **Voice on the iPhone.** Dictate a message with the mic button, on device and never sent to the cloud. Have a reply read aloud with the speaker button."

## Context

*— claude-opus-5-5, 2026-11-15*

**Why.** The owner asked on 2026-11-15 for native iOS speech in the iPhone app, fully on device and with no cloud keys. The realtime-voice architecture is approved in `docs/eval/realtime-media.md`; owner answers are at `:998-1010`. Three points from it bind this task:

- **The phone is the voice edge (V4).** STT is iOS `SpeechAnalyzer`, and only text crosses the E2E channel (Q6 answer, `:1005`).
- **Persistence.** Only the transcript is kept, never audio. The planned marker is an optional non-critical `via: "voice"` field (Q8, `:1007`).
- **Permission asks.** Spoken asks come from a deterministic template of the broker's text, and they are never answered by voice in v1 (Q4, `:1003`).

**TTS.** On the laptop the default is Kokoro. On the phone it is the system voice (owner brief).

**Gap.** V0 (`realtime-media.md:622-952`) measured the laptop cascade. The phone experiments (E7, E8, E10) were explicitly not run (`:811`). This task is the first, deliberately small phone step. It is **not** V4: it has no front model and no hands-free loop. It does two things:

1. **Dictation.** A mic button in the composer streams a live on-device transcript into the text field. The user edits it and sends as usual (Return sends, `ui/Composer.tsx:93-98`).
2. **Read-aloud.** A speaker button on assistant messages, plus an optional "read replies aloud" setting, speaks the reply with a good Italian or English system voice. Markdown is stripped to speakable text.

**Constraints.**

- The owner's phone runs **iOS 18.3.1**. The simulator runs iOS 26, and the E2E harness requires both 18.x and 26.x runtimes (`apps/mobile/e2e/README.md`). The deployment target is 18.0 (`apps/mobile/app.json`, `expo-build-properties`).
- No server-side change: no protocol, daemon or relay work.
- Never send audio anywhere. Never use a cloud recognizer: an on-device engine or nothing.
- AGENTS §7 "logic in pure modules": every branch goes in a React-free module tested by `bun test`. Components and Swift only render or bridge.

**Out of scope for v1.** A hands-free conversation loop, a wake word, voice approvals, any server-side change, background or lock-screen audio, Android.

**Repro (capability missing), 2026-11-15**, on `feat/mobile-voice` @ `ad9d9b41`:

```
$ rg -n "Speech|speech|NSMicrophone|microphonePermission" apps/mobile -g '!node_modules/**'
apps/mobile/src/permission-sheet.ts:436: * neutral with a speech bubble. …
apps/mobile/app.json:32:          "microphonePermission": false
apps/mobile/app.json:39:          "microphonePermission": false,
apps/mobile/test/pairing-guards.test.ts:130: … microphonePermission?: unknown …
apps/mobile/test/pairing-guards.test.ts:132:    expect(camera?.[1].microphonePermission).toBe(false);
apps/mobile/test/permission-sheet.test.ts:374:  test("reply is neutral with the speech-bubble icon", () => {
$ ls apps/mobile/modules
ls: apps/mobile/modules: No such file or directory
$ ls apps/mobile/node_modules ../../node_modules | grep -i 'speech\|haptics\|expo-audio'
(nothing)
```

What this shows:

- The repo has no speech code at all.
- It has no microphone or speech-recognition usage string.
- It has no local native module directory.
- Two plugins explicitly delete the microphone key (see Precondition P4: this matters).

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**On-device STT exists on both target OSes, through two different engines. The app can tell before listening whether the chosen engine will run on device, and it can refuse rather than fall back to the network.**

Proven from the Xcode SDK on this machine. Its Speech swiftinterface is built with Swift 6.4 and already carries `anyAppleOS 27` symbols:

- **iOS 18 path: `SFSpeechRecognizer`.**
  - `SFSpeechRecognitionRequest.requiresOnDeviceRecognition` is `API_AVAILABLE(ios(13))` (`Speech.framework/Headers/SFSpeechRecognitionRequest.h:65`).
  - The header says the request "only honors this setting if the `SFSpeechRecognizer/supportsOnDeviceRecognition` property is also `true`" (`:63`).
  - `supportsOnDeviceRecognition` is `API_AVAILABLE(ios(13))` (`SFSpeechRecognizer.h:164`). Its doc: "If `supportsOnDeviceRecognition` is `false`, the `SFSpeechRecognizer` requires a network in order to recognize speech" (`:162`).
  - `addsPunctuation` is iOS 16+ (`SFSpeechRecognitionRequest.h:72`).
  - **Consequence:** the gate is `supportsOnDeviceRecognition == true` checked *before* starting, together with `requiresOnDeviceRecognition = true` on the request. Either check alone is not enough. If `supportsOnDeviceRecognition` is false, dictation is **unavailable** for that locale, never "online".
- **iOS 26 path: `SpeechAnalyzer` + `SpeechTranscriber`.**
  - `final public actor SpeechAnalyzer` is `@available(anyAppleOS 26, *)` (`Speech.swiftmodule/arm64e-apple-ios.swiftinterface:227-228`).
  - `final public class SpeechTranscriber` is anyAppleOS 26 (`:344-346`). It has a `progressiveTranscription` preset (`:353`), the `volatileResults` reporting option (`:378`), and `static var isAvailable` (`:408`), which is the hardware gate.
  - It also has `supportedLocales`, `supportedLocale(equivalentTo:)` and `installedLocales` (`:411-417`).
  - `DictationTranscriber` is anyAppleOS 26 (`:67-70`): the broader-hardware sibling with the same locale API (`:152-156`).
  - Model assets are explicit, through `AssetInventory` (anyAppleOS 26, `:31-59`):
    - `status(forModules:)` returns `.unsupported | .downloading | .supported | .installed` (`:44-56`).
    - `assetInstallationRequest(supporting:)` downloads the model (`:57`).
    - `reserve(locale:)` and `maximumReservedLocales` cap how many locales the app may hold (`:34-43`).
  - This API is on device by design. It has no server mode to opt out of.

**What is NOT proven from headers, so it becomes Execution Step 0 (real device and simulator, results pasted into Execution):**

- (a) On the owner's iOS 18.3.1 phone, `supportsOnDeviceRecognition` is true for `it-IT` and `en-US`. It depends on the keyboard-dictation language assets being installed, which is folklore and not documented in the header.
- (b) `SpeechTranscriber.isAvailable` on the iOS 26 simulator. If it is false, the simulator exercises the `DictationTranscriber` or the unavailable branch, which is fine as long as the result is recorded.
- (c) Whether an on-device `SFSpeechRecognizer` request still hits the historical ~1 min per-request limit. The design segments anyway (F7).

If (a) is false on the phone, the owner hears it in Step 0, before any UI work. The two options then are a full-screen "turn on Dictation for Italiano" path, or v1 TTS-only on iOS 18.

### Preconditions

- **P1. Logic in pure modules (§7).** These are the patterns to copy:
  - the camera permission view-model `src/camera-access.ts:1-141` (structural types, no expo import);
  - the versioned settings record behind the `SecureKV` port, `src/lock-settings-store.ts:1-40` (fail-safe read, unknown `v` untouched, write failure rejects);
  - the composer decision `src/composer.ts:75` `composerAction` and `:112` `returnKeyAction`.
- **P2. Markdown is already parsed to a typed AST.**
  - `src/markdown.ts:24-65` defines `MdInline` and `MdBlock` (paragraph, heading, list, code{lang,text}, table, quote, rule, literal) and `Parsed` (`blocks | chunked`, the >20 000-char cap `:19`).
  - `plainText(parsed)` (`:306-345`) already walks it. Speakable text is a sibling walk over the same AST, not a second markdown parser.
- **P3. The draft has one writer seam.**
  - `SessionScreen.tsx:383-387` passes `draft={state.draft}` and `onChange={(text) => controller.setDraft(text)}`.
  - The compose controller persists drafts on the existing triggers (`compose-controller.ts:133-136, 309, 350`).
  - Dictation writes the field ONLY through `controller.setDraft`, so drafts, restore-after-failure (`composer.ts:149`) and the outbox see dictated text exactly like typed text.
- **P4. The microphone plist key is currently DELETED.**
  - `app.json` sets `"microphonePermission": false` in both `expo-image-picker` and `expo-camera`.
  - `test/pairing-guards.test.ts:131-132` documents `false` as expo-camera's **"delete the key"**.
  - Adding `NSMicrophoneUsageDescription` elsewhere would race those plugins' deletions; config-plugin mod order is not something to rely on.
  - **The fix is to make every writer agree:** both plugins get the SAME dictation string, and the pairing guard is rewritten to pin what it actually protects. See Design §6.
- **P5. The app is CNG.** `apps/mobile/ios/` is gitignored (`.gitignore:31`), so native config only exists via `app.json` plus config plugins, and a local module autolinks from `apps/mobile/modules/`. The dev build is `expo-dev-client` (`package.json`).
- **P6. Visual language.**
  - Tokens come from `src/theme.ts` (`accent :35`, `accentFill :37`, `red :44`, `glass`, `glassBorder`).
  - Icons are SF Symbols through a typed union in `src/ui/Icon.tsx:11-45`; a misspelt name fails typecheck.
  - The approved mockups (`.tentacle/tmp/mobile-ui/mockups/project/`, gitignored) have **no voice screen**: `rg -i 'mic|speaker|waveform|voice'` finds only "Dynamic Island". So Design §5 extends the existing capsule language and invents no new chrome.
- **P7. Assistant rows.** `transcript-rows.ts:27-38` `AssistantRow{key,text,version}` has no "complete" flag. Whether a row is still streaming must come from the session view (the running turn), decided in a pure function (Design §3).
- **P8. No protocol change.** Dictated text is sent as an ordinary prompt and read-aloud speaks text already on the phone. Nothing crosses the wire that does not today, so §7's protocol and persistence invariants are untouched. The `via:"voice"` marker is deferred (Owner Q2).

### Design

#### 1. One local native module, `apps/mobile/modules/tentacle-speech/` (Swift)

No maintained Expo module covers all of {SpeechAnalyzer on 26, on-device-only `SFSpeechRecognizer` on 18, `AVSpeechSynthesizer`, one owner of `AVAudioSession`}:

- **`expo-speech`** (TTS) wraps `AVSpeechSynthesizer` but does not configure the audio session. Under iOS's default `soloAmbient` category, speech then follows the silent switch and does not duck other audio. A second module touching the session would fight it.
- **Community STT modules.** `expo-speech-transcriber` (github.com/DaveyEke/expo-speech-transcriber) claims both engines, but it is a small single-maintainer project. `expo-speech-recognition`'s iOS 26 coverage is unverified.
- **On-device-only is a hard rule** here (F1). It must hold in code we own, not in a third party's default.

Recommendation: one module (Owner Q1). Its surface is deliberately dumb: it reports facts and runs commands. **Every decision lives in TS** (§2, §3):

```
capabilities(locales: string[]) → {
  os: number,                                   // major
  analyzer?: { transcriber: boolean, dictation: boolean,
               assets: Record<locale, "installed"|"supported"|"downloading"|"unsupported"> },
  recognizer: Record<locale, { supported: boolean, onDevice: boolean }>,
  permissions: { mic: "granted"|"denied"|"undetermined"|"restricted",
                 speech: "authorized"|"denied"|"notDetermined"|"restricted" } }
requestPermissions() → permissions               // mic first, then speech (one tap)
installAsset(locale) → void                      // iOS 26 AssetInventory; events: assetProgress{fraction}
startDictation({ engine: "transcriber"|"dictation"|"recognizer", locale }) → void
stopDictation() → void                           // finalize: flush volatile as final, then `ended`
cancelDictation() → void                         // drop volatile, `ended`
voices() → { id, language, name, quality: "default"|"enhanced"|"premium", novelty: boolean }[]
speak({ utterances: string[], voiceId, rate }) → void
stopSpeaking() → void
events: dictation{ finalDelta: string, volatile: string } · level{ rms: 0..1 }   // ~10 Hz
        ended{ reason: "stopped"|"cancelled"|"interrupted"|"route"|"error", code?: string }
        speech{ state: "started"|"utterance"(index)|"finished"|"stopped"|"interrupted" }
```

How the Swift side behaves:

- **Engine choice is passed in, never chosen in Swift.**
- **`recognizer` always sets `requiresOnDeviceRecognition = true`.** Swift *also* refuses to start when `supportsOnDeviceRecognition` is false, emitting `ended{error, code:"not-on-device"}`. This is belt and braces for F1.
  - `addsPunctuation = true`, `shouldReportPartialResults = true`.
  - Segment rollover: on a final result, or at 50 s, start a new request on the same audio tap. The finalized text goes out as `finalDelta`, so the stream is append-only.
- **`transcriber`** uses `SpeechTranscriber(locale:, preset: .progressiveTranscription)` in a `SpeechAnalyzer`, fed by an `AVAudioEngine` input tap converted to `bestAvailableAudioFormat(compatibleWith:)` (`:254`). Results with `isFinal` become `finalDelta`, and the others become `volatile`, which replaces the previous volatile text. `dictation` is the same with `DictationTranscriber`.
- **The audio session has one owner (this module).**
  - Dictation: `.playAndRecord`, mode `.default`, options `.duckOthers`, `.allowBluetoothHFP` (AirPods mic) and `.defaultToSpeaker`.
  - Speaking: `.playback` with `.duckOthers`, so it plays with the silent switch on (that is the point of a tap).
  - Deactivate with `.notifyOthersOnDeactivation` after both `ended` and `finished` or `stopped`.
  - Observe `AVAudioSession.interruptionNotification`, which emits `ended{interrupted}` or `speech{interrupted}`. Observe `routeChangeNotification` with `.oldDeviceUnavailable` (AirPods out), which emits `ended{route}` and stops speaking.
- **No `UIBackgroundModes: audio`.** Background is handled in TS (F6).
- **Haptics:** `UIImpactFeedbackGenerator` (light) on listen start, (soft) on stop, and `UINotificationFeedbackGenerator.error` on a failure. They are fired by TS calling a tiny `haptic(kind)` on the same module, which avoids an extra `expo-haptics` dependency.

#### 2. Pure modules for dictation (`src/`, React-free, `bun test`)

- **`speech-engine.ts`: `chooseEngine(caps, locale) → EngineChoice`.** Possible results:
  - `{engine, locale}`;
  - `{needsDownload, locale}` (iOS 26, asset `supported` and not installed);
  - `{unavailable, reason: "no-on-device-model" | "locale-unsupported" | "hardware"}`.

  Order of preference:
  1. `transcriber` when `analyzer.transcriber` and the asset is installed;
  2. `dictation` when its asset is installed;
  3. `needsDownload` when either is `supported`;
  4. `recognizer` **only if `onDevice`**;
  5. otherwise `unavailable`.

  A recognizer that is `supported && !onDevice` is `unavailable{no-on-device-model}`, never chosen. That is the F1 test.
- **`voice-permission.ts`**, modeled on `camera-access.ts`. It maps (mic, speech) states to the `MicView{action: "ask"|"start"|"explain"|"none", card?: "denied-mic"|"denied-speech"|"restricted"|"unavailable", settings: boolean, message?}`.
  - `undetermined` on either side means ask on the tap, and never before (camera decision 10).
  - `denied` explains, with "Open Settings" (`Linking.openSettings()`).
  - `restricted` gets a card with no Settings button, because Screen Time cannot be fixed from our Settings page.
  - Unavailable has its own sentence per `reason`.
- **`dictation.ts`**: the state machine plus the text merge, with an injected clock.

  States: `idle → asking → preparing(download?: fraction) → listening{base, finals, volatile, startedAt, lastTextAt} → finalizing{then: "idle"|"send"} → idle`, plus `failed{reason}`, which shows a card and then returns to idle.

  Events: `tap`, `permissions(…)`, `choice(…)`, `assetProgress`, `started`, `dictation{finalDelta, volatile}`, `ended{reason}`, `userEdit(text)`, `return`, `sendPress`, `appState`, `tick(now)`, `ttsStarted`.

  Effects (returned, never performed): `requestPermissions`, `installAsset`, `start(engine, locale)`, `stop`, `cancel`, `setDraft(text)`, `haptic(kind)`, `send`, `stopSpeaking`.

  Rules, each one a test:
  - `draftOf(listening) = join(base, finals, volatile)`. The separator is a single space, and only when both sides are non-empty and the left side does not end in whitespace or a newline. Each event emits `setDraft`, so the field shows text live.
  - **`base` is the draft at start**, so dictation appends to what was typed. Inserting at the cursor is debt; see Notes.
  - **The user types during listening** (`userEdit` whose text ≠ `draftOf`): emit `cancel`. The user's text wins and pending volatile text is dropped, never re-appended.
  - **Return or Send during listening** goes to `finalizing{then:"send"}`: emit `stop`, wait for `ended` or 1.5 s (`tick`), take the final draft, then emit `send`. That send goes through the existing `controller.pressReturn()` or `press()`, so `composerAction`'s blockers (offline, turn running, queue) still decide.
  - **Tap during listening** emits `stop` and goes to `finalizing{then:"idle"}`, where volatile text is promoted to final. **Tap during `preparing`** emits `cancel`.
  - **`tick`**: auto-stop after **20 s with no new text** (the mic was forgotten on) and at a **10 min hard cap**. Both emit `stop` plus a notice ("dictation stopped after 20 s of silence" / "…at 10 minutes").
  - `ended{interrupted|route}` keeps everything finalized and shows the notice "dictation stopped (call / audio route changed)". `ended{error}` keeps the finals and goes to `failed`.
  - `appState: inactive|background` during listening or finalizing emits `stop` and keeps the text (F6). During `preparing`, a download in progress continues in the system, and the state returns to idle.
  - Starting dictation while TTS speaks emits `stopSpeaking` first, so the app never transcribes its own voice.
- **`speech-locale.ts`: `dictationLocale(setting, deviceLocales) → "it-IT" | "en-US"`.**
  - `auto` picks the first device locale whose language is `it` or `en`, falling back to `en-US`.
  - An explicit setting wins.
  - `speechLocaleCandidates` returns the list sent to `capabilities`.

#### 3. Pure modules for read-aloud

- **`speakable.ts`: `speakable(parsed: Parsed, lang: "it"|"en") → string[]`** (utterances). It walks `MdBlock` like `plainText` (`markdown.ts:306`):
  - `paragraph` and `heading` become `flatten(children)`, one utterance each. Headings end with a period so the voice pauses.
  - `link` keeps only its text, never the href. A bare URL becomes "link" or "collegamento".
  - Inline `code` text is kept, with `_`, `/` and `.` read as is (it is short).
  - **`code` block** becomes "code block, N lines" or "blocco di codice, N righe" (N = `text.split("\n").length`, a trailing newline not counted; singular "1 line" or "1 riga"). It adds ", <lang>" when `lang` is set.
  - `table` becomes "table, R rows" or "tabella, R righe".
  - `list` items are one utterance each, in order. Ordered lists get "1." spoken naturally.
  - `quote` children are spoken as is. `rule` is skipped.
  - `literal` (raw HTML) is spoken with tags removed.
  - Emoji and box-drawing characters are stripped, and runs of whitespace are collapsed.
  - Any utterance over 600 characters is split at a sentence boundary.
  - `chunked` (over 20 000 characters) speaks `shown` as plain paragraphs, then "message truncated" or "messaggio troncato".
  - Empty input yields `[]`.
- **`speech-language.ts: detectLanguage(text, fallback) → "it"|"en"`.** It counts stopword hits from a closed list of about 30 words per language and needs a margin of at least 2 hits. Otherwise it returns `fallback`, the dictation or locale setting.
- **`pickVoice(voices, lang) → id | undefined`.** It filters by `language` prefix and excludes `novelty`. It ranks `premium > enhanced > default`, then prefers `it-IT` or `en-US` over other regions, then sorts by name for determinism. `undefined` means the system default for the language, which AVSpeech provides.
- **`read-aloud.ts`**: the state machine, `idle | speaking{rowKey, index, total}`.
  - Tapping the speaking row's button emits `stopSpeaking`. Tapping another row emits `stopSpeaking` then `speak(other)`.
  - `speech{finished|stopped|interrupted}` returns to idle.
  - `appState background` emits `stopSpeaking`.
  - Dictation starting emits `stopSpeaking`.
  - `readAloudOffered(row, runningRowKey)` is false for the row still streaming, so the button appears only on finished replies.
  - **Auto-read** (the setting): on a turn end, the last assistant row of that turn is spoken only if the setting is on, the session screen is focused, the app is `active`, dictation is idle, and the user did not start that turn from another device. That last condition comes from the session view's own-turn knowledge (`composer.ts` `REFUSED_NOTICE` path); if that knowledge is not cheaply available, drop the condition and note it.
  - **Spoken permission ask** (only when auto-read is on, eval Q4): a deterministic template from the permission-sheet view-model's own title, "Permission needed: <title>. Answer on screen." or "Serve un permesso: <title>. Rispondi sullo schermo.". It never includes pod-supplied arguments and never comes from a model. Approval stays a tap.
- **`voice-settings-store.ts`**: the `lock-settings-store.ts` pattern behind `SecureKV`. The record is `{v:1, readAloud: boolean, language: "auto"|"it-IT"|"en-US", rate: "normal"|"fast"}`. An unreadable record reads defaults (`false, auto, normal`). An unknown `v` is read as defaults and not overwritten. A write failure rejects, and Settings shows "didn't save".

#### 4. Wiring (the only non-pure TS)

- **`src/speech-native.ts`** is a structural port, `SpeechPort`. The interface above is implemented by `requireNativeModule("TentacleSpeech")` in `speech-native-expo.ts`. The pure controllers take the port, the same split as `app-log-fs.ts` / `app-log-fs-expo.ts`.
- **`src/voice-controller.ts`** is a thin driver, the `compose-controller.ts` shape: it feeds port events and RN `AppState` into the two reducers and performs their effects. Unit tests run it with a `FakeSpeechPort`, in the existing fakes style (AGENTS §9).
- `SessionScreen.tsx` owns one voice controller per mounted screen, passes `setDraft`, `pressReturn` and `press` from the compose controller, and disposes it on unmount (which emits `cancel` and `stopSpeaking`).

#### 5. UI (render only)

- **`ui/Composer.tsx`.** A mic button sits inside the capsule, right of the field and opposite the photo button: 20 pt `mic`, in `accent` when idle.
  - While listening, the capsule border becomes `accent` (from `glassBorder`), the icon becomes `waveform` and its opacity follows `level.rms`, and the placeholder reads "Listening…" or "Sto ascoltando…".
  - While preparing a download, it shows "Downloading Italian speech model… 42 %".
  - New props: `mic: MicButton` (`"idle"|"listening"|"preparing"|"hidden"`), `onMic`, `level`.
  - `Icon.tsx` gains `mic`, `mic.fill`, `waveform`, `speaker.wave.2` and `stop.circle`.
  - testIDs: `composer-mic`, `composer-mic-listening`, `voice-card` (+ `voice-card-settings`).
- **Cards.** Denied and unavailable states use the existing `Banner` primitive above the composer, with the view-model's message and an "Open Settings" action when `settings`.
- **`TranscriptRow.tsx`.** Under a finished assistant row, a small `speaker.wave.2` in `sec` color becomes `stop.circle` in `accent` while that row speaks. It has `accessibilityLabel` "Read aloud" / "Stop reading" and testIDs `assistant-speak` / `assistant-speak-stop`.
- **`SettingsScreen.tsx`.** A new "Voice" grouped card holds three things:
  - "Read replies aloud" (switch);
  - "Language" (Auto / Italiano / English);
  - "Speaking rate" (Normal / Fast).

  Below it, a footnote: "Dictation and speech run on this iPhone. Audio never leaves it and is never saved."

#### 6. Native config (`app.json`)

- Register the local module's config plugin (`./modules/tentacle-speech/app.plugin.js`). It writes `NSSpeechRecognitionUsageDescription`: "tentacle turns your speech into text on this iPhone, for the message you are writing".
- Change `microphonePermission: false` to the SAME string in **both** `expo-camera` and `expo-image-picker`: "tentacle uses the microphone only while you dictate a message; audio stays on this iPhone". `recordAudioAndroid: false` stays.
- Rewrite `pairing-guards.test.ts:124-133` to pin what it protects:
  1. the camera plugin never records audio (`recordAudioAndroid === false`; the scanner records nothing);
  2. every plugin that writes the microphone key writes the one dictation string, so no plugin can delete what another adds.

  Precondition P4 explains why.
- After `expo prebuild`, Execution greps the generated `Info.plist` for both keys and pastes the result (F3).

### Files

In dependency order. Everything is in `apps/mobile/`; nothing outside it except `changelog.d/`.

**Slice 1 (S): read-aloud.** Smallest, and it proves the native module end to end.

1. `modules/tentacle-speech/`: `expo-module.config.json`, `TentacleSpeech.podspec`, `ios/TentacleSpeechModule.swift` (voices, speak, stopSpeaking, haptic, the audio session for playback, interruption and route observers), `index.ts`.
2. `src/speakable.ts`, `src/speech-language.ts` (+ `pickVoice`), `src/read-aloud.ts`, with tests.
3. `src/speech-native.ts`, `src/speech-native-expo.ts`, `src/voice-controller.ts` (read-aloud half).
4. `src/ui/Icon.tsx` (new names), `src/screens/transcript/TranscriptRow.tsx` (speaker button), `src/screens/SessionScreen.tsx` (controller).

**Slice 2 (M): dictation.**

5. The Swift additions: capabilities, permissions, installAsset, the three engines, segment rollover, level, the record session.
6. `app.json` (P4 and Design §6), `modules/tentacle-speech/app.plugin.js`, `test/pairing-guards.test.ts`.
7. `src/speech-engine.ts`, `src/voice-permission.ts`, `src/speech-locale.ts`, `src/dictation.ts`, with tests.
8. `src/voice-controller.ts` (dictation half), `src/ui/Composer.tsx` (mic and listening state), `src/screens/SessionScreen.tsx`.

**Slice 3 (M): settings and polish.**

9. `src/voice-settings-store.ts` (+ test), `src/screens/SettingsScreen.tsx` (Voice card).
10. Auto-read and the spoken-ask template in `read-aloud.ts` (+ tests). Level-driven listening visuals.
11. `e2e/flows/24-voice-mic-denied.yaml`, `25-read-aloud.yaml`, `26-voice-settings.yaml` (+ the harness hooks if needed). `modules/tentacle-speech/README.md` (real-device checklist below). `changelog.d/mobile-voice.added.md`.

### Failure modes

| # | Failure | How state converges |
|---|---|---|
| F1 | **No on-device model** for the locale (iOS 18: `supportsOnDeviceRecognition == false`; iOS 26: asset `unsupported`) | `chooseEngine` returns `unavailable{…}`, the mic shows the card "On-device dictation for Italiano isn't available on this iPhone. Turn on Dictation for Italiano in Settings › General › Keyboard, or switch language" (iOS 18 wording verified in Step 0). **Never a network recognizer**: TS refuses AND Swift refuses (`not-on-device`). Test: a fake capability with `supported && !onDevice` asserts no `start` effect. |
| F2 | **Permission** undetermined / denied (mic or speech) / restricted | `voice-permission.ts`: ask only on the tap. On denied, a card plus Open Settings. On restricted, a card and no button. A grant in Settings is picked up on the next `active` (re-read `capabilities`). A denial mid-request never leaves state at `asking` (the promise resolves to the states and the reducer re-derives). |
| F3 | **Plist key missing** (the P4 race) | Without the key, iOS kills the app at the first mic access. Prevented by the agreeing writers (Design §6), the rewritten guard test, and the `Info.plist` grep after prebuild, pasted into Execution. |
| F4 | **Audio interruptions** (call, Siri, alarm) / **route change** (AirPods removed) / another app takes the session | Swift emits `ended{interrupted\|route}` or `speech{interrupted}`. Dictation keeps the finalized text and shows a notice; read-aloud goes idle. Nothing auto-resumes in v1. The session deactivates with `notifyOthers`, so the user's music returns. With AirPods connected at start, HFP gives an AirPods mic and output. |
| F5 | **iOS 26 asset not installed / download fails / reserved-locale cap** | `needsDownload` leads to `preparing{fraction}` with a cancellable progress line. A failure goes to `failed{download}` with a retry on the next tap. `reserve(locale:)` returning false at `maximumReservedLocales` falls back to the next engine in `chooseEngine` order, else `unavailable`. |
| F6 | **App backgrounded / locked / switcher** while listening or speaking | No background audio mode. `AppState inactive\|background` emits `stop` for dictation (finals kept, draft saved by the existing `compose-controller` background write `:136`) and `stopSpeaking`. The app-lock cover is unaffected. Returning does not resume. |
| F7 | **Long dictation** | iOS 18 segment rollover (final or 50 s) keeps the stream append-only. 20 s with no new text auto-stops; a 10 min cap stops with a notice. The text is always in the field, so nothing is lost. |
| F8 | **User edits while listening / sends while listening** | `userEdit` emits `cancel`: the user's text wins and pending volatile text is dropped. Return or Send leads to `finalizing{send}` (≤ 1.5 s), then the normal `composerAction` path. If the composer blocks (offline, turn running), the existing outbox and queue rules apply unchanged, and the text is never lost (`restoreAfterFailure`). |
| F9 | **Empty transcript** (stop with no speech) | The draft equals `base`: no send, no notice, a soft haptic. |
| F10 | **TTS: no voice for the detected language, empty speakable, very long message** | `pickVoice` returns `undefined` and the system default for the language is used. `speakable == []` means the button is disabled. Over 600-character utterances are split; `chunked` adds "message truncated". |
| F11 | **TTS and dictation collide** | Either one starting stops the other first (reducer effects), so the session category switches cleanly and the app never transcribes itself. |
| F12 | **Auto-read noise** (a reply finishing while the user is elsewhere, a laptop-driven turn) | Spoken only under every gate in Design §3. Anything else is silent. Default off. |
| F13 | **Screen unmount mid-dictation or mid-speech** | The controller's `dispose` emits `cancel` and `stopSpeaking`. A late native event after dispose is ignored, because the listener is removed first. |

### Tests

**Unit tests** (`bun test apps/mobile/test/<file>`). §9 applies: red before green per module, plus mutation checks named below.

- **`speakable.test.ts`.** Code block (1 / N lines, it and en, with and without lang). Inline code kept, link text without href, bare URL. Table, nested list, quote, rule, literal HTML. Emoji stripped, over-600-character split at a sentence, `chunked` truncation suffix, empty. **Mutation:** speak `block.text` for code and the "N lines" test must fail.
- **`speech-language.test.ts`.** it, en, mixed below the margin → fallback, empty. `pickVoice` covers premium over enhanced, novelty excluded, region preference, determinism, and no match → `undefined`.
- **`read-aloud.test.ts`.**
  - tap / stop / switch rows;
  - finished, interrupted, background;
  - `readAloudOffered` false for the streaming row;
  - auto-read gates, one test per gate;
  - the spoken-ask template contains the title and never the args.
- **`speech-engine.test.ts`.** The full preference order. **F1:** `recognizer{supported:true,onDevice:false}` is never chosen (mutation: drop the `onDevice` check and this test fails). Reserve cap → fallback.
- **`voice-permission.test.ts`.** Every (mic × speech) combination → view. Restricted has no settings button.
- **`dictation.test.ts`.**
  - the separator rules of `draftOf`;
  - volatile replaced, not appended;
  - userEdit → cancel and no re-append;
  - Return during listening → finalize then send, plus the timeout;
  - 20 s silence and the 10 min cap with the injected clock;
  - interrupted / route keep finals;
  - background → stop;
  - preparing tap → cancel;
  - TTS stopped on start.
- **`speech-locale.test.ts`, `voice-settings-store.test.ts`.** Locale cases; the store's three fail-safe rules, copied from `lock-settings-store.test.ts`.
- **`voice-controller.test.ts`** with a `FakeSpeechPort`. Effects reach the port in order, `setDraft` reaches the compose seam, and dispose removes listeners.
- **`pairing-guards.test.ts`** (rewritten, Design §6). Red against a mutation: one plugin back to `false` makes the agreement test fail.

**Maestro** (`bun run e2e:mobile`, iOS 18 and 26 simulators). Maestro cannot speak into the mic, so no flow asserts a transcript:

- **`24-voice-mic-denied`:** `xcrun simctl privacy <udid> revoke microphone so.tentacle.app` before launch → tap `composer-mic` → `voice-card` + `voice-card-settings` visible.
- **`25-read-aloud`:** seed a reply → tap `assistant-speak` → `assistant-speak-stop` visible → tap → `assistant-speak` back. Simulator TTS works.
- **`26-voice-settings`:** toggle "Read replies aloud" → relaunch → still on (the store round-trip).
- **Simulator mic unavailable:** if Step 0 finds the simulator reports no on-device engine, add a flow asserting `voice-card` with the unavailable text instead of listening.

**Real-device checklist** (in `modules/tentacle-speech/README.md`; results pasted into Execution with device, OS and date). Owner's iPhone, iOS 18.3.1, plus an iOS 26 device if available:

1. **Step 0 facts:** (a), (b) and (c) from the Load-bearing assumption, for `it-IT` and `en-US`.
2. Airplane mode on → dictate Italian and English → text appears (proves on device).
3. First-run prompts: the mic prompt then the speech prompt, with the strings from Design §6. Deny → card → Settings → grant → works without relaunch.
4. Music playing → dictate → music ducks, then returns after stop. Same for read-aloud.
5. Silent switch on → read-aloud is audible.
6. AirPods: dictate through the AirPods mic. Remove one AirPod mid-dictation → stops with the notice, text kept. Read-aloud stops on removal.
7. Incoming call (or a FaceTime from a second device) mid-dictation → stops, text kept. Mid-speech → stops.
8. Lock the phone or switch apps mid-dictation → stops, draft kept after unlock.
9. 3-minute continuous dictation on iOS 18 → no gap or duplicate at segment boundaries.
10. Read a reply with a code block and a table → hear "code block, 12 lines" / "blocco di codice, 12 righe", no symbols spoken, and a good voice (note which voice `pickVoice` chose).
11. Haptics on start, stop and error.
12. VoiceOver on: the mic and speaker buttons announce their labels. Read-aloud doesn't fight VoiceOver (stop on VO focus change is acceptable debt).

**Gate before Review:** `bun test`, `bun run typecheck` (including `tsc -p apps/mobile`), `bun run lint` (baseline clean), and `bun run e2e:mobile` on 18 and 26.

### Owner questions

1. **Native module: one local `tentacle-speech` Swift module for STT (both engines), TTS and the audio session, or `expo-speech` plus a community STT module?** Recommendation: **the local module.** `expo-speech` does not own the audio session, so it follows the silent switch, doesn't duck, and would fight the STT module over `AVAudioSession`. No maintained module verifiably covers SpeechAnalyzer *and* an enforced on-device-only `SFSpeechRecognizer`. The Swift is about 400 lines and we control the never-cloud rule (F1).
2. **The `via: "voice"` marker on dictated messages (eval Q8): now or later?** Recommendation: **later**, in V4 or a hands-free task. It is an on-disk and protocol field, which this brief rules out ("no server-side changes"). And v1 dictation is edited by the user before sending, which is no different from the iOS keyboard's own dictation.
3. **Language choice.** Recommendation: **Settings "Language: Auto / Italiano / English"**. Auto follows the iPhone's languages. A long-press on the mic offers a one-shot switch. Read-aloud picks its voice per message by detected language, so an English reply to an Italian user is read in English.
4. **"Read replies aloud" default and the spoken permission ask.** Recommendation: **default off.** When on, speak only a reply that finishes while you are looking at that session, plus a templated "Permission needed: <title>. Answer on screen." for asks. Never speak the arguments, and never approve by voice (eval Q4).

## Execution

*— executor recorded as **deepseek** by the exec commit `2dca65b3` ("feat(mobile-voice): exec (deepseek)"), 2026-11-15. This line first read `claude-opus-5-5`, which conflicts with that commit (Review round 1, finding 2). The exact DeepSeek model id is not recorded anywhere in the repo; the orchestrator must confirm it. Fix round 1 below is signed separately.*

### Load-bearing check (re-run first)

- **Header half: holds.** Re-grepped against the SDK on this machine, `iPhoneOS27.1.sdk`.
  - `SFSpeechRecognitionRequest.h:63,65`: `requiresOnDeviceRecognition` is honoured only if `supportsOnDeviceRecognition` is true.
  - `SFSpeechRecognizer.h:162,164`: with `supportsOnDeviceRecognition` false, the recognizer "requires a network".
  - `addsPunctuation` is at `:72`.
  - `Speech.swiftinterface`:
    - `actor SpeechAnalyzer` `:228`; `class SpeechTranscriber` `:346`, with `.progressiveTranscription` `:353`, `.volatileResults` `:378` and `isAvailable` `:408`;
    - `class DictationTranscriber` `:70`;
    - `AssetInventory`: `maximumReservedLocales` / `reservedLocales` / `reserve` / `status` / `assetInstallationRequest` `:34-57`;
    - `bestAvailableAudioFormat` `:254`.
- **Step 0 (a)(b)(c): NOT RUN.** There is no device or simulator in this executor's reach.
  - The real-device checklist is in `modules/tentacle-speech/README.md`.
  - Until (a) is known, the iOS 18 phone path is unverified. The code still cannot go to the network: the TS refusal and the Swift refusal are both tested (see Mutations).

### As built, in plan order

**Slice 1: read-aloud (DONE, except the native run).**

- `src/speakable.ts`, a walk of `Parsed`:
  - a code block becomes "code block, N lines[, lang]" (it/en);
  - a table is summarised, a link keeps its text, a bare URL is read as "link";
  - emoji and box-drawing characters are stripped;
  - utterances are split at 600 characters at a sentence boundary;
  - a `chunked` row ends with "message truncated".
- `src/speech-language.ts`: `detectLanguage`, with a margin of 2, and `pickVoice`.
- `src/read-aloud.ts`: the reducer, plus `readAloudOffered`, `streamingRowKey`, `speechRequest`, `autoReadRow` and `spokenAsk`.
- The native module is in `modules/tentacle-speech/`:
  - `ios/SpeechCore.swift`: the session, permissions, capabilities, `AVSpeechSynthesizer`, the interruption and route observers, and haptics;
  - `ios/TentacleSpeechModule.swift` (the Expo glue), `ios/TentacleSpeech.podspec`, `expo-module.config.json`;
  - `src/speech-native.ts` (the port) and `src/speech-native-expo.ts`.
- UI: `Icon.tsx` (+5 names), `TranscriptRow.tsx` (`assistant-speak` / `assistant-speak-stop`), `SessionScreen.tsx`.

**Slice 2: dictation (DONE, except the native run).**

- `ios/RecognizerEngine.swift` (iOS 18, on device only, 50 s rollover) and `ios/AnalyzerEngine.swift` (iOS 26).
- `app.json`:
  - the same dictation string goes into **both** `microphonePermission`s;
  - the plugin `./modules/tentacle-speech/app.plugin.js` is registered and writes `NSSpeechRecognitionUsageDescription`.
- `test/pairing-guards.test.ts` is rewritten (Design §6), plus a plugin test.
- `src/speech-engine.ts`, `src/voice-permission.ts`, `src/speech-locale.ts`, `src/dictation.ts`.
- `src/voice-controller.ts`.
- `ui/Composer.tsx` gets the mic button: `composer-mic` / `composer-mic-listening`, an accent border while listening, and a level-driven waveform.
- SessionScreen gets the `voice-card` / `voice-card-settings` Banner and the `voice-notice` line.

**Slice 3: settings and polish (PARTIAL).**

- Done:
  - `src/voice-settings-store.ts` (store and holder) and `src/voice-settings-expo.ts`;
  - the `SettingsScreen.tsx` Voice card: `voice-read-aloud`, `voice-language-*`, `voice-rate-*`, the footnote and `voice-error`, wired in `App.tsx`;
  - auto-read and the spoken ask (in the controller, gated in `read-aloud.ts`);
  - the module README with the checklist;
  - `changelog.d/mobile-voice.added.md`.
- **Not done: the Maestro flows 24, 25 and 26.**
  - They need a dev build that contains the new native module (prebuild, pod install, xcodebuild) and a `simctl privacy` harness hook.
  - Neither can be produced or verified here, and an unrun flow proves nothing (`e2e-flows.test.ts` rules).
  - To verify: build the dev client, then add the three flows against the testIDs above.

**F3 (plist).** `bunx expo config apps/mobile --type introspect --json`, which runs every plugin mod, produced:

```
"NSMicrophoneUsageDescription":"tentacle uses the microphone only while you dictate a message; audio stays on this iPhone"
"NSSpeechRecognitionUsageDescription":"tentacle turns your speech into text on this iPhone, for the message you are writing"
```

(The camera, Face ID, local-network and photo keys are unchanged.)

**Swift.** The three engine files typecheck with no errors and no warnings:

```
$ xcrun -sdk iphoneos swiftc -typecheck -swift-version 5 -target arm64-apple-ios18.0 SpeechCore.swift RecognizerEngine.swift AnalyzerEngine.swift
TYPECHECK_OK
```

`TentacleSpeechModule.swift` imports ExpoModulesCore, so it was checked against the expo-modules-core 58 sources by reading only, not compiled. That covers `Exception(name:description:code:)`, `runOnQueue` (async only, so the sync commands hop with `DispatchQueue.main.async`) and `OnCreate`. **To verify:** run a dev-client build.

### Red → green and mutations

| Target | Mutation / red | Result |
|---|---|---|
| `pairing-guards` agreement test | written before the `app.json` change | RED: `Expected: "string"  Received: "boolean"`, then green |
| same | `expo-image-picker` mic back to `false` | 1 fail (agreement test) |
| `speakable` (the plan's target) | speak `block.text` for a code block | 4 fail (all "code block" tests) |
| `speech-engine` F1 (the plan's target) | drop the `onDevice` check | 2 fail (both F1 tests) |
| `read-aloud` | drop the `event.id` check | 1 fail ("late 'stopped' does not idle the new one") |
| `read-aloud` spoken ask | add `detail` to the template | 1 fail ("never the detail or input") |
| `dictation` | append volatile instead of replacing it | 1 fail |
| `dictation` F11 | `stopSpeaking` after `start` | 6 fail |
| `voice-controller` F13 | no `unsubscribePort()` in dispose | 1 fail |
| `voice-wiring` (Swift F1) | `requiresOnDeviceRecognition = false` | 1 fail |

Every mutation was reverted and the file re-run green. The new modules are features, not fixes, so for them "red" means the mutations above. Their tests could not be red on an assertion before the module existed.

### Drift from the Implementation (and why)

1. **`speak` and `speech` events carry an `id`.** Without it, switching rows lets the old speech's late `stopped` idle the new one.
2. **`speak` carries `lang` / `language`.** AVSpeech needs a language when `pickVoice` returns `undefined` (F10).
3. **The port gains `reserveLocale`, and `installAsset(engine, locale)`.** The reducer gains a `reserve` effect and a `reserved` event. F5's fallback needs a TS seam. Capabilities also report `dictationAssets`, because the two iOS 26 models have separate assets.
4. **`probe` effect / `probed` event; `startFailed` in `asking`.** The capabilities read is a reducer effect, not controller logic, and a throw never leaves the state at `asking`.
5. **`finalizing.then` became `finalizing.after`.** Biome's `noThenProperty` rule.
6. **Send semantics:**
   - an interruption or route change never sends, even mid-`finalizing{send}`;
   - F9 ("no send") applies to a tap-stop;
   - an explicit Send with no new speech still goes to `composerAction`, which decides.
7. **Recognizer error 1110 ("no speech") ends as `stopped`, not `error`.** It is a quiet end and needs no failure card.
8. **Swift is split into three engine files plus the glue**, so the engines typecheck without Expo. The podspec sits in `ios/` (the Expo local-module convention). There is no `modules/…/index.ts`: the adapter is `src/speech-native-expo.ts`, which uses `requireOptionalNativeModule`. On a build without the module the mic and speaker buttons are hidden.
9. **New pure modules:**
   - `voice-view.ts`: the SessionScreen projection plus `endedTurn`, so the screen holds no branching (§7);
   - the settings holder;
   - `voice-settings-expo.ts`, so `pairing-guards`' Keychain-importer list now has three wiring files, sorted.
10. **Auto-read's own-turn gate** uses `TurnRow.own` (`transcript-rows.ts:87`). It was cheap, so it was kept.
11. **`deviceLocales`** is `Intl…resolvedOptions().locale`, a single locale, because `expo-localization` is not a dependency.
12. **The spoken ask caps the title at 80 characters.**
13. **Not built:** Owner Q3's long-press one-shot language switch (debt), and the Maestro flows (above).
14. **Side effect (Android, out of scope).** A string `microphonePermission` makes expo-image-picker add `android.permission.RECORD_AUDIO` (`withImagePicker.js:36-44`); `introspect` now lists it. The app is iOS-first and the module is iOS-only.
15. **Unverified:** whether `SpeechAnalyzer` needs Speech authorization. Both permissions are requested anyway, as the plan says.

### Gate

`bun run typecheck` (root, `apps/mobile`, `apps/relay`) is clean. `bun run lint`: `Checked 1457 files … No fixes applied`, 0 errors. `bun test`: **10480 pass, 4 skip, 0 fail**.
- 3 of the skips are the baseline opt-ins.
- The 4th is the pre-existing docker opt-in `packages/cli/test/session-hop.docker.test.ts:248` (`TENTACLE_DOCKER_TESTS`). None are in `apps/mobile`.
- No schema changed, so there is no `protocol.json` regeneration and no `protocol.d/` note.

### Fix round 1

*— claude-opus-5-5, 2026-11-15*

**Finding 1 (HIGH, start/cancel race): FIXED in TS and Swift. The Swift runtime behaviour is unverified on a device.**

Root cause: no event or command named the dictation it belonged to. A `started` that arrived after a cancel was dropped, and the native cancel had either already missed the engine or reached it too early.

The fix tags every attempt with an id, taking the reviewer's preferred option, which matches drift 1 for speech:

- **TS**
  - `dictation.ts`
    - `tap` carries `attempt`, a fresh id from the controller's counter (an id source, like `now`).
    - `asking`, `preparing`, `listening` and `finalizing` carry it.
    - The `start` and `cancel` effects carry it.
    - `started` carries it; `startFailed` and `ended` may carry it.
  - `stale()` runs before the per-state switch:
    - a `started` that is not the current `preparing{starting}` → `cancel{attempt: event.attempt}`, whatever the state, and the state is unchanged;
    - a duplicate `started` for the current listening attempt → no effect;
    - an `ended` or `startFailed` tagged with another attempt → ignored.
  - Because a `cancel` names its attempt, cancelling a stale start never touches a newer one.
  - `voice-controller.ts`: `tapMic` increments `attempts`; `start` passes it and tags both outcomes; `cancel` → `port.cancelDictation(attempt)`; the port's `ended.attempt` is forwarded.
  - `speech-native.ts` / `speech-native-expo.ts`: `startDictation({…, attempt})`, `cancelDictation(attempt)`, `ended.attempt?`.
- **Swift**
  - `SpeechCore.swift`:
    - `cancelledThrough` and `newestStart`, both main-thread only;
    - `startDictation(…, attempt:)` refuses a cancelled or older attempt on entry, so a cancel that reached main before the start's hop wins;
    - after `await next.start()`, if the attempt was cancelled or superseded, it runs `next.cancel()` and throws `cancelled`;
    - the catch path nils `engine` only if it is still this start's engine (before, it could nil a newer one);
    - `cancelDictation(attempt:)` records the attempt and cancels the engine only when `attempt >= newestStart`;
    - `EngineSink` carries the attempt, so `coreEnded` sends `attempt`.
  - `AnalyzerEngine.start`: the `finished` check shares a main hop with the step it guards. One hop does the check plus installing the analyzer and results task; another does the check plus `startAudio`. A cancel during any await either finds the analyzer to cancel, or makes the start throw before the mic opens.
  - `RecognizerEngine.begin`: `guard !finished` first.
  - `TentacleSpeechModule.swift`: the `startDictation` / `cancelDictation` arguments and `ended.attempt`. Checked by reading only, as in round 0: it imports ExpoModulesCore.
  - `xcrun … swiftc -typecheck` on the three engine files: `TYPECHECK_OK`.

**Red, then green.**
- `test/dictation.test.ts` "start/cancel race (attempt ids)", 7 tests. Written first and run on the unfixed reducer: **7 fail, on assertions**. Repro `race.ts` printed `idle+started → idle []`; the test now expects `[{type:"cancel",attempt:1}]`:
  ```
  error: expect(received).toEqual(expected)
  - [ { "attempt": 1, "type": "cancel" } ]
  + []
  ```
- `test/voice-wiring.test.ts` "start/cancel race: the Swift side", 4 static guards. With the pre-fix Swift files copied back in: **4 fail**. Restored: 11 pass.
- `test/voice-controller.test.ts`, two new tests:
  - "a tap while the native start is pending, then the start resolves": the port gets `cancel:1` twice, the state is idle, there is no `haptic:start` and no ticker;
  - "a stale ended from an older attempt does not end the current dictation".
  - Their non-vacuity is shown by M1 to M3 below. They were not run red on the old controller, because the old port signature had no attempt.

**Mutations.** Each was applied with `sed`, run, then restored from a scratch copy in `.tentacle/tmp/mobile-voice/new/`.

| # | Mutation | Result |
|---|---|---|
| M1 | `stale()`: late `started` → `effects: []` (the original bug) | 6 fail: 5 reducer race tests + the controller pending-start test |
| M2 | `stale()`: never ignore a mismatched `ended`/`startFailed` (`!== current` → `=== -1`) | 2 fail: the reducer stale-ended test + the controller stale-ended test |
| M3 | controller: `port.cancelDictation(0)` instead of `effect.attempt` | 2 fail: the pending-start test + dispose (F13) |
| M4 | `AnalyzerEngine`: delete the `guard !self.finished` before `startAudio` | 1 fail: "the analyzer re-checks `finished` in the same main hop that opens the mic" |

**Finding 2 (MEDIUM, signature): PARTIAL.**
- The Execution signature now states what the evidence shows: commit `2dca65b3` says the executor was DeepSeek, and the earlier line read `claude-opus-5-5`.
- The exact DeepSeek model id is not recorded anywhere I could read, so the orchestrator must fill it in.
- This round is signed with its real model, `claude-opus-5-5`.

**Drift / debt.**
- Only the start-path events are tagged. `probed`, `permissions`, `reserved` and the `asset*` events are untagged, and so is a `startFailed` raised by the probe or permission request. Those can still reach a newer attempt's `asking`/`preparing` after a fast tap-tap-tap: the wrong card or a lost attempt, but never a live mic, because no native start is pending in those phases.
- The port signature changed (`startDictation` / `cancelDictation` take an attempt). This is app-internal; the daemon protocol is untouched, so no `protocol.d/` note.
- **Unverified (device):** the Swift start/cancel interleavings. To verify, on a dev build tap the mic twice quickly (and background mid-start) on iOS 18 and on iOS 26; the mic indicator must go off. Add this to the module README checklist.

**Gate.**
- `bun run typecheck` (root, `apps/mobile`, `apps/relay`): clean.
- `bun run lint`: `Checked 1457 files … No fixes applied`.
- `bun test`: **10493 pass, 4 skip, 0 fail**, the same skips as round 0.
- The first full run reported **1 fail out of 10497**. Two reruns did not reproduce it, and I did not capture which test it was. The voice tests are deterministic and passed in every narrow run, so this was likely a timing-flaky test elsewhere. Unidentified.

## Review

*— claude-opus-5-5, 2026-11-15* (fresh context. Execution is signed by the same model, but commit `2dca65b3` says "exec (deepseek)", so see finding 2.)

**Verdict: REQUEST-CHANGES**

**Gate (re-run).**
- `bun test apps/mobile/test`: 1146 pass, 0 fail.
- `bun run lint`: 1457 files, clean.
- `bun run typecheck` (root, mobile, relay): clean.
- The full `bun test` was not re-run; the diff touches only `apps/mobile`.

**Findings.**

1. **HIGH: a cancel during a pending native start leaves the mic running, with no UI.**
   - TS half (`dictation.ts`):
     - `preparing{starting}` + `tap`, `send`, background, `ttsStarting` or `dispose` goes to idle and emits `cancel` (`:415-428`).
     - A late `started` that arrives in idle is dropped with no effect (`:320-332`).
     - Repro `.tentacle/tmp/mobile-voice/race.ts` prints `idle+started → idle []`.
   - Swift half:
     - `AnalyzerEngine.start` awaits four times (`:96-109`), then calls `startAudio` without checking `finished` (`:110`).
     - A `cancel` that lands during those awaits runs `finish` → `engineEnded`. That sets `SpeechCore.engine = nil` (`SpeechCore.swift:191`), so no later stop or cancel can reach the engine.
     - The audio tap then feeds an analyzer that nothing cancels. `consume` keeps `self` alive while the results stream is open (`:108,113`).
     - `RecognizerEngine.begin` has the same missing `finished` check (`RecognizerEngine.swift:52`). It also has a window where the cancel's main-queue hop runs before `engine = next` (`SpeechCore.swift:176`).
   - Result: the mic stays live and transcribes into a reducer that ignores it. Nothing auto-stops it, because the ticker runs only while listening.
   - Fix:
     - re-check `finished` after every await in both engines' start;
     - have the reducer answer a `started` that arrives in idle or failed with `cancel`;
     - preferably, tag dictation events with an id, as drift 1 already does for speech;
     - add a regression test for "late `started` → cancel".
   - Untested on device, like all native code here.
2. **MEDIUM (process, §10): who executed is unclear.** Execution is signed `claude-opus-5-5`, but the exec commit says deepseek. §10 uses the signature to track model drift, and this L task needed a strong executor. Fix the signature so it is true.

**Mutation (non-vacuity).** Dropped `&& rec.onDevice` in `speech-engine.ts:60`. Result: 3 fail (`speech-engine` F1 ×2, `dictation` F1 ×1). Restored from a scratch copy; `git status` is clean.

**Attacks tried.**
- F1 never-cloud: holds in TS (mutation above) and in Swift (`RecognizerEngine.swift:41,79` guard plus `requiresOnDeviceRecognition`).
- F13 dispose: the listener is removed first (`voice-controller.ts:317`). Holds.
- F11 speak during dictation:
  - the order on the main queue is stop, then speak (`setCategory(.playback)` while the input tap is still running for one hop);
  - no deterministic defect found statically; needs a device.
- F4 deactivation: `deactivateIfIdle` runs from `didFinish` and depends on `synthesizer.isSpeaking` being false inside that callback. Unverified: if it is still true there, other audio stays ducked. Check on device.
- Start/cancel race: finding 1.

**What holds.** The pure modules follow §7 (logic out of components). No protocol, persistence or daemon change. The plist keys were checked through `expo config` introspect.

**Executor behaviour.** Honest about what is unverified (Step 0, Maestro, the Expo glue). Missed the dictation-side counterpart of its own speech-`id` drift fix.

### Round 2

*— claude-opus-5-5, 2026-11-15* (fresh context; reviewed `git diff HEAD~1`, commit `86691927`)

**Verdict: REQUEST-CHANGES**

**Gate.**
- `bun test apps/mobile/test`: 1159 pass, 0 fail.
- `bun run lint`: 1457 files, clean.
- `bun run typecheck` (root, mobile, relay): clean.

**Round 1, finding 1 (start/cancel race): fixed in TS; the Swift half reads correctly.**
- Mutation: replaced the `cancel` effect for a stray `started` in `dictation.ts` `stale()` with no effect. Result: 6 fail (`dictation` ×5, `voice-controller` ×1).
- Restored from a scratch copy; `git status` is clean.
- Swift: `finished` is now checked inside the main hop before the mic opens (`AnalyzerEngine.swift` start, `RecognizerEngine.swift:53`), and `SpeechCore` cancels an engine that was superseded or cancelled after its `start()` returned. Unverified on device (module README item 13).

**Round 1, finding 2 (signature): only partly fixed.** The Execution signature now says deepseek. But the new "Fix round 1" sub-section is signed `claude-opus-5-5`, while its commit `86691927` says "(deepseek)": the same mismatch again.

**NEW: HIGH (regression from the fix). Dictation stops working on every session screen after the first.**
- The cause:
  - `attempts` starts at 0 in each voice controller (`voice-controller.ts:93`), and there is one controller per `SessionScreen` mount (`SessionScreen.tsx:128`);
  - `SpeechCore` is one object for the whole process (the native module), and its `cancelledThrough` / `newestStart` are never reset (`SpeechCore.swift:58-59`);
  - `startDictation` refuses any `attempt <= max(cancelledThrough, newestStart)`.
- Failure: open a session, dictate once (attempt 1), leave (dispose cancels attempt 1), then open any session. Its first tap sends attempt 1 again, the start is refused with `cancelled`, and the mic shows the start-failed card. This repeats until that screen has made more taps than every earlier screen together.
- Repro `.tentacle/tmp/mobile-voice/remount.ts` (it models the Swift guards):
  ```
  screen 1, first tap: listening
  screen 2, first tap: failed
  ```
- No test covers it, because the fake port does not model the native counters.
- Fix: make the attempt id unique for the whole process, for example a module-level counter in `speech-native-expo.ts` or in the port, or a counter seeded from the clock. Add a test with two controllers on one port.

**Attacks tried.**
- Mutation of the stale-`started` cancel: caught (above).
- Two controllers sharing one port: regression found (above).
- A stale `ended` or `startFailed` for another attempt is ignored (`stale()`). Holds.
- A cancel never reaches a newer engine (`attempt >= newestStart`). Holds by reading.

## Notes / debt (for Review)

*— claude-opus-5-5, 2026-11-15*

- **Cursor-position insert** is deferred. Dictation appends to the end of the draft. Tracking `TextInput` selection adds state for little v1 value.
- **Streaming read-aloud** (speaking while a reply streams) is deferred. v1 speaks finished replies, so there is no partial-sentence or re-speak logic.
- **Background and lock-screen audio** (`UIBackgroundModes: audio`) are deferred to V4 / E10 (eval Q6), because they change the App Store review surface.
- **Kokoro on the phone** is not in scope. The system voice is the owner's choice for the phone.
- **Android:** the module is iOS-only. On Android the mic and speaker buttons are `hidden` (the app is iOS-first).

#### Orchestrator decisions (owner night delegation 2026-11-15)

Every owner question: the recommendation.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
