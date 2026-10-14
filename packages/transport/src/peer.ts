/**
 * `RpcPeer` — a symmetric, bidirectional JSON-RPC 2.0 endpoint over a
 * `DuplexChannel`.
 *
 * The same class runs on both ends: each can issue `request`/`notify` and
 * handle inbound requests/notifications. It validates every INBOUND payload
 * against the shared protocol registries (params of a request/notification, and
 * the result of a response to one of our own requests) and correlates responses
 * to pending requests by id. Outbound notifications (the hot `session/update`
 * stream) are trusted and not re-validated; see the project's perf plan.
 */
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  JsonRpcMessageSchema,
  NotificationSchemas,
  type RequestId,
  RequestSchemas,
  isMethodName,
  isNotificationName,
} from "@agent-harness/protocol";
import type { DuplexChannel } from "./channel.ts";
import { RpcError } from "./errors.ts";

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

export interface RpcPeerOptions {
  /** Handles an inbound request; return its result, or throw `RpcError`. */
  readonly onRequest?: RequestHandler;
  /** Handles an inbound notification. */
  readonly onNotification?: NotificationHandler;
  /** If set, an outbound `request` rejects after this many ms with no reply. */
  readonly requestTimeoutMs?: number;
  /**
   * If set, an inbound frame larger than this many bytes (UTF-16 code units) is
   * rejected before `JSON.parse`, bounding the parse/allocation a peer can force
   * (an auth-gated DoS surface on the daemon). Unset means no cap.
   */
  readonly maxFrameBytes?: number;
  /** Non-fatal errors (bad frames, handler throws) are reported here. */
  readonly onError?: (error: Error) => void;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private readonly channel: DuplexChannel;
  private readonly opts: RpcPeerOptions;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(channel: DuplexChannel, opts: RpcPeerOptions = {}) {
    this.channel = channel;
    this.opts = opts;
    channel.setOnMessage((data) => this.receive(data));
    channel.setOnClose(() => this.handleClose());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Issue a request and resolve with its (schema-validated) result. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new RpcError(JsonRpcErrorCode.InternalError, "peer is closed"));
    }
    // Fail fast on malformed outbound params for a known method.
    if (isMethodName(method)) {
      const parsed = RequestSchemas[method].params.safeParse(params);
      if (!parsed.success) {
        return Promise.reject(
          new RpcError(JsonRpcErrorCode.InvalidParams, `invalid params for ${method}`),
        );
      }
    }
    const id = String(this.nextId++);
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject };
      if (this.opts.requestTimeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(JsonRpcErrorCode.InternalError, `request ${method} timed out`));
        }, this.opts.requestTimeoutMs);
      }
      this.pending.set(id, pending);
      this.sendFrame({
        jsonrpc: JSONRPC_VERSION,
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  /** Send a fire-and-forget notification (never validated outbound: hot path). */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendFrame({
      jsonrpc: JSONRPC_VERSION,
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  /** Close the channel and reject all in-flight requests. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.channel.close();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new RpcError(JsonRpcErrorCode.InternalError, "connection closed"));
    }
    this.pending.clear();
  }

  private sendFrame(frame: unknown): void {
    this.channel.send(JSON.stringify(frame));
  }

  private reportError(error: Error): void {
    this.opts.onError?.(error);
  }

  private receive(data: string): void {
    const max = this.opts.maxFrameBytes;
    if (max !== undefined && data.length > max) {
      // Don't echo the id (we won't parse the frame): reply with a null-id error.
      this.sendErrorResponse(null, JsonRpcErrorCode.InvalidRequest, "frame too large");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.sendErrorResponse(null, JsonRpcErrorCode.ParseError, "parse error");
      return;
    }
    const parsed = JsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const id = extractId(raw);
      this.sendErrorResponse(id, JsonRpcErrorCode.InvalidRequest, "invalid request");
      return;
    }
    // The union is validated; read fields directly to classify the frame
    // without fighting control-flow narrowing across its four members.
    const msg = parsed.data as {
      id?: RequestId | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      void this.handleRequest(msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      void this.handleNotification(msg.method, msg.params);
    } else if (msg.error !== undefined) {
      this.handleResponse(msg.id ?? null, undefined, msg.error);
    } else {
      this.handleResponse(msg.id ?? null, msg.result, undefined);
    }
  }

  private async handleRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    if (!isMethodName(method)) {
      this.sendErrorResponse(id, JsonRpcErrorCode.MethodNotFound, `unknown method: ${method}`);
      return;
    }
    const schema = RequestSchemas[method];
    const parsedParams = schema.params.safeParse(params);
    if (!parsedParams.success) {
      this.sendErrorResponse(id, JsonRpcErrorCode.InvalidParams, `invalid params for ${method}`);
      return;
    }
    const handler = this.opts.onRequest;
    if (!handler) {
      this.sendErrorResponse(id, JsonRpcErrorCode.InternalError, "no request handler");
      return;
    }
    try {
      const result = await handler(method, parsedParams.data);
      this.sendFrame({ jsonrpc: JSONRPC_VERSION, id, result: result ?? null });
    } catch (error) {
      if (error instanceof RpcError) {
        this.sendErrorResponse(id, error.code, error.message, error.data);
      } else {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
        this.sendErrorResponse(id, JsonRpcErrorCode.InternalError, "internal error");
      }
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (!isNotificationName(method)) {
      this.reportError(new Error(`unknown notification: ${method}`));
      return;
    }
    const parsed = NotificationSchemas[method].safeParse(params);
    if (!parsed.success) {
      this.reportError(new Error(`invalid params for notification ${method}`));
      return;
    }
    try {
      await this.opts.onNotification?.(method, parsed.data);
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleResponse(id: RequestId | null, result: unknown, error: unknown): void {
    if (id === null) {
      this.reportError(new Error("response with no id cannot be correlated"));
      return;
    }
    const pending = this.pending.get(String(id));
    if (!pending) {
      this.reportError(new Error(`response for unknown request id: ${String(id)}`));
      return;
    }
    this.pending.delete(String(id));
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (error !== undefined) {
      const e = error as { code?: number; message?: string; data?: unknown };
      pending.reject(
        new RpcError(e.code ?? JsonRpcErrorCode.InternalError, e.message ?? "error", e.data),
      );
      return;
    }
    // Validate the result against the method's schema (inbound validation).
    if (isMethodName(pending.method)) {
      const parsed = RequestSchemas[pending.method].result.safeParse(result);
      if (!parsed.success) {
        pending.reject(
          new RpcError(JsonRpcErrorCode.InternalError, `invalid result for ${pending.method}`),
        );
        return;
      }
      pending.resolve(parsed.data);
      return;
    }
    pending.resolve(result);
  }

  private sendErrorResponse(
    id: RequestId | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.sendFrame({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }
}

/** Best-effort id recovery from an unparseable frame, for the error response. */
function extractId(raw: unknown): RequestId | null {
  if (raw && typeof raw === "object" && "id" in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}
