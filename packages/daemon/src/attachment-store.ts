/**
 * The daemon's in-memory image store for `attachment/put`
 * (docs/feat/attachments-upload.md D2).
 *
 * Content-addressed by the sha256 of the whole blob, per session, bounded:
 * memory is reserved from the DECLARED size before a byte arrives, so a peer
 * that announces 15 MiB and sends nothing still pays for it. A partial that
 * stalls is evicted only when a new upload needs the room (owner Q3) —
 * completed blobs never are, because a ref in the history must keep resolving.
 *
 * `put` is SYNCHRONOUS from its offset check to its append, and that is
 * load-bearing (AGENTS §7, "don't serialize the RPC peer"): the peer calls
 * every handler's synchronous prefix in frame-arrival order without a lock, so
 * a sync check-and-append is atomic per frame per connection
 * (`.tentacle/tmp/attachments-upload/dispatch.ts`). An `await` anywhere before
 * the append would let two chunks of one blob interleave at the same offset.
 *
 * Nothing here reads the clock for a decision, touches a file, or names a path:
 * the bytes come from the caller and are verified against the id they claim
 * (AGENTS §7, "a pod is not trusted"). A `Complete` entry is always the
 * verified bytes of its id.
 */
import { createHash } from "node:crypto";
import type { AttachmentRef, AttachmentSource } from "@tentacle/core";
import { DomainErrorCode, MAX_IMAGE_BYTES } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** Per session (owner Q1): ≥ one full message, 5 × 15 MiB. */
export const SESSION_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Per daemon process (owner Q1), shared by every session's store. */
export const DAEMON_UPLOAD_BYTES = 256 * 1024 * 1024;

/** A partial with no touch for this long is a candidate for eviction (owner Q3). */
export const PARTIAL_IDLE_MS = 10 * 60 * 1000;

/** The content-addressed key of a blob: its sha256, lowercase hex. */
export type BlobId = string;

/**
 * One daemon's byte allowance, shared by every session's store. Counting the
 * DECLARED size (not the bytes received) is what bounds memory: a begun upload
 * costs its full size at once. One instance per `SessionHost`, so the cap is
 * the process's, not a connection's.
 */
export class UploadBudget {
  private reserved = 0;

  constructor(readonly maxBytes: number = DAEMON_UPLOAD_BYTES) {}

  /** Take `n` bytes if the budget has them; false (and nothing taken) otherwise. */
  reserve(n: number): boolean {
    if (this.reserved + n > this.maxBytes) {
      return false;
    }
    this.reserved += n;
    return true;
  }

  release(n: number): void {
    this.reserved = Math.max(0, this.reserved - n);
  }

  get used(): number {
    return this.reserved;
  }
}

/** A blob still arriving: the buffer is `size` long from the start (bounded), `have` of it verified. */
interface Partial {
  readonly kind: "partial";
  readonly size: number;
  readonly buf: Uint8Array;
  have: number;
  readonly hasher: ReturnType<typeof createHash>;
  touchedAt: number;
}

/** A verified blob: its reservation is kept until the store is disposed. */
interface Complete {
  readonly kind: "complete";
  readonly bytes: Uint8Array;
}

type Entry = Partial | Complete;

export interface AttachmentStoreOptions {
  /** This session's cap (default `SESSION_UPLOAD_BYTES`). */
  readonly maxBytes?: number;
  /** How long a partial may sit untouched and still be evictable-for-space (default `PARTIAL_IDLE_MS`). */
  readonly partialIdleMs?: number;
  /** The clock, injected so idle eviction is testable. */
  readonly now?: () => number;
}

/** One `attachment/put`'s payload, minus the session id the connection resolved. */
export interface PutChunk {
  readonly id: BlobId;
  readonly size: number;
  readonly offset: number;
  /** Base64; `""` is a probe. */
  readonly data: string;
}

const refuse = (reason: string, message: string): RpcError =>
  new RpcError(DomainErrorCode.AttachmentRefused, message, { reason });

export class AttachmentStore implements AttachmentSource {
  private readonly entries = new Map<BlobId, Entry>();
  private readonly budget: UploadBudget;
  private readonly maxBytes: number;
  private readonly partialIdleMs: number;
  private readonly now: () => number;
  /** This store's own reservation (its partials' sizes + its completed blobs). */
  private used = 0;
  private disposed = false;

