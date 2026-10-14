import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@agent-harness/core";
import { type TaskRunResult, createTaskTool } from "../src/task.ts";

const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
const TYPES = [
  { name: "general-purpose", description: "all tools" },
  { name: "explore", description: "read-only" },
];

function runnerReturning(result: TaskRunResult) {
  const calls: { description: string; prompt: string; type: string }[] = [];
  const run = async (opts: { description: string; prompt: string; type: string }) => {
    calls.push(opts);
    return result;
  };
  return { run, calls };
}

describe("createTaskTool", () => {
  test("returns the sub-agent's report as the tool result", async () => {
    const { run } = runnerReturning({ report: "all done", toolUses: 2, stopReason: "end_turn" });
    const tool = createTaskTool(run, TYPES);
    const result = await tool.execute(
      { description: "d", prompt: "do it", subagent_type: "explore" },
      ctx,
    );
    expect(result.content).toBe("all done");
    expect(result.isError).toBeUndefined();
  });

  test("defaults the type to the first and corrects an invalid one", async () => {
    const { run, calls } = runnerReturning({ report: "x", toolUses: 0, stopReason: "end_turn" });
    const tool = createTaskTool(run, TYPES);
    await tool.execute({ description: "d", prompt: "p" }, ctx); // no type
    await tool.execute({ description: "d", prompt: "p", subagent_type: "bogus" }, ctx);
    expect(calls.map((c) => c.type)).toEqual(["general-purpose", "general-purpose"]);
  });

  test("annotates a cancelled or capped run", async () => {
    const cancelled = createTaskTool(
      runnerReturning({ report: "partial", toolUses: 1, stopReason: "cancelled" }).run,
      TYPES,
    );
    expect((await cancelled.execute({ description: "d", prompt: "p" }, ctx)).content).toContain(
      "cancelled",
    );
    const capped = createTaskTool(
      runnerReturning({ report: "partial", toolUses: 9, stopReason: "max_iterations" }).run,
      TYPES,
    );
    expect((await capped.execute({ description: "d", prompt: "p" }, ctx)).content).toContain(
      "iteration cap",
    );
  });

  test("the tool itself needs no permission and lists the types", () => {
    const tool = createTaskTool(
      runnerReturning({ report: "", toolUses: 0, stopReason: "end_turn" }).run,
      TYPES,
    );
    expect(tool.permission).toBe("none");
    expect(tool.description).toContain("general-purpose");
    expect(tool.description).toContain("explore");
  });
});
