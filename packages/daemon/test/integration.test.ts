import { describe, expect, test } from "bun:test";
import { Agent, HookRunner, Session } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { BackgroundJobs, HostExecution } from "@tentacle/exec";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import type { EnqueueResult, KnownSessionUpdateParams, StopReason } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type Attachment, HostedSession, type UpdateSink } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

/** A test client attached to a hosted session: receives updates. */
const sinkTo = (send: UpdateSink): Attachment => ({
  send,
});

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
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A daemon-side `SessionHost` plus a connected client `RpcPeer`. */
function harness(
  model: ModelProvider,
  env: ExecutionEnvironment,
  clientHandlers: ConstructorParameters<typeof RpcPeer>[1] & {
    /** Answer every `permission_request` with this option (else leave it pending). */
    readonly answer?: string;
  } = {},
  connOptions: ConstructorParameters<typeof Connection>[3] = {},
) {
  const host = new SessionHost({
    defaultCwd: "/tmp/daemon-work",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host, undefined, connOptions);
  const updates: KnownSessionUpdateParams[] = [];
  const { answer, ...handlers } = clientHandlers;
  const client: RpcPeer = new RpcPeer(clientCh, {
    ...handlers,
    onNotification: (method, params) => {
      if (method === "session/update") {
        const p = params as KnownSessionUpdateParams;
        updates.push(p);
        if (answer !== undefined && p.update.type === "permission_request") {
          void client.request("session/resolve_permission", {
            sessionId: p.sessionId,
            requestId: p.update.requestId,
            optionId: answer,
          });
        }
      }
    },
  });
  return { client, updates, connection };
}

type TurnEndUpdate = Extract<KnownSessionUpdateParams["update"], { type: "turn_end" }>;

/** The streamed `turn_end` of `turnId` (a turn's outcome lives in the stream now). */
async function turnEnd(
  updates: readonly KnownSessionUpdateParams[],
  turnId: string,
  timeoutMs = 3000,
): Promise<TurnEndUpdate> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = updates
      .map((u) => u.update)
      .find((u): u is TurnEndUpdate => u.type === "turn_end" && u.turnId === turnId);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no turn_end for ${turnId}`);
    await tick(1);
  }
}

/** Start a turn (asserting the ack) and wait for its streamed `turn_end`. */
async function runTurn(
  client: RpcPeer,
  updates: readonly KnownSessionUpdateParams[],
  sessionId: string,
  text: string,
  turnId: string = crypto.randomUUID(),
): Promise<TurnEndUpdate> {
  const ack = await client.request("session/prompt", {
    sessionId,
    turnId,
    content: [{ type: "text", text }],
  });
  expect(ack).toEqual({ turnId });
  return turnEnd(updates, turnId);
}

describe("daemon ↔ client (in-memory)", () => {
  test("handshake → open → prompt streams updates and resolves the stop reason", async () => {
    const model = new ScriptedProvider([
      [
        { type: "text", delta: "Hello " },
        { type: "text", delta: "world" },
        { type: "done", usage: { promptTokens: 7, completionTokens: 2 } },
      ],
    ]);
    const { client, updates } = harness(model, noopEnv);

    const init = (await client.request("initialize", INIT)) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    const { sessionId } = (await client.request("session/open", { create: true })) as {
      sessionId: string;
    };
    expect(sessionId).toBeTruthy();

    const end = await runTurn(client, updates, sessionId, "hi", "t1");
    expect(end.stopReason).toBe("end_turn");

    await tick();
    const texts = updates
      .map((u) => u.update)
      .filter((u) => u.type === "agent_message_chunk")
      .map((u) =>
        u.type === "agent_message_chunk" && u.content.type === "text" ? u.content.text : "",
      );
    expect(texts.join("")).toBe("Hello world");
    // Usage rode along as an agent_usage update.
    expect(updates.some((u) => u.update.type === "agent_usage")).toBe(true);
    // Updates are sequence-numbered for replay: every frame, contiguous from 1.
    expect(updates.map((u) => u.seq)).toEqual(updates.map((_, i) => i + 1));
    // The turn is bracketed: turn_start{prompt} first, turn_end last, once each.
    expect(updates[0]?.update).toEqual({ type: "turn_start", turnId: "t1", prompt: "hi" });
    expect(updates.at(-1)?.update).toEqual({
      type: "turn_end",
      turnId: "t1",
      stopReason: "end_turn",
    });
    // The class flag: present (true) exactly on the bracket, omitted elsewhere.
    for (const u of updates) {
      const bracket = u.update.type === "turn_start" || u.update.type === "turn_end";
      expect("mandatory" in u).toBe(bracket);
      if (bracket) expect(u.mandatory).toBe(true);
    }
  });

  test("a non-text prompt block is rejected with InvalidParams; no turn starts", async () => {
    const inner = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    let calls = 0;
    const model: ModelProvider = {
      id: "counting",
      stream: (request) => {
        calls++;
        return inner.stream(request);
      },
    };
    const { client, updates } = harness(model, noopEnv);
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/open", { create: true })) as {
      sessionId: string;
    };

    await expect(
      client.request("session/prompt", {
        sessionId,
        turnId: "t-img",
        content: [
          { type: "text", text: "what is in this photo?" },
          { type: "image", mimeType: "image/png", data: "AA==" },
        ],
      }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining("image"),
    });
    await tick();
    expect(calls).toBe(0);
    expect(updates).toEqual([]);

    // Nothing leaked (no controller, no turn record): the SAME turnId now runs.
    const end = await runTurn(client, updates, sessionId, "hi", "t-img");
    expect(end.stopReason).toBe("end_turn");
    expect(calls).toBe(1);
  });

  test("a second initialize is rejected (handshake is idempotent-guarded)", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    await expect(client.request("initialize", INIT)).rejects.toMatchObject({
      code: DomainErrorCode.AlreadyInitialized,
    });
  });

  test("methods other than initialize are refused before the handshake", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await expect(client.request("session/open", { create: true })).rejects.toMatchObject({
      code: DomainErrorCode.NotInitialized,
    });
  });

  test("an incompatible protocol version is rejected", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await expect(
      client.request("initialize", {
        protocolVersion: 999,
        clientCapabilities: { streaming: true },
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.VersionMismatch,
      message: `protocol version mismatch: client 999, daemon ${PROTOCOL_VERSION} — update the daemon: run "tentacle update" on that host and restart "tentacle serve"`,
      data: { client: { protocol: 999 }, daemon: { protocol: PROTOCOL_VERSION }, update: "daemon" },
    });
  });

  // --- session/enqueue (steering) ----------------------------------------
  // Round 1 calls a tool (the daemon streams a `tool_call` update); round 2
  // ECHOES the last user message, so we can assert the model actually SAW the
  // steered text (non-vacuous — not just that a `steer` update was echoed).
  class EchoSteerProvider implements ModelProvider {
    readonly id = "echo-steer";
    readonly calls: { messages: string[] }[] = [];
    private turn = 0;
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      this.turn += 1;
      this.calls.push({ messages: request.messages.map((m) => m.content) });
      if (this.turn === 1) {
        yield {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
        };
        yield { type: "done" };
      } else {
        const last = request.messages[request.messages.length - 1]?.content ?? "";
        yield { type: "text", delta: `echo:${last}` };
        yield { type: "done" };
      }
    }
  }

  // A tool env whose exec is slow (200 ms): the client sees the `tool_call`
  // update while the tool is still running, a deterministic mid-turn window to
  // enqueue before the agent reaches the next model-round boundary.
  const slowEnv: ExecutionEnvironment = {
    id: "slow",
    async exec() {
      await new Promise((r) => setTimeout(r, 200));
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };

  const steerUpdates = (updates: KnownSessionUpdateParams[]) =>
    updates
      .map((u) => u.update)
      .filter(
        (u): u is Extract<KnownSessionUpdateParams["update"], { type: "steer" }> =>
          u.type === "steer",
      );

  test("session/enqueue mid-turn is served while the prompt is in flight and the model sees it", async () => {
    const model = new EchoSteerProvider();
    const { client, updates } = harness(model, slowEnv, {
      answer: "allow_once",
    });
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/open", { create: true })) as {
      sessionId: string;
    };

    await client.request("session/prompt", {
      sessionId,
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    // Wait until the daemon has announced round 1's tool call. The tool's exec
    // is still running (200 ms), so the turn is genuinely in flight.
    while (!updates.some((u) => u.update.type === "tool_call")) {
      await tick(5);
    }
    expect(updates.some((u) => u.update.type === "turn_end")).toBe(false);
    const result = (await client.request("session/enqueue", {
      sessionId,
      id: "e1",
      turnId: "t1",
      text: "steer me",
    })) as EnqueueResult;
    expect(result).toEqual({});
    const end = await turnEnd(updates, "t1");
    expect(end.stopReason).toBe("end_turn");

    // A `steer` update was streamed back with the queued text…
    expect(steerUpdates(updates).map((s) => s.text)).toEqual(["steer me"]);
    // …and the model actually SAW it: round 2 ran as a whole (without the steer
    // the turn would have ended after round 1's tool result) and echoed it.
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages.at(-1)).toBe("steer me");
    const echoed = updates
      .map((u) => u.update)
      .filter(
        (u): u is Extract<KnownSessionUpdateParams["update"], { type: "agent_message_chunk" }> =>
          u.type === "agent_message_chunk",
      )
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(echoed).toContain("echo:steer me");
  });

  test("two enqueues on the same boundary stream two steer updates in FIFO order", async () => {
    const model = new EchoSteerProvider();
    const { client, updates } = harness(model, slowEnv, {
      answer: "allow_once",
    });
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/open", { create: true })) as {
      sessionId: string;
    };

    await client.request("session/prompt", {
      sessionId,
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    while (!updates.some((u) => u.update.type === "tool_call")) {
      await tick(5);
    }
    // Both enqueues land on the SAME boundary (before round 2 drains).
    await client.request("session/enqueue", { sessionId, id: "a", turnId: "t1", text: "A" });
    await client.request("session/enqueue", { sessionId, id: "b", turnId: "t1", text: "B" });
    await turnEnd(updates, "t1");
    // N enqueue ⇒ N echo, in order — the invariant the TUI's FIFO removal relies on.
    expect(steerUpdates(updates).map((s) => s.text)).toEqual(["A", "B"]);
    // The model saw both injected user messages, in order.
    expect(model.calls[1]?.messages.slice(-2)).toEqual(["A", "B"]);
  });

  test("session/enqueue on an unknown session rejects with UnknownSession", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    await expect(
      client.request("session/enqueue", { sessionId: "nope", id: "e", turnId: "t", text: "x" }),
    ).rejects.toMatchObject({ code: DomainErrorCode.UnknownSession });
  });

  // INVARIANT (agent.ts, at the late-steer drain): from the LAST steering drain
  // to the daemon marking the turn over there is no await. A transport message
  // is a macrotask, so a timer armed inside the drain stands in for "the next
  // `session/enqueue` to arrive": when it fires the turn must already be over
  // (→ rejected as NoTurnRunning), never running-but-past-the-drain (→ accepted,
  // then silently dropped by the next send's reset).
  for (const [label, maxIterations, script] of [
    ["end_turn", 16, [[{ type: "text", delta: "hi" }, { type: "done" }]]],
    [
      "max_iterations",
      1,
      [
        [
          { type: "tool_call", toolCall: { id: "c1", name: "missing", arguments: "{}" } },
          { type: "done" },
        ],
        [{ type: "text", delta: "report" }, { type: "done" }],
      ],
    ],
  ] as const) {
    test(`no macrotask fits between the last steering drain and the turn's end (${label})`, async () => {
      const agent = new Agent({
        model: new ScriptedProvider(script),
        tools: new ToolRegistry(),
        env: noopEnv,
        maxIterations,
      });
      const runMessages = agent.runMessages.bind(agent);
      // What "the next `session/enqueue`" would observe at each drain.
      const atNextMacrotask: { running: boolean; ended: boolean }[] = [];
      const streamed: KnownSessionUpdateParams[] = [];
      const hosted = new HostedSession("s1", new Session(agent), new PermissionBroker());
      hosted.attach(sinkTo((p) => streamed.push(p)));
      const ended = () => streamed.some((p) => p.update.type === "turn_end");
      // Patched after construction: `Session.send` calls `agent.runMessages` per turn.
      agent.runMessages = (messages, sessionId, signal, drain) =>
        runMessages(messages, sessionId, signal, () => {
          setTimeout(() => atNextMacrotask.push({ running: hosted.running, ended: ended() }), 0);
          return drain?.() ?? [];
        });

      expect(hosted.prompt("t1", [{ type: "text", text: "go" }])).toEqual({ turnId: "t1" });
      await tick(5);
      // The turn is over (an enqueue is rejected) AND its outcome already
      // streamed, by the time any transport message could arrive.
      expect(atNextMacrotask.length).toBeGreaterThan(0);
      expect(atNextMacrotask.at(-1)).toEqual({ running: false, ended: true });
      expect(streamed.at(-1)?.update).toEqual({
        type: "turn_end",
        turnId: "t1",
        stopReason: label,
      });
    });
  }

  // The same invariant with an AWAITED `turn_end` hook (docs/feat/hooks-turn.md):
  // the hook runs BEFORE the last drain, so a `session/enqueue` arriving while
  // it runs is drained into the turn (another round), never accepted and
  // dropped; and still no macrotask fits between the last drain and the end.
  test("a slow turn_end hook: an enqueue during it is drained, and no macrotask fits after the last drain", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "first" }, { type: "done" }],
      [{ type: "text", delta: "second" }, { type: "done" }],
    ]);
    let hookRuns = 0;
    const env: ExecutionEnvironment = {
      ...noopEnv,
      async exec() {
        hookRuns++;
        if (hookRuns === 1) {
          // A transport message arriving while the hook runs.
          setTimeout(() => hosted.enqueue("e1", "t1", "late steer"), 10);
        }
        await tick(50);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const hooks = new HookRunner({
      specs: [{ event: "turn_end", command: "slow" }],
      env,
      cwd: "/",
    });
    const agent = new Agent({ model, tools: new ToolRegistry(), env, hooks });
    const runMessages = agent.runMessages.bind(agent);
    const atNextMacrotask: { running: boolean; ended: boolean }[] = [];
    const streamed: KnownSessionUpdateParams[] = [];
    const hosted = new HostedSession("s1", new Session(agent), new PermissionBroker());
    const h = hosted;
    h.attach(sinkTo((p) => streamed.push(p)));
    const ended = () => streamed.some((p) => p.update.type === "turn_end");
    agent.runMessages = (messages, sessionId, signal, drain) =>
      runMessages(messages, sessionId, signal, () => {
        setTimeout(() => atNextMacrotask.push({ running: h.running, ended: ended() }), 0);
        return drain?.() ?? [];
      });

    expect(h.prompt("t1", [{ type: "text", text: "go" }])).toEqual({ turnId: "t1" });
    while (!ended()) {
      await tick(10);
    }
    await tick(5);
    // Drained into the turn: a steer echo and a second model round.
    expect(steerUpdates(streamed).map((s) => s.text)).toEqual(["late steer"]);
    expect(hookRuns).toBe(2);
    expect(atNextMacrotask.at(-1)).toEqual({ running: false, ended: true });
    expect(streamed.at(-1)?.update).toEqual({
      type: "turn_end",
      turnId: "t1",
      stopReason: "end_turn",
    });
  });

  // A `turn_start` hook that stops the turn: a steer accepted while it ran is
  // drained before the end (kept + echoed, never dropped) but gets no model
  // round — the stop holds, and the steer never bypasses `turn_start`.
  test("a slow turn_start hook that stops the turn: an enqueue during it is kept and echoed, but gets no model round", async () => {
    let modelCalls = 0;
    const model: ModelProvider = {
      id: "counting",
      async *stream() {
        modelCalls++;
        yield { type: "text", delta: "answered" };
        yield { type: "done" };
      },
    };
    const env: ExecutionEnvironment = {
      ...noopEnv,
      async exec() {
        setTimeout(() => hosted.enqueue("e1", "t1", "late steer"), 10);
        await tick(50);
        return { stdout: "", stderr: "frozen", exitCode: 2 };
      },
    };
    const hooks = new HookRunner({
      specs: [{ event: "turn_start", command: "slow" }],
      env,
      cwd: "/",
    });
    const agent = new Agent({ model, tools: new ToolRegistry(), env, hooks });
    const runMessages = agent.runMessages.bind(agent);
    const atNextMacrotask: { running: boolean; ended: boolean }[] = [];
    const streamed: KnownSessionUpdateParams[] = [];
    const session = new Session(agent);
    const hosted = new HostedSession("s1", session, new PermissionBroker());
    hosted.attach(sinkTo((p) => streamed.push(p)));
    const ended = () => streamed.some((p) => p.update.type === "turn_end");
    agent.runMessages = (messages, sessionId, signal, drain) =>
      runMessages(messages, sessionId, signal, () => {
        setTimeout(() => atNextMacrotask.push({ running: hosted.running, ended: ended() }), 0);
        return drain?.() ?? [];
      });

    expect(hosted.prompt("t1", [{ type: "text", text: "go" }])).toEqual({ turnId: "t1" });
    while (!ended()) {
      await tick(10);
    }
    await tick(5);
    // Echoed and kept in the history, but the stop holds: the steer never
    // reached the model without passing through `turn_start`.
    expect(steerUpdates(streamed).map((s) => s.text)).toEqual(["late steer"]);
    expect(modelCalls).toBe(0);
    expect(session.pendingSteering()).toEqual([]);
    expect(session.messages.at(-1)).toEqual({ role: "user", content: "late steer" });
    expect(atNextMacrotask.at(-1)).toEqual({ running: false, ended: true });
    expect(streamed.at(-1)?.update).toEqual({
      type: "turn_end",
      turnId: "t1",
      stopReason: "end_turn",
    });
  });

  test("session/enqueue with no turn running rejects with NoTurnRunning", async () => {
    // Accepting it would be a fake success: the next `send` resets the steering
    // queue, so the text would be dropped silently.
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/open", { create: true })) as {
      sessionId: string;
    };
    await expect(
      client.request("session/enqueue", { sessionId, id: "e", turnId: "t", text: "late" }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NoTurnRunning });
  });

  test("prompting an unknown session errors", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    await expect(
      client.request("session/prompt", {
        sessionId: "nope",
        turnId: "t",
        content: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.UnknownSession });
    expect(JsonRpcErrorCode.InternalError).toBeDefined();
  });
});

