/**
 * Streamable HTTP transport for MCP (spec 2025-03-26+): every outbound JSON-RPC
 * message is POSTed to the server's single endpoint. A request's reply comes
 * back either as one `application/json` body or as a `text/event-stream` that
 * carries it (plus any server messages sent along the way); notifications and
 * responses get `202` with no body. The server may assign a session
 * (`Mcp-Session-Id`), echoed on every later request.
 *
 * Failure mapping — a pending request always settles, and a reachable server
 * never looks unreachable (see docs/feat/mcp-remote-transport.md):
 * - network failure / stream torn before the reply → close (unreachable);
 * - 404 while holding a session → close (session expired; no reconnect);
 * - any other non-2xx → a JSON-RPC error reply for that id, tagged
 *   `data.httpStatus` so `ping` does not count it as the server answering;
 * - 2xx whose body ends without the reply → a JSON-RPC error reply for that id.
 *
 * Not implemented: the optional GET stream for unsolicited server messages
 * (we implement no server→client methods) and `Last-Event-ID` resumption.
 */
import type { McpHttpServerSpec, McpTransport } from "./types.ts";

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
 * A synthesized JSON-RPC error for `id`. `httpStatus` marks one that stands for
 * an HTTP error status, not an answer from the MCP server itself (a proxy 503,
 * an expired token's 401) — `McpClient` keeps those from proving reachability.
 */
const errorReply = (id: RequestId, message: string, httpStatus?: number): unknown => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32000, message, ...(httpStatus !== undefined ? { data: { httpStatus } } : {}) },
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

export function createStreamableHttpTransport(
  spec: McpHttpServerSpec,
  options: HttpTransportOptions = {},
): McpTransport {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  // One controller aborts every in-flight POST (and its stream) on close.
  const inflight = new AbortController();
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  let closed = false;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let initializeId: RequestId | undefined;
  let sessionReleased = false;

  const emitClose = (reason?: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    inflight.abort();
    for (const listener of closeListeners) {
      listener(reason);
    }
  };

  const deliver = (message: unknown): void => {
    if (closed) {
      return;
    }
    if (initializeId !== undefined && isReplyTo(message, initializeId)) {
      const version = (message as { result?: { protocolVersion?: unknown } }).result
        ?.protocolVersion;
      if (typeof version === "string") {
        protocolVersion = version;
      }
    }
    for (const listener of messageListeners) {
      listener(message);
    }
  };

  const headers = (): Record<string, string> => ({
    ...spec.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    ...(protocolVersion ? { [PROTOCOL_VERSION_HEADER]: protocolVersion } : {}),
  });

  const post = async (message: unknown): Promise<void> => {
    const id = requestIdOf(message);
    let answered = false;
    const dispatch = (m: unknown): void => {
      if (id !== undefined && isReplyTo(m, id)) {
        answered = true;
      }
      deliver(m);
    };
    const sentSession = sessionId;
    try {
      const response = await doFetch(spec.url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(message),
        signal: inflight.signal,
      });
      const assigned = response.headers.get(SESSION_HEADER);
      if (assigned) {
        sessionId = assigned;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404 && sentSession !== undefined) {
          emitClose("MCP session expired (HTTP 404)");
          return;
        }
        if (id !== undefined) {
          const status = `HTTP ${response.status} ${response.statusText}`.trim();
          dispatch(errorReply(id, status, response.status));
        }
        return;
      }
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && response.body) {
        for await (const data of sseMessages(response.body)) {
          for (const m of parseMessages(data)) {
            dispatch(m);
          }
        }
      } else if (type.includes("application/json")) {
        for (const m of parseMessages(await response.text())) {
          dispatch(m);
        }
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch (error) {
      // Unreachable, or the stream broke mid-reply. Only a pending request
      // needs settling; a lost notification/response has nobody waiting.
      if (id !== undefined && !answered) {
        emitClose(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (id !== undefined && !answered) {
      dispatch(errorReply(id, "MCP server ended the response without a result"));
    }
  };

  return {
    send(message: unknown): void {
      if (closed) {
        return;
      }
      const m = message as { method?: unknown };
      if (m.method === "initialize") {
        initializeId = requestIdOf(message);
      }
      void post(message);
    },
    onMessage(listener): void {
      messageListeners.add(listener);
    },
    onClose(listener): void {
      closeListeners.add(listener);
    },
    close(): void {
      emitClose();
      if (sessionId && !sessionReleased) {
        sessionReleased = true;
        // Best effort: let the server free the session (it may answer 405).
        void doFetch(spec.url, { method: "DELETE", headers: headers() }).catch(() => {});
      }
    },
  };
}
