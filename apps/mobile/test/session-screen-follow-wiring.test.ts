/**
 * docs/fix/mobile-chat-glitches.md — the component halves of bugs 1 and 3 and
 * items 5/6. The decisions are pure and tested elsewhere (`follow.test.ts`,
 * `session-screen-compose.test.ts`); these files import React Native, so their
 * wiring is pinned as SOURCE (the `field-reveal.test.ts` pattern).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...parts), "utf8");

describe("SessionScreen follow wiring (bug 3: the TRUE end, padding included)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("no RN `scrollToEnd` (its target is the last cell's end, 16 pt short)", () => {
    expect(src).not.toContain("scrollToEnd(");
  });

  test("it scrolls to the offset `follow.ts` names", () => {
    expect(src).toMatch(
      /step\.scrollTo !== null\)[\s\S]{0,120}scrollToOffset\(\{ offset: step\.scrollTo/,
    );
  });

  test("the native content height feeds `contentGrew`, the list's layout feeds `viewportChanged`", () => {
    expect(src).toMatch(/\(_width: number, height: number\)[\s\S]{0,700}contentGrew\(/);
    expect(src).toMatch(/onContentSizeChange=\{onContentSize\}/);
    expect(src).toMatch(/onListLayout = useCallback\([\s\S]{0,300}viewportChanged\(/);
    expect(src).toMatch(/<FlatList[\s\S]*onLayout=\{onListLayout\}/);
  });
});

describe("RenameSheet (bug 1: the dialog sits above the keyboard, with a top inset)", () => {
  const src = read("screens", "RenameSheet.tsx");

  test("a KeyboardAvoidingView INSIDE the Modal (a Modal is its own window)", () => {
    expect(src).toMatch(
      /<Modal[\s\S]*<KeyboardAvoidingView[\s\S]*<\/KeyboardAvoidingView>[\s\S]*<\/Modal>/,
    );
  });

  test("the card has a non-zero top inset, and the title's Dynamic Type is capped", () => {
    expect(src).toMatch(/card: \{[^}]*paddingTop: [1-9]/);
    expect(src).toMatch(/maxFontSizeMultiplier=\{DENSE_FONT_SCALE\}[\s\S]{0,120}Rename session/);
  });
});

describe("items 5/6: a send dismisses the keyboard and remounts the field", () => {
  test("SessionScreen: `Keyboard.dismiss()` in an effect keyed on `state.sends`", () => {
    const src = read("screens", "SessionScreen.tsx");
    expect(src).toMatch(
      /useEffect\([\s\S]{0,300}Keyboard\.dismiss\(\)[\s\S]{0,200}\[state\.sends\]\)/,
    );
    expect(src).toMatch(/<Composer[\s\S]{0,200}fieldKey=\{state\.sends\}/);
  });

  test("Composer: `key={fieldKey}` on the composer-input TextInput", () => {
    const src = read("ui", "Composer.tsx");
    expect(src).toMatch(/<TextInput\s+key=\{fieldKey\}\s+testID="composer-input"/);
  });
});

describe("SessionScreen: a session opens ALREADY at its end (docs/fix/mobile-open-at-end.md, item 1)", () => {
  const src = read("screens", "SessionScreen.tsx");

  test("the performed scroll takes its `animated` from the step (never a hard `true`)", () => {
    expect(src).toMatch(/scrollToOffset\(\{ offset: step\.scrollTo, animated: step\.animated \}\)/);
    expect(src).not.toMatch(/scrollToOffset\(\{ offset: step\.scrollTo, animated: true \}\)/);
  });

  test("both measurements go through the landing first, and it owns the scroll while pending", () => {
    expect(src).toMatch(/onContentSize = useCallback\([\s\S]{0,400}if \(land\(\)\) \{/);
    expect(src).toMatch(/onListLayout = useCallback\([\s\S]{0,300}if \(land\(\)\) \{/);
    expect(src).toMatch(
      /landingStep\(landing\.current, size\.current, followRef\.current\.following\)/,
    );
    expect(src).toMatch(/const landing = useRef<Landing>\(landingStart\)/);
  });

  test("the list is HIDDEN while it lands (a long history is never seen scrolling) [mutation: drop the style → visible scroll]", () => {
    expect(src).toMatch(/<View style=\{settling \? styles\.hidden : styles\.screen\}>/);
    expect(src).toMatch(/hidden: \{ flex: 1, opacity: 0 \}/);
  });

  test("a re-attach (pull, Retry, Reopen) lands SILENTLY: no second visible scroll", () => {
    expect(src).toMatch(
      /landing\.current = followRef\.current\.following \? landingQuiet : landingDone/,
    );
    // The pull, the Retry row and the Reopen button all re-arm it.
    expect(src.match(/landing\.current = followRef\.current\.following/g) ?? []).toHaveLength(3);
  });

  test("the app's foreground transition reaches the controller (item 2)", () => {
    expect(src).toMatch(
      /AppState\.addEventListener\("change"[\s\S]{0,200}controller\.appState\(next\)/,
    );
  });
});
