/**
 * The duplex byte(/text) channel an `RpcPeer` rides on.
 *
 * Deliberately tiny and transport-agnostic: the same `RpcPeer` runs over a real
 * WebSocket in production and over an in-memory pipe in tests. A channel only
 * moves opaque text frames and signals close; all JSON-RPC framing, validation
 * and correlation live in `RpcPeer`.
 */
export interface DuplexChannel {
  /** Send one text frame. A no-op once the channel is closed. */
  send(data: string): void;
  /** Close the channel (idempotent); both ends observe `onClose`. */
  close(): void;
  /** Register the single inbound-frame handler (replaces any previous). */
  setOnMessage(handler: (data: string) => void): void;
  /** Register the single close handler (replaces any previous). */
  setOnClose(handler: () => void): void;
}

interface EndState {
  onMessage?: (data: string) => void;
  onClose?: () => void;
  closed: boolean;
}

/**
 * A linked pair of in-memory channels: whatever one end sends arrives at the
 * other's `onMessage` on a microtask (so delivery is async, like a socket, but
 * deterministic). Closing either end closes both. For tests and benches.
 */
export function createChannelPair(): [DuplexChannel, DuplexChannel] {
  const left: EndState = { closed: false };
  const right: EndState = { closed: false };

  const make = (self: EndState, other: EndState): DuplexChannel => ({
    send(data) {
      if (self.closed || other.closed) {
        return;
      }
      queueMicrotask(() => {
        if (!other.closed) {
          other.onMessage?.(data);
        }
      });
    },
    close() {
      if (self.closed) {
        return;
      }
      self.closed = true;
      queueMicrotask(() => self.onClose?.());
      if (!other.closed) {
        other.closed = true;
        queueMicrotask(() => other.onClose?.());
      }
    },
    setOnMessage(handler) {
      self.onMessage = handler;
    },
    setOnClose(handler) {
      self.onClose = handler;
    },
  });

  return [make(left, right), make(right, left)];
}
