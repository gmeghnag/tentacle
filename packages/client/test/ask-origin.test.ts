import { describe, expect, test } from "bun:test";
import { askOrigin, originWords } from "../src/ask-origin.ts";

describe("askOrigin", () => {
  test("no agent, no workflow → main", () => {
    expect(askOrigin({})).toEqual({ kind: "main" });
    expect(originWords({ kind: "main" })).toEqual({ lead: "Main agent", rest: "" });
  });

  test("agent → subagent", () => {
    const o = askOrigin({ agent: { type: "explore", description: "find callers" } });
    expect(o).toEqual({ kind: "subagent", type: "explore", task: "find callers" });
    expect(originWords(o)).toEqual({ lead: "Sub-agent explore", rest: "find callers" });
  });

  test("workflow step with a position", () => {
    const o = askOrigin({
      workflow: { name: "rassegna-stampa", runId: "wf-1", stepId: "generate", index: 1, count: 5 },
    });
    expect(o).toEqual({
      kind: "workflow",
      name: "rassegna-stampa",
      runId: "wf-1",
      stepId: "generate",
      position: { n: 2, m: 5 },
    });
    expect(originWords(o)).toEqual({
      lead: "rassegna-stampa",
      rest: "step generate · 2 of 5",
    });
  });

  test("run approval (no step) and schedule approval (no run)", () => {
    const run = askOrigin({ workflow: { name: "wf", runId: "wf-1", count: 3 } });
    expect(run).toEqual({
      kind: "workflow",
      name: "wf",
      runId: "wf-1",
      stepId: null,
      position: null,
    });
    expect(originWords(run)).toEqual({ lead: "wf", rest: "approval" });
    const sched = askOrigin({ workflow: { name: "wf" } });
    expect(sched).toEqual({
      kind: "workflow",
      name: "wf",
      runId: null,
      stepId: null,
      position: null,
    });
    expect(originWords(sched).rest).toBe("approval");
  });

  test("workflow beats agent", () => {
    const o = askOrigin({
      agent: { type: "general", description: "wf/generate", id: "wf-1.generate" },
      workflow: { name: "wf", runId: "wf-1", stepId: "generate", index: 0, count: 2 },
    });
    expect(o.kind).toBe("workflow");
  });

  test("N of M is dropped on a bad position", () => {
    const pos = (index: number, count: number) =>
      askOrigin({ workflow: { name: "w", stepId: "s", index, count } });
    const position = (o: ReturnType<typeof askOrigin>) =>
      o.kind === "workflow" ? o.position : "not-workflow";
    expect(position(pos(5, 5))).toBeNull();
    expect(position(pos(6, 5))).toBeNull();
    expect(position(pos(0, 65))).toBeNull();
    expect(position(pos(Number.NaN, 5))).toBeNull();
    expect(position(pos(-1, 5))).toBeNull();
    expect(position(pos(1.5, 5))).toBeNull();
    expect(position(pos(0, 64))).toEqual({ n: 1, m: 64 });
    expect(originWords(pos(5, 5)).rest).toBe("step s");
  });

  test("a missing index or count drops the position", () => {
    const o = askOrigin({ workflow: { name: "w", stepId: "s", index: 1 } });
    expect(o.kind === "workflow" && o.position).toBeNull();
  });

  test("the kind ignores the text: a workflow named «Main agent» is still a workflow", () => {
    expect(askOrigin({ workflow: { name: "Main agent" } }).kind).toBe("workflow");
    expect(askOrigin({ agent: { type: "Main agent", description: "" } }).kind).toBe("subagent");
  });

  test("strings are cut for one line", () => {
    const o = askOrigin({ workflow: { name: "n".repeat(500), stepId: "s".repeat(500) } });
    expect(o.kind === "workflow" && o.name.length).toBeLessThanOrEqual(64);
    expect(o.kind === "workflow" && (o.stepId ?? "").length).toBeLessThanOrEqual(64);
    const s = askOrigin({ agent: { type: "t".repeat(500), description: "d".repeat(500) } });
    expect(s.kind === "subagent" && s.task.length).toBeLessThanOrEqual(120);
    expect(s.kind === "subagent" && s.type.length).toBeLessThanOrEqual(64);
  });
});
