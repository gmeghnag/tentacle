/**
 * `floating-button.ts` — the floating Activity button's rules (docs/feat/mobile-chrome.md
 * Design 6, S10): edge snap, the band clamp, re-projection, tap vs drag, when it
 * shows, Reduce Motion and VoiceOver (F20, F21, F23).
 */
import { describe, expect, test } from "bun:test";
import {
  BAND_MARGIN,
  EDGE_INSET,
  FLOAT_SIZE,
  HUB_COLUMN,
  LIST_END_PADDING,
  a11y,
  footClearance,
  headerPill,
  isTap,
  listEndPadding,
  motion,
  place,
  snap,
  visible,
} from "../src/floating-button.ts";

/** A 390 pt phone, the band between a header at 0 and a composer at 600. */
const BOUNDS = { width: 390, height: 600 };
const MIN_CENTRE = BAND_MARGIN + FLOAT_SIZE / 2;
const MAX_CENTRE = BOUNDS.height - BAND_MARGIN - FLOAT_SIZE / 2;

describe("snap: the nearest vertical edge by the button's centre", () => {
  test("left of the midline → left, right of it → right", () => {
    expect(snap({ x: 100, y: 300 }, BOUNDS)?.edge).toBe("left");
    expect(snap({ x: 300, y: 300 }, BOUNDS)?.edge).toBe("right");
    expect(snap({ x: 194, y: 300 }, BOUNDS)?.edge).toBe("left");
  });

  test("exactly on the midline → right (pinned)", () => {
    expect(snap({ x: 195, y: 300 }, BOUNDS)?.edge).toBe("right");
  });

  test("y is clamped to the band: above the top → 0, below the bottom → 1", () => {
    expect(snap({ x: 10, y: -500 }, BOUNDS)?.yFraction).toBe(0);
    expect(snap({ x: 10, y: 0 }, BOUNDS)?.yFraction).toBe(0);
    expect(snap({ x: 10, y: 5000 }, BOUNDS)?.yFraction).toBe(1);
    expect(snap({ x: 10, y: BOUNDS.height }, BOUNDS)?.yFraction).toBe(1);
  });

  test("inside the band: the fraction of the band", () => {
    const mid = (MIN_CENTRE + MAX_CENTRE) / 2;
    expect(snap({ x: 10, y: mid }, BOUNDS)?.yFraction).toBeCloseTo(0.5, 6);
  });

  test("F20: a band shorter than 2 × the button → no position (hidden)", () => {
    expect(snap({ x: 10, y: 50 }, { width: 390, height: FLOAT_SIZE * 2 - 1 })).toBeNull();
    expect(snap({ x: 10, y: 50 }, { width: 390, height: FLOAT_SIZE * 2 })).not.toBeNull();
  });

  test("a non-finite drop never stores NaN", () => {
    const s = snap({ x: Number.NaN, y: Number.NaN }, BOUNDS);
    expect(s === null || Number.isFinite(s.yFraction)).toBe(true);
  });
});

describe("place: re-projects a stored position into the current band", () => {
  test("left edge sits EDGE_INSET inside the screen (F21), right edge mirrors it", () => {
    expect(place({ edge: "left", yFraction: 0 }, BOUNDS)).toEqual({
      x: EDGE_INSET,
      y: MIN_CENTRE - FLOAT_SIZE / 2,
    });
    expect(place({ edge: "right", yFraction: 1 }, BOUNDS)).toEqual({
      x: BOUNDS.width - EDGE_INSET - FLOAT_SIZE,
      y: MAX_CENTRE - FLOAT_SIZE / 2,
    });
  });

  test("the same yFraction lands proportionally in a shorter band (keyboard, rotation)", () => {
    const short = { width: 700, height: 300 };
    const p = place({ edge: "right", yFraction: 0.5 }, short);
    const centre = (p?.y ?? 0) + FLOAT_SIZE / 2;
    expect(centre).toBeCloseTo(short.height / 2, 6);
    expect(p?.x).toBe(700 - EDGE_INSET - FLOAT_SIZE);
  });

  test("snap then place round-trips the edge and the clamped centre", () => {
    const s = snap({ x: 40, y: 250 }, BOUNDS);
    expect(s).not.toBeNull();
    const p = s === null ? null : place(s, BOUNDS);
    expect(p?.x).toBe(EDGE_INSET);
    expect((p?.y ?? 0) + FLOAT_SIZE / 2).toBeCloseTo(250, 6);
  });

  test("never below the composer or above the header, whatever is stored", () => {
    const low = place({ edge: "left", yFraction: 7 }, BOUNDS);
    const high = place({ edge: "left", yFraction: -3 }, BOUNDS);
    expect((low?.y ?? 0) + FLOAT_SIZE).toBeLessThanOrEqual(BOUNDS.height - BAND_MARGIN);
    expect(high?.y ?? -1).toBeGreaterThanOrEqual(BAND_MARGIN);
  });

  test("no stored position → the right edge, bottom of the band (thumb reach)", () => {
    expect(place(undefined, BOUNDS)).toEqual(place({ edge: "right", yFraction: 1 }, BOUNDS));
  });

  test("F20: a band too short → null", () => {
    expect(place({ edge: "left", yFraction: 0.5 }, { width: 390, height: 100 })).toBeNull();
  });
});

