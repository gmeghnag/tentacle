import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { compactedHistory, summarizeConversation } from "../src/compact.ts";
import { Session } from "../src/session.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
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

describe("summarizeConversation", () => {
  test("sends a tool-free summary request and returns the text", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "SUMMARY" }, { type: "done" }]]);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const summary = await summarizeConversation(model, messages);
    expect(summary).toBe("SUMMARY");
    expect(model.requests[0]?.tools).toEqual([]);
  });
});

describe("compactedHistory", () => {
  test("keeps the system prompt then one summary user message", () => {
    const next = compactedHistory(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      "the gist",
    );
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ role: "system", content: "sys" });
    expect(next[1]?.role).toBe("user");
    expect(next[1]?.content).toContain("the gist");
  });
});

describe("Session.compact", () => {
  test("replaces the history with the system prompt + summary", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "a dense brief" }, { type: "done" }],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
    });
    const session = new Session(agent);
    session.messages.push({ role: "user", content: "do x" });
    session.messages.push({ role: "assistant", content: "did x" });

    const result = await session.compact();
    expect(result.before).toBe(3); // system + user + assistant
    expect(result.after).toBe(2); // system + summary
    expect(result.summary).toBe("a dense brief");
    expect(session.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(session.messages[1]?.content).toContain("a dense brief");
  });
});
