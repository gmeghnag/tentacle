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
    // docs/feat/mobile-queued-compose.md D1 added the pending bubbles to the same
    // footer (a queued message is read at the next step, so it is the thread's last
    // node): the tail is still drawn only when there IS one, under the rows.
    // mobile-hub-commands C2 item 15: the compaction slot rides the same footer.
    expect(src).toMatch(
      /ListFooterComponent=\{\s*layout\.tail === null &&\s*state\.slot === null &&\s*state\.view\.pending\.length === 0\s*\? undefined/,
    );
    expect(src).toMatch(/\{layout\.tail === null \? null : \(\s*<ThinkingNode/);
    expect(src).toMatch(/\{state\.slot === null \? null : \(\s*<CompactSlotNode/);
  });

  test("the pending bubbles ride the same footer, after the tail (D1)", () => {
    const footer = src.slice(src.indexOf("ListFooterComponent="));
    expect(footer.indexOf("<ThinkingNode")).toBeLessThan(footer.indexOf("<PendingBubbles"));
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
    // docs/fix/thought-placeholder.md: collapsed, never expandable (no toggle, no body).
    expect(reasoning).not.toContain("onToggle");
    expect(reasoning).not.toContain("body=");
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

  test("every ∴ (a thought's node, a folded thought) is one size, 12–13 pt (owner 09:33)", () => {
    const node = read("ui", "StepNode.tsx");
    const size = /const THEREFORE_SIZE = ([\d.]+);/.exec(node);
    expect(size === null ? 0 : Number(size[1])).toBeGreaterThanOrEqual(12);
    expect(size === null ? 99 : Number(size[1])).toBeLessThanOrEqual(13);
    // The font's ∴ glyph stays tiny even at 13 pt (simulator, 29-tool-rows-running
    // shots): every ∴ is DRAWN as three dots in a THEREFORE_SIZE box, like the live node.
    expect(node).not.toMatch(/>\s*∴\s*</);
    // Two, since 17/11: a thought's node and the folded thought in the open body.
    // A tool step's line carries NONE — it sat next to the command's duration
    // (docs/fix/mobile-step-thought-marker.md, `step-thought-marker.test.ts`).
    expect(node.match(/<ThereforeDots\b/g)?.length ?? 0).toBe(2);
    expect(node).toMatch(/dotBox: \{ width: THEREFORE_SIZE, height: THEREFORE_SIZE/);
  });

  test("the live Thinking node is mockup B + D: a breathing ∴ and a shimmering word (09:36)", () => {
    const node = read("ui", "StepNode.tsx");
    // B: the "thinking" node is the breathing ∴, no longer the queued ring.
    expect(node).toMatch(/case "thinking":\s*return <BreathingTherefore /);
    expect(node).toContain("clock.interpolate(breatheCurve(i))");
    // D: the footer's word is the shimmer, fed by the pure sweep.
    expect(node).toMatch(/node === "thinking" \? \(\s*<ShimmerWord/);
    expect(node).toContain("shimmerSweep(width)");
    // Reduce Motion stops both clocks (useLoop returns null when still).
    expect(node).toContain("useLoop(BREATHE_MS, !look.animate)");
    expect(node).toContain("useLoop(SHIMMER_MS, !look.animate)");
    // ...and, while it is still the `overflow: "hidden"` window of
    // docs/feat/mobile-thinking-images.md, it says so instead of describing the
    // glyph-clipped sweep S2 will build (Review round 1, finding 2: the comment
    // promised code that did not exist). The pair flips when S2 lands.
    expect(node).toMatch(/band: \{ position: "absolute",[\s\S]{0,80}overflow: "hidden"/);
    const fn = node.indexOf("function ShimmerWord(");
    const sweep = node.slice(node.lastIndexOf("/**", fn), node.indexOf("function Node(", fn));
    expect(sweep).toMatch(/is a visible RECTANGLE behind the word/);
    expect(sweep).not.toMatch(/CLIPPED to the glyphs|there is no window to translate/);
  });

  test("the Thinking motion runs on the native driver, never a JS timer per frame", () => {
    const node = read("ui", "StepNode.tsx");
    const loop = node.slice(node.indexOf("function useLoop("), node.indexOf("const DOT_AT"));
    expect(loop).toContain("useNativeDriver: true");
    const motion = node.slice(node.indexOf("function useLoop("), node.indexOf("function Node("));
    expect(motion).not.toMatch(/setInterval|requestAnimationFrame|setTimeout/);
    // Only transform + opacity are animated (both native-driver properties).
    expect(motion).not.toMatch(/(left|top|width|color): (clock|x)\b/);
  });
});
