/**
 * docs/fix/thought-placeholder.md: an assistant message's `thought` placeholder
 * (`{ ms }`, never the reasoning text) is display-only and FAIL-SOFT: a valid one
 * is kept, a malformed one is dropped and the CRITICAL `message` entry still
 * loads, an older schema strips it. Additive on strip schemas: no version bump.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ChatMessageSchema, LogMessageEntrySchema } from "../src/index.ts";

const reply = { role: "assistant", content: "hello" };
const entry = (message: unknown) => ({
  type: "message",
  seq: 2,
  id: "e2",
  prev: "e1",
  ts: 1,
  critical: true,
  message,
});

describe("ChatMessage.thought", () => {
  test("a valid placeholder is kept; a message without it has none", () => {
    expect(ChatMessageSchema.parse({ ...reply, thought: { ms: 12_400 } }).thought).toEqual({
      ms: 12_400,
    });
    expect(ChatMessageSchema.parse(reply)).not.toHaveProperty("thought");
  });

  test("a malformed placeholder is dropped and the message still parses", () => {
    for (const bad of [{ ms: -1 }, { ms: 1.5 }, { ms: "12" }, { ms: 86_400_001 }, {}, 12, null]) {
      const parsed = ChatMessageSchema.parse({ ...reply, thought: bad });
      expect(parsed.thought).toBeUndefined();
      expect(parsed.content).toBe("hello");
    }
  });

  test("a reasoning text a newer build might add is stripped, never kept", () => {
    const parsed = ChatMessageSchema.parse({ ...reply, thought: { ms: 5, text: "secret" } });
    expect(parsed.thought).toEqual({ ms: 5 });
  });

  test("the critical message log entry carries it, and loads when it is malformed", () => {
    expect(
      LogMessageEntrySchema.parse(entry({ ...reply, thought: { ms: 7 } })).message.thought,
    ).toEqual({ ms: 7 });
    expect(LogMessageEntrySchema.safeParse(entry({ ...reply, thought: "x" })).success).toBe(true);
  });

  test("an older reader without the field strips it (forward compatibility)", () => {
    const older = z.object({ role: z.string(), content: z.string() });
    expect(older.parse({ ...reply, thought: { ms: 7 } })).toEqual(reply);
  });
});