describe("connection close", () => {
  test("Connection.close() only detaches: the jobs live on; session/close from another connection kills them", async () => {
    const m = `3${Math.floor(Math.random() * 900000 + 100000)}`;
    const alive = (): number =>
      Bun.spawnSync(["pgrep", "-f", `sleep ${m}`])
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean).length;
    const created: BackgroundJobs[] = [];
    const host = new SessionHost({
      defaultCwd: "/tmp/daemon-work",
      createAgent: () => {
        const permissions = new PermissionBroker();
        // Grace ≫ the 2 s wait below: only session/close's group SIGTERM can pass.
        const jobs = new BackgroundJobs(new HostExecution({ killGraceMs: 10_000 }));
        created.push(jobs);
        const agent = new Agent({
          model: new ScriptedProvider([]),
          tools: new ToolRegistry(),
          env: noopEnv,
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions, jobs };
      },
    });
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    const client = new RpcPeer(clientCh, {});
    try {
      await client.request("initialize", INIT);
      const { sessionId } = (await client.request("session/open", { create: true })) as {
        sessionId: string;
      };
      const jobs = created[0];
      expect(jobs).toBeDefined();
      jobs?.start(`sleep ${m}; true`);
      const deadline = Date.now() + 2000;
      while (alive() < 2 && Date.now() < deadline) {
        await tick(20);
      }
      expect(alive()).toBe(2); // sh + sleep: the job really runs

      const exited = new Promise<void>((resolve) => jobs?.onExit(() => resolve()));
      connection.close();
      await tick(300);
      expect(alive()).toBe(2); // the session (and its job) outlived the connection
      expect(host.get(sessionId)).toBeDefined();

      const [d2, c2] = createChannelPair();
      new Connection(d2, host);
      const other = new RpcPeer(c2, {});
      await other.request("initialize", INIT);
      expect(await other.request("session/close", { sessionId })).toEqual({});
      expect(host.get(sessionId)).toBeUndefined();

      const until = Date.now() + 2000;
      while (alive() > 0 && Date.now() < until) {
        await tick(50);
      }
      expect(alive()).toBe(0);
      await exited;
      expect(jobs?.list().map((j) => j.status)).toEqual(["killed"]);
    } finally {
      Bun.spawnSync(["pkill", "-9", "-f", `sleep ${m}`]);
    }
  });
});

