import { describe, expect, test } from "bun:test";
/**
 * `AttachmentStore` — the daemon's image store (docs/feat/attachments-upload.md T2).
 *
 * The property: a blob becomes readable EXACTLY when its whole sha256-verified
 * byte string is in, whatever the order, duplicates and repeats of the chunks
 * that built it; and memory is bounded by the declared size the moment an
 * upload begins, returned when it fails or when the session ends.
 */
import { createHash } from "node:crypto";
import { DomainErrorCode, MAX_IMAGE_BYTES } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  AttachmentStore,
  DAEMON_UPLOAD_BYTES,
  SESSION_UPLOAD_BYTES,
  UploadBudget,
} from "../src/attachment-store.ts";

const CHUNK = 256 * 1024;

type Ack = { have: number; complete: boolean };

/** `got` is exactly `want`'s bytes. */
const same = (got: Uint8Array | null, want: Uint8Array): boolean =>
  got !== null && Buffer.compare(got, want) === 0;

/** A memory store's ack is synchronous: unwrap it (a promise here is a bug the test should see). */
const sync = (ack: Ack | Promise<Ack>): Ack => {
  if (ack instanceof Promise) throw new Error("expected a synchronous ack");
  return ack;
};

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A deterministic blob of `size` bytes (never all zeros: a swapped chunk must show). */
function blob(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const chunkAt = (bytes: Uint8Array, offset: number, length = CHUNK): string =>
  Buffer.from(bytes.subarray(offset, offset + length)).toString("base64");

/** A store plus the budgets it charges, for the assertions that read them. */
function store(opts: { maxBytes?: number; partialIdleMs?: number; now?: () => number } = {}): {
  store: AttachmentStore;
  budget: UploadBudget;
} {
  const budget = new UploadBudget();
  return { store: new AttachmentStore(budget, opts), budget };
}

/** Feed `bytes` in order, chunk by chunk; returns the last ack. */
function upload(
  s: AttachmentStore,
  bytes: Uint8Array,
  id: string = sha(bytes),
): Ack | Promise<Ack> {
  let ack: Ack | Promise<Ack> = { have: 0, complete: false };
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    ack = s.put({
      id,
      size: bytes.length,
      offset,
      data: chunkAt(bytes, offset, Math.min(CHUNK, bytes.length - offset)),
    });
  }
  return ack;
}

const refusal = (fn: () => unknown): { code: number; reason?: unknown } => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RpcError) {
      return { code: error.code, reason: (error.data as { reason?: unknown } | undefined)?.reason };
    }
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("happy path: in-order chunks become one verified blob", () => {
  test("1 MiB in four chunks: complete, and `read` returns the exact bytes", async () => {
    const { store: s } = store();
    const bytes = blob(1024 * 1024);
    const id = sha(bytes);
    expect(upload(s, bytes)).toEqual({ have: bytes.length, complete: true });
    const read = await s.read({ id, mimeType: "image/png", size: bytes.length });
    expect(read).not.toBeNull();
    expect(Buffer.from(read ?? new Uint8Array()).toString("hex")).toBe(
      Buffer.from(bytes).toString("hex"),
    );
  });

  test("a probe on a complete blob answers `{have: size, complete: true}` (dedupe)", () => {
    const { store: s } = store();
    const bytes = blob(CHUNK);
    const id = sha(bytes);
    upload(s, bytes);
    expect(s.put({ id, size: bytes.length, offset: 0, data: "" })).toEqual({
      have: bytes.length,
      complete: true,
    });
  });

  test("a single chunk smaller than the chunk size completes at once", () => {
    const { store: s } = store();
    const bytes = blob(10);
    expect(s.put({ id: sha(bytes), size: 10, offset: 0, data: chunkAt(bytes, 0, 10) })).toEqual({
      have: 10,
      complete: true,
    });
  });
});

