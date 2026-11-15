/**
 * The TUI session's autonomous-wake decision, pure (S13).
 *
 * `@tentacle/core`'s `auto-wake.ts` owns the MODEL (`wakeStep`) and the RULE
 * (`wakeDue`) — and a third shape for a `serve` daemon (`daemonWakeGate`). The
 * TUI is the second user, and it wrote its gate out TWICE (`App.tsx`'s live exit
 * handler and its post-turn `wakeIfPending`), with the same three fields derived
 * the same way. That derivation is the residue: `idle` is the NEGATION of a live
 * ref, `blocked` is a second ref, and getting one of them backwards silently
 * starts a turn over a `/clear` or over a running one. So it lives here, where a
 * test can pin it without a terminal (AGENTS §7: the TUI harness strips SGR, so
 * logic left in the component is often untestable).
 *
 * Pure: no React, no clock, no I/O. The caller reads its refs and executes.
 */
import { type WakeGate, type WakeModel, wakeDue, wakeStep } from "@tentacle/core";

/** What the TUI knows about its own session when a wake may be due. */
export interface WakeFacts {
  /** `autoWakeOnJobExit`: the user's setting. */
  readonly enabled: boolean;
  /** A turn is running (`stateRef.current.running`). */
  readonly running: boolean;
  /** A `/clear` is in flight (`clearingRef.current`). */
  readonly clearing: boolean;
}

/**
 * The TUI session's gate. `idle` is the negation of `running` (a running turn
 * flushes the exits at its next start, so the wake defers to it), and a `/clear`
 * in flight blocks it: its history has not been applied yet, so a turn started
 * now would be wiped by it (review H2).
 */
export function sessionWakeGate(facts: WakeFacts): WakeGate {
  return { enabled: facts.enabled, idle: !facts.running, blocked: facts.clearing };
}

/** The answer: the model to store, and whether ONE continuation starts now. */
export interface WakeAttempt {
  /**
   * The model to write back — ALWAYS, whether or not this attempt woke: a due
   * wake consumes `pending` (`turn_started`), a deferred one leaves it for the
   * next check.
   */
  readonly model: WakeModel;
  /** Start one continuation turn (`run("", { continuation: true })`)? */
  readonly wake: boolean;
}

/**
 * One attempt: if a wake is due, consume `pending` and say so; otherwise hand the
 * model back untouched, so the next check (a turn's end, a `/clear`'s end) asks
 * again. One place, so the live exit path and the post-turn path cannot drift.
 */
export function tryWake(model: WakeModel, facts: WakeFacts): WakeAttempt {
  if (!wakeDue(model, sessionWakeGate(facts))) {
    return { model, wake: false };
  }
  return { model: wakeStep(model, { type: "turn_started" }), wake: true };
}
