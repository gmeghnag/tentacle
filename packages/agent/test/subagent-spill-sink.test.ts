/**
 * A child's spill goes under its PARENT's session (docs/fix/tool-output-location.md),
 * so deleting the session deletes it; the child's own session id is a throwaway.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { createSubagentRunner } from "../src/index.ts";
import { spillLargeOutput } from "../src/result-pipeline.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  async writeFile() {
    throw new Error("the sink must be used, not env");
  },
};

class Script implements ModelProvider {
  readonly id = "s";
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const events: StreamEvent[] = !request.messages.some((m) => m.role === "tool")
      ? [{ type: "tool_call", toolCall: { id: "call_1", name: "noisy", arguments: "{}" } }]
      : [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noisy: Tool = {
  name: "noisy",
  description: "noisy",
  inputSchema: z.object({}),
  permission: "none",
  async execute() {
    return { content: "x\n".repeat(2000) };
  },
};
const worker = { name: "worker", description: "works", prompt: "work", tools: "all" as const };

function runner() {
  const writes: { sid: string; tool: string; id: string }[] = [];
  const { run } = createSubagentRunner({
    model: new Script(),
    env,
    tools: new ToolRegistry().register(noisy),
    types: [worker],
    resultTransforms: [spillLargeOutput({ maxInlineChars: 100 })],
    toolOutput: {
      write: async (sid, tool, id) => {
        writes.push({ sid, tool, id });
        return `/cache/${sid}/${tool}-${id}.txt`;
      },
    },
  });
  return { run, writes };
}

describe("a sub-agent's spill", () => {
  test("lands under the parent's session when the runner is told it", async () => {
    const { run, writes } = runner();
    await run({ description: "d", prompt: "go", type: "worker" }, { sessionId: "parent-sess" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sid).toBe("parent-sess");
  });

  test("its call id is scoped, so it cannot overwrite the parent's own call_1", async () => {
    const { run, writes } = runner();
    await run({ description: "d", prompt: "go", type: "worker" }, { sessionId: "parent-sess" });
    expect(writes[0]?.id).not.toBe("call_1");
    expect(writes[0]?.id.endsWith("-call_1")).toBe(true);
  });

  test("two children with the same call id write under different names", async () => {
    const { run, writes } = runner();
    const controls = { sessionId: "parent-sess" };
    await run({ description: "d", prompt: "go", type: "worker" }, controls);
    await run({ description: "d", prompt: "go", type: "worker" }, controls);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.id).not.toBe(writes[1]?.id);
  });

  test("with no parent session (a direct runner call) it is a throwaway id, as before", async () => {
    const { run, writes } = runner();
    await run({ description: "d", prompt: "go", type: "worker" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sid).not.toBe("parent-sess");
    expect(writes[0]?.sid.length).toBeGreaterThan(8);
  });
});
