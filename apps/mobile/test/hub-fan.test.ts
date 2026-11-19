/**
 * `hub-fan.ts` — the radial fan's geometry, selection, label and motion
 * (docs/feat/mobile-hub.md Design 3–4, M5/M11): never clipped, never crowded,
 * item 0 nearest the composer, hysteresis that never flickers.
 */
import { describe, expect, test } from "bun:test";
import type { Edge } from "../src/floating-button.ts";
import type { HubBadge, HubItem } from "../src/hub-actions.ts";
import {
  FAN_PAD,
  type FanItem,
  type FanLayout,
  HYSTERESIS_DEG,
  ITEM_PITCH,
  ITEM_SIZE,
  LABEL_GAP,
  REACH,
  RIM_FULL,
  type Rect,
  fanItemLook,
  fanLayout,
  fanMotion,
  labelPlacement,
  pickItem,
  rimFraction,
} from "../src/hub-fan.ts";
import { darkPalette, lightPalette } from "../src/theme.ts";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const HEADER = 97;

/** The render-check's phones: a band from the header to the composer (or the keyboard). */
function band(w: number, h: number, keyboard: number): Rect {
  return { left: 0, top: HEADER, right: w, bottom: h - 88 - keyboard };
}

/** The button's centre at an edge and a fraction of the band (mobile-chrome S10 `place`). */
function anchorAt(bounds: Rect, edge: Edge, yFraction: number) {
  const lo = bounds.top + 35;
  const hi = bounds.bottom - 35;
  return {
    x: edge === "right" ? bounds.right - 37 : bounds.left + 37,
    y: lo + (hi - lo) * yFraction,
  };
}

function fan(layout: FanLayout) {
  if (layout.kind !== "fan") {
    throw new Error("expected a fan");
  }
  return layout;
}

describe("fanLayout: the render-check sweep as a property", () => {
  const phones: [number, number, number][] = [
    [390, 844, 291],
    [375, 667, 216],
  ];
  let cases = 0;
  let menus = 0;
  let twoRings = 0;
  const bad: string[] = [];
  for (const [w, h, kb] of phones) {
    for (const keyboard of [0, kb]) {
      const bounds = band(w, h, keyboard);
      if (bounds.bottom - bounds.top < 2 * 54) {
        continue; // S10/F20: the button is hidden in a band this short
      }
      for (const edge of ["left", "right"] as const) {
        for (let yi = 0; yi <= 20; yi++) {
          for (let n = 1; n <= 6; n++) {
            cases += 1;
            const anchor = anchorAt(bounds, edge, yi / 20);
            const layout = fanLayout({ anchor, edge, bounds, n });
            const tag = `${w}x${h}${keyboard ? "+kbd" : ""} ${edge} y=${yi / 20} n=${n}`;
            if (layout.kind !== "fan") {
              menus += 1;
              continue;
            }
            if (layout.radii.length === 2) {
              twoRings += 1;
            }
            if (layout.items.length !== n) {
              bad.push(`${tag}: ${layout.items.length} items`);
            }
            const r = ITEM_SIZE / 2 + FAN_PAD;
            for (const it of layout.items) {
              if (
                it.x - r < bounds.left - EPS ||
                it.x + r > bounds.right + EPS ||
                it.y - r < bounds.top - EPS ||
                it.y + r > bounds.bottom + EPS
              ) {
                bad.push(`${tag}: item outside bounds − padding at ${it.x},${it.y}`);
              }
            }
            for (let i = 0; i < layout.items.length; i++) {
              for (let j = i + 1; j < layout.items.length; j++) {
                const a = layout.items[i] as FanItem;
                const b = layout.items[j] as FanItem;
                if (Math.hypot(a.x - b.x, a.y - b.y) < ITEM_PITCH - EPS) {
                  bad.push(`${tag}: items ${i},${j} closer than ${ITEM_PITCH}`);
                }
              }
            }
            // Order: each ring runs along its arc (one step apart, no gaps), from
            // the END nearest the composer. Not "item 0 is the lowest item": an
            // arc through straight-down has a lower item in its middle, and
            // sorting by y would scatter the priorities along the arc.
            for (const ring of [0, 1] as const) {
              const its = layout.items.filter((it) => it.ring === ring);
              const step = layout.steps[ring] ?? 0;
              for (let i = 1; i < its.length; i++) {
                const a = its[i - 1] as FanItem;
                const b = its[i] as FanItem;
                if (Math.abs(Math.abs(b.angle - a.angle) - step) > EPS) {
                  bad.push(`${tag}: ring ${ring} items ${i - 1},${i} not adjacent on the arc`);
                }
              }
              const first = its[0];
              const last = its[its.length - 1];
              if (first !== undefined && last !== undefined && first.y < last.y - EPS) {
                bad.push(`${tag}: ring ${ring} starts at its upper end`);
              }
            }
            if (layout.items[0]?.ring !== 0) {
              bad.push(`${tag}: item 0 is not on the inner ring`);
            }
          }
        }
      }
    }
  }

  test("1008 cases: inside the padding, ≥ 56 pt apart, arc order from the lower end", () => {
    expect(cases).toBe(1008);
    expect(bad).toEqual([]);
  });

  test("never the menu on these phones, and the two-ring step is used", () => {
    expect(menus).toBe(0);
    expect(twoRings).toBeGreaterThan(0);
  });
});

