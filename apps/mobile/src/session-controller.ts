/**
 * One computer's session lifecycle (docs/feat/mobile-session-view.md 12a.3):
 * open (attach), leave (detach, NEVER close), and the typed reason an open
 * failed with. Pure and injected — the client is a seam (`newSession`) — so the
 * rules below are tested without React, a simulator or a daemon.
 *
 * Rules this module owns:
 * - **Per session id, serialised.** An `open` issued while the same id's
 *   `detach` is still in flight WAITS for it: the client's session table is
 *   keyed by id, so a fast back-then-forward would otherwise re-open an entry
 *   that the detach is about to remove (`remote-client.ts:1384-1391`) and leave
 *   two listeners on one session (F17).
 * - **Leaving detaches.** `leave` is `RemoteSession.detach` (`session/detach`):
 *   the session keeps running for every client (decision 4). It is never
 *   `close()`, which is `session/close` and ends it (Hazard 3).
 * - **An open never throws a raw error at a screen.** It answers a typed reason
 *   decided by error CLASS/CODE — never by message text, which a pod daemon
 *   chooses (AGENTS §7 "a pod is not trusted").
 */
import { AttachTimeoutError, type SessionActivity } from "@tentacle/client";
import { DomainErrorCode, RpcError } from "@tentacle/transport";

/** Why an open failed, as the screen's banner names it (plan F14–F16, F24 later). */
export type SessionOpenFailure =
  /** `SessionArchived`: ended and kept; only an explicit `open{reopen}` reloads it. */
  | "archived"
  /** `SessionDeleted`: removed for good; never recreated. */
  | "deleted"
  /** `UnknownSession`: the daemon does not have it (never created, or lost with a restarted pod). */
  | "gone"
  /** `TooManySessions`: a reopen past the daemon's session cap; the record stays archived. */
  | "too-many"
  /** No answer in `ATTACH_TIMEOUT_MS`: nothing was created. */
  | "timeout"
  /** Anything else: the link (down, refused, an older daemon). */
  | "link";

/** What an open handed back, or the typed reason it failed with. */
export type OpenSessionResult<S extends SessionHandle> =
  | { readonly ok: true; readonly session: S }
  | { readonly ok: false; readonly reason: SessionOpenFailure };

/** The subset of `RemoteSession` this module drives (a seam: tests use a fake). */
export interface SessionHandle {
  open(): Promise<void>;
  detach(): Promise<void>;
  watch(listener: (activity: SessionActivity) => void): () => void;
}

export interface OpenOptions {
  /** Reload an ARCHIVED session (the person's Reopen). Absent: an archived id fails `archived`. */
  readonly reopen?: boolean;
  /** What the session does that this client did not start (turns, history, closed). */
  readonly watch?: (activity: SessionActivity) => void;
}

export interface SessionController<S extends SessionHandle> {
  /** Attach to `sessionId` (never create). Serialised per id; no throw. */
  open(sessionId: string, options?: OpenOptions): Promise<OpenSessionResult<S>>;
  /** Stop following it (`session/detach`): the session keeps running for everyone. */
  leave(sessionId: string): Promise<void>;
  /** Drop every subscription and forget every handle; in-flight opens are ignored. */
  dispose(): void;
  /** Whether this controller currently follows `sessionId`. */
  readonly follows: (sessionId: string) => boolean;
}

export interface SessionControllerDeps<S extends SessionHandle> {
  /** Build the client's session for `sessionId` (the app passes `client.newSession(…, {attach})`). */
  readonly newSession: (sessionId: string, options: { readonly reopen?: boolean }) => S;
}

/**
 * The typed reason for a failed open, by class then code. A pod daemon's message
 * text is never read: a plain `Error("archived")` is `link`.
 */
export function openFailureReason(error: unknown): SessionOpenFailure {
  if (error instanceof AttachTimeoutError) {
    return "timeout";
  }
  if (error instanceof RpcError) {
    switch (error.code) {
      case DomainErrorCode.SessionArchived:
        return "archived";
      case DomainErrorCode.SessionDeleted:
        return "deleted";
      case DomainErrorCode.UnknownSession:
        return "gone";
      case DomainErrorCode.TooManySessions:
        return "too-many";
      default:
        return "link";
    }
  }
  return "link";
}

export function createSessionController<S extends SessionHandle>(
  deps: SessionControllerDeps<S>,
): SessionController<S> {
  const live = new Map<string, { readonly session: S; readonly unwatch: () => void }>();
  /** Per id: the settle of the last operation, so the next one starts after it. */
  const tails = new Map<string, Promise<unknown>>();
  let disposed = false;

  /** Run `run` after everything already queued for `id` has settled. */
  function serialise<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) ?? Promise.resolve();
    // A failed (or disposed) predecessor must not block the next: both
    // handlers run it.
    const mine = previous.then(run, run);
    const tail = mine.then(
      () => undefined,
      () => undefined,
    );
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) {
        tails.delete(id);
      }
    });
    return mine;
  }

  async function open(sessionId: string, options: OpenOptions = {}): Promise<OpenSessionResult<S>> {
    const already = live.get(sessionId);
    if (already !== undefined) {
      return { ok: true, session: already.session };
    }
    return serialise(sessionId, async () => {
      if (disposed) {
        return { ok: false, reason: "link" } as const;
      }
      const reused = live.get(sessionId);
      if (reused !== undefined) {
        // Another open of this id won the queue while this one waited.
        return { ok: true, session: reused.session } as const;
      }
      const session = deps.newSession(sessionId, options.reopen === true ? { reopen: true } : {});
      try {
        await session.open();
      } catch (error) {
        return { ok: false, reason: openFailureReason(error) } as const;
      }
      if (disposed) {
        // The screen went away while the attach was in flight: never leave a
        // listener behind (the detach itself is fire-and-forget).
        void session.detach().catch(() => {});
        return { ok: false, reason: "link" } as const;
      }
      // Subscribed after the attach so the history/comments it already buffered
      // arrive now, in order (`watch` delivers what it holds).
      const unwatch = options.watch ? session.watch(options.watch) : () => {};
      live.set(sessionId, { session, unwatch });
      return { ok: true, session } as const;
    });
  }

  function leave(sessionId: string): Promise<void> {
    const entry = live.get(sessionId);
    if (entry !== undefined) {
      live.delete(sessionId);
      entry.unwatch();
    }
    return serialise(sessionId, async () => {
      if (entry === undefined) {
        return;
      }
      // `session/detach` never ends it; an older daemon's `MethodNotFound`
      // leaves the session followed, which is the safe side (nothing ended).
      await entry.session.detach().catch(() => {});
    });
  }

  return {
    open,
    leave,
    dispose() {
      disposed = true;
      for (const entry of live.values()) {
        entry.unwatch();
      }
      live.clear();
    },
    follows: (sessionId) => live.has(sessionId),
  };
}
