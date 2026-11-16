# fix/mobile-open-at-end — open at end, resync on foreground, swipe-to-time

> **Status:** implementation (approved by orchestrator, owner request)
> **Branch:** `fix/mobile-open-at-end`
> **Size:** S–M · **Blast:** contained (apps/mobile only, no protocol) · **Suited:** DeepSeek exec + one Opus review
> **Changelog:** `changelog.d/mobile-open-at-end.fixed.md` + `changelog.d/mobile-swipe-timestamps.added.md`

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

### Slice B — swipe a row left to reveal its time (owner, same branch)

Owner, 2026-11-16 (iPhone), with a reference screenshot from another chat app
(`.tentacle/tmp/mobile-swipe-timestamps/reference.png`): dragging the
conversation to the LEFT reveals, in the
right margin, the arrival time of each row (e.g. `22:16` aligned with the user
bubble). Releasing springs everything back. Not implemented in tentacle today;
the owner wants it ("lo voglio implementato").

Behaviour to match (iMessage-style):
- **Per row (owner correction, 2026-11-16):** a horizontal pan on ONE row
  (block) slides ONLY that row left and reveals ONLY its time; every other row
  stays put. Capped (~60–70pt), a little resistance; release → spring back.
  (The reference screenshot shows the whole transcript moving — NOT wanted.)
- The swiped row (user bubble, assistant text, tool-summary row) shows its time
  `HH:mm` (device locale/24h as the system says) vertically centred on the row,
  in the secondary text colour, mono font (owner: MONO font everywhere in charts;
  follow the app's existing secondary-label style).
- Must not fight vertical scrolling (activate only on a clearly horizontal
  drag), the hub floating button, the edge-swipe back gesture, text selection,
  or the tool-row tap/expand.
- Times: from the session log's entry timestamps (`ts` on log entries) or the
  message as received live; a row without a known time shows nothing.
  If a time is not reachable on the phone today, the plan states exactly where
  it comes from (log read on attach + live updates) and whether any protocol
  field is needed (prefer none; if needed, additive per AGENTS §7).

Constraints: logic (which rows get which time, gesture thresholds/state) in a
pure module with tests; the component only renders (AGENTS §7). Owner taste:
minimal (`owner-taste-minimalism`). Same branch as slices A (open at end) and the foreground resync (owner: do them together).

*— claude-opus-5-5 (orchestrator), 2026-11-16*

## Implementation

**Slice A** (items 1–2 above):

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
