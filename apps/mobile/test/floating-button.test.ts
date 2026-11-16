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
  a11y,
  headerPill,
  isTap,
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

describe("isTap: a press OR a drag, never both", () => {
  test("5 pt in 200 ms is a tap", () => {
    expect(isTap({ dx: 3, dy: 4, ms: 200 })).toBe(true);
  });
  test("7 pt is a drag", () => {
    expect(isTap({ dx: 7, dy: 0, ms: 100 })).toBe(false);
  });
  test("a 400 ms long press is not a tap", () => {
    expect(isTap({ dx: 0, dy: 0, ms: 400 })).toBe(false);
  });
});

describe("visible: only in Floating, while something runs or a report is unread", () => {
  const base = { covered: false, fits: true };
  for (const mode of ["header", "floating"] as const) {
    for (const count of [0, 2]) {
      for (const unread of [0, 1]) {
        const expected = mode === "floating" && (count > 0 || unread > 0);
        test(`${mode} × count ${count} × unread ${unread} → ${expected}`, () => {
          expect(visible({ mode, count, unread, ...base })).toBe(expected);
        });
      }
    }
  }
  test("F20: hidden while the drawer or a sheet covers it", () => {
    expect(visible({ mode: "floating", count: 1, unread: 0, covered: true, fits: true })).toBe(
      false,
    );
  });
  test("F20: hidden while the band is too short", () => {
    expect(visible({ mode: "floating", count: 1, unread: 0, covered: false, fits: false })).toBe(
      false,
    );
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
