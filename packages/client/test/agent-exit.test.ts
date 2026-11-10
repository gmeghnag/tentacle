/**
 * 6a-1 client half (docs/feat/subagent-background.md D7): a sub-agent's exit
 * has its own listener (never the shell-exit backlog), and `ownsTurn` outlives
 * the turn so a background child's ask is still "own" after its spawning turn.
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
  onStart(): () => void {
    return () => {};
  }
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
  const runtimes: AgentJobs[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/agent-exit-client",
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
  const finishChild = (description: string, which = 0) =>
    runtimes[which]?.start({ callId: "c", agentType: "general", description }, async () => ({
      report: "R",
      toolUses: 2,
      stopReason: "end_turn",
    }));
  return { jobs, dial, close, finishChild };
}

const drain = async (events: AsyncIterable<SessionEvent>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

describe("T36: onAgentExit", () => {
  test("fires for a sub-agent exit only, and subscribing leaves the exit backlog working", async () => {
    const r = rig();
    const c = await r.dial();
    const session = c.newSession(undefined, "S");
    await drain(session.send("hello"));
    const fired: string[] = [];
    const stop = session.onAgentExit(() => fired.push("agent"));
    // A shell exit never reaches the agent listener.
    r.jobs.fire("j1");
    await tick();
    expect(fired).toEqual([]);
    // A sub-agent's exit does.
    r.finishChild("map repo");
    await tick();
    expect(fired).toEqual(["agent"]);
    stop();
    // The agent listener is NOT a background-exit subscriber: the backlog still
    // holds both exits for the first real one (the TUI that mounts later).
    const notices: BackgroundExitNotice[] = [];
    c.onBackgroundExit((n) => notices.push(n));
    expect(notices.map((n) => n.jobId)).toEqual(["j1", "sa-1"]);
    expect(notices[1]?.agent).toEqual({ stopReason: "end_turn", toolUses: 2 });
    expect(notices[0]?.agent).toBeUndefined();
    r.close();
  });

  test("filtered by session: another session's child does not fire this one", async () => {
    const r = rig();
    const c = await r.dial();
    const a = c.newSession(undefined, "A");
    await drain(a.send("hello"));
    const fired: string[] = [];
    a.onAgentExit(() => fired.push("a"));
    const b = c.newSession(undefined, "B");
    await drain(b.send("hello"));
    void b;
    // The runtime is per session (one factory call each): finish B's child.
    await tick();
    r.finishChild("x", 1); // runtimes[1] is B's
    await tick();
    expect(fired).toEqual([]);
    r.close();
  });
});

describe("T35: ownsTurn outlives the turn, bounded", () => {
  test("an ended own turn is still own; a foreign id is not; the oldest fall off past 256", async () => {
    const r = rig();
    const c = await r.dial();
    const session = c.newSession(undefined, "S");
    await drain(session.send("hello"));
    const first = "turn-first";
    await drain(session.send("hi", undefined, { turnId: first }));
    expect(session.ownsTurn(first)).toBe(true);
    // A LATER turn ran: the first (a spawning turn) is still own, so a background
    // child's ask that names it is still auto-accepted.
    await drain(session.send("again", undefined, { turnId: "turn-second" }));
    expect(session.ownsTurn(first)).toBe(true);
    expect(session.ownsTurn("someone-elses")).toBe(false);
    for (let i = 0; i < 260; i++) {
      await drain(session.send("hi", undefined, { turnId: `turn-${i}` }));
    }
    expect(session.ownsTurn("turn-259")).toBe(true);
    expect(session.ownsTurn(first)).toBe(false); // dropped: bounded
    r.close();
  });
});