describe("fanLayout: cases", () => {
  const bounds = band(390, 844, 0);

  test("mid-band, six items → one ring at the minimum radius (96)", () => {
    const l = fan(
      fanLayout({ anchor: anchorAt(bounds, "right", 0.5), edge: "right", bounds, n: 6 }),
    );
    expect(l.radii).toEqual([96]);
    expect(l.items.every((it) => it.ring === 0 && it.R === 96)).toBe(true);
  });

  test("the fan points inward: left of a right-edge button, right of a left-edge one", () => {
    const right = fan(
      fanLayout({ anchor: anchorAt(bounds, "right", 0.5), edge: "right", bounds, n: 3 }),
    );
    const left = fan(
      fanLayout({ anchor: anchorAt(bounds, "left", 0.5), edge: "left", bounds, n: 3 }),
    );
    expect(right.items.every((it) => it.x < right.anchor.x)).toBe(true);
    expect(left.items.every((it) => it.x > left.anchor.x)).toBe(true);
  });

  test("bottom of the band, six items → two rings, inner ⌈n/2⌉ first, outer = inner + 56", () => {
    const l = fan(fanLayout({ anchor: anchorAt(bounds, "right", 1), edge: "right", bounds, n: 6 }));
    expect(l.radii.length).toBe(2);
    const [inner, outer] = l.radii;
    expect((outer ?? 0) - (inner ?? 0)).toBe(ITEM_PITCH);
    expect(l.items.map((it) => it.ring)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  test("each ring runs from its lowest end upward (item order = thumb travel)", () => {
    const l = fan(fanLayout({ anchor: anchorAt(bounds, "left", 1), edge: "left", bounds, n: 5 }));
    for (const ring of [0, 1]) {
      const ys = l.items.filter((it) => it.ring === ring).map((it) => it.y);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i] ?? 0).toBeLessThanOrEqual((ys[i - 1] ?? 0) + EPS);
      }
    }
  });

  test("an impossible band (120 pt high, n = 6) → the menu, never a clipped fan", () => {
    const tiny: Rect = { left: 0, top: 0, right: 390, bottom: 120 };
    expect(fanLayout({ anchor: { x: 353, y: 60 }, edge: "right", bounds: tiny, n: 6 })).toEqual({
      kind: "menu",
    });
  });

  test("n = 0 → an empty fan (nothing to place, nothing clipped)", () => {
    const l = fanLayout({ anchor: anchorAt(bounds, "right", 0.5), edge: "right", bounds, n: 0 });
    expect(l.kind === "fan" ? l.items.length : -1).toBe(0);
  });
});

/** A hand-built right-edge ring: three items around "straight left". */
const A = { x: 300, y: 400 };
const R = 100;
const STEP = 2 * Math.asin(ITEM_PITCH / 2 / R);
const ONE: FanLayout = {
  kind: "fan",
  anchor: A,
  edge: "right",
  radii: [R],
  steps: [STEP],
  items: [Math.PI - STEP, Math.PI, Math.PI + STEP].map((angle) => ({
    x: A.x + R * Math.cos(angle),
    y: A.y + R * Math.sin(angle),
    angle,
    R,
    ring: 0 as const,
  })),
};
const polar = (angle: number, r = R) => ({
  x: A.x + r * Math.cos(angle),
  y: A.y + r * Math.sin(angle),
});

