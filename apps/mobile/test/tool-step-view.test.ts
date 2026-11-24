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

describe("stepRowView: a FILE tool's body (docs/feat/mobile-file-view.md)", () => {
  const editRow = (extra: Partial<ToolRow> = {}): ToolRow =>
    tool("t", "ok", {
      name: "fs_edit",
      label: "Edit",
      args: '{"path":"src/app.ts"}',
      output: "edited src/app.ts (+2 -1)",
      diff: {
        kind: "diff",
        path: "src/app.ts",
        patch: [
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -40,2 +40,3 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "+const c = 4;",
        ].join("\n"),
        added: 2,
        removed: 1,
      },
      ...extra,
    });

  test("a file step carries its coloured body and NO raw result line", () => {
    const v = stepRowView(editRow(), null, false);
    expect(v.file?.header).toBe("lines 40–42 · TypeScript");
    // The body is the file's content, not the tool's result text: `edited …`
    // and the repeated `+2 -1` are gone (owner: the row says them once).
    expect(v.command).toEqual([]);
    expect(v.output).toBe(null);
    expect(v.file?.lines.length).toBe(4);
  });

  test("a file step is still tappable (the body opens on tap)", () => {
    expect(stepRowView(editRow(), null, false).tappable).toBe(true);
  });

  test("`full` reaches the file body's preview", () => {
    const many = Array.from({ length: 30 }, (_, at) => `const a${at} = 1;`);
    const row = tool("t", "ok", {
      name: "fs_read",
      label: "Read",
      args: '{"path":"src/big.ts"}',
      output: many.join("\n"),
    });
    expect(stepRowView(row, null, false).file?.hidden).toBe(18);
    expect(stepRowView(row, null, true).file?.hidden).toBe(0);
  });

  test("a non-file tool has no file body (nothing else changes)", () => {
    const v = stepRowView(tool("t", "ok", { output: "hi" }), null, false);
    expect(v.file).toBeUndefined();
    expect(v.output?.text).toBe("hi");
  });

  test("a FAILED file step keeps today's output, no body", () => {
    const v = stepRowView(
      editRow({ status: "error", output: "old_string not found in src/app.ts" }),
      null,
      false,
    );
    expect(v.file).toBeUndefined();
    expect(v.output?.text).toBe("old_string not found in src/app.ts");
  });
});

