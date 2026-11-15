/**
 * Keep a focused field and its action above the keyboard (mobile-ui-polish
 * slice 6: the Pair paste field and Continue ended UNDER the keyboard, so the
 * screenshot walk failed at `pair-review`). The decision is pure; `PairScreen`
 * only performs the scroll it returns.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_REVEAL_IDLE, type FieldRevealEvent, revealStep } from "../src/field-reveal.ts";

function run(events: readonly FieldRevealEvent[]): boolean[] {
  let state = FIELD_REVEAL_IDLE;
  const out: boolean[] = [];
  for (const event of events) {
    const step = revealStep(state, event);
    state = step.state;
    out.push(step.reveal);
  }
  return out;
}

describe("revealStep", () => {
  test("focus, then the keyboard is up → reveal once the keyboard is up", () => {
    expect(run(["focus", "keyboard-shown"])).toEqual([false, true]);
  });

  test("the keyboard already up (another field), then focus → reveal at once", () => {
    expect(run(["keyboard-shown", "focus"])).toEqual([false, true]);
  });

  test("the keyboard changes size while focused (QuickType bar) → reveal again", () => {
    expect(run(["focus", "keyboard-shown", "keyboard-shown"])).toEqual([false, true, true]);
  });

  test("the content grows while focused and up (a pasted line wraps) → reveal again", () => {
    expect(run(["focus", "keyboard-shown", "content-resized"])).toEqual([false, true, true]);
    expect(run(["content-resized", "focus", "content-resized"])).toEqual([false, false, false]);
    expect(run(["keyboard-shown", "content-resized"])).toEqual([false, false]);
  });

  test("never while the field is not focused, nor after the keyboard hides", () => {
    expect(run(["keyboard-shown"])).toEqual([false]);
    expect(run(["focus", "blur", "keyboard-shown"])).toEqual([false, false, false]);
    expect(run(["focus", "keyboard-shown", "keyboard-hidden", "focus"])).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });
});

describe("PairScreen wiring (it imports React Native: read as source)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "screens", "PairScreen.tsx"), "utf8");

  test("the paste field reports focus/blur and the keyboard drives the step", () => {
    expect(src).toContain("revealStep(");
    expect(src).toMatch(/testID="pair-paste-input"[\s\S]{0,400}onFocus=/);
    expect(src).toMatch(/testID="pair-paste-input"[\s\S]{0,400}onBlur=/);
    expect(src).toContain('"keyboardDidShow"');
    expect(src).toContain('"keyboardDidHide"');
  });

  test("a reveal scrolls the list to its end (the paste card and Continue are last)", () => {
    expect(src).toMatch(/\.reveal\)[\s\S]{0,200}scrollToEnd\(/);
  });

  test("the list's content resize feeds the step (the field wraps as it fills)", () => {
    expect(src).toMatch(/onContentSizeChange=\{\(\) => feed\("content-resized"\)\}/);
  });
});
