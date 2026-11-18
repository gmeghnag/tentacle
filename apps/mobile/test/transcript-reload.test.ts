/**
 * Live = reload (docs/fix/mobile-qa-1117.md, bugs 2 and 4): what a session shows
 * while it runs is what it shows when it is reopened from the daemon's history.
 *
 * - a failed step stays failed (the stored `isError`, bug 2);
 * - a compaction is ONE separator whatever device made it and whenever it is
 *   seen — live from another device or after a reopen — never the summary as a
 *   user bubble, never literal markdown (bug 4);
 * - no notice the phone writes carries `_…_` markdown: a notice row is plain
 *   text (`NoticeRowView`), so the underscores were shown as typed.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { COMPACTION_SUMMARY_HEAD } from "@tentacle/core";
import { historyRows } from "../src/transcript-history.ts";
import {
  type Row,
  type State,
  TURN_INTERRUPTED_NOTICE,
  TURN_LOST_NOTICE,
  apply,
  closedNotice,
  initialState,
} from "../src/transcript.ts";

function fold(inputs: readonly Parameters<typeof apply>[1][]): State {
  return inputs.reduce<State>((state, input) => apply(state, input), initialState);
}

function keys(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `k${n}`;
  };
}

const summary: ChatMessage = {
  role: "user",
  content: `${COMPACTION_SUMMARY_HEAD}\nThe person asked for a login flow; it was drawn.`,
  compacted: { fromTokens: 25_000, toTokens: 2_000, toExact: true },
};

describe("a failed step stays failed on reload (bug 2)", () => {
  const history: readonly ChatMessage[] = [
    { role: "user", content: "list it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "bad", name: "bash", arguments: '{"command":"ls missing-dir"}' },
        { id: "good", name: "bash", arguments: '{"command":"ls"}' },
      ],
    },
    { role: "tool", toolCallId: "bad", content: "ls: missing-dir: No such file", isError: true },
    { role: "tool", toolCallId: "good", content: "a.txt" },
  ];

  test("the stored isError projects to status error; a success stays ok", () => {
    const rows = historyRows(history, keys());
    const status = rows.flatMap((r) => (r.kind === "tool" ? [[r.id, r.status]] : []));
    expect(status).toEqual([
      ["bad", "error"],
      ["good", "ok"],
    ]);
  });

  test("a refusal with a reply is still `denied` (it wins over the error flag)", () => {
    const rows = historyRows(
      [
        history[1] as ChatMessage,
        { role: "tool", toolCallId: "bad", content: "refused", isError: true, denialReply: "no" },
      ],
      keys(),
    );
    expect(rows.find((r) => r.kind === "tool" && r.id === "bad")).toMatchObject({
      status: "denied",
    });
  });

  test("live and reload agree on the same failed call", () => {
    const live = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "bad", name: "bash", arguments: "{}" },
      {
        type: "tool_result",
        id: "bad",
        name: "bash",
        result: { content: "ls: missing-dir: No such file", isError: true },
      },
      { type: "turn_ended", outcome: "ended" },
    ]);
    const reload = fold([{ type: "history", messages: history, reason: null }]);
    const statusOf = (rows: readonly Row[]) =>
      rows.find((r) => r.kind === "tool" && r.id === "bad")?.kind === "tool"
        ? (rows.find((r) => r.kind === "tool" && r.id === "bad") as Row & { kind: "tool" }).status
        : undefined;
    expect(statusOf(live.rows)).toBe("error");
    expect(statusOf(reload.rows)).toBe("error");
  });
});

describe("a compaction is one separator, live and after reopen (bug 4)", () => {
  test("reopen: the summary is a separator with the figures, not a user bubble", () => {
    const rows = historyRows([summary, { role: "assistant", content: "Go on." }], keys());
    expect(rows.map((r) => r.kind)).toEqual(["notice", "assistant"]);
    expect(rows[0]).toMatchObject({
      kind: "notice",
      text: "compacted · ctx 25k → 2k",
      separator: true,
    });
    expect(rows.some((r) => r.kind === "user")).toBe(false);
  });

  test("a legacy summary (no `compacted` field) is a separator without figures", () => {
    const rows = historyRows([{ role: "user", content: summary.content }], keys());
    expect(rows[0]).toMatchObject({ kind: "notice", text: "compacted", separator: true });
  });

  test("live, another device: the SAME separator the reopen draws, no markdown", () => {
    const before = fold([
      { type: "history", messages: [{ role: "user", content: "hi" }], reason: null },
    ]);
    const after = apply(before, { type: "history", messages: [summary], reason: "compact" });
    const last = after.rows[after.rows.length - 1];
    expect(last).toMatchObject({
      kind: "notice",
      text: "compacted · ctx 25k → 2k",
      separator: true,
    });
    expect(after.rows[0]).toMatchObject({ kind: "user", text: "hi" }); // the transcript stays
  });
});

describe("no notice the phone writes is markdown (bug 4)", () => {
  const notices = [
    TURN_INTERRUPTED_NOTICE,
    TURN_LOST_NOTICE,
    closedNotice("gone"),
    closedNotice("closed"),
    closedNotice("deleted"),
  ];
  for (const notice of notices) {
    test(`plain text: ${notice}`, () => {
      expect(notice).not.toMatch(/^_|_$/);
    });
  }
});
