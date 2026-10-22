import { describe, expect, test } from "bun:test";
import { Agent, HookRunner } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PermissionRequester,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import {
  JsonRpcErrorCode,
  KNOWN_UPDATE_TYPES,
  Method,
  Notification,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import {
  MODEL_STREAM_BATCH_MAX_CHARS,
  MODEL_STREAM_COALESCE_MS,
  RemoteClient,
  type RemoteClientOptions,
} from "../src/remote-client.ts";
import { type WebSocketChannel, connectWebSocket } from "../src/ws-channel.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

function makeHost(model: ModelProvider, env: ExecutionEnvironment): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/remote-work",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
}

async function collect(iter: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
  }
  return out;
}

/** Poll `pred` until true or `timeoutMs` elapses; resolves with the result. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** A local (laptop) provider that records the signal it was called with and can
 *  hold mid-stream on a gate, so a test can drive a real mid-round cancel. */
class RecordingGatedProvider implements ModelProvider {
  readonly id = "rec";
  readonly seenSignals: AbortSignal[] = [];
  gate: (() => void) | null = null;
  constructor(private readonly script: readonly StreamEvent[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const signal = request.signal ?? new AbortController().signal;
    this.seenSignals.push(signal);
    // Yield the first event, then hold until the gate opens or the signal aborts
    // (a real provider would keep streaming; this lets the test cancel mid-round).
    yield this.script[0] as StreamEvent;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      this.gate = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
    if (signal.aborted) {
      return; // the local provider stops on a cancel (like a real one would)
    }
    for (const event of this.script.slice(1)) {
      yield event;
    }
  }
}

describe("model reverse-tunnel, chunked (streaming) cut", () => {
  test("the daemon streams the laptop model's events to the TUI as they are produced", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    // biome-ignore lint/style/useConst: assigned after the closure that references it
    let connection: Connection;
    const model = new RecordingGatedProvider([
      { type: "reasoning", delta: "thinking…" },
      { type: "text", delta: "hello from the laptop" },
      { type: "done", usage: { promptTokens: 5, completionTokens: 3 } },
    ]);
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => {
        const agent = new Agent({
          model: new ProxyModelProvider(
            (r) => connection.requestModelStream(r),
            (r, h) => connection.requestModelStreamChunked(r, h),
          ),
          tools: new ToolRegistry(),
          env: noopEnv,
        });
        return { agent, permissions: new PermissionBroker() };
      },
    });
    connection = new Connection(daemonCh, host);
    const client = new RemoteClient(clientCh, new PermissionBroker(), model);
    await client.initialize();

    const sendPromise = (async () => {
      const events: SessionEvent[] = [];
      for await (const e of client.newSession().send("hi")) {
        events.push(e);
        if (e.type === "reasoning") {
          // The turn is now mid-model-round: let the local model finish.
          model.gate?.();
        }
      }
      return events;
    })();
    const events = await sendPromise;

    // The local (laptop) model actually ran over the tunnel.
    expect(model.seenSignals).toHaveLength(1);
    const text = events
      .filter((e): e is Extract<SessionEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("hello from the laptop");
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    connection.close();
    client.close();
  });

  test("Esc (abort) reaches the laptop local provider's signal and ends the turn as a clean cancel", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    // biome-ignore lint/style/useConst: assigned after the closure that references it
    let connection: Connection;
    const model = new RecordingGatedProvider([
      { type: "reasoning", delta: "thinking…" },
      { type: "text", delta: "never seen" },
      { type: "done" },
    ]);
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => {
        const agent = new Agent({
          model: new ProxyModelProvider(
            (r) => connection.requestModelStream(r),
            (r, h) => connection.requestModelStreamChunked(r, h),
          ),
          tools: new ToolRegistry(),
          env: noopEnv,
        });
        return { agent, permissions: new PermissionBroker() };
      },
    });
    connection = new Connection(daemonCh, host);
    const client = new RemoteClient(clientCh, new PermissionBroker(), model);
    await client.initialize();

    const controller = new AbortController();
    const sendPromise = (async () => {
      const events: SessionEvent[] = [];
      for await (const e of client.newSession().send("hi", controller.signal)) {
        events.push(e);
      }
      return events;
    })();
    // Wait until the turn has reached the laptop and the local model is streaming.
    const reached = await waitFor(() => model.seenSignals.length === 1);
    expect(reached).toBe(true);
    // Esc: abort the turn while the model round is in flight.
    controller.abort();
    const events = await sendPromise;
    // The cancel propagated all the way to the laptop's local provider.
    expect(model.seenSignals[0]?.aborted).toBe(true);
    // …and the turn ended as a clean cancel, not an error.
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    connection.close();
    client.close();
  });
});

const WIRE_REQ = { messages: [{ role: "user" as const, content: "hi" }] };

/** A raw daemon-side peer issuing `model/streamChunked` (no agent in between). */
function rawDaemon(model: ModelProvider, onError?: (e: Error) => void) {
  const [daemonCh, clientCh] = createChannelPair();
  const client = new RemoteClient(clientCh, new PermissionBroker(), model, {
    ...(onError ? { onError } : {}),
  });
  const daemon = new RpcPeer(daemonCh);
  return { daemon, daemonCh, client };
}