describe("isTap: a press OR a drag, never both (mobile-hub Design 1: 10 pt / 400 ms)", () => {
  test("9 pt in 390 ms is a tap", () => {
    expect(isTap({ dx: 9, dy: 0, ms: 390 })).toBe(true);
  });
  test("7 pt in 350 ms is a tap now (S10's 6 pt / 300 ms called it a drag)", () => {
    expect(isTap({ dx: 7, dy: 0, ms: 350 })).toBe(true);
  });
  test("10 pt is a drag", () => {
    expect(isTap({ dx: 6, dy: 8, ms: 100 })).toBe(false);
  });
  test("a 400 ms long press is not a tap (it opens the hub)", () => {
    expect(isTap({ dx: 0, dy: 0, ms: 400 })).toBe(false);
  });
});

describe("visible: the hub shows whenever Floating is on, unless covered or the band is short", () => {
  test("Floating, uncovered, fits → shown, even with nothing running", () => {
    expect(visible({ mode: "floating", covered: false, fits: true })).toBe(true);
  });
  test("Header mode → never", () => {
    for (const covered of [false, true]) {
      for (const fits of [false, true]) {
        expect(visible({ mode: "header", covered, fits })).toBe(false);
      }
    }
  });
  test("F20: hidden while the drawer or a sheet covers it", () => {
    expect(visible({ mode: "floating", covered: true, fits: true })).toBe(false);
  });
  test("F20: hidden while the band is too short", () => {
    expect(visible({ mode: "floating", covered: false, fits: false })).toBe(false);
  });
});

describe("motion: Reduce Motion is a placement + a fade, no spring (F23)", () => {
  test("reduce → no spring", () => {
    expect(motion(true).spring).toBe(false);
    expect(motion(true).fadeMs).toBe(150);
  });
  test("default → spring", () => {
    expect(motion(false).spring).toBe(true);
  });
});

describe("a11y + headerPill: VoiceOver gets a fixed button AND the pill (F23)", () => {
  test("VoiceOver on → not draggable", () => {
    expect(a11y(true).draggable).toBe(false);
    expect(a11y(true).hint).toBe("Opens running sub-agents and jobs");
  });
  test("VoiceOver off → draggable", () => {
    expect(a11y(false).draggable).toBe(true);
  });
  test("the header pill: always in Header; in Floating only under VoiceOver", () => {
    expect(headerPill({ mode: "header", voiceOver: false })).toBe(true);
    expect(headerPill({ mode: "header", voiceOver: true })).toBe(true);
    expect(headerPill({ mode: "floating", voiceOver: false })).toBe(false);
    expect(headerPill({ mode: "floating", voiceOver: true })).toBe(true);
  });
});

/**
 * QA bug 1 (simulator, 2026-11-18): the pending message's inline actions ran to
 * the screen edge, and with the hub on the right the Cancel item sat at x
 * 384–434 pt — entirely under the floating button (376–430) — so a tap there
 * opened the fan instead of cancelling the message. The footer now keeps the
 * hub's column clear at BOTH edges (the button can rest on either).
 */
describe("footClearance: the transcript's foot never sits under the hub (QA bug 1)", () => {
  test("the reserved column is the button's own: its edge inset plus its diameter", () => {
    expect(HUB_COLUMN).toBe(EDGE_INSET + FLOAT_SIZE);
    expect(footClearance(true)).toBe(HUB_COLUMN);
  });

  test("nothing is reserved when the button is not drawn (header mode, covered, too short a band)", () => {
    expect(footClearance(false)).toBe(0);
  });

  test("the QA's own numbers: the Cancel item cleared the button it used to sit under", () => {
    // The report: the screen is 440 pt wide (iPhone 17 Pro Max in portrait at
    // its scale), the button spans x 376–430, Cancel sat at 384–434.
    const screen = 440;
    const buttonRight = screen - EDGE_INSET - FLOAT_SIZE; // 376
    // Before: the action row was padded only by 6 pt of its own, so its last item
    // could end at the screen edge — 10 pt past the button's right edge and 4 pt
    // inside its left one. After: the row ends at the clearance.
    const beforeRight = screen;
    const afterRight = screen - footClearance(true);
    expect(beforeRight).toBeGreaterThan(buttonRight); // the overlap that was
    expect(afterRight).toBeLessThanOrEqual(buttonRight); // no overlap now
    expect(afterRight).toBe(376);
  });

  test("the LEFT edge is reserved too: the hub can be dragged to it", () => {
    // `snap` puts the button at EDGE_INSET when it rests on the left, so an
    // action flush to x 0 would sit under it there — the same bug, other side.
    const clearance = footClearance(true);
    expect(clearance).toBeGreaterThanOrEqual(EDGE_INSET + FLOAT_SIZE);
  });
});

describe("listEndPadding (fix/mobile-qa-1119 row 17: the hub must not cover the last row at rest)", () => {
  const bounds = { width: 402, height: 600 };

  test("a hub resting at the bottom: the list's end clears its top edge", () => {
    // Mutation: return LIST_END_PADDING always → the last row's end runs 46 pt under the hub.
    const padding = listEndPadding({ mode: "floating", position: undefined, bounds });
    const hubTop = place(undefined, bounds)?.y ?? 0;
    expect(bounds.height - padding).toBeLessThanOrEqual(hubTop);
  });

  test("a hub in the upper half, the header mode, or no band: the plain padding", () => {
    const top = { edge: "right", yFraction: 0 } as const;
    expect(listEndPadding({ mode: "floating", position: top, bounds })).toBe(LIST_END_PADDING);
    expect(listEndPadding({ mode: "header", position: undefined, bounds })).toBe(LIST_END_PADDING);
    expect(listEndPadding({ mode: "floating", position: undefined, bounds: null })).toBe(
      LIST_END_PADDING,
    );
  });
});
