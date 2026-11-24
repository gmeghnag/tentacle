/**
 * `image_view` is never a child's tool (docs/feat/image-view.md D9, T7): a
 * sub-agent is built without the session's store, so its markers carry no ref.
 * `general` is `tools: "all"`, so only the "never a child" filter in
 * `subagent.ts` can drop it — pinned against a parent registry that holds it.
 */
import { describe, expect, test } from "bun:test";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry, createImageViewTool, fsReadTool } from "@tentacle/tools";
import { describeToolCall } from "../src/permission-gate.ts";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../src/subagent.ts";

const env: ExecutionEnvironment = {
  id: "rec",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

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

describe("image-view T9: a hook-forced ask on image_view carries only the bounded input", () => {
  test("describeToolCall (what the gate hands the broker on `force: ask`) → {ref, detail}", () => {
    const tool = createImageViewTool();
    expect(tool.permission).toBe("none");
    const request = describeToolCall(tool as never, { ref: "a1b2c3d4e5f6", detail: "high" });
    expect(request.input).toEqual({ ref: "a1b2c3d4e5f6", detail: "high" });
    expect(JSON.stringify(request).length).toBeLessThan(1000);
  });
});

describe("image-view D9: a child agent is never offered image_view", () => {
  test('a `general` child (tools: "all") does not get it from a parent that holds it', async () => {
    const offered: string[][] = [];
    const { run } = createSubagentRunner({
      model: recorder(offered),
      env,
      tools: new ToolRegistry().register(fsReadTool).register(createImageViewTool()),
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]).not.toContain("image_view");
    expect(offered[0]).toContain("fs_read");
  });
});
