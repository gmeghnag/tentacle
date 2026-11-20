/**
 * The drawer's New session pill (docs/feat/mobile-chrome.md Design 3, slice S7,
 * F8). React-free (AGENTS §7): the drawer only draws `state()`.
 *
 * - Offered only on an online computer (`drawerTitle(...).canCreate`, F2/F8):
 *   a tap there with `canCreate` false sends nothing.
 * - The id is minted HERE (the phone owns it, like the outbox's keys), the
 *   session is created on the drawer's SELECTED computer (which may not be the
 *   open session's), and only a create that succeeded opens it.
 * - One create at a time: a second tap while one is in flight does nothing.
 * - A failure opens nothing and stays visible (`error`) until the next tap or
 *   `dismiss` — never a silent no-op. Its text is decided by the typed reason,
 *   never by a daemon's message (a pod chooses that text, §7).
 */
import type { SessionOpenFailure } from "./session-controller.ts";

/** The header title of a session that has none yet (the daemon titles it after the first turn). */
export const NEW_SESSION_TITLE = "(new)";

export interface NewSessionState {
  readonly creating: boolean;
  /** Why the last create failed; null when none (or cleared). */
  readonly error: string | null;
}

export interface DrawerNewSessionDeps {
  /** A fresh session id (the app passes `crypto.randomUUID`). */
  readonly mint: () => string;
  /** `createFreshSession` over that computer's client. Never throws. */
  readonly create: (
    computerId: string,
    sessionId: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: SessionOpenFailure }>;
  /** The session exists: navigate to it. */
  readonly opened: (computerId: string, sessionId: string) => void;
}

export interface DrawerNewSession {
  state(): NewSessionState;
  subscribe(listener: () => void): () => void;
  start(computerId: string, canCreate: boolean): Promise<void>;
  dismiss(): void;
}

const ERROR_TEXT: Readonly<Record<SessionOpenFailure, string>> = {
  link: "Couldn't reach this computer. Try again when it's online.",
  timeout: "This computer didn't answer in time. Try again.",
  "too-many": "This computer has too many sessions open.",
  gone: "Couldn't create the session. Try again.",
  archived: "Couldn't create the session. Try again.",
  deleted: "Couldn't create the session. Try again.",
};

export function newSessionErrorText(reason: SessionOpenFailure): string {
  return ERROR_TEXT[reason];
}

/** What the pill draws: `canCreate` is `drawerTitle(...).canCreate` (online only). */
export function newSessionPill(
  canCreate: boolean,
  state: NewSessionState,
): { readonly enabled: boolean; readonly busy: boolean; readonly error: string | null } {
  return { enabled: canCreate && !state.creating, busy: state.creating, error: state.error };
}

export function createDrawerNewSession(deps: DrawerNewSessionDeps): DrawerNewSession {
  let state: NewSessionState = { creating: false, error: null };
  const listeners = new Set<() => void>();
  const set = (next: NewSessionState): void => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(computerId, canCreate) {
      if (!canCreate || state.creating) {
        return;
      }
      const sessionId = deps.mint();
      set({ creating: true, error: null });
      const result = await deps.create(computerId, sessionId);
      if (!result.ok) {
        set({ creating: false, error: newSessionErrorText(result.reason) });
        return;
      }
      set({ creating: false, error: null });
      deps.opened(computerId, sessionId);
    },
    dismiss() {
      if (state.error !== null) {
        set({ ...state, error: null });
      }
    },
  };
}

export interface HubNewSessionDeps {
  /** The computer the drawer lists (where the drawer's pill would create). */
  readonly computerId: string;
  /**
   * Is that computer online NOW? The app re-reads the probed rows
   * (`loadRows` → `drawerTitle(...).canCreate`). A throw reads as offline.
   */
  readonly probe: () => Promise<boolean>;
  readonly session: DrawerNewSession;
  /** Open the drawer: it says why (the computer's status, or the create's error). */
  readonly showDrawer: () => void;
}

/**
 * New session from the HUB (fix/mobile-hub-new-session). The drawer's own gate
 * is the drawer TITLE's probe, which runs only while the drawer is open — so from
 * the hub, with the drawer never opened, "not probed yet" read as "offline" and
 * the tap did nothing at all. This probes first; online, it creates and opens the
 * session like the pill; otherwise — offline, or a create that failed — it opens
 * the drawer, which draws the reason. Never a silent no-op.
 */
export async function newSessionFromHub(deps: HubNewSessionDeps): Promise<void> {
  const online = await deps.probe().catch(() => false);
  if (!online) {
    deps.showDrawer();
    return;
  }
  await deps.session.start(deps.computerId, true);
  if (deps.session.state().error !== null) {
    deps.showDrawer();
  }
}
