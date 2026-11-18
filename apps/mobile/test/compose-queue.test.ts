/**
 * The composer's queue (13a, plan D2/D3): what the phone shows above its input
 * and how a returned row gets back to its writer. Pure decisions, so this file
 * pins them one at a time, including the rules the plan names as mutations:
 *
 * - a returned row of mine is given back ONCE (drop `handedBack` → twice);
 * - another writer's returned row is never reclaimed automatically (auto →
 *   red), only by an explicit `take`;
 * - a row my live send-now carries is not given back at all;
 * - a row queued by a killed earlier app still counts as mine — `own` is the
 *   persisted map, which is the whole point of D3 (the client's `mine` dies
 *   with the process).
 */
import { describe, expect, test } from "bun:test";
import { DomainErrorCode, JsonRpcErrorCode, type QueueState } from "@tentacle/protocol";
import {
  OTHER_DEVICE,
  type OwnIds,
  type QueuedRows,
  addRow,
  afterRefusal,
  bubbleActions,
  handBackStep,
  handOff,
  markAcked,
  onReject,
  pendingBubbles,
  planHandBack,
  restoredByRefusal,
  returnedNotice,
  returnedOthers,
  settleOwn,
  settleReclaim,
  shownRows,
  takeForSendNow,
  takeReturned,
} from "../src/compose-queue.ts";

const own = (pairs: readonly (readonly [string, string])[]): OwnIds => new Map(pairs);

const state = (input: {
  readonly entries?: readonly (readonly [string, string])[];
  readonly returned?: readonly (readonly [string, string, "cancelled" | "failed" | "ended"])[];
}): QueueState => ({
  entries: (input.entries ?? []).map(([id, text]) => ({ id, text })),
  returned: (input.returned ?? []).map(([id, text, cause]) => ({ id, text, cause })),
});

describe("shown rows (D2)", () => {
  test("a local row shows before its ack, with my text", () => {
    const local = addRow([], "steer me", "q1");
    expect(shownRows(local, undefined, own([["q1", "steer me"]]))).toEqual([
      { id: "q1", text: "steer me", state: "queued", mine: true },
    ]);
  });

  test("the daemon's list says where the row is; an acked row it dropped is gone", () => {
    const local = markAcked(addRow([], "steer me", "q1"), "q1");
    expect(
      shownRows(local, { entries: [{ id: "q1", text: "steer me" }] }, own([["q1", "steer me"]])),
    ).toEqual([{ id: "q1", text: "steer me", state: "queued", mine: true }]);
    // Delivered: the daemon's next state no longer lists it → not shown.
    expect(shownRows(local, { entries: [] }, own([["q1", "steer me"]]))).toEqual([]);
  });

  test("an unacked row the daemon does not list yet still shows (in flight)", () => {
    const local = addRow([], "in flight", "q2");
    expect(shownRows(local, { entries: [] }, own([["q2", "in flight"]]))).toEqual([
      { id: "q2", text: "in flight", state: "queued", mine: true },
    ]);
  });

  test("another writer's row is listed, in delivery order, labelled as not mine", () => {
    const rows = shownRows(
      addRow([], "mine", "q1"),
      {
        entries: [
          { id: "other", text: "from the laptop" },
          { id: "q1", text: "mine" },
        ],
      },
      own([["q1", "mine"]]),
    );
    expect(rows.map((r) => [r.id, r.mine])).toEqual([
      ["other", false],
      ["q1", true],
    ]);
    expect(OTHER_DEVICE).toBe("from another device");
  });

  test("a `sending` row keeps its state when the daemon lists it", () => {
    const taken = takeForSendNow(addRow([], "taken", "q1"));
    expect(shownRows(taken.rows, { entries: [{ id: "q1", text: "taken" }] }, own([]))).toEqual([
      { id: "q1", text: "taken", state: "sending", mine: false },
    ]);
  });
});

