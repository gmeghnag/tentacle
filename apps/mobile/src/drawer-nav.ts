/**
 * Where a drawer pick goes, and the drawer's own UI state
 * (docs/feat/mobile-chrome.md Design 3, F1/F4/F6). Pure and React-free
 * (AGENTS §7): the screen calls `navigation.replace`/`reset` with exactly what
 * `drawerTarget` returns, and the drawer component holds no branching.
 *
 * - Same computer → `replace` the Session route (no stack growth).
 * - Another computer → `reset` to `[Computers, Sessions(B), Session(B, x)]`, so
 *   the edge back-swipe (which keeps meaning back, F1) lands on the RIGHT
 *   computer's list (F4).
 * - The open session itself → `stay` (just close: no remount, no detach).
 * A switch only unmounts the old screen — it detaches, never closes (F6).
 */
import type { RootStackParams, SessionRoute } from "./routes.ts";

/** A tapped drawer row, with the computer the drawer was listing. */
export interface DrawerPick {
  readonly computerId: string;
  /** For the Sessions route under it (`SessionsRoute.name`). */
  readonly computerName: string;
  readonly sessionId: string;
  readonly title: string;
  /** From the Archived section: opened with `archived: true`, never reopened. */
  readonly archived: boolean;
}

export type DrawerStackRoute =
  | { readonly name: "Computers" }
  | { readonly name: "Sessions"; readonly params: RootStackParams["Sessions"] }
  | { readonly name: "Session"; readonly params: SessionRoute };

export type DrawerNav =
  | { readonly kind: "stay" }
  | { readonly kind: "replace"; readonly route: DrawerStackRoute }
  | { readonly kind: "reset"; readonly routes: readonly DrawerStackRoute[] };

export function drawerTarget(from: SessionRoute, pick: DrawerPick): DrawerNav {
  const sameComputer = pick.computerId === from.computerId;
  if (sameComputer && pick.sessionId === from.sessionId) {
    return { kind: "stay" };
  }
  const session: DrawerStackRoute = {
    name: "Session",
    params: {
      computerId: pick.computerId,
      sessionId: pick.sessionId,
      title: pick.title,
      archived: pick.archived,
    },
  };
  if (sameComputer) {
    return { kind: "replace", route: session };
  }
  return {
    kind: "reset",
    routes: [
      { name: "Computers" },
      { name: "Sessions", params: { computerId: pick.computerId, name: pick.computerName } },
      session,
    ],
  };
}

/** The drawer's local state: not persisted, so every open restarts on the open session's computer. */
export interface DrawerState {
  readonly open: boolean;
  /** The computer the drawer LISTS (the open session does not change until a row is tapped). */
  readonly computerId: string;
  /** The person's archived toggle; null = automatic (`drawerList`). */
  readonly archivedOpen: boolean | null;
  /** The computer menu under the title. */
  readonly menuOpen: boolean;
}

export type DrawerAction =
  /** The hamburger tap (F1: the only opener); `computerId` = the open session's. */
  | { readonly type: "open"; readonly computerId: string }
  | { readonly type: "close" }
  | { readonly type: "select-computer"; readonly computerId: string }
  /** `shown` = whether the section is shown NOW (`drawerList`'s `archived.rows !== null`). */
  | { readonly type: "toggle-archived"; readonly shown: boolean }
  | { readonly type: "menu"; readonly open: boolean };

/**
 * The id `drawerList` highlights: the open session's, but only while the
 * drawer lists the open session's OWN computer (a session id is per daemon, so
 * the same id on another computer is a different session).
 */
export function drawerCurrentId(state: DrawerState, from: SessionRoute): string | null {
  return state.computerId === from.computerId ? from.sessionId : null;
}

export function initialDrawer(computerId: string): DrawerState {
  return { open: false, computerId, archivedOpen: null, menuOpen: false };
}

export function drawerReducer(state: DrawerState, action: DrawerAction): DrawerState {
  switch (action.type) {
    case "open":
      return { open: true, computerId: action.computerId, archivedOpen: null, menuOpen: false };
    case "close":
      return { ...state, open: false, menuOpen: false };
    case "select-computer":
      return { ...state, computerId: action.computerId, archivedOpen: null, menuOpen: false };
    case "toggle-archived":
      return { ...state, archivedOpen: !action.shown };
    case "menu":
      return { ...state, menuOpen: action.open };
    default:
      return state;
  }
}
