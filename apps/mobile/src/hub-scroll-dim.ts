/**
 * The hub's scroll dim (owner 2 B of docs/feat/mobile-hub-center.md): while the
 * transcript scrolls the floating button fades to 20 % and ignores taps; it comes
 * back 600 ms after the finger's scroll stops, on the same 150 ms fade as
 * show/hide.
 *
 * Pure, no React (AGENTS §7): the transition table and the presence rule are
 * here, unit-tested; the SCREEN owns the one timer (`timer` says what to do with
 * it) and `ui/FloatingActivity.tsx` only animates the level it returns.
 *
 * Orchestrator O4: only a scroll the FINGER makes counts — `onScrollBeginDrag` /
 * `onMomentumScrollBegin` begin it, `onScrollEndDrag` / `onMomentumScrollEnd` end
 * it; `onScroll` says nothing. The follow-scroll of a streaming turn therefore
 * never dims the hub: during a turn the hub is where Stop lives.
 */

/** Owner 2 B: 20 % while scrolling. */
export const SCROLL_DIM_LEVEL = 0.2;
/** Owner 2 B: back 600 ms after scrolling stops. */
export const SCROLL_REST_MS = 600;

/**
 * - `rest`: nothing dims it.
 * - `scrolling`: the finger is dragging, or the fling it threw is still running.
 * - `settling`: the finger stopped; the 600 ms tail runs.
 */
export type ScrollDim = "rest" | "scrolling" | "settling";

/** What the screen reports: a finger's scroll began / ended, the tail elapsed, or a reset. */
export type ScrollEvent = "begin" | "end" | "elapsed" | "reset";

/** What the caller does with its ONE timer after this step. */
export type TimerAction = "arm" | "disarm" | "keep";

/**
 * One step. `begin` always wins (a drag's `end` followed at once by a fling's
 * `begin` never starts the tail); `end` in `rest` is the lone momentum-end of a
 * PROGRAMMATIC scroll, which must not arm anything (O4); an `elapsed` in `rest`
 * or `scrolling` is a stale timer and changes nothing; `reset` clears everything.
 */
export function scrollDimStep(
  state: ScrollDim,
  event: ScrollEvent,
): { readonly state: ScrollDim; readonly timer: TimerAction } {
  switch (event) {
    case "begin":
      return { state: "scrolling", timer: "disarm" };
    case "end":
      return state === "rest"
        ? { state: "rest", timer: "keep" }
        : { state: "settling", timer: "arm" };
    case "elapsed":
      return state === "settling" ? { state: "rest", timer: "keep" } : { state, timer: "keep" };
    case "reset":
      return { state: "rest", timer: "disarm" };
  }
}

/**
 * The button's outer level and whether it takes touches (O5). The dim is the
 * same layer as show/hide, so the running arc and the glow dim with it — nothing
 * stays bright over the text.
 *
 * No dim under VoiceOver (the button must stay reachable, and VoiceOver users do
 * not scroll with a drag), none while the button is engaged (a finger on it, a
 * drag, the fan open: `busy` is the caller's verdict from the gesture machine),
 * and none while it is hidden — a hidden button is at 0 and takes nothing.
 */
export function hubPresence(input: {
  readonly shown: boolean;
  readonly scroll: ScrollDim;
  readonly voiceOver: boolean;
  readonly busy: boolean;
}): { readonly level: number; readonly touchable: boolean } {
  if (!input.shown) {
    return { level: 0, touchable: false };
  }
  if (input.scroll !== "rest" && !input.voiceOver && !input.busy) {
    return { level: SCROLL_DIM_LEVEL, touchable: false };
  }
  return { level: 1, touchable: true };
}
