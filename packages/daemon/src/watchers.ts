/**
 * A session's WATCHERS (docs/feat/logs-cmd.md, sub-task 2): the read-only
 * followers `tentacle logs -f` runs, kept apart from the `attachments` that are
 * clients of the session.
 *
 * Separate on purpose, not for tidiness: `attachments.size` decides real
 * behaviour — the blocking-ask fallback (a watcher that declared no
 * `permission_request` would make a pending ask be DENIED at once), the
 * detached-session cap, a quit's `ifLast`, and `session/list`'s `attached`
 * (which the relay's idle exit and `ps` read). A watcher is none of those: it
 * never receives a model call, never answers an ask and is never counted.
 *
 * The delivery is a PULL (owner Q5): the queue is bounded per watcher
 * (`watch-queue.ts`), and the client holds one `watch_next` at a time. So the
 * daemon carries at most one capped batch per watcher on the wire, overflow is
 * observable and counted instead of piling up in a transport that has no
 * back-pressure, and holding the request blocks nothing (the peer dispatches
 * every inbound request concurrently, AGENTS §7).
 *
 * A held poll answers a batch when the queue is non-empty AND the coalescing
 * window has passed (so a chunk storm yields one batch per window), at once for
 * a flush-now type (an ask, a turn's end, the close), or with an empty batch
 * when the hold times out. The clock and the timer are injected, so all of that
 * is testable without waiting.
 */
import {
  type KnownSessionUpdateParams,
  MAX_WATCHERS_PER_SESSION,
  WATCH_POLL_TIMEOUT_MS,
  type WatchCategory,
  type WatchEndReason,
} from "@tentacle/protocol";
import { DomainErrorCode, ErrorCode, RpcError } from "@tentacle/transport";
import { WATCH_COALESCE_MS, type WatchBatch, WatchQueue } from "./watch-queue.ts";

/**
 * A watcher that stops polling is dropped after this long (a bounded leak on a
 * hung client: its connection may stay open for hours). Owner Q8: a constant.
 */
export const WATCH_IDLE_DROP_MS = 60_000;

/** The timers this module needs (injected: a test drives them without waiting). */
export interface WatcherTimers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const realTimers: WatcherTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A pending hold must never keep a daemon process alive on its own.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One watcher: its queue, when it last polled, and the hold in flight (if any). */
interface Watcher {
  readonly id: string;
  readonly queue: WatchQueue;
  lastPollAt: number;
  /** A `watch_next` is held for this watcher: a second one is `InvalidRequest`. */
  holding: boolean;
  /** Resolve the held poll's wait (the loop then recomputes what it waits for). */
  wake: (() => void) | undefined;
}

/** A refusal the CLI words: `InvalidParams` (a hold already in flight) or `UnknownWatch`. */
export class WatchError extends RpcError {
  constructor(code: number, message: string) {
    super(code, message);
    this.name = "WatchError";
  }
}