describe("model/streamChunked — laptop side", () => {
  test("coalesces for real: a burst becomes few frames (first event alone, at once), seq counts frames, nothing lost, all before the result", async () => {
    const script: StreamEvent[] = [
      ...Array.from({ length: 50 }, (_, i): StreamEvent => ({ type: "text", delta: `t${i}` })),
      { type: "done", usage: { promptTokens: 7, completionTokens: 50 } },
    ];
    const { daemon, client } = rawDaemon(new ScriptedProvider([script]));
    const frames: { seq: number; value: unknown }[] = [];
    const result = (await daemon.request(
      Method.ModelStreamChunked,
      { request: WIRE_REQ },
      { onProgress: (value, seq) => frames.push({ seq, value }) },
    )) as { chunks: number };
    // Leading edge: the first event goes out alone, without waiting a window.
    expect(frames[0]?.value).toEqual([script[0]]);
    // The burst is batched: far fewer frames than events.
    expect(frames.length).toBeLessThanOrEqual(3);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    // Nothing lost, order kept, every frame routed BEFORE the result resolved.
    expect(frames.flatMap((f) => f.value as StreamEvent[])).toEqual(script);
    // Only the frame count: usage travelled inside the `done` event.
    expect(result).toEqual({ chunks: frames.length });
    daemon.close();
    client.close();
  });

  test("a batch never exceeds the size cap (big events split across frames; one oversize event travels alone)", async () => {
    const big = "x".repeat(Math.floor(MODEL_STREAM_BATCH_MAX_CHARS / 3));
    const huge = "y".repeat(MODEL_STREAM_BATCH_MAX_CHARS * 2);
    const script: StreamEvent[] = [
      ...Array.from({ length: 10 }, (): StreamEvent => ({ type: "text", delta: big })),
      { type: "text", delta: huge },
      { type: "done" },
    ];
    const { daemon, client } = rawDaemon(new ScriptedProvider([script]));
    const frames: StreamEvent[][] = [];
    await daemon.request(
      Method.ModelStreamChunked,
      { request: WIRE_REQ },
      { onProgress: (value) => frames.push(value as StreamEvent[]) },
    );
    expect(frames.flat()).toEqual(script);
    for (const frame of frames) {
      if (frame.length > 1) {
        expect(JSON.stringify(frame).length).toBeLessThanOrEqual(MODEL_STREAM_BATCH_MAX_CHARS);
      }
    }
    expect(frames.some((f) => f.length === 1 && f[0]?.type === "text" && f[0].delta === huge)).toBe(
      true,
    );
    daemon.close();
    client.close();
  });

  test("after a quiet pause the next event goes out at once (leading edge), not after a window", async () => {
    const yieldedAt: number[] = [];
    const model: ModelProvider = {
      id: "paused",
      async *stream(): AsyncIterable<StreamEvent> {
        for (const delta of ["a", "b"]) {
          yieldedAt.push(performance.now());
          yield { type: "text", delta };
          await new Promise((r) => setTimeout(r, MODEL_STREAM_COALESCE_MS * 3));
        }
        yield { type: "done" };
      },
    };
    const { daemon, client } = rawDaemon(model);
    const frames: unknown[] = [];
    const receivedAt: number[] = [];
    await daemon.request(
      Method.ModelStreamChunked,
      { request: WIRE_REQ },
      {
        onProgress: (value) => {
          frames.push(value);
          receivedAt.push(performance.now());
        },
      },
    );
    expect(frames).toEqual([
      [{ type: "text", delta: "a" }],
      [{ type: "text", delta: "b" }],
      [{ type: "done" }],
    ]);
    // Each post-pause event arrived well inside one window of being produced.
    for (const [i, t] of yieldedAt.entries()) {
      expect((receivedAt[i] ?? Number.POSITIVE_INFINITY) - t).toBeLessThan(
        MODEL_STREAM_COALESCE_MS / 2,
      );
    }
    daemon.close();
    client.close();
  });

  test("a local provider error reaches the pod OPAQUE; the real message goes to the laptop's onError only (§7: pod is not trusted)", async () => {
    const secret = "401 from http://10.0.0.5:8080/v1 key=sk-SECRET";
    const model: ModelProvider = {
      id: "boom",
      // biome-ignore lint/correctness/useYield: throws before yielding, on purpose
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error(secret);
      },
    };
    const logged: string[] = [];
    const { daemon, client } = rawDaemon(model, (e) => logged.push(e.message));
    let message = "";
    try {
      await daemon.request(
        Method.ModelStreamChunked,
        { request: WIRE_REQ },
        { onProgress: () => {} },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("internal error");
    expect(message).not.toContain("sk-SECRET");
    expect(logged.some((l) => l.includes(secret))).toBe(true);
    daemon.close();
    client.close();
  });

  test("a disconnect mid-round aborts the laptop's local model (it does not run to completion for nobody)", async () => {
    const model = new RecordingGatedProvider([{ type: "text", delta: "a" }, { type: "done" }]);
    const { daemon, daemonCh, client } = rawDaemon(model);
    daemon
      .request(Method.ModelStreamChunked, { request: WIRE_REQ }, { onProgress: () => {} })
      .catch(() => {});
    expect(await waitFor(() => model.seenSignals.length === 1)).toBe(true);
    daemonCh.close(); // the pod went away
    expect(await waitFor(() => model.seenSignals[0]?.aborted === true, 500)).toBe(true);
    client.close();
  });
});

describe("model/streamChunked — daemon ↔ laptop end to end (ProxyModelProvider)", () => {
  test("the laptop yields two events then throws: the daemon yields exactly those two, then throws", async () => {
    const model: ModelProvider = {
      id: "partial",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "reasoning", delta: "r" };
        yield { type: "text", delta: "t" };
        throw new Error("model died");
      },
    };
    const { daemon, client } = rawDaemon(model);
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("batch not expected")),
      (r, h) => daemon.request(Method.ModelStreamChunked, { request: r }, h) as never,
    );
    const seen: StreamEvent[] = [];
    let error: unknown;
    try {
      for await (const e of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        seen.push(e);
      }
    } catch (e) {
      error = e;
    }
    expect(seen).toEqual([
      { type: "reasoning", delta: "r" },
      { type: "text", delta: "t" },
    ]);
    expect(error).toBeInstanceOf(Error);
    daemon.close();
    client.close();
  });

  test("a disconnect mid-stream makes the daemon's stream() throw instead of hanging", async () => {
    const model = new RecordingGatedProvider([{ type: "text", delta: "a" }, { type: "done" }]);
    const { daemon, daemonCh, client } = rawDaemon(model);
    const provider = new ProxyModelProvider(
      () => Promise.reject(new Error("batch not expected")),
      (r, h) => daemon.request(Method.ModelStreamChunked, { request: r }, h) as never,
    );
    const seen: StreamEvent[] = [];
    const run = (async () => {
      for await (const e of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        seen.push(e);
        daemonCh.close(); // drop the tunnel after the first event
      }
    })();
    await expect(run).rejects.toThrow("connection closed");
    expect(seen).toEqual([{ type: "text", delta: "a" }]);
    client.close();
  });
});

describe("RemoteSession over an in-memory channel", () => {
  test("streams the reply back as AgentEvents the TUI understands", async () => {
    const model = new ScriptedProvider([
      [
        { type: "text", delta: "Hello " },
        { type: "text", delta: "world" },
        { type: "done", usage: { promptTokens: 9, completionTokens: 2 } },
      ],
    ]);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, noopEnv));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    const events = await collect(client.newSession().send("hi"));
    const text = events
      .filter((e): e is Extract<SessionEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello world");
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    client.close();
  });

  test("compact round-trips and shrinks the remote conversation", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "hello" }, { type: "done" }],
      [{ type: "text", delta: "a brief" }, { type: "done" }], // the summary turn
    ]);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, noopEnv));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    const session = client.newSession();
    await collect(session.send("hi")); // opens the session, history = [user, assistant]
    const result = await session.compact();
    expect(result.before).toBe(2);
    expect(result.after).toBe(1); // no system prompt in the test agent → just the summary
    client.close();
  });

  test("a tool permission prompt round-trips to the client's broker", async () => {
    const execCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(command) {
        execCalls.push(command);
        return { stdout: "done", stderr: "", exitCode: 0 };
      },
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, env));

    const prompts: string[] = [];
    const approve: PermissionRequester = async (req) => {
      prompts.push(req.title);
      return { allowed: true, scope: "once" };
    };
    const broker = new PermissionBroker(approve);
    const client = new RemoteClient(clientCh, broker);
    await client.initialize();

    const events = await collect(client.newSession().send("run it"));
    expect(execCalls).toEqual(["ls"]);
    expect(prompts).toHaveLength(1); // the client was asked to approve
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    client.close();
  });

  test("the prompt is the request the daemon's gate built, and 'allow always' is remembered daemon-side", async () => {
    // Before: the client rebuilt `tool: ""` with no suggestion, so the TUI
    // labelled a prefix-scoped "always" as "this session".
    const execCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(command) {
        execCalls.push(command);
        return { stdout: "done", stderr: "", exitCode: 0 };
      },
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const call = (id: string, command: string): StreamEvent => ({
      type: "tool_call",
      toolCall: { id, name: "shell", arguments: JSON.stringify({ command }) },
    });
    const model = new ScriptedProvider([
      [call("c1", "git status"), { type: "done" }],
      [call("c2", "git status -s"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, env));
    const seen: PermissionRequest[] = [];
    const broker = new PermissionBroker(async (req) => {
      seen.push(req);
      return { allowed: true, scope: "session" };
    });
    const client = new RemoteClient(clientCh, broker);
    await client.initialize();
    await collect(client.newSession().send("go"));
    expect(seen).toEqual([
      {
        tool: "shell",
        level: "ask",
        title: "Run a shell command",
        detail: "git status",
        input: {},
        suggestion: { prefix: "git status" },
      },
    ]);
    expect(execCalls).toEqual(["git status", "git status -s"]);
    client.close();
  });
});

