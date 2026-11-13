/**
 * The app's foreground gate (docs/feat/mobile-session-view.md 12a.4): a pure
 * wrapper around a link's `channelFactory`, so the app can drop its socket when
 * iOS backgrounds it and hold the redial until it is active again.
 *
 * Why a gate at all (Owner Q3, plan P6): the client has no keepalive of its own,
 * and `serve` closes a silent socket only after 60 s — without this, a
 * backgrounded phone leaves a ghost attachment for up to a minute and comes
 * back to a socket nobody told it was dead. Closing on background and redialling
 * on foreground turns that into the client's ordinary drop + redial, so its
 * existing replay/resync path (and the daemon's re-offer of a pending ask)
 * does the recovery. No new transport, no second session path (AGENTS §7).
 *
 * Rules this module owns, all decided here so they are testable without a
 * simulator:
 * - `suspend()` closes the LIVE channel (the client then treats it as a drop)
 *   and holds the next dial(s);
 * - `resume()` releases them; `suspend()`/`resume()` are idempotent (iOS
 *   delivers `inactive` then `background`, and `active` twice);
 * - a channel that arrives while suspended is CLOSED and never handed out
 *   (a dial that started before the app left the foreground must not leave a
 *   live socket behind it), and the dial then waits like any other.
 */
import type { DuplexChannel } from "@tentacle/transport";

export interface ForegroundGate {
  /**
   * The wrapped factory: the ONE the client dials with. Rejects/behaves exactly
   * like the inner one, except while suspended (it then waits).
   */
  readonly dial: () => Promise<DuplexChannel>;
  /** The app left the foreground: hold dials, drop the live socket. */
  suspend(): void;
  /** The app is active: let the pending dial through. */
  resume(): void;
  /** Whether dials are held now (the screen's banner does not read this; tests do). */
  readonly isSuspended: boolean;
}

export function createForegroundGate(inner: () => Promise<DuplexChannel>): ForegroundGate {
  let suspended = false;
  /** The channel handed out last: `suspend()` closes it (the client's drop). */
  let current: DuplexChannel | null = null;
  /** Resolves the dials waiting while suspended; null when none are. */
  let release: (() => void) | null = null;
  let held: Promise<void> = Promise.resolve();

  /** The promise every dial waits on while suspended (one shared hold). */
  function hold(): Promise<void> {
    if (release === null) {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return held;
  }

  function releaseHold(): void {
    const resolve = release;
    release = null;
    held = Promise.resolve();
    resolve?.();
  }

  return {
    async dial(): Promise<DuplexChannel> {
      for (;;) {
        if (suspended) {
          await hold();
        }
        const channel = await inner();
        if (!suspended) {
          current = channel;
          return channel;
        }
        // Dialled while the app was leaving the foreground: a live socket now
        // would be the ghost attachment this gate exists to avoid.
        channel.close();
      }
    },
    suspend(): void {
      if (suspended) {
        return; // `inactive` then `background`: the same state, once
      }
      suspended = true;
      void hold(); // armed before the close, so a dial in flight waits, not dials
      const live = current;
      current = null;
      live?.close();
    },
    resume(): void {
      if (!suspended) {
        return;
      }
      suspended = false;
      releaseHold();
    },
    get isSuspended(): boolean {
      return suspended;
    },
  };
}
