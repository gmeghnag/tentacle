/**
 * The daemon's side of `session/log` (docs/feat/session-log.md): an exact,
 * ordered log of a session's COMMITTED history, derived at the synchronous
 * points `HostedSession` already has (the cut, a history replacement, a head
 * swap). Pure: no I/O, no React, no clock of its own.
 *
 * Derivation (`commit`) is a reference diff of `messages[0, length)` against
 * the previous derivation's copy: messages are immutable values, so "changed"
 * ⇔ "another object at that index" (the plan's load-bearing assumption, pinned
 * by test D1). O(n) pointer compares, no stringify, no hashing: it runs inside
 * the steering window. A whole replacement (compaction, context reset) reuses
 * the SAME array, so it is never diffed: `replaced` starts a new segment and
 * RESETS the reference copy (F3). A shrink behind a cut — none exists today —
 * would still be logged (`truncate`), never lost.
 *
 * Reads are served ONLY from entries already derived — never from the live
 * array, which a concurrent request may observe mid-replacement. A checkpoint's
 * digest and every entry's size are computed lazily by the first read that
 * serves them, outside the steering window.
 *
 * Retention: the current segment and the previous one (F5 memory bound: their
 * entries reference the live message objects). A reader further behind is
 * `rebased` to the last `base`.
 */
import type { ChatMessage } from "@tentacle/core";
import {
  type KnownLogEntry,
  LOG_PAGE_MAX_CHARS,
  type LogBaseReason,
  type LogCursor,
  type LogResult,
  type SessionTitle,
  type Sha256,
  type StopReason,
  type WireChatMessage,
  digestOfDigests,
  messageDigest,
} from "@tentacle/protocol";

/** One retained entry: its wire object (a checkpoint's built on first read) and its size, once known. */
interface Slot {
  entry: KnownLogEntry | null;
  /** A checkpoint not served yet: the projection it asserts (immutable messages). */
  readonly lazy?: {
    readonly seq: number;
    readonly prev: string | null;
    readonly ts: number;
    readonly messages: readonly ChatMessage[];
  };
  size?: number;
}

/** Where a lineage continues from (`open{logBase}`): the client's head for the messages it seeded. */
export type LogBase = LogCursor;

export class SessionLog {
  private readonly slots: Slot[] = [];
  /** `seq` of `slots[0]`. */
  private firstSeq = 1;
  /** Index (in `slots`) of the current segment's `base`, and of the previous one (-1: none retained). */
  private current = 0;
  private previous = -1;
  /** The committed prefix as of the last derivation. */
  private ref: ChatMessage[] = [];
  private lastTitle: string | undefined;
  /** The digest of a message object (immutable: the object is the key). */
  private readonly digests = new WeakMap<object, string>();
  private nextSeq = 1;
  private lastId: string | null = null;
  /** The client head this incarnation was reseeded from (`open{logBase}`), if any. */
  private root: LogCursor | undefined;

