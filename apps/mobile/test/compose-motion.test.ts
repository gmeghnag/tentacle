/**
 * When the compose half's rows animate (Slice 6): a row arriving, leaving or
 * changing state — never a mere re-render with the same rows (the screen gets a
 * new state object on every streamed token, and animating each one would make
 * the whole transcript swim).
 */
import { describe, expect, test } from "bun:test";
import { composeRowsMoved } from "../src/compose-motion.ts";
import type { ComposeBarView } from "../src/session-view.ts";

const empty: ComposeBarView = {
  queued: [],
  returnedOthers: [],
  returnedNotice: "",
  outbox: [],
  notSaved: false,
  chips: [],
  attach: { items: ["photo", "camera"], reason: null },
  ownPending: 0,
  sendNow: false,
  pending: [],
  editing: null,
  unqueueOff: false,
};

const queued = (id: string, state: "queued" | "sending" = "queued") =>
  ({ id, text: "t", state, mine: true }) as ComposeBarView["queued"][number];

describe("composeRowsMoved", () => {
  test("the same rows in a new object: no animation", () => {
    const a = { ...empty, queued: [queued("q1")] };
    expect(composeRowsMoved(a, { ...a, queued: [queued("q1")] })).toBe(false);
    expect(composeRowsMoved(empty, { ...empty })).toBe(false);
  });

  test("a queued row arrives or leaves", () => {
    expect(composeRowsMoved(empty, { ...empty, queued: [queued("q1")] })).toBe(true);
    expect(composeRowsMoved({ ...empty, queued: [queued("q1")] }, empty)).toBe(true);
  });

  test("a row changes state (queued → sending)", () => {
    expect(
      composeRowsMoved(
        { ...empty, queued: [queued("q1")] },
        { ...empty, queued: [queued("q1", "sending")] },
      ),
    ).toBe(true);
  });

  test("outbox rows, returned rows, chips and Send now count too", () => {
    const outbox = { itemId: "o1", text: "t", state: "waiting", decide: false } as const;
    expect(composeRowsMoved(empty, { ...empty, outbox: [outbox] })).toBe(true);
    expect(composeRowsMoved(empty, { ...empty, returnedOthers: [{ id: "r", text: "t" }] })).toBe(
      true,
    );
    expect(
      composeRowsMoved(empty, { ...empty, chips: [{ key: "c", kind: "image", state: "ready" }] }),
    ).toBe(true);
    expect(composeRowsMoved(empty, { ...empty, sendNow: true })).toBe(true);
  });

  test("the editing banner appears and leaves (D6)", () => {
    const editing = { ...empty, editing: { id: "q1", text: "t", prior: "" } };
    expect(composeRowsMoved(empty, editing)).toBe(true);
    expect(composeRowsMoved(editing, empty)).toBe(true);
    expect(composeRowsMoved(editing, { ...editing })).toBe(false);
  });
});
