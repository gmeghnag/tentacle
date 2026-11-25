/**
 * docs/fix/reasoning-echo.md D8 (T4, schema half): an assistant message's
 * `reasoning` record — the model's own reasoning, as its provider must get it
 * back — rides the CRITICAL `message` entry and the pod model wire FAIL-SOFT:
 * a valid record is kept byte-identical, a malformed or oversized one is
 * dropped WHOLE (never cut) and the message still loads; an older schema
 * strips it. Additive on strip schemas: no version bump.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ChatMessageSchema,
  LogMessageEntrySchema,
  MessageWithoutAttachmentsSchema,
  WireChatMessageSchema,
  type WireReasoningRecord,
  WireStreamEventSchema,
} from "../src/index.ts";

const MiB = 1024 * 1024;
const reply = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "c1", name: "ls", arguments: "{}" }],
};
const entry = (message: unknown) => ({
  type: "message",
  seq: 2,
  id: "e2",
  prev: "e1",
  ts: 1,
  critical: true,
  message,
});

const openai: WireReasoningRecord = {
  source: "openai:deepseek",
  body: { format: "openai", field: "reasoning_content", text: "I should list the dir first." },
};
const openaiAlt: WireReasoningRecord = {
  source: "openai:qwen",
  body: { format: "openai", field: "reasoning", text: "Let me think." },
};
const anthropic: WireReasoningRecord = {
  source: "anthropic:claude",
  body: {
    format: "anthropic",
    blocks: [
      { type: "thinking", thinking: "plan: ls", signature: "sig-1" },
      // `display: "omitted"`: an empty thinking with a signature is exactly what the API wants back.
      { type: "thinking", thinking: "", signature: "sig-2" },
      { type: "redacted_thinking", data: "opaque==" },
    ],
  },
};

describe("ChatMessage.reasoning", () => {
  test("a valid record is kept byte-identical, in every format; a message without it has none", () => {
    for (const record of [openai, openaiAlt, anthropic]) {
      const parsed = ChatMessageSchema.parse({ ...reply, reasoning: record });
      expect(JSON.stringify(parsed.reasoning)).toBe(JSON.stringify(record));
    }
    expect(ChatMessageSchema.parse(reply)).not.toHaveProperty("reasoning");
  });

  test("a malformed record is dropped whole and the message still parses", () => {
    const bad: unknown[] = [
      "text",
      12,
      null,
      {},
      { source: "openai:m" },
      { source: "", body: openai.body },
      { source: "openai:m", body: { format: "openai", field: "thoughts", text: "x" } },
      { source: "openai:m", body: { format: "openai", field: "reasoning", text: "" } },
      { source: "openai:m", body: { format: "gemini", text: "x" } },
      { source: "a:m", body: { format: "anthropic", blocks: [] } },
      // an unsigned thinking block would 400 on echo: never stored
      {
        source: "a:m",
        body: { format: "anthropic", blocks: [{ type: "thinking", thinking: "t" }] },
      },
      {
        source: "a:m",
        body: { format: "anthropic", blocks: [{ type: "thinking", thinking: "t", signature: "" }] },
      },
      { source: "a:m", body: { format: "anthropic", blocks: [{ type: "text", text: "t" }] } },
      { source: "a:m", body: { format: "anthropic", blocks: [{ type: "redacted_thinking" }] } },
    ];
    for (const value of bad) {
      const parsed = ChatMessageSchema.parse({ ...reply, reasoning: value });
      expect(parsed.reasoning).toBeUndefined();
      expect(parsed.toolCalls).toEqual(reply.toolCalls);
    }
  });

  test("bounds are a guard, not a cap: a value over one is dropped whole, at the bound it is kept", () => {
    const text = (n: number): WireReasoningRecord => ({
      source: "openai:m",
      body: { format: "openai", field: "reasoning", text: "x".repeat(n) },
    });
    expect(ChatMessageSchema.parse({ ...reply, reasoning: text(MiB) }).reasoning).toEqual(
      text(MiB),
    );
    expect(
      ChatMessageSchema.parse({ ...reply, reasoning: text(MiB + 1) }).reasoning,
    ).toBeUndefined();
    const source = (n: number): WireReasoningRecord => ({ ...openai, source: "s".repeat(n) });
    expect(ChatMessageSchema.parse({ ...reply, reasoning: source(256) }).reasoning).toEqual(
      source(256),
    );
    expect(ChatMessageSchema.parse({ ...reply, reasoning: source(257) }).reasoning).toBeUndefined();
    const blocks = (n: number): WireReasoningRecord => ({
      source: "a:m",
      body: {
        format: "anthropic",
        blocks: Array.from({ length: n }, () => ({ type: "redacted_thinking", data: "d" })),
      },
    });
    expect(ChatMessageSchema.parse({ ...reply, reasoning: blocks(64) }).reasoning).toEqual(
      blocks(64),
    );
    expect(ChatMessageSchema.parse({ ...reply, reasoning: blocks(65) }).reasoning).toBeUndefined();
    const big = (field: "thinking" | "signature" | "data"): WireReasoningRecord => ({
      source: "a:m",
      body: {
        format: "anthropic",
        blocks: [
          field === "data"
            ? { type: "redacted_thinking", data: "d".repeat(MiB + 1) }
            : { type: "thinking", thinking: "t", signature: "s", [field]: "z".repeat(MiB + 1) },
        ],
      },
    });
    for (const field of ["thinking", "signature", "data"] as const) {
      expect(
        ChatMessageSchema.parse({ ...reply, reasoning: big(field) }).reasoning,
      ).toBeUndefined();
    }
  });

  test("the critical message log entry carries it, and loads when it is malformed", () => {
    expect(
      LogMessageEntrySchema.parse(entry({ ...reply, reasoning: anthropic })).message.reasoning,
    ).toEqual(anthropic);
    const loaded = LogMessageEntrySchema.safeParse(entry({ ...reply, reasoning: { source: 1 } }));
    expect(loaded.success).toBe(true);
    expect(loaded.success && loaded.data.message.reasoning).toBeUndefined();
    expect(
      MessageWithoutAttachmentsSchema.parse({ ...reply, reasoning: openai }).reasoning,
    ).toEqual(openai);
  });

  test("an older reader without the field strips it (forward compatibility)", () => {
    const older = z.object({ role: z.string(), content: z.string() });
    expect(older.parse({ role: "assistant", content: "", reasoning: openai })).toEqual({
      role: "assistant",
      content: "",
    });
  });
});

describe("the pod model wire carries it (docs/fix/reasoning-echo.md P3)", () => {
  test("a request message keeps a valid record and drops a malformed one", () => {
    expect(WireChatMessageSchema.parse({ ...reply, reasoning: anthropic }).reasoning).toEqual(
      anthropic,
    );
    const bad = WireChatMessageSchema.parse({ ...reply, reasoning: { source: "x", body: "y" } });
    expect(bad.reasoning).toBeUndefined();
    expect(bad.toolCalls).toEqual(reply.toolCalls);
  });

  test("a `done` event keeps a valid record and drops a malformed one (never a failed turn)", () => {
    const done = WireStreamEventSchema.parse({
      type: "done",
      stopReason: "tool_calls",
      reasoning: openai,
    });
    expect(done.type === "done" && done.reasoning).toEqual(openai);
    const bad = WireStreamEventSchema.parse({ type: "done", stopReason: "stop", reasoning: 7 });
    expect(bad).toEqual({ type: "done", stopReason: "stop" });
  });
});
