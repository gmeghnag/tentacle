import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import {
  type SkillActivatorEntry,
  type SkillBodyReader,
  ToolRegistry,
  createSkillActivator,
} from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { spillLargeOutput } from "../src/result-pipeline.ts";
import { Session } from "../src/session.ts";

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

    // The full output was written under .tentacle/tool-output/.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toContain(".tentacle/tool-output/noisy-c1");
    expect(writes[0]?.contents).toBe(big);

    // The in-context tool result is the spilled preview, not the full output.
    const toolResult = events.find((e) => e.type === "tool_result");
    const content = toolResult?.type === "tool_result" ? toolResult.result.content : "";
    expect(content).toContain(".tentacle/tool-output/noisy-c1");
    expect(content.length).toBeLessThan(big.length);
  });

  // docs/feat/tui-spill-note.md: the spill fact rides the event AND the
  // history message (resume / snapshot build the row from the message).
  test("the tool_result event and the pushed tool message both carry the spill", async () => {
    // Mutation (red, verified): drop the spread on the model-call push → the message assertion fails.
    const env: ExecutionEnvironment = {
      id: "fake",
      exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const big = "LINE\n".repeat(5000);
    const noisy: Tool = {
      name: "noisy",
      description: "returns a lot",
      inputSchema: z.object({}),
      permission: "none",
      execute: async () => ({ content: big }),
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
    const session = new Session(agent, "s1");
    const events: AgentEvent[] = [];
    for await (const event of session.send("go")) {
      events.push(event);
    }
    const toolResult = events.find((e) => e.type === "tool_result");
    const spill = toolResult?.type === "tool_result" ? toolResult.result.spill : undefined;
    expect(spill).toEqual({
      chars: big.length,
      path: ".tentacle/tool-output/noisy-c1.txt",
      head: big.slice(0, 600),
      tail: big.slice(big.length - 600),
      omitted: big.length - 1200,
    });
    const message = session.messages.find((m) => m.role === "tool");
    expect(spill).toBeDefined();
    expect(message?.spill as unknown).toEqual(spill);
    expect(message?.content).toBe(
      toolResult?.type === "tool_result" ? toolResult.result.content : "",
    );
  });

  test("a user /skill round's tool message carries the spill too", async () => {
    // Mutation (red, verified): drop the spread on the user-skill push → fails.
    const env: ExecutionEnvironment = {
      id: "fake",
      exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const entry: SkillActivatorEntry = {
      name: "big",
      location: "/s/big/SKILL.md",
      dir: "/s/big",
      files: [],
      filesTruncated: false,
      userInvocable: true,
    };
    const read: SkillBodyReader = async () => ({ body: "STEP\n".repeat(2000), bodyLine: 5 });
    const agent = new Agent({
      model: new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]),
      tools: new ToolRegistry(),
      env,
      skills: createSkillActivator([entry], read),
      // Not exempted here (production exempts `skill`, wiring.ts): this pins the push.
      resultTransforms: [spillLargeOutput({ maxInlineChars: 500 })],
    });
    const session = new Session(agent, "s1");
    for await (const _ of session.send("/big", undefined, { skill: "big" })) {
      // drain
    }
    const message = session.messages.find((m) => m.role === "tool");
    expect(message?.spill?.chars).toBeGreaterThan(500);
    expect(message?.spill?.path).toContain(".tentacle/tool-output/skill-");
  });
});
