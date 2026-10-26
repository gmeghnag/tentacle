/**
 * The pure context-awareness module (docs/feat/context-awareness.md): the
 * `[context: …]` line, when a new step emits one, the render that puts it into
 * the model's copy of a message, and the estimate of the next request's size.
 */
import { describe, expect, test } from "bun:test";
import { type ChatMessage, HeuristicTokenCounter } from "@tentacle/core";
import {
  contextLine,
  estimateUsed,
  lastEmitted,
  renderForModel,
  shouldEmit,
} from "../src/context-awareness.ts";

const counter = new HeuristicTokenCounter();

describe("contextLine", () => {
  test("formats tokens as is, in k, in M; the percentage is floored and never capped", () => {
    expect(contextLine({ used: 950, window: 128000 })).toBe("[context: 950 / 128k tokens (0%)]");
    expect(contextLine({ used: 82000, window: 128000 })).toBe("[context: 82k / 128k tokens (64%)]");
    expect(contextLine({ used: 1_000_000, window: 2_000_000 })).toBe(
      "[context: 1.0M / 2.0M tokens (50%)]",
    );
    expect(contextLine({ used: 999_600, window: 1_000_000 })).toBe(
      "[context: 1.0M / 1.0M tokens (99%)]",
    );
    expect(contextLine({ used: 132000, window: 128000 })).toBe(
      "[context: 132k / 128k tokens (103%)]",
    );
  });
});

describe("shouldEmit", () => {
  const at = (pct: number) => ({ used: pct * 1000, window: 100000 });
  test("the first value always emits", () => {
    expect(shouldEmit(at(0), undefined, 1)).toBe(true);
  });
  test("the same step emits nothing; the next one does", () => {
    expect(shouldEmit({ used: 40900, window: 100000 }, at(40), 1)).toBe(false);
    expect(shouldEmit(at(41), at(40), 1)).toBe(true);
  });
  test("a jump of several steps is one emission; a decrease is none", () => {
    expect(shouldEmit(at(47), at(40), 1)).toBe(true);
    expect(shouldEmit(at(39), at(40), 1)).toBe(false);
  });
  test("a 5% step emits only when a new multiple of 5 is crossed", () => {
    expect(shouldEmit(at(44), at(40), 5)).toBe(false);
    expect(shouldEmit(at(45), at(44), 5)).toBe(true);
  });
  test("a different window compares percentages, not tokens", () => {
    expect(shouldEmit({ used: 41000, window: 200000 }, at(40), 1)).toBe(false);
  });
});

describe("lastEmitted", () => {
  test("none without a line; the LATEST one otherwise", () => {
    expect(lastEmitted([{ role: "user", content: "a" }])).toBeUndefined();
    const history: ChatMessage[] = [
      { role: "user", content: "a", contextUsage: { used: 1, window: 10 } },
      { role: "assistant", content: "b" },
      { role: "tool", content: "c", toolCallId: "t", contextUsage: { used: 5, window: 10 } },
      { role: "assistant", content: "d" },
    ];
    expect(lastEmitted(history)).toEqual({ used: 5, window: 10 });
  });
});

describe("renderForModel", () => {
  test("appends the line, keeps every other field, drops contextUsage", () => {
    const m: ChatMessage = {
      role: "tool",
      content: "out",
      toolCallId: "t1",
      durationMs: 7,
      contextUsage: { used: 82000, window: 128000 },
    };
    expect(renderForModel(m)).toEqual({
      role: "tool",
      content: "out\n\n[context: 82k / 128k tokens (64%)]",
      toolCallId: "t1",
      durationMs: 7,
    });
  });
  test("a message without the field is returned as is (same object)", () => {
    const m: ChatMessage = { role: "user", content: "hi" };
    expect(renderForModel(m)).toBe(m);
  });
});

describe("estimateUsed", () => {
  const tools = [{ name: "t", description: "d", parameters: { type: "object" } }];
  const history: ChatMessage[] = [
    { role: "system", content: "s".repeat(40) },
    { role: "user", content: "u".repeat(80) },
    { role: "assistant", content: "a".repeat(400) },
  ];
  test("no anchor: the rendered history plus the tool definitions", () => {
    expect(estimateUsed(history, tools, undefined, counter)).toBe(
      counter.countMessages(history) + counter.countText(JSON.stringify(tools)),
    );
  });
  test("a valid anchor: the measured prompt plus only what came after it", () => {
    const anchor = { promptTokens: 5000, len: 2, ref: history[1] as ChatMessage };
    expect(estimateUsed(history, tools, anchor, counter)).toBe(
      5000 + counter.countMessages(history.slice(2)),
    );
  });
  test("what came after is counted RENDERED (its line costs tokens too)", () => {
    const tail: ChatMessage = {
      role: "user",
      content: "x",
      contextUsage: { used: 1, window: 10 },
    };
    const h = [...history, tail];
    const anchor = { promptTokens: 5000, len: 3, ref: history[2] as ChatMessage };
    expect(estimateUsed(h, tools, anchor, counter)).toBe(
      5000 + counter.countMessages([renderForModel(tail)]),
    );
  });
  test("an anchor whose message was replaced (compaction) or cut (shorter history) is ignored", () => {
    const fallback = counter.countMessages(history) + counter.countText(JSON.stringify(tools));
    const stale = { promptTokens: 5000, len: 2, ref: { role: "user", content: "old" } as const };
    expect(estimateUsed(history, tools, stale, counter)).toBe(fallback);
    const beyond = { promptTokens: 5000, len: 9, ref: history[1] as ChatMessage };
    expect(estimateUsed(history, tools, beyond, counter)).toBe(fallback);
  });
});
