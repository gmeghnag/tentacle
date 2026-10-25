import { describe, expect, test } from "bun:test";
import * as V from "../src/queue-view.ts";

// The queue's pure rules (docs/feat/queued-broadcast.md, Design item 4).

const row = (id: string) => ({ id, text: id.toUpperCase() });
const none = () => false;

describe("queueView", () => {
  test("idle or compacting: no entries; returned rows stay", () => {
    const returned = [{ ...row("r"), cause: "cancelled" as const }];
    expect(
      V.queueView({ turnRunning: false, queue: [], successor: null, isDelivered: none, returned }),
    ).toEqual({ entries: [], returned });
  });

  test("a running turn: the mirror, in order", () => {
    expect(
      V.queueView({
        turnRunning: true,
        queue: [row("a"), row("b")],
        successor: null,
        isDelivered: none,
        returned: [],
      }),
    ).toEqual({ entries: [row("a"), row("b")], returned: [] });
  });

  test("a live reserved send-now: its prompt (not delivered), the carried rows, its own steers", () => {
    const successor = {
      messages: [row("a"), row("d")],
      steers: [row("y")],
      cancelled: false,
    };
    expect(
      V.queueView({
        turnRunning: true,
        queue: [row("a"), row("x")],
        successor,
        isDelivered: (id) => id === "d",
        returned: [],
      }).entries,
    ).toEqual([row("a"), row("x"), row("y")]);
  });

  test("a cancelled send-now contributes nothing (its sender restores its rows)", () => {
    const successor = { messages: [row("a")], steers: [row("y")], cancelled: true };
    expect(
      V.queueView({
        turnRunning: true,
        queue: [row("a"), row("x")],
        successor,
        isDelivered: none,
        returned: [],
      }).entries,
    ).toEqual([row("a"), row("x")]);
  });
});

describe("leftovers", () => {
  test("a live send-now carries them: nothing is returned", () => {
    expect(
      V.leftovers([row("x")], { messages: [row("a")], steers: [], cancelled: false }),
    ).toBeNull();
  });

  test("no successor: every row goes back", () => {
    expect(V.leftovers([row("a"), row("b")], null)).toEqual([row("a"), row("b")]);
  });

  test("a cancelled send-now: its own messages and steers are not returned (no double hand-back)", () => {
    expect(
      V.leftovers([row("a"), row("b"), row("x")], {
        messages: [row("b")],
        steers: [row("x")],
        cancelled: true,
      }),
    ).toEqual([row("a")]);
  });
});

describe("returnCause / sameState", () => {
  test("closed → ended; cancelled → cancelled; anything else → failed", () => {
    expect(V.returnCause(true, "cancelled")).toBe("ended");
    expect(V.returnCause(false, "cancelled")).toBe("cancelled");
    for (const r of ["error", "max_tokens", "max_iterations", "end_turn"] as const) {
      expect(V.returnCause(false, r)).toBe("failed");
    }
  });

  test("sameState compares ids, texts, causes and order", () => {
    const a = {
      entries: [row("a"), row("b")],
      returned: [{ ...row("r"), cause: "failed" as const }],
    };
    expect(V.sameState(a, { entries: [row("a"), row("b")], returned: [...a.returned] })).toBe(true);
    expect(V.sameState(a, { ...a, entries: [row("b"), row("a")] })).toBe(false);
    expect(V.sameState(a, { ...a, entries: [row("a"), { id: "b", text: "other" }] })).toBe(false);
    expect(V.sameState(a, { ...a, returned: [{ ...row("r"), cause: "ended" }] })).toBe(false);
    expect(V.sameState(a, { ...a, returned: [] })).toBe(false);
  });
});
