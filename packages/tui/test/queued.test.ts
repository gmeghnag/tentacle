import { describe, expect, test } from "bun:test";
import {
  type QueuedRows,
  addRow,
  afterRefusal,
  handOff,
  onReject,
  onSteer,
  onTurnEnd,
  requeue,
  rowTexts,
  takeAll,
  takeForSendNow,
} from "../src/queued.ts";

const three = (): QueuedRows => addRow(addRow(addRow([], "A", "a"), "B", "b"), "C", "c");

describe("queued rows", () => {
  test("add keeps the enqueue order; rows start queued", () => {
    const rows = three();
    expect(rowTexts(rows)).toEqual(["A", "B", "C"]);
    expect(rows.every((r) => r.state === "queued")).toBe(true);
  });

  test("a steer drops the front row (FIFO), whatever its state", () => {
    expect(rowTexts(onSteer(three()))).toEqual(["B", "C"]);
    const { rows } = takeForSendNow(three());
    expect(onSteer(rows).map((r) => r.id)).toEqual(["b", "c"]);
    expect(onSteer([])).toEqual([]);
  });

  test("a reject drops exactly that queued row (the middle one), and says so", () => {
    const res = onReject(three(), "b", new Set());
    expect(res.notify).toBe(true);
    expect(rowTexts(res.rows)).toEqual(["A", "C"]);
  });

  test("a reject of a row already gone (the turn ended) still says so", () => {
    expect(onReject([], "b", new Set())).toEqual({ rows: [], notify: true });
  });

  test("a reject of a text a send-now took: the row stays, nothing is said", () => {
    const { rows, messages } = takeForSendNow(three());
    const owned = new Set(messages.map((m) => m.id));
    expect(onReject(rows, "b", owned)).toEqual({ rows, notify: false });
    expect(onReject([], "b", owned)).toEqual({ rows: [], notify: false });
  });

  test("takeForSendNow marks every queued row sending and returns them with their ids", () => {
    const { rows, messages } = takeForSendNow(three());
    expect(messages).toEqual([
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ]);
    expect(rows.every((r) => r.state === "sending")).toBe(true);
    // Rows typed after the chord are queued; a second take takes only them.
    const more = addRow(rows, "D", "d");
    expect(takeForSendNow(more).messages).toEqual([{ id: "d", text: "D" }]);
  });

  test("onTurnEnd clears every row", () => {
    expect(onTurnEnd(takeForSendNow(three()).rows)).toEqual([]);
  });

  test("handOff drops the sending rows and keeps the ones typed after the chord", () => {
    const rows = addRow(takeForSendNow(three()).rows, "D", "d");
    expect(handOff(rows)).toEqual([{ id: "d", text: "D", state: "queued" }]);
  });

  describe("afterRefusal", () => {
    // A, B taken by the send-now; D typed after the chord.
    const taken = () =>
      addRow(takeForSendNow(addRow(addRow([], "A", "a"), "B", "b")).rows, "D", "d");

    test("no report, old turn running: every sent text back, later rows stay queued", () => {
      const res = afterRefusal(taken(), null, true);
      expect(res.text).toBe("A\n\nB");
      expect(res.rows).toEqual([{ id: "d", text: "D", state: "queued" }]);
      expect(afterRefusal([], null, true).text).toBe("");
    });

    test("held ids are queued again (in order), only the others come back", () => {
      const res = afterRefusal(taken(), new Set(["a"]), true);
      expect(res.text).toBe("B");
      expect(res.rows).toEqual([
        { id: "a", text: "A", state: "queued" },
        { id: "d", text: "D", state: "queued" },
      ]);
    });

    test("everything held → nothing comes back", () => {
      expect(afterRefusal(taken(), new Set(["a", "b"]), true).text).toBe("");
    });

    test("old turn over: no row stays (its queue is the daemon's), the unheld texts come back", () => {
      expect(afterRefusal(taken(), new Set(["a"]), false)).toEqual({ rows: [], text: "B" });
      expect(afterRefusal(taken(), null, false)).toEqual({ rows: [], text: "A\n\nB" });
    });
  });

  test("takeAll returns every remaining text in order and clears", () => {
    const rows = addRow(takeForSendNow(three()).rows, "D", "d");
    expect(takeAll(rows)).toEqual({ rows: [], text: "A\n\nB\n\nC\n\nD" });
    expect(takeAll([])).toEqual({ rows: [], text: "" });
  });

  test("requeue (an older daemon refused a compaction's send-now): every row queued again, ids and order kept", () => {
    expect(requeue(takeForSendNow(three()).rows)).toEqual(three());
  });
});
