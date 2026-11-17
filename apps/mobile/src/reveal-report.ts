/**
 * The reveal's TRACKER (docs/feat/mobile-hub.md H4a, fix round 1 finding M1).
 *
 * `revealStep` (session-info.ts) is the rule: one band's report, one state, one
 * scroll. What the screen got wrong was WHERE the state lived. It held it in
 * `useState` and folded each `onLayout` against the value in that render's
 * closure, so every band reporting in ONE layout pass folded onto the same
 * stale state and the last write won. The schedules band reports before
 * `mcp`/`skills` in tree order, so the surviving state still had
 * `want: "schedules"` — and the sheet yanked the person back to that band on
 * every relayout above it (a pull landing, a row expanding, a wake firing).
 *
 * So the state is not render state at all: the reveal draws nothing, it only
 * decides one scroll. A tracker carries it outside React — read and written
 * SYNCHRONOUSLY, one report at a time, so no pass can overwrite another — and
 * the scroll is issued by the caller from the step's result, never from inside
 * a React updater (StrictMode invokes those twice).
 *
 * `reportReveal` is the exact function the screen's `onLayout` calls, so the
 * batching this file guards against is what the tests below execute (AGENTS §7:
 * the branch that matters lives in a pure, React-free, tested module).
 */

import {
  REVEAL_IDLE,
  type RevealState,
  type SectionId,
  revealStart,
  revealStep,
} from "./session-info.ts";

/** The reveal in flight, held by the caller outside React (a `useRef`). */
export interface RevealTrack {
  current: RevealState;
}

/** A fresh tracker: nothing wanted, nothing measured. */
export function trackReveal(): RevealTrack {
  return { current: REVEAL_IDLE };
}

/**
 * A reveal asked for — the sheet opening on `id`. It replaces whatever was in
 * flight (the previous reveal was either spent or belongs to a closed sheet), so
 * a second open scrolls again.
 */
export function startReveal(track: RevealTrack, id: SectionId | null): void {
  track.current = revealStart(id);
}

/**
 * One band laid out: fold it in and hand the caller the ONE y to scroll to (or
 * nothing). Reading and writing `track.current` here — rather than a value
 * captured by a render — is the fix: the reports of one batched pass are folded
 * one after another, so the wanted band's y is reached and the want is spent the
 * first time it can be.
 */
export function reportReveal(
  track: RevealTrack,
  laid: { readonly id: SectionId; readonly y: number },
  scroll: (y: number) => void,
): void {
  const step = revealStep(track.current, laid);
  track.current = step.state;
  if (step.scrollTo !== null) {
    scroll(step.scrollTo);
  }
}
