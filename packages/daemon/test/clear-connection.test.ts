import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { DomainErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

// docs/feat/clear-keeps-jobs.md — T14: `session/clear` is dispatched like any
// short request (AGENTS §7 "Don't serialize the RPC peer"): it is answered
// while a long `session/prompt` is still running, never queued behind it.
// Mutation: `await` anything (a never-resolving promise) before `clear()` in
// `Connection` → the request below never settles and the test times out.

const gate = Promise.withResolvers<void>();
class Gated implements ModelProvider {
  readonly id = "gated";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    await gate.promise;
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

describe("session/clear on the connection (T14)", () => {
  test("is answered (TurnInProgress) while a prompt is running, and works once idle", async () => {
    const host = new SessionHost({
      defaultCwd: "/tmp/clear-connection",
      createAgent: () => ({
        agent: new Agent({ model: new Gated(), tools: new ToolRegistry(), env }),
        permissions: new PermissionBroker(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RpcPeer(c, {
      onNotification: () => {},
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await client.request("session/open", { sessionId: "S", create: true });
    const prompt = client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    // The turn is still gated: this must settle on its own.
    let code: number | undefined;
    try {
      await client.request("session/clear", { sessionId: "S" });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.TurnInProgress);

    gate.resolve();
    await prompt;
    // `session/prompt` answers at the turn's start: clear once it has ended.
    let result: { before: number; after: number } | undefined;
    for (let i = 0; i < 200 && result === undefined; i++) {
      try {
        result = (await client.request("session/clear", { sessionId: "S" })) as {
          before: number;
          after: number;
        };
      } catch {
        await new Promise((r) => setTimeout(r, 2));
      }
    }
    expect(result?.before).toBeGreaterThan(0);
    expect(result?.after).toBe(0);
  });
});
