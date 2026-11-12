/**
 * The upload window — how many chunks of an image are in flight, and where the
 * next one starts (docs/feat/attachments-upload.md D4).
 *
 * A pure module (AGENTS §7: every branch a test would want to make lives here,
 * not in a component or a request loop): `next()` says what to send, `ack()`
 * folds the daemon's answer back in. W=2 is the measured sweet spot on a real
 * link — larger windows only add queueing latency to the control traffic that
 * shares the connection (`docs/eval/rpc-flow-control.md`).
 *
 * It also holds the LAPTOP's trust boundary: the daemon (in a pod, it is
 * whatever controls the pod) may answer anything, so a `have` past the blob, a
 * `complete` that is not the whole blob, or an endless `have: 0` is a
 * violation that throws, never a reason to keep sending.
 */
import { ATTACHMENT_CHUNK_BYTES } from "@tentacle/protocol";

/** Chunks in flight at once (docs/eval/rpc-flow-control.md: the measured sweet spot). */
export const UPLOAD_WINDOW = 2;

/**
 * How many times the blob's own size we may ever put on the wire. A daemon
 * that keeps answering `have: 0` would otherwise make the laptop send forever;
 * three passes is room for a reconnect or two on a genuinely bad link.
 */
export const UPLOAD_MAX_SENT_FACTOR = 3;

/** The daemon answered something a correct one never does: stop, do not retry. */
export class UploadProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadProtocolError";
  }
}

/** The caller's `signal` aborted the upload; the daemon's partial stays, so a later upload resumes. */
export class UploadAbortedError extends Error {
  constructor() {
    super("the upload was aborted");
    this.name = "AbortError";
  }
}

export type UploadStep =
  | { readonly kind: "send"; readonly offset: number; readonly length: number }
  | { readonly kind: "wait" }
  | { readonly kind: "done" };

/** One chunk in flight: where it starts and how long it is. */
interface InFlight {
  readonly offset: number;
  readonly length: number;
}

export interface UploadWindowOptions {
  /** Chunks in flight (default `UPLOAD_WINDOW`; tests run it at 1). */
  readonly window?: number;
  /** Bytes per chunk (default `ATTACHMENT_CHUNK_BYTES`). */
  readonly chunk?: number;
  /** The send bound, as a multiple of `size` (default `UPLOAD_MAX_SENT_FACTOR`). */
  readonly maxSentFactor?: number;
}

export class UploadWindow {
  readonly size: number;
  private readonly window: number;
  private readonly chunk: number;
  /** Bytes that may ever be sent: `maxSentFactor × size + window × chunk`. */
  private readonly sentCap: number;
  /** Next offset to send from. */
  private cursor = 0;
  /** Highest contiguous `have` the daemon has acknowledged. */
  private acked = 0;
  private readonly inFlight: InFlight[] = [];
  private sentBytes = 0;
  private done = false;

  constructor(size: number, opts: UploadWindowOptions = {}) {
    this.size = size;
    this.window = opts.window ?? UPLOAD_WINDOW;
    this.chunk = opts.chunk ?? ATTACHMENT_CHUNK_BYTES;
    this.sentCap = (opts.maxSentFactor ?? UPLOAD_MAX_SENT_FACTOR) * size + this.window * this.chunk;
  }

  /** Bytes the daemon has confirmed, from 0 (progress, for the TUI in 3b). */
  get have(): number {
    return this.acked;
  }

  /** Chunks currently out (a test reads it; the loop only obeys `next`). */
  get outstanding(): number {
    return this.inFlight.length;
  }

  /** Bytes this window has asked the caller to put on the wire. */
  get sent(): number {
    return this.sentBytes;
  }

