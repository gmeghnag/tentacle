/**
 * React Native's WebSocket as the client's `WebSocketCtor`. The client's
 * factory calls `new Ctor(url, init)` with `init = {headers}` (Bun's shape);
 * RN's constructor is `(url, protocols, options)`, so passing `init` straight
 * through would make it the protocol list. Pure: no React, no RN import.
 */
import type { WebSocketCtor } from "@tentacle/client";

export type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[],
  options?: unknown,
) => unknown;

export function rnWebSocketCtor(RN: RNWebSocketCtor): WebSocketCtor {
  return class {
    constructor(url: string, init?: unknown) {
      // biome-ignore lint/correctness/noConstructorReturn: an adapter returns the RN socket itself
      return new RN(url, undefined, init) as object;
    }
  } as unknown as WebSocketCtor;
}
