/**
 * Pure framing for the Kubernetes `exec` streaming protocol
 * (`v4.channel.k8s.io`), kept free of any WebSocket I/O so it is exhaustively
 * unit-testable.
 *
 * Every WebSocket message is a single **channel byte** followed by the payload:
 *   0 = stdin (client→server), 1 = stdout, 2 = stderr, 3 = error/status.
 * We tunnel RPC frames as stdin (channel 0) and read them back off stdout
 * (channel 1). A stream has no message boundaries, so — as with `streamChannel`
 * — frames are newline-delimited and the stdout side re-chunks on `\n`, through
 * the shared, capped `ByteFramer` (a pod is not trusted: AGENTS §7).
 */
import { ByteFramer, describeViolation } from "@tentacle/transport";

export const CHANNEL_STDIN = 0;
export const CHANNEL_STDOUT = 1;
export const CHANNEL_STDERR = 2;
export const CHANNEL_ERROR = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode one RPC frame as a channel-0 (stdin) message: `[0x00, ...frame\n]`. */
export function encodeStdin(frame: string): Uint8Array {
  const body = encoder.encode(`${frame}\n`);
  const out = new Uint8Array(body.length + 1);
  out[0] = CHANNEL_STDIN;
  out.set(body, 1);
  return out;
}

export interface ExecDemuxHandlers {
  /** A complete newline-delimited frame arrived on stdout (channel 1). */
  onFrame(frame: string): void;
  /** Text written to stderr (channel 2) — surfaced to the local log. */
  onStderr?(text: string): void;
  /** The error/status channel (3) — a terminal status at the end of the exec. */
  onError?(text: string): void;
  /**
   * stdout broke the framing (a line over the cap, the reserved NUL tag): the
   * reason, once. stdout is ignored after it; the owner closes the channel.
   */
  onViolation?(message: string): void;
}

/**
 * Demultiplex incoming exec messages: route by channel byte, and re-chunk the
 * stdout channel into complete newline-delimited frames (a partial trailing
 * line is held until the rest arrives, up to `maxLineBytes`).
 */
export class ExecDemux {
  private readonly stdout: ByteFramer;

  constructor(
    private readonly handlers: ExecDemuxHandlers,
    maxLineBytes?: number,
  ) {
    this.stdout = new ByteFramer(
      {
        onLine: (line) => this.handlers.onFrame(line),
        onViolation: (violation) =>
          this.handlers.onViolation?.(describeViolation(violation, "pod stdout")),
      },
      maxLineBytes,
    );
  }

  push(message: Uint8Array): void {
    if (message.length === 0) {
      return;
    }
    const channel = message[0];
    if (channel === CHANNEL_STDOUT) {
      this.stdout.push(message.subarray(1));
      return;
    }
    const payload = decoder.decode(message.subarray(1), { stream: true });
    switch (channel) {
      case CHANNEL_STDERR:
        if (payload !== "") {
          this.handlers.onStderr?.(payload);
        }
        break;
      case CHANNEL_ERROR:
        if (payload !== "") {
          this.handlers.onError?.(payload);
        }
        break;
      default:
        // Unknown channel (e.g. 4 = resize): ignored.
        break;
    }
  }
}