describe("turn lifecycle in the stream (ack, bracket, idempotency)", () => {
  /** A model whose calls each wait for `release()`, then reply via `reply(callIndex, messages)`. */
  class GatedProvider implements ModelProvider {
    readonly id = "gated";
    readonly calls: string[][] = [];
    private gates: (() => void)[] = [];
    constructor(
      private readonly reply: (call: number, messages: string[]) => StreamEvent[] = () => [
        { type: "text", delta: "ok" },
        { type: "done" },
      ],
      private readonly gated: (call: number) => boolean = () => true,
    ) {}
    release(): void {
      for (const open of this.gates.splice(0)) open();
    }
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      const call = this.calls.length;
      const messages = request.messages.map((m) => m.content);
      this.calls.push(messages);
      if (this.gated(call)) await new Promise<void>((r) => this.gates.push(r));
      for (const event of this.reply(call, messages)) yield event;
    }
  }

  /** Like `harness`, with the host's turn-error policy and the agent's iteration cap. */
  function turnHarness(
    model: ModelProvider,
    opts: {
      env?: ExecutionEnvironment;
      maxIterations?: number;
      exposeTurnErrors?: boolean;
      onTurnError?: (e: Error) => void;
    } = {},
  ) {
    const host = new SessionHost({
      defaultCwd: "/tmp/daemon-work",
      ...(opts.exposeTurnErrors ? { exposeTurnErrors: true } : {}),
      ...(opts.onTurnError ? { onTurnError: opts.onTurnError } : {}),
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model,
          tools: new ToolRegistry().register(shellTool),
          env: opts.env ?? noopEnv,
          requestPermission: (req, options) => permissions.request(req, options),
          ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
        });
        return { agent, permissions };
      },
    });
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client: RpcPeer = new RpcPeer(clientCh, {
      onNotification: (method, params) => {
        if (method !== "session/update") return;
        const p = params as KnownSessionUpdateParams;
        updates.push(p);
        if (p.update.type === "permission_request") {
          void client.request("session/resolve_permission", {
            sessionId: p.sessionId,
            requestId: p.update.requestId,
            optionId: "allow_once",
          });
        }
      },
    });
    const open = async (): Promise<string> => {
      await client.request("initialize", INIT);
      return ((await client.request("session/open", { create: true })) as { sessionId: string })
        .sessionId;
    };
    return { client, updates, open };
  }

  const prompt = (client: RpcPeer, sessionId: string, turnId: string, text = "go") =>
    client.request("session/prompt", { sessionId, turnId, content: [{ type: "text", text }] });

  /** Every update of one turn, from its turn_start to its turn_end. */
  const turnUpdates = (updates: readonly KnownSessionUpdateParams[], turnId: string) => {
    const start = updates.findIndex(
      (u) => u.update.type === "turn_start" && u.update.turnId === turnId,
    );
    const end = updates.findIndex(
      (u) => u.update.type === "turn_end" && u.update.turnId === turnId,
    );
    return updates.slice(start, end + 1);
  };

  test("prompt acks before the model runs; turn_start{prompt} is already streamed", async () => {
    const model = new GatedProvider();
    const { client, updates, open } = turnHarness(model);
    const sessionId = await open();
    // Resolves while the model is blocked (on main the ack WAS the turn's end).
    expect(await prompt(client, sessionId, "t1", "hello")).toEqual({ turnId: "t1" });
    expect(model.calls).toHaveLength(1);
    expect(updates.map((u) => u.update)).toEqual([
      { type: "turn_start", turnId: "t1", prompt: "hello" },
    ]);
    model.release();
    expect((await turnEnd(updates, "t1")).stopReason).toBe("end_turn");
  });

  // Each exit path of the agent: exactly one turn_start first, one turn_end last.
  const exits: [string, () => ModelProvider, { maxIterations?: number }, StopReason][] = [
    [
      "end_turn",
      () => new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]),
      {},
      "end_turn",
    ],
    [
      "max_iterations",
      () =>
        new ScriptedProvider([
          [
            { type: "tool_call", toolCall: { id: "c1", name: "missing", arguments: "{}" } },
            { type: "done" },
          ],
        ]),
      { maxIterations: 1 },
      "max_iterations",
    ],
    [
      "throwing model",
      () => ({
        id: "boom",
        // biome-ignore lint/correctness/useYield: throws before its first event
        async *stream(): AsyncIterable<StreamEvent> {
          throw new Error("provider 401: key sk-SECRET at https://endpoint");
        },
      }),
      {},
      "error",
    ],
  ];
  for (const [label, makeModel, opts, stopReason] of exits) {
    test(`turn bracket on every exit: ${label}`, async () => {
      const errors: Error[] = [];
      const { client, updates, open } = turnHarness(makeModel(), {
        ...opts,
        onTurnError: (e) => errors.push(e),
      });
      const sessionId = await open();
      await prompt(client, sessionId, "t1");
      const end = await turnEnd(updates, "t1");
      await tick();
      expect(end.stopReason).toBe(stopReason);
      const types = updates.map((u) => u.update.type);
      expect(types[0]).toBe("turn_start");
      expect(types.at(-1)).toBe("turn_end");
      expect(types.filter((t) => t === "turn_start")).toHaveLength(1);
      expect(types.filter((t) => t === "turn_end")).toHaveLength(1);
      expect(updates.map((u) => u.seq)).toEqual(updates.map((_, i) => i + 1));
      if (stopReason === "error") {
        // Redacted on the wire by default; the real error reaches the sink, once.
        expect(end.error).toEqual({ message: "internal error" });
        expect(errors.map((e) => e.message)).toEqual([
          "provider 401: key sk-SECRET at https://endpoint",
        ]);
        expect(JSON.stringify(updates)).not.toContain("sk-SECRET");
      } else {
        expect(end.error).toBeUndefined();
        expect(errors).toEqual([]);
      }
    });
  }

  test("turn bracket on cancel mid-model: turn_end cancelled, once", async () => {
    const model = new GatedProvider();
    const { client, updates, open } = turnHarness(model);
    const sessionId = await open();
    await prompt(client, sessionId, "t1");
    client.notify("session/cancel", { sessionId });
    await tick();
    model.release();
    const end = await turnEnd(updates, "t1");
    expect(end.stopReason).toBe("cancelled");
    expect(updates.filter((u) => u.update.type === "turn_end")).toHaveLength(1);
  });

  test("a turn error is exposed only with exposeTurnErrors; an RpcError keeps its code", async () => {
    const exposed = turnHarness(
      {
        id: "boom",
        // biome-ignore lint/correctness/useYield: throws before its first event
        async *stream(): AsyncIterable<StreamEvent> {
          throw new Error("real cause");
        },
      },
      { exposeTurnErrors: true },
    );
    const s1 = await exposed.open();
    await prompt(exposed.client, s1, "t1");
    expect((await turnEnd(exposed.updates, "t1")).error).toEqual({ message: "real cause" });

    const rpc = turnHarness({
      id: "rpc",
      // biome-ignore lint/correctness/useYield: throws before its first event
      async *stream(): AsyncIterable<StreamEvent> {
        throw new RpcError(DomainErrorCode.TurnInProgress, "domain message");
      },
    });
    const s2 = await rpc.open();
    await prompt(rpc.client, s2, "t1");
    expect((await turnEnd(rpc.updates, "t1")).error).toEqual({
      code: DomainErrorCode.TurnInProgress,
      message: "domain message",
    });
  });

  test("a retried turnId never runs twice: cached ack while running, `ended` after, forever", async () => {
    const model = new GatedProvider(undefined, (call) => call === 0);
    const { client, updates, open } = turnHarness(model);
    const sessionId = await open();
    expect(await prompt(client, sessionId, "t1")).toEqual({ turnId: "t1" });
    // Running: the same id is the same ack, not TurnInProgress, and no new model call.
    expect(await prompt(client, sessionId, "t1", "different text")).toEqual({ turnId: "t1" });
    expect(model.calls).toHaveLength(1);
    model.release();
    const end = await turnEnd(updates, "t1");
    // Ended: the ack carries the streamed outcome.
    const { type: _t, turnId: _id, ...outcome } = end;
    expect(await prompt(client, sessionId, "t1")).toEqual({ turnId: "t1", ended: outcome });
    // Not count-bounded: still cached after 50 more turns.
    for (let i = 0; i < 50; i++) {
      await prompt(client, sessionId, `n${i}`);
      await turnEnd(updates, `n${i}`);
    }
    const callsBefore = model.calls.length;
    expect(await prompt(client, sessionId, "t1")).toEqual({ turnId: "t1", ended: outcome });
    expect(model.calls.length).toBe(callsBefore);
    expect(updates.filter((u) => u.update.type === "turn_start")).toHaveLength(51);
  });

  test("a prompt rejected TurnInProgress is not recorded: its id later starts a turn", async () => {
    const model = new GatedProvider();
    const { client, updates, open } = turnHarness(model);
    const sessionId = await open();
    await prompt(client, sessionId, "t1");
    await expect(prompt(client, sessionId, "t2")).rejects.toMatchObject({
      code: DomainErrorCode.TurnInProgress,
    });
    model.release();
    await turnEnd(updates, "t1");
    expect(await prompt(client, sessionId, "t2")).toEqual({ turnId: "t2" });
    model.release();
    await tick();
    model.release();
    expect((await turnEnd(updates, "t2")).stopReason).toBe("end_turn");
  });

  // A turn's first round (last message = the prompt "go") calls a tool on a slow
  // env (a mid-turn window); every other round echoes the last message.
  const echo = () =>
    new GatedProvider(
      (_call, messages) =>
        messages.at(-1) === "go"
          ? [
              {
                type: "tool_call",
                toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
              },
              { type: "done" },
            ]
          : [{ type: "text", delta: `echo:${messages.at(-1) ?? ""}` }, { type: "done" }],
      () => false,
    );
  const slow: ExecutionEnvironment = {
    id: "slow",
    async exec() {
      await tick(100);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  const steers = (updates: readonly KnownSessionUpdateParams[]) =>
    updates.filter((u) => u.update.type === "steer");

  test("enqueue: accepted, ack lost, turn ends, same id retried → {} and the model saw it once", async () => {
    const model = echo();
    const { client, updates, open } = turnHarness(model, { env: slow });
    const sessionId = await open();
    await prompt(client, sessionId, "t1");
    while (!updates.some((u) => u.update.type === "tool_call")) await tick(5);
    // First attempt applied; its ack is "lost" (the result is discarded).
    void client.request("session/enqueue", { sessionId, id: "e1", turnId: "t1", text: "s" });
    await turnEnd(updates, "t1");
    // The retry after the turn ended: a no-op success, not NoTurnRunning.
    expect(
      await client.request("session/enqueue", { sessionId, id: "e1", turnId: "t1", text: "s" }),
    ).toEqual({});
    expect(steers(updates)).toHaveLength(1);
    expect(model.calls.flat().filter((m) => m === "s")).toHaveLength(1);
    // A retry during a LATER turn is still a no-op: never a second injection.
    await prompt(client, sessionId, "t2");
    while (updates.filter((u) => u.update.type === "tool_call").length < 2) await tick(5);
    expect(
      await client.request("session/enqueue", { sessionId, id: "e1", turnId: "t1", text: "s" }),
    ).toEqual({});
    await turnEnd(updates, "t2");
    expect(steers(updates)).toHaveLength(1);
  });

  test("enqueue bound to a turn that is no longer running → NoTurnRunning, never steers the next turn", async () => {
    const model = echo();
    const { client, updates, open } = turnHarness(model, { env: slow });
    const sessionId = await open();
    await prompt(client, sessionId, "t1");
    await turnEnd(updates, "t1");
    await prompt(client, sessionId, "t2");
    while (updates.filter((u) => u.update.type === "tool_call").length < 2) await tick(5);
    // A fresh id, but typed during t1: it must not land in t2.
    await expect(
      client.request("session/enqueue", { sessionId, id: "late", turnId: "t1", text: "stale" }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NoTurnRunning });
    await turnEnd(updates, "t2");
    expect(steers(updates)).toHaveLength(0);
    expect(model.calls.flat()).not.toContain("stale");
    // Rejected attempts are not recorded: the same id for the RUNNING turn applies.
    await prompt(client, sessionId, "t3");
    while (updates.filter((u) => u.update.type === "tool_call").length < 3) await tick(5);
    expect(
      await client.request("session/enqueue", { sessionId, id: "late", turnId: "t3", text: "now" }),
    ).toEqual({});
    await turnEnd(updates, "t3");
    expect(steers(updates).map((u) => u.update)).toEqual([
      { type: "steer", text: "now", id: "late" },
    ]);
  });

  test("an enqueue sent right after the ack is not lost to the turn-start steering reset", async () => {
    // Round 1 is gated (so the turn is surely running), then replies with text.
    const model = new GatedProvider(
      (call, messages) => [
        { type: "text", delta: call === 0 ? "first" : `echo:${messages.at(-1) ?? ""}` },
        { type: "done" },
      ],
      (call) => call === 0,
    );
    const { client, updates, open } = turnHarness(model);
    const sessionId = await open();
    const sent = prompt(client, sessionId, "t1").then(() =>
      client.request("session/enqueue", { sessionId, id: "e1", turnId: "t1", text: "early" }),
    );
    expect(await sent).toEqual({});
    model.release();
    await turnEnd(updates, "t1");
    // The late drain injected it and ran a second round that saw it.
    expect(steers(updates).map((u) => u.update)).toEqual([
      { type: "steer", text: "early", id: "e1" },
    ]);
    expect(model.calls[1]?.at(-1)).toBe("early");
  });

  test("a throwing sink never strands the session as running, nor rejects unhandled", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]),
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const errors: string[] = [];
    const hosted = new HostedSession("s1", new Session(agent), new PermissionBroker(), undefined, {
      onTurnError: (e) => errors.push(e.message),
    });
    hosted.attach(
      sinkTo(() => {
        throw new Error("sink down");
      }),
    );
    expect(hosted.prompt("t1", [{ type: "text", text: "go" }])).toEqual({ turnId: "t1" });
    await tick();
    expect(hosted.running).toBe(false);
    // Reported once, never silent; the sink is detached at its first throw.
    expect(errors).toEqual(["sink down"]);
    expect(hosted.attachedCount).toBe(0);
    // The turn is unaffected by its client's failure: it ran to its end.
    const retry = hosted.prompt("t1", [{ type: "text", text: "go" }]);
    expect(retry.ended?.stopReason).toBe("end_turn");
  });

  test("the replay buffer of a turn starts at its turn_start", async () => {
    const { client, updates, open } = turnHarness(
      new ScriptedProvider([
        [{ type: "text", delta: "a" }, { type: "done" }],
        [{ type: "text", delta: "b" }, { type: "done" }],
      ]),
    );
    const sessionId = await open();
    await prompt(client, sessionId, "t1");
    await turnEnd(updates, "t1");
    await prompt(client, sessionId, "t2");
    await turnEnd(updates, "t2");
    expect(turnUpdates(updates, "t2")[0]?.update).toEqual({
      type: "turn_start",
      turnId: "t2",
      prompt: "go",
    });
  });

  test("a throwing onTurnError (the embedder's log sink) never strands the turn", async () => {
    const agent = new Agent({
      model: {
        id: "boom",
        // biome-ignore lint/correctness/useYield: throws before its first event
        async *stream(): AsyncIterable<StreamEvent> {
          throw new Error("model down");
        },
      },
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const hosted = new HostedSession("s1", new Session(agent), new PermissionBroker(), undefined, {
      onTurnError: () => {
        throw new Error("log sink down");
      },
    });
    const streamed: KnownSessionUpdateParams[] = [];
    hosted.attach(sinkTo((p) => streamed.push(p)));
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await tick();
    expect(hosted.running).toBe(false);
    expect(streamed.at(-1)?.update).toEqual({
      type: "turn_end",
      turnId: "t1",
      stopReason: "error",
      error: { message: "internal error" },
    });
  });
});

