# feat/mobile-voice-hidden — Hide the iPhone app's voice features until they are mature

`Type: feat · Size: S · Blast: contained · Suited: DeepSeek exec, Opus review`

## Context

*— claude-opus-5-5, 2026-11-16*

**Owner, 2026-11-16, after using the latest iPhone build:** dictation (the mic button, `feat/mobile-voice`) is not usable yet:
1. when the finger is on the button there is no visible sign that recording started;
2. the transcript has nothing to do with what was said: one or two words, without meaning.

**Decision (owner):** "preferisco [tenere] questa funzione vocale ma spenta, nascosta in app fino a che non è matura". The code stays in the app. Every voice surface is switched off and hidden behind ONE build-time switch, off by default. The two defects are recorded as a separate fix task (`fix/mobile-dictation-quality`, TODO) and are NOT fixed here.

**Scope (orchestrator's reading, morning report says so):** hide ALL of the app's voice: the composer mic button, the read-aloud speaker button under assistant rows, auto read-aloud, and the Settings "Voice" card. Read-aloud got no complaint, but "questa funzione vocale" is the voice feature as a whole, and the Settings card mostly configures dictation. If the owner wants read-aloud back, it is a one-line change of the switch's scope.

## Implementation

*— claude-opus-5-5, 2026-11-16*

### Load-bearing assumption

The app already hides every voice surface when the native speech module is missing: `SPEECH_PORT` is `null` (`apps/mobile/src/speech-native-expo.ts:8,80`), `SessionScreen` then never creates the voice controller (`apps/mobile/src/screens/SessionScreen.tsx:153-157`), so `voiceState` stays `null`, and `voiceComposerView(null, …)` returns `HIDDEN` (mic `"hidden"`, `apps/mobile/src/voice-view.ts:30-44`) and `speakButtonOf(null, …)` returns `undefined` (`voice-view.ts:60-67`). Settings shows the Voice card only when both `voice` and `onVoice` are passed (`apps/mobile/src/screens/SettingsScreen.tsx:66-70,254`). **Executor: confirm this chain first** (the voice-view tests already cover the `null` state); if any surface stays visible with the port off, STOP and write it in Execution.

### Preconditions

- No protocol, daemon, persistence or relay change. No native (Swift) change: the module stays linked, so re-enabling needs no new native build beyond the JS switch.
- Mobile tests run under `bun test` (apps/mobile tests next to `voice-view.test.ts`, `voice-wiring.test.ts`).

### Design

- New pure module `apps/mobile/src/voice-feature.ts`: `export const VOICE_ENABLED = false;` plus a small pure helper `voicePort<P>(enabled: boolean, port: P | null): P | null` (returns `null` when disabled). One comment line: why it is off (this doc) and that flipping it re-enables everything.
- `SessionScreen.tsx`: use `voicePort(VOICE_ENABLED, SPEECH_PORT)` where it reads `SPEECH_PORT` (`:154`). Result: no controller, no mic-permission prompt, no `AVAudioSession` activity, mic + speaker buttons hidden, no auto read-aloud.
- Settings: wherever the parent passes `voice` / `onVoice` to `SettingsScreen` (find it with `rg -n "onVoice" apps/mobile/src`), pass them only when `VOICE_ENABLED` (absent ⇒ no Voice card, the existing rule at `SettingsScreen.tsx:254`). If the voice settings store is loaded at app start only for that card, skip loading it when disabled; otherwise leave it.
- Nothing is deleted. The stored voice settings (`tentacle.voice`) stay untouched on disk.

### Files

- `apps/mobile/src/voice-feature.ts` (new) + `apps/mobile/src/voice-feature.test.ts` (new)
- `apps/mobile/src/screens/SessionScreen.tsx` (one read site)
- the Settings parent that passes `voice`/`onVoice` (one site)
- `TODO.md`: add `fix/mobile-dictation-quality` (below), and mark this task.
- No changelog fragment beyond `changelog.d/mobile-voice-hidden.changed.md`: "- **Voice is hidden in the iPhone app for now.** Dictation and read-aloud are switched off until they work reliably."

### Failure modes

- A surface left visible (e.g. a speaker button rendered from another path) → the test below asserts each surface off.
- The switch accidentally on in a build → the pinned test fails (`VOICE_ENABLED === false`), so turning it on is a deliberate one-line change plus a test change.
- Re-enabling must still work → a test that `voicePort(true, port)` returns the port.

### Tests (red first)

- `voice-feature.test.ts`: `VOICE_ENABLED` is `false`; `voicePort(false, port)` is `null`; `voicePort(true, port)` is the port; and, through the existing pure views, with the port gated off the composer view's mic is `"hidden"` and `speakButtonOf` gives `undefined` for an assistant row.
- If `voice-wiring.test.ts` asserts the voice wiring is present in `SessionScreen`, update it to assert it goes through `voicePort(VOICE_ENABLED, SPEECH_PORT)`.
- Red before green: write the test before `voice-feature.ts` exists (import fails = red), then add the module.

### TODO entry to add (the defects, for later)

`fix/mobile-dictation-quality` (owner 2026-11-16, live on the iPhone build): (1) no visible feedback while the finger is on the mic, so the user cannot tell whether recording started; (2) transcripts are 1–2 nonsense words, unrelated to the speech. First hypothesis to test for (2): the `auto` dictation locale follows the iPhone's language (`speech-locale.ts` `dictationLocale`, `SessionScreen.tsx:97` device locales), so an English-language iPhone recognises Italian speech with `en-US`; other candidates: press-and-hold ending the request too early, the audio format fed to `SFSpeechAudioBufferRecognitionRequest`. Needs a dev build on the owner's phone (same session as the voice-conversation P1 spike). Re-enable via `VOICE_ENABLED` only after it passes. `Type: fix · Size: M · Blast: contained · Suited: Opus (needs device runs)`.

## Execution

## Review
