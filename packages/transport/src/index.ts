/**
 * `@agent-harness/transport` — the symmetric JSON-RPC peer and the duplex
 * channel it rides on. Used identically by the daemon and every client; the
 * only difference is whether the channel wraps a real WebSocket or an in-memory
 * pipe.
 */
export * from "./channel.ts";
export * from "./port-channel.ts";
export * from "./stream-channel.ts";
export * from "./errors.ts";
export * from "./peer.ts";
