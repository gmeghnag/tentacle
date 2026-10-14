/**
 * A `DuplexChannel` over a `MessagePort`-shaped endpoint — the transport for an
 * in-process **worker** daemon. Both ends of a `MessageChannel`, and a `Worker`
 * with its `self`, satisfy `MessageEndpoint`, so the same `RpcPeer` that rides a
 * WebSocket (remote) or an in-memory pipe (tests) also rides a worker boundary.
 *
 * This is what lets the local daemon run off the render thread: the TUI keeps a
 * `RemoteClient` on the main-thread port; the agent loop + tool execution run in
 * the worker, draining into the worker-thread port. Frames are JSON strings, as
 * everywhere else in the transport.
 */
import type { DuplexChannel } from "./channel.ts";

/** The slice of a `MessagePort` / `Worker` / `self` this channel needs. */
export interface MessageEndpoint {
  postMessage(data: string): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", handler: (event: { data: unknown }) => void): void;
  /** Ports expose `start()`; `Worker`/`self` do not — called when present. */
  start?(): void;
  /** Ports expose `close()`; `Worker`/`self` do not. */
  close?(): void;
}

/** Wrap a message endpoint as a `DuplexChannel`. */
export function messagePortChannel(endpoint: MessageEndpoint): DuplexChannel {
  let onMessage: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;

  const handler = (event: { data: unknown }): void => {
    // Only forward string frames (what `RpcPeer` sends); ignore anything else.
    if (typeof event.data === "string") {
      onMessage?.(event.data);
    }
  };
  endpoint.addEventListener("message", handler);
  endpoint.start?.();

  const fireClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    endpoint.removeEventListener?.("message", handler);
    onClose?.();
  };

  return {
    send(data: string): void {
      if (!closed) {
        endpoint.postMessage(data);
      }
    },
    close(): void {
      // Best-effort close of the underlying port (no-op on Worker/self), then
      // signal our own close exactly once.
      try {
        endpoint.close?.();
      } catch {
        // already closed / not closable
      }
      fireClose();
    },
    setOnMessage(h: (data: string) => void): void {
      onMessage = h;
    },
    setOnClose(h: () => void): void {
      onClose = h;
    },
  };
}
