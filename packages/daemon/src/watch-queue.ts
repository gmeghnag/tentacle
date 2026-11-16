/**
 * One WATCHER's queue (docs/feat/logs-cmd.md, sub-task 2): the bounded buffer
 * between a session's update stream and a `tentacle logs -f` poll.
 *
 * Pure — no I/O, no clock, no timers (the caller injects both) — so every rule
 * below is testable here and `HostedSession` only wires it.
 *
 * The three properties the design rests on:
 *
 * 1. **Enqueue is O(1) and synchronous.** `HostedSession.emit` calls `push` and
 *    never awaits: a watcher can never make the agent loop wait (AGENTS §7, the
 *    load-bearing assumption).
 * 2. **Memory is bounded per watcher, in BYTES and count.** One update is a
 *    5-byte chunk or a 500 KB tool result, so a count bounds neither memory nor
 *    coverage (`ring.ts:20`'s reasoning). Overflow drops the OLDEST DROPPABLE
 *    update (streamed text/thought, tool progress, a notice) and counts it, so
 *    the next batch says `lost: N` — never silent.
 * 3. **A chunk storm becomes one update per poll.** Adjacent
 *    `agent_message_chunk` / `agent_thought_chunk` updates merge IN PLACE
 *    (their text concatenated): a 10 000-chunk turn costs one queued entry.
 *    Only ADJACENT ones merge — a tool call between two texts is a boundary a
 *    follower must see.
 *
 * Flush-now types (an ask, a turn's end, the session's close) wake a held poll
 * at once; everything else waits out `SUBAGENTS_COALESCE_MS` (250 ms, the
 * stream's own coalescing), so a flood of text does not spin the poller.
 */
import {
  type KnownSessionUpdateParams,
  type SessionUpdate,
  type WatchCategory,
  watchAccepts,
} from "@tentacle/protocol";
import { jsonSize } from "./ring.ts";

/** Bytes ONE watcher's queue may hold (owner Q8: a constant, not a key). */
export const WATCH_QUEUE_MAX_BYTES = 1024 * 1024;
/** Updates ONE watcher's queue may hold, whatever their size (a storm of tiny ones). */
export const WATCH_QUEUE_MAX_COUNT = 4096;
/**
 * How long a non-flush-now update waits before it wakes a held poll: the
 * stream's own coalescing window, so the follower sees at most one batch per
 * window (the owner's bottleneck rule).
 */
export const WATCH_COALESCE_MS = 250;

/** The update types that wake a held poll AT ONCE (nothing may sit behind text). */
const FLUSH_NOW: ReadonlySet<SessionUpdate["type"]> = new Set<SessionUpdate["type"]>([
  "permission_request",
  "permission_resolved",
  "turn_start",
  "turn_end",
  "session_closed",
]);

/**
 * Droppable when the queue is full: streamed text/thought, a tool's live label
 * and progress, and a notice. An ask, a turn's end or the session's close is
 * NEVER dropped — losing one would hang or mislead the follower, so the queue
 * ends the watch instead (Owner Q3).
 */
const DROPPABLE: ReadonlySet<SessionUpdate["type"]> = new Set<SessionUpdate["type"]>([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_progress",
  "tool_call_phase",
  "plan",
  "agent_usage",
  "queued",
  "steer",
  "session_title",
  "session_settings",
  "subagents",
  "jobs",
  "schedules",
  "subagent_notify",
  "subagent_message",
  "background_exit",
]);

/** What a take answers: the batch, the drops since the last one, and whether the watch has ended. */
export interface WatchBatch {
  readonly updates: KnownSessionUpdateParams[];
  readonly lost: number;
  readonly ended: "closed" | "overflow" | "evicted" | undefined;
}

/**
 * One watcher's bounded queue. `only` is the reverse map of the categories the
 * client asked for (`undefined` = every category): the filter runs BEFORE the
 * push, so filtered streamed text is never stored at all.
 */
export class WatchQueue {
  private items: KnownSessionUpdateParams[] = [];
  private sizes: number[] = [];
  private total = 0;
  private lost = 0;
  private ended: "closed" | "overflow" | "evicted" | undefined;
  /** Set when a flush-now update (or the end) was queued: the next take is due now. */
  private urgent = false;
  /**
   * When the queue became non-empty (the injected clock): the coalescing window
   * runs from here, so a chunk storm becomes one batch per window rather than a
   * batch per chunk. Cleared by a take.
   */
  private queuedAt: number | undefined;
  /** Bumped on every `push`/`end`: a held poll compares it to know the queue moved. */
  private version = 0;

  constructor(private readonly only?: readonly WatchCategory[]) {}

  /** Queued entries (a test/diagnostic read). */
  get length(): number {
    return this.items.length;
  }

  /** Bytes held now (never above {@link WATCH_QUEUE_MAX_BYTES} unless one entry alone exceeds it). */
  get bytes(): number {
    return this.total;
  }

  /** The updates dropped since this watcher started (what a batch reports). */
  get dropped(): number {
    return this.lost;
  }

  /** Why this watch ended, if it has. */
  get endReason(): "closed" | "overflow" | "evicted" | undefined {
    return this.ended;
  }

  /** A value that changes whenever the queue did: a held poll may re-check on it. */
  get revision(): number {
    return this.version;
  }

