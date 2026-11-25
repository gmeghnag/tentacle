import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, ModelProvider, Tool } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import type { AgentType } from "../src/index.ts";
import { createSubagentRunner } from "../src/subagent.ts";

// docs/feat/agent-workflows.md A1: the ONLY runner change — two per-call knobs a
// workflow step needs (`maxTokens`, `extraTools`); no new agent loop.

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};
const noteTool: Tool = {
  name: "note",
  description: "no-op",
  inputSchema: z.object({}),
  permission: "none",
  execute: () => Promise.resolve({ content: "ok" }),
};
const WORKER: AgentType = { name: "worker", description: "w", prompt: "work", tools: ["note"] };
const tools = (): ToolRegistry => new ToolRegistry().register(noteTool);

/** Every round: one `note` call + 2,000 tokens spent. Records the offered tool names. */
function spending(offered: string[][]): ModelProvider {
  let round = 0;
  return {
    id: "spending",
    async *stream(request) {
      offered.push((request.tools ?? []).map((t) => t.name));
      round += 1;
      yield { type: "tool_call", toolCall: { id: `c${round}`, name: "note", arguments: "{}" } };
      yield { type: "done", usage: { promptTokens: 1_000, completionTokens: 1_000 } };
    },
  };
}

describe("per-call runner knobs", () => {
  test("controls.maxTokens caps THIS child when the runner has none", async () => {
    const { run } = createSubagentRunner({
      model: spending([]),
      env: noopEnv,
      tools: tools(),
      types: [WORKER],
      maxIterations: 50,
    });
    const capped = await run(
      { type: "worker", description: "d", prompt: "go" },
      { maxTokens: 4_000 },
    );
    expect(capped.stopReason).toBe("max_token_budget");
    expect(capped.toolUses).toBe(2);
    expect(capped.report).toContain("of 4,000 tokens used");
  });

  test("controls.maxTokens wins over the runner's cap", async () => {
    const { run } = createSubagentRunner({
      model: spending([]),
      env: noopEnv,
      tools: tools(),
      types: [WORKER],
      maxIterations: 50,
      maxTokens: 100_000,
    });
    const capped = await run(
      { type: "worker", description: "d", prompt: "go" },
      { maxTokens: 2_000 },
    );
    expect(capped.toolUses).toBe(1);
    expect(capped.report).toContain("of 2,000 tokens used");
  });

  test("controls.extraTools are offered past the type's allow-list, to this child only", async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: spending(offered),
      env: noopEnv,
      tools: tools(),
      types: [WORKER],
      maxIterations: 1,
    });
    const verdict: Tool = { ...noteTool, name: "step_verdict" };
    await run({ type: "worker", description: "d", prompt: "go" }, { extraTools: [verdict] });
    const firstChild = offered.length;
    await run({ type: "worker", description: "d", prompt: "go" }, {});
    expect(offered[0]).toContain("step_verdict");
    expect(offered[0]).toContain("note");
    expect(offered[firstChild]).not.toContain("step_verdict");
  });
});
