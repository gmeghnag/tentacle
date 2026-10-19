/**
 * Wire protocol version negotiated during `initialize`.
 *
 * Bump on any breaking change to the message shapes. Clients and the daemon
 * compare this during the handshake and refuse incompatible majors.
 */
export const PROTOCOL_VERSION = 4 as const;
