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
 *
 * A `serve` session's store is given an `AttachmentDisk`
 * (docs/feat/attachments-durable.md D2): it is seeded from what is on disk,
 * and the ack of a completed blob is sent only once the disk made it durable
 * (`put` then returns a promise — only from the verified last chunk on, so
 * the synchronous prefix above is unchanged).
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

/** The ack of a `put`: `have` contiguous bytes, `complete` = verified (and, with a disk, durable). */
export interface PutAck {
  readonly have: number;
  readonly complete: boolean;
}

/**
 * A verified blob in memory: its reservation is kept until the store is
 * disposed — or, with a disk, until it LANDS (`landing`: the ack, which
 * resolves once the file is durable, then the entry becomes `stored`).
 */
interface Complete {
  readonly kind: "complete";
  readonly bytes: Uint8Array;
  readonly landing: Promise<PutAck> | null;
}

/** A verified blob on disk only (docs/feat/attachments-durable.md D2): nothing in memory. */
interface Stored {
  readonly kind: "stored";
  readonly size: number;
}

type Entry = Partial | Complete | Stored;

/**
 * Where a `serve` session's verified blobs are made durable
 * (`SessionPersister.blobs`): absent = memory only (worker, pod daemons).
 */
export interface AttachmentDisk {
  /** The blobs already on disk (id → size), read once at construction. */
  readonly index: ReadonlyMap<BlobId, number>;
  /** Make the verified `bytes` of `id` durable; rejects when it could not. */
  write(id: BlobId, bytes: Uint8Array): Promise<void>;
  /** The bytes on disk, or `null`. */
  read(id: BlobId): Promise<Uint8Array | null>;
}

export interface AttachmentStoreOptions {
  /** A disk to make completed blobs durable on (`serve`); absent = memory only. */
  readonly disk?: AttachmentDisk;
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
  private readonly disk: AttachmentDisk | undefined;
  /**
   * This session's cap count: its partials' sizes + its completed blobs,
   * landing or on disk. The daemon `budget` counts only what is in MEMORY
   * (partials + complete in-memory blobs): a landed blob gives that back.
   */
  private used = 0;
  private disposed = false;

