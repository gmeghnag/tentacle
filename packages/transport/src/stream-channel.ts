/**
 * A `DuplexChannel` over a pair of byte streams (a Node `Readable` + `Writable`,
 * e.g. `process.stdin` / `process.stdout`). This is the transport for a daemon
 * driven over stdio — `tentacle serve --stdio` — which is in turn what the
 * Kubernetes `exec` channel pipes into inside a pod (F4).
 *
 * Unlike the WebSocket / MessagePort channels, a byte stream has no message
 * boundaries, so frames are **newline-delimited**. That is safe because every
 * `RpcPeer` frame is single-line JSON (`JSON.stringify` escapes any embedded
 * newline as `\n`). Inbound bytes go through the shared `ByteFramer`: split on
 * `\n`, a partial trailing line held until the rest arrives, and a line over
 * `maxLineBytes` (or starting with the reserved NUL tag) closes the channel.
 */
import { ByteFramer, describeViolation } from "./byte-framer.ts";
import type { DuplexChannel } from "./channel.ts";

/** The slice of a Node `Readable` this channel needs. */
export interface NodeReadableLike {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** The slice of a Node `Writable` this channel needs. */
export interface NodeWritableLike {
  write(chunk: string): unknown;
}

export interface StreamChannelOptions {
  /** The cap on one inbound line, in bytes. Default `MAX_STREAM_LINE_BYTES`. */
  readonly maxLineBytes?: number;
  /** Why the channel closed itself (a framing violation), before it closes. */
  readonly onError?: (error: Error) => void;
}

/** Wrap a readable/writable byte-stream pair as a newline-delimited channel. */
export function streamChannel(
  input: NodeReadableLike,
  output: NodeWritableLike,
  options: StreamChannelOptions = {},
): DuplexChannel {
  let onMessage: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  const encoder = new TextEncoder();

  const fireClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    onClose?.();
  };

  const framer = new ByteFramer(
    {
      onLine: (line) => {
        if (!closed) {
          onMessage?.(line);
        }
      },
      onViolation: (violation) => {
        options.onError?.(new Error(describeViolation(violation, "stream")));
        fireClose();
      },
    },
    options.maxLineBytes,
  );

  input.on("data", (chunk) => {
    if (!closed) {
      framer.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    }
  });
  input.on("end", fireClose);
  input.on("close", fireClose);

  return {
    send(data: string): void {
      if (!closed) {
        output.write(`${data}\n`);
      }
    },
    close(): void {
      // We do not end the underlying streams (for stdio, stdout stays open for
      // the process); we only signal our own close exactly once.
      fireClose();
    },
    setOnMessage(handler: (data: string) => void): void {
      onMessage = handler;
    },
    setOnClose(handler: () => void): void {
      onClose = handler;
    },
  };
}
