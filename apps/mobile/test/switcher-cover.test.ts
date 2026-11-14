/**
 * `switcher-cover-rule.ts` (docs/feat/mobile-lock.md D4, Owner Q2): WHICH settings
 * get a cover, and that a failed call leaves it failing closed.
 */
import { describe, expect, test } from "bun:test";
import { coverForSetting } from "../src/switcher-cover-rule.ts";

describe("coverForSetting (Owner Q2)", () => {
  test("every setting but `never` gets a cover", () => {
    expect(coverForSetting("immediately")).toBe(true);
    expect(coverForSetting("5m")).toBe(true);
    expect(coverForSetting("1h")).toBe(true);
  });

  test("`never` does not — the owner asked for no lock at all", () => {
    expect(coverForSetting("never")).toBe(false);
  });

  test("while the setting is still LOADING the cover is on (fail-closed)", () => {
    // The switcher can be opened in the first second of a launch; a wrong guess
    // here would leak the snapshot, so the default is "cover".
    expect(coverForSetting("loading")).toBe(true);
  });
});
