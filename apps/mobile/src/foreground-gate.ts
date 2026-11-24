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
 *   and holds the next dial;
 * - `resume()` releases the ONE dial that is waiting; `suspend()`/`resume()` are
 *   idempotent (iOS delivers `inactive` then `background`, and `active` twice);
 * - a channel that arrives while suspended is CLOSED and never handed out
 *   (a dial that started before the app left the foreground must not leave a
 *   live socket behind it), and the dial then waits like any other;
 * - **a dial the client ABANDONED never dials and never hands a channel out.**
 *   The client bounds a dial by `LIVENESS_MS` and gives up on it
 *   (`remote-client.ts` `dialChannel`), while the dial itself stays parked in
 *   this gate; a background longer than that leaves a stale caller behind, and
 *   releasing it would dial a second socket (closed by `dialChannel`, but only
 *   after this gate had made it `current` — then `suspend()` closes a dead
 *   socket and the live one stays up: the ghost attachment this gate exists to
 *   avoid). So the gate keeps a generation: the newest `dial()` supersedes every
 *   earlier one still parked, which then fails like a failed dial without
 *   touching the socket, and `current` is only ever the channel the newest
 *   caller received.
 */
import { ChannelError } from "@tentacle/client";
import type { DuplexChannel } from "@tentacle/transport";

/** Why an abandoned (superseded) dial fails: no socket was opened for it. */
function superseded(): ChannelError {
  return new ChannelError("unreachable", "this dial was superseded by a newer one");
}

export type ForegroundAction = "suspend" | "resume" | null;

export function foregroundAction(state: string | null | undefined): ForegroundAction {
  if (state === "active") return "resume";
  if (state === "background") return "suspend";
  return null;
}

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
  /**
   * Hold the socket open for up to `ms`, from a BACKGROUND task that needs one
   * dial (docs/feat/mobile-notifications.md Design 4 / N6: a notification's
   * Deny or Reply answers while iOS has the app suspended).
   *
   * It does exactly one thing `suspend()` would undo: it keeps a dial from being
   * parked, and keeps the socket it produced from being closed, until the
   * returned release is called or `ms` elapses. Returns the release: idempotent,
   * and safe to call from a `finally`.
   *
   * Bounded by the caller's own iOS budget (Design 4 step 2: `budgetMs`, ≤ 25 s)
   * — this gate never holds a socket for a person who has walked away.
   */
  hold(ms: number): () => void;
}

export function createForegroundGate(
  inner: () => Promise<DuplexChannel>,
  /** Injected so a test drives the hold's expiry without waiting (`setTimeout`). */
  clock: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): ForegroundGate {
  let suspended = false;
  /** The channel handed out last: `suspend()` closes it (the client's drop). */
  let current: DuplexChannel | null = null;
  /** Resolves the dial waiting while suspended; null when none is. */
  let release: (() => void) | null = null;
  let held: Promise<void> = Promise.resolve();
  /** The newest dial's generation: an older, still-parked dial is abandoned. */
  let generation = 0;
  /**
   * How many background tasks are holding the socket open right now, and the
   * timer that ends each (docs/feat/mobile-notifications.md Design 4). While it
   * is above zero a dial is NOT parked and a freshly dialled channel is KEPT: an
   * answer is on its way out.
   */
  let holds = 0;
  const holdTimers = new Set<unknown>();

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
      const mine = ++generation;
      const abandoned = (): boolean => mine !== generation;
      for (;;) {
        if (suspended && holds === 0) {
          await hold();
        }
        if (abandoned()) {
          // A newer dial took over (the client gave this attempt up while it was
          // held): dialling now would open a socket nobody awaits.
          throw superseded();
        }
        const channel = await inner();
        if (abandoned()) {
          channel.close();
          throw superseded();
        }
        if (!suspended || holds > 0) {
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
    hold(ms: number): () => void {
      holds += 1;
      // A dip in the middle of the hold: `resume` hands a parked dial back
      // (there is none: while suspended a dial waits for `resume`), so the only
      // thing to do is to NOT park the dial this hold exists for.
      if (suspended) {
        releaseHold();
      }
      let released = false;
      const finish = (): void => {
        if (released) {
          return;
        }
        released = true;
        holds = Math.max(0, holds - 1);
        if (ownsTimer !== undefined) {
          holdTimers.delete(ownsTimer);
          clock.clearTimeout(ownsTimer);
        }
      };
      const ownsTimer = clock.setTimeout(finish, ms);
      holdTimers.add(ownsTimer);
      return finish;
    },
  };
}
