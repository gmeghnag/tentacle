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

*(empty: not started; Implementation awaits owner approval)*

## Review

*(empty)*

## Notes / debt (for Review)

*— claude-opus-5-5, 2026-11-15*

- **Cursor-position insert** is deferred. Dictation appends to the end of the draft. Tracking `TextInput` selection adds state for little v1 value.
- **Streaming read-aloud** (speaking while a reply streams) is deferred. v1 speaks finished replies, so there is no partial-sentence or re-speak logic.
- **Background and lock-screen audio** (`UIBackgroundModes: audio`) are deferred to V4 / E10 (eval Q6), because they change the App Store review surface.
- **Kokoro on the phone** is not in scope. The system voice is the owner's choice for the phone.
- **Android:** the module is iOS-only. On Android the mic and speaker buttons are `hidden` (the app is iOS-first).
