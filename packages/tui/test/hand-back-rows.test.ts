import { describe, expect, test } from "bun:test";
import * as Q from "../src/queued.ts";

// My queued rows coming back from the daemon (docs/feat/queued-broadcast.md).
// Namespace access: on a tree without the hand-back every case fails on its
// assertion, not on a missing import.

const fns = Q as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
const notice = (n: number, cause: string, stoppedHere: boolean) =>
  fns.returnedNotice?.(n, cause, stoppedHere);

describe("returnedNotice", () => {
  test("cancelled from another device: the owner's wording", () => {
    expect(notice(2, "cancelled", false)).toBe(
      "_Turn stopped from another device: your 2 queued messages are back in the input_",
    );
    expect(notice(1, "cancelled", false)).toBe(
      "_Turn stopped from another device: your queued message is back in the input_",
    );
  });
  test("cancelled here: no 'another device'", () => {
    expect(notice(2, "cancelled", true)).toBe("_Your 2 queued messages are back in the input_");
  });
  test("failed / ended", () => {
    expect(notice(3, "failed", false)).toBe(
      "_The turn ended early: your 3 queued messages are back in the input_",
    );
    expect(notice(1, "ended", true)).toBe(
      "_The session ended: your queued message is back in the input_",
    );
  });
});

describe("handBackRows / dropIds", () => {
  test("the rows given back leave the list; their texts join like a send-now", () => {
    const rows = Q.addRow(Q.addRow(Q.addRow([], "A", "a"), "B", "b"), "C", "c");
    expect(fns.dropIds?.(rows, ["b"])).toEqual([
      { id: "a", text: "A", state: "queued" },
      { id: "c", text: "C", state: "queued" },
    ]);
    expect(
      fns.handBackRows?.(
        rows,
        [
          { id: "a", text: "fix x", cause: "cancelled" },
          { id: "zz", text: "and y", cause: "cancelled" },
        ],
        false,
      ),
    ).toEqual({
      rows: [
        { id: "b", text: "B", state: "queued" },
        { id: "c", text: "C", state: "queued" },
      ],
      text: "fix x\n\nand y",
      notice: "_Turn stopped from another device: your 2 queued messages are back in the input_",
    });
  });

  test("a row this TUI already restored itself is not given back twice (review F1)", () => {
    // Mutation: ignore `restored` → "fix x" lands in the input a second time.
    const rows = Q.addRow([], "C", "c");
    const back = [
      { id: "a", text: "fix x", cause: "cancelled" },
      { id: "b", text: "and y", cause: "cancelled" },
    ];
    expect(fns.handBackRows?.(rows, back, false, new Set(["a"]))).toEqual({
      rows: [{ id: "c", text: "C", state: "queued" }],
      text: "and y",
      notice: "_Turn stopped from another device: your queued message is back in the input_",
    });
    expect(fns.handBackRows?.(rows, back, false, new Set(["a", "b"]))).toEqual({
      rows: [{ id: "c", text: "C", state: "queued" }],
      text: "",
      notice: "",
    });
  });
});
