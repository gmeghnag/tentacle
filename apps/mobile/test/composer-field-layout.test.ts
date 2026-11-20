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

  test("the mic keeps its ids, plus one for transcribing (docs/feat/mobile-composer-buttons.md)", () => {
    expect(COMPOSER).toMatch(/idle: "composer-mic",/);
    expect(COMPOSER).toMatch(/listening: "composer-mic-listening",/);
    expect(COMPOSER).toMatch(/finalizing: "composer-mic-finalizing",/);
    expect(COMPOSER).toMatch(/testID=\{MIC_ID\[mic\]\}/);
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

/**
 * docs/feat/mobile-composer-buttons.md (owner B + S2, 20/11): the `+` and the mic
 * in one soft accent circle, a 44 pt target each, recording/transcribing told by
 * SHAPE (■ + halo + timer / arc + "…"), the field's border never coloured, and
 * no solid accent fill left on the send slot.
 */
describe("the round buttons (mockup B + S2)", () => {
  test("the field's border is ALWAYS sep — never the accent, not even while recording", () => {
    expect(COMPOSER).toMatch(/borderColor: palette\.sep,/);
    expect(COMPOSER).not.toMatch(/borderColor: [^,\n]*palette\.accent/);
  });

  test("`+` and the mic: a 32 pt soft circle in a 44×44 pressable (≥ 44 pt target)", () => {
    expect(COMPOSER).toMatch(/\n {2}hit: \{[^}]*width: 44,[^}]*height: 44,/);
    expect(COMPOSER).toMatch(
      /\n {2}circle: \{[^}]*width: 32,[^}]*height: 32,[^}]*borderRadius: 16,/,
    );
    const plus = COMPOSER.slice(COMPOSER.indexOf('testID="composer-photo"'));
    expect(plus.slice(0, plus.indexOf("</Pressable>"))).toMatch(
      /style=\{styles\.hit\}[\s\S]*palette\.accentSoft\b[\s\S]*name="plus"[\s\S]*weight="light"/,
    );
    const mic = COMPOSER.slice(COMPOSER.indexOf("testID={MIC_ID[mic]}"));
    expect(mic.slice(0, mic.indexOf("</Pressable>"))).toMatch(
      /style=\{styles\.hit\}[\s\S]*listening \? palette\.accentSoftStrong : palette\.accentSoft/,
    );
    // No hitSlop fudge left: the target is the pressable itself.
    expect(COMPOSER).not.toContain("styles.round");
  });

  test("no separate photo button: the `+` is the only one before the spacer", () => {
    expect(COMPOSER).not.toContain('name="photo"');
  });

  test("recording = filled ■ 11 pt + halo; transcribing = the arc, and its tap is disabled", () => {
    expect(COMPOSER).toMatch(/<Halo color=\{palette\.accent\} \/>/);
    expect(COMPOSER).toMatch(/\n {2}recSquare: \{ width: 11, height: 11, borderRadius: 2\.5 \}/);
    expect(COMPOSER).toMatch(/finalizing \? \(\s*<Spinner color=\{palette\.sec\} \/>/);
    expect(COMPOSER).toContain("disabled={!editable || finalizing}");
    // The old waveform face (level as opacity: hue/opacity only) is gone.
    expect(COMPOSER).not.toContain('name="waveform"');
  });

  test("the caption (timer / …) is the view-model's, drawn beside the mic", () => {
    expect(COMPOSER).toContain('testID="composer-mic-caption"');
    expect(COMPOSER).toMatch(/\{micCaption\}/);
    expect(read("screens", "SessionScreen.tsx")).toContain("micCaption={voiceView.caption}");
  });

  test("Reduce Motion stops both animations", () => {
    // Each animated face reads Reduce Motion and starts no loop when it is on.
    const reads = [...COMPOSER.matchAll(/const reduce = useReduceMotion\(\) !== false;/g)];
    expect(reads).toHaveLength(2);
    expect([...COMPOSER.matchAll(/if \(reduce\) \{\s*return;\s*\}/g)]).toHaveLength(2);
  });

  test("S2 send: ready = soft strong circle + accent ↑; empty = no circle, sec at 50 %", () => {
    expect(COMPOSER).not.toContain("palette.accentFill");
    expect(COMPOSER).not.toContain("palette.onAccent");
    expect(COMPOSER).toMatch(/slot === "up-dim"\s*\? "transparent"/);
    expect(COMPOSER).toMatch(/: palette\.accentSoftStrong,/);
    expect(COMPOSER).toMatch(/color=\{slot === "up-dim" \? palette\.sec : palette\.accent\}/);
    expect(COMPOSER).toMatch(/\n {2}dim: \{ opacity: 0\.5 \}/);
    // 36 pt + hitSlop 4 on each side = the 44 pt target.
    const send = COMPOSER.slice(COMPOSER.indexOf("testID={testIdOf(button)}"));
    expect(send.slice(0, send.indexOf("style="))).toContain("hitSlop={4}");
  });

  test("the soft tokens are the accent at 10 / 20 % light and 14 / 26 % dark", () => {
    const theme = read("theme.ts");
    expect(theme).toContain('accentSoft: "rgba(14,116,144,0.10)"');
    expect(theme).toContain('accentSoftStrong: "rgba(14,116,144,0.20)"');
    expect(theme).toContain('accentSoft: "rgba(34,211,238,0.14)"');
    expect(theme).toContain('accentSoftStrong: "rgba(34,211,238,0.26)"');
    // …and they ARE the accent (#0E7490 / #22D3EE), not a near miss.
    expect(theme).toContain('accent: "#0E7490"');
    expect(theme).toContain('accent: "#22D3EE"');
  });
});
