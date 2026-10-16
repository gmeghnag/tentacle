/**
 * `@tentacle/daemon` — hosts `Agent`/`Session` instances and serves the
 * JSON-RPC control channel. The core (`Connection`/`SessionHost`/`HostedSession`
 * + the event/permission mapping) is transport-agnostic and driven over an
 * in-memory channel in tests; `WsServer` binds it to a real WebSocket.
 */
export * from "./mapping.ts";
export * from "./permission-map.ts";
export * from "./hosted-session.ts";
export * from "./session-host.ts";
export * from "./connection.ts";
export * from "./proxy-model.ts";
export * from "./ws-server.ts";
