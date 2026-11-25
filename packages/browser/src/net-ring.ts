// Bounded per-tab ring of network / WS messages (docs/feat/browser-inspect.md
// failure modes: «2 000 messages / 8 MiB, overflow increments dropped, list is
// pull-based with cursors»). Pure; lives in the host, not the service worker.

export type RingEntry<T> = { seq: number; size: number; item: T };

export type RingPage<T> = {
  entries: RingEntry<T>[];
  /** Pass back as `cursor` to continue. */
  next: number;
  /** Messages evicted before the reader got them (since `cursor`, or ever). */
  dropped: number;
};

export class NetRing<T> {
  private buf: RingEntry<T>[] = [];
  private bytes = 0;
  private seq = 0; // next sequence number
  private evicted = 0; // total evicted

  constructor(
    private readonly maxMessages = 2000,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  push(item: T, size: number): number {
    const s = Math.max(0, size);
    const entry = { seq: this.seq++, size: s, item };
    this.buf.push(entry);
    this.bytes += s;
    while (
      this.buf.length > this.maxMessages ||
      (this.bytes > this.maxBytes && this.buf.length > 1)
    ) {
      const old = this.buf.shift();
      if (!old) break;
      this.bytes -= old.size;
      this.evicted++;
    }
    return entry.seq;
  }

  /** Entries with seq ≥ cursor (default 0), at most `limit`. */
  list(cursor = 0, limit = 100): RingPage<T> {
    const first = this.buf[0]?.seq ?? this.seq;
    // Everything in [cursor, first) was evicted before being read.
    const dropped = Math.max(0, first - Math.max(0, cursor));
    const entries = this.buf.filter((e) => e.seq >= cursor).slice(0, limit);
    const last = entries[entries.length - 1];
    return { entries, next: last ? last.seq + 1 : Math.max(cursor, first), dropped };
  }

  get(seq: number): RingEntry<T> | undefined {
    return this.buf.find((e) => e.seq === seq);
  }

  clear(): void {
    this.buf = [];
    this.bytes = 0;
  }

  get size(): number {
    return this.buf.length;
  }
  get byteSize(): number {
    return this.bytes;
  }
  get totalDropped(): number {
    return this.evicted;
  }
}
