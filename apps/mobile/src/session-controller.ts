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
 * - **A watching open always gets the history.** `RemoteSession.watch` delivers
 *   what the attach raised ONCE, to the first listener: a watcher takes a handle
 *   nobody watched yet, otherwise it re-attaches (detach, then a fresh open) and
 *   the superseded watcher is unsubscribed (docs/fix/mobile-session-open-empty.md).
 *   `leave` names its holder by that watcher, so a superseded one releases nothing.
 * - **Leaving detaches.** `leave` is `RemoteSession.detach` (`session/detach`):
 *   the session keeps running for every client (decision 4). It is never
 *   `close()`, which is `session/close` and ends it (Hazard 3).
 * - **An open never throws a raw error at a screen.** It answers a typed reason
 *   decided by error CLASS/CODE — never by message text, which a pod daemon
 *   chooses (AGENTS §7 "a pod is not trusted").
 */
import { AttachTimeoutError, type AutoAcceptLink, type SessionActivity } from "@tentacle/client";
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
  /**
   * The session's shared auto-accept (docs/feat/session-auto-accept.md D6):
   * `RemoteSession.autoAccept`, so the sheet's switch IS the session's and a
   * flip on another device arrives here. Absent on a handle that has none (a
   * fake, or an older client): the sheet then has no switch at all.
   */
  readonly autoAccept?: AutoAcceptLink;
}

/** A holder's listener; its identity is how that holder names itself to `leave`. */
export type Watch = (activity: SessionActivity) => void;

export interface OpenOptions {
  /** Reload an ARCHIVED session (the person's Reopen). Absent: an archived id fails `archived`. */
  readonly reopen?: boolean;
  /** What the session does that this client did not start (turns, history, closed). */
  readonly watch?: Watch;
}

