/**
 * The blinking bullet of a running tool call (docs/feat/tui-tool-blink.md).
 *
 * A call that is still running is marked `⏺` for the ON half of a one-second
 * cycle and two spaces for the OFF half, so a long call looks alive. `⏺` is 2
 * columns wide (`string-width`, the width function Ink's own layout uses), so
 * the OFF glyph is 2 columns too and the row is laid out with `⏺` and the glyph
 * swapped afterwards (`render-lines.ts`) — no row ever moves between phases.
 *
 * Every running call is drawn from ONE phase value, so they blink in sync:
 * there is no per-row timer. And the whole clock RULE lives here too — when the
 * clock runs, when it restarts ON, what a given tick renders — so the component
 * only renders what it is told (AGENTS §7).
 *
 * Pure and framework-free: items + a tick counter in, a glyph and a phase out.
 */
import type { DisplayItem, ToolStatus } from "./state.ts";

/** ON for this long, then OFF for as long: a one-second cycle. */
export const BLINK_HALF_MS = 500;

/** The bullet every tool call carries: running (blinking), ok, or error. */
export const BULLET = "⏺";

/** The OFF glyph: exactly as wide as `BULLET` (2 columns), so no row moves. */
export const BLANK = "  ";

/**
 * The shared clock's state: WHICH call set it was armed for and how many
 * half-periods have elapsed. A counter, never an accumulated time, so a late
 * timer fire shifts the phase by one half-period and every row agrees on it.
 */
export interface BlinkClock {
  /** The `calls` value this clock was armed at (0 = not armed). */
  readonly calls: number;
  /** Half-periods elapsed since the clock was armed (0 = the ON half). */
  readonly tick: number;
}

/** Not armed: phase 0, no timer. */
export const BLINK_IDLE: BlinkClock = { calls: 0, tick: 0 };

/** What the transcript says about the clock: how many calls exist, and may it run. */
export interface BlinkState {
  /** Tool calls in the transcript: it rises when a NEW call starts (never on a result). */
  readonly calls: number;
  /**
   * May the clock run at all? Only while the TURN runs and some call is still
   * unanswered. Both halves matter:
   * - a settled call is never on the clock, so a finished row cannot blink;
   * - `running` is what keeps a DEAD call (a link loss, a failed turn — the
   *   reducer can leave a `running` item behind) from blinking forever: the
   *   turn is over, so the timer is gone (owner decision 2, 2026-10-30).
   */
  readonly running: boolean;
}

/** Read the blink state off the transcript and the turn. */
export function blinkState(items: readonly DisplayItem[], turnRunning: boolean): BlinkState {
  let calls = 0;
  let unanswered = false;
  for (const item of items) {
    if (item.kind === "tool") {
      calls += 1;
      unanswered = unanswered || item.status === "running";
    }
  }
  return { calls, running: turnRunning && unanswered };
}

/**
 * The phase (ms) to render at this state.
 *
 * ON (0) whenever the clock is not running OR it was armed for a different call
 * set: a NEW call therefore starts ON in the very first frame that sees it,
 * without waiting for an effect (owner decision 1: the clock restarts ON when a
 * call starts, so a 200 ms call is never blank and no row ever starts mid-OFF).
 */
export function blinkPhase(clock: BlinkClock, state: BlinkState): number {
  if (!state.running || clock.calls !== state.calls) {
    return 0;
  }
  return clock.tick * BLINK_HALF_MS;
}

/**
 * The clock after one half-period. A different call set re-arms it from tick 1
 * (the ON half it just rendered was a full half-period), so the phase after a
 * new call is OFF — never a stale half of the previous call's cycle.
 */
export function advanceBlink(clock: BlinkClock, calls: number): BlinkClock {
  return { calls, tick: clock.calls === calls ? clock.tick + 1 : 1 };
}

/**
 * The clock re-armed for THIS state: idle when nothing is running (so the next
 * call starts ON and no stale OFF half survives a tick or a `/clear`), and
 * re-armed at tick 0 when the call set changed. Returns the SAME object when
 * nothing needs to change, so the App's sync effect cannot loop.
 */
export function syncBlink(clock: BlinkClock, state: BlinkState): BlinkClock {
  if (!state.running) {
    return clock === BLINK_IDLE ? clock : BLINK_IDLE;
  }
  if (clock.calls === state.calls) {
    return clock;
  }
  return { calls: state.calls, tick: 0 };
}

/**
 * The phase a row shows: ON for the first half of every cycle, so a call whose
 * clock starts at 0 (the first running call) begins ON and a call shorter than
 * one half-period is never blank. Negative / non-finite input is ON (never a
 * surprise blank row).
 */
export function blinkOn(phase: number): boolean {
  if (!Number.isFinite(phase) || phase <= 0) {
    return true;
  }
  return phase % (BLINK_HALF_MS * 2) < BLINK_HALF_MS;
}

/**
 * The glyph that opens a tool call's row: `⏺` for a finished call (ok or
 * error — the caller colours it) and for a running one during the ON phase,
 * `BLANK` during the OFF phase (same width: the rest of the row never moves).
 */
export function toolBullet(status: ToolStatus, phase: number): string {
  if (status !== "running") {
    return BULLET;
  }
  return blinkOn(phase) ? BULLET : BLANK;
}
