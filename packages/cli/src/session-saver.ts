/**
 * Fire-and-forget session saves that can neither crash the process nor fail
 * silently. The store's `save` rejects on EACCES/ENOSPC/…; an unhandled
 * rejection would kill the live TUI (and print a raw stack over Ink). Here
 * every save's outcome is handled: the first failure of a uid becomes one
 * in-TUI notice, a later success says so, and whatever is still unsaved at
 * teardown is reported once Ink has unmounted. The teardown wait is bounded: a
 * hung filesystem must not freeze the terminal after the TUI is gone.
 */
import type { JsonSessionStore, SessionRecord } from "@tentacle/agent";

/** All the saver needs from a store: a `save` whose promise settles with the write, and `remove`. */
export type SaveTarget = Pick<JsonSessionStore, "save" | "remove">;

/** A uid's last save outcome: fine, or failing with the latest error. */
export type SaveState =
  | { readonly failing: false }
  | { readonly failing: true; readonly error: string };

/**
 * The next state of one uid after a save settles, and the notice to show (if
 * any): only the ok→failing and failing→ok transitions speak, so a disk that
 * stays full doesn't print a warning after every turn.
 */
export function nextSaveState(
  previous: SaveState,
  id: string,
  outcome: { readonly ok: true } | { readonly ok: false; readonly error: string },
): { readonly state: SaveState; readonly notice: string | null } {
  const short = id.slice(0, 8);
  if (outcome.ok) {
    return {
      state: { failing: false },
      notice: previous.failing ? `Session ${short} saved again.` : null,
    };
  }
  return {
    state: { failing: true, error: outcome.error },
    notice: previous.failing
      ? null
      : `⚠ Session ${short} not saved — ${outcome.error}. The conversation continues; tentacle retries after the next turn.`,
  };
}

export interface DrainOptions {
  /** Give up waiting after this long (default 10 s); the sessions still pending are reported. */
  readonly timeoutMs?: number;
  /** Call `onSlow` once if saves are still pending after this long (default 1 s). */
  readonly slowMs?: number;
  /** Told which sessions are still being saved, so a slow exit says why it waits. */
  readonly onSlow?: (ids: readonly string[]) => void;
}

export class SessionSaver {
  private readonly states = new Map<string, SaveState>();
  /**
   * Each save's outcome handler (→ its uid) until it has run: what `drain` waits
   * for. The saver relies only on `save`'s own promise, not on how the store
   * orders its internal settling.
   */
  private readonly pending = new Map<Promise<void>, string>();
  /** Uids whose local copy was removed: a later save of one is dropped (never written back). */
  private readonly removed = new Set<string>();

  constructor(
    private readonly target: SaveTarget,
    private readonly notify: (text: string) => void,
  ) {}

  /** Save in the background; the outcome is reported, never thrown. */
  save(record: SessionRecord): void {
    if (this.removed.has(record.id)) {
      return;
    }
    const settled = this.target.save(record).then(
      () => this.settle(record.id, { ok: true }),
      (error: unknown) =>
        this.settle(record.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    this.pending.set(settled, record.id);
    void settled.finally(() => this.pending.delete(settled));
  }

  /**
   * A save that never reached the store (its history could not be read back):
   * reported exactly like a failed write — one notice on the transition, and
   * `drain` lists it until a later save of the uid succeeds.
   */
  failed(id: string, error: string): void {
    this.settle(id, { ok: false, error });
  }

  /**
   * Remove `id`'s local copy for good (the daemon says the session was
   * deleted): queued after any save in flight (the store's per-uid queue), and
   * no later save writes it back. A failure is one notice; `drain` waits for it.
   */
  remove(id: string): void {
    this.removed.add(id);
    this.states.delete(id);
    const settled = this.target.remove(id).then(
      () => {},
      (error: unknown) => {
        try {
          this.notify(
            `⚠ Session ${id.slice(0, 8)}'s local copy could not be removed — ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        } catch {
          // A broken listener must not become an unhandled rejection.
        }
      },
    );
    this.pending.set(settled, id);
    void settled.finally(() => this.pending.delete(settled));
  }

  private settle(
    id: string,
    outcome: { readonly ok: true } | { readonly ok: false; readonly error: string },
  ): void {
    if (this.removed.has(id)) {
      return; // deleted (a save in flight, a failed read): nothing left to save or report
    }
    const { state, notice } = nextSaveState(this.states.get(id) ?? { failing: false }, id, outcome);
    this.states.set(id, state);
    if (notice) {
      try {
        this.notify(notice);
      } catch {
        // A broken listener must not turn a handled save into an unhandled
        // rejection; the state is recorded, so `drain` still reports it.
      }
    }
  }

  private pendingIds(): string[] {
    return [...new Set(this.pending.values())];
  }

  /**
   * Wait (bounded) for every pending save, then return one line per session that
   * is not safely on disk — its LAST save failed, or it was still being written
   * when the wait gave up — for the caller to print after the TUI has unmounted.
   */
  async drain(options: DrainOptions = {}): Promise<string[]> {
    const { timeoutMs = 10_000, slowMs = 1_000, onSlow } = options;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolve) => {
      giveUp = setTimeout(() => resolve(true), timeoutMs);
    });
    const slow = setTimeout(() => {
      if (this.pending.size > 0) {
        onSlow?.(this.pendingIds());
      }
    }, slowMs);
    try {
      while (this.pending.size > 0) {
        const done = Promise.all(this.pending.keys()).then(() => false as const);
        if (await Promise.race([done, timedOut])) {
          break;
        }
      }
    } finally {
      clearTimeout(giveUp);
      clearTimeout(slow);
    }
    const lines: string[] = [];
    const stillWriting = this.pendingIds();
    for (const id of stillWriting) {
      lines.push(
        `[session] gave up waiting for session ${id} after ${Math.round(timeoutMs / 1000)}s — any file on disk is from an earlier save\n`,
      );
    }
    for (const [id, state] of this.states) {
      if (state.failing && !stillWriting.includes(id)) {
        lines.push(
          `[session] not saved: ${id} — ${state.error} (any file on disk is from an earlier save)\n`,
        );
      }
    }
    return lines;
  }
}
