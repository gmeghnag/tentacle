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

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

// A tool that emits two progress events while "running", then returns.
const probeTool: Tool = {
  name: "probe",
  description: "emits progress",
  inputSchema: z.object({}),
  permission: "none",
  async execute(_input, ctx) {
    ctx.emitProgress?.({ kind: "subagent_start", agentType: "explore", description: "probing" });
    ctx.emitProgress?.({ kind: "subagent_tool", label: "Read a.ts" });
    ctx.emitProgress?.({ kind: "subagent_end", toolUses: 1, stopReason: "end_turn" });
    return { content: "probe done" };
  },
};

describe("agent interleaves tool progress into its event stream", () => {
  test("subagent_* events appear between tool_start and tool_result", async () => {
    const agent = new Agent({
      model: new ScriptedProvider([
        [
          { type: "tool_call", toolCall: { id: "p1", name: "probe", arguments: "{}" } },
          { type: "done" },
        ],
        [{ type: "text", delta: "ok" }, { type: "done" }],
      ]),
      tools: new ToolRegistry().register(probeTool),
      env: noopEnv,
    });

    const types: string[] = [];
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      types.push(event.type);
      if (
        event.type === "subagent_start" ||
        event.type === "subagent_tool" ||
        event.type === "subagent_end"
      ) {
        expect((event as Extract<AgentEvent, { id: string }>).id).toBe("p1");
      }
    }

    const start = types.indexOf("tool_start");
    const result = types.indexOf("tool_result");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(result).toBeGreaterThan(start);
    // All three nested events land strictly between tool_start and tool_result.
    for (const nested of ["subagent_start", "subagent_tool", "subagent_end"]) {
      const at = types.indexOf(nested);
      expect(at).toBeGreaterThan(start);
      expect(at).toBeLessThan(result);
    }
  });
});
