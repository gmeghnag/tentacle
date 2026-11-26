/**
 * A fake remote A2A agent behind an in-memory `fetch` (docs/feat/a2a-client.md
 * Repro, as a helper): the SDK's REAL server (`DefaultRequestHandler` +
 * `InMemoryTaskStore` + `JsonRpcTransportHandler`) with a scripted executor.
 * No socket. The `fetch` behaves like a real one where the adapter's security
 * depends on it: it FOLLOWS a 3xx with the same headers unless
 * `redirect: "error"` (then it throws), and an aborted `signal` errors the
 * response body.
 *
 * Script, by the first message's text: `work` → progress, artifact, COMPLETED;
 * `ask` → INPUT_REQUIRED (a follow-up → artifact `got: <text>`, COMPLETED);
 * `auth` → AUTH_REQUIRED (the stream stays open); `hang` → WORKING until
 * `release()`; anything else → artifact `echo: <text>`, COMPLETED.
 */
import type { AgentCard } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
} from "@a2a-js/sdk/server";

export interface FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  /** The JSON-RPC method of a POST. */
  readonly rpc?: string;
}

export interface FakeReceived {
  readonly text: string;
  readonly taskId: string;
  readonly contextId: string;
}

export interface FakeA2A {
  readonly origin: string;
  readonly cardUrl: string;
  readonly fetch: typeof fetch;
  /** Every request the fetch was asked for, any origin, in order. */
  readonly requests: FakeRequest[];
  /** Every user message the executor received. */
  readonly received: FakeReceived[];
  /** POST /a2a → 307 to this URL. */
  redirectA2A?: string;
  /** POST /a2a → this response (`{auth}` in the body is replaced by the header it got). */
  failA2A?: { readonly status: number; readonly body: string };
  /** CancelTask never answers (until the caller's signal aborts). */
  cancelHangs: boolean;
  /** Finish every `hang` task. */
  release(): void;
  /** Cut every open stream (a network drop: the body errors). */
  dropStreams(): void;
  /** Open SSE bodies right now. */
  openStreams(): number;
}

const enc = new TextEncoder();

export function fakeCard(url: string, over: Partial<AgentCard> = {}): AgentCard {
  return {
    name: "fake remote",
    description: "A scripted A2A agent for tests.",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" }],
    provider: undefined,
    version: "9.9.9",
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    signatures: [],
    ...over,
  };
}

