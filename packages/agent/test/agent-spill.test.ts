import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@agent-harness/core";
import { ToolRegistry } from "@agent-harness/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { spillLargeOutput } from "../src/result-pipeline.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

describe("Agent applies result transforms (spill)", () => {
  test("a huge tool result is spilled to a workspace file", async () => {
    const writes: { path: string; contents: string }[] = [];
    const env: ExecutionEnvironment = {
      id: "fake",
      exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: () => Promise.resolve(""),
      writeFile: async (path, contents) => {
        writes.push({ path, contents });
      },
    };
    const big = "LINE\n".repeat(5000);
    const noisy: Tool = {
      name: "noisy",
      description: "returns a lot",
      inputSchema: z.object({}),
      permission: "none",
      execute: async () => ({ content: big, isError: false }),
    };
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "c1", name: "noisy", arguments: "{}" } }],
      [{ type: "text", delta: "done" }, { type: "done" }],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(noisy),
      env,
      resultTransforms: [spillLargeOutput({ maxInlineChars: 500 })],
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run("s1", [{ role: "user", content: "go" }])) {
      events.push(event);
    }

    // The full output was written under .harness/tool-output/.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toContain(".harness/tool-output/noisy-c1");
    expect(writes[0]?.contents).toBe(big);

    // The in-context tool result is the spilled preview, not the full output.
    const toolResult = events.find((e) => e.type === "tool_result");
    const content = toolResult?.type === "tool_result" ? toolResult.result.content : "";
    expect(content).toContain(".harness/tool-output/noisy-c1");
    expect(content.length).toBeLessThan(big.length);
  });
});