  constructor(
    readonly inc: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The first segment of this incarnation: a `base` + its messages, linked to `from` when the client gave one. */
  start(
    messages: readonly ChatMessage[],
    reason: LogBaseReason,
    from?: LogBase,
    turn?: string | null,
  ): void {
    if (from) {
      this.root = { seq: from.seq, id: from.id };
      this.firstSeq = from.seq + 1;
      this.nextSeq = from.seq + 1;
      this.lastId = from.id;
    }
    this.segment(messages, reason, turn);
  }

  /** A whole replacement (compaction, context reset): a new segment; the older-than-previous is dropped. */
  replaced(messages: readonly ChatMessage[], reason: LogBaseReason, turn?: string | null): void {
    this.segment(messages, reason, turn);
  }

  /** Derive the changes of `messages[0, length)` since the last derivation. Synchronous, O(length) compares. */
  commit(messages: readonly ChatMessage[], length: number): void {
    const old = this.ref.length;
    const shared = Math.min(old, length);
    for (let i = 0; i < shared; i++) {
      const message = messages[i];
      if (message !== undefined && message !== this.ref[i]) {
        this.push({ type: "replace", critical: true, index: i, message: wire(message) });
      }
    }
    if (length < old) {
      this.push({ type: "truncate", critical: true, length });
    }
    for (let i = old; i < length; i++) {
      const message = messages[i];
      if (message !== undefined) {
        this.push({ type: "message", critical: true, message: wire(message) });
      }
    }
    this.ref = messages.slice(0, length);
  }

  /** A `title` entry when the wire title differs from the last one logged. */
  title(title: SessionTitle): void {
    const key = `${title.source}\u0000${title.text}`;
    if (key === this.lastTitle) {
      return;
    }
    this.lastTitle = key;
    this.push({ type: "title", title: { text: title.text, source: title.source } });
  }

  turnStart(turnId: string): void {
    this.push({ type: "turn_start", turnId });
  }

  turnEnd(turnId: string, stopReason: StopReason): void {
    this.push({ type: "turn_end", turnId, stopReason });
  }

  callStarted(callId: string): void {
    this.push({ type: "call_started", callId });
  }

  /** Assert the projection here; its digest is computed by the first read that serves it. */
  checkpoint(): void {
    const seq = this.nextSeq++;
    const prev = this.lastId;
    this.lastId = `${this.inc}/${seq}`;
    this.slots.push({ entry: null, lazy: { seq, prev, ts: this.now(), messages: this.ref } });
  }

  /** The newest entry. */
  get tip(): LogCursor {
    return { seq: this.nextSeq - 1, id: this.lastId ?? "" };
  }

  /**
   * One page after `after` (a retained entry: same `seq` AND `id`), else from
   * the last `base` (`after` absent: a cold read; unknown, another lineage,
   * evicted: `rebased`). Pure over the retained entries; at least one entry
   * per page when any is due (a larger one travels alone).
   */
  read(after: LogCursor | undefined, maxChars: number, sha256: Sha256): LogResult {
    const budget = Math.max(1, Math.min(maxChars, LOG_PAGE_MAX_CHARS));
    let start = this.current;
    let rebased = false;
    if (after !== undefined) {
      const at = after.seq - this.firstSeq;
      const slot = at >= 0 && at < this.slots.length ? this.slots[at] : undefined;
      if (slot !== undefined && this.idOf(at) === after.id) {
        start = at + 1;
      } else {
        rebased = true;
      }
    }
    const entries: KnownLogEntry[] = [];
    let used = 0;
    let end = start;
    for (; end < this.slots.length; end++) {
      const slot = this.slots[end];
      if (slot === undefined) break;
      const entry = this.materialize(slot, sha256);
      slot.size ??= JSON.stringify(entry).length;
      if (entries.length > 0 && used + slot.size > budget) {
        break;
      }
      used += slot.size;
      entries.push(entry);
    }
    return {
      entries,
      more: end < this.slots.length,
      tip: this.tip,
      ...(rebased ? { rebased: true } : {}),
      // Entries from a base (cold or rebased): the head this incarnation was reseeded from.
      ...(start === this.current && this.root ? { root: this.root } : {}),
    };
  }

  private idOf(index: number): string {
    return `${this.inc}/${this.firstSeq + index}`;
  }

  private materialize(slot: Slot, sha256: Sha256): KnownLogEntry {
    if (slot.entry !== null) {
      return slot.entry;
    }
    const lazy = slot.lazy;
    if (lazy === undefined) {
      throw new Error("session log: an entry with no value");
    }
    const digests = lazy.messages.map((m) => {
      let d = this.digests.get(m);
      if (d === undefined) {
        d = messageDigest(wire(m), sha256);
        this.digests.set(m, d);
      }
      return d;
    });
    const seq = lazy.seq;
    const entry: KnownLogEntry = {
      type: "checkpoint",
      seq,
      id: `${this.inc}/${seq}`,
      ...(lazy.prev !== null ? { prev: lazy.prev } : {}),
      ts: lazy.ts,
      count: lazy.messages.length,
      digest: digestOfDigests(digests, sha256),
    };
    slot.entry = entry;
    return entry;
  }

  private segment(
    messages: readonly ChatMessage[],
    reason: LogBaseReason,
    turn: string | null | undefined,
  ): void {
    const baseIndex = this.slots.length;
    this.push({
      type: "base",
      critical: true,
      inc: this.inc,
      reason,
      count: messages.length,
      ...(turn ? { turn } : {}),
    });
    for (const message of messages) {
      this.push({ type: "message", critical: true, message: wire(message) });
    }
    this.ref = messages.slice();
    // Every segment carries the title again (the caller logs it next): a cold
    // read from this base knows it.
    this.lastTitle = undefined;
    // Retention: the previous segment stays (a reader one segment behind reads
    // its tail exactly), anything older goes.
    if (this.previous >= 0) {
      const drop = this.current;
      this.slots.splice(0, drop);
      this.firstSeq += drop;
      this.previous = this.current - drop;
      this.current = baseIndex - drop;
    } else {
      this.previous = baseIndex === 0 ? -1 : this.current;
      this.current = baseIndex;
    }
  }

  private push(body: DistributiveOmit<KnownLogEntry, "seq" | "id" | "prev" | "ts">): void {
    const seq = this.nextSeq++;
    const id = `${this.inc}/${seq}`;
    const entry = {
      ...body,
      seq,
      id,
      ...(this.lastId !== null ? { prev: this.lastId } : {}),
      ts: this.now(),
    } as KnownLogEntry;
    this.lastId = id;
    this.slots.push({ entry });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** core `ChatMessage` is structurally the wire schema (the snapshot relies on it too). */
function wire(message: ChatMessage): WireChatMessage {
  return message as WireChatMessage;
}

/**
 * Replay entries from a `base` into a projection (tests; the client has its own
 * validating reader). Unknown or non-projecting types are ignored.
 */
export function replayFromBase(entries: readonly KnownLogEntry[]): ChatMessage[] {
  let projection: ChatMessage[] = [];
  for (const e of entries) {
    if (e.type === "base") projection = [];
    else if (e.type === "message") projection.push(e.message as ChatMessage);
    else if (e.type === "replace") projection[e.index] = e.message as ChatMessage;
    else if (e.type === "truncate") projection.length = e.length;
  }
  return projection;
}
