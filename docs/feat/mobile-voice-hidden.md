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

*— claude-opus-5-5 (from this session's record, `~/.claude/projects/**/<session>.jsonl`), 2026-11-16*

**Model note:** the plan's metadata said `Suited: DeepSeek exec, Opus review`; this
session runs Opus, so executor and reviewer share a model family. Blast is
`contained`, but §10 asks for a fresh-context Review for this combination — the
orchestrator may want the review in a fresh context (a sub-agent) so it is not
self-approval.

**Branch/worktree:** ran in `.tentacle/worktrees/mobile-voice-hidden`, branch
`feat/mobile-voice-hidden`. No `git checkout`/`restore`/`stash`/`commit` was issued
(executor constraint). Scratch: `.tentacle/tmp/mobile-voice-hidden/`.
**Note:** the worktree had no `node_modules` (nothing could run: `Cannot find
package 'marked'`), so `bun install` was needed. It writes only gitignored
`node_modules`; `bun.lock` is unchanged.

### Load-bearing check, run FIRST (Implementation's assumption) — PASSED, with one drift

The plan asked: *"confirm that a settings change reaches the session screen
without a remount"*. It does **NOT**. `.tentacle/tmp/mobile-voice-hidden/repro.ts`
on the inherited branch:

```
VOICE_SETTINGS_VERSION      = 1
DEFAULT_VOICE_SETTINGS      = {"readAloud":false,"language":"auto","rate":"normal"}
has dictation/readAloudButton = false false
v1 record reads back         = {"settings":{"readAloud":true,"language":"it-IT","rate":"fast"},"writable":true}
SessionScreen subscribes     = false          <-- the finding
SessionScreen reads at render = 2 site(s)
  :164 settings: () => VOICE_SETTINGS.current();
  :333 dictationLocale(VOICE_SETTINGS.current().language, deviceLocales());
the holder notifies          = true
```

`SessionScreen.tsx` read `VOICE_SETTINGS.current()` at render only, with no
`subscribe`: the holder notifies (`voice-settings-store.ts` `publish`), but nothing
on this screen listened. Since Settings is a *different* screen stacked on top,
a switch flipped there would have reached the composer only on a remount — i.e.
the half of the feature nobody sees fail in a unit test. So the plan's conditional
was taken: **the screen subscribes** (S4). The rest of the assumption holds: the
"nothing shown" paths exist (`voiceComposerView(null)` → `HIDDEN`, `speakButtonOf(null)`
→ `undefined`, auto-read gated in the controller, `mic === "hidden"` renders
nothing in `Composer.tsx:120`), so the gates are pure-function changes, as the plan says.

### As-built, in order (red first, narrow file per slice)

1. **S1 — the store** (`voice-settings-store.ts`). RED first: 4 tests failed
   (round-trip expected `v: 2` with the new fields, the v1 migration, the Beta
   defaults, the holder's loaded shape). Then:
   - `VoiceSettings` gains `dictation` and `readAloudButton`, both `false` in
     `DEFAULT_VOICE_SETTINGS`; `VOICE_SETTINGS_VERSION = 2` plus
     `VOICE_SETTINGS_VERSION_V1 = 1`.
   - `parse` is restructured in three bands: language/rate validated first (they
     belong to every version), then **v1 → migrated** (`readAloud`/`language`/
     `rate` kept, both switches `false`, `writable: true`), then v2 strictly
     (both switches must be booleans). Any other `v` → `unreadable`, untouched,
     `VoiceSettingsPreserved` on write (the rule the plan said to keep).
   - `autoReadOn` was first written here and **moved** to `voice-beta.ts` in S3
     (see drift 1).

2. **S2 — the view gates** (`voice-view.ts`). RED first: 3 tests in the new
   `Beta off` block failed. `voiceComposerView(state, locale, settings)` returns
   `HIDDEN` when `!settings.dictation` *even with a live listening/failed state*;
   `speakButtonOf(…, settings)` returns `undefined` unless `settings.readAloudButton`
   — including the `"speaking"` case, because the stop button is a speaker surface
   too. Existing tests updated to pass the switches ON explicitly (`BETA`), so the
   old behaviour is pinned as "Beta on", not as the default.

3. **S3 — the controller gates + the stops.** New pure module `voice-beta.ts`
   (`dictationOn`, `readAloudButtonOn`, `autoReadOn`, `voiceRows`, `voiceStops`),
   with `voice-beta.test.ts`. RED first: 4 in `voice-controller.test.ts`, plus a
   `SyntaxError: Export named 'voiceRows' not found` step kept as the first red for
   the Settings predicate. Then:
   - `turnEnded`'s `AutoReadGates.enabled` and `permissionAsked`'s guard both read
     `autoReadOn(settings)` — auto read-aloud and the spoken permission ask now need
     **both** switches.
   - `VoiceController.settingsChanged(previous, next)` → `voiceStops` decides. Dictation
     going off sends the reducer a new `stopRequested` event (`dictation.ts`): it
     settles like a second tap (text kept, **never sent**), in `asking`/`preparing`/
     `listening`/`finalizing`. Read aloud going off sends the read reducer a new
     `settingsOff` event, which stops speech like `dispose` does.

4. **S4 — the session screen** (`SessionScreen.tsx`): the subscribe from the
   load-bearing check, `voiceComposerView`/`speakButtonOf` fed the live copy,
   `settingsChanged` called from an effect that diffs against a `useRef` of the
   previous value, and `extraData` memoised on `(readAloud, readAloudButton)` —
   a fresh array each render would re-render every row.

5. **S5 — Settings → Beta** (`SettingsScreen.tsx`): the `Voice` section becomes
   `Beta` with `beta-dictation` / `beta-read-aloud` (both `value={voice.…}`, so a
   fresh install shows them off) and the footnote "Experimental features. They may
   not work well yet."; `Read replies aloud` + Language + Speaking rate are gated by
   `voiceRows` (autoRead/rate on Read aloud; Language on either). The privacy
   footnote and the `voice-error` banner stay outside every gate.

6. **Tests for the two `.tsx` screens.** There is no RN renderer in this repo
   (`react-native`'s sources are Flow; `settings-beta.test.ts` / `voice-wiring.test.ts`
   follow `push-wiring-guards.test.ts`): the *decisions* are pure and tested in
   `voice-beta.test.ts`, and the screens are pinned as source text — which
   `testID`es exist, and that each is gated on the right value.

7. **Changelog:** `changelog.d/mobile-voice-hidden.changed.md` (one bullet).
   `CHANGELOG.md` untouched. No protocol/schema change → `protocol.json` not
   regenerated, no `protocol.d/` note. `TODO.md` not touched (the plan's TODO entry
   is left to the orchestrator, per the executor constraint).

### Drift from the Implementation (and why)

1. **`voice-beta.ts` is a new module, not "in `voice-view.ts`"** (the plan allowed
   either). Four predicates — two of them (`voiceRows`, `voiceStops`) consumed by a
   `.tsx` and the controller rather than by the view — do not belong in the view
   model; AGENTS §7 wants branching in one testable place.
2. **The session screen subscribes** (`useState` + `VOICE_SETTINGS.subscribe`).
   This is the plan's own conditional, taken because the check failed. Also
   `VoiceController.settingsChanged` is new API: with the screens gated, a switch
   going off would otherwise leave a *hidden* mic listening. The plan asked for
   exactly that behaviour ("stop the dictation … no stuck listening state") but did
   not name the seam; a controller method is it.
3. **Two new reducer events** (`dictation.ts` `stopRequested`, `read-aloud.ts`
   `settingsOff`) rather than reusing `dispose`. `dispose` is F13's terminal event
   and also flips the controller's `disposed` flag elsewhere; a settings change is
   not "this screen is going away". Mutation M8 shows the difference is real.
4. **`autoReadOn` requires BOTH switches**, per the Design's
   `settings.readAloudButton && settings.readAloud`. The plain "Dictation" switch is
   deliberately NOT required for the spoken *permission ask* (that is read-aloud,
   not dictation).
5. **v1 language/rate validated before the version branch.** The plan said a v1
   record's fields are kept; a v1 record with `language: "fr-FR"` is still refused
   (not migrated), because the choice it holds cannot be honoured. Pinned.

### Mutation checks (AGENTS §9, each reverted; tree verified clean afterwards)

| # | Target | Mutation | Result |
|---|---|---|---|
| M1 | `DEFAULT_VOICE_SETTINGS.dictation` | `false` → `true` | 5 RED (Beta defaults ×2 files, `voiceRows` all-off, v1 migration) |
| M2 | `voiceComposerView`'s gate | `!settings.dictation` → dropped | 2 RED ("mic hidden with a live state", "switches independent") |
| M3 | `speakButtonOf`'s gate | `!settings.readAloudButton` → dropped | 2 RED ("speaker never offered / speaking row shows nothing", "independent") |
| M4 | `autoReadOn` | `readAloudButton && readAloud` → `readAloud` | 2 RED (pure predicate + the controller's Beta-off case) |
| M5 | `settingsChanged`'s dictation stop | the `if (stops.dictation) {…}` block deleted | 1 RED ("Dictation off while listening ends it") |
| M6 | `settingsChanged`'s read-aloud stop | the `if (stops.readAloud) {…}` block deleted | 1 RED ("Read aloud off while speaking stops it") |
| M7 | `SessionScreen` | the `VOICE_SETTINGS.subscribe` line deleted | 1 RED ("it SUBSCRIBES …") |
| M8 | `SessionScreen` | the `settingsChanged` call deleted | 1 RED ("a switch going OFF is passed to the controller") |
| M9 | `SettingsScreen` | the three `rows.*` gates → `(true)` | 2 RED (both gate tests) |
| M10 | `SettingsScreen` | the Read-aloud switch writes `dictation` | 1 RED ("each switch writes ITS own field") |
| M11 | `read-aloud.ts` | the `case "settingsOff"` dropped | 1 RED (the new reducer test) |
| M12 | `voice-controller` | `stopRequested` → `dispose` | 1 RED ("Dictation off while listening") — the events are not interchangeable |

### Gate (final tree)

- `bunx tsc --noEmit` → clean; `bunx tsc -p apps/mobile` → clean; `bunx tsc -p apps/relay` → clean.
- `bun run lint` (biome) → `Checked 1661 files … No fixes applied` (0 errors, 0
  warnings: the AGENTS §6 clean baseline). Two `biome check --write` rounds were
  needed for formatting only.
- `bun test` → **12010 pass, 5 skip, 0 fail** (859 files, ~448 s). The 5 skips are
  the documented opt-in gates (2 k8s, 2 docker, 1 slow keepalive).
- One earlier full run showed **1 fail** in
  `packages/exec/test/confinement.test.ts` "F2: a hard link…" (`confineWrite` threw
  `refusing to write outside the workspace`). It is NOT from this task (the diff is
  `apps/mobile`-only) and not reproducible: 5/5 green alone, and 0 fails in the
  final full run. Recorded here rather than hidden — it looks like a load-sensitive
  TOCTOU in that test, worth its own look.

### Not verified / for Review

- **No run on a device or simulator.** The visual result (the Beta card's look, the
  mic/speaker actually absent) rests on the pure view-model plus source-text
  guards; nothing here renders React Native. The owner should confirm on the next
  build.
- The Settings source-text guards pin *structure* (a `testID` exists, a row is
  inside a gate). They cannot prove the gate's truth table — that lives in
  `voice-beta.test.ts` (`voiceRows`), which is the reason the predicate was extracted.
- **The auto-read "Read replies aloud" row is hidden when Read aloud is off**; a
  person who had it ON before this build now sees the switch gone (it is still ON in
  the store, and reappears when Read aloud is turned on). That is the plan's
  "show only when a switch that uses them is on", applied literally; flagging it in
  case the owner prefers the row visible-but-disabled.

## Review
