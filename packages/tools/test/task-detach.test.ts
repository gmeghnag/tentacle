import { describe, expect, test } from "bun:test";
import {
  type AgentJobResult,
  AgentJobs,
  type PermissionRequest,
  type PermissionRequester,
  type ToolContext,
} from "@tentacle/core";
import {
  type TaskRunControls,
  type TaskRunResult,
  type TaskRunner,
  createTaskTool,
} from "../src/task.ts";

// docs/feat/subagent-detach.md T6-T13: a FOREGROUND `agent_task` with a tool
// call id is MOVABLE. When someone writes while it runs, the call answers at
// once with the moved-to-background text, the child keeps running as `sa-N`,
// and its report arrives later as the ordinary background note.

const TYPES = [{ name: "general", description: "all tools" }];
const tick = () => new Promise((r) => setTimeout(r, 1));
const DONE: TaskRunResult = { report: "THE REPORT", toolUses: 1, stopReason: "end_turn" };

function ctxWith(extra: Partial<ToolContext> = {}) {
  const turn = new AbortController();
  const ctx = {
    sessionId: "s",
    signal: turn.signal,
    toolCallId: "call-1",
    ...extra,
  } as unknown as ToolContext;
  return { ctx, turn };
}

function jobsRig(cap = 2) {
  let n = 0;
  const ended: string[] = [];
  const exits: string[] = [];
  const jobs = new AgentJobs(cap);
  jobs.bind({
    launched: () => `sa-${++n}`,
    ended: (id, stop) => ended.push(`${id}:${stop}`),
  });
  jobs.onExit((e) => exits.push(`${e.agentId}:${e.report}`));
  return { jobs, ended, exits };
}

/** A run held until `finish`, recording its controls (and its progress sink). */
function gatedRunner() {
  const seen: TaskRunControls[] = [];
  const gate = Promise.withResolvers<TaskRunResult>();
  const run: TaskRunner = async (_opts, controls) => {
    seen.push(controls ?? {});
    return gate.promise;
  };
  return { run, seen, finish: (r: TaskRunResult = DONE) => gate.resolve(r) };
}

/** The moved-to-background text, exactly (`docs/feat/subagent-detach.md` Design 2). */
const movedText = (id: string, description: string) =>
  `moved to background as ${id}: ${description}. Its report will arrive later as a [background] note; you can keep working or end your turn.`;

