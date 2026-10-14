import { describe, expect, test } from "bun:test";
import { SessionUpdateParamsSchema, SessionUpdateSchema } from "../src/index.ts";

describe("session/update payloads", () => {
  const variants = [
    { type: "agent_message_chunk", content: { type: "text", text: "hello" } },
    { type: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    { type: "tool_call", toolCallId: "t1", title: "read file", status: "pending" },
    {
      type: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "text", text: "done" }],
    },
    { type: "plan", entries: [{ content: "step 1", status: "in_progress" }] },
  ];

  test("every update variant parses", () => {
    for (const v of variants) {
      expect(SessionUpdateSchema.safeParse(v).success).toBe(true);
    }
  });

  test("the discriminated union selects the right member", () => {
    const parsed = SessionUpdateSchema.parse({
      type: "tool_call",
      toolCallId: "t9",
      title: "run",
      status: "in_progress",
    });
    expect(parsed.type).toBe("tool_call");
    if (parsed.type === "tool_call") {
      expect(parsed.toolCallId).toBe("t9");
    }
  });

  test("rejects an unknown update type", () => {
    expect(SessionUpdateSchema.safeParse({ type: "mystery" }).success).toBe(false);
  });

  test("rejects an invalid tool-call status", () => {
    expect(
      SessionUpdateSchema.safeParse({
        type: "tool_call",
        toolCallId: "t",
        title: "x",
        status: "weird",
      }).success,
    ).toBe(false);
  });

  test("notification params wrap sessionId + update", () => {
    const r = SessionUpdateParamsSchema.safeParse({
      sessionId: "s1",
      update: { type: "agent_message_chunk", content: { type: "text", text: "x" } },
    });
    expect(r.success).toBe(true);
  });
});
