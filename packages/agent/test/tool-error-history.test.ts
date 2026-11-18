/**
 * A failed tool call's error flag reaches the HISTORY, not only the live
 * `tool_result` event (docs/fix/mobile-qa-1117.md, bug 2): the phone and the TUI
 * project a reopened session from the stored messages, and without the flag a
 * failed step reloaded green. `isError: true` rides the tool message like
 * `durationMs` — display only, absent on a success.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.ts";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const e of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield e;
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

function tool(name: string, isError: boolean): Tool<{ n: number }> {
  return {
    name,
    description: name,
    inputSchema: z.object({ n: z.number() }),
    permission: "none",
    async execute() {
      return isError
        ? { content: "ls: missing-dir: No such file", isError: true }
        : { content: "ok" };
    },
  };
}

async function run(): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> {
  const agent = new Agent({
    model: new Scripted([
      [
        { type: "tool_call", toolCall: { id: "bad", name: "fails", arguments: '{"n":1}' } },
        { type: "tool_call", toolCall: { id: "good", name: "works", arguments: '{"n":2}' } },
        { type: "done" },
      ],
    ]),
    tools: new ToolRegistry().register(tool("fails", true)).register(tool("works", false)),
    env,
  });
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  const events: AgentEvent[] = [];
  for await (const e of agent.runMessages(messages, "s1")) {
    events.push(e);
  }
  return { events, messages };
}

describe("tool error flag in history", () => {
  test("a failed call's tool message carries isError: true; a success carries none", async () => {
    const { events, messages } = await run();
    const live = events.flatMap((e) =>
      e.type === "tool_result" ? [[e.id, e.result.isError === true] as const] : [],
    );
    expect(live).toEqual([
      ["bad", true],
      ["good", false],
    ]);
    const stored = messages
      .filter((m) => m.role === "tool")
      .map((m) => [m.toolCallId, m.isError] as const);
    expect(stored).toEqual([
      ["bad", true],
      ["good", undefined],
    ]);
  });
});
