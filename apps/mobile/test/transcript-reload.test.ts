/**
 * Live = reload (docs/fix/mobile-qa-1117.md, bugs 2 and 4): what a session shows
 * while it runs is what it shows when it is reopened from the daemon's history.
 *
 * - a failed step stays failed (the stored `isError`, bug 2);
 * - a compaction is ONE step whatever device made it and whenever it is seen —
 *   live from another device or after a reopen — never the summary as a user
 *   bubble, never literal markdown (bug 4, docs/feat/mobile-reset-in-timeline
 *   plan 1A: the step replaced the separator notice);
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

describe("a compaction is ONE step, live and after reopen (1A)", () => {
  test("reopen: the summary is a step with the figures, not a user bubble", () => {
    const rows = historyRows([summary, { role: "assistant", content: "Go on." }], keys());
    expect(rows.map((r) => r.kind)).toEqual(["context", "assistant"]);
    expect(rows[0]).toMatchObject({
      kind: "context",
      event: "compact",
      figures: "ctx 25k → 2k",
      body: "The person asked for a login flow; it was drawn.",
    });
    expect(rows.some((r) => r.kind === "user")).toBe(false);
  });

  test("the body is the summary WITHOUT the head, and the running/skills notes stay", () => {
    // `packages/agent/src/compact.ts:342` writes `HEAD\n\n<summary>[\n\n<running>][\n\n<skills>]`:
    // the notes are part of what the model continues from, so only the head goes.
    const rows = historyRows(
      [
        {
          role: "user",
          content: `${COMPACTION_SUMMARY_HEAD}\n\nthe summary\n\nStill running: a job\n\nSkills kept: kcs`,
          compacted: { fromTokens: 25_000, toTokens: 2_000 },
        },
      ],
      keys(),
    );
    expect(rows[0]).toMatchObject({
      kind: "context",
      event: "compact",
      body: "the summary\n\nStill running: a job\n\nSkills kept: kcs",
      // An estimated after (no `toExact`) keeps the separator's own `~`.
      figures: "ctx 25k → ~2k",
    });
  });

  test("a legacy summary (no `compacted` field) is a step without figures", () => {
    const rows = historyRows([{ role: "user", content: summary.content }], keys());
    expect(rows[0]).toMatchObject({ kind: "context", event: "compact" });
    expect(rows[0] !== undefined && "figures" in rows[0]).toBe(false);
  });

  test("live, another device: the SAME step the reopen draws, no markdown", () => {
    const before = fold([
      { type: "history", messages: [{ role: "user", content: "hi" }], reason: null },
    ]);
    const after = apply(before, { type: "history", messages: [summary], reason: "compact" });
    const last = after.rows[after.rows.length - 1];
    expect(last).toMatchObject({
      kind: "context",
      event: "compact",
      figures: "ctx 25k → 2k",
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
