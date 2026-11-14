/**
 * Which address of a computer to dial (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 3; decision 2: "the app keeps several addresses per computer and tries
 * them in order").
 *
 * Pure and React-free, so the one rule with a branch is testable without a
 * socket. Two behaviours, both load-bearing:
 * - the loop STARTS at the address that answered last time (a laptop whose
 *   Tailscale address is up should not re-pay the failing Wi-Fi one on every
 *   dial). The memory is in-process only: nothing is persisted (Notes/debt).
 * - `unauthorized` STOPS the loop and is rethrown. A Noise `denied` needs the
 *   computer's own static key, so it is the computer's verdict about THIS
 *   phone's key (revoked, or the computer was reset) — no second address can
 *   change it, and falling through would dial a live computer pointlessly. Same
 *   rule as `pairDevice`'s (P1).
 */
import { ChannelError } from "@tentacle/client";

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
 * Is this failure the COMPUTER's verdict about our key (terminal), rather than
 * a path/reachability problem? Only `unauthorized` is: `secure-channel.ts` maps
 * a Noise `denied` to it, and only the daemon's static key can say `denied`.
 */
export function isTerminalDialError(error: unknown): boolean {
  return error instanceof ChannelError && error.kind === "unauthorized";
}

/**
 * Try each address, starting at the remembered good one, and return the first
 * success. A terminal failure is rethrown as-is (`unauthorized`, F-L1/F-L2);
 * any other failure falls through to the next address; when none answers, the
 * LAST error is thrown UNCHANGED — its own kind and message are what the link
 * machine and `describeError` classify, so wrapping it would only hide them.
 * A success updates `memory.lastGood`.
 */
export async function firstAnswering<T>(
  addresses: readonly string[],
  attempt: (address: string) => Promise<T>,
  memory: DialMemory,
): Promise<T> {
  if (addresses.length === 0) {
    throw new ChannelError("unreachable", "this computer has no address to dial");
  }
  const start =
    memory.lastGood !== undefined && memory.lastGood < addresses.length ? memory.lastGood : 0;
  let last: DialFailure | undefined;
  for (let step = 0; step < addresses.length; step += 1) {
    const index = (start + step) % addresses.length;
    const address = addresses[index];
    if (address === undefined) {
      continue;
    }
    try {
      const result = await attempt(address);
      memory.lastGood = index;
      return result;
    } catch (error) {
      if (isTerminalDialError(error)) {
        throw error;
      }
      last = { address, error };
    }
  }
  throw last?.error ?? new ChannelError("unreachable", "no pairing address answered");
}
