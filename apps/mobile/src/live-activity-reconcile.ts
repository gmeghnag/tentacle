/**
 * Live Activity RECONCILE (docs/feat/mobile-live-activity.md Design 7, L11):
 * bringing the phone's activities back in line with the daemon on every connect.
 *
 * **The daemon is the truth.** The phone cannot know what happened while it was
 * offline (F1/F2), so the plan is computed from the daemon's own view plus what
 * the seal can open — never from what an activity appears to say.
 *
 * Pure: the daemon's view, the local list, the seal and the last acked token are
 * all injected, so every rule is a table test rather than a device run.
 *
 * The rules, in precedence order:
 *  1. **A dismissed activity is reported `dismissed`** (F17): the daemon must
 *     never restart it for that turn, and only the app knows the person's gesture.
 *  2. **A content-state that does not OPEN is ended** (F6/F11): a forged one, or
 *     one sealed before a `devices reset` — nothing may stay on the lock screen
 *     that the phone cannot authenticate.
 *  3. **A turn that is no longer running is ended** (`ended`): the app was closed
 *     when it finished, so only this pass can clean it up.
 *  4. **An unacked update token is reported** (Owner Q8): the daemon's slot table
 *     is memory-only, so a daemon restart makes every token unknown and updates
 *     would stop silently. Reporting is what resumption depends on.
 *
 * Ending takes precedence over reporting: an activity being removed needs no token.
 */
import type { ActivityContent } from "@tentacle/protocol";

/** One activity the native module reports: what the system says, plus our own bookkeeping. */
export interface LaLocalActivity {
  /** The system's activity id. */
  readonly id: string;
  /** The daemon's slot (from the CLEAR attributes — used for correlation, not authority). */
  readonly slot: string;
  readonly computerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** The system's activity state: an activity the person swiped away is `dismissed`. */
  readonly state: "active" | "dismissed" | "ended" | "stale";
  /** The CLEAR content-state, as the system holds it (untrusted — the seal decides). */
  readonly contentState: { readonly v: 1; readonly e: string; readonly c: string };
}

/** What the daemon says, for the sessions this phone cares about. */
export interface LaDaemonView {
  /** `true` iff that session's turn is still running (its `session/list` truth). */
  isTurnRunning(sessionId: string, turnId: string): boolean;
}

export interface LaReconcileDeps {
  readonly activities: readonly LaLocalActivity[];
  readonly daemon: LaDaemonView;
  /** Re-open one content-state; `undefined` when it cannot be authenticated. */
  readonly openContent: (activity: LaLocalActivity) => ActivityContent | undefined;
  /** The activity's current update token, when iOS has issued one. */
  readonly updateTokenOf: (activity: LaLocalActivity) => string | undefined;
  /** The token the daemon last acknowledged for that activity (its ack, per slot). */
  readonly ackedToken: string | undefined;
}

/** One thing the reconcile pass must do. */
export type LaReconcileStep =
  | {
      readonly do: "end";
      readonly activityId: string;
      readonly reason: "dismissed" | "ended" | "stale";
    }
  | {
      readonly do: "reportToken";
      readonly activityId: string;
      readonly slot: string;
      readonly token: string;
    };

/** What to do on this connect, in order. */
export function planLiveActivityReconcile(deps: LaReconcileDeps): LaReconcileStep[] {
  const steps: LaReconcileStep[] = [];
  for (const activity of deps.activities) {
    // 1. The person's gesture: the daemon must never restart it for this turn.
    if (activity.state === "dismissed") {
      steps.push({ do: "end", activityId: activity.id, reason: "dismissed" });
      continue;
    }
    // 2. A state the phone cannot authenticate: a forged one, or one from before a
    //    computer reset. It must not stay on the lock screen, showing nothing (F6/F11).
    const opened = deps.openContent(activity);
    if (opened === undefined) {
      steps.push({ do: "end", activityId: activity.id, reason: "stale" });
      continue;
    }
    // 3. The daemon is the truth about whether the turn is still running: the app
    //    was closed when it finished, so only this pass can clean it up (F1/F2).
    if (!deps.daemon.isTurnRunning(activity.sessionId, activity.turnId)) {
      steps.push({ do: "end", activityId: activity.id, reason: "ended" });
      continue;
    }
    // 4. Updates resume only once the daemon knows the token (Owner Q8).
    const token = deps.updateTokenOf(activity);
    if (token !== undefined && token !== deps.ackedToken) {
      steps.push({ do: "reportToken", activityId: activity.id, slot: activity.slot, token });
    }
  }
  return steps;
}
