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
  type CancelRequestParams,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  JsonRpcMessageSchema,
  Notification,
  NotificationSchemas,
  type ProgressParams,
  type RequestId,
  RequestSchemas,
  isMethodName,
  isNotificationName,
} from "@tentacle/protocol";
import type { DuplexChannel } from "./channel.ts";
import { RpcError } from "./errors.ts";

/** Context handed to an inbound request handler (additive: existing
 *  `(method, params)` handlers are unaffected). */
export interface RequestContext {
  /**
   * The id of this inbound request, so a responder can frame `$/progress`
   * partials for it (the peer routes them back by this id).
   */
  readonly id: RequestId;
  /** Aborts when the caller sends `$/cancelRequest` for this request. */
  readonly signal: AbortSignal;
}

export type RequestHandler = (
  method: string,
  params: unknown,
  context?: RequestContext,
) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

/** Partial values a responder streams to an outbound request via `$/progress`. */
export type ProgressListener = (value: unknown, seq: number) => void;

export interface RequestOptions {
  /**
   * When aborted, the caller sends `$/cancelRequest` for this request's id and
   * the pending promise rejects with a catchable `cancelled` marker.
   */
  readonly signal?: AbortSignal;
  /** Receives `$/progress` partial values for this request, in `seq` order. */
  readonly onProgress?: ProgressListener;
}

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
  /**
   * When a request handler throws a NON-`RpcError`, the error response is a
   * generic "internal error" by default (never leak server internals to an
   * untrusted/remote peer). Set this true for a LOCAL, trusted peer (the
   * in-process worker daemon) so the real message + stack cross the wire and the
   * client (TUI) shows the actual cause instead of an opaque "internal error".
   */
  readonly exposeInternalErrors?: boolean;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  /** Detached from the signal when the request settles (see `request`). */
  onAbort?: () => void;
  /** `$/progress` receiver for this request (see `RequestOptions`). */
  onProgress?: ProgressListener;
}

/** Bound on `cancelledIds` (late answers to our own cancels). */
const MAX_REMEMBERED_CANCELS = 1024;

export class RpcPeer {
  private readonly channel: DuplexChannel;
  private readonly opts: RpcPeerOptions;
  private readonly pending = new Map<string, Pending>();
  /** AbortController per INBOUND request id; a `$/cancelRequest` aborts it. */
  private readonly inboundCancel = new Map<string, AbortController>();
  /**
   * Outbound ids WE cancelled whose late response may still arrive: it is
   * discarded silently instead of reported as an unknown id (it is expected,
   * not an error). Bounded (oldest dropped first) so a peer that never answers
   * cannot grow it; cleared on close.
   */
  private readonly cancelledIds = new Set<string>();
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

