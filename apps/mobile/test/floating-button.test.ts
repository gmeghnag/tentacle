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
  LIST_END_PADDING,
  a11y,
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

/**
 * Owner 1 (`docs/feat/mobile-hub-center.md`): the centre is a third resting
 * place, and a drop lands on the NEAREST of the three (orchestrator O1). The
 * boundaries are the midpoints between resting centres — 37 / 195 / 353 on the
 * 390 pt band below, so 116 and 274 — and a drop exactly on one goes to the
 * CENTRE.
 */
describe("snap: the NEAREST of the three resting places, by the button's centre", () => {
  test("on 390 pt: 115 → left, 116 → center, 274 → center, 275 → right", () => {
    expect(snap({ x: 115, y: 300 }, BOUNDS)?.edge).toBe("left");
    expect(snap({ x: 116, y: 300 }, BOUNDS)?.edge).toBe("center");
    expect(snap({ x: 274, y: 300 }, BOUNDS)?.edge).toBe("center");
    expect(snap({ x: 275, y: 300 }, BOUNDS)?.edge).toBe("right");
  });

  test("on 402 pt (the QA phone): 118 → left, 119 → center, 283 → center, 284 → right", () => {
    const qa = { width: 402, height: 600 };
    expect(snap({ x: 118, y: 300 }, qa)?.edge).toBe("left");
    expect(snap({ x: 119, y: 300 }, qa)?.edge).toBe("center");
    expect(snap({ x: 283, y: 300 }, qa)?.edge).toBe("center");
    expect(snap({ x: 284, y: 300 }, qa)?.edge).toBe("right");
  });

  test("the dead centre of the band is the centre (what used to snap right)", () => {
    expect(snap({ x: BOUNDS.width / 2, y: 300 }, BOUNDS)?.edge).toBe("center");
  });

  test("a non-finite x still goes right (the pre-existing fallback)", () => {
    expect(snap({ x: Number.NaN, y: 300 }, BOUNDS)?.edge).toBe("right");
    expect(snap({ x: Number.POSITIVE_INFINITY, y: 300 }, BOUNDS)?.edge).toBe("right");
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

  test("y is unchanged by the third place: a centre drop still stores its fraction", () => {
    expect(snap({ x: 195, y: -500 }, BOUNDS)?.yFraction).toBe(0);
    expect(snap({ x: 195, y: 5000 }, BOUNDS)?.yFraction).toBe(1);
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

  test("the centre rests at x = (width − FLOAT_SIZE)/2, on 390 and 402 pt", () => {
    expect(place({ edge: "center", yFraction: 0.5 }, BOUNDS)?.x).toBe(
      (BOUNDS.width - FLOAT_SIZE) / 2,
    );
    expect(place({ edge: "center", yFraction: 0.5 }, { width: 402, height: 600 })?.x).toBe(174);
  });

  test("the centre's y is the edges' y: the fraction decides, not the edge", () => {
    const centre = place({ edge: "center", yFraction: 0.25 }, BOUNDS);
    expect(centre?.y).toBe(place({ edge: "left", yFraction: 0.25 }, BOUNDS)?.y ?? -1);
    const bottom = place({ edge: "center", yFraction: 1 }, BOUNDS);
    expect((bottom?.y ?? 0) + FLOAT_SIZE).toBe(BOUNDS.height - BAND_MARGIN);
  });

  test("a centre position survives a narrower band (rotation, another phone)", () => {
    expect(place({ edge: "center", yFraction: 0.5 }, { width: 700, height: 300 })?.x).toBe(
      (700 - FLOAT_SIZE) / 2,
    );
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

describe("listEndPadding (fix/mobile-qa-1119 row 17; the SETTING is owner 6)", () => {
  const bounds = { width: 402, height: 600 };

  test("a hub resting in the LOWER half: the list's end clears its top edge", () => {
    // Mutation: return LIST_END_PADDING always → the last row's end runs under the hub.
    const padding = listEndPadding({
      mode: "floating",
      position: undefined,
      bounds,
      enabled: true,
    });
    const hubTop = place(undefined, bounds)?.y ?? 0;
    expect(bounds.height - padding).toBeLessThanOrEqual(hubTop);
  });

  test("a bottom-CENTRE hub clears its top edge too (it goes through `place`)", () => {
    const centre = { edge: "center", yFraction: 1 } as const;
    const padding = listEndPadding({ mode: "floating", position: centre, bounds, enabled: true });
    const hubTop = place(centre, bounds)?.y ?? 0;
    expect(bounds.height - padding).toBeLessThanOrEqual(hubTop);
  });

  test("the setting OFF → the plain 16 pt, whatever the hub is doing", () => {
    // Mutation: ignore `enabled` → this fails (70 pt, the hub's clearance).
    expect(listEndPadding({ mode: "floating", position: undefined, bounds, enabled: false })).toBe(
      LIST_END_PADDING,
    );
    const centre = { edge: "center", yFraction: 1 } as const;
    expect(listEndPadding({ mode: "floating", position: centre, bounds, enabled: false })).toBe(
      LIST_END_PADDING,
    );
  });

  test("a hub in the upper half, the header mode, or no band: the plain padding", () => {
    const top = { edge: "right", yFraction: 0 } as const;
    expect(listEndPadding({ mode: "floating", position: top, bounds, enabled: true })).toBe(
      LIST_END_PADDING,
    );
    expect(listEndPadding({ mode: "header", position: undefined, bounds, enabled: true })).toBe(
      LIST_END_PADDING,
    );
    expect(
      listEndPadding({ mode: "floating", position: undefined, bounds: null, enabled: true }),
    ).toBe(LIST_END_PADDING);
  });
});
