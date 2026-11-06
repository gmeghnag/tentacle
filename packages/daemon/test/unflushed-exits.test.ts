import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { type OpenResult, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

// `session/open` tells an attaching client how many background-job exits no turn
// has flushed (docs/fix/attach-unflushed-exits.md). Mutation: report
// `jobs.list().length` (or never reset) → the "after a turn" leg fails.

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

class Say implements ModelProvider {
  readonly id = "say";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
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

class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read(): undefined {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {}
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(id: string): void {
    for (const l of this.listeners) {
      l({ id, command: "sleep 1", startedAt: 0, status: "exited", exitCode: 0 });
    }
  }
}

function rig() {
  const jobs = new FakeJobs();
  const host = new SessionHost({
    defaultCwd: "/tmp/unflushed-exits",
    createAgent: () => ({
      agent: new Agent({ model: new Say(), tools: new ToolRegistry(), env, jobs }),
      permissions: new PermissionBroker(),
      jobs,
    }),
  });
  const connect = async () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RpcPeer(c, {
      onNotification: () => {},
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<OpenResult>;
    const prompt = (turnId: string, text: string) =>
      client.request("session/prompt", {
        sessionId: "S",
        turnId,
        content: [{ type: "text", text }],
      });
    return { open, prompt };
  };
  return { jobs, connect };
}

describe("session/open reports the exits no turn has flushed", () => {
  test("D-1 absent at 0; counts per exit; every opener sees it; a turn resets it", async () => {
    const r = rig();
    const a = await r.connect();
    expect(await a.open({ sessionId: "S", create: true })).not.toHaveProperty("unflushedExits");
    r.jobs.fire("j1");
    expect((await a.open({ sessionId: "S" })).unflushedExits).toBe(1);
    r.jobs.fire("j2");
    const b = await r.connect();
    expect((await b.open({ sessionId: "S" })).unflushedExits).toBe(2);
    expect((await a.open({ sessionId: "S" })).unflushedExits).toBe(2);
    // A continuation turn flushes them all.
    await a.prompt("t1", "");
    await flush();
    expect(await b.open({ sessionId: "S" })).not.toHaveProperty("unflushedExits");
  });
});
