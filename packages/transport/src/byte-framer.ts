/**
 * The ONE line framer for every byte stream that carries newline-delimited
 * RPC frames (stdio / unix socket `streamChannel`, k8s exec stdout, docker
 * exec stdout) — pure, no I/O (docs/fix/byte-stream-frame-cap.md, slice BF1 of
 * docs/eval/binary-frames.md).
 *
 * It splits RAW bytes on `0x0A` and decodes each whole line once. That is exact
 * for UTF-8: `0x0A` never occurs inside a multi-byte sequence, so a character
 * split across chunks is reassembled before it is decoded. Counting bytes as
 * they arrive lets it refuse a line BEFORE the line is held or concatenated: a
 * peer that is not trusted (a pod, AGENTS §7) cannot grow our memory past
 * `maxLineBytes` by never sending a newline.
 *
 * A violation (a line over the cap; a line starting with the reserved NUL tag,
 * which BF3 turns into a length frame) drops what is held, is reported once,
 * and leaves the framer DEAD: every later byte is ignored, so nothing after a
 * violation is ever parsed as a frame. The owner then closes the channel.
 */
/**
 * The cap on one line (the `\n` excluded), laptop-side by default: the Noise
 * initiator's cap (`INITIATOR_MAX_MESSAGE_BYTES`, equal by test — not imported,
 * so a byte stream does not load the Noise stack), since the laptop receives
 * whole-conversation replies whose size is not bounded (`session/log`,
 * `session/open`).
 */
export const MAX_STREAM_LINE_BYTES = 256 * 1024 * 1024;

const NEWLINE = 0x0a;
/** Reserved: will start a `[0x00][u32][body]` length frame (BF3). */
const RESERVED_TAG = 0x00;

export type FramerViolation =
  | { readonly kind: "line-too-long"; readonly limit: number }
  | { readonly kind: "reserved-tag" };

export interface ByteFramerHandlers {
  /** A complete, non-empty line (blank lines are keepalives, skipped). */
  onLine(line: string): void;
  /** Called once, on the first violation; the framer is dead after it. */
  onViolation(violation: FramerViolation): void;
}

/** The user-facing reason for `violation`, naming the stream it came from. */
export function describeViolation(violation: FramerViolation, source: string): string {
  return violation.kind === "line-too-long"
    ? `${source} line exceeds ${violation.limit} bytes with no newline (frame cap); channel closed`
    : `${source} sent a reserved frame tag (0x00); channel closed`;
}

export class ByteFramer {
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private isDead = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly handlers: ByteFramerHandlers,
    private readonly maxLineBytes: number = MAX_STREAM_LINE_BYTES,
  ) {}

  /** True once a violation was reported: every later `push` is ignored. */
  get dead(): boolean {
    return this.isDead;
  }

  push(chunk: Uint8Array): void {
    let start = 0;
    while (!this.isDead && start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      // Checked before anything is stored or joined.
      if (this.heldBytes + (end - start) > this.maxLineBytes) {
        this.violate({ kind: "line-too-long", limit: this.maxLineBytes });
        return;
      }
      if (this.heldBytes === 0 && end > start && chunk[start] === RESERVED_TAG) {
        this.violate({ kind: "reserved-tag" });
        return;
      }
      if (newline === -1) {
        // Copied: a producer may reuse its buffer after this call.
        this.held.push(chunk.slice(start));
        this.heldBytes += chunk.length - start;
        return;
      }
      this.emit(chunk.subarray(start, end));
      start = newline + 1;
    }
  }

  private emit(tail: Uint8Array): void {
    let line = tail;
    if (this.heldBytes > 0) {
      line = new Uint8Array(this.heldBytes + tail.length);
      let at = 0;
      for (const part of this.held) {
        line.set(part, at);
        at += part.length;
      }
      line.set(tail, at);
      this.held = [];
      this.heldBytes = 0;
    }
    if (line.length > 0) {
      this.handlers.onLine(this.decoder.decode(line));
    }
  }

  private violate(violation: FramerViolation): void {
    this.isDead = true;
    this.held = [];
    this.heldBytes = 0;
    this.handlers.onViolation(violation);
  }
}
