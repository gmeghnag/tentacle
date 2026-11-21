/**
 * The permission sheet's "Send reply" stays reachable with the keyboard up
 * (docs/fix/mobile-e2e-1121.md, flow 08c). The reply field sits above the
 * button in a `pageSheet` Modal, which the keyboard does not resize: with the
 * field focused, the keyboard covered the button (the gate's tap landed on a key,
 * and the reply was never sent). `PermissionSheet.tsx` is not renderable from Bun
 * (React Native's sources are Flow), so this pins the structure from the source —
 * the `project-tap-wiring.test.ts` pattern. The device proof is flow 08c.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The source with its comment lines removed: prose may name what the code must do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const SHEET = code(
  readFileSync(join(import.meta.dir, "..", "src", "screens", "PermissionSheet.tsx"), "utf8"),
);

/** The `<ScrollView …>` opening tag that carries `testID="perm-sheet"`. */
function sheetScrollView(): string {
  const at = SHEET.indexOf('testID="perm-sheet"');
  expect(at).toBeGreaterThan(-1);
  const open = SHEET.lastIndexOf("<ScrollView", at);
  expect(open).toBeGreaterThan(-1);
  return SHEET.slice(open, SHEET.indexOf(">", at) + 1);
}

describe("the permission sheet with the keyboard up", () => {
  test("its ScrollView insets itself by the keyboard", () => {
    expect(sheetScrollView()).toContain("automaticallyAdjustKeyboardInsets");
  });

  test("the keyboard showing scrolls the sheet's end (Send reply) into view", () => {
    const tag = sheetScrollView();
    const ref = /ref=\{(\w+)\}/.exec(tag)?.[1];
    expect(ref).toBeDefined();
    expect(SHEET).toMatch(
      new RegExp(
        `Keyboard\\.addListener\\(\\s*"keyboardDidShow"[\\s\\S]{0,120}${ref}\\.current\\?\\.scrollToEnd`,
      ),
    );
    // Unsubscribed on unmount: a listener left behind scrolls a sheet that is gone.
    expect(SHEET).toMatch(/return \(\) => shown\.remove\(\)/);
  });

  test("Send reply is drawn after the reply field (so the sheet's END is the button)", () => {
    const input = SHEET.indexOf('testID="perm-reply-input"');
    const send = SHEET.indexOf('testID="perm-reply-send"');
    expect(input).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(input);
  });
});
