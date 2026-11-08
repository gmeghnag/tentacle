import { describe, expect, test } from "bun:test";
import type { SubAgentProgress } from "../src/state.ts";
import { SUBAGENT_TAIL_ROWS, subAgentView } from "../src/subagent-view.ts";

// docs/feat/subagent-tail-view.md, eval A5 L4: a foreground sub-agent shows a
// ROLLING TAIL — its latest steps — not its first tool calls.
//
// Mutation (each red, verified): `activities.slice(-max)` → `slice(0, max)` in
// `subAgentView` makes every `rows`/`hidden` assertion below fail.

const labels = (n: number): string[] => Array.from({ length: n }, (_, i) => `step ${i + 1}`);

const sub = (over: Partial<SubAgentProgress> = {}): SubAgentProgress => ({
  agentType: "explore",
  description: "find callers of parseConfig",
  activities: [],
  toolUses: 0,
  tokens: 0,
  done: false,
  ...over,
});

describe("subAgentView: the head", () => {
  test("carries the type, the description, the tool uses and the child's own tokens", () => {
    const view = subAgentView(
      sub({ activities: labels(2), toolUses: 2, tokens: 12_400, agentType: "general" }),
    );
    expect(view.head).toEqual({
      agentType: "general",
      description: "find callers of parseConfig",
      toolUses: 2,
      tokens: 12_400,
    });
  });
});

describe("subAgentView: a rolling tail of the LATEST steps", () => {
  test("0 steps: no rows, nothing hidden (the renderer adds its own `└─ …`)", () => {
    expect(subAgentView(sub())).toEqual({
      head: {
        agentType: "explore",
        description: "find callers of parseConfig",
        toolUses: 0,
        tokens: 0,
      },
      hidden: 0,
      rows: [],
      done: null,
    });
  });

  test("1 step: shown, nothing hidden", () => {
    const view = subAgentView(sub({ activities: labels(1) }));
    expect(view.rows).toEqual(["step 1"]);
    expect(view.hidden).toBe(0);
  });

  test("exactly maxRows (5): all shown, nothing hidden — no `… +0 earlier`", () => {
    const view = subAgentView(sub({ activities: labels(5) }));
    expect(view.rows).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5"]);
    expect(view.hidden).toBe(0);
  });

  test("maxRows + 1 (6): the LAST five, one earlier step hidden", () => {
    const view = subAgentView(sub({ activities: labels(6) }));
    expect(view.rows).toEqual(["step 2", "step 3", "step 4", "step 5", "step 6"]);
    expect(view.hidden).toBe(1);
  });

  test("12 steps: the last five, seven hidden (mockup 1: `… +7 earlier`)", () => {
    const view = subAgentView(sub({ activities: labels(12) }));
    expect(view.rows).toEqual(["step 8", "step 9", "step 10", "step 11", "step 12"]);
    expect(view.hidden).toBe(7);
    expect(view.rows).not.toContain("step 1");
    expect(view.rows.at(-1)).toBe("step 12");
  });

  test("60 steps (more than the state's 50 cap): the newest five of what state kept", () => {
    // `SUB_ACTIVITY_CAP` keeps the LAST 50 (`state.ts:190,422`), so state holds
    // steps 11..60 and the tail is honest about THAT, not about 60.
    const view = subAgentView(sub({ activities: labels(60).slice(-50), toolUses: 60 }));
    expect(view.rows).toEqual(["step 56", "step 57", "step 58", "step 59", "step 60"]);
    expect(view.hidden).toBe(45);
  });

  test("maxRows 3: the last three", () => {
    const view = subAgentView(sub({ activities: labels(12) }), { maxRows: 3 });
    expect(view.rows).toEqual(["step 10", "step 11", "step 12"]);
    expect(view.hidden).toBe(9);
  });

  test("maxRows 0 and a negative maxRows: no rows, everything hidden, never a negative count", () => {
    expect(subAgentView(sub({ activities: labels(3) }), { maxRows: 0 })).toMatchObject({
      rows: [],
      hidden: 3,
    });
    expect(subAgentView(sub({ activities: labels(3) }), { maxRows: -2 })).toMatchObject({
      rows: [],
      hidden: 3,
    });
  });

  test("maxRows is floored: 2.9 shows two", () => {
    expect(subAgentView(sub({ activities: labels(6) }), { maxRows: 2.9 }).rows).toEqual([
      "step 5",
      "step 6",
    ]);
  });

  test("the default is one named constant (owner Q17: 5)", () => {
    expect(SUBAGENT_TAIL_ROWS).toBe(5);
    const twelve = labels(12);
    expect(subAgentView(sub({ activities: twelve })).rows).toEqual(
      subAgentView(sub({ activities: twelve }), { maxRows: SUBAGENT_TAIL_ROWS }).rows,
    );
  });
});

describe("subAgentView: the outcome", () => {
  test("running: done is null", () => {
    expect(subAgentView(sub({ activities: labels(1) })).done).toBeNull();
  });

  test("finished: done carries the stop reason, and the tail is KEPT", () => {
    const view = subAgentView(
      sub({ activities: labels(12), done: true, stopReason: "end_turn", toolUses: 12 }),
    );
    expect(view.done).toEqual({ stopReason: "end_turn" });
    expect(view.rows).toEqual(["step 8", "step 9", "step 10", "step 11", "step 12"]);
    expect(view.hidden).toBe(7);
  });

  test("error and cancelled children keep their tail (a failed child's trail is the point)", () => {
    for (const stopReason of ["error", "cancelled"]) {
      const view = subAgentView(sub({ activities: labels(8), done: true, stopReason }));
      expect(view.done).toEqual({ stopReason });
      expect(view.rows).toEqual(["step 4", "step 5", "step 6", "step 7", "step 8"]);
      expect(view.hidden).toBe(3);
    }
  });

  test("done with no stop reason (an older daemon's frame): finished, outcome unnamed", () => {
    expect(subAgentView(sub({ activities: labels(2), done: true })).done).toEqual({});
  });
});
