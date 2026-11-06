/**
 * What a client learns of background-job exits nobody was listening to
 * (docs/fix/attach-unflushed-exits.md): a backlog handed to the first
 * `onBackgroundExit` subscriber, and `unflushedExits()` from the open result.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { type BackgroundExitNotice, RemoteClient } from "../src/remote-client.ts";

const noopEnv = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
} as unknown as ExecutionEnvironment;

const quiet: ModelProvider = {
  id: "quiet",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  },
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

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rig() {
  const jobs = new FakeJobs();
  const host = new SessionHost({
    defaultCwd: "/tmp/unflushed-client",
    createAgent: () => ({
      agent: new Agent({ model: quiet, tools: new ToolRegistry(), env: noopEnv, jobs }),
      permissions: new PermissionBroker(),
      jobs,
    }),
  });
  const clients: RemoteClient[] = [];
  const dial = async (): Promise<RemoteClient> => {
    const make = () => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      return c;
    };
    const c = new RemoteClient(make(), new PermissionBroker(), undefined, {
      channelFactory: async () => make(),
      random: () => 0,
    });
    await c.initialize();
    clients.push(c);
    return c;
  };
  const close = (): void => {
    for (const c of clients) c.close();
  };
  return { jobs, dial, close };
}

const collect = (c: RemoteClient): { notices: BackgroundExitNotice[]; stop: () => void } => {
  const notices: BackgroundExitNotice[] = [];
  const stop = c.onBackgroundExit((n) => notices.push(n));
  return { notices, stop };
};

const drain = async (events: AsyncIterable<SessionEvent>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

describe("the exit backlog", () => {
  test("C-1a exits with no listener reach the first subscriber once, then none", async () => {
    // Mutation: never drain (or never push) → the first leg fails.
    const r = rig();
    const c = await r.dial();
    await c.openSession(undefined, undefined, "S");
    r.jobs.fire("j1");
    r.jobs.fire("j2");
    await tick();
    const first = collect(c);
    expect(first.notices.map((n) => n.jobId)).toEqual(["j1", "j2"]);
    first.stop();
    expect(collect(c).notices).toEqual([]);
    r.close();
  });

  test("C-1b the same jobId twice is one notice", async () => {
    // Mutation: no dedupe → two.
    const r = rig();
    const c = await r.dial();
    await c.openSession(undefined, undefined, "S");
    r.jobs.fire("j1");
    r.jobs.fire("j1");
    await tick();
    expect(collect(c).notices.map((n) => n.jobId)).toEqual(["j1"]);
    r.close();
  });

  test("C-1c the backlog is capped at 64, oldest dropped", async () => {
    // Mutation: no cap → 70.
    const r = rig();
    const c = await r.dial();
    await c.openSession(undefined, undefined, "S");
    for (let i = 0; i < 70; i++) r.jobs.fire(`j${i}`);
    await tick(40);
    const got = collect(c).notices.map((n) => n.jobId);
    expect(got).toHaveLength(64);
    expect(got[0]).toBe("j6");
    expect(got.at(-1)).toBe("j69");
    r.close();
  });

  test("C-1d with a listener present the backlog is untouched", async () => {
    // Mutation: push to the backlog even with a listener → the late subscriber gets j1.
    const r = rig();
    const c = await r.dial();
    await c.openSession(undefined, undefined, "S");
    const live = collect(c);
    r.jobs.fire("j1");
    await tick();
    expect(live.notices.map((n) => n.jobId)).toEqual(["j1"]);
    expect(collect(c).notices).toEqual([]);
    r.close();
  });
});

describe("unflushedExits()", () => {
  test("C-1e follows the open result: 0 → n for a late attacher → 0 after a turn", async () => {
    // Mutation: ignore `result.unflushedExits` → the middle leg fails.
    const r = rig();
    const a = await r.dial();
    await a.openSession(undefined, undefined, "S");
    expect(a.unflushedExits()).toBe(0);
    r.jobs.fire("j1");
    r.jobs.fire("j2");
    const b = await r.dial();
    await b.attachSession("S", { output: () => {}, linkClosed: () => {} } as never);
    expect(b.unflushedExits()).toBe(2);
    await drain(a.newSession(undefined, "S").send(""));
    const c = await r.dial();
    await c.attachSession("S", { output: () => {}, linkClosed: () => {} } as never);
    expect(c.unflushedExits()).toBe(0);
    r.close();
  });
});
