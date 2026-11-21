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

/**
 * One frame off a byte carrier: a BINARY frame as its bytes; a TEXT frame as
 * the string it was. A text frame is never valid on the e2e channel — it is
 * passed up as-is so the Noise layer can name why (a v1 peer, or garbage).
 */
export type CarrierFrame = Uint8Array | string;

/**
 * The raw channel a Noise endpoint runs on: one binary WebSocket message per
 * frame (docs/feat/noise-binary-carrier.md). Adapters stay dumb — every
 * decision about what a frame means lives in the pure Noise module.
 */
export interface ByteCarrier {
  /** Send one binary frame. A no-op once the carrier is closed. */
  send(data: Uint8Array): void;
  /** Close the carrier (idempotent); both ends observe `onClose`. */
  close(): void;
  /** Register the single inbound-frame handler (replaces any previous). */
  setOnMessage(handler: (frame: CarrierFrame) => void): void;
  /** Register the single close handler (replaces any previous). */
  setOnClose(handler: () => void): void;
}

/**
 * What a socket handed over, as a `CarrierFrame`: an `ArrayBuffer` or a view
 * becomes a `Uint8Array` over exactly its bytes (`byteOffset`/`byteLength`
 * respected: a Bun `Buffer` may sit inside a pooled slab), a string stays a
 * string, anything else (a `Blob`, …) is `null` — the adapter closes, never
 * `String(x)`.
 */
export function carrierFrameOf(data: unknown): CarrierFrame | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

interface EndState<T> {
  onMessage?: (data: T) => void;
  onClose?: () => void;
  closed: boolean;
}

interface LinkedEnd<In, Out> {
  send(data: Out): void;
  close(): void;
  setOnMessage(handler: (data: In) => void): void;
  setOnClose(handler: () => void): void;
}

/**
 * A linked pair of in-memory channels: whatever one end sends arrives at the
 * other's `onMessage` on a microtask (so delivery is async, like a socket, but
 * deterministic). Closing either end closes both. For tests and benches.
 */
export function createChannelPair(): [DuplexChannel, DuplexChannel] {
  return linkedPair<string, string>();
}

/** As `createChannelPair`, for the byte carrier under Noise. */
export function createByteCarrierPair(): [ByteCarrier, ByteCarrier] {
  return linkedPair<CarrierFrame, Uint8Array>();
}

function linkedPair<In, Out extends In>(): [LinkedEnd<In, Out>, LinkedEnd<In, Out>] {
  const left: EndState<In> = { closed: false };
  const right: EndState<In> = { closed: false };

  const make = (self: EndState<In>, other: EndState<In>): LinkedEnd<In, Out> => ({
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
