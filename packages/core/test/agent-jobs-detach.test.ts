import { describe, expect, test } from "bun:test";
import {
  type AgentJobExit,
  type AgentJobHost,
  type AgentJobLive,
  type AgentJobResult,
  type AgentJobSpec,
  AgentJobs,
} from "@tentacle/core";

// docs/feat/subagent-detach.md T1-T5: a foreground child's slot becomes MOVABLE
// (its `move` is `agent_task`'s), and `adopt` exchanges that slot for a running
// entry in one synchronous stretch — no cap check (F8: a detach never fails).

const spec = (description = "map repo"): AgentJobSpec => ({
  callId: "c1",
  agentType: "general",
  description,
});
const result = (report = "R"): AgentJobResult => ({ report, toolUses: 2, stopReason: "end_turn" });
const tick = () => new Promise((r) => setTimeout(r, 1));
const live = (toolUses = 0, tokens = 0, tail: string[] = []): AgentJobLive => ({
  toolUses,
  tokens,
  tail,
});

function rig(cap = 2, now?: () => number) {
  const log: string[] = [];
  let n = 0;
  const host: AgentJobHost = {
    launched: (s) => {
      n += 1;
      log.push(`launched:${s.description}`);
      return `sa-${n}`;
    },
    ended: (id, stopReason, report) => log.push(`ended:${id}:${stopReason}:${report.length}`),
    ...(now ? { now } : {}),
  };
  const jobs = new AgentJobs(cap);
  jobs.bind(host);
  const exits: AgentJobExit[] = [];
  jobs.onExit((e) => {
    log.push(`exit:${e.agentId}`);
    exits.push(e);
  });
  return { jobs, log, exits };
}

/** A slot that must have been granted (the rig's cap always has room here). */
function slotOf(jobs: AgentJobs, description = "fg") {
  const slot = jobs.acquire(description);
  if (!slot.ok) throw new Error(`no slot: ${slot.reason}`);
  return slot;
}

describe("T1: adopt exchanges a slot for a running entry, at any cap", () => {
  test("a full cap never refuses a detach; `used` is unchanged, a new spawn still is refused", async () => {
    const { jobs, log } = rig(1);
    const slot = slotOf(jobs, "map repo");
    // Cap 1, one foreground holder: the runtime is full.
    expect(jobs.start(spec("second"), async () => result()).ok).toBe(false);
    const gate = Promise.withResolvers<AgentJobResult>();
    const controller = new AbortController();
    const id = slot.adopt(spec("map repo"), controller, live(), async () => gate.promise);
    expect(id).toBe("sa-1");
    expect(log).toEqual(["launched:map repo"]);
    // One slot out, one entry in: the cap is exactly as full as it was.
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(jobs.start(spec("third"), async () => result()).ok).toBe(false);
    // Released afterwards anyway (the tool's `finally`): the entry still counts.
    slot.release();
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(jobs.start(spec("fourth"), async () => result()).ok).toBe(false);
    gate.resolve(result());
    await tick();
  });
});

describe("T2: detachForeground", () => {
  test("calls each registered move once; a second call does nothing", () => {
    const { jobs, log } = rig(3);
    const a = slotOf(jobs, "a");
    const b = slotOf(jobs, "b");
    let movedA = 0;
    let movedB = 0;
    a.movable(() => {
      movedA += 1;
      a.adopt(spec("a"), new AbortController(), live(), async () => result());
    });
    b.movable(() => {
      movedB += 1;
      b.adopt(spec("b"), new AbortController(), live(), async () => result());
    });
    jobs.detachForeground();
    expect([movedA, movedB]).toEqual([1, 1]);
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1", "sa-2"]);
    expect(log.filter((l) => l.startsWith("launched"))).toHaveLength(2);
    // Both left `foreground`: only a child still foreground can move.
    jobs.detachForeground();
    expect([movedA, movedB]).toEqual([1, 1]);
  });

  test("a slot with no move (a one-shot, a child that does not opt in) is left alone", () => {
    const { jobs, log } = rig(1);
    slotOf(jobs, "plain");
    jobs.detachForeground();
    expect(log).toEqual([]);
    // Still holding its slot: the cap is still taken.
    expect(jobs.acquire("later").ok).toBe(false);
  });
});

