import { describe, expect, test } from "bun:test";
import { HeuristicTokenCounter } from "../src/index.ts";
import type { ChatMessage } from "../src/index.ts";

describe("HeuristicTokenCounter", () => {
  const counter = new HeuristicTokenCounter();

  test("empty text counts as zero", () => {
    expect(counter.countText("")).toBe(0);
  });

  test("rounds up at ~4 chars per token", () => {
    expect(counter.countText("abcd")).toBe(1); // 4/4
    expect(counter.countText("abcde")).toBe(2); // ceil(5/4)
  });

  test("honours a custom charsPerToken", () => {
    const c = new HeuristicTokenCounter({ charsPerToken: 2 });
    expect(c.countText("abcd")).toBe(2);
  });

  test("rejects a non-positive charsPerToken", () => {
    expect(() => new HeuristicTokenCounter({ charsPerToken: 0 })).toThrow(RangeError);
  });

  test("counts a message with per-message overhead", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "abcd" }];
    // overhead(4) + content(1)
    expect(counter.countMessages(messages)).toBe(5);
  });

  test("includes tool calls in the message count", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "run", arguments: "{}" }],
      },
    ];
    // overhead(4) + content(0) + name "run"(1) + args "{}"(1)
    expect(counter.countMessages(messages)).toBe(6);
  });
});
