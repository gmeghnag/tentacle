/**
 * `hub-flash.ts` — the dimmed item's in-place label (docs/feat/mobile-hub-commands.md
 * C1 Design 6, owner Q3 A): the tapped empty item's OWN pill swaps to its empty
 * reason for `FLASH_MS`, then back. Pure, so the two boundaries are provable.
 */
import { describe, expect, test } from "bun:test";
import type { HubItem } from "../src/hub-actions.ts";
import { FLASH_MS, type Flash, pillIndex, pillText, pillVisible } from "../src/hub-flash.ts";

const item = (over: Partial<HubItem> = {}): HubItem => ({
  id: "artifacts",
  label: "Artifacts",
  badge: null,
  danger: false,
  dimmed: true,
  emptyLabel: "No artifacts yet",
  ...over,
});

describe("FLASH_MS", () => {
  test("~1.6 s, the owner's figure", () => {
    expect(FLASH_MS).toBe(1600);
  });
});

describe("pillText: the empty reason while the flash lasts, the label after", () => {
  const flash: Flash = { index: 2, at: 10_000 };

  test("1599 ms: still the empty reason (the window is half-open)", () => {
    expect(pillText(item(), 2, flash, 10_000 + 1599)).toBe("No artifacts yet");
  });

  test("1600 ms: back to the item's own label — exclusive, so it ends on the second", () => {
    expect(pillText(item(), 2, flash, 10_000 + 1600)).toBe("Artifacts");
  });

  test("before the flash started (a clock that went backwards) is not the reason", () => {
    expect(pillText(item(), 2, flash, 9_000)).toBe("Artifacts");
  });

  test("no flash at all → the label, as before", () => {
    expect(pillText(item(), 2, null, 10_000)).toBe("Artifacts");
    expect(pillText(item(), 2, undefined, 10_000)).toBe("Artifacts");
  });

  test("a re-tap restarts the window at its own `at`", () => {
    const again: Flash = { index: 2, at: 10_000 + 1500 };
    expect(pillText(item(), 2, again, 10_000 + 1599)).toBe("No artifacts yet");
    expect(pillText(item(), 2, again, 10_000 + 1500 + 1600)).toBe("Artifacts");
  });
});

describe("pillVisible: the highlighted item OR the flashing one", () => {
  const flash: Flash = { index: 2, at: 0 };

  test("the finger's highlight shows its pill", () => {
    expect(pillVisible(1, 1, null, 0)).toBe(true);
  });

  test("the flashing item keeps its pill after the finger left", () => {
    expect(pillVisible(2, null, flash, 100)).toBe(true);
  });

  test("once the flash is over, nothing is drawn for it", () => {
    expect(pillVisible(2, null, flash, FLASH_MS)).toBe(false);
    expect(pillVisible(2, 1, flash, FLASH_MS)).toBe(false);
  });

  test("the highlight wins over another item's flash", () => {
    expect(pillVisible(1, 1, flash, 100)).toBe(true);
    expect(pillVisible(0, 1, flash, 100)).toBe(false);
  });
});

describe("pillIndex: the ONE pill's item", () => {
  const flash: Flash = { index: 2, at: 0 };

  test("the finger's highlight", () => {
    expect(pillIndex(1, null, 0)).toBe(1);
  });

  test("with the finger off, the flashing item keeps it", () => {
    expect(pillIndex(null, flash, 100)).toBe(2);
  });

  test("neither → no pill at all, and after the flash too", () => {
    expect(pillIndex(null, null, 0)).toBeNull();
    expect(pillIndex(null, flash, FLASH_MS)).toBeNull();
  });

  test("the highlight wins", () => {
    expect(pillIndex(0, flash, 100)).toBe(0);
  });
});
