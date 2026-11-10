import { describe, expect, test } from "bun:test";
import {
  UNANSWERED_CALL_NOTE,
  answerOutstandingCalls,
  describeRepairs,
  invalidArgumentsMarker,
  invalidArgumentsNote,
  repairCounts,
  repairHistory,
  validateHistory,
  wireArguments,
} from "../src/index.ts";
import type { ChatMessage, ToolCall } from "../src/index.ts";

/** The incident's shape: an unterminated JSON string (one past its 167,794 chars). */
const BAD = '{"path":"a.txt","content":"line1\nunterminated';

const call = (id: string, args: string, name = "fs_write"): ToolCall => ({
  id,
  name,
  arguments: args,
});

const assistant = (calls: readonly ToolCall[], content = ""): ChatMessage => ({
  role: "assistant",
  content,
  toolCalls: calls,
});

const result = (id: string, content = "ok"): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: id,
});

const user = (content: string): ChatMessage => ({ role: "user", content });

/** Roles + the ids/content the rules decide, for readable assertions. */
function shape(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls && m.toolCalls.length > 0
      ? { calls: m.toolCalls.map((c) => [c.id, c.arguments]) }
      : {}),
    ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
  }));
}

describe("wireArguments", () => {
  test("a JSON object is kept byte for byte", () => {
    expect(wireArguments('{"path":"a.txt"}')).toBe('{"path":"a.txt"}');
  });

  test("an empty or blank string becomes {}", () => {
    expect(wireArguments("")).toBe("{}");
    expect(wireArguments("  \n ")).toBe("{}");
  });

  test("invalid JSON becomes the marker, with its UTF-8 byte count", () => {
    expect(wireArguments('{"a":')).toBe('{"_invalid_arguments":true,"bytes":5}');
    expect(invalidArgumentsMarker(5)).toBe('{"_invalid_arguments":true,"bytes":5}');
  });

  test('non-object JSON becomes the marker: [], "x", null, 1, true', () => {
    for (const raw of ["[]", '"x"', "null", "1", "true", "[1,2]"]) {
      expect(wireArguments(raw)).toBe(invalidArgumentsMarker(raw.length));
    }
  });

  test("the marker is idempotent (it is a plain object)", () => {
    const marker = wireArguments(BAD);
    expect(wireArguments(marker)).toBe(marker);
  });

  test("bytes are UTF-8, not code units", () => {
    // '"é"' is 4 chars, 5 bytes (é is two).
    expect(wireArguments('"é"')).toBe('{"_invalid_arguments":true,"bytes":4}');
    const unterminated = '{"é":';
    expect(wireArguments(unterminated)).toBe(
      `{"_invalid_arguments":true,"bytes":${new TextEncoder().encode(unterminated).length}}`,
    );
  });
});

describe("invalidArgumentsNote", () => {
  test("names the size and the marker, and forbids sending it", () => {
    expect(invalidArgumentsNote(1902)).toBe(
      '[history: this call\'s original arguments (1902 bytes) were not a valid JSON object, so this copy of the conversation shows {"_invalid_arguments":true,"bytes":1902} in their place. That marker is not a tool input: never send it as arguments.]',
    );
  });
});

describe("repairHistory: a valid history", () => {
  test("is returned as the SAME array reference, with no issues", () => {
    const history: ChatMessage[] = [
      user("hi"),
      assistant([call("c1", '{"path":"a"}')]),
      result("c1"),
      assistant([], "done"),
    ];
    const repair = repairHistory(history);
    expect(repair.messages).toBe(history);
    expect(repair.issues).toEqual([]);
    expect(validateHistory(history)).toEqual([]);
  });

  test("consecutive user messages are left alone, with no issue (rule 5)", () => {
    const history: ChatMessage[] = [user("a"), user("b"), assistant([], "ok")];
    const repair = repairHistory(history);
    expect(repair.messages).toBe(history);
    expect(repair.issues).toEqual([]);
  });
});

