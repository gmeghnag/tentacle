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
}

/** The stack's route table (`@react-navigation/native-stack` params). */
export type RootStackParams = {
  Pair: PairRouteParam | undefined;
  Computers: undefined;
  Sessions: SessionsRoute;
  Session: SessionRoute;
};

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
