import { describe, expect, test } from "bun:test";
import {
  type AgentJobExit,
  type AgentJobHost,
  type AgentJobResult,
  type AgentJobSpec,
  AgentJobs,
  capSubagentText,
} from "@tentacle/core";
import { SUBAGENT_REPORT_MAX_CHARS } from "@tentacle/protocol";

const spec = (description = "map repo"): AgentJobSpec => ({
  callId: "c1",
  agentType: "general",
  description,
});
const result = (report = "R"): AgentJobResult => ({ report, toolUses: 2, stopReason: "end_turn" });
const tick = () => new Promise((r) => setTimeout(r, 1));

function rig(cap = 2) {
  const log: string[] = [];
  let n = 0;
  const host: AgentJobHost = {
    launched: (s) => {
      n += 1;
      log.push(`launched:${s.description}`);
      return `sa-${n}`;
    },
    ended: (id, stopReason, report) => log.push(`ended:${id}:${stopReason}:${report.length}`),
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

/** A run that settles when the returned `done` is called. */
function gated(r = result()) {
  const gate = Promise.withResolvers<AgentJobResult>();
  let signal: AbortSignal | undefined;
  return {
    run: async (c: { signal: AbortSignal }) => {
      signal = c.signal;
      return gate.promise;
    },
    done: () => gate.resolve(r),
    fail: (e: unknown) => gate.reject(e),
    get signal() {
      return signal;
    },
  };
}

describe("AgentJobs.start", () => {
  test("below the cap launches once, lists it, and gives the run a live signal", async () => {
    const { jobs, log } = rig();
    const g = gated();
    const started = jobs.start(spec(), g.run);
    expect(started).toEqual({ ok: true, agentId: "sa-1" });
    expect(log).toEqual(["launched:map repo"]);
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(g.signal?.aborted).toBe(false);
    g.done();
    await tick();
  });

  test("over the cap refuses naming the running ids and descriptions; nothing launched", async () => {
    const { jobs, log } = rig(1);
    const g = gated();
    jobs.start(spec("first"), g.run);
    let ran = false;
    const refused = jobs.start(spec("second"), async () => {
      ran = true;
      return result();
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("sa-1 (first)");
      expect(refused.reason).toContain("subagents.maxParallel = 1");
      expect(refused.reason).not.toContain("foreground");
      expect(refused.reason).not.toContain("agent_kill");
    }
    expect(ran).toBe(false);
    expect(log).toEqual(["launched:first"]);
    g.done();
    await tick();
  });

  test("no host: refused, the run never starts", () => {
    const jobs = new AgentJobs(2);
    let ran = false;
    const r = jobs.start(spec(), async () => {
      ran = true;
      return result();
    });
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test("ended comes before the exit listeners; the report is capped; an empty one becomes a placeholder", async () => {
    const { jobs, log, exits } = rig();
    const big = "x".repeat(SUBAGENT_REPORT_MAX_CHARS + 500);
    jobs.start(spec("a"), async () => result(big));
    jobs.start(spec("b"), async () => result("   "));
    await tick();
    const order = log.filter((l) => l.startsWith("ended") || l.startsWith("exit"));
    expect(order[0]?.startsWith("ended:sa-1")).toBe(true);
    expect(order[1]).toBe("exit:sa-1");
    expect(order[2]?.startsWith("ended:sa-2")).toBe(true);
    expect(exits[0]?.report.length).toBeLessThanOrEqual(SUBAGENT_REPORT_MAX_CHARS);
    expect(exits[0]?.report).toBe(capSubagentText(big, SUBAGENT_REPORT_MAX_CHARS));
    // The host got the same capped text as the listener (the note and the log agree).
    expect(log).toContain(`ended:sa-1:end_turn:${exits[0]?.report.length}`);
    expect(exits[1]?.report).toBe("(the sub-agent produced no output)");
    expect(jobs.list()).toEqual([]);
  });

  test("a throwing run ends as an error and frees the slot; a throwing listener loses no other", async () => {
    const { jobs, exits } = rig(1);
    const seen: string[] = [];
    jobs.onExit(() => {
      throw new Error("bad listener");
    });
    jobs.onExit((e) => seen.push(e.agentId));
    jobs.start(spec(), async () => {
      throw new Error("boom");
    });
    await tick();
    expect(exits[0]?.stopReason).toBe("error");
    expect(exits[0]?.report).toContain("boom");
    expect(seen).toEqual(["sa-1"]);
    expect(jobs.start(spec("again"), async () => result()).ok).toBe(true);
    await tick();
  });

  test("dispose aborts every child, writes no ended and emits no exit", async () => {
    const { jobs, log } = rig();
    const g = gated();
    jobs.start(spec(), g.run);
    jobs.dispose();
    expect(g.signal?.aborted).toBe(true);
    g.done();
    await tick();
    expect(log).toEqual(["launched:map repo"]);
    expect(jobs.start(spec("late"), async () => result()).ok).toBe(false);
  });
});

describe("AgentJobs.acquire (a foreground child)", () => {
  test("below the cap it takes a slot; at the cap it is refused naming the running children; no slot leaks", async () => {
    const { jobs, log } = rig(2);
    const g = gated();
    jobs.start(spec("bg one"), g.run);
    const fg = jobs.acquire("fg one");
    expect(fg.ok).toBe(true);
    const refused = jobs.acquire("fg two");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain("sa-1 (bg one)");
      expect(refused.reason).toContain("fg one");
      expect(refused.reason).toContain("subagents.maxParallel = 2");
      expect(refused.reason).toContain("end your turn");
      expect(refused.reason).not.toContain("agent_kill");
      expect(refused.reason).not.toContain("run it in the foreground");
    }
    // The refused try left nothing behind: a release frees exactly one slot.
    if (fg.ok) {
      fg.release();
    }
    expect(jobs.acquire("fg three").ok).toBe(true);
    expect(jobs.acquire("fg four").ok).toBe(false);
    // A background launch sees the foreground slots too (one cap).
    expect(jobs.start(spec("bg two"), async () => result()).ok).toBe(false);
    expect(log).toEqual(["launched:bg one"]);
    g.done();
    await tick();
  });

  test("release is idempotent: a second call frees nothing more", () => {
    const { jobs } = rig(1);
    const a = jobs.acquire("a");
    if (!a.ok) {
      throw new Error("expected a slot");
    }
    a.release();
    const b = jobs.acquire("b");
    expect(b.ok).toBe(true);
    a.release();
    // `a`'s second release must not have freed `b`'s slot.
    expect(jobs.acquire("c").ok).toBe(false);
  });

  test("after dispose it is refused", () => {
    const { jobs } = rig();
    jobs.dispose();
    expect(jobs.acquire("x").ok).toBe(false);
  });
});

describe("AgentJobs.setCap", () => {
  test("lowering kills nothing and refuses new work; raising admits again", async () => {
    const { jobs } = rig(2);
    const a = gated();
    const b = gated();
    jobs.start(spec("a"), a.run);
    jobs.start(spec("b"), b.run);
    jobs.setCap(1);
    expect(jobs.list()).toHaveLength(2);
    expect(a.signal?.aborted).toBe(false);
    expect(jobs.start(spec("c"), async () => result()).ok).toBe(false);
    expect(jobs.acquire("c").ok).toBe(false);
    jobs.setCap(3);
    expect(jobs.start(spec("c"), async () => result()).ok).toBe(true);
    a.done();
    b.done();
    await tick();
  });
});
