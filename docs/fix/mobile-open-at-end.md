# fix/mobile-open-at-end — open a session at its end; resync on foreground

> **Status:** implementation (approved by orchestrator, owner request)
> **Branch:** `fix/mobile-open-at-end`
> **Size:** S–M · **Blast:** contained (apps/mobile only, no protocol) · **Suited:** DeepSeek exec + one Opus review
> **Changelog:** `changelog.d/mobile-open-at-end.fixed.md`

## Context

Owner, 2026-11-16 (live on the iPhone):
1. **Opening a long conversation scrolls visibly through the whole transcript**
   down to the end ("per conversazioni lunghissime è bruttino"). Wanted: the
   session opens ALREADY at its end — no visible scroll, no animation — like a
   messaging app. Later appends while following keep today's behaviour.
2. **Resync when the app comes back to the foreground.** Today a resync happens
   only when the link dropped (redial + re-attach, `connection.ts:130`) or on
   pull-to-refresh (`session-screen-controller.ts:1375` `resync()`). The bug
   class fixed in `docs/fix/mobile-media-live.md` (updates silently lost while the
   link stayed up) had no automatic recovery. Wanted: when the app returns to
   `active` with a session screen open, run the same `resync()` (silently: no
   pull spinner; the existing re-entry guard makes a concurrent pull a no-op).

*— claude-opus-5-5 (orchestrator), 2026-11-16*

## Implementation

**Load-bearing check (do first, paste output):** a repro under
`.tentacle/tmp/mobile-open-at-end/` (or a test) showing that today the first
scroll after the initial attach is `animated: true` (SessionScreen.tsx ~302, the
pure step that yields `step.scrollTo`) and/or that the list mounts at offset 0
with a long history.

**Design (pick the smallest that holds; logic in the pure module, the
component only renders — AGENTS §7):**
- The scroll state machine distinguishes the **initial landing** (first content
  of an attach/re-attach/resync with history) from later follow-scrolls: the
  initial landing is `animated: false` and happens before the rows are shown
  (e.g. hide the list for that first layout frame, or `initialScrollIndex` /
  `maintainVisibleContentPosition`, or an inverted list if it is the cleanest —
  justify the choice in Execution). Later appends: unchanged.
- A long history must not render every row to get to the end (keep FlatList
  virtualization; no `initialNumToRender = rows.length`).
- Foreground resync: the screen controller gets an `appActive()` input (fed
  from `AppState` by the screen/app shell, the pattern `dictation.ts` /
  `read-aloud.ts` use); when attached and not already refreshing it calls the
  `resync()` path silently. Never while offline (the redial path owns that), and
  at most once per foreground transition.

**Failure modes:** empty session; history shorter than the screen; resync that
appends nothing (no jump); resync while a turn streams (no duplicate rows — the
attach path already dedups, `transcript.ts:274-281`); user scrolled up reading
when foregrounding (resync must not yank them to the end); rapid
background/foreground.

**Tests (red first, mutation-checked):** pure-module tests for the scroll
machine (initial landing not animated; later follow animated; scrolled-up
reader not moved by a resync) and the controller (`appActive` → one silent
resync; offline → none; already refreshing → none); a SessionScreen render test
asserting the initial scroll call is `animated: false`.

*— claude-opus-5-5 (orchestrator), 2026-11-16 — APPROVED*

## Execution

## Review
