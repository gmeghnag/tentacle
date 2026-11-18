/**
 * S2 of docs/feat/mobile-tool-rows.md: what ONE step node is told to draw
 * (`stepRowView`, `thoughtRowView`, the footer's `thinkingA11yLabel`, the live
 * clock `liveElapsed`) and the `isBlock` rows (a chart, an artifact card) that
 * end a thread. Pure, so `StepNode.tsx` only maps these to elements (AGENTS §7).
 */
import { describe, expect, test } from "bun:test";
import {
  isBlockRow,
  stepLayout,
  stepRowView,
  thinkingA11yLabel,
  thoughtRowView,
} from "../src/tool-steps.ts";
import { liveElapsed } from "../src/tool-summary.ts";
import type { Row, ToolRow, ToolStatus } from "../src/transcript-rows.ts";

const think = (key: string, t = `thinking ${key}`): Row => ({
  kind: "reasoning",
  key,
  text: t,
  version: t.length,
});
const tool = (key: string, status: ToolStatus = "ok", extra: Partial<ToolRow> = {}): ToolRow => ({
  kind: "tool",
  key,
  id: key,
  name: "shell",
  label: "Bash",
  args: '{"command":"ls -la polpo-page.png"}',
  status,
  ...extra,
});

describe("stepRowView: one step's line and body", () => {
  test("a finished shell step: green dot, its command, the duration, the cut output with ⎿", () => {
    const out = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
    const v = stepRowView(tool("t", "ok", { durationMs: 14, output: out }), "why", false);
    expect(v.name).toEqual({ tool: "Bash" });
    expect(v.subtitle).toBe("ls -la polpo-page.png");
    expect(v.dot).toBe("ok");
    expect(v.trailing).toBe("14 ms");
    expect(v.trailingRed).toBe(false);
    expect(v.live).toBe(false);
    expect(v.thought).toBe("why");
    expect(v.command).toEqual(["ls -la polpo-page.png"]);
    expect(v.output).toEqual({
      text: ["⎿ line 1", "  line 2", "  line 3", "  line 4", "  line 5", "  line 6"].join("\n"),
      hidden: 3,
      error: false,
    });
    expect(v.tappable).toBe(true);
    expect(v.a11yLabel).toBe(
      "Bash, ls -la polpo-page.png, succeeded, 14 milliseconds, thought first",
    );
  });

  test("`full` shows every line; an error is red on the dot, the trailing text and the result", () => {
    const out = Array.from({ length: 9 }, (_, i) => `e${i}`).join("\n");
    const v = stepRowView(tool("t", "error", { output: out, durationMs: 1300 }), null, true);
    expect(v.dot).toBe("error");
    expect(v.trailingRed).toBe(true);
    expect(v.output?.hidden).toBe(0);
    expect(v.output?.error).toBe(true);
    expect(v.output?.text.split("\n")).toHaveLength(9);
  });

  test("denied: red, `denied` trailing, the reply makes it tappable", () => {
    const v = stepRowView(
      tool("t", "denied", { name: "shell_output", args: '{"id":"j1"}', denialReply: "no" }),
      null,
      false,
    );
    expect(v.dot).toBe("error");
    expect(v.trailing).toBe("denied");
    expect(v.trailingRed).toBe(true);
    expect(v.command).toEqual([]);
    expect(v.output).toBeNull();
    expect(v.tappable).toBe(true);
  });

  test("nothing to open (no thought, command, output, diff or reply) → not tappable", () => {
    const v = stepRowView(
      tool("t", "ok", { name: "shell_output", args: '{"id":"j1"}' }),
      null,
      false,
    );
    expect(v.tappable).toBe(false);
  });

  test("a diff alone makes the step tappable (the diff lives in the body, Owner Q7)", () => {
    const v = stepRowView(
      tool("t", "ok", {
        name: "shell_output",
        args: '{"id":"j1"}',
        diff: { added: 1, removed: 0 } as ToolRow["diff"],
      }),
      null,
      false,
    );
    expect(v.tappable).toBe(true);
    expect(v.trailing).toBe("+1 −0");
  });

  test("running: a spinner, and a live clock only when the row knows when it started", () => {
    expect(stepRowView(tool("t", "running", { at: 5 }), null, false)).toMatchObject({
      dot: "running",
      live: true,
      trailing: "",
    });
    expect(stepRowView(tool("t", "running"), null, false).live).toBe(false);
    expect(stepRowView(tool("t", "queued", { at: 5 }), null, false)).toMatchObject({
      dot: "queued",
      live: false,
    });
  });

  test("a finished sub-agent stops the spinner before its result lands", () => {
    const v = stepRowView(
      tool("t", "running", { at: 5, sub: { done: true } as ToolRow["sub"] }),
      null,
      false,
    );
    expect(v.dot).toBe("ok");
    expect(v.live).toBe(false);
  });

  test("an MCP step: server split off, flattened args, never raw JSON", () => {
    const v = stepRowView(
      tool("t", "ok", {
        name: "mcp__playwright__browser_resize",
        label: "mcp__playwright__browser_resize",
        args: '{"width":430,"height":932}',
      }),
      null,
      false,
    );
    expect(v.name).toEqual({ server: "playwright", tool: "browser_resize" });
    expect(v.subtitle).toBe("430 × 932");
    expect(v.command).toEqual(["width  430", "height  932"]);
  });
});

