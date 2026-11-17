/**
 * `@tentacle/transport` — the symmetric JSON-RPC peer and the duplex
 * channel it rides on. Used identically by the daemon and every client; the
 * only difference is whether the channel wraps a real WebSocket or an in-memory
 * pipe.
 */
export * from "./channel.ts";
export * from "./port-channel.ts";
export * from "./stream-channel.ts";
export * from "./errors.ts";
export * from "./peer.ts";
/** RFC 4648 base64 (dependency-free: the app's Hermes has neither `Buffer` nor `btoa`), shared
 *  with the secure channel's framing — `attachment/put` chunks ride it as text; the STRICT
 *  decode (canonical text only) reads `artifact/read` chunks back. */
export { decodeBase64, encodeBase64 } from "./noise-frame.ts";
