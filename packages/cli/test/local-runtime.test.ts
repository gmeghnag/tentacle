import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonSessionStore } from "@agent-harness/agent";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@agent-harness/core";
import { PermissionBroker } from "@agent-harness/core";
import { Connection, SessionHost } from "@agent-harness/daemon";
import { ToolRegistry } from "@agent-harness/tools";
import { createChannelPair } from "@agent-harness/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
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

/** A JobController whose exits are fired manually, for testing the live stream. */
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
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(job: BackgroundJob): void {
    for (const listener of this.listeners) {
      listener(job);
    }
  }
}

/** Wire a daemon (SessionHost+Connection) to a client channel over an in-memory pipe. */
function daemon(
  model: ModelProvider,
  jobs?: JobController,
): {
  channel: ReturnType<typeof createChannelPair>[1];
  dispose: () => void;
} {
  const host = new SessionHost({
    defaultCwd: "/tmp/work",
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env: noopEnv }),
      permissions: new PermissionBroker(),
      ...(jobs ? { jobs } : {}),
    }),
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  return { channel: clientCh, dispose: () => connection.close() };
}

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-local-rt-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createLocalRuntime (local over RPC)", () => {
  test("persists the session after a turn, under a stable uid", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "hi back" }, { type: "done" }]]);
    const { channel, dispose } = daemon(model);
    const store = new JsonSessionStore(join(dir, "a"));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      store,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });

    await drain(runtime.createSession().send("hello"));
    // Give the post-turn snapshot/persist a tick to land.
    await new Promise((r) => setTimeout(r, 20));

    const saved = await store.list();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.messages.map((m) => m.content)).toEqual(["hello", "hi back"]);
    expect(saved[0]?.title).toBe("hello");
    runtime.dispose();
  });

  test("streams a daemon background-job exit to the client's jobs view while idle", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const jobs = new FakeJobs();
    const { channel, dispose } = daemon(model, jobs);
    const store = new JsonSessionStore(join(dir, "jobs"));
    const runtime = await createLocalRuntime({
      channel,
      disposeTransport: dispose,
      permissions: new PermissionBroker(),
      store,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });

    const received: BackgroundJob[] = [];
    runtime.jobs.onExit((job) => received.push(job));

    // Open the session + finish its turn, so the daemon has subscribed to jobs.
    await drain(runtime.createSession().send("hi"));
    // Now, with NO turn running (idle), a background job exits on the daemon.
    jobs.fire({
      id: "j1",
      command: "sleep 1",
      startedAt: Date.now(),
      status: "exited",
      exitCode: 0,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(received.map((j) => j.id)).toEqual(["j1"]);
    expect(received[0]?.exitCode).toBe(0);
    expect(received[0]?.status).toBe("exited");
    runtime.dispose();
  });

  test("resumes a saved session: seeds history and keeps the same uid file", async () => {
    const store = new JsonSessionStore(join(dir, "b"));
    // First run creates a session.
    const model1 = new ScriptedProvider([[{ type: "text", delta: "one" }, { type: "done" }]]);
    const d1 = daemon(model1);
    const rt1 = await createLocalRuntime({
      channel: d1.channel,
      disposeTransport: d1.dispose,
      permissions: new PermissionBroker(),
      store,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: null,
    });
    await drain(rt1.createSession().send("first question"));
    await new Promise((r) => setTimeout(r, 20));
    const record = await store.latest();
    expect(record).not.toBeNull();
    rt1.dispose();

    // Second run resumes it.
    const model2 = new ScriptedProvider([[{ type: "text", delta: "two" }, { type: "done" }]]);
    const d2 = daemon(model2);
    const rt2 = await createLocalRuntime({
      channel: d2.channel,
      disposeTransport: d2.dispose,
      permissions: new PermissionBroker(),
      store,
      cwd: "/tmp/work",
      model: "qwen3",
      resume: record,
    });
    await drain(rt2.createSession().send("second question"));
    await new Promise((r) => setTimeout(r, 20));

    // The model saw the resumed history before the new turn.
    expect(model2.requests[0]?.messages.map((m) => m.content)).toEqual([
      "first question",
      "one",
      "second question",
    ]);
    // And it was saved back under the SAME uid (one file, not two).
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(record?.id ?? "");
    rt2.dispose();
  });
});
