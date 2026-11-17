/**
 * S3.4 of docs/feat/harness-notices.md: a resumed (or replayed) compaction is a
 * grey separator rule at the compaction point, its brief shown only with Ctrl+O
 * — not the `›` user row carrying the whole summary that the person never typed
 * (owner Q3). RED on `main`: such a message projected to `{kind:"user"}`.
 */
import { describe, expect, test } from "bun:test";
import { COMPACTION_SUMMARY_HEAD, type ChatMessage } from "@tentacle/core";
import { itemLines, stripAnsi } from "../src/render-lines.ts";
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
});