  constructor(budget: UploadBudget, opts: AttachmentStoreOptions = {}) {
    this.budget = budget;
    this.maxBytes = opts.maxBytes ?? SESSION_UPLOAD_BYTES;
    this.partialIdleMs = opts.partialIdleMs ?? PARTIAL_IDLE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Bytes this session's store holds, partials' declared sizes included. */
  get held(): number {
    return this.used;
  }

  /**
   * Take one chunk. Synchronous from the offset check to the append — the
   * atomicity the design relies on (module comment). Throws an
   * `AttachmentRefused` `RpcError`; every other outcome is an ack of `have`.
   */
  put(chunk: PutChunk): { have: number; complete: boolean } {
    const { id, size, offset, data } = chunk;
    // 1. The schema already refused these (P2); kept as a guard for a direct caller.
    if (size <= 0 || size > MAX_IMAGE_BYTES) {
      throw refuse("too_large", `an image is at most ${MAX_IMAGE_BYTES} bytes`);
    }
    const existing = this.entries.get(id);
    // 2. Already here: dedupe. A re-attached image transfers zero chunks; a
    //    different size under a verified id is a broken client.
    if (existing?.kind === "complete") {
      if (existing.bytes.length === size) {
        return { have: size, complete: true };
      }
      throw refuse("bad_chunk", `the blob is already complete at ${existing.bytes.length} bytes`);
    }
    // 3. A new blob: it must start at 0 (or be a bare probe), and it pays for
    //    its declared size NOW, before a byte arrives.
    if (existing === undefined) {
      if (data !== "" && offset !== 0) {
        return { have: 0, complete: false };
      }
      if (!this.reserve(size)) {
        throw refuse("store_full", `no room for ${size} more bytes (session or daemon cap)`);
      }
      const partial: Partial = {
        kind: "partial",
        size,
        buf: new Uint8Array(size),
        have: 0,
        hasher: createHash("sha256"),
        touchedAt: this.now(),
      };
      this.entries.set(id, partial);
      return this.advance(partial, id, offset, data);
    }
    // 4. An id fixes its size: a partial of another size is a broken client.
    if (existing.size !== size) {
      throw refuse("bad_chunk", `this blob began at ${existing.size} bytes`);
    }
    return this.advance(existing, id, offset, data);
  }

  /**
   * The appends, for a partial that already exists (rules 5–9).
   */
  private advance(
    partial: Partial,
    id: BlobId,
    offset: number,
    data: string,
  ): { have: number; complete: boolean } {
    // 5. The probe: `have` back, no bytes, and the entry counts as touched.
    if (data === "") {
      partial.touchedAt = this.now();
      return { have: partial.have, complete: false };
    }
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    // 6. Past the end, or an empty payload: broken. The partial is kept (its
    //    reservation and its verified prefix survive a bad frame).
    if (bytes.length === 0 || offset + bytes.length > partial.size) {
      throw refuse("bad_chunk", `chunk ${offset}+${bytes.length} is outside ${partial.size}`);
    }
    // 7. Wholly inside what we hold: a duplicate. Ack, write nothing, compare
    //    nothing (its bytes were hashed once already; a lying duplicate never
    //    reaches the buffer).
    if (offset + bytes.length <= partial.have) {
      partial.touchedAt = this.now();
      return { have: partial.have, complete: false };
    }
    // 8. A gap, or a straddle of `have`: ack the current `have` and write
    //    nothing — the client rewinds to it, so out-of-order converges.
    if (offset !== partial.have) {
      partial.touchedAt = this.now();
      return { have: partial.have, complete: false };
    }
    // 9. Contiguous: copy, hash, advance.
    partial.buf.set(bytes, offset);
    partial.hasher.update(bytes);
    partial.have += bytes.length;
    partial.touchedAt = this.now();
    if (partial.have < partial.size) {
      return { have: partial.have, complete: false };
    }
    // The last chunk: the digest decides. Verified → keep the buffer as is (no
    // copy) and keep the reservation, which belongs to the completed blob.
    if (partial.hasher.digest("hex") !== id) {
      this.drop(id, partial.size);
      throw refuse("hash_mismatch", "the bytes do not hash to the id they claimed");
    }
    this.entries.set(id, { kind: "complete", bytes: partial.buf });
    return { have: partial.size, complete: true };
  }

  /**
   * Reserve `size` in BOTH caps, evicting stale partials first if that is what
   * it takes (owner Q3: only when a new upload needs the room, never a timer).
   * Nothing is reserved on failure.
   */
  private reserve(size: number): boolean {
    if (this.fits(size)) {
      return this.take(size);
    }
    // Oldest stale partial first; the entry being begun is not in the map yet.
    const stale = [...this.entries]
      .filter(([, e]) => e.kind === "partial" && this.now() - e.touchedAt >= this.partialIdleMs)
      .sort((a, b) => touched(a[1]) - touched(b[1]));
    for (const [staleId, entry] of stale) {
      if (this.fits(size)) {
        break;
      }
      if (entry.kind === "partial") {
        this.drop(staleId, entry.size);
      }
    }
    return this.fits(size) && this.take(size);
  }

  private fits(size: number): boolean {
    return this.used + size <= this.maxBytes && this.budget.used + size <= this.budget.maxBytes;
  }

  private take(size: number): boolean {
    if (!this.budget.reserve(size)) {
      return false;
    }
    this.used += size;
    return true;
  }

  private drop(id: BlobId, size: number): void {
    if (!this.entries.delete(id)) {
      return;
    }
    this.used = Math.max(0, this.used - size);
    this.budget.release(size);
  }

  /**
   * The `AttachmentSource` seam sub-task 2b binds. `null` (never a throw) when
   * this store does not hold the ref's bytes: not uploaded yet, a partial, or a
   * size that disagrees with the id's blob — the provider then shows a
   * placeholder instead of a wrong image.
   */
  async read(ref: AttachmentRef): Promise<Uint8Array | null> {
    const entry = this.entries.get(ref.id);
    return this.holds(ref) && entry?.kind === "complete" ? entry.bytes : null;
  }

  /**
   * The SYNCHRONOUS twin of `read`'s predicate: this store holds the ref's
   * complete bytes, of exactly its size. `prompt` calls it inside its ack
   * (AGENTS §7: nothing awaited there), so a not-yet-uploaded image is refused
   * before anything is recorded.
   */
  holds(ref: AttachmentRef): boolean {
    const entry = this.entries.get(ref.id);
    return entry?.kind === "complete" && entry.bytes.length === ref.size;
  }

  /** Release every reservation. Idempotent: `close()` may run twice. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [id, entry] of this.entries) {
      this.drop(id, entry.kind === "partial" ? entry.size : entry.bytes.length);
    }
    this.entries.clear();
  }
}

const touched = (entry: Entry): number => (entry.kind === "partial" ? entry.touchedAt : 0);
