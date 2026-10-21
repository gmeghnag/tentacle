/**
 * `@tentacle/protocol` — the shared wire protocol.
 *
 * JSON-RPC 2.0 framing + ACP-shaped session/tool/permission vocabulary, all as
 * Zod schemas with inferred types. This package is the single source of truth
 * used by both the daemon and every client.
 */
export * from "./version.ts";
export * from "./jsonrpc.ts";
export * from "./content.ts";
export * from "./session.ts";
export * from "./updates.ts";
export * from "./permission.ts";
export * from "./model.ts";
export * from "./mcp.ts";
export * from "./methods.ts";