describe("send now (D2, TUI semantics)", () => {
  test("take returns the queued rows and marks them sending", () => {
    const rows: QueuedRows = [...addRow([], "one", "a"), ...addRow([], "two", "b")];
    const taken = takeForSendNow(rows);
    expect(taken.messages).toEqual([
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ]);
    expect(taken.rows.every((r) => r.state === "sending")).toBe(true);
    // A second tap takes nothing: the rows are already sending.
    expect(takeForSendNow(taken.rows).messages).toEqual([]);
  });

  test("handOff keeps rows typed after the tap", () => {
    const row = addRow([], "typed later", "late");
    const rows = takeForSendNow(addRow([], "sent now", "q1")).rows;
    // handOff needs the rows typed after the tap: the sending set plus the late one.
    expect(handOff([...rows, ...row])).toEqual([
      { id: "late", text: "typed later", state: "queued" },
    ]);
  });

  test("a refusal restores only what the daemon does not hold", () => {
    const rows = takeForSendNow([{ id: "a", text: "one", state: "queued" }]).rows;
    const held = new Set(["a"]);
    const step = afterRefusal(rows, held, true);
    expect(step.text).toBe("");
    expect(step.rows).toEqual([{ id: "a", text: "one", state: "queued" }]);
    // No report at all: everything comes back, and nothing stays queued.
    const none = afterRefusal(rows, null, false);
    expect(none.text).toBe("one");
    expect(none.rows).toEqual([]);
  });

  test("restoredByRefusal names what the caller must not give back twice", () => {
    const messages = [{ id: "a" }, { id: "b" }];
    expect(
      restoredByRefusal({ code: DomainErrorCode.TurnInProgress, data: { held: ["a"] } }, messages),
    ).toEqual(["b"]);
    expect(restoredByRefusal({ code: DomainErrorCode.TurnInProgress }, messages)).toEqual([
      "a",
      "b",
    ]);
    expect(restoredByRefusal({ code: JsonRpcErrorCode.MethodNotFound }, messages)).toEqual([]);
    expect(restoredByRefusal({ code: DomainErrorCode.NoTurnRunning }, messages)).toEqual([]);
    expect(restoredByRefusal(null, messages)).toEqual(["a", "b"]);
  });

  test("a refused enqueue drops its row and notifies, unless a send-now owns it", () => {
    const rows = addRow([], "refused", "q1");
    expect(onReject(rows, "q1", new Set())).toEqual({ rows: [], notify: true });
    expect(onReject(rows, "q1", new Set(["q1"]))).toEqual({ rows, notify: false });
  });
});

describe("returned rows (D3)", () => {
  const mine = own([["q1", "my steer"]]);

  test("mine comes back once, into the field, and is reclaimed once", () => {
    const queued = state({ returned: [["q1", "my steer", "cancelled"]] });
    const first = handBackStep({
      state: queued,
      own: mine,
      handedBack: new Set(),
      reclaiming: new Set(),
      stoppedHere: false,
    });
    expect(first.give.map((r) => r.id)).toEqual(["q1"]);
    expect(first.text).toBe("my steer");
    expect(first.reclaim).toEqual(["q1"]);
    expect(first.notice).toBe(
      "_Turn stopped from another device: your queued message is back in the input_",
    );
    expect(first.handedBack.has("q1")).toBe(true);

    // MUTATION GUARD: without `handedBack` this would give the row twice.
    const again = handBackStep({
      state: queued,
      own: mine,
      handedBack: first.handedBack,
      reclaiming: first.reclaiming,
      stoppedHere: false,
    });
    expect(again.give).toEqual([]);
    expect(again.text).toBe("");
    expect(again.notice).toBe("");
    // Still reclaimed: the earlier reclaim may have been lost with the link.
    expect(again.reclaim).toEqual([]);
    const settled = handBackStep({
      state: queued,
      own: mine,
      handedBack: first.handedBack,
      reclaiming: settleReclaim(first.reclaiming, first.reclaim),
      stoppedHere: false,
    });
    expect(settled.give).toEqual([]);
    expect(settled.reclaim).toEqual(["q1"]);
  });

  test("the text is MINE, never the daemon's", () => {
    const step = handBackStep({
      state: state({ returned: [["q1", "words I never typed", "failed"]] }),
      own: mine,
      handedBack: new Set(),
      reclaiming: new Set(),
      stoppedHere: false,
    });
    expect(step.text).toBe("my steer");
  });

  test("a row my live send-now carries is only reclaimed, never given back", () => {
    const step = handBackStep({
      state: state({ returned: [["q1", "my steer", "cancelled"]] }),
      own: mine,
      handedBack: new Set(),
      reclaiming: new Set(),
      carried: new Set(["q1"]),
      stoppedHere: true,
    });
    expect(step.give).toEqual([]);
    expect(step.text).toBe("");
    expect(step.reclaim).toEqual(["q1"]);
  });

  test("two of mine are joined like a send-now, one banner", () => {
    const step = handBackStep({
      state: state({
        returned: [
          ["a", "", "cancelled"],
          ["b", "", "cancelled"],
        ],
      }),
      own: own([
        ["a", "one"],
        ["b", "two"],
      ]),
      handedBack: new Set(),
      reclaiming: new Set(),
      stoppedHere: true,
    });
    expect(step.text).toBe("one\n\ntwo");
    expect(step.notice).toBe("_Your 2 queued messages are back in the input_");
  });

  test("an id I never minted is ignored, and another writer's row is never reclaimed", () => {
    const queued = state({ returned: [["theirs", "their text", "ended"]] });
    const step = handBackStep({
      state: queued,
      own: mine,
      handedBack: new Set(),
      reclaiming: new Set(),
      stoppedHere: false,
    });
    expect(step.give).toEqual([]);
    expect(step.reclaim).toEqual([]);
    expect(returnedOthers(queued, mine)).toEqual([
      { id: "theirs", text: "their text", cause: "ended" },
    ]);
    expect(planHandBack(queued, mine, new Set())).toEqual({ give: [], reclaim: [] });
  });

  test("Take: another device's row, one tap = reclaim + its text", () => {
    const queued = state({ returned: [["theirs", "their text", "cancelled"]] });
    expect(takeReturned(queued, mine, "theirs")).toEqual({
      kind: "take",
      id: "theirs",
      text: "their text",
      reclaim: ["theirs"],
    });
    // Mine are given back by themselves: a tap is a no-op, never a second path.
    expect(takeReturned(state({ returned: [["q1", "", "cancelled"]] }), mine, "q1")).toEqual({
      kind: "none",
    });
    expect(takeReturned(queued, mine, "gone")).toEqual({ kind: "none" });
  });

  test("a duplicate id in the daemon's list is given once", () => {
    const step = handBackStep({
      state: state({
        returned: [
          ["q1", "a", "cancelled"],
          ["q1", "b", "cancelled"],
        ],
      }),
      own: mine,
      handedBack: new Set(),
      reclaiming: new Set(),
      stoppedHere: false,
    });
    expect(step.give).toHaveLength(1);
    expect(step.reclaim).toEqual(["q1"]);
  });

  test("the banner wording is the TUI's", () => {
    expect(returnedNotice(1, "cancelled", true)).toBe("_Your queued message is back in the input_");
    expect(returnedNotice(2, "failed", false)).toBe(
      "_The turn ended early: your 2 queued messages are back in the input_",
    );
    expect(returnedNotice(1, "ended", false)).toBe(
      "_The session ended: your queued message is back in the input_",
    );
    expect(returnedNotice(1, "cancelled", false)).toBe(
      "_Turn stopped from another device: your queued message is back in the input_",
    );
  });
});

