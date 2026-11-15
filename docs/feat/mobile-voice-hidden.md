# feat/mobile-voice-hidden — iPhone voice features move to Settings → Beta, off by default

`Type: feat · Size: S–M · Blast: contained · Suited: DeepSeek exec, Opus review`

## Context

*— claude-opus-5-5, 2026-11-16*

**Owner, 2026-11-16, after using the latest iPhone build:** dictation (the mic button, `feat/mobile-voice`) is not usable yet:
1. when the finger is on the button there is no visible sign that recording started;
2. the transcript has nothing to do with what was said: one or two words, without meaning.

**Decision (owner, two messages):** "preferisco [tenere] questa funzione vocale ma spenta, nascosta in app fino a che non è matura", then: "semmai tra le impostazioni mettili sotto una roba tipo \"BETA\" e disabilitati di default". So the code stays; the voice features become **opt-in Beta switches in Settings, OFF by default**, and with them off nothing voice-related shows anywhere. The two defects go to a separate fix task (`fix/mobile-dictation-quality`, TODO) and are NOT fixed here.

**Scope (orchestrator's reading, morning report says so):** "mettili" = the voice features, one switch each: **Dictation** (the composer mic button) and **Read aloud** (the speaker button under assistant rows + the existing auto read-aloud). Read-aloud got no complaint, but it ships in the same Beta, off, so the owner turns on only what works for them.

## Implementation

*— claude-opus-5-5, 2026-11-16*

### Load-bearing assumption

The pure views already have a "nothing shown" path: `voiceComposerView(null, …)` returns `HIDDEN` (mic `"hidden"`, `apps/mobile/src/voice-view.ts:30-44`) and `speakButtonOf(null, …)` returns `undefined` (`voice-view.ts:60-67`); auto read-aloud is gated on `deps.settings().readAloud` (`apps/mobile/src/voice-controller.ts:318,332`); the voice settings are read live through `VOICE_SETTINGS.current()` (`apps/mobile/src/screens/SessionScreen.tsx:164`). So gating each surface on a setting is a pure-function change plus one stored field per switch. **Executor: confirm that a settings change reaches the session screen without a remount** (the Settings write → `VOICE_SETTINGS` → `SessionScreen` re-render); if the screen only reads at mount, subscribe to the store there (the store already notifies, check `voice-settings-store.ts`), and say so in Execution.

### Preconditions

- No protocol, daemon, persistence-on-host or relay change; no Swift change (the module stays linked).
- The voice settings record is a versioned local record (`VOICE_SETTINGS_KEY`/`VOICE_SETTINGS_VERSION = 1`, `apps/mobile/src/voice-settings-store.ts:18-31`): an unknown version is left untouched and never written over (`:53`, `VoiceSettingsPreserved`). Keep that rule.

### Design

- **Store** (`voice-settings-store.ts`): `VoiceSettings` gains `dictation: boolean` and `readAloudButton: boolean`, both `false` in `DEFAULT_VOICE_SETTINGS`. `VOICE_SETTINGS_VERSION` becomes `2`. A **v1 record is migrated on read** (its `readAloud`/`language`/`rate` kept, both new switches `false`, `writable: true`); any other unknown version stays unreadable/preserved as today.
- **Gating, pure** (in `voice-view.ts`, or a new `voice-beta.ts` if cleaner): the composer mic is `"hidden"` unless `settings.dictation`; `speakButtonOf` returns `undefined` unless `settings.readAloudButton`; auto read-aloud runs only when `settings.readAloudButton && settings.readAloud` (the controller's `enabled:`/guard at `voice-controller.ts:318,332`). With both switches off, nothing voice-related renders, and the mic permission is never requested (it is asked only on a dictation start).
- **Settings** (`screens/SettingsScreen.tsx:254-296`): the "Voice" section becomes a **"Beta"** section: header "Beta", a grouped card with two switches, "Dictation" (`testID="beta-dictation"`) and "Read aloud" (`testID="beta-read-aloud"`), both off by default, and a footnote "Experimental features. They may not work well yet." The existing rows move under it and show only when a switch that uses them is on: Language when either is on; "Read replies aloud" (auto) and Speaking rate only when Read aloud is on. The privacy footnote stays. Same look as the other sections (owner taste: minimal), no new components.
- Nothing is deleted.

### Files

- `apps/mobile/src/voice-settings-store.ts` (+ its test): fields, v2, v1 migration.
- `apps/mobile/src/voice-view.ts` (+ test) and `voice-controller.ts` (auto-read guard) — the gates.
- `apps/mobile/src/screens/SessionScreen.tsx` — pass the settings into the views (and subscribe if needed, see above).
- `apps/mobile/src/screens/SettingsScreen.tsx` — the Beta section.
- `TODO.md` — add `fix/mobile-dictation-quality` (below).
- `changelog.d/mobile-voice-hidden.changed.md`: "- **Voice moves to Beta in the iPhone app.** Dictation and read-aloud are off by default; turn them on in Settings → Beta."

### Failure modes

- A surface left visible with both switches off → tests below assert each one off.
- An older install with a v1 record → migrated, both switches off (the owner's phone today); never "unreadable", never overwritten wrongly.
- A newer build's v3 record on this phone → still preserved untouched (existing rule, keep its test).
- Turning Dictation off while listening → stop the dictation (the controller's existing stop/cancel path), no stuck "listening" state.
- Turning Read aloud off while speaking → stop speaking.

### Tests (red first)

- Store: default has both switches `false`; a v1 record migrates (fields kept, switches false, writable); v2 round-trips; an unknown version stays preserved.
- Views: mic `"hidden"` with `dictation:false` even with a live state; shown with `dictation:true`; `speakButtonOf` `undefined` with `readAloudButton:false`; auto-read does not start with `readAloud:true` but `readAloudButton:false`.
- Controller: switching dictation off while listening ends it; read-aloud off while speaking stops it.
- Settings (if the mobile test harness renders SettingsScreen, as other Settings tests do): Beta section present with two off switches; Language/rate rows hidden while off.
- Red before green for each.

### TODO entry to add (the defects, for later)

`fix/mobile-dictation-quality` (owner 2026-11-16, live on the iPhone build): (1) no visible feedback while the finger is on the mic, so the user cannot tell whether recording started; (2) transcripts are 1–2 nonsense words, unrelated to the speech. First hypothesis to test for (2): the `auto` dictation locale follows the iPhone's language (`speech-locale.ts` `dictationLocale`, `SessionScreen.tsx:97` device locales), so an English-language iPhone recognises Italian speech with `en-US`; other candidates: press-and-hold ending the request too early, the audio format fed to `SFSpeechAudioBufferRecognitionRequest`. Needs a dev build on the owner's phone (same session as the voice-conversation P1 spike). Leaves Beta only after it passes. `Type: fix · Size: M · Blast: contained · Suited: Opus (needs device runs)`.

## Execution

## Review