  /**
   * Issue a request and resolve with its (schema-validated) result.
   *
   * `options.signal` (abort → `$/cancelRequest` + local cancelled rejection)
   * and `options.onProgress` (receive `$/progress` partials for this request)
   * are additive; omitting them behaves exactly as before.
   */
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown> {
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
      const pending: Pending = { method, resolve, reject, onProgress: options?.onProgress };
      const settle = (settleFn: () => void): void => this.settlePending(id, pending, settleFn);
      if (this.opts.requestTimeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          settle(() =>
            reject(new RpcError(JsonRpcErrorCode.InternalError, `request ${method} timed out`)),
          );
        }, this.opts.requestTimeoutMs);
      }
      if (options?.signal) {
        const onAbort = (): void => {
          if (!this.pending.has(id)) {
            return; // already settled — the abort is a no-op
          }
          // Tell the peer to stop working on our request (unknown to it → no-op),
          // then reject locally so the caller's `.then`/`for await` ends now.
          this.notify(Notification.CancelRequest, { id } satisfies CancelRequestParams);
          this.rememberCancelled(id);
          settle(() => reject(cancelledError(id)));
        };
        if (options.signal.aborted) {
          // Aborted before the frame could go out: reject, send nothing (the
          // peer never saw this id, so there is nothing to cancel).
          settle(() => reject(cancelledError(id)));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.onAbort = (): void => options.signal?.removeEventListener("abort", onAbort);
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

  private rememberCancelled(id: string): void {
    this.cancelledIds.add(id);
    if (this.cancelledIds.size > MAX_REMEMBERED_CANCELS) {
      const oldest = this.cancelledIds.values().next().value;
      if (oldest !== undefined) {
        this.cancelledIds.delete(oldest);
      }
    }
  }

  /**
   * Settle a pending request exactly once: detach its abort listener, clear its
   * timer, remove it from `pending`, then run `settleFn`. Every completion path
   * (timeout, abort, response, close) funnels through here so a listener can
   * never outlive its request.
   */
  private settlePending(id: string, pending: Pending, settleFn: () => void): void {
    pending.onAbort?.();
    pending.onAbort = undefined;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(id);
    settleFn();
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
    for (const [id, pending] of this.pending) {
      this.settlePending(id, pending, () =>
        pending.reject(new RpcError(JsonRpcErrorCode.InternalError, "connection closed")),
      );
    }
    // Nobody can receive an inbound handler's result any more: abort them all
    // so a long responder (a model round on the laptop) stops its work.
    for (const controller of this.inboundCancel.values()) {
      controller.abort();
    }
    this.inboundCancel.clear();
    this.cancelledIds.clear();
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
    // A `$/cancelRequest` for this id aborts the handler's context signal.
    const controller = new AbortController();
    this.inboundCancel.set(String(id), controller);
    try {
      const result = await handler(method, parsedParams.data, {
        id,
        signal: controller.signal,
      } satisfies RequestContext);
      this.sendFrame({ jsonrpc: JSONRPC_VERSION, id, result: result ?? null });
    } catch (error) {
      if (error instanceof RpcError) {
        this.sendErrorResponse(id, error.code, error.message, error.data);
      } else {
        const err = error instanceof Error ? error : new Error(String(error));
        this.reportError(err);
        // Default: opaque, so a remote/untrusted peer learns nothing. A trusted
        // local peer (`exposeInternalErrors`) gets the real message + stack, so
        // the error is never silently reduced to "internal error" at the client.
        if (this.opts.exposeInternalErrors) {
          this.sendErrorResponse(
            id,
            JsonRpcErrorCode.InternalError,
            err.message || "internal error",
            {
              stack: err.stack,
            },
          );
        } else {
          this.sendErrorResponse(id, JsonRpcErrorCode.InternalError, "internal error");
        }
      }
    } finally {
      // The handler settled (result or error): drop its cancel controller so it
      // cannot leak and a late `$/cancelRequest` is a clean no-op.
      this.inboundCancel.delete(String(id));
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
    // Generic peer primitives, handled here so no application code needs to
    // know about them. Both are synchronous map work (no await, no lock), so
    // dispatch stays concurrent (§7). An old peer lacks them in its registry,
    // so the `isNotificationName` check above already no-ops them (non-fatal).
    if (method === Notification.CancelRequest) {
      const { id } = parsed.data as CancelRequestParams;
      this.inboundCancel.get(id)?.abort();
      return;
    }
    if (method === Notification.Progress) {
      const { id, seq, value } = parsed.data as ProgressParams;
      // Route to the still-pending outbound request's listener; a progress for
      // a settled/unknown id is dropped (non-fatal).
      this.pending.get(id)?.onProgress?.(value, seq);
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
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      if (this.cancelledIds.delete(key)) {
        return; // the late answer to a request we cancelled: expected, not an error
      }
      this.reportError(new Error(`response for unknown request id: ${key}`));
      return;
    }
    if (error !== undefined) {
      const e = error as { code?: number; message?: string; data?: unknown };
      this.settlePending(key, pending, () =>
        pending.reject(
          new RpcError(e.code ?? JsonRpcErrorCode.InternalError, e.message ?? "error", e.data),
        ),
      );
      return;
    }
    // Validate the result against the method's schema (inbound validation).
    if (isMethodName(pending.method)) {
      const parsed = RequestSchemas[pending.method].result.safeParse(result);
      if (!parsed.success) {
        this.settlePending(key, pending, () =>
          pending.reject(
            new RpcError(JsonRpcErrorCode.InternalError, `invalid result for ${pending.method}`),
          ),
        );
        return;
      }
      this.settlePending(key, pending, () => pending.resolve(parsed.data));
      return;
    }
    this.settlePending(key, pending, () => pending.resolve(result));
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

/**
 * The local rejection for a request the CALLER cancelled. `name ===
 * "cancelled"` is the catchable marker: a caller that aborts its own request
 * can distinguish "I cancelled it" from a transport error without string
 * matching. It is NOT an `RpcError` from the peer (the peer was merely told to
 * stop), so it carries no wire code.
 */
export function cancelledError(id?: string): Error {
  const error = new Error(
    id === undefined ? "request was cancelled" : `request ${id} was cancelled`,
  );
  error.name = "cancelled";
  return error;
}
