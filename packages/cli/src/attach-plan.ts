/**
 * `attach <name>` on a detached run, and its quit (docs/feat/detached-handover.md),
 * pure: what the attach does with the run's state, and whether the last TUI's
 * quit removes the workload. The IO shell is `attach-run.ts`.
 *
 * Owner tracking is for detached-origin runs only (Q4): with no `owner.json`
 * the attach is today's plain one. A run's TUIs share its ONE session (Q3), so
 * an attach never opens a fresh session on such a run, and a quit's removal is
 * the LAST client's only (Q1), never on a doubt.
 */
import type { ResidentUse } from "./relay-state.ts";
import { type OwnerRead, ownerKeeps } from "./run-state.ts";

export interface AttachInput {
  readonly owner: OwnerRead;
  /** The run dir's lock has a live holder (a relay, or the last TUI closing the run). */
  readonly relayAlive: boolean;
  /** The kept entry's `created`: a record that does not carry it is of an earlier workload. */
  readonly entryCreated: string;
  /** `--resume <uid>`; `--continue` and a bare `--resume` are no uid: the run's session. */
  readonly resumeUid?: string;
  /** stdin and stdout are a terminal: a TUI can mount. */
  readonly tty: boolean;
}

export type AttachPlan =
  /** Today's attach: no presence, no owner record (Q4). */
  | { readonly kind: "plain" }
  /** S2's refusal: a live relay owns the session, and no hand-over can happen. */
  | { readonly kind: "refuse"; readonly why: "relay" }
  /** No terminal: a TUI that cannot mount would end the run. */
  | { readonly kind: "refuse"; readonly why: "tty" }
  /**
   * Open the run's session; `handover`: from a live relay first. `cwd`: the
   * run's own folder (owner.json, written by this laptop), when it recorded
   * one — the attach behaves as if launched from there (docs/fix/attach-any-folder.md).
   */
  | {
      readonly kind: "run";
      readonly cwd?: string;
      readonly sessionId: string;
      readonly handover: boolean;
      readonly keep: boolean;
    };

export function planAttach(input: AttachInput): AttachPlan {
  const { owner, relayAlive } = input;
  if (owner.kind === "none") {
    return relayAlive ? { kind: "refuse", why: "relay" } : { kind: "plain" };
  }
  if (owner.kind === "unknown") {
    // The lock decides; the file is left untouched.
    return relayAlive ? { kind: "refuse", why: "relay" } : { kind: "plain" };
  }
  const record = owner.owner;
  if (record.created !== input.entryCreated) {
    // The run dir outlives a reused name: this record is not THIS workload's,
    // so it gives it no session and no delete (Q4). The lock decides, as above.
    return relayAlive ? { kind: "refuse", why: "relay" } : { kind: "plain" };
  }
  if (input.resumeUid !== undefined && input.resumeUid !== record.sessionId) {
    return relayAlive && record.kind === "relay"
      ? { kind: "refuse", why: "relay" }
      : { kind: "plain" };
  }
  if (!input.tty) {
    return { kind: "refuse", why: "tty" };
  }
  // A stale owner, an ended run (Q5) and a join (Q3) are one path.
  return {
    kind: "run",
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    sessionId: record.sessionId,
    handover: relayAlive,
    keep: ownerKeeps(record),
  };
}

export interface QuitInput {
  readonly keep: boolean;
  /**
   * Other TUIs of the run alive (presence files), mine excluded, read after
   * this quit's close (and, for a `/quit` closing for all, after its session's
   * other TUIs left): any left is on another session, or hung.
   */
  readonly othersAttached: number;
  /** Of those, the ones on this TUI's session: hung, a close reaches them. */
  readonly othersOnSession: number;
  /** The last read-back and its write to the laptop copy both confirmed. */
  readonly saved: boolean;
  /** `LocalRuntime.quit`'s: sessions the daemon did not confirm it closed. */
  readonly sessionsKept: number;
  /** One fresh read, before the close; `null` when it could not be told. */
  readonly use: ResidentUse | null;
}

export type QuitPlan =
  | { readonly kind: "stay"; readonly why?: string }
  | { readonly kind: "remove" };

/**
 * What a TUI's quit does with a keep=false run's workload: the ONLY place it
 * is decided. Every doubt keeps it (a leftover is one `rm` away; deleted files
 * are gone). Its own running turn and jobs do not hold it: the quit is the
 * explicit stop that ends them (Q6). Pod-supplied `use` and the daemon's
 * `closed` steer only the removal of that same workload.
 */
export function quitPlan(input: QuitInput): QuitPlan {
  if (input.keep) {
    return { kind: "stay" };
  }
  if (!input.saved) {
    return { kind: "stay", why: "the last save was not confirmed" };
  }
  // Read after this TUI's session was closed for its own TUIs (D1): one still
  // here is hung, or on another session (`/clear`).
  if (input.othersAttached > 0) {
    return {
      kind: "stay",
      why:
        input.othersOnSession > 0
          ? "another terminal did not leave the session"
          : "another terminal is on another session",
    };
  }
  if (input.sessionsKept > 0) {
    return { kind: "stay", why: "the daemon did not confirm the session closed" };
  }
  if (input.use === null) {
    return { kind: "stay", why: "could not tell whether it is in use" };
  }
  if (input.use.others > 0) {
    return { kind: "stay", why: "another session is in use" };
  }
  return { kind: "remove" };
}