describe("permission events at the client (router + broker over a fake daemon)", () => {
  const OPTIONS = [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ];
  /** A raw daemon (it could be a hostile pod): it streams whatever the test says. */
  async function rig(broker: PermissionBroker) {
    const [daemonCh, clientCh] = createChannelPair();
    const resolves: unknown[] = [];
    let seq = 0;
    const daemon = new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.ResolvePermission) {
          resolves.push(params);
          return {};
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const errors: Error[] = [];
    const client = new RemoteClient(clientCh, broker, undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    // A client routes only the sessions it opened (the stream is in seq order per session).
    await client.openSession(undefined, undefined, "s1");
    const send = (update: Record<string, unknown>) =>
      daemon.notify(Notification.SessionUpdate, {
        sessionId: "s1",
        seq: ++seq,
        mandatory: true,
        update,
      });
    const request = (requestId: string) =>
      send({
        type: "permission_request",
        requestId,
        toolCallId: "c1",
        tool: "shell",
        title: "Run a shell command",
        explanation: `cmd-${requestId}`,
        options: OPTIONS,
      });
    const resolved = (requestId: string, optionId = "allow_always") =>
      send({
        type: "permission_resolved",
        requestId,
        outcome: { outcome: "selected", optionId },
      });
    return { client, resolves, errors, send, request, resolved };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

  test("display-only (pod-trust): a permission_resolved never answers and never pre-approves a later request", async () => {
    // Mutation: let the router cache an `allow_always` outcome and answer the
    // next request itself → `asked` stays 1 and a resolve is sent → red.
    const asked: string[] = [];
    const signals: AbortSignal[] = [];
    const broker = new PermissionBroker((req, options) => {
      asked.push(req.detail ?? "");
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => {}); // the user has not answered yet
    });
    const r = await rig(broker);
    r.request("r1");
    await settle();
    expect(asked).toEqual(["cmd-r1"]);
    r.resolved("r1"); // "someone approved it — always"
    r.resolved("unknown");
    await settle();
    expect(signals[0]?.aborted).toBe(true); // the dialog was withdrawn
    expect(r.resolves).toEqual([]);
    r.request("r2");
    await settle();
    expect(asked).toEqual(["cmd-r1", "cmd-r2"]);
    expect(r.resolves).toEqual([]);
    r.client.close();
  });

  test("an answer is sent once, as session/resolve_permission; a dismissed prompt sends nothing", async () => {
    const answers = [
      { allowed: true, scope: "once" },
      { allowed: false, dismissed: true },
    ] as const;
    let i = 0;
    const r = await rig(new PermissionBroker(async () => answers[i++] ?? { allowed: false }));
    r.request("r1");
    await settle();
    r.request("r2");
    await settle();
    expect(r.resolves).toEqual([{ sessionId: "s1", requestId: "r1", optionId: "allow_once" }]);
    r.client.close();
  });

  test("holdUntilSet: a request that arrives before the TUI's prompt is mounted waits for it — never auto-approved", async () => {
    // Mutation: build the broker without `holdUntilSet` (default allowAll) →
    // an `allow_once` is sent before any prompt exists → red.
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    const r = await rig(broker);
    r.request("r1");
    await settle();
    expect(r.resolves).toEqual([]);
    const asked: string[] = [];
    broker.setRequester(async (req) => {
      asked.push(req.detail ?? "");
      return { allowed: false };
    });
    await settle();
    expect(asked).toEqual(["cmd-r1"]);
    expect(r.resolves).toEqual([{ sessionId: "s1", requestId: "r1", optionId: "reject_once" }]);
    r.client.close();
  });

  test("a losing answer (PermissionNotPending) is silent; session_closed withdraws the dialog", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    const daemon = new RpcPeer(daemonCh, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        throw new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending");
      },
    });
    const errors: Error[] = [];
    const signals: AbortSignal[] = [];
    let answer: (r: { allowed: boolean }) => void = () => {};
    const broker = new PermissionBroker((_req, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const client = new RemoteClient(clientCh, broker, undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const frame = (seq: number, update: Record<string, unknown>) =>
      daemon.notify(Notification.SessionUpdate, { sessionId: "s1", seq, mandatory: true, update });
    const request = (seq: number, requestId: string) =>
      frame(seq, {
        type: "permission_request",
        requestId,
        toolCallId: "c1",
        tool: "shell",
        title: "t",
        options: OPTIONS,
      });
    request(1, "r1");
    await settle();
    answer({ allowed: false });
    await settle();
    expect(errors).toEqual([]);
    request(2, "r2");
    await settle();
    frame(3, { type: "session_closed", reason: "closed" });
    await settle();
    expect(signals[1]?.aborted).toBe(true);
    client.close();
  });
});

describe("RemoteSession.enqueue (steering over RPC)", () => {
  // Round 1 calls a tool (slow exec = a mid-turn window); round 2 answers.
  const steerModel = (script: readonly (readonly StreamEvent[])[]) => new ScriptedProvider(script);

  test("enqueue mid-turn resolves and the steer echo flows back as a `steer` event", async () => {
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    // A slow exec so the turn is in flight when we enqueue.
    const env: ExecutionEnvironment = {
      id: "slow",
      async exec() {
        await new Promise((r) => setTimeout(r, 150));
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, env));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    const session = client.newSession();
    const sendP = (async () => {
      const events: SessionEvent[] = [];
      for await (const e of session.send("go")) {
        events.push(e);
        if (e.type === "tool_start") {
          await session.enqueue("steer me"); // mid-turn, while the tool runs
        }
      }
      return events;
    })();
    const events = await sendP;

    // The injected message came back as a `steer` event the TUI understands.
    const steers = events.filter(
      (e): e is Extract<SessionEvent, { type: "steer" }> => e.type === "steer",
    );
    expect(steers.map((s) => s.text)).toEqual(["steer me"]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    client.close();
  });

  test("enqueue REJECTS (not swallowed) when the daemon doesn't support it", async () => {
    // An older daemon: it answers the core session methods but not
    // `session/enqueue` (a real MethodNotFound would come from its peer).
    const [daemonCh, clientCh] = createChannelPair();
    let turnId = "";
    const daemon: RpcPeer = new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: 1,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        if (method === Method.Prompt) {
          turnId = (params as { turnId: string }).turnId;
          return { turnId }; // the turn stays open until the enqueue was tried
        }
        // Anything else — notably session/enqueue — is unknown to this daemon;
        // the turn then ends.
        setTimeout(() =>
          daemon.notify(Notification.SessionUpdate, {
            sessionId: "s1",
            seq: 1,
            mandatory: true,
            update: { type: "turn_end", turnId, stopReason: "end_turn" },
          }),
        );
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unknown method: ${method}`);
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    const session = client.newSession();
    const sendP = (async () => {
      const events: SessionEvent[] = [];
      for await (const e of session.send("hi")) {
        events.push(e);
      }
      return events;
    })();
    // The session id is now set (send opened it). The enqueue must REJECT with
    // the daemon's MethodNotFound (not be swallowed) — that is what lets the
    // TUI reconcile its optimistic entry.
    await new Promise((r) => setTimeout(r, 10));
    await expect(session.enqueue("nope")).rejects.toMatchObject({
      code: JsonRpcErrorCode.MethodNotFound,
    });
    const events = await sendP;
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    client.close();
  });

  test("enqueue while the first send is still opening the session is delivered", async () => {
    // Round 1 is slow, so the turn is still running when the enqueue lands; the
    // late-steer drain then injects it and round 2 runs.
    const seen: string[] = [];
    const model: ModelProvider = {
      id: "slow",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        seen.push(...request.messages.map((m) => m.content));
        await new Promise((r) => setTimeout(r, 100));
        yield { type: "text", delta: "ok" };
        yield { type: "done" };
      },
    };
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, noopEnv));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    const session = client.newSession();
    const iter = session.send("go")[Symbol.asyncIterator]();
    const first = iter.next(); // starts `session/open`; the id is not known yet
    // The TUI is already "running" here: this enqueue must wait for the session
    // instead of resolving as a silent no-op.
    await session.enqueue("early");
    const events: SessionEvent[] = [];
    for (let r = await first; !r.done; r = await iter.next()) {
      events.push(r.value);
    }
    expect(events.filter((e) => e.type === "steer")).toEqual([{ type: "steer", text: "early" }]);
    expect(seen).toContain("early");
    client.close();
  });

  test("enqueue before the first send is a no-op (resolves, touches nothing)", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]);
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(model, noopEnv));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    const session = client.newSession();
    // No session opened yet → enqueue must not touch the peer (no id).
    await expect(session.enqueue("early")).resolves.toBeUndefined();
    client.close();
  });
});

describe("unknown / malformed session/update frames (event classes)", () => {
  /** A raw fake daemon that streams `frames` during the prompt; the turn ends only if `end`. */
  function fakeDaemon(frames: readonly unknown[], end: boolean) {
    const [daemonCh, clientCh] = createChannelPair();
    const cancels: unknown[] = [];
    const daemon: RpcPeer = new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open)
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        if (method === Method.Prompt) {
          // Ack at once; the turn ends in the stream (only if `end`).
          const { turnId } = params as { turnId: string };
          for (const frame of frames) daemon.notify(Notification.SessionUpdate, frame);
          if (end) {
            daemon.notify(Notification.SessionUpdate, {
              sessionId: "s1",
              // The next seq: contiguity is checked (a jump would force a resync).
              seq: frames.length + 1,
              mandatory: true,
              update: { type: "turn_end", turnId, stopReason: "end_turn" },
            });
          }
          return { turnId };
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
      onNotification: (method, params) => {
        if (method === Notification.Cancel) cancels.push(params);
      },
    });
    return { clientCh, cancels };
  }

  async function run(frames: readonly unknown[], end: boolean) {
    const { clientCh, cancels } = fakeDaemon(frames, end);
    const errors: Error[] = [];
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    const events: SessionEvent[] = [];
    const outcome = await Promise.race([
      (async () => {
        for await (const e of client.newSession().send("hi")) events.push(e);
        return "ended";
      })().catch((e: unknown) => e as Error),
      new Promise<string>((r) => setTimeout(() => r("hung"), 500)),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    client.close();
    return { outcome, events, errors, cancels };
  }

  const chunk = (seq: number, text: string) => ({
    sessionId: "s1",
    seq,
    update: { type: "agent_message_chunk", content: { type: "text", text } },
  });

  test("session_closed while a turn is open fails it (UnknownSession), never hangs", async () => {
    // Mutation: drop RemoteSession's `session_closed` branch → "hung".
    const r = await run(
      [
        chunk(1, "a"),
        {
          sessionId: "s1",
          seq: 2,
          mandatory: true,
          update: { type: "session_closed", reason: "closed" },
        },
      ],
      false,
    );
    expect(r.outcome).toMatchObject({ code: DomainErrorCode.UnknownSession });
  });

  test("an unknown display event does not break the turn: one 'unsupported' event per kind", async () => {
    const r = await run(
      [
        chunk(1, "a"),
        { sessionId: "s1", seq: 2, update: { type: "progress", pct: 3 } },
        chunk(3, "b"),
        { sessionId: "s1", seq: 4, update: { type: "progress", pct: 4 } },
      ],
      true,
    );
    expect(r.outcome).toBe("ended");
    expect(r.events).toEqual([
      { type: "text", delta: "a" },
      { type: "unsupported", kind: "progress" },
      { type: "text", delta: "b" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(r.errors).toEqual([]);
  });

  test("an unknown kind that arrives while idle is shown at the next turn (once)", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    let seq = 0;
    const frame = (update: unknown, mandatory?: true) =>
      daemon.notify(Notification.SessionUpdate, {
        sessionId: "s1",
        seq: ++seq,
        ...(mandatory ? { mandatory } : {}),
        update,
      });
    const daemon: RpcPeer = new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open)
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        if (method === Method.Prompt) {
          const { turnId } = params as { turnId: string };
          frame({ type: "turn_end", turnId, stopReason: "end_turn" }, true);
          return { turnId };
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    await collect(session.send("one"));
    frame({ type: "future_status", x: 1 }); // idle: no turn running
    frame({ type: "future_status", x: 2 });
    await new Promise((r) => setTimeout(r, 10));
    const second = await collect(session.send("two"));
    expect(second.filter((e) => e.type === "unsupported")).toEqual([
      { type: "unsupported", kind: "future_status" },
    ]);
    expect(second.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    client.close();
    daemon.close();
  });

  test("a known update with an unknown field is applied (the field is stripped)", async () => {
    const r = await run(
      [
        {
          sessionId: "s1",
          seq: 1,
          future: true,
          update: { type: "agent_message_chunk", content: { type: "text", text: "a" }, future: 1 },
        },
      ],
      true,
    );
    expect(r.outcome).toBe("ended");
    expect(r.events[0]).toEqual({ type: "text", delta: "a" });
    expect(r.errors).toEqual([]);
  });

  test("an unknown mandatory event fails the turn loudly and cancels it daemon-side", async () => {
    const r = await run(
      [{ sessionId: "s1", seq: 1, mandatory: true, update: { type: "future_mandatory" } }],
      false,
    );
    expect(r.outcome).toBeInstanceOf(Error);
    expect(String((r.outcome as Error).message)).toMatch(/newer than this client/);
    expect(r.errors.map((e) => e.message)).toEqual([(r.outcome as Error).message]);
    expect(r.cancels).toEqual([{ sessionId: "s1" }]);
  });

  test("a malformed background_exit mid-turn fails that turn too (loud, documented)", async () => {
    const r = await run(
      [{ sessionId: "s1", seq: 1, update: { type: "background_exit", jobId: "j" } }],
      false,
    );
    expect(r.outcome).toBeInstanceOf(Error);
    expect(String((r.outcome as Error).message)).toMatch(/malformed background_exit/);
    expect(r.cancels).toEqual([{ sessionId: "s1" }]);
  });

  test("with no turn in flight a stream error reaches onError only (never silent, nothing cancelled)", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    const daemon = new RpcPeer(daemonCh, {
      onRequest: async (method) =>
        method === Method.Open
          ? { sessionId: "s1", epoch: "e", created: true, resync: false }
          : {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
              skills: [],
            },
    });
    const errors: Error[] = [];
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    await client.openSession(undefined, undefined, "s1"); // opened, idle: no turn in flight
    daemon.notify(Notification.SessionUpdate, {
      sessionId: "s1",
      seq: 1,
      mandatory: true,
      update: { type: "future_mandatory" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/future_mandatory.*newer than this client/),
    ]);
    client.close();
  });

  test("a malformed known event fails the turn loudly", async () => {
    const r = await run(
      [{ sessionId: "s1", seq: 1, update: { type: "agent_message_chunk" } }],
      false,
    );
    expect(r.outcome).toBeInstanceOf(Error);
    expect(String((r.outcome as Error).message)).toMatch(/malformed agent_message_chunk/);
    expect(r.cancels).toEqual([{ sessionId: "s1" }]);
  });
});

describe("real WebSocket smoke test", () => {
  test("connect over a loopback Bun.serve socket and stream a reply", async () => {
    const { startWsServer } = await import("@tentacle/daemon");
    const model = new ScriptedProvider([
      [{ type: "text", delta: "socket says hi" }, { type: "done" }],
    ]);
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: makeHost(model, noopEnv),
    });
    try {
      const channel: WebSocketChannel = await connectWebSocket(server.url);
      const client = new RemoteClient(channel, new PermissionBroker());
      await client.initialize();
      const events = await collect(client.newSession().send("hi"));
      const text = events
        .filter((e): e is Extract<SessionEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.delta)
        .join("");
      expect(text).toBe("socket says hi");
      client.close();
    } finally {
      server.stop();
    }
  });
});

describe("RemoteSession ends turns from the stream (turn_start/turn_end)", () => {
  /** A raw daemon: acks `prompt` with `ack(turnId)`, then runs `after(turnId)` (its stream). */
  function scriptedDaemon(
    ack: (turnId: string) => unknown,
    after: (turnId: string, notify: (update: unknown, mandatory?: boolean) => void) => void,
  ) {
    const [daemonCh, clientCh] = createChannelPair();
    const cancels: unknown[] = [];
    let seq = 0;
    const daemon: RpcPeer = new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open)
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        if (method === Method.Prompt) {
          const { turnId } = params as { turnId: string };
          setTimeout(() =>
            after(turnId, (update, mandatory) =>
              daemon.notify(Notification.SessionUpdate, {
                sessionId: "s1",
                seq: ++seq,
                ...(mandatory ? { mandatory: true } : {}),
                update,
              }),
            ),
          );
          return ack(turnId);
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
      onNotification: (method, params) => {
        if (method === Notification.Cancel) cancels.push(params);
      },
    });
    return { daemon, clientCh, cancels };
  }

  async function drive(clientCh: ReturnType<typeof createChannelPair>[1], timeoutMs = 500) {
    const errors: Error[] = [];
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    const events: SessionEvent[] = [];
    const outcome = await Promise.race([
      (async () => {
        for await (const e of client.newSession().send("hi")) events.push(e);
        return "ended";
      })().catch((e: unknown) => e as Error),
      new Promise<string>((r) => setTimeout(() => r("hung"), timeoutMs)),
    ]);
    return { client, outcome, events, errors };
  }

  const end = (turnId: string, stopReason = "end_turn", error?: unknown) => ({
    type: "turn_end",
    turnId,
    stopReason,
    ...(error ? { error } : {}),
  });
  const chunk = (text: string) => ({
    type: "agent_message_chunk",
    content: { type: "text", text },
  });

  test("the turn ends on ITS turn_end; another turn's bracket is ignored", async () => {
    const { clientCh } = scriptedDaemon(
      (turnId) => ({ turnId }),
      (turnId, notify) => {
        notify({ type: "turn_start", turnId, prompt: "hi" }, true);
        notify(chunk("a"));
        notify(end("someone-else"), true); // not ours: must not end the turn
        notify(chunk("b"));
        notify(end(turnId), true);
      },
    );
    const r = await drive(clientCh);
    expect(r.outcome).toBe("ended");
    expect(r.events).toEqual([
      { type: "text", delta: "a" },
      { type: "text", delta: "b" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    r.client.close();
  });

  test("turn_end{error} fails the turn with an RpcError carrying the streamed code/message", async () => {
    const { clientCh } = scriptedDaemon(
      (turnId) => ({ turnId }),
      (turnId, notify) => notify(end(turnId, "error", { code: -32004, message: "boom" }), true),
    );
    const r = await drive(clientCh);
    expect(r.outcome).toBeInstanceOf(RpcError);
    expect(r.outcome).toMatchObject({ code: -32004, message: "boom" });
    // Without a code: the generic internal error code.
    const plain = scriptedDaemon(
      (turnId) => ({ turnId }),
      (turnId, notify) => notify(end(turnId, "error", { message: "internal error" }), true),
    );
    const r2 = await drive(plain.clientCh);
    expect(r2.outcome).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: "internal error",
    });
    r.client.close();
    r2.client.close();
  });

  test("an ack carrying `ended` ends the turn with no stream (a retried, finished turn)", async () => {
    const { clientCh } = scriptedDaemon(
      (turnId) => ({ turnId, ended: { stopReason: "cancelled" } }),
      () => {},
    );
    const r = await drive(clientCh);
    expect(r.outcome).toBe("ended");
    expect(r.events).toEqual([{ type: "turn_end", reason: "cancelled" }]);
    r.client.close();
  });

  test("the socket closing after the ack fails the turn with `connection closed` (no hang)", async () => {
    const { daemon, clientCh } = scriptedDaemon(
      (turnId) => ({ turnId }),
      (turnId, notify) => {
        notify({ type: "turn_start", turnId, prompt: "hi" }, true);
        setTimeout(() => daemon.close(), 5);
      },
    );
    const r = await drive(clientCh);
    expect(r.outcome).toBeInstanceOf(RpcError);
    expect((r.outcome as Error).message).toBe("connection closed");
  });

  test("an envelope-invalid turn_end (no seq) fails the turn loudly and cancels it daemon-side", async () => {
    const { daemon, clientCh, cancels } = scriptedDaemon(
      (turnId) => ({ turnId }),
      (turnId) =>
        daemon.notify(Notification.SessionUpdate, {
          sessionId: "s1",
          mandatory: true,
          update: end(turnId),
        }),
    );
    const r = await drive(clientCh);
    expect(r.outcome).toBeInstanceOf(Error);
    expect((r.outcome as Error).message).toBe("malformed session/update frame from the daemon");
    expect(r.errors.map((e) => e.message)).toEqual([
      "invalid params for notification session/update",
    ]);
    await new Promise((res) => setTimeout(res, 5));
    expect(cancels).toEqual([{ sessionId: "s1" }]);
    r.client.close();
  });

  test("an envelope-invalid frame with no readable sessionId reaches onError only (no throw)", async () => {
    const { daemon, clientCh } = scriptedDaemon(
      (turnId) => ({ turnId }),
      (turnId, notify) => {
        daemon.notify(Notification.SessionUpdate, { sessionId: 42, seq: 1, update: chunk("x") });
        daemon.notify(Notification.SessionUpdate, null);
        notify(end(turnId), true);
      },
    );
    const r = await drive(clientCh);
    expect(r.outcome).toBe("ended");
    expect(r.errors.map((e) => e.message)).toEqual([
      "invalid params for notification session/update",
      "invalid params for notification session/update",
    ]);
    r.client.close();
  });

  for (const [label, ended] of [
    ["a plain ack", false],
    ["an ack carrying `ended`", true],
  ] as const) {
    test(`a turn_end that arrives BEFORE the ack ends the turn once; the late ack is a no-op (${label})`, async () => {
      // No contract orders the ack against the turn's stream (the handler's
      // result is sent a few microtasks after it returns, while the turn runs
      // concurrently). Measured on the in-memory pair the ack comes first, so pin
      // the other order deterministically: the stream is sent before returning.
      const [daemonCh, clientCh] = createChannelPair();
      const daemon: RpcPeer = new RpcPeer(daemonCh, {
        onRequest: async (method, params) => {
          if (method === Method.Initialize) {
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
              skills: [],
            };
          }
          if (method === Method.Open)
            return { sessionId: "s1", epoch: "e", created: true, resync: false };
          const { turnId } = params as { turnId: string };
          const frame = (seq: number, update: unknown, mandatory = false) =>
            daemon.notify(Notification.SessionUpdate, {
              sessionId: "s1",
              seq,
              ...(mandatory ? { mandatory: true } : {}),
              update,
            });
          frame(1, { type: "turn_start", turnId, prompt: "hi" }, true);
          frame(2, chunk("hi"));
          frame(3, end(turnId), true);
          // The ack, after the whole turn (with `ended`, as a retry would get it:
          // the turn must still end exactly once).
          return ended ? { turnId, ended: { stopReason: "end_turn" } } : { turnId };
        },
      });
      const r = await drive(clientCh);
      expect(r.outcome).toBe("ended");
      expect(r.events).toEqual([
        { type: "text", delta: "hi" },
        { type: "turn_end", reason: "end_turn" },
      ]);
      r.client.close();
    });
  }

  test("a real daemon's failing turn reaches the client as a thrown error (redacted remotely)", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    const failing: ModelProvider = {
      id: "boom",
      // biome-ignore lint/correctness/useYield: throws before its first event
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("provider said sk-SECRET");
      },
    };
    new Connection(daemonCh, makeHost(failing, noopEnv));
    const r = await drive(clientCh);
    expect(r.outcome).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: "internal error",
    });
    r.client.close();
  });
});

describe("RemoteSession steering bound to its turn (review fixes)", () => {
  // Round 1 calls a tool on a slow env (a mid-turn window); later rounds echo.
  const echoModel = (seen: string[][]): ModelProvider => ({
    id: "echo",
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      const messages = request.messages.map((m) => m.content);
      seen.push(messages);
      if (messages.at(-1) === "go") {
        yield {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
        };
      } else {
        yield { type: "text", delta: `echo:${messages.at(-1) ?? ""}` };
      }
      yield { type: "done" };
    },
  });
  const slowEnv: ExecutionEnvironment = {
    id: "slow",
    async exec() {
      await new Promise((r) => setTimeout(r, 100));
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };

  test("two steers in one turn are two distinct enqueues: both reach the model", async () => {
    const seen: string[][] = [];
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(echoModel(seen), slowEnv));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const events: SessionEvent[] = [];
    for await (const e of session.send("go")) {
      events.push(e);
      if (e.type === "tool_start") {
        await session.enqueue("A");
        await session.enqueue("B");
      }
    }
    // A shared key would make "B" a retry of "A": silently dropped.
    expect(events.filter((e) => e.type === "steer")).toEqual([
      { type: "steer", text: "A" },
      { type: "steer", text: "B" },
    ]);
    expect(seen[1]?.slice(-2)).toEqual(["A", "B"]);
    client.close();
  });

  test("a steer typed after the turn ended REJECTS NoTurnRunning (never a silent no-op)", async () => {
    const seen: string[][] = [];
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(echoModel(seen), slowEnv));
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    for await (const _ of session.send("go")) {
      // drain the turn
    }
    // The TUI can still show the turn running here (post-turn snapshot in
    // flight): the text must not vanish — the rejection lets it say "not queued".
    await expect(session.enqueue("late")).rejects.toMatchObject({
      code: DomainErrorCode.NoTurnRunning,
    });
    expect(seen.flat()).not.toContain("late");
    client.close();
  });

  test("a prompt the daemon refuses fails the turn (it does not wait for a turn_end)", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onRequest: async (method) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open)
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    const outcome = await Promise.race([
      (async () => {
        for await (const _ of client.newSession().send("hi")) {
          // no events expected
        }
        return "ended";
      })().catch((e: unknown) => e),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(outcome).toMatchObject({ code: DomainErrorCode.TurnInProgress });
    client.close();
  });
});

describe("RemoteClient.snapshot (paged history at the cut)", () => {
  test("joins the pages chronologically over a real Connection", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, makeHost(new ScriptedProvider([]), noopEnv));
    const seen: unknown[] = [];
    // Count the snapshot requests on the wire: a long history takes several pages.
    const send = clientCh.send.bind(clientCh);
    clientCh.send = (frame: string) => {
      const msg = JSON.parse(frame) as { method?: string; params?: unknown };
      if (msg.method === Method.Snapshot) seen.push(msg.params);
      send(frame);
    };
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    const seed = Array.from({ length: 450 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));
    const id = await client.openSession(undefined, seed);
    expect(await client.snapshot(id)).toEqual(seed);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ sessionId: id, limit: 200 });
    client.close();
  });

  /** A fake daemon answering `session/snapshot` from a script of handlers. */
  function pagedDaemon(answer: (params: { cursor?: string }, n: number) => unknown) {
    const [daemonCh, clientCh] = createChannelPair();
    let n = 0;
    new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        return answer(params as { cursor?: string }, ++n);
      },
    });
    return new RemoteClient(clientCh, new PermissionBroker());
  }
  const msg = (content: string) => ({ role: "user" as const, content });
  const since = { epoch: "e", seq: 1 };

  test("a compaction between two pages (StaleCursor) restarts from the newest page", async () => {
    const client = pagedDaemon((params, n) => {
      if (n === 1) return { messages: [msg("old-b")], since, cursor: "e/1" };
      if (n === 2) throw new RpcError(DomainErrorCode.StaleCursor, "stale");
      if (params.cursor === undefined)
        return { messages: [msg("summary")], since: { epoch: "f", seq: 9 } };
      throw new Error("unexpected");
    });
    await client.initialize();
    expect(await client.snapshot("s")).toEqual([msg("summary")]);
    client.close();
  });

  test("a daemon whose cursor makes no progress fails loudly instead of paging forever", async () => {
    let calls = 0;
    const repeating = pagedDaemon(() => {
      calls++;
      return { messages: [msg("x")], since, cursor: "e/1" };
    });
    await repeating.initialize();
    await expect(repeating.snapshot("s")).rejects.toThrow(/no progress/);
    expect(calls).toBe(2);
    repeating.close();

    const empty = pagedDaemon(() => ({ messages: [], since, cursor: "e/1" }));
    await empty.initialize();
    await expect(empty.snapshot("s")).rejects.toThrow(/no progress/);
    empty.close();
  });

  test("gives up after 3 stale attempts; any other error is not retried", async () => {
    let calls = 0;
    const stale = pagedDaemon((params) => {
      calls++;
      if (params.cursor === undefined) return { messages: [msg("x")], since, cursor: "e/1" };
      throw new RpcError(DomainErrorCode.StaleCursor, "stale");
    });
    await stale.initialize();
    await expect(stale.snapshot("s")).rejects.toMatchObject({ code: DomainErrorCode.StaleCursor });
    expect(calls).toBe(6);
    stale.close();

    calls = 0;
    const broken = pagedDaemon(() => {
      calls++;
      throw new RpcError(DomainErrorCode.UnknownSession, "gone");
    });
    await broken.initialize();
    await expect(broken.snapshot("s")).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    expect(calls).toBe(1);
    broken.close();
  });
});

describe("closing sessions (sessions outlive connections)", () => {
  /** A model that streams `n` chunks, one per macrotask. */
  const slow = (n: number): ModelProvider => ({
    id: "slow",
    async *stream(): AsyncIterable<StreamEvent> {
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, 1));
        yield { type: "text", delta: `c${i} ` };
      }
      yield { type: "done" };
    },
  });
  const connected = async (host: SessionHost): Promise<RemoteClient> => {
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, host);
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    return client;
  };

  test("closeSessions() closes every session this client opened, daemon-side", async () => {
    // Mutation: `closeSessions` iterates nothing → both stay live.
    const host = makeHost(slow(1), noopEnv);
    const client = await connected(host);
    const a = await client.openSession(undefined, undefined, "A");
    const b = await client.openSession(undefined, undefined, "B");
    expect(host.get(a) && host.get(b)).toBeDefined();
    await client.closeSessions(); // acknowledged before the peer closes
    expect(host.size).toBe(0);
    client.close();
  });

  test("closeSessions() is bounded: a daemon that never answers does not block the exit", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onRequest: (method) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
            skills: [],
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        return new Promise(() => {}); // session/close: never answered
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    await client.openSession();
    const started = Date.now();
    await client.closeSessions(50);
    expect(Date.now() - started).toBeLessThan(1000);
    client.close();
  });

  test("closeSessions() on a closed peer never rejects (no unhandled rejection)", async () => {
    const host = makeHost(slow(1), noopEnv);
    const client = await connected(host);
    await client.openSession(undefined, undefined, "A");
    client.close();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await client.closeSessions(); // resolves (the request failed: moot), never rejects
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test("RemoteSession.close() closes once, also while its first send is still opening", async () => {
    // Mutation: drop the `opening.then(close)` branch → the session stays live.
    const host = makeHost(slow(30), noopEnv);
    const client = await connected(host);
    const session = client.newSession(undefined, "S");
    const iter = session.send("go")[Symbol.asyncIterator]();
    const first = iter.next(); // starts `session/open`; the id is not known yet
    const turn = (async () => {
      for (let r = await first; !r.done; r = await iter.next()) {
        // drain
      }
    })().catch((e: unknown) => e);
    session.close(); // the open is in flight: no id yet
    session.close(); // idempotent
    // The turn ends (cancelled by the close that followed the open): never hangs.
    const outcome = await Promise.race([
      turn.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    expect(outcome).toBe("settled");
    // The open did happen, and the close followed it: the daemon forgot S.
    expect(host.get("S")).toBeUndefined();
    expect(host.size).toBe(0);
    await expect(collect(session.send("again"))).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    client.close();
  });

  test("a session closed by ANOTHER client ends this client's running turn (cancelled), never hangs", async () => {
    // Mutation: drop the daemon's synchronous `turn_end` in `HostedSession.close`
    // AND the client's `session_closed` handling → the turn hangs.
    const host = makeHost(slow(200), noopEnv);
    const laptop = await connected(host);
    const phone = await connected(host);
    const session = laptop.newSession(undefined, "S");
    const turn = collect(session.send("go"));
    expect(await waitFor(() => host.get("S")?.running === true)).toBe(true);
    await phone.openSession(undefined, undefined, "S"); // attaches (live)
    await phone.closeSession("S");
    const events = (await Promise.race([
      turn,
      new Promise((r) => setTimeout(() => r("hung"), 1000)),
    ])) as SessionEvent[] | "hung";
    expect(events).not.toBe("hung");
    expect(events === "hung" ? null : events.at(-1)).toEqual({
      type: "turn_end",
      reason: "cancelled",
    });
    // The laptop's `opened` dropped S on `session_closed`: its exit must not
    // close the session the phone recreates under the same id.
    // Mutation: keep the id in `opened` → the laptop's exit kills the phone's session.
    await phone.openSession(undefined, undefined, "S");
    await laptop.closeSessions();
    expect(host.get("S")).toBeDefined();
    laptop.close();
    phone.close();
  });

  test("send after close never opens a session (refused locally)", async () => {
    // Mutation: drop the `closed` guard in `runTurn` → a fresh session is opened.
    const host = makeHost(slow(1), noopEnv);
    const client = await connected(host);
    const session = client.newSession(undefined, "S");
    session.close(); // before any send: nothing to close daemon-side
    await expect(collect(session.send("x"))).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    expect(host.size).toBe(0);
    client.close();
  });
});

describe("hooks/trust (docs/feat/hooks-project-trust.md)", () => {
  const PARAMS = {
    sessionId: "s1",
    folder: "/repo",
    hash: "h1",
    files: [".agents/hooks.json"],
    hooks: [{ event: "turn_start", command: "proj-start" }],
    canAllow: false,
  };
  type Frame = { id?: unknown; method?: string; result?: unknown; error?: { code: number } };

  /**
   * A raw daemon (it could be a hostile pod) speaking JSON-RPC frames by hand:
   * it answers `initialize` / `session/open`, and `ask` sends a raw
   * `hooks/trust` frame — never validated by a daemon-side peer — and resolves
   * with the laptop's response frame.
   */
  async function rawTrust(hooksTrust?: RemoteClientOptions["hooksTrust"]) {
    const [daemonCh, clientCh] = createChannelPair();
    const waiting = new Map<string, (f: Frame) => void>();
    const reply = (id: unknown, result: unknown) =>
      daemonCh.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    daemonCh.setOnMessage((data) => {
      const f = JSON.parse(data) as Frame;
      if (f.method === Method.Initialize) {
        reply(f.id, {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
          skills: [],
        });
      } else if (f.method === Method.Open) {
        reply(f.id, { sessionId: "s1", epoch: "e", created: true, resync: false });
      } else if (f.method === undefined && typeof f.id === "string") {
        waiting.get(f.id)?.(f);
      }
    });
    const client = new RemoteClient(
      clientCh,
      new PermissionBroker(),
      undefined,
      hooksTrust ? { hooksTrust } : {},
    );
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    let n = 0;
    const ask = (params: unknown): Promise<Frame> => {
      const id = `raw-${++n}`;
      const answered = new Promise<Frame>((r) => waiting.set(id, r));
      daemonCh.send(JSON.stringify({ jsonrpc: "2.0", id, method: Method.HooksTrust, params }));
      return answered;
    };
    return { client, ask };
  }

  test("a client with no resolver answers { trusted: false } (never MethodNotFound, never trusted)", async () => {
    const { client, ask } = await rawTrust();
    expect((await ask(PARAMS)).result).toEqual({ trusted: false });
    client.close();
  });

  test("with a resolver: its answer, given the params and a signal the link drop aborts", async () => {
    const seen: unknown[] = [];
    let signal: AbortSignal | undefined;
    const { client, ask } = await rawTrust((p, s) => {
      seen.push(p);
      signal = s;
      return new Promise(() => {}); // the human never answers
    });
    void ask(PARAMS);
    expect(await waitFor(() => seen.length === 1)).toBe(true);
    expect(seen[0]).toEqual(PARAMS);
    expect(signal?.aborted).toBe(false);
    client.close(); // the laptop goes away while asked
    expect(signal?.aborted).toBe(true);
  });

  test("a pod's unknown fields are stripped: the resolver never sees them", async () => {
    const seen: unknown[] = [];
    const { client, ask } = await rawTrust(async (p) => {
      seen.push(p);
      return { trusted: false };
    });
    const response = await ask({
      ...PARAMS,
      future: "x",
      hooks: [{ ...PARAMS.hooks[0], future: "y" }],
    });
    expect(response.result).toEqual({ trusted: false });
    expect(seen).toEqual([PARAMS]);
    client.close();
  });

  test("a session this client never opened → { trusted: false }, nobody is asked", async () => {
    let calls = 0;
    const { client, ask } = await rawTrust(async () => {
      calls++;
      return { trusted: true };
    });
    expect((await ask({ ...PARAMS, sessionId: "other" })).result).toEqual({ trusted: false });
    expect(calls).toBe(0);
    client.close();
  });

  test("at most one trust prompt in flight per session: a second one → { trusted: false }", async () => {
    let calls = 0;
    let answer: (r: { trusted: boolean }) => void = () => {};
    const { client, ask } = await rawTrust(() => {
      calls++;
      return new Promise((r) => {
        answer = r;
      });
    });
    const first = ask(PARAMS);
    expect(await waitFor(() => calls === 1)).toBe(true);
    expect((await ask(PARAMS)).result).toEqual({ trusted: false });
    expect(calls).toBe(1);
    answer({ trusted: true });
    expect((await first).result).toEqual({ trusted: true });
    client.close();
  });

  for (const [label, folder] of [
    ["an ANSI escape", "/repo\u001b[2J"],
    ["a bidi override (U+202E)", "/repo‮hs.lave"],
  ] as const) {
    test(`a hostile daemon's ${label} never reaches the resolver (InvalidParams)`, async () => {
      let called = false;
      const { client, ask } = await rawTrust(async () => {
        called = true;
        return { trusted: true };
      });
      const response = await ask({ ...PARAMS, folder });
      expect(response.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(called).toBe(false);
      client.close();
    });
  }

  /** A daemon whose session has a project `turn_start` hook; records the hooks it ran. */
  function projectDaemon() {
    const [daemonCh, clientCh] = createChannelPair();
    const ran: string[] = [];
    const env: ExecutionEnvironment = {
      ...noopEnv,
      exec: (command) => {
        ran.push(command);
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    };
    const logs: string[] = [];
    const host = new SessionHost({
      defaultCwd: "/w",
      createAgent: () => {
        const hooks = new HookRunner({
          specs: [],
          env,
          cwd: "/w",
          log: (l) => logs.push(l),
          project: {
            specs: [{ event: "turn_start", command: "proj-start" }],
            folder: "/repo",
            hash: "h1",
            files: [".agents/hooks.json"],
            canAllow: true,
          },
        });
        const agent = new Agent({
          model: new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]),
          tools: new ToolRegistry(),
          env,
          hooks,
        });
        return { agent, permissions: new PermissionBroker() };
      },
    });
    const connection = new Connection(daemonCh, host);
    return { connection, clientCh, ran, logs };
  }

  test("an old laptop (no hooks/trust handler: real MethodNotFound) → the turn runs without the project hooks", async () => {
    const { connection, clientCh, ran, logs } = projectDaemon();
    const updates: { type?: string }[] = [];
    // A laptop that predates `hooks/trust`: its handler knows no such method.
    const laptop = new RpcPeer(clientCh, {
      onRequest: async (method) => {
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unexpected request: ${method}`);
      },
      onNotification: (_method, params) => {
        updates.push((params as { update: { type?: string } }).update);
      },
    });
    await laptop.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await laptop.request(Method.Open, { sessionId: "s1", create: true });
    await laptop.request(Method.Prompt, {
      sessionId: "s1",
      turnId: "t1",
      content: [{ type: "text", text: "hi" }],
    });
    expect(await waitFor(() => updates.some((u) => u.type === "turn_end"))).toBe(true);
    expect(ran).toEqual([]);
    expect(logs.some((l) => l.includes("unexpected request: hooks/trust"))).toBe(true);
    connection.close();
    laptop.close();
  });

  test("the laptop answers { trusted: false } → the project hook never runs", async () => {
    const { connection, clientCh, ran } = projectDaemon();
    let asked = 0;
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      hooksTrust: async () => {
        asked++;
        return { trusted: false };
      },
    });
    await client.initialize();
    await collect(client.newSession().send("hi"));
    expect(asked).toBe(1);
    expect(ran).toEqual([]);
    connection.close();
    client.close();
  });

  test("the prompting laptop trusts → the project hook runs, asked once per session", async () => {
    const { connection, clientCh, ran } = projectDaemon();
    let asked = 0;
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      hooksTrust: async () => {
        asked++;
        return { trusted: true };
      },
    });
    await client.initialize();
    const session = client.newSession();
    await collect(session.send("one"));
    await collect(session.send("two"));
    expect(asked).toBe(1);
    expect(ran).toEqual(["proj-start", "proj-start"]);
    connection.close();
    client.close();
  });
});

describe("blocking updates are gated by the initialize list (docs/feat/protocol-v10-forward-compat.md)", () => {
  const callShell: StreamEvent[] = [
    { type: "tool_call", toolCall: { id: "c1", name: "shell", arguments: '{"command":"ls"}' } },
    { type: "done" },
  ];
  const reply: StreamEvent[] = [{ type: "text", delta: "ok" }, { type: "done" }];

  /** A raw laptop declaring `updates` at initialize; records every update it receives. */
  async function laptop(updates: readonly string[] | undefined) {
    const [daemonCh, clientCh] = createChannelPair();
    const host = makeHost(new ScriptedProvider([callShell, reply]), noopEnv);
    const connection = new Connection(daemonCh, host);
    const frames: { type: string; [k: string]: unknown }[] = [];
    const peer = new RpcPeer(clientCh, {
      onNotification: (_m, params) => {
        frames.push((params as { update: { type: string } }).update);
      },
    });
    // Every request carries an unknown field (a newer laptop's): the daemon
    // strips it on inbound parse — the session runs as if it were absent.
    await peer.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true, future: 1, ...(updates ? { updates } : {}) },
      future: 1,
    });
    await peer.request(Method.Open, { sessionId: "s1", create: true, future: 1 });
    await peer.request(Method.Prompt, {
      sessionId: "s1",
      turnId: "t1",
      content: [{ type: "text", text: "go", future: 1 }],
      future: 1,
    });
    return { connection, peer, frames };
  }

  test("a client that does not list permission_request: denied with the reason at once, never suspended", async () => {
    const without = KNOWN_UPDATE_TYPES.filter((t) => t !== "permission_request");
    const { connection, peer, frames } = await laptop(without);
    expect(await waitFor(() => frames.some((f) => f.type === "turn_end"), 1000)).toBe(true);
    expect(frames.some((f) => f.type === "permission_request")).toBe(false);
    const text = JSON.stringify(frames);
    expect(text).toContain("client does not support permission_request");
    expect(text).toContain("update tentacle");
    connection.close();
    peer.close();
  });

  test("a client that lists it (or sends no list: the v10 base set) is prompted as before", async () => {
    for (const updates of [[...KNOWN_UPDATE_TYPES], undefined]) {
      const { connection, peer, frames } = await laptop(updates);
      expect(await waitFor(() => frames.some((f) => f.type === "permission_request"), 1000)).toBe(
        true,
      );
      expect(frames.some((f) => f.type === "turn_end")).toBe(false); // suspended on the ask
      connection.close();
      peer.close();
    }
  });

  type Frame = { mandatory?: boolean; update: { type: string; requestId?: string } };
  /** One more raw client on `host` (its own connection), attached to `s1`. */
  async function client(host: SessionHost, updates: readonly string[]) {
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    const frames: Frame[] = [];
    const peer = new RpcPeer(clientCh, {
      onNotification: (_m, params) => {
        frames.push(params as Frame);
      },
    });
    await peer.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true, updates },
    });
    await peer.request(Method.Open, { sessionId: "s1", create: true });
    const has = (type: string) => frames.some((f) => f.update.type === type);
    return { connection, peer, frames, has };
  }
  const ALL = [...KNOWN_UPDATE_TYPES];
  const NO_ASK = KNOWN_UPDATE_TYPES.filter((t) => t !== "permission_request");
  const prompt = (peer: RpcPeer) =>
    peer.request(Method.Prompt, {
      sessionId: "s1",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });

  test("mixed attach: the declaring client is prompted; the other gets it WITHOUT mandatory; the turn survives", async () => {
    const host = makeHost(new ScriptedProvider([callShell, reply]), noopEnv);
    const a = await client(host, ALL);
    const b = await client(host, NO_ASK);
    await prompt(a.peer);
    expect(await waitFor(() => a.has("permission_request") && b.has("permission_request"))).toBe(
      true,
    );
    const toA = a.frames.find((f) => f.update.type === "permission_request");
    const toB = b.frames.find((f) => f.update.type === "permission_request");
    expect(toA?.mandatory).toBe(true);
    expect(toB?.mandatory).toBeUndefined();
    expect(toA?.update.requestId).toBe(toB?.update.requestId as string); // same frame, same seq
    await a.peer.request(Method.ResolvePermission, {
      sessionId: "s1",
      requestId: toA?.update.requestId,
      optionId: "allow_once",
    });
    expect(await waitFor(() => a.has("turn_end") && b.has("turn_end"), 1000)).toBe(true);
    // seq stays contiguous for the non-declaring client.
    const seqs = b.frames.map((f) => (f as unknown as { seq: number }).seq);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i));
    for (const c of [a, b]) c.connection.close();
  });

  test("an ask pending while detached: a non-declaring client attaching → denied with the reason", async () => {
    const host = makeHost(new ScriptedProvider([callShell, reply]), noopEnv);
    const a = await client(host, ALL);
    await prompt(a.peer);
    expect(await waitFor(() => a.has("permission_request"))).toBe(true);
    a.connection.close(); // nobody attached: stays suspended (the owner's exception)
    const b = await client(host, NO_ASK);
    expect(await waitFor(() => b.has("turn_end"), 1000)).toBe(true);
    expect(JSON.stringify(b.frames)).toContain("client does not support permission_request");
    b.connection.close();
  });

  test("an ask pending while detached: a declaring client attaching is prompted (still suspended)", async () => {
    const host = makeHost(new ScriptedProvider([callShell, reply]), noopEnv);
    const a = await client(host, ALL);
    await prompt(a.peer);
    expect(await waitFor(() => a.has("permission_request"))).toBe(true);
    a.connection.close();
    const c = await client(host, ALL);
    expect(await waitFor(() => c.has("permission_request"))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.has("turn_end")).toBe(false);
    c.connection.close();
  });

  test("the only declaring client detaches while a non-declaring one stays → denied with the reason", async () => {
    const host = makeHost(new ScriptedProvider([callShell, reply]), noopEnv);
    const a = await client(host, ALL);
    const b = await client(host, NO_ASK);
    await prompt(a.peer);
    expect(await waitFor(() => a.has("permission_request"))).toBe(true);
    a.connection.close();
    expect(await waitFor(() => b.has("turn_end"), 1000)).toBe(true);
    expect(JSON.stringify(b.frames)).toContain("client does not support permission_request");
    b.connection.close();
  });

  test("RemoteClient declares every update type it knows at initialize (round-trip)", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    let declared: unknown;
    const daemon = new RpcPeer(daemonCh, {
      onRequest: (method, params) => {
        if (method === Method.Initialize) {
          declared = (params as { clientCapabilities: { updates?: unknown } }).clientCapabilities
            .updates;
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
          skills: [],
        };
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    expect(declared).toEqual([...KNOWN_UPDATE_TYPES]);
    client.close();
    daemon.close();
  });
});
