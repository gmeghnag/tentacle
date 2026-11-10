/**
 * 6a-2 core half (docs/feat/subagent-background-ui.md, Design 2): `AgentJobs`
 * grows the visible state of a child (`rows`, `progress`, `onChange`) and
 * `kill`, so the model can stop one. The class stays pure: the only clock is
 * the host's (never its own), and no listener or callback may let a throw
 * escape (Bun 1.4.3 exits the process on an unhandled rejection, LOW-1).
 */
import { describe, expect, test } from "bun:test";
import {
  type AgentJobExit,
  type AgentJobHost,
  type AgentJobResult,
  type AgentJobSpec,
  AgentJobs,
  type ToolProgressEvent,
} from "@tentacle/core";

const spec = (description = "map repo"): AgentJobSpec => ({
  callId: "c1",
  agentType: "general",
  description,
});
const result = (report = "R", stopReason = "end_turn"): AgentJobResult => ({
  report,
  toolUses: 2,
  stopReason,
});
const tick = () => new Promise((r) => setTimeout(r, 1));

function rig(cap = 2, now?: () => number) {
  let n = 0;
  const ends: string[] = [];
  const host: AgentJobHost = {
    launched: () => {
      n += 1;
      return `sa-${n}`;
    },
    ended: (id, stopReason) => ends.push(`${id}:${stopReason}`),
    ...(now ? { now } : {}),
  };
  const jobs = new AgentJobs(cap);
  jobs.bind(host);
  const exits: AgentJobExit[] = [];
  jobs.onExit((e) => exits.push(e));
  return { jobs, exits, ends };
}

function gated(r = result()) {
  const gate = Promise.withResolvers<AgentJobResult>();
  let signal: AbortSignal | undefined;
  const events: ToolProgressEvent[] = [];
  return {
    run: async (c: { signal: AbortSignal }) => {
      signal = c.signal;
      return gate.promise;
    },
    done: (override?: AgentJobResult) => gate.resolve(override ?? r),
    get signal() {
      return signal;
    },
    events,
  };
}

const tool = (label: string): ToolProgressEvent => ({ kind: "subagent_tool", label });
const usage = (promptTokens: number, completionTokens: number): ToolProgressEvent => ({
  kind: "subagent_usage",
  promptTokens,
  completionTokens,
});

