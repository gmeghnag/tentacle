/**
 * The `browser_*` tools are the PARENT's, never a child's
 * (docs/feat/browser-inspect.md B4): the tab group, its lease and the masking
 * key are the SESSION's, and a child has no image store for a shot. `general`
 * is `tools: "all"`, so only the "never a child" filter in `subagent.ts` can
 * drop them — pinned here by name against a parent registry holding all six
 * (real tools, over a backend that is never reached).
 */
import { describe, expect, test } from "bun:test";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import {
  BROWSER_TOOL_NAMES,
  ToolRegistry,
  createBrowserToolset,
  fsReadTool,
} from "@tentacle/tools";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../src/subagent.ts";

const env: ExecutionEnvironment = {
  id: "rec",
  exec: async () => ({ stdout: "ran", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

function parentRegistry(): ToolRegistry {
  const set = createBrowserToolset({
    backend: { call: () => Promise.reject(new Error("never reached")) },
  });
  return new ToolRegistry()
    .register(fsReadTool)
    .registerAll(set.tools({ maxEdge: 1568, maxImageBytes: 1_000_000 }));
}

function recorder(offered: string[][]): ModelProvider {
  return {
    id: "rec",
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      offered.push((request.tools ?? []).map((tool) => tool.name));
      yield { type: "text", delta: "report" };
      yield { type: "done" };
    },
  };
}

describe("browser-inspect B4: a child agent is never offered the browser tools", () => {
  test('a `general` child (tools: "all") gets none, from a parent that holds all six', async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: parentRegistry(),
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    for (const name of BROWSER_TOOL_NAMES) expect(offered[0]).not.toContain(name);
    // Non-vacuity: another parent tool IS offered.
    expect(offered[0]).toContain("fs_read");
  });
});
