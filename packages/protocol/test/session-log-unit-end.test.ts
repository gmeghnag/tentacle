import { describe, expect, test } from "bun:test";
import {
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  LogUnitEndEntrySchema,
  UNIT_END_ID_MAX_CHARS,
  UNIT_END_REASON_MAX_CHARS,
  UNIT_END_RESULT_MAX_CHARS,
  UNIT_END_WORD_MAX_CHARS,
  type WireChatMessage,
  projectEntry,
} from "../src/index.ts";

// docs/feat/a2a.md, Unification §2 — `unit_end`: a carried ENDED unit of work.

const envelope = { seq: 3, id: "inc/3", prev: "inc/2", ts: 1_000, critical: false } as const;
const atCaps = {
  ...envelope,
  type: "unit_end",
  kind: "k".repeat(UNIT_END_WORD_MAX_CHARS),
  unitId: "u".repeat(UNIT_END_ID_MAX_CHARS),
  origin: "t".repeat(128),
  state: "s".repeat(UNIT_END_WORD_MAX_CHARS),
  native: `stopped:${"x".repeat(UNIT_END_WORD_MAX_CHARS - 8)}`,
  reason: "r".repeat(UNIT_END_REASON_MAX_CHARS),
  startedAt: 10,
  endedAt: 20,
  result: "R".repeat(UNIT_END_RESULT_MAX_CHARS),
  resultDropped: true,
};

describe("unit_end entry", () => {
  test("is NON-critical (an older build skips it)", () => {
    expect(LOG_ENTRY_CRITICAL.unit_end).toBe(false);
    expect(LogUnitEndEntrySchema.safeParse({ ...atCaps, critical: true }).success).toBe(false);
    const { critical: _absent, ...noFlag } = atCaps;
    expect(LogUnitEndEntrySchema.safeParse(noFlag).success).toBe(true);
  });

  test("a known entry of the log union, parsed at every cap", () => {
    const parsed = KnownLogEntrySchema.safeParse(atCaps);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(atCaps as never);
  });

  test("the documented bounds (docs/feat/a2a.md) are the schema's", () => {
    expect(UNIT_END_WORD_MAX_CHARS).toBe(128);
    expect(UNIT_END_ID_MAX_CHARS).toBe(128);
    expect(UNIT_END_REASON_MAX_CHARS).toBe(2 * 1024);
    expect(UNIT_END_RESULT_MAX_CHARS).toBe(16 * 1024);
  });

  test("each cap is a real bound: one char over is refused", () => {
    const over: Record<string, unknown>[] = [
      { kind: "k".repeat(UNIT_END_WORD_MAX_CHARS + 1) },
      { state: "s".repeat(UNIT_END_WORD_MAX_CHARS + 1) },
      { native: "n".repeat(UNIT_END_WORD_MAX_CHARS + 1) },
      { unitId: "u".repeat(UNIT_END_ID_MAX_CHARS + 1) },
      { origin: "t".repeat(129) },
      { reason: "r".repeat(UNIT_END_REASON_MAX_CHARS + 1) },
      { result: "R".repeat(UNIT_END_RESULT_MAX_CHARS + 1) },
    ];
    for (const field of over) {
      expect(LogUnitEndEntrySchema.safeParse({ ...atCaps, ...field }).success).toBe(false);
    }
  });

  test("an unknown word parses: words are free strings, never enums", () => {
    const newer = {
      ...envelope,
      type: "unit_end",
      kind: "subagent",
      unitId: "sa-3",
      state: "paused",
      native: "stopped:quota_exceeded",
      endedAt: 5,
    };
    expect(LogUnitEndEntrySchema.safeParse(newer).success).toBe(true);
  });

  test("required fields and shapes are enforced", () => {
    const minimal = {
      ...envelope,
      type: "unit_end",
      kind: "turn",
      unitId: "t1",
      state: "completed",
      native: "end_turn",
      endedAt: 0,
    };
    expect(LogUnitEndEntrySchema.safeParse(minimal).success).toBe(true);
    for (const bad of [
      { kind: "" },
      { unitId: "" },
      { native: "" },
      { endedAt: undefined },
      { endedAt: 1.5 },
      { startedAt: -1 },
      { resultDropped: false },
    ]) {
      expect(LogUnitEndEntrySchema.safeParse({ ...minimal, ...bad }).success).toBe(false);
    }
  });

  test("it projects nothing", () => {
    const messages: WireChatMessage[] = [{ role: "user", content: "hi" }];
    const parsed = KnownLogEntrySchema.parse(atCaps);
    projectEntry(messages, parsed, (m) => m);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
