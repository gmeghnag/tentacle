/**
 * The app's route names and the launch decision (docs/feat/mobile-app-shell.md;
 * 11b.1 adds the pairing params): pure, React-free, so the "which screen first"
 * rule is tested without a simulator. The stack's screens are `Pair` and
 * `Computers` → `Sessions` → `Session`.
 */

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
