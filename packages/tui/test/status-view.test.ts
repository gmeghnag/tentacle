import { describe, expect, test } from "bun:test";
import { failTurn, initialState } from "../src/state.ts";
import { statusTokens } from "../src/status-view.ts";

// docs/fix/detach-live-followups.md F2 (owner OQ5): unmeasured is unknown, never 0.
describe("statusTokens", () => {
  test("nothing measured (a fresh TUI, a failed first turn): unknown", () => {
    expect(statusTokens(initialState)).toEqual({ totals: null, context: null });
    expect(statusTokens(failTurn(initialState, "boom", 0))).toEqual({
      totals: null,
      context: null,
    });
  });

  test("once a usage was applied: the session totals and the last prompt", () => {
    const state = {
      ...initialState,
      sessionTokens: { prompt: 70, completion: 9 },
      lastTurnTokens: { prompt: 50, completion: 4 },
    };
    expect(statusTokens(state)).toEqual({ totals: { prompt: 70, completion: 9 }, context: 50 });
    // A later failed turn keeps the last measured figures.
    expect(statusTokens(failTurn(state, "boom", 0)).context).toBe(50);
  });
});
