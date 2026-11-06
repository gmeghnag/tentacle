import { describe, expect, test } from "bun:test";
import { type DisplayState, appendNotice, initialState, replaceWithNotices } from "../src/state.ts";

// docs/feat/session-settings-apply.md, round 3 item 3: a pending line becomes its outcome.
describe("replaceWithNotices", () => {
  const notices = (state: DisplayState) =>
    state.items.map((item) => (item.kind === "notice" ? item.text : item.kind));
  const pendingState = () => {
    const state = appendNotice(appendNotice(initialState, "before"), "pending");
    const pending = state.items.at(-1);
    if (pending === undefined) throw new Error("unreachable");
    return { state: appendNotice(state, "after"), pending };
  };

  test("the outcome takes the pending entry's place, not a new one below", () => {
    const { state, pending } = pendingState();
    const next = replaceWithNotices(state, pending, [{ text: "done" }]);
    expect(notices(next).slice(-3)).toEqual(["before", "done", "after"]);
  });

  test("further lines follow it, hints kept", () => {
    const { state, pending } = pendingState();
    const next = replaceWithNotices(state, pending, [
      { text: "done" },
      { text: "kept", hint: "(why)" },
    ]);
    expect(notices(next).slice(-4)).toEqual(["before", "done", "kept", "after"]);
    const kept = next.items.at(-2);
    expect(kept?.kind === "notice" && kept.hint).toBe("(why)");
  });

  test("no outcome: the entry goes", () => {
    const { state, pending } = pendingState();
    expect(notices(replaceWithNotices(state, pending, [])).slice(-2)).toEqual(["before", "after"]);
  });

  test("the entry is gone already (a history reset): the outcome is appended, never lost", () => {
    // Mutation: return the state as it is → the outcome is silently dropped.
    const { state, pending } = pendingState();
    const gone = { ...state, items: state.items.filter((item) => item !== pending) };
    expect(notices(replaceWithNotices(gone, pending, [{ text: "done" }])).slice(-3)).toEqual([
      "before",
      "after",
      "done",
    ]);
  });
});