describe("idempotent and order-tolerant", () => {
  test("a duplicate chunk carrying DIFFERENT bytes leaves the blob byte-identical", async () => {
    const { store: s } = store();
    const bytes = blob(3 * CHUNK);
    const id = sha(bytes);
    // Chunks 0 and 1.
    s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0) });
    s.put({ id, size: bytes.length, offset: CHUNK, data: chunkAt(bytes, CHUNK) });
    // A RETRY of chunk 0 with corrupted bytes: acked, never written (rule 7).
    const lying = Buffer.alloc(CHUNK, 0xff).toString("base64");
    expect(s.put({ id, size: bytes.length, offset: 0, data: lying })).toEqual({
      have: 2 * CHUNK,
      complete: false,
    });
    // The rest, honestly.
    s.put({ id, size: bytes.length, offset: 2 * CHUNK, data: chunkAt(bytes, 2 * CHUNK) });
    const read = await s.read({ id, mimeType: "image/png", size: bytes.length });
    expect(Buffer.from(read ?? new Uint8Array()).toString("hex")).toBe(
      Buffer.from(bytes).toString("hex"),
    );
  });

  test("a gap acks the current `have` and writes nothing", () => {
    const { store: s } = store();
    const bytes = blob(3 * CHUNK);
    const id = sha(bytes);
    s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0) });
    // Chunk 2 before chunk 1: out of order.
    expect(
      s.put({ id, size: bytes.length, offset: 2 * CHUNK, data: chunkAt(bytes, 2 * CHUNK) }),
    ).toEqual({ have: CHUNK, complete: false });
    // Now the right one: it lands, then chunk 2 completes the blob.
    expect(s.put({ id, size: bytes.length, offset: CHUNK, data: chunkAt(bytes, CHUNK) })).toEqual({
      have: 2 * CHUNK,
      complete: false,
    });
    expect(
      s.put({ id, size: bytes.length, offset: 2 * CHUNK, data: chunkAt(bytes, 2 * CHUNK) }),
    ).toEqual({ have: 3 * CHUNK, complete: true });
  });

  test("a straddle of `have` acks it and writes nothing", () => {
    const { store: s } = store();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0, CHUNK / 2) });
    // Starts before `have`, ends after it: neither a duplicate nor contiguous.
    expect(
      s.put({
        id,
        size: bytes.length,
        offset: CHUNK / 4,
        data: chunkAt(bytes, CHUNK / 4, CHUNK / 2),
      }),
    ).toEqual({ have: CHUNK / 2, complete: false });
  });

  test("a first chunk that does not start at 0 is refused with `have: 0` and reserves nothing", () => {
    const { store: s, budget } = store();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    expect(s.put({ id, size: bytes.length, offset: CHUNK, data: chunkAt(bytes, CHUNK) })).toEqual({
      have: 0,
      complete: false,
    });
    expect(budget.used).toBe(0);
  });
});

describe("refusals", () => {
  test("a chunk past the declared end is `bad_chunk`; the partial is kept", () => {
    const { store: s } = store();
    const bytes = blob(100);
    const id = sha(bytes);
    s.put({ id, size: 100, offset: 0, data: chunkAt(bytes, 0, 30) });
    expect(
      refusal(() => s.put({ id, size: 100, offset: 90, data: chunkAt(bytes, 50, 20) })),
    ).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "bad_chunk",
    });
    // Its verified prefix survives.
    expect(sync(s.put({ id, size: 100, offset: 0, data: "" })).have).toBe(30);
  });

  test("a wrong last chunk is `hash_mismatch`: the entry and its reservation go", () => {
    const { store: s, budget } = store();
    const bytes = blob(CHUNK);
    const id = sha(bytes);
    const before = budget.used;
    const corrupted = blob(CHUNK, 99);
    expect(
      refusal(() => s.put({ id, size: CHUNK, offset: 0, data: chunkAt(corrupted, 0) })),
    ).toEqual({ code: DomainErrorCode.AttachmentRefused, reason: "hash_mismatch" });
    expect(budget.used).toBe(before);
    // Dropped, not left half-there: a probe now starts over.
    expect(s.put({ id, size: CHUNK, offset: 0, data: "" })).toEqual({ have: 0, complete: false });
  });

  test("a size above MAX_IMAGE_BYTES is `too_large` (the schema's backstop)", () => {
    const { store: s } = store();
    expect(
      refusal(() => s.put({ id: "a".repeat(64), size: MAX_IMAGE_BYTES + 1, offset: 0, data: "" })),
    ).toEqual({ code: DomainErrorCode.AttachmentRefused, reason: "too_large" });
  });

  test("a second size for a complete id is `bad_chunk`", () => {
    const { store: s } = store();
    const bytes = blob(10);
    const id = sha(bytes);
    upload(s, bytes);
    expect(refusal(() => s.put({ id, size: 11, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "bad_chunk",
    });
  });

  test("a second size for a partial id is `bad_chunk`", () => {
    const { store: s } = store();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0) });
    expect(refusal(() => s.put({ id, size: bytes.length + 1, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "bad_chunk",
    });
  });
});

