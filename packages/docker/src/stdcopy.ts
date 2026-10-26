/**
 * Pure demux of the Engine API's multiplexed stdout/stderr stream (an exec
 * with `Tty:false`): every frame is an 8-byte header `[stream, 0, 0, 0,
 * size32be]` followed by `size` payload bytes. Incremental: payload is emitted
 * as it arrives (never buffered to a whole frame — an exec can write a frame of
 * any size), and a header may be split across reads at any offset.
 *
 * Stream ids follow Docker's `stdcopy`: 0 (stdin, written back by some
 * engines) and 1 → stdout, 2 → stderr, 3 → systemErr (engine-side error text).
 */
export const STREAM_STDIN = 0;
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;
export const STREAM_SYSTEMERR = 3;

const HEADER_BYTES = 8;

export interface StdDemuxHandlers {
  onStdout(bytes: Uint8Array): void;
  onStderr(bytes: Uint8Array): void;
  onSystemErr?(bytes: Uint8Array): void;
  /** A malformed header: the stream is unusable; nothing more is emitted. */
  onError(message: string): void;
}

export class StdDemux {
  private readonly header = new Uint8Array(HEADER_BYTES);
  private headerFill = 0;
  private stream = 0;
  private remaining = 0;
  private failed = false;

  constructor(private readonly handlers: StdDemuxHandlers) {}

  push(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length && !this.failed) {
      if (this.remaining === 0) {
        const n = Math.min(HEADER_BYTES - this.headerFill, bytes.length - at);
        this.header.set(bytes.subarray(at, at + n), this.headerFill);
        this.headerFill += n;
        at += n;
        if (this.headerFill < HEADER_BYTES) {
          return;
        }
        this.headerFill = 0;
        const h = this.header;
        if ((h[0] as number) > STREAM_SYSTEMERR || h[1] !== 0 || h[2] !== 0 || h[3] !== 0) {
          this.failed = true;
          const hex = Array.from(h, (b) => b.toString(16).padStart(2, "0")).join(" ");
          this.handlers.onError(`malformed docker stream header [${hex}]`);
          return;
        }
        this.stream = h[0] as number;
        this.remaining = new DataView(h.buffer, h.byteOffset, HEADER_BYTES).getUint32(4);
        continue;
      }
      const n = Math.min(this.remaining, bytes.length - at);
      const payload = bytes.subarray(at, at + n);
      at += n;
      this.remaining -= n;
      this.emit(payload);
    }
  }

  private emit(payload: Uint8Array): void {
    switch (this.stream) {
      case STREAM_STDIN:
      case STREAM_STDOUT:
        this.handlers.onStdout(payload);
        break;
      case STREAM_STDERR:
        this.handlers.onStderr(payload);
        break;
      default:
        this.handlers.onSystemErr?.(payload);
        break;
    }
  }

  /**
   * The stream ended. `partial` is how many bytes of an unfinished frame were
   * missing or held (0 = it ended on a frame boundary); `failed` = a malformed
   * header was seen.
   */
  finish(): { readonly partial: number; readonly failed: boolean } {
    return {
      partial: this.remaining > 0 ? this.remaining : this.headerFill,
      failed: this.failed,
    };
  }
}