describe("stepRowView: one step's line and body", () => {
  test("a finished shell step: green dot, its command, the duration, the cut output, no ⎿", () => {
    const out = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
    const v = stepRowView(tool("t", "ok", { durationMs: 14, output: out }), "why", false);
    expect(v.name).toEqual({ tool: "Bash" });
    expect(v.subtitle).toBe("ls -la polpo-page.png");
    expect(v.dot).toBe("ok");
    expect(v.trailing).toBe("14 ms");
    expect(v.trailingRed).toBe(false);
    expect(v.live).toBe(false);
    // docs/fix/mobile-running-row.md (owner 21/11): the body is the command and
    // the result — never the reasoning folded into the step.
    expect("thought" in v).toBe(false);
    // The command appears ONCE (decision 5): on the `$` line when it is drawn,
    // else in the body — where it is the only place the command can be read.
    const multi = stepRowView(
      tool("m", "ok", {
        args: JSON.stringify({ command: "cd x\nbun test", description: "Go" }),
      }),
      null,
      false,
    );
    expect(multi.subline).toBe("$ cd x…");
    // The line shows the FIRST line only: the body keeps the whole command, so a
    // multi-line call still reads in full in one place.
    expect(multi.command).toEqual(["cd x", "bun test"]);
    // A plain shell row (no sentence): its subtitle IS the command, so the body
    // does not say it a second time.
    expect(v.subtitle).toBe("ls -la polpo-page.png");
    expect(v.command).toEqual([]);
    expect(v.output).toEqual({
      text: ["line 4", "line 5", "line 6", "line 7", "line 8", "line 9"].join("\n"),
      hidden: 3,
    });
    expect(v.tappable).toBe(true);
    expect(v.a11yLabel).toBe(
      "Bash, ls -la polpo-page.png, succeeded, 14 milliseconds, thought first",
    );
  });

  test("`full` shows every line; an error is red on the dot and the trailing text, NOT the result", () => {
    const out = Array.from({ length: 9 }, (_, i) => `e${i}`).join("\n");
    const v = stepRowView(tool("t", "error", { output: out, durationMs: 1300 }), null, true);
    expect(v.dot).toBe("error");
    expect(v.trailingRed).toBe(true);
    expect(v.output?.hidden).toBe(0);
    expect(v.output).not.toHaveProperty("error");
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

describe("the tap detail carries NO reasoning, for every tool (owner 21/11, docs/fix/mobile-running-row.md)", () => {
  const REASONING = "I should check the resolver latency first";
  const rows: readonly [string, ToolRow][] = [
    ["a shell call", tool("t", "ok", { output: "a\nb", durationMs: 5 })],
    [
      "a described shell call",
      tool("t", "ok", {
        args: JSON.stringify({ command: "dig +short a.example", description: "Test DNS" }),
        output: "exit=0\n1.2.3.4",
      }),
    ],
    [
      "a running described shell call",
      tool("t", "running", {
        args: JSON.stringify({ command: "sleep 9", description: "Test DNS" }),
        at: 5,
      }),
    ],
    [
      "a file read",
      tool("t", "ok", { name: "fs_read", label: "Read", args: '{"path":"a.txt"}', output: "x" }),
    ],
    [
      "an MCP tool",
      tool("t", "error", { name: "mcp__demo__browser_resize", label: "", args: '{"width":4}' }),
    ],
  ];
  for (const [what, row] of rows) {
    for (const compact of [false, true]) {
      test(`${what} (compactShell ${compact ? "on" : "off"}): the view says nothing of the thought`, () => {
        const v = stepRowView(row, REASONING, false, true, compact);
        expect(JSON.stringify(v)).not.toContain(REASONING);
        expect("thought" in v).toBe(false);
      });
    }
  }

  test("a thought alone does not make a step tappable (its body would be empty)", () => {
    const v = stepRowView(
      tool("t", "ok", { name: "shell_output", args: '{"id":"j1"}' }),
      REASONING,
      false,
    );
    expect(v.tappable).toBe(false);
  });

  test("VoiceOver still says a thought came first (a fact, not the reasoning)", () => {
    const v = stepRowView(tool("t", "ok", { durationMs: 14 }), REASONING, false);
    expect(v.a11yLabel).toContain("thought first");
    expect(v.a11yLabel).not.toContain(REASONING);
  });
});

describe("thoughtRowView / thinkingA11yLabel", () => {
  test("an orphan thought reads `Thought · N s`, not expandable (thought-placeholder)", () => {
    expect(thoughtRowView({ ms: 12_900 })).toEqual({
      subtitle: "· 12 s",
      expandable: false,
      a11yLabel: "Thought for 12 seconds. The thinking itself is not kept.",
    });
    expect(thoughtRowView({ ms: 400 }).subtitle).toBe("· <1 s");
    expect(thoughtRowView({ ms: 400 }).a11yLabel).toBe(
      "Thought for under a second. The thinking itself is not kept.",
    );
    expect(thoughtRowView({ ms: 1000 }).a11yLabel).toContain("for 1 second.");
    expect(thoughtRowView({ ms: 125_000 })).toMatchObject({
      subtitle: "· 2 min 5 s",
      a11yLabel: "Thought for 2 minutes 5 seconds. The thinking itself is not kept.",
    });
    // Not measured (a fold with no clock): the word alone, never a guessed time.
    expect(thoughtRowView({ ms: undefined })).toEqual({
      subtitle: "",
      expandable: false,
      a11yLabel: "Thought. The thinking itself is not kept.",
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
    expect(cells.get("r")).toMatchObject({ kind: "thought", ms: undefined });
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
