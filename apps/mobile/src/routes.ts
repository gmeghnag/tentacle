/**
 * The app's route names and the launch decision (docs/feat/mobile-app-shell.md;
 * 11b.1 adds the pairing params): pure, React-free, so the "which screen first"
 * rule is tested without a simulator. The stack's screens are `Pair` and
 * `Computers` → `Sessions` → `Session`.
 */
import type { SheetKind, SheetRouteLike } from "./sheet-plan.ts";

export type { SheetKind };

export interface ComputerRoute {
  readonly computerId: string;
  readonly name: string;
}

export interface SessionsRoute {
  readonly computerId: string;
  readonly name: string;
  /** Opened from the drawer's magnifier (mobile-chrome Design 3): the search field is focused. */
  readonly search?: boolean;
}

export interface SessionRoute {
  readonly computerId: string;
  readonly sessionId: string;
  readonly title: string;
  /**
   * The session was in the list's Archived section. It is opened with the
   * `archived` banner and a Reopen button, and only that button sends
   * `open{reopen}` (Owner Q4: browsing the list never revives a session).
   */
  readonly archived: boolean;
  /** Just created by the drawer's New session (mobile-chrome S7): the composer is focused. */
  readonly focus?: boolean;
  /**
   * The session's working folder, as the list row knew it (`session/list`
   * `cwd`): the header shows it at once. Absent (a push, a new session) → the
   * screen asks `session/list` once (docs/feat/mobile-header-status.md).
   */
  readonly cwd?: string;
}

/**
 * `Pair`'s params (11b.1, Files 8): `again` is the computer this pairing
 * REPLACES — "Pair again" from a `revoked`/`maybe-reset`/`broken` row, and the
 * re-pair Owner Q7 allows. The id survives the re-pair, so rejoining it here
 * means the screen can say which computer it is about to replace (and the store
 * keeps one index entry).
 */
export interface PairRouteParam {
  /** The stored computer the new pairing replaces (its id). */
  readonly again?: string;
  /** That computer's name, for the review card (nothing is read from the store to show it). */
  readonly againName?: string;
  /**
   * The pairing text an incoming `tentacle://pair?…` link carried (11b.2, Owner
   * Q6). It enters the SAME intake as a paste and is therefore only PARSED on
   * the way in: the review card follows, and nothing is dialled until the person
   * taps Pair (F-P17). `link` names it so the screen can tell a link from a paste
   * (a link is submitted once, on arrival — never re-submitted on a re-render).
   */
  readonly linkText?: string;
}

/**
 * The artifacts gallery's route (docs/feat/model-artifacts.md D9). It carries the
 * session it lists and how the person got there, so the screen can say "Reopen to
 * view" on an archived session and a flow can tell the three entries apart.
 */
export interface ArtifactGalleryRoute {
  readonly computerId: string;
  readonly sessionId: string;
  readonly title: string;
  /** The session was in the Archived section: its bytes need an explicit reopen. */
  readonly archived: boolean;
  readonly from: "session-info" | "hub" | "card";
  /** A card's artifact id: the gallery opens ITS viewer at once (`galleryItemFor`). */
  readonly open?: string;
}

/**
 * The native sheets' route (docs/feat/mobile-native-sheets.md D1): ONE route, five
 * kinds. Its params carry only identity and the kind — never content, because the
 * session screen publishes each sheet's element on `SHEET_HOSTS` (`sheet-host.ts`)
 * and the route reads it back (`sheetRouteView`). `SheetKind` is re-exported from
 * the pure module so the route table and `sheetOptions` cannot disagree.
 */
export interface SheetRouteParam {
  readonly computerId: string;
  readonly sessionId: string;
  readonly kind: SheetKind;
  /**
   * Session info was opened with a section to land on (`openScheduled`), so the
   * list scrolls inside the sheet: it opens at the LARGEST detent (`initialDetent`).
   * Every other kind ignores it.
   */
  readonly reveal?: boolean;
  /**
   * The ask's own id (`PermissionRequestOptions.requestId`), on Permission only:
   * the detent memory is keyed on it (`sheetIdentity`), so a re-delivery of the
   * SAME ask keeps the detent the person left it at (D3, Step 0b L3).
   */
  readonly askId?: string;
  /**
   * The ask on this route is still UNANSWERED (D5). It rides the params because
   * the navigator resolves a route's options before its screen mounts, and
   * `gestureEnabled` is an option: the sheet must be un-swipeable from the very
   * first frame, not one render later. The screen rewrites it in place with a
   * keyed `SET_PARAMS` once the ask settles (`updateSheetParams`).
   */
  readonly asking?: boolean;
}

/** The stack's route table (`@react-navigation/native-stack` params). */
export type RootStackParams = {
  Pair: PairRouteParam | undefined;
  Computers: undefined;
  Sessions: SessionsRoute;
  Session: SessionRoute;
  /** The Settings screen (docs/feat/mobile-lock.md D6): app lock + Export logs. No params. */
  Settings: undefined;
  /** The artifacts gallery (docs/feat/model-artifacts.md D9): a session's artifacts. */
  ArtifactGallery: ArtifactGalleryRoute;
  /**
   * A native sheet (docs/feat/mobile-native-sheets.md D1), presented as an iOS
   * `formSheet` with three detents. Pushed with `push` (a second sheet must
   * STACK, never replace params) and closed with a keyed `pop` of its own key.
   */
  Sheet: SheetRouteParam;
};

