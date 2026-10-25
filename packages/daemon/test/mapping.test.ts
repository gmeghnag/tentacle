import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import type { ToolResult } from "@tentacle/core";
import { JsonRpcErrorCode, type SessionUpdate, UPDATE_CLASS } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  DIFF_MIME,
  HOOK_MIME,
  assertTextOnly,
  contentToText,
  eventToUpdate,
  stopReasonToProtocol,
  toUpdateParams,
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

  test("a hook intervention rides as a hook:// resource block (reason in text, H1)", () => {
    expect(
      toolResultContent({
        content: "Blocked by a hook: `shell` was not run. Reason: no",
        isError: true,
        hook: { action: "blocked", name: "no-rm", reason: "no" },
      })[1],
    ).toEqual({ type: "resource", uri: "hook://blocked/no-rm", mimeType: HOOK_MIME, text: "no" });
    expect(
      toolResultContent({ content: "x", hook: { action: "modified", name: "a/b" } })[1],
    ).toEqual({
      type: "resource",
      uri: "hook://modified/a/b",
      mimeType: HOOK_MIME,
    });
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

describe("toUpdateParams (the session/update frame)", () => {
  const samples: SessionUpdate[] = [
    { type: "agent_message_chunk", content: { type: "text", text: "a" } },
    { type: "agent_thought_chunk", content: { type: "text", text: "t" } },
    { type: "tool_call", toolCallId: "t", title: "x", status: "pending" },
    { type: "tool_call_update", toolCallId: "t", status: "completed" },
    { type: "plan", entries: [] },
    { type: "agent_usage", promptTokens: 1, completionTokens: 2 },
    { type: "background_exit", jobId: "j", command: "c", status: "exited", exitCode: null },
    { type: "steer", text: "s" },
    { type: "turn_start", turnId: "t", prompt: "p" },
    { type: "turn_end", turnId: "t", stopReason: "end_turn" },
    { type: "history_replaced", reason: "compact" },
    { type: "session_closed", reason: "closed" },
    { type: "context_note", text: "Continue with the task.", reason: "continue" },
    {
      type: "permission_request",
      requestId: "r",
      toolCallId: "t",
      tool: "shell",
      title: "x",
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    },
    { type: "permission_resolved", requestId: "r", outcome: { outcome: "cancelled" } },
    { type: "session_title", title: "Fix login", source: "model" },
    {
      type: "queued",
      entries: [{ id: "a", text: "A" }],
      returned: [{ id: "b", text: "B", cause: "cancelled" }],
    },
  ];

  test("covers every known type (keeps the samples honest)", () => {
    const types: string[] = samples.map((u) => u.type).sort();
    expect(types).toEqual(Object.keys(UPDATE_CLASS).sort());
  });

  test("display updates carry no mandatory key at all (omitted, never false)", () => {
    for (const update of samples.filter((u) => UPDATE_CLASS[u.type] === "display")) {
      const params = toUpdateParams("s1", 7, update);
      expect(params).toEqual({ sessionId: "s1", seq: 7, update });
      expect("mandatory" in params).toBe(false);
    }
  });

  test("the real table: the turn bracket, the history barrier, the close and the permission events carry mandatory: true", () => {
    for (const update of samples) {
      const params = toUpdateParams("s1", 1, update);
      const mandatory =
        update.type === "turn_start" ||
        update.type === "turn_end" ||
        update.type === "history_replaced" ||
        update.type === "session_closed" ||
        update.type === "permission_request" ||
        update.type === "permission_resolved";
      expect(params.mandatory === true).toBe(mandatory);
    }
  });

  test("mandatory: true iff the class table says mandatory", () => {
    // Every type display except `steer`: the flag follows the injected table only.
    const classes = Object.fromEntries(
      Object.keys(UPDATE_CLASS).map((t) => [t, t === "steer" ? "mandatory" : "display"]),
    ) as Record<keyof typeof UPDATE_CLASS, "display" | "mandatory">;
    for (const update of samples) {
      const params = toUpdateParams("s1", 1, update, classes);
      expect("mandatory" in params).toBe(update.type === "steer");
      if (update.type === "steer") expect(params.mandatory).toBe(true);
    }
  });
});

describe("assertTextOnly (explicit reject until attachments land)", () => {
  test("text-only content passes", () => {
    expect(() => assertTextOnly([{ type: "text", text: "a" }])).not.toThrow();
  });

  for (const block of [
    { type: "image", mimeType: "image/png", data: "AA==" },
    { type: "resource", uri: "file:///a", text: "x" },
  ] as const) {
    test(`a ${block.type} block is rejected with InvalidParams naming it`, () => {
      let caught: unknown;
      try {
        assertTextOnly([{ type: "text", text: "look" }, block]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RpcError);
      expect(caught).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
      expect(String((caught as Error).message)).toContain(block.type);
    });
  }
});
