import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import type { SessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { DomainErrorCode } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
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
