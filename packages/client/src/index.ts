/**
 * `@agent-harness/client` — the client runtime. Connects to a daemon, performs
 * the handshake, and exposes a `RemoteSession` the Ink TUI consumes exactly like
 * a local `Session`, plus the WebSocket channel adapter and the wire↔local
 * mappings.
 */
export * from "./constants.ts";
export * from "./mapping.ts";
export * from "./permission-map.ts";
export * from "./queue.ts";
export * from "./ws-channel.ts";
export * from "./remote-client.ts";
export * from "./remote-session.ts";