  constructor(budget: UploadBudget, opts: AttachmentStoreOptions = {}) {
    this.budget = budget;
    this.maxBytes = opts.maxBytes ?? SESSION_UPLOAD_BYTES;
    this.partialIdleMs = opts.partialIdleMs ?? PARTIAL_IDLE_MS;
    this.now = opts.now ?? Date.now;
    this.disk = opts.disk;
    for (const [id, size] of opts.disk?.index ?? []) {
      this.entries.set(id, { kind: "stored", size });
      this.used += size;
    }
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
  put(chunk: PutChunk): PutAck | Promise<PutAck> {
    const { id, size, offset, data } = chunk;
    // 1. The schema already refused these (P2); kept as a guard for a direct caller.
    if (size <= 0 || size > MAX_IMAGE_BYTES) {
      throw refuse("too_large", `an image is at most ${MAX_IMAGE_BYTES} bytes`);
    }
    const existing = this.entries.get(id);
    // 2. Already here: dedupe. A re-attached image transfers zero chunks; a
    //    different size under a verified id is a broken client. A blob still
    //    landing answers with ITS ack (sent once the file is durable).
    if (existing?.kind === "complete") {
      if (existing.bytes.length === size) {
        return existing.landing ?? { have: size, complete: true };
      }
      throw refuse("bad_chunk", `the blob is already complete at ${existing.bytes.length} bytes`);
    }
    if (existing?.kind === "stored") {
      if (existing.size === size) {
        return { have: size, complete: true };
      }
      throw refuse("bad_chunk", `the blob is already complete at ${existing.size} bytes`);
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
  ): PutAck | Promise<PutAck> {
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
      this.drop(id, partial);
      throw refuse("hash_mismatch", "the bytes do not hash to the id they claimed");
    }
    if (this.disk === undefined) {
      this.entries.set(id, { kind: "complete", bytes: partial.buf, landing: null });
      return { have: partial.size, complete: true };
    }
    // With a disk (docs/feat/attachments-durable.md D2): the ack waits for the
    // file to be durable, so no client is told "complete" about bytes a crash
    // could still lose. Everything above stayed synchronous (module comment).
    return this.land(id, partial.buf);
  }

  /**
   * Make a verified blob durable. Until it lands it is `complete` with a
   * `landing` ack (readable from memory, NOT `holds`); landed → `stored` and
   * its memory reservation goes back to the daemon; failed → dropped (both
   * reservations released) and the ack rejects `store_failed`.
   */
  private land(id: BlobId, bytes: Uint8Array): Promise<PutAck> {
    const disk = this.disk;
    if (disk === undefined) throw new Error("land() without a disk");
    const size = bytes.length;
    const { promise, resolve, reject } = Promise.withResolvers<PutAck>();
    const entry: Complete = { kind: "complete", bytes, landing: promise };
    this.entries.set(id, entry);
    disk.write(id, bytes).then(
      () => {
        // Disposed meanwhile (or replaced): its reservations went with it.
        if (this.entries.get(id) === entry) {
          this.entries.set(id, { kind: "stored", size });
          this.budget.release(size);
        }
        resolve({ have: size, complete: true });
      },
      (error: unknown) => {
        this.drop(id, entry);
        const why = error instanceof Error ? error.message : String(error);
        reject(refuse("store_failed", `the image could not be stored on the daemon: ${why}`));
      },
    );
    return promise;
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
        this.drop(staleId, entry);
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

  /** Forget `id` (only if it is still `only`, when given) and give back what it reserved. */
  private drop(id: BlobId, only?: Entry): void {
    const entry = this.entries.get(id);
    if (entry === undefined || (only !== undefined && entry !== only)) {
      return;
    }
    this.entries.delete(id);
    const size = sizeOf(entry);
    this.used = Math.max(0, this.used - size);
    // A blob on disk holds no memory: its daemon reservation went when it landed.
    if (entry.kind !== "stored") {
      this.budget.release(size);
    }
  }

  /**
   * The `AttachmentSource` seam sub-task 2b binds. `null` (never a throw) when
   * this store does not hold the ref's bytes: not uploaded yet, a partial, or a
   * size that disagrees with the id's blob — the provider then shows a
   * placeholder instead of a wrong image.
   */
  async read(ref: AttachmentRef): Promise<Uint8Array | null> {
    const entry = this.entries.get(ref.id);
    if (entry?.kind === "complete") {
      // In memory: a memory store's blob, or one still landing on disk.
      return entry.bytes.length === ref.size ? entry.bytes : null;
    }
    if (entry?.kind === "stored" && entry.size === ref.size && this.disk !== undefined) {
      // On disk: the size is re-checked here, the sha256 by the provider (P11).
      const bytes = await this.disk.read(ref.id);
      return bytes !== null && bytes.length === ref.size ? bytes : null;
    }
    return null;
  }

  /**
   * The SYNCHRONOUS twin of `read`'s predicate: this store holds the ref's
   * complete bytes, of exactly its size. `prompt` calls it inside its ack
   * (AGENTS §7: nothing awaited there), so a not-yet-uploaded image is refused
   * before anything is recorded. A blob still LANDING on disk is not held: a
   * ref recorded now could name bytes a crash then loses (the other client
   * gets `not_uploaded`, re-uploads, and dedupes on the landed blob).
   */
  holds(ref: AttachmentRef): boolean {
    const entry = this.entries.get(ref.id);
    if (entry?.kind === "stored") return entry.size === ref.size;
    return entry?.kind === "complete" && entry.landing === null && entry.bytes.length === ref.size;
  }

  /** Release every MEMORY reservation (never touches the disk). Idempotent: `close()` may run twice. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const id of [...this.entries.keys()]) {
      this.drop(id);
    }
    this.entries.clear();
  }
}

const touched = (entry: Entry): number => (entry.kind === "partial" ? entry.touchedAt : 0);

const sizeOf = (entry: Entry): number =>
  entry.kind === "complete" ? entry.bytes.length : entry.size;
