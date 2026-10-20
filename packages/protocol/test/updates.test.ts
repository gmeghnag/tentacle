import { describe, expect, test } from "bun:test";
import {
  SessionUpdateParamsSchema,
  SessionUpdateSchema,
  UPDATE_CLASS,
  isKnownUpdateType,
} from "../src/index.ts";

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
    { type: "turn_start", turnId: "t1", prompt: "go" },
    { type: "turn_end", turnId: "t1", stopReason: "end_turn" },
    { type: "turn_end", turnId: "t1", stopReason: "error", error: { message: "boom" } },
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
      seq: 1,
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
      seq: 1,
      update: { type: "agent_message_chunk", content: { type: "text", text: "x" } },
    });
    expect(r.success).toBe(true);
  });
});

describe("session/update frame (event classes, catch-all, required seq)", () => {
  const frame = (extra: Record<string, unknown>) => ({ sessionId: "s1", seq: 4, ...extra });

  test("an unknown display event is accepted (skipped by the client, its seq still counts)", () => {
    const r = SessionUpdateParamsSchema.safeParse(frame({ update: { type: "progress", pct: 3 } }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.seq).toBe(4);
  });

  test("an unknown mandatory event is accepted with its flag (the client fails loudly)", () => {
    const r = SessionUpdateParamsSchema.safeParse(
      frame({ mandatory: true, update: { type: "future_mandatory", id: "p" } }),
    );
    expect(r.success && r.data.mandatory).toBe(true);
  });

  test("seq is required", () => {
    const r = SessionUpdateParamsSchema.safeParse({
      sessionId: "s1",
      update: { type: "steer", text: "x" },
    });
    expect(r.success).toBe(false);
  });

  test("mandatory has one encoding: true or absent, never false", () => {
    const r = SessionUpdateParamsSchema.safeParse(
      frame({ mandatory: false, update: { type: "steer", text: "x" } }),
    );
    expect(r.success).toBe(false);
  });

  test("a valid known event still parses as its member, not as the catch-all", () => {
    const r = SessionUpdateParamsSchema.safeParse(
      frame({ update: { type: "agent_message_chunk", content: { type: "text", text: "hi" } } }),
    );
    // The catch-all keeps only `type`; the member keeps `content`.
    expect(r.success && r.data.update).toEqual({
      type: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
  });

  test("an empty type is rejected even by the catch-all", () => {
    expect(SessionUpdateParamsSchema.safeParse(frame({ update: { type: "" } })).success).toBe(
      false,
    );
  });

  test("the turn bracket, the history barrier and the close are mandatory, everything else display", () => {
    // A client that cannot act on turn_start/turn_end would hang the turn; one
    // that skips history_replaced would apply updates over a stale history; one
    // that skips session_closed would show a dead session as live; one that skips a
    // permission event would leave a suspended turn unanswerable (or a stale dialog).
    const mandatory = Object.entries(UPDATE_CLASS)
      .filter(([, c]) => c === "mandatory")
      .map(([t]) => t)
      .sort();
    expect(mandatory).toEqual([
      "history_replaced",
      "permission_request",
      "permission_resolved",
      "session_closed",
      "turn_end",
      "turn_start",
    ]);
  });

  test("turn_end carries a valid stop reason and a turnId", () => {
    const bad = [
      { type: "turn_end", stopReason: "end_turn" },
      { type: "turn_end", turnId: "", stopReason: "end_turn" },
      { type: "turn_end", turnId: "t", stopReason: "nope" },
      { type: "turn_end", turnId: "t", stopReason: "error", error: {} },
      { type: "turn_start", turnId: "t" },
    ];
    for (const u of bad) expect(SessionUpdateSchema.safeParse(u).success).toBe(false);
  });

  test("every known type has a class; only own keys count as known", () => {
    for (const type of Object.keys(UPDATE_CLASS)) expect(isKnownUpdateType(type)).toBe(true);
    for (const v of ["progress", "toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(isKnownUpdateType(v)).toBe(false);
    }
  });
});
