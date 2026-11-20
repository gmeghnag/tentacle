# fix/mobile-mic-send — dictation: "I stop and send, nothing happens"; a light haptic on every mic tap

> **Status:** execution done · review pending
> **Branch:** `fix/mobile-mic-send`
> **Size:** S · **Blast:** contained · **Suited:** Opus (triage + plan + exec); standard Review, plus the owner's phone for the two device-only facts (below)
> **Changelog:** `changelog.d/mobile-mic-send.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-20*

Owner request 2026-11-20 (iPhone app, dictation is a Settings → Beta switch):

1. Tapping the microphone must give a **light haptic**, and the same when tapping
   again to stop.
2. **Bug:** "when I stop and send, nothing happens — as if the transcribed message
   is never sent".

**Symptom, characterised (AGENTS §1).** *Trigger:* the person stops dictation (a mic
tap, or Send, which stops first) and then Send. *Magnitude:* the whole transcript —
the field is emptied, so Send has nothing to send (`compose-controller.ts:996` returns
on a blank field: silently). *Collateral:* a "Dictation couldn't start — tap the mic to
retry" card, and the pending Send is dropped.

**Where it comes from (static → then proven by execution).**
- The pure path — tap → listening → tap → `finalizing` → `ended{stopped}` → Send — was
  driven end to end FIRST with the real reducer, voice controller and session screen
  (fake port): it sends. So the bug is not on the happy path.
- A sweep of every ending the native module can report while `finalizing` (repro
  below) found the defect: `dictation.ts` `active()` handled `ended{error}` the same in
  `finalizing` as in `listening` — `failed(START_FAILED, setDraft(finalsOnly(state)))`
  (`dictation.ts:593` on main). `finalsOnly` drops the volatile text, and the
  `after: "send"` of a Send already pressed is discarded. `ended{cancelled}` in
  `finalizing` likewise went to idle and dropped the Send.
- Why the owner's phone hits it: on iOS 26 the engine is `AnalyzerEngine`
  (`speech-engine.ts:46` prefers the transcriber), whose `consume` maps ANY throw of
  the results sequence to `finish(reason: "error")` (`AnalyzerEngine.swift:135-136`) —
  including one during `stop()`'s `finalizeAndFinishThroughEndOfInput`. The
  `SpeechTranscriber` `.progressiveTranscription` preset keeps a short utterance
  **volatile** until finalization, so at the stop all the words are volatile and
  `finalsOnly` = the base (usually `""`). The iOS 18 recognizer already treats an error
  while stopping as a stop (`RecognizerEngine.swift:125-140`: flush + `stopped`); the
  analyzer has no such guard, and the reducer trusted it.
- **Unverified on device (one line):** that the owner's analyzer actually ends with
  `error` at the stop. The fix makes the outcome right for *every* ending of a stop the
  person asked for; confirm on the phone with the steps in Review.

**Haptics (1).** The reducer played `haptic start` only on the native `started`
(`dictation.ts:492` on main) — *after* the `playAndRecord` session is active — and
`haptic stop` at `settle` after the engine ended. iOS mutes haptics while a session
records unless `setAllowHapticsAndSystemSoundsDuringRecording(true)`
(`SpeechCore.swift:181-185` never set it), and "stop" was `.soft`
(`SpeechCore.swift:321`). A programmatic stop (silence, cap, Send, interruption) also
buzzed through `settle`.

**Overlap with `fix/mobile-dictation-quality`** (TODO.md:83): its "no visible feedback
while holding the mic" is partly this haptic (now played at the tap); its nonsense
transcripts (locale) are NOT the cause here — the repro has a correct transcript and
still loses it — so the locale is left to that task.

**Repro** (2026-11-20, on `main` = `5014e6b7`, `.tentacle/tmp/mobile-mic-send/sweep.ts`):

```ts
import { dictationReduce, type DictationState, type DictationEvent } from "../../../apps/mobile/src/dictation.ts";
const L: DictationState = { kind: "listening", attempt: 1, base: "", finals: "", volatile: "hello world", startedAt: 0, lastTextAt: 0 };
function run(name: string, evs: DictationEvent[]) {
  let s: DictationState = L; const eff: string[] = [];
  for (const e of evs) { const st = dictationReduce(s, e); s = st.state; eff.push(...st.effects.map((x) => x.type + ("text" in x ? `(${JSON.stringify(x.text)})` : "kind" in x ? `(${x.kind})` : ""))); }
  console.log(name.padEnd(48), s.kind.padEnd(8), eff.join(" "));
}
const send: DictationEvent = { type: "send", via: "press", now: 1 };
const tap: DictationEvent = { type: "tap", draft: "", locale: "en-US", now: 1, attempt: 2 };
run("send, ended stopped", [send, { type: "ended", reason: "stopped", attempt: 1 }]);
// … one line per ending (see output)
```

```
send, ended stopped                              idle     stop setDraft("hello world") haptic(stop) send
tap stop, send, ended stopped                    idle     stop setDraft("hello world") haptic(stop) send
tap stop, send, ended error                      failed   stop setDraft("") haptic(error)
tap stop, send, ended cancelled                  idle     stop
tap stop, send, ended interrupted                idle     stop setDraft("hello world") haptic(stop)
tap stop, send, appState inactive                idle     stop stop setDraft("hello world") haptic(stop)
tap stop, send, startFailed                      finalizing stop
tap stop, ended error (all volatile)             failed   stop setDraft("") haptic(error)
tap stop, send, userEdit(stale echo)             idle     stop cancel
tap stop, send, tick 1500                        idle     stop cancel setDraft("hello world") haptic(stop) send
```

`ended error` → `setDraft("")` + no `send`; `ended cancelled` → no `send`. Interrupted /
route / background not sending is the approved design (`mobile-voice.md` F4 and
round-1 note 476: "an interruption … never sends, even mid-`finalizing{send}`") and is
kept. `startFailed` in `finalizing` is ignored and the 1.5 s timeout settles it (fine).

## Implementation

*— claude-opus-5-5, 2026-11-20* — **approved** (the owner asked for the fix; no product decision needed)

### Load-bearing assumption

The draft the person sees is `draftOf(state)` while `listening`/`finalizing`, written
through the ONE `setDraft` effect (`dictation.ts` `active()` `case "dictation"`), and
`settle` writes exactly that and then emits `send` (`dictation.ts` `settle`). So settling
a `finalizing` state on `error`/`cancelled` sends what was on screen through the same
`composerAction` path as any Send (`voice-controller.ts` `case "send"` →
`SessionScreen.tsx:292` → `controller.press()`). Proven by the integration test below.

### Preconditions

- Logic lives in pure modules (AGENTS §7): `dictation.ts` decides; `voice-controller.ts`
  performs effects on the port (`case "haptic": port.haptic(effect.kind)`); the screen
  only wires.
- Every native ending carries the attempt (`TentacleSpeechModule.swift` `coreEnded`), and
  `stale()` drops another attempt's, so the new branch sees only the current attempt.
- A Send press already plays `pressHaptic` (`SessionScreen.tsx:1679`), so dictation adds no
  haptic for a Send-initiated stop.

### Design

`dictation.ts` only (plus two Swift lines):
- `active()`, `case "ended"`: in `finalizing`, `error` and `cancelled` → `settle(finalizing,
  after, via, notice)` (keep everything shown, honour the pending Send, no card).
  `listening` behaviour unchanged; interrupted/route unchanged (F4).
- Haptics move to the TAP: `tap` from idle/failed emits `haptic start` FIRST (before the
  probe, so before the mic opens); `tap` in asking/preparing/listening emits `haptic
  stop` (`TAP_STOP`); `tap` in `finalizing` is a no-op (no haptic). `started` and
  `settle` emit no haptic, so programmatic stops are silent; `haptic error` unchanged.
- `SpeechCore.swift`: `setAllowHapticsAndSystemSoundsDuringRecording(true)` before
  `setActive(true)` (the stop tap's haptic plays with the mic live); `"stop"` → `.light`.

### Files

`apps/mobile/src/dictation.ts`, `apps/mobile/modules/tentacle-speech/ios/SpeechCore.swift`;
tests `apps/mobile/test/{dictation,voice-controller,session-screen-compose,voice-wiring}.test.ts`;
`changelog.d/mobile-mic-send.fixed.md`. No visual change (Composer untouched).

### Failure modes

- Engine `error` after a stop → text kept, Send honoured (the fix). `error` while still
  `listening` (the person did not ask to stop) → card + finals only, as designed.
- `cancelled` in `finalizing` → settle (only a native abort produces it there; our own
  cancels leave `finalizing` first).
- No `ended` at all → the existing 1.5 s `tick` settles (unchanged, tested).
- Interruption / route / background while finalizing a Send → text kept, NOT sent (F4,
  unchanged; the words stay in the field, never lost).
- Tap start then permission denied / start failure → the tap haptic, then the error
  haptic (two distinct events, both real).
- Double tap while finalizing → nothing (no second haptic).

### Tests

Red on main, then green: `dictation.test.ts` "stop and send" (3 new: error/cancelled while
finalizing) and "mic haptics" (6); `session-screen-compose.test.ts` "dictation → the
composer's Send" (real reducer + voice controller + screen); `voice-wiring.test.ts` "mic
haptics: the Swift side" (static pin). Existing tests that encoded the old haptic timing
updated (listed in Execution).

## Execution

*— claude-opus-5-5, 2026-11-20*

1. Repro: integration of real voice controller + session screen on the happy path →
   sends (not the bug). Reducer sweep (Context) → found `error`/`cancelled` in
   `finalizing`.
2. Tests written first. **Red on main** (`bun test test/dictation.test.ts`): `40 pass, 11
   fail`; the bug assertions:
   ```
   -   "x send this",
   +   "x send",
   (fail) stop and send > tap stop, then an engine ERROR while finalizing keeps everything shown (no card)
   (fail) stop and send > Send pressed, then an engine ERROR or CANCELLED while finalizing: it still sends what was shown
   (fail) stop and send > tap stop, Send while finalizing, then an ERROR: the Send is not dropped
   ```
   `session-screen-compose.test.ts -t fix/mobile-mic-send`: `1 pass, 2 fail` —
   `Expected: "hello world" / Received: ""` (the field emptied) and `sent` `[]` instead of
   `["hello world"]` — the owner's symptom. `voice-wiring.test.ts` Swift pin with the
   Swift change stashed: `14 pass, 2 fail`.
3. Fix in `dictation.ts` (tap-time haptics, `TAP_STOP`, `withFirst`, the `finalizing`
   branch in `active()` `case "ended"`) and `SpeechCore.swift` (2 lines). Green:
   `dictation + voice-controller + session-screen-compose` `104 pass, 0 fail`;
   `voice-wiring` `16 pass`.
4. Existing tests updated for the new haptic timing (intended behaviour change, not
   weakened): `dictation.test.ts` start-path effects (haptic first), "tap while
   listening" (haptic at the tap, none at settle), Return/Send while listening (no
   dictation haptic: `pressHaptic` plays), undetermined/permissions, transcriber
   `slice(2)`, retry tap `["haptic","probe"]`, attempt-ids cancel tap;
   `voice-controller.test.ts` call order and the pending-start race (exactly
   `haptic:start, haptic:stop`).
5. **Mutation checks** (each reverted after):
   - M1 drop the `finalizing` error/cancelled settle → `6 fail` (both integration tests,
     the 3 reducer bug tests, the stop-haptic-per-ending test).
   - M2 drop the stop-tap haptic → `2 fail`.
   - M3 put `haptic start` back on `started` (double haptic) → `3 fail`.
6. Gate: see below.

**Drift:** `docs/feat/mobile-voice.md:164` still says "(soft) on stop" and the haptics fire
on listen start/stop; this fix supersedes that line by the owner's 2026-11-20 rule (light,
at the tap). The legacy doc was not edited. No e2e change: flow 34 (`34-hub-dictate.yaml`)
only reaches the voice card on the simulator (the real mic crashes it), and a haptic is not
observable by Maestro. TODO.md not edited (shared file; the launcher indexes the task).

**Gate** (`bun run check`, 2026-11-20): typecheck green; lint `Checked 2131 files … No
fixes applied` (0 errors, 0 warnings, after `biome check --write` on the 5 touched TS
files); test `15770 pass · 5 skip · 0 fail` (`Ran 15775 tests across 1118 files`). The 5
skips are the pre-existing opt-in `skipIf`s (live k8s / docker / slow / platform); this
diff adds no skip (`git diff | grep -c skip` = 0).

## Review

*— pending*

Owner's phone (device-only, cannot be proven in Bun):
1. Settings → Beta → Dictation on; tap the mic → a light tap is felt at once; speak a
   short sentence; tap the mic → a light tap is felt; the words stay; Send → it is sent.
2. Same, but press Send instead of the second mic tap → sent.
3. If (1) still loses the words, the cause is elsewhere (not an engine `error` at the
   stop): report whether the "Dictation couldn't start" card appeared.
