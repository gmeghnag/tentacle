import { describe, expect, test } from "bun:test";
import { failTurn, initialState } from "../src/state.ts";
import {
  PILL_DONE_MS,
  type PillInput,
  pillText,
  pillView,
  statusTokens,
} from "../src/status-view.ts";

describe("pillView: the status bar's pill (owner's UI revision)", () => {
  const base: PillInput = { agents: 2, now: 1_000_000, focus: "input", width: 190 };
  const text = (over: Partial<PillInput> = {}): string => pillText(pillView({ ...base, ...over }));

  test("nothing in the background → NO pill (the screen is exactly as before)", () => {
    expect(pillView({ ...base, agents: 0 })).toEqual({ kind: "none" });
    expect(text({ agents: 0 })).toBe("");
    expect(text({ agents: 0, jobs: 0 })).toBe("");
  });

  test("the counts, unfocused: a dim `↓` says what DOWN does", () => {
    expect(text()).toBe("2 agents ↓");
    expect(text({ agents: 1 })).toBe("1 agent ↓");
    // Jobs are counted by kind, only when there are any (P6's feed; 0 today).
    expect(text({ jobs: 1 })).toBe("2 agents · 1 shell ↓");
  });

  test("focused: the pill's body is padded and carries `⏎`; the hint sits beside it", () => {
    const focused = pillView({ ...base, focus: "pill" });
    expect(focused).toMatchObject({ kind: "pill", state: "focus", hint: "enter open · esc back" });
    expect(pillText(focused)).toBe(" 2 agents ⏎ ");
    // Under the tier the pill's own `⏎` IS the hint: nothing is cut to make room.
    const narrow = pillView({ ...base, focus: "pill", width: 60 });
    expect(narrow).toMatchObject({ state: "focus", hint: "" });
    expect(text({ focus: "pill", width: 60 })).toBe(" 2 agents ⏎ ");
    // The dropdown open: the pill shows `▴` (the panel is above it).
    expect(text({ focus: "dropdown" })).toBe(" 2 agents ▴ ");
    expect(text({ focus: "open" })).toBe(" 2 agents ▴ ");
  });

  test("`▲ sa-2 asks` comes first, and outranks a `✓ done`", () => {
    const asked = pillView({ ...base, askingId: "sa-2" });
    expect(asked).toMatchObject({ kind: "pill", state: "ask", notice: "▲ sa-2 asks" });
    expect(pillText(asked)).toBe("▲ sa-2 asks · 2 agents ↓");
    // Both at once: the thing to ACT on wins.
    const both = pillText(
      pillView({ ...base, askingId: "sa-2", finished: { id: "sa-1", at: base.now } }),
    );
    expect(both).toBe("▲ sa-2 asks · 2 agents ↓");
    // A focused ask keeps the warning pill and its `⏎`.
    expect(pillText(pillView({ ...base, askingId: "sa-2", focus: "pill" }))).toBe(
      " ▲ sa-2 asks · 2 agents ⏎ ",
    );
  });

  test("`✓ sa-1 done` for ~5 s, then just the new counts (and nothing when it was the last)", () => {
    const at = 1_000_000;
    const justDone = pillView({ ...base, agents: 1, finished: { id: "sa-1", at }, now: at + 10 });
    expect(justDone).toMatchObject({ state: "done", notice: "✓ sa-1 done" });
    expect(pillText(justDone)).toBe("✓ sa-1 done · 1 agent ↓");
    // The window closes at PILL_DONE_MS — the property, not "it disappeared".
    const stillIn = pillView({
      ...base,
      agents: 1,
      finished: { id: "sa-1", at },
      now: at + PILL_DONE_MS - 1,
    });
    expect(stillIn).toMatchObject({ state: "done" });
    const expired = pillView({
      ...base,
      agents: 1,
      finished: { id: "sa-1", at },
      now: at + PILL_DONE_MS,
    });
    expect(expired).toMatchObject({ state: "idle", notice: "" });
    expect(pillText(expired)).toBe("1 agent ↓");
    // The last one ended: no pill at all (and focus goes back to the input).
    expect(pillView({ ...base, agents: 0, finished: { id: "sa-1", at }, now: at + 10 })).toEqual({
      kind: "none",
    });
  });
});

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