describe("pickItem: sectors, dead zone, reach, hysteresis", () => {
  test("on an item's angle → that item", () => {
    expect(pickItem(ONE, polar(Math.PI), null)).toBe(1);
    expect(pickItem(ONE, polar(Math.PI - STEP), null)).toBe(0);
  });

  test("dead zone: inside 0.45·R → null; just outside → the item", () => {
    expect(pickItem(ONE, polar(Math.PI, 0.44 * R), null)).toBeNull();
    expect(pickItem(ONE, polar(Math.PI, 0.46 * R), null)).toBe(1);
  });

  test("reach: up to R + 56, beyond → null", () => {
    expect(pickItem(ONE, polar(Math.PI, R + REACH - 1), null)).toBe(1);
    expect(pickItem(ONE, polar(Math.PI, R + REACH + 1), null)).toBeNull();
  });

  test("outside the arc (behind the button, past the ends) → null", () => {
    expect(pickItem(ONE, polar(0), null)).toBeNull();
    expect(pickItem(ONE, polar(Math.PI - STEP * 1.5 - DEG), null)).toBeNull();
  });

  test("hysteresis: the neighbour wins only past the midpoint + 4°", () => {
    const mid = Math.PI - STEP / 2;
    const towards0 = (deg: number) => polar(mid - deg * DEG);
    expect(pickItem(ONE, towards0(HYSTERESIS_DEG - 1), 1)).toBe(1);
    expect(pickItem(ONE, towards0(HYSTERESIS_DEG + 1), 1)).toBe(0);
    // and back the other way, from 0
    expect(pickItem(ONE, polar(mid + (HYSTERESIS_DEG - 1) * DEG), 0)).toBe(0);
    expect(pickItem(ONE, polar(mid + (HYSTERESIS_DEG + 1) * DEG), 0)).toBe(1);
    // with no previous item the midpoint decides
    expect(pickItem(ONE, towards0(1), null)).toBe(0);
  });

  test("the end item holds 4° past its own sector edge, then lets go", () => {
    const edge0 = Math.PI - STEP * 1.5;
    expect(pickItem(ONE, polar(edge0 - (HYSTERESIS_DEG - 1) * DEG), 0)).toBe(0);
    expect(pickItem(ONE, polar(edge0 - (HYSTERESIS_DEG + 1) * DEG), 0)).toBeNull();
  });

  test("sticky: within 30 pt of a centre → that item, else null", () => {
    const it = ONE.items[1] as FanItem;
    expect(pickItem(ONE, { x: it.x + 29, y: it.y }, null, { sticky: true })).toBe(1);
    expect(pickItem(ONE, { x: it.x + 31, y: it.y }, null, { sticky: true })).toBeNull();
  });

  test("the menu has nothing to pick", () => {
    expect(pickItem({ kind: "menu" }, A, null)).toBeNull();
  });
});

describe("pickItem: two rings — the radius picks the ring", () => {
  const bounds = band(390, 844, 0);
  const l = fan(fanLayout({ anchor: anchorAt(bounds, "right", 1), edge: "right", bounds, n: 6 }));
  const [r1, r2] = [l.radii[0] ?? 0, l.radii[1] ?? 0];
  const boundary = (r1 + r2) / 2;
  const on = (it: FanItem, r: number) => ({
    x: l.anchor.x + r * Math.cos(it.angle),
    y: l.anchor.y + r * Math.sin(it.angle),
  });

  test("each item is picked at its own centre", () => {
    l.items.forEach((it, i) => {
      expect(pickItem(l, { x: it.x, y: it.y }, null)).toBe(i);
    });
  });

  test("inner item's angle, outer radius → never the inner item", () => {
    const inner0 = l.items[0] as FanItem;
    expect(pickItem(l, on(inner0, r2), null)).not.toBe(0);
  });

  test("the ring boundary has 4 pt of hysteresis", () => {
    const inner0 = l.items[0] as FanItem;
    expect(pickItem(l, on(inner0, boundary + 2), 0)).toBe(0);
    expect(pickItem(l, on(inner0, boundary + 6), 0)).not.toBe(0);
  });
});