  /** Does this watcher want `update` at all? The client's `only`, checked before anything is stored. */ accepts(
    update: SessionUpdate,
  ): boolean {
    return watchAccepts(this.only, update);
  }

  /**
   * Queue one update (assumed to have passed {@link accepts}). Never throws and
   * never awaits — the agent loop's fan-out calls this, so it is an O(1)
   * enqueue. `now` is the injected clock (the coalescing window's start).
   */
  push(params: KnownSessionUpdateParams, now = Date.now()): void {
    if (this.ended !== undefined) {
      return;
    }
    const update = params.update;
    if (this.queuedAt === undefined) {
      this.queuedAt = now;
    }
    const last = this.items.at(-1);
    // A NEW object on both paths: the emitter (and the replay ring) hold the
    // update they built, and a watcher must never mutate their copy.
    const merged = last !== undefined ? mergeChunks(last.update, update) : undefined;
    if (last !== undefined && merged !== undefined) {
      // One entry, the NEWER seq (the follower's own ordering): adjacent text
      // is one queued update, not two, so a chunk storm costs one entry.
      const newer: KnownSessionUpdateParams = { ...params, update: merged };
      const size = jsonSize(newer);
      this.total += size - (this.sizes.at(-1) ?? 0);
      this.items[this.items.length - 1] = newer;
      this.sizes[this.sizes.length - 1] = size;
      this.version++;
      this.evict();
      return;
    }
    const size = jsonSize(params);
    this.items.push(params);
    this.sizes.push(size);
    this.total += size;
    this.version++;
    if (FLUSH_NOW.has(update.type)) {
      this.urgent = true;
    }
    this.evict();
  }

  /**
   * When this queue's next batch is due, on the `at` clock: now for a flush-now
   * update or an end (nothing may sit behind an ask), else the coalescing
   * window's end. `undefined` when there is nothing to deliver (a held poll then
   * waits out its timeout).
   */
  dueAt(at: number, coalesceMs: number): number | undefined {
    if (this.ended !== undefined || this.urgent) {
      return at;
    }
    if (this.items.length === 0) {
      return undefined;
    }
    return (this.queuedAt ?? at) + coalesceMs;
  }

  /**
   * Take everything queued: the batch, the drops counted since the last take,
   * and the watch's end when it has one. Clears the urgency and the window, so
   * the next held poll waits its full window again.
   */
  take(): WatchBatch {
    const updates = this.items;
    this.items = [];
    this.sizes = [];
    this.total = 0;
    const lost = this.lost;
    this.lost = 0;
    this.urgent = false;
    this.queuedAt = undefined;
    return { updates, lost, ended: this.ended };
  }

  /** Nothing queued and no end: a held poll may wait. */
  get empty(): boolean {
    return this.items.length === 0 && this.ended === undefined;
  }

  /**
   * End this watch (idempotent; the FIRST reason wins — a close that lands after
   * an overflow is still the overflow, which the client may already have seen).
   * The queued updates stay: the last batch delivers them, with the reason.
   */
  end(reason: "closed" | "overflow" | "evicted"): void {
    if (this.ended !== undefined) {
      return;
    }
    this.ended = reason;
    this.urgent = true;
    this.version++;
  }

  /**
   * Drop the OLDEST droppable entry, counting it; if there is none, end the watch
   * with `overflow` (the pathological case: a follower that never polls, and
   * only asks/turn ends pending). Called after every push, so an overflowing
   * watcher converges here, never at the transport.
   */
  private evict(): void {
    while (this.total > WATCH_QUEUE_MAX_BYTES || this.items.length > WATCH_QUEUE_MAX_COUNT) {
      const at = this.items.findIndex((item) => DROPPABLE.has(item.update.type));
      if (at < 0) {
        // Only non-droppable updates left and still full: never drop an ask or a
        // turn's end. End the watch; the client says why and exits non-zero.
        this.lost += this.items.length;
        this.end("overflow");
        return;
      }
      this.total -= this.sizes[at] ?? 0;
      this.items.splice(at, 1);
      this.sizes.splice(at, 1);
      this.lost++;
    }
  }
}

/**
 * The merge of two ADJACENT streamed chunks of the same kind (text with text,
 * thought with thought), as a NEW update — or `undefined` when they do not
 * merge. The content must be a text block: a non-text block (an image) never
 * merges, so nothing is lost by concatenating strings.
 */
function mergeChunks(into: SessionUpdate, next: SessionUpdate): SessionUpdate | undefined {
  if (into.type === "agent_message_chunk" && next.type === "agent_message_chunk") {
    return textOf(into.content, next.content, "agent_message_chunk");
  }
  if (into.type === "agent_thought_chunk" && next.type === "agent_thought_chunk") {
    return textOf(into.content, next.content, "agent_thought_chunk");
  }
  return undefined;
}

/** The two chunks' texts concatenated as one update of `kind`, or none (a non-text block). */
function textOf(
  a: { readonly type: string; readonly text?: string },
  b: { readonly type: string; readonly text?: string },
  kind: "agent_message_chunk" | "agent_thought_chunk",
): SessionUpdate | undefined {
  if (a.type !== "text" || b.type !== "text") {
    return undefined;
  }
  return { type: kind, content: { type: "text", text: `${a.text ?? ""}${b.text ?? ""}` } };
}