export interface SessionController<S extends SessionHandle> {
  /** Attach to `sessionId` (never create). Serialised per id; no throw. */
  open(sessionId: string, options?: OpenOptions): Promise<OpenSessionResult<S>>;
  /**
   * One holder stops following it; the last one out detaches (`session/detach`):
   * the session keeps running for everyone. `watch` = the listener this holder
   * opened with (absent: a holder that opened without one).
   */
  leave(sessionId: string, watch?: Watch): Promise<void>;
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

/** A handle built WITHOUT `attach` (`client.newSession(undefined, id)`): its `openSeeded` CREATES. */
export interface FreshHandle {
  openSeeded(): Promise<void>;
  detach(): Promise<void>;
}

/**
 * The phone's New session (docs/feat/mobile-chrome.md S7): the ONE place the
 * phone creates. `openSeeded` is `session/open{create}` under the phone-minted
 * id (an absent id is created empty; the daemon's open is atomic). The create
 * happens HERE, at the tap, not at the first send: the screen's open and the
 * outbox's port both attach only (`open` above; `App.tsx` `outboxOf`), so an
 * id that does not exist yet could never be sent to. The create's own handle
 * is then detached — and awaited — so the screen's controller attaches a
 * session this client no longer follows (the client's table is keyed by id).
 * A failed detach is still ok: the session exists, and the attach that follows
 * re-reaches it. Never throws.
 */
export async function createFreshSession(
  handle: FreshHandle,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: SessionOpenFailure }> {
  try {
    await handle.openSeeded();
  } catch (error) {
    return { ok: false, reason: openFailureReason(error) };
  }
  await handle.detach().catch(() => {});
  return { ok: true };
}

/** A followed session and who holds it. */
interface Entry<S> {
  readonly session: S;
  /** The one listener (`RemoteSession.watch` has a single slot); null: none now. */
  watcher: Watch | null;
  unwatch: () => void;
  /** It has had a watcher: the attach history is delivered and gone. */
  consumed: boolean;
  /** An open without a watch created it: that holder will `leave` too. */
  held: boolean;
}

/** An open still queued or attaching, so a `leave` can find it. */
interface PendingOpen {
  readonly watch: Watch | undefined;
  /** The `held` its entry will be registered with. */
  held: boolean;
  /** Its holder left: it must register nothing. */
  cancelled: boolean;
}

const nothing = (): void => {};

export function createSessionController<S extends SessionHandle>(
  deps: SessionControllerDeps<S>,
): SessionController<S> {
  const live = new Map<string, Entry<S>>();
  /** Per id: the settle of the last operation, so the next one starts after it. */
  const tails = new Map<string, Promise<unknown>>();
  /** Per id: the opens that have not settled yet. */
  const pending = new Map<string, Set<PendingOpen>>();
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

  /** Unsubscribe an entry's listener and forget it; the caller detaches the handle. */
  function drop(id: string, entry: Entry<S>): void {
    entry.unwatch();
    live.delete(id);
  }

  /**
   * `session/detach` never ends it; an older daemon's `MethodNotFound` leaves the
   * session followed, which is the safe side (nothing ended).
   */
  async function detach(session: S): Promise<void> {
    await session.detach().catch(() => {});
  }

  /**
   * Serve an open from a followed session, or null when only a fresh attach can:
   * the history goes ONCE, to the first listener.
   */
  function adopt(entry: Entry<S>, watch: Watch | undefined): OpenSessionResult<S> | null {
    if (watch !== undefined && entry.watcher !== watch) {
      if (entry.consumed) {
        return null;
      }
      entry.watcher = watch;
      entry.consumed = true;
      // What the attach already buffered arrives now, in order.
      entry.unwatch = entry.session.watch(watch);
    }
    return { ok: true, session: entry.session };
  }

  /** The queued half of `open`: runs alone for its id. */
  async function attach(
    sessionId: string,
    options: OpenOptions,
    request: PendingOpen,
    superseded: Entry<S> | undefined,
  ): Promise<OpenSessionResult<S>> {
    if (disposed) {
      return { ok: false, reason: "link" };
    }
    if (superseded !== undefined) {
      await detach(superseded.session);
    }
    const reused = live.get(sessionId);
    if (reused !== undefined) {
      // Another open of this id won the queue while this one waited.
      if (request.cancelled) {
        return { ok: false, reason: "link" };
      }
      const served = adopt(reused, options.watch);
      if (served !== null) {
        return served;
      }
      drop(sessionId, reused);
      request.held = reused.held;
      await detach(reused.session);
    }
    if (disposed) {
      return { ok: false, reason: "link" };
    }
    const session = deps.newSession(sessionId, options.reopen === true ? { reopen: true } : {});
    try {
      await session.open();
    } catch (error) {
      return { ok: false, reason: openFailureReason(error) };
    }
    if (disposed || request.cancelled) {
      // The holder went away while the attach was in flight (`dispose`, or a
      // back before the attach answered): never leave a listener behind, and
      // detach — the session was already reached at the daemon (the detach
      // itself is fire-and-forget).
      void detach(session);
      return { ok: false, reason: "link" };
    }
    const entry: Entry<S> = {
      session,
      watcher: null,
      unwatch: nothing,
      consumed: false,
      held: request.held,
    };
    live.set(sessionId, entry);
    // Never null: nothing watched this entry yet.
    adopt(entry, options.watch);
    return { ok: true, session };
  }

  async function open(sessionId: string, options: OpenOptions = {}): Promise<OpenSessionResult<S>> {
    const already = live.get(sessionId);
    if (already !== undefined) {
      const served = adopt(already, options.watch);
      if (served !== null) {
        return served;
      }
      // Takeover. Dropped at once, so the superseded holder's late `leave` finds
      // nothing of its own.
      drop(sessionId, already);
    }
    const request: PendingOpen = {
      watch: options.watch,
      held: already?.held ?? options.watch === undefined,
      cancelled: false,
    };
    const waiting = pending.get(sessionId) ?? new Set<PendingOpen>();
    pending.set(sessionId, waiting.add(request));
    return serialise(sessionId, async () => {
      try {
        return await attach(sessionId, options, request, already);
      } finally {
        waiting.delete(request);
        if (waiting.size === 0) {
          pending.delete(sessionId);
        }
      }
    });
  }

  function leave(sessionId: string, watch?: Watch): Promise<void> {
    const entry = live.get(sessionId);
    /** The handle this leave was the last holder of. */
    let last: S | undefined;
    if (entry !== undefined) {
      if (watch === undefined) {
        // A watching holder, if any, keeps following it.
        entry.held = false;
        if (entry.watcher === null) {
          last = entry.session;
        }
      } else if (entry.watcher === watch) {
        entry.unwatch();
        entry.unwatch = nothing;
        entry.watcher = null;
        if (!entry.held) {
          last = entry.session;
        }
      }
      if (last !== undefined) {
        drop(sessionId, entry);
      }
    }
    // A `leave` while that holder's open is still attaching: mark it so it
    // detaches instead of registering (the screen is gone; registering it would
    // keep a listener into an unmounted screen and re-offer asks to the phone's
    // held broker).
    for (const request of pending.get(sessionId) ?? []) {
      if (watch !== undefined) {
        if (request.watch === watch) {
          request.cancelled = true;
        }
      } else if (entry === undefined) {
        if (request.watch === undefined) {
          request.cancelled = true;
        } else {
          // A takeover in flight: the holder letting go only releases its hold.
          request.held = false;
        }
      }
    }
    return serialise(sessionId, async () => {
      if (last !== undefined) {
        await detach(last);
      }
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