export class SessionWatchers {
  private readonly watchers = new Map<string, Watcher>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timers: WatcherTimers = realTimers,
    private readonly coalesceMs: number = WATCH_COALESCE_MS,
    private readonly idleMs: number = WATCH_IDLE_DROP_MS,
  ) {}

  /** How many watchers this session holds LIVE (never counted as `attached`). */
  get size(): number {
    return [...this.watchers.values()].filter((watcher) => watcher.queue.endReason === undefined)
      .length;
  }

  /** Every watcher's id, oldest first (a test/diagnostic read). */
  get ids(): readonly string[] {
    return [...this.watchers.keys()];
  }

  /**
   * Start watching: a fresh queue filtered by `only`. Past the cap the OLDEST
   * LIVE watcher is ended `evicted` (never the newcomer: the caller just
   * asked); it keeps its queue for ONE more batch, which says why — a poll
   * after that is `UnknownWatch`, the same answer a client that stopped polling
   * gets. Ending it does not free the slot on its own, so a watcher already
   * ended is pruned here: otherwise a client could keep up to
   * `MAX_WATCHERS_PER_SESSION` unread ended queues per session forever.
   */
  open(only?: readonly WatchCategory[]): string {
    for (const watcher of [...this.watchers.values()]) {
      if (watcher.queue.endReason !== undefined) {
        this.watchers.delete(watcher.id);
      }
    }
    while (this.size >= MAX_WATCHERS_PER_SESSION) {
      const oldest = [...this.watchers.values()].find(
        (watcher) => watcher.queue.endReason === undefined,
      );
      if (oldest === undefined) {
        break;
      }
      this.end(oldest.id, "evicted");
    }
    const id = crypto.randomUUID();
    this.watchers.set(id, {
      id,
      queue: new WatchQueue(only),
      lastPollAt: this.now(),
      holding: false,
      wake: undefined,
    });
    return id;
  }

  /**
   * Offer one update to every watcher — called from `HostedSession.emit`
   * AFTER the attachment fan-out, per watcher in try/catch: a throwing watcher
   * is dropped and the turn (and the other clients) never notice. Synchronous
   * and never awaited: a watcher can never make the agent loop wait.
   */
  offer(params: KnownSessionUpdateParams): void {
    for (const watcher of [...this.watchers.values()]) {
      try {
        // A client that stopped polling is gone (a bounded leak), before its
        // queue grows any further.
        if (this.now() - watcher.lastPollAt > this.idleMs) {
          this.end(watcher.id, "evicted");
          continue;
        }
        if (!watcher.queue.accepts(params.update)) {
          continue; // filtered BEFORE the queue: ignored text is never stored
        }
        watcher.queue.push(params, this.now());
        if (watcher.queue.endReason === "overflow") {
          this.end(watcher.id, "overflow");
          continue;
        }
        // Woken on every push: a held poll recomputes what it is waiting for
        // (an urgent arrival is due now, ordinary text at its window's end).
        watcher.wake?.();
      } catch {
        // A watcher's bug may never break a turn (the rule attachments follow):
        // drop it, and the session runs on.
        this.drop(watcher.id);
      }
    }
  }

  /**
   * The next batch: everything queued once the coalescing window has passed (at
   * once for a flush-now type or an end), or an empty batch when `timeoutMs`
   * passes with nothing. ONE hold per watcher: a second concurrent call is
   * `InvalidParams`, so two batches are never in flight and the client's
   * picture stays ordered.
   */
  async next(watchId: string, timeoutMs: number = WATCH_POLL_TIMEOUT_MS): Promise<WatchBatch> {
    const watcher = this.require(watchId);
    if (watcher.holding) {
      throw new WatchError(
        ErrorCode.InvalidParams,
        `watch_next is already in flight for ${watchId} (one batch at a time)`,
      );
    }
    watcher.holding = true;
    watcher.lastPollAt = this.now();
    const deadline = this.now() + timeoutMs;
    try {
      for (;;) {
        const at = this.now();
        const due = watcher.queue.dueAt(at, this.coalesceMs);
        if (due !== undefined && due <= at) {
          return this.finish(watcher, watcher.queue.take());
        }
        if (at >= deadline) {
          // The hold is over: whatever arrived is delivered (never an empty
          // batch while something is queued), else the empty batch a poll loop
          // takes as "nothing new".
          return this.finish(watcher, watcher.queue.take());
        }
        // Sleep to the next interesting instant: the coalescing window's end, or
        // the hold's deadline. A push wakes us earlier, and the loop re-checks.
        const until = due === undefined ? deadline : Math.min(deadline, due);
        await this.hold(watcher, until - at);
      }
    } finally {
      watcher.holding = false;
    }
  }

  /** `session/unwatch`, idempotent: an id this session does not hold is a no-op. */
  close(watchId: string): void {
    this.drop(watchId);
  }

  /**
   * A batch left the daemon: an ENDED watch is forgotten once its last batch has
   * been delivered (the reason has been told; a further poll is `UnknownWatch`).
   */
  private finish(watcher: Watcher, batch: WatchBatch): WatchBatch {
    if (batch.ended !== undefined) {
      this.watchers.delete(watcher.id);
    }
    return batch;
  }

  /** The session ended: every watcher's last batch says why. */
  endAll(reason: Exclude<WatchEndReason, "overflow">): void {
    for (const watcher of [...this.watchers.values()]) {
      this.end(watcher.id, reason);
    }
  }

  /** End one watch, keeping its queue for the LAST batch (see `WatchQueue.end`). */
  private end(watchId: string, reason: WatchEndReason): void {
    const watcher = this.watchers.get(watchId);
    if (watcher === undefined) {
      return;
    }
    watcher.queue.end(reason);
    watcher.wake?.();
  }

  /** Forget a watcher entirely (an unwatch, a dropped one): its held poll ends. */
  private drop(watchId: string): void {
    const watcher = this.watchers.get(watchId);
    if (watcher === undefined) {
      return;
    }
    this.watchers.delete(watchId);
    watcher.queue.end("closed");
    watcher.wake?.();
  }

  private require(watchId: string): Watcher {
    const watcher = this.watchers.get(watchId);
    if (watcher === undefined) {
      throw new WatchError(
        DomainErrorCode.UnknownWatch,
        `unknown watch: ${watchId} (the watch ended, or its client stopped polling)`,
      );
    }
    return watcher;
  }

  /** Wait for the watcher's next change, or `ms`: resolves whether it was woken. */
  private hold(watcher: Watcher, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = this.timers.setTimeout(() => finish(false), Math.max(0, ms));
      const finish = (woke: boolean): void => {
        if (done) {
          return;
        }
        done = true;
        this.timers.clearTimeout(timer);
        watcher.wake = undefined;
        resolve(woke);
      };
      watcher.wake = () => finish(true);
    });
  }
}
