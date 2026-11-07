/**
 * One session's autonomous wake on a background-job exit, pure: the TUI and a
 * detached run's relay decide it here, each with its own turn driver
 * (docs/fix/detached-autowake.md), and a `serve` daemon for its own sessions,
 * attached or not (`daemonWakeGate`). The agent flushes every pending exit at a
 * turn's START, so N exits before the next start are one wake.
 */
export interface WakeModel {
  readonly pending: boolean;
}

export const initialWake: WakeModel = { pending: false };

export type WakeEvent =
  /** A job exited (the live notification). */
  | { readonly type: "exit" }
  /** A turn started: its start flushes every exit. */
  | { readonly type: "turn_started" }
  /** Our wake did not start (it lost the slot, a compaction defers it). */
  | { readonly type: "refused" }
  /** Another session: the old one's exit is not ours. */
  | { readonly type: "reset" };

export function wakeStep(_model: WakeModel, event: WakeEvent): WakeModel {
  return { pending: event.type === "exit" || event.type === "refused" };
}

export interface WakeGate {
  readonly enabled: boolean;
  readonly idle: boolean;
  readonly blocked: boolean;
}

/** True: start ONE continuation now; the caller then steps `turn_started`. */
export function wakeDue(model: WakeModel, gate: WakeGate): boolean {
  return model.pending && gate.enabled && gate.idle && !gate.blocked;
}

/** What a `serve` daemon knows of its own session when a wake may be due. */
export interface DaemonWakeState {
  /** The daemon host's own `autoWake` (never a carried setting). */
  readonly enabled: boolean;
  /** A turn or a compaction holds the slot. */
  readonly busy: boolean;
  /** The last turn ended `error` or `cancelled`: the chain stops there. */
  readonly lastEndBad: boolean;
  readonly closed: boolean;
}

/**
 * The third user (docs/feat/serve-autowake.md): a `serve` daemon is the ONLY
 * waker of its sessions — attached clients or not (they watch the wake turn
 * live and may cancel it) — when idle, after a normal end. Its `pending` is
 * the agent's own count of unflushed exits, not `wakeStep`.
 */
export function daemonWakeGate(s: DaemonWakeState): WakeGate {
  return {
    enabled: s.enabled,
    idle: !s.busy,
    blocked: s.lastEndBad || s.closed,
  };
}
