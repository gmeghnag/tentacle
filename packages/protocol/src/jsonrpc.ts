/**
 * JSON-RPC 2.0 envelopes.
 *
 * This is the transport framing for every message exchanged over the WebSocket
 * control channel. The *semantics* (method names and payloads) are defined in
 * the other modules and modelled on ACP; this file is purely the generic
 * request/response/notification machinery.
 *
 * @see https://www.jsonrpc.org/specification
 */
import { z } from "zod";

export const JSONRPC_VERSION = "2.0" as const;

/** Standard JSON-RPC error codes (reserved range). */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Custom, application-level error codes (outside JSON-RPC's reserved range).
 * Part of the wire contract (a non-TS client branches on them), so they live
 * here; `@tentacle/transport` re-exports them.
 */
export const DomainErrorCode = {
  Unauthorized: -32001,
  /** `initialize` refused; `data` is a `VersionMismatchData` (absent from a daemon older than it). */
  VersionMismatch: -32002,
  UnknownSession: -32003,
  TurnInProgress: -32004,
  NotInitialized: -32005,
  TooManySessions: -32006,
  AlreadyInitialized: -32007,
  NoTurnRunning: -32008,
  CompactInProgress: -32009,
  Cancelled: -32010,
  /** A `session/snapshot` cursor from an older epoch (the history was replaced): restart paging. */
  StaleCursor: -32011,
  /** A turn that a `serve` restart interrupted (the cached end of a retried `session/prompt`). */
  DaemonRestarted: -32012,
  /** A `session/resolve_permission` for a request that is not pending (answered, cancelled, unknown). */
  PermissionNotPending: -32013,
  /** A `session/open` of an archived session without `reopen` (it was ended; never revived by itself). */
  SessionArchived: -32014,
  /** A `session/open` of an id removed by `session/delete` (the daemon keeps a tombstone): never recreate it. */
  SessionDeleted: -32015,
} as const;

/**
 * Request / response correlation id. We emit string UUIDs by convention, but
 * the spec also permits integers, so both are accepted when parsing.
 */
export const RequestIdSchema = z.union([z.string().min(1), z.number().int()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

/** A method call that expects a matching response. */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** A fire-and-forget message — a request without an id, never answered. */
export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

/** The error payload carried by a failed response. */
export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

/** A successful response: carries `result`, never `error`. */
export const JsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  result: z.unknown(),
});
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;

/**
 * A failed response: carries `error`, never `result`. `id` may be null when the
 * request could not be parsed well enough to recover its id.
 */
export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RequestIdSchema.nullable(),
  error: JsonRpcErrorSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** Any single frame that can arrive on the wire (the shape; parse with `parseJsonRpcMessage`). */
export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

const NOT_A_FRAME = z.never();

/**
 * Parse one wire frame, classified by the members PRESENT
 * (docs/feat/protocol-v10-forward-compat.md). JSON-RPC 2.0 gives each kind
 * exactly one classifying member — `method` (a request when it also has an
 * `id`, else a notification), `result` (success), `error` (failure) — so a
 * frame with exactly one of them is unambiguous; none or several is invalid.
 * Any other member is unknown and stripped (a newer peer's envelope extension
 * never breaks this one); the members of the chosen kind keep their full
 * validation.
 */
export function parseJsonRpcMessage(raw: unknown): z.SafeParseReturnType<unknown, JsonRpcMessage> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NOT_A_FRAME.safeParse(raw);
  }
  const has = (key: string): boolean => Object.hasOwn(raw, key);
  const classes = ["method", "result", "error"].filter(has);
  if (classes.length !== 1) {
    return NOT_A_FRAME.safeParse(raw);
  }
  if (has("method")) {
    return has("id")
      ? JsonRpcRequestSchema.safeParse(raw)
      : JsonRpcNotificationSchema.safeParse(raw);
  }
  return has("error")
    ? JsonRpcErrorResponseSchema.safeParse(raw)
    : JsonRpcSuccessResponseSchema.safeParse(raw);
}
