/**
 * OD6 (docs/feat/session-hop-ux): after a move the session CONTINUES by itself.
 * The owner's requirement is that no typing is needed — the model is woken with
 * one short message, whose text names where it now is (the laptop's `hopWakeLine`),
 * so it neither sits idle nor guesses whether the move happened.
 *
 * This module is the DECISION only (AGENTS §7: decisions in a pure module, the
 * component renders): given where the hop came from and what happened, do we wake,
 * or hold the line for the user's next prompt? `App`/`useHop` execute it, because
 * only they own the turn.
 *
 * The rules, in order:
 *   - a `/move` typed at TRUE IDLE wakes nobody: the user is right there, and the
 *     next thing they type carries the line (today's behaviour, unchanged);
 *   - a MODEL-proposed move, or a `/move` typed mid-task (a queued one, D4), wakes:
 *     the work was in flight, and a move must not silently end it;
 *   - a chain of `HOP_WAKE_CHAIN_MAX` wakes with no user prompt between them stops:
 *     a model that proposes a move on every wake must not spin forever. The line
 *     then rides the user's next real prompt, so nothing is lost;
 *   - a hop that settles while the session is NOT idle (`hopReady`: a turn of
 *     ours, a queued row, a held foreign turn) holds too — one turn at a time.
 */

/** The prompt a wake sends: short, and the hop's line is prepended by the driver. */
export const HOP_WAKE_TEXT = "Continue the task from here.";

/** The dim row a wake paints instead of a user bubble, so the frame says why a turn ran. */
export const HOP_WAKE_ROW = "↻ continuing after the move";

/** How many consecutive wake turns run before the chain holds (no user prompt between). */
export const HOP_WAKE_CHAIN_MAX = 3;

/** Said ONCE when the chain holds, so a paused session cannot look hung. */
export const HOP_WAKE_PAUSED_NOTICE =
  "auto-continue paused after 3 moves — send a message to continue";

/** Where a settled hop came from (the three entries `startHop` has, D3). */
export type HopOrigin = "proposal" | "queued" | "idle";

/** What a settled hop did. */
export type HopWakeOutcome = "moved" | "failed" | "declined";

export type HopWakeStep = "wake" | "hold";

/**
 * `wake` sends ONE real prompt by itself; `hold` leaves the line for the user's
 * next prompt (it is consumed there, so it is never lost and never doubled).
 */ export function hopWakeStep(input: {
  readonly origin: HopOrigin;
  readonly outcome: HopWakeOutcome;
  /** Consecutive wake turns so far, with no user prompt between them. */
  readonly chain: number;
  /**
   * `hopReady`'s answer at the moment the hop settled: this TUI's own turn is
   * over AND nothing is queued (docs/feat/session-hop-ux, failure mode "Wake when
   * not idle"). A wake started into a busy session is a SECOND concurrent turn —
   * a job wake (`wakeIfPending`) or a drained foreign turn already owns the
   * slot — so the line waits for the next real prompt instead.
   */
  readonly ready: boolean;
}): HopWakeStep {
  // A user who is at the keyboard gets the line in their next prompt: a turn
  // starting by itself right after they typed `/move local` is noise.
  if (input.origin === "idle") {
    return "hold";
  }
  // A `/move` typed mid-task that the owner then REFUSED was answered by them; a
  // wake would ask the model to continue a task they just stopped.
  if (input.origin === "queued" && input.outcome === "declined") {
    return "hold";
  }
  // NEVER two turns at once: a hop that settles while something else runs holds
  // the line, and the next real prompt carries it (never lost, never doubled).
  if (!input.ready) {
    return "hold";
  }
  return input.chain >= HOP_WAKE_CHAIN_MAX ? "hold" : "wake";
}
