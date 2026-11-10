import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import chalk from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import * as wrapAnsiModule from "wrap-ansi";
import * as blink from "../src/blink.ts";
import * as format from "../src/format.ts";
import { expandTabs } from "../src/input-view.ts";
import * as markdown from "../src/markdown.ts";
import {
  type LaidItem,
  carryColor,
  itemLines,
  layoutTranscript,
  sliceLaid,
  toolTitle,
  transcriptLines,
  transcriptRows,
  warmRowsChunk,
  wrapLines,
} from "../src/render-lines.ts";
import type { DisplayItem, ToolItem } from "../src/state.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// The harness has no TTY, so chalk is off; the conceal bytes of the OFF phase
// are the property under test (same seam as `read-highlight.test.ts`).
const level = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

const opts = { expandAll: false };

describe("itemLines", () => {
  test("renders a user prompt with a prefix", () => {
    const lines = itemLines({ kind: "user", text: "do a thing" }, opts).map(strip);
    expect(lines[0]?.trimEnd()).toBe("› do a thing"); // the rest is the full-width pad
  });

  test("renders assistant markdown", () => {
    const lines = itemLines({ kind: "assistant", text: "hello **world**" }, opts).map(strip);
    expect(lines.join("\n")).toContain("hello");
    expect(lines.join("\n")).toContain("world");
  });

  test("skips an empty assistant item", () => {
    expect(itemLines({ kind: "assistant", text: "   " }, opts)).toEqual([]);
  });

  test("renders a tool diff with a friendly header, clean gutter and no meta noise", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "t1",
      name: "fs_write",
      args: '{"path":"a.txt"}',
      status: "ok",
      durationMs: 500,
      detail: {
        kind: "diff",
        path: "a.txt",
        patch:
          "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-old\n+new\n",
        added: 1,
        removed: 1,
      },
    };
    const text = itemLines(tool, opts).map(strip).join("\n");
    // Friendly header: action + target, not the raw JSON args.
    expect(text).toContain("Write a.txt");
    expect(text).not.toContain('{"path"');
    // Summary and coloured rows.
    expect(text).toContain("+1 -1");
    expect(text).toContain("+ new");
    expect(text).toContain("- old");
    // Unified-diff noise is stripped.
    expect(text).not.toContain("Index:");
    expect(text).not.toContain("@@");
    expect(text).not.toContain("+++");
    // Framed with a dashed rule top and bottom.
    expect(text).toContain("╌");
  });

  test("diff keeps context with line numbers and separates hunks with ⋯", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "t3",
      name: "fs_edit",
      args: '{"path":"m.ts"}',
      status: "ok",
      durationMs: 10,
      detail: {
        kind: "diff",
        path: "m.ts",
        patch: [
          "--- m.ts",
          "+++ m.ts",
          "@@ -1,2 +1,2 @@",
          " keep one",
          "-drop a",
          "+add a",
          "@@ -10,2 +10,2 @@",
          " keep two",
          "-drop b",
          "+add b",
          "",
        ].join("\n"),
        added: 2,
        removed: 2,
      },
    };
    const text = itemLines(tool, { expandAll: true, width: 60 }).map(strip);
    const joined = text.join("\n");
    // Context lines are preserved with their new-file line numbers.
    expect(joined).toContain("1   keep one");
    expect(joined).toContain("10   keep two");
    // The two hunks are separated by an ellipsis row.
    expect(text.some((l) => l.trim() === "⋯")).toBe(true);
    // Changed rows survive in full.
    expect(joined).toContain("+ add a");
    expect(joined).toContain("- drop b");
  });

  test("renders a sub-agent's nested activity tree and its report", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "t",
      name: "agent_task",
      args: '{"description":"find bug"}',
      status: "ok",
      durationMs: 5,
      resultText: "The bug is in auth.ts",
      sub: {
        agentType: "explore",
        description: "find bug",
        activities: ["Read auth.ts", "$ grep -n token"],
        toolUses: 2,
        tokens: 12_345,
        done: true,
      },
    };
    const text = itemLines(tool, { expandAll: true }).map(strip).join("\n");
    // The header keeps only label + elapsed when expanded: the primary target
    // (the description) is the first `  │ ` row under it (the command block,
    // docs/feat/tui-tool-expand.md) — NOT `Agent find bug` on one row any more.
    expect(text).toContain("  │ find bug");
    // Own tokens: a bare number, the session total's formatter (12345 → "12k").
    expect(text).toContain("explore · 2 tool uses · 12k"); // tree head
    expect(text).toContain("Read auth.ts");
    expect(text).toContain("$ grep -n token");
    expect(text).toContain("The bug is in auth.ts"); // report after the tree
  });

  // docs/feat/subagent-tail-view.md (eval A5, Opus L4 + mockup 1): a foreground
  // sub-agent shows the LAST steps, not the first ones. Mutation: render the whole
  // kept list (or `slice(0, n)`) → `step 1` reappears / `step 12` disappears.
  const STEPS_12 = Array.from({ length: 12 }, (_, i) => `Read f${i + 1}.ts`);
  const runningSub = (over: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool",
    id: "t",
    name: "agent_task",
    args: '{"description":"find callers of parseConfig","subagent_type":"explore"}',
    status: "running",
    sub: {
      agentType: "explore",
      description: "find callers of parseConfig",
      activities: STEPS_12,
      toolUses: 12,
      tokens: 12_400,
      done: false,
    },
    ...over,
  });
  const bodyOfWidth = (width: number, over: Partial<ToolItem> = {}): string[] =>
    itemLines(runningSub(over), { expandAll: false, width }).map((l) => strip(l).trimEnd());

  test("a running sub-agent at 80 columns shows its LAST five steps, and how many earlier", () => {
    const rows = bodyOfWidth(80);
    const joined = rows.join("\n");
    expect(joined).not.toContain("Read f1.ts"); // the first steps are the ones cut
    expect(joined).not.toContain("Read f7.ts");
    for (const i of [8, 9, 10, 11, 12]) {
      expect(joined).toContain(`Read f${i}.ts`);
    }
    expect(joined).toContain("… +7 earlier · ctrl+o to expand");
    // The head grammar is unchanged (type · uses · tokens).
    expect(joined).toContain("explore · 12 tool uses · 12k");
    // Running: it still closes with the bare ellipsis row (2-space body indent).
    expect(rows.at(-1)?.trim()).toBe("└─ …");
    // Newest LAST: the tail keeps the chronological order.
    const idx = (s: string): number => rows.findIndex((r) => r.includes(s));
    expect(idx("Read f8.ts")).toBeLessThan(idx("Read f12.ts"));
  });

  test("a finished sub-agent's tail closes on its last step instead of the ellipsis row", () => {
    const rows = itemLines(
      runningSub({
        status: "ok",
        durationMs: 5,
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          done: true,
          stopReason: "end_turn",
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    expect(rows.join("\n")).toContain("explore · 12 tool uses · 12k");
    expect(rows.at(-1)?.trim()).toBe("└─ Read f12.ts");
    expect(rows.map((r) => r.trim())).not.toContain("└─ …");
    expect(rows.join("\n")).toContain("… +7 earlier");
  });

  test("at 46 columns a long step is truncated by CELLS, never wrapped: no row over the width", () => {
    const WIDTH = 46;
    const long = runningSub({
      sub: {
        ...runningSub().sub,
        activities: [
          ...STEPS_12.slice(0, 11),
          "Read packages/config/src/a-very-long-directory-name/parse-config-schema.ts",
        ],
      } as NonNullable<ToolItem["sub"]>,
    });
    const rows = itemLines(long, { expandAll: false, width: WIDTH }).map((l) => strip(l).trimEnd());
    const joined = rows.join("\n");
    // The cut marker sits before the whole 3-cell prefix math can overflow.
    expect(joined).toContain("…");
    expect(joined).toContain("Read packages/config/src/a-very-long-di"); // kept up to the budget
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(WIDTH);
    }
    // Every one of the last five steps is still on its own row (the tail did not collapse).
    for (const i of [8, 9, 10, 11]) {
      expect(joined).toContain(`Read f${i}.ts`);
    }
    expect(joined).toContain("… +7 earlier");
    expect(joined).not.toContain("Read f7.ts");
  });

  test("the head row is cut to the width too, at 46 columns", () => {
    const wide = runningSub({
      sub: {
        ...runningSub().sub,
        agentType: "a-sub-agent-type-name-far-too-long-for-forty-six-columns",
        activities: STEPS_12,
      } as NonNullable<ToolItem["sub"]>,
    });
    const rows = itemLines(wide, { expandAll: false, width: 46 }).map((l) => strip(l).trimEnd());
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(46);
    }
    // Cut with the ellipsis, on the one row the head owns (never a wrapped second)
    // — and the TYPE is what gives way: the counts survive (review L4).
    expect(rows).toContain("⎿ ◆ a-sub-agent-type-na… · 12 tool uses · 12k");
    expect(rows.filter((r) => r.includes("a-sub-agent-type"))).toHaveLength(1);
  });

  test("a child with no step yet: the head and the `└─ …`, never a `… +0 earlier`", () => {
    const rows = itemLines(
      runningSub({
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          activities: [],
          toolUses: 0,
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    expect(rows.join("\n")).not.toContain("earlier");
    expect(rows.at(-1)?.trim()).toBe("└─ …");
    expect(rows.some((r) => r.includes("◆ explore · 0 tool uses"))).toBe(true);
  });

  test("fewer steps than the tail: all of them, no cut row", () => {
    const rows = itemLines(
      runningSub({
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          activities: ["Read a.ts", "Read b.ts"],
          toolUses: 2,
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    expect(rows.join("\n")).not.toContain("earlier");
    expect(rows.join("\n")).toContain("Read a.ts");
    expect(rows.join("\n")).toContain("Read b.ts");
  });

  test("Ctrl+O keeps the whole kept trail, for the one place that wants it", () => {
    const joined = itemLines(runningSub(), { expandAll: true, width: 80 })
      .map((l) => strip(l))
      .join("\n");
    expect(joined).toContain("Read f1.ts");
    expect(joined).toContain("Read f12.ts");
    expect(joined).not.toContain("earlier");
  });

  // Review M1: the head says `<n> tool uses` (the child's own counter) while the
  // cut row is derived from the LABELS state kept (capped at 50). 60 steps read
  // `60 tool uses` then `… +45 earlier` — a block contradicting itself.
  test("the cut row counts what the head counts, past the 50-label cap", () => {
    const sixty = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: Array.from({ length: 60 }, (_, i) => `Read f${i + 1}.ts`).slice(-50),
        toolUses: 60,
      },
    });
    const rows = itemLines(sixty, { expandAll: false, width: 80 }).map((l) => strip(l).trimEnd());
    const joined = rows.join("\n");
    expect(joined).toContain("explore · 60 tool uses");
    expect(joined).toContain("… +55 earlier");
    expect(joined).not.toContain("… +45 earlier");
    expect(joined).toContain("Read f60.ts");
  });

  // Review Q3 (owner-recommended default): one grammar with the existing
  // top-collapse, `… +N earlier · ctrl+o to expand`, and it fits at 46 columns.
  test("the cut row carries the ctrl+o hint, like every other cut marker", () => {
    const joined = bodyOfWidth(80).join("\n");
    expect(joined).toContain("… +7 earlier · ctrl+o to expand");
  });

  test("the cut row still fits at 46 columns (88 earlier steps is the widest count)", () => {
    const many = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: Array.from({ length: 93 }, (_, i) => `Read f${i + 1}.ts`).slice(-50),
        toolUses: 93,
      },
    });
    const rows = itemLines(many, { expandAll: false, width: 46 }).map((l) => strip(l).trimEnd());
    expect(rows.join("\n")).toContain("… +88 earlier · ctrl+o to expand");
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(46);
    }
  });

  // Review H1: a FINISHED child used to be cut by the generic body collapse
  // (`toolLines`' 8-row threshold), which hid the newest step, the closing row
  // and the report — two different cut markers in one block. The tree is exempt;
  // only the REPORT collapses.
  const finishedSub = (over: Partial<ToolItem> = {}): ToolItem =>
    runningSub({
      status: "ok",
      durationMs: 5,
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        done: true,
        stopReason: "end_turn",
      },
      ...over,
    });

  test("a finished child keeps its newest step and its closing row beside a report", () => {
    // Mutation (red, verified): let `plainToolBody`'s sub-agent body back into
    // the generic cut → `Read f12.ts` and `└─ Read f12.ts` disappear.
    const rows = itemLines(finishedSub({ resultText: "The bug is in auth.ts" }), {
      expandAll: false,
      width: 80,
    }).map((l) => strip(l).trimEnd());
    const joined = rows.join("\n");
    expect(joined).toContain("Read f12.ts");
    expect(rows).toContain("⎿ ◆ explore · 12 tool uses · 12k");
    expect(rows.some((r) => r.trim() === "└─ Read f12.ts")).toBe(true);
    expect(rows.some((r) => r.trim() === "└─ …")).toBe(false);
    // The report is there, one row, and it is the LAST row.
    expect(rows.at(-1)?.trim()).toBe("The bug is in auth.ts");
    // Two cut markers is the honest maximum, in ONE grammar pointing at ONE key:
    // the earlier-steps row (`… +7 earlier`) and, when the report is long, the
    // report's own (`… +N more lines`) — both opened by Ctrl+O. A SHORT report
    // adds none, so this block has only the earlier-steps one (review N4).
    expect(joined).not.toContain("more lines");
  });

  test("a long report still collapses, from the top, beside the whole tree", () => {
    const report = Array.from({ length: 12 }, (_, i) => `report line ${i + 1}`).join("\n");
    const rows = itemLines(finishedSub({ resultText: report }), {
      expandAll: false,
      width: 80,
    }).map((l) => strip(l).trimEnd());
    const joined = rows.join("\n");
    // The whole tree, both cut-free rows included.
    expect(joined).toContain("Read f8.ts");
    expect(rows.some((r) => r.trim() === "└─ Read f12.ts")).toBe(true);
    // The report's head, then its OWN cut row.
    expect(joined).toContain("report line 1");
    expect(joined).not.toContain("report line 12");
    expect(joined).toMatch(/… \+\d+ more lines · ctrl\+o to expand/);
    expect(joined).toContain("… +7 earlier");
  });

  // Review N1 (MEDIUM): the cut counted LOGICAL lines and a report is usually
  // paragraphs on single long lines, so 8 of them passed the 8-row threshold
  // uncut and the block rendered 49/65/81 rows at 80/60/46 columns — the newest
  // steps scrolled off the top, which is what this whole task exists to avoid.
  // Wrap to the body's width FIRST, then cut.
  test("a prose report is wrapped before it is cut: at most 8 report rows at any width", () => {
    const para = (i: number): string =>
      `Paragraph ${i}: ${"the parser reads the config once at startup and the watcher re-reads it on change, so ".repeat(4)}`;
    // 8 paragraphs: at the threshold (8) when counted as LOGICAL lines, so the
    // old code let all 8 through uncut and their wrapping pushed the block to
    // 49/65/81 rows at 80/60/46 columns.
    const report = Array.from({ length: 8 }, (_, i) => para(i + 1)).join("\n");
    for (const width of [200, 120, 80, 60, 46, 30]) {
      // The ROWS the terminal draws, not the logical lines: that is the observable.
      const rows = wrapLines(
        itemLines(finishedSub({ resultText: report }), { expandAll: false, width }),
        width,
      ).map((l) => strip(l).trimEnd());
      const blank = rows.findIndex((r) => r === "");
      expect(blank).toBeGreaterThan(0); // the tree, then the blank, then the report
      // THE property: the collapsed report costs at most `threshold` rows — the
      // preview plus its cut marker, or the whole report when it fits — whatever
      // the width. Counting logical lines made it width-dependent.
      const reportRows = rows.slice(blank + 1);
      expect(reportRows.length).toBeLessThanOrEqual(8);
      expect(reportRows[0]).toContain("Paragraph 1");
      if (reportRows.length > 7) {
        // 8 short enough rows fit the threshold whole; more than that is cut.
        expect(reportRows.length).toBe(8);
      } else {
        expect(reportRows.at(-1)).toMatch(/… \+\d+ more lines · ctrl\+o to expand/);
      }
      // The tree is still whole, and no row overflows the terminal.
      expect(rows.some((r) => r.trim() === "└─ Read f12.ts")).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(17);
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  // The bound the fix claims: the tree (at most 8 rows) + a blank + the report's
  // budget. A report that fits within `threshold` rows is shown WHOLE, so the
  // uncut case — not the long one — is the worst case: `threshold` rows.
  test("the worst case is a report that just fits the threshold, not a long one", () => {
    const exact = Array.from({ length: 8 }, (_, i) => `report line ${i + 1}`).join("\n");
    const rows = itemLines(finishedSub({ resultText: exact }), { expandAll: false, width: 80 }).map(
      (l) => strip(l).trimEnd(),
    );
    expect(rows.filter((r) => r.includes("report line")).length).toBe(8); // uncut
    expect(rows.length).toBeLessThanOrEqual(17);
  });

  // Review N2: under Ctrl+O a wrapped label restarted at column 0 and broke
  // mid-word, so the expanded view lost the tree's alignment.
  test("Ctrl+O: a wrapped label's continuation sits under its row, never at column 0", () => {
    const LONG = `$ bun test ${"packages/config/src/a-very-long-directory-name/".repeat(3)}`;
    const item = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: [LONG],
        toolUses: 1,
      },
    });
    const rows = wrapLines(itemLines(item, { expandAll: true, width: 46 }), 46).map((l) =>
      strip(l).trimEnd(),
    );
    const labelRows = rows.filter((r) => r.includes("packages/config/src"));
    expect(labelRows.length).toBeGreaterThan(1);
    // The first carries the tree's `├─ `; each continuation is indented to the
    // LABEL's column (2 body cells + the 3 of `├─ `), not to column 0.
    for (const [i, row] of labelRows.entries()) {
      expect(row.startsWith(i === 0 ? "  ├─ $ bun test" : "     ")).toBe(true);
    }
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(46);
    }
  });

  // The indent must not cost the wrapping its word boundaries: a label made of
  // WORDS folds between them, and every continuation is still indented.
  test("Ctrl+O: a word-wrapped label keeps its words whole and its indent", () => {
    const WORDS =
      "grep -rn callers of the parser in every package under packages/agent and packages/cli";
    const item = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: [WORDS],
        toolUses: 1,
      },
    });
    const rows = wrapLines(itemLines(item, { expandAll: true, width: 46 }), 46).map((l) =>
      strip(l).trimEnd(),
    );
    const step = rows.filter((r) => r.startsWith("  ├─") || r.startsWith("     "));
    expect(step.length).toBeGreaterThan(1);
    // Every word is intact: the rows rejoin to the original text.
    expect(step.map((r) => r.replace(/^\s*├─ |^\s{5}/, "")).join(" ")).toBe(WORDS);
    for (const row of step.slice(1)) {
      expect(row.startsWith("     ")).toBe(true);
    }
  });

  // Review N3: `agent_task` appends `_(sub-agent cancelled)_` to a cancelled
  // child's result (`tools/src/task.ts:118-122`), so the block said it twice —
  // `└─ ✗ cancelled` and then the note.
  test("a cancelled child says it ONCE: the note is dropped under `✗ cancelled`", () => {
    const cancelled = itemLines(
      finishedSub({
        resultText: "partial findings\n\n_(sub-agent cancelled)_",
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          done: true,
          stopReason: "cancelled",
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    expect(cancelled.filter((r) => r.includes("cancelled"))).toHaveLength(1);
    expect(cancelled.some((r) => r.trim() === "└─ ✗ cancelled")).toBe(true);
    expect(cancelled.join("\n")).toContain("partial findings");
  });

  // Owner default (awaiting confirmation): a raw `max_iterations` identifier is
  // not what a person watching reads. Mapped in the view-model, and its own note
  // goes the same way as `cancelled`'s.
  test("a capped child reads `└─ ✗ iteration cap`, and its note is not repeated", () => {
    const capped = itemLines(
      finishedSub({
        resultText: "ran out of budget\n\n_(sub-agent hit its iteration cap)_",
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          done: true,
          stopReason: "max_iterations",
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    expect(capped.some((r) => r.trim() === "└─ ✗ iteration cap")).toBe(true);
    expect(capped.join("\n")).not.toContain("max_iterations");
    expect(capped.join("\n")).not.toContain("hit its iteration cap");
    expect(capped.join("\n")).toContain("ran out of budget");
  });

  test("a spilled report drops the note too (the closing row already says it)", () => {
    const note = "_(sub-agent cancelled)_";
    const item = finishedSub({
      resultText: "report",
      spill: {
        chars: 40_800,
        path: "/tmp/o/x.txt",
        head: "partial findings",
        tail: `partial findings\n\n${note}`,
        omitted: 39_600,
      },
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        done: true,
        stopReason: "cancelled",
      },
    });
    const rows = itemLines(item, { expandAll: false, width: 80 }).map((l) => strip(l).trimEnd());
    expect(rows.some((r) => r.trim() === "└─ ✗ cancelled")).toBe(true);
    expect(rows.filter((r) => r.includes("cancelled"))).toHaveLength(1);
  });

  test("a 6-row tail: the exempt tree does not collapse (the trap if the constant grows)", () => {
    // The running block is 8 rows only by arithmetic (head + cut + 5 + `└─ …`
    // = the threshold). Pinning the finished case at a 6-row tree keeps that
    // from becoming a silent regression (review H1).
    const six = finishedSub({
      resultText: "ok",
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: STEPS_12.slice(-6),
        done: true,
        stopReason: "end_turn",
      },
    });
    const rows = itemLines(six, { expandAll: false, width: 80 }).map((l) => strip(l).trimEnd());
    expect(rows.join("\n")).not.toContain("more lines");
    expect(rows.some((r) => r.trim() === "└─ Read f12.ts")).toBe(true);
  });

  // Review M3 / Q2: `agent_task` returns no `isError` for a cancelled child, so
  // the tool row is `ok` and the block used to match a clean run character for
  // character. One closing row now says otherwise.
  test("a cancelled child closes with `└─ ✗ cancelled`, and keeps its tail", () => {
    const rows = itemLines(
      finishedSub({
        resultText: "partial",
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          done: true,
          stopReason: "cancelled",
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    const joined = rows.join("\n");
    expect(joined).toContain("Read f12.ts");
    expect(rows.some((r) => r.trim() === "└─ ✗ cancelled")).toBe(true);
    expect(rows.some((r) => r.trim() === "└─ Read f12.ts")).toBe(false);
  });

  test("an errored child closes the same way: `└─ ✗ error`", () => {
    const rows = itemLines(
      finishedSub({
        status: "error",
        resultText: "boom",
        sub: {
          ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
          done: true,
          stopReason: "error",
        },
      }),
      { expandAll: false, width: 80 },
    ).map((l) => strip(l).trimEnd());
    expect(rows.some((r) => r.trim() === "└─ ✗ error")).toBe(true);
  });

  test("a clean end is unchanged: the last step row closes the block", () => {
    const rows = itemLines(finishedSub({ resultText: "ok" }), { expandAll: false, width: 80 }).map(
      (l) => strip(l).trimEnd(),
    );
    expect(rows.some((r) => r.trim() === "└─ Read f12.ts")).toBe(true);
    expect(rows.join("\n")).not.toContain("✗");
  });

  // Review M2: Ctrl+O is the view documented as the escape hatch, and it used to
  // cut a long label anyway. Mutation (red, verified): drop the `expanded ?`
  // branch → the whole 170-cell label is gone.
  test("Ctrl+O shows a long label in full, wrapped, instead of cutting it", () => {
    const LONG = `$ bun test ${"packages/config/src/a-very-long-directory-name/".repeat(3)}`;
    const long = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: [LONG],
        toolUses: 1,
      },
    });
    const collapsed = itemLines(long, { expandAll: false, width: 46 }).map((l) => strip(l));
    expect(collapsed.join("\n")).not.toContain(LONG); // still cut when collapsed
    const expanded = itemLines(long, { expandAll: true, width: 80 }).map((l) => strip(l));
    // Wrapped across rows, so the label survives whole (minus the row prefixes).
    expect(expanded.map((r) => r.replace(/^\s*(?:│ )?/, "")).join(" ")).toContain("bun test");
    expect(expanded.join("").replace(/\s+/g, "")).toContain(LONG.replace(/\s+/g, "").slice(0, 150));
  });

  // Review L4: a long `subagent_type` cut the COUNTS (they sit to its right), so
  // `7 tool uses` vanished and only the type survived. Cut the type alone.
  test("a very long type leaves the counts on the head", () => {
    const wide = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        agentType: "an-extremely-long-sub-agent-type-name-that-goes-on-and-on-forever",
        activities: STEPS_12.slice(0, 7),
        toolUses: 7,
      },
    });
    for (const width of [80, 46]) {
      const rows = itemLines(wide, { expandAll: false, width }).map((l) => strip(l).trimEnd());
      const headRow = rows.find((r) => r.includes("◆")) ?? "";
      expect(headRow).toContain("7 tool uses");
      expect(headRow).toContain("12k");
      expect(headRow).toContain("…"); // the type is what got cut
      expect(headRow).not.toContain("forever");
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  // Review L2: a wide-character label through the block, at both widths.
  test("wide (CJK / emoji) labels are cut by CELLS, never over the width", () => {
    const wide = runningSub({
      sub: {
        ...(runningSub().sub as NonNullable<ToolItem["sub"]>),
        activities: [
          "Read 日本語のとても長いファイル名がここに続いています/設定スキーマ定義ファイル.ts",
          `$ echo ${"🎉".repeat(27)}`,
        ],
        toolUses: 2,
      },
    });
    for (const width of [80, 46]) {
      const rows = itemLines(wide, { expandAll: false, width }).map((l) => strip(l).trimEnd());
      expect(rows.join("\n")).toContain("Read 日本語");
      for (const row of rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  // Review L2: two sub-agents in one transcript keep their OWN rows and counts.
  test("two sub-agents in parallel: each block keeps its own steps and count", () => {
    const one: ToolItem = {
      kind: "tool",
      id: "a",
      name: "agent_task",
      args: '{"description":"scan the auth module"}',
      status: "ok",
      durationMs: 3,
      resultText: "a done",
      sub: {
        agentType: "explore",
        description: "scan the auth module",
        activities: Array.from({ length: 8 }, (_, i) => `Read a${(i + 1) * 2}.ts`),
        toolUses: 8,
        tokens: 0,
        done: true,
        stopReason: "end_turn",
      },
    };
    const two: ToolItem = {
      kind: "tool",
      id: "b",
      name: "agent_task",
      args: '{"description":"migrate tests to bun"}',
      status: "running",
      sub: {
        agentType: "general",
        description: "migrate tests to bun",
        activities: Array.from({ length: 6 }, (_, i) => `Edit b${i + 1}.ts`),
        toolUses: 6,
        tokens: 0,
        done: false,
      },
    };
    const rows = transcriptLines([one, two], { expandAll: false, width: 80 }).map((l) =>
      strip(l).trimEnd(),
    );
    const blockA = rows.slice(0, rows.indexOf(""));
    const blockB = rows.slice(rows.indexOf("") + 1);
    expect(blockA.join("\n")).not.toContain("Edit b");
    expect(blockA.join("\n")).toContain("8 tool uses");
    expect(blockA.join("\n")).toContain("… +3 earlier");
    expect(blockB.join("\n")).not.toContain("Read a");
    expect(blockB.join("\n")).toContain("6 tool uses");
    expect(blockB.join("\n")).toContain("… +1 earlier");
    expect(blockB.some((r) => r.trim() === "└─ …")).toBe(true);
  });

  test("tool header shows a friendly action label per tool", () => {
    const base = { kind: "tool" as const, status: "ok" as const, durationMs: 1 };
    const read = itemLines({ ...base, id: "r", name: "fs_read", args: '{"path":"x.ts"}' }, opts)[0];
    const bash = itemLines(
      { ...base, id: "b", name: "shell", args: '{"command":"ls -la"}' },
      opts,
    )[0];
    expect(strip(read ?? "")).toContain("Read x.ts");
    expect(strip(bash ?? "")).toContain("Bash ls -la");
  });
});

describe("tool-body collapse", () => {
  const bigTool: ToolItem = {
    kind: "tool",
    id: "t2",
    name: "shell",
    args: "{}",
    status: "ok",
    durationMs: 100,
    resultText: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
  };

  test("collapses a long body to a preview plus a hint", () => {
    const lines = itemLines(bigTool, opts).map(strip);
    // header + 6 preview + 1 hint
    expect(lines).toHaveLength(8);
    // Preview lines are the real content, one per row (regression: chalk.map).
    // The first output line carries the corner connector.
    expect(lines[1]?.trim()).toBe("⎿ line 1");
    expect(lines[6]?.trim()).toBe("line 6");
    expect(lines.at(-1)).toContain("+14 more lines");
    expect(lines.at(-1)).toContain("ctrl+o");
  });

  test("shows the full body when expanded", () => {
    const lines = itemLines(bigTool, { expandAll: true }).map(strip);
    // header + 20 body lines
    expect(lines).toHaveLength(21);
    expect(lines.join("\n")).toContain("line 20");
  });
});

describe("transcriptLines", () => {
  test("separates items with a blank line", () => {
    const lines = transcriptLines(
      [
        { kind: "user", text: "hi" },
        { kind: "assistant", text: "yo" },
      ],
      opts,
    ).map(strip);
    expect(lines[0]?.trimEnd()).toBe("› hi");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("yo");
  });
});

describe("wrapLines", () => {
  test("folds long lines to the display width and preserves blanks", () => {
    const rows = wrapLines(["", "abcdefghijklmnopqrstuvwxyz"], 10);
    expect(rows[0]).toBe("");
    for (const row of rows.slice(1)) {
      expect(strip(row).length).toBeLessThanOrEqual(10);
    }
    expect(rows.slice(1).map(strip).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  // The pre-fast-path implementation, kept as the reference.
  const reference = (lines: readonly string[], width: number): string[] =>
    lines.flatMap((line) =>
      line === ""
        ? [""]
        : carryColor(
            wrapAnsi(expandTabs(line), width, { hard: true, trim: false, wordWrap: true }).split(
              "\n",
            ),
          ),
    );

  const VARIED = [
    "",
    "plain text",
    "exactly ten",
    "exactly 10",
    "trailing spaces   ",
    "ten spaces         ",
    "\x1b[31mred\x1b[39m and \x1b[1mbold\x1b[22m",
    "\x1b[38;2;10;20;30mtruecolor, unclosed",
    "\x1b[38;2;10;20;30mtrue\x1b[39m",
    "\x1b[48;2;1;2;3m\x1b[38;2;4;5;6m 12 + bar \x1b[0m",
    "\x1b[42m  added bar line       \x1b[49m",
    "日本語のテキスト",
    "日本語のテキストです。",
    "emoji 👍🏽 and 🇮🇹 ok",
    "é decomposed (NFD)",
    "tab\there",
    "has\rcarriage",
    "two\nlogical\nlines",
    "crlf\r\nline",
    "a very long line that certainly does not fit in the narrow width at all",
    "\x1b]8;;http://x\x07link\x1b]8;;\x07 text",
  ];

  test("is identical to the reference wrap for lines that fit and lines that do not", () => {
    for (const width of [1, 5, 10, 11, 12, 20, 80]) {
      expect(wrapLines(VARIED, width)).toEqual(reference(VARIED, width));
    }
  });

  test("a line that fits is not handed to wrapAnsi; one that overflows is", () => {
    const spy = spyOn(wrapAnsiModule, "default");
    try {
      const fit = ["short", "\x1b[38;2;1;2;3mcolour\x1b[39m", "exactly 10", "日本語"];
      wrapLines(fit, 10);
      expect(spy.mock.calls.length).toBe(0);
      wrapLines(["this one is longer than ten columns"], 10);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a fitting line that wrapAnsi would rewrite still takes the full path", () => {
    const spy = spyOn(wrapAnsiModule, "default");
    try {
      wrapLines(["two\nlines", "é", "a\r\nb"], 40);
      expect(spy.mock.calls.length).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("transcriptRows", () => {
  // A representative transcript: a prompt, markdown that word-wraps, and a tool.
  const tool: ToolItem = {
    kind: "tool",
    id: "t1",
    name: "fs_read",
    args: '{"path":"src/App.tsx"}',
    status: "ok",
    durationMs: 500,
    resultText: "line one\nline two",
  };
  const items: DisplayItem[] = [
    { kind: "user", text: "explain the layout pipeline in detail please" },
    { kind: "assistant", text: "Here is **a long** reply that should wrap at a narrow width." },
    tool,
  ];
  const width = 24;

  test("matches the un-memoised wrapLines(transcriptLines(...)) layout", () => {
    const o = { expandAll: false, width };
    expect(transcriptRows(items, o)).toEqual(wrapLines(transcriptLines(items, o), width));
  });

  test("a resize (new width) re-lays-out rather than serving a stale cache", () => {
    const narrow = transcriptRows(items, { expandAll: false, width: 20 });
    const wide = transcriptRows(items, { expandAll: false, width: 80 });
    expect(narrow).not.toEqual(wide);
    expect(wide).toEqual(wrapLines(transcriptLines(items, { expandAll: false, width: 80 }), 80));
  });

  test("re-render re-lays-out only the item whose identity changed", () => {
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      const o = { expandAll: false, width };
      const settled: DisplayItem = { kind: "assistant", text: "settled reply" };
      // First paint: both assistant items are laid out (2 markdown renders).
      let turn: DisplayItem[] = [settled, { kind: "assistant", text: "streaming" }];
      transcriptRows(turn, o);
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(2);

      // Re-paint with the SAME objects (an unrelated flush): nothing re-renders.
      transcriptRows(turn, o);
      expect(spy.mock.calls.length).toBe(afterFirst);

      // A streaming delta replaces only the tail item (state.ts semantics):
      // exactly one more markdown render, the settled item stays cached.
      turn = [settled, { kind: "assistant", text: "streaming more" }];
      transcriptRows(turn, o);
      expect(spy.mock.calls.length).toBe(afterFirst + 1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a Ctrl+O (expandAll) toggle re-lays-out only tool items, not user/assistant", () => {
    // Only `tool` items collapse, so only their layout depends on expandAll.
    // Keying expand into every item's cache made a toggle needlessly re-render
    // the whole transcript; non-tool items must stay cached across the flip.
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      // First paint lays everything out (the assistant item renders markdown).
      transcriptRows(items, { expandAll: false, width });
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // Flip expandAll: the user/assistant items are unaffected by expand, so
      // they must be served from cache — zero additional markdown renders.
      transcriptRows(items, { expandAll: true, width });
      expect(spy.mock.calls.length).toBe(afterFirst);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("windowed layout (layoutTranscript + sliceLaid)", () => {
  const bigTool: ToolItem = {
    kind: "tool",
    id: "w",
    name: "shell",
    args: "{}",
    status: "ok",
    durationMs: 1,
    resultText: Array.from({ length: 12 }, (_, i) => `out ${i + 1}`).join("\n"),
  };
  const items: DisplayItem[] = [
    { kind: "user", text: "a prompt long enough to wrap at a narrow width right here" },
    {
      kind: "assistant",
      text: "**bold** reply with enough words to wrap across several rows at width 20",
    },
    bigTool,
    { kind: "assistant", text: "short tail" },
  ];
  const opts = { expandAll: true, width: 20 };

  test("total equals the full transcriptRows length", () => {
    expect(layoutTranscript(items, opts).total).toBe(transcriptRows(items, opts).length);
  });

  test("sliceLaid(s,e) equals transcriptRows(...).slice(s,e) for EVERY window", () => {
    const full = transcriptRows(items, opts);
    const { laid, total } = layoutTranscript(items, opts);
    expect(total).toBe(full.length);
    expect(total).toBeGreaterThan(4); // the transcript really does span many rows
    for (let s = 0; s <= total; s++) {
      for (let e = s; e <= total; e++) {
        expect(sliceLaid(laid, s, e)).toEqual(full.slice(s, e));
      }
    }
  });

  test("an all-blank transcript yields total 0 and an empty slice", () => {
    const blank: DisplayItem[] = [{ kind: "assistant", text: "   " }];
    const { laid, total } = layoutTranscript(blank, opts);
    expect(total).toBe(0);
    expect(sliceLaid(laid, 0, 10)).toEqual([]);
  });

  test("a window clamped past the end returns only the rows that exist", () => {
    const full = transcriptRows(items, opts);
    const { laid, total } = layoutTranscript(items, opts);
    expect(sliceLaid(laid, total - 2, total + 50)).toEqual(full.slice(total - 2));
  });
});

describe("two layout slots per item (Ctrl+O both ways)", () => {
  const body = Array.from({ length: 20 }, (_, i) => `result line ${i}`).join("\n");
  const mkTool = (id: string): ToolItem => ({
    kind: "tool",
    id,
    name: "shell",
    args: '{"command":"ls"}',
    status: "ok",
    durationMs: 500,
    resultText: body,
  });
  // `toolLines` calls formatDurationMs once per (re)layout of a finished tool.
  test("a second toggle in either direction lays nothing out again", () => {
    const items: DisplayItem[] = [mkTool("a"), mkTool("b")];
    const spy = spyOn(format, "formatDurationMs");
    try {
      const c = (expandAll: boolean) => layoutTranscript(items, { expandAll, width: 40 });
      const collapsed = c(false);
      const expanded = c(true);
      expect(spy.mock.calls.length).toBe(4); // 2 items × 2 views
      expect(expanded.total).toBeGreaterThan(collapsed.total);
      // Flip back and forth: all hits, same rows.
      expect(c(false).total).toBe(collapsed.total);
      expect(c(true).total).toBe(expanded.total);
      expect(c(false).laid[0]?.rows === collapsed.laid[0]?.rows).toBe(true); // same array
      expect(spy.mock.calls.length).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test("a width change invalidates both slots", () => {
    const items: DisplayItem[] = [mkTool("w")];
    const spy = spyOn(format, "formatDurationMs");
    try {
      layoutTranscript(items, { expandAll: false, width: 40 });
      layoutTranscript(items, { expandAll: true, width: 40 });
      expect(spy.mock.calls.length).toBe(2);
      layoutTranscript(items, { expandAll: true, width: 30 }); // new width
      expect(spy.mock.calls.length).toBe(3);
      layoutTranscript(items, { expandAll: false, width: 30 }); // old collapsed slot is gone
      expect(spy.mock.calls.length).toBe(4);
      layoutTranscript(items, { expandAll: true, width: 30 });
      layoutTranscript(items, { expandAll: false, width: 30 });
      expect(spy.mock.calls.length).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test("a changed threshold re-lays-out the collapsed view; rows stay correct", () => {
    const items: DisplayItem[] = [mkTool("t")];
    const a = layoutTranscript(items, { expandAll: false, width: 40, collapseThreshold: 8 });
    const b = layoutTranscript(items, { expandAll: false, width: 40, collapseThreshold: 50 });
    expect(b.total).toBeGreaterThan(a.total); // 20 lines now fit under the threshold
    const expected = wrapLines(
      itemLines(mkTool("t"), { expandAll: false, collapseThreshold: 50 }),
      40,
    );
    expect(b.laid[0]?.rows).toEqual(expected);
  });
});

describe("the running tool bullet's blink (docs/feat/tui-tool-blink.md)", () => {
  // A long transcript of settled items plus ONE running call: tick the shared
  // blink phase and only that call's row may change — and only it may be laid
  // out again. `settled` objects keep their identity across the two passes, as
  // `state.ts` does (it rebuilds only the item that changed).
  const running: ToolItem = {
    kind: "tool",
    id: "r",
    name: "shell",
    args: '{"command":"cp a b"}',
    status: "running",
  };
  const settledTools: DisplayItem[] = Array.from({ length: 6 }, (_, i) => ({
    kind: "tool" as const,
    id: `t${i}`,
    name: "shell",
    args: JSON.stringify({ command: `echo ${i}` }),
    status: "ok" as const,
    durationMs: 100,
    resultText: "out",
  }));
  const replies: DisplayItem[] = Array.from({ length: 6 }, (_, i) => ({
    kind: "assistant" as const,
    text: `reply ${i} with **enough** words to wrap at a narrow width right here`,
  }));
  const items: DisplayItem[] = [...replies, ...settledTools, running];

  const header = (laid: readonly LaidItem[]): string =>
    laid.find((l) => l.rows[0]?.includes("cp a b"))?.rows[0] ?? "";

  test("a running call blinks with the phase, and the rest of the row never moves", () => {
    // Mutation (red, verified): drop the phase swap entirely (`withPhase`
    // returns `rows`) → this test fails. A narrower OFF glyph alone does NOT
    // red it (the swap is after the wrap): that is the width-79 test's job.
    const on = transcriptRows(items, { expandAll: false, width: 24, blinkPhase: 0 });
    const off = transcriptRows(items, { expandAll: false, width: 24, blinkPhase: 500 });
    expect(on).toHaveLength(off.length); // same row count: nothing re-flows
    const onRow = strip(on.find((r) => r.includes("cp a b")) ?? "");
    const offRow = strip(off.find((r) => r.includes("cp a b")) ?? "");
    expect(onRow.startsWith("⏺ Bash")).toBe(true);
    // THE property that kills the bug (fix/tui-blink-off-width): with the SGR
    // stripped, the OFF row is BYTE-IDENTICAL to the ON row — the same glyph in
    // the same cells, so the label cannot sit one column off in any terminal.
    expect(offRow).toBe(onRow);
    // The label sits at the same DISPLAY COLUMN either way.
    expect(stringWidth(onRow.slice(0, onRow.indexOf("Bash")))).toBe(
      stringWidth(offRow.slice(0, offRow.indexOf("Bash"))),
    );
    expect(stringWidth(onRow)).toBe(stringWidth(offRow));
    // Non-vacuity: the RAW OFF row is not the ON row — the bullet really is
    // concealed there (a steady bullet would pass every assertion above).
    const rawOff = off.find((r) => r.includes("cp a b")) ?? "";
    const rawOn = on.find((r) => r.includes("cp a b")) ?? "";
    expect(rawOff).not.toBe(rawOn);
    expect(rawOff).toContain("\x1b[8m"); // the conceal opens…
    // …and closes BEFORE the label, so the label and elapsed stay visible.
    expect(rawOff.indexOf("\x1b[28m")).toBeLessThan(rawOff.indexOf("Bash"));
    expect(rawOff.indexOf(`\x1b[8m${blink.BULLET}`)).toBeGreaterThanOrEqual(0);
    // Nothing else in the transcript changed between the phases.
    expect(on.filter((r) => !r.includes("cp a b"))).toEqual(
      off.filter((r) => !r.includes("cp a b")),
    );
  });

  test("settled rows are not re-laid-out per tick: the cache still serves them", () => {
    // The exact property that keeps a long session cheap (AGENTS §2): a phase
    // tick must not re-wrap the settled/non-tool items.
    const o = { expandAll: false, width: 24, blinkPhase: 0 };
    const { laid: first } = layoutTranscript(items, o);
    const settledRows = first
      .filter((l) => !l.rows[0]?.includes("cp a b"))
      .map((l) => l.rows as readonly string[]);
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      const { laid: second } = layoutTranscript(items, { ...o, blinkPhase: 500 });
      // Zero markdown renders: every reply came from the cache.
      expect(spy.mock.calls.length).toBe(0);
      // The same array objects: settled items were not re-laid-out at all.
      const settledAgain = second
        .filter((l) => !l.rows[0]?.includes("cp a b"))
        .map((l) => l.rows as readonly string[]);
      expect(settledAgain).toHaveLength(settledRows.length);
      for (const [i, rows] of settledAgain.entries()) {
        // Object identity, not equality: a re-layout would produce a new array.
        expect(rows).toBe(settledRows[i] as readonly string[]);
      }
      // And the running row DID change, so the test is not vacuous.
      expect(header(first)).not.toBe(header(second));
    } finally {
      spy.mockRestore();
    }
  });

  test("at width 79 a long command's rows do not move between phases (finding 1)", () => {
    // The HIGH finding: the old OFF glyph `" "` was 1 column, so the row wrapped
    // differently ON vs OFF and the transcript jumped a row at 1 Hz. The OFF
    // phase now emits the SAME character, hidden, so no width function and no
    // terminal can disagree about it.
    expect(stringWidth(blink.toolBullet("running", 0))).toBe(2);
    expect(stringWidth(blink.toolBullet("running", 500))).toBe(2);
    expect(strip(blink.toolBullet("running", 500))).toBe(blink.BULLET);
    const long = {
      ...running,
      args: JSON.stringify({
        command:
          "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo item-$i-done-and-a-few-more-words; done > out.txt",
      }),
    };
    // Every width in the App's range, not just 79: the property is width-free.
    // Row 0 differs by the glyph only; every other row is byte-identical.
    for (const width of [22, 44, 45, 79, 80]) {
      const on = transcriptRows([{ ...long }], { expandAll: false, width, blinkPhase: 0 });
      const off = transcriptRows([{ ...long }], { expandAll: false, width, blinkPhase: 500 });
      expect([width, on.length]).toEqual([width, off.length]); // same row count
      expect(strip(on[0] ?? "").startsWith("⏺ Bash")).toBe(true);
      expect(off.map(strip)).toEqual(on.map(strip));
    }
    // Non-vacuity: the ON row really IS a wrapped row (the command's tail is
    // not on row 0), so the rows compared above could have differed. Before
    // the width-derived cut (docs/feat/tui-tool-expand.md) this test measured
    // the ROW COUNT instead; a long command now legitimately uses more of a
    // wide row (the last body bit can move up into a freed row), so the
    // property pinned here is the one that matters: the command is wrapped,
    // and no row moved between the phases.
    const wide = strip(
      transcriptRows([{ ...long }], { expandAll: false, width: 79, blinkPhase: 0 })[0] ?? "",
    );
    expect(wide).not.toContain("out.txt");
    expect(stringWidth(wide)).toBeLessThanOrEqual(79);
    const narrow = strip(
      transcriptRows([{ ...long }], { expandAll: false, width: 22, blinkPhase: 0 })[0] ?? "",
    );
    expect(narrow).not.toContain("out.txt");
  });

  test("a finished call is solid at every phase", () => {
    const done: DisplayItem[] = [
      { ...running, status: "ok", durationMs: 2000 },
      { ...running, status: "error", resultText: "boom" },
    ];
    for (const phase of [0, 500, 1000]) {
      // Fresh identities per phase: a settled item's rows are cached across
      // phases by design, so a phase value alone never reaches it. Cold items
      // prove the ASSERTION (the glyph is status-only), not the cache.
      const cold = done.map((i) => ({ ...i }) as DisplayItem);
      const rows = transcriptRows(cold, { expandAll: false, width: 24, blinkPhase: phase });
      for (const row of rows.filter((r) => r.includes("Bash"))) {
        expect(strip(row).startsWith("⏺ Bash")).toBe(true);
      }
    }
  });
});

describe("warmRowsChunk (non-blocking resize warm)", () => {
  // Fresh item identities → cache is cold regardless of width.
  const items: DisplayItem[] = Array.from({ length: 6 }, (_, i) => ({
    kind: "assistant" as const,
    text: `reply ${i} with **enough** words to wrap at a narrow width right here`,
  }));

  test("processes a bounded prefix within the budget and returns a resume index", () => {
    const next = warmRowsChunk(items, { expandAll: true, width: 24 }, 0, 0);
    // Budget 0 still makes progress (≥1 item) but does not do the whole lot.
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(items.length);
  });

  test("iterating to completion warms the transcript so the commit render is a no-op", () => {
    const o = { expandAll: true, width: 29 };
    let idx = 0;
    let guard = 0;
    while (idx < items.length && guard++ < 1000) {
      idx = warmRowsChunk(items, o, idx, 0);
    }
    expect(idx).toBe(items.length);
    // After warming, laying out at that width must do zero markdown renders —
    // i.e. the size-commit render pays ~nothing (no synchronous re-wrap freeze).
    const spy = spyOn(markdown, "renderMarkdown");
    try {
      layoutTranscript(items, o);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("toolTitle labels", () => {
  const tool = (name: string, args: string): ToolItem => ({
    kind: "tool",
    id: "t",
    name,
    args,
    status: "ok",
  });

  test("fs_multi_edit shows MultiEdit + path + edit count", () => {
    const item = tool("fs_multi_edit", '{"path":"a.ts","edits":[{},{}]}');
    expect(toolTitle(item)).toEqual({ label: "MultiEdit", subtitle: "a.ts · 2 edits" });
    expect(itemLines(item, opts).map(strip).join("\n")).toContain("MultiEdit a.ts · 2 edits");
  });

  test("fs_multi_edit with one edit uses the singular", () => {
    expect(toolTitle(tool("fs_multi_edit", '{"path":"a.ts","edits":[{}]}')).subtitle).toBe(
      "a.ts · 1 edit",
    );
  });

  test("fs_multi_edit with malformed args falls back to path alone, or empty", () => {
    expect(toolTitle(tool("fs_multi_edit", '{"path":"a.ts","edits":"x"}'))).toEqual({
      label: "MultiEdit",
      subtitle: "a.ts",
    });
    expect(toolTitle(tool("fs_multi_edit", "not json"))).toEqual({
      label: "MultiEdit",
      subtitle: "",
    });
  });

  test("shell_output / shell_kill show their label + job id", () => {
    expect(toolTitle(tool("shell_output", '{"job_id":"j1"}'))).toEqual({
      label: "BashOutput",
      subtitle: "j1",
    });
    expect(toolTitle(tool("shell_kill", '{"job_id":"j2"}'))).toEqual({
      label: "BashKill",
      subtitle: "j2",
    });
  });

  test("an unlabelled (MCP) tool keeps its name and raw args", () => {
    expect(toolTitle(tool("mcp__x__y", '{"q":1}'))).toEqual({
      label: "mcp__x__y",
      subtitle: '{"q":1}',
    });
  });
});

describe("hook annotation (H1)", () => {
  const blocked = (reason?: string): ToolItem => ({
    kind: "tool",
    id: "h1",
    name: "shell",
    args: JSON.stringify({ command: "rm -rf build" }),
    status: "error",
    resultText: `Blocked by a hook: \`shell\` was not run. Reason: ${reason ?? ""}`,
    durationMs: 1,
    hook: { action: "blocked", name: "no-rm", ...(reason !== undefined ? { reason } : {}) },
  });

  test("blocked with a reason: the ⎿ hook line, then only the reason (never the model-facing text)", () => {
    const lines = itemLines(blocked("rm -rf not allowed in this repo"), opts).map(strip);
    expect(lines.slice(1).map((l) => l.trim())).toEqual([
      "⎿ hook no-rm blocked Bash",
      "rm -rf not allowed in this repo",
    ]);
    expect(lines.join("\n")).not.toContain("Blocked by a hook");
  });

  test("blocked without a reason: only the ⎿ line", () => {
    expect(
      itemLines(blocked(), opts)
        .map(strip)
        .slice(1)
        .map((l) => l.trim()),
    ).toEqual(["⎿ hook no-rm blocked Bash"]);
  });

  test("a modified fs_edit: the ⎿ hook line, then still its diff", () => {
    const tool: ToolItem = {
      kind: "tool",
      id: "h2",
      name: "fs_edit",
      args: JSON.stringify({ path: "a.ts" }),
      status: "ok",
      resultText: "edited a.ts",
      detail: {
        kind: "diff",
        path: "a.ts",
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        added: 1,
        removed: 1,
      },
      durationMs: 1,
      hook: { action: "modified", name: "fmt" },
    };
    const lines = itemLines(tool, opts).map(strip);
    expect(lines[1]?.trim()).toBe("⎿ hook fmt modified Edit input");
    expect(lines.join("\n")).toContain("new");
    expect(lines.length).toBeGreaterThan(2);
  });
});

// docs/feat/tui-spill-note.md: a spilled result shows a short note + the head/tail
// preview from the structured spill — never the model's banner, never parsed.
// (Colours — syntax on fs_read, the error colour — are pinned in read-highlight.test.ts,
// which turns chalk on for the whole file: the highlighter caches its theme on first use.)
describe("a spilled tool result", () => {
  const PATH = ".tentacle/tool-output/fs_read-c1.txt";
  const code = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}; // line ${i}`).join(
    "\n",
  );
  const head = code.slice(0, 600);
  const tail = code.slice(code.length - 600);
  const banner = `[large fs_read output: full output (40800 chars) saved to ${PATH} — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]`;
  const spilled = (over: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool",
    id: "s1",
    name: "fs_read",
    args: JSON.stringify({ path: "src/a.ts" }),
    status: "ok",
    durationMs: 1,
    resultText: `${banner}\n${head}\n…[39600 characters omitted]…\n${tail}`,
    spill: { chars: 40_800, path: PATH, head, tail, omitted: 39_600 },
    ...over,
  });
  const NOTE = "40.8k chars · too large, the model reads it in parts";
  // The body's rows: the header (row 0) and any `  │ ` command row of an
  // expanded call (docs/feat/tui-tool-expand.md) are not body rows, so skip
  // them both — with `expandAll` the command is shown, and these tests are
  // about the spelling of the body itself.
  const body = (tool: ToolItem, o: Parameters<typeof itemLines>[1]) =>
    itemLines(tool, o)
      .filter((l) => !strip(l).startsWith("  │ ") && strip(l) !== "  │")
      .slice(1)
      .map((l) => strip(l).replace(/^(⎿ | {2})/, ""));

  test("collapsed: the note first, no banner, no path, the usual ctrl+o hint", () => {
    // Mutation (red, verified): render `resultText` instead of the spill view → fails.
    const lines = body(spilled(), opts);
    expect(lines[0]).toBe(NOTE);
    const text = lines.join("\n");
    expect(text).not.toContain("[large ");
    expect(text).not.toContain(PATH);
    expect(text).not.toContain("characters omitted");
    expect(lines.slice(1, 6)).toEqual(head.split("\n").slice(0, 5));
    expect(lines.at(-1)).toMatch(/^… \+\d+ more lines · ctrl\+o to expand$/);
  });

  test("expanded: note, saved to <path>, the head, the omitted line, the tail — in order", () => {
    const lines = body(spilled(), { expandAll: true });
    expect(lines).toEqual([
      NOTE,
      `saved to ${PATH}`,
      ...head.split("\n"),
      "… 39.6k chars omitted …",
      ...tail.split("\n"),
    ]);
  });

  test("in a pod: saved in the pod to <path>", () => {
    expect(body(spilled(), { expandAll: true, spillInPod: true })[1]).toBe(
      `saved in the pod to ${PATH}`,
    );
  });

  test("any tool that spills (shell), and the no-path note", () => {
    const { path: _p, ...noPath } = {
      chars: 40_800,
      path: PATH,
      head: "a\nb",
      tail: "y\nz",
      omitted: 39_600,
    };
    const shell = spilled({
      name: "shell",
      args: JSON.stringify({ command: "ls" }),
      spill: noPath,
    });
    expect(body(shell, { expandAll: true })).toEqual([
      "40.8k chars · too large, could not be saved — the model sees only this preview",
      "a",
      "b",
      "… 39.6k chars omitted …",
      "y",
      "z",
    ]);
  });

  test("a sub-agent whose report spilled: the tree, a blank row, then the spill view", () => {
    const sub = spilled({
      name: "agent_task",
      args: "{}",
      sub: {
        agentType: "explore",
        description: "d",
        activities: ["Read a.ts"],
        toolUses: 1,
        tokens: 0,
        done: true,
      },
      spill: { chars: 40_800, path: PATH, head: "report", tail: "end", omitted: 39_600 },
    });
    expect(body(sub, { expandAll: true })).toEqual([
      "◆ explore · 1 tool use",
      "└─ Read a.ts",
      "",
      NOTE,
      `saved to ${PATH}`,
      "report",
      "… 39.6k chars omitted …",
      "end",
    ]);
  });

  test("an older daemon (no spill field): the banner renders verbatim, nothing is derived from it", () => {
    const { spill: _s, ...older } = spilled({ name: "shell", args: "{}" });
    const lines = body(older, { expandAll: true });
    expect(lines[0]).toBe(banner);
    expect(lines).toContain("…[39600 characters omitted]…");
  });
});

describe("display cells: a tab or a wide char never makes a row overflow", () => {
  const WIDTH = 60;
  const o = { expandAll: true, width: WIDTH };
  const tool = (name: string, extra: Partial<ToolItem>): ToolItem => ({
    kind: "tool",
    id: name,
    name,
    args: "{}",
    status: "ok",
    durationMs: 1,
    ...extra,
  });
  const rowsOf = (item: DisplayItem, width = WIDTH): string[] =>
    wrapLines(itemLines(item, { ...o, width }), width).map(strip);
  const diffTool = (patch: string): ToolItem =>
    tool("fs_write", { detail: { kind: "diff", path: "p.go", added: 1, removed: 1, patch } });
  const isBar = (r: string): boolean => /^ +\d* [+-] /.test(r);

  const PATCH = [
    "@@ -1,3 +1,7 @@",
    "-\told := 1",
    "+\tnew := 1 // a",
    '+\t\t"strings"',
    "+中文中文中文",
    "+\u{1F600}\u{1F600}\u{1F600}",
    "+x\ty",
    " \tcontext\tline",
    "",
  ].join("\n");

  test("no rendered diff row contains a tab", () => {
    for (const w of [30, 60, 120]) {
      for (const r of rowsOf(diffTool(PATCH), w)) {
        expect(r).not.toContain("\t");
      }
    }
  });

  test("every bar row of one diff starts at the same column and has the same display width", () => {
    for (const w of [30, 60, 120]) {
      const bars = rowsOf(diffTool(PATCH), w).filter(isBar);
      expect(bars.length).toBe(6);
      // the +/- marker sits in the same column on every bar (a removed row has no number)
      expect(new Set(bars.map((r) => r.search(/[+-] /))).size).toBe(1);
      expect(new Set(bars.map((r) => stringWidth(r))).size).toBe(1);
      expect(stringWidth(bars[0] ?? "")).toBeLessThanOrEqual(w);
    }
  });

  test("a tab is shown as 4 spaces inside a bar", () => {
    const rows = rowsOf(diffTool("@@ -0,0 +1 @@\n+\tx\n"));
    expect(rows.some((r) => r.includes("+     x"))).toBe(true); // marker + space + 4 + x
  });

  test("a tab inside a word-diff pair keeps both bars aligned", () => {
    const rows = rowsOf(diffTool("@@ -1 +1 @@\n-\tfoo(a, b)\n+\tfoo(a, c)\n"));
    const bars = rows.filter(isBar);
    expect(bars.length).toBe(2);
    expect(new Set(bars.map((r) => stringWidth(r))).size).toBe(1);
    expect(bars.join("")).not.toContain("\t");
  });

  test("a word-diff pair with CJK and emoji renders bars of exactly width cells", () => {
    const rows = rowsOf(
      diffTool(
        "@@ -1,2 +1,2 @@\n-中文中文 foo \u{1F600}\u{1F600} end\n+中文中文 bar \u{1F600}\u{1F600} end\n",
      ),
    );
    const bars = rows.filter(isBar);
    expect(bars.length).toBe(2);
    for (const b of bars) {
      expect(stringWidth(b)).toBe(WIDTH - 1);
    }
  });

  const long = `func main() {\n\t${"word ".repeat(20)}\n}`;
  for (const [name, extra] of [
    ["fs_read", { args: '{"path":"m.txt"}', resultText: long }],
    ["shell", { args: '{"command":"cat m"}', resultText: long }],
  ] as const) {
    test(`${name} output with a long tabbed line has no tab and fits the width`, () => {
      const rows = rowsOf(tool(name, extra));
      for (const r of rows) {
        expect(r).not.toContain("\t");
        expect(stringWidth(r)).toBeLessThanOrEqual(WIDTH);
      }
    });
  }

  test("a user message with a tab has no tab and keeps its full-width row", () => {
    const rows = rowsOf({ kind: "user", text: "a\tb" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain("\t");
    expect(stringWidth(rows[0] ?? "")).toBe(WIDTH);
  });

  test("wrapLines never lets a tab through, and leaves ANSI intact", () => {
    expect(wrapLines(["a\tb", "\x1b[31mx\ty\x1b[39m"], 20)).toEqual([
      "a    b",
      "\x1b[31mx    y\x1b[39m",
    ]);
  });
});

describe("a tool call's command: width-derived cut, and per-call expansion", () => {
  // Owner 2026-10-30 (docs/feat/tui-tool-expand.md). The observable: the header
  // row is the whole command when it fits, never a fixed 72-char cut.
  const COMMAND =
    "cd . && go test ./internal/ui -run TestZZWebGapDeadBranches -count=1 -v -timeout 120s 2>&1 | tail -50";
  const longTool: ToolItem = {
    kind: "tool",
    id: "t1",
    name: "shell",
    args: JSON.stringify({ command: COMMAND }),
    status: "ok",
    durationMs: 1700,
    resultText: "ok",
  };
  /** The mockup's continuation prefix: 4 display columns. */
  const CONT = "  │ ";

  test("at 160 columns the whole command sits on the header row (no fixed 72 cut)", () => {
    // RED before the change: `truncate(subtitle, 72)` cut it to "… 1.7s" at a
    // 84-column header on a 160-column terminal (the Context repro).
    const rows = transcriptRows([longTool], { expandAll: false, width: 160 }).map(strip);
    expect(rows[0]).toContain(COMMAND);
    expect(rows[0]).toContain("1.7s");
    expect(rows).toHaveLength(2); // header + the "⎿ ok" body row, nothing else
    expect(stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(160);
  });

  test("a narrow terminal still cuts it, with an ellipsis, and one row", () => {
    const rows = transcriptRows([longTool], { expandAll: false, width: 40 }).map(strip);
    expect(rows[0]).toContain("…");
    expect(rows[0]).not.toContain("tail -50");
    expect(stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(40);
    // Exactly one header row: the cut never wraps the header.
    expect(rows.filter((r) => r.includes("Bash"))).toHaveLength(1);
  });

  test("a multi-line command collapses to ONE header row", () => {
    const multi: ToolItem = {
      ...longTool,
      args: JSON.stringify({ command: "make build\nmake test\nmake deploy" }),
    };
    const rows = transcriptRows([multi], { expandAll: false, width: 60 }).map(strip);
    expect(rows.filter((r) => r.includes("make"))).toHaveLength(1);
    expect(rows[0]).toContain("make build");
  });

  test("expanding ONE call shows its command wrapped under the header (mockup)", () => {
    const rows = transcriptRows([longTool], {
      expandAll: false,
      width: 40,
      expandedIds: ["t1"],
    }).map(strip);
    // The header keeps the bullet, the label and the elapsed time — no comment.
    expect(rows[0]).toContain("Bash");
    expect(rows[0]).toContain("1.7s");
    expect(rows[0]).not.toContain("TestZZ");
    // Then the full command as `  │ ` continuation rows, wrapped to the width.
    const cont = rows.slice(1).filter((r) => r.startsWith(CONT));
    expect(cont.length).toBeGreaterThan(1);
    const joined = cont
      .map((r) => r.slice(CONT.length))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(joined).toBe(COMMAND);
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(40);
    }
    // The body is untouched by the toggle (still the collapsed preview).
    expect(rows.at(-1)).toBe("⎿ ok");
  });

  test("expanding one call does not touch its BODY, Ctrl+O does both", () => {
    const big: ToolItem = {
      ...longTool,
      resultText: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
    };
    const one = transcriptRows([big], { expandAll: false, width: 60, expandedIds: ["t1"] }).map(
      strip,
    );
    expect(one.some((r) => r.includes("ctrl+o to expand"))).toBe(true); // body still collapsed
    const all = transcriptRows([big], { expandAll: true, width: 60 }).map(strip);
    expect(all.some((r) => r.includes("ctrl+o to expand"))).toBe(false); // body expanded
    expect(all.some((r) => r.includes("line 20"))).toBe(true);
  });

  test("Ctrl+O (expandAll) shows the full command of every call too (point 3)", () => {
    const second: ToolItem = {
      ...longTool,
      id: "t2",
      args: JSON.stringify({ command: `${COMMAND} | tail-second` }),
    };
    const rows = transcriptRows([longTool, second], { expandAll: true, width: 40 }).map(strip);
    // Both calls contribute continuation rows: two `⏺ Bash` headers, each
    // followed by at least one `  │ ` row, and both tails are visible.
    expect(rows.filter((r) => r.includes("Bash"))).toHaveLength(2);
    expect(rows.filter((r) => r.startsWith(CONT)).length).toBeGreaterThan(3);
    expect(rows.join("\n")).toContain("tail -50");
    expect(rows.join("\n")).toContain("tail-second");
  });

  test("an expanded call's multiline command keeps every line, indented", () => {
    const multi: ToolItem = {
      ...longTool,
      args: JSON.stringify({ command: "make build\nmake test\nmake deploy" }),
    };
    const rows = transcriptRows([multi], {
      expandAll: false,
      width: 60,
      expandedIds: ["t1"],
    }).map(strip);
    const cont = rows.filter((r) => r.startsWith(CONT)).map((r) => r.slice(CONT.length));
    expect(cont).toEqual(["make build", "make test", "make deploy"]);
  });

  test("a call with empty args has no continuation rows when expanded", () => {
    const empty: ToolItem = { ...longTool, name: "shell", args: "{}" };
    const rows = transcriptRows([empty], { expandAll: false, width: 60, expandedIds: ["t1"] }).map(
      strip,
    );
    expect(rows.some((r) => r.startsWith(CONT))).toBe(false);
    expect(rows[0]).toContain("Bash");
  });

  test("toggling one call re-lays-out only that item (point 6)", () => {
    const a: ToolItem = { ...longTool, id: "a" };
    const b: ToolItem = { ...longTool, id: "b", args: JSON.stringify({ command: `${COMMAND} b` }) };
    const reply: DisplayItem = { kind: "assistant", text: "some **reply** text that wraps here" };
    const items: DisplayItem[] = [reply, a, b];
    const o = { expandAll: false, width: 40 };
    layoutTranscript(items, o); // cold: the collapsed slot for every item
    const spy = spyOn(format, "formatDurationMs");
    try {
      const cold = layoutTranscript(items, { ...o, expandedIds: [] });
      expect(spy.mock.calls.length).toBe(0); // an empty set is the plain view
      const toggled = layoutTranscript(items, { ...o, expandedIds: ["b"] });
      // Exactly ONE re-layout: the toggled call. Its rows really changed…
      expect(spy.mock.calls.length).toBe(1);
      expect(toggled.total).toBeGreaterThan(cold.total);
      // …and every other item kept the very same row array (identity, not
      // equality: a re-layout would allocate a new one).
      const rowsAt = (l: LaidItem | undefined): readonly string[] => l?.rows ?? [];
      expect(rowsAt(toggled.laid[0])).toBe(rowsAt(cold.laid[0])); // the reply
      expect(rowsAt(toggled.laid[1])).toBe(rowsAt(cold.laid[1])); // call a
      expect(rowsAt(toggled.laid[2])).not.toBe(rowsAt(cold.laid[2])); // call b
      // Toggling back is a cache hit again, in both directions.
      const back = layoutTranscript(items, { ...o, expandedIds: [] });
      expect(spy.mock.calls.length).toBe(1);
      expect(rowsAt(back.laid[2])).toBe(rowsAt(cold.laid[2]));
      const again = layoutTranscript(items, { ...o, expandedIds: ["b"] });
      expect(spy.mock.calls.length).toBe(1);
      expect(rowsAt(again.laid[2])).toBe(rowsAt(toggled.laid[2]));
    } finally {
      spy.mockRestore();
    }
  });

  test("Ctrl+O and a per-call expansion are different slots of the same item", () => {
    // expandAll shows every command, so it subsumes the per-call set: flipping
    // expandAll off again must bring the single call's view straight back from
    // the cache, with no re-layout.
    const items: DisplayItem[] = [longTool];
    const o = { width: 40 };
    const rowsAt = (l: LaidItem | undefined): readonly string[] => l?.rows ?? [];
    const one = layoutTranscript(items, { ...o, expandAll: false, expandedIds: ["t1"] });
    layoutTranscript(items, { ...o, expandAll: true, expandedIds: ["t1"] }); // the all slot
    const spy = spyOn(format, "formatDurationMs");
    try {
      layoutTranscript(items, { ...o, expandAll: false, expandedIds: ["t1"] });
      expect(spy.mock.calls.length).toBe(0);
      const back = layoutTranscript(items, { ...o, expandAll: false, expandedIds: ["t1"] });
      expect(rowsAt(back.laid[0])).toBe(rowsAt(one.laid[0]));
    } finally {
      spy.mockRestore();
    }
  });

  test("the idle/resize WARM must warm the expanded-command view too", () => {
    // A width change warms the next render's slot. The warm's options must
    // therefore carry `expandedIds`: warming only the collapsed view leaves the
    // clicked call cold, and the COMMITTING render pays its re-layout (the
    // freeze the warm exists to avoid) — App passes it to both warms.
    const warmThenLayout = (warmOpts: Parameters<typeof layoutTranscript>[1]) => {
      const item: DisplayItem = { ...longTool }; // a fresh identity: cold cache
      const items: DisplayItem[] = [item];
      let idx = 0;
      while (idx < items.length) {
        idx = warmRowsChunk(items, warmOpts, idx, 0);
      }
      const spy = spyOn(format, "formatDurationMs");
      try {
        layoutTranscript(items, { expandAll: false, width: 40, expandedIds: ["t1"] });
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    // The warm that carries the set: the committing render is all hits.
    expect(warmThenLayout({ expandAll: false, width: 40, expandedIds: ["t1"] })).toBe(0);
    // Non-vacuity: WITHOUT it the same render re-lays-out the call.
    expect(warmThenLayout({ expandAll: false, width: 40 })).toBe(1);
  });

  test("an expanded RUNNING call still blinks and no row moves (point 7)", () => {
    const running: ToolItem = { ...longTool, status: "running", resultText: undefined };
    const on = transcriptRows([running], {
      expandAll: false,
      width: 40,
      blinkPhase: 0,
      expandedIds: ["t1"],
    });
    const off = transcriptRows([{ ...running }], {
      expandAll: false,
      width: 40,
      blinkPhase: 500,
      expandedIds: ["t1"],
    });
    expect(on).toHaveLength(off.length); // the continuation block does not re-flow
    expect(on.length).toBeGreaterThan(2); // it really is expanded + wrapped
    expect(strip(on[0] ?? "").startsWith("⏺ Bash")).toBe(true);
    expect(strip(off[0] ?? "")).toBe(strip(on[0] ?? "")); // same glyph, same cells
    expect(off[0] ?? "").toContain("\x1b[8m"); // and really concealed
    // Only the glyph differs; every continuation and body row is identical.
    expect(off.slice(1).map(strip)).toEqual(on.slice(1).map(strip));
    // The label sits at the same display column in both phases.
    const col = (row: string): number => {
      const plain = strip(row);
      return stringWidth(plain.slice(0, plain.indexOf("Bash")));
    };
    expect(col(off[0] ?? "")).toBe(col(on[0] ?? ""));
  });

  test("a width change re-wraps an expanded call at the new width", () => {
    const at40 = transcriptRows([longTool], {
      expandAll: false,
      width: 40,
      expandedIds: ["t1"],
    }).map(strip);
    const at80 = transcriptRows([longTool], {
      expandAll: false,
      width: 80,
      expandedIds: ["t1"],
    }).map(strip);
    expect(at40.filter((r) => r.startsWith(CONT)).length).toBeGreaterThan(
      at80.filter((r) => r.startsWith(CONT)).length,
    );
    for (const row of at80) {
      expect(stringWidth(row)).toBeLessThanOrEqual(80);
    }
    // Both still show the whole command.
    const text = (rows: string[]): string =>
      rows
        .filter((r) => r.startsWith(CONT))
        .map((r) => r.slice(CONT.length))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    expect(text(at40)).toBe(COMMAND);
    expect(text(at80)).toBe(COMMAND);
  });
});

// docs/feat/subagent-detach.md T29: a child that MOVED to the background closes
// with a SUBTLE row (`→ background as sa-1 · its report will arrive later`),
// never `✗ background`, and shows no report body of its own: its report arrives
// later as the ordinary `[background]` note, which is its own item.
describe("T29: a moved sub-agent block", () => {
  const movedSub = (over: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool",
    id: "t",
    name: "agent_task",
    args: '{"description":"find callers of parseConfig","subagent_type":"explore"}',
    status: "ok",
    durationMs: 3,
    // The tool's own result: the moved-to-background text, never a report.
    resultText:
      "moved to background as sa-1: find callers of parseConfig. Its report will arrive later as a [background] note; you can keep working or end your turn.",
    sub: {
      agentType: "explore",
      description: "find callers of parseConfig",
      activities: Array.from({ length: 3 }, (_, i) => `Read f${i + 1}.ts`),
      toolUses: 3,
      tokens: 1200,
      done: true,
      stopReason: "background",
      movedTo: "sa-1",
    },
    ...over,
  });

  test("shows the closing row and NO report body", () => {
    const rows = itemLines(movedSub(), { expandAll: false, width: 80 }).map((l) =>
      strip(l).trimEnd(),
    );
    const joined = rows.join("\n");
    // The row says where the work went…
    expect(
      rows.some((r) => r.trim() === "└─ → background as sa-1 · its report will arrive later"),
    ).toBe(true);
    // …and it is never a failure.
    expect(joined).not.toContain("✗");
    // No report body: the tool's own text is the row's job now, and the real
    // report arrives later as its own `[background]` notice.
    expect(joined).not.toContain("moved to background as sa-1: find callers");
    // Its tail is still there (the person can see what it did before moving).
    expect(joined).toContain("Read f3.ts");
  });

  test("at a narrow width the row is cut, not wrapped into a failure", () => {
    const rows = itemLines(movedSub(), { expandAll: false, width: 40 }).map((l) =>
      strip(l).trimEnd(),
    );
    expect(rows.join("\n")).not.toContain("✗");
    expect(rows.some((r) => r.includes("→ background"))).toBe(true);
  });
});