describe("AgentJobs.progress + rows (6a-2)", () => {
  test("a running child's row carries its spec, state, tool uses, tokens and the last 8 labels", async () => {
    const { jobs } = rig(2, () => 7000);
    const g = gated();
    jobs.start(spec("map repo"), g.run);
    // A fresh child: no label, no token, `running`.
    expect(jobs.rows()).toEqual([
      {
        id: "sa-1",
        callId: "c1",
        agentType: "general",
        description: "map repo",
        state: "running",
        toolUses: 0,
        tokens: 0,
        startedAt: 7000,
        tail: [],
      },
    ]);
    for (let i = 1; i <= 10; i++) {
      jobs.progress("sa-1", tool(`t${i}`));
    }
    jobs.progress("sa-1", usage(100, 20));
    jobs.progress("sa-1", usage(3, 4));
    const row = jobs.rows()[0];
    expect(row?.toolUses).toBe(10);
    // The child's own tokens, summed across its model calls.
    expect(row?.tokens).toBe(127);
    // Oldest first, the last 8 only: a long turn cannot grow a row without bound.
    expect(row?.tail).toEqual(["t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
    g.done();
    await tick();
    // Ended: no row at all (the list is the live state, not a history).
    expect(jobs.rows()).toEqual([]);
  });

  test("startedAt comes from the host's clock, never the class's: 0 without one", async () => {
    const noClock = rig(1);
    noClock.jobs.start(spec(), gated().run);
    expect(noClock.jobs.rows()[0]?.startedAt).toBe(0);
    const clocked = rig(1, () => 4242);
    clocked.jobs.start(spec(), gated().run);
    expect(clocked.jobs.rows()[0]?.startedAt).toBe(4242);
  });

  test("progress for an unknown or ended child is a no-op, never a throw", async () => {
    const { jobs } = rig(1);
    expect(() => jobs.progress("sa-9", tool("x"))).not.toThrow();
    const g = gated();
    jobs.start(spec(), g.run);
    g.done();
    await tick();
    expect(() => jobs.progress("sa-1", tool("late"))).not.toThrow();
    expect(jobs.rows()).toEqual([]);
  });

  test("onChange fires on start, on every progress, and at the end; it stops after dispose", async () => {
    const { jobs } = rig(1);
    const seen: string[] = [];
    const stop = jobs.onChange(() => seen.push(`${jobs.rows().length}`));
    const g = gated();
    jobs.start(spec(), g.run);
    jobs.progress("sa-1", tool("a"));
    jobs.progress("sa-1", usage(1, 1));
    g.done();
    await tick();
    expect(seen).toEqual(["1", "1", "1", "0"]);
    stop();
    jobs.start(spec(), gated().run);
    expect(seen).toHaveLength(4);
    const after = rig(1);
    after.jobs.onChange(() => seen.push("disposed"));
    after.jobs.dispose();
    expect(seen).not.toContain("disposed");
  });

  test("a throwing onChange or progress listener loses nothing and escapes nothing", async () => {
    // Bun 1.4.3 EXITS on an unhandled rejection and the repo has no global
    // handler: `progress` is called from inside the child's run, so a throw
    // there would take down the process mid-turn.
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { jobs, exits } = rig(1);
      jobs.onChange(() => {
        throw new Error("listener down");
      });
      const gate = Promise.withResolvers<AgentJobResult>();
      jobs.start(spec(), async () => gate.promise);
      expect(() => jobs.progress("sa-1", tool("a"))).not.toThrow();
      gate.resolve(result());
      await tick();
      await Bun.sleep(25);
      expect(unhandled).toEqual([]);
      // The other listeners still ran: the exit reached them.
      expect(exits).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("AgentJobs.kill (6a-2, owner Q1 a)", () => {
  test("kills exactly the named child, whose exit is `cancelled`; the others run on", async () => {
    const { jobs, exits, ends } = rig(2);
    const first = gated();
    const second = gated();
    jobs.start(spec("one"), first.run);
    jobs.start(spec("two"), second.run);
    expect(jobs.kill("sa-1")).toBe(true);
    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    first.done(result("stopped", "end_turn")); // the runner may report its own end
    await tick();
    // Whatever the run said, a killed child's exit is `cancelled`: the user stopped it.
    expect(exits.map((e) => `${e.agentId}:${e.stopReason}`)).toEqual(["sa-1:cancelled"]);
    expect(ends).toEqual(["sa-1:cancelled"]);
    expect(jobs.rows().map((r) => r.id)).toEqual(["sa-2"]);
    second.done();
    await tick();
  });

  test("a second kill, and one for an unknown child, say not running", async () => {
    const { jobs } = rig(1);
    const g = gated();
    jobs.start(spec(), g.run);
    expect(jobs.kill("sa-1")).toBe(true);
    expect(jobs.kill("sa-1")).toBe(false);
    expect(jobs.kill("sa-404")).toBe(false);
    g.done();
    await tick();
    expect(jobs.kill("sa-1")).toBe(false);
  });

  test("a killed child still frees its slot: the next launch is admitted", async () => {
    const { jobs } = rig(1);
    const g = gated();
    jobs.start(spec(), g.run);
    expect(jobs.start(spec("next"), async () => result()).ok).toBe(false);
    jobs.kill("sa-1");
    g.done();
    await tick();
    expect(jobs.start(spec("next"), async () => result()).ok).toBe(true);
  });
});

describe("the refusal offers agent_control only when it can help (owner Q1 a + LOW-2)", () => {
  test("a background child running: the text offers stopping one with agent_control", async () => {
    const { jobs } = rig(1);
    const g = gated();
    jobs.start(spec("bg one"), g.run);
    const refused = jobs.acquire("fg one");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("sa-1 (bg one)");
      // The model can now end the run by stopping the child.
      expect(refused.reason).toContain("agent_control");
      expect(refused.reason).toContain("end your turn");
    }
    g.done();
    await tick();
  });

  test("foreground holders alone: neither 'end your turn' nor agent_kill (LOW-2 stays)", () => {
    const { jobs } = rig(1);
    expect(jobs.acquire("fg one").ok).toBe(true);
    const refused = jobs.acquire("fg two");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // Ending the turn wakes nobody, and agent_control cannot stop a foreground
      // call: both would be lies.
      expect(refused.reason).not.toContain("end your turn");
      expect(refused.reason).not.toContain("agent_control");
      expect(refused.reason).toContain("Retry when the running foreground sub-agents return");
    }
  });
});
