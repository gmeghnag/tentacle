/**
 * Streamable HTTP transport for MCP, dual-era: modern (2026-07-28 — stateless,
 * per-request `_meta`) and legacy (2025-03-26 … 2025-11-25 — `initialize`
 * handshake, optional `Mcp-Session-Id`). Every outbound JSON-RPC message is
 * POSTed to the server's single endpoint. A request's reply comes back either
 * as one `application/json` body or as a `text/event-stream` that carries it
 * (plus request-scoped notifications); notifications get `202`.
 *
 * HTTP binding rules live here, so `McpClient` stays transport-agnostic:
 * - headers per request: `MCP-Protocol-Version` (from the body's `_meta`, else
 *   the legacy negotiated version), `Mcp-Method`, `Mcp-Name`, and
 *   `Mcp-Param-*` mirrored from `x-mcp-header` tool annotations, which are
 *   learnt from `tools/list` replies (an invalid annotation drops that tool);
 * - cancellation: an outgoing `notifications/cancelled` aborts that request's
 *   own POST (closing its stream *is* the modern cancel signal); it is POSTed
 *   too only for a legacy request.
 *
 * Failure mapping — a pending request always settles, and a reachable server
 * never looks unreachable (see docs/feat/mcp-remote-transport.md):
 * - network failure / stream torn before the reply → close (unreachable);
 * - 404 while holding a (legacy) session → close (session expired; no reconnect);
 * - non-2xx whose body is a JSON-RPC error → delivered as that request's error
 *   (with its code: the modern version/era signals ride on `400`);
 * - any other non-2xx → a JSON-RPC error reply for that id, tagged
 *   `data.httpStatus` so `ping` does not count it as the server answering;
 * - 2xx whose body ends without the reply → a JSON-RPC error reply for that id.
 *
 * Not implemented: the legacy GET stream, `subscriptions/listen`, and
 * `Last-Event-ID` resumption (removed in 2026-07-28).
 */
import { type HeaderParam, headerParams, paramHeaders, standardHeaders } from "./http-headers.ts";
import { MCP_META_PROTOCOL_VERSION, type McpHttpServerSpec, type McpTransport } from "./types.ts";

export interface HttpTransportOptions {
  /** Injectable `fetch` (tests pass a fake); defaults to the global one. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

type RequestId = number | string;

function requestIdOf(message: unknown): RequestId | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const m = message as { id?: unknown; method?: unknown };
  if (typeof m.method !== "string") {
    return undefined; // a response we send back to the server
  }
  return typeof m.id === "number" || typeof m.id === "string" ? m.id : undefined;
}

/** True for a response (no `method`) whose id is `id`. */
function isReplyTo(message: unknown, id: RequestId): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { id?: unknown; method?: unknown };
  return m.method === undefined && m.id === id;
}

/**
 * A synthesized JSON-RPC error for `id`. A tag marks one that is not an answer
 * from the MCP server itself — `httpStatus` (a proxy 503, an expired token's
 * 401) or `streamLost` (the reply's stream broke) — so `McpClient` keeps it
 * from proving reachability.
 */
const errorReply = (
  id: RequestId,
  message: string,
  tag?: { readonly httpStatus: number } | { readonly streamLost: true },
): unknown => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32000, message, ...(tag ? { data: tag } : {}) },
});

/**
 * Yield the `data` of each `message` event of an SSE body (multi-line `data`
 * joined with `\n`, per the SSE spec). Other event types and comments are
 * skipped. Line endings: `\n` and `\r\n`.
 */
export async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): string | undefined => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        data.push(value);
      }
    }
    return event === "message" && data.length > 0 ? data.join("\n") : undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Normalise on the whole buffer, so a `\r\n` split across chunks still joins.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = parse(block);
        if (data !== undefined) {
          yield data;
        }
      }
    }
    const tail = parse(buffer);
    if (tail !== undefined) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse a JSON-RPC payload (one message or a batch); malformed JSON → none. */
