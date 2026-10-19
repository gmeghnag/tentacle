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
  VersionMismatch: -32002,
  UnknownSession: -32003,
  TurnInProgress: -32004,
  NotInitialized: -32005,
  TooManySessions: -32006,
  AlreadyInitialized: -32007,
  NoTurnRunning: -32008,
} as const;

/**
 * Request / response correlation id. We emit string UUIDs by convention, but
 * the spec also permits integers, so both are accepted when parsing.
 */
export const RequestIdSchema = z.union([z.string().min(1), z.number().int()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

/** A method call that expects a matching response. */
export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RequestIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** A fire-and-forget message — a request without an id, never answered. */
export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

/** The error payload carried by a failed response. */
export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

/** A successful response: carries `result`, never `error`. */
export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RequestIdSchema,
    result: z.unknown(),
  })
  .strict();
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;

/**
 * A failed response: carries `error`, never `result`. `id` may be null when the
 * request could not be parsed well enough to recover its id.
 */
export const JsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RequestIdSchema.nullable(),
    error: JsonRpcErrorSchema,
  })
  .strict();
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** Any single frame that can arrive on the wire. */
export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;
