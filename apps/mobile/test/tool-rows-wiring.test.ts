/**
 * S2 of docs/feat/mobile-tool-rows.md — the component half. The decisions are
 * pure and tested in `tool-steps.test.ts` / `tool-step-view.test.ts`; these files
 * import React Native, so their wiring is pinned as SOURCE (the
 * `session-screen-follow-wiring.test.ts` pattern).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), "utf8");

/** The body of `function <name>(` up to the next top-level `function`. */
const fnBody = (src: string, name: string): string => {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};

describe("SessionScreen: one layout, the open state, the footer", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("the layout is memoised on the rows and the running flag", () => {
    expect(src).toMatch(
      /useMemo\(\s*\(\) => stepLayout\(rows, running, isBlockRow\),\s*\[rows, running\]/,
    );
  });

  test("renderItem reads the row's cell, and a hidden cell is null BEFORE SwipeTime wraps it", () => {
    expect(src).toContain("layout.cells.get(item.key)");
    expect(src).toMatch(/cell\?\.kind === "hidden"\)\s*\{?\s*return null;[\s\S]*<SwipeTime/);
  });

  test("the open and show-all sets live in the screen and reach every cell through extraData", () => {
    expect(src).toMatch(/useState<readonly string\[\]>\(\[\]\)/);
    expect(src).toMatch(
      /rowExtraData = useMemo\([\s\S]{0,400}openSteps[\s\S]{0,200}fullSteps[\s\S]{0,200}layout/,
    );
    expect(src).toContain("toggleOpen(");
  });

  test("the footer is the live tail, drawn only when there is one", () => {
    expect(src).toMatch(
      /ListFooterComponent=\{\s*layout\.tail === null \? undefined : \(\s*<ThinkingNode/,
    );
  });

  test("the footer node gets the tail's thought and its up segment (Review S2 #1)", () => {
    const footer = src.slice(src.indexOf("<ThinkingNode"));
    expect(footer).toMatch(/^<ThinkingNode[^>]*thought=\{layout\.tail\.thought\}/);
    expect(footer).toMatch(/^<ThinkingNode[^>]*up=\{layout\.tail\.up\}/);
  });

  test("a toggle animates, unless Reduce Motion is on", () => {
    expect(src).toContain("animateNextLayout(a11yFlags.reduceMotion)");
  });
});

describe("TranscriptRow: tool and reasoning views draw a StepNode", () => {
  const src = read("screens", "transcript", "TranscriptRow.tsx");

  test("no open/show-all state inside the tool or reasoning view (it would die with the cell)", () => {
    expect(fnBody(src, "ToolRowView")).not.toContain("useState");
    expect(fnBody(src, "ReasoningRowView")).not.toContain("useState");
  });

  test("both views draw a StepNode; the 12-line preview constant is gone", () => {
    expect(fnBody(src, "ToolRowView")).toContain("<StepNode");
    expect(fnBody(src, "ReasoningRowView")).toContain("<StepNode");
    expect(src).not.toContain("OUTPUT_PREVIEW_LINES");
  });

  test("the layout's cell reaches the node: the folded thought and the thread (Review S2 #1)", () => {
    const tool = fnBody(src, "ToolRowView");
    expect(tool).toMatch(
      /stepRowView\(\s*tool,\s*cell\?\.kind === "step" \? cell\.thought : null,/,
    );
    expect(tool).toContain('const thread = cell?.kind === "step" ? cell.thread : LONE;');
    expect(tool.match(/thread=\{thread\}/g)?.length).toBe(2);
    const reasoning = fnBody(src, "ReasoningRowView");
    expect(reasoning).toContain('const thread = cell?.kind === "thought" ? cell.thread : LONE;');
    expect(reasoning.match(/thread=\{thread\}/g)?.length).toBe(2);
  });

  test("the flows' testIDs survive: status on the label, output, reply, progress, activity", () => {
    expect(src).toContain("labelTestID={`tool-${tool.id}-${tool.status}`}");
    expect(src).toContain("`tool-${tool.id}-output`");
    expect(src).toContain("`tool-${tool.id}-reply`");
    expect(src).toContain("`tool-${tool.id}-progress`");
    expect(src).toContain("`tool-${tool.id}-activity`");
  });
});

describe("StepNode replaces ToolRow", () => {
  test("ToolRow.tsx is gone and nothing imports it", () => {
    expect(existsSync(join(SRC, "ui", "ToolRow.tsx"))).toBe(false);
    expect(read("screens", "transcript", "TranscriptRow.tsx")).not.toContain("ui/ToolRow");
  });

  test("the label carries the testID; the thread is hidden from VoiceOver", () => {
    const node = read("ui", "StepNode.tsx");
    expect(node).toContain("testID={labelTestID}");
    expect(node).toContain("accessibilityElementsHidden");
    expect(node).toContain("maxFontSizeMultiplier={DENSE_FONT_SCALE}");
  });
});