describe("repairHistory: invalid arguments (rule 1)", () => {
  test("the incident's shape: the copy carries the marker, the paired result the note", () => {
    const history: ChatMessage[] = [
      user("write a file"),
      assistant([call("c1", BAD)]),
      result("c1", "invalid JSON arguments for fs_write"),
    ];
    const before = structuredClone(history);
    const repair = repairHistory(history);
    const bytes = new TextEncoder().encode(BAD).length;
    expect(shape(repair.messages)).toEqual([
      { role: "user", content: "write a file" },
      { role: "assistant", content: "", calls: [["c1", invalidArgumentsMarker(bytes)]] },
      {
        role: "tool",
        content: `invalid JSON arguments for fs_write\n\n${invalidArgumentsNote(bytes)}`,
        toolCallId: "c1",
      },
    ]);
    expect(repair.issues).toEqual([{ kind: "invalid_arguments", index: 1, callId: "c1", bytes }]);
    // The stored history is untouched (deep equality against a pre-call clone).
    expect(history).toEqual(before);
    // Idempotent, and valid afterwards.
    const again = repairHistory(repair.messages);
    expect(again.issues).toEqual([]);
    expect(again.messages).toBe(repair.messages);
    expect(validateHistory(repair.messages)).toEqual([]);
  });

  test("empty arguments become {} with NO note (the registry already reads it as {})", () => {
    const history: ChatMessage[] = [assistant([call("c1", "")]), result("c1")];
    const repair = repairHistory(history);
    expect(shape(repair.messages)[0]).toEqual({
      role: "assistant",
      content: "",
      calls: [["c1", "{}"]],
    });
    expect(repair.messages[1]).toEqual({ role: "tool", content: "ok", toolCallId: "c1" });
    expect(repair.issues).toEqual([{ kind: "empty_arguments", index: 0, callId: "c1" }]);
    expect(repairCounts(repair.issues)).toBeNull();
    expect(repairHistory(repair.messages).issues).toEqual([]);
  });

  test("non-object JSON gets the marker and the note too", () => {
    const history: ChatMessage[] = [assistant([call("c1", "[]")]), result("c1")];
    const repair = repairHistory(history);
    expect(shape(repair.messages)[0]).toEqual({
      role: "assistant",
      content: "",
      calls: [["c1", '{"_invalid_arguments":true,"bytes":2}']],
    });
    expect(repair.issues).toEqual([
      { kind: "invalid_arguments", index: 0, callId: "c1", bytes: 2 },
    ]);
  });
});

describe("repairHistory: unanswered calls (rule 3)", () => {
  test("a trailing dangling call is answered at the end of its block (eval A/B/G)", () => {
    const history: ChatMessage[] = [user("go"), assistant([call("c1", "{}")])];
    const repair = repairHistory(history);
    expect(shape(repair.messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "", calls: [["c1", "{}"]] },
      { role: "tool", content: UNANSWERED_CALL_NOTE, toolCallId: "c1" },
    ]);
    expect(repair.issues).toEqual([{ kind: "unanswered_call", index: 1, callId: "c1" }]);
    expect(repairHistory(repair.messages).issues).toEqual([]);
  });

  test("a mid-history dangling call is answered in place, before the next user turn (F4)", () => {
    const history: ChatMessage[] = [
      user("go"),
      assistant([call("c1", "{}")]),
      user("hey"),
      assistant([], "hi"),
    ];
    const repair = repairHistory(history);
    expect(shape(repair.messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "", calls: [["c1", "{}"]] },
      { role: "tool", content: UNANSWERED_CALL_NOTE, toolCallId: "c1" },
      { role: "user", content: "hey" },
      { role: "assistant", content: "hi" },
    ]);
    expect(repair.issues).toEqual([{ kind: "unanswered_call", index: 1, callId: "c1" }]);
  });

  test("two calls, one answered: the other gets the note, in call order (C)", () => {
    const history: ChatMessage[] = [user("go"), assistant([call("c1", "{}"), call("c2", "{}")])];
    const repair = repairHistory(history);
    expect(shape(repair.messages).slice(2)).toEqual([
      { role: "tool", content: UNANSWERED_CALL_NOTE, toolCallId: "c1" },
      { role: "tool", content: UNANSWERED_CALL_NOTE, toolCallId: "c2" },
    ]);
    expect(repair.issues).toEqual([
      { kind: "unanswered_call", index: 1, callId: "c1" },
      { kind: "unanswered_call", index: 1, callId: "c2" },
    ]);
  });
});

describe("repairHistory: invalid arguments plus unanswered (F5)", () => {
  test("one synthesized message carries both notes", () => {
    const history: ChatMessage[] = [assistant([call("c1", BAD)])];
    const repair = repairHistory(history);
    const bytes = new TextEncoder().encode(BAD).length;
    expect(shape(repair.messages)[1]).toEqual({
      role: "tool",
      content: `${UNANSWERED_CALL_NOTE}\n\n${invalidArgumentsNote(bytes)}`,
      toolCallId: "c1",
    });
    expect(repair.issues).toEqual([
      { kind: "invalid_arguments", index: 0, callId: "c1", bytes },
      { kind: "unanswered_call", index: 0, callId: "c1" },
    ]);
    expect(repairHistory(repair.messages).issues).toEqual([]);
  });
});

describe("repairHistory: orphan tool messages (rule 4)", () => {
  test("one outside any block is dropped from the copy", () => {
    const history: ChatMessage[] = [result("c1"), user("hi"), assistant([], "ok")];
    const repair = repairHistory(history);
    expect(shape(repair.messages)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);
    expect(repair.issues).toEqual([{ kind: "orphan_tool_result", index: 0, toolCallId: "c1" }]);
    expect(repairHistory(repair.messages).issues).toEqual([]);
  });

  test("an unknown id in a block is dropped", () => {
    const history: ChatMessage[] = [assistant([call("c1", "{}")]), result("c9"), result("c1")];
    const repair = repairHistory(history);
    expect(shape(repair.messages).map((m) => (m as { toolCallId?: string }).toolCallId)).toEqual([
      undefined,
      "c1",
    ]);
    expect(repair.issues).toEqual([{ kind: "orphan_tool_result", index: 1, toolCallId: "c9" }]);
  });

  test("a duplicate answer to the same id is dropped", () => {
    const history: ChatMessage[] = [
      assistant([call("c1", "{}")]),
      result("c1", "first"),
      result("c1", "second"),
    ];
    const repair = repairHistory(history);
    expect(repair.messages.map((m) => m.content)).toEqual(["", "first"]);
    expect(repair.issues).toEqual([{ kind: "orphan_tool_result", index: 2, toolCallId: "c1" }]);
  });

  test("a tool message with no toolCallId is dropped", () => {
    const history: ChatMessage[] = [
      assistant([call("c1", "{}")]),
      { role: "tool", content: "who?" },
      result("c1"),
    ];
    const repair = repairHistory(history);
    expect(repair.messages.map((m) => m.content)).toEqual(["", "ok"]);
    expect(repair.issues).toEqual([
      { kind: "orphan_tool_result", index: 1, toolCallId: undefined },
    ]);
  });
});

