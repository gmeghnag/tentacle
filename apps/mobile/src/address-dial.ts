/**
 * Which address of a computer to dial (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 3; decision 2: "the app keeps several addresses per computer and tries
 * them in order"), and since docs/feat/mobile-relay.md R6 a **staggered race**
 * instead of a strict sequence (Owner Q6, "happy eyeballs", RFC 8305 style).
 *
 * Why a race at all: the address list is "direct first, relay last"
 * (`pair-addresses.ts`), and the relay exists for the networks where a direct
 * address does not answer. Dialling strictly in order means the app waits out
 * every dead direct address before the relay is ever tried — on a phone that is
 * off the LAN a `ws://192.168.x.y:4000/e2e` hangs in TCP connect, and the
 * client's 15 s dial deadline (`LINK_LIVENESS`) can expire first. Then the relay
 * fallback it was paired for never happens. So:
 *
 * - address *i* is started; if its SOCKET has not opened after {@link STAGGER_MS},
 *   address *i+1* starts too, and so on down the list;
 * - the FIRST socket to open wins the race, and only the winner goes on to the
 *   Noise handshake;
 * - every loser is CLOSED before any handshake (`abandon`), so a losing relay
 *   leg leaves no daemon-side state at all: its stream closes pre-handshake and
 *   its handshake-limiter slot goes back (R2's relay and `acceptDevice` both
 *   count that, so a race must not spend slots it does not use);
 * - the loop still STARTS at the address that answered last time (a laptop whose
 *   Tailscale address is up should not re-pay the failing Wi-Fi one on every
 *   dial). The memory is in-process only: nothing is persisted (Notes/debt);
 * - `unauthorized` still STOPS everything and is rethrown. A Noise `denied`
 *   needs the computer's own static key, so it is the computer's verdict about
 *   THIS phone's key (revoked, or the computer was reset) — no other address can
 *   change it, and dialling one anyway would be pointless (and, with the race,
 *   would mean spending the other paths' sockets on a decided question).
 *
 * The race is decided at SOCKET-OPEN, not at handshake, because that is the step
 * that distinguishes "this path is not there" (a LAN address off-network) from
 * "this path answered" — and because it is the only step that can be raced
 * without building daemon-side state per attempt.
 *
 * Pure and React-free (AGENTS §7) with the timer injected: no test waits 750 ms,
 * and every rule below is decided in one place, not across components.
 */
import { ChannelError } from "@tentacle/client";

/** How long an unopened address holds the next one back (`STAGGER_MS`, Owner Q6). */
export const STAGGER_MS = 750;

/** A timer seam: the app passes `setTimeout`, a test fires the callback by hand. */
export interface DialTimer {
  schedule(fn: () => void, ms: number): { readonly cancel: () => void };
}

