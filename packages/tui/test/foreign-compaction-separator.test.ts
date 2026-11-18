/**
 * S3.3 of docs/feat/harness-notices.md: another device's compaction is the SAME
 * grey separator as this TUI's own (`compacted · ctx 182k → 9k`), with no
 * "on another device" wording (owner Q6 override), and no notice.
 *
 * RED on `main`: `historyAction` answered `"notice"` and the TUI pushed
 * `_the conversation was compacted on another device_`.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { COMPACTION_SUMMARY_HEAD } from "@tentacle/core";
import { compactionSeparatorOf, historyAction } from "../src/turn-feed.ts";

const summary = (extra: Record<string, unknown> = {}): ChatMessage =>
  ({
    role: "user",
    content: `${COMPACTION_SUMMARY_HEAD}\n\n- goal: fix it`,
    ...extra,
  }) as ChatMessage;

describe("historyAction: a foreign compaction appends a separator, never a notice", () => {
  test("foreign → separator; mine → none (my settle already wrote one)", () => {
    // Mutation: keep returning "notice" → both fail, and the transcript shows the
    // removed device-blaming line instead of the rule.
    expect(historyAction({ reason: "compact", ownCompaction: false })).toBe("separator");
    expect(historyAction({ reason: "compact", ownCompaction: true })).toBe("none");
  });

  test("the other reasons are untouched", () => {
    expect(historyAction({ reason: null, ownCompaction: false })).toBe("replace");
    expect(historyAction({ reason: "clear", ownCompaction: true })).toBe("replace");
    expect(historyAction({ reason: "context_reset", ownCompaction: false })).toBe("append");
  });
});

describe("compactionSeparatorOf: the separator's text, from the new history", () => {
  test("a structural compaction fact gives the figures — the SAME wording as my own", () => {
    // Mutation: a foreign variant (`compacted on another device · …`) → red
    // (owner Q6: it must read exactly as when this person compacted here).
    expect(
      compactionSeparatorOf([
        { role: "system", content: "sys" },
        summary({ compacted: { fromTokens: 182_000, toTokens: 9_000, toExact: true } }),
      ]),
    ).toBe("compacted · ctx 182k → 9k");
  });

  test("an estimated after keeps its `~`", () => {
    expect(
      compactionSeparatorOf([summary({ compacted: { fromTokens: 182_000, toTokens: 9_000 } })]),
    ).toBe("compacted · ctx 182k → ~9k");
  });

  test("a legacy summary (no fact) → `compacted` alone; no summary at all → the same", () => {
    // Never a fake number: an older daemon's history, and a history whose summary
    // this build cannot recognise, both degrade to the bare word.
    expect(compactionSeparatorOf([summary()])).toBe("compacted");
    expect(compactionSeparatorOf([{ role: "user", content: "hi" } as ChatMessage])).toBe(
      "compacted",
    );
  });
});
