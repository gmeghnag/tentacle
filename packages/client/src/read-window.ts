/**
 * The read window — which chunks of an artifact version are in flight, and
 * whether what came back may be believed (docs/feat/model-artifacts.md D6).
 *
 * The mirror of `upload-window.ts`, traffic the other way, and pure for the
 * same reason (AGENTS §7): `next()` says which offset to read, `accept()` folds
 * one answer in, `rewind()` forgets what was in flight when the link dropped,
 * `finish()` hands the bytes back.
 *
 * It holds the CLIENT's trust boundary. The daemon may be a pod — whatever
 * controls the pod — so nothing it answers sizes anything: the buffer is the
 * META's `size` (schema-capped at `MAX_ARTIFACT_BYTES`), a chunk must be
 * exactly `min(C, size - offset)` bytes, the daemon's own `size` must equal the
 * meta's, and the whole must hash to the meta's `sha256`. Anything else is an
 * `ArtifactCorruptError`: stop, never retry, cache nothing.
 */
import { ATTACHMENT_CHUNK_BYTES, MAX_ARTIFACT_BYTES } from "@tentacle/protocol";
import { decodeBase64 } from "@tentacle/transport";

/** Chunks in flight at once: the upload's measured sweet spot (`docs/eval/rpc-flow-control.md`). */
export const READ_WINDOW = 2;

/** The daemon handed back other bytes than the meta announced: a viewer says "couldn't verify this file". */
export class ArtifactCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCorruptError";
  }
}

/** The caller's `signal` aborted the read: nothing is returned, nothing cached. */
export class ArtifactReadAbortedError extends Error {
  constructor() {
    super("the artifact read was aborted");
    this.name = "AbortError";
  }
}

/** The link dropped and did not come back (or cannot, here); reading again starts over. */
export class ArtifactLinkLostError extends Error {
  constructor(waitedMs?: number) {
    super(
      waitedMs === undefined
        ? "the link to the daemon dropped while reading the artifact and cannot be re-established here"
        : `the link to the daemon dropped while reading the artifact and did not come back within ${waitedMs / 1000}s`,
    );
    this.name = "ArtifactLinkLostError";
  }
}

export type ReadStep =
  | { readonly kind: "read"; readonly offset: number }
  | { readonly kind: "wait" }
  | { readonly kind: "done" };

export interface ReadWindowOptions {
  /** Chunks in flight (default `READ_WINDOW`). */
  readonly window?: number;
  /** Bytes per chunk (default `ATTACHMENT_CHUNK_BYTES`; the daemon's chunk). */
  readonly chunk?: number;
}

export class ReadWindow {
  readonly size: number;
  private readonly window: number;
  private readonly chunk: number;
  private readonly buffer: Uint8Array;
  /** Per chunk index: its bytes are in `buffer`. */
  private readonly held: boolean[];
  private readonly inFlight = new Set<number>();
  private heldCount = 0;
  private heldBytes = 0;

  /** `size` is the META's (never a daemon answer's): bounded before any buffer exists. */
  constructor(size: number, opts: ReadWindowOptions = {}) {
    if (!Number.isInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES) {
      throw new RangeError(`an artifact is 1..${MAX_ARTIFACT_BYTES} bytes (this one says ${size})`);
    }
    this.size = size;
    this.window = opts.window ?? READ_WINDOW;
    this.chunk = opts.chunk ?? ATTACHMENT_CHUNK_BYTES;
    this.buffer = new Uint8Array(size);
    this.held = new Array<boolean>(Math.ceil(size / this.chunk)).fill(false);
  }

  /** Bytes received and length-checked so far (progress). */
  get have(): number {
    return this.heldBytes;
  }

  /** The next thing to do: read one chunk, wait for an answer, or stop. */
  next(): ReadStep {
    if (this.heldCount === this.held.length) {
      return { kind: "done" };
    }
    if (this.inFlight.size >= this.window) {
      return { kind: "wait" };
    }
    const index = this.held.findIndex((got, i) => !got && !this.inFlight.has(i));
    if (index < 0) {
      // Every missing chunk is already out: their answers decide.
      return { kind: "wait" };
    }
    this.inFlight.add(index);
    return { kind: "read", offset: index * this.chunk };
  }

  /** Fold one `artifact/read` answer for `offset` (an offset THIS window handed out) in. */
  accept(offset: number, reply: { readonly data: string; readonly size: number }): void {
    const index = offset / this.chunk;
    if (!this.inFlight.delete(index)) {
      throw new Error(`no read in flight at offset ${offset}`);
    }
    if (reply.size !== this.size) {
      throw new ArtifactCorruptError(
        `the daemon says the artifact is ${reply.size} bytes; it was announced as ${this.size}`,
      );
    }
    const expected = Math.min(this.chunk, this.size - offset);
    // Checked on the TEXT first: a wrong-length chunk is never decoded at all.
    if (reply.data.length !== 4 * Math.ceil(expected / 3)) {
      throw new ArtifactCorruptError(
        `the chunk at ${offset} is not ${expected} bytes (base64 length ${reply.data.length})`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(reply.data);
    } catch {
      throw new ArtifactCorruptError(`the chunk at ${offset} is not canonical base64`);
    }
    if (bytes.length !== expected) {
      throw new ArtifactCorruptError(
        `the chunk at ${offset} is ${bytes.length} bytes, not ${expected}`,
      );
    }
    this.buffer.set(bytes, offset);
    if (this.held[index] !== true) {
      this.held[index] = true;
      this.heldCount += 1;
      this.heldBytes += expected;
    }
  }

  /** The link dropped: whatever was in flight is lost; the next read is the first MISSING chunk. */
  rewind(): void {
    this.inFlight.clear();
  }

  /**
   * The bytes, once every chunk is in AND they hash to `sha256` (the meta's,
   * lowercase hex). `hasher` is the client's binary sha-256.
   */
  finish(sha256: string, hasher: (bytes: Uint8Array) => string): Uint8Array {
    if (this.heldCount !== this.held.length) {
      throw new ArtifactCorruptError(`only ${this.heldBytes} of ${this.size} bytes arrived`);
    }
    if (hasher(this.buffer) !== sha256) {
      throw new ArtifactCorruptError("the artifact's bytes do not match its sha256");
    }
    return this.buffer;
  }
}
