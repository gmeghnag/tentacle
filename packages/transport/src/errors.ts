/**
 * Error vocabulary for the control channel. Transport/protocol failures map to
 * the reserved JSON-RPC codes; domain failures use a small custom range. A
 * handler throws an `RpcError` to produce a specific error response; any other
 * thrown value becomes a generic `InternalError` (never leaking a stack).
 */
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";

/** Custom, application-level error codes — defined in `@tentacle/protocol`. */
export { DomainErrorCode };

export const ErrorCode = { ...JsonRpcErrorCode, ...DomainErrorCode } as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}