describe("labelPlacement: inner side, clamped, else above", () => {
  const screen: Rect = { left: 0, top: 0, right: 390, bottom: 844 };
  const size = { width: 90, height: 30 };

  test("right-edge fan → the pill sits left of the item, centred on it", () => {
    const it = ONE.items[1] as FanItem;
    expect(labelPlacement(ONE, 1, size, screen)).toEqual({
      x: it.x - LABEL_GAP - size.width,
      y: it.y - size.height / 2,
    });
  });

  test("left-edge fan → right of the item", () => {
    const left: FanLayout = {
      ...ONE,
      edge: "left",
      items: [{ x: 120, y: 300, angle: 0, R, ring: 0 }],
    };
    expect(labelPlacement(left, 0, size, screen)).toEqual({ x: 120 + LABEL_GAP, y: 285 });
  });

  test("no room on the inner side → above the item, clamped inside both screen edges", () => {
    const nearLeft: FanLayout = { ...ONE, items: [{ x: 30, y: 300, angle: Math.PI, R, ring: 0 }] };
    expect(labelPlacement(nearLeft, 0, size, screen)).toEqual({
      x: FAN_PAD,
      y: 300 - LABEL_GAP - size.height,
    });
    const nearRight: FanLayout = {
      ...ONE,
      edge: "left",
      items: [{ x: 360, y: 300, angle: 0, R, ring: 0 }],
    };
    expect(labelPlacement(nearRight, 0, size, screen)).toEqual({
      x: 390 - FAN_PAD - size.width,
      y: 300 - LABEL_GAP - size.height,
    });
  });

  test("a label wider than the screen still starts inside it", () => {
    const wide = { width: 500, height: 30 };
    expect(labelPlacement(ONE, 1, wide, screen)?.x).toBe(FAN_PAD);
  });

  test("never above the top of the screen", () => {
    const high: FanLayout = { ...ONE, items: [{ x: 60, y: 20, angle: Math.PI, R, ring: 0 }] };
    expect(labelPlacement(high, 0, size, screen)?.y).toBe(FAN_PAD);
  });

  test("no item → null", () => {
    expect(labelPlacement(ONE, 7, size, screen)).toBeNull();
    expect(labelPlacement({ kind: "menu" }, 0, size, screen)).toBeNull();
  });
});

describe("fanMotion (Design 4; Reduce Motion is read per open, M11)", () => {
  test("default: staggered spring out, magnified highlight", () => {
    expect(fanMotion(false)).toEqual({
      spring: true,
      staggerMs: 18,
      damping: 18,
      stiffness: 260,
      fromScale: 0.4,
      highlightScale: 1.3,
      dimOpacity: 0.55,
      fadeMs: 120,
      collapseMs: 120,
    });
  });

  test("Reduce Motion: no spring, no stagger, no scale; a 120 ms fade", () => {
    const m = fanMotion(true);
    expect(m.spring).toBe(false);
    expect(m.staggerMs).toBe(0);
    expect(m.fromScale).toBe(1);
    expect(m.highlightScale).toBe(1);
    expect(m.fadeMs).toBe(120);
  });

  test("ONE object per mode: a re-render never hands the fan a new motion (docs/fix/mobile-fan-jank-device.md)", () => {
    // The fan starts its springs from an effect keyed on `motion`: a fresh object
    // per call restarted every item's spring (and its stagger) on every re-render
    // of the screen — every streamed delta on a phone.
    expect(fanMotion(false)).toBe(fanMotion(false));
    expect(fanMotion(true)).toBe(fanMotion(true));
    expect(fanMotion(true)).not.toBe(fanMotion(false));
  });
});

