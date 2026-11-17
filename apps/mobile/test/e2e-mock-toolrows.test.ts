/**
 * Flow 29's mock-model scenario (docs/feat/mobile-tool-rows.md S3), through the
 * REAL `OpenAIProvider` stream: `TOOLROWS29` is a turn of three rounds, picked by
 * how many tool results follow the person's prompt. Round 1: a thought, a line,
 * two `shell` calls. Round 2: a thought (no text, so the app folds it into the
 * next step), a ranged `fs_read` and an unknown MCP tool. Round 3: a thought and
 * the reply, no call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { ChatMessage, StreamEvent, ToolCall } from "@tentacle/core";
import { OpenAIProvider } from "../../../packages/providers/src/index.ts";
import { TOOLROWS_PROMPT, startMockModel } from "../e2e/mock-model.ts";

const mock = startMockModel({ thinkMs: 5 });
afterAll(() => mock.stop());
const provider = new OpenAIProvider({ baseURL: mock.baseUrl, model: "mock" });

interface Round {
  readonly order: string[];
  readonly reasoning: string;
  readonly text: string;
  readonly calls: ToolCall[];
}

async function round(messages: ChatMessage[]): Promise<Round> {
  const order: string[] = [];
  let reasoning = "";
  let text = "";
  const calls: ToolCall[] = [];
  for await (const event of provider.stream({ messages }) as AsyncIterable<StreamEvent>) {
    if (event.type === "reasoning") reasoning += event.delta;
    else if (event.type === "text") text += event.delta;
    else if (event.type === "tool_call") calls.push(event.toolCall);
    else continue;
    if (order[order.length - 1] !== event.type) order.push(event.type);
  }
  return { order, reasoning, text, calls };
}

/** The history after `n` rounds' worth of tool results (ids are irrelevant to the mock). */
function withResults(results: number, prompt: string = TOOLROWS_PROMPT): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  for (let i = 1; i <= results; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${i}`, name: "shell", arguments: "{}" }],
    });
    messages.push({ role: "tool", toolCallId: `c${i}`, content: "exit=0" });
  }
  return messages;
}

describe("TOOLROWS29 (flow 29)", () => {
  test("round 1: thinks, says a line, then two shell calls (one fails)", async () => {
    const r = await round(withResults(0));
    expect(r.order).toEqual(["reasoning", "text", "tool_call"]);
    expect(r.calls.map((c) => c.name)).toEqual(["shell", "shell"]);
    const commands = r.calls.map((c) => (JSON.parse(c.arguments) as { command: string }).command);
    expect(commands[0]).toContain("notes.txt");
    expect(commands[1]).toContain("missing-dir");
  });

  test("round 2: a thought with NO text, then a ranged read and an unknown MCP tool", async () => {
    const r = await round(withResults(2));
    expect(r.order).toEqual(["reasoning", "tool_call"]);
    expect(r.calls.map((c) => c.name)).toEqual(["fs_read", "mcp__demo__browser_resize"]);
    const read = r.calls[0];
    if (read === undefined) throw new Error("no read");
    expect(JSON.parse(read.arguments)).toEqual({ path: "notes.txt", offset: 1, limit: 20 });
    const mcp = r.calls[1];
    if (mcp === undefined) throw new Error("no mcp call");
    expect(JSON.parse(mcp.arguments)).toEqual({ width: 430, height: 932 });
  });

  test("round 3: a thought, then the reply, no call", async () => {
    const r = await round(withResults(4));
    expect(r.order).toEqual(["reasoning", "text"]);
    expect(r.calls).toEqual([]);
    expect(r.text.length).toBeGreaterThan(0);
  });

  test("only tool results AFTER the prompt count (an earlier turn's do not)", async () => {
    // A second TOOLROWS29 in the same session starts again at round 1.
    const earlier = withResults(4, "something else");
    const r = await round([...earlier, { role: "user", content: TOOLROWS_PROMPT }]);
    expect(r.calls.map((c) => c.name)).toEqual(["shell", "shell"]);
  });

  test("another prompt is untouched: no reasoning, no call", async () => {
    const r = await round(withResults(0, "hello"));
    expect(r.reasoning).toBe("");
    expect(r.calls).toEqual([]);
  });
});
