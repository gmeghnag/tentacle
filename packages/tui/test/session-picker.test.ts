import { describe, expect, test } from "bun:test";
import {
  type SessionChoice,
  movePicker,
  pickerAge,
  pickerKey,
  pickerView,
} from "../src/session-picker.ts";

// The `--resume` picker's logic (docs/feat/resume-picker.md). Each rule names
// the mutation that turns it red (AGENTS §9).

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();

const choice = (n: number): SessionChoice => ({
  id: `id-${n}`,
  title: `title ${n}`,
  updatedAt: NOW - n * M,
  messageCount: n,
});
const choices = (count: number): SessionChoice[] =>
  Array.from({ length: count }, (_, i) => choice(i));

describe("pickerAge", () => {
  test("relative units at their boundaries, then a date", () => {
    // Mutation: `<=` instead of `<` on any boundary → the unit flips one step early.
    expect(pickerAge(NOW - 59 * S, NOW)).toBe("just now");
    expect(pickerAge(NOW - 60 * S, NOW)).toBe("1m ago");
    expect(pickerAge(NOW - 59 * M, NOW)).toBe("59m ago");
    expect(pickerAge(NOW - 60 * M, NOW)).toBe("1h ago");
    expect(pickerAge(NOW - 23 * H, NOW)).toBe("23h ago");
    expect(pickerAge(NOW - 24 * H, NOW)).toBe("1d ago");
    expect(pickerAge(NOW - 6 * D, NOW)).toBe("6d ago");
    expect(pickerAge(new Date(2026, 2, 5, 12).getTime(), NOW)).toBe("2026-03-05");
  });

  test("a timestamp in the future (clock skew) reads as just now, never negative", () => {
    expect(pickerAge(NOW + 5 * M, NOW)).toBe("just now");
  });
});

describe("movePicker", () => {
  test("clamps at both ends (no wrap)", () => {
    // Mutation: wrap around → 0-1 becomes 4.
    expect(movePicker(0, -1, 5)).toBe(0);
    expect(movePicker(4, 1, 5)).toBe(4);
    expect(movePicker(2, 1, 5)).toBe(3);
    expect(movePicker(2, -1, 5)).toBe(1);
  });

  test("an empty list stays at 0", () => {
    expect(movePicker(0, 1, 0)).toBe(0);
  });
});

describe("pickerView", () => {
  test("all rows fit: no window, the selected row is marked, newest first as given", () => {
    const view = pickerView(choices(3), 1, NOW, 10);
    expect(view.rows.map((r) => [r.id, r.selected])).toEqual([
      ["id-0", false],
      ["id-1", true],
      ["id-2", false],
    ]);
    expect(view.above).toBe(0);
    expect(view.below).toBe(0);
    expect(view.rows[2]).toMatchObject({ title: "title 2", age: "2m ago", meta: "2 msgs" });
    expect(view.rows[1]?.meta).toBe("1 msg");
  });

  test("windowed: the selected row stays visible and the hidden counts add up", () => {
    // Mutation: ignore `selected` when windowing → the bottom case loses the ❯ row.
    for (const selected of [0, 5, 9]) {
      const view = pickerView(choices(10), selected, NOW, 4);
      expect(view.rows).toHaveLength(4);
      expect(view.rows.some((r) => r.selected && r.id === `id-${selected}`)).toBe(true);
      expect(view.above + view.rows.length + view.below).toBe(10);
    }
    expect(pickerView(choices(10), 0, NOW, 4)).toMatchObject({ above: 0, below: 6 });
    expect(pickerView(choices(10), 9, NOW, 4)).toMatchObject({ above: 6, below: 0 });
  });

  test("a height below 1 still shows the selected row", () => {
    const view = pickerView(choices(5), 3, NOW, 0);
    expect(view.rows.map((r) => r.id)).toEqual(["id-3"]);
  });
});

describe("pickerKey", () => {
  const none = { upArrow: false, downArrow: false, return: false, escape: false, ctrl: false };
  test("arrows, j/k, Enter, Esc, Ctrl+C", () => {
    expect(pickerKey("", { ...none, upArrow: true })).toBe("up");
    expect(pickerKey("", { ...none, downArrow: true })).toBe("down");
    expect(pickerKey("k", none)).toBe("up");
    expect(pickerKey("j", none)).toBe("down");
    expect(pickerKey("", { ...none, return: true })).toBe("choose");
    expect(pickerKey("", { ...none, escape: true })).toBe("cancel");
    // Mutation: drop the Ctrl+C case → with exitOnCtrlC off, Ctrl+C would do nothing.
    expect(pickerKey("c", { ...none, ctrl: true })).toBe("cancel");
    expect(pickerKey("c", none)).toBe("none");
  });
});
