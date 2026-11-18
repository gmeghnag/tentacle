/**
 * The composer's ONE field (docs/feat/mobile-queued-compose.md D4, owner Q3): one
 * rounded rect holding the `TextInput` and a 36 pt row under it — `+` on the left,
 * then one ⇥ Send now pill (while Send now is offered), the mic, and the send
 * slot whose glyph is `sendSlot`'s. `ComposeBar.tsx` imports React Native (Flow
 * sources Bun cannot parse), so this reads the sources and pins the STRUCTURE and
 * the testIDs the Maestro flows depend on (plan P9).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: readonly string[]): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...parts), "utf8");

const COMPOSER = read("ui", "Composer.tsx");
const BAR = read("screens", "compose", "ComposeBar.tsx");

describe("one field: the TextInput and the 36 pt row live in the same rounded rect", () => {
  test("exactly one TextInput, and the row is INSIDE the field's own View", () => {
    expect([...COMPOSER.matchAll(/<TextInput\b/g)]).toHaveLength(1);
    const field = COMPOSER.slice(
      COMPOSER.indexOf("<View\n        style={[\n          styles.field"),
    );
    expect(field.length).toBeGreaterThan(0);
    // The row closes before the field does: the field wraps it.
    expect(field.indexOf("styles.row")).toBeGreaterThan(0);
    expect(field.indexOf("styles.row")).toBeLessThan(field.indexOf("</View>\n    </View>"));
  });

  test("the bottom row is 36 pt, and the slot inside it is 36 pt too", () => {
    expect(COMPOSER).toMatch(/\n {2}row: \{[^}]*height: 36/);
    expect(COMPOSER).toMatch(/\n {2}slot: \{[^}]*height: 36/);
  });

  test("the field is the fill with a 1 pt separator stroke and a 22 pt radius", () => {
    // Mutation: the old glass capsule (borderColor palette.glassBorder) → red.
    expect(COMPOSER).toMatch(/backgroundColor: palette\.fill/);
    expect(COMPOSER).toMatch(/borderColor: [^,\n]*palette\.sep\b/);
    expect(COMPOSER).toMatch(/borderWidth: 1,/);
    expect(COMPOSER).toMatch(/borderRadius: radius\.composer/);
    expect(read("theme.ts")).toMatch(/\n {2}composer: 22,/);
  });
});

describe("the testIDs the flows depend on are all still there", () => {
  for (const id of ["composer-input", "composer-photo", "composer-filled", "composer-send-now"]) {
    test(`Composer.tsx sets ${id}`, () => {
      expect(COMPOSER).toContain(`testID="${id}"`);
    });
  }

  test("the send slot keeps composer-send / -stop / -send-later (testIdOf)", () => {
    // A flow taps `composer-send` for BOTH a send and a queue: one id, one button.
    expect(COMPOSER).toContain('button === "stop"');
    expect(COMPOSER).toContain('"composer-stop"');
    expect(COMPOSER).toContain('"composer-send-later"');
    expect(COMPOSER).toContain('"composer-send"');
    expect(COMPOSER).toMatch(/testID=\{testIdOf\(button\)\}/);
  });

  test("the mic keeps both states", () => {
    expect(COMPOSER).toContain('listening ? "composer-mic-listening" : "composer-mic"');
  });

  test("Send now lives in the FIELD, and the card above it no longer draws one", () => {
    // Owner Q3: the pill moved beside the field's text. Mutation: leave the card's
    // pill → the screen would draw two.
    expect(BAR).not.toContain("composer-send-now");
    expect(BAR).not.toContain('"Send now"');
    expect(COMPOSER).toContain('testID="composer-send-now"');
  });

  test("the card above the field no longer draws MY queued rows (they are bubbles now)", () => {
    // D1/D4: `queued-row-*` is gone; another device's RETURNED rows with Take stay.
    expect(BAR).not.toContain("queued-row-");
    expect(BAR).toContain("take-${row.id}");
    expect(BAR).toContain("returned-other-${row.id}");
  });
});

describe("the send slot's glyph is `sendSlot`'s, never a re-decision here", () => {
  test("the component reads `slot`, and the view-model computes it with sendSlot", () => {
    expect(COMPOSER).toMatch(/readonly slot: SendSlot/);
    expect(COMPOSER).not.toContain("composerAction(");
    const VIEW = read("session-view.ts");
    expect(VIEW).toContain("sendSlot(action)");
  });

  test("the four glyphs: up, dimmed up, stop square, clock", () => {
    expect(COMPOSER).toContain('slot === "stop"');
    expect(COMPOSER).toContain('slot === "clock"');
    expect(COMPOSER).toContain('slot === "up-dim"');
    expect(COMPOSER).toContain('name="arrow.up"');
  });
});