  /** The next thing to do: send one chunk, wait for an ack, or stop. */
  next(): UploadStep {
    // An ack may have completed the blob while chunks were still in flight
    // (another client finished it; our own duplicate did).
    if (this.done || this.acked >= this.size) {
      return { kind: "done" };
    }
    if (this.inFlight.length >= this.window) {
      return { kind: "wait" };
    }
    if (this.cursor >= this.size) {
      // Everything is out; the acks decide whether it landed.
      return this.inFlight.length > 0 ? { kind: "wait" } : this.overrun();
    }
    const offset = this.cursor;
    const length = Math.min(this.chunk, this.size - offset);
    // Checked BEFORE the chunk is handed out, so the bound is never exceeded.
    if (this.sentBytes + length > this.sentCap) {
      throw new UploadProtocolError(
        // One template literal: a `+` join of two templates trips `useTemplate`.
        `sent ${this.sentBytes} bytes for a ${this.size}-byte image (a daemon that never advances cannot make this laptop send forever)`,
      );
    }
    this.cursor = offset + length;
    this.inFlight.push({ offset, length });
    this.sentBytes += length;
    return { kind: "send", offset, length };
  }

  /**
   * Fold one put's answer in. `sentOffset` identifies which in-flight chunk it
   * answers (a reconnect drops the bookkeeping and re-probes instead).
   */
  ack(sentOffset: number, result: { have: number; complete: boolean }): void {
    const { have, complete } = result;
    this.checked(sentOffset, have, complete);
    const entry = this.forget(sentOffset);
    const length = entry?.length ?? this.size - sentOffset;
    if (have > this.acked) {
      this.acked = have;
    }
    // This chunk's bytes are NOT what the daemon holds (a gap, a reorder, a
    // daemon that restarted under us): go back to what it really has. Its
    // remaining in-flight siblings will ack as gaps and change nothing.
    if (have < sentOffset + length) {
      this.cursor = have;
    }
    if (complete) {
      this.done = true;
      this.inFlight.length = 0;
    }
  }

  /** Adopt the daemon's `have` after a reconnect (the link came back; start there). */
  rewind(have: number): void {
    if (!Number.isInteger(have) || have < 0 || have > this.size) {
      throw new UploadProtocolError(`the daemon claims have=${have} of ${this.size} bytes`);
    }
    // The daemon is the truth after a drop: its store may have been restarted,
    // so a `have` LOWER than what we acked earlier is real progress lost, not a
    // violation — start again from there.
    this.inFlight.length = 0;
    this.acked = have;
    this.cursor = have;
  }

  /**
   * Fold the PROBE's answer in: the blob is already stored (nothing to send), or
   * resume from the `have` it reports. A `complete` that does not cover the
   * whole blob is a lie, exactly like an early `complete` on a chunk.
   */
  probe(have: number, complete: boolean): "complete" | "resume" {
    if (complete) {
      if (have !== this.size) {
        throw new UploadProtocolError(
          `the daemon calls the image complete at ${have} of ${this.size} bytes`,
        );
      }
      this.finish();
      return "complete";
    }
    this.rewind(have);
    return "resume";
  }

  /** The blob was already there (the probe said `complete`): nothing to send. */
  finish(): void {
    this.done = true;
    this.acked = this.size;
    this.inFlight.length = 0;
    this.cursor = this.size;
  }

  /** Every violation of what a correct daemon may answer (AGENTS §7: a pod is not trusted). */
  private checked(sentOffset: number, have: number, complete: boolean): void {
    if (!Number.isInteger(have) || have < 0 || have > this.size) {
      throw new UploadProtocolError(`the daemon claims have=${have} of ${this.size} bytes`);
    }
    if (complete && have !== this.size) {
      throw new UploadProtocolError(`the daemon completed ${have} of ${this.size} bytes`);
    }
    if (have === this.size && !complete && sentOffset >= this.size - this.chunk) {
      // The last chunk's own ack says the whole blob is in, yet not complete:
      // the daemon has a blob it cannot verify, so nothing more can be sent.
      throw new UploadProtocolError(`the daemon holds all ${this.size} bytes but is not complete`);
    }
  }

  private forget(sentOffset: number): InFlight | undefined {
    const at = this.inFlight.findIndex((c) => c.offset === sentOffset);
    if (at < 0) {
      return undefined;
    }
    const [entry] = this.inFlight.splice(at, 1);
    return entry;
  }

  private overrun(): UploadStep {
    throw new UploadProtocolError(
      `the blob stopped at ${this.acked} of ${this.size} bytes with every chunk sent`,
    );
  }
}