/**
 * The artifacts gallery's ONE entry (D9): Session info's row, a transcript card,
 * and — in `feat/mobile-hub` — the hub's badge all call this, so the route's
 * params are built in one place. Nothing is dialled here; the screen reads the
 * feed the session screen already published.
 */
export function openArtifactGallery(
  nav: { navigate(name: "ArtifactGallery", params: ArtifactGalleryRoute): void },
  input: ArtifactGalleryRoute,
): void {
  nav.navigate("ArtifactGallery", {
    computerId: input.computerId,
    sessionId: input.sessionId,
    title: input.title,
    archived: input.archived,
    from: input.from,
    ...(input.open === undefined ? {} : { open: input.open }),
  });
}

/**
 * The narrow navigation surface a sheet uses — never the whole router object.
 * Mirrors `openArtifactGallery`: the screen's `useNavigation<SheetStackNavigation>()`
 * is cast from a generic prop, so the sheet paths are pinned HERE (a router
 * change that renamed `POP`'s `source` would break this file, not a screen).
 */
export interface SheetPopAction {
  readonly type: "POP";
  readonly payload: { readonly count: number };
  /** The route being removed — `StackRouter` looks the key up by it. */
  readonly source: string;
  /** The stack that owns it. */
  readonly target: string;
}

export interface SheetStackNavigation {
  push(name: "Sheet", params: SheetRouteParam): void;
  /** The two actions a sheet dispatches: a keyed `POP`, a keyed `SET_PARAMS`. */
  dispatch(action: SheetPopAction | SheetSetParamsAction): void;
  getState(): { readonly key: string; readonly routes: readonly SheetRouteLike[] };
  setOptions(options: { gestureEnabled?: boolean }): void;
}

/** The one in-place params rewrite a sheet makes: `SET_PARAMS`, keyed on its route. */
export interface SheetSetParamsAction {
  readonly type: "SET_PARAMS";
  /**
   * A PATCH, not the whole params: `BaseRouter` merges it over what the route
   * holds (`{ ...r.params, ...action.payload.params }`,
   * `routers@7.6.5/src/BaseRouter.tsx:18-39`), so the identity a sheet was pushed
   * with is never restated (and never silently dropped).
   */
  readonly payload: { readonly params: Partial<SheetRouteParam> };
  /** The route whose params change — `BaseRouter` looks it up by it. */
  readonly source: string;
  /** The stack that owns it. */
  readonly target: string;
}

/**
 * Rewrite ONE sheet's params in place (D5's `asking`, from `askingParamUpdate`'s
 * decision). Keyed on the route (`source`), like `popSheet`: an unkeyed one would
 * hit the WRONG route — the top of the stack, which is not necessarily ours. The
 * action is written out rather than taken from `StackActions`, so this module
 * stays free of a react-navigation import (it is loaded by `bun test`, where RN
 * does not).
 */
export function updateSheetParams(
  nav: Pick<SheetStackNavigation, "dispatch" | "getState">,
  key: string,
  params: Partial<SheetRouteParam>,
): void {
  nav.dispatch({
    type: "SET_PARAMS",
    payload: { params },
    source: key,
    target: nav.getState().key,
  });
}

/**
 * Open a native sheet (D1): `push`, never `navigate` — a second sheet must
 * STACK. `navigate` would reuse the one `Sheet` route and REPLACE its params,
 * which silently drops the sheet underneath (Outbox under a permission ask).
 */
export function openSheet(nav: Pick<SheetStackNavigation, "push">, params: SheetRouteParam): void {
  nav.push("Sheet", params);
}

/**
 * Close ONE sheet: a `pop` keyed on that route (`source`) and targeted at the
 * stack, which is what `StackRouter`'s `POP` needs to remove a single route
 * (`routers/src/StackRouter.tsx:557-578`). An unkeyed `goBack()` would pop the
 * route underneath — the Session itself when one sheet is up.
 *
 * The action is written out rather than taken from `StackActions.pop`, so this
 * module stays free of a react-navigation import (it is imported by tests under
 * `bun test`, where RN does not load).
 */
export function popSheet(
  nav: Pick<SheetStackNavigation, "dispatch" | "getState">,
  key: string,
): void {
  nav.dispatch({
    type: "POP",
    payload: { count: 1 },
    source: key,
    target: nav.getState().key,
  });
}

/**
 * Which screen the app opens on: `Pair` with no computer to show, else
 * `Computers`. A fresh install (nothing in the Keychain) therefore lands on the
 * pairing screen, never a bare list.
 */
export function initialRoute(computers: readonly unknown[]): "Pair" | "Computers" {
  return computers.length === 0 ? "Pair" : "Computers";
}

/**
 * Where the app goes after a store READ failure (F-K3/F-K4): `Computers`, which
 * shows the store error — never `Pair`, which would read as "nothing is paired"
 * and invite a person to pair over a store that a newer build wrote.
 */
export function routeForStoreError(failure: unknown): "Pair" | "Computers" {
  return failure === undefined || failure === null ? "Pair" : "Computers";
}
