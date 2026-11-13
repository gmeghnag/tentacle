/**
 * The app's route names and the launch decision (docs/feat/mobile-app-shell.md):
 * pure, React-free, so the "which screen first" rule is tested without a
 * simulator. The stack's screens are `Pair` (paired computers are task 9) and
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
}

/** The stack's route table (`@react-navigation/native-stack` params). */
export type RootStackParams = {
  Pair: undefined;
  Computers: undefined;
  Sessions: SessionsRoute;
  Session: SessionRoute;
};

/**
 * Which screen the app opens on: `Pair` with no computer to show, else
 * `Computers`. A build with no dev environment (the only source in 11a)
 * therefore lands on the pairing placeholder, never a bare list.
 */
export function initialRoute(computers: readonly unknown[]): "Pair" | "Computers" {
  return computers.length === 0 ? "Pair" : "Computers";
}
