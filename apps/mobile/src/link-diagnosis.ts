/**
 * Why a computer is not answering (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 3; task 9 F11).
 *
 * On `/e2e` the app can say something 11a could not. A Noise handshake gives
 * the phone an AUTHENTICATED verdict (`denied` → `unauthorized`: only the
 * daemon's static key can say it), so "this phone was removed" is a fact, not a
 * guess. A handshake that fails `closed`/`timeout` is NOT authenticated (an
 * on-path party can produce it), so one of them says nothing; THREE in a row,
 * each on a socket that actually OPENED, is the honest hint for a computer that
 * was reset (`tentacle devices reset` makes a new identity, so our pinned key is
 * simply wrong now — F-L3).
 *
 * Fed with the error OBJECT and whether the raw socket opened, never with the
 * link's `stopped.reason` TEXT (`link-machine.ts` writes prose; matching it
 * would be the text-matching bug this whole module exists to avoid).
 *
 * Pure and React-free: a reducer, so every rule is testable without a socket.
 */
import { ChannelError } from "@tentacle/client";

/** What the row says (and, for the first two, what the app offers). */
export type LinkDiagnosis = "ok" | "unreachable" | "revoked" | "maybe-reset";

/** One dial attempt's observable: did the raw socket open, and what did the handshake do? */
export interface DialObservation {
  /** The raw WebSocket dial resolved (so the path was there and the host answered). */
  readonly opened: boolean;
  /** What the attempt threw, if anything (a success is `ok()`). */
  readonly error?: unknown;
  /**
   * The relay said "no daemon registered for that id" (close `4404`, after the
   * stream opened and before the handshake — docs/feat/mobile-projects.md §6):
   * the project's `serve` is not running. NOT a hint of a reset, so it never
   * feeds `MAYBE_RESET_STREAK`.
   */
  readonly absent?: boolean;
}

/** How many opened-but-unconfirmed handshakes in a row hint at a reset (F11/Task 9). */
export const MAYBE_RESET_STREAK = 3;

export interface LinkDiagnoser {
  /** Record one failed attempt; returns what to show now. */
  observe(observation: DialObservation): LinkDiagnosis;
  /** A dial succeeded: everything is forgotten (the count resets). */
  ok(): LinkDiagnosis;
  /** What to show right now, without observing (a re-render keeps the last verdict). */
  current(): LinkDiagnosis;
  /** The last failed attempt was the relay's `4404` (the project's `serve` is not running). */
  absent(): boolean;
}

/**
 * Is this failure the computer's verdict about our key? Only `unauthorized`:
 * `secure-channel.ts` maps Noise `denied` to it, and nothing else produces it on
 * `/e2e` (P5) — a bad token cannot, because there is no token.
 */
function isUnauthorized(error: unknown): boolean {
  return error instanceof ChannelError && error.kind === "unauthorized";
}

export function createLinkDiagnoser(): LinkDiagnoser {
  /** Consecutive attempts that OPENED and then failed to confirm the handshake. */
  let streak = 0;
  let state: LinkDiagnosis = "ok";
  let absent = false;
  return {
    observe(observation: DialObservation): LinkDiagnosis {
      absent = false;
      if (isUnauthorized(observation.error)) {
        // Terminal and authenticated: the count is irrelevant.
        streak = 0;
        state = "revoked";
        return state;
      }
      if (observation.absent === true) {
        // A stopped project's relay address: the relay itself said nobody is
        // registered. Says nothing about our key — the streak is left alone.
        absent = true;
        state = "unreachable";
        return state;
      }
      if (!observation.opened) {
        // The socket never opened: the computer is not reachable, and this says
        // NOTHING about its identity — so it must not feed the reset hint.
        state = "unreachable";
        return state;
      }
      streak += 1;
      state = streak >= MAYBE_RESET_STREAK ? "maybe-reset" : "unreachable";
      return state;
    },
    ok(): LinkDiagnosis {
      streak = 0;
      absent = false;
      state = "ok";
      return state;
    },
    current(): LinkDiagnosis {
      return state;
    },
    absent(): boolean {
      return absent;
    },
  };
}

/** The sentence for a diagnosis (empty for `ok`: a working computer shows no status). */
export function diagnosisMessage(diagnosis: LinkDiagnosis, computerName: string): string {
  switch (diagnosis) {
    case "ok":
      return "";
    case "revoked":
      return `This phone was removed from '${computerName}' — pair again, or remove it here`;
    case "maybe-reset":
      return `'${computerName}' may have been reset (\`tentacle devices reset\`) — pair again`;
    case "unreachable":
      // Covers F23 (an older tentacle has no `/e2e`): its 401/refused upgrade is
      // a dial that never opened, and "update it" is the fix. The relay is named
      // because it IS a path a phone can take (docs/feat/mobile-relay.md R6):
      // with one paired, "nowhere to go" usually means the daemon's relay is off
      // (`serve --no-relay`, an unreadable `relay.json`) rather than no network.
      return `Can't reach '${computerName}' — same network, Tailscale, or the relay? \`tentacle serve --host 0.0.0.0\` running and up to date?`;
  }
}
