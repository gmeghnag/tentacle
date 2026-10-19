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
    { type: "background_exit", jobId: "j1", command: "ls", status: "exited", exitCode: 0 },
    { type: "steer", text: "also do X" },
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

  test("the discriminated union selects the steer member", () => {
    const parsed = SessionUpdateSchema.parse({ type: "steer", text: "also do X" });
    expect(parsed.type).toBe("steer");
    if (parsed.type === "steer") {
      expect(parsed.text).toBe("also do X");
    }
    // The wrapped notification params carry it too.
    const wrapped = SessionUpdateParamsSchema.safeParse({
      sessionId: "s1",
      update: { type: "steer", text: "also do X" },
    });
    expect(wrapped.success).toBe(true);
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
