import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@tentacle/protocol";
import { updateToEvent } from "../src/mapping.ts";

// docs/feat/subagent-detach.md T27: a child that MOVED to the background ends
// its tool call with `stopReason: "background"` and its `sa-N` id, and the
// client maps that id through `progressText` like every other pod-supplied text
// (the field is optional on the wire: an older daemon never sends it).

const names = new Map<string, string>();

describe("T27: subagent_end carries the moved id", () => {
  test("agentId maps through, and a moved end keeps its stopReason", () => {
    const update: SessionUpdate = {
      type: "tool_progress",
      toolCallId: "c1",
      kind: "subagent_end",
      toolUses: 2,
      stopReason: "background",
      agentId: "sa-1",
    };
    expect(updateToEvent(update, names)).toEqual({
      type: "subagent_end",
      id: "c1",
      toolUses: 2,
      stopReason: "background",
      agentId: "sa-1",
    });
  });

  test("absent: no `agentId` key at all (an older daemon's frame)", () => {
    const event = updateToEvent(
      {
        type: "tool_progress",
        toolCallId: "c1",
        kind: "subagent_end",
        toolUses: 1,
        stopReason: "end_turn",
      },
      names,
    );
    expect(event).toEqual({ type: "subagent_end", id: "c1", toolUses: 1, stopReason: "end_turn" });
    expect(event).not.toHaveProperty("agentId");
  });

  test("a pod's agentId is sanitized like every other pod text", () => {
    expect(
      updateToEvent(
        {
          type: "tool_progress",
          toolCallId: "c1",
          kind: "subagent_end",
          toolUses: 0,
          stopReason: "background",
          agentId: "sa-1\u001b[31m\nx",
        },
        names,
      ),
    ).toEqual({
      type: "subagent_end",
      id: "c1",
      toolUses: 0,
      stopReason: "background",
      agentId: "sa-1 [31m x",
    });
  });
});
