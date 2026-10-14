import { describe, expect, test } from "bun:test";
import { DefaultContextManager, HeuristicTokenCounter } from "../src/index.ts";
import type { ChatMessage } from "../src/index.ts";

describe("DefaultContextManager", () => {
  const counter = new HeuristicTokenCounter();
  const mgr = new DefaultContextManager(counter, { contextWindow: 20, reserveForOutput: 8 });
  // compaction threshold = 20 - 8 = 12 tokens

  test("used() delegates to the counter", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "abcd" }];
    expect(mgr.used(messages)).toBe(counter.countMessages(messages));
  });

  test("does not need compaction below the threshold", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "abcd" }]; // 5 tokens
    expect(mgr.needsCompaction(messages)).toBe(false);
  });

  test("needs compaction above the threshold", () => {
    const big = "x".repeat(60); // ceil(60/4)=15 tokens + 4 overhead = 19 > 12
    const messages: ChatMessage[] = [{ role: "user", content: big }];
    expect(mgr.needsCompaction(messages)).toBe(true);
  });
});