describe("rimFraction + fanItemLook (mobile-hub-badges Design 6–7, 9)", () => {
  test("RIM_FULL pins the owner's 36°-per-item scale (Q2 C)", () => {
    // 360° / 36° per item: a count of RIM_FULL is exactly one full rim.
    expect(RIM_FULL).toBe(10);
  });

  test("no badge → no rim", () => {
    expect(rimFraction(null)).toBeNull();
  });

  test("a count is proportional and clamps: 1 → 0.1, 5 → 0.5, 10 → 1, 99 → 1", () => {
    expect(rimFraction({ kind: "count", n: 1 })).toBeCloseTo(0.1, 6);
    expect(rimFraction({ kind: "count", n: 5 })).toBeCloseTo(0.5, 6);
    expect(rimFraction({ kind: "count", n: RIM_FULL })).toBe(1);
    expect(rimFraction({ kind: "count", n: 99 })).toBe(1);
  });

  test("a count of nothing is no rim; a negative never draws backwards (F7)", () => {
    expect(rimFraction({ kind: "count", n: 0 })).toBeNull();
    expect(rimFraction({ kind: "count", n: -3 })).toBeNull();
    expect(rimFraction({ kind: "count", n: Number.NaN })).toBeNull();
  });

  test("a due scheduled wake is a full rim (Q2: the dot's meaning, as a shape)", () => {
    expect(rimFraction({ kind: "dot" })).toBe(1);
  });

  const item = (over: Partial<HubItem> = {}): HubItem => ({
    id: "artifacts",
    label: "Artifacts",
    badge: null,
    danger: false,
    dimmed: false,
    emptyLabel: null,
    ...over,
  });

  /** Every combination the fan can draw: the mix that must never produce glass again. */
  const ALL: readonly { readonly item: HubItem; readonly lit: boolean }[] = [false, true].flatMap(
    (danger) =>
      [false, true].flatMap((dimmed) =>
        [null, { kind: "dot" } as const, { kind: "count", n: 3 } as const].flatMap((badge) =>
          [false, true].map((lit) => ({ item: item({ danger, dimmed, badge }), lit })),
        ),
      ),
  );

  test("Q3 B: no combination of danger/dimmed/badge/lit draws a glass disc", () => {
    for (const { item: it, lit } of ALL) {
      expect(fanItemLook(it, lit).bg).not.toBe("glass");
    }
  });

  test("a resting item is an opaque card disc: card bg, accent glyph (red for Stop)", () => {
    expect(fanItemLook(item(), false)).toEqual({
      bg: "card",
      fg: "accent",
      rim: null,
      rimTone: "accent",
      dashed: false,
      glyphOpacity: 1,
    });
    expect(fanItemLook(item({ danger: true }), false)).toMatchObject({ bg: "card", fg: "red" });
  });

  test("a dimmed item is a FILL disc with a secondary glyph — never faint glass (Design 7)", () => {
    const look = fanItemLook(item({ id: "activity", dimmed: true }), false);
    expect(look.bg).toBe("fill");
    expect(look.fg).toBe("sec");
    // The shape cues of owner Q3 A: a dashed hairline and a 38 % glyph, so the
    // state is not carried by the grey alone.
    expect(look.dashed).toBe(true);
    expect(look.glyphOpacity).toBeCloseTo(0.38, 2);
    // A dimmed item has nothing to show, so it never draws a rim.
    expect(
      fanItemLook(item({ dimmed: true, badge: { kind: "count", n: 3 } }), false).rim,
    ).toBeNull();
  });

  test("the highlighted item is a solid accent disc, red for Stop, on-accent glyph and rim (F9)", () => {
    expect(fanItemLook(item({ badge: { kind: "count", n: 4 } }), true)).toEqual({
      bg: "accentFill",
      fg: "onAccent",
      rim: 0.4,
      rimTone: "onAccent",
      dashed: false,
      glyphOpacity: 1,
    });
    expect(fanItemLook(item({ danger: true }), true)).toEqual({
      bg: "red",
      fg: "onAccent",
      rim: null,
      rimTone: "onAccent",
      dashed: false,
      glyphOpacity: 1,
    });
    // The highlight wins over dimmed: the disc is still lit while the finger is on it.
    expect(fanItemLook(item({ dimmed: true }), true).bg).toBe("accentFill");
  });

  test("a resting badged item carries its rim; a due wake draws the whole one", () => {
    expect(fanItemLook(item({ badge: { kind: "count", n: 2 } }), false).rim).toBeCloseTo(0.2, 6);
    expect(fanItemLook(item({ badge: { kind: "dot" } }), false).rim).toBe(1);
  });

  test("Q3 B's premise, pinned: the disc tokens are opaque hex in BOTH palettes", () => {
    for (const palette of [lightPalette, darkPalette]) {
      expect(palette.card).toMatch(/^#[0-9A-F]{6}$/i);
      expect(palette.fill).toMatch(/^#[0-9A-F]{6}$/i);
      expect(palette.accentFill).toMatch(/^#[0-9A-F]{6}$/i);
      expect(palette.red).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});
