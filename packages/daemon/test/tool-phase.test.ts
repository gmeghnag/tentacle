/** `tool_phase` → `tool_call_phase` (T-W, docs/feat/parallel-tools.md). */
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import { PROTOCOL_VERSION, SessionUpdateSchema, UPDATE_CLASS } from "@tentacle/protocol";
import { eventToUpdate } from "../src/mapping.ts";

describe("tool_call_phase on the wire (T-W)", () => {
  test("each phase maps to a display update keyed by the call", () => {
    for (const phase of ["queued", "running"] as const) {
      const event: AgentEvent = { type: "tool_phase", id: "c1", phase };
      expect(eventToUpdate(event)).toEqual({ type: "tool_call_phase", toolCallId: "c1", phase });
    }
    expect(UPDATE_CLASS.tool_call_phase).toBe("display");
  });

  test("the schema keeps phase a free string (an unknown one parses; the client skips it)", () => {
    const parsed = SessionUpdateSchema.safeParse({
      type: "tool_call_phase",
      toolCallId: "c1",
      phase: "from_the_future",
    });
    expect(parsed.success).toBe(true);
    expect(
      SessionUpdateSchema.safeParse({ type: "tool_call_phase", toolCallId: "", phase: "running" })
        .success,
    ).toBe(false);
  });

  test("PROTOCOL_VERSION is at least 15: a peer without the signal fails at initialize", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(15);
  });
});
