/**
 * Slice B's component halves (docs/fix/mobile-open-at-end.md): the rules are pure
 * and tested in `row-swipe.test.ts`; `SwipeTime.tsx` imports React Native, so its
 * WIRING is pinned as source (the `field-reveal.test.ts` / follow-wiring pattern).
 *
 * Mutations that must turn these red: drop the terminate spring-back; switch to
 * `onStartShouldSetPanResponder`; `useNativeDriver: false`; put the label inside
 * the row's flow (no `position: "absolute"`); give the component its own
 * `Date`/`Intl` instead of the injected label; stop wrapping `TranscriptRow`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...parts), "utf8");

describe("SwipeTime: the gesture is the pure module's, the wiring is safe", () => {
  const src = read("screens", "transcript", "SwipeTime.tsx");

  test("claims on MOVE only, through `claimsPan` — never on start", () => {
    expect(src).toMatch(/onMoveShouldSetPanResponder:[\s\S]{0,200}claimsPan\(/);
    expect(src).not.toContain("onStartShouldSetPanResponder");
  });

  test("the offset comes from `revealOffset`, and a native gesture may take over", () => {
    expect(src).toContain("revealOffset(g.dx)");
    expect(src).toMatch(/onPanResponderTerminationRequest: \(\) => true/);
  });

  test("BOTH release and terminate spring back (a takeover must never leave a stuck row)", () => {
    expect(src).toMatch(/onPanResponderRelease: settle/);
    expect(src).toMatch(/onPanResponderTerminate: settle/);
    expect(src).toMatch(/Animated\.spring\([\s\S]{0,120}useNativeDriver: true/);
  });

  test("the label is ABSOLUTE, outside the row, and fixed to REVEAL's width", () => {
    expect(src).toMatch(/position: "absolute"/);
    expect(src).toMatch(/right: -REVEAL/);
    expect(src).toMatch(/width: REVEAL/);
    expect(src).toContain('pointerEvents="none"');
  });

  test("no clock here: the label is a prop (the caller computes it)", () => {
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/Intl\.DateTimeFormat/);
    expect(src).not.toContain("Date.now()");
    expect(src).toMatch(/readonly label: string \| null;/);
  });
});

describe("SessionScreen renders one row per cell, wrapped in SwipeTime", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("`renderItem` wraps TranscriptRow in SwipeTime with the row's own time", () => {
    expect(src).toMatch(/<SwipeTime[\s\S]{0,200}label=\{rowTimeLabel\(item\)\}/);
    expect(src).toMatch(/<SwipeTime[\s\S]*<TranscriptRow[\s\S]*<\/SwipeTime>/);
  });

  test("the screen formats no time of its own (it asks the pure module)", () => {
    expect(src).not.toMatch(/toLocaleTimeString/);
    expect(src).not.toMatch(/hour: "2-digit"/);
  });

  test("the label is computed by the pure module, not inline", () => {
    expect(src).toContain('import { rowTimeLabel } from "../row-swipe.ts";');
  });
});