describe("repairHistory: non-destructive and minimal", () => {
  test("the input messages are never mutated", () => {
    const history: ChatMessage[] = [
      assistant([call("c1", BAD)]),
      result("c1"),
      assistant([call("c2", "still-poisoned")]),
    ];
    const before = structuredClone(history);
    repairHistory(history);
    expect(history).toEqual(before);
  });

  test("a stored marker is not an issue (F12)", () => {
    const marker = invalidArgumentsMarker(12);
    const history: ChatMessage[] = [assistant([call("c1", marker)]), result("c1")];
    expect(repairHistory(history).issues).toEqual([]);
    expect(repairHistory(history).messages).toBe(history);
  });

  test("an empty history is returned as is", () => {
    const history: ChatMessage[] = [];
    expect(repairHistory(history)).toEqual({ messages: history, issues: [] });
  });
});

describe("repairCounts", () => {
  test("null for no issues, and for empty_arguments alone (F22)", () => {
    expect(repairCounts([])).toBeNull();
    expect(repairCounts([{ kind: "empty_arguments", index: 0, callId: "c1" }])).toBeNull();
  });

  test("the exact counts of the counted kinds", () => {
    expect(
      repairCounts([
        { kind: "invalid_arguments", index: 0, callId: "c1", bytes: 3 },
        { kind: "unanswered_call", index: 0, callId: "c2" },
        { kind: "orphan_tool_result", index: 3, toolCallId: "c9" },
        { kind: "empty_arguments", index: 0, callId: "c3" },
      ]),
    ).toEqual({ invalidArguments: 1, unansweredCalls: 1, orphanResults: 1 });
  });
});

describe("describeRepairs", () => {
  test("one part", () => {
    expect(describeRepairs({ invalidArguments: 1, unansweredCalls: 0, orphanResults: 0 })).toBe(
      "history repaired for the model: 1 tool call with invalid arguments — the saved session is unchanged",
    );
  });

  test("every part, plural, in a fixed order", () => {
    expect(describeRepairs({ invalidArguments: 2, unansweredCalls: 1, orphanResults: 1 })).toBe(
      "history repaired for the model: 2 tool calls with invalid arguments, 1 unanswered tool call, 1 stray tool result — the saved session is unchanged",
    );
  });

  test("stray results alone", () => {
    expect(describeRepairs({ invalidArguments: 0, unansweredCalls: 0, orphanResults: 3 })).toBe(
      "history repaired for the model: 3 stray tool results — the saved session is unchanged",
    );
  });
});

describe("answerOutstandingCalls", () => {
  test("every call answered: nothing", () => {
    const owner = assistant([call("c1", "{}")]);
    const messages: ChatMessage[] = [owner, result("c1")];
    expect(answerOutstandingCalls(messages, owner, [call("c1", "{}")], () => "x")).toEqual([]);
  });

  test("one of two answered: one message for the other, in call order", () => {
    const owner = assistant([call("c1", "{}"), call("c2", "{}")]);
    const messages: ChatMessage[] = [owner, result("c2")];
    expect(
      answerOutstandingCalls(messages, owner, [call("c1", "{}"), call("c2", "{}")], (c) => c.id),
    ).toEqual([{ role: "tool", content: "c1", toolCallId: "c1" }]);
  });

  test("owner no longer in the history: nothing", () => {
    const owner = assistant([call("c1", "{}")]);
    const messages: ChatMessage[] = [user("fresh")];
    expect(answerOutstandingCalls(messages, owner, [call("c1", "{}")], () => "x")).toEqual([]);
  });

  test("a non-tool message after the block: nothing (never splice)", () => {
    const owner = assistant([call("c1", "{}")]);
    const messages: ChatMessage[] = [owner, user("after")];
    expect(answerOutstandingCalls(messages, owner, [call("c1", "{}")], () => "x")).toEqual([]);
  });

  test("the input array is never mutated", () => {
    const owner = assistant([call("c1", "{}")]);
    const messages: ChatMessage[] = [owner];
    const before = structuredClone(messages);
    answerOutstandingCalls(messages, owner, [call("c1", "{}")], () => "x");
    expect(messages).toEqual(before);
  });
});
