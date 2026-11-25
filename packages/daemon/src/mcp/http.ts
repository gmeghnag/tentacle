/**
 * The MCP HTTP route (docs/feat/serve-mcp-server.md, Design §1–§2; slice M2):
 * `POST /mcp`, Streamable HTTP with no session and no GET stream. Mounted by
 * `startWsServer` (`WsServerOptions.mcp`) on the one external entry, beside
 * `/a2a`; any path it does not own falls through. The guards (dedicated
 * caller token, browser `Origin`, bounded body) are the protocol-neutral
 * `external/route.ts`; the JSON-RPC shapes are the pure `mcp/wire.ts`; the
 * verbs are `mcp/tools.ts`.
 *
 * Responses are `application/json`, except a `session_status` wait with a
 * `progressToken`: `text/event-stream`, a `notifications/progress` every 15 s,
 * then the result. A client disconnect ends only that wait.
 */
import {
  EXTERNAL_MAX_BODY_BYTES,
  type ExternalCaller,
  type ExternalRoute,
  type TimeoutServer,
  authenticateCaller,
  readBoundedBody,
} from "../external/route.ts";
import { tasksMethod } from "./tasks.ts";
import { InvalidToolParams, MCP_TOOLS, type McpTools } from "./tools.ts";
import {
  ErrorCode,
  type ParsedRequest,
  type ServerInfo,
  type WireReply,
  discoverResult,
  errorBody,
  initializeResult,
  mayUseTasks,
  methodNotAllowed,
  parseRequest,
  progressCounter,
  progressNotification,
  resultBody,
  rpcError,
  rpcResult,
  sseEvent,
} from "./wire.ts";

export const MCP_PATH = "/mcp";
const PROGRESS_MS = 15_000;

export const MCP_INSTRUCTIONS =
  "Delegate work to a tentacle session on this serve: session_start, then session_status (waitSeconds to wait) until it ends; session_send steers or continues it, session_cancel stops it.";

export interface McpHttpOptions {
  readonly tools: McpTools;
  /** One entry per MCP caller; none = the route is not built. */
  readonly callers: readonly ExternalCaller[];
  readonly serverInfo: ServerInfo;
  readonly maxBodyBytes?: number;
  readonly onAudit?: (line: string) => void;
  /** Progress interval of a held `session_status` (tests shorten it). */
  readonly progressMs?: number;
}

const reply = (r: WireReply): Response =>
  new Response(r.body === undefined ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: {
      ...(r.body === undefined ? {} : { "content-type": "application/json" }),
      ...(r.headers ?? {}),
    },
  });