describe("compaction is exclusive with a turn", () => {
  /**
   * The rejection of `p`; fails if `p` resolves or is still pending after `ms`.
   * Not `expect(p).rejects`: on bun 1.4.3 that spins forever on a promise that
   * never settles, past the test timeout (docs/library-bugs.md) — and a
   * regression here is exactly a request left parked.
   */
  async function rejection(p: Promise<unknown>, ms = 1000): Promise<unknown> {
    const outcome = await Promise.race([
      p.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      tick(ms).then(() => ({ kind: "pending" as const })),
    ]);
    if (outcome.kind !== "rejected") throw new Error(`expected a rejection, got: ${outcome.kind}`);
    return outcome.error;
  }

  /**
   * The summarize request (the tool-free one) parks until `releaseSummary()`
   * and IGNORES the abort signal (the stronger case for cancel). A turn round
   * whose last message is "go" calls the shell tool; every other round answers.
   */
  class CompactProvider implements ModelProvider {
    readonly id = "compact";
    summaries = 0;
    private summaryGates: (() => void)[] = [];
    constructor(private readonly summary = "SUMMARY") {}
    releaseSummary(): void {
      for (const open of this.summaryGates.splice(0)) open();
    }
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      if (request.tools?.length === 0) {
        this.summaries++;
        await new Promise<void>((r) => this.summaryGates.push(r));
        if (this.summary) yield { type: "text", delta: this.summary };
        yield { type: "done" };
        return;
      }
      if (request.messages.at(-1)?.content === "go") {
        yield {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
        };
      } else {
        yield { type: "text", delta: "done" };
      }
      yield { type: "done" };
    }
  }

  /** A tool env whose `exec` parks until `release()`. */
  function parkedEnv() {
    let gate: (() => void) | null = null;
    const env: ExecutionEnvironment = {
      id: "parked",
      async exec() {
        await new Promise<void>((r) => {
          gate = r;
        });
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    return {
      env,
      parked: () => gate !== null,
      release: () => gate?.(),
    };
  }

  const until = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await tick(1);
    }
  };

  async function setup(model: ModelProvider, env: ExecutionEnvironment = noopEnv) {
    const h = harness(model, env, { answer: "allow_once" });
    await h.client.request("initialize", INIT);
    const { sessionId } = (await h.client.request("session/open", { create: true })) as {
      sessionId: string;
    };
    const history = async () =>
      ((await h.client.request("session/snapshot", { sessionId })) as { messages: ChatMessage[] })
        .messages;
    const compact = () => h.client.request("session/compact", { sessionId });
    const prompt = (turnId: string, text: string) =>
      h.client.request("session/prompt", { sessionId, turnId, content: [{ type: "text", text }] });
    return { ...h, sessionId, history, compact, prompt };
  }

  test("compact during a turn is rejected TurnInProgress; the turn's history stays whole", async () => {
    const model = new CompactProvider();
    const parked = parkedEnv();
    const s = await setup(model, parked.env);
    await s.prompt("t1", "go");
    await until(parked.parked);

    expect(await rejection(s.compact())).toMatchObject({ code: DomainErrorCode.TurnInProgress });

    parked.release();
    expect((await turnEnd(s.updates, "t1")).stopReason).toBe("end_turn");
    const history = (await s.history()).filter((m) => m.role !== "system");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history[1]?.toolCalls?.[0]?.id).toBe("c1");
    expect(history[2]?.toolCallId).toBe("c1");
    expect(model.summaries).toBe(0);
  });

  test("prompt during a compaction is rejected CompactInProgress and not recorded", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const before = (await s.history()).length;
    const compacting = s.compact();
    await until(() => model.summaries === 1);

    expect(await rejection(s.prompt("t1", "second"))).toMatchObject({
      code: DomainErrorCode.CompactInProgress,
    });

    model.releaseSummary();
    const result = (await compacting) as { before: number; after: number };
    expect(result.before).toBe(before);
    // The rejected id was not recorded: it now starts a turn on the compacted history.
    expect((await runTurn(s.client, s.updates, s.sessionId, "second", "t1")).stopReason).toBe(
      "end_turn",
    );
    const history = (await s.history()).filter((m) => m.role !== "system");
    expect(history.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(history[0]?.content).toContain("SUMMARY");
    expect(history[1]?.content).toBe("second");
  });

  test("compact during a compaction is rejected CompactInProgress; the first completes", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const first = s.compact();
    await until(() => model.summaries === 1);

    expect(await rejection(s.compact())).toMatchObject({ code: DomainErrorCode.CompactInProgress });

    model.releaseSummary();
    expect(await first).toMatchObject({ after: 1 });
    expect(model.summaries).toBe(1);
  });

  test("session/cancel stops a compaction: Cancelled, history untouched, session free", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const before = await s.history();
    const compacting = s.compact();
    await until(() => model.summaries === 1);

    s.client.notify("session/cancel", { sessionId: s.sessionId });
    await tick();
    // The provider ignores the signal: its summary still lands, and must not apply.
    model.releaseSummary();

    expect(await rejection(compacting)).toMatchObject({ code: DomainErrorCode.Cancelled });
    expect(await s.history()).toEqual(before);
    expect((await runTurn(s.client, s.updates, s.sessionId, "again", "t1")).stopReason).toBe(
      "end_turn",
    );
  });

  test("a compaction that fails frees the session for the next prompt", async () => {
    const model = new CompactProvider("");
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const compacting = s.compact();
    await until(() => model.summaries === 1);
    model.releaseSummary();
    expect(await rejection(compacting)).toBeInstanceOf(RpcError);

    expect((await runTurn(s.client, s.updates, s.sessionId, "again", "t1")).stopReason).toBe(
      "end_turn",
    );
  });

  test("a parked compaction does not serialize the peer: snapshot and enqueue still answer", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const compacting = s.compact();
    await until(() => model.summaries === 1);

    expect((await s.history()).filter((m) => m.role !== "system")).toHaveLength(2);
    expect(
      await rejection(
        s.client.request("session/enqueue", {
          sessionId: s.sessionId,
          id: "e1",
          turnId: "t0",
          text: "late",
        }),
      ),
    ).toMatchObject({ code: DomainErrorCode.NoTurnRunning });

    model.releaseSummary();
    await compacting;
  });
  // The load-bearing property: check and take of the busy slot in ONE
  // synchronous stretch. Both frames are sent in the same tick, so an `await`
  // between the check and the take would let both in.
  test("compact then prompt in the same tick: the compaction wins, the prompt is rejected", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const before = (await s.history()).length;
    const compacting = s.compact();
    const prompted = s.prompt("t1", "racing");

    expect(await rejection(prompted)).toMatchObject({ code: DomainErrorCode.CompactInProgress });
    await until(() => model.summaries === 1);
    model.releaseSummary();
    expect(await compacting).toMatchObject({ before, after: 1 });
    expect(s.updates.some((u) => u.update.type === "turn_start" && u.update.turnId === "t1")).toBe(
      false,
    );
  });

  test("prompt then compact in the same tick: the turn wins, the compact is rejected", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    const prompted = s.prompt("t1", "racing");
    const compacting = s.compact();

    expect(await rejection(compacting)).toMatchObject({ code: DomainErrorCode.TurnInProgress });
    expect(await prompted).toEqual({ turnId: "t1" });
    expect((await turnEnd(s.updates, "t1")).stopReason).toBe("end_turn");
    expect(model.summaries).toBe(0);
  });

  test("$/cancelRequest on session/compact stops it daemon-side: history untouched, slot freed", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const before = await s.history();
    const controller = new AbortController();
    const compacting = s.client.request(
      "session/compact",
      { sessionId: s.sessionId },
      { signal: controller.signal },
    );
    await until(() => model.summaries === 1);

    controller.abort();
    await rejection(compacting);
    await tick();
    // The provider ignores the signal: its summary still lands, and must not apply.
    model.releaseSummary();
    await tick();

    expect(await s.history()).toEqual(before);
    expect((await runTurn(s.client, s.updates, s.sessionId, "again", "t1")).stopReason).toBe(
      "end_turn",
    );
  });

  test("a retried turnId while compacting gets its cached outcome, not CompactInProgress", async () => {
    const model = new CompactProvider();
    const s = await setup(model);
    await runTurn(s.client, s.updates, s.sessionId, "hello", "t0");
    const compacting = s.compact();
    await until(() => model.summaries === 1);

    expect(await s.prompt("t0", "hello")).toMatchObject({
      turnId: "t0",
      ended: { stopReason: "end_turn" },
    });

    model.releaseSummary();
    await compacting;
  });
  test("a compact whose signal is already aborted is Cancelled before any model call", async () => {
    const model = new CompactProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);
    session.messages.push({ role: "user", content: "hi" });
    const hosted = new HostedSession("s1", session, new PermissionBroker());
    const controller = new AbortController();
    controller.abort();

    expect(await rejection(hosted.compact(controller.signal))).toMatchObject({
      code: DomainErrorCode.Cancelled,
    });
    expect(model.summaries).toBe(0);
    expect(hosted.running).toBe(false);
  });
});
