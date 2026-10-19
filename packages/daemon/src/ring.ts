/**
 * A session's replay ring: every streamed update, seq-ordered, bounded in BYTES
 * (one update can be a 5-byte chunk or a 500 KB tool result, so a count bounds
 * neither memory nor coverage), and never reset at turn boundaries — coverage
 * depends on size only, never on turn structure a client cannot see.
 *
 * Eviction never removes an entry past the PIN (the snapshot cut): a client
 * that just took a snapshot must always be able to replay from its cut, or a
 * resync could loop forever. The pin spans the rounds since the last commit:
 * usually one, more when rounds continue without tool calls (a late steer, the
 * empty-round nudge) — at most `maxIterations` of them.
 *
 * Pure (no I/O, no clock); `HostedSession` owns one per session.
 */

/**
 * Size of an entry in the budget: its JSON length in UTF-16 code units (= bytes
 * for ASCII; an estimate of memory, not of wire bytes). One extra stringify per
 * update — the price of a byte bound instead of a count.
 */
export function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

export class SessionRing<T extends { readonly seq: number }> {
  private readonly maxBytes: number;
  private readonly sizeOf: (value: T) => number;
  private entries: T[] = [];
  private sizes: number[] = [];
  /** Index of the oldest retained entry (evicted ones stay below it until compaction). */
  private head = 0;
  private total = 0;
  /** Seq of the newest evicted entry: `since(s)` is covered iff `s >= floor`. */
  private floor = 0;

  constructor(maxBytes: number, sizeOf: (value: T) => number = jsonSize) {
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
  }

  /** Total size of the retained entries. */
  get bytes(): number {
    return this.total;
  }

  /** Number of retained entries. */
  get length(): number {
    return this.entries.length - this.head;
  }

  /**
   * Append the next update, then evict down to the budget (respecting `pinSeq`).
   * Seqs must be contiguous: a gap would make `since` lie, so it throws.
   */
  push(value: T, pinSeq: number): void {
    const last = this.length > 0 ? this.entries[this.entries.length - 1]?.seq : this.floor;
    if (last !== undefined && value.seq !== last + 1) {
      throw new Error(`ring: non-contiguous seq ${value.seq} after ${last}`);
    }
    const size = this.sizeOf(value);
    this.entries.push(value);
    this.sizes.push(size);
    this.total += size;
    this.evict(pinSeq);
  }

  /** Drop the oldest entries while over budget, but never one with `seq > pinSeq`. */
  evict(pinSeq: number): void {
    while (this.total > this.maxBytes && this.head < this.entries.length) {
      const oldest = this.entries[this.head];
      if (oldest === undefined || oldest.seq > pinSeq) {
        break;
      }
      this.total -= this.sizes[this.head] ?? 0;
      this.floor = oldest.seq;
      this.head++;
    }
    // Reclaim the evicted prefix once it dominates, so `push` stays amortised O(1).
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * Every retained entry with `seq > afterSeq`, oldest first — or `null` when
   * some of them were already evicted (`afterSeq` below the floor). A seq past
   * the newest entry yields `[]`; the caller rejects "future" seqs itself.
   */
  since(afterSeq: number): T[] | null {
    if (afterSeq < this.floor) {
      return null;
    }
    // Contiguous seqs: the entry with seq `afterSeq + 1` sits at a fixed offset.
    const start = this.head + (afterSeq - this.floor);
    return this.entries.slice(Math.min(start, this.entries.length));
  }
}
