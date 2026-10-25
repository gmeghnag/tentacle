/**
 * The session's queue as every client sees it (docs/feat/queued-broadcast.md):
 * pure, React-free, no clock. `HostedSession` owns the state (the steering
 * mirror, the reserved send-now, the rows returned to their writer) and asks
 * here what to stream, what a turn's end hands back, and whether anything
 * changed. The rules of the wire state are in `@tentacle/protocol` (the queue
 * comment in `session.ts`).
 */
import type {
  QueueState,
  QueuedEntry,
  ReturnCause,
  ReturnedEntry,
  SendNowMessage,
  TurnEnd,
} from "@tentacle/protocol";

/** What the view needs of a reserved send-now (`HostedSession`'s `Successor`). */
export interface ReservedTurn {
  readonly messages: readonly SendNowMessage[];
  readonly steers: readonly QueuedEntry[];
  /** A cancel (or a close) landed first: it ends unstarted, its sender restores its rows. */
  readonly cancelled: boolean;
}

export interface QueueInput {
  /** A turn holds the slot (not a compaction). */
  readonly turnRunning: boolean;
  /** The steering mirror: the running turn's undrained rows, in order. */
  readonly queue: readonly QueuedEntry[];
  readonly successor: ReservedTurn | null;
  /** The text of `id` is in the history already (never shown as waiting). */
  readonly isDelivered: (id: string) => boolean;
  readonly returned: readonly ReturnedEntry[];
}

export const EMPTY_QUEUE: QueueState = { entries: [], returned: [] };

/** A reserved send-now that will start (not cancelled). */
const live = (next: ReservedTurn | null): boolean => next !== null && !next.cancelled;

/**
 * The queue now. With a live reserved send-now: its prompt's texts not
 * delivered yet, then the rows it carries over (the queue minus its own
 * messages), then the steers typed for it — the order the new turn will
 * deliver them in. Otherwise the running turn's queue (nothing while idle or
 * compacting). A cancelled send-now contributes nothing: its sender restores
 * its rows (`delivered: false`).
 */
export function queueView(input: QueueInput): QueueState {
  const next = input.successor;
  const returned = input.returned.map((r) => ({ id: r.id, text: r.text, cause: r.cause }));
  if (next !== null && live(next)) {
    const own = new Set(next.messages.map((m) => m.id));
    const entries = [
      ...next.messages.filter((m) => !input.isDelivered(m.id)),
      ...input.queue.filter((r) => !own.has(r.id)),
      ...next.steers,
    ].map((r) => ({ id: r.id, text: r.text }));
    return { entries, returned };
  }
  const entries = input.turnRunning ? input.queue.map((r) => ({ id: r.id, text: r.text })) : [];
  return { entries, returned };
}

/**
 * A turn ended with `queue` undrained: the rows that go back to their writer,
 * or null when a live send-now carries them over (D4: the conversation they
 * steer goes on at once). A cancelled send-now's own rows (its messages, its
 * steers) are not returned: its sender restores them through
 * `delivered: false` — never handed back twice.
 */
export function leftovers(
  queue: readonly QueuedEntry[],
  successor: ReservedTurn | null,
): readonly QueuedEntry[] | null {
  if (live(successor)) {
    return null;
  }
  const theirs = new Set([
    ...(successor?.messages ?? []).map((m) => m.id),
    ...(successor?.steers ?? []).map((s) => s.id),
  ]);
  return queue.filter((r) => !theirs.has(r.id));
}

/** Why a turn's leftovers went back (`closed`: the session ended with it). */
export function returnCause(closed: boolean, stopReason: TurnEnd["stopReason"]): ReturnCause {
  if (closed) {
    return "ended";
  }
  return stopReason === "cancelled" ? "cancelled" : "failed";
}

const sameRows = (
  a: readonly { readonly id: string; readonly text: string; readonly cause?: string }[],
  b: readonly { readonly id: string; readonly text: string; readonly cause?: string }[],
): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const s = b[i];
    return s !== undefined && r.id === s.id && r.text === s.text && r.cause === s.cause;
  });

/** Same rows, texts and causes, in the same order: nothing to stream. */
export function sameState(a: QueueState, b: QueueState): boolean {
  return sameRows(a.entries, b.entries) && sameRows(a.returned, b.returned);
}
