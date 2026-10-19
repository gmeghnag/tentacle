import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import type { EnqueueResult, SessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { DomainErrorCode } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { HostedSession } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

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

const INIT = { protocolVersion: 1, clientCapabilities: { streaming: true } };
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A daemon-side `SessionHost` plus a connected client `RpcPeer`. */
function harness(
  model: ModelProvider,
  env: ExecutionEnvironment,
  clientHandlers: ConstructorParameters<typeof RpcPeer>[1] = {},
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
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host, undefined, connOptions);
  const updates: SessionUpdateParams[] = [];
  const client = new RpcPeer(clientCh, {
    ...clientHandlers,
    onNotification: (method, params) => {
      if (method === "session/update") {
        updates.push(params as SessionUpdateParams);
      }
    },
  });
  return { client, updates, connection };
}

describe("daemon ↔ client (in-memory)", () => {
  test("handshake → new → prompt streams updates and resolves the stop reason", async () => {
    const model = new ScriptedProvider([
      [
        { type: "text", delta: "Hello " },
        { type: "text", delta: "world" },
        { type: "done", usage: { promptTokens: 7, completionTokens: 2 } },
      ],
    ]);
    const { client, updates } = harness(model, noopEnv);

    const init = (await client.request("initialize", INIT)) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(1);

    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
    expect(sessionId).toBeTruthy();

    const result = (await client.request("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "hi" }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");

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
    // Updates are sequence-numbered for replay.
    expect(updates[0]?.seq).toBe(1);
  });

  test("a shell tool round-trips a permission prompt and runs when approved", async () => {
    const execCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(command) {
        execCalls.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls -la" }) },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "done" }, { type: "done" }],
    ]);

    const asked: unknown[] = [];
    const { client, updates } = harness(model, env, {
      onRequest: async (method, params) => {
        if (method === "session/request_permission") {
          asked.push(params);
          return { outcome: { outcome: "selected", optionId: "allow_once" } };
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
    const result = (await client.request("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "run it" }],
    })) as { stopReason: string };

    expect(result.stopReason).toBe("end_turn");
    expect(execCalls).toEqual(["ls -la"]);
    // The daemon asked for permission, carrying the current tool-call id.
    expect(asked).toHaveLength(1);
    expect((asked[0] as { toolCallId: string }).toolCallId).toBe("c1");
    await tick();
    const toolUpdates = updates.filter((u) => u.update.type === "tool_call_update");
    expect(
      toolUpdates.some(
        (u) => u.update.type === "tool_call_update" && u.update.status === "completed",
      ),
    ).toBe(true);
  });

  test("a denied permission blocks the tool and the turn still ends", async () => {
    const execCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(command) {
        execCalls.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "rm -rf /" }) },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { client } = harness(model, env, {
      onRequest: async () => ({ outcome: { outcome: "selected", optionId: "reject_once" } }),
    });
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
    await client.request("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "go" }],
    });
    expect(execCalls).toEqual([]); // never ran
  });

  test("an unanswered permission request times out and auto-denies (turn still ends)", async () => {
    const execCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(command) {
        execCalls.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
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
    // The client receives the permission request but never answers it.
    const { client } = harness(
      model,
      env,
      { onRequest: () => new Promise(() => {}) },
      { permissionTimeoutMs: 30 },
    );
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
    const result = (await client.request("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "go" }],
    })) as { stopReason: string };
    expect(execCalls).toEqual([]); // auto-denied on timeout → tool never ran
    expect(result.stopReason).toBe("end_turn"); // and the turn did not hang
  });

  test("session/new is refused past the per-connection cap", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv, {}, { maxSessions: 1 });
    await client.request("initialize", INIT);
    await client.request("session/new", {}); // the one allowed session
    await expect(client.request("session/new", {})).rejects.toMatchObject({
      code: DomainErrorCode.TooManySessions,
    });
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
    await expect(client.request("session/new", {})).rejects.toMatchObject({
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
    ).rejects.toMatchObject({ code: DomainErrorCode.VersionMismatch });
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

  const steerUpdates = (updates: SessionUpdateParams[]) =>
    updates
      .map((u) => u.update)
      .filter(
        (u): u is Extract<SessionUpdateParams["update"], { type: "steer" }> => u.type === "steer",
      );

  test("session/enqueue mid-turn is served while the prompt is in flight and the model sees it", async () => {
    const model = new EchoSteerProvider();
    const { client, updates } = harness(model, slowEnv, {
      onRequest: async (method) =>
        method === "session/request_permission"
          ? { outcome: { outcome: "selected", optionId: "allow_once" } }
          : {},
    });
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };

    const promptP = client.request("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "go" }],
    });
    let promptSettled = false;
    promptP.then(
      () => {
        promptSettled = true;
      },
      () => {
        promptSettled = true;
      },
    );
    // Wait until the daemon has announced round 1's tool call. The tool's exec
    // is still running (200 ms), so the prompt is genuinely in flight.
    while (!updates.some((u) => u.update.type === "tool_call")) {
      await tick(5);
    }
    expect(promptSettled).toBe(false);
    // Enqueue WITHOUT awaiting the prompt: if the peer serialized requests per
    // connection, this would block until the prompt settled. It resolves on its
    // own — the concurrency the whole mechanism relies on.
    const result = (await client.request("session/enqueue", {
      sessionId,
      text: "steer me",
    })) as EnqueueResult;
    expect(result).toEqual({});
    const stop = (await promptP) as { stopReason: string };
    expect(stop.stopReason).toBe("end_turn");

    // A `steer` update was streamed back with the queued text…
    expect(steerUpdates(updates).map((s) => s.text)).toEqual(["steer me"]);
    // …and the model actually SAW it: round 2 ran as a whole (without the steer
    // the turn would have ended after round 1's tool result) and echoed it.
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages.at(-1)).toBe("steer me");
    const echoed = updates
      .map((u) => u.update)
      .filter(
        (u): u is Extract<SessionUpdateParams["update"], { type: "agent_message_chunk" }> =>
          u.type === "agent_message_chunk",
      )
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
    expect(echoed).toContain("echo:steer me");
  });

  test("two enqueues on the same boundary stream two steer updates in FIFO order", async () => {
    const model = new EchoSteerProvider();
    const { client, updates } = harness(model, slowEnv, {
      onRequest: async (method) =>
        method === "session/request_permission"
          ? { outcome: { outcome: "selected", optionId: "allow_once" } }
          : {},
    });
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };

    const promptP = client.request("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "go" }],
    });
    while (!updates.some((u) => u.update.type === "tool_call")) {
      await tick(5);
    }
    // Both enqueues land on the SAME boundary (before round 2 drains).
    await client.request("session/enqueue", { sessionId, text: "A" });
    await client.request("session/enqueue", { sessionId, text: "B" });
    await promptP;
    // N enqueue ⇒ N echo, in order — the invariant the TUI's FIFO removal relies on.
    expect(steerUpdates(updates).map((s) => s.text)).toEqual(["A", "B"]);
    // The model saw both injected user messages, in order.
    expect(model.calls[1]?.messages.slice(-2)).toEqual(["A", "B"]);
  });

  test("session/enqueue on an unknown session rejects with UnknownSession", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    await expect(
      client.request("session/enqueue", { sessionId: "nope", text: "x" }),
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
      const runningAtNextMacrotask: boolean[] = [];
      const hosted = new HostedSession(
        "s1",
        new Session(agent),
        new PermissionBroker(),
        async () => {
          throw new Error("no permission expected");
        },
      );
      // Patched after construction: `Session.send` calls `agent.runMessages` per turn.
      agent.runMessages = (messages, sessionId, signal, drain) =>
        runMessages(messages, sessionId, signal, () => {
          setTimeout(() => runningAtNextMacrotask.push(hosted.running), 0);
          return drain?.() ?? [];
        });

      expect(await hosted.prompt([{ type: "text", text: "go" }])).toBe(label);
      await tick(5);
      expect(runningAtNextMacrotask.at(-1)).toBe(false);
    });
  }

  test("session/enqueue with no turn running rejects with NoTurnRunning", async () => {
    // Accepting it would be a fake success: the next `send` resets the steering
    // queue, so the text would be dropped silently.
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    const { sessionId } = (await client.request("session/new", {})) as { sessionId: string };
    await expect(
      client.request("session/enqueue", { sessionId, text: "late" }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NoTurnRunning });
  });

  test("prompting an unknown session errors", async () => {
    const { client } = harness(new ScriptedProvider([]), noopEnv);
    await client.request("initialize", INIT);
    await expect(
      client.request("session/prompt", {
        sessionId: "nope",
        content: [{ type: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.UnknownSession });
    expect(JsonRpcErrorCode.InternalError).toBeDefined();
  });
});
