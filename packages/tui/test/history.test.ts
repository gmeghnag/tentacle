import { describe, expect, test } from "bun:test";
import { type HistoryState, pushHistory, recall } from "../src/history.ts";

const H = (items: string[], index: number): HistoryState => ({ items, index });

describe("pushHistory", () => {
  test("appends a new prompt", () => {
    expect(pushHistory([], "one")).toEqual(["one"]);
    expect(pushHistory(["one"], "two")).toEqual(["one", "two"]);
  });

  test("skips empty and whitespace-only prompts", () => {
    expect(pushHistory([], "")).toEqual([]);
    expect(pushHistory(["one"], "   ")).toEqual(["one"]);
  });

  test("dedups consecutive duplicates (like bash)", () => {
    expect(pushHistory(["one"], "one")).toEqual(["one"]);
    expect(pushHistory(["one"], "two")).toEqual(["one", "two"]);
    // A repeated prompt after a different one is kept (only consecutive dedup).
    expect(pushHistory(["one", "two"], "one")).toEqual(["one", "two", "one"]);
  });
});

describe("recall", () => {
  test("up from the draft slot saves the draft and shows the most recent entry", () => {
    const h = H(["one", "two"], 2);
    const r = recall(h, -1, "my draft");
    expect(r).toEqual({ index: 1, value: "two", draft: "my draft" });
    // A second up continues from the result: older entry, draft still preserved.
    const r2 = recall({ items: h.items, index: r.index }, -1, r.draft);
    expect(r2).toEqual({ index: 0, value: "one", draft: "my draft" });
  });

  test("up at the oldest entry is a no-op (stays there, draft preserved)", () => {
    const r = recall(H(["one", "two"], 0), -1, "my draft");
    expect(r).toEqual({ index: 0, value: "one", draft: "my draft" });
  });

  test("down walks back towards the draft; past the newest entry restores it", () => {
    // In history at index 1 ("two"): down → index 2 (draft slot) restores the draft.
    const r = recall(H(["one", "two"], 1), 1, "my draft");
    expect(r).toEqual({ index: 2, value: "my draft", draft: "my draft" });
    // Down at the draft slot is a no-op.
    const r2 = recall(H(["one", "two"], 2), 1, "my draft");
    expect(r2).toEqual({ index: 2, value: "my draft", draft: "my draft" });
  });

  test("up at the draft slot with no history is a no-op on the draft", () => {
    const r = recall(H([], 0), -1, "my draft");
    expect(r).toEqual({ index: 0, value: "my draft", draft: "my draft" });
  });

  test("an empty draft is saved as empty (restoring clears the input)", () => {
    const r = recall(H(["one"], 1), -1, "");
    expect(r).toEqual({ index: 0, value: "one", draft: "" });
    const back = recall(H(["one"], 0), 1, "");
    expect(back).toEqual({ index: 1, value: "", draft: "" });
  });

  test("full shell-style round trip: up, up, down, down lands back on the draft", () => {
    const items = ["a", "b", "c"];
    let r = recall(H(items, 3), -1, "draft");
    expect(r.value).toBe("c");
    r = recall(H(items, r.index), -1, r.draft);
    expect(r.value).toBe("b");
    r = recall(H(items, r.index), 1, r.draft);
    expect(r.value).toBe("c");
    r = recall(H(items, r.index), 1, r.draft);
    expect(r).toMatchObject({ index: 3, value: "draft" });
  });
});