describe("T3: a throwing move or launch never takes the others down", () => {
  test("a throwing move does not lose the next one", () => {
    const { jobs } = rig(3);
    const a = slotOf(jobs, "a");
    const b = slotOf(jobs, "b");
    a.movable(() => {
      throw new Error("boom");
    });
    b.movable(() => {
      b.adopt(spec("b"), new AbortController(), live(), async () => result());
    });
    expect(() => jobs.detachForeground()).not.toThrow();
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);
  });

  test("a throwing `launched` leaves the child in foreground, with no id consumed", () => {
    let calls = 0;
    const jobs = new AgentJobs(1);
    jobs.bind({
      launched: () => {
        calls += 1;
        throw new Error("the log refused");
      },
      ended: () => {},
    });
    const slot = slotOf(jobs, "map repo");
    let adopted: string | undefined = "not-run";
    slot.movable(() => {
      adopted = slot.adopt(spec(), new AbortController(), live(), async () => ({ ...OK }));
    });
    jobs.detachForeground();
    expect(calls).toBe(1);
    // The throw escaped `adopt` before it returned: no id was handed out.
    expect(adopted).toBe("not-run");
    expect(jobs.list()).toEqual([]);
    // The slot is still held: nothing half-moved.
    expect(jobs.acquire("later").ok).toBe(false);
    // And a second detach tries again (it is still foreground, still movable).
    jobs.detachForeground();
    expect(calls).toBe(2);
  });
});

const OK = result();

describe("T4: adopt refuses once the slot is gone", () => {
  test("after release: undefined, and no id is minted", () => {
    const { jobs, log } = rig(2);
    const slot = slotOf(jobs);
    slot.release();
    expect(slot.adopt(spec(), new AbortController(), live(), async () => result())).toBeUndefined();
    expect(log).toEqual([]);
    expect(jobs.list()).toEqual([]);
  });

  test("after dispose: undefined, no id minted", () => {
    const { jobs, log } = rig(2);
    const slot = slotOf(jobs);
    jobs.dispose();
    expect(slot.adopt(spec(), new AbortController(), live(), async () => result())).toBeUndefined();
    expect(log).toEqual([]);
  });

  test("no host bound: undefined (a one-shot has no ledger to write)", () => {
    const jobs = new AgentJobs(2);
    const slot = slotOf(jobs);
    expect(slot.adopt(spec(), new AbortController(), live(), async () => result())).toBeUndefined();
    expect(jobs.list()).toEqual([]);
  });

  test("movable on a slot that was released registers nothing", () => {
    const { jobs } = rig(2);
    const slot = slotOf(jobs);
    slot.release();
    let moved = 0;
    slot.movable(() => {
      moved += 1;
    });
    jobs.detachForeground();
    expect(moved).toBe(0);
  });
});

describe("T5: an adopted child is a normal background child", () => {
  test("its row carries the seed and the SLOT's startedAt; one `ended`, one exit", async () => {
    const { jobs, log, exits } = rig(2, () => 777);
    const slot = slotOf(jobs, "map repo");
    const gate = Promise.withResolvers<AgentJobResult>();
    const controller = new AbortController();
    const id = slot.adopt(
      { callId: "c9", agentType: "explore", description: "map repo" },
      controller,
      live(3, 120, ["Read a.ts", "Read b.ts"]),
      async () => gate.promise,
    );
    expect(id).toBe("sa-1");
    const row = jobs.rows()[0];
    expect(row).toMatchObject({
      id: "sa-1",
      callId: "c9",
      agentType: "explore",
      description: "map repo",
      state: "running",
      toolUses: 3,
      tokens: 120,
      startedAt: 777,
      tail: ["Read a.ts", "Read b.ts"],
    });
    // A progress event of the child goes on folding into that row.
    jobs.progress("sa-1", { kind: "subagent_tool", label: "Read c.ts" });
    expect(jobs.rows()[0]?.tail).toEqual(["Read a.ts", "Read b.ts", "Read c.ts"]);
    gate.resolve(result("THE REPORT"));
    await tick();
    expect(log).toEqual(["launched:map repo", "ended:sa-1:end_turn:10", "exit:sa-1"]);
    expect(exits[0]?.report).toBe("THE REPORT");
    expect(jobs.rows()).toEqual([]);
  });

  test("the slot's startedAt is the host clock at acquire", () => {
    let t = 1000;
    const { jobs } = rig(2, () => t);
    const slot = slotOf(jobs);
    t = 2500;
    slot.adopt(spec(), new AbortController(), live(), async () => result());
    expect(jobs.rows()[0]?.startedAt).toBe(1000);
  });
});
