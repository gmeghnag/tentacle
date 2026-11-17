/**
 * S3.4 of docs/feat/harness-notices.md: a resumed (or replayed) compaction is a
 * grey separator rule at the compaction point, its brief shown only with Ctrl+O
 * — not the `›` user row carrying the whole summary that the person never typed
 * (owner Q3). RED on `main`: such a message projected to `{kind:"user"}`.
 */
import { describe, expect, test } from "bun:test";
import { COMPACTION_SUMMARY_HEAD, type ChatMessage } from "@tentacle/core";
import stringWidth from "string-width";
import { itemLines, stripAnsi, transcriptLines, wrapLines } from "../src/render-lines.ts";
import { messagesToItems } from "../src/resume.ts";

const sys: ChatMessage = { role: "system", content: "SYS" };
const brief = "- goal: fix the test\n- plan: slice 3";
const summary = (extra: Record<string, unknown> = {}): ChatMessage =>
  ({ role: "user", content: `${COMPACTION_SUMMARY_HEAD}\n\n${brief}`, ...extra }) as ChatMessage;

describe("messagesToItems: a compaction summary is the separator", () => {
  test("the summary is the rule, the brief its body — never a user row", () => {
    // Mutation: keep the user row → red (and a resumed compaction shows the whole
    // brief as something the person typed, the owner's Q3 complaint).
    expect(
      messagesToItems([
        sys,
        summary({ compacted: { fromTokens: 182_000, toTokens: 9_000, toExact: true } }),
        { role: "assistant", content: "after it" },
      ]),
    ).toEqual([
      { kind: "notice", text: "compacted · ctx 182k → 9k", separator: true, body: brief },
      { kind: "assistant", text: "after it" },
    ]);
  });

  test("a legacy summary (written before the field) → the bare word, same body", () => {
    // Migration: the plan's older-daemon case. Never a figure it cannot know.
    expect(messagesToItems([summary()])).toEqual([
      { kind: "notice", text: "compacted", separator: true, body: brief },
    ]);
  });

  test("a summary with no brief beyond the head adds no empty body", () => {
    // Ink measures an empty <Text> 0×0 (AGENTS §6): a `body: ""` would be a row
    // that vanishes and an expand hint for nothing.
    const bare = { role: "user", content: COMPACTION_SUMMARY_HEAD } as ChatMessage;
    expect(messagesToItems([bare])).toEqual([
      { kind: "notice", text: "compacted", separator: true },
    ]);
  });

  test("a `/clear`'s history (no summary message) gets no separator", () => {
    // A `/clear` is logged as a `compact` reason (`hosted-session.ts`), but its
    // history has no summary: `compactionOf` is null, so nothing here matches.
    expect(
      messagesToItems([sys, { role: "user", content: "a fresh start" } as ChatMessage]),
    ).toEqual([{ kind: "user", text: "a fresh start" }]);
  });

  test("the body is hidden until Ctrl+O — one rule, then the hinted brief", () => {
    // The rendering half (S3.4's `separatorLines` body): collapsed is ONE row
    // carrying the expand hint; expanded is the rule plus the brief's lines.
    const item = {
      kind: "notice" as const,
      text: "compacted · ctx 182k → 9k",
      separator: true as const,
      body: brief,
    };
    const collapsed = itemLines(item, { expandAll: false, width: 60 }).map(stripAnsi);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.startsWith("── compacted · ctx 182k → 9k ─")).toBe(true);
    expect(collapsed[0]?.endsWith("ctrl+o to expand")).toBe(true);
    const expanded = itemLines(item, { expandAll: true, width: 60 }).map(stripAnsi);
    const rule = collapsed[0] ?? "";
    expect(expanded).toEqual([
      rule.slice(0, -" ctrl+o to expand".length),
      "  - goal: fix the test",
      "  - plan: slice 3",
    ]);
  });

  test("the collapsed rule plus its hint fits the width — one row, never two", () => {
    // Review S3 round 1, F1: `rest` used to fill the rule to the full `width` and
    // the hint was then appended, so `wrapAnsi` pushed it onto a SECOND row on
    // every `--resume`/resync of a compacted session. A logical-line count proves
    // nothing here (both renders are ONE logical line): the assert is on the
    // wrapped rows' measured width.
    const items = messagesToItems([
      sys,
      summary({ compacted: { fromTokens: 182_000, toTokens: 9_000, toExact: true } }),
      { role: "assistant", content: "after it" },
    ]);
    for (const width of [40, 60, 100]) {
      const rows = wrapLines(transcriptLines(items, { width, expandAll: false }), width).map(
        stripAnsi,
      );
      // The hint never owns a row of its own: the only row that may carry it is
      // the rule's, together with the figures. (At 40 it is dropped outright —
      // head + hint cannot fit — rather than wrapped or truncated.)
      const hintRows = rows.filter((r) => r.includes("ctrl+o to expand"));
      expect(hintRows.length).toBeLessThanOrEqual(1);
      for (const row of hintRows) {
        expect(row.startsWith("── compacted · ctx 182k → 9k ─")).toBe(true);
      }
      if (width >= 60) {
        expect(hintRows).toHaveLength(1);
      }
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
      // Two non-empty rows only: the rule and the answer. A fragment of the hint
      // ("to expand" alone) is the same two-row bug in another dress.
      expect(rows.filter((r) => r !== "")).toHaveLength(2);
      // And the visible rule is a rule, not a stub: the figures survive the cut.
      expect(rows[0]?.startsWith("── compacted · ctx 182k → 9k ──")).toBe(true);
    }
  });
});
