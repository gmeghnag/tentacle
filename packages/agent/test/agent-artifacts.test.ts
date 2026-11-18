import { describe, expect, test } from "bun:test";
/**
 * `AgentConfig.artifacts` reaches every tool call's context
 * (docs/feat/model-artifacts.md D4, P2) — the seam `present` writes through —
 * and an agent built without one gives its tools none.
 */
import type {
  ArtifactSink,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
  ToolContext,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/index.ts";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

const env = { id: "e" } as unknown as ExecutionEnvironment;

function probe(seen: (ToolContext["artifacts"] | "absent")[]): Tool<Record<string, never>> {
  return {
    name: "probe",
    description: "records its context",
    inputSchema: z.object({}),
    permission: "none",
    async execute(_input, ctx) {
      seen.push(ctx.artifacts ?? "absent");
      return { content: "ok" };
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _ of gen) {
    // drain
  }
}

const script = (): StreamEvent[][] => [
  [{ type: "tool_call", toolCall: { id: "c1", name: "probe", arguments: "{}" } }, { type: "done" }],
  [{ type: "done" }],
];

describe("AgentConfig.artifacts → ToolContext.artifacts", () => {
  test("the configured sink is the one a tool call sees", async () => {
    const sink: ArtifactSink = { present: async () => Promise.reject(new Error("unused")) };
    const seen: (ToolContext["artifacts"] | "absent")[] = [];
    const agent = new Agent({
      model: new Scripted(script()),
      tools: new ToolRegistry().register(probe(seen)),
      env,
      artifacts: sink,
    });
    await drain(agent.run("s1", [{ role: "user", content: "go" }]));
    expect(seen).toEqual([sink]);
  });

  test("no sink configured → the tool's context has none", async () => {
    const seen: (ToolContext["artifacts"] | "absent")[] = [];
    const agent = new Agent({
      model: new Scripted(script()),
      tools: new ToolRegistry().register(probe(seen)),
      env,
    });
    await drain(agent.run("s1", [{ role: "user", content: "go" }]));
    expect(seen).toEqual(["absent"]);
  });
});