/** Build the route. Throws without a caller: MCP is off unless a token exists. */
export function createMcpRoute(options: McpHttpOptions): ExternalRoute {
  if (options.callers.length === 0) {
    throw new Error("MCP needs at least one caller token");
  }
  const maxBody = options.maxBodyBytes ?? EXTERNAL_MAX_BODY_BYTES;
  const progressMs = options.progressMs ?? PROGRESS_MS;
  const encoder = new TextEncoder();

  const post = async (req: Request, srv: TimeoutServer): Promise<Response> => {
    // A browser page never drives the route (the MCP spec's code: 403, before auth).
    if (req.headers.get("origin") !== null) {
      options.onAudit?.("mcp-origin-refused");
      return new Response("forbidden", { status: 403 });
    }
    const caller = authenticateCaller(req, options.callers);
    if (caller === null) {
      options.onAudit?.("mcp-auth-failure");
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    // A held status wait legitimately outlives Bun's HTTP idle timeout.
    srv.timeout(req, 0);
    const text = await readBoundedBody(req, maxBody);
    if (text === "too-large") {
      return new Response("request too large", { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reply(rpcError(null, ErrorCode.ParseError, "invalid JSON"));
    }
    const parsed = parseRequest(req.headers, body);
    if (parsed.kind === "reply") return reply(parsed.reply);
    if (parsed.kind === "notification") return new Response(null, { status: 202 });
    return dispatch(parsed, caller, req.signal);
  };

  const dispatch = async (
    r: ParsedRequest,
    caller: string,
    signal: AbortSignal,
  ): Promise<Response> => {
    switch (r.method) {
      case "initialize":
        return reply(
          rpcResult(
            r.id,
            initializeResult(r.params.protocolVersion, options.serverInfo, MCP_INSTRUCTIONS),
          ),
        );
      case "server/discover":
        return reply(rpcResult(r.id, discoverResult(options.serverInfo, MCP_INSTRUCTIONS)));
      case "ping":
        return reply(rpcResult(r.id, {}));
      case "tools/list":
        return reply(rpcResult(r.id, { tools: MCP_TOOLS }));
      case "tools/call":
        return toolsCall(r, caller, signal);
      case "tasks/get":
      case "tasks/update":
      case "tasks/cancel":
        // Only for a request that declared the extension (else -32021).
        try {
          return reply(await tasksMethod(options.tools, r, caller, options.onAudit));
        } catch (error) {
          return reply(invalid(r, error));
        }
      default:
        return reply(rpcError(r.id, ErrorCode.MethodNotFound, `unknown method ${r.method}`));
    }
  };

  const toolsCall = async (
    r: ParsedRequest,
    caller: string,
    signal: AbortSignal,
  ): Promise<Response> => {
    const name = r.params.name;
    const rawArgs = r.params.arguments ?? {};
    if (typeof name !== "string" || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return reply(rpcError(r.id, ErrorCode.InvalidParams, "tools/call: name and arguments"));
    }
    const args = rawArgs as Record<string, unknown>;
    const held =
      name === "session_status" &&
      r.progressToken !== undefined &&
      typeof args.waitSeconds === "number" &&
      args.waitSeconds > 0;
    if (!held) {
      try {
        // A task only for a request that declared the extension (never legacy).
        const result = mayUseTasks(r)
          ? await options.tools.callAsTask(caller, name, args, signal)
          : await options.tools.call(caller, name, args, signal);
        return reply(rpcResult(r.id, result));
      } catch (error) {
        return reply(invalid(r, error));
      }
    }
    return progressStream(r, caller, args, signal);
  };

  /** A held `session_status`: progress every `progressMs`, then the result, then close. */
  const progressStream = (
    r: ParsedRequest,
    caller: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Response => {
    const token = r.progressToken ?? 0;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort);
    let tick: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(tick);
      signal.removeEventListener("abort", onAbort);
    };
    const sse = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (message: unknown) => {
          try {
            controller.enqueue(encoder.encode(sseEvent(message)));
          } catch {
            // the caller went away
          }
        };
        const started = Date.now();
        const next = progressCounter();
        tick = setInterval(
          () => send(progressNotification(token, next((Date.now() - started) / 1000))),
          progressMs,
        );
        void (async () => {
          try {
            send(
              resultBody(
                r.id,
                await options.tools.call(caller, "session_status", args, abort.signal),
              ),
            );
          } catch (error) {
            send(invalid(r, error).body);
          } finally {
            stop();
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          }
        })();
      },
      cancel() {
        // The caller dropped: only the wait ends, the turn runs on.
        stop();
        abort.abort();
      },
    });
    return new Response(sse, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  };

  return {
    handle(req, srv) {
      if (new URL(req.url).pathname !== MCP_PATH) {
        return undefined;
      }
      if (req.method !== "POST") {
        return reply(methodNotAllowed());
      }
      return post(req, srv);
    },
  };
}

/** Bad arguments → `-32602`; anything else is an internal fault that says nothing more. */
function invalid(r: ParsedRequest, error: unknown): WireReply {
  return error instanceof InvalidToolParams
    ? rpcError(r.id, ErrorCode.InvalidParams, error.message)
    : { status: 500, body: errorBody(r.id, ErrorCode.InternalError, "internal error") };
}