describe("bounded memory", () => {
  test("a begun upload reserves its DECLARED size before any byte arrives", () => {
    const { store: s, budget } = store();
    s.put({ id: "b".repeat(64), size: MAX_IMAGE_BYTES, offset: 0, data: "" });
    expect(budget.used).toBe(MAX_IMAGE_BYTES);
    expect(s.held).toBe(MAX_IMAGE_BYTES);
  });

  test("the session cap refuses a new upload with `store_full`, reserving nothing", () => {
    const { store: s, budget } = store({ maxBytes: 1000 });
    s.put({ id: "b".repeat(64), size: 600, offset: 0, data: "" });
    const used = budget.used;
    expect(refusal(() => s.put({ id: "c".repeat(64), size: 500, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "store_full",
    });
    expect(budget.used).toBe(used);
    expect(s.held).toBe(600);
  });

  test("the daemon budget bounds the SUM of sessions, reserving nothing on refusal", () => {
    const budget = new UploadBudget(1000);
    const a = new AttachmentStore(budget);
    const b = new AttachmentStore(budget);
    a.put({ id: "a".repeat(64), size: 700, offset: 0, data: "" });
    expect(refusal(() => b.put({ id: "b".repeat(64), size: 400, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "store_full",
    });
    expect(budget.used).toBe(700);
    // Room is shared, so a smaller one fits.
    expect(sync(b.put({ id: "b".repeat(64), size: 300, offset: 0, data: "" })).have).toBe(0);
    expect(budget.used).toBe(1000);
  });

  test("the defaults are the owner's (100 MiB a session, 256 MiB a daemon)", () => {
    expect(SESSION_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(DAEMON_UPLOAD_BYTES).toBe(256 * 1024 * 1024);
  });

  test("a stale partial is evicted to make room; a fresh one is not", () => {
    let clock = 0;
    const { store: s, budget } = store({ maxBytes: 1000, now: () => clock });
    s.put({ id: "a".repeat(64), size: 600, offset: 0, data: "" });
    clock = 5 * 60 * 1000;
    s.put({ id: "b".repeat(64), size: 200, offset: 0, data: "" });
    // Not stale yet (both touched within 10 min): the new one is refused.
    clock = 9 * 60 * 1000;
    expect(refusal(() => s.put({ id: "c".repeat(64), size: 500, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "store_full",
    });
    // 11 min after `a` was touched (and 6 after `b`): only `a` is stale.
    clock = 11 * 60 * 1000;
    expect(sync(s.put({ id: "c".repeat(64), size: 500, offset: 0, data: "" })).have).toBe(0);
    expect(budget.used).toBe(700); // b (200, kept: fresh) + c (500)
  });

  test("a completed blob is never evicted for room (a ref in history must resolve)", () => {
    let clock = 0;
    const { store: s } = store({ maxBytes: 1000, now: () => clock });
    const bytes = blob(600);
    upload(s, bytes);
    clock = 60 * 60 * 1000;
    expect(refusal(() => s.put({ id: "c".repeat(64), size: 500, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "store_full",
    });
  });

  test("`dispose` releases everything and is idempotent", () => {
    const { store: s, budget } = store();
    const complete = blob(CHUNK);
    upload(s, complete);
    s.put({ id: "b".repeat(64), size: 4096, offset: 0, data: "" });
    expect(budget.used).toBe(CHUNK + 4096);
    s.dispose();
    expect(budget.used).toBe(0);
    expect(s.held).toBe(0);
    s.dispose();
    expect(budget.used).toBe(0);
  });
});

describe("the 2b seam: `read`", () => {
  test("a partial, an unknown id, or a size-mismatched ref reads `null`", async () => {
    const { store: s } = store();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0) });
    expect(await s.read({ id, mimeType: "image/png", size: bytes.length })).toBeNull();
    expect(await s.read({ id: "f".repeat(64), mimeType: "image/png", size: 4 })).toBeNull();
    upload(s, bytes);
    expect(await s.read({ id, mimeType: "image/png", size: bytes.length - 1 })).toBeNull();
  });
});

describe("`holds`: the synchronous twin of `read` (attachments-prompt D2)", () => {
  test("true only for a complete blob whose length matches the ref's size", () => {
    const { store: s } = store();
    const bytes = blob(2 * CHUNK);
    const id = sha(bytes);
    const ref = { id, mimeType: "image/png", size: bytes.length };
    s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0) });
    expect(s.holds(ref)).toBe(false); // a partial
    upload(s, bytes);
    expect(s.holds(ref)).toBe(true);
    expect(s.holds({ ...ref, size: bytes.length - 1 })).toBe(false);
    expect(s.holds({ ...ref, id: "f".repeat(64) })).toBe(false);
  });

  test("returns a boolean, never a Promise (it is called inside a synchronous ack)", () => {
    const { store: s } = store();
    const held = s.holds({ id: "a".repeat(64), mimeType: "image/png", size: 4 });
    expect(held).not.toBeInstanceOf(Promise);
    expect(held).toBe(false);
  });
});

describe("synchronous by contract (AGENTS §7: the peer is never serialized)", () => {
  test("`put` returns a plain ack object, never a Promise", () => {
    const { store: s } = store();
    const ack = s.put({ id: "a".repeat(64), size: 10, offset: 0, data: "" });
    expect(ack).toEqual({ have: 0, complete: false });
    expect(ack).not.toBeInstanceOf(Promise);
  });
});

describe("disk-backed (`serve`): docs/feat/attachments-durable.md T3", () => {
  /** A fake disk: writes wait on a gate the test opens (or fails). */
  function fakeDisk(seed: Map<string, Uint8Array> = new Map()) {
    const files = new Map(seed);
    const gates: Array<{ id: string; open: () => void; fail: (e: Error) => void }> = [];
    let auto = false;
    const disk = {
      index: new Map([...seed].map(([id, b]) => [id, b.length])),
      writes: 0,
      reads: 0,
      write(id: string, bytes: Uint8Array): Promise<void> {
        disk.writes++;
        if (auto) {
          files.set(id, bytes);
          return Promise.resolve();
        }
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        gates.push({
          id,
          open: () => {
            files.set(id, bytes);
            resolve();
          },
          fail: reject,
        });
        return promise;
      },
      async read(id: string): Promise<Uint8Array | null> {
        disk.reads++;
        return files.get(id) ?? null;
      },
    };
    return {
      disk,
      files,
      gates,
      autoLand: () => {
        auto = true;
      },
    };
  }

  const ref = (bytes: Uint8Array) => ({
    id: sha(bytes),
    mimeType: "image/png",
    size: bytes.length,
  });
  const settled = async <T>(p: Promise<T>) => {
    let state: "pending" | "resolved" | "rejected" = "pending";
    p.then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    return state;
  };

  test("the completion ack resolves only once the file is durable; held only after; memory released, session cap kept", async () => {
    const { disk, gates } = fakeDisk();
    const budget = new UploadBudget();
    const s = new AttachmentStore(budget, { disk });
    const bytes = blob(CHUNK + 10);
    const ack = upload(s, bytes);
    expect(ack).toBeInstanceOf(Promise);
    const pending = Promise.resolve(ack);
    expect(await settled(pending)).toBe("pending");
    expect(s.holds(ref(bytes))).toBe(false);
    // Landing: the memory bytes still serve a read.
    const during = await s.read(ref(bytes));
    expect(same(during, bytes)).toBe(true);
    expect(budget.used).toBe(bytes.length);
    gates[0]?.open();
    expect(await pending).toEqual({ have: bytes.length, complete: true });
    expect(s.holds(ref(bytes))).toBe(true);
    expect(budget.used).toBe(0);
    expect(s.held).toBe(bytes.length);
    const after = await s.read(ref(bytes));
    expect(same(after, bytes)).toBe(true);
    expect(disk.reads).toBe(1);
  });

  test("a failing write rejects `store_failed` with the OS message; both caps back to prior; a retry can land", async () => {
    const { disk, gates } = fakeDisk();
    const budget = new UploadBudget();
    const s = new AttachmentStore(budget, { disk });
    const bytes = blob(100);
    const ack = Promise.resolve(upload(s, bytes));
    gates[0]?.fail(new Error("couldn't write x: no space left on device (ENOSPC)"));
    const error = await ack.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(DomainErrorCode.AttachmentRefused);
    expect(((error as RpcError).data as { reason?: unknown }).reason).toBe("store_failed");
    expect((error as RpcError).message).toContain("no space left");
    expect(budget.used).toBe(0);
    expect(s.held).toBe(0);
    expect(s.holds(ref(bytes))).toBe(false);
    expect(await s.read(ref(bytes))).toBeNull();
    const retry = Promise.resolve(upload(s, bytes));
    gates[1]?.open();
    expect(await retry).toEqual({ have: 100, complete: true });
  });

  test("a duplicate final chunk or a probe during landing returns the SAME ack", async () => {
    const { disk, gates } = fakeDisk();
    const s = new AttachmentStore(new UploadBudget(), { disk });
    const bytes = blob(50);
    const first = upload(s, bytes);
    const dup = s.put({ id: sha(bytes), size: 50, offset: 0, data: chunkAt(bytes, 0, 50) });
    const probe = s.put({ id: sha(bytes), size: 50, offset: 0, data: "" });
    expect(dup).toBe(first);
    expect(probe).toBe(first);
    expect(disk.writes).toBe(1);
    gates[0]?.open();
    expect(await probe).toEqual({ have: 50, complete: true });
  });

  test("before the last chunk `put` stays synchronous: two chunks in one tick are ordered", () => {
    const { disk } = fakeDisk();
    const s = new AttachmentStore(new UploadBudget(), { disk });
    const bytes = blob(3 * CHUNK);
    const id = sha(bytes);
    const a = s.put({ id, size: bytes.length, offset: 0, data: chunkAt(bytes, 0) });
    const b = s.put({ id, size: bytes.length, offset: CHUNK, data: chunkAt(bytes, CHUNK) });
    expect(a).toEqual({ have: CHUNK, complete: false });
    expect(b).toEqual({ have: 2 * CHUNK, complete: false });
    expect(a).not.toBeInstanceOf(Promise);
  });

  test("seeded from the disk index: held, read from disk, deduped with zero chunks, counted in the session cap only", async () => {
    const bytes = blob(70);
    const { disk } = fakeDisk(new Map([[sha(bytes), bytes]]));
    const budget = new UploadBudget();
    const s = new AttachmentStore(budget, { disk });
    expect(s.holds(ref(bytes))).toBe(true);
    expect(s.held).toBe(70);
    expect(budget.used).toBe(0);
    const got = await s.read(ref(bytes));
    expect(same(got, bytes)).toBe(true);
    expect(s.put({ id: sha(bytes), size: 70, offset: 0, data: "" })).toEqual({
      have: 70,
      complete: true,
    });
    expect(disk.writes).toBe(0);
    // A ref of another size under that id is not held.
    expect(s.holds({ ...ref(bytes), size: 71 })).toBe(false);
    expect(await s.read({ ...ref(bytes), size: 71 })).toBeNull();
  });

  test("disk bytes of the wrong size (truncated file) → null, never wrong bytes", async () => {
    const bytes = blob(70);
    const { disk, files } = fakeDisk(new Map([[sha(bytes), bytes]]));
    const s = new AttachmentStore(new UploadBudget(), { disk });
    files.set(sha(bytes), bytes.subarray(0, 40));
    expect(await s.read(ref(bytes))).toBeNull();
  });

  test("the session cap counts what is on disk: over it, a new upload is `store_full` before a byte", () => {
    const bytes = blob(80);
    const { disk } = fakeDisk(new Map([[sha(bytes), bytes]]));
    const s = new AttachmentStore(new UploadBudget(), { disk, maxBytes: 100 });
    const other = blob(30, 9);
    expect(refusal(() => s.put({ id: sha(other), size: 30, offset: 0, data: "" }))).toEqual({
      code: DomainErrorCode.AttachmentRefused,
      reason: "store_full",
    });
  });

  test("dispose releases memory only: the disk is never touched", async () => {
    const { disk, gates, files } = fakeDisk();
    const budget = new UploadBudget();
    const s = new AttachmentStore(budget, { disk });
    const bytes = blob(20);
    const ack = Promise.resolve(upload(s, bytes));
    s.dispose();
    expect(budget.used).toBe(0);
    gates[0]?.open();
    await ack;
    expect(budget.used).toBe(0);
    expect(files.has(sha(bytes))).toBe(true);
  });
});
