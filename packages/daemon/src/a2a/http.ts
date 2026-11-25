/**
 * The A2A HTTP route (docs/feat/a2a.md S9): the public agent card, and
 * `POST /a2a` — JSON-RPC, or SSE for the streaming methods. Mounted by
 * `startWsServer` (`WsServerOptions.a2a`) BEFORE its WebSocket checks; any path
 * it does not own falls through to today's behaviour. The token / Origin /
 * size guards are the protocol-neutral `external/route.ts`; this file is the
 * A2A wire glue over the SDK's `JsonRpcTransportHandler` (the same dispatch
 * the SDK's express adapter uses, without express).
 */
import type { AgentCard } from "@a2a-js/sdk";
import {
  JsonRpcTransportHandler,
  type A2ARequestHandler as SdkRequestHandler,
  defaultServerCallContextBuilder,
  validateVersion,
} from "@a2a-js/sdk/server";
import {
  EXTERNAL_MAX_BODY_BYTES,
  type ExternalCaller,
  authenticateCaller,
  readBoundedBody,
} from "../external/route.ts";

export const A2A_PATH = "/a2a";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
const SSE_PING_MS = 15_000;
const VERSION_HEADER = "A2A-Version";

/** What the route needs from Bun's server (lifts the idle timeout of a long call). */
export interface TimeoutServer {
  timeout(req: Request, seconds: number): void;
}

/** The hook `startWsServer` calls first on every request. */
export interface A2ARoute {
  /** A response when the route owns the path; undefined = not ours, fall through. */
  handle(req: Request, srv: TimeoutServer): Response | Promise<Response> | undefined;
}

export interface A2AHttpOptions {
  /** The handler built over the executor and the projection store (an `A2ARequestHandler`). */
  readonly requestHandler: SdkRequestHandler;
  /** The public card (its `supportedInterfaces` fix the versions accepted). */
  readonly card: AgentCard;
  /** One entry per caller; none = the route is not built. */
  readonly callers: readonly ExternalCaller[];
  readonly maxBodyBytes?: number;
  readonly onAudit?: (line: string) => void;
  /** Heartbeat of an open stream (tests shorten it). */
  readonly pingMs?: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const INTERNAL = -32603;

/** An internal fault tells the caller nothing but that it happened (the SDK echoes the message). */
const scrub = (e: { code: number; message: string }): { code: number; message: string } =>
  e.code === INTERNAL ? { code: INTERNAL, message: "internal error" } : e;

const rpcError = (id: unknown, error: { code: number; message: string }, status = 200): Response =>
  json(status, { jsonrpc: "2.0", id: id ?? null, error: scrub(error) });

/** Build the route. Throws without a caller: A2A is off unless a token exists. */
export function createA2ARoute(options: A2AHttpOptions): A2ARoute {
  if (options.callers.length === 0) {
    throw new Error("A2A needs at least one caller token");
  }
  const transport = new JsonRpcTransportHandler(options.requestHandler);
  const maxBody = options.maxBodyBytes ?? EXTERNAL_MAX_BODY_BYTES;
  const pingMs = options.pingMs ?? SSE_PING_MS;
  const encoder = new TextEncoder();

  const post = async (req: Request, srv: TimeoutServer): Promise<Response> => {
    const caller = authenticateCaller(req, options.callers);
    if (caller === null) {
      options.onAudit?.("a2a-auth-failure");
      return new Response("unauthorized", { status: 401 });
    }
    // A blocking call (or a stream) legitimately outlives Bun's HTTP idle timeout.
    srv.timeout(req, 0);
    const text = await readBoundedBody(req, maxBody);
    if (text === "too-large") {
      return new Response("request too large", { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return rpcError(null, { code: -32600, message: "Invalid Request" });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return rpcError(null, { code: -32700, message: "Invalid JSON payload." });
    }
    const id = body.id;
    const mediaType = (req.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "" && mediaType !== "application/json") {
      return rpcError(id, {
        code: -32005,
        message: "Unsupported Content-Type: expected application/json.",
      });
    }
    try {
      const context = defaultServerCallContextBuilder({
        extensions: undefined,
        user: { isAuthenticated: true, userName: caller },
        headers: Object.fromEntries([...(req.headers as unknown as Iterable<[string, string]>)]),
        requestedVersion: req.headers.get(VERSION_HEADER) || undefined,
      });
      validateVersion(context.requestedVersion, options.card, "JSONRPC");
      const result = await transport.handle(body, context);
      if (typeof (result as AsyncGenerator<unknown>)?.[Symbol.asyncIterator] !== "function") {
        const failure = (result as { error?: { code: number; message: string } }).error;
        return failure?.code === INTERNAL
          ? rpcError((result as { id?: unknown }).id, failure, 500)
          : json(200, result);
      }
      return stream(result as AsyncGenerator<unknown, void, undefined>, id);
    } catch (error) {
      const mapped = JsonRpcTransportHandler.mapToJSONRPCError(error);
      return rpcError(id, mapped, mapped.code === -32603 ? 500 : 200);
    }
  };

  /** SSE: the first event is awaited so a pre-stream error is a plain JSON-RPC error. */
  const stream = async (
    events: AsyncGenerator<unknown, void, undefined>,
    id: unknown,
  ): Promise<Response> => {
    let first: IteratorResult<unknown, void>;
    try {
      first = await events.next();
    } catch (error) {
      return rpcError(id, JsonRpcTransportHandler.mapToJSONRPCError(error));
    }
    let ping: ReturnType<typeof setInterval> | undefined;
    const sse = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // the caller went away
          }
        };
        ping = setInterval(() => send(": ping\n\n"), pingMs);
        void (async () => {
          try {
            if (!first.done) {
              send(`data: ${JSON.stringify(first.value)}\n\n`);
            }
            if (!first.done) {
              for await (const event of events) {
                send(`data: ${JSON.stringify(event)}\n\n`);
              }
            }
          } catch (error) {
            const mapped = JsonRpcTransportHandler.mapToJSONRPCError(error);
            send(
              `event: error\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: scrub(mapped) })}\n\n`,
            );
          } finally {
            clearInterval(ping);
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          }
        })();
      },
      cancel() {
        // The caller dropped: the unit continues (the task is the session's, not the stream's).
        clearInterval(ping);
        void events.return(undefined).catch(() => {});
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
      const path = new URL(req.url).pathname;
      if (path === AGENT_CARD_PATH) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return new Response("method not allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        return json(200, options.card);
      }
      if (path === A2A_PATH) {
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
        }
        return post(req, srv);
      }
      return undefined;
    },
  };
}
