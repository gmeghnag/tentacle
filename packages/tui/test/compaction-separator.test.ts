/**
 * S3.2 of docs/feat/harness-notices.md: a SUCCESSFUL `/compact` writes no
 * transcript notice any more — it hands the App a separator's text instead
 * (`compacted · ctx 182k → 9k`) and the slot says `Compacted ✓`. A failure and a
 * cancel keep their harness lines, with their levels.
 */
import { describe, expect, test } from "bun:test";
import { addRow } from "../src/queued.ts";
import { onCompactionSettled } from "../src/send-now.ts";

const idle = { rows: [], sendNowOwns: false, turnRunning: false } as const;
const sized = { ok: true, before: 97, after: 2, fromTokens: 182_000, toTokens: 9_000 } as const;

describe("onCompactionSettled: success is a separator, not a notice", () => {
  test("success → `notice: null` plus the separator's text (exact after, no `~`)", () => {
    // Mutation: keep the old `_Context compacted — N → M messages._` notice → red
    // here, and the transcript shows the removed line again.
    expect(onCompactionSettled({ ...idle, result: { ...sized, toExact: true } })).toEqual({
      notice: null,
      separator: "compacted · ctx 182k → 9k",
      send: null,
      restore: null,
    });
  });

  test("an estimated after is `~9k`; an older daemon without figures is `compacted` alone", () => {
    // Mutation: drop the `~` (always exact) → the first fails. Mutation: a fake 0
    // for missing figures → the second fails (`ctx 0 → 0`).
    expect(onCompactionSettled({ ...idle, result: sized }).separator).toBe(
      "compacted · ctx 182k → ~9k",
    );
    expect(
      onCompactionSettled({ ...idle, result: { ok: true, before: 9, after: 2 } }).separator,
    ).toBe("compacted");
  });

  test("a failure keeps its `▲` line and writes no separator", () => {
    const out = onCompactionSettled({ ...idle, result: { ok: false, error: new Error("down") } });
    expect(out.notice).toBe("_Compact failed: Error: down_");
    expect(out.level).toBe("warn");
    expect(out.separator).toBeUndefined();
  });

  test("a send-now's cancel keeps its `◇` info line and writes no separator", () => {
    // Mutation: mark a cancel `warn` → the `▲` would claim a failure that the
    // person already knows about (they did it).
    const cancelled = Object.assign(new Error("cancelled"), { code: -32010 });
    const out = onCompactionSettled({
      ...idle,
      sendNowOwns: true,
      result: { ok: false, error: cancelled },
    });
    expect(out.notice).toBe("_Compaction cancelled — sending now._");
    expect(out.level).toBeUndefined();
    expect(out.separator).toBeUndefined();
  });

  test("the queued rows still go out on success — the separator changes nothing there", () => {
    const rows = addRow(addRow([], "A", "a"), "B", "b");
    expect(
      onCompactionSettled({ rows, sendNowOwns: false, turnRunning: false, result: sized }),
    ).toEqual({
      notice: null,
      separator: "compacted · ctx 182k → ~9k",
      send: "A\n\nB",
      restore: null,
    });
  });
});