describe("T6: a detach answers the call with the moved text", () => {
  test("exactly `movedText`, no isError, and the caller returns before the child", async () => {
    const { jobs } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    expect(jobs.rows()).toEqual([]);
    // The steer: the whole trigger.
    jobs.detachForeground();
    const result = await running;
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(movedText("sa-1", "map repo"));
    // The child is still running, as a background one.
    expect(jobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(g.seen).toHaveLength(1);
    g.finish();
    await tick();
  });
});

describe("T7: the unlink is the property", () => {
  test("a turn abort BEFORE the move aborts the child; AFTER it, does not", async () => {
    // Before.
    {
      const { jobs } = jobsRig();
      const g = gatedRunner();
      const tool = createTaskTool(g.run, TYPES, { background: jobs });
      const { ctx, turn } = ctxWith();
      const running = tool.execute({ description: "d", prompt: "p" }, ctx);
      await tick();
      turn.abort();
      expect(g.seen[0]?.signal?.aborted).toBe(true);
      g.finish({ report: "cancelled", toolUses: 0, stopReason: "cancelled" });
      await running;
    }
    // After.
    {
      const { jobs } = jobsRig();
      const g = gatedRunner();
      const tool = createTaskTool(g.run, TYPES, { background: jobs });
      const { ctx, turn } = ctxWith();
      const running = tool.execute({ description: "d", prompt: "p" }, ctx);
      await tick();
      jobs.detachForeground();
      await running;
      // The child's own signal, never the turn's: Esc leaves it running.
      expect(g.seen[0]?.signal).not.toBe(ctx.signal);
      expect(g.seen[0]?.signal?.aborted).toBe(false);
      turn.abort();
      expect(g.seen[0]?.signal?.aborted).toBe(false);
      g.finish();
      await tick();
    }
  });
});

describe("T8: after the move, progress goes to the row and the end is announced once", () => {
  test("bg.progress, never emitProgress; `subagent_end{background, agentId}` before the result", async () => {
    const { jobs } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const emitted: { kind: string; agentId?: string; stopReason?: string }[] = [];
    const { ctx } = ctxWith({
      emitProgress: (e) => emitted.push(e as { kind: string }),
    });
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    // While foreground: the turn sees it.
    const sink = g.seen[0]?.onEvent;
    sink?.({ kind: "subagent_tool", label: "Read a.ts" });
    expect(emitted.map((e) => e.kind)).toEqual(["subagent_tool"]);
    expect(jobs.rows()).toEqual([]);
    jobs.detachForeground();
    await running;
    const afterMove = emitted.length;
    // The end is announced once, with the id and `background`.
    expect(emitted.at(-1)).toMatchObject({
      kind: "subagent_end",
      agentId: "sa-1",
      stopReason: "background",
    });
    expect(emitted.filter((e) => e.kind === "subagent_end")).toHaveLength(1);
    // After the move: the row, not the turn.
    sink?.({ kind: "subagent_tool", label: "Read b.ts" });
    expect(emitted).toHaveLength(afterMove);
    expect(jobs.rows()[0]?.tail).toEqual(["Read a.ts", "Read b.ts"]);
    g.finish();
    await tick();
  });
});

describe("T9: a run settling and a move in the same tick", () => {
  test("exactly one report: the moved note, never also the exit", async () => {
    const { jobs, exits } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    // Both in one synchronous stretch: the child finished, AND the steer landed.
    g.finish(DONE);
    jobs.detachForeground();
    const result = await running;
    // `agentId` alone decides the path: the call is the moved note.
    expect(result.content).toBe(movedText("sa-1", "map repo"));
    await tick();
    // The report arrives once, as the background note's payload (the exit).
    expect(exits).toEqual(["sa-1:THE REPORT"]);
  });

  test("a move after the run settled but before its `.then` ran still gives one report", async () => {
    const { jobs, exits } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    // The run's promise settles first, then the steer: no microtask ran between.
    g.finish(DONE);
    jobs.detachForeground();
    const result = await running;
    expect(result.content).toBe(movedText("sa-1", "map repo"));
    await tick();
    expect(exits).toHaveLength(1);
  });
});

describe("T10: a child that already ended or was cancelled never moves", () => {
  test("an aborted child does not move: no marker, no id", async () => {
    const { jobs, ended } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx, turn } = ctxWith();
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    turn.abort();
    jobs.detachForeground();
    expect(jobs.list()).toEqual([]);
    g.finish({ report: "R", toolUses: 0, stopReason: "cancelled" });
    const result = await running;
    expect(result.content).toContain("_(sub-agent cancelled)_");
    await tick();
    expect(ended).toEqual([]);
  });
});

describe("T11: no tool call id → not movable, today's result", () => {
  test("the steer is queued and the call waits for the child", async () => {
    const { jobs } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
    const running = tool.execute({ description: "d", prompt: "p" }, ctx);
    await tick();
    jobs.detachForeground();
    expect(jobs.list()).toEqual([]);
    g.finish(DONE);
    expect((await running).content).toBe("THE REPORT");
  });

  test("no AgentJobs at all (a one-shot): today's result, no slot", async () => {
    const run: TaskRunner = async () => DONE;
    const tool = createTaskTool(run, TYPES);
    const { ctx } = ctxWith();
    expect((await tool.execute({ description: "d", prompt: "p" }, ctx)).content).toBe("THE REPORT");
  });
});

describe("T12: the moved report is shaped with the CHILD's signal", () => {
  test("shapeResult receives the child's own signal, not the turn's", async () => {
    const { jobs, exits } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const shaped: { text: string; signal?: AbortSignal }[] = [];
    const { ctx } = ctxWith({
      shapeResult: async (r, signal) => {
        shaped.push({ text: r.content, ...(signal ? { signal } : {}) });
        return { content: `[shaped] ${r.content}` };
      },
    });
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    jobs.detachForeground();
    // The call answered at the move; the shaping happens when the child ends.
    expect((await running).content).toBe(movedText("sa-1", "map repo"));
    const childSignal = g.seen[0]?.signal;
    expect(childSignal).toBeDefined();
    g.finish(DONE);
    await tick();
    expect(shaped).toHaveLength(1);
    expect(shaped[0]?.text).toBe("THE REPORT");
    expect(shaped[0]?.signal).toBe(childSignal as AbortSignal);
    expect(exits).toEqual(["sa-1:[shaped] THE REPORT"]);
  });
});

