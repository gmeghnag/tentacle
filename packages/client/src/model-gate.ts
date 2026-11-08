/**
 * A bounded gate for the named model calls a pod can cause
 * (docs/feat/models-map-pod.md, F7). Pure: no timer, no I/O.
 *
 * At most `limit` calls are inside; up to `maxWaiting` wait, in order; any more
 * is refused at once. It bounds how fast a pod can spend on a paid entry, not
 * how much. A waiter only holds its own handler: the peer stays concurrent
 * (AGENTS §7, "Don't serialize the RPC peer").
 */

/** Why a call did not get in. */
export class CallGateError extends Error {
  constructor(readonly reason: "full" | "aborted" | "dropped") {
    super(`call gate: ${reason}`);
    this.name = "CallGateError";
  }
}

export interface CallGate {
  /** Resolves with the call's release once a slot is free (a second release is a no-op). */
  enter(signal?: AbortSignal): Promise<() => void>;
  /** Refuse everything still waiting (its link is gone). Running calls keep their slots. */
  dropWaiting(): void;
}

interface Waiter {
  admit(): void;
  drop(): void;
}

export function createCallGate(limit: number, maxWaiting: number): CallGate {
  let inside = 0;
  const waiting: Waiter[] = [];

  const releaser = (): (() => void) => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inside -= 1;
      admitNext();
    };
  };

  const admitNext = (): void => {
    while (inside < limit) {
      const next = waiting.shift();
      if (!next) {
        return;
      }
      inside += 1;
      next.admit();
    }
  };

  return {
    enter(signal) {
      if (signal?.aborted) {
        return Promise.reject(new CallGateError("aborted"));
      }
      if (inside < limit && waiting.length === 0) {
        inside += 1;
        return Promise.resolve(releaser());
      }
      if (waiting.length >= maxWaiting) {
        return Promise.reject(new CallGateError("full"));
      }
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) {
            waiting.splice(at, 1);
            reject(new CallGateError("aborted"));
          }
        };
        const waiter: Waiter = {
          admit() {
            signal?.removeEventListener("abort", onAbort);
            resolve(releaser());
          },
          drop() {
            signal?.removeEventListener("abort", onAbort);
            reject(new CallGateError("dropped"));
          },
        };
        waiting.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    dropWaiting() {
      for (const waiter of waiting.splice(0)) {
        waiter.drop();
      }
    },
  };
}
