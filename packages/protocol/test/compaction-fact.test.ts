/**
 * docs/feat/harness-notices.md S1: the compaction summary's `compacted` fact
 * is a display-only, FAIL-SOFT message field (like `note`): a valid one is
 * kept, a malformed one is dropped and the CRITICAL `message` entry still
 * loads, and an older schema without it strips it (forward compatibility).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ChatMessageSchema, CompactResultSchema, LogMessageEntrySchema } from "../src/index.ts";

const summary = { role: "user", content: "Summary of the earlier conversation" };
const entry = (message: unknown) => ({
  type: "message",
  seq: 2,
  id: "e2",
  prev: "e1",
  ts: 1,
  critical: true,
  message,
});

describe("ChatMessage.compacted", () => {
  test("a valid fact is kept, exact or estimated", () => {
    const exact = { fromTokens: 182000, toTokens: 9000, toExact: true as const };
    expect(ChatMessageSchema.parse({ ...summary, compacted: exact }).compacted).toEqual(exact);
    const est = { fromTokens: 182000, toTokens: 9000 };
    expect(ChatMessageSchema.parse({ ...summary, compacted: est }).compacted).toEqual(est);
  });

  test("a malformed fact is dropped and the message still parses", () => {
    for (const bad of [
      { fromTokens: -1, toTokens: 9000 },
      { fromTokens: 1.5, toTokens: 9000 },
      { fromTokens: 182000 },
      { fromTokens: 182000, toTokens: 9000, toExact: false },
      "182k",
    ]) {
      const parsed = ChatMessageSchema.parse({ ...summary, compacted: bad });
      expect(parsed.compacted).toBeUndefined();
      expect(parsed.content).toBe(summary.content);
    }
  });

  test("the critical message log entry carries it, and loads when it is malformed", () => {
    const fact = { fromTokens: 182000, toTokens: 9000 };
    expect(
      LogMessageEntrySchema.parse(entry({ ...summary, compacted: fact })).message.compacted,
    ).toEqual(fact);
    const broken = LogMessageEntrySchema.safeParse(
      entry({ ...summary, compacted: { toTokens: "x" } }),
    );
    expect(broken.success).toBe(true);
  });

  test("an older schema without the field strips it (forward compatibility)", () => {
    const older = z.object({ role: z.string(), content: z.string() });
    const parsed = older.parse({ ...summary, compacted: { fromTokens: 1, toTokens: 1 } });
    expect(parsed).toEqual(summary);
  });
});

describe("session/compact result", () => {
  test("carries the optional context sizes; an older daemon's result still parses", () => {
    const full = { before: 40, after: 2, fromTokens: 182000, toTokens: 9000, toExact: true };
    expect(CompactResultSchema.parse(full)).toEqual(full);
    expect(CompactResultSchema.parse({ before: 40, after: 2 })).toEqual({ before: 40, after: 2 });
  });
});
