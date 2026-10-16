import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import type { ToolResult } from "@tentacle/core";
import {
  DIFF_MIME,
  contentToText,
  eventToUpdate,
  stopReasonToProtocol,
  toolResultContent,
} from "../src/mapping.ts";

describe("stopReasonToProtocol", () => {
  test("maps every agent stop reason, including max_iterations losslessly", () => {
    expect(stopReasonToProtocol("end_turn")).toBe("end_turn");
    expect(stopReasonToProtocol("cancelled")).toBe("cancelled");
    expect(stopReasonToProtocol("max_iterations")).toBe("max_iterations");
  });
});

describe("eventToUpdate", () => {
  test("text → agent_message_chunk", () => {
    expect(eventToUpdate({ type: "text", delta: "hi" })).toEqual({
      type: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
  });

  test("reasoning → agent_thought_chunk", () => {
    expect(eventToUpdate({ type: "reasoning", delta: "hmm" })).toEqual({
      type: "agent_thought_chunk",
      content: { type: "text", text: "hmm" },
    });
  });

  test("tool_start → tool_call with parsed rawInput", () => {
    const ev: AgentEvent = {
      type: "tool_start",
      id: "c1",
      name: "shell",
      arguments: '{"command":"ls"}',
    };
    expect(eventToUpdate(ev)).toEqual({
      type: "tool_call",
      toolCallId: "c1",
      title: "shell",
      status: "in_progress",
      rawInput: { command: "ls" },
    });
  });

  test("tool_result failure → tool_call_update status failed", () => {
    const ev: AgentEvent = {
      type: "tool_result",
      id: "c1",
      name: "shell",
      result: { content: "boom", isError: true },
    };
    const update = eventToUpdate(ev);
    expect(update?.type).toBe("tool_call_update");
    if (update?.type === "tool_call_update") {
      expect(update.status).toBe("failed");
    }
  });

  test("usage → agent_usage", () => {
    expect(
      eventToUpdate({ type: "usage", usage: { promptTokens: 10, completionTokens: 3 } }),
    ).toEqual({ type: "agent_usage", promptTokens: 10, completionTokens: 3 });
  });

  test("turn_end has no streamed update", () => {
    expect(eventToUpdate({ type: "turn_end", reason: "end_turn" })).toBeNull();
  });
});

describe("toolResultContent", () => {
  test("embeds a unified diff as a text/x-diff resource block", () => {
    const result: ToolResult = {
      content: "edited a.txt",
      details: {
        kind: "diff",
        path: "a.txt",
        patch: "@@ -1 +1 @@\n-a\n+b\n",
        added: 1,
        removed: 1,
      },
    };
    const blocks = toolResultContent(result);
    expect(blocks[0]).toEqual({ type: "text", text: "edited a.txt" });
    expect(blocks[1]).toEqual({
      type: "resource",
      uri: "diff://a.txt",
      mimeType: DIFF_MIME,
      text: "@@ -1 +1 @@\n-a\n+b\n",
    });
  });

  test("omits empty content", () => {
    expect(toolResultContent({ content: "   " })).toEqual([]);
  });
});

describe("contentToText", () => {
  test("flattens text blocks and ignores non-text", () => {
    expect(
      contentToText([
        { type: "text", text: "one" },
        { type: "image", mimeType: "image/png", data: "x" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });
});