/** The app's own timer (the same shape as `outbox-drafts.ts`'s, one per policy). */
const systemTimer: DialTimer = {
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

/** Where to dial, and what answered (the whole memory a link keeps between dials). */
export interface DialMemory {
  /** The index of the address that last answered, if any. */
  lastGood: number | undefined;
}

/** One attempt's failure: which address, and what it threw (a diagnosis reads these). */
export interface DialFailure {
  readonly address: string;
  readonly error: unknown;
}

/**
 * One address's dial, in the two steps the race needs: opening the raw path is
 * what wins or loses, and the handshake happens only on the winner.
 */
export interface DialSteps<TOpened, TAnswer> {
  /** Open the raw path at this address. The race is decided when THIS settles. */
  open(address: string): Promise<TOpened>;
  /** Close a path that lost the race — before any handshake is sent on it. */
  abandon(opened: TOpened): void;
  /** The handshake, on the one path whose socket opened first. */
  confirm(opened: TOpened): Promise<TAnswer>;
}

export interface FirstAnsweringOptions {
  /** The stagger timer (default: real `setTimeout`; a test injects a hand-driven one). */
  readonly timer?: DialTimer;
  /** Override {@link STAGGER_MS} (a test's own scale; production reads the constant). */
  readonly staggerMs?: number;
}

/**
 * Is this failure the COMPUTER's verdict about our key (terminal), rather than
 * a path/reachability problem? Only `unauthorized` is: `secure-channel.ts` maps
 * a Noise `denied` to it, and only the daemon's static key can say `denied`.
 */
export function isTerminalDialError(error: unknown): boolean {
  return error instanceof ChannelError && error.kind === "unauthorized";
}

/** One address of the ring, with the index the caller's array gave it. */
interface Candidate {
  readonly address: string;
  readonly index: number;
  /** Where it sits in the current round's list (what a fall-through slices on). */
  readonly position: number;
}

/** One round's verdict: something answered, or the winner failed (and where it was). */
type RaceOutcome<TAnswer> =
  | { readonly kind: "answered"; readonly value: TAnswer; readonly index: number }
  /**
   * No answer. `at` is the position of the round's winner when one OPENED and
   * failed its handshake (the addresses after it are still worth trying); it is
   * `undefined` when nothing opened at all, so nothing is left to try.
   */
  | { readonly kind: "failed"; readonly error: unknown; readonly at: number | undefined };

/**
 * Try each address, starting at the remembered good one, racing them as
 * described in this module's header, and return the first success. A terminal
 * failure is rethrown as-is (`unauthorized`, F-L1/F-L2); any other failure falls
 * through to the remaining addresses; when none answers, the LAST error is
 * thrown UNCHANGED — its own kind and message are what the link machine and
 * `describeError` classify, so wrapping it would only hide them. A success
 * updates `memory.lastGood`.
 */
export async function firstAnswering<TOpened, TAnswer>(
  addresses: readonly string[],
  steps: DialSteps<TOpened, TAnswer>,
  memory: DialMemory,
  options: FirstAnsweringOptions = {},
): Promise<TAnswer> {
  if (addresses.length === 0) {
    throw new ChannelError("unreachable", "this computer has no address to dial");
  }
  const start =
    memory.lastGood !== undefined && memory.lastGood < addresses.length ? memory.lastGood : 0;
  // The ring: the remembered good address first, then the rest in list order.
  // `index` is the caller's array position (what `lastGood` means); a round's
  // `position` is where it stands in THIS order, which is what a fall-through
  // slices on.
  const ring: number[] = addresses.map((_address, offset) => (start + offset) % addresses.length);
  let round = roundOf(ring, addresses);
  let last: unknown;
  while (round.length > 0) {
    const outcome = await raceOnce(round, steps, options.timer ?? systemTimer, options.staggerMs);
    if (outcome.kind === "answered") {
      memory.lastGood = outcome.index;
      return outcome.value;
    }
    last = outcome.error;
    if (isTerminalDialError(outcome.error)) {
      throw outcome.error;
    }
    // A winner that OPENED and then failed its handshake is a path that is
    // wrong, not absent: the addresses after it have not been answered yet, so
    // the race resumes there (a leg we abandoned mid-round is dialled again —
    // that is the same fresh dial a redial makes).
    round = outcome.at === undefined ? [] : round.slice(outcome.at + 1);
  }
  throw last ?? new ChannelError("unreachable", "no pairing address answered");
}

/**
 * ONE round of the ring, numbered: `position` is where a candidate stands in this
 * round's order (what a fall-through slices on), `index` is its address's place
 * in the caller's array (what `memory.lastGood` means — the two differ once the
 * remembered good address moves the start).
 */
function roundOf(ring: readonly number[], addresses: readonly string[]): Candidate[] {
  return ring.map((index, position) => ({ address: addresses[index] ?? "", index, position }));
}

/**
 * ONE staggered race over `round`. Resolves as soon as one socket opens (the
 * winner's handshake then decides) or when every address has been started and
 * none opened. Never leaves a socket behind: a path that opens after the race is
 * decided — or after the winner's handshake — is `abandon`ed on arrival.
 */
function raceOnce<TOpened, TAnswer>(
  round: readonly Candidate[],
  steps: DialSteps<TOpened, TAnswer>,
  timer: DialTimer,
  staggerMs: number | undefined,
): Promise<RaceOutcome<TAnswer>> {
  const stagger = staggerMs ?? STAGGER_MS;
  return new Promise((resolve) => {
    let next = 0;
    /** Opens still in flight (the round cannot be called "all failed" while any is). */
    let inFlight = 0;
    /** A socket has opened: no address starts after this one, the race is decided. */
    let winner = false;
    let settled = false;
    let armed: { readonly cancel: () => void } | undefined;
    let lastError: unknown;

    const finish = (outcome: RaceOutcome<TAnswer>): void => {
      if (settled) {
        return;
      }
      settled = true;
      armed?.cancel();
      armed = undefined;
      resolve(outcome);
    };

    /** Arm the stagger for the NEAREST unstarted address, if there is one. */
    const arm = (): void => {
      if (settled || winner || next >= round.length) {
        return;
      }
      armed = timer.schedule(startNext, stagger);
    };

    const startNext = (): void => {
      armed = undefined;
      if (settled || winner) {
        return;
      }
      const candidate = round[next];
      if (candidate === undefined) {
        return;
      }
      next += 1;
      inFlight += 1;
      // Armed BEFORE the open is awaited, so the timer covers an open that hangs
      // (the whole point: a socket that never opens must not hold the list back).
      arm();
      steps.open(candidate.address).then(
        (opened) => {
          inFlight -= 1;
          onOpened(candidate, opened);
        },
        (error: unknown) => {
          inFlight -= 1;
          if (settled || winner) {
            return; // late, and the round is already decided
          }
          lastError = error;
          if (next >= round.length && inFlight === 0) {
            finish({ kind: "failed", error: lastError, at: undefined });
          }
        },
      );
    };

    const onOpened = (candidate: Candidate, opened: TOpened): void => {
      if (settled || winner) {
        // A loser: closed BEFORE any handshake, so it leaves no daemon state.
        steps.abandon(opened);
        return;
      }
      winner = true;
      armed?.cancel();
      armed = undefined;
      steps.confirm(opened).then(
        (value) => finish({ kind: "answered", value, index: candidate.index }),
        (error: unknown) => finish({ kind: "failed", error, at: candidate.position }),
      );
    };

    startNext();
  });
}
