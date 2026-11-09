/**
 * 6a-2 client half (docs/feat/subagent-background-ui.md Design 4): the live list
 * of background sub-agents, kept per session like the queue, and BOUNDED here —
 * a pod's daemon is not trusted, so the client cuts the row count and every
 * label (`progressText`) before anything renders it.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type AgentJobs,
  AgentJobs as AgentJobsClass,
  type BackgroundJob,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import type { SubagentRow } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient, type SessionSubagentsNotice } from "../src/remote-client.ts";
import { boundSubagents, subagentsFromSnapshot } from "../src/subagents.ts";

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
  onExit(): () => void {
    return () => {};
  }
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function row(i: number, extra: Partial<SubagentRow> = {}): SubagentRow {
  return {
    id: `sa-${i}`,
    callId: `c${i}`,
    agentType: "general",
    description: `d${i}`,
    state: "running",
    toolUses: i,
    tokens: i * 10,
    startedAt: i,
    tail: [`t${i}`],
    ...extra,
  };
}

describe("T46: rows are bounded and sanitized at the client", () => {
  test("at most 32 rows, kept in launch order", () => {
    const many = Array.from({ length: 40 }, (_, i) => row(i + 1));
    const bounded = boundSubagents(many);
    expect(bounded).toHaveLength(32);
    expect(bounded[0]?.id).toBe("sa-1");
    expect(bounded.at(-1)?.id).toBe("sa-32");
    // A hostile list of 10 000 is cut the same way, cheaply.
    const huge = Array.from({ length: 10_000 }, (_, i) => row(i + 1));
    expect(boundSubagents(huge)).toHaveLength(32);
  });

  test("every string is one line through progressText; a tail keeps its last 8", () => {
    const hostile = row(1, {
      description: "a\nb\u0000c\u001b[31m",
      state: "running\n",
      agentType: "general\t",
      tail: Array.from({ length: 12 }, (_, i) => `t${i}\u0007`),
    });
    const [clean] = boundSubagents([hostile]);
    expect(clean?.description.includes("\n")).toBe(false);
    expect(clean?.description.includes("\u0000")).toBe(false);
    expect(clean?.state).toBe("running");
    expect(clean?.agentType).toBe("general");
    expect(clean?.tail).toHaveLength(8);
    // The LAST 8: the recent work, not the start of a long turn.
    expect(clean?.tail[0]).toBe("t4");
    expect(clean?.tail.at(-1)).toBe("t11");
  });

  test("a very long label is cut, with an ellipsis, not truncated silently", () => {
    const [clean] = boundSubagents([row(1, { description: "x".repeat(5000) })]);
    expect(clean?.description.length).toBeLessThanOrEqual(200);
    expect(clean?.description.endsWith("…")).toBe(true);
  });

  test("the numbers are kept as they came (a meter is not a guess)", () => {
    const [clean] = boundSubagents([row(7)]);
    expect(clean).toMatchObject({ toolUses: 7, tokens: 70, startedAt: 7 });
  });

  test("a snapshot's list goes through the same bounding; absent stays undefined", () => {
    const many = Array.from({ length: 40 }, (_, i) => row(i + 1));
    expect(subagentsFromSnapshot(many)).toHaveLength(32);
    expect(subagentsFromSnapshot(undefined)).toBeUndefined();
    expect(subagentsFromSnapshot([])).toEqual([]);
  });
});

function rig() {
  const jobs = new FakeJobs();
  const runtimes: AgentJobs[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/subagents-client",
    createAgent: () => {
      const agentJobs = new AgentJobsClass(4);
      runtimes.push(agentJobs);
      return {
        agent: new Agent({
          model: quiet,
          tools: new ToolRegistry(),
          env: noopEnv,
          jobs,
          agentJobs,
        }),
        permissions: new PermissionBroker(),
        jobs,
        agentJobs,
      };
    },
  });
  const clients: RemoteClient[] = [];
  const dial = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };
  const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
    channelFactory: async () => dial(),
    random: () => 0,
  });
  clients.push(client);
  const sid = () =>
    [...(host as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0] ?? "";
  return {
    runtimes,
    client,
    sid,
    host,
    close: () => {
      for (const c of clients) c.close();
    },
  };
}

const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("T46b: the session's listeners see the live list", () => {
  test("onSubagents gives the state at once and then every change; onSessionSubagents fans out", async () => {
    const r = rig();
    await r.client.initialize();
    const session = r.client.newSession();
    const turnDone = drain(session.send("hello"));
    await until(() => r.sid() !== "");
    // No report yet (as `queued`): nothing is given, never a guess. A daemon
    // that reports an empty list gives one at once; this one has sent no frame.
    const seen: string[][] = [];
    session.onSubagents((rows) => seen.push(rows.map((x) => x.id)));
    expect(seen).toEqual([]);
    expect(session.subagents).toBeUndefined();
    const notices: SessionSubagentsNotice[] = [];
    r.client.onSessionSubagents((n) => notices.push(n));
    const runtime = r.runtimes[0];
    expect(runtime).toBeDefined();
    if (runtime === undefined) return;
    const stopped = Promise.withResolvers<void>();
    runtime.start(
      { callId: "c1", agentType: "general", description: "map repo" },
      async (ctl) =>
        new Promise((resolve) => {
          ctl.signal.addEventListener("abort", () => {
            stopped.resolve();
            resolve({ report: "", toolUses: 0, stopReason: "cancelled" });
          });
        }),
    );
    await until(() => seen.at(-1)?.length === 1);
    expect(seen.at(-1)).toEqual(["sa-1"]);
    expect(notices.at(-1)?.sessionId).toBe(r.sid());
    expect(notices.at(-1)?.rows.map((x) => x.id)).toEqual(["sa-1"]);
    expect(session.subagents?.map((x) => x.id)).toEqual(["sa-1"]);
    expect(runtime.kill("sa-1")).toBe(true);
    await until(() => seen.at(-1)?.length === 0);
    expect(r.client.subagentsOf(r.sid())).toEqual([]);
    stopped.resolve();
    await turnDone;
    r.close();
  });

  test("a second client attaching mid-run gets the list from the snapshot at the cut", async () => {
    // The "another TUI attaches mid-run" failure mode: the frames it missed are
    // behind its cut, so the snapshot's first page must carry the live list.
    const r = rig();
    await r.client.initialize();
    const first = r.client.newSession();
    const turnDone = drain(first.send("hello"));
    await until(() => r.sid() !== "");
    const runtime = r.runtimes[0];
    if (runtime === undefined) return;
    const stopped = Promise.withResolvers<void>();
    runtime.start(
      { callId: "c1", agentType: "general", description: "map repo" },
      async (ctl) =>
        new Promise((resolve) => {
          ctl.signal.addEventListener("abort", () => {
            stopped.resolve();
            resolve({ report: "", toolUses: 0, stopReason: "cancelled" });
          });
        }),
    );
    await until(() => runtime.rows().length === 1);
    // A SECOND client, dialling fresh: it reads the snapshot, never the frame.
    const dial = () => {
      const [d, c] = createChannelPair();
      new Connection(d, r.host);
      return c;
    };
    const second = new RemoteClient(dial(), new PermissionBroker(), undefined, {
      channelFactory: async () => dial(),
      random: () => 0,
    });
    await second.initialize();
    await second.openSession(undefined, undefined, r.sid());
    expect(second.subagentsOf(r.sid())?.map((x) => x.id)).toEqual(["sa-1"]);
    second.close();
    runtime.kill("sa-1");
    stopped.resolve();
    await turnDone;
    r.close();
  });
});
