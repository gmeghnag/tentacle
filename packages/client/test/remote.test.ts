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
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";
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
