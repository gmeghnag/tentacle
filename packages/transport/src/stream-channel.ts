/**
 * A `DuplexChannel` over a pair of byte streams (a Node `Readable` + `Writable`,
 * e.g. `process.stdin` / `process.stdout`). This is the transport for a daemon
 * driven over stdio — `tentacle serve --stdio` — which is in turn what the
 * Kubernetes `exec` channel pipes into inside a pod (F4).
 *
 * Unlike the WebSocket / MessagePort channels, a byte stream has no message
 * boundaries, so frames are **newline-delimited**. That is safe because every
 * `RpcPeer` frame is single-line JSON (`JSON.stringify` escapes any embedded
 * newline as `\n`). Inbound bytes are accumulated and split on `\n`; a partial
 * trailing line is held until the rest arrives.
 */
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

/** Wrap a readable/writable byte-stream pair as a newline-delimited channel. */
export function streamChannel(input: NodeReadableLike, output: NodeWritableLike): DuplexChannel {
  let onMessage: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  let buffer = "";
  const decoder = new TextDecoder();

  const fireClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    onClose?.();
  };

  input.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    // Emit each complete line; keep the trailing partial (if any) buffered.
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        onMessage?.(line);
      }
      newline = buffer.indexOf("\n");
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
