import { describe, expect, test } from "bun:test";
import { AgentJobs, type ToolContext, type ToolResult } from "@tentacle/core";
import { type TaskRunResult, type TaskRunner, createTaskTool } from "../src/task.ts";

const TYPES = [{ name: "general", description: "all tools" }];
const tick = () => new Promise((r) => setTimeout(r, 1));

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
  const jobs = new AgentJobs(cap);
  jobs.bind({
    launched: () => `sa-${++n}`,
    ended: (id, stop) => ended.push(`${id}:${stop}`),
  });
  return { jobs, ended };
}

function gatedRunner() {
  const seen: { signal?: AbortSignal; agentId?: string }[] = [];
  const gate = Promise.withResolvers<TaskRunResult>();
  const run: TaskRunner = async (_opts, controls) => {
    seen.push({
      ...(controls?.signal ? { signal: controls.signal } : {}),
      ...(controls?.agentId !== undefined ? { agentId: controls.agentId } : {}),
    });
    return gate.promise;
  };
  return { run, seen, finish: (r: TaskRunResult) => gate.resolve(r) };
}

const DONE: TaskRunResult = { report: "THE REPORT", toolUses: 1, stopReason: "end_turn" };

describe("agent_task background", () => {
  test("returns at once with the id; the child does not get the turn's signal", async () => {
    const { jobs, ended } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx, turn } = ctxWith();
    const result = await tool.execute({ description: "map", prompt: "p", background: true }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("started in background as sa-1");
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0]?.agentId).toBe("sa-1");
    // The launching turn is cancelled (Esc): the child lives on.
    turn.abort();
    expect(g.seen[0]?.signal?.aborted).toBe(false);
    expect(g.seen[0]?.signal).not.toBe(ctx.signal);
    g.finish(DONE);
    await tick();
    expect(ended).toEqual(["sa-1:end_turn"]);
  });

  test("no tool call id: refused before anything starts (a blank callId breaks the schema)", async () => {
    const { jobs, ended } = jobsRig();
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
    const result = await tool.execute({ description: "map", prompt: "p", background: true }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("need a tool call id");
    // No launch, no slot held, no child: `log.subagentBackground` never saw "".
    expect(jobs.list()).toEqual([]);
    expect(g.seen).toHaveLength(0);
    expect(ended).toEqual([]);
  });

  test("at the cap a background launch is an error naming the running ids; no child starts", async () => {
    const { jobs } = jobsRig(1);
    const g = gatedRunner();
    const tool = createTaskTool(g.run, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    await tool.execute({ description: "first", prompt: "p", background: true }, ctx);
    const second = await tool.execute(
      { description: "second", prompt: "p", background: true },
      ctx,
    );
    expect(second.isError).toBe(true);
    expect(second.content).toContain("sa-1 (first)");
    expect(g.seen).toHaveLength(1);
    g.finish(DONE);
    await tick();
  });

  test("a foreground call at a full cap is refused naming the running ids; no child, no slot leaked", async () => {
    const { jobs } = jobsRig(1);
    const g = gatedRunner();
    let ran = 0;
    const fgRun: TaskRunner = async () => {
      ran += 1;
      return DONE;
    };
    const bgTool = createTaskTool(g.run, TYPES, { background: jobs });
    const fgTool = createTaskTool(fgRun, TYPES, { background: jobs });
    const { ctx } = ctxWith();
    await bgTool.execute({ description: "busy one", prompt: "p", background: true }, ctx);
    const refused = await fgTool.execute({ description: "fg", prompt: "p" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("sa-1 (busy one)");
    expect(refused.content).not.toContain("run it in the foreground");
    expect(ran).toBe(0);
    // The refusal took no slot: once the child ends, a foreground call runs.
    g.finish(DONE);
    await tick();
    const ok = await fgTool.execute({ description: "fg", prompt: "p" }, ctx);
    expect(ok.content).toBe("THE REPORT");
    expect(ran).toBe(1);
  });

  test("a foreground slot is held while it runs, and released after a throw (the finally)", async () => {
    const { jobs } = jobsRig(1);
    const fgTool = createTaskTool(
      async () => {
        // While this child runs, the cap is full for everyone.
        expect(jobs.acquire("probe").ok).toBe(false);
        throw new Error("child crashed");
      },
      TYPES,
      { background: jobs },
    );
    const { ctx } = ctxWith();
    await expect(fgTool.execute({ description: "fg", prompt: "p" }, ctx)).rejects.toThrow(
      "child crashed",
    );
    const after = jobs.acquire("after");
    expect(after.ok).toBe(true);
  });

  test("without the option: no `background` argument, and a stray one runs in the foreground", async () => {
    const plain = createTaskTool(async () => DONE, TYPES);
    const withBg = createTaskTool(async () => DONE, TYPES, { background: jobsRig().jobs });
    const keys = (t: typeof plain) =>
      Object.keys((t.inputSchema as unknown as { shape: object }).shape);
    expect(keys(plain)).not.toContain("background");
    expect(keys(withBg)).toContain("background");
    let ran = 0;
    const tool = createTaskTool(async () => {
      ran += 1;
      return DONE;
    }, TYPES);
    const { ctx } = ctxWith();
    const result = await tool.execute({ description: "d", prompt: "p", background: true }, ctx);
    expect(result.content).toBe("THE REPORT");
    expect(ran).toBe(1);
  });

  test("the report passes shapeResult; a thrown run still passes it", async () => {
    const { jobs } = jobsRig(2);
    const shaped: string[] = [];
    const shapeResult = async (r: ToolResult): Promise<ToolResult> => {
      shaped.push(r.content);
      return { content: `[shaped] ${r.content}` };
    };
    const exits: string[] = [];
    jobs.onExit((e) => exits.push(e.report));
    const ok = createTaskTool(async () => DONE, TYPES, { background: jobs });
    const bad = createTaskTool(
      async () => {
        throw new Error("boom");
      },
      TYPES,
      { background: jobs },
    );
    const { ctx } = ctxWith({ shapeResult });
    await ok.execute({ description: "a", prompt: "p", background: true }, ctx);
    await bad.execute({ description: "b", prompt: "p", background: true }, ctx);
    await tick();
    expect(shaped).toEqual(["THE REPORT", "the sub-agent failed: boom"]);
    expect(exits).toEqual(["[shaped] THE REPORT", "[shaped] the sub-agent failed: boom"]);
  });
});
