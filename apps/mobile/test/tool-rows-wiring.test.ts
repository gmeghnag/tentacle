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
    // In the store (mobile-ui-fluidity-s4 decision 2): once per publish, behind
    // a one-entry memo on (rows, running). The shell computes none.
    const store = read("session-store.ts");
    expect(store).toContain("const layout = stepLayout(rows, running, isBlockRow);");
    expect(store).toContain("last.rows !== rows || last.running !== running");
    expect(src).toMatch(/useMemo\(\(\) => new Map\(rowsSlice\.cells\), \[rowsSlice\.cells\]\)/);
  });

  test("renderItem reads the row's cell, and a hidden cell is null BEFORE SwipeTime wraps it", () => {
    expect(src).toContain("cellEnv.cells.get(item.key)");
    // The memoized cell (docs/fix/mobile-fan-jank-device.md) wraps SwipeTime.
    expect(src).toMatch(/kind === "hidden"\)\s*\{?\s*return null;[\s\S]*<TranscriptCell/);
  });

  test("the open and show-all sets live in the screen and reach every cell through extraData", () => {
    expect(src).toMatch(/useState<readonly string\[\]>\(\[\]\)/);
    expect(src).toMatch(
      /const cellEnv = useMemo[\s\S]{0,600}cells,[\s\S]{0,100}openSteps,\s*fullSteps,/,
    );
    expect(src).toContain("extraData={cellEnv}");
    expect(src).toContain("toggleOpen(");
  });

  // The footer is `TailPane`'s since mobile-ui-fluidity-s4 (always mounted; it
  // draws nothing when it has nothing).
  const pane = read("screens", "session", "TailPane.tsx");

  test("the footer is the live tail, drawn only when there is one", () => {
    // docs/feat/mobile-queued-compose.md D1 added the pending bubbles to the same
    // footer (a queued message is read at the next step, so it is the thread's last
    // node): the tail is still drawn only when there IS one, under the rows.
    // mobile-hub-commands C2 item 15: the compaction slot rides the same footer.
    expect(src).toContain("ListFooterComponent={tailFooter}");
    expect(pane).toMatch(/\{thinking === null \? null : \(\s*<ThinkingNode/);
    expect(pane).toMatch(/\{slice\.slot === null \? null : \(\s*<CompactSlotNode/);
  });

  test("the pending bubbles ride the same footer, after the tail (D1)", () => {
    expect(pane.indexOf("<ThinkingNode")).toBeGreaterThan(-1);
    expect(pane.indexOf("<ThinkingNode")).toBeLessThan(pane.indexOf("<PendingBubbles"));
  });

  test("the footer node gets the tail's thought and its up segment (Review S2 #1)", () => {
    const footer = pane.slice(pane.indexOf("<ThinkingNode\n"));
    expect(footer).toMatch(/^<ThinkingNode[^>]*thought=\{thinking\.thought\}/);
    expect(footer).toMatch(/^<ThinkingNode[^>]*up=\{thinking\.up\}/);
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

  test("the open body's folded ∴ is one size, 12–13 pt (owner 09:33)", () => {
    const node = read("ui", "StepNode.tsx");
    const size = /const THEREFORE_SIZE = ([\d.]+);/.exec(node);
    expect(size === null ? 0 : Number(size[1])).toBeGreaterThanOrEqual(12);
    expect(size === null ? 99 : Number(size[1])).toBeLessThanOrEqual(13);
    // The font's ∴ glyph stays tiny even at 13 pt (simulator, 29-tool-rows-running
    // shots): the ∴ of an open body's folded thought is DRAWN as three dots in a
    // THEREFORE_SIZE box. It is the ONLY ∴ left (owner decision 4, 22/11): the
    // reasoning node is a dot/ring now, and a tool step's line carries none
    // (docs/fix/mobile-step-thought-marker.md, `step-thought-marker.test.ts`).
    expect(node).not.toMatch(/>\s*∴\s*</);
    expect(node.match(/<ThereforeDots\b/g)?.length ?? 0).toBe(1);
    expect(node).toMatch(/dotBox: \{ width: THEREFORE_SIZE, height: THEREFORE_SIZE/);
  });

  test("the live Thinking node is the running tool's own dot; a Thought is a dim ring (22/11)", () => {
    const node = read("ui", "StepNode.tsx");
    // docs/fix/mobile-step-rail.md owner decision 4: ONE node shape for every
    // step. The breathing ∴ is gone; the live thought is the running tool's
    // own dot — literally the same component, so the blink clock is shared.
    expect(node).not.toContain("BreathingTherefore");
    expect(node).toMatch(/case "thinking":\s*return <ThoughtDot [^>]*live /);
    expect(node).toMatch(/case "thought":\s*return <ThoughtDot [^>]*live=\{false\}/);
    expect(node).toMatch(/return <BlinkingDot palette=\{palette\} still=\{still\} \/>;/);
    // The shimmered word survives (it is what says "still thinking" in text).
    expect(node).toMatch(/node === "thinking" \|\| shimmer === true \? \(\s*<ThinkingWord/);
    expect(node).toContain("shimmerSweep(width)");
    expect(node).toContain("useLoop(SHIMMER_MS, !look.animate)");
  });

  test("the shimmer is CLIPPED to the glyphs: no overflow window, no counter-transform (docs/feat/mobile-thinking-images.md S2)", () => {
    const node = read("ui", "StepNode.tsx");
    const word = fnBody(node, "ThinkingWord");
    // The rectangle is gone: no clipping window, no copy of the word moved back.
    expect(node).not.toMatch(/overflow: "hidden"/);
    expect(node).not.toContain("<ShimmerWord");
    expect(word).not.toContain("Animated.multiply");
    expect(word).not.toContain("<Animated.View");
    // The bright layer is the gradient, inside a clip made of the word itself,
    // and the grey word is the SAME svg text (they cannot drift apart).
    expect(word).toMatch(
      /<ClipPath id="thinking-glyphs">\s*<SvgText \{\.\.\.glyph\}>\{line\}<\/SvgText>/,
    );
    expect(word).toMatch(/<SvgText \{\.\.\.glyph\} fill=\{palette\[look\.word\]\}>\s*\{line\}/);
    expect(word).toMatch(
      /<G clipPath="url\(#thinking-glyphs\)">\s*<AnimatedRect\s+x=\{x\}[\s\S]{0,120}fill="url\(#thinking-shine\)"/,
    );
    expect(word).toContain("sweep.stops.map(");
    // The RN text only lays out while the svg draws the word.
    expect(word).toContain('color: glyphs ? "transparent" : palette[look.word]');
  });

  test("the live node says “Thinking” and its seconds in tabular figures (S2)", () => {
    const node = read("ui", "StepNode.tsx");
    const live = fnBody(node, "ThinkingNode");
    expect(live).toContain("name={{ tool: thinkingLabel(0).word }}");
    // The seconds are the owned clock counting from the tail's `since`
    // (docs/feat/mobile-ui-fluidity-s2.md), in the `thinking` format.
    expect(live).toContain("{...(since === undefined ? {} : { liveFrom: since })}");
    expect(live).toContain('clock="thinking"');
    expect(live).not.toContain("Thinking…");
    expect(node).toContain('tabular={node === "thinking"}');
    const clock = read("ui", "ClockText.tsx");
    expect(clock).toContain("tabular ? styles.tabular : undefined");
    expect(clock).toContain('tabular: { fontVariant: ["tabular-nums"] }');
  });

  test("the Thinking motion runs on the native driver, never a JS timer per frame", () => {
    const node = read("ui", "StepNode.tsx");
    const loop = node.slice(node.indexOf("function useLoop("), node.indexOf("const DOT_AT"));
    expect(loop).toContain("useNativeDriver: true");
    const motion = node.slice(node.indexOf("function useLoop("), node.indexOf("function Node("));
    expect(motion).not.toMatch(/setInterval|requestAnimationFrame|setTimeout/);
    // Only transform + opacity (views) and the svg gradient's `x` (S0's verdict)
    // are animated — all on the native driver.
    expect(motion).not.toMatch(/(left|top|width|color): (clock|x)\b/);
    expect(motion).not.toMatch(/(width|height|offset|stopOpacity)=\{(clock|x)\}/);
  });
});

/**
 * docs/fix/mobile-running-row.md: the svg layer draws what the RN label has room
 * for (its own wrapped lines at the label's real width), in the label's face,
 * in a canvas with room for an italic overhang; a running step is the blinking
 * dot; a tool's tap detail never gets the folded reasoning.
 */
describe("running row wiring (docs/fix/mobile-running-row.md)", () => {
  test("the shimmer svg is told the text that fits, the face, and a canvas past the advance width", () => {
    const node = read("ui", "StepNode.tsx");
    const word = fnBody(node, "ThinkingWord");
    expect(word).toContain("setLine(shimmerLine(e.nativeEvent.lines))");
    expect(word).toContain("shimmerFont(font, ");
    expect(word).toContain("shimmerCanvas(width, height, fontSize)");
    expect(word).toMatch(/<Svg[^>]*width=\{canvas\.width\} height=\{canvas\.height\}/);
    // The label is not capped at 45 % when nothing sits beside it (a sentence).
    expect(word).toContain("wide ? styles.nameWide : styles.name");
    // The measuring copy is never seen, never read by VoiceOver.
    expect(word).toMatch(/accessibilityElementsHidden[\s\S]{0,300}onTextLayout/);
  });

  test("a running step is the blinking dot on the shared clock — no turning ring", () => {
    const node = read("ui", "StepNode.tsx");
    expect(node).toMatch(/case "running":\s*return <BlinkingDot /);
    expect(node).not.toContain("function Spinner(");
    expect(node).not.toContain("STEP_SPINNER_TURN_MS");
    const dot = fnBody(node, "BlinkingDot");
    expect(dot).toContain("runningDotLook(still)");
    expect(dot).toContain("STEP_BLINK_CURVE");
    expect(dot).toContain("styles.dot");
  });

  test("a tool row's open body is given no thought", () => {
    const row = read("screens", "transcript", "TranscriptRow.tsx");
    const tool = fnBody(row, "ToolRowView");
    expect(tool).toContain("thought={null}");
    expect(tool).not.toContain("view.thought");
  });
});