describe("T13: a foreground rejection before any move still fails the call", () => {
  test("the throw reaches the registry, not turned into a report", async () => {
    const { jobs, ended } = jobsRig();
    const run: TaskRunner = async () => {
      throw new Error("child crashed");
    };
    const tool = createTaskTool(run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    await expect(tool.execute({ description: "d", prompt: "p" }, ctx)).rejects.toThrow(
      "child crashed",
    );
    // No marker, no leak of the slot.
    expect(ended).toEqual([]);
    expect(jobs.acquire("after").ok).toBe(true);
  });

  test("a non-clean foreground end still reads as today", async () => {
    const { jobs } = jobsRig();
    const run: TaskRunner = async () => ({
      report: "R",
      toolUses: 1,
      stopReason: "max_iterations",
    });
    const tool = createTaskTool(run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    const r = await tool.execute({ description: "d", prompt: "p" }, ctx);
    expect(r.content).toBe("R\n\n_(sub-agent hit its iteration cap)_");
  });
});

// A requester is only needed for typing here; the tools package never asks itself.
const _requester: PermissionRequester = async (_req: PermissionRequest) => ({ allowed: true });
void _requester;

describe("T12b: a NOT-moved call is not shaped by the tool", () => {
  test("shapeResult never runs for a foreground child that ended normally", async () => {
    // The agent loop applies the call's transforms to the result `execute`
    // returns (`agent.ts` `finishCall`). Shaping here too would redact, hook and
    // spill it twice — the exact double-run 6a has, and only for a MOVED child
    // (whose report never returns through the loop).
    const { jobs } = jobsRig();
    let shapedCalls = 0;
    const run: TaskRunner = async () => DONE;
    const tool = createTaskTool(run, TYPES, { background: jobs });
    const { ctx } = ctxWith({
      shapeResult: async (r) => {
        shapedCalls += 1;
        return { content: `[shaped] ${r.content}` };
      },
    });
    expect((await tool.execute({ description: "d", prompt: "p" }, ctx)).content).toBe("THE REPORT");
    expect(shapedCalls).toBe(0);
  });
});

// docs/feat/agent-message.md T12: a movable foreground child's inbox comes over
// with the move (`adopt` moves the SLOT's inbox), so `message(sa-1)` after the
// move is drained by the SAME running child.
describe("T12: the moved child's inbox is the same object", () => {
  test("before the move there is no id; after it, a message is read by that child", async () => {
    const { jobs } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    const running = tool.execute({ description: "map repo", prompt: "p" }, ctx);
    await tick();
    // Foreground: no id, so nothing to message.
    expect(jobs.message("sa-1", "too early", "agent").ok).toBe(false);
    // The inbox the child was launched with: `task.ts` passes the SLOT's.
    const inbox = g.seen[0]?.inbox;
    expect(inbox).toBeDefined();
    jobs.detachForeground();
    expect((await running).content).toBe(movedText("sa-1", "map repo"));
    // The move hands that very inbox to the running entry.
    expect(jobs.message("sa-1", "after the move", "agent")).toEqual({ ok: true, index: 1 });
    expect(inbox?.drain()).toEqual(["[message from the parent agent] after the move"]);
    g.finish();
    await tick();
  });

  test("a background child is given ITS entry's inbox at launch", async () => {
    const { jobs } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    const started = await tool.execute(
      { description: "map repo", prompt: "p", background: true },
      ctx,
    );
    expect(started.content).toContain("started in background as sa-1");
    const inbox = g.seen[0]?.inbox;
    expect(inbox).toBeDefined();
    expect(jobs.message("sa-1", "hi", "agent")).toEqual({ ok: true, index: 1 });
    expect(inbox?.drain()).toEqual(["[message from the parent agent] hi"]);
    g.finish();
    await tick();
  });
});