describe("thoughtRowView / thinkingA11yLabel", () => {
  test("an orphan thought reads its first non-empty line", () => {
    expect(thoughtRowView("\n  first idea  \nsecond")).toEqual({
      subtitle: "first idea",
      a11yLabel: "Thought, first idea",
    });
  });

  test("the footer reads its seconds once there is one", () => {
    expect(thinkingA11yLabel(400)).toBe("Thinking");
    expect(thinkingA11yLabel(1000)).toBe("Thinking, 1 second");
    expect(thinkingA11yLabel(12_900)).toBe("Thinking, 12 seconds");
    expect(thinkingA11yLabel(125_000)).toBe("Thinking, 2 minutes 5 seconds");
  });
});

describe("liveElapsed: a clock that ticks once a second", () => {
  test("nothing under a second, then whole seconds, then minutes", () => {
    expect(liveElapsed(999)).toBe("");
    expect(liveElapsed(-5)).toBe("");
    expect(liveElapsed(1000)).toBe("1 s");
    expect(liveElapsed(59_999)).toBe("59 s");
    expect(liveElapsed(125_400)).toBe("2 min 5 s");
  });
});

describe("isBlock: a row drawn as a block (chart, artifact card) ends the thread", () => {
  const chart = (key: string): ToolRow => tool(key, "ok", { name: "chart" });
  const isChart = (row: ToolRow): boolean => row.name === "chart";

  test("tool, chart, tool → two single-node runs; the chart is drawn as today", () => {
    const { cells } = stepLayout([tool("a"), chart("c"), tool("b")], false, isChart);
    expect(cells.has("c")).toBe(false);
    expect(cells.get("a")).toMatchObject({ thread: { up: false, down: false } });
    expect(cells.get("b")).toMatchObject({ thread: { up: false, down: false } });
  });

  test("a thought before a block does not fold into it: it is a Thought node", () => {
    const { cells } = stepLayout([think("r"), chart("c")], false, isChart);
    expect(cells.get("r")).toMatchObject({ kind: "thought", text: "thinking r" });
    expect(cells.has("c")).toBe(false);
  });

  test("thinking after a block: the tail shows, and does not join a thread", () => {
    const { tail } = stepLayout([tool("a"), chart("c")], true, isChart);
    expect(tail).toEqual({ thought: "", up: false });
  });

  test("isBlockRow: a valid chart and a presented artifact are blocks; anything else a step", () => {
    const spec = JSON.stringify({
      type: "bar",
      title: "t",
      labels: ["a", "b"],
      datasets: [{ label: "x", data: [1, 2] }],
    });
    expect(isBlockRow(tool("c", "ok", { name: "chart", args: spec }))).toBe(true);
    // A forged spec or a failed chart call keeps the generic tool row: a step.
    expect(isBlockRow(tool("c", "ok", { name: "chart", args: "{}" }))).toBe(false);
    expect(isBlockRow(tool("c", "error", { name: "chart", args: spec }))).toBe(false);
    expect(
      isBlockRow(tool("p", "ok", { name: "present", artifact: {} as ToolRow["artifact"] })),
    ).toBe(true);
    expect(isBlockRow(tool("t"))).toBe(false);
  });

  test("no predicate: a chart is a step like any tool (S1 behaviour)", () => {
    const { cells } = stepLayout([tool("a"), chart("c")], false);
    expect(cells.get("c")).toMatchObject({ kind: "step" });
  });
});
