/**
 * `@tentacle/protocol` — the shared wire protocol.
 *
 * JSON-RPC 2.0 framing + ACP-shaped session/tool/permission vocabulary, all as
 * Zod schemas with inferred types. This package is the single source of truth
 * used by both the daemon and every client.
 *
 * Forward compatibility (protocol 10, docs/feat/protocol-v10-forward-compat.md):
 * application payloads are STRIP objects, never `.strict()` — on inbound parse
 * an unknown field is dropped (never used), every known field keeps its full
 * validation. Only the JSON-RPC envelope (`jsonrpc.ts`) stays strict: its
 * members are fixed by JSON-RPC 2.0 and strictness tells its shapes apart.
 */
export * from "./version.ts";
export * from "./jsonrpc.ts";
export * from "./content.ts";
export * from "./session.ts";
export * from "./updates.ts";
export * from "./permission.ts";
export * from "./model.ts";
export * from "./mcp.ts";
export * from "./skills.ts";
export * from "./hooks.ts";
export * from "./daemon.ts";
export * from "./methods.ts";
