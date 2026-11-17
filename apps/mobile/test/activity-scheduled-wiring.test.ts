/**
 * The Activity sheet's Scheduled group shows the session's REAL wakes
 * (docs/fix/mobile-qa-sweep.md, 11:38 item 4): the screen feeds `state.schedules`
 * into `activityView`, the sheet never paints a hard-coded "soon", and the
 * Scheduled row opens Session info at SCHEDULED WAKES through the one path
 * (`openScheduled`). Source pins: `.tsx` cannot be imported from Bun.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", "screens", file), "utf8");

describe("Activity ▸ Scheduled wiring", () => {
  test("the screen feeds the daemon's wakes into the Activity view", () => {
    const screen = src("SessionScreen.tsx");
    const at = screen.indexOf("activityView(");
    expect(at).toBeGreaterThan(-1);
    const call = screen.slice(at, screen.indexOf("activityNow,", at));
    expect(call).toContain("schedules: state.schedules");
  });

  test("the sheet paints no hard-coded ghost value", () => {
    const sheet = src("ActivitySheet.tsx");
    expect(sheet).not.toContain('value="soon"');
    expect(sheet).toContain("group.empty");
  });

  test("the sheet draws the view's sheet-level empty state (never a blank sheet)", () => {
    const sheet = src("ActivitySheet.tsx");
    expect(sheet).toContain("title={view.empty}");
  });

  test("the Scheduled row closes Activity and opens Session info via openScheduled", () => {
    const sheet = src("ActivitySheet.tsx");
    expect(sheet).toMatch(/row\.kind === "scheduled"\s*\?\s*onScheduled\(\)/);
    const screen = src("SessionScreen.tsx");
    const at = screen.indexOf("onScheduled={");
    expect(at).toBeGreaterThan(-1);
    const handler = screen.slice(at, screen.indexOf("}}", at));
    expect(handler).toContain("setActivityOpen(false)");
    expect(handler).toContain("openScheduled()");
  });
});