describe("my persisted ids (D4 bound)", () => {
  test("an id the daemon no longer lists leaves the set", () => {
    const ownIds = own([
      ["gone", "old"],
      ["live", "waiting"],
    ]);
    expect([...settleOwn(ownIds, state({ entries: [["live", "waiting"]] }))]).toEqual([
      ["live", "waiting"],
    ]);
  });

  test("a local unacked row or a send-now's message keeps its id", () => {
    const ownIds = own([["inflight", "x"]]);
    expect([...settleOwn(ownIds, state({}), ["inflight"])]).toEqual([["inflight", "x"]]);
  });

  test("a returned row still counts as mine until reclaimed", () => {
    const ownIds = own([["back", "txt"]]);
    expect([...settleOwn(ownIds, state({ returned: [["back", "", "cancelled"]] }))]).toEqual([
      ["back", "txt"],
    ]);
  });
});

describe("pending bubbles in the transcript (D1)", () => {
  const rows = (...specs: readonly (readonly [string, string, boolean, "queued" | "sending"])[]) =>
    specs.map(([id, text, mine, state]) => ({ id, text, mine, state }));

  test("one bubble per row, in delivery order, from the rows the phone holds", () => {
    // Mutation: return them reversed / sorted by id → red.
    expect(
      pendingBubbles(rows(["b", "second", true, "queued"], ["a", "first", false, "queued"])),
    ).toEqual([
      { id: "b", text: "second", mine: true, phase: "pending" },
      { id: "a", text: "first", mine: false, phase: "pending" },
    ]);
  });

  test("a row's state becomes the bubble's phase", () => {
    // Mutation: map `sending` to `pending` → red (the footnote would say "next step").
    expect(pendingBubbles(rows(["q", "w", true, "queued"]))[0]?.phase).toBe("pending");
    expect(pendingBubbles(rows(["s", "w", true, "sending"]))[0]?.phase).toBe("sending");
  });

  test("another device's row appears and stays labelled not-mine", () => {
    expect(pendingBubbles(rows(["o", "theirs", false, "queued"]))[0]?.mine).toBe(false);
  });

  test("no rows → no bubbles (nothing invented, no placeholder)", () => {
    expect(pendingBubbles([])).toEqual([]);
  });
});

describe("the E1 menu on a pending bubble (D2)", () => {
  const mine = { id: "e1", text: "my words", mine: true, phase: "pending" as const };
  const all = { link: true, turn: true, sendNow: true, unqueue: true };

  test("mine, pending, on a live link, during a turn, daemon supports unqueue → the three", () => {
    // Mutation: drop any clause below → red.
    expect(bubbleActions(mine, all)).toEqual(["edit", "send-now", "cancel"]);
  });

  test("another writer's words are shown, never acted on (owner Q3)", () => {
    expect(bubbleActions({ ...mine, mine: false }, all)).toEqual([]);
  });

  test("a bubble already in flight (sending) offers nothing", () => {
    expect(bubbleActions({ ...mine, phase: "sending" }, all)).toEqual([]);
  });

  test("no link, or no turn: nothing (nothing travels / nothing is queued)", () => {
    expect(bubbleActions(mine, { ...all, link: false })).toEqual([]);
    expect(bubbleActions(mine, { ...all, turn: false })).toEqual([]);
  });

  test("an older daemon hides Edit and Cancel, keeping Send now", () => {
    // Mutation: gate nothing on `unqueue` → red (a tap would hit MethodNotFound).
    expect(bubbleActions(mine, { ...all, unqueue: false })).toEqual(["send-now"]);
  });

  test("Send now is D3's rule, so it never appears on its own", () => {
    expect(bubbleActions(mine, { ...all, sendNow: false })).toEqual(["edit", "cancel"]);
  });
});
