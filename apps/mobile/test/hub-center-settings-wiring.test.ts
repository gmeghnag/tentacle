/**
 * `feat/mobile-hub-center` D7 — the list-end setting's wiring, pinned as SOURCE
 * (the `chart-labels-wiring.test.ts` pattern): these files import React Native
 * and the Keychain adapter, so what is provable here is who OWNS the write and
 * that the row exists only where it can mean anything (with the floating button).
 *
 * The default itself (absent = ON) is `listEndOn`'s, tested in
 * `activity-settings-store.test.ts`; the padding maths is `floating-button.test.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const APP = join(import.meta.dir, "..");
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), "utf8");

describe("Settings → Activity button: «Keep the chat's end above the button» (owner 6)", () => {
  const settings = read("screens", "SettingsScreen.tsx");

  test("the two props exist, and the row is drawn only with the floating button", () => {
    expect(settings).toMatch(/readonly activityListEnd\?: boolean;/);
    expect(settings).toMatch(/readonly onActivityListEnd\?: \(on: boolean\) => void;/);
    // The opacity band's rule: nothing to decide without the floating button.
    expect(settings).toMatch(
      /activityMode !== "floating" \|\| onActivityListEnd === undefined \? null :/,
    );
    expect(settings).toMatch(/testID="activity-list-end"/);
  });

  test("it is disabled over an unwritable record and says why, like the Photos switch", () => {
    expect(settings).toMatch(
      /testID="activity-list-end"[\s\S]{0,700}disabled=\{!activityWritable\}/,
    );
    expect(settings).toMatch(
      /value=\{activityListEnd \?\? true\}[\s\S]{0,1200}Set by a newer version of tentacle/,
    );
  });

  test("its words are the owner's (O7)", () => {
    expect(settings).toContain('title="Keep the chat\'s end above the button"');
    expect(settings).toContain("the last message stops above it");
  });

  test("the section's footnote names the centre (D1/O7)", () => {
    expect(settings).toContain("a button you can drag to either edge or the center.");
  });

  test("App writes it by spreading the current settings, and passes the DEFAULT down", () => {
    const app = readFileSync(join(APP, "App.tsx"), "utf8");
    expect(app).toMatch(
      /const selectActivityListEnd = useCallback\(\(on: boolean\) => \{[\s\S]{0,400}listEndAboveHub: on/,
    );
    // A failed write reuses the Activity button's banner (F22), never a new one.
    expect(app).toMatch(
      /selectActivityListEnd = useCallback\([\s\S]{0,400}That Activity button setting didn't save/,
    );
    expect(app).toMatch(/activityListEnd=\{listEndOn\(activitySettings\)\}/);
    expect(app).toMatch(/onActivityListEnd=\{selectActivityListEnd\}/);
    // The default lives in `listEndOn` ONLY: never `?? true` at a call site.
    expect(app).not.toContain("listEndAboveHub ??");
    expect(app).toMatch(/import \{ type ActivitySettings, listEndOn \}/);
  });
});
