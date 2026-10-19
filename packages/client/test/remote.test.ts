import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequester,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, Notification, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  MODEL_STREAM_BATCH_MAX_CHARS,
  MODEL_STREAM_COALESCE_MS,
  RemoteClient,
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

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
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
      const events: AgentEvent[] = [];
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
      .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
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
      const events: AgentEvent[] = [];
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
      .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
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
      const events: AgentEvent[] = [];
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
      (e): e is Extract<AgentEvent, { type: "steer" }> => e.type === "steer",
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
          return { protocolVersion: 1, agentCapabilities: { tools: true, permissions: true } };
        }
        if (method === Method.NewSession) {
          return { sessionId: "s1" };
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
      const events: AgentEvent[] = [];
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
    const first = iter.next(); // starts `session/new`; the id is not known yet
    // The TUI is already "running" here: this enqueue must wait for the session
    // instead of resolving as a silent no-op.
    await session.enqueue("early");
    const events: AgentEvent[] = [];
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
          };
        }
        if (method === Method.NewSession) return { sessionId: "s1" };
        if (method === Method.Prompt) {
          // Ack at once; the turn ends in the stream (only if `end`).
          const { turnId } = params as { turnId: string };
          for (const frame of frames) daemon.notify(Notification.SessionUpdate, frame);
          if (end) {
            daemon.notify(Notification.SessionUpdate, {
              sessionId: "s1",
              seq: 999,
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
    const events: AgentEvent[] = [];
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

  test("an unknown display event is skipped silently and the turn completes", async () => {
    const r = await run(
      [
        chunk(1, "a"),
        { sessionId: "s1", seq: 2, update: { type: "progress", pct: 3 } },
        chunk(3, "b"),
      ],
      true,
    );
    expect(r.outcome).toBe("ended");
    expect(r.events).toEqual([
      { type: "text", delta: "a" },
      { type: "text", delta: "b" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(r.errors).toEqual([]);
  });

  test("an unknown mandatory event fails the turn loudly and cancels it daemon-side", async () => {
    const r = await run(
      [{ sessionId: "s1", seq: 1, mandatory: true, update: { type: "permission_request" } }],
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
      onRequest: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { tools: true, permissions: true },
      }),
    });
    const errors: Error[] = [];
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    daemon.notify(Notification.SessionUpdate, {
      sessionId: "s1",
      seq: 9,
      mandatory: true,
      update: { type: "permission_request" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/permission_request.*newer than this client/),
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
        .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
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
          };
        }
        if (method === Method.NewSession) return { sessionId: "s1" };
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
    const events: AgentEvent[] = [];
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
            };
          }
          if (method === Method.NewSession) return { sessionId: "s1" };
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
    const events: AgentEvent[] = [];
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
          };
        }
        if (method === Method.NewSession) return { sessionId: "s1" };
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
