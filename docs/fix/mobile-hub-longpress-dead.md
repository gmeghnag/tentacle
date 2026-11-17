# fix/mobile-hub-longpress-dead — iPhone floating button: long-press does nothing, no haptics, no icon

> **Status:** context · implementation (executor: repro FIRST on the simulator, then plan, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/mobile-hub-longpress-dead`
> **Size:** S–M · **Blast:** contained (apps/mobile hub) · **Suited:** Opus exec + fresh Opus review
> **Changelog:** `changelog.d/mobile-hub-longpress-dead.fixed.md`

## Context

Owner 2026-11-17 09:06, on the iOS build of main 32dcf4fb (mobile-hub H1–H4b all merged, docs/feat/mobile-hub.md):
- **Tap** on the floating button → the Activity sheet opens (OK) — but it only shows `SCHEDULED · Scheduled · soon` (screenshot `.tentacle/tmp/mobile-hub-longpress-dead/owner-activity.png`), the S10-era placeholder, although cron-tool + H4a (Scheduled entry) are merged.
- **Long-press** → NOTHING: no fan (radial fan A, the owner's pick), no haptic.
- **No haptic on any touch.**
- The button is an **empty dark circle, no glyph** (`owner-button.png`, bottom right, over the transcript).
The design (docs/feat/mobile-hub.md §1): held 400 ms with travel < 10 pt → fan opens with haptic `open`; `hub-gesture.ts` pure state machine; the changelog says the fan works "with Settings → Activity button → Floating".

Suspects to TEST, not assume: the gesture machine is not wired into the floating button component that actually renders (a different component / an older path survived app-decomposition or open-at-end merges); the 400 ms timer never armed (Pressable onLongPress vs the custom machine); haptics module not linked in the release build (expo-haptics native module missing → silently no-op); a setting gate; the glyph's icon font/SVG not bundled.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: reproduce FIRST in the iOS simulator with the release-like build the repo's Maestro flows use (or the dev build), driving a long-press on `hub-button` (Maestro `longPressOn`) and capturing a screenshot; also check the button glyph and the Activity sheet content against the hub design. Then: root cause (one sentence each), minimal fix, regression tests (pure + a real-screen render or Maestro flow that FAILS today), and the haptics checked on the real native module path. Write the plan here before fixing.

## Execution

*— claude-opus-5-5, 2026-11-17*

**STOPPED at diagnosis (AGENTS §0 escalate / brief "a step contradicts the code").**
No code was changed, there is no changelog fragment, and nothing was committed. The root cause
was settled by static evidence (grep), so no simulator run was needed: the
feature the Context expects to be broken was **never built**.

**Evidence** (from `apps/mobile`):
```
$ rg -ln "hub-gesture|hub-fan|HubFan|stepGesture" --glob '*.tsx' src
(no match)                       # no component consumes the gesture machine or the fan
$ ls src/ui/Hub*                  → no matches
$ rg -n "playHaptic|haptic" src/ui/FloatingActivity.tsx → (no match)
```
`docs/feat/mobile-hub.md:705` "H3 — hub UI + wiring (PARTIAL: blocked, out of disk)"
and `:761`: **Not done:** `ui/HubFan.tsx`, the `FloatingActivity` rewrite
(responder → `reduce`, the 400 ms timer, the glyph, the arc and badge,
`accessibilityActions`), the `SessionScreen` entries, `openAttach`,
`gestureEnabled`, More/VoiceOver `ActionSheet`, Composer focus for Steer, flow 29.
H3 was never finished, but H4a/H4b were merged on top of it. They added only pure
modules (`hub-actions`, `hub-session`) and `SessionScreen` handlers that no
component calls.

**Root causes (one sentence each):**
1. *Long-press does nothing*: `src/ui/FloatingActivity.tsx:105-158` is still the
   mobile-chrome F2 `PanResponder` (tap = `isTap`, otherwise drag/snap). It has no hold timer,
   no `hub-gesture.reduce`, and no fan component exists to open.
2. *No haptic*: `FloatingActivity.tsx` never calls `playHaptic`. The haptics
   module itself is live (`SessionScreen.tsx:636,1129`, `SessionsDrawer.tsx:518`,
   `CodeBlock.tsx:68`), so the expo-haptics-not-linked suspect is refuted.
3. *Empty circle*: the button renders only `running ? <ActivityIndicator/>` + the
   count `label` (`FloatingActivity.tsx:194-201`). With nothing running and the
   count empty, it is a blank glass disc. The hub glyph belongs to the unbuilt H3 rewrite.
4. *Activity sheet "Scheduled · soon"*: this is NOT the hub. It is the mobile-chrome
   Activity sheet's ghost group (`src/activity.ts:51` `ghost`,
   `src/screens/ActivitySheet.tsx:58` `value="soon"`). H4a placed Scheduled in the
   hub fan → Session info, not in this sheet, so the placeholder was never
   replaced. It is a separate, small gap.
5. *Shipped claim*: `changelog.d/mobile-hub.added.md:2` says "long-press the
   button: a fan of actions opens", which is false on `main`.

**Why I stopped.** This task is sized S–M · contained as a *fix*. The real work is
the rest of mobile-hub H3: a new `HubFan.tsx`, a `FloatingActivity` gesture rewrite,
`SessionScreen`/`App.tsx` wiring, an a11y ActionSheet, and flow 29. It is gated on H3's own
**load-bearing spike** (does a `PanResponder` on the button keep the touch over the
transcript `ScrollView` for 400 ms + a drag-select), which was never run
(`mobile-hub.md:709`). That is an M–L UI subsystem plus an unverified assumption. AGENTS §10
puts it with a strong executor and a mandatory fresh review, under its own plan. It is
not a minimal fix, and building it here would contradict the approved sizing.

**Decision needed (owner/orchestrator), pick one:**
- **A (recommended):** close this fix as "diagnosed: H3 never built". Reopen
  mobile-hub **H3** (the spike first, now that disk is free) as its own slice. Fix
  `changelog.d/mobile-hub.added.md` now so it does not claim the fan, either by dropping the
  long-press sentence or by moving it to H3. Track item 4 (Activity sheet Scheduled ghost)
  as a tiny separate fix.
- **B:** re-scope *this* branch to H3: re-size it as L · load-bearing UI, write the §8
  plan here from `mobile-hub.md:158-452`, run the spike on the simulator, then build it.
- **C (stop-gap):** on this branch, only give the button a static glyph + a tap haptic,
  and correct the changelog. The fan stays absent.

**Gate:** not run (no code changed).

## Review