function parseMessages(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** A JSON-RPC error object (`{ code: number, … }`) from a non-2xx body, if that is what it holds. */
function jsonRpcError(messages: readonly unknown[], id: RequestId): { error: unknown } | undefined {
  for (const m of messages) {
    const msg = m as { jsonrpc?: unknown; id?: unknown; error?: unknown } | null;
    const error = msg?.error;
    // A gateway's own JSON error (`{"error":{"code":404}}`) is not JSON-RPC.
    const forUs =
      msg?.jsonrpc === "2.0" && (msg.id === id || msg.id === null || msg.id === undefined);
    if (forUs && typeof (error as { code?: unknown } | null | undefined)?.code === "number") {
      return { error };
    }
  }
  return undefined;
}

/** The statuses the spec gives a JSON-RPC error body (version/era/header errors, unknown method). */
const RPC_ERROR_STATUSES = new Set([400, 404]);

interface InFlight {
  readonly method: string;
  readonly abort: AbortController;
  /** The body carried a modern `_meta` protocol version. */
  readonly modern: boolean;
  cancelled: boolean;
}

export function createStreamableHttpTransport(
  spec: McpHttpServerSpec,
  options: HttpTransportOptions = {},
): McpTransport {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  // One controller aborts every in-flight POST (and its stream) on close.
  const inflight = new AbortController();
  const requests = new Map<RequestId, InFlight>();
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  // `x-mcp-header` annotations per tool, from the last `tools/list` reply.
  const toolHeaders = new Map<string, readonly HeaderParam[]>();
  let closed = false;
  let sessionId: string | undefined;
  let legacyVersion: string | undefined;
  let sessionReleased = false;

  const emitClose = (reason?: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    inflight.abort();
    for (const request of requests.values()) {
      request.abort.abort();
    }
    for (const listener of closeListeners) {
      listener(reason);
    }
  };

  /** Keep only tools whose `x-mcp-header` annotations are valid, remembering them. */
  const filterTools = (message: unknown): unknown => {
    const result = (message as { result?: { tools?: unknown } }).result;
    if (!Array.isArray(result?.tools)) {
      return message;
    }
    const kept = result.tools.filter((tool: unknown) => {
      const name = (tool as { name?: unknown } | null)?.name;
      const params = headerParams((tool as { inputSchema?: unknown } | null)?.inputSchema);
      if (typeof name === "string" && params.ok) {
        toolHeaders.set(name, params.params);
      }
      return params.ok; // invalid annotation → excluded (spec MUST)
    });
    return { ...(message as object), result: { ...result, tools: kept } };
  };

  const deliver = (message: unknown, request?: InFlight): void => {
    if (closed) {
      return;
    }
    let delivered = message;
    if (request?.method === "initialize") {
      const version = (message as { result?: { protocolVersion?: unknown } }).result
        ?.protocolVersion;
      if (typeof version === "string") {
        legacyVersion = version;
      }
    } else if (request?.method === "tools/list" && request.modern) {
      // `x-mcp-header` is a 2026-07-28 rule; a legacy server's tools pass as-is.
      delivered = filterTools(message);
    }
    for (const listener of messageListeners) {
      listener(delivered);
    }
  };

  const baseHeaders = (): Record<string, string> => ({
    ...spec.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
  });

  /** Headers for one message: base + version + the request-metadata mirror. */
  const headersFor = (message: unknown): Record<string, string> => {
    const m = message as { method?: unknown; params?: unknown };
    const params = m.params as {
      _meta?: Record<string, unknown>;
      name?: unknown;
      arguments?: unknown;
    };
    const metaVersion = params?._meta?.[MCP_META_PROTOCOL_VERSION];
    const version = typeof metaVersion === "string" ? metaVersion : legacyVersion;
    const headers: Record<string, string> = {
      ...baseHeaders(),
      ...(version ? { [PROTOCOL_VERSION_HEADER]: version } : {}),
    };
    // The request-metadata mirror is a 2026-07-28 binding rule: modern requests only.
    if (
      typeof m.method === "string" &&
      requestIdOf(message) !== undefined &&
      typeof metaVersion === "string"
    ) {
      Object.assign(headers, standardHeaders(m.method, params));
      const annotated = typeof params?.name === "string" ? toolHeaders.get(params.name) : undefined;
      if (m.method === "tools/call" && annotated) {
        Object.assign(headers, paramHeaders(annotated, params?.arguments));
      }
    }
    return headers;
  };

  const post = async (message: unknown): Promise<void> => {
    const id = requestIdOf(message);
    const request = id !== undefined ? requests.get(id) : undefined;
    let answered = false;
    const dispatch = (m: unknown): void => {
      if (id !== undefined && isReplyTo(m, id)) {
        answered = true;
      }
      deliver(m, request);
    };
    const sentSession = sessionId;
    // A request has its own controller (per-request cancel); `emitClose` aborts them all.
    const signal = request ? request.abort.signal : inflight.signal;
    try {
      let response: Response;
      try {
        response = await doFetch(spec.url, {
          method: "POST",
          headers: headersFor(message),
          body: JSON.stringify(message),
          signal,
        });
      } catch (error) {
        // No response at all: the server is unreachable — unless the client
        // itself cancelled. Only a pending request needs settling.
        if (id !== undefined && !request?.cancelled) {
          emitClose(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      const assigned = response.headers.get(SESSION_HEADER);
      if (assigned) {
        sessionId = assigned;
      }
      try {
        await readResponse(response, id, sentSession, dispatch, () => answered);
      } catch (error) {
        // The server started answering, then the stream broke: this request is
        // lost (its outcome unknown), the connection is not. A client cancel
        // lands here too, and needs nothing.
        if (id !== undefined && !answered && !request?.cancelled) {
          const why = error instanceof Error ? error.message : String(error);
          dispatch(
            errorReply(id, `MCP response stream lost (${why}); the call's outcome is unknown`, {
              streamLost: true,
            }),
          );
        }
        return;
      }
    } finally {
      if (id !== undefined) {
        requests.delete(id);
      }
      // Answered: stop reading whatever the server keeps streaming after the reply.
      if (answered && request) {
        request.cancelled = true;
        request.abort.abort();
      }
    }
    if (id !== undefined && !answered && !closed) {
      dispatch(errorReply(id, "MCP server ended the response without a result"));
    }
  };

  /** Read one POST's response, dispatching every message it carries; throws if its stream breaks. */
  const readResponse = async (
    response: Response,
    id: RequestId | undefined,
    sentSession: string | undefined,
    dispatch: (m: unknown) => void,
    answered: () => boolean,
  ): Promise<void> => {
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!response.ok) {
      if (response.status === 404 && sentSession !== undefined) {
        await response.body?.cancel().catch(() => {});
        emitClose("MCP session expired (HTTP 404)");
        return;
      }
      const rpcBody = RPC_ERROR_STATUSES.has(response.status) && type.includes("application/json");
      const body = rpcBody ? parseMessages(await response.text()) : [];
      if (!rpcBody) {
        await response.body?.cancel().catch(() => {});
      }
      if (id !== undefined) {
        const rpc = jsonRpcError(body, id);
        const status = `HTTP ${response.status} ${response.statusText}`.trim();
        dispatch(
          rpc
            ? { jsonrpc: "2.0", id, error: rpc.error }
            : errorReply(id, status, { httpStatus: response.status }),
        );
      }
      return;
    }
    if (type.includes("text/event-stream") && response.body) {
      for await (const data of sseMessages(response.body)) {
        for (const m of parseMessages(data)) {
          dispatch(m);
        }
        if (answered()) {
          return; // the final response SHOULD end the stream; don't wait for it
        }
      }
    } else if (type.includes("application/json")) {
      for (const m of parseMessages(await response.text())) {
        dispatch(m);
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
  };

  /** Stop waiting for a request without telling the server: close its stream. */
  const abandon = (requestId: RequestId): void => {
    const request = requests.get(requestId);
    if (request) {
      request.cancelled = true;
      request.abort.abort();
    }
  };

  /** `notifications/cancelled`: abort the request's own stream; POST it only for a legacy request. */
  const cancel = (message: unknown): boolean => {
    const requestId = (message as { params?: { requestId?: unknown } }).params?.requestId;
    const request =
      typeof requestId === "number" || typeof requestId === "string"
        ? requests.get(requestId)
        : undefined;
    if (!request) {
      return false; // already finished: nothing in flight to cancel
    }
    request.cancelled = true;
    request.abort.abort();
    return !request.modern;
  };

  return {
    send(message: unknown): void {
      if (closed) {
        return;
      }
      const m = message as { method?: unknown; params?: { _meta?: Record<string, unknown> } };
      if (m.method === "notifications/cancelled") {
        if (cancel(message)) {
          void post(message);
        }
        return;
      }
      const id = requestIdOf(message);
      if (id !== undefined && typeof m.method === "string") {
        requests.set(id, {
          method: m.method,
          abort: new AbortController(),
          modern: typeof m.params?._meta?.[MCP_META_PROTOCOL_VERSION] === "string",
          cancelled: false,
        });
      }
      void post(message);
    },
    onMessage(listener): void {
      messageListeners.add(listener);
    },
    onClose(listener): void {
      closeListeners.add(listener);
    },
    abandon,
    close(): void {
      emitClose();
      if (sessionId && !sessionReleased) {
        sessionReleased = true;
        // Best effort: let a legacy server free the session (it may answer 405).
        void doFetch(spec.url, { method: "DELETE", headers: baseHeaders() }).catch(() => {});
      }
    },
  };
}
