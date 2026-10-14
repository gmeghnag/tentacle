import { describe, expect, test } from "bun:test";
import { Agent } from "@agent-harness/agent";
import { RemoteClient } from "@agent-harness/client";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@agent-harness/core";
import { PermissionBroker } from "@agent-harness/core";
import { Connection, ProxyModelProvider, SessionHost } from "@agent-harness/daemon";
import { ToolRegistry } from "@agent-harness/tools";
import { createChannelPair } from "@agent-harness/transport";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request);
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

describe("model reverse-tunnel (F4.d)", () => {
  test("the daemon's ProxyModelProvider runs the model on the client over RPC", async () => {
    const [daemonCh, clientCh] = createChannelPair();

    // The "pod": a daemon whose agent has NO local model — only the proxy, which
    // tunnels calls back to the client over the connection. Built BEFORE the
    // client handshakes, so the daemon is there to answer `initialize`.
    // Annotated `let` (not const) to break the type cycle: the createAgent
    // closure references `connection`, which is assigned just below; it only
    // reads it when a session is created, by which point it is set.
    // biome-ignore lint/style/useConst: assigned after the closure that references it
    let connection: Connection;
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({
          model: new ProxyModelProvider((request) => connection.requestModelStream(request)),
          tools: new ToolRegistry(),
          env: noopEnv,
        }),
        permissions: new PermissionBroker(),
      }),
    });
    connection = new Connection(daemonCh, host);

    // The "laptop": a client holding the real (scripted) model.
    const localModel = new ScriptedProvider([
      [{ type: "text", delta: "answer from the laptop model" }, { type: "done" }],
    ]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), localModel);
    await client.initialize();

    // Drive a turn from the client; the text must have come from the local model.
    const session = client.newSession();
    let text = "";
    for await (const event of session.send("ping")) {
      if (event.type === "text") {
        text += event.delta;
      }
    }

    expect(text).toContain("answer from the laptop model");
    // The model actually ran on the client side (its request was recorded there),
    // and it saw the pod's user message.
    expect(localModel.seen).toHaveLength(1);
    expect(localModel.seen[0]?.messages.at(-1)).toEqual({ role: "user", content: "ping" });

    connection.close();
    client.close();
  });
});