function textPart(value: string) {
  return {
    content: { $case: "text" as const, value },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

function status(taskId: string, contextId: string, state: TaskState, text?: string) {
  return AgentEvent.statusUpdate({
    taskId,
    contextId,
    metadata: {},
    status: {
      state,
      timestamp: undefined,
      message:
        text === undefined
          ? undefined
          : {
              messageId: crypto.randomUUID(),
              taskId,
              contextId,
              role: Role.ROLE_AGENT,
              parts: [textPart(text)],
              metadata: {},
              extensions: [],
              referenceTaskIds: [],
            },
    },
  });
}

function artifact(taskId: string, contextId: string, text: string) {
  return AgentEvent.artifactUpdate({
    taskId,
    contextId,
    artifact: {
      artifactId: "r",
      name: "r",
      description: "",
      parts: [textPart(text)],
      metadata: {},
      extensions: [],
    },
    append: false,
    lastChunk: true,
    metadata: {},
  });
}

export function createFakeA2A(
  opts: { origin?: string; token?: string; card?: Partial<AgentCard> } = {},
): FakeA2A {
  const origin = opts.origin ?? "http://remote.example";
  const card = fakeCard(`${origin}/a2a`, opts.card);
  const hangs = new Set<() => void>();
  const streams = new Set<() => void>();
  const requests: FakeRequest[] = [];
  const received: FakeReceived[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: the SDK's executor types are server-internal
  type Bus = { publish(event: any): void };
  const executor = {
    // biome-ignore lint/suspicious/noExplicitAny: RequestContext is server-internal
    async execute(rc: any, bus: Bus): Promise<void> {
      const { taskId, contextId } = rc;
      // biome-ignore lint/suspicious/noExplicitAny: SDK parts
      const text = rc.userMessage.parts.map((p: any) => p.content?.value ?? "").join("");
      received.push({ text, taskId: rc.userMessage.taskId, contextId: rc.userMessage.contextId });
      const task = rc.task ?? {
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
        artifacts: [],
        history: [],
        metadata: {},
      };
      bus.publish(AgentEvent.task(task));
      if (rc.task) {
        bus.publish(artifact(taskId, contextId, `got: ${text}`));
        bus.publish(status(taskId, contextId, TaskState.TASK_STATE_COMPLETED));
        return;
      }
      bus.publish(status(taskId, contextId, TaskState.TASK_STATE_WORKING, "step 1"));
      if (text === "ask") {
        bus.publish(
          status(taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, "which branch?"),
        );
        return;
      }
      if (text === "auth") {
        bus.publish(status(taskId, contextId, TaskState.TASK_STATE_AUTH_REQUIRED, "need a token"));
        await new Promise<void>((r) => hangs.add(r));
        return;
      }
      if (text === "hang") {
        await new Promise<void>((r) => hangs.add(r));
        bus.publish(artifact(taskId, contextId, "done: late"));
        bus.publish(status(taskId, contextId, TaskState.TASK_STATE_COMPLETED));
        return;
      }
      bus.publish(artifact(taskId, contextId, text === "work" ? "done: 42" : `echo: ${text}`));
      bus.publish(status(taskId, contextId, TaskState.TASK_STATE_COMPLETED));
    },
    async cancelTask(taskId: string, bus: Bus): Promise<void> {
      bus.publish(status(taskId, "", TaskState.TASK_STATE_CANCELED));
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: the executor shape above
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor as any);
  const transport = new JsonRpcTransportHandler(handler);

  /** SSE, first event awaited (a pre-stream error is a plain JSON-RPC error), like the daemon's route. */
  const sse = async (events: AsyncGenerator<unknown>, id: unknown): Promise<Response> => {
    let first: IteratorResult<unknown>;
    try {
      first = await events.next();
    } catch (error) {
      return Response.json({
        jsonrpc: "2.0",
        id: id ?? null,
        error: JsonRpcTransportHandler.mapToJSONRPCError(error),
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (chunk: string): void => {
          try {
            c.enqueue(enc.encode(chunk));
          } catch {
            // the caller went away
          }
        };
        void (async () => {
          try {
            if (!first.done) {
              send(`data: ${JSON.stringify(first.value)}\n\n`);
              for await (const ev of events) send(`data: ${JSON.stringify(ev)}\n\n`);
            }
          } catch (error) {
            const e = JsonRpcTransportHandler.mapToJSONRPCError(error);
            send(
              `event: error\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: e })}\n\n`,
            );
          } finally {
            try {
              c.close();
            } catch {
              // cancelled
            }
          }
        })();
      },
      cancel() {
        void events.return(undefined).catch(() => {});
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  const route = async (req: Request, signal: AbortSignal | undefined): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/.well-known/agent-card.json" && req.method === "GET") return Response.json(card);
    if (path !== "/a2a" || req.method !== "POST") return new Response("not found", { status: 404 });
    if (fake.redirectA2A !== undefined) {
      return new Response(null, { status: 307, headers: { location: fake.redirectA2A } });
    }
    const auth = req.headers.get("authorization");
    if (fake.failA2A !== undefined) {
      return new Response(fake.failA2A.body.replace("{auth}", auth ?? "-"), {
        status: fake.failA2A.status,
      });
    }
    if (opts.token !== undefined && auth !== `Bearer ${opts.token}`) {
      // Echoes what it got: the adapter must never surface it.
      return new Response(`unauthorized (got ${auth ?? "nothing"})`, { status: 401 });
    }
    const body = (await req.json()) as Record<string, unknown>;
    if (fake.cancelHangs && /cancel/i.test(String(body.method))) {
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }
    const context = defaultServerCallContextBuilder({
      extensions: undefined,
      user: { isAuthenticated: true, userName: "test" },
      headers: {},
      requestedVersion: req.headers.get("A2A-Version") || undefined,
    });
    const result = await transport.handle(body, context);
    if (typeof (result as AsyncGenerator<unknown>)?.[Symbol.asyncIterator] === "function") {
      return sse(result as AsyncGenerator<unknown>, body.id);
    }
    return Response.json(result);
  };

  /** An aborted signal (or `dropStreams`) errors the body, as a real fetch does. */
  const abortable = (res: Response, signal: AbortSignal | undefined): Response => {
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("event-stream")) return res;
    const reader = res.body.getReader();
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const kill = (err: unknown): void => {
      try {
        ctl?.error(err);
      } catch {
        // already closed
      }
      void reader.cancel().catch(() => {});
      streams.delete(drop);
    };
    const drop = (): void => kill(new TypeError("network connection lost"));
    streams.add(drop);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            streams.delete(drop);
            c.close();
          } else c.enqueue(r.value);
        } catch {
          // killed
        }
      },
      cancel() {
        streams.delete(drop);
        void reader.cancel().catch(() => {});
      },
    });
    if (signal?.aborted) kill(new DOMException("aborted", "AbortError"));
    else
      signal?.addEventListener("abort", () => kill(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    return new Response(body, { status: res.status, headers: res.headers });
  };

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    let rpc: string | undefined;
    if (req.method === "POST") {
      try {
        rpc = String((JSON.parse(await req.clone().text()) as { method?: unknown }).method);
      } catch {
        rpc = undefined;
      }
    }
    requests.push({
      url: req.url,
      method: req.method,
      auth: req.headers.get("authorization"),
      ...(rpc ? { rpc } : {}),
    });
    if (new URL(req.url).origin !== origin) return new Response("foreign", { status: 200 });
    const res = await route(req, signal);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null) {
      const mode = init?.redirect ?? "follow";
      if (mode === "error") throw new TypeError("fetch failed: unexpected redirect");
      if (mode === "follow") {
        // A naive follow keeps every header — the worst case the adapter must not rely on.
        return fetchImpl(new URL(location, req.url).href, { ...init, headers: req.headers });
      }
    }
    return abortable(res, signal);
  };

  const fake: FakeA2A = {
    origin,
    cardUrl: `${origin}/.well-known/agent-card.json`,
    fetch: fetchImpl as typeof fetch,
    requests,
    received,
    cancelHangs: false,
    release() {
      for (const r of [...hangs]) r();
      hangs.clear();
    },
    dropStreams() {
      for (const d of [...streams]) d();
    },
    openStreams: () => streams.size,
  };
  return fake;
}
