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

## Review
