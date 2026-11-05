/** The laptop's exact cut labels (T-L1, docs/feat/parallel-tools.md decision 6). */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { ENDED_INTERRUPTED_NOTE, ENDED_NOT_RUN_NOTE, ENDED_TURN_NOTE } from "@tentacle/daemon";
import { cutHistory } from "../src/local-runtime.ts";

const round: ChatMessage[] = [
  { role: "user", content: "go" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "c1", name: "fs_read", arguments: "{}" },
      { id: "c2", name: "fs_read", arguments: "{}" },
      { id: "c3", name: "fs_read", arguments: "{}" },
    ],
  },
];
const tools = (messages: readonly ChatMessage[]) =>
  messages.flatMap((m) => (m.role === "tool" ? [[m.toolCallId, m.content]] : []));

describe("cutHistory (T-L1)", () => {
  test("running = {c1}: c1 Interrupted, c2 and c3 Not run (queued or unapproved)", () => {
    const cut = cutHistory(round, new Set(["c1"]));
    expect(tools(cut)).toEqual([
      ["c1", ENDED_INTERRUPTED_NOTE],
      ["c2", ENDED_NOT_RUN_NOTE],
      ["c3", ENDED_NOT_RUN_NOTE],
    ]);
    expect(cut.at(-1)).toEqual({ role: "assistant", content: ENDED_TURN_NOTE });
  });

  test("a group with c1 and c3 started: both Interrupted, c2 Not run", () => {
    expect(tools(cutHistory(round, new Set(["c1", "c3"])))).toEqual([
      ["c1", ENDED_INTERRUPTED_NOTE],
      ["c2", ENDED_NOT_RUN_NOTE],
      ["c3", ENDED_INTERRUPTED_NOTE],
    ]);
  });

  test("a call cut in its ask (never started): Not run", () => {
    expect(tools(cutHistory(round, new Set()))).toEqual([
      ["c1", ENDED_NOT_RUN_NOTE],
      ["c2", ENDED_NOT_RUN_NOTE],
      ["c3", ENDED_NOT_RUN_NOTE],
    ]);
  });

  test("null (a session without the signal's record): today's first-unanswered rule", () => {
    expect(tools(cutHistory(round, null))).toEqual([
      ["c1", ENDED_INTERRUPTED_NOTE],
      ["c2", ENDED_NOT_RUN_NOTE],
      ["c3", ENDED_NOT_RUN_NOTE],
    ]);
  });
});
