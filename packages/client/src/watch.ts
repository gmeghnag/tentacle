/**
 * The laptop's side of the watcher (docs/feat/logs-cmd.md sub-task 2): the poll
 * loop `tentacle logs -f --connect` runs, over a plain `RpcPeer` — NOT a
 * `RemoteClient`/`RemoteSession` (a follower is no session client: it attaches
 * nothing, owns no model link and has no reducer). One `watch_next` at a time,
 * by construction, which is what bounds the wire to one capped batch.
 *
 * Every update is parsed here with the EXISTING schemas: a pod's daemon is not
 * trusted (AGENTS §7), so an unknown kind is reported (never half-applied) and
 * its text is bounded by the schema that knows it. `lost` and `ended` are
 * surfaced, never swallowed — a follower must learn both that updates were
 * dropped and why its stream stopped.
 *
 * Pure of I/O given a `peer` (the daemon's `session/watch{,_next}`/`unwatch`).
 */
import {
  Method,
  type SessionUpdate,
  SessionUpdateSchema,
  type WatchCategory,
  type WatchEndReason,
  type WatchNextResult,
  type WatchState,
  watchCategoriesOf,
} from "@tentacle/protocol";
import type { RpcPeer } from "@tentacle/transport";

/** One poll's parsed outcome. */
export interface WatchPoll {
  /** The updates this build understands, in the daemon's emit order. */
  readonly updates: readonly SessionUpdate[];
  /**
   * Updates of a kind this build does not know (`type`, and whether the daemon
   * marked it mandatory — a mandatory unknown one means the daemon is newer and
   * the follower must say so rather than pretend it saw everything).
   */
  readonly unknown: readonly { readonly type: string; readonly mandatory: boolean }[];
  /** Updates dropped from the daemon's queue for this watcher since the last poll. */
  readonly lost: number;
  /** Present on the last poll of a watch. */
  readonly ended?: WatchEndReason;
}

/** A watch already started: its id and the state it began with. */
export interface OpenWatch {
  readonly watchId: string;
  /** What the daemon was doing when the watch started (a running turn, pending asks). */
  readonly state: WatchState;
}

/** How this client words a watch that the daemon no longer holds. */
export const UNKNOWN_WATCH_HINT =
  "the watch is gone (the daemon dropped it: the session ended, or nothing polled it)";

/**
 * Start a watch: `session/watch` with the `--only` categories. The daemon
 * refuses an unknown or archived session with `UnknownSession` — this NEVER
 * opens or revives one.
 */
export async function openWatch(
  peer: Pick<RpcPeer, "request">,
  sessionId: string,
  only?: readonly WatchCategory[],
): Promise<OpenWatch> {
  const result = (await peer.request(Method.Watch, {
    sessionId,
    ...(only !== undefined ? { only } : {}),
  })) as OpenWatch;
  return { watchId: result.watchId, state: result.state };
}

/** One poll: the held batch, parsed. `timeoutMs` bounds the hold; `signal` ends it (Ctrl+C). */
export async function pollWatch(
  peer: Pick<RpcPeer, "request">,
  watchId: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<WatchPoll> {
  const result = (await peer.request(
    Method.WatchNext,
    {
      watchId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
    // A signal makes the peer send `$/cancelRequest` and reject locally at once:
    // a Ctrl+C never waits out a 25 s hold.
    options.signal !== undefined ? { signal: options.signal } : undefined,
  )) as WatchNextResult;
  const updates: SessionUpdate[] = [];
  const unknown: { type: string; mandatory: boolean }[] = [];
  for (const params of result.updates) {
    const parsed = SessionUpdateSchema.safeParse(params.update);
    if (parsed.success) {
      updates.push(parsed.data);
      continue;
    }
    const type = rawType(params.update);
    unknown.push({ type, mandatory: params.mandatory === true });
  }
  return {
    updates,
    unknown,
    lost: result.lost,
    ...(result.ended !== undefined ? { ended: result.ended } : {}),
  };
}

/** Stop watching. Idempotent on the daemon; a peer already closed sends nothing. */
export async function closeWatch(peer: Pick<RpcPeer, "request">, watchId: string): Promise<void> {
  await peer.request(Method.Unwatch, { watchId });
}

/** The `type` of a frame this build could not parse (a display label, bounded). */
function rawType(update: unknown): string {
  const raw = update as { type?: unknown } | null;
  return typeof raw?.type === "string" ? raw.type.slice(0, 64) : "unknown";
}

/**
 * The categories an update belongs to (the ONE shared map), re-exported so a
 * caller of this module needs no second import to filter a poll.
 */
export { watchCategoriesOf };
