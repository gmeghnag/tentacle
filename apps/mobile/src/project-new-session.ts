/**
 * The New session button of a project's session list
 * (docs/feat/mobile-project-new-session.md D2, D3, D5). React-free (AGENTS §7):
 * `SessionsScreen` only draws the view. The create itself is the drawer's
 * (`createDrawerNewSession`).
 *
 * - The gate is the list's own state, no extra probe: enabled iff the daemon has
 *   answered and the link is not down.
 * - A dimmed button always says why, in words (never colour alone); a tap on it
 *   is refused (the app plays the light haptic) and sends nothing.
 */
import type { NewSessionState } from "./drawer-new-session.ts";
import type { SessionListState } from "./session-list.ts";

export const CONNECTING_REASON = "Connecting…";
export const OFFLINE_REASON = "Offline — reconnecting";
export const CANT_REACH_REASON = "Can't reach this computer";

const LABEL = "New session";

export interface ProjectNewSessionView {
  /** The pill looks live. */
  readonly enabled: boolean;
  /** A create is in flight (spinner). */
  readonly busy: boolean;
  /** Why it is dimmed, shown beside it; null when live or busy. */
  readonly reason: string | null;
  /** Why the last create failed, the line above the bar. */
  readonly error: string | null;
  readonly accessibilityLabel: string;
}

type ListGate = Pick<SessionListState, "status" | "stale">;

/** Why this list cannot start a session; null when it can. */
function blocked(list: ListGate): string | null {
  // A failed first read is also marked stale, so it is asked first.
  if (list.status === "failed") {
    return CANT_REACH_REASON;
  }
  if (list.stale) {
    return OFFLINE_REASON;
  }
  return list.status === "loaded" ? null : CONNECTING_REASON;
}

export function projectNewSessionView(
  list: ListGate,
  state: NewSessionState,
): ProjectNewSessionView {
  const why = blocked(list);
  const reason = state.creating ? null : why;
  return {
    enabled: why === null && !state.creating,
    busy: state.creating,
    reason,
    error: state.error,
    accessibilityLabel: reason === null ? LABEL : `${LABEL}, ${reason}`,
  };
}

/** What a tap does: create, refuse (light haptic, nothing sent) or ignore (busy). */
export function projectNewSessionTap(view: ProjectNewSessionView): "create" | "refuse" | "ignore" {
  if (view.busy) {
    return "ignore";
  }
  return view.enabled ? "create" : "refuse";
}
