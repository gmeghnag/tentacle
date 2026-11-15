# tentacle-speech

On-device dictation and read-aloud for the tentacle iPhone app
(`docs/feat/mobile-voice.md`). A local Expo module, autolinked from
`apps/mobile/modules/`. It only reports facts and runs commands. Every decision is
made in TS (`src/speech-engine.ts`, `src/dictation.ts`, `src/read-aloud.ts`).

| File | What it owns |
|---|---|
| `ios/SpeechCore.swift` | Permissions, capabilities, `AVSpeechSynthesizer`, the one `AVAudioSession` owner, interruption and route observers, haptics |
| `ios/RecognizerEngine.swift` | iOS 18: `SFSpeechRecognizer`, **on device only** (`not-on-device` refusal, `requiresOnDeviceRecognition = true`), 50 s segment rollover |
| `ios/AnalyzerEngine.swift` | iOS 26: `SpeechAnalyzer` with `SpeechTranscriber` / `DictationTranscriber`, `AssetInventory` reserve and install |
| `ios/TentacleSpeechModule.swift` | The Expo glue (`Name("TentacleSpeech")`) |
| `app.plugin.js` | `NSSpeechRecognitionUsageDescription`. The mic key is written by expo-camera and expo-image-picker (P4) |

The three engine files have no ExpoModulesCore import, so they typecheck on their own:

```
xcrun -sdk iphoneos swiftc -typecheck -swift-version 5 -target arm64-apple-ios18.0 \
  ios/SpeechCore.swift ios/RecognizerEngine.swift ios/AnalyzerEngine.swift
```

## Real-device checklist

Paste the results into the task doc's Execution section, with the device, the OS and the date.
Use the owner's iPhone (iOS 18.3.1), plus an iOS 26 device if one is available.

1. **Step 0 facts**, for `it-IT` and `en-US`:
   - (a) iOS 18: `capabilities().recognizer[locale].onDevice`;
   - (b) iOS 26 simulator: `analyzer.transcriber` and the asset status;
   - (c) whether an on-device request still stops after about 1 min (the rollover handles it either way).
2. Airplane mode on: dictate in Italian and in English. Text appears, which proves it runs on device.
3. First run: the mic prompt, then the speech prompt, with the app.json strings. Deny: a card appears, then Settings. Grant: it works without a relaunch.
4. Music playing: dictate. The music ducks, then comes back after stop. Same for read-aloud.
5. Silent switch on: read-aloud is still audible.
6. AirPods: dictate through the AirPods mic. Remove one AirPod mid-dictation: it stops with the notice and the text is kept. Read-aloud stops when an AirPod is removed.
7. Incoming call mid-dictation: it stops and the text is kept. Mid-speech: it stops.
8. Lock the phone or switch apps mid-dictation: it stops, and the draft is still there after unlock.
9. 3-minute continuous dictation on iOS 18: no gap and no duplicate at the segment boundaries.
10. Read a reply with a code block and a table. You hear "code block, N lines" and no symbols. Note which voice `pickVoice` chose.
11. Haptics on start, stop and error.
12. VoiceOver: the mic and speaker buttons announce their labels.
