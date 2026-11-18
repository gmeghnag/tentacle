/**
 * docs/feat/harness-notices.md S1: the pure compaction view shared by the TUI
 * and mobile — which message is a compaction summary, and its separator text.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACTION_SUMMARY_HEAD,
  type ChatMessage,
  compactionOf,
  compactionSeparatorText,
  formatTokens,
} from "../src/index.ts";

const legacy: ChatMessage = { role: "user", content: `${COMPACTION_SUMMARY_HEAD}\n\nbrief` };

describe("compactionOf", () => {
  test("structural: the field wins", () => {
    const m: ChatMessage = {
      ...legacy,
      compacted: { fromTokens: 182000, toTokens: 9000, toExact: true },
    };
    expect(compactionOf(m)).toEqual({ fromTokens: 182000, toTokens: 9000, toExact: true });
  });

  test("a legacy summary (head, no field) → a fact without figures", () => {
    expect(compactionOf(legacy)).toEqual({});
  });

  test("a plain user message, or the head on another role → null", () => {
    expect(compactionOf({ role: "user", content: "hello" })).toBeNull();
    expect(compactionOf({ role: "assistant", content: legacy.content })).toBeNull();
    expect(compactionOf({ role: "user", content: `quote: ${COMPACTION_SUMMARY_HEAD}` })).toBeNull();
  });
});

describe("compactionSeparatorText", () => {
  test("exact, estimated, no figures", () => {
    expect(compactionSeparatorText({ fromTokens: 182000, toTokens: 9000, toExact: true })).toBe(
      "compacted · ctx 182k → 9k",
    );
    expect(compactionSeparatorText({ fromTokens: 182000, toTokens: 9000 })).toBe(
      "compacted · ctx 182k → ~9k",
    );
    expect(compactionSeparatorText({})).toBe("compacted");
  });

  test("no foreign variant (Q6 owner override): one wording whatever the device", () => {
    // @ts-expect-error — the function takes the view only.
    const text = compactionSeparatorText({ fromTokens: 182000, toTokens: 9000 }, { foreign: true });
    expect(text).toBe("compacted · ctx 182k → ~9k");
  });
});

test("formatTokens lives in core", () => {
  expect(formatTokens(182000)).toBe("182k");
  expect(formatTokens(999)).toBe("999");
});
