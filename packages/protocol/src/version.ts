/**
 * Wire protocol version negotiated during `initialize`.
 *
 * Bump on any breaking change to the message shapes. Clients and the daemon
 * compare this during the handshake and refuse incompatible majors.
 */
// 18: `model/slots` removed (docs/feat/models-map.md: the sub-agent cap is the
// user's `subagents.maxParallel` only) — an older pod daemon fails at `initialize`.
export const PROTOCOL_VERSION = 18 as const;
