import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import type { SubAgentProgress } from "../src/state.ts";
import {
  SUBAGENT_TAIL_ROWS,
  subAgentEarlierRow,
  subAgentHeadRow,
  subAgentReport,
  subAgentView,
} from "../src/subagent-view.ts";

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

  test("60 steps (more than the state's 50 cap): the newest five, and 55 counted earlier", () => {
    // `SUB_ACTIVITY_CAP` keeps the LAST 50 labels (`state.ts:195,427`), so state
    // holds steps 11..60 — but the HEAD says `60 tool uses`, so a count read off
    // the labels alone would contradict the row right above it (review M1). The
    // count is the child's own `toolUses` when that is the larger of the two.
    const view = subAgentView(sub({ activities: labels(60).slice(-50), toolUses: 60 }));
    expect(view.rows).toEqual(["step 56", "step 57", "step 58", "step 59", "step 60"]);
    expect(view.head.toolUses).toBe(60);
    expect(view.hidden).toBe(55);
  });

  test("the wire's own shape (a tail of 8 labels, 19 tool uses): 14 earlier, matching the head", () => {
    // Review H1's background row carries `tail: last <= 8 labels` + `toolUses`,
    // so 6a/7 reuse this count against the SAME head (review M1/L4).
    const view = subAgentView(sub({ activities: labels(19).slice(-8), toolUses: 19 }));
    expect(view.rows).toHaveLength(5);
    expect(view.hidden).toBe(14);
    expect(view.hidden).toBe(view.head.toolUses - view.rows.length);
  });

  test("hidden never goes negative when the labels outrun the counter", () => {
    // Not reachable on the wire (each `subagent_tool` bumps BOTH counters), but
    // the head and the cut row must describe the same number when it happens.
    const view = subAgentView(sub({ activities: labels(3), toolUses: 0 }));
    expect(view.hidden).toBe(0);
    expect(view.head.toolUses).toBe(3);
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

describe("subAgentEarlierRow: the cut row's wording (review Q3)", () => {
  test("one grammar with the transcript's other cut markers", () => {
    expect(subAgentEarlierRow(7, false)).toBe("… +7 earlier · ctrl+o to expand");
    expect(subAgentEarlierRow(7, true)).toBe("… +7 earlier"); // already expanded
    expect(subAgentEarlierRow(0, false)).toBeNull();
  });

  test("it fits at 46 columns even at the 999-step worst case", () => {
    // 46 - 2 (the body indent the renderer adds) is the room it has; the widest
    // count a 3-digit `toolUses` can produce must not need a cut.
    const worst = subAgentEarlierRow(999, false) ?? "";
    expect(stringWidth(worst)).toBe(33);
    expect(stringWidth(`  ${worst}`)).toBeLessThanOrEqual(46);
  });
});

describe("subAgentHeadRow: the type gives way, not the counts (review L4)", () => {
  const head = {
    agentType: "an-extremely-long-sub-agent-type-name-that-goes-on-and-on-forever",
    description: "d",
    toolUses: 7,
    tokens: 12_400,
  };

  test("a long type is cut; the counts and the tokens always survive", () => {
    // 24 is the narrowest body width whose head can still hold the counts (18
    // cells is the pathological floor: the renderer's own body minimum is 20).
    for (const width of [44, 24]) {
      const row = subAgentHeadRow(head, width);
      expect(row).toContain("· 7 tool uses");
      expect(row.endsWith("· 7 tool uses · 12k")).toBe(true);
      expect(stringWidth(row)).toBeLessThanOrEqual(width - 2);
    }
  });

  test("a width that cannot hold the counts alone still fits, cut whole", () => {
    const row = subAgentHeadRow(head, 20);
    expect(row).toBe("an-extremely-long…");
    expect(stringWidth(row)).toBeLessThanOrEqual(18);
  });

  test("a short type is not cut at all", () => {
    expect(subAgentHeadRow({ ...head, agentType: "explore" }, 60)).toBe(
      "explore · 7 tool uses · 12k",
    );
    expect(subAgentHeadRow({ ...head, agentType: "explore", toolUses: 1 }, 60)).toBe(
      "explore · 1 tool use · 12k",
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
      expect(view.rows).toEqual(["step 4", "step 5", "step 6", "step 7", "step 8"]);
      expect(view.hidden).toBe(3);
      expect(view.done?.stopReason).toBe(stopReason);
    }
  });

  // Review M3 / owner Q2: a child that did NOT finish cleanly says so on ONE
  // closing row. The decision is here, not in the renderer: it is a branch on
  // the stop reason, and `agent_task` returns no `isError` for these
  // (`packages/tools/src/task.ts:118-125`), so the tool row looks like a success.
  test("a non-clean end carries a closing row; a clean `end_turn` carries none", () => {
    const cancelled = subAgentView(
      sub({ activities: labels(3), done: true, stopReason: "cancelled" }),
    );
    expect(cancelled.done).toEqual({ stopReason: "cancelled", closing: "✗ cancelled" });
    const clean = subAgentView(sub({ activities: labels(3), done: true, stopReason: "end_turn" }));
    expect(clean.done).toEqual({ stopReason: "end_turn" });
    expect(clean.done?.closing).toBeUndefined();
  });

  test("every other non-clean reason closes with a row too (error, the iteration cap)", () => {
    for (const stopReason of ["error", "max_iterations"]) {
      expect(
        subAgentView(sub({ activities: labels(2), done: true, stopReason })).done?.closing,
      ).toBe(`✗ ${stopReason === "max_iterations" ? "iteration cap" : stopReason}`);
    }
  });

  // Owner default, awaiting confirmation (review N3): `max_iterations` is the
  // wire's identifier, not English, and it read beside a prose note.
  test("a capped end reads `✗ iteration cap`; an unmapped reason stays as the wire says", () => {
    expect(
      subAgentView(sub({ activities: labels(1), done: true, stopReason: "max_iterations" })).done
        ?.closing,
    ).toBe("✗ iteration cap");
    // No mapping, no invention: an unknown reason is printed as-is.
    expect(
      subAgentView(sub({ activities: labels(1), done: true, stopReason: "budget_exceeded" })).done
        ?.closing,
    ).toBe("✗ budget_exceeded");
  });

  test("a running child never carries a closing row", () => {
    expect(subAgentView(sub({ activities: labels(2) })).done).toBeNull();
  });

  test("a `done` with no recorded reason (unreachable from the wire) finishes with no closing row", () => {
    // Not "an older daemon's frame" (review L1): `AgentEvent.stopReason` is
    // required (`agent.ts:264-269`) and the client DROPS a `subagent_end`
    // without one (`client/src/mapping.ts:128-136`). Only a hand-built state
    // can reach this, and it must still draw a finished block.
    expect(subAgentView(sub({ activities: labels(2), done: true })).done).toEqual({});
  });
});

// Review N3: `agent_task` appends its own note to a non-clean child's result
// (`packages/tools/src/task.ts:118-122`), so the block printed the outcome twice —
// `└─ ✗ cancelled` and then `_(sub-agent cancelled)_`. The note stays in the tool
// result (the MODEL reads it); only the render drops it.
describe("subAgentReport: the outcome is said once", () => {
  test("drops the cancelled note and the blank line before it", () => {
    expect(subAgentReport("partial findings\n\n_(sub-agent cancelled)_", "cancelled")).toBe(
      "partial findings",
    );
  });

  test("drops the iteration-cap note too", () => {
    expect(subAgentReport("ran out\n\n_(sub-agent hit its iteration cap)_", "max_iterations")).toBe(
      "ran out",
    );
  });

  test("keeps the note when the reason does not carry it (an errored child)", () => {
    // `error` has no note of its own (`task.ts:119-122`), so nothing is dropped.
    expect(subAgentReport("boom\n\n_(sub-agent cancelled)_", "error")).toBe(
      "boom\n\n_(sub-agent cancelled)_",
    );
  });

  test("a note-shaped line the model wrote itself is NOT dropped unless it ends the report", () => {
    // Only the exact trailing note `agent_task` appends goes; a report that
    // merely mentions it keeps its text.
    expect(subAgentReport("it said _(sub-agent cancelled)_ and stopped", "cancelled")).toBe(
      "it said _(sub-agent cancelled)_ and stopped",
    );
    expect(subAgentReport("_(sub-agent cancelled)_\n\nbut then it continued", "cancelled")).toBe(
      "_(sub-agent cancelled)_\n\nbut then it continued",
    );
  });

  test("a report that is ONLY the note becomes empty (the closing row says it)", () => {
    expect(subAgentReport("_(sub-agent cancelled)_", "cancelled")).toBe("");
  });

  test("trailing newlines are gone; a clean end keeps its text verbatim", () => {
    expect(subAgentReport("The bug is in auth.ts.\n\n", "end_turn")).toBe("The bug is in auth.ts.");
    expect(subAgentReport("", "end_turn")).toBe("");
  });
});
