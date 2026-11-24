/**
 * docs/feat/mobile-shell-output-scroll.md — the RENDER half of "B, the terminal
 * in the row". The cut (tail) and the neutral colour are pure and tested in
 * `tool-summary.test.ts` / `tool-step-view.test.ts`; this pins, as SOURCE (the
 * `step-rail-render.test.ts` pattern: the components pull React Native), that
 * `ui/OutputBlock.tsx` draws ONE horizontal scroller, never wraps, has no line
 * numbers and no tap action on the text, and that `StepBody` uses it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...p), "utf8");

describe("OutputBlock: the output as a terminal block", () => {
  test("one horizontal ScrollView around ONE Text; the edge fades like CodeBlock", () => {
    const src = read("ui", "OutputBlock.tsx");
    expect(src).toMatch(/<ScrollView\s+horizontal/);
    expect(src).toContain("trailingFade(");
    expect(src.match(/<Text\b/g)?.length).toBeGreaterThanOrEqual(2); // body + footer
    expect(src).not.toContain("numberOfLines");
    expect(src).not.toMatch(/lineNumber|gutter/i);
  });

  test("neutral text colour (`sec`): never red", () => {
    const src = read("ui", "OutputBlock.tsx");
    expect(src).toContain("palette.sec");
    expect(src).not.toContain("palette.red");
  });

  test("no tap action on the text (iOS selection stays); `show all` is the footer only", () => {
    const src = read("ui", "OutputBlock.tsx");
    const body = src.slice(0, src.indexOf("{hidden === 0"));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("onPress");
    expect(src).toContain("earlier ");
    expect(src).toContain("selectable");
  });
});

describe("SessionScreen: the sticky overlay is a read-only tap-in", () => {
  test("onScroll feeds it, cells are measured, the overlay collapses via the step toggle", () => {
    const src = read("screens", "SessionScreen.tsx");
    const scroll = src.slice(src.indexOf("const onScroll = useCallback("));
    expect(scroll.slice(0, 400)).toContain("recomputeSticky.current()");
    expect(src).toContain("CellRendererComponent={MeasuredCell}");
    expect(src).toContain("<StickyStep");
    expect(src).toContain("cellActions.current.onToggle(key)");
  });
});

describe("StepBody uses it", () => {
  test("the output is an <OutputBlock>, not a wrapping red Text in a Pressable", () => {
    const src = read("ui", "StepNode.tsx");
    expect(src).toContain("<OutputBlock");
    expect(src).not.toContain("output.error");
    expect(src).not.toContain("more lines");
  });
});
