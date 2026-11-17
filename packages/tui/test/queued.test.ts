import { describe, expect, test } from "bun:test";
import {
  type QueuedRows,
  addRow,
  afterRefusal,
  afterUnqueue,
  handOff,
  markAcked,
  onReject,
  onSteer,
  onTurnEnd,
  pullBackTarget,
  requeue,
  rowTexts,
  shownRows,
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

  test("a steer that names its row drops that row only; another writer's drops nothing", () => {
    // Review F1's root: the daemon says whose steer it is, the TUI never guesses.
    const { rows } = takeForSendNow(three());
    expect(onSteer(rows, "b").map((r) => r.id)).toEqual(["a", "c"]);
    expect(onSteer(three(), "zz")).toEqual(three());
  });

  test("a steer with no id (an older daemon) drops the front row (FIFO), whatever its state", () => {
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

// docs/feat/tui-foreign-turns.md C7: the rows shown are the daemon's list.
describe("shownRows / markAcked (C7)", () => {
  test("with a report: its entries in order (mine keep my state), then my unacked rows", () => {
    const { rows } = takeForSendNow(addRow([], "mine", "m1"));
    const local = addRow(rows, "typed", "m2");
    const shown = shownRows(local, {
      entries: [
        { id: "p1", text: "phone" },
        { id: "m1", text: "mine" },
      ],
    });
    expect(shown.map((r) => [r.id, r.state])).toEqual([
      ["p1", "queued"],
      ["m1", "sending"],
      ["m2", "queued"],
    ]);
  });

  test("an acked row of mine the daemon no longer lists is gone; one it still lists (carried) stays after my local rows went", () => {
    const acked = markAcked(addRow([], "mine", "m1"), "m1");
    expect(acked[0]?.acked).toBe(true);
    expect(shownRows(acked, { entries: [] })).toEqual([]);
    const carried = shownRows(onTurnEnd(acked), { entries: [{ id: "m1", text: "mine" }] });
    expect(rowTexts(carried)).toEqual(["mine"]);
  });

  test("no report yet (or a local session): the local rows, as before", () => {
    expect(shownRows(three(), undefined)).toEqual(three());
  });
});

describe("pull a queued message back (docs/feat/queue-unqueue.md)", () => {
  test("the target is my newest ACKED row no send-now took; none → null", () => {
    const acked = markAcked(markAcked(three(), "a"), "b");
    expect(pullBackTarget(acked)).toEqual({ id: "b", text: "B" });
    // c is not acked: its enqueue may still be in flight (an unqueue could overtake it).
    expect(pullBackTarget(three())).toBeNull();
    const sending = acked.map((r) => (r.id === "b" ? { ...r, state: "sending" as const } : r));
    expect(pullBackTarget(sending)).toEqual({ id: "a", text: "A" });
    expect(pullBackTarget([])).toBeNull();
  });

  test("removed → the row goes, its text to the field; delivered/unsupported → it stays, a notice", () => {
    const target = { id: "b", text: "B" };
    const removed = afterUnqueue(three(), target, { removed: ["b"], delivered: [] });
    expect(rowTexts(removed.rows)).toEqual(["A", "C"]);
    expect(removed).toMatchObject({ text: "B", notice: null });
    const delivered = afterUnqueue(three(), target, { removed: [], delivered: ["b"] });
    expect(delivered.rows).toEqual(three());
    expect(delivered.text).toBeNull();
    expect(delivered.notice).toContain("already sent");
    const old = afterUnqueue(three(), target, "unsupported");
    expect(old.rows).toEqual(three());
    expect(old.text).toBeNull();
    expect(old.notice).toContain("can't cancel queued messages");
  });
});
